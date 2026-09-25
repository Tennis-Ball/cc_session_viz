import { box, buildProp, cylinder, sphere, type Part } from './kit';
import type { PropBuild, PropOptions, PropPalette } from './types';

/** Where the arch sits; the telescope aims through its opening. */
const ARCH_Z = -0.2;
/** Tripod centre, and how far its feet splay from it. */
const TRIPOD: readonly [number, number] = [0.05, 0.45];
const FOOT_RADIUS = 0.32;
const LEG_LEAN = 0.32;
/** Barrel aim, as an XZ Euler pair: up, out through the arch, and a little east. */
const AIM: readonly [number, number] = [-0.8, -0.25];

/**
 * The observatory: one instrument under one arch, and nothing else.
 *
 * The archway is the only piece of the office that is pure architecture rather
 * than furniture, so it earns the height — it is the silhouette that tells you
 * where the edge of the world is. Everything else here stays low on purpose.
 */
export function buildObservatory(palette: PropPalette, options: PropOptions = {}): PropBuild {
  // Seeded so a second observatory can lean its arch the other way later; for
  // now it only nudges the barrel, which is enough to break up a repeated zone.
  const drift = (Math.trunc(options.seed ?? 0) % 3) * 0.04;
  const parts: Part[] = [];

  // Archway: two piers and a corbelled span. Each course steps in by less than
  // its own width so the stack stays visually continuous from any angle.
  for (const x of [-1.15, 1.15] as const) {
    parts.push(box(0.55, 1.9, 0.55, { color: palette.surface, position: [x, 0, ARCH_Z] }));
    parts.push(box(0.55, 0.28, 0.55, { color: palette.surfaceAlt, position: [x, 1.9, ARCH_Z], grad: [0.5, 1] }));
    parts.push(box(0.55, 0.28, 0.55, { color: palette.surfaceAlt, position: [x * 0.678, 2.18, ARCH_Z], grad: [0.5, 1] }));
  }
  parts.push(box(1.06, 0.28, 0.55, { color: palette.accent, position: [0, 2.46, ARCH_Z], grad: [0.6, 1] }));

  // Tripod. Each leg is planted on its splay circle and rotated back toward the
  // centre, so all three tops meet without a separate mount block.
  const [cx, cz] = TRIPOD;
  for (let i = 0; i < 3; i++) {
    const phi = Math.PI / 2 + (i * 2 * Math.PI) / 3;
    parts.push(
      cylinder(
        0.045,
        1.0,
        {
          color: palette.dark,
          position: [cx + Math.cos(phi) * FOOT_RADIUS, 0, cz + Math.sin(phi) * FOOT_RADIUS],
          rotation: [0, -phi, LEG_LEAN],
        },
        8,
      ),
    );
  }
  parts.push(sphere(0.1, { color: palette.metal, position: [cx, 0.95, cz] }, 12));

  // Barrel, plus the flared hood that makes it read as a lens and not a pipe.
  const pitch = AIM[0] + drift;
  const yawTilt = AIM[1];
  const dir: readonly [number, number, number] = [
    -Math.sin(yawTilt),
    Math.cos(pitch) * Math.cos(yawTilt),
    Math.sin(pitch) * Math.cos(yawTilt),
  ];
  const along = (t: number): [number, number, number] => [cx + dir[0] * t, 0.9 + dir[1] * t, cz + dir[2] * t];
  parts.push(cylinder(0.13, 1.1, { color: palette.surfaceAlt, position: along(0), rotation: [pitch, 0, yawTilt], grad: [0.6, 1] }, 12));
  parts.push(cylinder(0.13, 0.2, { color: palette.dark, position: along(1.02), rotation: [pitch, 0, yawTilt], grad: [0.7, 1] }, 12, 0.19));
  parts.push(cylinder(0.055, 0.2, { color: palette.metal, position: along(-0.22), rotation: [pitch, 0, yawTilt], grad: [0.7, 1] }, 8));

  // Low bench, kept below knee-of-the-arch height so it never competes.
  parts.push(box(1.5, 0.1, 0.42, { color: palette.surface, position: [0, 0.38, 1.15], grad: [0.5, 1] }));
  for (const x of [-0.58, 0.58] as const) {
    parts.push(box(0.14, 0.38, 0.4, { color: palette.dark, position: [x, 0, 1.15] }));
  }

  return {
    geometry: buildProp(parts),
    slots: [{ kind: 'telescope', position: [0.05, 0, 0.85], facing: Math.PI }],
    footprint: [3.2, 2.8],
  };
}
