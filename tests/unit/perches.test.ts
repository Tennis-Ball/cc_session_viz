import { describe, expect, it } from 'vitest';
import { perchesFor } from '@renderer/office/anim/perches';
import { flockSize } from '@renderer/office/anim/birdFlight';
import { archBlockers, planArchitecture } from '@renderer/office/world/architecture';
import { buildCampus, type DeskRequest } from '@renderer/office/world/layout';
import { levelY, PLATFORM_THICKNESS } from '@renderer/office/world/campusTemplate';

function desks(count: number): DeskRequest[] {
  return Array.from({ length: count }, (_, i) => ({ id: `s${i}`, label: `s${i}`, colorIndex: i, seats: 1 }));
}

const SEEDS = Array.from({ length: 20 }, (_, i) => 1 + i * 613);

describe('where a bird will sit', () => {
  it('puts one on top of whatever the column carries, never inside it', () => {
    // Of a hundred and fifty tall columns and big arches across twenty worlds,
    // all but three had something directly above them: a cornice, a roof, a
    // course along an arcade. The top of a column is not the top of the
    // building. A perch is the highest surface over the spot.
    for (const seed of SEEDS) {
      const campus = buildCampus(desks(5), new Map(), seed, 'ornate');
      const plan = planArchitecture(campus, seed, 'ornate');
      const byId = new Map(campus.platforms.map((p) => [p.id, p]));

      for (const perch of perchesFor(campus, plan)) {
        // Against *every* room, not only its own: a stacked terrace brings its
        // colonnade over the platform below it, and a perch checked against
        // one room's pieces went straight into another room's pillar.
        for (const [platformId, pieces] of plan.onPlatform) {
          const platform = byId.get(platformId)!;
          const base = levelY(platform.level);
          const x = perch.at[0] - platform.position[0];
          const z = perch.at[2] - platform.position[1];
          const y = perch.at[1] - base;
          for (const blocker of archBlockers(pieces)) {
            const over = blocker.top > y + 0.05 && blocker.base <= y + 0.6;
            const inside = Math.abs(x - blocker.x) < blocker.halfWidth && Math.abs(z - blocker.z) < blocker.halfDepth;
            expect(over && inside, `seed ${seed}: perch buried in ${platformId}`).toBe(false);
          }
        }
      }
    }
  });

  it('never puts one under a floor', () => {
    for (const seed of SEEDS) {
      const campus = buildCampus(desks(6), new Map(), seed, 'ornate');
      const plan = planArchitecture(campus, seed, 'ornate');
      for (const perch of perchesFor(campus, plan)) {
        for (const platform of campus.platforms) {
          const under = levelY(platform.level) - PLATFORM_THICKNESS;
          if (under <= perch.at[1] + 0.05) continue;
          const [width, depth] = platform.size;
          const inside =
            Math.abs(perch.at[0] - platform.position[0]) < width / 2 &&
            Math.abs(perch.at[2] - platform.position[1]) < depth / 2;
          // A stacked terrace is a whole floor overhead, and it belongs to a
          // different platform — so it is not in the pieces the check above
          // looks at, and it has to be ruled out separately.
          expect(inside && under < perch.at[1] + 6, `seed ${seed}: perch under ${platform.id}`).toBe(false);
        }
      }
    }
  });

  it('still leaves somewhere to land in most worlds', () => {
    // A rule that rejects everything is a rule that removes the birds, which
    // is not the fix anybody asked for.
    let withBirds = 0;
    for (const seed of SEEDS) {
      const campus = buildCampus(desks(5), new Map(), seed, 'ornate');
      const plan = planArchitecture(campus, seed, 'ornate');
      if (flockSize(perchesFor(campus, plan).length) > 0) withBirds += 1;
    }
    // Rejecting every buried perch and stopping there left one world in twenty
    // with any birds at all, which is not the fix anybody asked for.
    expect(withBirds).toBeGreaterThanOrEqual(SEEDS.length * 0.9);
  });

  it('gives every perch a distinct spot', () => {
    for (const seed of SEEDS.slice(0, 6)) {
      const campus = buildCampus(desks(5), new Map(), seed, 'ornate');
      const perches = perchesFor(campus, planArchitecture(campus, seed, 'ornate'));
      const seen = new Set(perches.map((p) => p.at.map((v) => v.toFixed(2)).join(',')));
      expect(seen.size).toBe(perches.length);
      // And ids that index the array, which is what the flock steers by.
      perches.forEach((perch, i) => expect(perch.id).toBe(i));
    }
  });
});
