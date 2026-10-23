import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import * as schema from "./schema.js";
import { config } from "../config.js";

/**
 * Database handle. Production uses PostgreSQL through node-postgres (DATABASE_URL). Development and
 * tests fall back to PGlite, an in-process build of Postgres, so the full system runs without any
 * external service. Both expose the same Drizzle API and run the same SQL migrations.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

export type DbHandle = {
  db: Db;
  kind: "postgres" | "pglite";
  close: () => Promise<void>;
};

let handle: DbHandle | undefined;

export const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function openDatabase(opts: { url?: string; pgliteDir?: string } = {}): Promise<DbHandle> {
  const url = opts.url ?? config().databaseUrl;
  if (url) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const pool = new Pool({ connectionString: url, max: 20 });
    const db = drizzle(pool, { schema }) as unknown as Db;
    await migrate(drizzle(pool, { schema }), { migrationsFolder });
    return { db, kind: "postgres", close: () => pool.end() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = opts.pgliteDir ?? config().pgliteDir;
  let client: InstanceType<typeof PGlite>;
  if (dir === "memory://") {
    client = new PGlite();
  } else {
    mkdirSync(dir, { recursive: true });
    client = new PGlite(dir);
  }
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db: db as unknown as Db, kind: "pglite", close: () => client.close() };
}

export async function initDb(opts?: { url?: string; pgliteDir?: string }): Promise<DbHandle> {
  if (handle) return handle;
  handle = await openDatabase(opts);
  return handle;
}

export function db(): Db {
  if (!handle) throw new Error("Database not initialised; call initDb() first");
  return handle.db;
}

export function dbKind() {
  return handle?.kind ?? "pglite";
}

export async function closeDb() {
  if (handle) {
    const h = handle;
    handle = undefined;
    await h.close();
  }
}

/** Runs a raw SQL statement and returns its rows regardless of driver. */
export async function rawRows<T = Record<string, unknown>>(query: SQL): Promise<T[]> {
  const result = (await db().execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

export { sql };
