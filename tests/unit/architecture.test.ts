import { describe, expect, it } from 'vitest';
import { archBlockers, campusArchGeometry, lowestFloor, planArchitecture, type Piece } from '@renderer/office/world/architecture';
import { buildCampus, walkwaySpan, type DeskRequest } from '@renderer/office/world/layout';
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
    expect(b.favoured).toEqual(a.favoured);
    expect(b.detached).toEqual(a.detached);
  });

  it('is a different building for a different seed', () => {
    const campus = buildCampus(desks(4), new Map(), 1);
    const shapes = new Set(SEEDS.map((seed) => JSON.stringify([...planArchitecture(campus, seed).onPlatform])));
    // Every world draws its own favourites out of the whole bank, and the
    // placement varies within that: if this collapses, every world is the same
    // world and the generator is decorative.
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
        const carried = held(pieces);

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
          /*
           * Or standing on another platform, which an aqueduct's pool does.
           *
           * Water that lands is the one gesture here that belongs to two
           * terraces: the channel is built on its own platform's list and the
           * pool it makes is on the deck below, so from the source platform's
           * point of view it is a box out past the rim at a height nothing in
           * that platform's own piece list supports. The deck under it is what
           * supports it.
           */
          const worldX = platform.position[0] + box.x;
          const worldZ = platform.position[1] + box.z;
          const worldBase = levelY(platform.level) + box.base;
          const onAnother = campus.platforms.some(
            (other) =>
              other.id !== platform.id &&
              Math.abs(worldX - other.position[0]) <= other.size[0] / 2 &&
              Math.abs(worldZ - other.position[1]) <= other.size[1] / 2 &&
              Math.abs(levelY(other.level) - worldBase) < 0.3,
          );
          if (onAnother) continue;
          expect(
            carried.has(piece),
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
  return sits(under, over) && under.base < -0.5;
}

/** Is `under` directly beneath `over` and close enough to be carrying it? */
function sits(under: Extent, over: Extent): boolean {
  const overlaps =
    Math.abs(under.x - over.x) < under.halfX + over.halfX &&
    Math.abs(under.z - over.z) < under.halfZ + over.halfZ;
  return overlaps && under.base < over.base && under.top >= over.base - 0.4;
}

/**
 * Everything out past the rim that something is holding up, directly or not.
 *
 * One level of "is there something under it" is not enough, and the aqueduct is
 * why: its channel rests in a stone trough, which rests on the bays, which rest
 * on the legs, and only the legs reach down past the deck. Asking each piece
 * for a single supporter that hangs below the platform called the water in the
 * channel unsupported — correctly, by that rule, and wrongly about the office.
 *
 * So: start from whatever hangs, and keep adding anything resting on what is
 * already held. What is left over at the end is genuinely in mid air.
 */
function held(pieces: readonly Piece[]): Set<Piece> {
  const boxes = pieces.map((piece) => ({ piece, box: boxOf(piece) }));
  const out = new Set<Piece>();
  for (const { piece, box } of boxes) if (box.base < -0.5) out.add(piece);
  for (let pass = 0; pass < 6; pass += 1) {
    let grew = false;
    for (const over of boxes) {
      if (out.has(over.piece)) continue;
      for (const under of boxes) {
        if (under.piece === over.piece || !out.has(under.piece)) continue;
        if (!sits(under.box, over.box)) continue;
        out.add(over.piece);
        grew = true;
        break;
      }
    }
    if (!grew) break;
  }
  return out;
}

describe('what every world is given', () => {
  it('builds a waterfall and a drape whatever dialect it speaks', () => {
    // A dialect is three motifs out of thirteen, chosen once from the seed and
    // kept for ever — so anything outside it is not rare in a given world, it
    // is absent from it permanently. Water and cloth are the two worth having
    // everywhere: the only moving thing in the kit, and the only thing that
    // bends. Both get first refusal on a platform before the budget rolls.
    for (let seed = 1; seed <= 40; seed += 1) {
      for (const detail of ['quiet', 'ornate'] as const) {
        const campus = buildCampus(desks(5), new Map(), seed, detail);
        const built = new Set(planArchitecture(campus, seed, detail).motifs.values());
        expect(built, `seed ${seed} / ${detail}`).toContain('waterfall');
        expect(built, `seed ${seed} / ${detail}`).toContain('drape');
      }
    }
  });

  it('stands every post on the floor it is meant to be standing on', () => {
    /*
     * A band may straddle a rim; a post may not.
     *
     * `f.fit` lets a thin piece overhang where the walkable ring cannot hold
     * it, which is right for a balustrade — it runs the length of the edge, a
     * sliver of it is on the deck, and it reads as attached. Applied to a
     * *point* it is the bug: a lamp post 0.2 across came out with eight
     * millimetres of itself over the terrace and the rest over the drop, and
     * in an isometric view its foot lands on the platform's silhouette, where
     * there is nothing to say it is standing on anything. The whole office
     * grew a crop of floating pins.
     *
     * A quarter of its own width is the allowance: enough for a dome's skirt
     * or a minaret's flank to kiss the edge, nowhere near enough to hang one.
     */
    for (let seed = 1; seed <= 24; seed += 1) {
      const campus = buildCampus(desks(8), new Map(), seed, 'ornate');
      const plan = planArchitecture(campus, seed, 'ornate');
      for (const [id, pieces] of plan.onPlatform) {
        const platform = campus.platforms.find((entry) => entry.id === id)!;
        for (const piece of pieces) {
          if (piece.shape !== 'column') continue;
          const [blocker] = archBlockers([piece]);
          if (!blocker) continue;
          const over = Math.max(
            Math.abs(blocker.x) + blocker.halfWidth - platform.size[0] / 2,
            Math.abs(blocker.z) + blocker.halfDepth - platform.size[1] / 2,
          );
          expect(over, `seed ${seed} / ${id} / ${plan.motifs.get(id) ?? 'accent'}`).toBeLessThan(
            blocker.halfWidth / 2,
          );
        }
      }
    }
  });

  it('ends every keel inside the fog, so nothing has a bottom you can see', () => {
    /*
     * The third separate bug to ship as "there is something hanging under the
     * platforms", and the first two were a colour-space mismatch and a fade
     * that was aimed at the wrong sky. This one was arithmetic: the course
     * heights were shares of a sum, and the divisor summed one..steps where
     * the numerators summed nought..steps-1, so every keel came out about four
     * fifths as long as it meant to be and stopped a couple of units *above*
     * the plane the fog finishes on. What you see then is a grey block with a
     * hard flat bottom under every room in the office.
     *
     * Where the rock ends is not something to eyeball — it is below the fade,
     * so by definition you are looking for something that should be invisible.
     */
    for (let seed = 1; seed <= 12; seed += 1) {
      const campus = buildCampus(desks(8), new Map(), seed, 'ornate');
      const plan = planArchitecture(campus, seed, 'ornate');
      const floor = lowestFloor(campus);
      // `OfficeView` sets the void plane to floor - 5.5 and fades it over 7.5.
      const vanished = floor - 13;
      for (const [id, pieces] of plan.onPlatform) {
        const platform = campus.platforms.find((entry) => entry.id === id)!;
        if (platform.over) continue;
        /*
         * The keel, and only the keel: a box under the deck that the
         * platform's own centre line passes through. A ghat hangs off a rim
         * and a waterfall spills past one, and both are *meant* to stop where
         * they stop; the rock is the one thing that has to reach the fog.
         */
        let low = Infinity;
        for (const piece of pieces) {
          if (piece.shape !== 'box') continue;
          if (piece.at[1] >= -0.4 || piece.tone !== 'stone') continue;
          // Under the platform's own footprint. The rock leans as it descends,
          // so a deep course need not straddle the centre line any more; what
          // it may not do is wander out past the rim, which is where a ghat
          // and a waterfall live.
          if (Math.abs(piece.at[0]) > platform.size[0] / 2 || Math.abs(piece.at[2]) > platform.size[1] / 2) continue;
          low = Math.min(low, levelY(platform.level) + piece.at[1]);
        }
        // A platform standing on nothing is the point of `rockKind: 'none'`.
        if (low === Infinity) continue;
        expect(low, `seed ${seed} / ${id}`).toBeLessThan(vanished);
      }
    }
  });

  it('never builds anything into a walkway', () => {
    /*
     * A building is planned per platform and a walkway between two of them, and
     * nothing used to compare the two. A canopy beam or a cornice is allowed to
     * oversail its rim, and what it oversails is the gap a flight of stairs
     * climbs — so the office drew staircases passing through walls.
     *
     * Measured against what each walkway *occupies*, which for a spiral is the
     * disc its treads sweep and not the line between its two ends.
     */
    for (const seed of SEEDS) {
      for (const count of [1, 6, 14]) {
        const campus = buildCampus(desks(count), new Map(), seed, 'ornate');
        const ways = campus.connectors.map(walkwaySpan);
        const plan = planArchitecture(campus, seed, 'ornate');
        const byId = new Map(campus.platforms.map((platform) => [platform.id, platform]));

        for (const [platformId, pieces] of plan.onPlatform) {
          const platform = byId.get(platformId);
          if (!platform) continue;
          const base = levelY(platform.level);
          for (const blocker of archBlockers(pieces)) {
            const minX = blocker.x + platform.position[0] - blocker.halfWidth;
            const maxX = blocker.x + platform.position[0] + blocker.halfWidth;
            const minZ = blocker.z + platform.position[1] - blocker.halfDepth;
            const maxZ = blocker.z + platform.position[1] + blocker.halfDepth;
            for (const way of ways) {
              // Touching at a rim is a landing meeting a floor, not a clash.
              if (Math.min(maxX, way.maxX) - Math.max(minX, way.minX) <= 0.2) continue;
              if (Math.min(maxZ, way.maxZ) - Math.max(minZ, way.minZ) <= 0.2) continue;
              if (blocker.top + base <= way.minY + 0.1) continue;
              if (blocker.base + base >= way.maxY + 1.9) continue;
              throw new Error(
                `seed ${seed} / ${count} desks: ${platformId} builds into a walkway at ` +
                  `x ${minX.toFixed(2)}..${maxX.toFixed(2)}, z ${minZ.toFixed(2)}..${maxZ.toFixed(2)}`,
              );
            }
          }
        }
      }
    }
  });

  it('never leaves a stream of water ending in a straight line', () => {
    /*
     * Water goes somewhere, and there are only two somewheres.
     *
     * An aqueduct used to tip one box fifteen units long off its end: it passed
     * through whatever was under it and then simply stopped, in mid air, on a
     * horizontal edge — the one silhouette falling water must never have. Now
     * it either lands on a deck and spreads into a pool, or it keeps going and
     * dissolves into the sky the way the waterfalls do. This checks that every
     * stream in every world does one of the two.
     */
    for (const seed of SEEDS) {
      for (const count of [2, 6, 14]) {
        const campus = buildCampus(desks(count), new Map(), seed, 'ornate');
        const plan = planArchitecture(campus, seed, 'ornate');

        for (const [platformId, motif] of plan.motifs) {
          // Aqueducts only. A waterfall's three sheets wander apart as they
          // fall, so they are several streams rather than one, and they have
          // had their own ending for several rounds.
          if (motif !== 'aqueduct') continue;
          const pieces = plan.onPlatform.get(platformId) ?? [];
          const platform = campus.platforms.find((candidate) => candidate.id === platformId);
          if (!platform) continue;
          const base = levelY(platform.level);

          let low = Infinity;
          let fade = 0;
          let pooled = false;
          for (const piece of pieces) {
            if (piece.shape !== 'box' || piece.tone !== 'water') continue;
            // A trough and a pool are both near-flat; a fall is not.
            if (piece.size[1] < 0.3) {
              // The trough sits at deck height; a pool is the only flat water
              // that has gone down to meet something.
              if (piece.at[1] < -1) pooled = true;
              continue;
            }
            if (piece.at[1] < low) {
              low = piece.at[1];
              fade = piece.fade ?? 0;
            }
          }
          if (low === Infinity) continue;

          const gone = base + low < lowestFloor(campus) - 12;
          expect(
            pooled || gone || fade >= 0.85,
            `seed ${seed}/${count}: ${platformId} spills water that ends at ${low.toFixed(1)} ` +
              `with fade ${fade.toFixed(2)} and no pool`,
          ).toBe(true);
        }
      }
    }
  });

  it('still leaves most of a world to its own taste', () => {
    // The mandate is two platforms. If it ever became the majority of what a
    // world builds, every world would look the same and the weights would be
    // decoration — which is the failure mode this is one step away from.
    let mandated = 0;
    let total = 0;
    for (let seed = 1; seed <= 30; seed += 1) {
      const campus = buildCampus(desks(6), new Map(), seed, 'ornate');
      for (const motif of planArchitecture(campus, seed, 'ornate').motifs.values()) {
        total += 1;
        if (motif === 'waterfall' || motif === 'drape') mandated += 1;
      }
    }
    expect(total).toBeGreaterThan(30);
    expect(mandated / total).toBeLessThan(0.6);
  });
});
