import { expect, test } from '@playwright/test';
import { launchApp } from './helpers';

interface Figure {
  id: string;
  phase: string;
  platform: string | null;
  zone: string | null;
  position: [number, number, number];
}

interface Platform {
  id: string;
  position: [number, number];
  size: [number, number];
  level: number;
}

interface Connector {
  id: string;
  a: [number, number, number];
  b: [number, number, number];
  kind: string;
}

/** Distance from a point to a line segment, on the ground plane. */
function distanceToSegment(px: number, pz: number, a: [number, number, number], b: [number, number, number]): number {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[2]) * dz) / lengthSquared));
  return Math.hypot(px - (a[0] + dx * t), pz - (a[2] + dz * t));
}

/**
 * The office is a place, and people stand on floors.
 *
 * A figure adrift in the void is the loudest possible rendering bug and the
 * easiest to miss in a screenshot, so it gets asserted rather than eyeballed.
 */
test('nobody stands in the void', async () => {
  test.setTimeout(180_000);
  const { app, page } = await launchApp({
    source: 'ambient',
    env: { CCV_SOURCE: 'ambient', CCV_MODE: 'simulation' },
    query: { probe: '1' },
  });

  await expect(page.locator('.titlebar')).toBeVisible();
  await page.waitForTimeout(3_000);
  await page.locator('.segmented button', { hasText: 'Office' }).click();

  // Let sessions come and go, so desks are added and removed under the figures.
  const offenders: string[] = [];
  let checked = 0;

  for (let sweep = 0; sweep < 14; sweep++) {
    await page.waitForTimeout(8_000);
    const snapshot = await page.evaluate(() => {
      const probe = (window as unknown as {
        __atrium?: { figures(): unknown; platforms(): unknown; connectors(): unknown };
      }).__atrium;
      if (!probe) return null;
      return {
        figures: probe.figures() as Figure[],
        platforms: probe.platforms() as Platform[],
        connectors: probe.connectors() as Connector[],
      };
    });
    if (!snapshot) continue;

    const byId = new Map(snapshot.platforms.map((p) => [p.id, p]));

    // A figure on the move has to be on a floor or on a walkway — never
    // striding through open air between them.
    for (const figure of snapshot.figures) {
      if (figure.phase !== 'walking') continue;
      checked += 1;
      const [x, , z] = figure.position;
      const onPlatform = snapshot.platforms.some(
        (p) => Math.abs(x - p.position[0]) <= p.size[0] / 2 + 0.6 && Math.abs(z - p.position[1]) <= p.size[1] / 2 + 0.6,
      );
      const onWalkway = snapshot.connectors.some((c) => distanceToSegment(x, z, c.a, c.b) <= 1.4);
      if (!onPlatform && !onWalkway) {
        offenders.push(
          `${figure.id} (${figure.zone}) is walking through open air at ${x.toFixed(1)}, ${z.toFixed(1)}`,
        );
      }
    }

    for (const figure of snapshot.figures) {
      if (figure.phase !== 'standing') continue;
      checked += 1;
      const platform = figure.platform ? byId.get(figure.platform) : undefined;
      if (!platform) {
        offenders.push(`${figure.id} stands on ${figure.platform ?? 'nothing'}, which is not on the floor plan`);
        continue;
      }
      const dx = Math.abs(figure.position[0] - platform.position[0]);
      const dz = Math.abs(figure.position[2] - platform.position[1]);
      // Half a unit of slack: a figure may stand at the very edge of a seat.
      if (dx > platform.size[0] / 2 + 0.5 || dz > platform.size[1] / 2 + 0.5) {
        offenders.push(
          `${figure.id} (${figure.zone}) is ${dx.toFixed(1)}×${dz.toFixed(1)} from the centre of ${platform.id}, ` +
            `which is ${platform.size[0]}×${platform.size[1]}`,
        );
      }
    }
  }

  await app.close();
  expect(checked, 'the probe never saw anybody standing').toBeGreaterThan(5);
  expect(offenders, offenders.join('\n')).toHaveLength(0);
});
