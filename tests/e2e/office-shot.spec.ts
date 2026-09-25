import { test } from '@playwright/test';
import { launchApp, shoot } from './helpers';

/** Development harness for the office scene, at a pinned midday. */
test('office over live sessions', async () => {
  const { app, page } = await launchApp({ source: 'live' });
  await page.waitForTimeout(7000);
  await page.evaluate(() => {
    window.history.replaceState({}, '', '?clock=13:00');
  });
  await page.locator('.segmented button', { hasText: 'Office' }).click();
  await page.waitForTimeout(4000);
  await shoot(page, 'office-default');
  await app.close();
});
