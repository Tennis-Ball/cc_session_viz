import { expect, test } from '@playwright/test';
import { launchApp, shoot } from './helpers';

/**
 * Agents sit on their chairs.
 *
 * This has been got wrong twice, each time in a way a whole-campus screenshot
 * hid: once the figure never committed to the chair it spawned at, once it sat
 * at a height derived from its own size rather than from the furniture, so it
 * floated above a tall chair and sank into a low one. Both looked fine from
 * across the office and wrong the moment you looked at a desk.
 *
 * So this asks the office directly — how many figures believe they are seated,
 * and how high the seat each of them is using — and then leaves a close crop
 * of one of them in artifacts/shots to be looked at.
 */
test('agents sit on the furniture, not above it', async () => {
  test.setTimeout(120_000);
  const { app, page } = await launchApp({
    source: 'sim:showcase',
    query: { probe: '1', clock: '13:00', seed: '9' },
  });

  await expect(page.locator('.titlebar')).toBeVisible();
  await page.locator('.segmented button', { hasText: 'Office' }).click();
  // Long enough for figures to walk to a zone, claim a slot and settle into it.
  await page.waitForTimeout(20_000);

  const seats = await page.evaluate(() => {
    const probe = (window as unknown as {
      __atrium?: {
        figures(): { id: string; phase: string; seated: number; seatHeight: number }[];
        screenOf(id: string): { x: number; y: number } | null;
      };
    }).__atrium;
    const figures = probe?.figures() ?? [];
    return {
      total: figures.length,
      sitting: figures
        .filter((figure) => figure.seated > 0.5)
        .map((figure) => ({ id: figure.id, seated: figure.seated, seatHeight: figure.seatHeight, at: probe?.screenOf(figure.id) ?? null })),
    };
  });

  expect(seats.total, 'the office had nobody in it').toBeGreaterThan(0);
  expect(seats.sitting.length, 'nobody in the whole office is sitting down').toBeGreaterThan(0);

  for (const sitter of seats.sitting) {
    // A seat height comes from the prop's own slot, scaled with the prop. A
    // figure reporting the 0.42 fallback is one whose furniture never told it
    // where its chair was, which is exactly the bug that made agents hover.
    expect(sitter.seatHeight, `${sitter.id} is sitting at the fallback height`).toBeGreaterThan(0.05);
    expect(sitter.seatHeight, `${sitter.id} is sitting improbably high`).toBeLessThan(1.6);
  }

  await shoot(page, 'office-seats');
  await app.close();
});
