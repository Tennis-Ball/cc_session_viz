import { box, buildProp, cylinder, sphere, type Part } from './kit';
import type { PropBuild, PropOptions, PropPalette } from './types';

/**
 * A session's home desk: where writing and editing happen.
 *
 * The paper stack is the one prop that carries live data — its height is the
 * session's context fill — so it is built separately and scaled at runtime.
 */
export function buildDeskPod(palette: PropPalette, options: PropOptions = {}): PropBuild {
  const tint = options.tint ?? palette.accent;
  const parts: Part[] = [];

  // Desk: a top on two plinths, kept chunky so it reads at a distance.
  parts.push(box(1.7, 0.08, 0.8, { color: palette.surface, position: [0, 0.64, 0], grad: [0.6, 1] }));
  parts.push(box(0.12, 0.64, 0.7, { color: palette.dark, position: [-0.72, 0, 0] }));
  parts.push(box(0.12, 0.64, 0.7, { color: palette.dark, position: [0.72, 0, 0] }));

  // Monitor, angled slightly, with an emissive face in the session color.
  parts.push(box(0.1, 0.22, 0.1, { color: palette.dark, position: [0, 0.72, -0.18] }));
  parts.push(box(0.66, 0.4, 0.05, { color: palette.dark, position: [0, 0.94, -0.2], rotation: [-0.12, 0, 0] }));
  parts.push(
    box(0.6, 0.34, 0.02, {
      color: tint,
      emissive: 1,
      position: [0, 0.97, -0.17],
      rotation: [-0.12, 0, 0],
      grad: [0.8, 1],
    }),
  );

  // Chair: seat, back, single post.
  parts.push(cylinder(0.06, 0.34, { color: palette.dark, position: [0, 0, 0.72] }, 10));
  parts.push(box(0.46, 0.08, 0.44, { color: palette.surfaceAlt, position: [0, 0.34, 0.72] }));
  parts.push(box(0.44, 0.42, 0.08, { color: palette.surfaceAlt, position: [0, 0.42, 0.94], rotation: [0.1, 0, 0] }));

  // Desk lamp: the office's night light.
  parts.push(cylinder(0.07, 0.03, { color: palette.metal, position: [-0.62, 0.72, -0.12] }, 10));
  parts.push(cylinder(0.015, 0.3, { color: palette.metal, position: [-0.62, 0.74, -0.12] }, 6));
  parts.push(
    cylinder(0.11, 0.1, { color: palette.metal, emissive: 0.8, position: [-0.58, 1.02, -0.1], rotation: [0.5, 0, 0] }, 10, 0.05),
  );

  // Inbox tray for queued prompts, and a plant, because every desk has one.
  parts.push(box(0.3, 0.04, 0.22, { color: palette.metal, position: [0.6, 0.72, 0.1] }));
  parts.push(cylinder(0.1, 0.16, { color: palette.surfaceAlt, position: [0.72, 0.72, -0.22] }, 10));
  parts.push(sphere(0.14, { color: palette.plant, position: [0.72, 0.96, -0.22] }, 12));

  return {
    geometry: buildProp(parts),
    slots: [{ kind: 'deskSeat', position: [0, 0, 0.72], facing: Math.PI, seat: 0.42 }],
    footprint: [2.2, 2.2],
  };
}

/**
 * The paper stack that shows context fill. Built at full height and scaled on
 * the Y axis, so one geometry serves every session.
 */
export function buildPaperStack(palette: PropPalette): PropBuild {
  const parts: Part[] = [];
  const sheets = 10;
  for (let i = 0; i < sheets; i++) {
    parts.push(
      box(0.26, 0.012, 0.2, {
        color: i % 2 === 0 ? palette.paper : palette.surfaceAlt,
        position: [0, i * 0.014, 0],
        grad: [0.85, 1],
      }),
    );
  }
  return { geometry: buildProp(parts), slots: [], footprint: [0.3, 0.3] };
}
