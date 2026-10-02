import { describe, expect, it } from 'vitest';
import { buildCampus, type DeskRequest } from '@renderer/office/world/layout';
import { spiralShape, WALK } from '@renderer/office/world/spiral';
import { CAMPUS, MAX_FLIGHT, levelY } from '@renderer/office/world/campusTemplate';
import { NavGraph, pathLength, pointAlong } from '@renderer/office/world/navGraph';

function desks(count: number): DeskRequest[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `slot-${i}`,
    label: `session ${i}`,
    colorIndex: i % 12,
    seats: 1,
  }));
}

function overlaps(a: { position: [number, number]; size: [number, number] }, b: typeof a): boolean {
  const ax = Math.abs(a.position[0] - b.position[0]);
  const az = Math.abs(a.position[1] - b.position[1]);
  return ax < (a.size[0] + b.size[0]) / 2 && az < (a.size[1] + b.size[1]) / 2;
}

describe('office layout', () => {
  it('keeps every platform clear of every other one', () => {
    const campus = buildCampus(desks(14));
    for (let i = 0; i < campus.platforms.length; i++) {
      for (let j = i + 1; j < campus.platforms.length; j++) {
        const a = campus.platforms[i]!;
        const b = campus.platforms[j]!;
        expect(overlaps(a, b), `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });

  it('never stands two floors on the same ground, at any seed or any size', () => {
    /*
     * The seeded worlds are the ones that stack, and the check above only ever
     * saw seed zero, which does not. A raised deck standing *on* its host is
     * the one legitimate overlap — and only if it clears the host by a storey,
     * or the pair reads as two platforms fighting over one cell.
     */
    for (let seed = 1; seed <= 12; seed += 1) {
      for (const count of [1, 4, 9, 16]) {
        const campus = buildCampus(desks(count), new Map(), seed, 'ornate');
        for (let i = 0; i < campus.platforms.length; i++) {
          for (let j = i + 1; j < campus.platforms.length; j++) {
            const a = campus.platforms[i]!;
            const b = campus.platforms[j]!;
            if (!overlaps(a, b)) continue;
            const where = `seed ${seed}, ${count} desks: ${a.id} over ${b.id}`;
            expect(a.over === b.id || b.over === a.id, where).toBe(true);
            expect(Math.abs(levelY(a.level) - levelY(b.level)), where).toBeGreaterThan(1.2);
          }
        }
      }
    }
  });

  it('walks a spiral up its own treads', () => {
    /*
     * The geometry and the route used to be worked out separately, and what
     * that drew was every figure walking through the newel and out the other
     * side. Both now ask `spiral.ts` for the same curve, and this is the check
     * that they are still asking — a via point off the helix is a figure in
     * mid air, and one at the wrong radius is a figure beside the treads.
     */
    let spirals = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      for (const count of [1, 6, 14]) {
        const campus = buildCampus(desks(count), new Map(), seed, 'ornate');
        for (const connector of campus.connectors) {
          if (connector.style !== 'spiral') continue;
          spirals += 1;
          const shape = spiralShape(connector);
          expect(connector.via, `${connector.id} has no route over itself`).toBeDefined();
          const low = Math.min(connector.a[1], connector.b[1]);
          const high = Math.max(connector.a[1], connector.b[1]);
          for (const point of connector.via ?? []) {
            const radius = Math.hypot(point[0] - shape.midX, point[2] - shape.midZ);
            expect(radius, `${connector.id}: off the treads`).toBeCloseTo(shape.reach * WALK, 5);
            expect(point[1]).toBeGreaterThanOrEqual(low - 1e-6);
            expect(point[1]).toBeLessThanOrEqual(high + 1e-6);
          }
          // And it climbs the way it is walked, a to b, rather than always up.
          const via = connector.via ?? [];
          const first = via[0]?.[1] ?? 0;
          const last = via[via.length - 1]?.[1] ?? 0;
          expect(Math.sign(last - first)).toBe(Math.sign(connector.b[1] - connector.a[1]));
        }
      }
    }
    expect(spirals, 'no spirals in any world to check').toBeGreaterThan(20);
  });

  it('never crosses one walkway through another', () => {
    /*
     * Every adjacent pair of platforms gets a walkway, and two gaps that cross
     * used to give two flights of stairs interleaved at the same height. See
     * `pruneCrossings`.
     */
    for (let seed = 1; seed <= 12; seed += 1) {
      for (const count of [1, 6, 14]) {
        const campus = buildCampus(desks(count), new Map(), seed, 'ornate');
        const walkways = campus.connectors;
        for (let i = 0; i < walkways.length; i++) {
          for (let j = i + 1; j < walkways.length; j++) {
            const a = walkways[i]!;
            const b = walkways[j]!;
            if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue;
            const flat = (c: (typeof walkways)[number]): [number, number, number, number] => {
              const half = c.width / 2;
              const padX = c.axis === 'x' ? 0 : half;
              const padZ = c.axis === 'x' ? half : 0;
              return [
                Math.min(c.a[0], c.b[0]) - padX,
                Math.max(c.a[0], c.b[0]) + padX,
                Math.min(c.a[2], c.b[2]) - padZ,
                Math.max(c.a[2], c.b[2]) + padZ,
              ];
            };
            const [aMinX, aMaxX, aMinZ, aMaxZ] = flat(a);
            const [bMinX, bMaxX, bMinZ, bMaxZ] = flat(b);
            const sharesFloor = aMaxX > bMinX && bMaxX > aMinX && aMaxZ > bMinZ && bMaxZ > aMinZ;
            if (!sharesFloor) continue;
            // Allowed only with a storey of headroom between them.
            const aLow = Math.min(a.a[1], a.b[1]);
            const aHigh = Math.max(a.a[1], a.b[1]);
            const bLow = Math.min(b.a[1], b.b[1]);
            const bHigh = Math.max(b.a[1], b.b[1]);
            expect(aHigh + 1.4 <= bLow || bHigh + 1.4 <= aLow, `seed ${seed}: ${a.id} crosses ${b.id}`).toBe(true);
          }
        }
      }
    }
  });

  it('is deterministic: the same sessions produce the same floor plan', () => {
    const first = buildCampus(desks(8));
    const second = buildCampus(desks(8));
    expect(second.platforms.map((p) => [p.id, p.position, p.level])).toEqual(
      first.platforms.map((p) => [p.id, p.position, p.level]),
    );
  });

  it('remembers a desk position, so the office never reshuffles under you', () => {
    const assigned = new Map<string, [number, number]>();
    const before = buildCampus(desks(3), assigned);
    // A fourth session arrives; the first three must not move.
    const after = buildCampus(desks(4), assigned);

    for (const platform of before.platforms.filter((p) => p.kind === 'desk')) {
      const moved = after.platforms.find((p) => p.id === platform.id);
      expect(moved?.position).toEqual(platform.position);
    }
  });

  it('includes every shared zone, whatever is going on', () => {
    const campus = buildCampus([]);
    for (const zone of CAMPUS) {
      expect(campus.platforms.some((p) => p.id === `zone:${zone.id}`)).toBe(true);
    }
  });

  it('never runs a walkway across a third platform', () => {
    const campus = buildCampus(desks(10));
    for (const connector of campus.connectors) {
      for (const platform of campus.platforms) {
        if (platform.id === connector.from || platform.id === connector.to) continue;
        for (let t = 0.1; t < 0.95; t += 0.1) {
          const x = connector.a[0] + (connector.b[0] - connector.a[0]) * t;
          const z = connector.a[2] + (connector.b[2] - connector.a[2]) * t;
          const insideX = Math.abs(x - platform.position[0]) < platform.size[0] / 2;
          const insideZ = Math.abs(z - platform.position[1]) < platform.size[1] / 2;
          expect(insideX && insideZ, `${connector.id} crosses ${platform.id}`).toBe(false);
        }
      }
    }
  });

  it('routes between platforms rather than teleporting', () => {
    const campus = buildCampus(desks(6));
    const nav = new NavGraph(campus);
    const lounge = campus.platforms.find((p) => p.id === 'zone:lounge')!;
    const library = campus.platforms.find((p) => p.id === 'zone:library')!;

    const path = nav.path(
      lounge.id,
      [lounge.position[0], 0, lounge.position[1]],
      library.id,
      [library.position[0], 0, library.position[1]],
    );
    expect(path.length).toBeGreaterThan(2);
    expect(pathLength(path)).toBeGreaterThan(0);

    // The route ends where it was asked to end.
    const end = pointAlong(path, pathLength(path));
    expect(end.position[0]).toBeCloseTo(library.position[0], 3);
    expect(end.position[2]).toBeCloseTo(library.position[1], 3);
  });

  it('walks a straight line inside one platform', () => {
    const campus = buildCampus(desks(2));
    const nav = new NavGraph(campus);
    const path = nav.path('zone:lounge', [0, 0, 0], 'zone:lounge', [2, 0, 2]);
    expect(path).toHaveLength(2);
  });

  /**
   * One walkway each is not enough, and checking only that is what let two
   * desks hang off each other in mid-air with no way back to the campus. What
   * matters is that the whole thing is one place you can walk across.
   */
  it('is one connected campus, however it is terraced', () => {
    for (const seed of [0, 1, 97, 8919, 40503, 123456]) {
      const campus = buildCampus(desks(12), new Map(), seed);
      const neighbours = new Map<string, string[]>();
      for (const connector of campus.connectors) {
        neighbours.set(connector.from, [...(neighbours.get(connector.from) ?? []), connector.to]);
        neighbours.set(connector.to, [...(neighbours.get(connector.to) ?? []), connector.from]);
      }

      const seen = new Set<string>([campus.platforms[0]!.id]);
      const queue = [campus.platforms[0]!.id];
      while (queue.length > 0) {
        for (const next of neighbours.get(queue.shift()!) ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }

      for (const platform of campus.platforms) {
        expect(seen.has(platform.id), `seed ${seed}: ${platform.id} cannot be walked to`).toBe(true);
      }
    }
  });

  /**
   * A walkway may climb two levels, and the flight that does it is built as a
   * grand stair. Three is not a stair, it is a cliff with treads drawn on it —
   * and `settleSlopes` exists to make sure it never happens.
   */
  it('never terraces two joined platforms beyond a single flight', () => {
    for (const seed of [0, 1, 97, 8919, 40503, 123456]) {
      const campus = buildCampus(desks(12), new Map(), seed);
      const byId = new Map(campus.platforms.map((p) => [p.id, p]));
      for (const connector of campus.connectors) {
        const drop = Math.abs(byId.get(connector.from)!.level - byId.get(connector.to)!.level);
        expect(drop, `seed ${seed}: ${connector.id}`).toBeLessThanOrEqual(MAX_FLIGHT);
      }
    }
  });

  /**
   * Desks are the exception. They are placed against whatever they can reach,
   * and a desk hung two levels off its host is a desk at the top of a stair
   * that is most of the platform it stands on.
   */
  it('never puts a desk more than one storey from the platform it hangs off', () => {
    for (const seed of [0, 1, 97, 8919, 40503, 123456]) {
      const campus = buildCampus(desks(12), new Map(), seed);
      const byId = new Map(campus.platforms.map((p) => [p.id, p]));
      for (const connector of campus.connectors) {
        const a = byId.get(connector.from)!;
        const b = byId.get(connector.to)!;
        if (a.kind !== 'desk' && b.kind !== 'desk') continue;
        // A desk built *on top of* a platform is two levels above it by
        // design, and reached by its own flight down onto the host's deck.
        // The rule is about desks hung off the side of the campus, which have
        // to be a single step from the thing they hang off.
        if (a.over || b.over) continue;
        expect(Math.abs(a.level - b.level), `seed ${seed}: ${connector.id}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('spreads desks over several levels, so the ring is not a flat disc', () => {
    const campus = buildCampus(desks(12));
    const levels = new Set(campus.platforms.filter((p) => p.kind === 'desk').map((p) => p.level));
    expect(levels.size).toBeGreaterThan(1);
  });
});
