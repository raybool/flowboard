import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: false,
  plugins: [swc.vite({ module: { type: 'es6', resolveFully: false } })],
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    fileParallelism: false,
    include: ['test/**/*.postgres.spec.ts'],
    setupFiles: ['./test/postgres-required.setup.ts'],
  },
});
