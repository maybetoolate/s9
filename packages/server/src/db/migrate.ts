import { readdir, readFile } from 'node:fs/promises';
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

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

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

    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

    for (const file of files) {
      const already = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (already.rowCount && already.rowCount > 0) {
        skipped.push(file);
        continue;
      }

      const sql = await readFile(join(migrationsDir, file), 'utf8');
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

const isMain = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isMain) {
  runMigrations()
    .then(async (result) => {
      logger.info({ applied: result.applied, skipped: result.skipped.length }, 'migrations complete');
      await closePool();
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error({ err: error }, 'migrations failed');
      await closePool();
      process.exit(1);
    });
}
