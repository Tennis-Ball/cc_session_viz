import { levelY } from './campusTemplate';
import type { Campus, Platform } from './layout';
import type { Occupancy } from './occupancy';

/**
 * Getting from anywhere to anywhere.
 *
 * Two layers, because the problem really is two problems:
 *
 * 1. *Which platforms* — a small graph over the ends of every walkway.
 * 2. *Where exactly, on each one* — the platform's own occupancy grid, so the
 *    route bends around the furniture instead of through it.
 *
 * Stairs and bridges are crossed as single straight segments, which is correct:
 * they are one cell wide and there is nothing on them.
 */

export type Vec3 = [number, number, number];

interface Node {
  id: string;
  platform: string;
  position: Vec3;
  /** The node at the other end of the same walkway. */
  twin: string;
  /** Points to pass through on the way to the twin, in that order. */
  via: Vec3[];
}

export class NavGraph {
  private readonly nodes = new Map<string, Node>();
  private readonly onPlatform = new Map<string, string[]>();
  private readonly platforms = new Map<string, Platform>();
  private readonly hops = new Map<string, string[] | null>();

  constructor(
    campus: Campus,
    private readonly occupancy: Map<string, Occupancy> = new Map(),
  ) {
    for (const platform of campus.platforms) {
      this.platforms.set(platform.id, platform);
      this.onPlatform.set(platform.id, []);
    }

    for (const connector of campus.connectors) {
      const entry = `${connector.id}:a`;
      const exit = `${connector.id}:b`;
      const via = connector.via ?? [];
      this.addNode({ id: entry, platform: connector.from, position: connector.a, twin: exit, via });
      this.addNode({ id: exit, platform: connector.to, position: connector.b, twin: entry, via: [...via].reverse() });
    }
  }

  /** Does this graph still know the platform? False after a campus rebuild. */
  has(platformId: string): boolean {
    return this.platforms.has(platformId);
  }

  /**
   * The platform a point is standing on, or the closest one.
   *
   * A figure whose desk was removed keeps its old platform id; asking where it
   * actually is gets it back onto the walkways instead of routing it from a
   * platform that no longer exists.
   */
  nearestPlatform(point: Vec3): string | null {
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const platform of this.platforms.values()) {
      // Height counts, and counts heavily. Terraces stack now, so a point can
      // be directly above one platform and directly below another; measuring
      // in plan alone picks whichever of the two happens to be nearer in x/z,
      // which is a coin toss, and the loser sends the figure through a floor.
      const flat = Math.hypot(platform.position[0] - point[0], platform.position[1] - point[2]);
      const d = flat + Math.abs(levelY(platform.level) - point[1]) * 3;
      if (d < bestDistance) {
        bestDistance = d;
        best = platform.id;
      }
    }
    return best;
  }

  /** The nearest spot on a platform where a figure can actually stand. */
  standable(platformId: string, point: Vec3): Vec3 {
    const grid = this.occupancy.get(platformId);
    const platform = this.platforms.get(platformId);
    if (!grid || !platform) return point;
    const [x, z] = grid.nearestFree(point[0], point[2]);
    return [x, levelY(platform.level), z];
  }

  /** A walkable route from one point to another, in world space. */
  path(fromPlatform: string, from: Vec3, toPlatform: string, to: Vec3): Vec3[] {
    if (fromPlatform === toPlatform) return this.walk(fromPlatform, from, to);

    const hops = this.hopsBetween(fromPlatform, toPlatform);
    // No route (a platform with no walkway yet): go straight rather than
    // freeze. It reads as a shortcut, and it cannot happen on a built campus.
    if (!hops) return [from, to];

    const points: Vec3[] = [];
    let cursor = from;
    let platform = fromPlatform;

    for (let i = 0; i < hops.length; i += 2) {
      const entry = this.nodes.get(hops[i]!);
      const exit = this.nodes.get(hops[i + 1]!);
      if (!entry || !exit) break;
      // Across this platform to the foot of the walkway…
      points.push(...this.walk(platform, cursor, entry.position));
      // …then over it, by way of whatever it insists on. A straight flight
      // insists on nothing; a lift insists on the inside of its own shaft.
      points.push(...entry.via, exit.position);
      cursor = exit.position;
      platform = exit.platform;
    }

    points.push(...this.walk(platform, cursor, to));
    return dedupe(points);
  }

  /**
   * A leg across one platform, at that platform's floor height — except at the
   * ends, which keep the heights they were given.
   *
   * Flattening every point used to be right, because every point was on a
   * floor. It is not any more: the start can be halfway up a flight (a figure
   * re-routed mid-crossing), and the end can be a raised anchor like the
   * pedestal's plinth. Rewriting either to the deck teleported the figure —
   * off the stairs on one side, off the plinth on the other.
   */
  private walk(platformId: string, from: Vec3, to: Vec3): Vec3[] {
    const grid = this.occupancy.get(platformId);
    const platform = this.platforms.get(platformId);
    const y = platform ? levelY(platform.level) : from[1];
    if (!grid) return [from, to];
    const points = grid.route([from[0], from[2]], [to[0], to[2]]).map(([x, z]) => [x, y, z] as Vec3);
    const first = points[0];
    const last = points[points.length - 1];
    if (first) first[1] = from[1];
    if (last) last[1] = to[1];
    return points;
  }

  private addNode(node: Node): void {
    if (this.nodes.has(node.id)) return;
    this.nodes.set(node.id, node);
    this.onPlatform.get(node.platform)?.push(node.id);
  }

  /**
   * The sequence of walkway crossings between two platforms, as pairs of
   * (this side, far side). Cached: figures ask for the same routes constantly.
   */
  private hopsBetween(from: string, to: string): string[] | null {
    const key = `${from}->${to}`;
    const cached = this.hops.get(key);
    if (cached !== undefined) return cached;
    const found = this.search(from, to);
    this.hops.set(key, found);
    return found;
  }

  /** Dijkstra over walkway ends. A few dozen nodes, so a sorted list is fine. */
  private search(fromPlatform: string, toPlatform: string): string[] | null {
    const dist = new Map<string, number>();
    const prev = new Map<string, string>();
    const frontier: string[] = [];

    for (const id of this.onPlatform.get(fromPlatform) ?? []) {
      dist.set(id, this.spanOf(fromPlatform, id));
      frontier.push(id);
    }
    if (frontier.length === 0) return null;

    let goal: string | null = null;
    const visited = new Set<string>();

    while (frontier.length > 0) {
      let best = 0;
      for (let i = 1; i < frontier.length; i++) {
        if ((dist.get(frontier[i]!) ?? Infinity) < (dist.get(frontier[best]!) ?? Infinity)) best = i;
      }
      const current = frontier.splice(best, 1)[0]!;
      if (visited.has(current)) continue;
      visited.add(current);

      const node = this.nodes.get(current);
      if (!node) continue;

      const twin = this.nodes.get(node.twin);
      if (!twin) continue;

      const crossing = distance(node.position, twin.position);
      const twinCost = (dist.get(current) ?? Infinity) + crossing;
      if (twinCost < (dist.get(twin.id) ?? Infinity)) {
        dist.set(twin.id, twinCost);
        prev.set(twin.id, current);
        frontier.push(twin.id);
      }

      if (twin.platform === toPlatform) {
        goal = twin.id;
        break;
      }

      // Walk across the platform we just landed on to its other walkways.
      for (const id of this.onPlatform.get(twin.platform) ?? []) {
        if (id === twin.id) continue;
        const next = this.nodes.get(id);
        if (!next) continue;
        const cost = twinCost + distance(twin.position, next.position);
        if (cost < (dist.get(id) ?? Infinity)) {
          dist.set(id, cost);
          prev.set(id, twin.id);
          frontier.push(id);
        }
      }
    }

    if (!goal) return null;

    const chain: string[] = [];
    let cursor: string | undefined = goal;
    while (cursor) {
      chain.unshift(cursor);
      cursor = prev.get(cursor);
    }
    // The chain alternates (near side, far side); anything else means a walk
    // across a platform, which `walk()` fills in.
    return chain;
  }

  /** Distance from a platform's notional middle to one of its walkway ends. */
  private spanOf(platformId: string, nodeId: string): number {
    const platform = this.platforms.get(platformId);
    const node = this.nodes.get(nodeId);
    if (!platform || !node) return 0;
    return Math.hypot(platform.position[0] - node.position[0], platform.position[1] - node.position[2]);
  }
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Consecutive duplicates come out of stitching legs together. */
function dedupe(points: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - point[0]) < 0.01 && Math.abs(last[1] - point[1]) < 0.01 && Math.abs(last[2] - point[2]) < 0.01) {
      continue;
    }
    out.push(point);
  }
  return out;
}

/** Total length of a polyline, used to pace walking animations. */
export function pathLength(points: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1]!, points[i]!);
  return total;
}

/** Position at distance `travelled` along a polyline, plus the heading there. */
export function pointAlong(points: Vec3[], travelled: number): { position: Vec3; heading: number } {
  let remaining = travelled;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const segment = distance(a, b);
    if (remaining <= segment || i === points.length - 1) {
      const t = segment === 0 ? 0 : Math.min(1, remaining / segment);
      return {
        position: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
        heading: Math.atan2(b[0] - a[0], b[2] - a[2]),
      };
    }
    remaining -= segment;
  }
  const last = points[points.length - 1] ?? [0, 0, 0];
  return { position: last, heading: 0 };
}
