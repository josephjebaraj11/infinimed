import { hostname } from "node:os";
import { randomToken } from "../lib/ids.js";
import { errorFields, log } from "../lib/logger.js";
import { claimJobs, completeJob, failJob, queueEvents, reclaimExpiredLocks, rescheduleJob, RetryLater, type JobRow } from "./queue.js";

/**
 * Worker loop. Handlers are registered per queue; the loop claims jobs up to the concurrency
 * limit, runs them, and records the outcome. A periodic scheduler runs maintenance tasks.
 */

export type JobHandler = (payload: Record<string, unknown>, job: JobRow) => Promise<void>;

const handlers = new Map<string, JobHandler>();
const periodic: { name: string; everyMs: number; run: () => Promise<void>; last: number }[] = [];

export function registerHandler(queue: string, handler: JobHandler) {
  handlers.set(queue, handler);
}

export function registerPeriodic(name: string, everyMs: number, run: () => Promise<void>) {
  periodic.push({ name, everyMs, run, last: 0 });
}

export type WorkerHandle = { stop: () => Promise<void>; drain: (timeoutMs?: number) => Promise<void> };

export function startWorker(opts: { concurrency: number; pollMs?: number; runPeriodic?: boolean }): WorkerHandle {
  const workerId = `${hostname()}:${process.pid}:${randomToken(4)}`;
  const pollMs = opts.pollMs ?? 500;
  let running = true;
  let inFlight = 0;
  let wake: (() => void) | null = null;
  const idleWaiters: (() => void)[] = [];

  const onEnqueue = () => wake?.();
  queueEvents.on("enqueued", onEnqueue);

  async function runJob(job: JobRow) {
    const handler = handlers.get(job.queue);
    try {
      if (!handler) throw new Error(`no handler registered for queue ${job.queue}`);
      await handler(job.payload, job);
      await completeJob(job.id);
    } catch (err) {
      if (err instanceof RetryLater) {
        await rescheduleJob(job, err.delaySeconds, err.payloadPatch);
        log.debug("job deferred", { queue: job.queue, job_id: job.id, reason: err.reason, delay_s: err.delaySeconds });
      } else {
        const outcome = await failJob(job, (err as Error)?.message ?? String(err));
        log.warn("job failed", { queue: job.queue, job_id: job.id, attempts: job.attempts, outcome, ...errorFields(err) });
      }
    } finally {
      inFlight--;
      wake?.();
      if (inFlight === 0) idleWaiters.splice(0).forEach((r) => r());
    }
  }

  async function tickPeriodic() {
    const now = Date.now();
    for (const task of periodic) {
      if (now - task.last < task.everyMs) continue;
      task.last = now;
      try {
        await task.run();
      } catch (err) {
        log.warn("periodic task failed", { task: task.name, ...errorFields(err) });
      }
    }
  }

  const loop = (async () => {
    let lastReclaim = 0;
    while (running) {
      try {
        if (Date.now() - lastReclaim > 30_000) {
          lastReclaim = Date.now();
          await reclaimExpiredLocks();
        }
        if (opts.runPeriodic !== false) await tickPeriodic();
        const free = opts.concurrency - inFlight;
        if (free > 0) {
          const jobs = await claimJobs(workerId, [...handlers.keys()], free);
          for (const job of jobs) {
            inFlight++;
            void runJob(job);
          }
          if (jobs.length > 0) continue;
        }
      } catch (err) {
        log.error("worker loop error", errorFields(err));
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
      });
    }
  })();

  return {
    async stop() {
      running = false;
      wake?.();
      queueEvents.off("enqueued", onEnqueue);
      await loop;
      if (inFlight > 0) await new Promise<void>((r) => idleWaiters.push(r));
    },
    async drain(timeoutMs = 30_000) {
      // Test helper: wait until no job is runnable right now and nothing is in flight.
      const { rawRows, sql } = await import("../db/client.js");
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const [row] = await rawRows<{ n: number }>(
          sql`select count(*)::int as n from jobs where status = 'running' or (status = 'queued' and run_at <= now())`,
        );
        if (Number(row?.n ?? 0) === 0 && inFlight === 0) return;
        wake?.();
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("worker drain timed out");
    },
  };
}
