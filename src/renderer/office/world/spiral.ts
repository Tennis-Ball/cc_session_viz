import type { Connector } from './layout';

/**
 * The shape of a spiral flight, in one place, because two things need it.
 *
 * `Platforms` builds the treads and `layout` builds the route through them,
 * and for as long as those were worked out separately they disagreed: the
 * geometry wound one and a half times round a newel and the walk was the
 * straight line between the two ends, so every figure using a spiral went
 * *through* the post and out the other side. It looked exactly like what it
 * was — somebody walking through a staircase — and no amount of tuning either
 * side would ever have fixed it, because the two were never computing the same
 * curve in the first place.
 *
 * So the curve is computed once, here, and both of them ask.
 */

/** What one step climbs. */
const RISER = 0.24;
/**
 * How far round one step goes, in radians.
 *
 * With the rise fixed, this is what decides whether a flight is a quarter turn
 * of deep treads or three half-turns of shallow ones.
 */
const TURN_PER_TREAD = 0.44;

export interface SpiralShape {
  /** The newel's axis. */
  midX: number;
  midZ: number;
  /** Bottom and top of the flight, as the connector gave them. */
  low: [number, number, number];
  high: [number, number, number];
  rise: number;
  /** Where the first tread points, and how far round the flight goes. */
  start: number;
  sweep: number;
  /** Outer radius of a tread. */
  reach: number;
  treads: number;
  /** Depth of one tread, cut to the arc it has to fill. */
  tread: number;
}

export function spiralShape(connector: Connector): SpiralShape {
  const up = connector.b[1] >= connector.a[1];
  const low = up ? connector.a : connector.b;
  const high = up ? connector.b : connector.a;

  const midX = (low[0] + high[0]) / 2;
  const midZ = (low[2] + high[2]) / 2;
  const rise = high[1] - low[1];
  const alongX = connector.axis === 'x';
  const run = alongX ? Math.abs(high[0] - low[0]) : Math.abs(high[2] - low[2]);

  /**
   * Which way it winds, and why the sweep is an odd number of half turns.
   *
   * A spiral has to land square at both ends, and it does that when its sweep
   * is an odd multiple of half a turn: the low end points one way, the high end
   * exactly opposite, which is where the other platform is. An earlier version
   * swept a fixed 1.35 turns from wherever the low end happened to be, and left
   * the top tread sixty degrees from the platform it was meant to arrive at.
   */
  const turn = fract(low[0] * 2.3 + high[2]) < 0.5 ? 1 : -1;
  const start = Math.atan2(low[2] - midZ, low[0] - midX);
  const treads = Math.max(5, Math.round(rise / RISER));
  const halves = Math.max(1, Math.round((treads * TURN_PER_TREAD) / Math.PI));
  const sweep = Math.PI * (halves % 2 === 0 ? halves + 1 : halves) * turn;

  /**
   * Outer radius of a tread — and it has to be most of the gap.
   *
   * At 0.62 of the half-run this was a corkscrew two and a bit units across in
   * a gap four units wide, and from an isometric camera that is a stack of
   * plates the width of one figure. Worse, the landing at the top is wider than
   * the helix and sits directly over it, so what the window actually showed was
   * two pale slabs with a dark seam between them. A flight has to be the size
   * of the hole it fills.
   */
  const reach = Math.max(1.35, (run / 2) * 0.8);
  /*
   * Cut to the arc it has to fill at the outer end.
   *
   * A tread deeper than that is a tread lying on top of the one below it, which
   * is where the fan came from; shallower and the flight is a ladder with gaps
   * in it. Toward the newel they still overlap, which is exactly what a real
   * spiral tread does and what the newel is there to swallow.
   */
  const tread = Math.max(0.3, 2 * reach * Math.sin(Math.abs(sweep) / treads / 2));

  return { midX, midZ, low, high, rise, start, sweep, reach, treads, tread };
}

/**
 * Where on the helix a tread is centred, as a fraction of `reach`.
 *
 * This is the line a figure walks as well as the middle of the tread, which is
 * the point of having one number: the two cannot drift apart.
 */
export const WALK = 0.62;

/** Where the tread at `t` (0 at the bottom, 1 at the top) sits and which way it points. */
export function spiralStep(shape: SpiralShape, t: number): { at: [number, number, number]; angle: number } {
  const angle = shape.start + shape.sweep * t;
  return {
    at: [
      shape.midX + Math.cos(angle) * shape.reach * WALK,
      shape.low[1] + shape.rise * t,
      shape.midZ + Math.sin(angle) * shape.reach * WALK,
    ],
    angle,
  };
}

/**
 * The way up, as points to walk between.
 *
 * Sampled rather than every tread: the router eases between points and a
 * figure taking twenty-six separate waypoints up a flight moves in visible
 * steps. Eight is enough that the path hugs the helix at this radius, and the
 * two ends are left off because the connector's own ends already carry the
 * heights the platforms are at.
 */
export function spiralVia(connector: Connector): [number, number, number][] {
  const shape = spiralShape(connector);
  const samples = 8;
  const points: [number, number, number][] = [];
  for (let i = 1; i < samples; i += 1) points.push(spiralStep(shape, i / samples).at);
  // `a` is not always the low end, and the route is walked from `a` to `b`.
  return connector.b[1] >= connector.a[1] ? points : points.reverse();
}

function fract(value: number): number {
  return value - Math.floor(value);
}
