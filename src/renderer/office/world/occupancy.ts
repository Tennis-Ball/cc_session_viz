import type { BufferGeometry } from 'three';
import type { Platform } from './layout';

/**
 * What can be walked on, one platform at a time.
 *
 * Figures used to move in straight lines between anchor points, which meant
 * walking through desks, tables and shelves — the one thing that instantly
 * breaks the illusion of a place. This turns each platform's furniture into a
 * small occupancy grid and routes around it.
 *
 * The grid is built from the prop's own triangles rather than a hand-declared
 * footprint, so it is automatically correct for every prop and stays correct
 * when one is redesigned. Only geometry a figure could actually walk into
 * counts: a rug on the floor does not block, and neither does the top of an
 * arch you can walk under.
 */

/** Cell size. Fine enough to slip between table legs, coarse enough to be cheap. */
const CELL = 0.4;
/** Below this is floor decoration; above it is headroom. */
const FLOOR_CLEARANCE = 0.08;
const HEAD_CLEARANCE = 1.5;
/** How far a figure's body reaches from its centre. */
const BODY_RADIUS = 0.42;

/**
 * A declared obstacle, in platform-local coordinates.
 *
 * Furniture is rasterised from its own triangles, which is exact and needs no
 * upkeep. Architecture is declared instead: it is generated from a plan that
 * already knows its own boxes, and going via geometry would tie the nav grid to
 * the palette, so that dusk would reseat everybody.
 */
export interface Blocker {
  x: number;
  z: number;
  halfWidth: number;
  halfDepth: number;
  /** Height above the platform floor. */
  base: number;
  top: number;
}

export interface Occupancy {
  readonly platformId: string;
  /** True if a figure's centre can stand here. */
  isFree(x: number, z: number): boolean;
  /** The closest standable point, for when a slot lands inside furniture. */
  nearestFree(x: number, z: number): [number, number];
  /** A walkable route in world x/z, or a straight line when none is needed. */
  route(from: [number, number], to: [number, number]): [number, number][];
  /**
   * Can a figure get from every one of these points to every other?
   *
   * A flood fill, not a route: the question is whether the walkable floor is
   * one piece, and asking it as a route between each pair is the same answer
   * for a great deal more work. The architecture planner asks it about every
   * platform it builds on, because a colonnade down one side and a pool at
   * one end are each perfectly legal and together seal the ring.
   */
  connects(points: readonly [number, number][]): boolean;
}

/**
 * The prop geometry is in the prop's own coordinates, centred on the platform,
 * so the grid works in those too and converts at its edges. Rasterising local
 * geometry against world coordinates silently shifts every obstacle by the
 * platform's position, and everything downstream then looks almost right.
 */
export function buildOccupancy(
  platform: Platform,
  geometry: BufferGeometry | null,
  /**
   * World x/z points that must stay walkable whatever the furniture says —
   * the mouths of the walkways. A shelf parked across a doorway would make a
   * platform unreachable, and a figure would have to clip through it to leave.
   */
  doorways: [number, number][] = [],
  /** Architecture standing on the platform, declared rather than rasterised. */
  blockers: Blocker[] = [],
): Occupancy {
  const [width, depth] = platform.size;
  const cols = Math.max(1, Math.round(width / CELL));
  const rows = Math.max(1, Math.round(depth / CELL));
  const originX = -width / 2;
  const originZ = -depth / 2;
  const [platformX, platformZ] = platform.position;

  const blocked = new Uint8Array(cols * rows);
  if (geometry) rasterize(geometry, blocked, cols, rows, originX, originZ);
  stamp(blockers, blocked, cols, rows, originX, originZ);
  dilate(blocked, cols, rows, Math.ceil(BODY_RADIUS / CELL));
  for (const [x, z] of doorways) {
    carve(blocked, cols, rows, Math.floor((x - platform.position[0] - originX) / CELL), Math.floor((z - platform.position[1] - originZ) / CELL));
  }

  const index = (col: number, row: number): number => row * cols + col;
  // World in, world out; the grid itself is platform-local. Clamped, because
  // doorways sit exactly on the boundary and would otherwise floor to one cell
  // past the end — which then reads as "nowhere to stand".
  const clamp = (value: number, limit: number): number => Math.min(limit - 1, Math.max(0, value));
  const colOf = (x: number): number => clamp(Math.floor((x - platformX - originX) / CELL), cols);
  const rowOf = (z: number): number => clamp(Math.floor((z - platformZ - originZ) / CELL), rows);
  const centreX = (col: number): number => platformX + originX + (col + 0.5) * CELL;
  const centreZ = (row: number): number => platformZ + originZ + (row + 0.5) * CELL;
  const inside = (col: number, row: number): boolean => col >= 0 && row >= 0 && col < cols && row < rows;

  const free = (col: number, row: number): boolean => inside(col, row) && blocked[index(col, row)] === 0;

  const nearestFreeCell = (col: number, row: number): [number, number] => {
    if (free(col, row)) return [col, row];
    for (let ring = 1; ring < Math.max(cols, rows); ring++) {
      for (let dc = -ring; dc <= ring; dc++) {
        for (let dr = -ring; dr <= ring; dr++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
          if (free(col + dc, row + dr)) return [col + dc, row + dr];
        }
      }
    }
    return [col, row];
  };

  /**
   * Is the straight line between two points walkable?
   *
   * A grid traversal, not point sampling. Sampling a line at fixed intervals
   * can step straight over a cell the line only clips the corner of, however
   * fine the interval — and the smoother trusts this answer completely, so a
   * near-miss here becomes a figure walking through a desk. This visits every
   * cell the segment touches.
   */
  const clearLine = (a: [number, number], b: [number, number]): boolean => {
    let col = colOf(a[0]);
    let row = rowOf(a[1]);
    if (!free(col, row)) return false;

    const endCol = colOf(b[0]);
    const endRow = rowOf(b[1]);
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const stepCol = Math.sign(dx);
    const stepRow = Math.sign(dz);

    // Distances, in units of the segment, to the next cell boundary each way.
    const localX = a[0] - platformX - originX;
    const localZ = a[1] - platformZ - originZ;
    let nextX = stepCol === 0 ? Infinity : ((stepCol > 0 ? col + 1 : col) * CELL - localX) / dx;
    let nextZ = stepRow === 0 ? Infinity : ((stepRow > 0 ? row + 1 : row) * CELL - localZ) / dz;
    const strideX = stepCol === 0 ? Infinity : CELL / Math.abs(dx);
    const strideZ = stepRow === 0 ? Infinity : CELL / Math.abs(dz);

    for (let guard = 0; (col !== endCol || row !== endRow) && guard < cols + rows + 4; guard++) {
      if (Math.abs(nextX - nextZ) < 1e-9 && stepCol !== 0 && stepRow !== 0) {
        // Exactly through a corner. Squeezing between two blocked cells that
        // meet at a point is not walking, it is clipping.
        if (!free(col + stepCol, row) || !free(col, row + stepRow)) return false;
        col += stepCol;
        row += stepRow;
        nextX += strideX;
        nextZ += strideZ;
      } else if (nextX < nextZ) {
        col += stepCol;
        nextX += strideX;
      } else {
        row += stepRow;
        nextZ += strideZ;
      }
      if (!free(col, row)) return false;
    }
    return true;
  };

  return {
    platformId: platform.id,

    isFree(x, z) {
      return free(colOf(x), rowOf(z));
    },

    nearestFree(x, z) {
      const [col, row] = nearestFreeCell(colOf(x), rowOf(z));
      return [centreX(col), centreZ(row)];
    },

    connects(points) {
      if (points.length < 2) return true;
      const cells = points.map(([x, z]) => nearestFreeCell(colOf(x), rowOf(z)));
      const start = cells[0]!;
      if (!free(start[0], start[1])) return false;

      const seen = new Uint8Array(cols * rows);
      const queue: number[] = [index(start[0], start[1])];
      seen[queue[0]!] = 1;
      for (let head = 0; head < queue.length; head++) {
        const at = queue[head]!;
        const col = at % cols;
        const row = (at - col) / cols;
        for (const [dc, dr] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nc = col + dc;
          const nr = row + dr;
          if (!free(nc, nr)) continue;
          const next = index(nc, nr);
          if (seen[next] === 1) continue;
          seen[next] = 1;
          queue.push(next);
        }
      }

      return cells.every(([col, row]) => free(col, row) && seen[index(col, row)] === 1);
    },

    route(from, to) {
      if (clearLine(from, to)) return [from, to];

      const start = nearestFreeCell(colOf(from[0]), rowOf(from[1]));
      const goal = nearestFreeCell(colOf(to[0]), rowOf(to[1]));
      const cells = search(blocked, cols, rows, start, goal);
      // No route at all (a slot walled in by something): go straight rather
      // than freeze. Better a clipped corner than a figure stuck forever.
      if (!cells) return [from, to];

      const points: [number, number][] = [from, ...cells.map(([c, r]) => [centreX(c), centreZ(r)] as [number, number]), to];
      return smooth(points, clearLine);
    },
  };
}

// ---------- building the grid ----------

function rasterize(
  geometry: BufferGeometry,
  blocked: Uint8Array,
  cols: number,
  rows: number,
  originX: number,
  originZ: number,
): void {
  const position = geometry.getAttribute('position');
  if (!position) return;
  const index = geometry.getIndex();
  const count = index ? index.count : position.count;

  for (let i = 0; i < count; i += 3) {
    const a = index ? index.getX(i) : i;
    const b = index ? index.getX(i + 1) : i + 1;
    const c = index ? index.getX(i + 2) : i + 2;

    const ys = [position.getY(a), position.getY(b), position.getY(c)];
    // Anything entirely under your feet or over your head is not in the way.
    if (Math.max(...ys) < FLOOR_CLEARANCE || Math.min(...ys) > HEAD_CLEARANCE) continue;

    const xs = [position.getX(a), position.getX(b), position.getX(c)];
    const zs = [position.getZ(a), position.getZ(b), position.getZ(c)];

    // The triangle's footprint is enough: props are made of boxes, so a bbox
    // per triangle is barely coarser than the triangle itself.
    const minCol = Math.floor((Math.min(...xs) - originX) / CELL);
    const maxCol = Math.floor((Math.max(...xs) - originX) / CELL);
    const minRow = Math.floor((Math.min(...zs) - originZ) / CELL);
    const maxRow = Math.floor((Math.max(...zs) - originZ) / CELL);

    for (let row = Math.max(0, minRow); row <= Math.min(rows - 1, maxRow); row++) {
      for (let col = Math.max(0, minCol); col <= Math.min(cols - 1, maxCol); col++) {
        blocked[row * cols + col] = 1;
      }
    }
  }
}

/** Marks the declared obstacles, on the same terms the triangles are judged by. */
function stamp(
  blockers: Blocker[],
  blocked: Uint8Array,
  cols: number,
  rows: number,
  originX: number,
  originZ: number,
): void {
  for (const blocker of blockers) {
    // An archway's span is over your head; a doorstep is under your feet.
    if (blocker.top < FLOOR_CLEARANCE || blocker.base > HEAD_CLEARANCE) continue;

    const minCol = Math.floor((blocker.x - blocker.halfWidth - originX) / CELL);
    const maxCol = Math.floor((blocker.x + blocker.halfWidth - originX) / CELL);
    const minRow = Math.floor((blocker.z - blocker.halfDepth - originZ) / CELL);
    const maxRow = Math.floor((blocker.z + blocker.halfDepth - originZ) / CELL);

    for (let row = Math.max(0, minRow); row <= Math.min(rows - 1, maxRow); row++) {
      for (let col = Math.max(0, minCol); col <= Math.min(cols - 1, maxCol); col++) {
        blocked[row * cols + col] = 1;
      }
    }
  }
}

/** Grows the blocked set so a figure's body clears furniture, not just its centre. */
function dilate(blocked: Uint8Array, cols: number, rows: number, radius: number): void {
  if (radius <= 0) return;
  const source = blocked.slice();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (source[row * cols + col] !== 1) continue;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
          blocked[r * cols + c] = 1;
        }
      }
    }
  }
}

/** Opens a doorway back up, plus enough depth to step in and turn. */
function carve(blocked: Uint8Array, cols: number, rows: number, col: number, row: number): void {
  const reach = Math.ceil((BODY_RADIUS + 0.9) / CELL);
  for (let dr = -reach; dr <= reach; dr++) {
    for (let dc = -reach; dc <= reach; dc++) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
      if (Math.hypot(dc, dr) > reach) continue;
      blocked[r * cols + c] = 0;
    }
  }
}

// ---------- routing ----------

const NEIGHBOURS: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/** A* over the grid. Small enough that a sorted frontier beats a real heap. */
function search(
  blocked: Uint8Array,
  cols: number,
  rows: number,
  start: [number, number],
  goal: [number, number],
): [number, number][] | null {
  if (start[0] === goal[0] && start[1] === goal[1]) return [start];

  const size = cols * rows;
  const cost = new Float32Array(size).fill(Infinity);
  const cameFrom = new Int32Array(size).fill(-1);
  const startIndex = start[1] * cols + start[0];
  const goalIndex = goal[1] * cols + goal[0];
  cost[startIndex] = 0;

  const frontier: [number, number][] = [[startIndex, heuristic(start, goal)]];

  while (frontier.length > 0) {
    let best = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (frontier[i]![1] < frontier[best]![1]) best = i;
    }
    const [current] = frontier.splice(best, 1)[0]!;
    if (current === goalIndex) break;

    const col = current % cols;
    const row = (current - col) / cols;

    for (const [dc, dr, step] of NEIGHBOURS) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      const next = r * cols + c;
      if (blocked[next] === 1) continue;
      // Never squeeze diagonally between two blocked cells.
      if (dc !== 0 && dr !== 0 && (blocked[row * cols + c] === 1 || blocked[r * cols + col] === 1)) continue;

      const candidate = cost[current]! + step;
      if (candidate >= cost[next]!) continue;
      cost[next] = candidate;
      cameFrom[next] = current;
      frontier.push([next, candidate + heuristic([c, r], goal)]);
    }
  }

  if (cameFrom[goalIndex] === -1 && goalIndex !== startIndex) return null;

  const out: [number, number][] = [];
  let cursor = goalIndex;
  while (cursor !== -1) {
    const col = cursor % cols;
    out.unshift([col, (cursor - col) / cols]);
    if (cursor === startIndex) break;
    cursor = cameFrom[cursor]!;
  }
  return out;
}

function heuristic(a: [number, number], b: [number, number]): number {
  const dx = Math.abs(a[0] - b[0]);
  const dy = Math.abs(a[1] - b[1]);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

/**
 * String-pulling: drop any waypoint you can see past.
 *
 * A raw grid path is a staircase of 0.4-unit steps; walked at speed it reads as
 * a shuffle. This turns it back into the few long straight legs a person would
 * actually take.
 */
function smooth(points: [number, number][], clearLine: (a: [number, number], b: [number, number]) => boolean): [number, number][] {
  const out: [number, number][] = [points[0]!];
  let anchor = 0;

  while (anchor < points.length - 1) {
    let furthest = anchor + 1;
    for (let i = points.length - 1; i > anchor; i--) {
      if (clearLine(points[anchor]!, points[i]!)) {
        furthest = i;
        break;
      }
    }
    out.push(points[furthest]!);
    anchor = furthest;
  }
  return out;
}
