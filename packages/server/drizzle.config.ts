import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration.
 *
 * `generate` reads the TypeScript schema and writes SQL migrations, so it does
 * not need a database. `push`/`studio` use the same connection string as the
 * server.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://s9:s9@localhost:55432/s9',
  },
  strict: true,
  verbose: true,
});
