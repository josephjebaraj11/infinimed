import type { TokenAuthMethod, Surface, SourceCategory } from "../db/schema.js";

/**
 * Vendor profiles capture everything that differs between EHR and payer implementations of the
 * "same" standards: client authentication method, scopes, extra authorize parameters, how the
 * patient identity is returned, refresh behaviour, and the FHIR query plan the background pull runs.
 * Adding a source of a known vendor needs no code; a new vendor needs a profile here.
 */

export type QueryStep = {
  resourceType: string;
  /** search parameters; `{patient}` is replaced with the patient's FHIR id */
  params: Record<string, string>;
  /** label used in pull details when one resource type is split across several queries */
  label?: string;
};

export type VendorProfile = {
  vendor: string;
  displayName: string;
  category: SourceCategory;
  defaultTokenAuthMethod: TokenAuthMethod;
  pkce: boolean;
  scopes: Partial<Record<Surface, string[]>>;
  extraAuthorizeParams?: Record<string, string>;
  /** Where the patient FHIR id comes from, in priority order. */
  identity: ("token_patient" | "id_token_fhir_user" | "userinfo")[];
  /** Does the vendor issue refresh tokens for patient access? */
  refreshTokens: boolean;
  /** Patient compartment query plan for patient access and backend reads. */
  queryPlan: QueryStep[];
  /** References to follow after the main queries (resource types). */
  followReferences: string[];
  /** Soft request budget per minute per FHIR base (vendor-published or conservative). */
  requestsPerMinute: number;
  /** Bulk Data `_type` list for backend group export. */
  bulkTypes?: string[];
  notes?: string;
};

const USCDI_RESOURCES = [
  "AllergyIntolerance",
  "CarePlan",
  "CareTeam",
  "Condition",
  "Coverage",
  "Device",
  "DiagnosticReport",
  "DocumentReference",
  "Encounter",
  "Goal",
  "Immunization",
  "MedicationRequest",
  "Observation",
  "Procedure",
  "ServiceRequest",
] as const;

const patientScopesFor = (resources: readonly string[], extra: string[] = []) => [
  ...extra,
  ...resources.map((r) => `patient/${r}.read`),
];

const byPatient = (types: readonly string[]): QueryStep[] =>
  types.map((resourceType) => ({ resourceType, params: { patient: "{patient}" } }));

const OBSERVATION_CATEGORIES = [
  "laboratory",
  "vital-signs",
  "social-history",
  "survey",
  "exam",
  "imaging",
  "procedure",
  "sdoh",
  "functional-status",
];

const DEFAULT_FOLLOW = ["Practitioner", "PractitionerRole", "Organization", "Location", "Medication", "RelatedPerson"];

/** Generic US Core plan, used by vendors that accept `patient` on every USCDI resource. */
const GENERIC_PLAN: QueryStep[] = byPatient(USCDI_RESOURCES);

const EPIC_PLAN: QueryStep[] = [
  ...byPatient(["AllergyIntolerance", "Condition", "Coverage", "Device", "DiagnosticReport", "DocumentReference", "Encounter", "Goal", "Immunization", "MedicationRequest", "Procedure", "ServiceRequest", "CareTeam"]),
  // Epic requires a category on Observation and CarePlan searches.
  ...OBSERVATION_CATEGORIES.map((category) => ({
    resourceType: "Observation",
    params: { patient: "{patient}", category },
    label: `Observation:${category}`,
  })),
  { resourceType: "CarePlan", params: { patient: "{patient}", category: "assess-plan" }, label: "CarePlan:assess-plan" },
];

const CARIN_BB_PLAN = (beneficiaryParam: "patient" | "beneficiary"): QueryStep[] => [
  {
    resourceType: "Coverage",
    params: beneficiaryParam === "beneficiary" ? { beneficiary: "Patient/{patient}" } : { patient: "{patient}" },
  },
  { resourceType: "ExplanationOfBenefit", params: { patient: "{patient}" } },
];

export const PROFILES: Record<string, VendorProfile> = {
  epic: {
    vendor: "epic",
    displayName: "Epic",
    category: "ehr",
    defaultTokenAuthMethod: "private_key_jwt",
    pkce: true,
    scopes: {
      patient_access: ["openid", "fhirUser", "launch/patient", "offline_access"],
      clinical_workflow: ["launch", "openid", "fhirUser"],
      backend: ["system/Patient.read", "system/Observation.read", "system/Condition.read", "system/Group.read"],
    },
    identity: ["token_patient", "id_token_fhir_user"],
    refreshTokens: true,
    queryPlan: EPIC_PLAN,
    followReferences: DEFAULT_FOLLOW,
    requestsPerMinute: 300,
    bulkTypes: [...USCDI_RESOURCES, "Patient"],
    notes: "Rolling refresh tokens require 'Requires Persistent Access' and 'Uses Rolling Refresh Tokens' in the app registration.",
  },
  cerner: {
    vendor: "cerner",
    displayName: "Oracle Health (Cerner)",
    category: "ehr",
    defaultTokenAuthMethod: "private_key_jwt",
    pkce: true,
    scopes: {
      patient_access: patientScopesFor(["Patient", ...USCDI_RESOURCES, "RelatedPerson"], ["openid", "fhirUser", "launch/patient", "offline_access"]),
      clinical_workflow: ["openid", "fhirUser", "launch", "user/Patient.read", "user/Encounter.read", "user/Observation.read", "online_access"],
      backend: [
        ...USCDI_RESOURCES.map((r) => `system/${r}.read`),
        "system/Patient.read",
        "system/Binary.read",
        "system/Location.read",
        "system/Organization.read",
        "system/Practitioner.read",
        "system/RelatedPerson.read",
        "system/Group.read",
      ],
    },
    identity: ["token_patient", "id_token_fhir_user"],
    refreshTokens: true,
    queryPlan: [...GENERIC_PLAN, { resourceType: "RelatedPerson", params: { patient: "{patient}" } }],
    followReferences: DEFAULT_FOLLOW,
    requestsPerMinute: 300,
    bulkTypes: [...USCDI_RESOURCES, "Patient"],
  },
  athena: {
    vendor: "athena",
    displayName: "athenahealth",
    category: "ehr",
    defaultTokenAuthMethod: "private_key_jwt",
    pkce: true,
    scopes: {
      patient_access: patientScopesFor(["Patient", ...USCDI_RESOURCES], ["openid", "fhirUser", "launch/patient", "offline_access"]),
      clinical_workflow: ["launch", "openid", "fhirUser", "user/Patient.read", "user/Encounter.read", "user/Observation.read"],
      backend: ["system/Patient.read", "system/Observation.read"],
    },
    identity: ["token_patient", "id_token_fhir_user"],
    refreshTokens: true,
    queryPlan: GENERIC_PLAN,
    followReferences: DEFAULT_FOLLOW,
    requestsPerMinute: 150,
    notes: "The practice is selected before OAuth; its FHIR base URL is the `aud`.",
  },
  ecw: {
    vendor: "ecw",
    displayName: "eClinicalWorks (healow)",
    category: "ehr",
    defaultTokenAuthMethod: "private_key_jwt",
    pkce: true,
    scopes: {
      patient_access: patientScopesFor(["Patient", ...USCDI_RESOURCES, "Provenance"], ["openid", "fhirUser", "launch/patient", "offline_access"]),
      clinical_workflow: ["launch", "openid", "fhirUser", "user/Patient.read"],
    },
    identity: ["token_patient", "id_token_fhir_user"],
    refreshTokens: true,
    queryPlan: GENERIC_PLAN,
    followReferences: DEFAULT_FOLLOW,
    // healow: 250 calls/minute per base URL, including authorize and token calls.
    requestsPerMinute: 200,
  },
  meditech: {
    vendor: "meditech",
    displayName: "MEDITECH Expanse",
    category: "ehr",
    defaultTokenAuthMethod: "client_secret_post",
    pkce: true,
    scopes: {
      patient_access: patientScopesFor(["Patient", ...USCDI_RESOURCES, "MedicationDispense", "Specimen", "Provenance"], ["openid", "fhirUser", "launch/patient", "offline_access"]),
    },
    identity: ["token_patient", "id_token_fhir_user"],
    refreshTokens: true,
    queryPlan: [...GENERIC_PLAN, ...byPatient(["MedicationDispense", "Specimen"])],
    followReferences: DEFAULT_FOLLOW,
    requestsPerMinute: 120,
    notes: "Authorization codes are signed JWTs with a 60 second TTL; the callback exchanges them inline.",
  },
  aetna: {
    vendor: "aetna",
    displayName: "Aetna",
    category: "payer",
    defaultTokenAuthMethod: "client_secret_basic",
    pkce: true,
    scopes: { patient_access: ["launch/patient", "patient/*.read"] },
    extraAuthorizeParams: { skin: "skin13" },
    identity: ["token_patient"],
    refreshTokens: false,
    queryPlan: [
      ...CARIN_BB_PLAN("patient"),
      ...byPatient(["AllergyIntolerance", "CarePlan", "CareTeam", "Condition", "Device", "DiagnosticReport", "DocumentReference", "Encounter", "Goal", "Immunization", "MedicationDispense", "MedicationRequest", "Observation", "Procedure"]),
    ],
    followReferences: [...DEFAULT_FOLLOW],
    requestsPerMinute: 60,
    notes: "OAuth `aud` is the auth root, not the resource base. No refresh tokens: the first pull must finish on the initial access token.",
  },
  uhc: {
    vendor: "uhc",
    displayName: "UnitedHealthcare",
    category: "payer",
    defaultTokenAuthMethod: "client_secret_basic",
    pkce: true,
    scopes: {
      patient_access: patientScopesFor(["Patient", "Coverage", "ExplanationOfBenefit", "Condition", "Encounter", "Procedure", "MedicationRequest", "MedicationDispense", "Observation", "Immunization"]),
    },
    identity: ["token_patient", "id_token_fhir_user"],
    refreshTokens: true,
    queryPlan: [...CARIN_BB_PLAN("patient"), ...byPatient(["Condition", "Encounter", "Procedure", "MedicationRequest", "MedicationDispense", "Observation", "Immunization"])],
    followReferences: DEFAULT_FOLLOW,
    requestsPerMinute: 60,
  },
  cms_bluebutton: {
    vendor: "cms_bluebutton",
    displayName: "Medicare (CMS Blue Button 2.0)",
    category: "payer",
    defaultTokenAuthMethod: "client_secret_basic",
    pkce: true,
    scopes: {
      patient_access: ["openid", "profile", "launch/patient", "patient/Patient.read", "patient/Coverage.read", "patient/ExplanationOfBenefit.read"],
    },
    identity: ["token_patient", "userinfo"],
    refreshTokens: true,
    queryPlan: CARIN_BB_PLAN("beneficiary"),
    followReferences: [],
    // Sandbox is ~10 requests/second per app; stay well under.
    requestsPerMinute: 300,
    notes: "Beneficiary consent lasts 13 months. No id_token is issued; identity comes from the token response or userinfo.",
  },
  smart_sandbox: {
    vendor: "smart_sandbox",
    displayName: "SMART Health IT Sandbox",
    category: "sandbox",
    defaultTokenAuthMethod: "none",
    pkce: true,
    scopes: {
      patient_access: ["launch/patient", "openid", "fhirUser", "offline_access", "patient/*.read"],
      clinical_workflow: ["launch", "openid", "fhirUser", "user/*.read"],
    },
    identity: ["token_patient", "id_token_fhir_user"],
    refreshTokens: true,
    queryPlan: GENERIC_PLAN,
    followReferences: DEFAULT_FOLLOW,
    requestsPerMinute: 600,
  },
  synthetic: {
    vendor: "synthetic",
    displayName: "InfiniMed Synthetic Hospital",
    category: "sandbox",
    defaultTokenAuthMethod: "private_key_jwt",
    pkce: true,
    scopes: {
      patient_access: ["launch/patient", "openid", "fhirUser", "offline_access", "patient/*.read"],
      clinical_workflow: ["launch", "openid", "fhirUser", "user/*.read"],
      backend: ["system/*.read"],
    },
    identity: ["token_patient", "id_token_fhir_user"],
    refreshTokens: true,
    queryPlan: GENERIC_PLAN,
    followReferences: DEFAULT_FOLLOW,
    requestsPerMinute: 6000,
    bulkTypes: ["Patient", "AllergyIntolerance", "Condition", "Observation", "MedicationRequest", "Immunization", "Procedure", "Encounter", "Practitioner", "Organization"],
  },
  generic: {
    vendor: "generic",
    displayName: "FHIR R4 (SMART)",
    category: "ehr",
    defaultTokenAuthMethod: "private_key_jwt",
    pkce: true,
    scopes: {
      patient_access: ["launch/patient", "openid", "fhirUser", "offline_access", "patient/*.read"],
      clinical_workflow: ["launch", "openid", "fhirUser", "user/*.read"],
      backend: ["system/*.read"],
    },
    identity: ["token_patient", "id_token_fhir_user", "userinfo"],
    refreshTokens: true,
    queryPlan: GENERIC_PLAN,
    followReferences: DEFAULT_FOLLOW,
    requestsPerMinute: 120,
  },
};

export function profileFor(vendor: string): VendorProfile {
  return PROFILES[vendor] ?? PROFILES.generic!;
}

/** Vendors that sources can reference but that ingest data rather than authorize (feeds). */
export const FEED_VENDORS = new Set(["hl7v2", "external"]);
