import { describe, expect, it } from 'vitest';
import { Staging } from '@renderer/office/anim/staging';
import { MAX_STAGES } from '@renderer/office/material/facet';
import type { Campus, Connector, Platform } from '@renderer/office/world/layout';

function platform(id: string, cell: [number, number] = [0, 0]): Platform {
  return {
    id,
    kind: 'desk',
    cell: { col: cell[0], row: cell[1], cols: 2, rows: 2 },
    position: [cell[0] * 6, cell[1] * 6],
    size: [5, 5],
    level: 0,
    stone: 0,
    stoneLevel: 0,
  } as unknown as Platform;
}

function link(from: string, to: string): Connector {
  return { from, to, kind: 'bridge' } as unknown as Connector;
}

function campus(ids: string[], connectors: Connector[] = []): Campus {
  return {
    platforms: ids.map((id, i) => platform(id, [i, 0])),
    connectors,
  } as unknown as Campus;
}

/** Runs the clock until nothing is moving, or gives up. */
function settle(staging: Staging, seconds = 12): number {
  let elapsed = 0;
  const dt = 1 / 60;
  while (elapsed < seconds && staging.busy()) {
    staging.step(dt);
    elapsed += dt;
  }
  return elapsed;
}

describe('a world arriving', () => {
  it('brings the first campus up rather than cutting to it', () => {
    const staging = new Staging();
    staging.sync(campus(['a', 'b', 'c']), MAX_STAGES);
    // Struck, every one of them: the opening frame has nothing in it, which is
    // the whole point — the office rises into a window that was empty.
    expect(staging.valueOf('a')).toBe(0);
    expect(staging.busy()).toBe(true);
    const took = settle(staging);
    expect(staging.valueOf('a')).toBe(1);
    expect(staging.valueOf('c')).toBe(1);
    // Over quickly. An opening that outstays its welcome is worse than a cut.
    expect(took).toBeLessThan(4);
  });

  it('starts them one after another', () => {
    const staging = new Staging();
    staging.sync(campus(['a', 'b', 'c', 'd', 'e']), MAX_STAGES);
    staging.step(0.2);
    const values = ['a', 'b', 'c', 'd', 'e'].map((id) => staging.valueOf(id));
    // Five buildings rising in unison read as one object with five parts.
    expect(new Set(values.map((v) => v.toFixed(3))).size).toBeGreaterThan(1);
    expect(values[0]!).toBeGreaterThan(values[4]!);
  });

  it('gives a new room its own slot and leaves the others alone', () => {
    const staging = new Staging();
    staging.sync(campus(['a', 'b']), MAX_STAGES);
    settle(staging);
    const slots = { a: staging.slotOf('a'), b: staging.slotOf('b') };

    staging.sync(campus(['a', 'b', 'c']), MAX_STAGES);
    expect(staging.slotOf('a')).toBe(slots.a);
    expect(staging.slotOf('b')).toBe(slots.b);
    expect(staging.slotOf('c')).not.toBe(slots.a);
    // Only the newcomer moves. The office does not rebuild itself around it.
    expect(staging.valueOf('a')).toBe(1);
    expect(staging.valueOf('c')).toBe(0);
  });

  it('writes every slot, and pins the ones it does not own at settled', () => {
    const staging = new Staging();
    staging.sync(campus(['a', 'b']), MAX_STAGES);
    settle(staging);
    const into = new Float32Array(MAX_STAGES).fill(0.5);
    staging.write(into);
    // Slot 0 is everything that simply exists — the freestanding arches, and
    // anything past the end of the array. It must never be struck.
    expect(into[0]).toBe(1);
    for (let i = 0; i < MAX_STAGES; i += 1) expect(into[i]).toBe(1);
  });
});

describe('a world leaving', () => {
  it('keeps a room in the picture until it has finished sinking', () => {
    const staging = new Staging();
    const before = campus(['a', 'b']);
    staging.sync(before, MAX_STAGES);
    settle(staging);

    staging.remember(before);
    staging.sync(campus(['a']), MAX_STAGES);
    // Gone from the campus, still drawn — or there is nothing to sink.
    expect(staging.sinking().map((p) => p.id)).toEqual(['b']);
    staging.step(0.2);
    expect(staging.valueOf('b')).toBeLessThan(1);
    expect(staging.valueOf('b')).toBeGreaterThan(0);

    settle(staging);
    // And then it is really gone, slot and all.
    expect(staging.sinking()).toEqual([]);
    expect(staging.valueOf('b')).toBe(1); // unknown rooms are "settled", not "struck"
  });

  it('says exactly once that a room has left the mesh', () => {
    const staging = new Staging();
    const before = campus(['a', 'b']);
    staging.sync(before, MAX_STAGES);
    settle(staging);
    staging.remember(before);
    staging.sync(campus(['a']), MAX_STAGES);

    let retirements = 0;
    for (let t = 0; t < 6; t += 1 / 60) retirements += staging.step(1 / 60).retired ? 1 : 0;
    // One React render for the whole departure, on the frame it matters.
    expect(retirements).toBe(1);
  });

  it('takes every walkway down with the room it served', () => {
    const staging = new Staging();
    const before = campus(['a', 'b'], [link('a', 'b'), link('b', 'c')]);
    staging.sync(before, MAX_STAGES);
    settle(staging);

    staging.remember(before);
    staging.sync(campus(['a']), MAX_STAGES);
    // Including the one whose other end is staying. The layout drops that the
    // instant the platform is gone, so leaving it out meant a bridge blinking
    // away while the desk it served spent a second sinking.
    expect(staging.sinkingConnectors().map((c) => `${c.from}>${c.to}`).sort()).toEqual(['a>b', 'b>c']);
  });

  it('ties a walkway to whichever end is moving', () => {
    const staging = new Staging();
    staging.sync(campus(['a']), MAX_STAGES);
    settle(staging);
    staging.sync(campus(['a', 'b']), MAX_STAGES);

    // Both ends have a slot — every room the office has seen keeps one — so
    // "whichever is non-zero" always picked `a`, and the bridge to the new
    // desk was drawn complete, reaching out over nothing.
    expect(staging.valueOf('a')).toBe(1);
    expect(staging.valueOf('b')).toBe(0);
    expect(staging.walkwaySlot('a', 'b')).toBe(staging.slotOf('b'));
    expect(staging.walkwaySlot('b', 'a')).toBe(staging.slotOf('b'));
  });

  it('catches a room that comes back before it has gone', () => {
    const staging = new Staging();
    const before = campus(['a', 'b']);
    staging.sync(before, MAX_STAGES);
    settle(staging);

    staging.remember(before);
    staging.sync(campus(['a']), MAX_STAGES);
    staging.step(0.3);
    const midway = staging.valueOf('b');
    expect(midway).toBeLessThan(1);

    // A session that blinks — which /clear does — must not make its desk drop
    // out of the world and build itself again from scratch.
    staging.sync(campus(['a', 'b']), MAX_STAGES);
    expect(staging.valueOf('b')).toBeCloseTo(midway, 6);
    settle(staging);
    expect(staging.valueOf('b')).toBe(1);
    expect(staging.sinking()).toEqual([]);
  });
});

describe('switching every room at once', () => {
  it('hands one office over to another without either blinking', () => {
    const staging = new Staging();
    const sim = campus(['s1', 's2', 's3', 's4']);
    staging.sync(sim, MAX_STAGES);
    settle(staging);

    // What a data-source switch does: every session replaced in one patch.
    staging.remember(sim);
    staging.sync(campus(['r1', 'r2', 'r3']), MAX_STAGES);

    expect(staging.sinking().map((p) => p.id).sort()).toEqual(['s1', 's2', 's3', 's4']);
    staging.step(0.25);

    const going = ['s1', 's2', 's3', 's4'].map((id) => staging.valueOf(id));
    // Some of the old office has started down and the rest is waiting its
    // turn — waiting *in place*. A room queued to leave is still a room.
    expect(going.some((v) => v < 1)).toBe(true);
    expect(going.every((v) => v > 0)).toBe(true);
    // And the new one is on its way up behind it, rather than after it.
    for (const id of ['r1', 'r2', 'r3']) expect(staging.valueOf(id)).toBeLessThan(1);

    settle(staging);
    for (const id of ['r1', 'r2', 'r3']) expect(staging.valueOf(id)).toBe(1);
    expect(staging.sinking()).toEqual([]);
  });

  it('never gives two rooms the same slot', () => {
    const staging = new Staging();
    let live = Array.from({ length: 12 }, (_, i) => `p${i}`);
    staging.sync(campus(live), MAX_STAGES);
    settle(staging);

    for (let round = 0; round < 25; round += 1) {
      const before = campus(live);
      live = live.slice(round % 3).concat([`n${round}a`, `n${round}b`]);
      staging.remember(before);
      staging.sync(campus(live), MAX_STAGES);
      settle(staging, 6);

      const slots = live.map((id) => staging.slotOf(id));
      const held = slots.filter((slot) => slot !== 0);
      expect(new Set(held).size).toBe(held.length);
      for (const slot of slots) expect(slot).toBeLessThan(MAX_STAGES);
    }
  });

  it('survives more rooms than there are slots', () => {
    const staging = new Staging();
    const many = Array.from({ length: MAX_STAGES + 20 }, (_, i) => `p${i}`);
    staging.sync(campus(many), MAX_STAGES);
    settle(staging, 20);
    const into = new Float32Array(MAX_STAGES);
    staging.write(into);
    // Past the end of the array everything is simply present, which is the old
    // behaviour rather than a broken one.
    for (let i = 0; i < MAX_STAGES; i += 1) expect(into[i]).toBe(1);
  });
});

describe('the offset', () => {
  it('is the full drop when struck and nothing when settled', () => {
    const staging = new Staging();
    staging.setDrop(30);
    staging.sync(campus(['a']), MAX_STAGES);
    expect(staging.offsetOf('a')).toBeCloseTo(-30, 6);
    settle(staging);
    expect(staging.offsetOf('a')).toBe(0);
    // Anything it has never heard of is exactly where the layout put it.
    expect(staging.offsetOf('nobody')).toBe(0);
  });

  it('eases out, so the part you watch is the slow settle', () => {
    const staging = new Staging();
    staging.setDrop(24);
    staging.sync(campus(['a']), MAX_STAGES);
    staging.step(0.5);
    const half = staging.valueOf('a');
    // Most of the travel is over while the room is still down in the fog.
    expect(half).toBeGreaterThan(0.55);
    expect(half).toBeLessThan(1);
  });
});
