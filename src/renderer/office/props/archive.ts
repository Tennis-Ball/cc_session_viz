import { box, buildProp, type Part } from './kit';
import type { PropBuild, PropOptions, PropPalette } from './types';

/** Cabinet centres, left to right. The middle one is the one standing open. */
const CABINET_X: readonly number[] = [-1.25, -0.47, 0.31];
const CABINET_Z = -0.8;
/** Drawer front heights within a cabinet. */
const DRAWER_Y: readonly number[] = [0.08, 0.5, 0.92];
/** Index into CABINET_X / DRAWER_Y of the drawer that is pulled out. */
const OPEN_CABINET = 1;
const OPEN_DRAWER = 1;

/**
 * The archive: where context goes when a session compacts.
 *
 * Drawer lines are real gaps between proud drawer fronts rather than scored
 * lines, because an incised groove vanishes the moment the camera pulls back.
 * One drawer hangs open with paper in it — the single piece of narrative that
 * tells you the cabinets are used and not scenery.
 */
export function buildArchive(palette: PropPalette, options: PropOptions = {}): PropBuild {
  const seed = Math.trunc(options.seed ?? 0);
  const parts: Part[] = [];

  CABINET_X.forEach((x, cabinetIndex) => {
    parts.push(box(0.72, 1.34, 0.62, { color: palette.surface, position: [x, 0, CABINET_Z] }));
    parts.push(box(0.78, 0.07, 0.66, { color: palette.dark, position: [x, 1.34, CABINET_Z], grad: [0.5, 1] }));

    DRAWER_Y.forEach((y, drawerIndex) => {
      if (cabinetIndex === OPEN_CABINET && drawerIndex === OPEN_DRAWER) return;
      parts.push(box(0.62, 0.38, 0.06, { color: palette.surfaceAlt, position: [x, y, -0.47], grad: [0.4, 1] }));
      parts.push(box(0.22, 0.05, 0.05, { color: palette.metal, position: [x, y + 0.27, -0.42], grad: [0.8, 1] }));
    });
  });

  // The open drawer: a carcass pulled forward, its own face on the front, and
  // three sheets fanned by a seeded wobble so no two archives look identical.
  const openX = CABINET_X[OPEN_CABINET] ?? 0;
  const openY = DRAWER_Y[OPEN_DRAWER] ?? 0.5;
  parts.push(box(0.62, 0.32, 0.46, { color: palette.surfaceAlt, position: [openX, openY + 0.02, -0.28], grad: [0.4, 1] }));
  parts.push(box(0.66, 0.38, 0.05, { color: palette.surfaceAlt, position: [openX, openY, -0.045], grad: [0.4, 1] }));
  for (let i = 0; i < 3; i++) {
    const wobble = ((((i + seed) % 5) + 5) % 5) - 2;
    parts.push(
      box(0.42, 0.02, 0.3, {
        color: palette.paper,
        position: [openX + wobble * 0.02, openY + 0.28 + i * 0.03, -0.3],
        rotation: [0, wobble * 0.07, 0],
        grad: [0.9, 1],
      }),
    );
  }

  // Box stack. Each crate is turned a little off-square; the lids are what make
  // three plain masses read as boxes at all.
  const crates: ReadonlyArray<readonly [number, number, number, number, number]> = [
    [1.2, 0.0, -0.62, 0.64, 0.0],
    [1.26, 0.49, -0.58, 0.56, 0.18],
    [1.14, 0.93, -0.66, 0.5, -0.22],
  ];
  crates.forEach(([x, y, z, width, yaw], i) => {
    const height = 0.42 - i * 0.04;
    const depth = width - 0.08;
    parts.push(box(width, height, depth, { color: i === 1 ? palette.surface : palette.surfaceAlt, position: [x, y, z], rotation: [0, yaw, 0] }));
    parts.push(
      box(width + 0.04, 0.06, depth + 0.04, {
        color: palette.paper,
        position: [x, y + height, z],
        rotation: [0, yaw, 0],
        grad: [0.7, 1],
      }),
    );
  });

  return {
    geometry: buildProp(parts),
    slots: [
      { kind: 'cabinet', position: [-1.25, 0, 0.08], facing: Math.PI },
      { kind: 'cabinet', position: [0.31, 0, 0.08], facing: Math.PI },
    ],
    footprint: [3.4, 2.4],
  };
}
