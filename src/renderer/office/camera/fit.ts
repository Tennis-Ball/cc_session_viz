/**
 * Framing the office.
 *
 * The camera orbits at a fixed distance, so "zoom to fit" is a projection
 * problem rather than a dolly: work out how much of the screen the campus
 * covers at the current angle, and pick the orthographic zoom that fills the
 * window.
 *
 * It fits against the platforms themselves rather than one bounding box around
 * everything. A box around a ring of terraces is mostly empty air, and fitting
 * to the air is how you end up with a small office in a big sky.
 *
 * Pure, so the framing can be asserted at every angle without a renderer.
 */

export type Point = [number, number, number];

export interface Viewport {
  width: number;
  height: number;
}

export interface View {
  zoom: number;
  /** Where the camera should look, so the campus sits in the middle. */
  centre: Point;
}

/**
 * The camera's screen axes for an orbit at (azimuth, polar), matching
 * three.js `lookAt` with a world up of +Y.
 */
export function screenBasis(azimuth: number, polar: number): { right: Point; up: Point } {
  const sa = Math.sin(azimuth);
  const ca = Math.cos(azimuth);
  const sp = Math.sin(polar);
  const cp = Math.cos(polar);
  return {
    right: [ca, 0, -sa],
    up: [-cp * sa, sp, -cp * ca],
  };
}

/** The 8 corners of an axis-aligned box, ready to hand to `fitView`. */
export function boxCorners(min: Point, max: Point): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < 8; i++) {
    out.push([i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]);
  }
  return out;
}

const FALLBACK: View = { zoom: 24, centre: [0, 0, 0] };

/**
 * Zoom and pivot that frame `points` in `viewport` at this angle.
 *
 * `fill` leaves a margin: at 1 the campus touches the window edges, which looks
 * cramped and clips the labels that sit just outside a platform's footprint.
 */
export function fitView(points: Point[], azimuth: number, polar: number, viewport: Viewport, fill = 0.96): View {
  if (points.length === 0) return FALLBACK;

  const { right, up } = screenBasis(azimuth, polar);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    const sx = point[0] * right[0] + point[1] * right[1] + point[2] * right[2];
    const sy = point[0] * up[0] + point[1] * up[1] + point[2] * up[2];
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  }

  const halfX = Math.max((maxX - minX) / 2, 0.001);
  const halfY = Math.max((maxY - minY) / 2, 0.001);
  const zoom = Math.min(((viewport.width / 2) * fill) / halfX, ((viewport.height / 2) * fill) / halfY);

  // The pivot is the middle of what the camera can see, expressed back in world
  // space along the screen axes. Recomputed per angle, so the office stays
  // centred as you orbit instead of drifting into a corner.
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    zoom,
    centre: [
      right[0] * cx + up[0] * cy,
      right[1] * cx + up[1] * cy,
      right[2] * cx + up[2] * cy,
    ],
  };
}
