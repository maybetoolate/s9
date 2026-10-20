import { closePool, getPool } from './pool.js';
import { logger } from '../lib/logger.js';

/**
 * Drops and recreates the public schema. Used by `pnpm db:reset` and by the
 * integration test setup.
 */
export async function resetDatabase(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    client.release();
  }
}
