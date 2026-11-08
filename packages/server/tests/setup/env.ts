import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll } from 'bun:test';
import type { RunningServer } from '../../src/lib/serve.js';

/**
 * Test environment.
 *
 * The integration tests run against a dedicated database so they never touch
 * the development data. The auth service runs as a real HTTP server on an
 * ephemeral port, so the API exercises the same service boundary as
 * production.
 *
 * The database is migrated at the top level, before any test module is
 * imported. Test helpers import the Better-Auth instance statically, and
 * Better-Auth validates its schema when the instance is created, so the OAuth
 * tables must exist by then.
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

// Service-to-service credentials used by the API in the tests.
process.env.AUTH_CLIENT_ID = 's9-api';
process.env.AUTH_CLIENT_SECRET = 'integration-service-client-secret';
process.env.AUTH_CLIENT_SCOPES = 'users:read sessions:validate';
process.env.AUTH_SERVICE_TOKEN_TTL = '300';
process.env.AUTH_API_RESOURCE = 'urn:s9:api';
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

const { runMigrations } = await import('../../src/db/migrate.js');
await runMigrations({ log: false });

let authServer: RunningServer | undefined;
let authPool: Pool | undefined;

beforeAll(async () => {
  // Start the auth service on a random port and point the API at it.
  const { buildAuthServer } = await import('../../src/auth/server.js');
  const { serveHttp } = await import('../../src/lib/serve.js');
  const { authPool: pool } = await import('../../src/api/auth.js');
  const { resetEnvCache } = await import('../../src/config/env.js');
  const { resetAuthClientCache } = await import('../../src/auth/client.js');

  authPool = pool;
  const authApp = await buildAuthServer();
  authServer = await serveHttp({ fetch: authApp.fetch, port: 0, hostname: '127.0.0.1' });

  process.env.AUTH_INTERNAL_URL = `http://127.0.0.1:${authServer.port}`;
  resetEnvCache();
  resetAuthClientCache();
});

afterAll(async () => {
  await authServer?.stop().catch(() => undefined);
  await authPool?.end().catch(() => undefined);
});
