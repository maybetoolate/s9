import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * PostgreSQL access.
 *
 * PostgreSQL is the durable system of record. Queue state is never the only
 * record of anything (blueprint section 8).
 */

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env().DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (error) => {
      logger.error({ err: error }, 'postgres pool error');
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Runs a function inside a transaction.
 *
 * Every state change that must be atomic (execution creation plus its outbox
 * event, for example) goes through this helper.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, 'rollback failed');
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs a function inside a transaction that takes an advisory lock.
 *
 * Used by the scheduler so that several pollers cannot create the same
 * occurrence, and by the recovery operations so that two simultaneous retry
 * requests create one recovery.
 */
export async function withAdvisoryLock<T>(key: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Hash the key into the advisory lock id space and hold it for the
    // duration of the transaction.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, 'rollback failed');
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Database time. Leases, schedules and deadlines use database time, not worker clocks. */
export async function databaseNow(): Promise<Date> {
  const rows = await query<{ now: Date }>('SELECT now() AS now');
  return rows[0]?.now ?? new Date();
}
