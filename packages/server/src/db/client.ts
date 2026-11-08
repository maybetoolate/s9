import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { logger } from '../lib/logger.js';
import { getPool } from './pool.js';
import { schema, type Schema } from './schema.js';

/**
 * The Drizzle client.
 *
 * PostgreSQL is the durable system of record (blueprint section 8). Drizzle
 * owns the query surface and the migrations; the underlying `pg` pool is
 * shared with Better-Auth so the process never opens a second pool.
 *
 * Every function that participates in a multi-statement invariant accepts a
 * `Db` (database or transaction) so the caller controls the transaction
 * boundary.
 */

export type Database = NodePgDatabase<Schema>;

export type Transaction = PgTransaction<
  NodePgQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;

export type Db = Database | Transaction;

let db: Database | undefined;

export function getDb(): Database {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}

/** Runs a function inside a transaction. */
export async function withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return getDb().transaction(fn);
}

/**
 * Runs a function inside a transaction that takes an advisory lock.
 *
 * Used by the scheduler so that several pollers cannot create the same
 * occurrence, and by the recovery operations so that two simultaneous retry
 * requests create one recovery.
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withTransaction(async (tx) => {
    // Hash the key into the advisory lock id space and hold it for the
    // duration of the transaction.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    return fn(tx);
  });
}

/** Database time. Leases, schedules and deadlines use database time, not worker clocks. */
export async function databaseNow(): Promise<Date> {
  // Raw `execute` results bypass Drizzle's column encoders: a timestamp comes
  // back as a string, not a `Date`. Reading epoch milliseconds keeps the value
  // unambiguous and lets this function return a real `Date`, which every
  // timestamp-bound query below relies on.
  const result = await getDb().execute<{ now_ms: string }>(
    sql`SELECT (extract(epoch from now()) * 1000)::bigint::text AS now_ms`,
  );
  const value = result.rows[0]?.now_ms;
  const milliseconds = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : new Date();
}

/** Logs a failed rollback without masking the original error. */
export function logRollbackFailure(error: unknown): void {
  logger.error({ err: error }, 'rollback failed');
}
