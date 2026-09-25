import { expect, test } from '@playwright/test';
import { launchApp } from './helpers';

/**
 * The office draws at 60 Hz when you are looking at it, and not at all when you
 * are not.
 *
 * Both halves of that were broken and neither was visible. `frameloop` was never
 * passed to the `Canvas` at all, so it defaulted to `always` and the office
 * redrew on every vsync for the life of the window — 120 fps on a ProMotion
 * display to redraw a picture that changes by under a thousandth of its pixels.
 * And switching modes unmounted the whole view, so the WebGL context was
 * destroyed and rebuilt every time, which is both a black frame and a good way
 * to hit the browser's live-context cap.
 *
 * Measured through the office's own probe, which records when the renderer
 * actually ran rather than when a timer thought it should have.
 */
test('the office paces itself and stops when it is not in front', async () => {
  test.setTimeout(180_000);
  const { app, page } = await launchApp({ source: 'sim:showcase', query: { probe: '1', clock: '13:00' } });

  await expect(page.locator('.titlebar')).toBeVisible();
  await page.locator('.segmented button', { hasText: 'Office' }).click();
  await page.waitForTimeout(8_000);

  const pace = async (): Promise<number[]> => {
    const frames = (await page.evaluate(
      (n) =>
        (window as unknown as { __atrium?: { flicker(n: number, light?: boolean): Promise<{ t: number }[]> } }).__atrium?.flicker(n, true),
      600,
    )) as { t: number }[] | undefined;
    expect(frames, 'the probe recorded no frames').toBeTruthy();
    return frames!.slice(1).map((frame, i) => frame.t - frames![i]!.t);
  };

  const gaps = await pace();
  const median = [...gaps].sort((a, b) => a - b)[(gaps.length / 2) | 0]!;
  // 60 Hz is 16.7ms. Anything near 8.3 means it is drawing every vsync again.
  expect(median, `median frame gap was ${median.toFixed(1)}ms`).toBeGreaterThan(13);
  expect(median, `median frame gap was ${median.toFixed(1)}ms`).toBeLessThan(20);
  // A pacer that counts refreshes should almost never overrun. Timing one by
  // elapsed milliseconds missed a sixth of its deadlines.
  const late = gaps.filter((gap) => gap > 21).length;
  expect(late / gaps.length, `${late} of ${gaps.length} frames ran long`).toBeLessThan(0.1);

  // In canvas mode the office is still mounted — and must be idle. The world
  // keeps arriving from the engine and R3F invalidates on every scene-graph
  // change, so this only holds because the frameloop itself is switched off.
  await page.locator('.segmented button', { hasText: 'Canvas' }).click();
  await page.waitForTimeout(1_500);
  const drewWhileHidden = await page.evaluate(async () => {
    const probe = (window as unknown as { __atrium?: { flicker(n: number, light?: boolean): Promise<unknown> } }).__atrium;
    if (!probe) return true;
    return Promise.race([
      probe.flicker(3, true).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
  });
  expect(drewWhileHidden, 'the office kept rendering behind the canvas').toBe(false);

  // The context survived, so coming back is instant rather than a rebuild — and
  // the office picks its cadence straight back up.
  await page.locator('.segmented button', { hasText: 'Office' }).click();
  await page.waitForTimeout(1_500);
  const again = await pace();
  const medianAgain = [...again].sort((a, b) => a - b)[(again.length / 2) | 0]!;
  expect(medianAgain, `median frame gap after switching back was ${medianAgain.toFixed(1)}ms`).toBeGreaterThan(13);
  expect(medianAgain).toBeLessThan(20);

  await app.close();
});
