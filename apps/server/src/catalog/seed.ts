import { and, eq, isNull } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { sources, type Environment, type SourceCategory, type Surface } from "../db/schema.js";
import { newId } from "../lib/ids.js";
import { buildSearchText, normalizeBaseUrl } from "../services/sources.js";

/**
 * Built-in catalog entries: every public vendor sandbox with a documented, stable endpoint plus the
 * production endpoints that are app-global (one registration serves every member). Per-organization
 * production endpoints (each Epic, Oracle Health, MEDITECH or healow customer) are loaded from the
 * vendors' published directories with `pnpm catalog:import` (see catalog/importer.ts).
 */

export type SeedSource = {
  key: string;
  name: string;
  vendor: string;
  category: SourceCategory;
  environment: Environment;
  fhirBaseUrl: string;
  audience?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  revokeUrl?: string;
  userinfoUrl?: string;
  jwksUri?: string;
  logoUrl?: string;
  portalUrl?: string;
  surfaces: Surface[];
  details?: Record<string, unknown>;
};

export function builtInSources(): SeedSource[] {
  const pub = config().publicUrl;
  return [
    {
      key: "synthetic-hospital",
      name: "Synthetic Hospital",
      vendor: "synthetic",
      category: "sandbox",
      environment: "sandbox",
      fhirBaseUrl: `${pub}/synthetic/fhir/r4`,
      authorizeUrl: `${pub}/synthetic/oauth/authorize`,
      tokenUrl: `${pub}/synthetic/oauth/token`,
      revokeUrl: `${pub}/synthetic/oauth/revoke`,
      surfaces: ["patient_access", "clinical_workflow", "backend"],
      details: { aliases: ["test", "demo", "infinimed"], pinned_endpoints: true },
    },
    {
      key: "smart-health-it",
      name: "SMART Health IT Sandbox",
      vendor: "smart_sandbox",
      category: "sandbox",
      environment: "sandbox",
      // Launcher "sim" segment: base64 JSON launch options; launch type 3 = patient standalone.
      fhirBaseUrl: "https://launch.smarthealthit.org/v/r4/sim/WzMsIiIsIiIsIkFVVE8iLDAsMCwwLCIiLCIiLCIiLCIiLCIiLCIiLCIiLDAsMV0/fhir",
      portalUrl: "https://launch.smarthealthit.org/",
      surfaces: ["patient_access", "clinical_workflow"],
      details: { aliases: ["smart", "reference"] },
    },
    {
      key: "epic-sandbox",
      name: "Epic Sandbox (MyChart)",
      vendor: "epic",
      category: "ehr",
      environment: "sandbox",
      fhirBaseUrl: "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4",
      portalUrl: "https://fhir.epic.com/Documentation?docId=testpatients",
      surfaces: ["patient_access", "clinical_workflow", "backend"],
      details: { aliases: ["mychart", "epic on fhir"] },
    },
    {
      key: "cerner-sandbox-patient",
      name: "Oracle Health Code Sandbox (Patient)",
      vendor: "cerner",
      category: "ehr",
      environment: "sandbox",
      fhirBaseUrl: "https://fhir-myrecord.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d",
      surfaces: ["patient_access"],
      details: { aliases: ["cerner", "oracle"], tenant_id: "ec2458f2-1e24-41c8-b71b-0e701af7583d" },
    },
    {
      key: "cerner-sandbox-provider",
      name: "Oracle Health Code Sandbox (Provider)",
      vendor: "cerner",
      category: "ehr",
      environment: "sandbox",
      fhirBaseUrl: "https://fhir-ehr-code.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d",
      surfaces: ["clinical_workflow", "backend"],
      details: { aliases: ["cerner", "oracle", "powerchart"], tenant_id: "ec2458f2-1e24-41c8-b71b-0e701af7583d" },
    },
    {
      key: "athena-preview",
      name: "athenahealth Preview",
      vendor: "athena",
      category: "ehr",
      environment: "sandbox",
      fhirBaseUrl: "https://api.preview.platform.athenahealth.com/fhir/r4",
      authorizeUrl: "https://api.preview.platform.athenahealth.com/oauth2/v1/authorize",
      tokenUrl: "https://api.preview.platform.athenahealth.com/oauth2/v1/token",
      surfaces: ["patient_access"],
      details: { aliases: ["athena", "athenaone"], practice_id: "80000", pinned_endpoints: true },
    },
    {
      key: "meditech-greenfield",
      name: "MEDITECH Greenfield Workspace",
      vendor: "meditech",
      category: "ehr",
      environment: "sandbox",
      fhirBaseUrl: "https://greenfield-prod-apis.meditech.com/v2/uscore/STU6",
      authorizeUrl: "https://greenfield-prod-apis.meditech.com/oauth/authorize",
      tokenUrl: "https://greenfield-prod-apis.meditech.com/oauth/token",
      revokeUrl: "https://greenfield-prod-apis.meditech.com/oauth/revoke",
      surfaces: ["patient_access"],
      details: { aliases: ["expanse", "greenfield"], pinned_endpoints: true },
    },
    {
      key: "aetna-sandbox",
      name: "Aetna Sandbox",
      vendor: "aetna",
      category: "payer",
      environment: "sandbox",
      fhirBaseUrl: "https://vteapif1.aetna.com/fhirdemo/v2/patientaccess",
      audience: "https://vteapif1.aetna.com/fhirdemo",
      authorizeUrl: "https://vteapif1.aetna.com/fhirdemo/v1/fhirserver_auth/oauth2/authorize",
      tokenUrl: "https://vteapif1.aetna.com/fhirdemo/v1/fhirserver_auth/oauth2/token",
      surfaces: ["patient_access"],
      details: { aliases: ["cvs", "insurance", "payer"], pinned_endpoints: true },
    },
    {
      key: "cms-bb-sandbox",
      name: "Medicare (CMS Blue Button) Sandbox",
      vendor: "cms_bluebutton",
      category: "payer",
      environment: "sandbox",
      fhirBaseUrl: "https://sandbox.bluebutton.cms.gov/v2/fhir",
      audience: "https://sandbox.bluebutton.cms.gov/v2/fhir/",
      authorizeUrl: "https://sandbox.bluebutton.cms.gov/v2/o/authorize/",
      tokenUrl: "https://sandbox.bluebutton.cms.gov/v2/o/token/",
      revokeUrl: "https://sandbox.bluebutton.cms.gov/v2/o/revoke_token/",
      userinfoUrl: "https://sandbox.bluebutton.cms.gov/v2/connect/userinfo",
      jwksUri: "https://sandbox.bluebutton.cms.gov/v2/o/jwks/",
      surfaces: ["patient_access"],
      details: { aliases: ["medicare", "cms", "blue button"], pinned_endpoints: true },
    },
    {
      key: "cms-bb-production",
      name: "Medicare (CMS Blue Button)",
      vendor: "cms_bluebutton",
      category: "payer",
      environment: "production",
      fhirBaseUrl: "https://api.bluebutton.cms.gov/v2/fhir",
      audience: "https://api.bluebutton.cms.gov/v2/fhir/",
      authorizeUrl: "https://api.bluebutton.cms.gov/v2/o/authorize/",
      tokenUrl: "https://api.bluebutton.cms.gov/v2/o/token/",
      revokeUrl: "https://api.bluebutton.cms.gov/v2/o/revoke_token/",
      userinfoUrl: "https://api.bluebutton.cms.gov/v2/connect/userinfo",
      jwksUri: "https://api.bluebutton.cms.gov/v2/o/jwks/",
      portalUrl: "https://www.medicare.gov/",
      surfaces: ["patient_access"],
      details: { aliases: ["medicare", "cms", "blue button"], pinned_endpoints: true },
    },
    {
      key: "athena-production",
      name: "athenahealth",
      vendor: "athena",
      category: "ehr",
      environment: "production",
      fhirBaseUrl: "https://api.platform.athenahealth.com/fhir/r4",
      authorizeUrl: "https://api.platform.athenahealth.com/oauth2/v1/authorize",
      tokenUrl: "https://api.platform.athenahealth.com/oauth2/v1/token",
      surfaces: ["patient_access"],
      details: { aliases: ["athena", "athenaone"], pinned_endpoints: true },
    },
  ];
}

export async function upsertSeedSource(s: SeedSource, workspaceId: string | null = null) {
  const base = normalizeBaseUrl(s.fhirBaseUrl);
  const where = and(
    eq(sources.environment, s.environment),
    workspaceId ? eq(sources.workspaceId, workspaceId) : isNull(sources.workspaceId),
  );
  // Built-ins are matched by their stable key (the synthetic hospital's URL follows PUBLIC_URL).
  const existing = (await db().select().from(sources).where(where)).find(
    (r) => r.details?.seed_key === s.key || r.fhirBaseUrl === base,
  );
  const details: Record<string, unknown> = { ...(s.details ?? {}), seed_key: s.key };
  const values = {
    name: s.name,
    vendor: s.vendor,
    category: s.category,
    environment: s.environment,
    fhirBaseUrl: base,
    audience: s.audience ?? null,
    authorizeUrl: s.authorizeUrl ?? existing?.authorizeUrl ?? null,
    tokenUrl: s.tokenUrl ?? existing?.tokenUrl ?? null,
    revokeUrl: s.revokeUrl ?? existing?.revokeUrl ?? null,
    userinfoUrl: s.userinfoUrl ?? existing?.userinfoUrl ?? null,
    jwksUri: s.jwksUri ?? existing?.jwksUri ?? null,
    logoUrl: s.logoUrl ?? null,
    portalUrl: s.portalUrl ?? null,
    city: typeof details.city === "string" ? details.city : null,
    state: typeof details.state === "string" ? details.state : null,
    surfaces: s.surfaces,
    details,
    searchText: buildSearchText({
      name: s.name,
      vendor: s.vendor,
      city: typeof details.city === "string" ? details.city : null,
      state: typeof details.state === "string" ? details.state : null,
      details,
    }),
    updatedAt: new Date(),
  };
  if (existing) {
    await db().update(sources).set(values).where(eq(sources.id, existing.id));
    return existing.id;
  }
  const id = newId("source");
  await db()
    .insert(sources)
    .values({ id, workspaceId, ...values });
  return id;
}

export async function seedCatalog() {
  for (const s of builtInSources()) await upsertSeedSource(s);
}

export async function syntheticSourceId(): Promise<string> {
  const rows = await db().select().from(sources).where(and(eq(sources.vendor, "synthetic"), isNull(sources.workspaceId)));
  const row = rows[0];
  if (!row) throw new Error("synthetic hospital source not seeded");
  return row.id;
}
