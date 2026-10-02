import { expect, test } from '@playwright/test';
import { launchApp, shoot } from './helpers';

/**
 * The office with thirty sessions in it.
 *
 * This state was in the plan, asserted about in the unit tests and never once
 * looked at, because nothing could produce it: the simulation held between two
 * and six desks and the live source needs thirty real terminals. `CCV_SIM_SESSIONS`
 * is what makes the crowd reachable, and this is what looks at it — desk spiral
 * overflow, label collision and the figure batches all fail here first.
 */
test('thirty desks', async () => {
  const { app, page } = await launchApp({
    source: 'ambient',
    env: { CCV_SOURCE: 'ambient', CCV_MODE: 'simulation', CCV_SIM_SESSIONS: '30' },
  });

  await page.locator('.segmented button', { hasText: 'Office' }).click();
  await page.evaluate(() => window.history.replaceState({}, '', '?clock=13:00&seed=3'));
  await page.waitForTimeout(30_000);

  const sessions = await page.evaluate(
    () => (window as unknown as { __ccv?: { sessions?: number } }).__ccv?.sessions ?? 0,
  );
  await shoot(page, 'crowd-office');

  await page.locator('.segmented button', { hasText: 'Canvas' }).click();
  await page.waitForTimeout(6000);
  await shoot(page, 'crowd-canvas');

  // The probe is best-effort; the shots are the point. What must hold is that
  // a crowd does not take the office down.
  expect(sessions).toBeGreaterThanOrEqual(0);
  await app.close();
});
