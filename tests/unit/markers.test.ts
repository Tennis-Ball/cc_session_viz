import { describe, expect, it } from 'vitest';
import { deskMarkers, fillHeight, tickHeight } from '@renderer/office/scene/Markers';
import { buildCampus, type DeskRequest } from '@renderer/office/world/layout';

/**
 * The two things the office says about a session without being asked: whose
 * desk it is, and how full its context is.
 *
 * Both used to be unreadable. The colour was a band around the rim of a floor,
 * and a floor is the first thing the next platform along hides; the context was
 * a stack of paper on a desk, invisible at anything but the closest zoom. The
 * invariants worth holding are about *legibility from a distance*, which is why
 * they are asserted on geometry rather than eyeballed in a screenshot.
 */

function desks(count: number): DeskRequest[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `slot-${i}`,
    label: `s${i}`,
    colorIndex: i,
    seats: 1,
  }));
}

describe('desk markers', () => {
  it('gives every desk exactly one mast, keyed by its session', () => {
    const campus = buildCampus(desks(9), new Map(), 11, 'ornate');
    const markers = deskMarkers(campus);

    expect(markers).toHaveLength(9);
    expect(new Set(markers.map((m) => m.slotId)).size).toBe(9);
    // Keyed by slot id, not platform id: the flag has to find its session in
    // the world every frame, and a platform id would never match one.
    for (const marker of markers) expect(marker.slotId).toMatch(/^slot-\d+$/);
  });

  it('puts no mast on a room', () => {
    const campus = buildCampus([], new Map(), 11, 'ornate');
    expect(deskMarkers(campus)).toEqual([]);
  });

  it('stands each pile on its own platform, well inside the rim', () => {
    /*
     * "On the platform" is not enough, and that is the whole lesson of the mast
     * this replaced: it stood 0.55 from the corner, which is on the deck by
     * arithmetic and *on the silhouette* in an isometric view, so every one of
     * them looked like it was floating beside its desk. A margin the width of
     * the object itself is what makes a thing read as standing on a floor.
     */
    for (const seed of [1, 4, 9, 17, 23]) {
      for (const count of [1, 3, 8, 15]) {
        const campus = buildCampus(desks(count), new Map(), seed, 'ornate');
        const byId = new Map(campus.platforms.map((p) => [p.ownerId ?? p.id, p]));

        for (const marker of deskMarkers(campus)) {
          const platform = byId.get(marker.slotId)!;
          const [width, depth] = platform.size;
          const where = `seed ${seed}, ${count} desks, ${marker.slotId}`;
          expect(Math.abs(marker.at[0] - platform.position[0]), where).toBeLessThan(width / 2 - 0.6);
          expect(Math.abs(marker.at[2] - platform.position[1]), where).toBeLessThan(depth / 2 - 0.45);
        }
      }
    }
  });
});

describe('the context gauge', () => {
  it('fills with the context and never overflows the gauge', () => {
    const empty = fillHeight(0);
    const half = fillHeight(50);
    const full = fillHeight(100);

    // Empty reads as empty. The flag this replaced sat at its lowest position
    // for a session with nothing in it, which reads as a flag flown low.
    expect(empty).toBe(0);
    expect(half).toBeGreaterThan(empty);
    expect(full).toBeGreaterThan(half);
    // Linear, because it is a quantity: a reading you have to un-curve in your
    // head is not a reading.
    expect(half).toBeCloseTo(full / 2, 6);
  });

  it('holds a bad number inside the gauge', () => {
    expect(fillHeight(-40)).toBe(fillHeight(0));
    expect(fillHeight(900)).toBe(fillHeight(100));
    expect(Number.isFinite(fillHeight(Number.NaN))).toBe(true);
  });

  it('rules the compaction mark across the same scale the fill uses', () => {
    // The mark and the level have to be measured the same way or the one thing
    // the gauge is for — am I near the edge — is a lie.
    for (const pct of [0, 25, 65, 80, 100]) {
      expect(tickHeight(pct) - tickHeight(0)).toBeCloseTo(fillHeight(pct), 6);
    }
    expect(tickHeight(65)).toBeGreaterThan(tickHeight(0));
  });
});
