import { archBlockers, type ArchPlan } from '../world/architecture';
import { levelY, PLATFORM_THICKNESS } from '../world/campusTemplate';
import type { Campus } from '../world/layout';
import type { Perch } from './birdFlight';

/**
 * Where a bird can sit.
 *
 * Read off the architecture plan rather than authored: the tops of columns and
 * the crowns of arches are already the highest, most isolated points the office
 * builds, which is exactly where a bird would go. Taking them from the plan
 * also means a world that builds no towers simply has fewer perches, with
 * nothing to keep in step by hand.
 *
 * The first version stopped there, and it was wrong in a way that is obvious
 * the moment you see it: *the top of a column is not the top of the building*.
 * A colonnade has an entablature over it, a pavilion has a roof, an arcade has
 * a course along its crown — and of a hundred and fifty tall columns and big
 * arches across twenty worlds, all but three had something directly above
 * them. Half the flock was sitting inside the thing its perch was holding up.
 *
 * Merely rejecting those leaves a campus with no birds on it. So a column is
 * not the perch, it is the *place*: the perch is the highest surface standing
 * over that spot, whatever that turns out to be. A bird lands on the cornice
 * the pillars carry, on the ridge of the roof, on the cap of the tower — which
 * is both where a bird would actually go and the thing that was being asked
 * for. The columns remain the right places to look because they are the
 * distinctive, isolated, well-spaced ones.
 */

/** How much room a bird wants over its head before it will sit down. */
const HEADROOM = 0.7;
/** Ignore anything that starts this far above: it is somebody else's storey. */
const CEILING = 6;
/** Below this above its own floor, a perch is furniture rather than a lookout. */
const MIN_HEIGHT = 1.9;
/** Two perches closer than this are one perch. */
const APART = 0.9;
/** Widest a thing can be in plan and still be something to perch *on*. */
const NARROW = 2.2;

export function perchesFor(campus: Campus, plan: ArchPlan): Perch[] {
  const out: Perch[] = [];
  const byId = new Map(campus.platforms.map((platform) => [platform.id, platform]));

  /*
   * Everything standing anywhere on the campus, in world coordinates.
   *
   * Built once, and in *world* space, because "is anything above this bird"
   * is not a question about the room the bird is in. A stacked terrace brings
   * its own colonnade over the room below it, and a perch checked only against
   * its own platform's pieces went straight into somebody else's pillar.
   */
  const everything: Blocker[] = [];
  for (const [platformId, pieces] of plan.onPlatform) {
    const platform = byId.get(platformId);
    if (!platform) continue;
    const base = levelY(platform.level);
    for (const blocker of archBlockers(pieces)) {
      everything.push({
        x: blocker.x + platform.position[0],
        z: blocker.z + platform.position[1],
        halfWidth: blocker.halfWidth,
        halfDepth: blocker.halfDepth,
        base: blocker.base + base,
        top: blocker.top + base,
      });
    }
  }

  for (const [platformId, pieces] of plan.onPlatform) {
    const platform = byId.get(platformId);
    if (!platform) continue;
    const base = levelY(platform.level);
    // Its own room decides how high the perch is; the whole campus decides
    // whether there is room for a bird there.
    const mine = archBlockers(pieces);
    const taken: [number, number][] = [];

    for (const piece of pieces) {
      /*
       * Only the tall, thin things: a bird on the corner of a wall reads as a
       * mistake, and one in the middle of a floor is not perched at all.
       *
       * Boxes count too, and have to. A tower, a minaret cap, a pylon and the
       * finial on a drape post are all boxes, so a world fond of any of those
       * offered no candidate spots whatsoever and simply had no birds in it —
       * which was one world in five once every world could build anything.
       * What matters is the footprint, not the primitive.
       */
      let spot: [number, number] | null = null;
      if (piece.shape === 'column' && piece.height > 1.6) spot = [piece.at[0], piece.at[2]];
      else if (piece.shape === 'arch' && piece.radius > 0.9) spot = [piece.at[0], piece.at[2]];
      else if (piece.shape === 'box' && Math.max(piece.size[0], piece.size[2]) <= NARROW) {
        spot = [piece.at[0], piece.at[2]];
      }
      if (!spot) continue;

      const [x, z] = spot;
      const y = stackTop(mine, x, z);
      if (y < MIN_HEIGHT) continue;

      const world: [number, number, number] = [platform.position[0] + x, base + y, platform.position[1] + z];
      if (roofed(everything, world[0], world[1], world[2])) continue;
      // And no floor of the campus overhead either: a stacked terrace is a
      // whole storey above, and a floor is not in anybody's piece list.
      if (covered(campus, world[0], world[1], world[2])) continue;
      // Two columns under one cornice would otherwise put two birds on the
      // same square inch of it.
      if (taken.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < APART)) continue;
      taken.push([x, z]);

      out.push({ id: out.length, at: world });
    }
  }
  return out;
}

interface Blocker {
  x: number;
  z: number;
  halfWidth: number;
  halfDepth: number;
  base: number;
  top: number;
}

/**
 * The highest thing standing over a spot — which is the thing a bird lands on.
 *
 * Reading the whole stack rather than one piece is the point: a pillar in a
 * colonnade reports the height of the cornice it carries, an arch in an arcade
 * reports the course along its crown, and a bird put at either lands on a
 * surface instead of inside a solid.
 */
function stackTop(blockers: readonly Blocker[], x: number, z: number): number {
  let top = -Infinity;
  for (const blocker of blockers) {
    if (Math.abs(x - blocker.x) > blocker.halfWidth) continue;
    if (Math.abs(z - blocker.z) > blocker.halfDepth) continue;
    if (blocker.top > top) top = blocker.top;
  }
  return top;
}

/** Is anything on this platform standing in the air over the point? */
function roofed(blockers: readonly Blocker[], x: number, y: number, z: number): boolean {
  for (const blocker of blockers) {
    // Its own shaft ends exactly here, and so may a neighbour's; what matters
    // is whether anything reaches *above* the perch.
    if (blocker.top <= y + 0.05) continue;
    if (blocker.base > y + CEILING) continue;
    if (blocker.base > y + HEADROOM) continue;
    if (Math.abs(x - blocker.x) > blocker.halfWidth) continue;
    if (Math.abs(z - blocker.z) > blocker.halfDepth) continue;
    return true;
  }
  return false;
}

/** And is there a floor of the campus overhead? */
function covered(campus: Campus, x: number, y: number, z: number): boolean {
  for (const platform of campus.platforms) {
    const top = levelY(platform.level);
    const under = top - PLATFORM_THICKNESS;
    if (under <= y + 0.05 || under > y + CEILING) continue;
    const [width, depth] = platform.size;
    if (Math.abs(x - platform.position[0]) > width / 2) continue;
    if (Math.abs(z - platform.position[1]) > depth / 2) continue;
    return true;
  }
  return false;
}
