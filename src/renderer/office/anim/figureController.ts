import { ACTIVITY_ZONE, type Activity, type SlotKind, type ZoneId } from '@shared/activity';
import { scaleForTier, type FigureShape } from '../figures/geometry';
import { pathLength, pointAlong, type Vec3 } from '../world/navGraph';
import { BeatQueue, NEUTRAL, type BeatKind, type BeatModifier } from './beats';

/**
 * One figure's behaviour.
 *
 * The hard part is not walking, it is *not* walking: agents change tool every
 * second or two, and a figure that obeyed every change would sprint between
 * zones forever. So a target zone has to hold still before the figure commits
 * to it, and once it commits it stays put for a while.
 */

export type FigurePhase = 'arriving' | 'standing' | 'walking' | 'leaving' | 'gone';

export interface FigurePose {
  position: Vec3;
  heading: number;
  scale: number;
  /** 0–1, drives a halo ring when the agent needs the user. */
  attention: number;
  /** Vertical scale; a beat squashes or stretches without changing footprint. */
  squash: number;
  /** Radians of lean across the shoulders. */
  tilt: number;
  /** 0–1: how present the carried context slab is. */
  carry: number;
  /** 0–1: an error highlight. */
  flash: number;
  /** 0–1: how far into a chair. Standing is 0, fully sat down is 1. */
  seated: number;
  /** World height of that chair's seat. */
  seatHeight: number;
}

/**
 * Slots you sit at.
 *
 * Everything else in the office is something you stand and work at — a
 * whiteboard, a shelf, a copier — so sitting is the exception and worth
 * naming. It is also most of what makes a desk read as *yours*: an agent
 * standing beside its desk looks like it is about to leave.
 */
const SEATED_SLOTS = new Set<SlotKind>(['deskSeat', 'sofa', 'tableSeat', 'warTableSeat', 'bench', 'hourglass']);

/** How long it takes to sit down or stand up. */
const SIT_MS = 420;

export interface ZoneResolver {
  /** Where this figure goes for a zone: its own desk, or the shared platform. */
  platformFor(zone: ZoneId, agentId: string): { platformId: string; position: Vec3 } | null;
  claimSlot(
    agentId: string,
    platformId: string,
    kind: SlotKind,
    near: Vec3,
  ): { position: Vec3; facing: number; seat?: number };
  /** The platform a figure is actually standing on, which is where a walk starts. */
  platformAt(position: Vec3): string | null;
  route(fromPlatform: string, from: Vec3, toPlatform: string, to: Vec3): Vec3[];
}

/**
 * How a figure decides where to be.
 *
 * Agents change tool every second or two. Reacting to each change sends figures
 * sprinting between zones forever — and, worse, they never arrive, because a
 * new destination lands before the last walk finishes. So instead of the
 * instantaneous activity, each figure keeps a decaying tally of where its work
 * has been lately and goes to whichever zone is winning.
 */
const WINDOW_SECONDS = 6;
/** Seconds of accumulated lead before it is worth crossing the office. */
const LEAD_SECONDS = 1;
/** Once it arrives somewhere it stays a while, whatever the tally says. */
const MIN_DWELL_MS = 4000;
/**
 * What a turn of thinking is worth, against a turn of doing something.
 *
 * Thinking is sixty per cent of everything an agent does and it maps to the
 * desk, so at full weight the desk wins permanently and the office is a room
 * full of people sitting down. Measured over five minutes of simulated traffic:
 * reading went to the library seventeen times out of eighty-five and testing
 * reached the workshop never once. Every other room was furniture nobody
 * touched, which is the exact failure the tally was introduced to avoid and it
 * had simply moved it somewhere else.
 *
 * At a third, a session that reads, thinks, reads, thinks is a session at the
 * library — which is the truth about it — while a session that only thinks is
 * still walked home inside about ten seconds.
 *
 * The three numbers above are the other half of it, and they were tuned by
 * measurement rather than by eye: with the window at four seconds and the lead
 * under one, the office went the other way and spent seventy per cent of its
 * time walking, which is not busy, it is frantic. These settle at about two and
 * a half seconds of sustained work to earn a trip — long enough to ignore the
 * blips, short enough that a burst of reading is a trip to the library.
 */
const THINKING_WEIGHT = 0.35;
/**
 * Walking pace, in world units per second.
 *
 * Brisk on purpose: the campus is about forty units across, and at a realistic
 * stroll a figure spends its whole life in transit and is never seen at work.
 */
const WALK_SPEED = 2.7;
const STAIR_SPEED = 1.7;
const ARRIVE_MS = 700;
const LEAVE_MS = 600;
/** A model switch changes a figure's presence; it should grow into it. */
const TIER_TWEEN_MS = 800;

/**
 * How much room everybody keeps around themselves, and how far they will step
 * aside to get it.
 *
 * Figures are routed, not simulated: two of them sent to neighbouring slots on
 * the same errand arrive on paths that cross, and for a second or two they
 * occupy the same half-metre and draw as one four-armed person. Nobody was
 * wrong — both routes were valid — which is why this is a display correction
 * rather than a change to the routing: the nudge is added to the *pose*, so
 * the path, the slot and the arrival are all untouched and only the body moves
 * over a little.
 *
 * `BODY` is the figure's own half-width, scaled per figure because the models
 * are not all the same size: the bodies are built around a cone of radius 0.3,
 * and the sliver on top of it is the air people leave between themselves. It
 * has to be the real measurement, and for two rounds it was not — 0.44 against
 * a cone of 0.3 — which made every arithmetic judgement about this pass wrong
 * in the same direction. At the house tier that is bodies asking for 1.58
 * between their centres when they touch at 1.08, so the pass reported crowding
 * where there was daylight, and, far worse, asked for a separation of 1.58 that
 * two caps of 0.55 could not deliver: from a dead-centre overlap it could never
 * finish the job, and the last stretch of it was a standing overlap no number
 * of passes would clear.
 *
 * `GIVE` is capped because the nudge does not know where the floor ends, and is
 * sized from `BODY` rather than guessed: a pair must be able to part *fully*,
 * so two gives have to exceed two bodies with something to spare. On stairs it
 * is cut to `CROWD_STAIR_GIVE`, where the floor ends much sooner.
 *
 * The cap used to be a third of a unit, which cannot separate anything. And the
 * push was always along the line between them, which is the one direction that
 * does not help a pair walking *at* each other — it brakes them and they slide
 * through. Both are fixed below; see `separateFigures`.
 */
const CROWD_BODY = 0.32;
/**
 * Sized from the widest pair the office can produce, rather than picked.
 *
 * Two figures on a collision course end up missing each other by two of these,
 * so two of these have to be more than two bodies or the pass cannot finish the
 * job it exists to do — and the bodies that matter are the biggest ones, a pair
 * of Fables. Guessing it is how it came to be a third of a unit, then a half,
 * neither of which could separate anybody.
 */
const CROWD_GIVE = CROWD_BODY * scaleForTier(3) * 1.12;
/** How quickly the body eases toward the offset it wants. */
const CROWD_EASE = 7;
/**
 * And how quickly when the offset it wants is a whole body bigger than the one
 * it has, which is a correction rather than a lean. See `update`.
 */
const CROWD_SNAP = 25;
/**
 * Relaxation passes per frame.
 *
 * One pass settles a pair and gets a crowd wrong, because every push is
 * computed against where everybody started rather than where the last push put
 * them — so in a knot of four, three of them agree to move into the same gap.
 * Three passes over the *proposed* positions is enough for the knots this
 * office makes and costs nothing at this population.
 */
const CROWD_PASSES = 3;
/** Under one, so the passes converge instead of ringing. */
const CROWD_STIFF = 0.8;
/**
 * Below this the two of them are not going anywhere relative to each other.
 *
 * The length of the difference between their courses: zero for a pair walking in
 * step or both standing, two for a head-on pair. Under a few hundredths there is no
 * encounter to steer, so the pair simply backs apart along the line between
 * them, which in that case is both stable and the shortest way out.
 */
const CROWD_TOGETHER = 0.03;
/**
 * How near a dead-on collision counts as dead on, measured as the miss distance.
 *
 * Inside this there is no side of the other figure to prefer, and which side the
 * arithmetic lands on is down to a hundredth of a unit of noise — so the pair
 * agrees on one by a rule instead, and keeps it.
 */
const CROWD_DEADON = 0.3;
/**
 * How far ahead the pass looks, per unit of closing rate, in world units.
 *
 * Not a multiple of a body, which is what it was and is what made it too small:
 * it is a *time*, converted. The step aside is eased in rather than snapped, so
 * it takes something like three time constants to actually arrive — a little
 * under half a second — and in that time a pair walking at each other covers a
 * good two units, because they are each doing `WALK_SPEED` and the office is
 * drawn at a scale where that is quick. A reach of one and a bit bodies is
 * therefore a sidestep that is still arriving while the two of them are passing
 * through one another, which is exactly what the office looked like: the worst
 * overlap over four minutes was two walking figures thirteen hundredths of a
 * unit apart.
 *
 * Written as the arithmetic rather than the answer on purpose. All three numbers
 * it depends on have been tuned at least once, and every time one of them moved,
 * a hand-written constant here was quietly wrong again.
 */
const CROWD_FORESIGHT = (3 / CROWD_EASE) * (2 * WALK_SPEED);
/**
 * And how far a figure on a flight of stairs may be moved.
 *
 * A little less than on open floor, because the nudge has no idea it is on a
 * flight and stepping off the side of one into the void is a worse picture than
 * the overlap it was fixing. Only a little, though: below half a body it buys
 * that safety by making a pair meeting on the stairs unseparable, which is the
 * exact thing this pass exists to prevent. A walkway is 2.6 across, so this
 * still leaves most of a body between the figure and the drop.
 */
const CROWD_STAIR_GIVE = 0.58;

export class FigureController {
  phase: FigurePhase = 'arriving';
  position: Vec3;
  /** Where the body is, relative to where the route says it is. See `CROWD_GIVE`. */
  private nudge: [number, number] = [0, 0];
  private nudgeWanted: [number, number] = [0, 0];
  heading = 0;
  scale = 0;
  attention = 0;

  private activity: Activity = 'thinking';
  private zone: ZoneId | null = null;
  private platformId: string | null = null;
  private desiredZone: ZoneId | null = null;
  private readonly tally = new Map<ZoneId, number>();
  private arrivedAt = 0;
  private phaseStartedAt = 0;

  private path: Vec3[] | null = null;
  private travelled = 0;
  private pathLength = 0;
  private stairPath = false;
  private facing = 0;
  private bobPhase = Math.random() * Math.PI * 2;
  /**
   * Something held for a while, as opposed to the `carry` beat.
   *
   * The beat is two and a half seconds of taking the context stack to the
   * Archive. Somebody who has been to the coffee machine is holding a cup
   * until they put it down, which is minutes — so it is state, not a beat, and
   * the pose takes whichever of the two is larger.
   */
  private holding = 0;
  private holdingTarget = 0;
  /**
   * Until when this figure is somewhere of its own accord.
   *
   * Set when two agents that are actually talking to each other are sent to
   * meet. Without it the tally puts them straight back to work: a figure is
   * credited for its activity's zone every frame, so the one that walked over
   * turns round and walks home before the other has said anything.
   */
  private heldUntil = 0;
  /** Where the figure is between standing and sitting, and where it is headed. */
  private seated = 0;
  private seatedTarget = 0;
  private seatHeight = 0.42;

  private readonly beats = new BeatQueue();
  private beatModifier: BeatModifier = NEUTRAL;
  private lastNow = 0;
  private tierFrom: number;
  private tierTo: number;
  private tierAt = 0;

  constructor(
    readonly id: string,
    readonly role: FigureShape,
    tierScale: number,
    start: {
      position: Vec3;
      platformId: string | null;
      zone: ZoneId | null;
      facing?: number;
      /**
       * The kind of slot it starts in. A figure that materialises at its own
       * desk never routes anywhere, so nothing would otherwise tell it it is
       * sitting down — it would stand beside its chair until its first errand.
       */
      slot?: SlotKind;
      /** Height of the seat it starts at, if it starts in one. */
      seat?: number;
    },
    private resolver: ZoneResolver,
    now: number,
  ) {
    this.tierFrom = tierScale;
    this.tierTo = tierScale;
    this.tierAt = now - TIER_TWEEN_MS;
    this.position = [...start.position];
    this.platformId = start.platformId;
    this.zone = start.zone;
    this.desiredZone = start.zone;
    this.facing = start.facing ?? 0;
    this.heading = this.facing;
    this.seatedTarget = start.slot && SEATED_SLOTS.has(start.slot) && start.seat !== undefined ? 1 : 0;
    this.seated = this.seatedTarget;
    if (start.seat !== undefined) this.seatHeight = start.seat;
    this.phaseStartedAt = now;
    this.arrivedAt = now;
    this.lastNow = now;
    if (start.zone) this.tally.set(start.zone, LEAD_SECONDS);
  }

  /**
   * The floor plan changed underneath this figure.
   *
   * Desks come and go as sessions start and end, and every rebuild produces a
   * fresh nav graph and slot pool. Without this the figure keeps a platform id
   * nothing knows about any more, loses its seat to a newcomer, and is routed
   * straight across the void — which is exactly what it looks like.
   */
  rehome(resolver: ZoneResolver, now: number): void {
    this.resolver = resolver;
    if (this.phase === 'gone' || this.phase === 'leaving') return;

    // Whatever it was heading for may be gone with the old floor plan, so fall
    // back through its desk to the lounge. Failing every one of those means
    // there is nowhere left to stand, and standing in the void is not an
    // option: the figure bows out instead.
    const wanted = this.zone ?? this.desiredZone;
    this.zone = null;
    for (const zone of [wanted, 'desk', 'lounge'] as (ZoneId | null)[]) {
      if (zone && this.commit(zone, now)) return;
    }
    this.leave(now);
  }

  /** Body scale from the model tier, tweened so a model switch is not a pop. */
  get baseScale(): number {
    return this.tierScale;
  }

  private get tierScale(): number {
    const t = Math.min(1, Math.max(0, (this.lastNow - this.tierAt) / TIER_TWEEN_MS));
    return this.tierFrom + (this.tierTo - this.tierFrom) * easeInOutCubic(t);
  }

  /** A model change: grow or shrink into the new presence. */
  /** Picks something up, or puts it down. See `holding`. */
  setHolding(held: boolean): void {
    this.holdingTarget = held ? 1 : 0;
  }

  setTier(scale: number, now: number): void {
    if (Math.abs(scale - this.tierTo) < 0.001) return;
    this.tierFrom = this.tierScale;
    this.tierTo = scale;
    this.tierAt = now;
  }

  /** Something happened to this figure. See `beats.ts`. */
  play(kind: BeatKind, now: number): void {
    if (this.phase === 'gone' || this.phase === 'leaving') return;
    this.beats.push(kind, now);
  }

  /**
   * Turn on the spot to look at something, which is most of a conversation.
   *
   * Only while standing: a figure mid-stride is already facing where it is
   * going, and overriding that makes it crab sideways across the office. The
   * *idle* sway in `animateIdle` eases toward `facing`, so setting it here is
   * enough — the turn comes out as a look rather than a snap.
   */
  faceTowards(point: Vec3): void {
    if (this.phase !== 'standing') return;
    const dx = point[0] - this.position[0];
    const dz = point[2] - this.position[2];
    if (Math.hypot(dx, dz) < 0.05) return;
    this.facing = Math.atan2(dx, dz);
  }

  /** Which platform this figure believes it is standing on. */
  /**
   * How far the floor under this figure is from where the layout put it.
   *
   * Exposed because a pose carries it folded into the position, and anything
   * that wants to take a *difference* of two heights has to be able to take it
   * back out again — see the contact shadows, which read
   * `pose.position[1] - position[1]` as "a beat has lifted them off the floor"
   * and got −24 for it the first time a room arrived.
   */
  get groundOffset(): number {
    return groundLift(this.platformId);
  }

  get platform(): string | null {
    return this.platformId;
  }

  /** How far along its current walk, 0–1. Diagnostic; 1 when standing still. */
  get progress(): number {
    return this.pathLength > 0 ? Math.min(1, this.travelled / this.pathLength) : 1;
  }

  /** The zone it has committed to, which is not always the one it wants yet. */
  get currentZone(): ZoneId | null {
    return this.zone;
  }

  /** What its session says it is doing, and where that would put it. */
  get doing(): Activity {
    return this.activity;
  }

  get wantedZone(): ZoneId | null {
    return this.desiredZone;
  }

  setActivity(activity: Activity, now: number, attention = false): void {
    const wasWaiting = this.attention > 0;
    this.activity = activity;
    this.attention = attention ? 1 : 0;
    const target = ACTIVITY_ZONE[activity].zone;
    this.desiredZone = target;

    /**
     * Attention preempts the tally: being wanted is urgent, and the pedestal
     * is the one place it always makes sense to drop everything for.
     *
     * Once, though. This used to re-commit every time it was called, and it is
     * called on every world patch — ten times a second while the window is
     * focused, driven by *any* session's traffic, not just this one's. Each
     * commit released and re-picked the slot, re-ran the route, and set
     * `travelled` back to zero, so a figure on its way to answer a question
     * restarted its walk ten times a second: it never got past the slow part
     * of its own ease-in, its phase flipped between walking and standing on
     * alternate frames so the breathing tempo strobed, and if it happened to
     * be on a staircase the rebuilt path put its first point at the floor
     * height of whichever platform it was nearest — which snapped it off the
     * stairs and onto the deck, over and over. That is the glitch.
     *
     * The commit is what the transition deserves, not the state.
     */
    const arriving = attention && !wasWaiting;
    const misplaced = attention && this.zone !== target;
    if (arriving || misplaced) {
      this.tally.clear();
      this.tally.set(target, WINDOW_SECONDS);
      this.commit(target, now);
    }
  }

  /**
   * Go and stand next to somebody, and stay there for a while.
   *
   * The office's figures are otherwise driven entirely by what their session is
   * doing, which is right and is also why two agents exchanging messages never
   * ended up in the same place: each was wherever its own work had sent it, and
   * the only sign that they had said anything to each other was an envelope
   * crossing the campus. This is the exception, and it is a narrow one — it is
   * only ever used for a pair the world says are talking, and it lapses on its
   * own.
   *
   * Attention still wins: `setActivity` commits straight to the pedestal when
   * somebody is wanted, and being wanted outranks a conversation.
   */
  meetAt(platformId: string, position: Vec3, now: number, forMs: number): void {
    this.heldUntil = now + forMs;
    // Standing up to go, and nobody sits down at a meeting point: the seat
    // belongs to a slot, and this is not one.
    this.seatedTarget = 0;
    const origin = this.resolver.platformAt(this.position) ?? this.platformId ?? platformId;
    this.path = this.resolver.route(origin, this.position, platformId, position);
    this.platformId = platformId;
    this.travelled = 0;
    this.pathLength = pathLength(this.path);
    this.stairPath = this.path.some((point, index) => index > 0 && Math.abs(point[1] - this.path![index - 1]![1]) > 0.05);
    if (this.phase === 'arriving' || this.pathLength < 0.05) {
      if (this.phase !== 'arriving') this.phase = 'standing';
      this.position = [...position];
      this.path = null;
      this.arrivedAt = now;
      return;
    }
    this.phase = 'walking';
  }

  /** Lets the tally have the figure back, now the conversation is over. */
  releaseHold(): void {
    this.heldUntil = 0;
  }

  /** True while it is standing somewhere its session did not send it. */
  get held(): boolean {
    return this.heldUntil > 0;
  }

  leave(now: number): void {
    if (this.phase === 'gone' || this.phase === 'leaving') return;
    this.phase = 'leaving';
    this.phaseStartedAt = now;
  }

  /** Cleared by the separation pass before it adds this frame's asks. */
  clearNudge(): void {
    this.nudgeWanted[0] = 0;
    this.nudgeWanted[1] = 0;
  }

  /** Half a body, at this figure's size: the models are not all the same. */
  get bodyRadius(): number {
    return CROWD_BODY * this.baseScale;
  }

  /** Where the body is being drawn this frame, which is what must not overlap. */
  get standsAt(): [number, number] {
    return [this.position[0] + this.nudgeWanted[0], this.position[2] + this.nudgeWanted[1]];
  }

  /** The way it is travelling, or null when it is not going anywhere. */
  get course(): [number, number] | null {
    if (this.phase !== 'walking') return null;
    return [Math.sin(this.heading), Math.cos(this.heading)];
  }

  /** Sitting down, and therefore not to be shoved out of its own chair. */
  get isSeated(): boolean {
    return this.seated > 0.5;
  }

  /** One neighbour's worth of "shove over", capped at `CROWD_GIVE`. */
  pushAside(x: number, z: number): void {
    const wx = this.nudgeWanted[0] + x;
    const wz = this.nudgeWanted[1] + z;
    const reach = Math.hypot(wx, wz);
    const cap = this.stairPath && this.phase === 'walking' ? CROWD_STAIR_GIVE : CROWD_GIVE;
    const keep = reach > cap ? cap / reach : 1;
    this.nudgeWanted[0] = wx * keep;
    this.nudgeWanted[1] = wz * keep;
  }


  update(dt: number, now: number): void {
    this.accumulate(now);
    this.lastNow = now;
    this.beatModifier = this.beats.evaluate(now);
    /*
     * Eased toward whatever the last separation pass asked for, so somebody
     * stepping aside leans out of the way rather than teleporting sideways —
     * unless what it is being asked for is a whole body more than it has, which
     * is not a lean at all.
     *
     * That only happens when something moved which was not walking: a figure
     * rehomed onto a rebuilt campus, or one that has just arrived. The office
     * rebuilds its floor plan every time a session appears or retires, and for
     * the fraction of a second afterwards two figures can be standing in the
     * same place through no fault of either of them — and gently leaning out of
     * a full overlap takes the better part of a second, which is long enough to
     * see. Over four minutes of a ten-session office, every single one of the
     * remaining overlaps was one of these: a pair whose *routed* positions were
     * a tenth of a unit apart, with the correction still on its way.
     */
    const want = Math.hypot(this.nudgeWanted[0], this.nudgeWanted[1]);
    const have = Math.hypot(this.nudge[0], this.nudge[1]);
    const ease = Math.min(1, dt * (want > have + CROWD_BODY ? CROWD_SNAP : CROWD_EASE));
    this.nudge[0] += (this.nudgeWanted[0] - this.nudge[0]) * ease;
    this.nudge[1] += (this.nudgeWanted[1] - this.nudge[1]) * ease;

    // You cannot sit down while walking. Standing up is the first thing that
    // happens when a figure sets off, and sitting only begins once it has
    // arrived — otherwise figures glide across the office still seated.
    const wanted = this.phase === 'standing' ? this.seatedTarget : 0;
    const step = (dt * 1000) / SIT_MS;
    this.seated = wanted > this.seated ? Math.min(wanted, this.seated + step) : Math.max(wanted, this.seated - step);

    // Picked up and put down over about the same time as sitting down, so the
    // two read as one piece of business rather than two separate events.
    const hold = (dt * 1000) / SIT_MS;
    this.holding =
      this.holdingTarget > this.holding
        ? Math.min(this.holdingTarget, this.holding + hold)
        : Math.max(this.holdingTarget, this.holding - hold);

    switch (this.phase) {
      case 'arriving': {
        const t = Math.min(1, (now - this.phaseStartedAt) / ARRIVE_MS);
        this.scale = this.baseScale * easeOutBack(t);
        if (t >= 1) {
          this.phase = 'standing';
          this.scale = this.baseScale;
        }
        break;
      }
      case 'leaving': {
        const t = Math.min(1, (now - this.phaseStartedAt) / LEAVE_MS);
        this.scale = this.baseScale * (1 - easeInCubic(t));
        if (t >= 1) this.phase = 'gone';
        return;
      }
      case 'walking':
        this.advance(dt, now);
        break;
      default:
        break;
    }

    if (this.phase !== 'walking' && this.phase !== 'gone') this.considerMove(now);
    this.animateIdle(dt);
  }

  /**
   * Credits the current activity's zone, and lets the rest fade.
   *
   * An exponential decay over ten seconds means a quick Read in the middle of a
   * long Bash run barely registers, while a real shift of work wins within a
   * couple of seconds.
   */
  private accumulate(now: number): void {
    const elapsed = Math.min(0.25, Math.max(0, (now - this.lastNow) / 1000));
    if (elapsed === 0) return;

    const decay = Math.exp(-elapsed / WINDOW_SECONDS);
    for (const [zone, value] of this.tally) {
      const faded = value * decay;
      // The floor has to sit well below one frame's worth of credit, or a zone
      // is pruned every tick and can never build up a lead.
      if (faded < 0.0005 && zone !== this.desiredZone) this.tally.delete(zone);
      else this.tally.set(zone, faded);
    }
    if (this.desiredZone) {
      const worth = this.activity === 'thinking' ? THINKING_WEIGHT : 1;
      this.tally.set(this.desiredZone, (this.tally.get(this.desiredZone) ?? 0) + elapsed * worth);
    }
  }

  /** Moves once a zone has clearly won the last ten seconds of work. */
  private considerMove(now: number): void {
    if (now < this.heldUntil) return;
    if (now - this.arrivedAt < MIN_DWELL_MS) return;

    let leader: ZoneId | null = null;
    let best = 0;
    for (const [zone, value] of this.tally) {
      if (value > best) {
        best = value;
        leader = zone;
      }
    }
    if (!leader || leader === this.zone) return;
    if (best - (this.zone ? (this.tally.get(this.zone) ?? 0) : 0) < LEAD_SECONDS) return;

    this.commit(leader, now);
  }

  /** Returns false when the zone has no platform, so callers can fall back. */
  private commit(zone: ZoneId, now: number): boolean {
    const target = this.resolver.platformFor(zone, this.id);
    if (!target) return false;

    const kind = ACTIVITY_ZONE[this.activity].slot;
    const slot = this.resolver.claimSlot(this.id, target.platformId, kind, this.position);
    this.zone = zone;
    this.seatedTarget = SEATED_SLOTS.has(kind) && slot.seat !== undefined ? 1 : 0;
    if (slot.seat !== undefined) this.seatHeight = slot.seat;

    // Route from where the figure *is*, not from where it was last sent. A
    // commit can land mid-walk — the floor plan changed, or the user is needed
    // — and trusting the remembered platform then draws a straight line from
    // the destination it never reached, across open air.
    const origin = this.resolver.platformAt(this.position) ?? this.platformId ?? target.platformId;
    /*
     * Always routed, even when the destination is on the platform underfoot.
     *
     * A move within one room used to be drawn as the straight line between the
     * two slots, on the reasoning that there is nothing to route around on a
     * floor you are already standing on. There is: the floor is where all the
     * furniture is. Crossing the library from the ladder to the reading stand
     * went through the shelves, and crossing the workshop went through the
     * copier — which is exactly the "walks through objects" this was. The nav
     * graph already spends the occupancy grid on this case (see `path`, which
     * short-circuits to `walk` when both ends share a platform), so asking it
     * costs one grid search and nothing else.
     */
    this.path = this.resolver.route(origin, this.position, target.platformId, slot.position);

    this.platformId = target.platformId;
    this.facing = slot.facing;
    this.travelled = 0;
    this.pathLength = pathLength(this.path);
    this.stairPath = this.path.some((point, index) => index > 0 && Math.abs(point[1] - this.path![index - 1]![1]) > 0.05);

    // A figure still materialising takes its place rather than setting off: the
    // walk would start before it was fully there.
    if (this.phase === 'arriving' || this.pathLength < 0.05) {
      if (this.phase !== 'arriving') this.phase = 'standing';
      this.position = [...slot.position];
      this.heading = slot.facing;
      this.path = null;
      this.arrivedAt = now;
      return true;
    }
    this.phase = 'walking';
    return true;
  }

  private advance(dt: number, now: number): void {
    if (!this.path) {
      this.phase = 'standing';
      return;
    }
    const speed = this.stairPath ? STAIR_SPEED : WALK_SPEED;
    // Ease out of the start and into the end so nobody snaps into motion.
    const eased = speed * easeEnds(this.travelled, this.pathLength);
    this.travelled = Math.min(this.pathLength, this.travelled + eased * dt);

    const { position, heading } = pointAlong(this.path, this.travelled);
    this.position = position;
    this.heading = approachAngle(this.heading, heading, dt * 6);

    if (this.travelled >= this.pathLength) {
      this.phase = 'standing';
      this.phaseStartedAt = now;
      this.arrivedAt = now;
      this.path = null;
      this.heading = this.facing;
    }
  }

  /**
   * Breathing, plus whatever the current activity looks like up close: typing
   * bobs quickly, thinking sways slowly, waiting barely moves at all.
   */
  private animateIdle(dt: number): void {
    const tempo =
      this.phase === 'walking'
        ? 7
        : this.activity === 'responding' || this.activity === 'editing'
          ? 3.4
          : this.activity === 'thinking' || this.activity === 'planning'
            ? 0.8
            : 1.2;
    this.bobPhase += dt * tempo;
    const breath =
      this.phase === 'walking'
        ? 0.02
        : this.activity === 'responding' || this.activity === 'editing'
          ? 0.022
          : this.activity === 'awaiting'
            ? 0.008
            : 0.012;
    const target = this.baseScale * (1 + Math.sin(this.bobPhase) * breath);
    this.scale += (target - this.scale) * Math.min(1, dt * 6);
    if (this.phase === 'standing') {
      // A thinking figure drifts a few degrees off its mark, which reads as
      // attention wandering rather than a statue facing a wall.
      const sway = this.activity === 'thinking' || this.activity === 'planning' ? Math.sin(this.bobPhase * 0.6) * 0.18 : 0;
      this.heading = approachAngle(this.heading, this.facing + sway, dt * 3);
    }
  }

  pose(): FigurePose {
    const beat = this.beatModifier;
    /*
     * Plus however far the floor under them has got.
     *
     * A room arrives by being drawn a long way down and rising into place (see
     * `Staging`), and the figures on it are a different mesh entirely — so
     * without this, three people stood in clear air over a platform that had
     * not turned up yet. Applying it here rather than in `Figures` is what
     * makes the shadow, the held cup, the halo and the hitbox all follow: they
     * every one of them read `pose.position`.
     */
    const ground = groundLift(this.platformId);
    const lift = beat.lift * this.scale + ground;
    // The body, which is the route's position plus however far this one has
    // had to step aside to keep out of somebody else. See `CROWD_GIVE`.
    return {
      position:
        lift === 0 && this.nudge[0] === 0 && this.nudge[1] === 0
          ? this.position
          : [this.position[0] + this.nudge[0], this.position[1] + lift, this.position[2] + this.nudge[1]],
      heading: this.heading + beat.spin,
      scale: this.scale,
      attention: this.attention,
      squash: beat.squash,
      tilt: beat.tilt,
      carry: Math.max(beat.carry, this.holding),
      flash: beat.flash,
      seated: this.seated,
      seatHeight: this.seatHeight,
    };
  }
}

/**
 * Where the ground is, relative to where the layout says it is.
 *
 * Module state for the same reason the tone basis is: the office writes it once
 * a frame for everybody, and threading it through every controller — and then
 * through five instanced batches that each read a pose — would be a parameter
 * carried through a dozen places so that one of them could use it.
 */
let groundLift: (platformId: string | null) => number = () => 0;

export function setGroundLift(resolve: (platformId: string | null) => number): void {
  groundLift = resolve;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutBack(t: number): number {
  const c = 1.70158;
  const p = t - 1;
  return 1 + (c + 1) * p * p * p + c * p * p;
}

function easeInCubic(t: number): number {
  return t * t * t;
}

/** Slows the first and last 0.4 units of a walk. */
function easeEnds(travelled: number, total: number): number {
  if (total <= 0.8) return 0.6;
  const ramp = 0.4;
  const into = Math.min(1, travelled / ramp);
  const outOf = Math.min(1, (total - travelled) / ramp);
  return 0.35 + 0.65 * Math.min(into, outOf);
}

function approachAngle(current: number, target: number, rate: number): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * Math.min(1, rate);
}

/**
 * Keeps bodies out of each other, once per frame, for everybody at once.
 *
 * Pairwise and O(n²), which at thirty agents and six caretakers is about six
 * hundred distance checks a frame — nothing beside the geometry it is drawn
 * with, and the alternative (a grid) is more code than the problem deserves at
 * this population.
 *
 * Two rules keep it from fighting the thing it is correcting. It only ever
 * moves the *pose*, never the route, so a figure still arrives exactly where
 * its slot is and the separation quietly relaxes to nothing once it gets
 * there. And it is capped per figure rather than summed, so somebody caught
 * between two others leans out by the same third of a unit as everyone else
 * instead of being squeezed off the terrace.
 *
 * Height matters: two figures on platforms two levels apart can share an xz
 * position and not overlap at all on screen, and pushing them apart there is
 * how you get somebody sidling along a rooftop for no visible reason.
 */
/**
 * Scratch for the relaxation passes, kept between frames.
 *
 * This runs on every figure every frame, so the two arrays it needs are grown
 * once and reused rather than allocated sixty times a second. Flat, because a
 * pair of numbers per figure is a pair of numbers, not an object.
 */
let standing = new Float64Array(0);
let wanted = new Float64Array(0);

export function separateFigures(figures: Iterable<FigureController>): void {
  const all: FigureController[] = [];
  for (const figure of figures) {
    if (figure.phase === 'gone') continue;
    figure.clearNudge();
    all.push(figure);
  }
  if (all.length < 2) return;

  /*
   * Worked out against where everybody stood at the start of each pass, and
   * applied at the end of it.
   *
   * Taken one pair at a time instead, the second push on a figure is measured
   * from a position the first push has already moved — so two neighbours shoving
   * somebody from opposite sides do not cancel, they take turns, and the answer
   * leans toward whichever of them happened to be considered last. The case that
   * breaks is a figure walking between two others standing closer together than
   * two bodies: it cannot be made to fit, and it does not have to, but it should
   * come out brushing past both of them rather than standing inside one. Measured
   * on the pair of them, that was the difference between a tenth of a body and
   * half of one.
   */
  if (standing.length < all.length * 2) {
    standing = new Float64Array(all.length * 2);
    wanted = new Float64Array(all.length * 2);
  }

  for (let pass = 0; pass < CROWD_PASSES; pass += 1) {
    for (let i = 0; i < all.length; i += 1) {
      const [sx, sz] = all[i]!.standsAt;
      standing[i * 2] = sx;
      standing[i * 2 + 1] = sz;
      wanted[i * 2] = 0;
      wanted[i * 2 + 1] = 0;
    }

    for (let i = 0; i < all.length; i += 1) {
      const a = all[i]!;
      for (let j = i + 1; j < all.length; j += 1) {
        const b = all[j]!;
        // Height first. Two people either side of a terrace edge are a storey
        // apart however close they look from above, and this is an isometric
        // camera, so they look very close indeed.
        if (Math.abs(a.position[1] - b.position[1]) > 1.1) continue;

        const bodies = a.bodyRadius + b.bodyRadius;
        const dx = standing[j * 2]! - standing[i * 2]!;
        const dz = standing[j * 2 + 1]! - standing[i * 2 + 1]!;
        const gap = Math.hypot(dx, dz);

        /*
         * How far apart they have to be before this cares, which depends on how
         * fast they are closing: a pair already drawing apart gets only the
         * reach of their own bodies, so they are let alone the moment they clear.
         */
        const rate = closingRate(a, b, dx, dz, gap);
        const reach = bodies + CROWD_FORESIGHT * Math.max(0, rate);
        if (gap >= reach) continue;

        /*
         * Who moves.
         *
         * A seated figure does not: it is in its own chair, and a passer-by
         * shoving somebody out of their seat looks far worse than the moment of
         * overlap it would have fixed. Nor does somebody standing still while
         * the other one is walking — the person going somewhere is the one who
         * goes around, which is both how it works and twice the clearance, since
         * a walker taking the whole step moves the full width of the nudge
         * instead of half of it. Whatever share is declined goes to the other
         * one; two walkers, or two figures both standing, split it.
         */
        const aFixed = a.isSeated;
        const bFixed = b.isSeated;
        if (aFixed && bFixed) continue;
        const aWalking = a.course !== null;
        const bWalking = b.course !== null;
        const aShare = aFixed ? 0 : bFixed ? 1 : aWalking === bWalking ? 0.5 : aWalking ? 1 : 0;
        const bShare = 1 - aShare;

        /*
         * How hard, which is two different questions.
         *
         * An overlap that already exists is answered in proportion to itself:
         * however far inside each other they are is how far they have to move.
         * One that is merely coming is answered on a schedule instead — nothing
         * at the edge of noticing, the whole step by the moment they would touch
         * — because the point of seeing it early is to have *finished* moving by
         * then, and a push proportional to a distance that is still large would
         * swing figures wide of each other from two units away.
         *
         * Whichever asks for more wins, so a pair that is both overlapping and
         * still closing gets the larger of the two rather than their sum.
         */
        const crowded = (bodies - gap) * CROWD_STIFF;
        const foreseen = reach > bodies ? CROWD_GIVE * Math.min(1, (reach - gap) / (reach - bodies)) : 0;
        const push = Math.max(crowded, foreseen);
        if (push <= 0) continue;

        const [px, pz] = partingAxis(a, b, dx, dz, gap);
        if (aShare > 0) {
          wanted[i * 2]! -= px * push * aShare;
          wanted[i * 2 + 1]! -= pz * push * aShare;
        }
        if (bShare > 0) {
          wanted[j * 2]! += px * push * bShare;
          wanted[j * 2 + 1]! += pz * push * bShare;
        }
      }
    }

    for (let i = 0; i < all.length; i += 1) {
      const wx = wanted[i * 2]!;
      const wz = wanted[i * 2 + 1]!;
      if (wx !== 0 || wz !== 0) all[i]!.pushAside(wx, wz);
    }
  }
}

/**
 * How fast this pair is closing, as a fraction of two figures walking head-on.
 *
 * Courses are unit vectors and everybody walks at about the same pace, so this
 * is just how much of each one's heading points at the other, differenced. One
 * for a head-on pair, a half for one walking at somebody standing still, zero
 * for a pair holding their distance — and **negative** for a pair already moving
 * apart, which is the case worth having a sign for: there is nothing to foresee
 * about two figures who are leaving.
 */
function closingRate(a: FigureController, b: FigureController, dx: number, dz: number, gap: number): number {
  if (gap < 0.0001) return 0; // already on top of each other; nothing to foresee
  const ux = dx / gap;
  const uz = dz / gap;
  const along = (figure: FigureController, x: number, z: number): number => {
    const course = figure.course;
    return course === null ? 0 : course[0] * x + course[1] * z;
  };
  return Math.max(-1, Math.min(1, (along(a, ux, uz) - along(b, ux, uz)) / 2));
}

/**
 * The one axis a pair can safely part along: across their *relative* course.
 *
 * This is the whole of the problem, and it took three wrong answers to find.
 * Split their separation into the part lying along the course they are closing
 * on and the part lying across it. The first reverses as they pass each other —
 * so anything steered by the direction away from the other figure, which is what
 * "step away from them" means, inverts halfway through the encounter, and asks an
 * offset that is eased in over a fifth of a second to swing to the opposite side
 * through zero at the exact moment the two of them are closest. Swept across
 * every angle two figures can meet at, that drew a perpendicular crossing three
 * hundredths of a body apart.
 *
 * The part *across* that course does not reverse. It does not change at all: its
 * rate of change is the relative velocity projected onto a direction square to
 * the relative velocity, which is zero. So it is the one thing in this geometry
 * that can be steered by without flipping, and pushing the pair apart along it
 * is exactly the classical miss distance — two figures aimed at the same point
 * come out missing it by two full steps, whatever angle they met at.
 *
 * Two cases fall outside it. A pair going the same way, or both standing, have
 * no relative course to be across; nothing of theirs is going to cross either,
 * so the line between them is stable and is the shortest way out. And a pair aimed
 * *dead* at each other have no side to prefer — the miss distance that would
 * choose one is zero give or take noise — so they settle it by a rule, which
 * both of them read the same way and neither changes its mind about.
 */
function partingAxis(
  a: FigureController,
  b: FigureController,
  dx: number,
  dz: number,
  gap: number,
): readonly [number, number] {
  const seeded = (): readonly [number, number] => {
    const turn = ((a.id.charCodeAt(0) + b.id.charCodeAt(0)) % 8) * (Math.PI / 4);
    return [Math.cos(turn), Math.sin(turn)];
  };

  const ca = a.course;
  const cb = b.course;
  const rvx = (ca?.[0] ?? 0) - (cb?.[0] ?? 0);
  const rvz = (ca?.[1] ?? 0) - (cb?.[1] ?? 0);
  const rv = Math.hypot(rvx, rvz);

  if (rv < CROWD_TOGETHER) {
    if (gap < 0.0001) return seeded();
    return [dx / gap, dz / gap];
  }

  const px = rvz / rv;
  const pz = -rvx / rv;
  const miss = px * dx + pz * dz;
  if (Math.abs(miss) < CROWD_DEADON) {
    // A rule, not a measurement: the same side every frame for this pair, and
    // the same one for both of them, which is all it has to be.
    return (a.id.charCodeAt(0) + b.id.charCodeAt(0)) % 2 === 0 ? [px, pz] : [-px, -pz];
  }
  return miss < 0 ? [-px, -pz] : [px, pz];
}
