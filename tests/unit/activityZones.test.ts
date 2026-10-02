import { describe, expect, it } from 'vitest';
import { ACTIVITY_ZONE, ACTIVITY_LABEL, type Activity, type ZoneId } from '@shared/activity';

/**
 * A representative afternoon, in parts per thousand of agent-time.
 *
 * Sampled from three hours of the simulation — which is built on the real tool
 * mix, Bash-heavy with a thinking block opening every turn — rather than chosen
 * to make a point. The shape is what matters, and two things about it drive the
 * whole campus: thinking is far and away the largest single number, because
 * every turn starts with one; and the long waits are the next largest, because
 * an agent sitting on a test suite, a fan-out, a workflow or a background task
 * is doing that for minutes at a time, not for the instant the call is made.
 *
 * The numbers this replaces were written when those waits all read as thinking,
 * so they credited four rooms with traffic that was not actually going there.
 * Kept in sync by hand, deliberately: it is a record of what the layout was
 * designed against, and `simulation.test.ts` is what checks the present.
 */
const HOUR: Partial<Record<Activity, number>> = {
  thinking: 293,
  idle: 130,
  testing: 113,
  responding: 77,
  watching: 74,
  delegating: 61,
  browsing: 44,
  awaiting: 33,
  reading: 29,
  searching: 29,
  orchestrating: 27,
  editing: 16,
  planning: 15,
  tooling: 12,
  running: 11,
  publishing: 9,
  learning: 6,
  compacting: 5,
  messaging: 5,
  tasking: 5,
  stalled: 4,
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
