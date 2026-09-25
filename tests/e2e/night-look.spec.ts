import { test } from '@playwright/test';
import { launchApp, shoot } from './helpers';

test('night', async () => {
  const { app, page } = await launchApp({ source: 'sim:showcase' });
  await page.waitForTimeout(6000);
  await page.locator('.segmented button', { hasText: 'Office' }).click();
  await page.evaluate(() => window.history.replaceState({}, '', '?clock=02:00&seed=7'));
  await page.waitForTimeout(3500);
  await shoot(page, 'night-0200');
  await app.close();
});
