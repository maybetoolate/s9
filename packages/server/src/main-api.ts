import { logger } from './lib/logger.js';
import { runMigrations } from './db/migrate.js';

/**
 * The API process.
 *
 * Migrations are applied on start so a developer only has to run one
 * command. A deployment that manages migrations separately can set
 * `SKIP_MIGRATIONS=true`.
 *
 * The API server is imported only after migrations: it imports the auth
 * module, and Better-Auth validates its schema when the instance is created.
 */

async function main(): Promise<void> {
  if (process.env.SKIP_MIGRATIONS !== 'true') {
    await runMigrations();
  }
  const { startApi } = await import('./api/server.js');
  await startApi();
}

main().catch((error) => {
  logger.error({ err: error }, 'the api failed to start');
  process.exit(1);
});
