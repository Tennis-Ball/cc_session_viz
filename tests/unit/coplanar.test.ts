import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { campusArchGeometry, planArchitecture } from '@renderer/office/world/architecture';
import { connectorGeometry, platformGeometry } from '@renderer/office/scene/Platforms';
import { buildCampus, type DeskRequest } from '@renderer/office/world/layout';
import { resolveTheme } from '@renderer/office/theme/themes';
import type { OfficeDetail } from '@shared/prefs';

/**
 * Nothing in the office shares a plane with something else of a different
 * colour.
 *
 * This is the flashing, and it took four rounds to find because every way of
 * looking for it was the wrong way. The campus is one merged mesh with one
 * material, so two upward faces at the same height have nothing to break the
 * depth tie: the winner is decided per pixel by whichever way a rounding error
 * went. From a standing camera that comparison is *deterministic*, so the
 * picture is perfectly stable and a frame-by-frame diff of the framebuffer —
 * which is what I spent two rounds on — reports a clean scene. It only breaks up
 * when the camera moves, and then large areas strobe between two colours.
 *
 * So it is asserted on the geometry instead of looked for in the picture.
 *
 * Two things make the check tractable. The facet material is `FrontSide`, so
 * downward faces are culled and only *upward* ones can fight. And a fight needs
 * a visible difference, so faces of the same colour are ignored — which is why
 * the healthy way to stack masonry, course on identical course, passes.
 */

const THEME = resolveTheme('monument', 1);
const DETAILS: OfficeDetail[] = ['quiet', 'ornate'];
const SEEDS = [1, 3, 4, 7, 9, 12, 14, 17, 20, 23];

/** A desk per session, enough of them to force stacking and long walkways. */
function desks(count: number): DeskRequest[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    label: `session ${i}`,
    colorIndex: i % 12,
    seats: 1 + (i % 3),
  }));
}

interface Face {
  /** The three 2D corners, on the ground plane. */
  points: [number, number][];
  y: number;
  /** Colour and vertical-gradient weight: what the face will actually look like. */
  look: string;
  /** Which builder made it, so a failure says where to go and look. */
  source: string;
}

/**
 * Every upward-facing triangle in a geometry, with what it looks like.
 *
 * The index buffer is not optional. `BoxGeometry` is indexed, so nearly every
 * piece in the office is, and walking `position` three vertices at a time
 * invents triangles that were never drawn: the first version of this did exactly
 * that and confidently reported seven z-fights, every one of them a quad stitched
 * out of corners belonging to three different faces. Two minutes from "fixing"
 * geometry that was already correct.
 *
 * `0.999` rather than an exact 1 because a face built by rotating a box lands a
 * rounding error off straight up, and a spiral tread is still a floor.
 */
function upwardFaces(geometry: BufferGeometry, source: string): Face[] {
  const position = geometry.getAttribute('position');
  const color = geometry.getAttribute('color');
  const grad = geometry.getAttribute('aGrad');
  const index = geometry.getIndex();
  const faces: Face[] = [];
  const count = index ? index.count : position.count;
  const at = (n: number): number => (index ? index.getX(n) : n);

  for (let n = 0; n < count; n += 3) {
    const i = at(n);
    const j = at(n + 1);
    const k = at(n + 2);
    const ax = position.getX(i);
    const ay = position.getY(i);
    const az = position.getZ(i);
    const bx = position.getX(j);
    const by = position.getY(j);
    const bz = position.getZ(j);
    const cx = position.getX(k);
    const cy = position.getY(k);
    const cz = position.getZ(k);

    // Cross product of two edges; only its direction matters.
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-9 || ny / length < 0.999) continue;

    // A sloped face is not a tie: only ones that are level can share a plane.
    if (Math.abs(ay - by) > 1e-4 || Math.abs(ay - cy) > 1e-4) continue;

    faces.push({
      points: [
        [ax, az],
        [bx, bz],
        [cx, cz],
      ],
      y: ay,
      source,
      look: color
        ? `${color.getX(i).toFixed(3)},${color.getY(i).toFixed(3)},${color.getZ(i).toFixed(3)}@${(grad?.getX(i) ?? 0).toFixed(2)}`
        : 'plain',
    });
  }

  return faces;
}

function boundsOf(face: Face): [number, number, number, number] {
  const xs = face.points.map((p) => p[0]);
  const zs = face.points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
}

function inTriangle(x: number, z: number, points: [number, number][]): boolean {
  const [[ax, az], [bx, bz], [cx, cz]] = points as [[number, number], [number, number], [number, number]];
  const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  if (Math.abs(area) < 1e-12) return false;
  const s = ((bx - ax) * (z - az) - (bz - az) * (x - ax)) / area;
  const t = ((x - ax) * (cz - az) - (z - az) * (cx - ax)) / area;
  return s >= 0 && t >= 0 && s + t <= 1;
}

/**
 * Do two coplanar triangles cover any of the same ground?
 *
 * Sampled rather than clipped. Exact polygon intersection is the right answer
 * and far more code than this needs: what is being looked for is a *surface*
 * shared between two pieces of furniture, which is tens of thousands of times
 * larger than the sample spacing. Sampling also gives the check the property it
 * wants most — two pieces that merely meet along an edge, which is how every
 * correctly built stair and bridge in the office joins its neighbour, share no
 * interior and are not reported.
 */
/**
 * The middle of two coplanar faces' shared ground, or null if they share none.
 *
 * Sampled rather than clipped. Exact polygon intersection is the right answer
 * and far more code than this needs: what is being looked for is a *surface*
 * shared between two pieces of furniture, which is far larger than the sample
 * spacing. Sampling also gives the check the property it wants most — two pieces
 * that merely meet along an edge, which is how every correctly built stair and
 * bridge in the office joins its neighbour, share no interior and go unreported.
 *
 * The shared area comes back with it, because the threshold matters. Connectors
 * and architecture are planned independently and will always clip each other
 * somewhere by a few centimetres — a lift post grazing a parapet — and failing
 * the build over a patch two pixels across would bury the cases that matter in
 * noise. Every real fight found so far has been between a third of a square unit
 * and nine of them; this is set two orders of magnitude below the smallest.
 */
function sharedPoint(a: Face, b: Face): { x: number; z: number; area: number } | null {
  const [ax0, az0, ax1, az1] = boundsOf(a);
  const [bx0, bz0, bx1, bz1] = boundsOf(b);
  const x0 = Math.max(ax0, bx0);
  const z0 = Math.max(az0, bz0);
  const x1 = Math.min(ax1, bx1);
  const z1 = Math.min(az1, bz1);
  if (x1 - x0 < 0.02 || z1 - z0 < 0.02) return null;

  const STEPS = 6;
  const cell = ((x1 - x0) / STEPS) * ((z1 - z0) / STEPS);
  let hits = 0;
  let firstX = 0;
  let firstZ = 0;
  for (let i = 1; i < STEPS; i += 1) {
    for (let j = 1; j < STEPS; j += 1) {
      const x = x0 + ((x1 - x0) * i) / STEPS;
      const z = z0 + ((z1 - z0) * j) / STEPS;
      if (!inTriangle(x, z, a.points) || !inTriangle(x, z, b.points)) continue;
      if (hits === 0) {
        firstX = x;
        firstZ = z;
      }
      hits += 1;
    }
  }
  return hits === 0 ? null : { x: firstX, z: firstZ, area: hits * cell };
}

/** Smallest shared surface worth failing over, in square world units. */
const MIN_AREA = 0.05;

/**
 * Is there something solid above this spot?
 *
 * A tie only matters if you can see it. The office stacks masonry constantly —
 * a roof fascia with a course sitting on it, a column whose cap is under the
 * eaves it carries — and those coincide exactly by design, because a course
 * *should* sit flush on the one below. Whatever is above wins the depth test at
 * a nearer plane and hides both, so the tie underneath never resolves to a
 * pixel. Reporting it would bury the real cases in dozens of correct ones.
 *
 * Approximated by asking whether any upward face higher up covers the same
 * ground, which for a world built entirely out of solid boxes and courses is
 * the same question.
 */
function covered(faces: Face[], x: number, z: number, y: number): boolean {
  for (const face of faces) {
    if (face.y <= y + 0.01) continue;
    if (inTriangle(x, z, face.points)) return true;
  }
  return false;
}

function overlaps(a: Face, b: Face): boolean {
  const [ax0, az0, ax1, az1] = boundsOf(a);
  const [bx0, bz0, bx1, bz1] = boundsOf(b);
  const x0 = Math.max(ax0, bx0);
  const z0 = Math.max(az0, bz0);
  const x1 = Math.min(ax1, bx1);
  const z1 = Math.min(az1, bz1);
  // Edge-adjacent, or apart. A shared edge is a hairline, not a fight.
  if (x1 - x0 < 0.02 || z1 - z0 < 0.02) return false;

  const STEPS = 6;
  for (let i = 1; i < STEPS; i += 1) {
    for (let j = 1; j < STEPS; j += 1) {
      const x = x0 + ((x1 - x0) * i) / STEPS;
      const z = z0 + ((z1 - z0) * j) / STEPS;
      if (inTriangle(x, z, a.points) && inTriangle(x, z, b.points)) return true;
    }
  }
  return false;
}

/** Every pair of same-height, different-colour, overlapping upward faces. */
function fights(faces: Face[]): string[] {

  // Bucketed by height, so only faces that could possibly tie are compared.
  // The depth buffer has far more precision than this at office scale; a
  // separation of a hundredth of a unit is enough to settle the comparison, and
  // is the smallest lift the code itself uses (`FLOOR_LIFT`).
  const planes = new Map<number, Face[]>();
  for (const face of faces) {
    const key = Math.round(face.y * 100);
    const list = planes.get(key);
    if (list) list.push(face);
    else planes.set(key, [face]);
  }

  const found: string[] = [];
  for (const [key, list] of planes) {
    if (list.length < 2) continue;
    // Only ever a handful of distinct looks on one plane; comparing those is
    // what makes this cheap, because faces that look alike cannot fight.
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.look === b.look) continue;
        const shared = sharedPoint(a, b);
        if (!shared || shared.area < MIN_AREA) continue;
        if (covered(faces, shared.x, shared.z, a.y)) continue;
        const ab = boundsOf(a);
        const bb = boundsOf(b);
        const span = (t: [number, number, number, number]): string =>
          `x ${t[0].toFixed(2)}..${t[2].toFixed(2)} z ${t[1].toFixed(2)}..${t[3].toFixed(2)}`;
        const line = `y=${(key / 100).toFixed(2)} over ~${shared.area.toFixed(2)}u²  ${a.source} [${a.look}] ${span(ab)}  vs  ${b.source} [${b.look}] ${span(bb)}`;
        if (!found.includes(line)) found.push(line);
        if (found.length > 6) return found;
      }
    }
  }
  return found;
}

describe('coplanar surfaces', () => {
  for (const detail of DETAILS) {
    it(`no two surfaces of different colours share a plane — ${detail}`, () => {
      for (const seed of SEEDS) {
        const campus = buildCampus(desks(9), new Map(), seed, detail);
        const plan = planArchitecture(campus, seed, detail);

        // Kept separate so a failure names the builder rather than a coordinate.
        const faces: Face[] = [];
        for (const platform of campus.platforms) {
          faces.push(...upwardFaces(platformGeometry(platform, THEME), `platform ${platform.id}`));
        }
        // Both halves of the stone, exactly as `Platforms` passes them: the
        // variant *and* the terrace it is coloured as if it stood on. Passing
        // only the variant is what this test caught when the terrace bias
        // landed, and it was right to — a landing a shade off the floor it
        // lands on is the flashing, whatever produced it.
        const stoneOf = new Map(campus.platforms.map((p) => [p.id, [p.stone, p.stoneLevel] as const]));
        for (const connector of campus.connectors) {
          const [stone, level] = stoneOf.get(connector.from) ?? [0, 0];
          const geometry = connectorGeometry(connector, THEME, stone, level);
          faces.push(...upwardFaces(geometry, `${connector.style ?? connector.kind} ${connector.id}`));
        }
        const built = campusArchGeometry(campus, plan, THEME);
        if (built) faces.push(...upwardFaces(built, 'architecture'));

        const found = fights(faces);
        expect(found, `seed ${seed} (${detail}) has coplanar surfaces:\n  ${found.join('\n  ')}`).toEqual([]);
      }
    });
  }
});
