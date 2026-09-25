import { hash32 } from '@shared/format';
import { rng } from '@shared/rand';
import type { ZoneId } from '@shared/activity';
import type { OfficeDetail } from '@shared/prefs';
import { STONE_COUNT } from '../theme/themes';
import {
  CAMPUS,
  CELL,
  cellToWorld,
  levelY,
  MAX_FLIGHT,
  WALKWAY_WIDTH,
  type CellRect,
  type ZoneSpec,
} from './campusTemplate';

/**
 * Turns the set of live sessions into a floor plan.
 *
 * The core is hand-composed (see `campusTemplate.ts`); desks are added around it
 * on the same grid. A desk may only go somewhere that is one empty cell from an
 * existing platform and within one level of it — which is exactly the condition
 * for a proper walkway or a single flight of stairs to reach it. Anywhere a desk
 * *can* go, it can be walked to.
 *
 * Placement is deterministic and sticky: a session keeps its cell for as long as
 * it lives, so the office never reshuffles under you.
 */

export interface Platform {
  id: string;
  kind: 'zone' | 'desk';
  zone?: ZoneId;
  /** Grid rectangle. The world position below is derived from it. */
  cell: CellRect;
  /** Centre in world units. */
  position: [number, number];
  level: number;
  size: [number, number];
  prop?: string;
  label: string;
  /** Desk platforms only: which session or group owns it. */
  ownerId?: string;
  colorIndex?: number;
  /**
   * Which of the theme's stones this platform is cut from.
   *
   * See `stoneVariant`. Assigned here rather than derived at draw time because
   * the architecture standing on a platform has to be cut from the same stone
   * as the platform, and the planner and the renderer are different passes that
   * would otherwise each have to reinvent the same answer.
   */
  stone: number;
  /**
   * Upper terraces only: the platform this one stands over.
   *
   * A terrace with a host is genuinely stacked — its footprint is inside the
   * host's and it sits two levels above it, with room to walk underneath. It
   * has no rock under it, because what holds it up is the host: the
   * architecture gives it piers instead.
   */
  over?: string;
}

export interface Connector {
  id: string;
  from: string;
  to: string;
  /** Same level → bridge, otherwise a climb. */
  kind: 'bridge' | 'stairs';
  /**
   * How that climb is made.
   *
   * Every flight in the office being the same straight run of treads is what
   * makes a campus of thirteen platforms read as a diagram. A spiral turns
   * about a newel; a lift is an open tower you ride up the inside of. They are
   * the same walkway to the nav graph — the difference is the shape of it, and
   * for the lift, the shape of the route through it.
   */
  style: 'straight' | 'spiral' | 'lift';
  /** Which way it runs: 'x' means it spans the gap along x. */
  axis: 'x' | 'z';
  /** Walkable width, centred on the shared edge span. */
  width: number;
  a: [number, number, number];
  b: [number, number, number];
  /**
   * Points the route must pass through between the two ends.
   *
   * A lift is not crossed in a straight line: you walk in at the bottom, go
   * straight up, and walk out at the top. Without this the figure would drift
   * diagonally through the tower's frame.
   */
  via?: [number, number, number][];
}

export interface Campus {
  platforms: Platform[];
  connectors: Connector[];
  bounds: { min: [number, number]; max: [number, number] };
}

export interface DeskRequest {
  /** Session slot id, or a group id when sessions are combined. */
  id: string;
  label: string;
  colorIndex: number;
  /** How many desks the platform has to hold. */
  seats: number;
}

/**
 * Desks are two cells square.
 *
 * Narrower looks tidier but does not work: once the pod is scaled to furnish
 * the platform there is no walkable ring left around it, and a figure cannot
 * get from the stairs to its chair without going through the desk.
 */
const DESK_LONG = 2;
const DESK_SHORT = 2;
const MAX_LEVEL = 4;
const MIN_LEVEL = -4;

/** Where a placed desk sits, remembered across rebuilds. */
export type DeskCell = [number, number];

/**
 * Builds the whole floor plan. Pure, so it can be tested and diffed.
 *
 * `seed` terraces the campus: same cells, different skyline. Zero keeps the
 * hand-composed levels, which is what the layout tests measure against.
 */
export function buildCampus(
  desks: DeskRequest[],
  assigned: Map<string, DeskCell> = new Map(),
  seed = 0,
  detail: OfficeDetail = 'composed',
): Campus {
  const platforms: Platform[] = CAMPUS.map(zonePlatform);
  if (seed !== 0) terrace(platforms, seed);
  const stacked = seed === 0 ? [] : raiseTerraces(platforms, seed, detail);
  platforms.push(...stacked);

  /**
   * A platform carries at most one thing.
   *
   * Two decks over one host is a multi-storey car park: the piers of the
   * second have nowhere to stand that the first has not already taken, and the
   * host disappears under its own upper floors.
   */
  const carrying = new Set(stacked.map((platform) => platform.over!));
  let stackBudget = seed === 0 ? 0 : DESK_STACKS[detail];

  for (const desk of desks) {
    /**
     * Some desks are built on top of something rather than beside it.
     *
     * Which ones is a property of the session, not of the order they arrived
     * in, so an office does not rearrange itself vertically every time a
     * session ends. It is a minority on purpose: a raised desk is a moment,
     * and the office has to keep making sense as the ground floor.
     */
    const wantsHeight = stackBudget > 0 && hash32(`${desk.id}^stack`) % 4 === 0;
    const placement = placeDesk(desk, platforms, assigned.get(desk.id), wantsHeight ? carrying : null);
    if (!placement) continue;
    assigned.set(desk.id, [placement.cell.col, placement.cell.row]);
    if (placement.over) {
      carrying.add(placement.over);
      stackBudget -= 1;
    }
    platforms.push({
      id: `desk:${desk.id}`,
      kind: 'desk',
      cell: placement.cell,
      ...cellToWorld(placement.cell),
      // A stacked desk is built like a raised terrace: smaller than its cells,
      // because what holds it up has to stand on the host's floor.
      ...(placement.over ? { size: stackSize(placement.cell) } : {}),
      level: placement.level,
      label: desk.label,
      ownerId: desk.id,
      colorIndex: desk.colorIndex,
      // Replaced by `assignStone` once every platform exists; it needs to see
      // the neighbours before it can pick.
      stone: 0,
      ...(placement.over ? { over: placement.over } : {}),
    });
  }

  assignStone(platforms, seed);

  return {
    platforms,
    // Stacked terraces are joined by hand: their footprint is *inside* their
    // host's, so the grid adjacency every other walkway is found by — one clear
    // cell apart, overlapping on the other axis — can never see them.
    connectors: [...buildConnectors(platforms), ...stackConnectors(platforms)],
    bounds: boundsOfAll(platforms),
  };
}

/**
 * Which stone each platform is cut from.
 *
 * Two things have to be true at once, and picking a variant by hashing the
 * platform's id gives neither. Rooms next to each other have to *differ*, or
 * the colour does no work — a run of three neighbours in the same stone is
 * exactly the cream mat this replaced. And the assignment has to move with the
 * seed, or every world is the same colours in the same places, which is half of
 * why one seed looked so much like the next.
 *
 * So: walk the platforms in a seeded order and give each one the stone its
 * neighbours have used least, tie-broken by the seed. Greedy, deterministic and
 * more than good enough on a grid where nothing has more than four neighbours.
 *
 * A stacked terrace is a deliberate exception. It takes its host's stone: it is
 * an upper storey of the same building, carried on that building's own piers,
 * and cutting it from a different rock makes the pair read as two platforms that
 * happen to overlap rather than as one thing with height.
 */
function assignStone(platforms: Platform[], seed: number): void {
  const random = rng(seed ^ 0x5f3a91);
  const order = [...platforms]
    .map((platform) => ({ platform, key: random() }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.platform);

  const chosen = new Map<string, number>();
  const byId = new Map(platforms.map((platform) => [platform.id, platform]));

  for (const platform of order) {
    if (platform.over) continue;
    const used = new Set<number>();
    for (const other of platforms) {
      if (other === platform || other.over) continue;
      const taken = chosen.get(other.id);
      if (taken !== undefined && touching(platform, other)) used.add(taken);
    }
    let pick = Math.floor(random() * STONE_COUNT) % STONE_COUNT;
    for (let i = 0; i < STONE_COUNT && used.has(pick); i += 1) pick = (pick + 1) % STONE_COUNT;
    chosen.set(platform.id, pick);
    platform.stone = pick;
  }

  // Upper storeys, once their hosts are settled.
  for (const platform of platforms) {
    if (!platform.over) continue;
    platform.stone = byId.get(platform.over)?.stone ?? 0;
  }
}

/**
 * Near enough that sharing a stone would read as one mass.
 *
 * Generous on purpose — platforms a clear cell apart still sit side by side in
 * the frame, and it is the picture this is for, not the floor plan.
 */
function touching(a: Platform, b: Platform): boolean {
  const gapX = Math.abs(a.position[0] - b.position[0]) - (a.size[0] + b.size[0]) / 2;
  const gapZ = Math.abs(a.position[1] - b.position[1]) - (a.size[1] + b.size[1]) / 2;
  return Math.max(gapX, gapZ) < CELL * 1.6;
}

function zonePlatform(zone: ZoneSpec): Platform {
  return {
    id: `zone:${zone.id}`,
    kind: 'zone',
    zone: zone.id,
    cell: zone.cell,
    ...cellToWorld(zone.cell),
    level: zone.level,
    prop: zone.prop,
    label: zone.label,
    // See `assignStone`, which fills this in once the whole campus exists.
    stone: 0,
  };
}

// ---------- how much of a platform the furniture takes ----------

/**
 * Lives here rather than with the props because the floor plan needs it too.
 *
 * A stacked terrace's stair has to come down onto floor a figure can stand on,
 * and the only part of a furnished platform guaranteed to be clear is the ring
 * around the furniture — so the layout has to know how wide that ring is. It
 * used to be the props' business alone, which meant the layout placed stairs by
 * guesswork and landed one in the middle of a bookcase.
 */
/** How much of a platform its furniture should take up, edge to edge. */
export const FILL = 0.66;
/**
 * Clear floor left around the furniture, in world units.
 *
 * A fraction alone is not enough: on a small platform 34% of not-very-much is
 * narrower than a person, and the walkable ring around the furniture closes up.
 * When that happens there is no route from the stairs to the chair at all.
 */
export const WALK_MARGIN = 1.35;
const MAX_UPSCALE = 2;
/**
 * Height follows width, but only partly.
 *
 * Scaling a prop uniformly to fill a floor turns a bookcase into a tower: in an
 * isometric view height costs far more screen than footprint does. Damping the
 * vertical keeps the floor furnished and the skyline calm.
 */
const HEIGHT_DAMPING = 0.55;

/**
 * How much clear floor a platform has between its furniture and its rim, per
 * axis. Architecture has to fit in there, so it asks rather than guesses: the
 * two would otherwise drift apart the first time a prop is resized, and the
 * symptom would be a figure unable to reach its own chair.
 *
 * Conservative on purpose — a prop is scaled uniformly, so it is often smaller
 * than its allowance on one axis and the real ring is wider than this says.
 */
export function walkableRing(platform: Platform): [number, number] {
  const allowedWidth = Math.min(platform.size[0] * FILL, platform.size[0] - 2 * WALK_MARGIN);
  const allowedDepth = Math.min(platform.size[1] * FILL, platform.size[1] - 2 * WALK_MARGIN);
  return [
    Math.max(0, (platform.size[0] - allowedWidth) / 2),
    Math.max(0, (platform.size[1] - allowedDepth) / 2),
  ];
}


// ---------- terracing ----------

/**
 * The shape a world's heights take.
 *
 * Height used to be a random walk out from one platform: every step mostly
 * zero, occasionally ±1, clamped near the middle. That is noise, and noise has
 * no silhouette — thirteen platforms all within a level of each other read as
 * one floor with a few kerbs, however many times you reseed it. The campus
 * looked like a floor plan seen at a slight angle.
 *
 * So a world picks a *landform* instead, evaluated over the grid. A cascade
 * falls the whole way across; a mesa stands out of its own outskirts; a bowl
 * sinks a court in the middle of a raised rim. Two worlds are then different
 * places rather than two shuffles of the same one, and — the point — the
 * campus has a skyline, which is what the z axis is for.
 *
 * `u` and `v` run −1…1 across the grid; the result is in levels.
 */
const RELIEFS: { id: string; field: (u: number, v: number) => number }[] = [
  // A terraced hillside, falling corner to corner. The most Monument Valley
  // of the five: every walkway across it is a flight of stairs.
  { id: 'cascade', field: (u, v) => (u + v) * -1.9 },
  // A spine along one diagonal, dropping away on both sides.
  { id: 'ridge', field: (u, v) => 2.4 - Math.abs(u - v) * 2.6 },
  // A sunken court ringed by higher ground.
  { id: 'bowl', field: (u, v) => Math.hypot(u, v) * 3.1 - 1.7 },
  // One raised plateau with the rest falling away from it.
  { id: 'mesa', field: (u, v) => 2.2 - Math.hypot(u * 1.15, v) * 3.4 },
  // Giant steps banded across one axis.
  { id: 'steps', field: (u) => u * 2.8 },
];

/**
 * Levels from a landform, then flattened until every walkway is one flight.
 *
 * Evaluating the field is the easy half. The hard half is that a connector
 * only exists between platforms one level apart, so a field taken literally
 * would cut the campus into islands separated by cliffs. `settleSlopes` lowers
 * whatever is too high for its neighbours until no edge exceeds one level,
 * which keeps the landform's shape everywhere the grid has room for it and
 * quietly gives up where it does not.
 */
function terrace(platforms: Platform[], seed: number): void {
  const random = rng(seed);
  const relief = RELIEFS[Math.floor(random() * RELIEFS.length)]!;
  // A quarter turn and a mirror. Those alone give forty campuses, which is few
  // enough that two seeds land on the same one often — so the relief is also
  // scaled and tilted, and the per-platform grain is drawn from the seed.
  const turn = Math.floor(random() * 4);
  const flip = random() < 0.5 ? 1 : -1;
  const amplitude = 0.75 + random() * 0.6;
  const tiltU = (random() - 0.5) * 1.6;
  const tiltV = (random() - 0.5) * 1.6;
  const extent = gridExtent(platforms);

  for (const platform of platforms) {
    const [u, v] = normalisedCell(platform.cell, extent, turn, flip);
    // The hand-composed level survives as an intention, not a number: the
    // watchtower still wants to be the high thing and the archive the low one,
    // but by how much is the world's business.
    const wish = platform.level * 0.4;
    const grain = rng(seed ^ hash32(platform.id))() - 0.5;
    const height = relief.field(u, v) * amplitude + u * tiltU + v * tiltV + wish + grain * 1.1;
    platform.level = clampLevel(Math.round(height));
  }

  settleSlopes(platforms);
  recentre(platforms);
}

/**
 * Slides the whole campus so its middle sits at level zero.
 *
 * Nothing in the world is anchored to y = 0 except the void: the height fog
 * fades everything below a fixed depth into the sky, and the rock each
 * platform stands on reaches down to just above it. A landform that happened
 * to come out four levels low would be dissolving into the floor of the
 * frame. Recentring costs nothing — only differences in height mean anything —
 * and it keeps every world sitting in the same band.
 */
function recentre(platforms: Platform[]): void {
  if (platforms.length === 0) return;
  const sorted = [...platforms].map((platform) => platform.level).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  if (median === 0) return;
  for (const platform of platforms) platform.level -= median;
}

// ---------- terraces on top of terraces ----------

/**
 * How high an upper terrace floats above the one it stands on.
 *
 * Two levels, which at 2.5 a level leaves about four and a half units of clear
 * headroom under the slab. Anything less and walking beneath it feels like
 * stooping; anything more and it stops reading as one building.
 */
const STACK_RISE = 2;

/** How many cells square an upper terrace is. */
const STACK_SIZE = 2;

/** How many raised terraces a world may have, per detail setting. */
const STACKS: Record<OfficeDetail, [number, number]> = {
  quiet: [0, 1],
  composed: [1, 2],
  ornate: [2, 3],
};

/**
 * Terraces standing on terraces.
 *
 * The campus was flat, then it was a hillside, and it was still a hillside made
 * of one layer — every platform had the sky directly above it. Monument Valley
 * is not like that: its levels fold over each other, and you walk under the
 * thing you were just standing on. This puts a smaller deck over part of a big
 * platform, high enough to walk beneath, reached by its own flight.
 *
 * Only big, quiet platforms get one, and only a couple per campus: the point is
 * one or two moments where the office goes up, not a second storey everywhere.
 */
function raiseTerraces(platforms: Platform[], seed: number, detail: OfficeDetail): Platform[] {
  const random = rng(seed ^ 0x51ac);
  const hosts = platforms
    .filter((platform) => platform.cell.cols >= 3 && platform.cell.rows >= 2)
    .sort((a, b) => b.cell.cols * b.cell.rows - a.cell.cols * a.cell.rows);
  if (hosts.length === 0) return [];

  // How many upper decks a world gets. One is a moment; four is a multi-storey
  // car park, and reads as one whatever else is done to it.
  const range = STACKS[detail];
  const wanted = range[0] + Math.floor(random() * (range[1] - range[0] + 1));
  const raised: Platform[] = [];

  const taken: Platform[] = [];
  for (const host of hosts) {
    if (raised.length >= wanted) break;
    if (random() < 0.35) continue;
    // Not next door to something that is already carrying. Three raised decks
    // in one corner of the campus read as a single lumpy building and leave
    // the rest of it flat; spread out, the same three are a skyline.
    if (taken.some((other) => gridNeighbours(host.cell, other.cell))) continue;
    const level = clampLevel(host.level + STACK_RISE);
    // Clamping can flatten the rise back to nothing on a campus that is
    // already at its ceiling, and a terrace at the same height as its host is
    // just a rug.
    if (level - host.level < STACK_RISE) continue;

    // Pushed into a corner of the host, so the walkable middle — where the
    // furniture is and where the walkways arrive — stays open and the piers
    // land on floor nobody needs.
    const west = random() < 0.5;
    const north = random() < 0.5;
    const cell: CellRect = {
      col: west ? host.cell.col : host.cell.col + host.cell.cols - STACK_SIZE,
      row: north ? host.cell.row : host.cell.row + host.cell.rows - STACK_SIZE,
      cols: STACK_SIZE,
      rows: Math.min(STACK_SIZE, host.cell.rows),
    };

    const placed = cellToWorld(cell);
    raised.push({
      id: `upper:${host.id}`,
      kind: 'zone',
      cell,
      // Overwritten with the host's, since an upper storey is the same building.
      stone: 0,
      position: placed.position,
      /**
       * Smaller than the cells it is booked into.
       *
       * The cell rectangle is bookkeeping — it keeps the terrace out of the
       * desk ring and out of the walkway search. What it is *built* as is
       * four-fifths of that, because a deck the full size of two cells is
       * wider than anything that can hold it up without standing in the
       * host's walkway, and a large deck on one column reads as a table.
       */
      size: [placed.size[0] * 0.8, placed.size[1] * 0.8],
      level,
      label: '',
      over: host.id,
    });
    taken.push(host);
  }

  return raised;
}

/**
 * The flight from a host deck up onto the terrace above it.
 *
 * Two things decide where it goes, and the second is the one that was wrong
 * first time. It runs along whichever axis the host still extends past the
 * terrace, because that is the only direction with host left to land on. And
 * it sits *in the host's walkable ring* on the other axis — pushed out against
 * the rim — because the middle of a furnished platform is furniture, and a
 * stair that comes down inside a bookcase leaves the terrace above it
 * unreachable. The ring is the one band guaranteed to be clear.
 */
function stackConnectors(platforms: Platform[]): Connector[] {
  const byId = new Map(platforms.map((platform) => [platform.id, platform]));
  const connectors: Connector[] = [];

  for (const upper of platforms) {
    if (!upper.over) continue;
    const host = byId.get(upper.over);
    if (!host) continue;

    // Out toward the middle of the host: the terrace is in a corner, so the
    // way down is whichever direction has host left in it.
    const dx = host.position[0] - upper.position[0];
    const dz = host.position[1] - upper.position[1];
    const alongX = Math.abs(dx) >= Math.abs(dz);
    const sign = alongX ? Math.sign(dx) || 1 : Math.sign(dz) || 1;

    const ring = walkableRing(host);
    // The cross axis: hard against whichever of the host's two rims the
    // terrace reaches, half a ring in, and clamped to stay on the terrace.
    const crossHalfHost = alongX ? host.size[1] / 2 : host.size[0] / 2;
    const crossHalfUpper = alongX ? upper.size[1] / 2 : upper.size[0] / 2;
    const crossHost = alongX ? host.position[1] : host.position[0];
    const crossUpper = alongX ? upper.position[1] : upper.position[0];
    const toward = Math.sign(crossUpper - crossHost) || 1;
    const band = Math.max(0.7, Math.min(alongX ? ring[1] : ring[0], 1.6));
    const cross = clampTo(
      crossHost + toward * (crossHalfHost - band / 2),
      crossUpper - crossHalfUpper + band,
      crossUpper + crossHalfUpper - band,
    );

    const upperY = levelY(upper.level);
    const hostY = levelY(host.level);
    const rim = alongX ? upper.size[0] / 2 : upper.size[1] / 2;
    const alongUpper = alongX ? upper.position[0] : upper.position[1];

    const topAlong = alongUpper + sign * rim;
    const footAlong = topAlong + sign * CELL;

    const top: [number, number, number] = alongX ? [topAlong, upperY, cross] : [cross, upperY, topAlong];
    const foot: [number, number, number] = alongX ? [footAlong, hostY, cross] : [cross, hostY, footAlong];

    const style = climbStyle(`${host.id}->${upper.id}`, upper.level - host.level);
    connectors.push({
      id: `${host.id}->${upper.id}`,
      from: host.id,
      to: upper.id,
      kind: 'stairs',
      style,
      axis: alongX ? 'x' : 'z',
      width: WALKWAY_WIDTH,
      a: foot,
      b: top,
      ...viaFor(style, foot, top),
    });
  }

  return connectors;
}

function clampTo(value: number, low: number, high: number): number {
  return low > high ? (low + high) / 2 : Math.max(low, Math.min(high, value));
}

/** The grid rectangle every platform sits inside. */
function gridExtent(platforms: Platform[]): { col: number; row: number; cols: number; rows: number } {
  let minCol = Infinity;
  let minRow = Infinity;
  let maxCol = -Infinity;
  let maxRow = -Infinity;
  for (const platform of platforms) {
    minCol = Math.min(minCol, platform.cell.col);
    minRow = Math.min(minRow, platform.cell.row);
    maxCol = Math.max(maxCol, platform.cell.col + platform.cell.cols);
    maxRow = Math.max(maxRow, platform.cell.row + platform.cell.rows);
  }
  return { col: minCol, row: minRow, cols: Math.max(1, maxCol - minCol), rows: Math.max(1, maxRow - minRow) };
}

/** A platform's centre as −1…1 across the grid, turned and mirrored. */
function normalisedCell(
  cell: CellRect,
  extent: { col: number; row: number; cols: number; rows: number },
  turn: number,
  flip: number,
): [number, number] {
  const u = ((cell.col + cell.cols / 2 - extent.col) / extent.cols) * 2 - 1;
  const v = ((cell.row + cell.rows / 2 - extent.row) / extent.rows) * 2 - 1;
  const turned: [number, number] =
    turn === 0 ? [u, v] : turn === 1 ? [-v, u] : turn === 2 ? [-u, -v] : [v, -u];
  return [turned[0] * flip, turned[1]];
}

/**
 * Lowers whatever stands more than one flight above a neighbour, until nothing
 * does.
 *
 * Only ever lowering is what makes this terminate: levels are bounded below,
 * so the sweep cannot run forever, and it cannot undo itself. The result is
 * the tallest landform the grid will carry — a hillside where there is room to
 * climb, a plateau where there is not.
 */
function settleSlopes(platforms: Platform[]): void {
  for (let pass = 0; pass < 32; pass++) {
    let changed = false;
    for (const a of platforms) {
      for (const b of platforms) {
        if (a === b || !gridNeighbours(a.cell, b.cell)) continue;
        if (a.level > b.level + MAX_FLIGHT) {
          a.level = b.level + MAX_FLIGHT;
          changed = true;
        }
      }
    }
    if (!changed) return;
  }
}

function clampLevel(level: number): number {
  return Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, level));
}

/**
 * What kind of climb a walkway is, decided by the walkway itself.
 *
 * Deterministic from the pair of platforms it joins, so a world keeps its
 * staircases wherever it is reseeded from. Flat crossings are always bridges.
 * A tall climb is the interesting case: that is where a lift earns its keep,
 * because two levels of straight treads is a lot of treads.
 */
function climbStyle(id: string, drop: number): Connector['style'] {
  if (drop === 0) return 'straight';
  const roll = (hash32(id) % 1000) / 1000;
  if (Math.abs(drop) > 1) return roll < 0.22 ? 'lift' : roll < 0.42 ? 'spiral' : 'straight';
  return roll < 0.16 ? 'spiral' : 'straight';
}

/** A lift is entered at the bottom and left at the top, never crossed. */
function viaFor(
  style: Connector['style'],
  from: [number, number, number],
  to: [number, number, number],
): { via?: [number, number, number][] } {
  if (style !== 'lift') return {};
  const [lowX, lowY, lowZ] = from[1] <= to[1] ? from : to;
  const [highX, highY, highZ] = from[1] <= to[1] ? to : from;
  // The shaft stands over the high end, so the ride is the vertical leg and
  // the walk in is the horizontal one.
  const shaft: [number, number, number] = [highX, lowY, highZ];
  const head: [number, number, number] = [highX, highY, highZ];
  return { via: from[1] <= to[1] ? [shaft, head] : [head, shaft] };
}

/** Grid adjacency alone: one clear cell on one axis, overlapping on the other. */
function gridNeighbours(a: CellRect, b: CellRect): boolean {
  const gapWest = b.col - (a.col + a.cols);
  const gapEast = a.col - (b.col + b.cols);
  const gapNorth = b.row - (a.row + a.rows);
  const gapSouth = a.row - (b.row + b.rows);

  if (gapWest === 1 || gapEast === 1) {
    return Math.min(a.row + a.rows, b.row + b.rows) > Math.max(a.row, b.row);
  }
  if (gapNorth === 1 || gapSouth === 1) {
    return Math.min(a.col + a.cols, b.col + b.cols) > Math.max(a.col, b.col);
  }
  return false;
}

// ---------- placing desks ----------

interface Placement {
  cell: CellRect;
  level: number;
  /** Set when the desk is built on top of another platform rather than beside it. */
  over?: string;
}

/** How many desks may be built on top of something, per detail setting. */
const DESK_STACKS: Record<OfficeDetail, number> = { quiet: 0, composed: 1, ornate: 3 };

/** A raised platform is built smaller than the cells it is booked into. */
function stackSize(cell: CellRect): [number, number] {
  const { size } = cellToWorld(cell);
  return [size[0] * 0.8, size[1] * 0.8];
}

/**
 * The first free spot that touches the existing campus, searched outward.
 *
 * Candidates are generated by walking the edges of every platform already
 * placed, so desks cluster against the core and against each other rather than
 * drifting off on their own. Ordering by distance from the middle keeps the
 * silhouette compact; the session's own hash only breaks ties, so two sessions
 * never fight over one spot and the result is stable.
 */
function placeDesk(
  desk: DeskRequest,
  platforms: Platform[],
  remembered: DeskCell | undefined,
  /** Non-null when this desk may be built on top of something; the set is what is already carrying. */
  carrying: Set<string> | null,
): Placement | null {
  const ground = deskCandidates(platforms);
  // Rooftops are offered only to a desk that asked for one, and only where
  // nothing is standing yet.
  const rooftops = carrying ? rooftopCandidates(platforms, carrying) : [];

  if (remembered) {
    const kept = [...rooftops, ...ground].find(
      ([cell]) => cell.col === remembered[0] && cell.row === remembered[1],
    );
    if (kept) return { cell: kept[0], level: kept[1], ...(kept[2] ? { over: kept[2] } : {}) };
  }

  // A desk that wants height takes it if there is any to be had; the ground is
  // the fallback, not the competition. Sorting the two together by distance to
  // the middle would put every desk on a roof, because a roof is by definition
  // closer in than the ring around it.
  const candidates = rooftops.length > 0 ? rooftops : ground;
  if (candidates.length === 0) return null;
  const centre = campusCentre(platforms);
  const seed = hash32(desk.id);

  candidates.sort((a, b) => {
    const da = distanceToCentre(a[0], centre);
    const db = distanceToCentre(b[0], centre);
    if (Math.abs(da - db) > 0.01) return da - db;
    // A stable, session-specific tie-break: equally good spots get shared out
    // instead of every session queueing for the same one.
    return ((seed + cellKeyNumber(a[0])) % 997) - ((seed + cellKeyNumber(b[0])) % 997);
  });

  const chosen = candidates[0]!;
  return { cell: chosen[0], level: chosen[1], ...(chosen[2] ? { over: chosen[2] } : {}) };
}

/**
 * Somewhere to build a desk on top of, rather than next to.
 *
 * The office grows outward as sessions arrive, and a ring of terraces around a
 * core is a plan rather than a place. Letting a desk land on the roof of
 * something — a shared room, or another desk — is what turns the campus into a
 * town: the newest thing is above the older one, reached by its own flight,
 * with the older one still working underneath it.
 *
 * A host has to be big enough to carry a deck and still be walked across, and
 * high enough that two more levels do not put the desk through the ceiling of
 * the world.
 */
function rooftopCandidates(platforms: Platform[], carrying: Set<string>): [CellRect, number, string][] {
  const out: [CellRect, number, string][] = [];

  const carriers = platforms.filter((platform) => carrying.has(platform.id));

  for (const host of platforms) {
    if (carrying.has(host.id)) continue;
    // Not on something that is itself standing on something: a third storey is
    // a tower block, and its piers would have nowhere to land.
    if (host.over) continue;
    // Nor next door to something already carrying, for the same reason the
    // belvederes spread out: clustered stacks are one lump, not a skyline.
    if (carriers.some((other) => gridNeighbours(host.cell, other.cell))) continue;
    if (host.cell.cols < 3 || host.cell.rows < 2) continue;
    const level = clampLevel(host.level + STACK_RISE);
    if (level - host.level < STACK_RISE) continue;

    // Into a corner, so the piers land on floor nobody needs and the middle —
    // where the furniture is and where the walkways arrive — stays open.
    for (const west of [true, false]) {
      for (const north of [true, false]) {
        out.push([
          {
            col: west ? host.cell.col : host.cell.col + host.cell.cols - STACK_SIZE,
            row: north ? host.cell.row : host.cell.row + host.cell.rows - STACK_SIZE,
            cols: STACK_SIZE,
            rows: Math.min(STACK_SIZE, host.cell.rows),
          },
          level,
          host.id,
        ]);
      }
    }
  }

  return out;
}

/**
 * Every free, grid-aligned rectangle that would be reachable if a desk were
 * put there: one empty cell from a platform, overlapping it by at least one
 * cell, and within one level of it.
 */
function deskCandidates(platforms: Platform[]): [CellRect, number][] {
  // A stacked terrace occupies cells that its host already occupies, so it is
  // not a thing to hang a desk off, not a thing to keep clear of, and not a
  // thing to measure the middle of the campus by. Left in, it generated
  // candidate spots *inside* its host's footprint and quietly dragged the
  // whole desk ring toward whichever platform happened to be carrying one.
  const ground = platforms.filter((platform) => !platform.over);
  const taken = ground.map((platform) => platform.cell);
  const seen = new Set<string>();
  const out: [CellRect, number][] = [];

  for (const platform of ground) {
    for (const [cell, orientation] of neighbourRects(platform.cell)) {
      const key = `${cell.col},${cell.row},${cell.cols},${cell.rows}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (taken.some((other) => cellsOverlap(cell, other))) continue;
      // Also keep one clear cell from anything it is not connecting to, or the
      // campus turns into a solid block with no walkways visible.
      if (taken.some((other) => !isClearOf(cell, other))) continue;

      // Every platform the desk would end up touching, not just the one it was
      // generated against. A desk is small and already furnished, and a grand
      // two-level flight landing on one takes most of its floor — so a desk is
      // held to a single flight from *all* of its neighbours, which the level
      // it wants has to be squeezed into.
      const neighbours = ground.filter((other) => gridNeighbours(cell, other.cell));
      const level = deskLevel(platform.level, cell, orientation, neighbours);
      if (level === null) continue;
      out.push([cell, level]);
    }
  }
  return out;
}

/**
 * The four places a desk can attach to one platform, oriented so its long side
 * faces the platform it hangs off.
 */
function neighbourRects(host: CellRect): [CellRect, 'x' | 'z'][] {
  const midCol = host.col + Math.floor((host.cols - DESK_LONG) / 2);
  const midRow = host.row + Math.floor((host.rows - DESK_LONG) / 2);
  return [
    // North and south: wide, shallow.
    [{ col: midCol, row: host.row - 1 - DESK_SHORT, cols: DESK_LONG, rows: DESK_SHORT }, 'z'],
    [{ col: midCol, row: host.row + host.rows + 1, cols: DESK_LONG, rows: DESK_SHORT }, 'z'],
    // West and east: narrow, deep.
    [{ col: host.col - 1 - DESK_SHORT, row: midRow, cols: DESK_SHORT, rows: DESK_LONG }, 'x'],
    [{ col: host.col + host.cols + 1, row: midRow, cols: DESK_SHORT, rows: DESK_LONG }, 'x'],
  ];
}

/**
 * Desks terrace rather than sitting flat.
 *
 * The step is derived from where the desk is, not from the session, so the
 * skyline is a property of the place and stays put as sessions come and go.
 *
 * The step must land in {-1, 0, 1}: a desk more than one level from the
 * platform it hangs off gets no walkway, and a desk with no walkway is an
 * island. `%` keeps the sign of its left operand in JavaScript, so a desk at a
 * negative row — anything placed north of the core — used to come out three
 * levels adrift and float there unreachable.
 */
function deskLevel(
  hostLevel: number,
  cell: CellRect,
  orientation: 'x' | 'z',
  neighbours: readonly Platform[],
): number | null {
  const step = ((((cell.col * 7 + cell.row * 13) % 3) + 3) % 3) - 1;
  const wanted = hostLevel + (orientation === 'z' ? step : -step);

  // The band that is one flight from everything the desk would touch. It is
  // empty when two of its neighbours are already two levels apart — there is
  // no height a desk between them could sit at, so that spot is not a spot.
  let floor = MIN_LEVEL;
  let ceiling = MAX_LEVEL;
  for (const neighbour of neighbours) {
    floor = Math.max(floor, neighbour.level - 1);
    ceiling = Math.min(ceiling, neighbour.level + 1);
  }
  if (floor > ceiling) return null;
  return Math.max(floor, Math.min(ceiling, wanted));
}

/**
 * The middle of the *core*, not of everything placed so far.
 *
 * Measuring the whole campus drags the centre toward wherever the last desk
 * went, so each new desk is judged against a target that has already moved
 * toward it — and they all end up piled on one side. The core never moves.
 */
function campusCentre(platforms: Platform[]): [number, number] {
  const core = platforms.filter((platform) => platform.kind === 'zone' && !platform.over);
  const measured = core.length > 0 ? core : platforms;
  let col = 0;
  let row = 0;
  for (const platform of measured) {
    col += platform.cell.col + platform.cell.cols / 2;
    row += platform.cell.row + platform.cell.rows / 2;
  }
  return [col / measured.length, row / measured.length];
}

function distanceToCentre(cell: CellRect, centre: [number, number]): number {
  return Math.hypot(cell.col + cell.cols / 2 - centre[0], cell.row + cell.rows / 2 - centre[1]);
}

function cellKeyNumber(cell: CellRect): number {
  return cell.col * 131 + cell.row * 17;
}

// ---------- grid relationships ----------

function cellsOverlap(a: CellRect, b: CellRect): boolean {
  return (
    a.col < b.col + b.cols && a.col + a.cols > b.col && a.row < b.row + b.rows && a.row + a.rows > b.row
  );
}

/**
 * At least one clear cell between them, on some axis.
 *
 * Two platforms flush against each other read as one lumpy platform, and there
 * is nowhere to put the walkway that would justify them being separate.
 */
function isClearOf(a: CellRect, b: CellRect): boolean {
  const gapX = Math.max(b.col - (a.col + a.cols), a.col - (b.col + b.cols));
  const gapZ = Math.max(b.row - (a.row + a.rows), a.row - (b.row + b.rows));
  return gapX >= 1 || gapZ >= 1;
}

/**
 * Are these two platforms joined? Exactly one empty cell apart on one axis,
 * overlapping on the other, and climbable in a single flight.
 */
function adjacency(a: Platform, b: Platform): { axis: 'x' | 'z'; from: number; to: number } | null {
  // A stacked terrace has exactly one way on and off, built by hand. Letting
  // the grid find it more would run a flight from a neighbouring platform
  // straight up onto somebody's roof.
  if (a.over || b.over) return null;
  if (Math.abs(a.level - b.level) > MAX_FLIGHT) return null;

  const gapWest = b.cell.col - (a.cell.col + a.cell.cols);
  const gapEast = a.cell.col - (b.cell.col + b.cell.cols);
  const gapNorth = b.cell.row - (a.cell.row + a.cell.rows);
  const gapSouth = a.cell.row - (b.cell.row + b.cell.rows);

  if (gapWest === 1 || gapEast === 1) {
    const from = Math.max(a.cell.row, b.cell.row);
    const to = Math.min(a.cell.row + a.cell.rows, b.cell.row + b.cell.rows);
    return to > from ? { axis: 'x', from, to } : null;
  }
  if (gapNorth === 1 || gapSouth === 1) {
    const from = Math.max(a.cell.col, b.cell.col);
    const to = Math.min(a.cell.col + a.cell.cols, b.cell.col + b.cell.cols);
    return to > from ? { axis: 'z', from, to } : null;
  }
  return null;
}

/** Every pair of platforms that are grid neighbours gets a walkway. */
function buildConnectors(platforms: Platform[]): Connector[] {
  const connectors: Connector[] = [];

  for (let i = 0; i < platforms.length; i++) {
    for (let j = i + 1; j < platforms.length; j++) {
      const a = platforms[i]!;
      const b = platforms[j]!;
      const shared = adjacency(a, b);
      if (!shared) continue;

      // Centred on the shared edge, so a walkway always meets both platforms
      // square on rather than clipping a corner.
      const midCell = (shared.from + shared.to) / 2;
      const mid = midCell * CELL;
      const ay = levelY(a.level);
      const by = levelY(b.level);

      const [from, to]: [[number, number, number], [number, number, number]] =
        shared.axis === 'x'
          ? [
              [a.position[0] + Math.sign(b.position[0] - a.position[0]) * (a.size[0] / 2), ay, mid],
              [b.position[0] + Math.sign(a.position[0] - b.position[0]) * (b.size[0] / 2), by, mid],
            ]
          : [
              [mid, ay, a.position[1] + Math.sign(b.position[1] - a.position[1]) * (a.size[1] / 2)],
              [mid, by, b.position[1] + Math.sign(a.position[1] - b.position[1]) * (b.size[1] / 2)],
            ];

      // A two-level flight is climbed as one grand stair, so it is built as
      // one: wider than a walkway, as wide as the shared edge will allow. A
      // steep flight at walkway width reads as a ladder; the same pitch at
      // half again the width reads as a temple stair, which is the thing it is.
      const span = (shared.to - shared.from) * CELL - 0.6;
      const drop = Math.abs(a.level - b.level);
      const tall = drop > 1;
      const style = climbStyle(`${a.id}->${b.id}`, drop);
      connectors.push({
        id: `${a.id}->${b.id}`,
        from: a.id,
        to: b.id,
        kind: a.level === b.level ? 'bridge' : 'stairs',
        style,
        axis: shared.axis,
        // A lift is a tower, not a ramp: it wants to be square, not wide.
        width: style === 'lift' ? Math.min(WALKWAY_WIDTH, span) : Math.min(tall ? WALKWAY_WIDTH * 1.6 : WALKWAY_WIDTH, span),
        a: from,
        b: to,
        ...viaFor(style, from, to),
      });
    }
  }

  return connectors;
}

function boundsOfAll(platforms: Platform[]): Campus['bounds'] {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const platform of platforms) {
    minX = Math.min(minX, platform.position[0] - platform.size[0] / 2);
    maxX = Math.max(maxX, platform.position[0] + platform.size[0] / 2);
    minZ = Math.min(minZ, platform.position[1] - platform.size[1] / 2);
    maxZ = Math.max(maxZ, platform.position[1] + platform.size[1] / 2);
  }
  return { min: [minX, minZ], max: [maxX, maxZ] };
}
