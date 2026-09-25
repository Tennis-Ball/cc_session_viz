import { ACTIVITY_ZONE, type Activity, type SlotKind, type ZoneId } from '@shared/activity';
import type { AgentRole } from '@shared/model';
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
const WINDOW_SECONDS = 10;
/** Seconds of accumulated lead before it is worth crossing the office. */
const LEAD_SECONDS = 1.6;
/** Once it arrives somewhere it stays a while, whatever the tally says. */
const MIN_DWELL_MS = 5000;
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

export class FigureController {
  phase: FigurePhase = 'arriving';
  position: Vec3;
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
    readonly role: AgentRole,
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

  /** Which platform this figure believes it is standing on. */
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

  leave(now: number): void {
    if (this.phase === 'gone' || this.phase === 'leaving') return;
    this.phase = 'leaving';
    this.phaseStartedAt = now;
  }

  update(dt: number, now: number): void {
    this.accumulate(now);
    this.lastNow = now;
    this.beatModifier = this.beats.evaluate(now);

    // You cannot sit down while walking. Standing up is the first thing that
    // happens when a figure sets off, and sitting only begins once it has
    // arrived — otherwise figures glide across the office still seated.
    const wanted = this.phase === 'standing' ? this.seatedTarget : 0;
    const step = (dt * 1000) / SIT_MS;
    this.seated = wanted > this.seated ? Math.min(wanted, this.seated + step) : Math.max(wanted, this.seated - step);

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
      this.tally.set(this.desiredZone, (this.tally.get(this.desiredZone) ?? 0) + elapsed);
    }
  }

  /** Moves once a zone has clearly won the last ten seconds of work. */
  private considerMove(now: number): void {
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
    this.path =
      origin === target.platformId
        ? [this.position, slot.position] // same platform, different seat
        : this.resolver.route(origin, this.position, target.platformId, slot.position);

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
    return {
      position:
        beat.lift === 0
          ? this.position
          : [this.position[0], this.position[1] + beat.lift * this.scale, this.position[2]],
      heading: this.heading + beat.spin,
      scale: this.scale,
      attention: this.attention,
      squash: beat.squash,
      tilt: beat.tilt,
      carry: beat.carry,
      flash: beat.flash,
      seated: this.seated,
      seatHeight: this.seatHeight,
    };
  }
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
