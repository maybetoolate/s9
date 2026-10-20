import { closePool } from '../db/pool.js';
import { seed } from '../db/seed.js';
import { logger } from '../lib/logger.js';

/** The seed CLI. */
seed()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error) => {
    logger.error({ err: error }, 'the seed failed');
    await closePool();
    process.exit(1);
  });
