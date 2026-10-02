import { expect, test } from '@playwright/test';
import { launchApp, shoot } from './helpers';

/**
 * Two people stopping to talk to each other.
 *
 * Asserted rather than eyeballed, because what it looks like is two small
 * figures standing still — which is also what a bug looks like. What can be
 * checked is the thing that makes it a conversation: the office pairs two of
 * them up, and they end up facing each other rather than both facing the way
 * they happened to arrive.
 */
test('people stop and talk', async () => {
  test.setTimeout(10 * 60 * 1000);
  const { app, page } = await launchApp({
    source: 'ambient',
    env: { CCV_SOURCE: 'ambient', CCV_MODE: 'simulation', CCV_SIM_SESSIONS: '10' },
    query: { probe: '1', seed: '11', clock: '13:00' },
  });
  await page.locator('.segmented button', { hasText: 'Office' }).click();

  /*
   * Waited for rather than expected at a particular moment.
   *
   * Two people falling into conversation needs two of them standing near each
   * other with nothing else to do, and then a roll of the dice — it is a rate,
   * not a schedule. On a quiet machine the first one turns up within seconds; on
   * a loaded one, with the office clock running behind, it took longer than this
   * was willing to wait and the whole spec failed on the dice rather than on
   * anything about the office. More desks and a longer wait, for the same reason
   * you do not conclude a coin is two-tailed from four throws.
   */
  type Chat = { id: string; with: string | null; facing: number; reported: boolean; note: string | null };
  let seen: Chat[] = [];
  for (let i = 0; i < 90 && seen.length === 0; i += 1) {
    await page.waitForTimeout(3000);
    seen = await page.evaluate(
      () => (window as unknown as { __atrium?: { chats(): Chat[] } }).__atrium?.chats() ?? [],
    );
  }
  /*
   * Then give them a moment before reading the headings.
   *
   * A figure turns on the spot at about a radian a second, so catching a
   * conversation on the tick it begins catches two people still facing
   * whichever way they arrived. The pairing is true immediately; the looking
   * at each other takes as long as it takes.
   */
  await page.waitForTimeout(2500);
  seen = await page.evaluate(
    () => (window as unknown as { __atrium?: { chats(): Chat[] } }).__atrium?.chats() ?? [],
  );
  await shoot(page, 'chat');
  // A conversation is a pair, so it always reports both halves of it.
  expect(seen.length).toBeGreaterThanOrEqual(2);
  const [one, other] = seen;
  expect(one?.with).toBe(other?.id);
  expect(other?.with).toBe(one?.id);
  // And they are looking at each other: half a turn apart, give or take the
  // idle sway that keeps a standing figure from being a statue.
  const turn = Math.PI * 2;
  const signed = (((one!.facing - other!.facing + Math.PI) % turn) + turn) % turn - Math.PI;
  expect(Math.abs(Math.abs(signed) - Math.PI)).toBeLessThan(0.5);

  /*
   * And the card says so.
   *
   * The office's own answer to "why are those two standing there doing
   * nothing" used to be the activity line, which says "idle" — true of the
   * session and useless about the figure. Pointing at one of them has to
   * explain what you are looking at.
   */
  const at = await page.evaluate(
    (id) =>
      (window as unknown as { __atrium?: { screenOf(i: string): { x: number; y: number } | null } }).__atrium?.screenOf(
        id,
      ) ?? null,
    one!.id,
  );
  expect(at, 'the probe could not place the figure on screen').not.toBeNull();
  await page.mouse.move(at!.x, at!.y);
  await expect(page.locator('.figure-card')).toBeVisible({ timeout: 4000 });
  // Named only when a message caused it; two people who simply ran into each
  // other in the lounge get the truth about that instead. See `chatNote`.
  await expect(page.locator('.figure-card')).toContainText(one!.reported ? 'Talking to' : 'Chatting');

  await app.close();
});
