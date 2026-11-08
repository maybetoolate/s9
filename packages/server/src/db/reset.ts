import { getPool } from './pool.js';

/**
 * Drops and recreates the application schema.
 *
 * Both `public` and the `drizzle` schema are removed: the latter stores the
 * migration history, so leaving it behind would make the migrator believe the
 * baseline was already applied to an empty database.
 *
 * Used by `pnpm db:reset` and by the integration test setup.
 */
export async function resetDatabase(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    client.release();
  }
}
