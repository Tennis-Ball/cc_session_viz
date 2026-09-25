import { box, buildProp, cylinder, type Part } from './kit';
import type { PropBuild, PropOptions, PropPalette } from './types';

/**
 * A 32-bit xorshift, local to this file because the kit deliberately has no
 * randomness in it. Books are the one prop where variation is the point, and
 * the seed keeps a given library identical on every launch.
 */
function makeRng(seed: number): () => number {
  // imul, not `*`: platform ids hash to a full uint32 and a plain multiply would
  // drift past 2^53 before the mask ever gets a chance to run.
  let state = Math.imul(Math.trunc(seed), 2654435761) >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

/** Indexes into a color pool without tripping noUncheckedIndexedAccess. */
function pick(pool: readonly string[], index: number, fallback: string): string {
  return pool[((index % pool.length) + pool.length) % pool.length] ?? fallback;
}

/** Shelf carcass constants, shared by both units so they read as one piece of joinery. */
const UNIT_WIDTH = 1.4;
const UNIT_DEPTH = 0.42;
const UNIT_HEIGHT = 2.2;
const UNIT_Z = -1.3;
/** Board heights; the space below the lowest board is the open bay. */
const BOARDS: readonly number[] = [0.72, 1.46];
/** Where books sit within a bay, left to right. */
const BOOK_X: readonly number[] = [-0.38, 0.0, 0.38];

/**
 * The library: shelves to search, stands to read at, and one shelf that glows.
 *
 * The glow is the only light in the zone, so "learning" is visible as a place
 * rather than as a figure's pose — the same trick the desk lamp plays at night.
 */
export function buildLibrary(palette: PropPalette, options: PropOptions = {}): PropBuild {
  const rng = makeRng(options.seed ?? 1);
  const spines = [palette.accent, palette.surfaceAlt, palette.paper, palette.plant, palette.metal, palette.dark];
  const parts: Part[] = [];

  // Two identical units. The right one carries the skill shelf in its open bay.
  const units: ReadonlyArray<readonly [number, boolean]> = [
    [-0.85, false],
    [0.85, true],
  ];

  for (const [cx, isSkill] of units) {
    parts.push(box(UNIT_WIDTH, UNIT_HEIGHT, 0.06, { color: palette.surfaceAlt, position: [cx, 0, UNIT_Z - 0.18] }));
    parts.push(box(0.09, UNIT_HEIGHT, UNIT_DEPTH, { color: palette.surface, position: [cx - 0.655, 0, UNIT_Z] }));
    parts.push(box(0.09, UNIT_HEIGHT, UNIT_DEPTH, { color: palette.surface, position: [cx + 0.655, 0, UNIT_Z] }));
    parts.push(
      box(UNIT_WIDTH + 0.04, 0.1, UNIT_DEPTH + 0.04, {
        color: palette.surface,
        position: [cx, UNIT_HEIGHT, UNIT_Z],
        grad: [0.6, 1],
      }),
    );

    BOARDS.forEach((y, boardIndex) => {
      // The board capping the skill bay is picked out in the zone accent, so the
      // glow below it reads as belonging to a shelf and not to the floor.
      const accented = isSkill && boardIndex === 0;
      parts.push(
        box(1.22, 0.07, 0.4, {
          color: accented ? palette.accent : palette.surface,
          position: [cx, y, UNIT_Z],
          grad: [0.7, 1],
        }),
      );

      for (const [bookIndex, dx] of BOOK_X.entries()) {
        const width = 0.28 + rng() * 0.13;
        const height = 0.34 + rng() * 0.18;
        parts.push(
          box(width, height, 0.3, {
            color: pick(spines, Math.floor(rng() * spines.length) + bookIndex, palette.surfaceAlt),
            position: [cx + dx, y + 0.07, UNIT_Z + 0.02],
            grad: [0.55, 1],
          }),
        );
      }
    });

    if (isSkill) {
      // A flat emissive panel at the back of the bay rather than a glowing shelf
      // edge: the light then spills forward instead of outlining the furniture.
      parts.push(
        box(1.18, 0.56, 0.02, {
          color: palette.screen,
          emissive: 0.55,
          position: [cx, 0.09, UNIT_Z - 0.13],
          grad: [0.8, 1],
        }),
      );
    }
  }

  // Rolling ladder, leaning on the left unit. Rungs are stepped along the rail
  // axis so they stay square to it under the same lean.
  const lean = -0.17;
  const axisY = Math.cos(lean);
  const axisZ = Math.sin(lean);
  for (const dx of [-0.24, 0.24] as const) {
    parts.push(box(0.06, 2.0, 0.06, { color: palette.metal, position: [-0.85 + dx, 0, -0.78], rotation: [lean, 0, 0] }));
  }
  for (const t of [0.5, 1.0, 1.5] as const) {
    parts.push(
      box(0.42, 0.05, 0.05, {
        color: palette.metal,
        position: [-0.85, axisY * t, -0.78 + axisZ * t],
        rotation: [lean, 0, 0],
        grad: [0.7, 1],
      }),
    );
  }

  // Reading stands: a tapered plinth and a sloped top, high edge away from the
  // reader so the page tips toward their eyes.
  for (const x of [-0.8, 0.8] as const) {
    parts.push(cylinder(0.17, 0.92, { color: palette.dark, position: [x, 0, 0.6] }, 10, 0.08));
    parts.push(
      box(0.52, 0.06, 0.38, {
        color: palette.paper,
        position: [x, 0.92, 0.6],
        rotation: [0.35, 0, 0],
        grad: [0.75, 1],
      }),
    );
  }

  return {
    geometry: buildProp(parts),
    slots: [
      { kind: 'shelf', position: [-1.35, 0, -0.62], facing: Math.PI },
      { kind: 'shelf', position: [-0.35, 0, -0.62], facing: Math.PI },
      { kind: 'skillShelf', position: [0.85, 0, -0.62], facing: Math.PI },
      { kind: 'readStand', position: [-0.8, 0, 1.12], facing: Math.PI },
      { kind: 'readStand', position: [0.8, 0, 1.12], facing: Math.PI },
    ],
    footprint: [3.4, 3.2],
  };
}
