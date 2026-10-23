import { closeDb, initDb } from "./client.js";

// Applies pending migrations against DATABASE_URL (or the embedded PGlite data dir) and exits.
const handle = await initDb();
console.log(`migrations applied (${handle.kind})`);
await closeDb();
