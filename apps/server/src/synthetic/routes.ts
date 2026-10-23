import { Hono } from "hono";
import { html } from "hono/html";
import { and, eq, isNull } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { createLocalJWKSet, jwtVerify, SignJWT } from "jose";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { syntheticPatients, syntheticTokens } from "../db/schema.js";
import { cursorSigningKey, safeEqual, sha256Hex } from "../lib/crypto.js";
import { newId, randomToken } from "../lib/ids.js";
import type { AppEnv, Ctx } from "../http/context.js";
import { activeKey, publicJwks, SIGNING_ALG } from "../services/keys.js";
import { pkceChallengeFor } from "../smart/pkce.js";
import { CSP, layout } from "../routes/pages/layout.js";
import { generateSyntheticPatient, SYNTHETIC_PASSWORD, SYNTHETIC_PEOPLE } from "./generator.js";

/**
 * The Synthetic Hospital: a complete SMART on FHIR R4 sandbox EHR served by InfiniMed itself, so the
 * full patient-access path (discovery, authorize, login, consent, PKCE, private_key_jwt token
 * exchange, rolling refresh, paged FHIR search) runs end to end without any vendor registration.
 * Patients are generated deterministically; testers can also upload their own FHIR R4 bundle.
 */

const base = () => `${config().publicUrl}/synthetic/fhir/r4`;
const tokenUrl = () => `${config().publicUrl}/synthetic/oauth/token`;

/** Test hooks: make the FHIR API rate limit or fail to exercise worker behaviour. */
export const syntheticFaults = { rateLimitOnce: false, failSearchFor: new Set<string>(), pageSize: 20 };

const seenJti = new Map<string, number>();
const SYSTEM = "system";
const bulkPolls = new Map<string, number>();

function signRequest(params: Record<string, string>) {
  const body = Buffer.from(JSON.stringify(params)).toString("base64url");
  const mac = createHmac("sha256", cursorSigningKey()).update(`synthetic:${body}`).digest("base64url");
  return `${body}.${mac}`;
}

function readRequest(signed: string): Record<string, string> | null {
  const [body, mac] = signed.split(".");
  if (!body || !mac) return null;
  const expect = createHmac("sha256", cursorSigningKey()).update(`synthetic:${body}`).digest("base64url");
  if (!safeEqual(expect, mac)) return null;
  const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, string> & { exp?: string };
  if (Number(parsed.exp ?? 0) < Date.now()) return null;
  return parsed;
}

/** Uploaded sandbox bundles are temporary: removed after 7 days. */
export async function purgeSyntheticUploads() {
  const { lt } = await import("drizzle-orm");
  await db()
    .delete(syntheticPatients)
    .where(and(eq(syntheticPatients.uploaded, true), lt(syntheticPatients.createdAt, new Date(Date.now() - 7 * 86400_000))));
}

export async function seedSyntheticPatients() {
  for (let i = 0; i < SYNTHETIC_PEOPLE.length; i++) {
    const p = generateSyntheticPatient(i);
    await db()
      .insert(syntheticPatients)
      .values({ id: `syn_${i + 1}`, username: p.username, displayName: p.displayName, fhirPatientId: p.patientId, bundle: p.bundle })
      .onConflictDoUpdate({ target: syntheticPatients.id, set: { bundle: p.bundle, displayName: p.displayName, username: p.username } });
  }
}

async function issue(
  kind: "code" | "access" | "refresh",
  args: { patientRowId: string; clientId: string; scope: string; redirectUri?: string; codeChallenge?: string; ttlSeconds: number; context?: Record<string, unknown> },
) {
  const token = randomToken(32);
  await db()
    .insert(syntheticTokens)
    .values({
      tokenHash: sha256Hex(token),
      kind,
      syntheticPatientId: args.patientRowId,
      clientId: args.clientId,
      scope: args.scope,
      redirectUri: args.redirectUri ?? null,
      codeChallenge: args.codeChallenge ?? null,
      context: args.context ?? null,
      expiresAt: new Date(Date.now() + args.ttlSeconds * 1000),
    });
  return token;
}

async function consume(kind: "code" | "refresh", token: string) {
  const [row] = await db()
    .update(syntheticTokens)
    .set({ consumedAt: new Date() })
    .where(and(eq(syntheticTokens.tokenHash, sha256Hex(token)), eq(syntheticTokens.kind, kind), isNull(syntheticTokens.consumedAt)))
    .returning();
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

const oauthError = (error: string, description: string) => ({ error, error_description: description });

export function syntheticRouter() {
  const r = new Hono<AppEnv>();

  r.get("/synthetic/fhir/r4/.well-known/smart-configuration", (c) =>
    c.json({
      issuer: base(),
      authorization_endpoint: `${config().publicUrl}/synthetic/oauth/authorize`,
      token_endpoint: tokenUrl(),
      revocation_endpoint: `${config().publicUrl}/synthetic/oauth/revoke`,
      jwks_uri: `${config().publicUrl}/.well-known/jwks.json`,
      token_endpoint_auth_methods_supported: ["private_key_jwt", "client_secret_basic", "none"],
      token_endpoint_auth_signing_alg_values_supported: [SIGNING_ALG],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "fhirUser", "launch/patient", "offline_access", "patient/*.read", "patient/*.rs"],
      response_types_supported: ["code"],
      capabilities: ["launch-standalone", "client-public", "client-confidential-asymmetric", "context-standalone-patient", "permission-offline", "permission-patient", "sso-openid-connect"],
    }),
  );

  r.get("/synthetic/fhir/r4/metadata", (c) =>
    c.json({
      resourceType: "CapabilityStatement",
      status: "active",
      date: "2026-01-01",
      kind: "instance",
      fhirVersion: "4.0.1",
      format: ["json"],
      software: { name: "InfiniMed Synthetic Hospital" },
      rest: [
        {
          mode: "server",
          security: {
            service: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/restful-security-service", code: "SMART-on-FHIR" }] }],
            extension: [
              {
                url: "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris",
                extension: [
                  { url: "authorize", valueUri: `${config().publicUrl}/synthetic/oauth/authorize` },
                  { url: "token", valueUri: tokenUrl() },
                ],
              },
            ],
          },
          resource: ["Patient", "AllergyIntolerance", "Condition", "Observation", "MedicationRequest", "Immunization", "Procedure", "Encounter", "DiagnosticReport", "DocumentReference", "Coverage", "Practitioner", "Organization", "Location"].map((type) => ({
            type,
            interaction: [{ code: "read" }, { code: "search-type" }],
          })),
        },
      ],
    }),
  );

  // ------------------------------------------------------------------- authorization
  r.get("/synthetic/oauth/authorize", async (c) => {
    c.header("Content-Security-Policy", CSP);
    const q = Object.fromEntries(new URL(c.req.url).searchParams);
    const required = ["response_type", "client_id", "redirect_uri", "state", "code_challenge"];
    const missing = required.filter((k) => !q[k]);
    if (missing.length || q.response_type !== "code" || q.code_challenge_method !== "S256") {
      return c.html(layout({ title: "Invalid request", body: html`<div class="card"><h1>Invalid authorization request</h1><p>Missing or invalid: ${missing.join(", ") || "response_type/code_challenge_method"}</p></div>` }), 400);
    }
    if (q.aud && q.aud.replace(/\/+$/, "") !== base()) {
      return c.html(layout({ title: "Invalid audience", body: html`<div class="card"><h1>Invalid audience</h1><p>aud must be ${base()}</p></div>` }), 400);
    }
    if (q.launch) {
      const launch = readRequest(q.launch);
      if (!launch?.patient_row) return c.html(layout({ title: "Invalid launch", body: html`<div class="card"><h1>Invalid or expired launch</h1></div>` }), 400);
      const code = await issue("code", {
        patientRowId: launch.patient_row,
        clientId: q.client_id!,
        scope: q.scope ?? "",
        redirectUri: q.redirect_uri,
        codeChallenge: q.code_challenge,
        ttlSeconds: 60,
        context: { encounter: launch.encounter, need_patient_banner: true, intent: "chart-review", practitioner: "Practitioner/syn-prac-1" },
      });
      const back = new URL(q.redirect_uri!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.state!);
      return c.redirect(back.toString(), 302);
    }
    const signed = signRequest({ ...q, exp: String(Date.now() + 15 * 60_000) });
    const people = await db().select({ id: syntheticPatients.id, name: syntheticPatients.displayName, username: syntheticPatients.username }).from(syntheticPatients).where(eq(syntheticPatients.uploaded, false));
    return c.html(
      layout({
        title: "Synthetic Hospital sign in",
        branding: { display_name: "Synthetic Hospital", primary_color: "#0f766e" },
        body: html`<div class="card">
            <h1>Synthetic Hospital patient portal</h1>
            <p>Sandbox only. Sign in as a synthetic patient. Every password is <code>${SYNTHETIC_PASSWORD}</code>.</p>
            <form method="post" action="/synthetic/oauth/login">
              <input type="hidden" name="request" value="${signed}">
              <label for="patient">Patient</label>
              <select id="patient" name="patient">${people.map((p) => html`<option value="${p.id}">${p.name} (${p.username})</option>`)}</select>
              <label for="password">Password</label>
              <input id="password" type="password" name="password" value="${SYNTHETIC_PASSWORD}">
              <p></p>
              <button type="submit">Log in</button>
            </form>
          </div>
          <div class="card">
            <h2>Upload your own patient bundle</h2>
            <p>Paste a FHIR R4 Bundle containing a Patient resource.</p>
            <form method="post" action="/synthetic/oauth/login">
              <input type="hidden" name="request" value="${signed}">
              <textarea name="bundle" rows="6" placeholder='{"resourceType":"Bundle", ...}' aria-label="FHIR bundle JSON"></textarea>
              <p></p>
              <button type="submit" class="secondary">Sign in as this patient</button>
            </form>
          </div>`,
      }),
    );
  });

  r.post("/synthetic/oauth/login", async (c) => {
    c.header("Content-Security-Policy", CSP);
    const form = await c.req.parseBody();
    const req = readRequest(String(form.request ?? ""));
    if (!req) return c.html(layout({ title: "Expired", body: html`<div class="card"><h1>Session expired</h1><p>Start the connection again.</p></div>` }), 400);
    let patientRowId: string;
    if (typeof form.bundle === "string" && form.bundle.trim()) {
      // Public sandbox endpoint: bound what an anonymous visitor can store. Uploads expire (housekeeping).
      if (form.bundle.length > 2 * 1024 * 1024) {
        return c.html(layout({ title: "Bundle too large", body: html`<div class="card"><h1>Bundle too large</h1><p>Uploaded bundles are limited to 2 MB.</p></div>` }), 413);
      }
      let bundle: { resourceType?: string; entry?: { resource?: Record<string, unknown> }[] };
      try {
        bundle = JSON.parse(form.bundle);
      } catch {
        return c.html(layout({ title: "Invalid bundle", body: html`<div class="card"><h1>Invalid bundle</h1><p>The bundle is not valid JSON.</p></div>` }), 400);
      }
      const patient = bundle.entry?.find((e) => e.resource?.resourceType === "Patient")?.resource;
      if (bundle.resourceType !== "Bundle" || !patient) {
        return c.html(layout({ title: "Invalid bundle", body: html`<div class="card"><h1>Invalid bundle</h1><p>A FHIR R4 Bundle with a Patient resource is required.</p></div>` }), 400);
      }
      if (!patient.id) patient.id = `upload-${randomToken(6)}`;
      patientRowId = newId("syntheticPatient");
      const names = (patient.name as { given?: string[]; family?: string }[] | undefined)?.[0];
      await db()
        .insert(syntheticPatients)
        .values({
          id: patientRowId,
          username: `upload-${randomToken(8)}`,
          displayName: names ? [names.given?.join(" "), names.family].filter(Boolean).join(" ") : "Uploaded patient",
          fhirPatientId: String(patient.id),
          bundle: bundle as Record<string, unknown>,
          uploaded: true,
        });
    } else {
      if (form.password !== SYNTHETIC_PASSWORD) return c.html(layout({ title: "Sign in failed", body: html`<div class="card"><h1>Incorrect password</h1><p>Use ${SYNTHETIC_PASSWORD}.</p></div>` }), 401);
      patientRowId = String(form.patient ?? "");
    }
    const [patient] = await db().select().from(syntheticPatients).where(eq(syntheticPatients.id, patientRowId)).limit(1);
    if (!patient) return c.html(layout({ title: "Unknown patient", body: html`<div class="card"><h1>Unknown patient</h1></div>` }), 400);
    const consent = signRequest({ ...req, patient_row: patient.id, exp: String(Date.now() + 10 * 60_000) });
    const scopes = (req.scope ?? "").split(/\s+/).filter(Boolean);
    return c.html(
      layout({
        title: "Approve access",
        branding: { display_name: "Synthetic Hospital", primary_color: "#0f766e" },
        body: html`<div class="card">
          <h1>Share your records?</h1>
          <p>The app <strong>${req.client_id}</strong> is asking to read ${patient.displayName}'s health records from Synthetic Hospital.</p>
          <ul>${scopes.map((s) => html`<li><code>${s}</code></li>`)}</ul>
          <form method="post" action="/synthetic/oauth/consent" class="row">
            <input type="hidden" name="request" value="${consent}">
            <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
            <button type="submit" name="decision" value="approve">Approve</button>
          </form>
        </div>`,
      }),
    );
  });

  r.post("/synthetic/oauth/consent", async (c) => {
    const form = await c.req.parseBody();
    const req = readRequest(String(form.request ?? ""));
    if (!req || !req.patient_row) return c.text("expired", 400);
    const redirect = new URL(req.redirect_uri!);
    redirect.searchParams.set("state", req.state!);
    if (form.decision !== "approve") {
      redirect.searchParams.set("error", "access_denied");
      redirect.searchParams.set("error_description", "The patient denied access");
      return c.redirect(redirect.toString(), 302);
    }
    const code = await issue("code", { patientRowId: req.patient_row, clientId: req.client_id!, scope: req.scope ?? "", redirectUri: req.redirect_uri, codeChallenge: req.code_challenge, ttlSeconds: 60 });
    redirect.searchParams.set("code", code);
    return c.redirect(redirect.toString(), 302);
  });

  async function authenticateClient(form: Record<string, string>, authHeader: string | undefined): Promise<string | null> {
    if (form.client_assertion_type === "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" && form.client_assertion) {
      const jwks = createLocalJWKSet(await publicJwks());
      const { payload } = await jwtVerify(form.client_assertion, jwks, { audience: tokenUrl() }).catch(() => ({ payload: null as never }));
      if (!payload || payload.iss !== payload.sub || (form.client_id && form.client_id !== payload.iss)) return null;
      const jti = String(payload.jti ?? "");
      if (!jti || seenJti.has(jti)) return null;
      seenJti.set(jti, Date.now());
      for (const [k, t] of seenJti) if (Date.now() - t > 600_000) seenJti.delete(k);
      return String(payload.iss);
    }
    if (authHeader?.startsWith("Basic ")) {
      const [id] = Buffer.from(authHeader.slice(6), "base64").toString().split(":");
      return id ? decodeURIComponent(id) : null;
    }
    return form.client_id ?? null;
  }

  r.post("/synthetic/oauth/token", async (c) => {
    const form = (await c.req.parseBody()) as Record<string, string>;
    const clientId = await authenticateClient(form, c.req.header("authorization"));
    if (!clientId) return c.json(oauthError("invalid_client", "Client authentication failed"), 401);
    let patientRowId: string;
    let scope: string;
    let launchContext: Record<string, unknown> | null = null;
    if (form.grant_type === "client_credentials") {
      if (form.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") {
        return c.json(oauthError("invalid_client", "Backend services require private_key_jwt"), 401);
      }
      const access = await issue("access", { patientRowId: SYSTEM, clientId, scope: form.scope ?? "system/*.read", ttlSeconds: 300 });
      return c.json({ access_token: access, token_type: "Bearer", expires_in: 300, scope: form.scope ?? "system/*.read" });
    }
    if (form.grant_type === "authorization_code") {
      const row = await consume("code", form.code ?? "");
      if (!row || row.clientId !== clientId) return c.json(oauthError("invalid_grant", "Authorization code is invalid, expired or already used"), 400);
      if (row.redirectUri !== form.redirect_uri) return c.json(oauthError("invalid_grant", "redirect_uri does not match"), 400);
      if (!form.code_verifier || pkceChallengeFor(form.code_verifier) !== row.codeChallenge) return c.json(oauthError("invalid_grant", "PKCE verification failed"), 400);
      patientRowId = row.syntheticPatientId;
      scope = row.scope;
      launchContext = row.context ?? null;
    } else if (form.grant_type === "refresh_token") {
      const row = await consume("refresh", form.refresh_token ?? "");
      if (!row || row.clientId !== clientId) return c.json(oauthError("invalid_grant", "Refresh token is invalid or expired"), 400);
      patientRowId = row.syntheticPatientId;
      scope = row.scope;
    } else {
      return c.json(oauthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported"), 400);
    }
    const [patient] = await db().select().from(syntheticPatients).where(eq(syntheticPatients.id, patientRowId)).limit(1);
    const access = await issue("access", { patientRowId, clientId, scope, ttlSeconds: 3600 });
    // Rolling refresh tokens: every use returns a new one and consumes the old.
    const refresh = scope.includes("offline_access") ? await issue("refresh", { patientRowId, clientId, scope, ttlSeconds: 90 * 86400 }) : undefined;
    const { kid, key } = await activeKey();
    const fhirUser = launchContext?.practitioner ? `${base()}/${launchContext.practitioner}` : `${base()}/Patient/${patient!.fhirPatientId}`;
    const idToken = scope.includes("openid")
      ? await new SignJWT({ fhirUser, name: launchContext ? "Dr. Grace Adebayo" : patient!.displayName })
          .setProtectedHeader({ alg: SIGNING_ALG, kid })
          .setIssuer(base())
          .setSubject(patient!.id)
          .setAudience(clientId)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(key)
      : undefined;
    return c.json({
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      scope,
      patient: patient!.fhirPatientId,
      ...(launchContext?.encounter ? { encounter: launchContext.encounter } : {}),
      ...(launchContext ? { need_patient_banner: launchContext.need_patient_banner, intent: launchContext.intent } : {}),
      ...(refresh ? { refresh_token: refresh } : {}),
      ...(idToken ? { id_token: idToken } : {}),
    });
  });

  r.post("/synthetic/oauth/revoke", async (c) => {
    const form = (await c.req.parseBody()) as Record<string, string>;
    if (form.token) await db().update(syntheticTokens).set({ consumedAt: new Date() }).where(eq(syntheticTokens.tokenHash, sha256Hex(form.token)));
    return c.body(null, 200);
  });

  // ------------------------------------------------------------------- EHR launcher (simulates a clinician opening the app from the chart)
  r.get("/synthetic/ehr-launch", async (c) => {
    const ws = c.req.query("workspace_id");
    const row = c.req.query("patient") ?? "syn_1";
    if (!ws || !/^ws_[A-Z0-9]+$/.test(ws)) return c.text("workspace_id is required", 400);
    const [patient] = await db().select().from(syntheticPatients).where(eq(syntheticPatients.id, row)).limit(1);
    if (!patient) return c.text("unknown patient", 404);
    const encounter = ((patient.bundle as { entry?: { resource?: Record<string, unknown> }[] }).entry ?? []).map((e) => e.resource).find((r) => r?.resourceType === "Encounter")?.id;
    const launch = signRequest({ patient_row: patient.id, encounter: String(encounter ?? ""), exp: String(Date.now() + 5 * 60_000) });
    const target = new URL(`${config().publicUrl}/smart/launch/${ws}`);
    target.searchParams.set("iss", base());
    target.searchParams.set("launch", launch);
    return c.redirect(target.toString(), 302);
  });

  // ------------------------------------------------------------------- Bulk Data ($export) for backend services
  async function systemAuthorized(c: Ctx) {
    const auth = c.req.header("authorization");
    if (!auth?.startsWith("Bearer ")) return false;
    const [row] = await db()
      .select()
      .from(syntheticTokens)
      .where(and(eq(syntheticTokens.tokenHash, sha256Hex(auth.slice(7))), eq(syntheticTokens.kind, "access"), eq(syntheticTokens.syntheticPatientId, SYSTEM)))
      .limit(1);
    return !!row && row.expiresAt.getTime() > Date.now();
  }

  r.get("/synthetic/fhir/r4/Group/:id/$export", async (c) => {
    if (!(await systemAuthorized(c))) return c.json(outcome("login", "System token required"), 401);
    if (c.req.header("prefer") !== "respond-async") return c.json(outcome("invalid", "Prefer: respond-async is required"), 400);
    const types = (c.req.query("_type") ?? "").split(",").filter(Boolean);
    const job = signRequest({ group: c.req.param("id"), types: types.join(","), exp: String(Date.now() + 3600_000) });
    bulkPolls.set(job, 0);
    return c.body(null, 202, { "Content-Location": `${config().publicUrl}/synthetic/bulk/status/${job}`, "Retry-After": "1" });
  });

  r.get("/synthetic/bulk/status/:job", async (c) => {
    if (!(await systemAuthorized(c))) return c.json(outcome("login", "System token required"), 401);
    const job = c.req.param("job");
    const req = readRequest(job);
    if (!req) return c.json(outcome("not-found", "Unknown job"), 404);
    const polls = (bulkPolls.get(job) ?? 0) + 1;
    bulkPolls.set(job, polls);
    if (polls < 2) return c.body(null, 202, { "Retry-After": "1", "X-Progress": "Exporting synthetic patients" });
    const people = await db().select().from(syntheticPatients).where(eq(syntheticPatients.uploaded, false));
    const present = new Set(people.flatMap((p) => ((p.bundle as { entry?: { resource?: { resourceType?: string } }[] }).entry ?? []).map((e) => e.resource?.resourceType)));
    const types = (req.types ? req.types.split(",") : [...present]).filter((t): t is string => !!t && present.has(t));
    return c.json({
      transactionTime: new Date().toISOString(),
      request: `${base()}/Group/${req.group}/$export`,
      requiresAccessToken: true,
      output: types.map((type) => ({ type, url: `${config().publicUrl}/synthetic/bulk/file/${job}/${type}` })),
      error: [],
    });
  });

  r.get("/synthetic/bulk/file/:job/:type", async (c) => {
    if (!(await systemAuthorized(c))) return c.json(outcome("login", "System token required"), 401);
    if (!readRequest(c.req.param("job"))) return c.json(outcome("not-found", "Unknown job"), 404);
    const type = c.req.param("type");
    const people = await db().select().from(syntheticPatients).where(eq(syntheticPatients.uploaded, false));
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const p of people) {
      for (const e of (p.bundle as { entry?: { resource?: Record<string, unknown> }[] }).entry ?? []) {
        const res = e.resource;
        if (!res || res.resourceType !== type || seen.has(String(res.id))) continue;
        seen.add(String(res.id));
        lines.push(JSON.stringify(res));
      }
    }
    return c.body(lines.join("\n") + (lines.length ? "\n" : ""), 200, { "Content-Type": "application/fhir+ndjson" });
  });

  // ------------------------------------------------------------------- FHIR API
  async function authorize(c: Ctx) {
    const auth = c.req.header("authorization");
    if (!auth?.startsWith("Bearer ")) return null;
    const [row] = await db()
      .select()
      .from(syntheticTokens)
      .where(and(eq(syntheticTokens.tokenHash, sha256Hex(auth.slice(7))), eq(syntheticTokens.kind, "access")))
      .limit(1);
    if (!row || row.expiresAt.getTime() < Date.now() || row.consumedAt) return null;
    const [patient] = await db().select().from(syntheticPatients).where(eq(syntheticPatients.id, row.syntheticPatientId)).limit(1);
    return patient ?? null;
  }

  const outcome = (code: string, diagnostics: string) => ({ resourceType: "OperationOutcome", issue: [{ severity: "error", code, diagnostics }] });

  r.get("/synthetic/fhir/r4/:type/:id", async (c) => {
    const patient = await authorize(c);
    if (!patient) return c.json(outcome("login", "Invalid or expired access token"), 401);
    const entries = ((patient.bundle as { entry?: { resource?: Record<string, unknown> }[] }).entry ?? []).map((e) => e.resource!).filter(Boolean);
    const found = entries.find((x) => x.resourceType === c.req.param("type") && x.id === c.req.param("id"));
    if (!found) return c.json(outcome("not-found", "Resource not found"), 404);
    return c.json(found, 200, { "Content-Type": "application/fhir+json" });
  });

  r.get("/synthetic/fhir/r4/:type", async (c) => {
    const patient = await authorize(c);
    if (!patient) return c.json(outcome("login", "Invalid or expired access token"), 401);
    if (syntheticFaults.rateLimitOnce) {
      syntheticFaults.rateLimitOnce = false;
      return c.json(outcome("throttled", "Too many requests"), 429, { "Retry-After": "1" });
    }
    const type = c.req.param("type");
    if (syntheticFaults.failSearchFor.has(type)) return c.json(outcome("forbidden", "Not permitted in sandbox"), 403);
    const q = new URL(c.req.url).searchParams;
    const ref = q.get("patient") ?? q.get("subject") ?? q.get("beneficiary");
    const target = ref?.replace(/^Patient\//, "");
    if (!target) return c.json(outcome("required", "A patient, subject or beneficiary parameter is required"), 400);
    if (target !== patient.fhirPatientId) return c.json(outcome("forbidden", "Outside the authorized patient compartment"), 403);
    const entries = ((patient.bundle as { entry?: { resource?: Record<string, unknown> }[] }).entry ?? []).map((e) => e.resource!).filter(Boolean);
    const category = q.get("category");
    const matched = entries.filter((x) => {
      if (x.resourceType !== type) return false;
      const subj = ((x.subject ?? x.patient ?? x.beneficiary) as { reference?: string } | undefined)?.reference;
      if (subj !== `Patient/${patient.fhirPatientId}`) return false;
      if (category) {
        const cats = ((x.category as { coding?: { code?: string }[] }[] | undefined) ?? []).flatMap((cc) => (cc.coding ?? []).map((cd) => cd.code));
        if (!cats.includes(category)) return false;
      }
      return true;
    });
    const count = Math.min(Number(q.get("_count") ?? syntheticFaults.pageSize) || syntheticFaults.pageSize, syntheticFaults.pageSize);
    const offset = Number(q.get("_offset") ?? 0) || 0;
    const slice = matched.slice(offset, offset + count);
    const self = new URL(c.req.url);
    const link = [{ relation: "self", url: self.toString() }];
    if (offset + count < matched.length) {
      const next = new URL(`${base()}/${type}`);
      for (const [k, v] of q) if (k !== "_offset") next.searchParams.set(k, v);
      next.searchParams.set("_offset", String(offset + count));
      link.push({ relation: "next", url: next.toString() });
    }
    return c.json(
      { resourceType: "Bundle", type: "searchset", total: matched.length, link, entry: slice.map((resource) => ({ fullUrl: `${base()}/${type}/${resource.id}`, resource, search: { mode: "match" } })) },
      200,
      { "Content-Type": "application/fhir+json" },
    );
  });

  return r;
}
