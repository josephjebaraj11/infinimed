import { createHash } from "node:crypto";
import { withPatientIdentifier } from "../services/records.js";

/**
 * Export-time transformation of stored resources.
 *
 * FHIR ids may only contain letters, digits, '-' and '.', 1 to 64 characters. Some EHRs emit ids
 * outside that grammar; a destination server would reject them. Non-conformant ids are replaced by
 * a stable hash and every reference to them is rewritten to match, so the graph stays intact.
 *
 * With `idStrategy: "namespaced"`, every id is additionally prefixed per source so resources from
 * different EHRs can never collide on one destination server.
 */

export const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;

export type IdStrategy = "source" | "namespaced";

export function stableId(resourceType: string, id: string, namespace?: string): string {
  if (!namespace && FHIR_ID.test(id)) return id;
  const candidate = namespace ? `${namespace}-${id}` : id;
  if (FHIR_ID.test(candidate)) return candidate;
  return `x-${createHash("sha256").update(`${namespace ?? ""}|${resourceType}/${id}`).digest("hex").slice(0, 40)}`;
}

export function sourceNamespace(sourceId: string): string {
  return createHash("sha256").update(sourceId).digest("hex").slice(0, 8);
}

const REFERENCE = /^([A-Z][A-Za-z]+)\/([^/]+)(\/_history\/[^/]+)?$/;

function rewriteReferences(value: unknown, namespace: string | undefined): unknown {
  if (Array.isArray(value)) return value.map((v) => rewriteReferences(v, namespace));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "reference" && typeof v === "string") {
        const m = REFERENCE.exec(v);
        out[k] = m ? `${m[1]}/${stableId(m[1]!, m[2]!, namespace)}` : v;
      } else {
        out[k] = rewriteReferences(v, namespace);
      }
    }
    return out;
  }
  return value;
}

export function transformForExport(
  resource: Record<string, unknown>,
  opts: { externalPatientId: string; sourceId: string; idStrategy: IdStrategy },
): Record<string, unknown> {
  const namespace = opts.idStrategy === "namespaced" ? sourceNamespace(opts.sourceId) : undefined;
  const type = String(resource.resourceType);
  const rewritten = rewriteReferences(resource, namespace) as Record<string, unknown>;
  rewritten.id = stableId(type, String(resource.id), namespace);
  // Contained resources keep local ids (#ref), and meta.versionId belongs to the destination.
  if (rewritten.meta && typeof rewritten.meta === "object") {
    const { versionId, lastUpdated, ...meta } = rewritten.meta as Record<string, unknown>;
    void versionId, lastUpdated;
    rewritten.meta = { ...meta, source: (meta.source as string | undefined) ?? `urn:infinimed:source:${opts.sourceId}` };
  } else {
    rewritten.meta = { source: `urn:infinimed:source:${opts.sourceId}` };
  }
  return withPatientIdentifier(rewritten, opts.externalPatientId);
}
