import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: './artifacts/e2e',
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.002 },
  },
});
