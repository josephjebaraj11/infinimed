import { Hono } from "hono";
import { html } from "hono/html";
import { getCookie, setCookie } from "hono/cookie";
import { createHmac } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { mcpAuthCodes, mcpClients, mcpGrants, workspaces } from "../db/schema.js";
import { cursorSigningKey, safeEqual, sha256Hex } from "../lib/crypto.js";
import { newId, randomToken } from "../lib/ids.js";
import type { AppEnv } from "../http/context.js";
import { clientIp } from "../http/context.js";
import { authenticate, createSessionFor, createUser, membershipsFor, sessionFromToken, SESSION_TTL_MS } from "../services/accounts.js";
import { audit } from "../services/audit.js";
import { signPlatformJwt } from "../services/keys.js";
import { pkceChallengeFor } from "../smart/pkce.js";
import { CSP, layout } from "../routes/pages/layout.js";

/**
 * OAuth 2.1 authorization server for the MCP endpoint, per the MCP authorization spec:
 *   - Protected Resource Metadata (RFC 9728) advertises this server for {PUBLIC_URL}/mcp
 *   - Authorization Server Metadata (RFC 8414)
 *   - Dynamic Client Registration (RFC 7591) for public clients (Claude, ChatGPT, Codex...)
 *   - authorization code + PKCE (S256), Resource Indicators (RFC 8707), rotating refresh tokens
 * The consent screen lets the user pick the workspace and untick any capability. Access tokens are
 * one-hour JWTs signed with the platform key; revoking a grant stops refreshes immediately.
 */

export const MCP_SCOPES = {
  connect: "Connect your healthcare facilities: search hospitals, clinics and insurers and start secure connections.",
  "records:read": "Read your health records that have been brought into the workspace.",
  manage: "Manage people and delete data: add or remove people, disconnect facilities, delete records.",
} as const;
export type McpScope = keyof typeof MCP_SCOPES;

const COOKIE = "im_session";
const pub = () => config().publicUrl;

export function protectedResourceMetadata() {
  return {
    resource: config().mcpResourceUrl,
    authorization_servers: [pub()],
    scopes_supported: Object.keys(MCP_SCOPES),
    bearer_methods_supported: ["header"],
    resource_name: "InfiniMed workspace",
  };
}

export function authorizationServerMetadata() {
  return {
    issuer: pub(),
    authorization_endpoint: `${pub()}/oauth/authorize`,
    token_endpoint: `${pub()}/oauth/token`,
    registration_endpoint: `${pub()}/oauth/register`,
    revocation_endpoint: `${pub()}/oauth/revoke`,
    jwks_uri: config().jwksUrl,
    scopes_supported: Object.keys(MCP_SCOPES),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function validRedirect(uri: string) {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return true;
    // Native apps may register private-use schemes (RFC 8252 7.1).
    return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(u.protocol);
  } catch {
    return false;
  }
}

function sign(params: Record<string, string>) {
  const body = Buffer.from(JSON.stringify({ ...params, exp: Date.now() + 15 * 60_000 })).toString("base64url");
  return `${body}.${createHmac("sha256", cursorSigningKey()).update(`mcp:${body}`).digest("base64url")}`;
}
function unsign(v: string): Record<string, string> | null {
  const [body, mac] = v.split(".");
  if (!body || !mac || !safeEqual(createHmac("sha256", cursorSigningKey()).update(`mcp:${body}`).digest("base64url"), mac)) return null;
  const p = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, string> & { exp: number };
  return p.exp > Date.now() ? p : null;
}

async function issueTokens(grant: typeof mcpGrants.$inferSelect) {
  const refresh = `imr_${randomToken(32)}`;
  await db().update(mcpGrants).set({ refreshTokenHash: sha256Hex(refresh), lastUsedAt: new Date() }).where(eq(mcpGrants.id, grant.id));
  const access = await signPlatformJwt(
    { scope: grant.scopes.join(" "), gid: grant.id, client_id: grant.clientId },
    { audience: config().mcpResourceUrl, expiresIn: "1h", subject: grant.userId },
  );
  return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: grant.scopes.join(" ") };
}

export function mcpOauthRouter() {
  const r = new Hono<AppEnv>();

  r.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata()));
  r.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResourceMetadata()));
  r.get("/.well-known/oauth-authorization-server", (c) => c.json(authorizationServerMetadata()));
  r.get("/.well-known/oauth-authorization-server/*", (c) => c.json(authorizationServerMetadata()));

  r.post("/oauth/register", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { client_name?: string; redirect_uris?: string[]; token_endpoint_auth_method?: string };
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === "string") : [];
    if (uris.length === 0 || uris.length > 10 || !uris.every(validRedirect)) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be https, loopback http, or a private-use scheme" }, 400);
    }
    const id = newId("mcpClient");
    await db()
      .insert(mcpClients)
      .values({ id, clientName: (body.client_name ?? "MCP client").slice(0, 100), redirectUris: uris, metadata: { registered_from: clientIp(c) } });
    return c.json(
      {
        client_id: id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: body.client_name ?? "MCP client",
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  const page = (title: string, body: ReturnType<typeof html>) => layout({ title, branding: { display_name: "InfiniMed" }, body });

  r.get("/oauth/authorize", async (c) => {
    c.header("Content-Security-Policy", CSP);
    const q = Object.fromEntries(new URL(c.req.url).searchParams);
    const [client] = q.client_id ? await db().select().from(mcpClients).where(eq(mcpClients.id, q.client_id)).limit(1) : [];
    if (!client || !q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
      return c.html(page("Invalid request", html`<div class="card"><h1>Invalid request</h1><p>Unknown client or redirect URI.</p></div>`), 400);
    }
    const back = new URL(q.redirect_uri);
    if (q.state) back.searchParams.set("state", q.state);
    if (q.response_type !== "code" || !q.code_challenge || q.code_challenge_method !== "S256") {
      back.searchParams.set("error", "invalid_request");
      back.searchParams.set("error_description", "response_type=code with PKCE S256 is required");
      return c.redirect(back.toString(), 302);
    }
    if (q.resource && q.resource.replace(/\/+$/, "") !== config().mcpResourceUrl) {
      back.searchParams.set("error", "invalid_target");
      return c.redirect(back.toString(), 302);
    }
    const signed = sign({ client_id: client.id, redirect_uri: q.redirect_uri, state: q.state ?? "", code_challenge: q.code_challenge, resource: q.resource ?? "", scope: q.scope ?? "" });
    const token = getCookie(c, COOKIE);
    const session = token ? await sessionFromToken(token) : null;
    if (!session) {
      return c.html(
        page(
          "Sign in",
          html`<div class="card">
              <h1>Sign in to InfiniMed</h1>
              <p><strong>${client.clientName}</strong> wants to connect to your InfiniMed workspace.</p>
              <form method="post" action="/oauth/login">
                <input type="hidden" name="request" value="${signed}">
                <label for="email">Email</label><input id="email" name="email" type="text" autocomplete="email">
                <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
                <p></p><button type="submit">Sign in</button>
              </form>
            </div>
            <div class="card">
              <h2>New here?</h2>
              <form method="post" action="/oauth/login">
                <input type="hidden" name="request" value="${signed}"><input type="hidden" name="create" value="1">
                <label for="n">Your name</label><input id="n" name="name" type="text" autocomplete="name">
                <label for="e2">Email</label><input id="e2" name="email" type="text" autocomplete="email">
                <label for="p2">Password (10+ characters)</label><input id="p2" name="password" type="password" autocomplete="new-password">
                <p></p><button type="submit" class="secondary">Create account and continue</button>
              </form>
            </div>`,
        ),
      );
    }
    const ms = await membershipsFor(session.user.id);
    const requested = (q.scope ? q.scope.split(/\s+/) : Object.keys(MCP_SCOPES)).filter((s): s is McpScope => s in MCP_SCOPES);
    const scopes = requested.length ? requested : (Object.keys(MCP_SCOPES) as McpScope[]);
    const production = ms.filter((m) => m.ws.environment === "production");
    const preferred = production[0] ?? ms[0];
    return c.html(
      page(
        "Allow access",
        html`<div class="card">
          <h1>Allow ${client.clientName}?</h1>
          <p>It will know your name and email and can see the workspace you choose. Choose what else it may do.</p>
          <form method="post" action="/oauth/consent">
            <input type="hidden" name="request" value="${signed}">
            <label for="ws">Workspace</label>
            <select id="ws" name="workspace_id">${ms.map((m) => html`<option value="${m.ws.id}" ${m.ws.id === preferred?.ws.id ? "selected" : ""}>${m.ws.name} (${m.ws.environment})</option>`)}</select>
            ${scopes.map(
              (s) => html`<label style="font-weight:400;display:flex;gap:8px;align-items:flex-start;margin-top:14px"><input type="checkbox" name="scope" value="${s}" checked> <span><strong>${s}</strong><br><span class="muted">${MCP_SCOPES[s]}</span></span></label>`,
            )}
            <p></p>
            <div class="row"><button type="submit" name="decision" value="deny" class="secondary">Cancel</button><button type="submit" name="decision" value="allow">Allow</button></div>
          </form>
        </div>`,
      ),
    );
  });

  r.post("/oauth/login", async (c) => {
    const form = await c.req.parseBody();
    const req = unsign(String(form.request ?? ""));
    if (!req) return c.text("Request expired; start again from your assistant.", 400);
    try {
      let user;
      if (form.create === "1") {
        user = await createUser({ email: form.email, password: form.password, name: form.name });
        // New people get a personal production workspace that holds only their own records.
        const id = newId("workspace");
        await db().insert(workspaces).values({ id, name: `${user.name ?? "My"} health records`, environment: "production", personal: true, branding: { display_name: "InfiniMed" } });
        const { memberships } = await import("../db/schema.js");
        await db().insert(memberships).values({ id: newId("membership"), userId: user.id, workspaceId: id, role: "owner" });
      } else {
        user = await authenticate(form.email, form.password, clientIp(c));
      }
      const ms = await membershipsFor(user.id);
      const s = await createSessionFor(user.id, ms[0]?.ws.id ?? null, { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? null });
      setCookie(c, COOKIE, s.token, { httpOnly: true, secure: config().isProduction, sameSite: "Lax", path: "/", maxAge: Math.floor(SESSION_TTL_MS / 1000) });
    } catch (err) {
      return c.html(page("Sign in failed", html`<div class="card"><h1>Sign in failed</h1><p>${(err as Error).message}</p><p><a href="javascript:history.back()">Back</a></p></div>`), 400);
    }
    const qs = new URLSearchParams({ response_type: "code", client_id: req.client_id!, redirect_uri: req.redirect_uri!, code_challenge: req.code_challenge!, code_challenge_method: "S256", state: req.state ?? "", scope: req.scope ?? "" });
    if (req.resource) qs.set("resource", req.resource);
    return c.redirect(`/oauth/authorize?${qs.toString()}`, 302);
  });

  r.post("/oauth/consent", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const req = unsign(String(form.request ?? ""));
    const token = getCookie(c, COOKIE);
    const session = token ? await sessionFromToken(token) : null;
    if (!req || !session) return c.text("Request expired; start again from your assistant.", 400);
    const back = new URL(req.redirect_uri!);
    if (req.state) back.searchParams.set("state", req.state);
    if (form.decision !== "allow") {
      back.searchParams.set("error", "access_denied");
      return c.redirect(back.toString(), 302);
    }
    const wsId = String(form.workspace_id ?? "");
    const ms = await membershipsFor(session.user.id);
    if (!ms.some((m) => m.ws.id === wsId)) return c.text("Not a member of that workspace", 403);
    const raw = form.scope;
    const scopes = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String).filter((s) => s in MCP_SCOPES);
    const code = randomToken(32);
    await db()
      .insert(mcpAuthCodes)
      .values({
        codeHash: sha256Hex(code),
        clientId: req.client_id!,
        userId: session.user.id,
        workspaceId: wsId,
        scopes,
        codeChallenge: req.code_challenge!,
        redirectUri: req.redirect_uri!,
        resource: req.resource || null,
        expiresAt: new Date(Date.now() + 2 * 60_000),
      });
    await audit({ workspaceId: wsId, actor: { type: "user", id: session.user.id }, action: "mcp.consent", metadata: { client_id: req.client_id, scopes }, ip: clientIp(c) });
    back.searchParams.set("code", code);
    return c.redirect(back.toString(), 302);
  });

  r.post("/oauth/token", async (c) => {
    const form = (await c.req.parseBody()) as Record<string, string>;
    const err = (error: string, description: string, status = 400) => c.json({ error, error_description: description }, status as 400);
    if (form.resource && form.resource.replace(/\/+$/, "") !== config().mcpResourceUrl) return err("invalid_target", "Unknown resource");
    if (form.grant_type === "authorization_code") {
      const [code] = await db()
        .update(mcpAuthCodes)
        .set({ consumedAt: new Date() })
        .where(and(eq(mcpAuthCodes.codeHash, sha256Hex(form.code ?? "")), isNull(mcpAuthCodes.consumedAt), gt(mcpAuthCodes.expiresAt, new Date())))
        .returning();
      if (!code || code.clientId !== form.client_id || code.redirectUri !== form.redirect_uri) return err("invalid_grant", "Invalid authorization code");
      if (!form.code_verifier || pkceChallengeFor(form.code_verifier) !== code.codeChallenge) return err("invalid_grant", "PKCE verification failed");
      const [grant] = await db()
        .insert(mcpGrants)
        .values({ id: newId("mcpGrant"), clientId: code.clientId, userId: code.userId, workspaceId: code.workspaceId, scopes: code.scopes })
        .returning();
      return c.json(await issueTokens(grant!));
    }
    if (form.grant_type === "refresh_token") {
      const [grant] = await db()
        .select()
        .from(mcpGrants)
        .where(and(eq(mcpGrants.refreshTokenHash, sha256Hex(form.refresh_token ?? "")), isNull(mcpGrants.revokedAt)))
        .limit(1);
      if (!grant || (form.client_id && form.client_id !== grant.clientId)) return err("invalid_grant", "Invalid refresh token");
      return c.json(await issueTokens(grant));
    }
    return err("unsupported_grant_type", "Use authorization_code or refresh_token");
  });

  r.post("/oauth/revoke", async (c) => {
    const form = (await c.req.parseBody()) as Record<string, string>;
    if (form.token) await db().update(mcpGrants).set({ revokedAt: new Date(), refreshTokenHash: null }).where(eq(mcpGrants.refreshTokenHash, sha256Hex(form.token)));
    return c.body(null, 200);
  });

  r.get("/mcp/connected", (c) =>
    c.html(page("Connected", html`<div class="card"><h1>You're all set</h1><p>Return to your AI assistant and ask it to check the connection status.</p></div>`)),
  );

  return r;
}
