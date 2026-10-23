import { parseArgs } from "node:util";
import { closeDb, initDb } from "../db/client.js";
import { importDirectory } from "../catalog/importer.js";
import type { Environment, Surface } from "../db/schema.js";

/**
 * Imports a published endpoint directory into the source catalog.
 *
 *   pnpm --filter @infinimed/server catalog:import --vendor epic --env production \
 *     --url https://open.epic.com/Endpoints/R4
 *
 * Accepts FHIR Endpoint bundles, SMART User-access Brands bundles, or a JSON array of
 * { name, fhir_base_url, logo_url?, portal_url?, city?, state? } (local file or URL).
 */
const { values } = parseArgs({
  options: {
    url: { type: "string" },
    file: { type: "string" },
    vendor: { type: "string" },
    env: { type: "string", default: "production" },
    category: { type: "string", default: "ehr" },
    surfaces: { type: "string", default: "patient_access" },
  },
});
const location = values.url ?? values.file;
if (!location || !values.vendor) {
  console.error("usage: catalog-import --vendor <epic|cerner|meditech|ecw|...> (--url <url> | --file <path>) [--env production|sandbox]");
  process.exit(2);
}
await initDb();
const result = await importDirectory(location, {
  vendor: values.vendor,
  environment: values.env as Environment,
  category: values.category as "ehr" | "payer",
  surfaces: values.surfaces!.split(",") as Surface[],
});
console.log(`imported ${result.imported} sources for ${values.vendor} (${values.env})`);
await closeDb();
