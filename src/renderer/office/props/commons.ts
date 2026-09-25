import { box, buildProp, cylinder, type Part } from './kit';
import type { PropBuild, PropOptions, PropPalette } from './types';

/** Seats around the round table. */
const COMMONS_SEATS = 6;
const COMMONS_SEAT_RADIUS = 1.18;
/** Chair x positions along one side of the war room table. */
const WAR_SEAT_X: readonly number[] = [-0.78, -0.26, 0.26, 0.78];
/** [z of the chair row, yaw a figure faces there]. */
const WAR_ROWS: ReadonlyArray<readonly [number, number]> = [
  [0.78, Math.PI],
  [-0.78, 0],
];

/**
 * The commons: a round table an agent sits at while its subagents work.
 *
 * Round on purpose — delegation has no head of the table, and a circle of six
 * identical chairs reads as a group from above, which is the only angle the
 * isometric camera ever gives you.
 */
export function buildCommons(palette: PropPalette, options: PropOptions = {}): PropBuild {
  // The circle is rotated by the seed so neighbouring commons platforms don't
  // line their chairs up into an accidental grid.
  const phase = ((Math.trunc(options.seed ?? 0) % COMMONS_SEATS) * Math.PI) / COMMONS_SEATS;
  const parts: Part[] = [];
  const slots: PropBuild['slots'] = [];

  parts.push(cylinder(0.42, 0.06, { color: palette.dark, position: [0, 0, 0] }, 16));
  parts.push(cylinder(0.14, 0.64, { color: palette.dark, position: [0, 0, 0] }, 12));
  parts.push(cylinder(0.82, 0.08, { color: palette.surface, position: [0, 0.64, 0], grad: [0.6, 1] }, 20));

  for (let i = 0; i < COMMONS_SEATS; i++) {
    const angle = phase + (i * 2 * Math.PI) / COMMONS_SEATS;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const x = sin * COMMONS_SEAT_RADIUS;
    const z = cos * COMMONS_SEAT_RADIUS;

    parts.push(cylinder(0.05, 0.42, { color: palette.dark, position: [x, 0, z] }, 8));
    parts.push(cylinder(0.21, 0.07, { color: palette.surfaceAlt, position: [x, 0.42, z], grad: [0.5, 1] }, 12));
    // The back sits a little further out than the seat and is turned tangentially,
    // which is what stops six cylinders from reading as six bollards.
    parts.push(
      box(0.36, 0.34, 0.07, {
        color: palette.surfaceAlt,
        position: [sin * 1.38, 0.49, cos * 1.38],
        rotation: [0, angle, 0],
        grad: [0.4, 1],
      }),
    );

    slots.push({ kind: 'tableSeat', position: [x, 0, z], facing: angle + Math.PI, seat: 0.4 });
  }

  return { geometry: buildProp(parts), slots, footprint: [3.2, 3.2] };
}

/**
 * The war room: a long table, eight places, and a board of four phase columns.
 *
 * The columns are emissive so a workflow's progress is readable as light from
 * across the office. They light as a set rather than individually — a prop is
 * one merged geometry, so per-phase control would cost the single draw call
 * this whole kit is built around.
 */
export function buildWarRoom(palette: PropPalette, options: PropOptions = {}): PropBuild {
  const seed = Math.trunc(options.seed ?? 0);
  const parts: Part[] = [];
  const slots: PropBuild['slots'] = [];

  parts.push(box(2.3, 0.09, 0.95, { color: palette.surface, position: [0, 0.63, 0], grad: [0.6, 1] }));
  for (const dx of [-0.95, 0.95] as const) {
    parts.push(box(0.16, 0.63, 0.8, { color: palette.dark, position: [dx, 0, 0] }));
  }

  for (const [z, facing] of WAR_ROWS) {
    const side = Math.sign(z);
    for (const x of WAR_SEAT_X) {
      parts.push(cylinder(0.05, 0.4, { color: palette.dark, position: [x, 0, z] }, 8));
      parts.push(box(0.36, 0.07, 0.36, { color: palette.surfaceAlt, position: [x, 0.4, z], grad: [0.5, 1] }));
      parts.push(
        box(0.34, 0.3, 0.07, {
          color: palette.surfaceAlt,
          position: [x, 0.47, z + side * 0.21],
          rotation: [side * 0.12, 0, 0],
          grad: [0.4, 1],
        }),
      );
      slots.push({ kind: 'warTableSeat', position: [x, 0, z], facing, seat: 0.4 });
    }
  }

  // Phase board, standing at the head of the table so every seat faces it.
  parts.push(box(0.5, 0.08, 0.5, { color: palette.dark, position: [1.55, 0, -0.1] }));
  parts.push(box(0.16, 0.95, 0.3, { color: palette.dark, position: [1.55, 0.08, -0.1] }));
  parts.push(box(0.09, 1.1, 1.36, { color: palette.dark, position: [1.55, 0.95, -0.1], grad: [0.5, 1] }));
  // Columns rise from a shared baseline like a bar chart, so how far a workflow
  // has got is legible as silhouette. Height carries it rather than colour: a
  // theme is free to resolve `screen` and `accent` to the same value, and often
  // does, which would flatten any purely chromatic distinction.
  const reached = ((((seed % 4) + 4) % 4) as 0 | 1 | 2 | 3) + 1;
  for (let i = 0; i < 4; i++) {
    const done = i < reached;
    parts.push(
      box(0.03, done ? 0.9 : 0.34, 0.26, {
        color: done ? palette.accent : palette.screen,
        emissive: 1,
        position: [1.49, 1.05, -0.1 + (i - 1.5) * 0.32],
        grad: [0.85, 1],
      }),
    );
  }

  return { geometry: buildProp(parts), slots, footprint: [3.8, 2.8] };
}
