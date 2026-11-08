import { createLogger } from './lib/logger.js';
import { runMigrations } from './db/migrate.js';

/**
 * The auth service process.
 *
 * It owns the Better-Auth tables and exposes the public auth endpoints plus
 * the internal endpoints the API uses. Migrations are applied on start under
 * an advisory lock, so the API and the auth service can start in any order.
 *
 * The auth server is imported only after migrations: Better-Auth validates its
 * schema when the instance is created, so the OAuth tables must already exist.
 */

const logger = createLogger({ service: 's9-auth' });

async function main(): Promise<void> {
  if (process.env.SKIP_MIGRATIONS !== 'true') {
    await runMigrations();
  }
  const { startAuth } = await import('./auth/server.js');
  await startAuth();
}

main().catch((error) => {
  logger.error({ err: error }, 'the auth service failed to start');
  process.exit(1);
});
