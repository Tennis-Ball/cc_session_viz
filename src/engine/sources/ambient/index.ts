import type { VisualEvent } from '../../../shared/events';
import { hash32 } from '../../../shared/format';
import type { Endpoint, Ms } from '../../../shared/model';
import { SESSION_PALETTE } from '../../../shared/palette';
import type { LiveSlot } from '../../discovery/registry';
import type { Signal } from '../../parse/signals';
import { systemClock, type Clock } from '../../ports/clock';
import type { EntryLog } from '../../state/entryLog';
import { SessionRuntime } from '../../state/sessionRuntime';
import type { WorldStore } from '../../state/worldStore';
import { deriveCharacter, span } from './character';
import { pickFrom, REPOS, type Repo } from './corpus';
import {
  AUTO_COMPACT_PCT,
  newDecks,
  newStoryState,
  opening,
  story,
  type Beat,
  type Opening,
  type StoryContext,
} from './story';
import { rng, type DataSource } from '../types';

/**
 * Simulation mode: an office that contains nobody's work.
 *
 * Emulated sessions are pushed through the *real* reducers as signals, so
 * anything the live pipeline can show — a fan-out, a compaction, a plan waiting
 * for approval — the simulation shows too, with the same visuals. Every
 * synthetic entity is flagged `ambient`, nothing here reads `~/.claude`, and
 * nothing is ever written anywhere.
 *
 * The whole world is a pure function of `seed` and the clock. A fresh seed is
 * drawn at construction so two launches are not the same afternoon, and it is
 * logged in a form that brings that afternoon back: `CCV_SIM_SEED=<n>`.
 */

const TICK_MS = 250;
/** The cast drifts inside this band rather than sitting at a constant. */
const DEFAULT_POPULATION: readonly [number, number] = [2, 6];

/**
 * How many desks the simulation is allowed to fill.
 *
 * `CCV_SIM_SESSIONS=30` pins it, which is the only way to see a crowded office
 * at all: the simulation is the only source anyone can run on demand, and it
 * held between two and six sessions, so the layout, the label spacing, the
 * desk spiral and the frame rate at thirty had never actually been looked at —
 * they were designed for and then asserted about in the abstract. A number
 * here is not a feature, it is the harness for a state the app claims to
 * support.
 */
const POPULATION: readonly [number, number] = (() => {
  const pinned = Number.parseInt(process.env['CCV_SIM_SESSIONS'] ?? '', 10);
  if (!Number.isFinite(pinned) || pinned <= 0) return DEFAULT_POPULATION;
  const capped = Math.min(60, pinned);
  return [capped, capped];
})();
/** How long a population target holds before it drifts again. */
const DRIFT_MS: readonly [number, number] = [60_000, 180_000];
/** Arrivals are spaced out, so nobody watches four desks appear at once. */
const ARRIVAL_MS: readonly [number, number] = [10_000, 45_000];
/** How long a terminal that has just walked in had already been open. */
const FRESH_MS: readonly [number, number] = [20_000, 4 * 60_000];
/** How long the process had been up before a warm session's run-up starts. */
const BACKSTORY_MS: readonly [number, number] = [4 * 60_000, 70 * 60_000];
/** Simulated step while a warm session's run-up is fast-forwarded. */
const WARM_STEP_MS = 500;
/** The earliest a warm session's next beat may land after the office opens. */
const WARM_HOLD_MS: readonly [number, number] = [2000, 18_000];
/** How long a warm session has already been sitting in its opening pose. */
const DWELL_MS: Record<Opening, readonly [number, number]> = {
  midTurn: [3000, 25_000],
  justFinished: [10_000, 45_000],
  fannedOut: [8000, 40_000],
  deepContext: [3000, 20_000],
  workflow: [20_000, 120_000],
  awaitingPlan: [25_000, 90_000],
  awaitingQuestion: [20_000, 80_000],
  watching: [15_000, 90_000],
};
/** The openings that fill out the cast once the two required ones are placed. */
const FILLER: readonly Opening[] = [
  'midTurn',
  'midTurn',
  'midTurn',
  'justFinished',
  'justFinished',
  'watching',
  'awaitingQuestion',
  'awaitingPlan',
  'workflow',
];

/** How long synthetic sessions take to pack up once real work appears. */
export const AMBIENT_RETIRE_MS = 20_000;

const FIRST_PID = 60_000;

interface AmbientSession {
  runtime: SessionRuntime;
  slot: LiveSlot;
  beats: Generator<Beat>;
  colorIndex: number;
  nextBeatAt: Ms;
  retiresAt: Ms;
  leaving: boolean;
}

export class AmbientSource implements DataSource {
  readonly kind = 'sim';

  /** Logged at startup; `CCV_SIM_SEED=<n>` plays this same office back. */
  readonly seed: number;

  private readonly sessions = new Map<string, AmbientSession>();
  /**
   * Population-level decisions only. Each session's own stream is derived from
   * its index rather than drawn from here, so a session's character does not
   * depend on how the ticks happened to land around its arrival.
   */
  private readonly cast: () => number;
  private timer: NodeJS.Timeout | null = null;
  private spawned = 0;
  private target = 0;
  private nextDriftAt = 0;
  private nextArrivalAt = 0;
  private active = false;
  /** Holds back visual events while a warm session's history is replayed. */
  private warming = false;

  constructor(
    private readonly store: WorldStore,
    private readonly clock: Clock = systemClock,
    seed = chooseSeed(),
  ) {
    this.seed = seed >>> 0;
    this.cast = rng(this.seed);
  }

  start(): void {
    // One line, copyable: this is the only way back to a world you liked.
    console.log(`[simulation] seed ${this.seed}`);
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clear();
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Turning it off lets the current cast walk out rather than vanish. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.store.patchHealth({ ambientActive: active });
    // The store only keeps what belongs to the world being shown, so say which
    // world that is from here as well as from the engine's mode switch. A
    // source that publishes without claiming the store is a source whose
    // sessions are silently dropped — which is the correct behaviour and a
    // baffling way to find out about it.
    if (active) this.store.setMode('simulation');
    const now = this.clock.now();

    if (!active) {
      for (const session of this.sessions.values()) {
        session.leaving = true;
        session.retiresAt = Math.min(session.retiresAt, now + AMBIENT_RETIRE_MS);
      }
      return;
    }

    // Anyone who had started packing up unpacks again.
    for (const session of this.sessions.values()) {
      session.leaving = false;
      session.retiresAt = Math.max(session.retiresAt, now + 3 * 60_000);
    }
    if (this.sessions.size === 0) this.warmStart(now);
    this.target = Math.max(this.target, this.sessions.size);
    this.nextDriftAt = now + span(DRIFT_MS, this.cast);
    this.nextArrivalAt = now + span(ARRIVAL_MS, this.cast);
  }

  logFor(cardId: string): EntryLog | undefined {
    for (const session of this.sessions.values()) {
      const log = session.runtime.log(cardId);
      if (log) return log;
    }
    return undefined;
  }

  private tick(): void {
    const now = this.clock.now();

    if (this.active) this.population(now);

    for (const [slotId, session] of this.sessions) {
      if (now >= session.retiresAt) {
        this.retire(slotId);
        continue;
      }
      this.advance(session, now);
      session.runtime.tick(now, true);
      this.publish(session, now);
    }
  }

  /** An office breathes: people arrive, people leave, the room is never level. */
  private population(now: Ms): void {
    // Pull the target into the band before anything else. It is set from the
    // warm start and then only ever nudged by one every minute or two, so a
    // band that moves — which is what `CCV_SIM_SESSIONS` does — would otherwise
    // take the better part of an hour to be obeyed, or never be reached at all.
    this.target = Math.min(POPULATION[1], Math.max(POPULATION[0], this.target));

    if (now >= this.nextDriftAt) {
      const step = this.cast() < 0.5 ? -1 : 1;
      this.target = Math.min(POPULATION[1], Math.max(POPULATION[0], this.target + step));
      this.nextDriftAt = now + span(DRIFT_MS, this.cast);
    }

    if (this.sessions.size < this.target && now >= this.nextArrivalAt) {
      this.spawnSession(now);
      // A pinned cast arrives briskly: waiting three quarters of an hour for
      // the thirtieth desk defeats the point of asking for thirty.
      const pinned = POPULATION[0] === POPULATION[1];
      this.nextArrivalAt = now + (pinned ? 250 : span(ARRIVAL_MS, this.cast));
    }

    if (this.sessions.size > this.target) {
      // The desk that has been here longest packs up, rather than a random one
      // vanishing mid-sentence.
      let oldest: AmbientSession | undefined;
      for (const session of this.sessions.values()) {
        if (!oldest || session.slot.startedAt < oldest.slot.startedAt) oldest = session;
      }
      if (oldest) oldest.retiresAt = Math.min(oldest.retiresAt, now + AMBIENT_RETIRE_MS);
    }
  }

  /** Plays out the story a beat at a time, on the wall clock. */
  private advance(session: AmbientSession, now: Ms): void {
    if (session.leaving) return;
    let guard = 0;
    while (now >= session.nextBeatAt && guard++ < 8) {
      const next = session.beats.next();
      if (next.done) return; // `story` never ends, but a generator can be closed
      this.apply(session, next.value, now, false);
    }
  }

  private apply(session: AmbientSession, beat: Beat, at: Ms, backfill: boolean): void {
    for (const signal of beat.signals) {
      session.runtime.applySignal({ ...signal, at } as Signal, beat.agent, backfill);
    }
    // The registry file is what the liveness machine reads for "busy". Claude
    // Code writes it when a turn opens and again when it closes; the quiet
    // stretch in between must not flip it back, or nothing is ever idle.
    if (!beat.agent) {
      if (beat.signals.some((s) => s.s === 'prompt')) session.slot.status = 'busy';
      if (beat.signals.some((s) => s.s === 'turnEnd')) session.slot.status = 'idle';
    }
    session.nextBeatAt = at + beat.after;
  }

  // -------------------------------------------------------------------------
  // Warm start
  // -------------------------------------------------------------------------

  /**
   * The office opens mid-morning, not at dawn.
   *
   * An empty room that ramps up is a room you have to wait for, so the first
   * frame already has turns in flight, a fan-out running, a context bar worth
   * reading and — often enough — somebody waiting on you.
   */
  private warmStart(now: Ms): void {
    for (const kind of this.castPlan()) this.spawnSession(now, kind);
  }

  /**
   * A fan-out and a full context window are always there, because those are the
   * two things worth looking at first; everything else is drawn, so the plan
   * awaiting approval and the workflow are occasional rather than guaranteed.
   */
  private castPlan(): Opening[] {
    const plan: Opening[] = ['fannedOut', 'deepContext'];
    const size = 3 + Math.floor(this.cast() * 3);
    while (plan.length < size) plan.push(pickFrom(FILLER, this.cast));
    return plan;
  }

  private spawnSession(now: Ms, kind?: Opening): void {
    const index = this.spawned++;
    const random = rng(hash32(`${this.seed}:session:${index}`));
    const character = deriveCharacter(random);
    const repo = pickFrom(REPOS, random);
    const pid = FIRST_PID + index;

    const state = newStoryState(character);
    if (kind === 'deepContext') {
      // Past the auto-compact line, so the bar reads as full and the archive
      // gets a visit within a turn or two.
      state.contextUsed = Math.round(character.window * (AUTO_COMPACT_PCT / 100 - 0.04 + random() * 0.14));
    }

    const ctx: StoryContext = {
      random,
      character,
      repo,
      tag: pid.toString(36),
      decks: newDecks(random),
      state,
      peers: () => this.peerNames(pid),
    };
    const beats = kind ? chain(opening(ctx, kind), story(ctx)) : story(ctx);

    // The run-up is collected before anything exists, because its length is
    // what decides how far back this session started.
    const runUp = kind ? collect(beats) : [];
    const offsets: number[] = [];
    let cursor = 0;
    for (const beat of runUp) {
      offsets.push(cursor);
      cursor += beat.after;
    }
    const poseAt = Math.round(now - (kind ? span(DWELL_MS[kind], random) : 0));
    const firstAt = poseAt - (offsets[offsets.length - 1] ?? 0);
    const startedAt = Math.round(firstAt - span(kind ? BACKSTORY_MS : FRESH_MS, random));

    const slot = makeSlot(pid, startedAt, repo, random);
    const colorIndex = this.freeColor();
    const runtime = new SessionRuntime(slot, {
      emit: (event: VisualEvent) => {
        if (!this.warming) this.store.emit(event);
      },
      noteUnknown: () => {},
      resolveTarget: (to, from): Endpoint => this.resolvePeer(to, from),
      colorIndex,
      ambient: true,
      autoCompactPct: AUTO_COMPACT_PCT,
    });

    const session: AmbientSession = {
      runtime,
      slot,
      beats,
      colorIndex,
      nextBeatAt: firstAt,
      retiresAt: now + character.lifetimeMs,
      leaving: false,
    };
    this.sessions.set(slot.slotId, session);

    runtime.applySignal(
      { at: startedAt, s: 'envelope', cwd: slot.cwd, gitBranch: repo.branch, version: slot.version },
      undefined,
      true,
    );
    runtime.applySignal({ at: startedAt, s: 'modelAttachment', modelId: character.model }, undefined, true);
    runtime.applySignal({ at: startedAt, s: 'permissionMode', mode: 'auto' }, undefined, true);

    if (kind) this.replay(session, runUp, offsets, firstAt, poseAt, now, random);

    this.store.emit({ at: now, t: 'sessionAppeared', slot: slot.slotId });
    this.publish(session, now);
  }

  /**
   * The live tick loop, fast-forwarded on a backdated clock.
   *
   * Nothing here builds a view object: the same beats go through the same
   * reducers, only sooner. Signals are marked as backfill and events are held
   * back, so the office does not replay half an hour of animation the moment it
   * opens.
   */
  private replay(
    session: AmbientSession,
    runUp: readonly Beat[],
    offsets: readonly number[],
    firstAt: Ms,
    poseAt: Ms,
    now: Ms,
    random: () => number,
  ): void {
    this.warming = true;
    try {
      let step = firstAt;
      for (let i = 0; i < runUp.length; i++) {
        const at = firstAt + offsets[i]!;
        // Tick through the gap first: the liveness machine needs several looks
        // to settle on idle, exactly as it would have live.
        for (; step < at; step += WARM_STEP_MS) session.runtime.tick(step, true);
        step = at;
        this.apply(session, runUp[i]!, at, true);
      }
      for (; step < now; step += WARM_STEP_MS) session.runtime.tick(step, true);
      session.runtime.tick(now, true);
    } finally {
      this.warming = false;
    }

    // The pose holds for a moment after the office opens: nothing resolves the
    // instant you look at it, and the cast does not all move at once.
    const last = runUp[runUp.length - 1];
    session.nextBeatAt = Math.round(Math.max(poseAt + (last?.after ?? 0), now + span(WARM_HOLD_MS, random)));
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  private retire(slotId: string): void {
    const session = this.sessions.get(slotId);
    if (!session) return;
    for (const agent of session.runtime.agents.values()) this.store.removeAgent(agent.id);
    for (const watch of session.runtime.watches.values()) this.store.removeWatch(watch.id);
    for (const run of session.runtime.workflows.values()) this.store.removeWorkflow(run.runId);
    this.store.removeSession(slotId);
    this.sessions.delete(slotId);
    this.store.emit({ at: this.clock.now(), t: 'sessionEnded', slot: slotId });
  }

  private clear(): void {
    for (const slotId of [...this.sessions.keys()]) this.retire(slotId);
  }

  private publish(session: AmbientSession, now: Ms): void {
    this.store.upsertSession(session.runtime.toView(now));
    for (const agent of session.runtime.agentViews(now)) this.store.upsertAgent(agent);
    for (const id of session.runtime.prunedAgentIds(now)) this.store.removeAgent(id);
    for (const watch of session.runtime.watches.values()) this.store.upsertWatch(watch);
    for (const run of session.runtime.workflows.values()) this.store.upsertWorkflow(run);
  }

  private peerNames(exceptPid: number): string[] {
    const names: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.slot.pid === exceptPid || !session.slot.name) continue;
      names.push(session.slot.name);
    }
    return names;
  }

  /**
   * Who a `SendMessage` was addressed to, the same three ways the live source
   * reads it.
   *
   * This used to look at session names only, so the two kinds of message that
   * happen *inside* a session — an agent briefing one of its subagents, and a
   * subagent reporting back — both resolved to an external label. Nothing could
   * be drawn between two figures that were standing next to each other, which
   * is exactly the pair worth drawing something between.
   */
  private resolvePeer(to: string, fromSlot: string): Endpoint {
    if (!to) return { kind: 'external', label: 'unknown' };
    if (to === 'main') {
      const session = this.sessions.get(fromSlot);
      return session ? { kind: 'agent', agentId: session.runtime.main.id } : { kind: 'external', label: 'main' };
    }
    if (/^a[0-9a-f]{16}$/.test(to)) return { kind: 'agent', agentId: to };
    for (const session of this.sessions.values()) {
      if (session.slot.name === to) return { kind: 'session', slotId: session.slot.slotId };
    }
    return { kind: 'external', label: to };
  }

  private freeColor(): number {
    const used = new Set<number>();
    for (const session of this.sessions.values()) used.add(session.colorIndex);
    for (let i = 0; i < SESSION_PALETTE.length; i++) {
      const index = (i * 5) % SESSION_PALETTE.length;
      if (!used.has(index)) return index;
    }
    return 0;
  }
}

/**
 * A fresh world per launch, unless one is asked for by name.
 *
 * This is the only entropy the simulation ever draws, and it is drawn exactly
 * once. Everything downstream comes from the seeded generator, which is what
 * makes the line in the log enough to bring an office back.
 */
function chooseSeed(): number {
  const pinned = Number.parseInt(process.env['CCV_SIM_SEED'] ?? '', 10);
  if (Number.isFinite(pinned)) return pinned >>> 0;
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

/** The run-up, up to and including the beat that holds the opening pose. */
function collect(beats: Generator<Beat>): Beat[] {
  const out: Beat[] = [];
  for (let guard = 0; guard < 200; guard++) {
    const next = beats.next();
    if (next.done) break;
    out.push(next.value);
    if (next.value.pose) break;
  }
  return out;
}

function* chain(first: Generator<Beat>, second: Generator<Beat>): Generator<Beat> {
  yield* first;
  yield* second;
}

function makeSlot(pid: number, startedAt: Ms, repo: Repo, random: () => number): LiveSlot {
  return {
    slotId: `${pid}@${startedAt}`,
    pid,
    sessionId: `sim-${pid.toString(36)}`,
    cwd: `/code/${repo.name}`,
    startedAt,
    procStart: 'simulated',
    version: '2.1.277',
    kind: 'interactive',
    entrypoint: 'cli',
    name: `${repo.name}-${Math.floor(random() * 90 + 10)}`,
    nameSource: 'derived',
    status: 'busy',
    alive: true,
  };
}
