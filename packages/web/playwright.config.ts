import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration.
 *
 * The suite runs against a real stack: PostgreSQL, Redis, the API (with its
 * embedded authentication), the worker and the Next.js web app. It never mocks
 * the API, so a test failure points at the product rather than at a fixture.
 *
 * `pnpm test:e2e` rebuilds the dedicated database and seeds it before
 * Playwright starts these servers.
 */

const envFile = resolve(__dirname, '../../.env.e2e');
if (existsSync(envFile)) {
  // Variables already set in the environment win, so CI can supply its own
  // service addresses.
  for (const [key, value] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const apiPort = Number(process.env.API_PORT ?? 4200);
const webPort = Number(process.env.WEB_PORT ?? 3100);

// Origin-sensitive values (cookies, Better-Auth trusted origins) must match the
// address the browser actually uses, so both are derived from the same host.
const apiUrl = `http://localhost:${apiPort}`;
const webUrl = `http://localhost:${webPort}`;

/** The current environment without `undefined` values, as Playwright expects. */
function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

const apiEnv: Record<string, string> = {
  ...inheritedEnvironment(),
  NODE_ENV: 'test',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  API_PORT: String(apiPort),
  API_HOST: '127.0.0.1',
  API_PUBLIC_URL: apiUrl,
  WEB_PUBLIC_URL: webUrl,
};

const webEnv: Record<string, string> = {
  ...inheritedEnvironment(),
  // Next.js reads PORT; the origin variables drive the runtime proxy.
  PORT: String(webPort),
  API_PUBLIC_URL: apiUrl,
  API_INTERNAL_URL: apiUrl,
  WEB_PUBLIC_URL: webUrl,
  BETTER_AUTH_URL: webUrl,
  NEXT_TELEMETRY_DISABLED: '1',
};

// NODE_ENV=test belongs to the API only; `next dev` must stay in development
// mode. The spread above may have inherited it from the process environment.
delete webEnv.NODE_ENV;

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: webUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/user.json',
      },
      dependencies: ['setup'],
    },
  ],
  webServer: [
    {
      name: 'api',
      command: 'pnpm --filter @s9/server exec bun tests/e2e/serve.ts',
      url: `${apiUrl}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: apiEnv,
    },
    {
      name: 'web',
      command: `pnpm --filter @s9/web exec next dev --port ${webPort}`,
      url: `${webUrl}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: webEnv,
    },
  ],
});
