import { startApi } from './api/server.js';
import { logger } from './lib/logger.js';
import { runMigrations } from './db/migrate.js';

/**
 * The API process.
 *
 * Migrations are applied on start so a developer only has to run one
 * command. A deployment that manages migrations separately can set
 * `SKIP_MIGRATIONS=true`.
 */

async function main(): Promise<void> {
  if (process.env.SKIP_MIGRATIONS !== 'true') {
    await runMigrations();
  }
  await startApi();
}

main().catch((error) => {
  logger.error({ err: error }, 'the api failed to start');
  process.exit(1);
});
