import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The tests resolve the shared core package from source, so a test run does
 * not need a build step first.
 */
const alias = {
  '@s9/core': resolve(here, '../core/src/index.ts'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    // Integration test files share one database and truncate it between tests,
    // so files must never overlap. This has to live on the root config: Vitest
    // does not apply `fileParallelism` from an individual project.
    fileParallelism: false,
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/setup/env.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
