import { defineConfig } from 'tsdown';

/**
 * Server bundler configuration.
 *
 * Every entry point is an executable process (or a CLI), so they are built as
 * separate ESM bundles that keep their conventional `.js` names. The runtime
 * dependencies stay external: the images copy `node_modules`, and the
 * workspace core package is resolved from its own build.
 */
export default defineConfig({
  entry: {
    'main-api': 'src/main-api.ts',
    'main-worker': 'src/main-worker.ts',
    'main-scheduler': 'src/main-scheduler.ts',
    'cli-migrate': 'src/cli/migrate.ts',
    'cli-reset': 'src/cli/reset.ts',
    'cli-seed': 'src/cli/seed.ts',
  },
  platform: 'node',
  format: ['esm'],
  target: 'node20',
  sourcemap: true,
  clean: true,
  // tsdown pins Node output to `.mjs` by default. The package is already ESM
  // (`"type": "module"`), and the images and `start:*` scripts execute
  // `dist/*.js`, so keep the conventional extension.
  fixedExtension: false,
  dts: false,
  // The entry points are executed directly in development.
  banner: { js: '#!/usr/bin/env bun' },
});
