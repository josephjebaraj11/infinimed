import { EventEmitter } from "node:events";
import { sql } from "drizzle-orm";
import { rawRows } from "../db/client.js";

/**
 * Durable job queue on Postgres. Jobs are claimed with `FOR UPDATE SKIP LOCKED` so any number of
 * worker processes can run concurrently without double-processing. A `dedupe_key` collapses
 * duplicate pending work (e.g. one export run per destination at a time).
 */

export type JobRow = {
  id: number;
  queue: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  dedupe_key: string | null;
};

export const queueEvents = new EventEmitter();
queueEvents.setMaxListeners(50);

export type EnqueueOptions = {
  runAt?: Date;
  delaySeconds?: number;
  priority?: number;
  maxAttempts?: number;
  dedupeKey?: string;
};

export async function enqueue(queue: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<number | null> {
  const runAt = opts.runAt ?? new Date(Date.now() + (opts.delaySeconds ?? 0) * 1000);
  const rows = await rawRows<{ id: number }>(sql`
    insert into jobs (queue, payload, run_at, priority, max_attempts, dedupe_key)
    values (${queue}, ${JSON.stringify(payload)}::jsonb, ${runAt.toISOString()}::timestamptz, ${opts.priority ?? 100}, ${opts.maxAttempts ?? 5}, ${opts.dedupeKey ?? null})
    on conflict (dedupe_key) where status in ('queued','running') and dedupe_key is not null do nothing
    returning id`);
  const id = rows[0]?.id ?? null;
  if (id !== null && runAt.getTime() <= Date.now() + 50) queueEvents.emit("enqueued", queue);
  return id === null ? null : Number(id);
}

export async function claimJobs(workerId: string, queues: string[], limit: number, lockSeconds = 300): Promise<JobRow[]> {
  if (queues.length === 0 || limit <= 0) return [];
  const queueList = sql.join(
    queues.map((q) => sql`${q}`),
    sql`, `,
  );
  const rows = await rawRows<JobRow>(sql`
    update jobs set status = 'running', locked_by = ${workerId},
      locked_until = now() + make_interval(secs => ${lockSeconds}), attempts = attempts + 1
    where id in (
      select id from jobs
      where status = 'queued' and run_at <= now() and queue in (${queueList})
      order by priority asc, run_at asc
      for update skip locked
      limit ${limit}
    )
    returning id, queue, payload, attempts, max_attempts, dedupe_key`);
  return rows.map((r) => ({ ...r, id: Number(r.id) }));
}

export async function completeJob(id: number) {
  await rawRows(sql`update jobs set status = 'done', finished_at = now(), locked_by = null, locked_until = null where id = ${id}`);
}

/** Failure: retry with exponential backoff until max_attempts, then mark failed. */
export async function failJob(job: JobRow, error: string) {
  if (job.attempts >= job.max_attempts) {
    await rawRows(sql`update jobs set status = 'failed', last_error = ${error.slice(0, 2000)}, finished_at = now(), locked_by = null, locked_until = null where id = ${job.id}`);
    return "failed" as const;
  }
  const backoffSeconds = Math.min(3600, 15 * 2 ** (job.attempts - 1)) + Math.floor(Math.random() * 10);
  await rawRows(sql`
    update jobs set status = 'queued', last_error = ${error.slice(0, 2000)},
      run_at = now() + make_interval(secs => ${backoffSeconds}), locked_by = null, locked_until = null
    where id = ${job.id}`);
  return "retrying" as const;
}

/** Reschedule without consuming an attempt (rate limited upstream, bulk export still running). */
export async function rescheduleJob(job: JobRow, delaySeconds: number, payloadPatch?: Record<string, unknown>) {
  const payload = payloadPatch ? JSON.stringify({ ...job.payload, ...payloadPatch }) : JSON.stringify(job.payload);
  await rawRows(sql`
    update jobs set status = 'queued', attempts = greatest(attempts - 1, 0), payload = ${payload}::jsonb,
      run_at = now() + make_interval(secs => ${Math.max(1, Math.ceil(delaySeconds))}), locked_by = null, locked_until = null
    where id = ${job.id}`);
}

/** Merges fields into a job's payload (e.g. to resume the same pull row on the next attempt). */
export async function patchJobPayload(jobId: number, patch: Record<string, unknown>) {
  await rawRows(sql`update jobs set payload = payload || ${JSON.stringify(patch)}::jsonb where id = ${jobId}`);
}

/** Jobs whose worker died keep their lock until it expires; then they are made claimable again. */
export async function reclaimExpiredLocks() {
  await rawRows(sql`update jobs set status = 'queued', locked_by = null, locked_until = null where status = 'running' and locked_until < now()`);
}

export async function purgeFinishedJobs(olderThanDays = 7) {
  await rawRows(sql`delete from jobs where status in ('done') and finished_at < now() - make_interval(days => ${olderThanDays})`);
}

/** Thrown by handlers to defer a job without counting a failed attempt. */
export class RetryLater extends Error {
  constructor(
    readonly delaySeconds: number,
    readonly reason: string,
    readonly payloadPatch?: Record<string, unknown>,
  ) {
    super(reason);
    this.name = "RetryLater";
  }
}
