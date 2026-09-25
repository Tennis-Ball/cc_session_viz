import { test } from '@playwright/test';
import { launchApp, shoot } from './helpers';

/** Development harness: look at the real thing with real sessions. */
test('canvas over live sessions', async () => {
  const { app, page } = await launchApp({ source: 'live' });
  await page.locator('.segmented button', { hasText: 'Canvas' }).click();
  await page.waitForTimeout(9000);
  await shoot(page, 'live-canvas');

  // Zoom in on one card to check the TUI replica at reading size.
  await page.mouse.move(700, 600);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Meta+Equal').catch(() => {});
  }
  await page.locator('.react-flow__controls button').first().click();
  await page.locator('.react-flow__controls button').first().click();
  await page.waitForTimeout(1200);
  await shoot(page, 'live-canvas-zoom');
  await app.close();
});
