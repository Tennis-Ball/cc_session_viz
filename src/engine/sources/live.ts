import { homedir } from 'node:os';
import { join } from 'node:path';
import type { VisualEvent } from '../../shared/events';
import type { Endpoint, WorkflowRun } from '../../shared/model';
import { SESSION_PALETTE } from '../../shared/palette';
import { Locator } from '../discovery/locator';
import { Registry, type LiveSlot } from '../discovery/registry';
import { TailReader } from '../io/tailReader';
import { normalizeLine } from '../parse/normalize';
import { systemClock, type Clock } from '../ports/clock';
import { NodeFsPort, type FsPort } from '../ports/fs';
import { NodeProcPort, type ProcPort } from '../ports/proc';
import type { EntryLog } from '../state/entryLog';
import { SessionRuntime } from '../state/sessionRuntime';
import type { WorldStore } from '../state/worldStore';
import type { DataSource } from './types';

const REGISTRY_INTERVAL_MS = 2000;
const TICK_INTERVAL_MS = 1000;
const SAFETY_POLL_MS = 3000;
const WATCH_DEBOUNCE_MS = 60;
/** Only files touched recently are worth cold-loading at startup. */
const COLD_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAIN_TAIL_BYTES = 16 * 1024 * 1024;
const AGENT_TAIL_BYTES = 2 * 1024 * 1024;
/** Sessions keep their desk for a while after exiting, so restarts reuse it. */
const ENDED_GRACE_MS = 10 * 60 * 1000;

export interface LiveSourceOptions {
  claudeDir?: string;
  fs?: FsPort;
  proc?: ProcPort;
  clock?: Clock;
}

interface Tracked {
  runtime: SessionRuntime;
  transcriptPath: string | null;
  main: TailReader | null;
  agents: Map<string, TailReader>;
  workflowMtimes: Map<string, number>;
  endedAt: number | null;
}

/**
 * Reads the real ~/.claude tree: the live registry decides which sessions exist,
 * and their transcripts (plus subagent sidecars and workflow summaries) fill in
 * what each one is doing.
 */
export class LiveSource implements DataSource {
  readonly kind = 'live';

  private readonly fs: FsPort;
  private readonly proc: ProcPort;
  private readonly clock: Clock;
  private readonly claudeDir: string;
  private readonly registry: Registry;
  private readonly locator: Locator;

  private readonly tracked = new Map<string, Tracked>();
  private readonly dirty = new Set<string>();
  private readonly usedColors = new Set<number>();
  private readonly timers: NodeJS.Timeout[] = [];
  private unwatch: (() => void) | null = null;
  private pendingPaths = new Set<string>();
  private debounce: NodeJS.Timeout | null = null;
  private unknownSignals = 0;
  private autoCompactPct = 80;

  constructor(
    private readonly store: WorldStore,
    options: LiveSourceOptions = {},
  ) {
    this.fs = options.fs ?? new NodeFsPort();
    this.proc = options.proc ?? new NodeProcPort();
    this.clock = options.clock ?? systemClock;
    this.claudeDir = options.claudeDir ?? join(homedir(), '.claude');
    this.registry = new Registry(this.fs, this.proc, this.clock, join(this.claudeDir, 'sessions'));
    this.locator = new Locator(this.fs, join(this.claudeDir, 'projects'));
  }

  async start(): Promise<void> {
    this.store.patchHealth({ source: 'live' });
    // See `AmbientSource.setActive`: the store keeps only what belongs to the
    // world on screen, and this is the source claiming it.
    this.store.setMode('real');
    await this.readSettings();
    await this.locator.reindex();
    await this.syncRegistry();

    this.unwatch = this.fs.watch(join(this.claudeDir, 'projects'), (relative) => {
      this.pendingPaths.add(relative);
      if (this.debounce) return;
      this.debounce = setTimeout(() => {
        this.debounce = null;
        this.pendingPaths.clear();
        void this.pump();
      }, WATCH_DEBOUNCE_MS);
    });

    this.timers.push(setInterval(() => void this.syncRegistry(), REGISTRY_INTERVAL_MS));
    this.timers.push(setInterval(() => void this.pump(), SAFETY_POLL_MS));
    this.timers.push(setInterval(() => this.tick(), TICK_INTERVAL_MS));
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    if (this.debounce) clearTimeout(this.debounce);
    this.unwatch?.();
    this.unwatch = null;
  }

  /**
   * Stops and forgets everything it has read.
   *
   * Switching to the simulation has to leave no trace of the real sessions —
   * not on screen, and not in memory waiting to reappear. A later `start()`
   * then rediscovers the world from scratch, which is also what makes the
   * switch back correct rather than stale.
   */
  reset(): void {
    this.stop();
    for (const slotId of this.tracked.keys()) {
      this.store.removeSession(slotId);
    }
    for (const agent of Object.values(this.store.snapshot().agents)) {
      if (this.tracked.has(agent.slotId)) this.store.removeAgent(agent.id);
    }
    for (const watch of Object.values(this.store.snapshot().watches)) {
      if (this.tracked.has(watch.slotId)) this.store.removeWatch(watch.id);
    }
    this.tracked.clear();
    this.dirty.clear();
    this.usedColors.clear();
    this.pendingPaths.clear();
  }

  /** `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` decides where the context bar's tick sits. */
  private async readSettings(): Promise<void> {
    const text = await this.fs.readText(join(this.claudeDir, 'settings.json'));
    if (!text) return;
    try {
      const settings = JSON.parse(text) as { env?: Record<string, string> };
      const override = Number(settings.env?.['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE']);
      if (Number.isFinite(override) && override > 0) this.autoCompactPct = override;
    } catch {
      // Malformed settings are the user's business, not ours.
    }
  }

  private async syncRegistry(): Promise<void> {
    const slots = await this.registry.scan();
    const now = this.clock.now();
    const seen = new Set<string>();

    for (const slot of slots) {
      // Programmatic runs (SDK/eval) are noise in a visualizer of your desk.
      if (slot.entrypoint === 'sdk-cli' || (slot.kind && slot.kind !== 'interactive')) continue;
      seen.add(slot.slotId);

      const existing = this.tracked.get(slot.slotId);
      if (existing) {
        const sessionChanged = existing.runtime.sessionId !== slot.sessionId;
        existing.runtime.updateRegistry(slot, now);
        if (slot.alive) existing.endedAt = null;
        if (sessionChanged) await this.attachTranscript(existing, slot.sessionId, { fresh: true });
        this.dirty.add(slot.slotId);
        continue;
      }
      if (!slot.alive) continue;
      await this.addSlot(slot, now);
    }

    // Keep ended sessions around briefly; a quick restart should reuse the desk.
    for (const [slotId, tracked] of this.tracked) {
      if (seen.has(slotId)) continue;
      if (tracked.endedAt === null) tracked.endedAt = now;
      if (now - tracked.endedAt > ENDED_GRACE_MS) this.removeSlot(slotId);
    }
  }

  private async addSlot(slot: LiveSlot, now: number): Promise<void> {
    const runtime = new SessionRuntime(slot, {
      emit: (event: VisualEvent) => this.store.emit(event),
      noteUnknown: (kind) => {
        this.unknownSignals += 1;
        if (this.unknownSignals % 25 === 1) {
          console.warn(`[engine] unknown signal ${kind} (${this.unknownSignals} total)`);
          this.store.patchHealth({ unknownSignals: this.unknownSignals });
        }
      },
      resolveTarget: (to, fromSlot) => this.resolveTarget(to, fromSlot),
      colorIndex: this.takeColor(slot.slotId),
      autoCompactPct: this.autoCompactPct,
    });

    const tracked: Tracked = {
      runtime,
      transcriptPath: null,
      main: null,
      agents: new Map(),
      workflowMtimes: new Map(),
      endedAt: null,
    };
    this.tracked.set(slot.slotId, tracked);
    this.store.emit({ at: now, t: 'sessionAppeared', slot: slot.slotId });

    await this.attachTranscript(tracked, slot.sessionId, { fresh: false });
    this.dirty.add(slot.slotId);
    this.publish();
  }

  private removeSlot(slotId: string): void {
    const tracked = this.tracked.get(slotId);
    if (!tracked) return;
    for (const agent of tracked.runtime.agents.values()) this.store.removeAgent(agent.id);
    for (const watch of tracked.runtime.watches.values()) this.store.removeWatch(watch.id);
    for (const run of tracked.runtime.workflows.values()) this.store.removeWorkflow(run.runId);
    this.store.removeSession(slotId);
    this.usedColors.delete(tracked.runtime.toView(this.clock.now()).colorIndex);
    this.tracked.delete(slotId);
  }

  /**
   * Cold load: the head carries session metadata, the tail carries what is
   * happening now. Everything in between is history the visualizer never shows.
   */
  private async attachTranscript(tracked: Tracked, sessionId: string, opts: { fresh: boolean }): Promise<void> {
    const path = await this.locator.transcriptPath(sessionId);
    tracked.transcriptPath = path;
    tracked.main = null;
    tracked.agents.clear();
    if (!path) return;

    const stat = await this.fs.stat(path);
    if (!stat) return;

    const reader = new TailReader(this.fs, path);
    tracked.main = reader;

    if (opts.fresh) {
      reader.seek(0, stat.ino, false);
    } else {
      const headEnd = Math.min(stat.size, 256 * 1024);
      const head = await this.fs.readRange(path, 0, headEnd);
      this.applyLines(tracked, splitComplete(head.toString('utf8')), undefined, true, stat.mtimeMs);

      const start = Math.max(headEnd, stat.size - MAIN_TAIL_BYTES);
      reader.seek(start, stat.ino, start > 0);
    }

    const { lines } = await reader.read(MAIN_TAIL_BYTES);
    this.applyLines(tracked, lines, undefined, true, stat.mtimeMs);

    await this.syncSubagents(tracked, { backfill: true });
    await this.syncWorkflows(tracked);
    this.dirty.add(tracked.runtime.slotId);
  }

  /** Sidecars are how a subagent transcript is tied to the call that spawned it. */
  private async syncSubagents(tracked: Tracked, opts: { backfill: boolean }): Promise<void> {
    if (!tracked.transcriptPath) return;
    const now = this.clock.now();
    const files = await this.locator.subagents(tracked.transcriptPath);

    for (const file of files) {
      const meta = file.meta ?? {};
      // The transcript's creation time is when the agent actually started, which
      // matters for cold-loaded agents whose first lines are long gone.
      const stat = await this.fs.stat(file.jsonlPath);
      const agent = tracked.runtime.ensureAgent(file.agentId, {
        agentType: meta.agentType ?? 'general-purpose',
        description: meta.description ?? '',
        depth: (meta.spawnDepth ?? 0) + 1,
        background: meta.requestShape === 'background',
        isFork: meta.isFork === true,
        startedAt: stat?.birthtimeMs ?? now,
        lastActivityAt: stat?.mtimeMs ?? now,
        model: meta.model,
        ...(meta.parentAgentId ? { parentId: meta.parentAgentId } : {}),
        ...(meta.name ? { name: meta.name } : {}),
        ...(file.workflowRunId ? { workflowRunId: file.workflowRunId } : {}),
      });
      if (meta.stoppedByUser && agent.status === 'running') agent.finish('stopped', now);

      if (tracked.agents.has(file.agentId)) continue;
      if (!stat) continue;

      const reader = new TailReader(this.fs, file.jsonlPath);
      tracked.agents.set(file.agentId, reader);

      // Old agents stay as finished cards built from the parent's data.
      if (now - stat.mtimeMs > COLD_WINDOW_MS) {
        reader.seek(stat.size, stat.ino, false);
        continue;
      }
      const start = Math.max(0, stat.size - AGENT_TAIL_BYTES);
      reader.seek(start, stat.ino, start > 0);
      const { lines } = await reader.read(AGENT_TAIL_BYTES);
      this.applyLines(tracked, lines, file.agentId, opts.backfill, opts.backfill ? stat.mtimeMs : undefined);
    }
  }

  private async syncWorkflows(tracked: Tracked): Promise<void> {
    if (!tracked.transcriptPath) return;
    for (const files of await this.locator.workflows(tracked.transcriptPath)) {
      const stat = await this.fs.stat(files.summaryPath);
      if (!stat) continue;
      if (tracked.workflowMtimes.get(files.runId) === stat.mtimeMs) continue;
      tracked.workflowMtimes.set(files.runId, stat.mtimeMs);

      const text = await this.fs.readText(files.summaryPath);
      if (!text) continue;
      try {
        this.applyWorkflowSummary(tracked, files.runId, JSON.parse(text) as WorkflowSummary);
      } catch {
        // A partially written summary shows up again on the next poll.
      }
    }
  }

  private applyWorkflowSummary(tracked: Tracked, runId: string, summary: WorkflowSummary): void {
    const existing = tracked.runtime.workflows.get(runId);
    const phases = (summary.workflowProgress ?? [])
      .filter((item) => item.type === 'workflow_phase')
      .map<WorkflowRun['phases'][number]>((item, index) => ({
        index: item.index ?? index,
        title: item.title ?? `phase ${index + 1}`,
        status: 'pending',
        agentIds: [],
      }));

    for (const item of summary.workflowProgress ?? []) {
      if (item.type !== 'workflow_agent' || !item.agentId) continue;
      const phase = phases.find((p) => p.index === item.phaseIndex);
      if (phase) {
        phase.agentIds.push(item.agentId);
        if (item.state === 'running') phase.status = 'active';
        else if (phase.status !== 'active') phase.status = 'done';
      }
      const agent = tracked.runtime.ensureAgent(item.agentId, {
        agentType: 'workflow-subagent',
        description: item.label ?? '',
        startedAt: item.startedAt ?? summary.startedAt ?? this.clock.now(),
        workflowRunId: runId,
        model: item.model,
      });
      agent.phaseIndex = item.phaseIndex;
      if (item.state === 'done' && agent.status === 'running') agent.finish('done', this.clock.now());
    }

    const run: WorkflowRun = {
      runId,
      slotId: tracked.runtime.slotId,
      parentAgentId: existing?.parentAgentId ?? tracked.runtime.main.id,
      name: summary.workflowName ?? existing?.name ?? 'workflow',
      status: normalizeWorkflowStatus(summary.status),
      phases: phases.length ? phases : (existing?.phases ?? []),
      agentCount: summary.agentCount ?? existing?.agentCount ?? 0,
      totalTokens: summary.totalTokens ?? 0,
      totalToolCalls: summary.totalToolCalls ?? 0,
      startedAt: summary.startedAt ?? existing?.startedAt ?? this.clock.now(),
      ...(summary.durationMs !== undefined ? { durationMs: summary.durationMs } : {}),
      ...(existing?.toolUseId ? { toolUseId: existing.toolUseId } : {}),
    };
    tracked.runtime.workflows.set(runId, run);
    this.dirty.add(tracked.runtime.slotId);
  }

  /**
   * `asOf` is the clock a timestamp-less line inherits.
   *
   * It matters: while backfilling, "now" is the wrong answer. A few line types
   * carry no timestamp, and giving them the wall clock makes a session that has
   * been quiet since yesterday look like it spoke the instant the app started —
   * which then reads as "Quiet for 0s" everywhere. During backfill the caller
   * passes the file's mtime instead, which is the latest anything in it can
   * possibly have happened.
   */
  private applyLines(
    tracked: Tracked,
    lines: string[],
    agentId: string | undefined,
    backfill: boolean,
    asOf?: number,
  ): void {
    if (lines.length === 0) return;
    const now = asOf ?? this.clock.now();
    for (const line of lines) {
      for (const signal of normalizeLine(line, { now })) {
        tracked.runtime.applySignal(signal, agentId, backfill);
      }
    }
    this.dirty.add(tracked.runtime.slotId);
  }

  /** Reads whatever grew since last time, for every tracked file. */
  private async pump(): Promise<void> {
    for (const tracked of this.tracked.values()) {
      if (tracked.main) {
        const { lines, reset } = await tracked.main.read(MAIN_TAIL_BYTES);
        if (reset) this.dirty.add(tracked.runtime.slotId);
        this.applyLines(tracked, lines, undefined, false);
      }
      for (const [agentId, reader] of tracked.agents) {
        const { lines } = await reader.read(AGENT_TAIL_BYTES);
        this.applyLines(tracked, lines, agentId, false);
      }
      await this.syncSubagents(tracked, { backfill: false });
      await this.syncWorkflows(tracked);
    }
    this.publish();
  }

  private tick(): void {
    const now = this.clock.now();
    for (const tracked of this.tracked.values()) {
      const slot = tracked.runtime.registry;
      const alive = tracked.endedAt === null && this.proc.isAlive(slot.pid);
      const before = tracked.runtime.toView(now).phase;
      tracked.runtime.tick(now, alive);
      if (tracked.runtime.toView(now).phase !== before) this.dirty.add(tracked.runtime.slotId);
      // Elapsed time and context percentages move every second anyway.
      if (tracked.runtime.toView(now).phase === 'working') this.dirty.add(tracked.runtime.slotId);
    }
    this.publish();
  }

  private publish(): void {
    if (this.dirty.size === 0) return;
    const now = this.clock.now();
    for (const slotId of this.dirty) {
      const tracked = this.tracked.get(slotId);
      if (!tracked) continue;
      this.store.upsertSession(tracked.runtime.toView(now));
      for (const agent of tracked.runtime.agentViews(now)) this.store.upsertAgent(agent);
      for (const id of tracked.runtime.prunedAgentIds(now)) this.store.removeAgent(id);
      for (const watch of tracked.runtime.watches.values()) this.store.upsertWatch(watch);
      for (const run of tracked.runtime.workflows.values()) this.store.upsertWorkflow(run);
    }
    this.dirty.clear();
  }

  /**
   * A card id is either a slot (the session's own transcript) or an agent id.
   */
  logFor(cardId: string): EntryLog | undefined {
    const direct = this.tracked.get(cardId);
    if (direct) return direct.runtime.log(cardId);
    for (const tracked of this.tracked.values()) {
      const log = tracked.runtime.log(cardId);
      if (log) return log;
    }
    return undefined;
  }

  /** SendMessage targets a session by name, or a subagent by its id. */
  private resolveTarget(to: string, fromSlot: string): Endpoint {
    if (!to) return { kind: 'external', label: 'unknown' };
    if (to === 'main') {
      const tracked = this.tracked.get(fromSlot);
      return tracked ? { kind: 'agent', agentId: tracked.runtime.main.id } : { kind: 'external', label: 'main' };
    }
    if (/^a[0-9a-f]{16}$/.test(to)) return { kind: 'agent', agentId: to };

    // Cross-session sends address a peer by name, sometimes with a [ref] suffix.
    const name = to.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
    for (const tracked of this.tracked.values()) {
      const slot = tracked.runtime.registry;
      const names = [slot.name, ...(slot.formerNames ?? []).map((f) => f.name)];
      if (names.some((candidate) => candidate === name)) {
        return { kind: 'session', slotId: tracked.runtime.slotId };
      }
    }
    return { kind: 'external', label: name };
  }

  private takeColor(slotId: string): number {
    const total = SESSION_PALETTE.length;
    let hash = 0;
    for (let i = 0; i < slotId.length; i++) hash = (hash * 31 + slotId.charCodeAt(i)) >>> 0;
    for (let offset = 0; offset < total; offset++) {
      const index = (hash + offset) % total;
      if (!this.usedColors.has(index)) {
        this.usedColors.add(index);
        return index;
      }
    }
    return hash % total;
  }
}

interface WorkflowSummary {
  workflowName?: string;
  status?: string;
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  startedAt?: number;
  durationMs?: number;
  workflowProgress?: {
    type?: string;
    index?: number;
    title?: string;
    label?: string;
    phaseIndex?: number;
    agentId?: string;
    model?: string;
    state?: string;
    startedAt?: number;
  }[];
}

function normalizeWorkflowStatus(status: string | undefined): WorkflowRun['status'] {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'killed':
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}

/** Drops a trailing partial line from a head read. */
function splitComplete(text: string): string[] {
  const parts = text.split('\n');
  parts.pop();
  return parts.filter((line) => line.length > 0);
}
