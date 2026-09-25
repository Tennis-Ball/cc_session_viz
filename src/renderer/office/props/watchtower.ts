import { box, buildProp, cone, cylinder, torus, type Part } from './kit';
import type { PropBuild, PropOptions, PropPalette } from './types';

/** Radius the spiral treads orbit at, and how many of them climb the shaft. */
const STEP_RADIUS = 0.58;
const STEP_COUNT = 12;
/** Deck top, which is also the height the three lookout slots stand at. */
const DECK_TOP = 2.32;
const DECK_SLOTS = 3;
const DECK_SLOT_RADIUS = 0.42;

/**
 * The watchtower: where an agent goes to wait on something that is running.
 *
 * The three lookout slots are the one place in the office a figure stands above
 * the platform, so their slot positions carry a real Y. Anything walking here
 * has to climb; the spiral is a literal path and not decoration.
 */
export function buildWatchtower(palette: PropPalette, options: PropOptions = {}): PropBuild {
  // The spiral's starting angle is seeded so the stair mouth can be turned to
  // face whichever way the platform's bridge arrives from.
  const phase = ((Math.trunc(options.seed ?? 0) % 8) * Math.PI) / 4;
  const parts: Part[] = [];

  // Shaft: two tapered drums rather than one, so the silhouette has a waist.
  parts.push(cylinder(0.46, 1.3, { color: palette.surface, position: [0, 0, 0] }, 12, 0.4));
  parts.push(cylinder(0.4, 0.9, { color: palette.surface, position: [0, 1.3, 0] }, 12, 0.36));

  // Spiral treads. Each is turned to its own angle so its long axis runs
  // radially — a tread square to the world reads as debris stuck to the tower.
  for (let i = 0; i < STEP_COUNT; i++) {
    const angle = phase + i * 0.62;
    parts.push(
      box(0.3, 0.1, 0.34, {
        color: palette.surfaceAlt,
        position: [Math.sin(angle) * STEP_RADIUS, 0.14 + i * 0.155, Math.cos(angle) * STEP_RADIUS],
        rotation: [0, angle, 0],
        grad: [0.3, 1],
      }),
    );
  }

  // Lookout deck, carried on a flared corbel so the overhang looks supported.
  parts.push(cylinder(0.42, 0.18, { color: palette.surfaceAlt, position: [0, 2.02, 0], grad: [0.4, 1] }, 16, 0.92));
  parts.push(cylinder(0.92, 0.12, { color: palette.surface, position: [0, 2.2, 0], grad: [0.5, 1] }, 16));

  // Rail: four posts off the diagonals, clear of the bell, plus one ring.
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI / 4 + (i * Math.PI) / 2;
    parts.push(
      box(0.07, 0.42, 0.07, {
        color: palette.dark,
        position: [Math.sin(angle) * 0.8, DECK_TOP, Math.cos(angle) * 0.8],
        rotation: [0, angle, 0],
        grad: [0.5, 1],
      }),
    );
  }
  parts.push(torus(0.82, 0.045, { color: palette.metal, position: [0, 2.72, 0], rotation: [Math.PI / 2, 0, 0], grad: [0.8, 1] }, 20));

  // Bell, hung off the deck edge over the drop rather than standing on it, so
  // the three lookout places stay clear.
  parts.push(box(0.09, 0.72, 0.09, { color: palette.dark, position: [0, DECK_TOP, -0.78], grad: [0.5, 1] }));
  parts.push(box(0.09, 0.08, 0.5, { color: palette.dark, position: [0, 2.96, -0.83], grad: [0.9, 1] }));
  parts.push(cone(0.2, 0.28, { color: palette.metal, position: [0, 2.66, -0.95], grad: [0.6, 1] }, 14));

  // Moon-phase dial: a disc laid against the shaft with one lit moon on it. The
  // only glow on the tower, so "watching" has a colour at night.
  parts.push(cylinder(0.3, 0.06, { color: palette.paper, position: [0, 1.5, 0.38], rotation: [Math.PI / 2, 0, 0], grad: [0.7, 1] }, 16));
  parts.push(
    cylinder(
      0.12,
      0.04,
      { color: palette.screen, emissive: 0.7, position: [0.08, 1.56, 0.43], rotation: [Math.PI / 2, 0, 0], grad: [0.9, 1] },
      12,
    ),
  );

  const slots: PropBuild['slots'] = [];
  for (let i = 0; i < DECK_SLOTS; i++) {
    const angle = (i * 2 * Math.PI) / DECK_SLOTS;
    slots.push({
      kind: 'deck',
      // Facing outward: a watcher is looking at the horizon, not at the mast.
      position: [Math.sin(angle) * DECK_SLOT_RADIUS, DECK_TOP, Math.cos(angle) * DECK_SLOT_RADIUS],
      facing: angle,
    });
  }

  return { geometry: buildProp(parts), slots, footprint: [2.4, 2.4] };
}
