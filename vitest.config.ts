import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    /*
     * Well past vitest's 5s default, because several of these are genuinely
     * expensive rather than slow: the office layout and architecture suites
     * build a whole campus per seed and merge its geometry, which is hundreds
     * of milliseconds of real arithmetic each on this machine and several
     * times that on a shared CI runner. Five seconds passes locally and fails
     * in Actions, which is the worst of both.
     *
     * Nothing here waits on I/O, so a generous limit cannot mask a hang — it
     * can only decide how long a genuine one takes to report.
     */
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@engine': resolve(__dirname, 'src/engine'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
});
