import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'main-api': 'src/main-api.ts',
    'main-worker': 'src/main-worker.ts',
    'main-scheduler': 'src/main-scheduler.ts',
  },
  format: ['esm'],
  target: 'node20',
  sourcemap: true,
  clean: true,
  splitting: false,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
});
