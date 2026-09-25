import { expect, test } from '@playwright/test';
import { launchApp, shoot } from './helpers';

/** Ambient mode with no live session data at all. */
test('the simulation fills an empty house', async () => {
  const { app, page } = await launchApp({ source: 'ambient', env: { CCV_SOURCE: 'ambient', CCV_MODE: 'simulation' } });

  // Emulated sessions arrive on their own.
  await page.locator('.segmented button', { hasText: 'Canvas' }).click();
  await expect(page.locator('.canvas-view')).toBeVisible();
  await page.waitForTimeout(12_000);
  await shoot(page, 'sim-canvas');

  await page.evaluate(() => window.history.replaceState({}, '', '?clock=13:00&probe=1'));
  await page.locator('.segmented button', { hasText: 'Office' }).click();
  await page.waitForTimeout(20_000);
  await shoot(page, 'sim-office');
  await app.close();
});
