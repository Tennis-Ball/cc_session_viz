import { test } from '@playwright/test';
import { launchApp, press, shoot } from './helpers';

/**
 * Development harness for the world generator.
 *
 * Every world is built from one seed, so the only way to know whether the
 * generator is any good is to look at several of them side by side: one world
 * tells you nothing about whether the next one will be a different place or the
 * same place shuffled. Shots land in artifacts/shots/.
 */
/**
 * One per dialect, so a pass over these shows the whole vocabulary rather than
 * seven goes at whichever one the first seed happened to pick: steps, courts,
 * arcades, domes, spires, waters, ramparts.
 */
const SEEDS = [1, 4, 7, 9, 12, 14, 20];

test('worlds', async () => {
  const { app, page } = await launchApp({ source: 'sim:showcase' });
  await page.waitForTimeout(6000);
  await page.locator('.segmented button', { hasText: 'Office' }).click();

  for (const seed of SEEDS) {
    await page.evaluate((value) => {
      window.history.replaceState({}, '', `?clock=13:00&seed=${value}`);
    }, seed);
    // Long enough for the campus to rebuild and the rooms in use to go up.
    await page.waitForTimeout(3500);
    await shoot(page, `world-${seed}`);
  }

  await page.evaluate(() => {
    window.history.replaceState({}, '', '?clock=13:00&seed=1');
  });
  await page.waitForTimeout(3000);

  /**
   * The same world at each detail setting.
   *
   * The seed is held so this is genuinely one place three times, which is the
   * only way to judge whether turning the office down keeps its character or
   * just empties it.
   */
  for (const detail of ['quiet', 'ornate'] as const) {
    await page.evaluate(
      (value) => (window as unknown as { atrium: { prefs: { set(patch: unknown): Promise<unknown> } } }).atrium.prefs.set({ office: { detail: value } }),
      detail,
    );
    await page.waitForTimeout(2500);
    await shoot(page, `world-1-${detail}`);
  }
  await page.evaluate(
    () => (window as unknown as { atrium: { prefs: { set(patch: unknown): Promise<unknown> } } }).atrium.prefs.set({ office: { detail: 'composed' } }),
  );
  await page.waitForTimeout(2500);

  // Half a turn, because half of what a world builds faces away from the house
  // angle. A waterfall on the far side of the campus is still a waterfall, and
  // the only way to know it looks like one is to go round and look at it.
  for (let quarter = 0; quarter < 4; quarter++) await press(page, '[');
  await page.waitForTimeout(2000);
  await shoot(page, 'world-1-turned');

  // The same world at dusk, to check the architecture still reads once the
  // palette collapses toward the sky.
  await page.evaluate(() => {
    window.history.replaceState({}, '', '?clock=20:30&seed=1');
  });
  await page.waitForTimeout(3000);
  await shoot(page, 'world-1-dusk');

  await app.close();
});
