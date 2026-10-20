import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll } from 'vitest';

/**
 * Test environment.
 *
 * The integration tests run against a dedicated database so they never touch
 * the development data.
 */

const rootEnvFile = resolve(process.cwd(), '../../.env');

if (existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

const adminUrl = process.env.DATABASE_ADMIN_URL ?? 'postgres://flowforge:flowforge@localhost:55432/postgres';
const testUrl = process.env.DATABASE_URL_TEST ?? 'postgres://flowforge:flowforge@localhost:55432/flowforge_test';

process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';

beforeAll(async () => {
  // Create the test database when it does not exist yet.
  const { Client } = await import('pg');
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', ['flowforge_test']);
    if (existing.rowCount === 0) {
      await client.query('CREATE DATABASE flowforge_test');
    }
  } finally {
    await client.end();
  }

  const { runMigrations } = await import('../../src/db/migrate.js');
  await runMigrations({ log: false });
});
