import { box, buildProp, cone, cylinder, sphere, torus, type Part } from './kit';
import type { PropBuild, PropOptions, PropPalette } from './types';

const SOFA_X = -0.55;
const SOFA_Z = -0.55;
/** Cushion centres, which double as the two seated slot positions. */
const CUSHION_DX: readonly number[] = [-0.38, 0.38];

/**
 * The lounge: where idle and offline sessions go.
 *
 * Deliberately the softest zone — rounded plant, a rug that grounds the group,
 * and the only furniture in the office nobody works at. The rug is what makes
 * five scattered objects read as one room without needing walls.
 */
export function buildLounge(palette: PropPalette, options: PropOptions = {}): PropBuild {
  // The seed only swaps which plant is which shape, so two lounges side by side
  // don't mirror each other exactly.
  const flip = ((Math.trunc(options.seed ?? 0) % 2) + 2) % 2 === 1;
  const parts: Part[] = [];

  parts.push(box(2.4, 0.03, 1.8, { color: palette.surfaceAlt, position: [0, 0, 0.3], grad: [0.9, 1] }));

  // Two-seat sofa: one mass, two cushions, a reclined back and two arms.
  parts.push(box(1.6, 0.34, 0.72, { color: palette.surface, position: [SOFA_X, 0, SOFA_Z] }));
  for (const dx of CUSHION_DX) {
    parts.push(box(0.66, 0.14, 0.6, { color: palette.surfaceAlt, position: [SOFA_X + dx, 0.34, SOFA_Z], grad: [0.5, 1] }));
  }
  parts.push(box(1.6, 0.5, 0.18, { color: palette.surface, position: [SOFA_X, 0.34, -0.9], rotation: [-0.1, 0, 0], grad: [0.4, 1] }));
  for (const dx of [-0.72, 0.72] as const) {
    parts.push(box(0.16, 0.24, 0.72, { color: palette.surface, position: [SOFA_X + dx, 0.34, SOFA_Z], grad: [0.4, 1] }));
  }

  // Coffee machine on a low cabinet, with one cup under the group head.
  parts.push(box(0.8, 0.62, 0.5, { color: palette.surface, position: [1.15, 0, -0.75] }));
  parts.push(box(0.34, 0.4, 0.3, { color: palette.dark, position: [1.15, 0.62, -0.78], grad: [0.5, 1] }));
  parts.push(box(0.18, 0.1, 0.16, { color: palette.metal, position: [1.15, 0.78, -0.62], grad: [0.8, 1] }));
  parts.push(cylinder(0.05, 0.09, { color: palette.paper, position: [1.15, 0.62, -0.58], grad: [0.7, 1] }, 10));

  // Water cooler: body, inverted bottle, tap.
  parts.push(box(0.36, 0.95, 0.36, { color: palette.surface, position: [1.6, 0, 0.3] }));
  parts.push(cylinder(0.17, 0.44, { color: palette.paper, position: [1.6, 0.95, 0.3], grad: [0.85, 1] }, 12));
  parts.push(box(0.12, 0.1, 0.1, { color: palette.dark, position: [1.6, 0.6, 0.15], grad: [0.8, 1] }));

  // Two plants with different silhouettes, because a pair of identical spheres
  // reads as a mistake from the isometric camera.
  const round: readonly [number, number] = flip ? [1.45, 1.15] : [-1.5, 0.35];
  const spire: readonly [number, number] = flip ? [-1.5, 0.35] : [1.45, 1.15];
  parts.push(cylinder(0.16, 0.26, { color: palette.surfaceAlt, position: [round[0], 0, round[1]] }, 12, 0.19));
  parts.push(sphere(0.26, { color: palette.plant, position: [round[0], 0.52, round[1]] }, 14));
  parts.push(cylinder(0.15, 0.22, { color: palette.surfaceAlt, position: [spire[0], 0, spire[1]] }, 12, 0.17));
  parts.push(cone(0.24, 0.5, { color: palette.plant, position: [spire[0], 0.2, spire[1]] }, 12));
  parts.push(cone(0.15, 0.32, { color: palette.plant, position: [spire[0], 0.56, spire[1]], grad: [0.6, 1] }, 12));

  return {
    geometry: buildProp(parts),
    slots: [
      { kind: 'sofa', position: [SOFA_X + (CUSHION_DX[0] ?? -0.38), 0, SOFA_Z], facing: 0, seat: 0.48 },
      { kind: 'sofa', position: [SOFA_X + (CUSHION_DX[1] ?? 0.38), 0, SOFA_Z], facing: 0, seat: 0.48 },
      // Third idler stands at the coffee machine: the sofa only seats two, and a
      // queue on the armrest looks worse than someone waiting for a refill.
      { kind: 'sofa', position: [1.15, 0, -0.15], facing: Math.PI },
    ],
    footprint: [3.8, 2.8],
  };
}

/**
 * The pedestal an agent stands on when it needs the user.
 *
 * Three shallow steps, deliberately low: the figure has to be raised enough to
 * be findable in a crowded office but not so far that the walk up looks like a
 * climb. The ring at the lip is the halo — the only emissive part of the prop.
 */
export function buildPedestal(palette: PropPalette): PropBuild {
  const parts: Part[] = [
    cylinder(0.85, 0.12, { color: palette.surface, position: [0, 0, 0] }, 20),
    cylinder(0.65, 0.11, { color: palette.surface, position: [0, 0.12, 0], grad: [0.4, 1] }, 20),
    cylinder(0.46, 0.1, { color: palette.surfaceAlt, position: [0, 0.23, 0], grad: [0.5, 1] }, 20),
    torus(0.44, 0.035, { color: palette.screen, emissive: 1, position: [0, 0.33, 0], rotation: [Math.PI / 2, 0, 0], grad: [0.9, 1] }, 24),
  ];

  return {
    geometry: buildProp(parts),
    // The one slot in the office that is off the platform surface: standing on
    // the plinth rather than beside it is the whole point of the prop.
    slots: [{ kind: 'plinth', position: [0, 0.33, 0], facing: 0 }],
    footprint: [2.0, 2.0],
  };
}

/**
 * A bench and a stone hourglass, for sessions that have stopped on an error.
 *
 * Nothing here glows and nothing moves: a stalled agent should look like it has
 * been set down somewhere quiet, not like it is being alarmed at.
 */
export function buildHourglass(palette: PropPalette): PropBuild {
  const parts: Part[] = [];

  parts.push(box(1.2, 0.09, 0.42, { color: palette.surface, position: [-0.4, 0.38, 0], grad: [0.5, 1] }));
  for (const dx of [-0.46, 0.46] as const) {
    parts.push(box(0.13, 0.38, 0.38, { color: palette.dark, position: [-0.4 + dx, 0, 0] }));
  }

  // The two bulbs are the same cone, one of them turned over — which is the
  // reason an hourglass is a good shape for this kit in the first place.
  parts.push(box(0.48, 0.1, 0.48, { color: palette.surface, position: [0.85, 0, 0] }));
  parts.push(cone(0.2, 0.32, { color: palette.metal, position: [0.85, 0.1, 0], grad: [0.5, 1] }, 14));
  parts.push(cone(0.13, 0.15, { color: palette.accent, position: [0.85, 0.1, 0], grad: [0.6, 1] }, 12));
  parts.push(cone(0.2, 0.32, { color: palette.metal, position: [0.85, 0.74, 0], rotation: [Math.PI, 0, 0], grad: [0.5, 1] }, 14));
  parts.push(box(0.48, 0.1, 0.48, { color: palette.surface, position: [0.85, 0.74, 0], grad: [0.8, 1] }));
  for (const dz of [-0.19, 0.19] as const) {
    parts.push(box(0.055, 0.64, 0.055, { color: palette.dark, position: [0.85, 0.1, dz], grad: [0.6, 1] }));
  }

  return {
    geometry: buildProp(parts),
    slots: [{ kind: 'hourglass', position: [-0.4, 0, 0], facing: Math.PI / 2, seat: 0.4 }],
    footprint: [2.4, 1.2],
  };
}
