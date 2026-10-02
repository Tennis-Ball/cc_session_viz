import { expect, test } from '@playwright/test';
import { launchApp } from './helpers';

type Body = {
  id: string;
  at: [number, number, number];
  routed: [number, number, number];
  radius: number;
  phase: string;
  on: string | null;
  seated: boolean;
};
type Row = { id: string; doing: string; want: string | null; at: string | null; phase: string };

/**
 * Figures do not stand inside each other, and they do get where they are going.
 *
 * Both halves of this are things you catch rather than reason about. An overlap
 * lasts the second two routes cross, so a screenshot almost never lands on one,
 * and the only way to see it is to sample the drawn pose fast and keep the worst
 * case. The other half is the failure that fixing the first one invites: a crowd
 * so eager to give way, or re-routed so often, that nobody ever arrives, and the
 * office becomes a roomful of people milling about.
 *
 * What is asserted is deliberately not "never, not once, not for a frame". Every
 * geometry two walking figures can meet at is covered exactly and deterministically
 * by the sweep in `tests/unit/separation.test.ts`, which is the right instrument
 * for it; a sampled run of a live office is noisy enough that one bad crossing
 * and five are the same reading twice. What this adds is the thing that sweep
 * cannot see: the office *routes* two figures onto the same spot now and then —
 * when its floor plan is rebuilt, or when two walkways merge — and no correction
 * applied to a drawn position can be instantaneous. So a frame of it is allowed,
 * and a pair still inside each other the better part of a second later is not.
 */
test('nobody walks through anybody', async () => {
  test.setTimeout(5 * 60 * 1000);
  const { app, page } = await launchApp({
    source: 'ambient',
    env: { CCV_SOURCE: 'ambient', CCV_MODE: 'simulation', CCV_SIM_SESSIONS: '10' },
    query: { probe: '1', seed: '12', clock: '13:00', weather: 'clear' },
  });
  await page.locator('.segmented button', { hasText: 'Office' }).click();
  await page.waitForTimeout(6000);

  let worst = 1;
  let worstAt = '';
  let pairs = 0;
  let close = 0;
  let stuck = '';
  let inside = new Set<string>();
  let standing = 0;
  let poses = 0;
  const zones = new Set<string>();

  for (let i = 0; i < 100; i += 1) {
    await page.waitForTimeout(800);
    const [bodies, work] = await page.evaluate(() => {
      const probe = (window as unknown as { __atrium?: { bodies(): Body[]; work(): Row[] } }).__atrium;
      return [probe?.bodies() ?? [], probe?.work() ?? []] as const;
    });

    const nowInside = new Set<string>();
    for (let a = 0; a < bodies.length; a += 1) {
      for (let b = a + 1; b < bodies.length; b += 1) {
        const A = bodies[a]!;
        const B = bodies[b]!;
        // A storey apart is not close, however close it looks from up here.
        if (Math.abs(A.at[1] - B.at[1]) > 1.1) continue;
        pairs += 1;
        const want = A.radius + B.radius;
        const ratio = Math.hypot(A.at[0] - B.at[0], A.at[2] - B.at[2]) / want;
        if (ratio < 1) close += 1;
        if (ratio < 0.5) {
          const key = [A.id, B.id].sort().join('|');
          nowInside.add(key);
          if (inside.has(key) && !stuck) {
            const routed = Math.hypot(A.routed[0] - B.routed[0], A.routed[2] - B.routed[2]);
            stuck = `${A.id}(${A.phase},${A.on}) and ${B.id}(${B.phase},${B.on}) — routed ${routed.toFixed(2)}, want ${want.toFixed(2)}`;
          }
        }
        if (ratio < worst) {
          worst = ratio;
          worstAt = `${A.id}(${A.phase}) / ${B.id}(${B.phase}) at ${ratio.toFixed(2)} of a body`;
        }
      }
    }
    inside = nowInside;

    for (const row of work) {
      poses += 1;
      if (row.phase !== 'standing') continue;
      standing += 1;
      if (row.at) zones.add(row.at);
    }
  }

  expect(pairs, 'the probe never saw two figures at once').toBeGreaterThan(200);
  // The one that is never acceptable: still drawn inside each other most of a
  // second after they first were. That is not a crossing, it is a pile.
  expect(stuck, 'two figures stayed inside each other').toBe('');
  // And touching at all stays rare. Before the separation pass was rebuilt this
  // was one pair in twenty; it is now one in a hundred.
  expect(close / pairs, `${close} of ${pairs} pairs closer than touching; worst ${worstAt}`).toBeLessThan(0.025);

  // They also arrive. A figure that never stops walking is not visiting a room,
  // it is orbiting one, which is what over-eager re-routing looks like.
  expect(standing / poses, 'almost nobody ever stands still').toBeGreaterThan(0.2);
  expect(zones.size, `only visited ${[...zones].join(', ')}`).toBeGreaterThanOrEqual(3);

  await app.close();
});
