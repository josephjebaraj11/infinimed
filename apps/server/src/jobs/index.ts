import { lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { idempotencyKeys, oauthStates, syntheticTokens, userSessions } from "../db/schema.js";
import { handleExportJob } from "../exports/run.js";
import { expireStaleSessions } from "../services/sessions.js";
import { handleDeliveryJob } from "../webhooks/delivery.js";
import { handleDownload, handleKickoff, handlePoll, scheduleBackendSyncs } from "./backend.js";
import { handlePullJob, scheduleDuePulls } from "./pull.js";
import { purgeFinishedJobs } from "./queue.js";
import { purgeSyntheticUploads } from "../synthetic/routes.js";
import { registerHandler, registerPeriodic } from "./worker.js";

let registered = false;

/** Registers every queue handler and periodic task. Idempotent. */
export function registerJobs() {
  if (registered) return;
  registered = true;
  registerHandler("records.pull", handlePullJob);
  registerHandler("webhook.deliver", handleDeliveryJob);
  registerHandler("export.run", handleExportJob);
  registerHandler("backend.kickoff", handleKickoff);
  registerHandler("backend.poll", handlePoll);
  registerHandler("backend.download", handleDownload);

  registerPeriodic("scheduled-pulls", 60_000, async () => void (await scheduleDuePulls()));
  registerPeriodic("expire-sessions", 60_000, expireStaleSessions);
  registerPeriodic("backend-schedule", 15 * 60_000, scheduleBackendSyncs);
  registerPeriodic("housekeeping", 3600_000, async () => {
    const now = new Date();
    await db().delete(oauthStates).where(lt(oauthStates.expiresAt, new Date(now.getTime() - 24 * 3600_000)));
    await db().delete(userSessions).where(lt(userSessions.expiresAt, now));
    await db().delete(syntheticTokens).where(lt(syntheticTokens.expiresAt, now));
    await db().delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(now.getTime() - 48 * 3600_000)));
    await purgeFinishedJobs(7);
    await purgeSyntheticUploads();
  });
}
