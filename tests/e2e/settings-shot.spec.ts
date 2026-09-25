import { expect, test } from '@playwright/test';
import { launchApp, shoot } from './helpers';

/** The settings sheet, over the office it is changing. */
test('settings sheet', async () => {
  test.setTimeout(120_000);
  const { app, page } = await launchApp({ source: 'live', env: { CCV_SOURCE: 'live' } });

  await expect(page.locator('.titlebar')).toBeVisible();
  await page.waitForTimeout(3_000);
  await page.locator('.segmented button', { hasText: 'Office' }).click();
  await page.waitForTimeout(6_000);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('.sheet')).toBeVisible();
  await page.waitForTimeout(600);
  await shoot(page, 'settings');

  // Picking a theme has to change the office behind the sheet, not just the card.
  await page.locator('.theme-card', { hasText: 'Sage' }).click();
  await page.waitForTimeout(1_500);
  await shoot(page, 'settings-sage');
  await app.close();
});
