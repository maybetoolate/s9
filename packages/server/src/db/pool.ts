import { Pool } from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * The PostgreSQL connection pool.
 *
 * PostgreSQL is the durable system of record. Queue state is never the only
 * record of anything (blueprint section 8).
 *
 * The pool is shared by the Drizzle client and the Better-Auth Drizzle
 * adapter, so the process owns exactly one set of connections.
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
