import { closePool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { logger } from '../lib/logger.js';

/**
 * The migration CLI.
 *
 * It lives in its own entry point so that the migration runner can be
 * imported by the API without its command line behaviour travelling with it.
 */
runMigrations()
  .then(async () => {
    logger.info('migrations complete');
    await closePool();
    process.exit(0);
  })
  .catch(async (error) => {
    logger.error({ err: error }, 'migrations failed');
    await closePool();
    process.exit(1);
  });
