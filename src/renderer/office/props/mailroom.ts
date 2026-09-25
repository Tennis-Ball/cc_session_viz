import { box, buildProp, cylinder, type Part } from './kit';
import type { PropBuild, PropOptions, PropPalette } from './types';

const WALL_X = -0.85;
const WALL_Z = -1.15;
/** Pigeonhole grid, as offsets from the wall cabinet's origin. */
const SLOT_DX: readonly number[] = [-0.6, -0.2, 0.2, 0.6];
const SLOT_Y: readonly number[] = [0.68, 1.02, 1.36];

/**
 * The mailroom: where a session speaks to the outside world.
 *
 * The pigeonholes are dark except for a few in paper — an empty grid is a
 * texture, a partly full one is a place where things arrive. Which holes are
 * full comes from the seed, so a given mailroom stays the same across launches.
 */
export function buildMailroom(palette: PropPalette, options: PropOptions = {}): PropBuild {
  const seed = Math.trunc(options.seed ?? 0);
  const parts: Part[] = [];

  parts.push(box(1.7, 1.75, 0.3, { color: palette.surface, position: [WALL_X, 0, WALL_Z] }));
  SLOT_Y.forEach((y, row) => {
    SLOT_DX.forEach((dx, col) => {
      const index = row * SLOT_DX.length + col;
      const full = ((((index * 7 + seed) % 12) + 12) % 12) < 4;
      parts.push(
        box(0.36, 0.24, 0.05, {
          color: full ? palette.paper : palette.dark,
          position: [WALL_X + dx, y, -0.99],
          grad: [0.6, 1],
        }),
      );
    });
  });

  // Pneumatic tube. The tube is two solid drums with a gap: the capsule showing
  // through the gap is cheaper and reads better than any attempt at glass.
  parts.push(box(0.42, 0.3, 0.42, { color: palette.dark, position: [1.15, 0, -1.0] }));
  parts.push(cylinder(0.16, 0.85, { color: palette.metal, position: [1.15, 0.3, -1.0], grad: [0.5, 1] }, 12));
  parts.push(cylinder(0.13, 0.34, { color: palette.accent, emissive: 0.6, position: [1.15, 1.15, -1.0], grad: [0.8, 1] }, 10));
  parts.push(cylinder(0.16, 0.75, { color: palette.metal, position: [1.15, 1.49, -1.0], grad: [0.8, 1] }, 12));
  parts.push(cylinder(0.2, 0.12, { color: palette.dark, position: [1.15, 2.24, -1.0], grad: [0.8, 1] }, 12));

  // Counter, long enough for two figures to work it without overlapping.
  parts.push(box(2.0, 0.1, 0.62, { color: palette.surface, position: [-0.1, 0.86, 0.2], grad: [0.6, 1] }));
  parts.push(box(2.0, 0.86, 0.12, { color: palette.surface, position: [-0.1, 0, 0.45] }));
  parts.push(box(1.9, 0.5, 0.42, { color: palette.surfaceAlt, position: [-0.1, 0, 0.14] }));
  parts.push(box(0.3, 0.22, 0.26, { color: palette.paper, position: [0.62, 0.96, 0.2], grad: [0.6, 1] }));
  parts.push(box(0.32, 0.24, 0.07, { color: palette.accent, position: [0.62, 0.95, 0.2], grad: [0.6, 1] }));

  return {
    geometry: buildProp(parts),
    slots: [
      { kind: 'counter', position: [-0.6, 0, 0.95], facing: Math.PI },
      { kind: 'counter', position: [0.4, 0, 0.95], facing: Math.PI },
    ],
    footprint: [3.4, 2.6],
  };
}
