/**
 * The normalized world the UI renders. Nothing in here knows about JSONL field
 * names: `engine/parse/normalize.ts` is the only module that does.
 */

import type { Activity } from './activity';

export type Ms = number;

/**
 * Identity of a *terminal process* running Claude Code, stable across /clear and
 * /resume (both of which change the sessionId while the pid stays put).
 */
export type SlotId = string; // `${pid}@${startedAt}`
export type AgentId = string; // `main@${slotId}` for the main agent, else the raw agentId

export type SessionPhase = 'starting' | 'working' | 'attention' | 'idle' | 'ended';

export type AttentionKind = 'permission' | 'question' | 'planApproval' | 'probablePermission';

export interface Attention {
  kind: AttentionKind;
  since: Ms;
  /** Where the signal came from; heuristics get softer visuals than facts. */
  source: 'cmux' | 'registry' | 'transcript' | 'heuristic';
  detail?: string;
}

export type ModelFamily = 'haiku' | 'sonnet' | 'opus' | 'fable' | 'unknown';

export interface ModelInfo {
  id: string;
  family: ModelFamily;
  label: string; // "Opus 5"
  tier: 0 | 1 | 2 | 3; // haiku..fable, drives figure size
  window: number; // context window in tokens
}

export interface SessionChainLink {
  sessionId: string;
  reason: 'start' | 'clear' | 'resume';
  at: Ms;
}

export interface ContextState {
  used: number;
  window: number;
  pct: number;
  autoCompactPct: number;
  compacting: 'no' | 'probable' | 'confirmed';
  lastCompact?: { at: Ms; trigger: string; pre: number; post: number; durationMs: number };
}

export interface TurnState {
  startedAt: Ms;
  outputTokens: number;
  toolUses: number;
  /** Chooses the "Brewed"/"Cogitated" verb deterministically. */
  verbSeed: number;
  activeForm?: string;
}

export type ConditionKind = 'apiError' | 'rateLimited' | 'refusalFallback' | 'hookError' | 'maxTokens';

export interface Condition {
  kind: ConditionKind;
  since: Ms;
  detail?: string;
}

export interface TaskItem {
  id: string;
  subject: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface SessionView {
  id: SlotId;
  /** Synthetic sessions from ambient mode are flagged, never disguised as real. */
  ambient: boolean;
  pid: number;
  startedAt: Ms;
  version: string;
  sessionId: string;
  sessionChain: SessionChainLink[];
  cwd: string;
  repo: string;
  gitBranch?: string;
  worktree?: { name: string; branch: string; path: string };
  title: string;
  titleSource: 'registry' | 'agentName' | 'aiTitle' | 'cwd';
  formerNames: string[];
  phase: SessionPhase;
  phaseSince: Ms;
  attention?: Attention;
  unread: boolean;
  lastActivityAt: Ms;
  mainAgentId: AgentId;
  model: ModelInfo;
  effort?: string;
  ultra: boolean;
  fast: boolean;
  permissionMode: string;
  plan?: { filePath?: string; awaitingApproval: boolean };
  context: ContextState;
  turn?: TurnState;
  lastTurn?: { endedAt: Ms; durationMs: number; verbSeed: number };
  queue: { count: number; previews: string[] };
  tasks: TaskItem[];
  prs: { number: number; url: string; repo: string }[];
  remote?: { bridgeSessionId: string; connected: boolean };
  conditions: Condition[];
  cost?: { usd: number; linesAdded: number; linesRemoved: number };
  awaySummary?: { at: Ms; text: string };
  cmux?: { workspaceId: string; workspaceTitle?: string; surfaceId?: string };
  groupId?: string;
  colorIndex: number;
}

export type AgentRole = 'main' | 'general-purpose' | 'Explore' | 'Plan' | 'workflow' | 'fork' | 'custom';
export type AgentStatus = 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'stale';

export interface AgentView {
  id: AgentId;
  slotId: SlotId;
  ambient: boolean;
  role: AgentRole;
  agentType: string;
  name?: string;
  description: string;
  parentId?: AgentId;
  depth: number;
  spawnToolUseId?: string;
  background: boolean;
  isFork: boolean;
  workflowRunId?: string;
  phaseIndex?: number;
  model: ModelInfo;
  status: AgentStatus;
  activity: Activity;
  activityDetail?: { tool: string; label: string; target?: string; toolUseId?: string; since: Ms };
  startedAt: Ms;
  endedAt?: Ms;
  lastActivityAt: Ms;
  stats: { tokens: number; toolUses: number; durationMs: number };
  resultPreview?: string;
}

export interface WorkflowPhase {
  index: number;
  title: string;
  detail?: string;
  status: 'pending' | 'active' | 'done';
  agentIds: AgentId[];
}

export interface WorkflowRun {
  runId: string;
  slotId: SlotId;
  parentAgentId: AgentId;
  toolUseId?: string;
  name: string;
  description?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  phases: WorkflowPhase[];
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  startedAt: Ms;
  durationMs?: number;
}

export type WatchKind = 'bash' | 'monitor' | 'wakeup' | 'cron' | 'bgAgentWait';

export interface WatchTask {
  id: string;
  slotId: SlotId;
  ownerAgentId: AgentId;
  kind: WatchKind;
  label: string;
  startedAt: Ms;
  until?: Ms;
  recurring?: boolean;
  persistent?: boolean;
  status: 'active' | 'fired' | 'completed' | 'failed' | 'stopped' | 'expired';
  eventCount: number;
  lastEventAt?: Ms;
  exitCode?: number;
}

export type Endpoint =
  | { kind: 'session'; slotId: SlotId }
  | { kind: 'agent'; agentId: AgentId }
  | { kind: 'external'; label: string };

export type MessageKind =
  | 'crossSession'
  | 'coordinator'
  | 'agentToMain'
  | 'handback'
  | 'resume'
  | 'idleNotice'
  | 'deliveryNotice';

export interface MessageLink {
  id: string;
  kind: MessageKind;
  from: Endpoint;
  to: Endpoint;
  preview: string;
  at: Ms;
  observed: 'sender' | 'recipient' | 'both';
  delivered?: boolean;
}

export type GroupRule =
  | { kind: 'slot'; slotId: SlotId }
  | { kind: 'session'; sessionId: string }
  | { kind: 'cwd'; path: string };

export interface Group {
  id: string;
  name: string;
  colorIndex: number;
  rules: GroupRule[];
  members: SlotId[];
  createdAt: Ms;
}

export interface UsageBar {
  id: string;
  label: string;
  /** Percent of the limit consumed: the only unit the account reports. */
  pct: number;
  resetsAt?: Ms;
  /** The account's own word for how close this limit is, e.g. `locked`. */
  severity?: string;
  /** The limit the account is actually being measured against right now. */
  binding?: boolean;
}

/**
 * Why the panel looks the way it does.
 *
 * The account is the only source of these numbers, so everything other than
 * `live` is a failure the panel names out loud. Nothing here is ever papered
 * over with a locally computed guess: a wrong number the user believes is worse
 * than a missing number they can act on.
 */
export type UsageState =
  | 'live'
  | 'signedOut'
  | 'expired'
  | 'noAccess'
  | 'offline'
  | 'timedOut'
  | 'unreadable'
  | 'serverError';

export interface UsageSnapshot {
  state: UsageState;
  /**
   * The last numbers the account gave, kept across a failed refresh so a flaky
   * minute does not blank the panel. Empty until the account has answered once.
   */
  bars: UsageBar[];
  /** When `bars` were read. 0 when the account has never answered this run. */
  updatedAt: Ms;
  account?: string;
  /** Context for a state that has some, e.g. `HTTP 503`. Never token material. */
  detail?: string;
}

/**
 * What the app is showing.
 *
 * Exclusive by design: the simulation is generated, and never contains or
 * borrows from a real session.
 */
export type DataMode = 'real' | 'simulation';

export interface WorldHealth {
  source: 'live' | 'sim' | 'replay';
  mode: DataMode;
  /** Set from the environment, which beats whatever the prefs file remembers. */
  modeLocked: boolean;
  ambientActive: boolean;
  /**
   * The simulation's seed. Everything the generated office does follows from
   * it, so it is the one number worth being able to read back: setting
   * `CCV_SIM_SEED` to it brings the same office back.
   */
  simSeed: number;
  cmux: boolean;
  lagMs: number;
  unknownSignals: number;
}

export interface World {
  rev: number;
  sessions: Record<SlotId, SessionView>;
  agents: Record<AgentId, AgentView>;
  workflows: Record<string, WorkflowRun>;
  watches: Record<string, WatchTask>;
  links: MessageLink[];
  groups: Record<string, Group>;
  usage: UsageSnapshot | null;
  health: WorldHealth;
}

export function emptyWorld(): World {
  return {
    rev: 0,
    sessions: {},
    agents: {},
    workflows: {},
    watches: {},
    links: [],
    groups: {},
    usage: null,
    health: {
      source: 'live',
      mode: 'real',
      modeLocked: false,
      ambientActive: false,
      simSeed: 0,
      cmux: false,
      lagMs: 0,
      unknownSignals: 0,
    },
  };
}
