import { describe, expect, it } from 'vitest';
import { buildScenery } from '@renderer/office/world/scenery';
import { HORIZONS, type Horizon } from '@shared/prefs';

const KINDS = HORIZONS.filter((kind): kind is Exclude<Horizon, 'none'> => kind !== 'none');
const FLOOR = -6;
const SPREAD = 35;

/**
 * Where a landmark stands, in the frame `scenery` writes in.
 *
 * Not the world's: `Distance` puts the whole ring at the campus and turns it,
 * slowly, to follow the camera. So these are measured about nothing, which is
 * exactly what the module builds about.
 */
const radiusOf = (piece: { at: [number, number, number] }): number => Math.hypot(piece.at[0], piece.at[2]);
const bearingOf = (piece: { at: [number, number, number] }): number => Math.atan2(piece.at[0], -piece.at[2]);

/**
 * The void plane the facet shader dissolves against, as `OfficeView` sets it.
 * Anything whose whole body is under this comes out as sky: built, merged,
 * drawn, and invisible — which is exactly what the first three versions of this
 * module did, so it is worth a test rather than an eye.
 */
const VOID_Y = FLOOR - 5.5;
const VOID_FADE = 7.5;

describe('the distance', () => {
  it('builds nothing at all when it is turned off', () => {
    expect(buildScenery('none', 1, FLOOR, SPREAD)).toEqual([]);
  });

  it('is the same archipelago every time you generate it from the same seed', () => {
    for (const kind of KINDS) {
      expect(buildScenery(kind, 7, FLOOR, SPREAD)).toEqual(buildScenery(kind, 7, FLOOR, SPREAD));
    }
  });

  it('is a different one for a different seed', () => {
    for (const kind of KINDS) {
      const shapes = new Set([1, 2, 3, 4, 5].map((seed) => JSON.stringify(buildScenery(kind, seed, FLOOR, SPREAD))));
      expect(shapes.size).toBe(5);
    }
  });

  it('stands clear of the campus, and not so far out that the frame cannot reach it', () => {
    for (const kind of KINDS) {
      for (const piece of buildScenery(kind, 3, FLOOR, SPREAD)) {
        /*
         * A ring, and the radius is the whole of what keeps it in the window.
         *
         * Under this projection a ring draws as an ellipse about as wide as its
         * radius and three-quarters as tall. Tighter than this and it cuts
         * through the office; wider and its sides are past the frame edge. Both
         * have been shipped, and both read as the background being broken
         * rather than as the background being far away.
         */
        expect(radiusOf(piece)).toBeGreaterThan(SPREAD * 1.1);
        expect(radiusOf(piece)).toBeLessThan(SPREAD * 1.8);
      }
    }
  });

  it('keeps every landmark\'s crown above the plane that dissolves into sky', () => {
    /*
     * The *keel* is supposed to trail off into nothing — that is what the fade
     * is good for, and counting pieces punishes a landmark for having a long
     * one. What must not happen is a landmark whose highest point is already
     * sky, which is what three earlier versions of this file shipped: built,
     * merged, drawn, completely invisible.
     */
    for (const kind of KINDS) {
      for (let seed = 1; seed <= 20; seed += 1) {
        const crowns = new Map<string, number>();
        for (const piece of buildScenery(kind, seed, FLOOR, SPREAD)) {
          const at = `${piece.at[0].toFixed(1)},${piece.at[2].toFixed(1)}`;
          crowns.set(at, Math.max(crowns.get(at) ?? -Infinity, piece.at[1] + piece.size[1]));
        }
        for (const crown of crowns.values()) expect(crown).toBeGreaterThan(VOID_Y - VOID_FADE * 0.5);
      }
    }
  });

  it('never rises to the office it is standing behind', () => {
    /*
     * The near arc of the ring is the only arc the frame can see, and it is
     * pushed *down* the window by its distance. A low fragment therefore lands
     * in the void under the keels, where it belongs; a tall one draws a column
     * through the middle of the building. That is not a matter of taste — it is
     * what the projection does — so the ceiling is a test, not a guideline.
     *
     * And the ceiling is under the lowest terrace, not over it: level with the
     * office, a landmark is the same stone at the same size and reads as one
     * more platform that has come adrift.
     */
    for (const kind of KINDS) {
      for (let seed = 1; seed <= 60; seed += 1) {
        for (const piece of buildScenery(kind, seed, FLOOR, SPREAD)) {
          expect(piece.at[1] + piece.size[1]).toBeLessThan(FLOOR);
        }
      }
    }
  });

  it('washes what stands further out further toward the sky, and shrinks it', () => {
    for (const kind of KINDS) {
      const pieces = buildScenery(kind, 11, FLOOR, SPREAD);
      const byRadius = [...pieces].sort(
        (a, b) => Math.hypot(a.at[0], a.at[2]) - Math.hypot(b.at[0], b.at[2]),
      );
      expect(byRadius[0]!.wash).toBeLessThan(byRadius[byRadius.length - 1]!.wash);
      for (const piece of pieces) {
        expect(piece.wash).toBeGreaterThanOrEqual(0);
        expect(piece.wash).toBeLessThanOrEqual(1);
      }
    }
  });

  it('goes all the way round, so no angle is left with an empty sky', () => {
    /*
     * The reason it is a ring at all.
     *
     * An arc has to be pinned to the camera to stay in the window, and anything
     * pinned to the camera does not move when you orbit — which is not distance,
     * it is a sticker on the glass. A ring can afford to turn slowly, because
     * whichever way you face there is more of it coming round; this is the check
     * that there is.
     */
    for (const kind of KINDS) {
      for (let seed = 1; seed <= 20; seed += 1) {
        const quadrants = new Set(
          buildScenery(kind, seed, FLOOR, SPREAD).map((piece) =>
            Math.floor(((bearingOf(piece) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 2)),
          ),
        );
        expect(quadrants.size, `seed ${seed}`).toBe(4);
      }
    }
  });

  it('puts its landmarks somewhere new in every world', () => {
    /*
     * They were seeded and they were identical, which is not a contradiction:
     * the lobes were pinned to the camera's abeam and the index decided the
     * rest, so every world put its first isle on the same bearing and only the
     * jitter moved. Reproducible per seed, indistinguishable between seeds —
     * and the report was the plain one: the isles do not change when the world
     * does.
     */
    const bearings = new Set<string>();
    for (let seed = 1; seed <= 12; seed += 1) {
      const pieces = buildScenery('isles', seed, FLOOR, SPREAD);
      bearings.add(pieces.map((p) => Math.atan2(p.at[0], p.at[2]).toFixed(2)).join(','));
    }
    expect(bearings.size).toBe(12);
  });

  it('turns off the office\'s two axes, so a landmark is not another terrace', () => {
    /*
     * Every box in the campus is square to the same two axes. A landmark that
     * is as well reads as more building, however far off it is painted — the
     * corners agree, and the eye files it with the architecture. A few degrees
     * is enough to break that, and it is the cheapest thing in this module.
     */
    for (const kind of KINDS) {
      for (let seed = 1; seed <= 12; seed += 1) {
        const pieces = buildScenery(kind, seed, FLOOR, SPREAD);
        expect(pieces.every((piece) => Math.abs(piece.yaw) <= 0.8)).toBe(true);
        // Most of them, not all: an isle that happens to draw a yaw near zero
        // is one island square to the grid, which is scenery too.
        const turned = pieces.filter((piece) => Math.abs(piece.yaw) > 0.05).length;
        expect(turned / pieces.length, `seed ${seed}`).toBeGreaterThan(0.6);
        const mean = pieces.reduce((sum, piece) => sum + Math.abs(piece.yaw), 0) / pieces.length;
        expect(mean, `seed ${seed}`).toBeGreaterThan(0.1);
      }
    }
  });
});
