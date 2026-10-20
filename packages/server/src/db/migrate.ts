import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, getPool } from './pool.js';
import { logger } from '../lib/logger.js';

/**
 * Migration runner.
 *
 * Migrations are plain SQL files applied in lexical order and recorded in
 * `schema_migrations`. Applying them to an empty database is part of the
 * CI contract, so the runner must be idempotent and safe to re-run.
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
  applied: string[];
  skipped: string[];
}

export async function runMigrations(options: { log?: boolean } = {}): Promise<MigrationResult> {
  const pool = getPool();
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();

    for (const file of files) {
      const already = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (already.rowCount && already.rowCount > 0) {
        skipped.push(file);
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      // Each migration runs in its own transaction so a failure does not leave
      // a half applied schema behind.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        options.log !== false && logger.info({ migration: file }, 'migration applied');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
    }
  } finally {
    client.release();
  }

  return { applied, skipped };
}
