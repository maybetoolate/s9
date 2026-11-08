import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getPool } from './pool.js';
import { schema } from './schema.js';
import { logger } from '../lib/logger.js';

/**
 * Migration runner.
 *
 * Drizzle owns the migration history (`drizzle.__drizzle_migrations`). The
 * SQL files are generated from `src/db/schema.ts`; an empty database is
 * brought up to date by applying them in order.
 *
 * Concurrent starts (the API, the worker and the scheduler can all boot at
 * once) are serialised with a session-scoped advisory lock. The lock is
 * released when the connection closes, even if a process crashes.
 */

/**
 * Finds the migrations directory.
 *
 * The runner is executed from the source tree in development
 * (`src/db/migrate.ts`) and from the bundled output in a container
 * (`dist/main-api.js`), so the directory is located by walking up from the
 * module instead of by a fixed relative path.
 */
function resolveMigrationsDir(): string {
  const candidates: string[] = [];

  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(join(directory, 'migrations'));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  candidates.push(resolve(process.cwd(), 'migrations'));
  candidates.push(resolve(process.cwd(), 'packages/server/migrations'));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (readdirSync(candidate).some((file) => file.endsWith('.sql'))) return candidate;
  }

  throw new Error(
    `the migrations directory could not be found (looked in: ${candidates.join(', ')})`,
  );
}

const migrationsDir = resolveMigrationsDir();

export interface MigrationResult {
  applied: boolean;
}

export async function runMigrations(options: { log?: boolean } = {}): Promise<MigrationResult> {
  const client = await getPool().connect();

  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['s9:migrations']);

    // The Drizzle baseline is a full schema, not an incremental migration. A
    // database created by the previous runner cannot be adopted in place, so
    // fail with the one command that fixes it instead of a confusing
    // "relation already exists" error.
    const state = await client.query<{ drizzle: boolean; legacy: boolean }>(
      `SELECT
         to_regclass('public.__drizzle_migrations') IS NOT NULL
           OR to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS drizzle,
         to_regclass('public.schema_migrations') IS NOT NULL
           OR to_regclass('public.workspaces') IS NOT NULL AS legacy`,
    );
    const row = state.rows[0];
    if (row && !row.drizzle && row.legacy) {
      throw new Error(
        'this database was created before the Drizzle migration baseline; ' +
          'run `pnpm db:reset` once to recreate it, then start the API again',
      );
    }

    // The migrator runs on this exact connection so the advisory lock covers
    // every statement it executes.
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: migrationsDir });

    options.log !== false && logger.info({ migrationsDir }, 'migrations complete');
    return { applied: true };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['s9:migrations']);
    } catch {
      // The connection is already broken; the lock is released with it.
    }
    client.release();
  }
}
