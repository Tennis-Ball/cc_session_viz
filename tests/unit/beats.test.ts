import { describe, expect, it } from 'vitest';
import { BEAT_DURATIONS, BeatQueue, modifierFor, NEUTRAL, type BeatKind } from '@renderer/office/anim/beats';

const KINDS = Object.keys(BEAT_DURATIONS) as BeatKind[];

describe('beats', () => {
  it('starts and ends at rest, whatever the gesture', () => {
    for (const kind of KINDS) {
      for (const t of [0, 1]) {
        const m = modifierFor(kind, t);
        expect(Math.abs(m.lift), `${kind} lift at ${t}`).toBeLessThan(0.02);
        expect(Math.abs(m.squash - 1), `${kind} squash at ${t}`).toBeLessThan(0.02);
        expect(Math.abs(m.tilt), `${kind} tilt at ${t}`).toBeLessThan(0.05);
        expect(Math.abs(m.spin), `${kind} spin at ${t}`).toBeLessThan(0.02);
      }
    }
  });

  it('stays within a range that still looks like a person', () => {
    for (const kind of KINDS) {
      for (let t = 0; t <= 1; t += 0.05) {
        const m = modifierFor(kind, t);
        expect(m.squash).toBeGreaterThan(0.75);
        expect(m.squash).toBeLessThan(1.25);
        expect(Math.abs(m.tilt)).toBeLessThan(0.45);
        expect(Math.abs(m.lift)).toBeLessThan(0.3);
        expect(m.carry).toBeGreaterThanOrEqual(0);
        expect(m.carry).toBeLessThanOrEqual(1);
      }
    }
  });

  it('plays one gesture at a time and returns to neutral', () => {
    const queue = new BeatQueue();
    queue.push('nod', 0);
    expect(queue.current).toBe('nod');
    expect(queue.evaluate(BEAT_DURATIONS.nod.durationMs / 2).tilt).not.toBe(0);

    queue.evaluate(BEAT_DURATIONS.nod.durationMs + 1);
    expect(queue.current).toBeNull();
    expect(queue.evaluate(9999)).toEqual(NEUTRAL);
  });

  it('lets an interrupt cut across a quieter gesture', () => {
    const queue = new BeatQueue();
    queue.push('carry', 0);
    queue.push('squash', 100);
    expect(queue.current).toBe('squash');
  });

  it('makes a quieter gesture wait rather than stepping on a louder one', () => {
    const queue = new BeatQueue();
    queue.push('squash', 0);
    queue.push('nod', 10);
    expect(queue.current).toBe('squash');

    queue.evaluate(BEAT_DURATIONS.squash.durationMs + 1);
    expect(queue.current).toBe('nod');
  });

  it('does not stack repeats of the same gesture', () => {
    const queue = new BeatQueue();
    queue.push('nod', 0);
    queue.push('nod', 10);
    queue.push('nod', 20);
    queue.evaluate(BEAT_DURATIONS.nod.durationMs + 1);
    expect(queue.current).toBeNull();
  });

  it('drops the overflow instead of queueing a backlog', () => {
    const queue = new BeatQueue();
    queue.push('squash', 0);
    queue.push('nod', 1);
    queue.push('lookUp', 2);
    queue.push('greet', 3);
    queue.push('debrief', 4);

    // squash + two queued: everything after that is stale by the time it runs.
    let now = BEAT_DURATIONS.squash.durationMs + 1;
    queue.evaluate(now);
    expect(queue.current).toBe('nod');
    now += BEAT_DURATIONS.nod.durationMs + 1;
    queue.evaluate(now);
    expect(queue.current).toBe('lookUp');
    now += BEAT_DURATIONS.lookUp.durationMs + 1;
    queue.evaluate(now);
    expect(queue.current).toBeNull();
  });
});
