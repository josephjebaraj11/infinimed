import { and, asc, eq, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { mpiIdentities, patients } from "../db/schema.js";
import { newId } from "../lib/ids.js";
import { compareDemographics, demographicsFromApp, demographicsFromPatient, type Demographics } from "../mpi/match.js";

/**
 * Master patient index integration.
 *
 * Patient access: the customer already knows who the patient is, so every source Patient resource
 * pulled for that patient is compared against the patient's anchor identity (the first one linked).
 * A low score means the person who signed in to a portal shared someone else's records (a proxy or
 * family account) or the wrong account; such identities are flagged `review`/`mismatch` so the
 * customer can confirm before treating the records as one person.
 *
 * Backend and feed ingestion: incoming patients are matched against every identity in the workspace
 * (blocked by birth date or family-name Soundex) to find the existing patient or create a new one.
 */

type Identity = typeof mpiIdentities.$inferSelect;

export async function registerIdentity(args: {
  workspaceId: string;
  patientId: string;
  connectionId: string;
  sourceId: string;
  fhirPatient: Record<string, unknown>;
}): Promise<Identity> {
  const demographics = demographicsFromPatient(args.fhirPatient);
  const fhirPatientId = String(args.fhirPatient.id);
  const existing = await db()
    .select()
    .from(mpiIdentities)
    .where(eq(mpiIdentities.patientId, args.patientId))
    .orderBy(asc(mpiIdentities.createdAt));
  const self = existing.find((i) => i.connectionId === args.connectionId && i.fhirPatientId === fhirPatientId);
  const anchor = existing.find((i) => i.matchStatus === "anchor" && i.id !== self?.id);

  let matchStatus: Identity["matchStatus"] = "anchor";
  let matchScore: number | null = null;
  let matchDetails: Record<string, unknown> = {};
  if (anchor) {
    const result = compareDemographics(anchor.demographics as unknown as Demographics, demographics);
    matchStatus = result.status;
    matchScore = Math.round(result.probability * 100);
    matchDetails = { against: anchor.id, score: result.score, fields: result.fields };
  } else {
    // No anchor yet: sanity-check against what the customer told us (name/email), when given.
    const [p] = await db().select().from(patients).where(eq(patients.id, args.patientId)).limit(1);
    if (p?.name) {
      const result = compareDemographics(demographicsFromApp({ name: p.name, email: p.email }), demographics);
      matchDetails = { against: "customer_profile", score: result.score, fields: result.fields };
      if (result.fields.family?.outcome === "disagree" && result.fields.given?.outcome === "disagree") {
        matchDetails.warning = "Source demographics do not match the name on the customer profile";
      }
    }
  }
  // Manual decisions stick across re-pulls.
  if (self && (self.matchStatus === "confirmed" || self.matchStatus === "rejected")) matchStatus = self.matchStatus;

  if (self) {
    const [row] = await db()
      .update(mpiIdentities)
      .set({ demographics: demographics as unknown as Record<string, unknown>, matchStatus, matchScore, matchDetails, updatedAt: new Date() })
      .where(eq(mpiIdentities.id, self.id))
      .returning();
    return row!;
  }
  const [row] = await db()
    .insert(mpiIdentities)
    .values({
      id: newId("identity"),
      workspaceId: args.workspaceId,
      patientId: args.patientId,
      connectionId: args.connectionId,
      sourceId: args.sourceId,
      fhirPatientId,
      demographics: demographics as unknown as Record<string, unknown>,
      matchStatus,
      matchScore,
      matchDetails,
    })
    .returning();
  return row!;
}

export async function identitiesForPatient(patientId: string) {
  return db().select().from(mpiIdentities).where(eq(mpiIdentities.patientId, patientId)).orderBy(asc(mpiIdentities.createdAt));
}

export async function setIdentityDecision(workspaceId: string, identityId: string, decision: "confirmed" | "rejected") {
  const [row] = await db()
    .update(mpiIdentities)
    .set({ matchStatus: decision, updatedAt: new Date() })
    .where(and(eq(mpiIdentities.id, identityId), eq(mpiIdentities.workspaceId, workspaceId)))
    .returning();
  return row ?? null;
}

/** Finds the workspace patient most likely to be this person (for backend cohorts and feeds). */
export async function findMatchingPatient(workspaceId: string, fhirPatient: Record<string, unknown>) {
  const d = demographicsFromPatient(fhirPatient);
  const blocks = [];
  if (d.birthDate) blocks.push(sql`${mpiIdentities.demographics}->>'birthDate' = ${d.birthDate}`);
  for (const s of d.soundexFamily) blocks.push(sql`${mpiIdentities.demographics}->'soundexFamily' ? ${s}`);
  if (blocks.length === 0) return null;
  const candidates = await db()
    .select()
    .from(mpiIdentities)
    .where(and(eq(mpiIdentities.workspaceId, workspaceId), or(...blocks)))
    .limit(500);
  let best: { patientId: string; score: number; status: string } | null = null;
  for (const c of candidates) {
    if (c.matchStatus === "rejected") continue;
    const r = compareDemographics(c.demographics as unknown as Demographics, d);
    if (!best || r.score > best.score) best = { patientId: c.patientId, score: r.score, status: r.status };
  }
  return best && best.status === "match" ? best : null;
}

/** Summary used on the patient object: does anyone need to look at an identity? */
export async function identityReviewState(patientId: string): Promise<"ok" | "review_required"> {
  const rows = await db()
    .select({ s: mpiIdentities.matchStatus })
    .from(mpiIdentities)
    .where(eq(mpiIdentities.patientId, patientId));
  return rows.some((r) => r.s === "review" || r.s === "mismatch") ? "review_required" : "ok";
}
