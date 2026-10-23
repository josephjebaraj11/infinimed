import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { bootstrap } from "../bootstrap.js";
import { closeDb, db } from "../db/client.js";
import { users } from "../db/schema.js";
import { createApiKey, createUser, createWorkspace } from "../services/accounts.js";
import { loadSamplePatients } from "../services/samples.js";

/**
 * Development seed: a demo account with a sandbox workspace, the ten sample patients and an API
 * key. Refuses to run in production.
 *
 *   pnpm --filter @infinimed/server seed
 */
if (config().isProduction) {
  console.error("seed is for development only");
  process.exit(1);
}
await bootstrap();
const email = process.env.SEED_EMAIL ?? "demo@infinimed.dev";
const password = process.env.SEED_PASSWORD ?? "demo-password-123";
const [existing] = await db().select().from(users).where(eq(users.email, email)).limit(1);
if (existing) {
  console.log(`${email} already exists; sign in at ${config().publicUrl}/app/`);
} else {
  const user = await createUser({ email, password, name: "Demo Developer" });
  const ws = await createWorkspace(user.id, { name: "Demo Sandbox", environment: "sandbox" });
  const loaded = await loadSamplePatients(ws);
  const { secret } = await createApiKey(ws, { name: "Seed key" }, user.id);
  console.log(`Sign in at ${config().publicUrl}/app/ as ${email} / ${password}`);
  console.log(`Loaded ${loaded.length} sample patients into workspace ${ws.id}`);
  console.log(`INFINIMED_API_KEY=${secret}`);
}
await closeDb();
