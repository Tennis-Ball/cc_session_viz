import type { VisualEvent } from '../../shared/events';
import { fmtDuration, fmtTokens, hash32, modelInfo, repoName } from '../../shared/format';
import type {
  AgentView,
  Condition,
  Endpoint,
  MessageLink,
  Ms,
  SessionChainLink,
  SessionView,
  TaskItem,
  WatchTask,
  WorkflowRun,
} from '../../shared/model';
import { toolToActivity } from '../parse/toolActivity';
import type { TranscriptEntry } from '../../shared/transcript';
import type { Signal, TaskNotification } from '../parse/signals';
import type { LiveSlot } from '../discovery/registry';
import { AgentRuntime, roleFor } from './agentRuntime';
import { diffOf, EntryLog, previewResult, summarizeResult } from './entryLog';
import { LivenessMachine, type LivenessEvidence } from './liveness';

const AGENT_ID_RE = /^a[0-9a-f]{16}$/;
const AGENT_STALE_MS = 15 * 60 * 1000;
/** A turn that ended hours ago is history, not something to glow about. */
const UNREAD_TTL_MS = 10 * 60 * 1000;
const MAX_FINISHED_AGENTS = 12;
const CONDITION_TTL_MS = 60_000;
const PROBABLE_PERMISSION_MS = 8000;
const COMPACT_SILENCE_MS = 4000;
const AUTOCOMPACT_SILENCE_MS = 6000;
/** Tools that normally return instantly; a long pause means a permission prompt. */
const FAST_TOOLS = new Set(['Edit', 'Write', 'Read', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'LS']);

export interface SessionRuntimeDeps {
  emit(event: VisualEvent): void;
  noteUnknown(kind: string): void;
  /** Resolves a SendMessage recipient name to a session, agent or unknown peer. */
  resolveTarget(to: string, slotId: string): Endpoint;
  colorIndex: number;
  ambient?: boolean;
  autoCompactPct?: number;
}

/**
 * One Claude Code process (a "slot"), including every agent under it.
 *
 * Identity is the pid and its start time, not the sessionId: /clear and /resume
 * both mint a new sessionId while the terminal, and therefore the desk in the
 * office, stays exactly where it was.
 */
export class SessionRuntime {
  readonly slotId: string;
  readonly agents = new Map<string, AgentRuntime>();
  readonly watches = new Map<string, WatchTask>();
  /** One transcript log per canvas card: the session, then each subagent. */
  private readonly logs = new Map<string, EntryLog>();
  readonly workflows = new Map<string, WorkflowRun>();
  readonly main: AgentRuntime;

  private slot: LiveSlot;
  private sessionChain: SessionChainLink[];
  private readonly titles: { registry?: string; agentName?: string; aiTitle?: string; lastPrompt?: string } = {};
  private cwd: string;
  private gitBranch: string | undefined;
  private worktree: SessionView['worktree'];
  private permissionMode = 'default';
  private plan: SessionView['plan'];
  private contextUsed = 0;
  /** Only set by the `model` attachment, which is the sole place `[1m]` appears. */
  private windowOverride: number | undefined;
  private lastCompact: SessionView['context']['lastCompact'];
  private compacting: 'no' | 'probable' | 'confirmed' = 'no';
  private turn: SessionView['turn'];
  private lastTurn: SessionView['lastTurn'];
  private queue: { count: number; previews: string[] } = { count: 0, previews: [] };
  private tasks: TaskItem[] = [];
  private prs: SessionView['prs'] = [];
  private remote: SessionView['remote'];
  private conditions: Condition[] = [];
  private cost: SessionView['cost'];
  private awaySummary: SessionView['awaySummary'];
  private effort: string | undefined;
  private ultra = false;
  private fast = false;
  private unread = false;
  private lastLineAt: Ms;
  private readonly liveness = new LivenessMachine();
  private phase: SessionView['phase'] = 'starting';
  private phaseSince: Ms;
  private attention: SessionView['attention'];
  private attentionTool: { kind: 'question' | 'planApproval'; since: Ms; detail?: string } | null = null;
  private cmuxAttention: { kind: 'permission'; detail?: string } | null = null;
  private cmux: SessionView['cmux'];
  private groupId: string | undefined;

  private readonly pendingSpawns = new Map<string, { agentType: string; description: string; at: Ms }>();
  private readonly pendingWorkflows = new Map<string, { name: string; phases: { title: string }[]; at: Ms }>();
  private readonly pendingMessages = new Map<string, { to: string; preview: string }>();
  private readonly seenNotifications = new Set<string>();

  constructor(
    slot: LiveSlot,
    private readonly deps: SessionRuntimeDeps,
  ) {
    this.slot = slot;
    this.slotId = slot.slotId;
    this.cwd = slot.cwd;
    this.sessionChain = [{ sessionId: slot.sessionId, reason: 'start', at: slot.startedAt }];
    this.phaseSince = slot.startedAt;
    this.lastLineAt = slot.startedAt;
    if (slot.name) this.titles.registry = slot.name;

    this.main = new AgentRuntime({
      id: `main@${slot.slotId}`,
      slotId: slot.slotId,
      role: 'main',
      agentType: 'main',
      description: 'main conversation',
      depth: 0,
      background: false,
      isFork: false,
      startedAt: slot.startedAt,
      ambient: deps.ambient ?? false,
    });
    this.agents.set(this.main.id, this.main);
  }

  get sessionId(): string {
    return this.slot.sessionId;
  }

  get registry(): LiveSlot {
    return this.slot;
  }

  /** Registry updates carry status, renames and sessionId transitions. */
  updateRegistry(slot: LiveSlot, now: Ms): void {
    const previous = this.slot;
    this.slot = slot;

    if (slot.name && slot.name !== previous.name) {
      const from = this.title;
      this.titles.registry = slot.name;
      if (from !== slot.name) this.deps.emit({ at: now, t: 'renamed', slot: this.slotId, from, to: slot.name });
    }

    if (slot.sessionId !== previous.sessionId) {
      // Same process, new transcript: /clear starts empty, /resume reopens one.
      const reason: SessionChainLink['reason'] = 'clear';
      this.sessionChain = [...this.sessionChain, { sessionId: slot.sessionId, reason, at: now }];
      this.contextUsed = 0;
      this.turn = undefined;
      this.queue = { count: 0, previews: [] };
      this.tasks = [];
      this.logFor(undefined).reset({ k: 'divider', id: `d:${now}`, at: now, reason: 'clear', sessionId: slot.sessionId });
      this.deps.emit({ at: now, t: 'cleared', slot: this.slotId });
    }
  }

  setCmuxAttention(attention: { kind: 'permission'; detail?: string } | null): void {
    this.cmuxAttention = attention;
  }

  setCmux(info: SessionView['cmux']): void {
    this.cmux = info;
  }

  setGroup(groupId: string | undefined): void {
    this.groupId = groupId;
  }

  markSeen(): void {
    this.unread = false;
  }

  get title(): string {
    return (
      this.titles.aiTitle ??
      this.titles.agentName ??
      (this.slot.nameSource && this.slot.nameSource !== 'derived' ? this.titles.registry : undefined) ??
      this.titles.registry ??
      repoName(this.cwd)
    );
  }

  /**
   * Applies one signal. `agentId` routes subagent transcript lines to their own
   * runtime; undefined means the main conversation.
   */
  applySignal(signal: Signal, agentId?: string, backfill = false): void {
    const at = signal.at;
    if (at > this.lastLineAt) this.lastLineAt = at;
    const agent = this.agentFor(agentId);
    const emit = (event: VisualEvent): void => {
      if (!backfill) this.deps.emit(event);
    };
    this.record(signal, agentId, agent);

    switch (signal.s) {
      case 'envelope':
        if (signal.cwd) this.cwd = signal.cwd;
        if (signal.gitBranch) this.gitBranch = signal.gitBranch;
        break;

      case 'title':
        if (signal.kind === 'aiTitle') this.titles.aiTitle = signal.value;
        if (signal.kind === 'agentName') this.titles.agentName = signal.value;
        if (signal.kind === 'lastPrompt') this.titles.lastPrompt = signal.value;
        break;

      case 'prompt': {
        this.turn = { startedAt: at, outputTokens: 0, toolUses: 0, verbSeed: hash32(`${this.slotId}:${at}`) };
        this.unread = false; // you were clearly at the terminal
        this.queue = { count: Math.max(0, this.queue.count - 1), previews: this.queue.previews.slice(1) };
        if (this.plan?.awaitingApproval) this.plan = { ...this.plan, awaitingApproval: false };
        this.attentionTool = null;
        this.main.setActivity('thinking', at);
        emit({ at, t: 'turnStarted', slot: this.slotId, preview: signal.text.slice(0, 120) });
        break;
      }

      case 'turnEnd': {
        if (this.turn) this.lastTurn = { endedAt: at, durationMs: signal.durationMs, verbSeed: this.turn.verbSeed };
        this.turn = undefined;
        this.unread = true;
        this.main.setActivity('idle', at);
        emit({ at, t: 'turnEnded', slot: this.slotId, durationMs: signal.durationMs });
        break;
      }

      case 'text':
        if (agent.noteMessage(`${signal.messageId}:text`)) agent.setActivity('responding', at);
        break;

      case 'thinking':
        agent.setActivity('thinking', at);
        break;

      case 'usage': {
        const first = agent.noteMessage(signal.messageId);
        if (!agentId && signal.used > 0) {
          // Only the main chain defines the session's context window usage, and
          // an all-zero usage means an aborted or errored request, not an empty
          // context: taking it would wipe the meter.
          this.contextUsed = signal.used;
          if (signal.effort) this.effort = signal.effort;
          this.fast = signal.speed !== undefined && signal.speed !== 'standard';
        }
        if (first) agent.addTokens(signal.output);
        if (agent.setModel(signal.model, agentId ? undefined : this.windowOverride) && !backfill) {
          emit({ at, t: 'modelChanged', agent: agent.id, from: agent.model.id, to: signal.model });
        }
        if (signal.apiError || signal.error) {
          const kind = signal.error === 'rate_limit' ? 'rateLimited' : 'apiError';
          this.addCondition({ kind, since: at, ...(signal.error ? { detail: signal.error } : {}) });
          agent.setActivity('stalled', at);
          emit({ at, t: 'apiError', agent: agent.id, kind: signal.error ?? 'error' });
        } else {
          this.clearConditions('apiError', 'rateLimited');
        }
        if (signal.stopReason === 'max_tokens') this.addCondition({ kind: 'maxTokens', since: at });
        break;
      }

      case 'toolUse': {
        const activity = toolToActivity(signal.name, signal.input);
        agent.pending.set(signal.id, {
          toolUseId: signal.id,
          name: signal.name,
          input: signal.input,
          at,
          activity,
        });
        agent.countToolUse();
        agent.setActivity(activity.activity, at, { ...activity, toolUseId: signal.id });
        if (this.turn) this.turn = { ...this.turn, toolUses: this.turn.toolUses + 1 };
        emit({
          at,
          t: 'toolStarted',
          agent: agent.id,
          tool: signal.name,
          activity: activity.activity,
          label: activity.label,
          toolUseId: signal.id,
        });
        this.noteToolStart(signal, agent.id, at, emit);
        break;
      }

      case 'toolResult': {
        const pending = agent.pending.get(signal.id);
        agent.pending.delete(signal.id);
        emit({ at, t: 'toolFinished', agent: agent.id, toolUseId: signal.id, ok: !signal.isError });
        if (signal.denial) emit({ at, t: 'denied', agent: agent.id, kind: signal.denial });
        this.noteToolResult(signal, pending?.name, agent, at, emit);
        if (agent.activityDetail?.toolUseId === signal.id) agent.setActivity('thinking', at);
        break;
      }

      case 'taskNotification':
        this.applyNotification(signal.notification, at, emit);
        break;

      case 'agentProgress': {
        const agent = this.agents.get(signal.taskId);
        if (agent) agent.noteProgress(signal.summary, at);
        break;
      }

      case 'compact': {
        this.contextUsed = signal.post;
        this.compacting = 'no';
        this.lastCompact = {
          at,
          trigger: signal.trigger,
          pre: signal.pre,
          post: signal.post,
          durationMs: signal.durationMs ?? 0,
        };
        this.main.setActivity('compacting', at);
        emit({ at, t: 'compacted', slot: this.slotId, pre: signal.pre, post: signal.post, trigger: signal.trigger });
        break;
      }

      case 'permissionMode':
        this.permissionMode = signal.mode;
        if (signal.mode === 'plan' && !this.plan) this.plan = { awaitingApproval: false };
        break;

      case 'planMode':
        if (signal.state === 'exit') this.plan = undefined;
        else this.plan = { awaitingApproval: false, ...(signal.planFilePath ? { filePath: signal.planFilePath } : {}) };
        break;

      case 'autoMode':
        this.permissionMode = signal.enabled ? 'auto' : 'default';
        break;

      case 'effortMode':
        this.ultra = signal.ultra;
        break;

      case 'modelAttachment': {
        this.windowOverride = modelInfo(signal.modelId).window;
        if (!agentId) this.main.setModel(signal.modelId, this.windowOverride);
        break;
      }

      case 'tasks':
        this.tasks = signal.items.map((item) => ({
          id: item.id,
          subject: item.subject,
          status: item.status === 'in_progress' || item.status === 'completed' ? item.status : 'pending',
          ...(item.activeForm ? { activeForm: item.activeForm } : {}),
        }));
        if (this.turn) {
          const active = this.tasks.find((t) => t.status === 'in_progress');
          this.turn = { ...this.turn, ...(active?.activeForm ? { activeForm: active.activeForm } : {}) };
        }
        break;

      case 'queueOp':
        if (signal.op === 'enqueue') {
          this.queue = {
            count: this.queue.count + 1,
            previews: [...this.queue.previews, signal.content].slice(-3),
          };
          emit({ at, t: 'promptQueued', slot: this.slotId });
        } else {
          this.queue = { count: Math.max(0, this.queue.count - 1), previews: this.queue.previews.slice(1) };
        }
        break;

      case 'interrupt': {
        for (const pending of agent.pending.values()) {
          emit({ at, t: 'toolFinished', agent: agent.id, toolUseId: pending.toolUseId, ok: false });
        }
        agent.pending.clear();
        if (this.turn) this.lastTurn = { endedAt: at, durationMs: at - this.turn.startedAt, verbSeed: this.turn.verbSeed };
        this.turn = undefined;
        this.attentionTool = null;
        emit({ at, t: 'interrupted', slot: this.slotId });
        break;
      }

      case 'inbound': {
        const link: MessageLink = {
          id: `${this.slotId}:${at}:in`,
          kind:
            signal.via === 'crossSession'
              ? 'crossSession'
              : signal.via === 'coordinator'
                ? 'coordinator'
                : signal.via === 'peer'
                  ? 'agentToMain'
                  : 'deliveryNotice',
          from: this.deps.resolveTarget(signal.from, this.slotId),
          to: { kind: 'session', slotId: this.slotId },
          preview: signal.text.slice(0, 140),
          at,
          observed: 'recipient',
        };
        emit({ at, t: 'message', link });
        break;
      }

      case 'prLink':
        if (!this.prs.some((pr) => pr.number === signal.number)) {
          this.prs = [...this.prs, { number: signal.number, url: signal.url, repo: signal.repo }];
          emit({ at, t: 'prLinked', slot: this.slotId, number: signal.number });
        }
        break;

      case 'cost':
        this.cost = { usd: signal.usd, linesAdded: signal.linesAdded, linesRemoved: signal.linesRemoved };
        break;

      case 'worktree':
        this.worktree = { name: signal.name, branch: signal.branch, path: signal.path };
        break;

      case 'relocated':
        this.cwd = signal.cwd;
        break;

      case 'bridge':
        this.remote = signal.bridgeSessionId
          ? { bridgeSessionId: signal.bridgeSessionId, connected: true }
          : undefined;
        break;

      case 'remoteChange':
        if (this.remote) this.remote = { ...this.remote, connected: signal.connected };
        break;

      case 'hook':
        if (!signal.ok) this.addCondition({ kind: 'hookError', since: at, ...(signal.detail ? { detail: signal.detail } : {}) });
        emit({ at, t: 'hook', slot: this.slotId, ok: signal.ok });
        break;

      case 'scheduledFire': {
        const watch = this.watches.get(signal.taskId);
        if (watch) {
          this.watches.set(signal.taskId, { ...watch, status: 'fired', lastEventAt: at });
          emit({ at, t: 'wakeupFired', watch: signal.taskId });
        }
        break;
      }

      case 'notice':
        if (signal.origin === 'awaySummary') this.awaySummary = { at, text: signal.text };
        if (signal.origin === 'refusalFallback') this.addCondition({ kind: 'refusalFallback', since: at, detail: signal.text });
        break;

      case 'unknown':
        this.deps.noteUnknown(signal.kind);
        break;

      default:
        break;
    }
  }

  /** Side effects that depend on which tool started. */
  private noteToolStart(
    signal: Extract<Signal, { s: 'toolUse' }>,
    agentId: string,
    at: Ms,
    emit: (event: VisualEvent) => void,
  ): void {
    switch (signal.name) {
      case 'Agent':
      case 'Task':
        this.pendingSpawns.set(signal.id, {
          agentType: String(signal.input['subagent_type'] ?? 'general-purpose'),
          description: String(signal.input['description'] ?? ''),
          at,
        });
        break;
      case 'Workflow': {
        const script = String(signal.input['script'] ?? '');
        this.pendingWorkflows.set(signal.id, { name: workflowName(script), phases: workflowPhases(script), at });
        break;
      }
      case 'SendMessage':
        this.pendingMessages.set(signal.id, {
          to: String(signal.input['to'] ?? ''),
          preview: String(signal.input['message'] ?? '').slice(0, 140),
        });
        break;
      case 'ExitPlanMode':
        this.attentionTool = { kind: 'planApproval', since: at };
        this.plan = { ...(this.plan ?? {}), awaitingApproval: true };
        break;
      case 'AskUserQuestion':
        this.attentionTool = { kind: 'question', since: at };
        break;
      case 'Skill':
        emit({ at, t: 'skillUsed', agent: agentId, skill: String(signal.input['skill'] ?? '') });
        break;
      case 'Edit':
      case 'Write':
      case 'MultiEdit':
        emit({ at, t: 'fileEdited', agent: agentId, path: String(signal.input['file_path'] ?? '') });
        break;
      case 'SendUserFile':
      case 'Artifact':
        emit({ at, t: 'published', agent: agentId });
        break;
      default:
        break;
    }
  }

  private noteToolResult(
    signal: Extract<Signal, { s: 'toolResult' }>,
    toolName: string | undefined,
    agent: AgentRuntime,
    at: Ms,
    emit: (event: VisualEvent) => void,
  ): void {
    const result = signal.result ?? {};

    // A spawned subagent is only identified by its result: the tool call itself
    // has no id, and several can be in flight at once.
    const spawn = this.pendingSpawns.get(signal.id);
    if (spawn) {
      this.pendingSpawns.delete(signal.id);
      const childId = typeof result['agentId'] === 'string' ? result['agentId'] : undefined;
      if (childId) {
        const child = this.ensureAgent(childId, {
          agentType: spawn.agentType,
          description: spawn.description,
          parentId: agent.id,
          background: result['isAsync'] === true,
          startedAt: spawn.at,
          model: typeof result['resolvedModel'] === 'string' ? result['resolvedModel'] : undefined,
          spawnToolUseId: signal.id,
        });
        emit({ at, t: 'subagentSpawned', parent: agent.id, child: child.id });
      }
    }

    if (toolName === 'Workflow') {
      const pendingWorkflow = this.pendingWorkflows.get(signal.id);
      const runId = typeof result['runId'] === 'string' ? result['runId'] : undefined;
      if (pendingWorkflow && runId) {
        this.pendingWorkflows.delete(signal.id);
        this.workflows.set(runId, {
          runId,
          slotId: this.slotId,
          parentAgentId: agent.id,
          toolUseId: signal.id,
          name: typeof result['workflowName'] === 'string' ? result['workflowName'] : pendingWorkflow.name,
          status: 'running',
          phases: pendingWorkflow.phases.map((phase, index) => ({
            index,
            title: phase.title,
            status: index === 0 ? 'active' : 'pending',
            agentIds: [],
          })),
          agentCount: 0,
          totalTokens: 0,
          totalToolCalls: 0,
          startedAt: pendingWorkflow.at,
        });
        emit({ at, t: 'workflowStarted', runId });
      }
    }

    if (toolName === 'SendMessage') {
      const pendingMessage = this.pendingMessages.get(signal.id);
      this.pendingMessages.delete(signal.id);
      if (pendingMessage) {
        const target = this.deps.resolveTarget(pendingMessage.to, this.slotId);
        const kind: MessageLink['kind'] =
          pendingMessage.to === 'main'
            ? 'agentToMain'
            : AGENT_ID_RE.test(pendingMessage.to)
              ? 'coordinator'
              : 'crossSession';
        emit({
          at,
          t: 'message',
          link: {
            id: `${signal.id}:out`,
            kind,
            from: { kind: 'agent', agentId: agent.id },
            to: target,
            preview: pendingMessage.preview,
            at,
            observed: 'sender',
            delivered: !signal.isError,
          },
        });
      }
      const resumed = typeof result['resumedAgentId'] === 'string' ? result['resumedAgentId'] : undefined;
      if (resumed) {
        const revived = this.agents.get(resumed);
        if (revived) {
          revived.revive(at);
          emit({ at, t: 'subagentRevived', agent: resumed });
        }
      }
    }

    // Background work: each of these parks a lantern on the watchtower.
    const backgroundTaskId = typeof result['backgroundTaskId'] === 'string' ? result['backgroundTaskId'] : undefined;
    if (backgroundTaskId) {
      this.addWatch(
        { id: backgroundTaskId, kind: 'bash', label: 'background command', ownerAgentId: agent.id, startedAt: at },
        emit,
      );
    }
    const taskId = typeof result['taskId'] === 'string' ? result['taskId'] : undefined;
    if (taskId && (toolName === 'Monitor' || toolName === 'ScheduleWakeup' || toolName === 'CronCreate')) {
      const kind = toolName === 'Monitor' ? 'monitor' : toolName === 'CronCreate' ? 'cron' : 'wakeup';
      this.addWatch(
        {
          id: taskId,
          kind,
          label: toolName.toLowerCase(),
          ownerAgentId: agent.id,
          startedAt: at,
          persistent: result['persistent'] === true,
          recurring: kind === 'cron',
        },
        emit,
      );
    }

    if (toolName === 'ExitPlanMode') {
      this.attentionTool = null;
      this.plan = signal.isError ? { ...(this.plan ?? {}), awaitingApproval: false } : undefined;
    }
    if (toolName === 'AskUserQuestion') this.attentionTool = null;
  }

  /** Background agents, background Bash and Monitor all finish through this. */
  private applyNotification(notification: TaskNotification, at: Ms, emit: (event: VisualEvent) => void): void {
    const key = `${notification.taskId}:${notification.status ?? ''}:${notification.summary?.slice(0, 40) ?? ''}`;
    if (this.seenNotifications.has(key)) return; // it arrives twice: queue op + user line
    this.seenNotifications.add(key);

    const agent = this.agents.get(notification.taskId);
    if (agent) {
      agent.setStats({
        ...(notification.tokens !== undefined ? { tokens: notification.tokens } : {}),
        ...(notification.toolUses !== undefined ? { toolUses: notification.toolUses } : {}),
        ...(notification.durationMs !== undefined ? { durationMs: notification.durationMs } : {}),
      });
      const status = notification.status === 'completed' ? 'done' : 'failed';
      agent.finish(status, at, notification.result?.slice(0, 400));
      emit({ at, t: 'subagentFinished', agent: agent.id, status });
      return;
    }

    const watch = this.watches.get(notification.taskId);
    if (watch) {
      if (notification.event !== undefined) {
        this.watches.set(notification.taskId, {
          ...watch,
          eventCount: watch.eventCount + 1,
          lastEventAt: at,
        });
        emit({ at, t: 'watchPulse', watch: watch.id });
        return;
      }
      this.watches.set(notification.taskId, { ...watch, status: 'completed', lastEventAt: at });
      emit({ at, t: 'watchEnded', watch: watch.id });
    }
  }

  /** Registers or updates a subagent, including ones discovered via sidecars. */
  ensureAgent(
    id: string,
    init: {
      agentType: string;
      description: string;
      parentId?: string;
      depth?: number;
      background?: boolean;
      isFork?: boolean;
      workflowRunId?: string;
      startedAt: Ms;
      lastActivityAt?: Ms;
      model?: string | undefined;
      name?: string;
      spawnToolUseId?: string;
    },
  ): AgentRuntime {
    const existing = this.agents.get(id);
    if (existing) {
      if (init.description && !existing.description) existing.description = init.description;
      if (init.workflowRunId) existing.workflowRunId = init.workflowRunId;
      return existing;
    }
    const agent = new AgentRuntime({
      id,
      slotId: this.slotId,
      role: roleFor(init.agentType, init.isFork ?? false, init.workflowRunId),
      agentType: init.agentType,
      description: init.description,
      depth: init.depth ?? 1,
      background: init.background ?? false,
      isFork: init.isFork ?? false,
      startedAt: init.startedAt,
      ambient: this.deps.ambient ?? false,
      ...(init.parentId ? { parentId: init.parentId } : {}),
      ...(init.workflowRunId ? { workflowRunId: init.workflowRunId } : {}),
      ...(init.model ? { model: init.model } : {}),
      ...(init.name ? { name: init.name } : {}),
    });
    if (init.lastActivityAt) agent.lastActivityAt = init.lastActivityAt;
    this.agents.set(id, agent);

    if (init.workflowRunId) {
      const run = this.workflows.get(init.workflowRunId);
      if (run) {
        this.workflows.set(init.workflowRunId, { ...run, agentCount: run.agentCount + 1 });
      }
    }
    return agent;
  }

  private addWatch(
    init: {
      id: string;
      kind: WatchTask['kind'];
      label: string;
      ownerAgentId: string;
      startedAt: Ms;
      persistent?: boolean;
      recurring?: boolean;
    },
    emit: (event: VisualEvent) => void,
  ): void {
    if (this.watches.has(init.id)) return;
    this.watches.set(init.id, {
      id: init.id,
      slotId: this.slotId,
      ownerAgentId: init.ownerAgentId,
      kind: init.kind,
      label: init.label,
      startedAt: init.startedAt,
      status: 'active',
      eventCount: 0,
      ...(init.persistent !== undefined ? { persistent: init.persistent } : {}),
      ...(init.recurring !== undefined ? { recurring: init.recurring } : {}),
    });
    emit({ at: init.startedAt, t: 'watchStarted', watch: init.id });
  }

  /** Per-second pass: liveness, compaction guesses and condition expiry. */
  tick(now: Ms, processAlive: boolean): void {
    this.conditions = this.conditions.filter((c) => now - c.since < CONDITION_TTL_MS);
    this.sweepStaleAgents(now);

    const evidence: LivenessEvidence = {
      now,
      processAlive,
      registryStatus: this.slot.status,
      registryWaitingFor: this.slot.waitingFor,
      cmuxAttention: this.cmuxAttention,
      openTurn: this.turn !== undefined,
      pendingAttention: this.attentionTool,
      probablePermission: this.probablePermission(now),
      lastLineAt: this.lastLineAt,
      foregroundSubagentRunning: this.hasForegroundSubagent(),
    };
    const result = this.liveness.update(evidence);
    const previous = this.phase;
    this.phase = result.phase;
    this.phaseSince = result.since;
    this.attention = result.attention;

    if (previous !== 'ended' && result.phase === 'ended') {
      for (const agent of this.agents.values()) {
        if (agent.status === 'running') agent.finish('stale', now);
      }
      this.deps.emit({ at: now, t: 'sessionEnded', slot: this.slotId });
    }

    this.updateCompacting(now);
  }

  /**
   * Compaction is invisible while it runs: the whole burst is written after it
   * finishes. A busy process that has gone quiet with no open turn is the only
   * tell, so this stays a "probable" state with softer visuals.
   */
  private updateCompacting(now: Ms): void {
    if (this.compacting === 'confirmed') return;
    const silence = now - this.lastLineAt;
    const pct = this.contextPct();
    const manual = this.slot.status === 'busy' && !this.turn && silence > COMPACT_SILENCE_MS;
    const auto =
      this.turn !== undefined && pct >= (this.deps.autoCompactPct ?? 80) && silence > AUTOCOMPACT_SILENCE_MS;

    if ((manual || auto) && this.compacting === 'no') {
      this.compacting = 'probable';
      this.main.setActivity('compacting', now);
      this.deps.emit({ at: now, t: 'compactProbable', slot: this.slotId });
    } else if (!manual && !auto && this.compacting === 'probable' && silence < COMPACT_SILENCE_MS) {
      this.compacting = 'no';
    }
  }

  private probablePermission(now: Ms): { since: Ms; detail?: string } | null {
    if (this.permissionMode === 'auto' || this.permissionMode === 'bypassPermissions') return null;
    for (const pending of this.main.pending.values()) {
      if (!FAST_TOOLS.has(pending.name)) continue;
      if (now - pending.at < PROBABLE_PERMISSION_MS) continue;
      return { since: pending.at, detail: pending.name };
    }
    return null;
  }

  private hasForegroundSubagent(): boolean {
    for (const agent of this.agents.values()) {
      if (agent.role !== 'main' && agent.status === 'running' && !agent.background) return true;
    }
    return false;
  }

  private agentFor(agentId?: string): AgentRuntime {
    if (!agentId) return this.main;
    return (
      this.agents.get(agentId) ??
      this.ensureAgent(agentId, { agentType: 'general-purpose', description: '', startedAt: this.lastLineAt })
    );
  }

  private addCondition(condition: Condition): void {
    this.conditions = [...this.conditions.filter((c) => c.kind !== condition.kind), condition];
  }

  private clearConditions(...kinds: Condition['kind'][]): void {
    if (this.conditions.length === 0) return;
    this.conditions = this.conditions.filter((c) => !kinds.includes(c.kind));
  }

  /** The per-message model id has no `[1m]` suffix, so the attachment wins. */
  private get contextWindow(): number {
    return this.windowOverride ?? this.main.model.window;
  }

  private contextPct(): number {
    return this.contextWindow > 0 ? Math.min(100, (this.contextUsed / this.contextWindow) * 100) : 0;
  }

  /**
   * Mirrors signals into the transcript log that canvas mode renders. This runs
   * for backfilled lines too: a card has to show history the moment it opens.
   */
  private record(signal: Signal, agentId: string | undefined, agent: AgentRuntime): void {
    const at = signal.at;
    const log = this.logFor(agentId);

    switch (signal.s) {
      case 'prompt':
        log.append({
          k: 'user',
          id: `u:${at}:${log.all().length}`,
          at,
          text: signal.text,
          source: signal.source,
          images: signal.images,
          pasted: signal.pasted,
        });
        break;
      case 'text':
        log.append({ k: 'text', id: `t:${signal.messageId}:${log.all().length}`, at, text: signal.text });
        break;
      case 'thinking':
        log.append({ k: 'thinking', id: `k:${signal.messageId}:${log.all().length}`, at, text: signal.text });
        break;
      case 'toolUse': {
        const activity = toolToActivity(signal.name, signal.input);
        log.append({
          k: 'tool',
          id: signal.id,
          at,
          name: signal.name,
          title: signal.name,
          arg: toolArg(signal.name, signal.input),
          status: 'pending',
          ...(activity.target ? {} : {}),
        });
        break;
      }
      case 'toolResult': {
        const existing = log.get(signal.id);
        if (!existing || existing.k !== 'tool') break;
        const summary = summarizeResult(existing.name, signal.result, signal.text);
        const preview = previewResult(signal.text);
        const diff = diffOf(signal.result);
        log.replace({
          ...existing,
          status: signal.denial ? 'denied' : signal.isError ? 'error' : 'ok',
          result: summary ? { ...preview, summary } : preview,
          ...(diff ? { diff } : {}),
          ...(typeof signal.result?.['agentId'] === 'string' ? { agentId: signal.result['agentId'] } : {}),
          ...(typeof signal.result?.['backgroundTaskId'] === 'string'
            ? { bgTaskId: signal.result['backgroundTaskId'] }
            : {}),
        });
        break;
      }
      case 'turnEnd':
        log.append({
          k: 'turnEnd',
          id: `e:${at}`,
          at,
          durationMs: signal.durationMs,
          verbSeed: this.turn?.verbSeed ?? this.lastTurn?.verbSeed ?? 0,
        });
        break;
      case 'compact':
        log.append({ k: 'compact', id: `c:${at}`, at, trigger: signal.trigger, pre: signal.pre, post: signal.post });
        break;
      case 'interrupt':
        log.append({ k: 'interrupt', id: `i:${at}`, at, forTool: signal.forTool });
        break;
      case 'inbound':
        log.append({ k: 'inbound', id: `n:${at}`, at, from: signal.from, via: signal.via, text: signal.text });
        break;
      case 'notice':
        if (signal.origin === 'localCommand') break; // command echoes are noise
        log.append({ k: 'notice', id: `s:${at}`, at, level: signal.level, text: signal.text, origin: signal.origin });
        break;
      case 'taskNotification': {
        // Finished background work updates the tool call that launched it.
        const toolUseId = signal.notification.toolUseId;
        const tool = toolUseId ? log.get(toolUseId) : undefined;
        if (tool && tool.k === 'tool') {
          const note = signal.notification;
          // Rebuild Claude Code's "Done (…)" line from the reported usage.
          const parts: string[] = [];
          if (note.toolUses !== undefined) parts.push(`${note.toolUses} tool uses`);
          if (note.tokens !== undefined) parts.push(`${fmtTokens(note.tokens)} tokens`);
          if (note.durationMs !== undefined) parts.push(fmtDuration(note.durationMs));
          const done = parts.length ? `Done (${parts.join(' · ')})` : (note.summary ?? 'Done');
          log.replace({
            ...tool,
            status: note.status === 'completed' ? 'ok' : 'error',
            result: { ...previewResult(note.result ?? note.summary ?? ''), summary: done },
          });
        }
        break;
      }
      default:
        break;
    }
    void agent;
  }

  /** `cardId` is this slot for the main conversation, or a subagent's id. */
  log(cardId: string): EntryLog | undefined {
    return this.logs.get(cardId);
  }

  logIds(): string[] {
    return [...this.logs.keys()];
  }

  private logFor(agentId: string | undefined): EntryLog {
    const cardId = agentId ?? this.slotId;
    let log = this.logs.get(cardId);
    if (!log) {
      log = new EntryLog();
      this.logs.set(cardId, log);
    }
    return log;
  }

  toView(now: Ms): SessionView {
    return {
      id: this.slotId,
      ambient: this.deps.ambient ?? false,
      pid: this.slot.pid,
      startedAt: this.slot.startedAt,
      version: this.slot.version,
      sessionId: this.slot.sessionId,
      sessionChain: this.sessionChain,
      cwd: this.cwd,
      repo: repoName(this.cwd),
      title: this.title,
      titleSource: this.titles.aiTitle ? 'aiTitle' : this.titles.agentName ? 'agentName' : 'registry',
      formerNames: (this.slot.formerNames ?? []).map((f) => f.name),
      phase: this.phase,
      phaseSince: this.phaseSince,
      unread: this.unread && now - (this.lastTurn?.endedAt ?? 0) < UNREAD_TTL_MS,
      lastActivityAt: this.lastLineAt,
      mainAgentId: this.main.id,
      model: { ...this.main.model, window: this.contextWindow },
      ultra: this.ultra,
      fast: this.fast,
      permissionMode: this.permissionMode,
      context: {
        used: this.contextUsed,
        window: this.contextWindow,
        pct: this.contextPct(),
        autoCompactPct: this.deps.autoCompactPct ?? 80,
        compacting: this.compacting,
        ...(this.lastCompact ? { lastCompact: this.lastCompact } : {}),
      },
      queue: this.queue,
      tasks: this.tasks,
      prs: this.prs,
      conditions: this.conditions,
      colorIndex: this.deps.colorIndex,
      ...(this.gitBranch ? { gitBranch: this.gitBranch } : {}),
      ...(this.worktree ? { worktree: this.worktree } : {}),
      ...(this.attention ? { attention: this.attention } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      ...(this.plan ? { plan: this.plan } : {}),
      ...(this.turn ? { turn: this.turn } : {}),
      ...(this.lastTurn ? { lastTurn: this.lastTurn } : {}),
      ...(this.remote ? { remote: this.remote } : {}),
      ...(this.cost ? { cost: this.cost } : {}),
      ...(this.awaySummary ? { awaySummary: this.awaySummary } : {}),
      ...(this.cmux ? { cmux: this.cmux } : {}),
      ...(this.groupId ? { groupId: this.groupId } : {}),
    };
  }

  /**
   * A subagent that has been silent since its parent's turn ended is finished in
   * every way that matters, even if no completion notification ever landed
   * (background agents that outlive a killed parent, cold-loaded history).
   */
  private sweepStaleAgents(now: Ms): void {
    for (const agent of this.agents.values()) {
      if (agent.role === 'main' || agent.status !== 'running') continue;
      if (now - agent.lastActivityAt < AGENT_STALE_MS) continue;
      if (this.turn && agent.lastActivityAt > this.turn.startedAt) continue;
      agent.finish('stale', agent.lastActivityAt);
    }
  }

  /**
   * Bounds what reaches the UI: every running agent, plus the most recent
   * finished ones. Older history collapses into a "+N earlier" stack in canvas
   * mode, so shipping hundreds of dead agents would be pure payload.
   */
  agentViews(now: Ms): AgentView[] {
    const running: AgentView[] = [];
    const finished: AgentView[] = [];
    for (const agent of this.agents.values()) {
      const view = agent.toView(now);
      if (agent.role === 'main' || agent.status === 'running') running.push(view);
      else finished.push(view);
    }
    finished.sort((a, b) => (b.endedAt ?? b.lastActivityAt) - (a.endedAt ?? a.lastActivityAt));
    return [...running, ...finished.slice(0, MAX_FINISHED_AGENTS)];
  }

  /** Ids no longer published, so the store can drop them. */
  prunedAgentIds(now: Ms): string[] {
    const kept = new Set(this.agentViews(now).map((view) => view.id));
    return [...this.agents.keys()].filter((id) => !kept.has(id));
  }
}

/** `export const meta = { name: '…', phases: [{ title: '…' }] }` in the script. */
function workflowName(script: string): string {
  return /name:\s*['"]([^'"]+)['"]/.exec(script)?.[1] ?? 'workflow';
}

function workflowPhases(script: string): { title: string }[] {
  const block = /phases:\s*\[([\s\S]*?)\]/.exec(script)?.[1];
  if (!block) return [];
  const titles: { title: string }[] = [];
  const re = /title:\s*['"]([^'"]+)['"]/g;
  let match = re.exec(block);
  while (match) {
    if (match[1]) titles.push({ title: match[1] });
    match = re.exec(block);
  }
  return titles;
}

/** The argument Claude Code shows in parentheses after a tool name. */
function toolArg(name: string, input: Record<string, unknown>): string {
  const pick = (key: string): string | undefined =>
    typeof input[key] === 'string' ? (input[key] as string) : undefined;
  switch (name) {
    case 'Bash':
      return (pick('command') ?? '').replace(/\s+/g, ' ').trim();
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return pick('file_path') ?? '';
    case 'Grep':
      return pick('pattern') ?? '';
    case 'Glob':
      return pick('pattern') ?? pick('path') ?? '';
    case 'Agent':
    case 'Task':
      return pick('description') ?? pick('subagent_type') ?? '';
    case 'Skill':
      return pick('skill') ?? '';
    case 'WebFetch':
      return pick('url') ?? '';
    case 'WebSearch':
    case 'ToolSearch':
      return pick('query') ?? '';
    case 'SendMessage':
      return pick('to') ?? '';
    default:
      return pick('description') ?? pick('name') ?? '';
  }
}
