import { config } from "./config.js";
import { initDb } from "./db/client.js";
import { seedCatalog } from "./catalog/seed.js";
import { seedSyntheticPatients } from "./synthetic/routes.js";
import { loadSigningKeys } from "./services/keys.js";
import { registerJobs } from "./jobs/index.js";

/** Shared startup for the API process, the worker process and tests. */
export async function bootstrap(opts: { pgliteDir?: string; databaseUrl?: string } = {}) {
  const handle = await initDb({ url: opts.databaseUrl, pgliteDir: opts.pgliteDir });
  await loadSigningKeys();
  if (config().seedCatalog) {
    await seedCatalog();
    await seedSyntheticPatients();
  }
  registerJobs();
  return handle;
}
