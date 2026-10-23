import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { patients, workspaces, type Plan } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";

/**
 * Plans and entitlements. Free: patient access, sandboxes, the full API, exports, webhooks, custom
 * client IDs and the MCP server, up to 1,000 active patients. Enterprise adds backend services,
 * clinician workflow, network exchange and document structuring, with no patient cap.
 * A patient becomes "active" the first time a pull lands records for them.
 */

export type Feature =
  | "patient_access"
  | "exports"
  | "webhooks"
  | "custom_credentials"
  | "mcp"
  | "clinical_models"
  | "hl7v2_ingest"
  | "backend"
  | "clinical_workflow"
  | "network"
  | "document_structuring";

export const PLANS: Record<Plan, { activePatientQuota: number | null; features: Feature[] }> = {
  free: {
    activePatientQuota: 1000,
    features: ["patient_access", "exports", "webhooks", "custom_credentials", "mcp", "clinical_models", "hl7v2_ingest"],
  },
  enterprise: {
    activePatientQuota: null,
    features: [
      "patient_access",
      "exports",
      "webhooks",
      "custom_credentials",
      "mcp",
      "clinical_models",
      "hl7v2_ingest",
      "backend",
      "clinical_workflow",
      "network",
      "document_structuring",
    ],
  },
};

type WorkspaceRow = typeof workspaces.$inferSelect;

export function featureEnabled(ws: Pick<WorkspaceRow, "plan" | "featureOverrides" | "environment">, feature: Feature): boolean {
  const override = ws.featureOverrides?.[feature];
  if (override !== undefined) return override;
  // Sandbox workspaces can explore every surface against sandbox sources.
  if (ws.environment === "sandbox") return true;
  return PLANS[ws.plan].features.includes(feature);
}

export function requireFeature(ws: Pick<WorkspaceRow, "plan" | "featureOverrides" | "environment">, feature: Feature) {
  if (!featureEnabled(ws, feature)) {
    throw new ApiError("feature_not_enabled", "This feature isn't part of your plan. Contact support to enable it.", {
      details: { feature },
    });
  }
}

export function patientQuota(ws: Pick<WorkspaceRow, "plan" | "patientQuotaOverride">): number | null {
  return ws.patientQuotaOverride ?? PLANS[ws.plan].activePatientQuota;
}

export async function activePatientCount(workspaceId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(patients)
    .where(and(eq(patients.workspaceId, workspaceId), isNotNull(patients.activatedAt)));
  return Number(row?.n ?? 0);
}

/** Throws quota_exceeded when a not-yet-active patient would push the workspace past its cap. */
export async function assertCanActivate(ws: WorkspaceRow, patient: { activatedAt: Date | null }) {
  if (patient.activatedAt) return;
  const quota = patientQuota(ws);
  if (quota === null) return;
  if ((await activePatientCount(ws.id)) >= quota) {
    throw new ApiError("quota_exceeded", "You've hit your patient limit. Contact support to increase it.", { details: { quota } });
  }
}
