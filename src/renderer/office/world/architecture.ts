import type { BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng } from '@shared/rand';
import type { OfficeDetail } from '@shared/prefs';
import { box, buildProp, cylinder, type Part } from '../props/kit';
import { buildPropFor } from '../props/registry';
import { mixHex, stoneVariant, type ResolvedTheme } from '../theme/themes';
import { levelY, PLATFORM_THICKNESS } from './campusTemplate';
import { walkableRing, type Campus, type Platform } from './layout';
import { buildOccupancy, type Blocker } from './occupancy';

/**
 * The architecture the office is set in.
 *
 * Platforms and furniture alone read as a floor plan — a grid of trays with
 * objects on them. What makes a place feel built is the stuff that has no
 * function: a colonnade, a wall that stops half way, an arch you walk under, a
 * tower you cannot enter. This generates those, and generates them differently
 * for every world, so no two offices are the same building.
 *
 * A *plan* is deliberately separate from its geometry. The shape of the
 * building depends on the world seed and nothing else, so the nav grid can be
 * built from it once and left alone; the colours come from the theme, which
 * moves with the clock. Fusing the two means every sunset reseats everybody.
 */

export type Tone = 'stone' | 'pale' | 'accent' | 'plant' | 'water';

/** One primitive, placed. Platform pieces are in platform-local coordinates. */
export type Piece =
  | {
      shape: 'box';
      tone: Tone;
      size: [number, number, number];
      at: [number, number, number];
      /** Yaw, for the segments that approximate a curve. */
      rotY?: number;
      grad: [number, number];
    }
  | {
      shape: 'column';
      tone: Tone;
      radius: number;
      height: number;
      /** Ratio of top radius to bottom: 1 is a post, less than 1 tapers. */
      taper?: number;
      at: [number, number, number];
      grad: [number, number];
    }
  | {
      shape: 'arch';
      tone: Tone;
      radius: number;
      tube: number;
      at: [number, number, number];
      /** Spanning along z rather than x. */
      turned: boolean;
      grad: [number, number];
    };

export interface ArchPlan {
  /** Which dialect this world was built in. */
  dialect: string;
  /** Per platform, in that platform's local coordinates, like a prop. */
  onPlatform: Map<string, Piece[]>;
  /** Freestanding pieces, already in world coordinates. */
  detached: Piece[];
}

/**
 * What this world is built out of.
 *
 * Deliberately few. An earlier pass gave every platform two or three motifs on
 * top of a curtain wall, a rock and a shelf of clutter, and the result was
 * busy rather than built — a fortified village, when the brief is a Monument
 * Valley palace. The reference is Moorish and Escher: arcades, domes, slender
 * towers, pointed arches, flat pastel planes, and a great deal of nothing.
 *
 * So the rule is one large gesture per platform and at most one small one.
 * Elegance here is a subtraction problem.
 */
type Motif =
  | 'arcade'
  | 'dome'
  | 'minaret'
  | 'tower'
  | 'ghat'
  | 'screen'
  | 'wall'
  | 'canopy'
  | 'waterfall'
  | 'aqueduct'
  | 'pavilion'
  | 'pylon';
type Accentpiece = 'pool' | 'lantern' | 'planter' | 'none';

/** Which side of a platform a piece sits on. */
type Edge = 'north' | 'south' | 'east' | 'west';
const EDGES: Edge[] = ['north', 'south', 'east', 'west'];

/**
 * A world speaks one dialect. Two large motifs is enough range for a dozen
 * platforms and few enough that the campus reads as one building — which is
 * the thing a world of eight motifs can never do.
 */
const DIALECTS: { id: string; motifs: Motif[] }[] = [
  { id: 'arcades', motifs: ['arcade', 'pylon', 'wall'] },
  { id: 'domes', motifs: ['dome', 'arcade', 'canopy'] },
  { id: 'spires', motifs: ['minaret', 'screen', 'tower'] },
  { id: 'waters', motifs: ['waterfall', 'aqueduct', 'ghat'] },
  { id: 'pavilions', motifs: ['pavilion', 'canopy', 'minaret'] },
  { id: 'steps', motifs: ['ghat', 'pylon', 'wall'] },
  { id: 'ramparts', motifs: ['wall', 'tower', 'screen'] },
  { id: 'courts', motifs: ['canopy', 'arcade', 'pavilion'] },
];

/**
 * How many platforms a motif may claim across a whole campus.
 *
 * The tall ones are silhouette: three minarets is a skyline, seven is a fence.
 */
const MOTIF_CAP: Partial<Record<Motif, number>> = {
  minaret: 3,
  tower: 3,
  canopy: 4,
  wall: 4,
  dome: 3,
  waterfall: 3,
  aqueduct: 2,
  pylon: 4,
  pavilion: 4,
};

/**
 * How much a world is allowed to build, per setting.
 *
 * The vocabulary outgrew the restraint. Every motif in it earns its place on
 * its own, and a campus wearing all of them at once is a curiosity shop rather
 * than a building — so the question "how much" stopped being a constant and
 * became a choice. `composed` is deliberately below where the numbers used to
 * sit: the honest read of "there's just a lot going on" is that the house
 * style was already past its own bar.
 */
const BUDGET: Record<OfficeDetail, {
  /** Chance a shared platform takes a large gesture, and a desk platform. */
  major: number;
  deskMajor: number;
  /** Chance of a small one on top. */
  accent: number;
  /** Chance a bridge gets a gateway arch over it. */
  gateway: number;
  /** Multiplier on how many platforms each tall motif may claim. */
  cap: number;
  /** Chance a raised terrace is roofed rather than open. */
  roof: number;
}> = {
  quiet: { major: 0.46, deskMajor: 0.12, accent: 0.12, gateway: 0.1, cap: 0.55, roof: 0.6 },
  composed: { major: 0.72, deskMajor: 0.26, accent: 0.26, gateway: 0.2, cap: 1, roof: 0.5 },
  ornate: { major: 0.96, deskMajor: 0.58, accent: 0.52, gateway: 0.42, cap: 1.8, roof: 0.75 },
};

export function planArchitecture(
  campus: Campus,
  seed: number,
  detail: OfficeDetail = 'composed',
): ArchPlan {
  const budget = BUDGET[detail];
  const random = rng(seed);
  const dialect = DIALECTS[Math.floor(random() * DIALECTS.length)] ?? DIALECTS[0]!;
  const used = new Map<Motif, number>();
  const onPlatform = new Map<string, Piece[]>();

  // Which edges a walkway already meets: nothing may be built across a way in.
  const busy = doorwayEdges(campus);

  // One height for the whole campus, jittered per building. A kingdom is one
  // mason's work, and the give-away is that the courses line up across things
  // that are otherwise nothing alike.
  const storey = 3.1 + random() * 0.8;
  const bedrock = bedrockOf(campus);
  // What holds the stacked terraces up, keyed by the platform they stand on.
  // Built in the *host's* coordinates, not the terrace's: the piers stand on
  // the host's deck, so that is where they have to be drawn and — more to the
  // point — where a figure has to walk around them.
  const byId = new Map(campus.platforms.map((platform) => [platform.id, platform]));
  const upperOf = new Map<string, Platform>();
  for (const platform of campus.platforms) {
    if (platform.over && byId.has(platform.over)) upperOf.set(platform.over, platform);
  }

  for (const platform of campus.platforms) {
    // A stacked terrace has no rock: it is held up by the platform beneath it.
    // Giving it a substructure would drive a column of stone down through its
    // own host and out of the bottom of the world.
    /**
     * A raised platform has no rock — it is held up by the one beneath it —
     * and what it wears instead is a parapet, sometimes under a roof.
     *
     * The parapet goes in with the *droppable* pieces rather than with the
     * ground, because a raised deck can also be somebody's desk, and a desk
     * platform is small, already furnished, and quite capable of being sealed
     * by its own railing. The rock and the piers cannot be given up; a railing
     * can.
     */
    const ground: Piece[] = platform.over
      ? []
      : [...substructure(platform, random, bedrock), ...support(platform, upperOf.get(platform.id), campus, random, storey)];

    const open = EDGES.filter((edge) => !(busy.get(platform.id) ?? new Set<Edge>()).has(edge));

    // A deck that is somebody's desk is furnished already; one that is not is a
    // belvedere, and a belvedere is worth roofing.
    let built: Piece[] = platform.over
      ? parapet(platform, random, platform.kind === 'desk' ? 0 : budget.roof)
      : [];
    let accent: Piece[] = [];
    let motif: Motif | null = null;

    if (!platform.over && open.length > 0) {
      const available = dialect.motifs.filter(
        (item) => (used.get(item) ?? 0) < Math.round((MOTIF_CAP[item] ?? Infinity) * budget.cap),
      );
      // Desks get the quiet half of the vocabulary: they are small, they are
      // already furnished, and a minaret over somebody's desk is a joke.
      const pool = platform.kind === 'desk' ? (['screen', 'pylon'] as Motif[]) : available;

      if (pool.length > 0 && random() < (platform.kind === 'desk' ? budget.deskMajor : budget.major)) {
        const edge = takeEdge(open, outward(platform, campus), random, 0.8);
        // A motif may decline — a dome will not perch on a terrace too narrow
        // to hold it — so try the rest of the dialect before giving up on the
        // platform. Rotating the start keeps the choice seeded rather than
        // always preferring whichever motif the dialect lists first.
        const start = Math.floor(random() * pool.length);
        for (let i = 0; i < pool.length; i++) {
          const choice = pool[(start + i) % pool.length]!;
          const made = major(choice, platform, edge, random, storey);
          if (made.length === 0) continue;
          motif = choice;
          built = made;
          break;
        }
      }
    }

    // At most one small thing, and often nothing at all.
    if (!platform.over && open.length > 0 && random() < budget.accent) {
      const edge = takeEdge(open, outward(platform, campus), random, 0.3);
      accent = minor(pickAccent(random), platform, edge, random);
    }

    /**
     * Then check what it did, and undo it if it walled somebody in.
     *
     * Every piece is placed against a clearance budget, and every time that
     * budget has been got right the ring has still closed somewhere — because
     * the budget is a local sum and being walled in is not. A colonnade down
     * the west side and a pool at the east end are each well within their
     * allowance; together they are the only two ways past the furniture. So
     * rather than adding a sixth term to the arithmetic, build it, walk it,
     * and drop the accent — and then the whole gesture — if it does not walk.
     */
    const standing = standingSpots(platform, campus);
    let pieces = [...ground, ...built, ...accent];
    if (!walkable(platform, pieces, standing)) {
      accent = [];
      pieces = [...ground, ...built];
      if (!walkable(platform, pieces, standing)) {
        built = [];
        motif = null;
        pieces = ground;
      }
    }

    if (motif) used.set(motif, (used.get(motif) ?? 0) + 1);
    if (pieces.length > 0) onPlatform.set(platform.id, pieces);
  }

  return { dialect: dialect.id, onPlatform, detached: voidWorks(campus, random, budget.gateway) };
}

/**
 * Which way is away from the rest of the campus.
 *
 * The big gestures want this. A waterfall dropping twenty units off a terrace
 * is the most dramatic thing a world has, and put on whichever edge happened
 * to be free it falls straight down behind the next platform along, where it
 * is generated, correct, and never once seen. The same is true of a minaret
 * standing in somebody else's courtyard. Facing outward puts them against the
 * sky from most of the angles the camera can take, and is the sensible place
 * to have built them anyway.
 */
function outward(platform: Platform, campus: Campus): Edge {
  let sumX = 0;
  let sumZ = 0;
  for (const other of campus.platforms) {
    sumX += other.position[0];
    sumZ += other.position[1];
  }
  const count = Math.max(1, campus.platforms.length);
  return edgeToward(platform, [
    platform.position[0] * 2 - sumX / count,
    0,
    platform.position[1] * 2 - sumZ / count,
  ]);
}

/**
 * Takes an edge out of what is still free, preferring the one given.
 *
 * Preferring rather than insisting: a campus where every gesture faces
 * directly out of the middle is a compass rose, not a place.
 */
function takeEdge(open: Edge[], preferred: Edge, random: () => number, bias: number): Edge {
  const wanted = open.indexOf(preferred);
  const index = wanted >= 0 && random() < bias ? wanted : Math.floor(random() * open.length);
  return open.splice(index, 1)[0]!;
}

/**
 * Everywhere on a platform a figure has to be able to stand, and which of
 * those the occupancy grid is allowed to force open.
 *
 * The distinction matters, and getting it wrong made the whole check useless.
 * A *doorway* — the mouth of a walkway — is carved clear whatever the
 * furniture says, because a platform you cannot step onto is not a platform. A
 * *seat* is not: it is somewhere the figure has to be able to reach, and reach
 * is exactly the question being asked. Passing the seats in as doorways as
 * well, which is what this did, punched a hole through the furniture at every
 * chair and then cheerfully reported that the floor joined up — on a grid
 * production never builds.
 */
interface Standing {
  /** Carved open regardless: the ends of the walkways. */
  doors: [number, number][];
  /** Everywhere that has to be mutually reachable, doorways included. */
  spots: [number, number][];
}

function standingSpots(platform: Platform, campus: Campus): Standing {
  const doors: [number, number][] = [];
  for (const connector of campus.connectors) {
    if (connector.from === platform.id) doors.push([connector.a[0], connector.a[2]]);
    if (connector.to === platform.id) doors.push([connector.b[0], connector.b[2]]);
  }
  const spots: [number, number][] = [...doors];
  const prop = buildPropFor(platform, PLAN_PALETTE);
  for (const slot of prop?.slots ?? []) {
    spots.push([platform.position[0] + slot.position[0], platform.position[1] + slot.position[2]]);
  }
  return { doors, spots };
}

/**
 * The strongest support a host can carry and still be walked across.
 *
 * Tried most generous first. A campus where every raised deck stands on one
 * slim column would be timid; a campus where one of them walls off half a
 * platform is broken. This asks the floor.
 */
function support(
  host: Platform,
  upper: Platform | undefined,
  campus: Campus,
  random: () => number,
  storey: number,
): Piece[] {
  if (!upper) return [];
  const standing = standingSpots(host, campus);
  const { posts, canopy } = pierLayouts(upper, host, random, storey);
  for (const layout of posts) {
    if (walkable(host, layout, standing)) return [...layout, ...canopy];
  }
  return [...(posts[posts.length - 1] ?? []), ...canopy];
}

/** Does the floor still join up, with this built on it? */
function walkable(platform: Platform, pieces: readonly Piece[], standing: Standing): boolean {
  if (standing.spots.length < 2) return true;
  const prop = buildPropFor(platform, PLAN_PALETTE);
  const grid = buildOccupancy(platform, prop?.geometry ?? null, standing.doors, archBlockers(pieces));
  return grid.connects(standing.spots);
}

/**
 * Colours for the props the planner measures against.
 *
 * A prop's shape does not depend on its palette — only its colours do — and
 * the plan has to be a function of the seed alone, so the planner must not see
 * the theme. Any palette gives the same geometry; this one is never drawn.
 */
const PLAN_PALETTE = {
  surface: '#ffffff',
  surfaceAlt: '#ffffff',
  accent: '#ffffff',
  dark: '#ffffff',
  screen: '#ffffff',
  paper: '#ffffff',
  plant: '#ffffff',
  metal: '#ffffff',
};

function pickAccent(random: () => number): Accentpiece {
  const roll = random();
  // Pools used to take four rims in ten, and with water finally visible that
  // read as a campus with a moat. Water is a set piece; it should not be the
  // commonest thing on the skyline.
  return roll < 0.18 ? 'pool' : roll < 0.58 ? 'planter' : roll < 0.9 ? 'lantern' : 'none';
}

// ---------- placing things on an edge ----------

/**
 * Walkable floor that has to survive whatever gets built, and how far an
 * obstacle's shadow actually reaches.
 *
 * `BODY` is the grid's dilation, not the body radius: the occupancy grid grows
 * obstacles by whole 0.4 cells, so a 0.42 body costs 0.8 of floor. Budgeting
 * for the radius instead leaves architecture that fits on paper and seals the
 * walkway in fact.
 */
const CLEARANCE = 0.55;
const BODY = 0.85;

interface EdgeFrame {
  /** Along the edge, and outward from it. */
  axis: [number, number];
  normal: [number, number];
  /** Length of the edge. */
  along: number;
  /** Clear floor between the furniture and this rim. */
  room: number;
  /** True when the edge runs along x. */
  horizontal: boolean;
  /** A point on the edge, `offset` along it and `out` beyond the rim. */
  at(offset: number, y: number, out: number): [number, number, number];
  /** How far in from the rim a piece this thick may stand; negative overhangs. */
  fit(thickness: number, preferred?: number): number;
  /** A box lying along the edge: `len` along, `thick` across. */
  band(len: number, tall: number, thick: number, offset: number, y: number, out: number, tone: Tone, grad: [number, number]): Piece;
}

function frameFor(platform: Platform, edge: Edge): EdgeFrame {
  const [width, depth] = platform.size;
  const horizontal = edge === 'north' || edge === 'south';
  const along = horizontal ? width : depth;
  const axis: [number, number] = horizontal ? [1, 0] : [0, 1];
  const normal: [number, number] =
    edge === 'north' ? [0, -1] : edge === 'south' ? [0, 1] : edge === 'west' ? [-1, 0] : [1, 0];
  const ring = walkableRing(platform);
  const across = horizontal ? ring[1] : ring[0];
  const half: [number, number] = [width / 2, depth / 2];

  const at = (offset: number, y: number, out: number): [number, number, number] => [
    normal[0] * (half[0] + out) + axis[0] * offset,
    y,
    normal[1] * (half[1] + out) + axis[1] * offset,
  ];

  return {
    axis,
    normal,
    along,
    room: across,
    horizontal,
    at,
    fit(thickness, preferred = 0.4) {
      /**
       * Positive is inward from the rim; negative overhangs the drop.
       *
       * A piece that cannot stand inside the walkable ring overhangs instead,
       * where it costs almost no floor — which, on a platform whose ring is one
       * body wide, is most of them. But it has to keep a foot on the terrace.
       * The overhang used to be `thickness / 2 + 0.14`, which puts the piece's
       * *inner* edge a finger's width past the rim: every overhanging piece was
       * floating, and on a thin balustrade a 0.14 gap reads as a join, so it
       * went unnoticed for passes. On a dome three units across it reads as a
       * dome, in the sky, next to the office.
       *
       * So an overhanging piece straddles: a sixth of its thickness stays over
       * the platform. That sliver of floor is what the planner's walkability
       * check is for.
       */
      const limit = across - CLEARANCE - BODY - thickness / 2;
      return limit < 0 ? -(thickness * 0.34) : Math.min(preferred, limit);
    },
    band(len, tall, thick, offset, y, out, tone, grad) {
      return {
        shape: 'box',
        tone,
        size: horizontal ? [len, tall, thick] : [thick, tall, len],
        at: at(offset, y, out),
        grad,
      };
    },
  };
}

// ---------- the large gestures ----------

function major(motif: Motif, platform: Platform, edge: Edge, random: () => number, storey: number): Piece[] {
  const f = frameFor(platform, edge);
  switch (motif) {
    case 'arcade':
      return arcade(f, random, storey);
    case 'dome':
      return dome(f, random, storey);
    case 'minaret':
      return minaret(f, random, storey);
    case 'tower':
      return tower(f, random, storey);
    case 'wall':
      return wall(f, random, storey);
    case 'canopy':
      return canopy(f, random, storey);
    case 'ghat':
      return ghat(f, random);
    case 'screen':
      return screen(f, random, storey);
    case 'waterfall':
      return waterfall(f, random);
    case 'aqueduct':
      return aqueduct(f, random, storey);
    case 'pavilion':
      return pavilion(platform, random, storey);
    case 'pylon':
      return pylon(f, random, storey);
    default:
      return [];
  }
}

/**
 * A run of pointed arches on slim piers, under one flat entablature.
 *
 * The signature form. It is tall enough to matter and open enough to see the
 * room through, which is the whole trick a solid wall could not do.
 */
function arcade(f: EdgeFrame, random: () => number, storey: number): Piece[] {
  const thick = 0.3;
  const out = -f.fit(thick, 0.3);
  const bays = 3 + Math.floor(random() * 3);
  const span = f.along * 0.86;
  const bay = span / bays;
  const pier = 0.28;
  const height = storey * (0.78 + random() * 0.2);
  const spring = height * 0.58;
  const pieces: Piece[] = [];

  for (let i = 0; i <= bays; i++) {
    const offset = -span / 2 + i * bay;
    pieces.push(f.band(pier, spring, thick, offset, 0, out, 'pale', [0.5, 1]));
  }
  for (let i = 0; i < bays; i++) {
    const offset = -span / 2 + (i + 0.5) * bay;
    pieces.push({
      shape: 'arch',
      tone: 'pale',
      radius: (bay - pier) / 2,
      tube: thick / 2,
      at: f.at(offset, spring, out),
      turned: !f.horizontal,
      grad: [0.7, 1],
    });
  }
  // The entablature, oversailing a little at each end so the run is finished
  // rather than simply stopped.
  pieces.push(f.band(span + pier * 2.2, height - spring - (bay - pier) / 2, thick * 1.5, 0, spring + (bay - pier) / 2, out, 'stone', [0.72, 1]));
  return pieces;
}

/** A hemisphere on a drum, stepped out of flat slices. */
function dome(f: EdgeFrame, random: () => number, storey: number): Piece[] {
  // Sized against the floor it has to stand on, not just the edge it sits on:
  // a dome scaled only to the length of its edge is oversized on any platform
  // that is long and shallow, and ends up perched half off the rim.
  const radius = Math.min(1.5, f.along * 0.17, Math.max(0.55, f.room * 0.8));
  const inset = f.fit(radius * 2, 0.2);
  // A dome is mass. It stands on the terrace or it is not built here: perched
  // on the rim it has two and a half units of nothing under it, and the one
  // thing a heavy object must not do in this office is float.
  if (inset < 0) return [];
  const out = -inset;
  const drum = storey * (0.45 + random() * 0.2);
  const offset = (random() - 0.5) * f.along * 0.3;
  const pieces: Piece[] = [
    { shape: 'column', tone: 'pale', radius, height: drum, at: f.at(offset, 0, out), grad: [0.5, 1] },
    { shape: 'column', tone: 'stone', radius: radius * 1.16, height: 0.16, at: f.at(offset, drum, out), grad: [0.8, 1] },
  ];

  // Five slices of a sphere. Flat courses read better here than a real
  // hemisphere would: the office is made of planes, and a smooth dome in a
  // faceted scene looks like it came from somewhere else.
  const slices = 5;
  for (let i = 0; i < slices; i++) {
    const t = i / slices;
    const next = (i + 1) / slices;
    pieces.push({
      shape: 'column',
      tone: 'pale',
      radius: radius * Math.sqrt(Math.max(0.02, 1 - t * t)),
      height: radius * (next - t),
      taper: Math.sqrt(Math.max(0.02, 1 - next * next)) / Math.sqrt(Math.max(0.02, 1 - t * t)),
      at: f.at(offset, drum + 0.16 + radius * t, out),
      grad: [0.62, 1],
    });
  }
  pieces.push({
    shape: 'column',
    tone: 'accent',
    radius: radius * 0.1,
    height: radius * 0.5,
    at: f.at(offset, drum + 0.16 + radius, out),
    grad: [0.7, 1],
  });
  return pieces;
}

/** A slender tower: shaft, balcony, shaft, cap. */
function minaret(f: EdgeFrame, random: () => number, storey: number): Piece[] {
  const side = 0.62 + random() * 0.2;
  const inset = f.fit(side, 0.25);
  // Same rule as the dome: a tower four units tall standing off the edge of
  // the terrace has nothing holding it up, and it shows.
  if (inset < 0) return [];
  const out = -inset;
  const offset = (random() < 0.5 ? -1 : 1) * f.along * (0.3 + random() * 0.1);
  const pieces: Piece[] = [];
  let y = 0;

  const lifts = 2 + Math.floor(random() * 2);
  let w = side;
  for (let i = 0; i < lifts; i++) {
    const tall = storey * (0.85 + random() * 0.4);
    pieces.push({
      shape: 'box',
      tone: i % 2 === 0 ? 'pale' : 'stone',
      size: [w, tall, w],
      at: f.at(offset, y, out),
      grad: [0.45, 1],
    });
    y += tall;
    // The balcony: a thin disc oversailing the shaft, which is the one detail
    // that makes a tall thin thing read as a tower rather than a post.
    pieces.push({
      shape: 'column',
      tone: 'stone',
      radius: w * 1.05,
      height: 0.14,
      at: f.at(offset, y, out),
      grad: [0.82, 1],
    });
    y += 0.14;
    w *= 0.84;
  }
  pieces.push({ shape: 'column', tone: 'pale', radius: w * 0.62, height: w * 1.4, taper: 0.2, at: f.at(offset, y, out), grad: [0.6, 1] });
  return pieces;
}

/**
 * A wall with a way through it.
 *
 * The one motif that is unambiguously *structure* rather than ornament, and
 * the thing that turns a terrace into a courtyard. Two stretches with a
 * gateway between them, a capping course along the top to give it a top, and
 * buttresses at intervals — the buttresses are what stop a long straight wall
 * reading as a fence, because they give it a rhythm and a thickness.
 */
function wall(f: EdgeFrame, random: () => number, storey: number): Piece[] {
  const thick = 0.42;
  const out = -f.fit(thick, 0.32);
  const run = f.along * (0.62 + random() * 0.2);
  const height = storey * (0.42 + random() * 0.2);
  const gate = Math.min(run * 0.3, 2.1);
  const stretch = (run - gate) / 2;
  const pieces: Piece[] = [];

  for (const side of [-1, 1]) {
    const offset = (side * (run - stretch)) / 2;
    pieces.push(
      f.band(stretch, height, thick, offset, 0, out, 'pale', [0.42, 1]),
      // The capping course oversails, which is what makes the top of a wall a
      // top rather than the place the wall happens to stop.
      f.band(stretch + 0.24, 0.2, thick + 0.24, offset, height, out, 'stone', [0.72, 1]),
    );
  }

  // The gateway: piers, a corbelled head, and a lintel across.
  pieces.push({
    shape: 'arch',
    tone: 'pale',
    radius: gate / 2,
    tube: thick / 2,
    at: f.at(0, height * 0.52, out),
    turned: !f.horizontal,
    grad: [0.5, 1],
  });
  pieces.push(
    f.band(gate + thick, 0.24, thick + 0.18, 0, height * 0.52 + gate / 2 + 0.1, out, 'stone', [0.74, 1]),
  );

  // Buttresses, standing proud of the wall on the void side.
  const buttresses = 2 + Math.floor(random() * 2);
  for (let i = 0; i < buttresses; i++) {
    const at = (i / (buttresses - 1) - 0.5) * (run + thick * 2);
    if (Math.abs(at) < gate * 0.6) continue;
    pieces.push(f.band(thick * 0.9, height * 0.82, thick * 1.7, at, 0, out + thick * 0.8, 'pale', [0.38, 1]));
  }

  return pieces;
}

/**
 * Two posts and a wide flat roof: shade, with nothing under it.
 *
 * The lightest thing in the vocabulary and the one most often wanted. A
 * pavilion encloses; a canopy only shelters, so it can go on an edge a
 * pavilion could never fit on, and it leaves the view through it open — which
 * on a terrace where the whole point is the drop beyond is the difference
 * between framing it and blocking it.
 */
function canopy(f: EdgeFrame, random: () => number, storey: number): Piece[] {
  const post = 0.26;
  const out = -f.fit(post, 0.3);
  const run = Math.min(f.along * (0.42 + random() * 0.18), 5.2);
  const height = storey * (0.6 + random() * 0.16);
  const pieces: Piece[] = [];

  for (const side of [-1, 1]) {
    const offset = (side * run) / 2;
    pieces.push(
      f.band(post, height, post, offset, 0, out, 'pale', [0.44, 1]),
      // A bracket at the head of each post, angled in under the eaves.
      f.band(post * 2.2, 0.22, post * 1.4, offset, height - 0.22, out, 'stone', [0.7, 1]),
    );
  }

  // The roof: deep enough to oversail the posts on every side, in two courses.
  pieces.push(
    f.band(run + post * 3, 0.24, post * 5.5, 0, height, out, 'stone', [0.55, 0.9]),
    f.band(run + post * 1.8, 0.26, post * 4.4, 0, height + 0.24, out, 'pale', [0.68, 1]),
  );

  return pieces;
}

/**
 * A square tower, rising in setbacks under a stepped roof.
 *
 * The minaret is round, slender and all silhouette; this is its opposite
 * number — stout, four-sided, and read as mass rather than as a line. A
 * skyline wants both, and a world that only has one of them looks like it was
 * generated rather than built.
 */
function tower(f: EdgeFrame, random: () => number, storey: number): Piece[] {
  const base = 1.0 + random() * 0.35;
  const inset = f.fit(base, 0.2);
  // Mass stands on the terrace or it is not built, the same rule the dome and
  // the minaret answer to.
  if (inset < 0) return [];
  const out = -inset;
  const offset = (random() < 0.5 ? -1 : 1) * f.along * (0.22 + random() * 0.12);

  const pieces: Piece[] = [];
  let side = base;
  let y = 0;

  const stages = 2 + Math.floor(random() * 2);
  for (let i = 0; i < stages; i++) {
    const tall = storey * (0.5 + random() * 0.22);
    pieces.push(f.band(side, tall, side, offset, y, out, 'pale', [0.42 + i * 0.1, 1]));
    y += tall;
    // A string course marking each setback: the join is the detail.
    pieces.push(f.band(side + 0.2, 0.18, side + 0.2, offset, y, out, 'stone', [0.72, 1]));
    y += 0.18;
    side *= 0.78 - random() * 0.06;
  }

  // A window high up, so the tower reads as something with an inside.
  pieces.push(f.band(side * 0.34, side * 0.5, side + 0.06, offset, y - storey * 0.4, out, 'stone', [0.3, 0.7]));
  pieces.push(...roof(f.at(offset, 0, out)[0], y, f.at(offset, 0, out)[2], side + 0.3, side + 0.3, random));

  return pieces;
}

/** Wide shallow steps running down off the rim, like a bathing ghat. */
function ghat(f: EdgeFrame, random: () => number): Piece[] {
  const span = f.along * (0.5 + random() * 0.26);
  const pieces: Piece[] = [];
  const steps = 4 + Math.floor(random() * 4);
  let out = 0.1;
  let y = 0;

  for (let i = 0; i < steps; i++) {
    const tread = 0.42 + random() * 0.16;
    const rise = 0.3 + random() * 0.1;
    y -= rise;
    out += tread;
    pieces.push(f.band(span - i * 0.35, rise, tread, 0, y, out - tread / 2, i % 2 === 0 ? 'stone' : 'pale', [0.4, 1]));
  }
  return pieces;
}

/** A perforated screen: a frame filled with a lattice. */
function screen(f: EdgeFrame, random: () => number, storey: number): Piece[] {
  const thick = 0.18;
  const out = -f.fit(thick, 0.3);
  const span = f.along * (0.46 + random() * 0.2);
  const height = storey * (0.5 + random() * 0.22);
  const pieces: Piece[] = [
    f.band(span, 0.16, thick * 1.6, 0, 0, out, 'stone', [0.5, 1]),
    f.band(span, 0.16, thick * 1.6, 0, height, out, 'stone', [0.8, 1]),
  ];
  for (const side of [-1, 1]) {
    pieces.push(f.band(0.2, height, thick * 1.6, (side * span) / 2, 0, out, 'stone', [0.45, 1]));
  }

  // The lattice. Thin enough that at any distance it reads as a texture, which
  // is the point of a screen.
  const bars = 4 + Math.floor(random() * 4);
  for (let i = 1; i < bars; i++) {
    pieces.push(f.band(0.07, height, thick, -span / 2 + (span / bars) * i, 0, out, 'pale', [0.6, 1]));
  }
  const rows = 2 + Math.floor(random() * 2);
  for (let i = 1; i < rows; i++) {
    pieces.push(f.band(span, 0.07, thick, 0, (height / rows) * i, out, 'pale', [0.7, 1]));
  }
  return pieces;
}

/**
 * A water channel carried out over the drop on arches, and tipped off the end.
 *
 * The one piece of the vocabulary that is unmistakably *infrastructure* — it
 * was built to get water from somewhere to somewhere — and that is exactly
 * what makes it worth having. A campus of temples and terraces reads as a
 * monument; one aqueduct in it reads as a place people live.
 */
function aqueduct(f: EdgeFrame, random: () => number, storey: number): Piece[] {
  const bays = 3 + Math.floor(random() * 2);
  const bay = 1.5 + random() * 0.5;
  const span = bays * bay;
  const wide = 1.15;
  const deck = storey * (0.35 + random() * 0.12);
  const pieces: Piece[] = [];

  /**
   * It springs from the rim, and marches outward from there.
   *
   * Both halves of that sentence were wrong once. The run used to start most
   * of a unit out over the drop, which left the channel hanging in the air
   * with a gap between it and the terrace it was supposed to be carrying water
   * off — a viaduct to nowhere from nowhere. And the piers stepped outward
   * while the channel they carried ran along the rim, crossing every one of
   * them at right angles and resting on none.
   *
   * So: an abutment on the terrace itself, then bays outward, each on a longer
   * leg than the last because the ground fell away several units ago.
   */
  const abutment = f.fit(1.1, 0.5);
  pieces.push(
    // The abutment: the one part standing on the platform, which is what makes
    // the whole thing read as attached to something.
    f.band(wide * 1.35, deck + 0.5, 1.2, 0, 0, abutment, 'stone', [0.45, 1]),
  );

  const nose = -abutment;
  for (let i = 0; i < bays; i++) {
    const out = nose + 0.4 + i * bay;
    const leg = 3.2 + i * 1.6 + random() * 0.6;
    pieces.push(
      f.band(0.4, leg, 0.4, 0, deck - leg, out, 'pale', [0.36, 1]),
      // The bay it carries, spanning outward to the next pier.
      f.band(wide, 0.3, bay, 0, deck, out + bay / 2, 'stone', [0.55, 1]),
      {
        shape: 'arch',
        tone: 'pale',
        radius: bay * 0.44,
        tube: 0.13,
        at: f.at(0, deck - bay * 0.44 - 0.28, out + bay / 2),
        // The opening is between two piers, so it spans the way the piers
        // march: outward from the rim, not along it.
        turned: f.horizontal,
        grad: [0.5, 1],
      },
    );
  }

  // The channel along the top, running from the abutment all the way out.
  const from = nose;
  const to = nose + 0.4 + span;
  const middle = (from + to) / 2;
  const length = to - from;
  pieces.push(
    f.band(wide * 0.86, 0.36, length, 0, deck + 0.3, middle, 'stone', [0.62, 1]),
    // Water sits *down* in the trough, not flush with its rim. Flush is where
    // it was, and 0.3 + 0.36 is the same number as 0.54 + 0.12: the water's
    // surface and the stone coping shared a plane, overlapped, and differed in
    // colour, so the whole channel flickered between water and masonry as the
    // camera turned. Four centimetres of freeboard reads as a channel with
    // water in it anyway, which flush never quite did.
    f.band(wide * 0.56, 0.12, length - 0.3, 0, deck + 0.5, middle, 'water', [0.96, 1]),
  );

  // And the spill off the far end.
  const fall = 15 + random() * 6;
  pieces.push(f.band(wide * 0.56, fall, 0.36, 0, deck + 0.4 - fall, to, 'water', [0.94, 1]));

  return pieces;
}

/**
 * Water going over the edge, and the lip it goes over.
 *
 * The first version was three pale ribbons a hand's width across, hung off the
 * rim. From across the campus that is a scratch on the screen — it read as a
 * rendering fault rather than as the one dramatic thing on that terrace. A
 * waterfall is a set piece or it is nothing: a channel cut back into the
 * floor, a spill lip that overhangs, one broad sheet with a couple of narrower
 * ones beside it, and a haze at the bottom where it is already dissolving into
 * the fog. It takes the whole edge it is given.
 */
function waterfall(f: EdgeFrame, random: () => number): Piece[] {
  // The channel is the only part that stands on the floor, so it is the only
  // part that has to fit. Everything below the lip hangs off the edge at a
  // fixed reach: placing the fall itself with `fit` put it *inside* the
  // footprint on any platform with room to spare, which is directly behind the
  // rock that platform stands on — generated, correct, and never once seen.
  const inset = f.fit(0.55, 0.2);
  const wide = Math.min(f.along * 0.62, 5.2);
  const pieces: Piece[] = [
    // The channel: a shallow trough of water let into the floor, so the fall
    // comes from somewhere rather than starting in mid air.
    f.band(wide, 0.05, 0.55, 0, 0.02, inset, 'water', [0.95, 1]),
    // The lip, overhanging the drop. Dark stone, because the one thing that
    // makes a fall read as a fall is the shadow it comes out from under.
    //
    // Its top is kept just under the floor rather than level with it. A third of
    // the lip's depth lies inside the platform, so a top face at exactly floor
    // height was a six-by-a-third strip of dark stone sharing a plane with the
    // pale floor over it — the single widest z-fight in the office, and on the
    // one gesture that is supposed to be the thing you look at.
    f.band(wide + 0.7, 0.34, 0.8, 0, -0.4, 0.1, 'stone', [0.4, 0.8]),
  ];
  const out = 0.3;

  /**
   * One broad sheet down the middle and a narrower one either side.
   *
   * Three heavy sheets, not five thin ones: at this distance a thin sheet is a
   * scratch on the screen and five of them are a comb. There was a "haze" here
   * too — three wide pale slabs stacked under the lip, meant to read as spray.
   * They were thicker than the sheets and at the same reach, so what they
   * actually did was stand in front of the waterfall and hide it, which is why
   * the falls looked like a set of grey shelves bolted to the rim.
   */
  const sheets = 3;
  for (let i = 0; i < sheets; i++) {
    const middle = i / (sheets - 1) - 0.5;
    const offset = middle * wide * 0.62;
    let span = wide * (i === 1 ? 0.44 : 0.24 + random() * 0.06);
    // Stepped out a little from each other, so the sheets read as three falls
    // rather than as one slab with grooves in it.
    const reach = out + 0.3 + (i === 1 ? 0.22 : 0);

    /**
     * Each sheet falls in narrowing stages rather than as one long box.
     *
     * A single box is a pane of glass: constant width, two hard vertical
     * edges, a silhouette that is exactly a rectangle. Water does not do that
     * — it necks in as it falls and wanders off the line it started on. Three
     * stages, each a little narrower and nudged sideways, cost three boxes and
     * turn the pane into something falling.
     *
     * The gradient is flat on purpose. Everything else in the office is lit by
     * the direction it faces and shaded toward its foot, which is what makes
     * stone read as stone — and what turned a fall into a slab of wet slate,
     * because the face a fall presents to the camera is usually the one
     * pointing at neither of the two lit directions. Water is bright all the
     * way down; the only thing that takes anything off it is the fog it ends
     * in. Long enough, too, to reach that fog from the highest terrace a world
     * can put one on: a fall that stops short ends in a horizontal line, and
     * there is no such thing as the bottom edge of a waterfall.
     */
    let y = -0.2;
    let wander = offset;
    for (let stage = 0; stage < 3; stage++) {
      const drop = (stage === 2 ? 13 : 3 + random() * 2.5) + random() * 2;
      pieces.push(f.band(span, drop, 0.34, wander, y - drop, reach, 'water', [0.94, 1]));
      y -= drop;
      span *= 0.74 + random() * 0.12;
      wander += (random() - 0.5) * wide * 0.16;
    }
  }

  return pieces;
}

/** Four columns and a flat roof: a room's worth of shade, standing free. */
function pavilion(platform: Platform, random: () => number, storey: number): Piece[] {
  const [width, depth] = platform.size;
  const ring = walkableRing(platform);
  const radius = 0.16;
  const insetX = ring[0] - CLEARANCE - BODY - radius;
  const insetZ = ring[1] - CLEARANCE - BODY - radius;
  if (insetX < 0 || insetZ < 0) return [];

  const height = storey * (0.72 + random() * 0.2);
  const x = width / 2 - Math.min(0.5, insetX);
  const z = depth / 2 - Math.min(0.5, insetZ);
  const pieces: Piece[] = [];

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      pieces.push({ shape: 'column', tone: 'pale', radius, height, at: [sx * x, 0, sz * z], grad: [0.45, 1] });
    }
  }
  pieces.push(...roof(0, height, 0, 2 * x + 1.1, 2 * z + 1.1, random));
  return pieces;
}

/**
 * A stepped roof.
 *
 * Two flat courses and a finial was what a pavilion wore, and two flat courses
 * is a lid: it stops the columns without giving the building a top. A roof has
 * to come to a point, and in a world made of planes it gets there in steps —
 * each course a little smaller and a little higher than the one below, which
 * is how a hipped roof is drawn in a Japanese print and how everything else in
 * this office is already cut.
 *
 * Shared, because a raised terrace wants one too, and two things wearing the
 * same roof is most of what makes them look like one building.
 */
function roof(
  x: number,
  y: number,
  z: number,
  width: number,
  depth: number,
  random: () => number,
): Piece[] {
  const pieces: Piece[] = [];
  // The eaves oversail the columns, which is the whole reason a roof reads as
  // shelter rather than as a cap.
  let w = width + 0.5;
  let d = depth + 0.5;
  let top = y;

  // A thin dark fascia under the eaves, and pale courses above it. Cutting the
  // whole bottom course from the dark stone made the roof the heaviest thing
  // in the frame — a slab of chocolate balanced on four pale sticks.
  pieces.push({
    shape: 'box',
    tone: 'stone',
    size: [w + 0.16, 0.12, d + 0.16],
    at: [x, y - 0.12, z],
    grad: [0.42, 0.8],
  });

  const courses = 3 + Math.floor(random() * 2);
  for (let i = 0; i < courses; i++) {
    const tall = i === 0 ? 0.22 : 0.26 + random() * 0.1;
    pieces.push({
      shape: 'box',
      tone: 'pale',
      size: [w, tall, d],
      at: [x, top, z],
      grad: [0.56 + i * 0.09, 1],
    });
    top += tall;
    const shrink = 0.62 + random() * 0.08;
    w *= shrink;
    d *= shrink;
  }

  pieces.push(
    { shape: 'box', tone: 'stone', size: [w * 1.5, 0.14, d * 1.5], at: [x, top, z], grad: [0.78, 1] },
    { shape: 'column', tone: 'accent', radius: 0.13, height: 0.46, taper: 0.22, at: [x, top + 0.14, z], grad: [0.72, 1] },
  );
  return pieces;
}

/** A standing slab with an opening cut through it. Pure Escher. */
function pylon(f: EdgeFrame, random: () => number, storey: number): Piece[] {
  const thick = 0.34;
  const out = -f.fit(thick, 0.3);
  const width = f.along * (0.26 + random() * 0.12);
  const height = storey * (0.8 + random() * 0.3);
  const holeW = width * 0.44;
  const sill = height * 0.3;
  const head = height * 0.72;
  const jamb = (width - holeW) / 2;

  return [
    f.band(width, sill, thick, 0, 0, out, 'stone', [0.4, 1]),
    f.band(jamb, head - sill, thick, -(holeW + jamb) / 2, sill, out, 'stone', [0.55, 1]),
    f.band(jamb, head - sill, thick, (holeW + jamb) / 2, sill, out, 'stone', [0.55, 1]),
    f.band(width, height - head, thick, 0, head, out, 'stone', [0.75, 1]),
    // One pale course, so the slab has a horizon of its own.
    f.band(width * 1.08, 0.12, thick * 1.3, 0, head - 0.12, out, 'pale', [0.85, 1]),
  ];
}

// ---------- the small ones ----------

function minor(kind: Accentpiece, platform: Platform, edge: Edge, random: () => number): Piece[] {
  if (kind === 'none') return [];
  const f = frameFor(platform, edge);

  if (kind === 'pool') {
    // A still sheet of water at the rim, with a thin lip. Half of why the
    // waterfalls read: water belongs to this place, not just to its edges.
    const out = -f.fit(1.1, 0.2);
    const span = f.along * (0.3 + random() * 0.2);
    return [
      f.band(span + 0.24, 0.12, 1.24, 0, 0, out, 'stone', [0.6, 1]),
      f.band(span, 0.06, 1.0, 0, 0.12, out, 'water', [0.92, 1]),
    ];
  }

  if (kind === 'planter') {
    const out = -f.fit(0.9, 0.25);
    const offset = (random() < 0.5 ? -1 : 1) * f.along * 0.24;
    return [
      f.band(0.9, 0.3, 0.9, offset, 0, out, 'stone', [0.55, 1]),
      {
        shape: 'column',
        tone: 'plant',
        radius: 0.36,
        height: 0.95 + random() * 0.35,
        taper: 0.1,
        at: f.at(offset, 0.3, out),
        grad: [0.5, 1],
      },
    ];
  }

  // A lantern: a slim post with a lit head. The one thing in the vocabulary
  // that carries the accent colour, and the only thing that reads at night.
  const out = -f.fit(0.24, 0.2);
  const offset = (random() - 0.5) * f.along * 0.5;
  const post = 1.1 + random() * 0.6;
  return [
    { shape: 'column', tone: 'pale', radius: 0.09, height: post, at: f.at(offset, 0, out), grad: [0.5, 1] },
    { shape: 'column', tone: 'accent', radius: 0.17, height: 0.3, taper: 0.6, at: f.at(offset, post, out), grad: [0.8, 1] },
  ];
}

/**
 * What a stacked terrace visibly rests on, and what actually holds it up.
 *
 * Those are two different things, and separating them is what makes this work.
 * The *posts* are the only part standing on the host's floor, so they are the
 * only part that can wall somebody in — and on a busy platform they often do,
 * which is why they come as a series of weaker and weaker options for the
 * planner to walk down. Everything else — the corbels, the beams under the
 * slab, the arch between the legs — lives at head height and above, where the
 * occupancy grid ignores it, so it is always drawn. That is the half that
 * carries the *look* of being held up, and drawing it unconditionally is why a
 * terrace reduced to a single column still reads as architecture rather than
 * as a slab someone forgot to drop.
 */
interface Support {
  /** Standing on the host's floor. Tried most generous first. */
  posts: Piece[][];
  /** Overhead, and always built. */
  canopy: Piece[];
}

function pierLayouts(upper: Platform, host: Platform, random: () => number, storey: number): Support {
  const rise = levelY(upper.level) - levelY(host.level) - PLATFORM_THICKNESS;
  if (rise < 1) return { posts: [[]], canopy: [] };

  const side = 0.34 + random() * 0.12;
  const dx = upper.position[0] - host.position[0];
  const dz = upper.position[1] - host.position[1];
  const inset = side * 0.8;
  const halfX = upper.size[0] / 2 - inset;
  const halfZ = upper.size[1] / 2 - inset;

  /**
   * How deep the overhead beams are, and therefore how far a leg that lands
   * under one has to stop short.
   *
   * A post that runs the full rise passes straight through the beam it is
   * carrying and comes out level with its top face — two upward faces on one
   * plane, pale against stone, which flickers as the camera turns. A post stops
   * at the soffit of whatever it holds up, which is also the only way round it.
   */
  const BEAM_DEPTH = 0.3;
  const post = (x: number, z: number, thick = side, height = rise): Piece[] => [
    { shape: 'box', tone: 'pale', size: [thick, height, thick], at: [x, 0, z], grad: [0.44, 1] },
  ];

  // Which way the middle of the host lies: supports crowd toward that side,
  // because the outer side is rim and the rim is where people walk.
  const inX = Math.sign(host.position[0] - upper.position[0]) || 1;
  const inZ = Math.sign(host.position[1] - upper.position[1]) || 1;

  // Four legs, at the terrace's corners and then pulled well in from them.
  // The inner ring is the one that usually survives a furnished host: its legs
  // land in the gap between the furniture and the walkway rather than in the
  // walkway itself, and a deck standing on four legs — wherever they are — is
  // worth a great deal more than a deck standing on one.
  const ring = (scale: number): Piece[] => {
    // At full spread the legs stand exactly under the beam crossings, so they
    // stop at the soffit. Pulled in, they are under the slab itself and carry
    // it directly, so they go all the way up.
    const height = scale === 1 ? rise - BEAM_DEPTH : rise;
    return [
      ...post(dx - halfX * scale, dz - halfZ * scale, side, height),
      ...post(dx + halfX * scale, dz - halfZ * scale, side, height),
      ...post(dx - halfX * scale, dz + halfZ * scale, side, height),
      ...post(dx + halfX * scale, dz + halfZ * scale, side, height),
    ];
  };
  // Two posts on the inner edge, the deck cantilevered out over the rim. Both
  // stand under the beam along that edge.
  const cantilever = [
    ...post(dx + inX * halfX, dz - halfZ * 0.55, side, rise - BEAM_DEPTH),
    ...post(dx + inX * halfX, dz + halfZ * 0.55, side, rise - BEAM_DEPTH),
  ];
  // One, tucked into the inner corner.
  const single = post(dx + inX * halfX * 0.6, dz + inZ * halfZ * 0.6, side * 1.15);
  // A stout trunk under the middle: nothing to walk around at all.
  const trunk: Piece[] = [
    { shape: 'column', tone: 'pale', radius: side * 1.3, height: rise * 0.82, taper: 0.82, at: [dx, 0, dz], grad: [0.44, 1] },
    // A spreading capital. The one thing that stops a single column reading as
    // a stick with a plate balanced on it.
    { shape: 'column', tone: 'pale', radius: side * 1.05, height: rise * 0.18, taper: 2.4, at: [dx, rise * 0.82, dz], grad: [0.62, 1] },
  ];

  // ---- overhead, always built ----
  const canopy: Piece[] = [];
  const beamY = rise - BEAM_DEPTH;
  for (const sz of [-1, 1]) {
    canopy.push({
      shape: 'box',
      tone: 'stone',
      size: [halfX * 2 + side * 1.9, BEAM_DEPTH, side * 1.2],
      at: [dx, beamY, dz + sz * halfZ],
      grad: [0.5, 0.95],
    });
  }
  for (const sx of [-1, 1]) {
    canopy.push({
      shape: 'box',
      tone: 'stone',
      size: [side * 1.2, BEAM_DEPTH, halfZ * 2 + side * 1.9],
      at: [dx + sx * halfX, beamY, dz],
      grad: [0.5, 0.95],
    });
  }
  // Corbels where the beams cross, so the frame has joints.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      canopy.push({
        shape: 'box',
        tone: 'pale',
        size: [side * 1.9, 0.34, side * 1.9],
        at: [dx + sx * halfX, beamY - 0.34, dz + sz * halfZ],
        grad: [0.66, 1],
      });
    }
  }
  if (random() < 0.75) {
    // An arch between the outer legs, so what you walk under is a doorway.
    const radius = Math.min(halfX * 0.92, storey * 0.42);
    canopy.push({
      shape: 'arch',
      tone: 'pale',
      radius,
      tube: 0.16,
      at: [dx, Math.max(0.3, beamY - radius - 0.5), dz - inZ * halfZ],
      turned: false,
      grad: [0.6, 1],
    });
  }

  return { posts: [ring(1), ring(0.62), cantilever, single, trunk], canopy };
}

/**
 * A low wall around a stacked terrace.
 *
 * Every upper deck gets one, rather than taking its chances with the motif
 * system: a terrace you can walk off the edge of reads as an accident, and
 * these are small enough that most of the vocabulary declines to stand on them
 * anyway. Gapped at the head of the stair, which is the way on.
 */
function parapet(platform: Platform, random: () => number, roofed: number): Piece[] {
  const [width, depth] = platform.size;
  const tall = 0.42 + random() * 0.18;
  const thick = 0.22;
  const pieces: Piece[] = [];

  for (const edge of EDGES) {
    const f = frameFor(platform, edge);
    // One continuous stretch down the middle of each side, leaving the corners
    // open. Two short lengths with a gap between them, which is what this did,
    // reads from any distance as four broken teeth rather than as a wall.
    pieces.push(f.band(f.along * 0.76, tall, thick, 0, 0, -thick / 2, 'pale', [0.55, 1]));
    // A pier at each end of the stretch, so it terminates rather than stops.
    for (const side of [-1, 1]) {
      pieces.push(
        f.band(thick * 1.7, tall * 1.3, thick * 1.7, (side * f.along * 0.76) / 2, 0, -thick / 2, 'pale', [0.6, 1]),
      );
    }
  }

  /**
   * Some of them are roofed.
   *
   * A terrace with a roof on it is a *building* standing on another building,
   * which is the thing being reached for; a terrace without one is a lookout.
   * Both are worth having, so it is a coin toss — but the roof only goes on
   * the corners, clear of the one way on and off, because there are no seats
   * up here to route around and nothing to be gained by boxing it in.
   */
  if (random() < roofed) {
    const post = 0.2;
    const x = width / 2 - post * 2.2;
    const z = depth / 2 - post * 2.2;
    const height = 2.2 + random() * 0.7;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        pieces.push({
          shape: 'column',
          tone: 'pale',
          radius: post,
          height,
          at: [sx * x, 0, sz * z],
          grad: [0.48, 1],
        });
      }
    }
    pieces.push(...roof(0, height, 0, 2 * x + 0.9, 2 * z + 0.9, random));
  }

  return pieces;
}

// ---------- the rock underneath ----------

/**
 * How far the rock reaches below the lowest terrace, in world units.
 *
 * It used to be an absolute depth, which held only while every campus sat
 * near y = 0. A world that is a hillside has terraces well below that, and an
 * absolute floor either buries them or leaves them standing on nothing. The
 * floor is a property of the campus now, so a world keeps its proportions
 * however high or low it happens to sit.
 */
const ROCK_REACH = 15;

/**
 * Where the world stops being solid, for one campus.
 *
 * Deep on purpose. The rock has to end *inside* the height fog — below the
 * point the fade has finished — or the office stands on a row of flat-bottomed
 * boxes hanging in the sky. Only the top few units of it are ever seen; the
 * rest is there so there is no bottom to see.
 */
export function bedrockOf(campus: Campus): number {
  return lowestFloor(campus) - ROCK_REACH;
}

/** The y of the lowest walkable floor in a campus. */
export function lowestFloor(campus: Campus): number {
  let lowest = Infinity;
  for (const platform of campus.platforms) lowest = Math.min(lowest, levelY(platform.level));
  return Number.isFinite(lowest) ? lowest : 0;
}

/**
 * The mass a platform stands on.
 *
 * Every one reaches the same depth, so a terrace high up stands on a tall rock
 * and one near the bottom sits almost on the ground — which is what ties
 * terraces at different heights into one landscape rather than a set of trays.
 *
 * Two things matter about how it is cut. It steps in as it goes down, which is
 * what makes it read as carved rather than as a plinth; and it stays *pale*.
 * The obvious move is the dark side tone with the usual base darkening, and
 * with the short rocks this used to make that was fine. Now that a world is a
 * hillside the tallest of these is most of the frame, and a dozen unrelieved
 * chocolate columns is what the office looks like. The first course takes the
 * dark tone because that is the shadow under the terrace; everything under it
 * lightens toward the fog it is about to disappear into.
 */
/**
 * What kind of rock a platform stands on.
 *
 * One parametric family, however carefully tuned, gives every platform the same
 * rock: thirteen leaning wedding cakes of slightly different proportions, which
 * across a campus read as a set of table legs holding up a floor plan. A third
 * of the frame is underneath the office and all of it looked the same.
 *
 * Monument Valley is not shy about this — a structure sits on a sheer monolith,
 * or on a slender stalk, or on nothing whatever, and the differences are large.
 * So the character is chosen first and the parameters follow from it, rather
 * than every platform sampling the middle of one distribution.
 *
 * `none` is the important one and the reason this is worth doing. A platform
 * with nothing under it is the single most Monument Valley thing the office can
 * do, and it costs no geometry at all.
 */
type RockKind = 'stepped' | 'sheer' | 'stalk' | 'none';

function rockKind(random: () => number): RockKind {
  const roll = random();
  if (roll < 0.34) return 'stepped';
  if (roll < 0.62) return 'sheer';
  if (roll < 0.84) return 'stalk';
  return 'none';
}

function substructure(platform: Platform, random: () => number, bedrock: number): Piece[] {
  const [width, depth] = platform.size;
  const reach = Math.max(1.2, levelY(platform.level) - bedrock);
  const kind = rockKind(random);
  // Nothing at all: the terrace simply ends, and the campus gets some air in it.
  if (kind === 'none') return [];
  // A sheer face wants few, tall courses; a stalk wants many, so it can neck
  // down convincingly instead of jumping to a point in two jumps.
  const steps =
    kind === 'sheer'
      ? Math.max(2, Math.min(3, 1 + Math.round(reach / 6)))
      : kind === 'stalk'
        ? Math.max(4, Math.min(7, 3 + Math.round(reach / 2.6)))
        : Math.max(3, Math.min(6, 2 + Math.round(reach / 3.4)));
  const pieces: Piece[] = [];

  /**
   * Which way the rock leans.
   *
   * Courses stepping in by the same amount on all four sides give a stack of
   * concentric boxes — a wedding cake, and thirteen of them across a campus
   * read as a set rather than as ground. A cliff is cut back harder on one
   * side than the other, so each platform picks a direction once and every
   * course under it drifts that way.
   */
  const lean: [number, number] = [random() - 0.5, random() - 0.5];
  // A sheer cliff barely leans — that is what makes it read as sheer.
  const bite = (0.55 + random() * 0.5) * (kind === 'sheer' ? 0.25 : 1);

  let w = width * (kind === 'sheer' ? 0.98 : 0.92);
  let d = depth * (kind === 'sheer' ? 0.98 : 0.92);
  let x = 0;
  let z = 0;
  let y = -0.55;
  let left = reach;

  for (let i = 0; i < steps; i++) {
    // Each course takes a shrinking share of what is left, so the visible top
    // of the rock is finely cut and the invisible bottom is one long block.
    const tall = i === steps - 1 ? left : Math.min(left - 0.4, 0.9 + random() * 1.3 + i * 0.6);
    const shade = i / Math.max(1, steps - 1);
    // How hard each course cuts in, which is the whole difference between the
    // three: a cliff holds its width, a stalk necks away to a shaft.
    const [base, spread] = kind === 'sheer' ? [0.97, 0.03] : kind === 'stalk' ? [0.72, 0.1] : [0.86, 0.08];
    const shrinkX = base - random() * spread;
    const shrinkZ = base - random() * spread;

    pieces.push({
      shape: 'box',
      tone: 'stone',
      size: [w, tall, d],
      at: [x, y - tall, z],
      // Bottom of the ramp, top of the ramp. Both rise with depth: the deeper
      // the course, the less the gradient takes off it.
      grad: [0.3 + shade * 0.55, 0.86 + shade * 0.14],
    });

    y -= tall;
    left -= tall;
    // Half of what a course loses comes off the leaning side, so the face on
    // that side stays nearly sheer while the other cuts back in steps.
    x += (w * (1 - shrinkX)) / 2 * lean[0] * bite * 2;
    z += (d * (1 - shrinkZ)) / 2 * lean[1] * bite * 2;
    w *= shrinkX;
    d *= shrinkZ;
  }
  return pieces;
}

/**
 * Architecture built in the void, where there is no walkable floor to spend.
 */
function voidWorks(campus: Campus, random: () => number, gateway: number): Piece[] {
  const pieces: Piece[] = [];

  // Gateways over the bridges. Only bridges: a flight of stairs is already a
  // strong enough piece of architecture on its own, and an arch pitched over a
  // slope reads as a mistake from most angles.
  for (const connector of campus.connectors) {
    if (connector.kind !== 'bridge') continue;
    if (random() > gateway) continue;

    const midX = (connector.a[0] + connector.b[0]) / 2;
    const midZ = (connector.a[2] + connector.b[2]) / 2;
    const y = connector.a[1];
    const alongX = connector.axis === 'x';
    // Just outside the walkway, so the way across stays the width it looks.
    const offset = connector.width / 2 + 0.42;
    const height = 2.0 + random() * 0.8;
    // Just far enough down to read as a support. Any deeper and the piers
    // become two black bars with an office behind them.
    const drop = 0.35 + random() * 0.45;

    for (const side of [-1, 1]) {
      pieces.push({
        shape: 'box',
        tone: 'pale',
        size: [0.34, height + drop, 0.34],
        at: [midX + (alongX ? 0 : side * offset), y - drop, midZ + (alongX ? side * offset : 0)],
        grad: [0.6, 1],
      });
    }
    pieces.push({
      shape: 'arch',
      tone: 'pale',
      radius: offset,
      tube: 0.17,
      at: [midX, y + height, midZ],
      turned: alongX,
      grad: [0.7, 1],
    });
  }


  return pieces;
}


// ---------- where not to build ----------

/**
 * Edges a walkway already meets. Building across one would leave figures
 * walking through a column to reach the stairs.
 */
function doorwayEdges(campus: Campus): Map<string, Set<Edge>> {
  const out = new Map<string, Set<Edge>>();
  const mark = (platformId: string, edge: Edge): void => {
    const set = out.get(platformId) ?? new Set<Edge>();
    set.add(edge);
    out.set(platformId, set);
  };

  const byId = new Map(campus.platforms.map((platform) => [platform.id, platform]));
  for (const connector of campus.connectors) {
    const from = byId.get(connector.from);
    const to = byId.get(connector.to);
    if (from) mark(from.id, edgeToward(from, connector.a));
    if (to) mark(to.id, edgeToward(to, connector.b));
  }
  return out;
}

function edgeToward(platform: Platform, point: [number, number, number]): Edge {
  const dx = point[0] - platform.position[0];
  const dz = point[2] - platform.position[1];
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west';
  return dz > 0 ? 'south' : 'north';
}

// ---------- pieces → geometry ----------

/**
 * Tone names → the theme's colours.
 *
 * Architecture borrows the platform's own palette rather than bringing its
 * own. A building the same few colours as the ground it stands on reads as
 * carved out of the campus; one with its own palette reads as dropped onto it.
 */
function palette(theme: ResolvedTheme, variant = 0): Record<Tone, string> {
  // Whatever stone the platform is cut from, the building on it is cut from the
  // same — that is what makes architecture read as carved out of the campus
  // rather than dropped onto it, and it is now a per-platform answer rather
  // than a per-theme one.
  const stone = stoneVariant(theme, variant);
  return {
    stone: stone.side,
    pale: mixHex(stone.top, theme.tones.top, 0.5),
    accent: theme.accent,
    plant: theme.id === 'ink' ? theme.accent : '#6E9E62',
    /**
     * Cool, and deliberately not the sky.
     *
     * Water was the accent blended into the sky, which in a warm theme is very
     * nearly the colour of the fog a waterfall falls through — the falls were
     * generated, placed, rendered and invisible, three passes running. Pulling
     * it toward the theme's own cold end was not enough either, because the
     * cold end of a sunset is still a pastel of the same value.
     *
     * So water is the one thing in the office with a colour of its own. It
     * takes a little of the platform stone so it still belongs to the theme,
     * and nothing else: a fall has to read from across the campus against a
     * peach horizon at noon and a lavender one at midnight.
     */
    water: mixHex('#63C3E8', theme.platform.top, 0.18),
  };
}

/** One draw call for a set of pieces, in whatever space they were planned in. */
export function archGeometry(pieces: readonly Piece[], theme: ResolvedTheme, variant = 0): BufferGeometry | null {
  if (pieces.length === 0) return null;
  const colors = palette(theme, variant);
  const parts: Part[] = [];

  for (const piece of pieces) {
    const color = colors[piece.tone];
    if (piece.shape === 'box') {
      parts.push(
        box(piece.size[0], piece.size[1], piece.size[2], {
          color,
          position: piece.at,
          grad: piece.grad,
          ...(piece.rotY === undefined ? {} : { rotation: [0, piece.rotY, 0] as [number, number, number] }),
        }),
      );
      continue;
    }
    if (piece.shape === 'column') {
      parts.push(
        cylinder(
          piece.radius,
          piece.height,
          { color, position: piece.at, grad: piece.grad },
          14,
          piece.radius * (piece.taper ?? 1),
        ),
      );
      continue;
    }
    parts.push(...corbelArch(piece, color));
  }

  return buildProp(parts);
}

/** How many courses an arch is corbelled out of. */
const ARCH_COURSES = 6;

/**
 * An arch, cut the way this office cuts everything else: in flat courses.
 *
 * It was a half torus, which is the obvious way to get an arch and the wrong
 * one here. Every other surface in the world is a flat plane meeting another
 * flat plane at an edge, and a smooth swept tube among them reads as a piece
 * of macaroni laid over the architecture — the facet shader has nothing to
 * grip, so it shades as a soft gradient while its neighbours stay crisp.
 *
 * A corbelled arch is the same opening built as stone actually corbels one:
 * courses stepping inward until they meet. It is flat, it is faceted, its
 * soffit follows a true circle, and it is what the arches in a Moorish
 * courtyard look like from across the room.
 */
export function corbelArch(piece: Extract<Piece, { shape: 'arch' }>, color: string): Part[] {
  const { radius, tube, at, grad, turned } = piece;
  const course = radius / ARCH_COURSES;
  const parts: Part[] = [];

  for (let i = 0; i < ARCH_COURSES; i++) {
    const y = at[1] + i * course;
    // The soffit follows the circle: each course starts where the arc has got
    // to by the time it reaches that course's *top*, so no course ever
    // intrudes into the opening.
    const top = Math.min(radius, (i + 1) * course);
    const inner = Math.sqrt(Math.max(0, radius * radius - top * top));
    const outer = radius + tube;
    const width = outer - inner;
    if (width <= 0.001) continue;

    for (const side of [-1, 1]) {
      const centre = side * (inner + width / 2);
      parts.push(
        box(turned ? tube * 2 : width, course, turned ? width : tube * 2, {
          color,
          position: [at[0] + (turned ? 0 : centre), y, at[2] + (turned ? centre : 0)],
          grad,
        }),
      );
    }
  }

  // The keystone closing the last of the gap, and a thin cap over the whole
  // head so the corbelling reads as one piece rather than as a pile.
  const cap = (radius + tube) * 2;
  parts.push(
    box(turned ? tube * 2 : cap, tube * 0.9, turned ? cap : tube * 2, {
      color,
      position: [at[0], at[1] + radius, at[2]],
      grad: [Math.min(1, grad[1]), 1],
    }),
  );

  return parts;
}

/**
 * What of a platform's architecture a figure cannot walk through.
 *
 * Declared rather than rasterized from the geometry, because the two answers
 * differ where it matters: an arch rasterizes as a solid wall, when the whole
 * point of an arch is that you walk under it.
 */
export function archBlockers(pieces: readonly Piece[]): Blocker[] {
  const out: Blocker[] = [];
  for (const piece of pieces) {
    if (piece.shape === 'box') {
      // A yawed box is stamped by its bounding box, which is larger than the
      // box. Deliberately: a hair of rotation must not open a gap the router
      // will happily send someone through and the renderer will then clip.
      const [width, height, depth] = piece.size;
      const yaw = piece.rotY ?? 0;
      const cos = Math.abs(Math.cos(yaw));
      const sin = Math.abs(Math.sin(yaw));
      out.push({
        x: piece.at[0],
        z: piece.at[2],
        halfWidth: (width * cos + depth * sin) / 2,
        halfDepth: (width * sin + depth * cos) / 2,
        base: piece.at[1],
        top: piece.at[1] + height,
      });
      continue;
    }
    if (piece.shape === 'column') {
      const radius = Math.max(piece.radius, piece.radius * (piece.taper ?? 1));
      out.push({
        x: piece.at[0],
        z: piece.at[2],
        halfWidth: radius,
        halfDepth: radius,
        base: piece.at[1],
        top: piece.at[1] + piece.height,
      });
      continue;
    }
    // Only an arch's two feet are in the way.
    const foot = piece.tube * 1.25;
    for (const side of [-1, 1]) {
      out.push({
        x: piece.at[0] + (piece.turned ? 0 : side * piece.radius),
        z: piece.at[2] + (piece.turned ? side * piece.radius : 0),
        halfWidth: foot,
        halfDepth: foot,
        base: piece.at[1],
        top: piece.at[1] + piece.radius,
      });
    }
  }
  return out;
}

/** Merges the freestanding pieces, which are already in world coordinates. */
export function detachedGeometry(plan: ArchPlan, theme: ResolvedTheme): BufferGeometry | null {
  return archGeometry(plan.detached, theme);
}

/** One geometry for every platform's architecture, placed into the world. */
export function campusArchGeometry(
  campus: Campus,
  plan: ArchPlan,
  theme: ResolvedTheme,
  /** A room that has not been built yet has nothing standing on it. */
  includes: (platform: Platform) => boolean = () => true,
): BufferGeometry | null {
  const parts: BufferGeometry[] = [];
  for (const platform of campus.platforms) {
    if (!includes(platform)) continue;
    const pieces = plan.onPlatform.get(platform.id);
    if (!pieces) continue;
    const geometry = archGeometry(pieces, theme, platform.stone);
    if (!geometry) continue;
    geometry.translate(platform.position[0], levelY(platform.level), platform.position[1]);
    parts.push(geometry);
  }
  const loose = detachedGeometry(plan, theme);
  if (loose) parts.push(loose);
  if (parts.length === 0) return null;
  const merged = parts.length === 1 ? parts[0]! : mergeGeometries(parts);
  return merged ?? null;
}
