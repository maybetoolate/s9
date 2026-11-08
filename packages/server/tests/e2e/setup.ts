import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { Client } from 'pg';

/**
 * End-to-end test setup.
 *
 * Recreates the dedicated E2E database from the Drizzle baseline, seeds the
 * demo workspace, and clears the isolated Redis database before Playwright
 * starts the API, the worker and the web app.
 *
 * This runs as its own process (`pnpm test:e2e` invokes it before Playwright),
 * so the servers never observe a database that is being rebuilt underneath
 * them.
 */

const envFile = resolve(process.cwd(), '../../.env.e2e');
if (!existsSync(envFile)) {
  throw new Error(`the E2E environment file is missing: ${envFile}`);
}

for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
  if (process.env[key] === undefined) process.env[key] = value;
}

process.env.NODE_ENV = 'test';

const databaseUrl = process.env.DATABASE_URL;
const adminUrl = process.env.DATABASE_ADMIN_URL;
const redisUrl = process.env.REDIS_URL;

if (!databaseUrl || !adminUrl || !redisUrl) {
  throw new Error('DATABASE_URL, DATABASE_ADMIN_URL and REDIS_URL must be configured for E2E tests');
}

const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
const redisDatabase = new URL(redisUrl).pathname.replace(/^\//, '');

// Guard rails: the setup drops schemas and flushes Redis. Refuse to touch a
// database that does not look disposable, or the default Redis database that
// the development stack uses.
if (!/e2e|test/i.test(databaseName)) {
  throw new Error(`refusing to prepare "${databaseName}": the E2E database name must contain "e2e" or "test"`);
}
if (redisDatabase === '' || redisDatabase === '0') {
  throw new Error(`refusing to flush Redis database "${redisDatabase || '0'}": set REDIS_URL to an isolated database (e.g. /1)`);
}

/** Quotes an identifier for a `CREATE DATABASE` statement. */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

// The E2E database is created on first use. PostgreSQL cannot create a
// database inside a transaction, so this uses a short-lived admin connection.
const admin = new Client({ connectionString: adminUrl });
await admin.connect();
try {
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
  if (existing.rowCount === 0) {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  }
} finally {
  await admin.end();
}

const { resetDatabase } = await import('../../src/db/reset.js');
await resetDatabase();

// `seed()` migrates first and only then imports the auth module, because
// Better-Auth validates its schema when the instance is created.
const { seed } = await import('../../src/db/seed.js');
await seed();

// The queue is part of the test fixture: remove anything a previous run left
// behind so stale jobs cannot be claimed by the E2E worker.
const { getRedis, closeRedis } = await import('../../src/queue/connection.js');
const redis = getRedis();
await redis.flushdb();
await closeRedis();

const { closePool } = await import('../../src/db/pool.js');
await closePool();

process.stdout.write(`the E2E database "${databaseName}" is ready\n`);
