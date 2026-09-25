import { expect, test } from '@playwright/test';
import { launchApp, shoot } from './helpers';

/**
 * Hovering a figure names it, and clicking one takes you to its terminal.
 * The office answers "what is going on"; the canvas answers "what did it say".
 */
test('a figure can be inspected and followed', async () => {
  test.setTimeout(120_000);
  const { app, page } = await launchApp({
    source: 'live',
    env: { CCV_SOURCE: 'live' },
    query: { probe: '1' },
  });

  await expect(page.locator('.titlebar')).toBeVisible();
  await page.waitForTimeout(3_000);
  await page.locator('.segmented button', { hasText: 'Office' }).click();
  // Long enough for the cold load to finish and for figures to stop
  // materialising; a figure mid-arrival is a fraction of its final size.
  await page.waitForTimeout(12_000);

  // Figures walk, and one standing behind a bookcase is genuinely not
  // pointable, so try each of them in turn and re-read positions every round.
  const aim = async (): Promise<{ x: number; y: number }[]> =>
    page.evaluate(() => {
      const probe = (window as unknown as {
        __atrium?: {
          figures(): { id: string; phase: string }[];
          screenOf(id: string): { x: number; y: number } | null;
        };
      }).__atrium;
      const figures = probe?.figures() ?? [];
      const ordered = [...figures].sort((a, b) => Number(b.phase === 'standing') - Number(a.phase === 'standing'));
      return ordered
        .map((figure) => probe?.screenOf(figure.id) ?? null)
        .filter((spot): spot is { x: number; y: number } => spot !== null);
    });

  let shown = false;
  let target: { x: number; y: number } | null = null;

  for (let round = 0; round < 3 && !shown; round++) {
    const spots = await aim();
    expect(spots.length, 'the probe found no figure to hover').toBeGreaterThan(0);
    for (const spot of spots) {
      await page.mouse.move(spot.x, spot.y);
      shown = await page
        .locator('.figure-card')
        .waitFor({ state: 'visible', timeout: 1_200 })
        .then(() => true)
        .catch(() => false);
      if (shown) {
        target = spot;
        break;
      }
    }
  }
  expect(shown, 'hovering a figure showed no card').toBe(true);
  await page.waitForTimeout(400);
  await shoot(page, 'office-hover');

  // Clicking pins the card rather than throwing you into the canvas: the card
  // stays put when the pointer leaves, and offers the terminal as a choice.
  await page.mouse.click(target!.x, target!.y);
  await page.mouse.move(4, 4);
  await page.waitForTimeout(300);
  await expect(page.locator('.figure-card')).toBeVisible();

  await page.locator('.figure-card button', { hasText: 'Open terminal' }).click();
  await expect(page.locator('.canvas-view')).toBeVisible();
  await app.close();
});
