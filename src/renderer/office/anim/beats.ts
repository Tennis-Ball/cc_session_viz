/**
 * Transient choreography.
 *
 * Where a figure stands says what it is doing; a beat says what just *happened*
 * to it. Beats are short, never block walking, and always resolve — a dropped
 * event costs an animation and nothing else, which is the whole reason state
 * and events are kept separate.
 */

export type BeatKind =
  | 'carry' // taking the context stack to the Archive
  | 'toss' // sending a message
  | 'receive' // one arriving
  | 'greet' // a subagent materialising beside its parent
  | 'debrief' // a subagent reporting back before it dissolves
  | 'stretch' // the turn ended
  | 'squash' // interrupted mid-stride
  | 'turnBack' // a tool call was denied
  | 'startle' // an API error or rate limit
  | 'lookUp' // a watch fired
  | 'nod'; // a smaller acknowledgement: a skill, an edit, a publish

interface BeatSpec {
  /** Higher wins when two things happen at once. */
  priority: number;
  durationMs: number;
}

const SPECS: Record<BeatKind, BeatSpec> = {
  squash: { priority: 9, durationMs: 520 },
  startle: { priority: 8, durationMs: 700 },
  turnBack: { priority: 8, durationMs: 900 },
  toss: { priority: 6, durationMs: 1200 },
  receive: { priority: 6, durationMs: 900 },
  carry: { priority: 5, durationMs: 2500 },
  greet: { priority: 4, durationMs: 1100 },
  debrief: { priority: 4, durationMs: 1200 },
  stretch: { priority: 3, durationMs: 1400 },
  lookUp: { priority: 3, durationMs: 1000 },
  nod: { priority: 2, durationMs: 700 },
};

/** What a beat does to a pose. Neutral values leave the figure alone. */
export interface BeatModifier {
  /** World units added to y. */
  lift: number;
  /** Vertical scale; below 1 squashes and widens, above 1 stretches. */
  squash: number;
  /** Radians of lean, around the axis across the figure's shoulders. */
  tilt: number;
  /** Extra heading, on top of where the figure is facing. */
  spin: number;
  /** 0–1: how present the carried slab is. */
  carry: number;
  /** 0–1: a highlight flash, used for errors. */
  flash: number;
}

export const NEUTRAL: BeatModifier = { lift: 0, squash: 1, tilt: 0, spin: 0, carry: 0, flash: 0 };

interface ActiveBeat {
  kind: BeatKind;
  startedAt: number;
  durationMs: number;
  priority: number;
}

/**
 * One beat at a time per figure, with a tiny queue behind it.
 *
 * Layering two beats would read as a twitch rather than a gesture, so a beat
 * either preempts (louder than what is playing) or waits its turn, and anything
 * that has waited too long is dropped instead of playing late.
 */
export class BeatQueue {
  private active: ActiveBeat | null = null;
  private pending: ActiveBeat[] = [];

  push(kind: BeatKind, now: number): void {
    const spec = SPECS[kind];
    const beat: ActiveBeat = { kind, startedAt: now, durationMs: spec.durationMs, priority: spec.priority };

    if (!this.active) {
      this.active = beat;
      return;
    }
    if (spec.priority > this.active.priority) {
      this.active = beat;
      this.pending.length = 0;
      return;
    }
    // Repeats of what is already playing just extend nothing: one nod is a nod.
    if (this.active.kind === kind) return;
    if (this.pending.length < 2) this.pending.push(beat);
  }

  get current(): BeatKind | null {
    return this.active?.kind ?? null;
  }

  clear(): void {
    this.active = null;
    this.pending.length = 0;
  }

  evaluate(now: number): BeatModifier {
    if (!this.active) return NEUTRAL;

    const t = (now - this.active.startedAt) / this.active.durationMs;
    if (t >= 1) {
      const next = this.pending.shift() ?? null;
      this.active = next;
      if (next) next.startedAt = now;
      return this.active ? this.evaluate(now) : NEUTRAL;
    }
    // A beat that waited more than its own length behind another is stale news.
    return modifierFor(this.active.kind, Math.max(0, t));
  }
}

/** One arch: 0 at both ends, 1 in the middle. Beats start and end at rest. */
function arch(t: number): number {
  return Math.sin(Math.PI * t);
}

/** A quick impulse that decays, for anything that reads as a jolt. */
function jolt(t: number): number {
  return Math.sin(Math.PI * t * 1.6) * Math.exp(-3.2 * t);
}

export function modifierFor(kind: BeatKind, t: number): BeatModifier {
  switch (kind) {
    case 'carry': {
      // Leaning into a load, and moving a little heavier for it. The lean comes
      // and goes with the load: letting it end mid-lean snaps the figure
      // upright the instant the stack is filed.
      const held = Math.min(1, t * 6, (1 - t) * 6);
      return { ...NEUTRAL, carry: Math.min(1, arch(t) * 2.2), tilt: 0.07 * held };
    }
    case 'toss':
      // A wind-up, then the throw: the lean goes forward and comes back.
      return { ...NEUTRAL, tilt: -0.1 * arch(Math.min(1, t * 2)) + 0.26 * arch(Math.max(0, t * 2 - 1)), spin: 0.12 * arch(t) };
    case 'receive':
      return { ...NEUTRAL, lift: 0.07 * arch(t), tilt: -0.14 * arch(t) };
    case 'greet':
      return { ...NEUTRAL, tilt: 0.2 * arch(t), spin: 0.5 * (1 - t) * arch(t) };
    case 'debrief':
      // Two short nods, then still: a handover rather than a wave.
      return { ...NEUTRAL, tilt: 0.16 * Math.sin(Math.PI * 2 * t) * (1 - t) };
    case 'stretch':
      return { ...NEUTRAL, lift: 0.1 * arch(t), squash: 1 + 0.09 * arch(t) };
    case 'squash':
      return { ...NEUTRAL, squash: 1 - 0.17 * arch(t), lift: -0.02 * arch(t) };
    case 'turnBack':
      // Turns away from what it was told not to do, then back.
      return { ...NEUTRAL, spin: 0.95 * arch(t), tilt: -0.08 * arch(t) };
    case 'startle':
      return { ...NEUTRAL, lift: 0.13 * Math.abs(jolt(t)), squash: 1 - 0.08 * jolt(t), flash: 1 - t };
    case 'lookUp':
      return { ...NEUTRAL, tilt: -0.26 * arch(t), lift: 0.03 * arch(t) };
    case 'nod':
      return { ...NEUTRAL, tilt: 0.13 * Math.sin(Math.PI * 2 * t) * (1 - t * 0.5) };
    default:
      return NEUTRAL;
  }
}

export const BEAT_DURATIONS = SPECS;
