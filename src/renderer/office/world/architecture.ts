import type { BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng } from '@shared/rand';
import type { OfficeDetail } from '@shared/prefs';
import { box, buildProp, cylinder, tagStage, type Part } from '../props/kit';
import { buildPropFor } from '../props/registry';
import { mixHex, stoneVariant, type ResolvedTheme } from '../theme/themes';
import { levelY, PLATFORM_THICKNESS } from './campusTemplate';
import { walkableRing, walkwaySpan, type Campus, type Platform } from './layout';
import { HEAD_CLEARANCE, buildOccupancy, type Blocker } from './occupancy';

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
      /**
       * How far this piece has already dissolved into the sky, 0–1.
       *
       * Only water uses it. The shader dissolves everything into the sky as it
       * nears the void plane, which is the right rule for a building standing
       * on rock and the wrong one for a waterfall: the void is set from the
       * lowest *floor*, and a fall starts below that and keeps going, so it ran
       * off the bottom of the window still fully saturated. A fall has to
       * dissolve because it is falling, not because of where the ground is.
       */
      fade?: number;
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

/**
 * The two motifs every world gets, whatever else it favours.
 *
 * Weights alone cannot guarantee anything, and these two are worth guaranteeing:
 *
 * - **Water**, because a waterfall is the only moving thing the architecture
 *   has, and the biggest single gesture in the whole kit. A campus with one is
 *   a place; a campus without is a model.
 * - **Cloth**, because everything else here is cut stone and does not bend.
 *   The drape is the one object in the vocabulary that hangs, and the eye reads
 *   the sag as weight precisely because nothing else in the frame gives at all.
 *
 * They are *mandated*, not merely available: each gets first refusal on a
 * platform before the ordinary budget rolls, so a world cannot simply fail to
 * show them the way it could when they were one option among three.
 */
const ALWAYS: Motif[] = ['waterfall', 'drape'];

export interface ArchPlan {
  /** What this world prefers to build, most-favoured first. See `worldVoice`. */
  favoured: Motif[];
  /**
   * What is actually standing, per platform.
   *
   * The plan used to say only where the *geometry* went, which meant nothing
   * downstream — not a test, not Settings — could ask the simple question
   * "did this world build a waterfall". It is one map and it costs nothing.
   */
  motifs: Map<string, Motif>;
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
  | 'pylon'
  | 'drape'
  | 'sail';
type Accentpiece = 'pool' | 'lantern' | 'planter' | 'none';

/** Which side of a platform a piece sits on. */
type Edge = 'north' | 'south' | 'east' | 'west';
const EDGES: Edge[] = ['north', 'south', 'east', 'west'];

/**
 * What a world is built out of.
 *
 * It used to speak a *dialect*: three motifs out of thirteen, chosen once from
 * the seed, and nothing else — ever. That gave every campus a strong accent,
 * which was the point, and it had a cost nobody notices until they have had
 * the app open for a month: the other ten motifs are not rare in your world,
 * they are permanently absent from it. Rebuilding the world gave you a
 * different three, not more of them.
 *
 * So every world can now build anything, and what differs between worlds is
 * what it *prefers*. Uniqueness has to come from the ordering rather than from
 * rolling the dice per platform — the whole bank drawn uniformly is not a bank
 * full of interesting worlds, it is the same soup every time, and a campus
 * wearing one of everything is a curiosity shop rather than a building.
 *
 * Opening the bank up is also what turned up the older bug underneath it. Four
 * of the heavy gestures — the dome, the tower, the minaret, the pavilion —
 * asked `f.fit` whether the terrace could hold them, which is a test none of
 * them can pass on any platform the generator makes, so all four declined
 * everywhere and always had. Under dialects that was invisible: a world fond
 * of domes simply built the other two. Under weights it is a world fond of
 * domes with no dome in it. They stand on `f.clear` now; see `EdgeFrame`.
 *
 * The weights below are the whole of that argument:
 *
 * - The top three carry most of it. On a campus of about ten shared platforms
 *   at the ornate budget, roughly eight get a gesture — so a 7 / 5 / 3.5 split
 *   over a baseline of 1 puts four or five of them in the favoured three and
 *   leaves two or three for the rest of the bank. That is a place with an
 *   accent that also has surprises in it.
 * - The tail is never zero. One unexpected thing is what makes a world feel
 *   built rather than generated, and it is also the only way somebody ever
 *   sees the other ten.
 * - Saturation is not this table's problem. `MOTIF_CAP` already stops three
 *   minarets becoming seven, and it applies whatever the weights say — being
 *   fond of towers must not turn a skyline into a fence.
 */
const FAVOUR = [7, 5, 3.5];
const BASELINE = 1;

export interface WorldVoice {
  /** In order. The first is the one you would name the world after. */
  favoured: Motif[];
  weight: Map<Motif, number>;
}

/** What a motif is called, where a person has to read it. */
export const MOTIF_NAMES: Record<Motif, string> = {
  arcade: 'colonnades',
  minaret: 'minarets',
  dome: 'domes',
  canopy: 'canopies',
  wall: 'long walls',
  waterfall: 'waterfalls',
  aqueduct: 'aqueducts',
  ghat: 'bathing steps',
  pylon: 'pylons',
  pavilion: 'pavilions',
  screen: 'pierced screens',
  tower: 'towers',
  drape: 'drape canopies',
  sail: 'cloth sails',
};

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
  drape: 4,
  sail: 3,
};

/**
 * How much a world is allowed to build, per setting.
 *
 * The vocabulary outgrew the restraint. Every motif in it earns its place on
 * its own, and a campus wearing all of them at once is a curiosity shop rather
 * than a building — so the question "how much" stopped being a constant and
 * became a choice — and then a choice between two, because three degrees of
 * "how much architecture" is a slider pretending to be a decision.
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
  /*
   * The old `composed`, opened up a little — not the old `ornate`.
   *
   * `ornate` used to mean "build everything it is allowed to", and a campus
   * wearing every motif at once is a curiosity shop: the reason three settings
   * existed at all. With the middle gone, the richer of the two has to be the
   * one somebody would actually leave switched on, so it is the house style
   * with a slightly freer hand rather than the maximum.
   */
  ornate: { major: 0.8, deskMajor: 0.3, accent: 0.3, gateway: 0.26, cap: 1.15, roof: 0.55 },
};

export function planArchitecture(
  campus: Campus,
  seed: number,
  detail: OfficeDetail = 'ornate',
): ArchPlan {
  const budget = BUDGET[detail];
  const random = rng(seed);
  const voice = voiceFrom(random);
  const used = new Map<Motif, number>();
  const motifs = new Map<string, Motif>();
  const onPlatform = new Map<string, Piece[]>();

  // Which edges a walkway already meets: nothing may be built across a way in.
  const busy = doorwayEdges(campus);
  // And where those walkways actually are, so nothing is built *into* one
  // either. The edge rule only keeps a building off the mouth of a flight;
  // a cornice, a canopy beam or a colonnade is allowed to oversail the rim,
  // and what it oversails is the gap the flight crosses.
  const ways = campus.connectors.map(walkwaySpan);
  // Collected as the aqueducts are built and answered once they all exist.
  const spills: Spill[] = [];

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

  /*
   * The rock and the piers, for every platform, before anything else.
   *
   * These were computed inside the main loop, which meant the mandate pass
   * above could only check its gesture against *itself* — and then the main
   * loop would check it again with the substructure included and quietly throw
   * it out, leaving a world without the canopy it was promised. They also
   * consume the seed, so they cannot simply be computed twice: the whole plan
   * has to see the same draws in the same order.
   *
   * A stacked terrace has no rock. It is held up by the platform beneath it,
   * and giving it a substructure would drive a column of stone down through
   * its own host and out of the bottom of the world.
   */
  const groundOf = new Map<string, Piece[]>();
  for (const platform of campus.platforms) {
    groundOf.set(
      platform.id,
      platform.over
        ? []
        : [
            ...substructure(platform, random, bedrock),
            ...support(platform, upperOf.get(platform.id), campus, random, storey),
          ],
    );
  }

  /*
   * First refusal, before anything else is built.
   *
   * A mandated motif walks the shared platforms in a seeded order and takes the
   * first one that will have it. Walking rather than picking the "best" keeps
   * the choice varied between worlds; taking the *first* that accepts is what
   * makes the guarantee a guarantee — a dome will decline a terrace too narrow
   * to hold it, and so will a waterfall.
   */
  const claimed = new Map<string, { motif: Motif; pieces: Piece[] }>();
  const wanted = [...ALWAYS];
  const candidates = campus.platforms.filter(
    (platform) => !platform.over && platform.kind !== 'desk' && openEdges(platform, busy).length > 0,
  );
  for (const motif of wanted) {
    const start = Math.floor(random() * Math.max(1, candidates.length));
    for (let i = 0; i < candidates.length; i += 1) {
      const platform = candidates[(start + i) % candidates.length]!;
      if (claimed.has(platform.id)) continue;
      const open = openEdges(platform, busy);
      if (open.length === 0) continue;
      const edge = takeEdge([...open], outward(platform, campus), random, 0.8);
      const made = major(motif, platform, edge, random, storey, campus, spills);
      if (made.length === 0) continue;
      // And it has to leave the room walkable, which is the one rule a
      // mandate does not get to override. Checked here as well as below so a
      // motif that would be thrown out simply moves on to the next platform
      // rather than being dropped and leaving the world without one.
      if (!walkable(platform, [...(groundOf.get(platform.id) ?? []), ...made], standingSpots(platform, campus))) {
        continue;
      }
      // And it must not be standing in a walkway, for the same reason: better
      // for a mandated gesture to move to the next platform than to be built
      // here and thrown out below, which is how a world ended up with neither.
      if (!clearOfWalkways(platform, made, ways)) continue;
      claimed.set(platform.id, { motif, pieces: made });
      used.set(motif, (used.get(motif) ?? 0) + 1);
      break;
    }
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
    const ground: Piece[] = groundOf.get(platform.id) ?? [];

    const open = openEdges(platform, busy);
    const reserved = claimed.get(platform.id);

    // A deck that is somebody's desk is furnished already; one that is not is a
    // belvedere, and a belvedere is worth roofing.
    let built: Piece[] = platform.over
      ? parapet(platform, random, platform.kind === 'desk' ? 0 : budget.roof)
      : [];
    let accent: Piece[] = [];
    let motif: Motif | null = null;

    if (reserved) {
      // Already spoken for. It has had its edge taken and its motif counted.
      built = reserved.pieces;
    } else if (!platform.over && open.length > 0) {
      const available = ALL_MOTIFS.filter(
        (item) => (used.get(item) ?? 0) < Math.round((MOTIF_CAP[item] ?? Infinity) * budget.cap),
      );
      // Desks get the quiet half of the vocabulary: they are small, they are
      // already furnished, and a minaret over somebody's desk is a joke.
      const pool = platform.kind === 'desk' ? (['screen', 'pylon'] as Motif[]) : available;

      if (pool.length > 0 && random() < (platform.kind === 'desk' ? budget.deskMajor : budget.major)) {
        const edge = takeEdge(open, outward(platform, campus), random, 0.8);
        // A motif may decline — a dome will not perch on a terrace too narrow
        // to hold it — so work down the whole bank before giving up on the
        // platform. The order is drawn against this world's weights, so what
        // it is fond of comes first and everything else is still reachable.
        for (const choice of weightedOrder(pool, voice.weight, random)) {
          const made = major(choice, platform, edge, random, storey, campus, spills);
          if (made.length === 0) continue;
          if (!clearOfWalkways(platform, made, ways)) continue;
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
    const ok = (candidate: Piece[]): boolean =>
      walkable(platform, candidate, standing) && clearOfWalkways(platform, candidate, ways);
    let pieces = [...ground, ...built, ...accent];
    if (!ok(pieces)) {
      accent = [];
      pieces = [...ground, ...built];
      if (!ok(pieces)) {
        built = [];
        motif = null;
        pieces = ground;
      }
    }

    if (motif) {
      used.set(motif, (used.get(motif) ?? 0) + 1);
      motifs.set(platform.id, motif);
    }
    if (reserved && built.length > 0) motifs.set(platform.id, reserved.motif);
    // A mandated gesture that the walkability check threw out is no longer
    // standing, so it must not go on being counted as built.
    if (reserved && built.length === 0) used.set(reserved.motif, Math.max(0, (used.get(reserved.motif) ?? 1) - 1));
    if (pieces.length > 0) onPlatform.set(platform.id, pieces);
  }

  /*
   * Last, because this is the one gesture that is about two platforms.
   *
   * Everything else here is planned per platform and checked per platform, and
   * an aqueduct's water is the exception: where it goes depends on what the
   * rest of the campus turned out to be. Run after the walkability pass as
   * well, deliberately — a stream and the pool it makes are both below
   * `FLOOR_CLEARANCE`, so the nav grid never sees them and nobody is ever
   * walled in by water.
   */
  resolveSpills(spills, campus, onPlatform, random);

  return { favoured: voice.favoured, motifs, onPlatform, detached: voidWorks(campus, random, budget.gateway) };
}

/**
 * What a world is fond of, without building it.
 *
 * Read off the first few draws of the seed, so it costs nothing — which is what
 * lets Settings say what you are looking at. It goes through exactly the draws
 * the planner does, in the same order, because the one thing worse than not
 * naming the world is naming it wrong.
 */
export function worldVoice(seed: number): WorldVoice {
  return voiceFrom(rng(seed));
}

function voiceFrom(random: () => number): WorldVoice {
  // A shuffle of the whole bank, so the ordering itself is the world's taste.
  const order = [...ALL_MOTIFS];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }

  const weight = new Map<Motif, number>();
  order.forEach((motif, i) => {
    // A little jitter on the tail, so two worlds that favour the same three
    // still differ in what turns up behind them.
    weight.set(motif, (FAVOUR[i] ?? BASELINE) * (i < FAVOUR.length ? 1 : 0.6 + random() * 0.8));
  });
  return { favoured: order.slice(0, FAVOUR.length), weight };
}

/**
 * The pool, in an order drawn against the weights, without replacement.
 *
 * An order rather than a single pick, because a motif is allowed to decline —
 * a dome will not stand on a terrace too narrow for it — and the fallback then
 * has to obey the same preferences the first choice did. Picking again at
 * random on a refusal is how a world ends up looking like every other one
 * precisely on the platforms where something interesting was going to happen.
 */
/** Which edges of a platform nothing is standing in the way of. */
function openEdges(platform: Platform, busy: Map<string, Set<Edge>>): Edge[] {
  const taken = busy.get(platform.id) ?? new Set<Edge>();
  return EDGES.filter((edge) => !taken.has(edge));
}

function weightedOrder(pool: Motif[], weight: Map<Motif, number>, random: () => number): Motif[] {
  const left = [...pool];
  const out: Motif[] = [];
  while (left.length > 0) {
    let total = 0;
    for (const motif of left) total += weight.get(motif) ?? BASELINE;
    let roll = random() * total;
    let index = left.length - 1;
    for (let i = 0; i < left.length; i += 1) {
      roll -= weight.get(left[i]!) ?? BASELINE;
      if (roll <= 0) {
        index = i;
        break;
      }
    }
    out.push(left[index]!);
    left.splice(index, 1);
  }
  return out;
}

const ALL_MOTIFS = Object.keys(MOTIF_NAMES) as Motif[];

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
  const prop = planProp(platform);
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
/**
 * Nothing may stand where a walkway is.
 *
 * Buildings are planned per platform and walkways between them, and for as long
 * as the two never spoke a canopy beam could oversail a rim and hang directly
 * over the gap a flight of stairs climbs. On screen that is a staircase passing
 * through a wall, which is the loudest thing this office can do wrong.
 *
 * `HEAD_CLEARANCE` above the flight counts as in the way as well: a beam at
 * head height over a stair is not a collision, but it is still something a
 * figure walks through.
 */
function clearOfWalkways(platform: Platform, pieces: readonly Piece[], ways: readonly Span[]): boolean {
  if (ways.length === 0) return true;
  const base = levelY(platform.level);
  for (const blocker of archBlockers(pieces)) {
    const minX = blocker.x + platform.position[0] - blocker.halfWidth;
    const maxX = blocker.x + platform.position[0] + blocker.halfWidth;
    const minZ = blocker.z + platform.position[1] - blocker.halfDepth;
    const maxZ = blocker.z + platform.position[1] + blocker.halfDepth;
    const bottom = blocker.base + base;
    const top = blocker.top + base;
    for (const way of ways) {
      // A hair of contact at a rim is how a landing meets a floor, not a clash.
      if (Math.min(maxX, way.maxX) - Math.max(minX, way.minX) <= 0.2) continue;
      if (Math.min(maxZ, way.maxZ) - Math.max(minZ, way.minZ) <= 0.2) continue;
      if (top <= way.minY + 0.1) continue;
      if (bottom >= way.maxY + HEAD_CLEARANCE) continue;
      return false;
    }
  }
  return true;
}

type Span = ReturnType<typeof walkwaySpan>;

function walkable(platform: Platform, pieces: readonly Piece[], standing: Standing): boolean {
  if (standing.spots.length < 2) return true;
  const prop = planProp(platform);
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

/**
 * The furniture, built once per platform per plan.
 *
 * `buildPropFor` merges a fresh BufferGeometry every call, and the planner asks
 * about the same platform's furniture several times over — once per walkability
 * probe, once per edge frame. A WeakMap keyed on the platform keeps the plan a
 * pure function of the seed while paying for the geometry once.
 */
const PLAN_PROPS = new WeakMap<Platform, ReturnType<typeof buildPropFor>>();

function planProp(platform: Platform): ReturnType<typeof buildPropFor> {
  const held = PLAN_PROPS.get(platform);
  if (held !== undefined) return held;
  const built = buildPropFor(platform, PLAN_PALETTE);
  PLAN_PROPS.set(platform, built);
  return built;
}

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
  /**
   * How far in from this rim you can build before you are inside the furniture.
   *
   * `room` is a *budget*: the rim band with a walking lane already deducted
   * from it, which on most platforms leaves nothing at all — which is right
   * for a balustrade that overhangs and costs no floor, and wrong as a licence
   * for anything with mass. `clear` is a *measurement*: the prop declares the
   * width and depth it needs kept free, and everything from there to the rim is
   * genuinely empty deck. A gesture heavy enough that it must not overhang asks
   * this, builds inside it, and lets the occupancy grid arbitrate the walking.
   */
  clear: number;
  /** True when the edge runs along x. */
  horizontal: boolean;
  /** A point on the edge, `offset` along it and `out` beyond the rim. */
  at(offset: number, y: number, out: number): [number, number, number];
  /** How far in from the rim a piece this thick may stand; negative overhangs. */
  fit(thickness: number, preferred?: number): number;
  /**
   * Where a piece this thick stands to keep its whole footprint on clear deck.
   *
   * The outward offset to hand `at`, so negative — mass goes *in* from the rim,
   * never out over the drop. `deeper` (0…1) pushes it further in through
   * whatever slack the deck has left. `null` means the deck cannot hold it,
   * which is the only honest way for a heavy gesture to decline.
   */
  stand(thickness: number, deeper?: number): number | null;
  /** A box lying along the edge: `len` along, `thick` across. */
  band(
    len: number,
    tall: number,
    thick: number,
    offset: number,
    y: number,
    out: number,
    tone: Tone,
    grad: [number, number],
    /** Only water uses this; see `Piece`. */
    fade?: number,
  ): Piece;
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
  const keep = planProp(platform)?.footprint ?? [0, 0];
  const clear = Math.max(0, ((horizontal ? depth - keep[1] : width - keep[0]) / 2));
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
    clear,
    horizontal,
    at,
    stand(thickness, deeper = 0) {
      const slack = clear - thickness;
      if (slack < 0) return null;
      return -(thickness / 2 + slack * deeper);
    },
    fit(thickness, preferred = 0.4) {
      /**
       * Positive is inward from the rim; negative overhangs the drop.
       *
       * This is the budget for light work that overhangs — a balustrade, a
       * screen, a row of piers. Anything with mass asks `stand` instead: this
       * one deducts a whole walking lane from the rim band, which on most
       * platforms leaves nothing, and a dome that waits for permission from it
       * waits for ever.
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
    band(len, tall, thick, offset, y, out, tone, grad, fade) {
      return {
        shape: 'box',
        tone,
        size: horizontal ? [len, tall, thick] : [thick, tall, len],
        at: at(offset, y, out),
        grad,
        ...(fade === undefined ? {} : { fade }),
      };
    },
  };
}

// ---------- the large gestures ----------

/**
 * Where an aqueduct tips its water out, and what it has to clear.
 *
 * Recorded rather than built, because what happens to the water depends on what
 * is underneath it, and when an aqueduct is planned the planner has only got as
 * far as that one platform. The whole campus — every deck, and every other
 * aqueduct's channel — is known once the loop has finished, and that is where
 * the falls get built. See `resolveSpills`.
 */
interface Spill {
  /** The platform the aqueduct stands on, whose local frame `at` is in. */
  platformId: string;
  /** The lip, in that platform's local frame. */
  at: [number, number, number];
  width: number;
  /** Which way the channel runs, so the pool it makes lies the same way. */
  horizontal: boolean;
}

function major(
  motif: Motif,
  platform: Platform,
  edge: Edge,
  random: () => number,
  storey: number,
  campus: Campus,
  spills: Spill[],
): Piece[] {
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
      return aqueduct(f, random, storey, platform, campus, spills);
    case 'pavilion':
      return pavilion(f, random, storey);
    case 'pylon':
      return pylon(f, random, storey);
    case 'drape':
      return drape(f, random, storey);
    case 'sail':
      return sail(f, random, storey);
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
  /*
   * Sized against the deck it has to stand on.
   *
   * A dome is mass, and the one thing a heavy object must not do in this office
   * is float — so it stands entirely on the terrace or it is not built here.
   * That rule used to be enforced by asking `f.fit`, which it can never pass:
   * the radius grew with the rim band faster than the band grew, so "a dome
   * needs 1.4 plus its radius of rim" came out wanting seven units of band on a
   * campus whose widest is two. Every world fond of domes built none, quietly.
   *
   * `f.clear` is the deck the furniture is not using. Half of it is a dome that
   * stands on the deck by construction, and the occupancy grid — which measures
   * circulation properly, and is already the arbiter — decides the walking.
   */
  const radius = Math.min(1.5, f.along * 0.17, f.clear / 2);
  // Below this it is a bollard with a spike on it.
  if (radius < 0.38) return [];
  const out = f.stand(radius * 2, random() * 0.4) ?? 0;
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
  const side = 0.78 + random() * 0.26;
  // Same rule as the dome: a tower four units tall standing off the edge of
  // the terrace has nothing holding it up, and it shows. So it stands on the
  // clear deck, or it declines.
  const base = side * 1.34;
  const out = f.stand(base, 0.18 + random() * 0.4);
  if (out === null) return [];
  const offset = (random() < 0.5 ? -1 : 1) * f.along * (0.3 + random() * 0.1);
  const pieces: Piece[] = [];
  let y = 0;

  /*
   * A plinth, because a tower has to meet the floor somewhere.
   *
   * Without it the shaft simply intersects the deck, and at this scale a
   * vertical stick arriving at a floor plane with no transition reads as
   * stuck through it rather than standing on it.
   */
  pieces.push({ shape: 'box', tone: 'stone', size: [base, 0.34, base], at: f.at(offset, y, out), grad: [0.4, 1] });
  y += 0.34;
  pieces.push({ shape: 'box', tone: 'pale', size: [side * 1.14, 0.16, side * 1.14], at: f.at(offset, y, out), grad: [0.7, 1] });
  y += 0.16;

  const lifts = 2 + Math.floor(random() * 2);
  let w = side;
  for (let i = 0; i < lifts; i++) {
    const tall = storey * (0.72 + random() * 0.34);
    /*
     * One stone all the way up, and the storeys told by the galleries.
     *
     * The lifts used to alternate pale and dark, which at a distance is not a
     * tower with floors in it — it is a pole painted in two colours, and the
     * dark band in the middle of a pale shaft reads as a gap with sky behind
     * it. A minaret is one piece of masonry; what divides it is where the
     * balconies are.
     */
    pieces.push({
      shape: 'box',
      tone: 'pale',
      size: [w, tall, w],
      at: f.at(offset, y, out),
      // Each lift a shade lighter than the one below, so the shaft has a sky
      // to climb toward instead of being flat for nine units.
      grad: [0.44 + i * 0.1, 1],
    });
    y += tall;
    /*
     * The gallery: a corbel, the walkway that oversails it, and a rail.
     *
     * A single thin disc was the old version and it is a shelf, not a
     * balcony — nothing under it and nothing on it. Three courses is the one
     * detail that makes a tall thin thing read as a tower somebody climbs
     * rather than as a post somebody planted.
     */
    pieces.push(
      { shape: 'column', tone: 'stone', radius: w * 0.78, height: 0.16, at: f.at(offset, y, out), grad: [0.5, 1] },
      { shape: 'column', tone: 'stone', radius: w * 1.06, height: 0.15, at: f.at(offset, y + 0.16, out), grad: [0.86, 1] },
      {
        shape: 'column',
        tone: 'pale',
        radius: w * 1.0,
        height: 0.26,
        taper: 0.94,
        at: f.at(offset, y + 0.31, out),
        grad: [0.62, 1],
      },
    );
    y += 0.57;
    w *= 0.86;
  }
  // A neck, then the finial: the cap sat straight on the last gallery and the
  // tower had no head, only a hat.
  pieces.push(
    { shape: 'column', tone: 'pale', radius: w * 0.5, height: w * 0.7, at: f.at(offset, y, out), grad: [0.66, 1] },
    {
      shape: 'column',
      tone: 'pale',
      radius: w * 0.66,
      height: w * 1.8,
      taper: 0.06,
      at: f.at(offset, y + w * 0.7, out),
      grad: [0.72, 1],
    },
  );
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
 * A canopy court: cloth slung in bays between a row of posts.
 *
 * The office is cut stone all the way through, which is most of why it reads as
 * one place — and also why it has no give in it anywhere. Cloth is the one
 * thing in the vocabulary that is not load-bearing: it hangs, it sags, and the
 * eye reads the curve as weight because nothing else in the frame bends at all.
 *
 * The first version of this was too polite to be any of that. One bay, posts
 * about two thirds of a storey, and a sag of four-tenths of a unit — which at
 * the size the office is looked less like a canopy than like a towel on a line,
 * and you had to be told it was there. A gesture this large has to be *large*:
 * two or three bays across most of the rim, posts over a storey high, and a sag
 * deep enough that the bottom of the cloth is a curve rather than a line.
 *
 * Built as a row of panels rather than a curved surface, because the whole
 * office is flat-shaded facets and a smoothly-swept cloth would be the one
 * object in it pretending to be round. The panels step, and at this scale the
 * steps *are* the fold: it is the same reasoning the corbelled arches use.
 *
 * It shelters without enclosing and there is nothing solid above waist height,
 * so it is also one of the few large gestures that can stand on a furnished
 * platform without hiding what is on it.
 */
const DRAPE_PANELS = 30;
/**
 * How many times the cloth swings toward you and back across one bay.
 *
 * The whole difference between cloth and a paper cut-out. Every panel used to
 * hang in the *same plane* — the only depth in the thing was a tenth of a unit
 * of belly at the lowest point — so a drape was a flat sheet with a curved
 * hem printed on it, and from any angle but dead square-on it read as a decal
 * standing on the rim. Two and a half folds is enough to be obviously three
 * dimensional and few enough that each one is a fold rather than a corrugation.
 *
 * It has to stay gentle as well as deep. Two and a half folds across fifteen
 * panels moved each panel a fifth of a unit in front of its neighbour, which is
 * wider than a panel — so the curtain came apart into a row of loose slats with
 * sky between them. Fewer folds over more panels, and a panel thick enough to
 * overlap the one beside it, is a curtain.
 *
 * Saying that and *arithmetic* are two different things, and the first pass
 * only said it. A panel's thickness was driven by how far the fold had swung,
 * which puts the thickest panel at the crest — and the crest is exactly where
 * the cloth is flattest. The thinnest panels landed on the steepest part of
 * the wave, where the gap to open is widest, so the slats came back. The
 * thickness is measured now: a panel is as thick as the depth its own width
 * covers, taken off its neighbours, which is what a slice of a curved surface
 * is. There is no gap it can open that the measurement does not close.
 */
const DRAPE_FOLDS = 1.5;

function drape(f: EdgeFrame, random: () => number, storey: number): Piece[] {
  const post = 0.26;
  /*
   * The posts stand; the cloth is allowed to hang.
   *
   * Those are different questions and they were being answered together. A
   * curtain over the rim is the whole idea, but the thing holding it up is a
   * quarter-unit square in plan, and placed by the overhang rule it ended up
   * with two centimetres of itself on the deck — a pin with a curtain on it.
   * `stand` puts the posts on measured floor; the panels hang from them and
   * go wherever the sag takes them, which is out over the drop.
   */
  const out = f.stand(post, 0.38) ?? -f.fit(post, 0.42);
  const span = Math.min(f.along * (0.74 + random() * 0.16), 11.5);
  /*
   * How many bays the rim will take.
   *
   * A short edge with three bays is four posts across it, and at the router's
   * grid that is a picket fence: the rim comes out impassable and the whole
   * canopy is thrown away. One wide bay is both more passable and a better
   * shape for a small room.
   */
  const bays = span > 7.4 ? 3 : span > 4.2 ? 2 : 1;
  const bay = span / bays;
  const height = storey * (1.06 + random() * 0.3);
  /*
   * How far the middle of a bay falls below the line it is slung from.
   *
   * A third of the span it crosses, which is what cloth actually does — and
   * then clamped so the lowest point of the cloth still clears a head. Without
   * the clamp a wide bay hung to knee height, the router correctly called the
   * rim impassable, and the whole gesture was thrown away: worlds that were
   * supposed to have a canopy quietly had nothing. A shallower sag is a far
   * better answer than no canopy.
   */
  const sag = Math.min(bay * (0.3 + random() * 0.12), Math.max(0.35, height - HEAD_CLEARANCE - 0.9));
  /** How far a fold swings in and out of the plane of the rail. */
  const swing = Math.min(0.3, Math.max(0.16, bay * 0.06));
  const pieces: Piece[] = [];

  for (let i = 0; i <= bays; i += 1) {
    const offset = -span / 2 + i * bay;
    pieces.push(
      f.band(post, height, post, offset, 0, out, 'pale', [0.34, 1]),
      // A capital, and a finial above it, so the post has a top rather than
      // just stopping.
      f.band(post * 1.9, 0.18, post * 1.9, offset, height, out, 'stone', [0.72, 1]),
      // A finial that comes to a point. A cube of accent up there read as an
      // orange box someone had left on top of the post.
      {
        shape: 'column',
        tone: 'accent',
        radius: post * 0.44,
        height: 0.34,
        taper: 0.2,
        at: f.at(offset, height + 0.18, out),
        grad: [0.55, 1],
      },
    );
  }

  const head = height - 0.04;
  const width = bay / DRAPE_PANELS;
  const step = 1 / DRAPE_PANELS;
  /*
   * The cloth, as two functions of one parameter.
   *
   * `t` runs −0.5 at one post to +0.5 at the other. `dipAt` is how far the
   * cloth has fallen there, `foldAt` how far it has swung toward you — both
   * pinned to nothing at the posts by the same parabola, because a curtain
   * cannot billow or sag where it is nailed down. Writing them as functions
   * rather than inline is what lets the hem be sampled finer than the panels
   * and still land on the same curve.
   */
  const dipAt = (u: number): number => sag * Math.max(0, 1 - 4 * u * u);
  const foldAt = (u: number): number =>
    Math.sin((u + 0.5) * Math.PI * 2 * DRAPE_FOLDS) * swing * Math.max(0, 1 - 4 * u * u);

  for (let b = 0; b < bays; b += 1) {
    const centre = -span / 2 + (b + 0.5) * bay;
    // A head rail across the bay, which is the thing the cloth hangs from.
    pieces.push(f.band(bay, 0.12, post * 0.8, centre, head, out, 'stone', [0.8, 1]));

    for (let i = 0; i < DRAPE_PANELS; i += 1) {
      const t = (i + 0.5) / DRAPE_PANELS - 0.5;
      const dip = dipAt(t);
      const drop = 0.5 + dip;
      const fold = foldAt(t);
      const belly = out - dip * 0.1 + fold;
      /*
       * As thick as the depth this panel's own width covers.
       *
       * Measured off its neighbours rather than guessed from the wave: a slice
       * of a curved surface is exactly as deep as the surface moves across it,
       * and a slice built that way cannot leave a gap for the one beside it to
       * show through. The addition is the cloth's own body. It also means the
       * resolution is free — double the panels and every one of them halves,
       * still overlapping — which is what lets the count be chosen for the
       * smoothness of the hem rather than for the tightness of the weave.
       */
      const reach = Math.max(Math.abs(foldAt(t + step) - fold), Math.abs(fold - foldAt(t - step)));
      const thick = 0.15 + reach * 1.3;
      // Overlapped along the rail as well, so the joints between panels are
      // inside the cloth rather than on its face.
      pieces.push(
        f.band(width * 1.4, drop, thick, centre + t * bay, head - drop, belly, 'pale', [0.12, 1]),
        /*
         * The hem: one band per panel, taller than the step between panels.
         *
         * The sag is a parabola, so near the posts the bottom of the cloth
         * falls fastest, and a hem shorter than that fall comes apart into a
         * row of separate blocks — the jagged orange staircase this had. At
         * thirty panels the steepest step is a fifth of a unit and the band is
         * a quarter, so consecutive blocks always overlap and the silhouette
         * is a continuous scallop. It reaches up into the cloth as well, so
         * there is never a slot of sky between a curtain and its own hem.
         */
        f.band(
          width * 1.4,
          0.26,
          thick + 0.06,
          centre + t * bay,
          head - drop - 0.2,
          belly,
          'accent',
          [0.5, 1],
        ),
      );
      /*
       * A pelmet over the head of the cloth, shallower and folded the other
       * way, so the top of the curtain has a thickness too.
       */
      const shade = dip * 0.3 + 0.16;
      pieces.push(
        f.band(width * 1.4, shade, thick + 0.1, centre + t * bay, head - shade, belly - fold * 0.55, 'pale', [0.42, 0.9]),
      );
    }
  }

  /*
   * And a return round each end post.
   *
   * The one detail that cannot be faked with a sagging hem: a curtain that
   * stops dead at its last panel is a sheet of card seen edge on, and a
   * curtain that turns the corner is unmistakably a thing in a room. Three
   * short panels each, running *across* the rim instead of along it.
   */
  const returns = 3;
  for (const side of [-1, 1]) {
    const at = (side * span) / 2;
    for (let i = 0; i < returns; i += 1) {
      const t = (i + 0.5) / returns;
      const deep = 0.34 + t * 0.5;
      const drop = 0.5 + sag * 0.5 * (1 - t) + 0.12;
      pieces.push(
        f.band(0.1 + (1 - t) * 0.06, drop, 0.42, at, head - drop, out - deep, 'pale', [0.2, 1]),
        f.band(0.15, 0.14, 0.46, at, head - drop - 0.11, out - deep, 'accent', [0.5, 1]),
      );
    }
  }

  return pieces;
}

/**
 * A sail: cloth stretched flat between four posts and sagging under its own
 * weight.
 *
 * The other thing cloth does. A drape is a *wall* of it and reads as a screen
 * you can see past; this is a *roof* of it, and reads as shade. A sagging
 * horizontal sheet is a silhouette the office has nowhere else and cannot make
 * out of stone, and having two cloth gestures rather than one is what stops
 * "the soft thing" being a single object you recognise on sight.
 *
 * It began as an awning sloping out over the drop, which is the obvious shape
 * and is not buildable here: a plane that starts on the deck and ends below it
 * crosses deck height *somewhere past the rim*, and a piece out there with
 * clear sky above and below it is the "balloon moored beside the office" the
 * layout invariant exists to catch. Bracketing every rib would be a lot of
 * carpentry in aid of hiding a shape that was wrong anyway. Four posts on the
 * deck and the cloth between them is the honest version, and it is the better
 * silhouette: you see the campus *through* the sag.
 */
const SAIL_ACROSS = 9;
const SAIL_DEEP = 5;

function sail(f: EdgeFrame, random: () => number, storey: number): Piece[] {
  const post = 0.22;
  const near = f.stand(post, 0);
  if (near === null) return [];
  const span = Math.min(f.along * (0.52 + random() * 0.2), 8.5);
  /*
   * How far in the back posts go.
   *
   * Bounded by the *actual* clear deck, because a sail whose back posts land in
   * the middle of the library shelves is a sail that gets thrown away. That
   * used to be spelled `f.room < 1.5`, which is a guess about the furniture
   * rather than a measurement of it, and it happened to be a guess no platform
   * the generator makes could satisfy. `f.clear` asks the prop what it needs
   * kept free and takes the rest.
   */
  const deep = Math.min(f.clear - post, 4.6);
  // A sheet shallower than this is a pelmet, and the sag has nowhere to go.
  if (deep < 0.95) return [];
  const height = storey * (1.08 + random() * 0.2);
  // How far the middle of the sheet falls. Cloth, so: a lot — but never so
  // far that you could not walk under it; see `drape`.
  const sag = Math.min(
    Math.min(span, deep) * (0.17 + random() * 0.07),
    Math.max(0.3, height - HEAD_CLEARANCE - 0.55),
  );
  const pieces: Piece[] = [];

  const far = near - deep;

  for (const offset of [-span / 2, span / 2]) {
    for (const out of [near, far]) {
      pieces.push(
        f.band(post, height, post, offset, 0, out, 'pale', [0.34, 1]),
        f.band(post * 1.8, 0.16, post * 1.8, offset, height, out, 'stone', [0.72, 1]),
      );
    }
  }

  /*
   * The sheet, as a grid of flat panels.
   *
   * Stepped rather than swept, like every other soft thing here: the office is
   * flat-shaded facets and a smoothly-curved sail would be the one object in
   * it pretending to be round. At this size the steps read as the quilting.
   */
  const cell = span / SAIL_ACROSS;
  const rank = deep / SAIL_DEEP;
  for (let i = 0; i < SAIL_ACROSS; i += 1) {
    const u = (i + 0.5) / SAIL_ACROSS - 0.5;
    for (let j = 0; j < SAIL_DEEP; j += 1) {
      const v = (j + 0.5) / SAIL_DEEP - 0.5;
      // A parabola in both directions: taut at the posts, deepest in the middle.
      const dip = sag * (1 - 4 * u * u) * (1 - 4 * v * v);
      const out = near - (j + 0.5) * rank;
      pieces.push(f.band(cell * 1.04, 0.1, rank * 1.04, u * span, height - 0.08 - dip, out, 'pale', [0.7, 1]));
    }
  }

  // A weighted edge along the two free sides, which is what makes the sag read
  // as cloth under load rather than as a dented lid.
  for (let i = 0; i < SAIL_ACROSS; i += 1) {
    const u = (i + 0.5) / SAIL_ACROSS - 0.5;
    const dip = sag * (1 - 4 * u * u) * 0.75;
    for (const out of [near - rank * 0.2, far + rank * 0.2]) {
      pieces.push(f.band(cell * 1.08, 0.17, 0.14, u * span, height - 0.2 - dip, out, 'accent', [0.5, 1]));
    }
  }

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
  // Mass stands on the terrace or it is not built, the same rule the dome and
  // the minaret answer to.
  const out = f.stand(base, random() * 0.45);
  if (out === null) return [];
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
  /*
   * It runs down the *face* of the terrace, not out away from it.
   *
   * Each course used to step a full tread further from the rim as well as a
   * riser down, so after six of them the flight was a staircase hanging two and
   * a half units out in clear air with nothing under it — and because each
   * course was also cut shorter than the last, from across the campus the whole
   * thing read as a dotted line trailing off a corner. A ghat descends against
   * the thing it is cut into. Here that is the rock under the terrace, so the
   * courses hug the rim and corbel out a little as they go, the way a stepped
   * buttress does.
   */
  const span = f.along * (0.46 + random() * 0.22);
  const pieces: Piece[] = [];
  const steps = 5 + Math.floor(random() * 4);
  const thick = 0.55;
  /*
   * Straddling the rim, and starting a finger *below* the floor.
   *
   * Pulling the flight inboard put the top course's upward face on exactly the
   * platform's own floor plane, in a different stone — which `coplanar.test.ts`
   * caught immediately, and which would have been a patch of flicker on the
   * deck of every ghat in the office. The first course belongs under the slab;
   * what you see of the flight starts at the rim and goes down.
   */
  let out = thick * 0.42;
  let y = -0.05;

  for (let i = 0; i < steps; i++) {
    const rise = 0.3 + random() * 0.1;
    y -= rise;
    pieces.push(f.band(span - i * 0.14, rise, thick, 0, y, out, i % 2 === 0 ? 'stone' : 'pale', [0.4, 1]));
    // A finger further out each course, so the flight widens downward and the
    // face of every step is visible from above.
    out += 0.1 + random() * 0.05;
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
function aqueduct(
  f: EdgeFrame,
  random: () => number,
  storey: number,
  platform: Platform,
  campus: Campus,
  spills: Spill[],
): Piece[] {
  /*
   * Long enough to reach the terrace it is pointing at, if there is one.
   *
   * An aqueduct that tips its water into the void is a fine object and a
   * slightly pointless one — it was built to get water from somewhere to
   * somewhere, and half of that sentence was missing. When there is a lower
   * deck out past this rim, the run is cut to land on it, and the water
   * arrives: a fall, and a pool spreading where it hits. That is the whole
   * reason this motif is in the vocabulary rather than another colonnade.
   *
   * It is still only *if*. Most rims face open sky, and an aqueduct emptying
   * into the fog is what the rest of them do.
   */
  let bays = 3 + Math.floor(random() * 2);
  let bay = 1.5 + random() * 0.5;
  const target = reachableDeck(f, platform, campus);
  if (target !== null) {
    for (const count of [4, 3, 5, 6]) {
      const want = (target - f.fit(1.1, 0.5) * -1 - 0.4) / count;
      if (want >= 1.3 && want <= 2.3) {
        bays = count;
        bay = want;
        break;
      }
    }
  }
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

  /*
   * And the spill off the far end — recorded, not built.
   *
   * It used to be one box fifteen to twenty units tall, which did two things
   * wrong at once. It never thinned out, so it ended in a horizontal line the
   * way no falling water ever does — the waterfall learned that lesson several
   * rounds ago and this never got the fix. And it went straight through
   * whatever happened to be under it, because nothing here knows what is. Both
   * are answered in `resolveSpills`, once the whole campus exists.
   */
  spills.push({
    platformId: platform.id,
    at: f.at(0, deck + 0.4, to),
    width: wide * 0.56,
    horizontal: f.horizontal,
  });

  return pieces;
}

/**
 * Everything a falling stream could land on, in world coordinates.
 *
 * Platform decks and the tops of other aqueducts' channels: the two flat things
 * in this office that water could plausibly arrive on. Gathered once, because
 * the answer is the same for every spill and the campus does not move.
 */
interface Shelf {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y: number;
}

/**
 * Where each aqueduct's water actually goes.
 *
 * Two outcomes, and the office is better for having both. If there is a deck or
 * another channel under the lip, the water *lands*: the fall stops there and
 * spreads into a pool, which is the one thing in the whole campus that says two
 * of these terraces are part of the same waterworks. If there is nothing under
 * it, it falls into the void and dissolves, the way the waterfalls do.
 *
 * Built into the *source* platform's piece list even when it lands on another
 * one. A piece is drawn at its platform's position plus its own offset, so an
 * offset can reach anywhere; and keeping the whole gesture in one place means
 * an aqueduct is still one object that can be read, moved or dropped whole.
 */
function resolveSpills(
  spills: readonly Spill[],
  campus: Campus,
  onPlatform: Map<string, Piece[]>,
  random: () => number,
): void {
  if (spills.length === 0) return;
  const byId = new Map(campus.platforms.map((platform) => [platform.id, platform]));

  const shelves: Shelf[] = campus.platforms.map((platform) => ({
    minX: platform.position[0] - platform.size[0] / 2,
    maxX: platform.position[0] + platform.size[0] / 2,
    minZ: platform.position[1] - platform.size[1] / 2,
    maxZ: platform.position[1] + platform.size[1] / 2,
    y: levelY(platform.level),
  }));
  // Other channels count too: an aqueduct emptying into an aqueduct is the
  // edge case this started from, and it is a better picture than either of the
  // two things it used to do.
  for (const spill of spills) {
    const host = byId.get(spill.platformId);
    if (!host) continue;
    const x = host.position[0] + spill.at[0];
    const z = host.position[1] + spill.at[2];
    const half = spill.width * 1.4;
    shelves.push({ minX: x - half, maxX: x + half, minZ: z - half, maxZ: z + half, y: levelY(host.level) + spill.at[1] });
  }

  for (const spill of spills) {
    const host = byId.get(spill.platformId);
    if (!host) continue;
    const base = levelY(host.level);
    const x = host.position[0] + spill.at[0];
    const z = host.position[1] + spill.at[2];
    const lip = base + spill.at[1];

    let landing: number | null = null;
    for (const shelf of shelves) {
      // Far enough below to be a fall rather than a seam. Under that and the
      // water arrives before it has had room to look like it is falling.
      if (shelf.y > lip - 2.6) continue;
      if (x < shelf.minX || x > shelf.maxX || z < shelf.minZ || z > shelf.maxZ) continue;
      if (landing === null || shelf.y > landing) landing = shelf.y;
    }

    const pieces = onPlatform.get(spill.platformId) ?? [];
    const local = (worldY: number): number => worldY - base;
    pieces.push(...fallFrom(spill, local(lip), landing === null ? null : local(landing), random));
    onPlatform.set(spill.platformId, pieces);
  }
}

/**
 * The stream itself, in the source platform's local frame.
 *
 * Staged and narrowing, like a waterfall's sheets, for the same reason: a
 * single long box is a pane of glass with two hard vertical edges, and water
 * necks in as it falls. What differs is the end. A fall into the void keeps
 * dissolving until there is nothing of it; a fall that lands holds its colour
 * all the way down and then stops, because you can see where it stops.
 */
function fallFrom(spill: Spill, lipY: number, landY: number | null, random: () => number): Piece[] {
  const pieces: Piece[] = [];
  const [x, , z] = spill.at;
  const long = spill.horizontal ? spill.width : 0.36;
  const deep = spill.horizontal ? 0.36 : spill.width;

  const drop = landY === null ? 17 + random() * 5 : lipY - landY;
  const stages = Math.max(4, Math.min(9, Math.round(drop / 2.4)));
  let y = lipY;
  let span = 1;
  let wander = 0;
  for (let i = 0; i < stages; i += 1) {
    const t = stages === 1 ? 1 : i / (stages - 1);
    const tall = drop / stages;
    y -= tall;
    /*
     * A fall into the void thins into the sky; one that lands does not.
     *
     * The fade is the whole difference between the two readings. Dissolving on
     * the way down says "this goes on past the bottom of the world", which is
     * true of the first and a lie about the second — and a stream that arrives
     * at a pool already half sky reads as a stain on the platform rather than
     * as water hitting it.
     */
    const fade = landY === null ? Math.min(0.97, Math.pow(t, 1.7) * 1.05) : 0;
    pieces.push({
      shape: 'box',
      tone: 'water',
      size: [long * span, tall + 0.06, deep * span],
      at: [x + wander, y, z],
      grad: [0.94, 1],
      ...(fade > 0 ? { fade } : {}),
    });
    span *= 0.93 + random() * 0.05;
    wander += (random() - 0.5) * 0.12;
  }

  if (landY === null) return pieces;

  /*
   * And the pool it makes.
   *
   * Three rings, each wider and thinner than the last, which is the same
   * stepped trick the ripple under the pedestal uses — at this size a smooth
   * disc is not available and a stepped one reads as spreading water anyway.
   * Low enough that the occupancy grid ignores it (`FLOOR_CLEARANCE`), because
   * a puddle is not a wall and nobody should have to walk round it.
   */
  const spread = spill.width * (2.1 + random() * 0.9);
  for (let i = 0; i < 3; i += 1) {
    const t = i / 2;
    const side = spill.width * 0.8 + (spread - spill.width * 0.8) * t;
    pieces.push({
      shape: 'box',
      tone: 'water',
      size: [side, 0.07 - t * 0.016, side],
      at: [x + wander, landY + 0.01, z],
      grad: [0.97, 1],
    });
  }
  return pieces;
}

/**
 * How far out past this rim a lower deck begins, or null.
 *
 * Measured along the edge's own normal from the platform's middle, so the
 * answer is in the same units `fit` and `band` take. "Lower" means at least a
 * flight down: level with this one is a bridge, not a fall, and the water would
 * arrive without ever having looked like it was falling.
 */
function reachableDeck(f: EdgeFrame, platform: Platform, campus: Campus): number | null {
  const here = levelY(platform.level);
  const half = f.horizontal ? platform.size[1] / 2 : platform.size[0] / 2;
  let best: number | null = null;
  for (const other of campus.platforms) {
    if (other.id === platform.id || other.over) continue;
    if (levelY(other.level) > here - 2.6) continue;
    // Square on: the channel runs straight out, so the target has to be in
    // front of this rim rather than off to one side of it.
    const alongHere = f.horizontal ? platform.position[0] : platform.position[1];
    const alongThere = f.horizontal ? other.position[0] : other.position[1];
    const alongHalf = f.horizontal ? other.size[0] / 2 : other.size[1] / 2;
    if (Math.abs(alongThere - alongHere) > alongHalf + 0.5) continue;

    const outHere = f.horizontal ? platform.position[1] : platform.position[0];
    const outThere = f.horizontal ? other.position[1] : other.position[0];
    const sign = f.horizontal ? f.normal[1] : f.normal[0];
    const outHalf = f.horizontal ? other.size[1] / 2 : other.size[0] / 2;
    // Distance from this rim to a point comfortably inside the far deck.
    const reach = (outThere - outHere) * sign - half + outHalf * 0.45;
    if (reach < 2.5 || reach > 14) continue;
    if (best === null || reach < best) best = reach;
  }
  return best;
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
    /*
     * And it dissolves as it goes, rather than ending.
     *
     * Three long boxes reached the bottom of the window at full strength and
     * stopped dead on the window edge — the one silhouette a waterfall must
     * never have. Leaving it to the void fade does not work either: that plane
     * is set from the lowest *floor* in the campus and a fall starts under one
     * and keeps going, so most of the drop is below anything the fade is aimed
     * at. Water has to thin out because it is falling.
     *
     * So: more stages, each a step further toward the colour of the sky behind
     * it, with the steps bunched at the bottom where the change has to happen
     * fastest. The banding that would give a smooth surface is exactly the
     * stepping every other soft thing in this office is made of — the drape
     * folds, the corbelled arches — and at the width of a falling sheet it
     * reads as spray rather than as courses.
     */
    const stages = 7;
    let y = -0.2;
    let wander = offset;
    for (let stage = 0; stage < stages; stage++) {
      const t = stage / (stages - 1);
      // Short at the lip and longer as it goes, so the fall accelerates.
      const drop = 1.4 + t * 5.5 + random() * 1.6;
      // Held near full for the first third and then gone quickly.
      const fade = Math.min(0.97, Math.pow(t, 1.7) * 1.05);
      pieces.push(f.band(span, drop, 0.34, wander, y - drop, reach, 'water', [0.94, 1], fade));
      y -= drop;
      span *= 0.88 + random() * 0.07;
      wander += (random() - 0.5) * wide * 0.1;
    }
  }

  return pieces;
}

/**
 * A pavilion: a plinth, four columns and a hipped roof — a building, not a lid.
 *
 * A canopy shelters and a pavilion *encloses*, and the difference is meant to
 * be legible from across the campus: this one has a floor you step up onto, a
 * proper order of column, and a roof that comes to a ridge.
 *
 * It used to be four thin posts at the corners of the *whole* platform under a
 * roof spanning the lot, which had two problems. It never once got built — its
 * corner inset came out of the same rim-band budget the dome was starving on —
 * and had it been built it would have put a lid over the zone, hiding the very
 * furniture the office exists to show. So it takes one edge, like every other
 * gesture, and stands a bay on the clear deck there: you see it side-on against
 * the sky, you see the zone working beside it, and you can see daylight through
 * it between the columns.
 */
function pavilion(f: EdgeFrame, random: () => number, storey: number): Piece[] {
  const column = 0.3;
  const near = f.stand(column, 0);
  const deep = Math.min(f.clear - column, 3.4);
  // Narrower than this and the two ranks of columns are one rank; a pavilion
  // you cannot see through is a wall with a hat on.
  if (near === null || deep < 1.15) return [];
  const span = Math.min(f.along * (0.42 + random() * 0.16), Math.max(deep * 1.6, 5.4));
  const height = storey * (0.86 + random() * 0.22);
  const plinth = 0.26;
  const far = near - deep;
  const mid = near - deep / 2;
  const pieces: Piece[] = [];

  // The plinth, in two courses so the building sits on something rather than
  // starting out of the floor. A hair wider than the columns stand, which is
  // what reads as a step.
  pieces.push(
    f.band(span + column * 3.4, plinth * 0.55, deep + column * 3.4, 0, 0, mid, 'stone', [0.4, 0.82]),
    f.band(span + column * 2.2, plinth * 0.55, deep + column * 2.2, 0, plinth * 0.55, mid, 'pale', [0.62, 1]),
  );

  // Four columns, each with a base and a capital. The bands at either end are
  // most of what separates a column from a post.
  for (const offset of [-span / 2, span / 2]) {
    for (const out of [near, far]) {
      pieces.push(
        f.band(column * 1.34, 0.14, column * 1.34, offset, plinth, out, 'stone', [0.5, 0.92]),
        { shape: 'column', tone: 'pale', radius: column / 2, height, at: f.at(offset, plinth + 0.14, out), grad: [0.4, 1] },
        f.band(column * 1.5, 0.18, column * 1.5, offset, plinth + 0.14 + height, out, 'stone', [0.74, 1]),
      );
    }
  }

  // An architrave tying the columns together, then the roof on top of it. A
  // roof resting straight on four capitals looks balanced there; a beam under
  // it looks built.
  const head = plinth + 0.32 + height;
  pieces.push(
    f.band(span + column * 1.5, 0.2, column, 0, head, near, 'stone', [0.66, 1]),
    f.band(span + column * 1.5, 0.2, column, 0, head, far, 'stone', [0.66, 1]),
  );

  const [cx, , cz] = f.at(0, 0, mid);
  pieces.push(
    ...roof(
      cx,
      head + 0.2,
      cz,
      f.horizontal ? span : deep,
      f.horizontal ? deep : span,
      random,
    ),
  );
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

/**
 * The small things, and why every one of them now asks `stand`.
 *
 * These used to be placed with `fit`, which is the budget that lets a piece
 * overhang the rim when the walkable ring is too narrow to hold it — and it
 * nearly always is. For a balustrade that is right: it is a long thin band,
 * a sliver of it keeps a foot on the terrace, and it reads as attached
 * because it runs the length of the edge. For a *point* it is a disaster. A
 * lamp post 0.18 across, placed by that same rule, ends up with eight
 * millimetres of itself over the deck and the rest over the drop, and in an
 * isometric view its foot lands exactly on the platform's silhouette. There
 * is then nothing in the picture to say it is standing on anything, and the
 * report was the plain one: the pins are floating.
 *
 * So anything with a footprint rather than a length stands on measured deck
 * or is not built. The occupancy check downstream can still drop it if the
 * two of them together seal the walkway; an accent is the first thing it is
 * allowed to take.
 */
function minor(kind: Accentpiece, platform: Platform, edge: Edge, random: () => number): Piece[] {
  if (kind === 'none') return [];
  const f = frameFor(platform, edge);

  if (kind === 'pool') {
    // A still sheet of water at the rim, with a thin lip. Half of why the
    // waterfalls read: water belongs to this place, not just to its edges.
    const out = f.stand(1.24, 0.12);
    if (out === null) return [];
    const span = f.along * (0.3 + random() * 0.2);
    return [
      f.band(span + 0.24, 0.12, 1.24, 0, 0, out, 'stone', [0.6, 1]),
      f.band(span, 0.06, 1.0, 0, 0.12, out, 'water', [0.92, 1]),
    ];
  }

  if (kind === 'planter') {
    const out = f.stand(0.9, 0.2);
    if (out === null) return [];
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

  // A lantern: a slim post on a plinth, with a lit head. The one thing in the
  // vocabulary that carries the accent colour, and the only thing that reads
  // at night. The plinth is not decoration — it is the part of it that is
  // visibly standing on the floor, and a post without one is a pin.
  const FOOT = 0.54;
  const out = f.stand(FOOT, 0.3);
  if (out === null) return [];
  const offset = (random() - 0.5) * f.along * 0.5;
  const base = 0.16;
  const post = 1.1 + random() * 0.6;
  return [
    f.band(FOOT, base, FOOT, offset, 0, out, 'stone', [0.45, 1]),
    { shape: 'column', tone: 'pale', radius: 0.1, height: post, at: f.at(offset, base, out), grad: [0.5, 1] },
    {
      shape: 'column',
      tone: 'accent',
      radius: 0.18,
      height: 0.3,
      taper: 0.6,
      at: f.at(offset, base + post, out),
      grad: [0.8, 1],
    },
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

/**
 * How wide the rock still is, a given fraction of the way down it.
 *
 * The profile, as a curve, rather than a shrink factor applied per course —
 * and that is the whole of the fix. A ratio per course means the taper depends
 * on how many courses the dice gave: a sheer face takes three of them at 0.97
 * and comes out 91% as wide at the bottom as at the top, which is not a cliff,
 * it is a column with a lid on it. Worse, the last course always took whatever
 * height was left as one block, so whatever tapering had happened stopped dead
 * and the rock finished as a straight shaft hanging in the fog.
 *
 * Asking the curve instead means every rock arrives at the same place however
 * it was cut: about a tenth of its top width, necking away to nothing. The
 * three characters differ in *where* along the drop they spend it — a cliff
 * holds its width and then falls away, a stalk necks immediately, stepped does
 * it evenly — which is the difference that was supposed to be there and was
 * being spent on the wrong axis.
 */
function rockProfile(kind: RockKind, t: number): number {
  const u = Math.min(1, Math.max(0, t));
  /*
   * The exponents are chosen for where the *visible* part of the rock is.
   *
   * Only about the top two thirds of a keel is above the plane that dissolves
   * into sky, so a curve that does all its narrowing in the last third is a
   * curve that, on screen, does not narrow at all — which is how a profile
   * that was correct on paper still shipped as a set of columns. These reach
   * roughly half width by halfway down and then fall away, so the taper is
   * something you can see and the point it comes to is something the fog
   * finishes rather than hides.
   */
  const shape = kind === 'sheer' ? Math.pow(u, 1.7) : kind === 'stalk' ? Math.pow(u, 0.5) : u * u * (3 - 2 * u);
  return 1 - 0.94 * shape;
}

function substructure(platform: Platform, random: () => number, bedrock: number): Piece[] {
  const [width, depth] = platform.size;
  const reach = Math.max(1.2, levelY(platform.level) - bedrock);
  const kind = rockKind(random);
  // Nothing at all: the terrace simply ends, and the campus gets some air in it.
  if (kind === 'none') return [];
  /*
   * Enough courses to cut the curve, and more of them than there used to be.
   *
   * A taper read off a profile is only as smooth as the number of steps you
   * cut it in, and three steps over twenty units is not a taper, it is a
   * wedding cake. These are cheap — one box each, in a mesh that is merged
   * anyway — and the top ones are what anybody actually sees.
   */
  const steps = Math.max(5, Math.min(11, Math.round(reach / (kind === 'sheer' ? 3.2 : 2.3))));
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
  const top: [number, number] = [width * (kind === 'sheer' ? 0.98 : 0.92), depth * (kind === 'sheer' ? 0.98 : 0.92)];

  let x = 0;
  let z = 0;
  let y = -0.55;
  let w = top[0];
  let d = top[1];

  for (let i = 0; i < steps; i++) {
    /*
     * Courses get taller as they go down, so the visible top of the rock is
     * finely cut and the part inside the fog is not cut at all. The weights
     * sum to `reach` by construction, which is what keeps every rock in the
     * campus ending on the same plane however many courses it was given.
     *
     * "By construction" is doing real work in that sentence, and it was wrong
     * once: the divisor was the sum of 1..steps where the numerators are the
     * sum of 0..steps-1, so the shares came to about four fifths and every
     * keel in the office stopped a couple of units short of the plane the fog
     * finishes on. What that draws is a grey block with a hard flat bottom
     * hanging under each platform — reported, fairly, as a shadow under
     * everything. If this expression is ever edited again, check that the
     * shares sum to one before checking anything else.
     */
    const share = (i + 1.4) / ((steps * (steps - 1)) / 2 + 1.4 * steps);
    const tall = reach * share;
    y -= tall;
    pieces.push({
      shape: 'box',
      tone: 'stone',
      size: [w, tall, d],
      at: [x, y, z],
      // Bottom of the ramp, top of the ramp. Both rise with depth: the deeper
      // the course, the less the gradient takes off it.
      grad: [0.3 + (i / Math.max(1, steps - 1)) * 0.55, 0.86 + (i / Math.max(1, steps - 1)) * 0.14],
    });

    // The width of the *next* course, read off the profile at the depth this
    // one ended, with a little noise so the neck is cut rather than turned.
    const at = rockProfile(kind, (-0.55 - y) / reach) * (0.94 + random() * 0.12);
    const nextW = Math.max(0.22, top[0] * at);
    const nextD = Math.max(0.22, top[1] * at);
    // Half of what a course loses comes off the leaning side, so the face on
    // that side stays nearly sheer while the other cuts back in steps.
    x += ((w - nextW) / 2) * lean[0] * bite * 2;
    z += ((d - nextD) / 2) * lean[1] * bite * 2;
    w = nextW;
    d = nextD;
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
function palette(theme: ResolvedTheme, variant = 0, level = 0): Record<Tone, string> {
  // Whatever stone the platform is cut from, the building on it is cut from the
  // same — that is what makes architecture read as carved out of the campus
  // rather than dropped onto it, and it is now a per-platform answer rather
  // than a per-theme one.
  const stone = stoneVariant(theme, variant, level);
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
export function archGeometry(
  pieces: readonly Piece[],
  theme: ResolvedTheme,
  variant = 0,
  level = 0,
): BufferGeometry | null {
  if (pieces.length === 0) return null;
  const colors = palette(theme, variant, level);
  const parts: Part[] = [];

  for (const piece of pieces) {
    let color = colors[piece.tone];
    if (piece.shape === 'box') {
      // Toward the bottom of the sky, which is the band a fall ends in and the
      // colour the void fade is aiming at anyway — so the two compose instead
      // of fighting.
      if (piece.fade) color = mixHex(color, theme.sky[0], piece.fade);
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
  /**
   * Which staging slot each platform's architecture belongs to.
   *
   * Optional, and when it is given the freestanding pieces take slot 0: a
   * gateway arch over a bridge belongs to the campus rather than to either
   * room, and it has nothing to rise out of.
   */
  stage?: (platform: Platform) => number,
): BufferGeometry | null {
  const parts: BufferGeometry[] = [];
  for (const platform of campus.platforms) {
    if (!includes(platform)) continue;
    const pieces = plan.onPlatform.get(platform.id);
    if (!pieces) continue;
    const geometry = archGeometry(pieces, theme, platform.stone, platform.stoneLevel);
    if (!geometry) continue;
    geometry.translate(platform.position[0], levelY(platform.level), platform.position[1]);
    if (stage) tagStage(geometry, stage(platform));
    parts.push(geometry);
  }
  const loose = detachedGeometry(plan, theme);
  if (loose) parts.push(stage ? tagStage(loose, 0) : loose);
  if (parts.length === 0) return null;
  const merged = parts.length === 1 ? parts[0]! : mergeGeometries(parts);
  return merged ?? null;
}
