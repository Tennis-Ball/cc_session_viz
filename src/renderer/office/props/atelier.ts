import { box, buildProp, cylinder, type Part } from './kit';
import type { PropBuild, PropOptions, PropPalette } from './types';

/**
 * Sticky note placements on the wall panel, as [x, y] offsets from the panel's
 * origin. Hand-placed rather than generated: a task wall should look posted by
 * someone in a hurry, and a grid reads as a calendar instead.
 */
const NOTES: ReadonlyArray<readonly [number, number]> = [
  [-0.26, 1.42],
  [0.04, 1.46],
  [0.3, 1.16],
  [-0.28, 1.1],
  [0.0, 1.08],
  [0.26, 0.82],
];

/** Indexes into a color pool without tripping noUncheckedIndexedAccess. */
function pick(pool: readonly string[], index: number, fallback: string): string {
  return pool[((index % pool.length) + pool.length) % pool.length] ?? fallback;
}

/**
 * The atelier: where a turn is thought through before anything is touched.
 *
 * The easel is deliberately the biggest single mass in the office after the
 * platforms themselves — planning is the loudest thing an agent does, so the
 * zone has to be legible from the far side of the scene.
 */
export function buildAtelier(palette: PropPalette, options: PropOptions = {}): PropBuild {
  const seed = options.seed ?? 0;
  const notePool = [palette.accent, palette.paper, palette.surfaceAlt];
  const parts: Part[] = [];

  // Easel. The board leans back on its own legs; the face is offset in world Z
  // rather than along the tilted normal, which stays clear of the frame because
  // both pieces pivot about the same base height.
  const tilt = -0.16;
  parts.push(box(0.12, 0.8, 0.12, { color: palette.dark, position: [-1.55, 0, -0.82], rotation: [tilt, 0, 0] }));
  parts.push(box(0.12, 0.8, 0.12, { color: palette.dark, position: [0.15, 0, -0.82], rotation: [tilt, 0, 0] }));
  parts.push(box(2.0, 1.25, 0.08, { color: palette.dark, position: [-0.7, 0.72, -0.96], rotation: [tilt, 0, 0] }));
  parts.push(
    box(1.82, 1.14, 0.03, {
      color: palette.paper,
      position: [-0.7, 0.74, -0.91],
      rotation: [tilt, 0, 0],
      grad: [0.75, 1],
    }),
  );
  // Pen tray, which also hides the seam where board meets legs.
  parts.push(box(1.94, 0.07, 0.18, { color: palette.surfaceAlt, position: [-0.7, 0.66, -0.86], grad: [0.6, 1] }));

  // Standing table: counter height, so figures read as leaning on it, not sitting.
  parts.push(cylinder(0.3, 0.05, { color: palette.dark, position: [0.35, 0, 0.66] }, 14));
  parts.push(cylinder(0.09, 0.96, { color: palette.dark, position: [0.35, 0, 0.66] }, 10));
  parts.push(box(0.9, 0.08, 0.58, { color: palette.surface, position: [0.35, 0.96, 0.66], grad: [0.6, 1] }));

  // Two stools, offset from the table so the group never looks symmetrical.
  for (const x of [-0.35, 1.03] as const) {
    parts.push(cylinder(0.05, 0.6, { color: palette.dark, position: [x, 0, 0.68] }, 8));
    parts.push(cylinder(0.21, 0.07, { color: palette.surfaceAlt, position: [x, 0.6, 0.68], grad: [0.5, 1] }, 12));
  }

  // Sticky note wall: a freestanding panel rather than a real wall, because the
  // office has almost none.
  parts.push(box(1.0, 1.85, 0.1, { color: palette.surface, position: [1.2, 0, -0.96] }));
  NOTES.forEach(([dx, dy], i) => {
    parts.push(
      box(0.2, 0.2, 0.02, {
        color: pick(notePool, i + seed, palette.accent),
        position: [1.2 + dx, dy, -0.9],
        grad: [0.85, 1],
      }),
    );
  });

  return {
    geometry: buildProp(parts),
    slots: [
      { kind: 'whiteboard', position: [-1.2, 0, -0.19], facing: Math.PI },
      { kind: 'whiteboard', position: [-0.2, 0, -0.19], facing: Math.PI },
      { kind: 'stickyWall', position: [1.2, 0, -0.24], facing: Math.PI },
    ],
    footprint: [3.6, 2.6],
  };
}
