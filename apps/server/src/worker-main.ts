import { config } from "./config.js";
import { bootstrap } from "./bootstrap.js";
import { closeDb } from "./db/client.js";
import { startWorker } from "./jobs/worker.js";
import { log } from "./lib/logger.js";

// Dedicated worker process (set WORKER_INLINE=false on API processes when running these separately).
await bootstrap();
const worker = startWorker({ concurrency: config().workerConcurrency });
log.info("InfiniMed worker started", { concurrency: config().workerConcurrency });

async function shutdown() {
  await worker.stop();
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
