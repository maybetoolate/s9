import { closePool } from '../db/pool.js';
import { resetDatabase } from '../db/reset.js';
import { logger } from '../lib/logger.js';

/** The database reset CLI. */
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
