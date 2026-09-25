import { box, buildProp, type Part } from './kit';
import type { PropBuild, PropOptions, PropPalette } from './types';

/** Indexes into a color pool without tripping noUncheckedIndexedAccess. */
function pick(pool: readonly string[], index: number, fallback: string): string {
  return pool[((index % pool.length) + pool.length) % pool.length] ?? fallback;
}

/**
 * The workshop: the loud end of the office, where commands actually run.
 *
 * Three machines, three jobs — the copier is a test run, the rack is a tool
 * call, the bench is everything else. They are spaced far enough apart that a
 * figure at one of them is never ambiguous about which it is at.
 */
export function buildWorkshop(palette: PropPalette, options: PropOptions = {}): PropBuild {
  const seed = Math.trunc(options.seed ?? 0);
  const parts: Part[] = [];

  // Copier. The sheet caught half-out of the tray is the whole idea of the prop:
  // a machine mid-job reads as running even when nobody is standing at it.
  parts.push(box(0.78, 0.95, 0.68, { color: palette.surface, position: [-1.15, 0, -0.75] }));
  parts.push(box(0.82, 0.1, 0.7, { color: palette.surfaceAlt, position: [-1.15, 0.95, -0.75], grad: [0.5, 1] }));
  parts.push(box(0.82, 0.18, 0.46, { color: palette.dark, position: [-1.15, 1.05, -0.85], grad: [0.5, 1] }));
  parts.push(
    box(0.34, 0.13, 0.02, {
      color: palette.screen,
      emissive: 1,
      position: [-0.97, 1.05, -0.44],
      rotation: [-0.9, 0, 0],
      grad: [0.85, 1],
    }),
  );
  parts.push(box(0.62, 0.05, 0.3, { color: palette.metal, position: [-1.15, 0.6, -0.3], grad: [0.8, 1] }));
  parts.push(box(0.46, 0.02, 0.34, { color: palette.paper, position: [-1.15, 0.65, -0.26], rotation: [0.06, 0, 0], grad: [0.95, 1] }));

  // Server rack. A single column of lights, not a grid: one legible vertical
  // stripe of glow at distance beats a wall of dots that averages to a smear.
  parts.push(box(0.76, 1.9, 0.62, { color: palette.dark, position: [0.15, 0, -0.85] }));
  parts.push(box(0.64, 1.74, 0.04, { color: palette.surfaceAlt, position: [0.15, 0.08, -0.53], grad: [0.35, 1] }));
  const lamps = [palette.screen, palette.screen, palette.accent];
  for (let i = 0; i < 8; i++) {
    parts.push(
      box(0.09, 0.09, 0.03, {
        color: pick(lamps, i + seed, palette.screen),
        emissive: 1,
        position: [-0.03, 0.28 + i * 0.2, -0.5],
        grad: [0.9, 1],
      }),
    );
  }

  // Workbench: two standing places, so a pair of Bash calls doesn't queue up.
  parts.push(box(1.3, 0.09, 0.72, { color: palette.surface, position: [1.25, 0.81, -0.7], grad: [0.6, 1] }));
  for (const dx of [-0.54, 0.54] as const) {
    parts.push(box(0.12, 0.81, 0.62, { color: palette.dark, position: [1.25 + dx, 0, -0.7] }));
  }
  parts.push(box(1.3, 0.55, 0.06, { color: palette.surfaceAlt, position: [1.25, 0.9, -1.0], grad: [0.5, 1] }));
  parts.push(box(0.22, 0.16, 0.2, { color: palette.metal, position: [0.88, 0.9, -0.55], grad: [0.5, 1] }));
  parts.push(box(0.3, 0.18, 0.26, { color: palette.surfaceAlt, position: [1.6, 0.9, -0.62], grad: [0.5, 1] }));

  return {
    geometry: buildProp(parts),
    slots: [
      { kind: 'copier', position: [-1.15, 0, 0.05], facing: Math.PI },
      { kind: 'rack', position: [0.15, 0, 0.05], facing: Math.PI },
      { kind: 'bench', position: [0.9, 0, 0.05], facing: Math.PI },
      { kind: 'bench', position: [1.65, 0, 0.05], facing: Math.PI },
    ],
    footprint: [3.9, 2.4],
  };
}
