import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll } from 'bun:test';

/**
 * Test environment.
 *
 * The integration tests run against a dedicated database so they never touch
 * the development data. Authentication is embedded in the API, so there is no
 * separate auth server to start: the tests drive the real module.
 *
 * The database is migrated at the top level, before any test module is
 * imported. Test helpers import the auth module statically, and Better-Auth
 * validates its schema when the instance is created, so the auth tables must
 * exist by then.
 */

const rootEnvFile = resolve(process.cwd(), '../../.env');

if (existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

const adminUrl = process.env.DATABASE_ADMIN_URL ?? 'postgres://s9:s9@localhost:55432/postgres';
const testUrl = process.env.DATABASE_URL_TEST ?? 'postgres://s9:s9@localhost:55432/s9_test';

process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.WEB_PUBLIC_URL = process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000';

// Create the test database when it does not exist yet.
{
  const { Client } = await import('pg');
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', ['s9_test']);
    if (existing.rowCount === 0) {
      await client.query('CREATE DATABASE s9_test');
    }
  } finally {
    await client.end();
  }
}

// Recreate the schemas so the run starts from the Drizzle baseline instead of
// a database left behind by an earlier revision of the schema.
const { resetDatabase } = await import('../../src/db/reset.js');
await resetDatabase();

const { runMigrations } = await import('../../src/db/migrate.js');
await runMigrations({ log: false });

// The pool is shared by every test file in the run, so it is closed once here
// rather than in an individual file's afterAll.
afterAll(async () => {
  const { closePool } = await import('../../src/db/pool.js');
  await closePool();
});
