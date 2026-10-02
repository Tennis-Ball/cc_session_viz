/**
 * How a bird flies, as arithmetic.
 *
 * Kept out of the scene for the same reason the figure controller is: this is
 * where the behaviour lives, it is the part worth pinning down in a test, and
 * it has no business knowing what a matrix is. `Birds.tsx` reads the numbers
 * below and writes them into three instanced meshes.
 *
 * The first version of this lerped a bird from one perch to the next along a
 * straight line with a sine bump for height, and it was wrong in a way that is
 * worth writing down: *a bird's path is a consequence of how it flies, not a
 * shape it follows*. Nothing that slides between two points at a constant rate
 * can look alive, however nice the curve, because the tell is not the line — it
 * is the banking into the turn, the run of hard beats to get airborne, the long
 * flat glide, and the flare where the speed goes and the wings come forward.
 *
 * So there is no path here at all. A bird has a heading, a speed and a target,
 * it turns at a limited rate, and it rolls because it is turning. Everything
 * that reads as grace comes out of those four facts.
 */

/** Where a bird can sit: the top of something tall and thin. */
export interface Perch {
  at: [number, number, number];
  /** Index of the perch, for the alarm test below. */
  id: number;
}

/**
 * What a bird is doing.
 *
 * `alert` is the one that earns its keep. A bird that launches the instant
 * something comes near is a trigger; a bird that stops, turns and *looks* — and
 * only goes if whatever it is keeps coming — is an animal. It is also the state
 * you actually see, because it happens while the figure is still walking over.
 */
export type BirdPhase = 'perched' | 'alert' | 'launch' | 'cruise' | 'approach' | 'settle';

export interface Bird {
  phase: BirdPhase;
  /** Seconds spent in the current phase. */
  since: number;
  /** Seconds until the bird moves on of its own accord, while perched. */
  patience: number;

  at: [number, number, number];
  /** Yaw, radians. The nose points along +Z rotated by this. */
  heading: number;
  /** Bank, radians. Positive rolls the right wing down. */
  roll: number;
  /** Nose up, radians. */
  pitch: number;
  speed: number;

  /** Where it sits, or −1 in the air. */
  perch: number;
  /** Where it is going, or −1 if it has nowhere in mind. */
  target: number;
  /** Altitude it is holding while it crosses. */
  cruiseY: number;

  /** Wingbeat phase, radians. */
  beat: number;
  /** How hard it is flapping, 0–1. Eased, so a glide starts gradually. */
  power: number;
  /** Seconds left in the current run of beats, or of gliding. */
  gliding: boolean;
  glideFor: number;

  /** What it is looking at while alert, as a yaw. */
  watch: number;
  /** How long this bird waits before following somebody else up, in ms. */
  follows: number;
  random: () => number;
}

/** Somebody on the campus, and whether they are the kind that waves. */
export interface Threat {
  at: [number, number, number];
  npc: boolean;
}

export const FLIGHT = {
  /** A figure this close is worth watching. */
  notice: 5.6,
  /** And this close is worth leaving. */
  spook: 3.2,
  /** An NPC shooing: deliberate, so it works from further out. */
  shoo: 4.4,
  /** A threat more than this far below is on another floor and is nobody's business. */
  reach: 4.5,

  /**
   * How far the news travels.
   *
   * One bird going up takes its neighbours with it, and this is the single most
   * bird-like thing in the file: the flock is not six independent animals, it
   * is one animal's nerves shared six ways. Without it the campus has birds on
   * it; with it the campus has a flock on it.
   */
  alarm: 7.5,
  /** And how long the next one waits before following. Never in step. */
  contagionMs: [90, 420] as const,

  speed: { launch: 6.2, cruise: 4.4, approach: 2.4, flare: 0.7 },
  /** Radians per second. Slower than a fighter, which is the point. */
  turn: 2.3,
  /** How much of the turn rate becomes bank. */
  rollGain: 0.62,
  rollMax: 0.95,
  /** How fast the bank and the pitch catch up with where they are going. */
  attitudeEase: 6.5,

  /** Above the higher of the two perches. */
  cruiseLift: [5.5, 8.5] as const,
  /** Vertical speed, up and down. */
  climb: 5.0,
  sink: 3.4,

  /** Horizontal distance at which the crossing becomes a descent. */
  approachAt: 9.0,
  /** And at which the descent becomes a flare. */
  flareAt: 2.2,

  /** Radians per second at full power: about two and a half beats a second. */
  flap: 16.0,
  /** Seconds a run of beats lasts, and a glide between runs. */
  beatsFor: [0.5, 1.1] as const,
  glideFor: [0.9, 2.2] as const,

  /** How long a bird will sit before it fancies a change. */
  perchFor: [16, 64] as const,
  /** How long it will stare at something before deciding it is fine. */
  watchFor: 2.4,
  /** The flare, and then it is down. */
  settleFor: 0.42,

  maxBirds: 12,
};

function span(range: readonly [number, number], random: () => number): number {
  return range[0] + random() * (range[1] - range[0]);
}

/** Signed smallest angle from `a` to `b`. */
export function angleTo(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * How many birds a campus with this many perches carries.
 *
 * Fewer than there are places to sit, always: a bird on every column is a row
 * of ornaments, and the empty perches are what make the occupied ones read as
 * chosen.
 */
export function flockSize(perches: number): number {
  if (perches < 3) return 0;
  return Math.min(FLIGHT.maxBirds, Math.max(2, Math.floor(perches * 0.42)));
}

export function createBird(perches: Perch[], slot: number, random: () => number): Bird {
  const perch = Math.floor(random() * perches.length);
  const at = perches[perch]?.at ?? [0, 0, 0];
  return {
    phase: 'perched',
    since: 0,
    // Staggered, or the whole flock's first move is one event.
    patience: slot * 3.1 + span(FLIGHT.perchFor, random),
    at: [...at] as [number, number, number],
    heading: random() * Math.PI * 2,
    roll: 0,
    pitch: 0,
    speed: 0,
    perch,
    target: -1,
    cruiseY: at[1] + span(FLIGHT.cruiseLift, random),
    beat: random() * Math.PI * 2,
    power: 0,
    gliding: false,
    glideFor: 0,
    watch: 0,
    follows: FLIGHT.contagionMs[0] + random() * (FLIGHT.contagionMs[1] - FLIGHT.contagionMs[0]),
    random,
  };
}

export interface FlightContext {
  perches: Perch[];
  threats: readonly Threat[];
  /** Rain: nobody settles, everybody stays up. */
  grounded: boolean;
  /** Where the last bird went up from, and how long ago. See `FLIGHT.alarm`. */
  alarmAt: [number, number, number] | null;
  alarmAgeMs: number;
}

/** The nearest figure worth caring about, and how close it got. */
function nearestThreat(bird: Bird, threats: readonly Threat[]): { distance: number; reach: number; yaw: number } | null {
  let best: { distance: number; reach: number; yaw: number } | null = null;
  for (const threat of threats) {
    const dx = threat.at[0] - bird.at[0];
    const dz = threat.at[2] - bird.at[2];
    // Height counts: somebody on the floor twenty feet below a tower is not
    // walking up to it, and a bird that leaves anyway is jumpy rather than shy.
    if (Math.abs(threat.at[1] - bird.at[1]) > FLIGHT.reach) continue;
    const distance = Math.hypot(dx, dz);
    const reach = threat.npc ? FLIGHT.shoo : FLIGHT.spook;
    if (!best || distance - reach < best.distance - best.reach) {
      best = { distance, reach, yaw: Math.atan2(dx, dz) };
    }
  }
  return best;
}

/** Somewhere else to sit. Never where it already is. */
function pickTarget(bird: Bird, perches: Perch[]): number {
  if (perches.length < 2) return -1;
  let next = Math.floor(bird.random() * perches.length);
  if (next === bird.perch) next = (next + 1) % perches.length;
  return next;
}

/**
 * Put a bird up by hand.
 *
 * The office is a picture you watch rather than one you operate, and it has
 * exactly two things you can do to it — frame a desk, and pick up a figure.
 * This is the third, and it is the cheapest possible one: the birds already
 * leave when somebody walks up, so leaving because *you* said so needs no new
 * behaviour at all, only a way to say it. It also carries the alarm, so
 * shooing one takes the two sitting near it with it, which is the whole reason
 * it is satisfying rather than merely responsive.
 */
export function shoo(bird: Bird, perches: Perch[]): boolean {
  if (bird.phase !== 'perched' && bird.phase !== 'alert') return false;
  launch(bird, perches, null);
  return true;
}

function launch(bird: Bird, perches: Perch[], away: number | null): void {
  bird.phase = 'launch';
  bird.since = 0;
  bird.perch = -1;
  bird.target = pickTarget(bird, perches);
  bird.speed = FLIGHT.speed.launch * 0.45;
  bird.power = 1;
  bird.gliding = false;
  bird.glideFor = span(FLIGHT.beatsFor, bird.random);
  // Off the way it was already looking, or straight away from whatever moved.
  if (away !== null) bird.heading = away + Math.PI + (bird.random() - 0.5) * 0.8;
  const top = Math.max(bird.at[1], perches[bird.target]?.at[1] ?? bird.at[1]);
  bird.cruiseY = top + span(FLIGHT.cruiseLift, bird.random);
}

/**
 * One bird, one frame.
 *
 * Mutates in place: this runs for every bird on every frame and a fresh object
 * apiece would be the most allocation in the office.
 */
export function stepBird(bird: Bird, dt: number, ctx: FlightContext): void {
  bird.since += dt;
  const { perches } = ctx;

  if (bird.phase === 'perched' || bird.phase === 'alert') {
    const threat = nearestThreat(bird, ctx.threats);
    const close = threat !== null && threat.distance < threat.reach;
    const seen = threat !== null && threat.distance < FLIGHT.notice;

    // Somebody else went up nearby, and it is catching. The delay is what
    // turns six simultaneous launches into a flock leaving.
    const alarmed =
      ctx.alarmAt !== null &&
      ctx.alarmAgeMs >= bird.follows &&
      ctx.alarmAgeMs <= FLIGHT.contagionMs[1] + 120 &&
      Math.hypot(ctx.alarmAt[0] - bird.at[0], ctx.alarmAt[2] - bird.at[2]) < FLIGHT.alarm;

    if (close || ctx.grounded || alarmed || bird.patience <= 0) {
      launch(bird, perches, threat && close ? threat.yaw : null);
      return;
    }

    if (seen) {
      // Watching. It holds still and turns to face whatever it is, which is
      // both what a bird does and a tell that something is about to happen.
      bird.phase = 'alert';
      bird.watch = threat.yaw;
      bird.heading += angleTo(bird.heading, bird.watch) * Math.min(1, dt * 5);
      bird.since = 0;
    } else if (bird.phase === 'alert' && bird.since > FLIGHT.watchFor) {
      bird.phase = 'perched';
      bird.since = 0;
    }

    bird.patience -= dt;
    bird.speed += (0 - bird.speed) * Math.min(1, dt * 8);
    bird.power += (0 - bird.power) * Math.min(1, dt * 6);
    bird.roll += (0 - bird.roll) * Math.min(1, dt * FLIGHT.attitudeEase);
    bird.pitch += (0 - bird.pitch) * Math.min(1, dt * FLIGHT.attitudeEase);
    return;
  }

  // --- airborne ---

  /*
   * Rain takes the destinations away rather than the birds.
   *
   * Nothing settles in a shower, so a grounded bird has nowhere in mind — and
   * a bird with nowhere in mind circles, which is exactly the right answer and
   * costs nothing to arrange. Clearing the target is also what stops it
   * flip-flopping between approach and cruise on the doorstep of a perch it is
   * not allowed to use.
   */
  if (ctx.grounded) bird.target = -1;
  else if (bird.target < 0 && bird.phase === 'cruise') bird.target = pickTarget(bird, perches);

  const to = perches[bird.target]?.at ?? null;
  const dx = to ? to[0] - bird.at[0] : 0;
  const dz = to ? to[2] - bird.at[2] : 0;
  const flat = Math.hypot(dx, dz);

  let wantSpeed = FLIGHT.speed.cruise;
  let wantY = bird.cruiseY;
  let wantHeading = bird.heading;
  let wantPitch = 0;
  let turnRate = FLIGHT.turn;

  if (to) wantHeading = Math.atan2(dx, dz);

  switch (bird.phase) {
    case 'launch':
      wantSpeed = FLIGHT.speed.launch;
      wantY = bird.cruiseY;
      wantPitch = -0.34; // nose up, climbing
      // It is not steering yet. A bird leaving a perch goes where it was
      // pointed and sorts the direction out once it has some air under it.
      wantHeading = bird.heading;
      if (bird.at[1] > bird.cruiseY - 1.4 || bird.since > 1.5) {
        bird.phase = 'cruise';
        bird.since = 0;
      }
      break;

    case 'cruise':
      wantSpeed = FLIGHT.speed.cruise;
      // No target — raining, or a world with one perch — so it circles. A wide
      // slow turn, which is the most restful thing anything in the sky does.
      if (!to) {
        wantHeading = bird.heading + 0.55;
        turnRate = FLIGHT.turn * 0.35;
      }
      if (to && flat < FLIGHT.approachAt && !ctx.grounded) {
        bird.phase = 'approach';
        bird.since = 0;
      }
      break;

    case 'approach':
      wantSpeed = FLIGHT.speed.approach;
      wantY = to ? to[1] + 0.25 : bird.cruiseY;
      wantPitch = 0.12;
      // Tighter, because it is slow: the turn radius is what a landing
      // approach is made of.
      turnRate = FLIGHT.turn * 1.45;
      if (ctx.grounded) {
        bird.phase = 'cruise';
        bird.since = 0;
      } else if (flat < FLIGHT.flareAt) {
        bird.phase = 'settle';
        bird.since = 0;
      }
      break;

    case 'settle': {
      // The flare: speed goes, the nose comes up, the wings come forward and
      // wide. Every landing anything does is this shape.
      wantSpeed = FLIGHT.speed.flare;
      wantY = to ? to[1] : bird.at[1];
      wantPitch = 0.55;
      turnRate = FLIGHT.turn * 1.8;
      const t = Math.min(1, bird.since / FLIGHT.settleFor);
      if (to) {
        // Drawn onto the perch over the flare rather than flown at it, so it
        // arrives exactly on the spot instead of near it.
        const k = Math.min(1, dt / Math.max(0.001, FLIGHT.settleFor * (1 - t) + 0.001));
        bird.at[0] += (to[0] - bird.at[0]) * k;
        bird.at[1] += (to[1] - bird.at[1]) * k;
        bird.at[2] += (to[2] - bird.at[2]) * k;
      }
      if (t >= 1) {
        bird.phase = 'perched';
        bird.since = 0;
        bird.perch = bird.target;
        bird.target = -1;
        bird.patience = span(FLIGHT.perchFor, bird.random);
        bird.speed = 0;
        bird.power = 0;
        if (to) bird.at = [to[0], to[1], to[2]];
        /*
         * Down, and nothing else happens this frame.
         *
         * The steering and the integration below run for every airborne bird,
         * and they were still running on the frame the bird arrived: the
         * easing put a fraction of the flare speed back and carried it about
         * half a millimetre off the perch it had just been snapped onto. Small
         * enough to be invisible and exactly the kind of thing that makes a
         * bird sit a hair beside its column instead of on it.
         */
        return;
      }
      break;
    }
    default:
      break;
  }

  // Steering. The turn is rate-limited and the bank is a consequence of it,
  // which is the whole of why this looks like flight.
  const wanted = angleTo(bird.heading, wantHeading);
  const turn = Math.max(-turnRate * dt, Math.min(turnRate * dt, wanted));
  bird.heading += turn;
  const bank = Math.max(-FLIGHT.rollMax, Math.min(FLIGHT.rollMax, (turn / Math.max(dt, 0.0001)) * FLIGHT.rollGain));
  bird.roll += (bank - bird.roll) * Math.min(1, dt * FLIGHT.attitudeEase);
  bird.pitch += (wantPitch - bird.pitch) * Math.min(1, dt * FLIGHT.attitudeEase);
  bird.speed += (wantSpeed - bird.speed) * Math.min(1, dt * 3.2);

  if (bird.phase !== 'settle') {
    bird.at[0] += Math.sin(bird.heading) * bird.speed * dt;
    bird.at[2] += Math.cos(bird.heading) * bird.speed * dt;
    const rise = wantY - bird.at[1];
    const rate = rise > 0 ? FLIGHT.climb : FLIGHT.sink;
    bird.at[1] += Math.max(-rate * dt, Math.min(rate * dt, rise));
  }

  /*
   * Beats and glides.
   *
   * A bird that flaps steadily is a toy. What it actually does is beat three
   * or four times, then hold the wings out and coast — and the coast is the
   * elegant half, because it is the only moment the silhouette is still. The
   * climb out is all beats and the flare is all beats; the crossing in between
   * is mostly glide.
   */
  bird.glideFor -= dt;
  if (bird.glideFor <= 0) {
    bird.gliding = !bird.gliding;
    bird.glideFor = span(bird.gliding ? FLIGHT.glideFor : FLIGHT.beatsFor, bird.random);
  }
  const working = bird.phase === 'launch' || bird.phase === 'settle' || !bird.gliding;
  const wantPower = bird.phase === 'launch' ? 1 : bird.phase === 'settle' ? 0.85 : working ? 0.72 : 0.06;
  bird.power += (wantPower - bird.power) * Math.min(1, dt * 7);
  bird.beat += dt * FLIGHT.flap * (0.35 + 0.65 * bird.power);
  if (bird.beat > Math.PI * 2) bird.beat -= Math.PI * 2;
}
