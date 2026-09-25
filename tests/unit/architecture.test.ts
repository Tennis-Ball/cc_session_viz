import { describe, expect, it } from 'vitest';
import { archBlockers, campusArchGeometry, planArchitecture, type Piece } from '@renderer/office/world/architecture';
import { buildCampus, type DeskRequest } from '@renderer/office/world/layout';
import { buildOccupancy } from '@renderer/office/world/occupancy';
import { buildPropFor, propPalette } from '@renderer/office/props/registry';
import { NavGraph } from '@renderer/office/world/navGraph';
import { resolveTheme } from '@renderer/office/theme/themes';
import { levelY, MAX_FLIGHT } from '@renderer/office/world/campusTemplate';
import type { Occupancy } from '@renderer/office/world/occupancy';

const THEME = resolveTheme('monument', 1);

/**
 * Enough seeds to catch a motif that only occasionally walls a platform in.
 * A generator you only ever see one output of is a generator you have not
 * tested: the bug is always in the world you did not look at.
 */
const SEEDS = Array.from({ length: 24 }, (_, i) => 1000 + i * 7919);

function desks(count: number): DeskRequest[] {
  return Array.from({ length: count }, (_, i) => ({ id: `s${i}`, label: `s${i}`, colorIndex: i, seats: 1 }));
}

function doorwaysOf(campus: ReturnType<typeof buildCampus>): Map<string, [number, number][]> {
  const doorways = new Map<string, [number, number][]>();
  for (const connector of campus.connectors) {
    doorways.set(connector.from, [...(doorways.get(connector.from) ?? []), [connector.a[0], connector.a[2]]]);
    doorways.set(connector.to, [...(doorways.get(connector.to) ?? []), [connector.b[0], connector.b[2]]]);
  }
  return doorways;
}

function gridsOf(campus: ReturnType<typeof buildCampus>, seed: number): Map<string, Occupancy> {
  const plan = planArchitecture(campus, seed);
  const doorways = doorwaysOf(campus);
  const grids = new Map<string, Occupancy>();
  for (const platform of campus.platforms) {
    const prop = buildPropFor(platform, propPalette(THEME, platform));
    grids.set(
      platform.id,
      buildOccupancy(
        platform,
        prop?.geometry ?? null,
        doorways.get(platform.id) ?? [],
        archBlockers(plan.onPlatform.get(platform.id) ?? []),
      ),
    );
  }
  return grids;
}

describe('architecture', () => {
  it('is the same building every time you generate it from the same seed', () => {
    const campus = buildCampus(desks(4), new Map(), 4242);
    const a = planArchitecture(campus, 4242);
    const b = planArchitecture(campus, 4242);
    expect(JSON.stringify([...b.onPlatform])).toBe(JSON.stringify([...a.onPlatform]));
    expect(b.dialect).toBe(a.dialect);
    expect(b.detached).toEqual(a.detached);
  });

  it('is a different building for a different seed', () => {
    const campus = buildCampus(desks(4), new Map(), 1);
    const shapes = new Set(SEEDS.map((seed) => JSON.stringify([...planArchitecture(campus, seed).onPlatform])));
    // Six dialects, and the placement varies within each: if this collapses,
    // every world is the same world and the generator is decorative.
    expect(shapes.size).toBeGreaterThan(SEEDS.length / 2);
  });

  it('never builds across a doorway', () => {
    for (const seed of SEEDS) {
      const campus = buildCampus(desks(6), new Map(), seed);
      const grids = gridsOf(campus, seed);
      for (const connector of campus.connectors) {
        for (const [platformId, point] of [
          [connector.from, connector.a],
          [connector.to, connector.b],
        ] as const) {
          const grid = grids.get(platformId);
          if (!grid) continue;
          expect(grid.isFree(point[0], point[2]), `seed ${seed}: ${connector.id} blocked at ${platformId}`).toBe(true);
        }
      }
    }
  });

  it('leaves a way from every door to every seat, whatever it built', () => {
    for (const seed of SEEDS) {
      const campus = buildCampus(desks(6), new Map(), seed);
      const plan = planArchitecture(campus, seed);
      const doorways = doorwaysOf(campus);

      for (const platform of campus.platforms) {
        const prop = buildPropFor(platform, propPalette(THEME, platform));
        const doors = doorways.get(platform.id) ?? [];
        const grid = buildOccupancy(
          platform,
          prop?.geometry ?? null,
          doors,
          archBlockers(plan.onPlatform.get(platform.id) ?? []),
        );

        const spots: [number, number][] = [
          ...doors,
          ...(prop?.slots ?? []).map(
            (slot) =>
              [platform.position[0] + slot.position[0], platform.position[1] + slot.position[2]] as [number, number],
          ),
        ].map(([x, z]) => grid.nearestFree(x, z));

        for (const from of spots) {
          for (const to of spots) {
            for (const [a, b] of legs(grid.route(from, to))) {
              const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.15));
              for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const x = a[0] + (b[0] - a[0]) * t;
                const z = a[1] + (b[1] - a[1]) * t;
                expect(
                  grid.isFree(x, z),
                  `seed ${seed}, ${platform.id}: clips at ${x.toFixed(2)}, ${z.toFixed(2)}`,
                ).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  it('keeps every platform reachable however the world is terraced', () => {
    for (const seed of SEEDS) {
      const campus = buildCampus(desks(6), new Map(), seed);
      const nav = new NavGraph(campus, gridsOf(campus, seed));
      const [first, ...rest] = campus.platforms;
      expect(first).toBeDefined();

      for (const platform of rest) {
        const start = nav.standable(first!.id, [first!.position[0], levelY(first!.level), first!.position[1]]);
        const end = nav.standable(platform.id, [platform.position[0], levelY(platform.level), platform.position[1]]);
        const route = nav.path(first!.id, start, platform.id, end);
        // A route of exactly two points between two different platforms is the
        // straight-line fallback: it means no walkway was found and the figure
        // would fly there.
        expect(route.length, `seed ${seed}: ${first!.id} → ${platform.id} has no walked route`).toBeGreaterThan(2);
      }
    }
  });

  it('never terraces two connected platforms beyond a single flight', () => {
    for (const seed of SEEDS) {
      const campus = buildCampus(desks(6), new Map(), seed);
      const byId = new Map(campus.platforms.map((p) => [p.id, p]));
      for (const connector of campus.connectors) {
        const a = byId.get(connector.from)!;
        const b = byId.get(connector.to)!;
        expect(Math.abs(a.level - b.level), `seed ${seed}: ${connector.id}`).toBeLessThanOrEqual(MAX_FLIGHT);
      }
    }
  });

  /**
   * Nothing is built standing in the air beside a terrace.
   *
   * A piece may hang *off* a rim — a ghat steps down off one, a waterfall
   * falls from one — and those are supported by the mass they come out of. A
   * piece out past the rim at deck height is supported by nothing, and that is
   * what a dome three units across looked like for a whole pass: a balloon
   * moored next to the office. It went unnoticed because the escape hatch that
   * put it there is shared with the balustrades, where the same arithmetic
   * leaves a gap too small to see.
   */
  it('never leaves a piece standing in mid air beside a platform', () => {
    for (const seed of SEEDS) {
      const campus = buildCampus(desks(6), new Map(), seed);
      const plan = planArchitecture(campus, seed);

      for (const platform of campus.platforms) {
        const [halfWidth, halfDepth] = [platform.size[0] / 2, platform.size[1] / 2];
        const pieces = plan.onPlatform.get(platform.id) ?? [];

        for (const piece of pieces) {
          const box = boxOf(piece);
          // How far the piece's nearest edge is beyond the rim, on the axis it
          // sticks out along. Negative means it is over the platform.
          const past = Math.max(
            Math.abs(box.x) - box.halfX - halfWidth,
            Math.abs(box.z) - box.halfZ - halfDepth,
          );
          if (past <= 0.2) continue;
          // Out over the drop. Two things out there are fine: something that
          // *hangs* — a ghat step, a waterfall, an aqueduct's leg, all of
          // which reach down past the deck — and something standing on one of
          // those. What is not fine is a piece sitting at deck height with
          // clear sky above and below it, which is what a dome parked beside a
          // terrace was doing.
          if (box.top <= 0.05 || box.base < -0.5) continue;
          expect(
            pieces.some((other) => other !== piece && reachesDown(boxOf(other), box)),
            `seed ${seed}: ${platform.id} has a ${piece.shape} ${past.toFixed(2)} past the rim with nothing under it`,
          ).toBe(true);
        }
      }
    }
  });

  it('builds geometry for every world without a merge failing', () => {
    for (const seed of SEEDS) {
      const campus = buildCampus(desks(6), new Map(), seed);
      const plan = planArchitecture(campus, seed);
      const geometry = campusArchGeometry(campus, plan, THEME);
      expect(geometry, `seed ${seed}`).not.toBeNull();
      // The facet shader reads all three; a part missing one turns the whole
      // merge into null and takes the office's floor with it.
      for (const attribute of ['position', 'color', 'aGrad', 'aEmissive']) {
        expect(geometry!.getAttribute(attribute), `seed ${seed}: ${attribute}`).toBeDefined();
      }
    }
  });
});

function legs(points: [number, number][]): [[number, number], [number, number]][] {
  const out: [[number, number], [number, number]][] = [];
  for (let i = 1; i < points.length; i++) out.push([points[i - 1]!, points[i]!]);
  return out;
}


interface Extent {
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  base: number;
  top: number;
}

/** A piece's axis-aligned bounding box, in its platform's local coordinates. */
function boxOf(piece: Piece): Extent {
  if (piece.shape === 'box') {
    const yaw = piece.rotY ?? 0;
    const cos = Math.abs(Math.cos(yaw));
    const sin = Math.abs(Math.sin(yaw));
    return {
      x: piece.at[0],
      z: piece.at[2],
      halfX: (piece.size[0] * cos + piece.size[2] * sin) / 2,
      halfZ: (piece.size[0] * sin + piece.size[2] * cos) / 2,
      base: piece.at[1],
      top: piece.at[1] + piece.size[1],
    };
  }
  if (piece.shape === 'column') {
    const radius = Math.max(piece.radius, piece.radius * (piece.taper ?? 1));
    return {
      x: piece.at[0],
      z: piece.at[2],
      halfX: radius,
      halfZ: radius,
      base: piece.at[1],
      top: piece.at[1] + piece.height,
    };
  }
  return {
    x: piece.at[0],
    z: piece.at[2],
    halfX: piece.turned ? piece.tube : piece.radius + piece.tube,
    halfZ: piece.turned ? piece.radius + piece.tube : piece.tube,
    base: piece.at[1],
    top: piece.at[1] + piece.radius + piece.tube,
  };
}

/**
 * Is there something below `over` that goes all the way down?
 *
 * Deliberately not "is this the piece holding that one up". An aqueduct is a
 * deck on a channel on a pier, and chasing the chain link by link means every
 * new piece of scenery has to be modelled as a load path. The question worth
 * asking is cruder and catches the bug that keeps happening: does *anything*
 * at this spot reach down past the terrace's own floor. A pier does. A dome
 * moored in the sky does not.
 */
function reachesDown(under: Extent, over: Extent): boolean {
  const overlaps =
    Math.abs(under.x - over.x) < under.halfX + over.halfX &&
    Math.abs(under.z - over.z) < under.halfZ + over.halfZ;
  return overlaps && under.base < -0.5 && under.top >= over.base - 0.4;
}
