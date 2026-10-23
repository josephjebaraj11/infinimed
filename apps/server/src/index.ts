import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { bootstrap } from "./bootstrap.js";
import { closeDb } from "./db/client.js";
import { startWorker } from "./jobs/worker.js";
import { log } from "./lib/logger.js";

const cfg = config();
const db = await bootstrap();
const app = createApp();
const server = serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) => {
  log.info("InfiniMed API listening", { port: info.port, public_url: cfg.publicUrl, database: db.kind, worker_inline: cfg.workerInline });
});
const worker = cfg.workerInline ? startWorker({ concurrency: cfg.workerConcurrency }) : null;

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  server.close();
  await worker?.stop();
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
