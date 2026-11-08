import { defineConfig } from 'tsdown';

/**
 * Core library bundler configuration.
 *
 * The package is ESM and declares its entry points as `dist/index.js` and
 * `dist/index.d.ts`, so the output keeps conventional extensions instead of
 * tsdown's `.mjs` default. Dependency declarations are external and resolved
 * by the consumer.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  platform: 'node',
  format: ['esm'],
  target: 'node20',
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
});
