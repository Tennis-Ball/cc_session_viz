import { describe, expect, it } from 'vitest';
import { ACTIVITY_ZONE, ACTIVITY_LABEL, type Activity, type ZoneId } from '@shared/activity';

/**
 * A representative hour of traffic.
 *
 * These are counts measured from a simulated hour built on the real tool mix —
 * Bash-heavy, one thinking block per turn, occasional fan-outs — not numbers
 * chosen to make a point. The shape is what matters: thinking dwarfs
 * everything else, because every single turn starts with one.
 */
const HOUR: Partial<Record<Activity, number>> = {
  thinking: 135,
  idle: 63,
  reading: 22,
  awaiting: 21,
  searching: 19,
  browsing: 16,
  testing: 12,
  running: 8,
  editing: 6,
  delegating: 5,
  messaging: 4,
  watching: 4,
  planning: 3,
  tasking: 3,
  compacting: 2,
  publishing: 2,
  orchestrating: 1,
};

function occupancy(): Map<ZoneId, number> {
  const out = new Map<ZoneId, number>();
  for (const [activity, count] of Object.entries(HOUR) as [Activity, number][]) {
    const zone = ACTIVITY_ZONE[activity].zone;
    out.set(zone, (out.get(zone) ?? 0) + count);
  }
  return out;
}

describe('where the work happens', () => {
  /**
   * The bug this exists to prevent: routing thinking to a shared room. It is
   * the obvious place for it — thinking looks like standing at a whiteboard —
   * and it puts the whole population in one room permanently, which is what
   * the office looked like before. Anything that takes more than half the
   * office's time belongs somewhere each agent has its own of.
   */
  it('never puts most of the office in one shared room', () => {
    const total = [...occupancy().values()].reduce((a, b) => a + b, 0);
    for (const [zone, count] of occupancy()) {
      if (zone === 'desk') continue;
      expect(count / total, `${zone} holds ${Math.round((100 * count) / total)}% of the office`).toBeLessThan(0.3);
    }
  });

  it('gives the shared rooms enough traffic to be worth building', () => {
    const busy = [...occupancy().entries()].filter(([, count]) => count > 0);
    // A campus of a dozen rooms where only two ever get used is a campus of
    // two rooms and ten monuments.
    expect(busy.length).toBeGreaterThanOrEqual(8);
  });

  it('describes every activity and sends it somewhere', () => {
    for (const activity of Object.keys(ACTIVITY_ZONE) as Activity[]) {
      expect(ACTIVITY_ZONE[activity].zone, activity).toBeTruthy();
      expect(ACTIVITY_LABEL[activity], activity).toBeTruthy();
    }
  });
});
