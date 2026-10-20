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

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  resetDatabase()
    .then(async () => {
      logger.info('database reset');
      await closePool();
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error({ err: error }, 'database reset failed');
      await closePool();
      process.exit(1);
    });
}
