import type { Activity } from '../../shared/activity';
import { modelInfo } from '../../shared/format';
import type { AgentRole, AgentStatus, AgentView, ModelInfo, Ms } from '../../shared/model';
import type { ToolActivity } from '../parse/toolActivity';

/** A tool call that has not produced a result yet. */
export interface PendingTool {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
  at: Ms;
  activity: ToolActivity;
}

export interface AgentInit {
  id: string;
  slotId: string;
  role: AgentRole;
  agentType: string;
  description: string;
  parentId?: string;
  depth: number;
  background: boolean;
  isFork: boolean;
  workflowRunId?: string;
  phaseIndex?: number;
  model?: string;
  name?: string;
  startedAt: Ms;
  ambient: boolean;
}

/**
 * One agent's live state: the main conversation or a subagent.
 *
 * Usage is deduped by message id because a single API response is written as
 * one line per content block, each repeating the same usage object.
 */
export class AgentRuntime {
  readonly id: string;
  readonly slotId: string;
  readonly role: AgentRole;
  agentType: string;
  description: string;
  parentId: string | undefined;
  depth: number;
  background: boolean;
  isFork: boolean;
  workflowRunId: string | undefined;
  phaseIndex: number | undefined;
  name: string | undefined;
  model: ModelInfo;
  status: AgentStatus = 'running';
  activity: Activity = 'thinking';
  activityDetail: AgentView['activityDetail'];
  startedAt: Ms;
  endedAt: Ms | undefined;
  lastActivityAt: Ms;
  resultPreview: string | undefined;
  readonly pending = new Map<string, PendingTool>();

  private tokens = 0;
  private toolUses = 0;
  private readonly seenMessages = new Set<string>();
  private readonly ambient: boolean;

  constructor(init: AgentInit) {
    this.id = init.id;
    this.slotId = init.slotId;
    this.role = init.role;
    this.agentType = init.agentType;
    this.description = init.description;
    this.parentId = init.parentId;
    this.depth = init.depth;
    this.background = init.background;
    this.isFork = init.isFork;
    this.workflowRunId = init.workflowRunId;
    this.phaseIndex = init.phaseIndex;
    this.name = init.name;
    this.model = modelInfo(init.model);
    this.startedAt = init.startedAt;
    this.lastActivityAt = init.startedAt;
    this.ambient = init.ambient;
  }

  setActivity(activity: Activity, at: Ms, detail?: ToolActivity & { toolUseId?: string }): void {
    this.activity = activity;
    this.lastActivityAt = at;
    this.activityDetail = detail
      ? {
          tool: detail.label,
          label: detail.label,
          since: at,
          ...(detail.target ? { target: detail.target } : {}),
          ...(detail.toolUseId ? { toolUseId: detail.toolUseId } : {}),
        }
      : undefined;
  }

  /**
   * A progress ping from a background agent.
   *
   * It carries a sentence about what the agent is doing right now, which no
   * other line in the transcript does, and it doubles as proof of life — a
   * background agent that is quiet but still pinging must not be swept away as
   * stale.
   */
  noteProgress(summary: string | undefined, at: Ms): void {
    this.lastActivityAt = at;
    if (!summary) return;
    this.activityDetail = {
      tool: this.activityDetail?.tool ?? 'Agent',
      label: summary,
      since: at,
      ...(this.activityDetail?.toolUseId ? { toolUseId: this.activityDetail.toolUseId } : {}),
    };
  }

  /** Returns true the first time this message id is seen, for usage dedupe. */
  noteMessage(messageId: string): boolean {
    if (this.seenMessages.has(messageId)) return false;
    this.seenMessages.add(messageId);
    // Bound the set: only recent ids matter for dedupe.
    if (this.seenMessages.size > 512) {
      const first = this.seenMessages.values().next().value;
      if (first) this.seenMessages.delete(first);
    }
    return true;
  }

  addTokens(n: number): void {
    this.tokens += n;
  }

  countToolUse(): void {
    this.toolUses += 1;
  }

  setStats(stats: { tokens?: number; toolUses?: number; durationMs?: number }): void {
    if (stats.tokens !== undefined) this.tokens = stats.tokens;
    if (stats.toolUses !== undefined) this.toolUses = stats.toolUses;
    if (stats.durationMs !== undefined) this.endedAt = this.startedAt + stats.durationMs;
  }

  finish(status: AgentStatus, at: Ms, preview?: string): void {
    this.status = status;
    this.endedAt = at;
    this.activity = 'idle';
    this.activityDetail = undefined;
    this.pending.clear();
    if (preview) this.resultPreview = preview;
  }

  revive(at: Ms): void {
    this.status = 'running';
    this.endedAt = undefined;
    this.lastActivityAt = at;
  }

  setModel(id: string, window?: number): boolean {
    // `<synthetic>` is what API error lines carry; it is not a model switch.
    if (!id || id.startsWith('<')) return false;
    const next = modelInfo(id);
    if (window) next.window = window;
    const changed = next.id !== this.model.id;
    this.model = next;
    return changed;
  }

  toView(now: Ms): AgentView {
    return {
      id: this.id,
      slotId: this.slotId,
      ambient: this.ambient,
      role: this.role,
      agentType: this.agentType,
      description: this.description,
      depth: this.depth,
      background: this.background,
      isFork: this.isFork,
      model: this.model,
      status: this.status,
      activity: this.activity,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      stats: {
        tokens: this.tokens,
        toolUses: this.toolUses,
        durationMs: (this.endedAt ?? now) - this.startedAt,
      },
      ...(this.name ? { name: this.name } : {}),
      ...(this.parentId ? { parentId: this.parentId } : {}),
      ...(this.workflowRunId ? { workflowRunId: this.workflowRunId } : {}),
      ...(this.phaseIndex !== undefined ? { phaseIndex: this.phaseIndex } : {}),
      ...(this.activityDetail ? { activityDetail: this.activityDetail } : {}),
      ...(this.endedAt ? { endedAt: this.endedAt } : {}),
      ...(this.resultPreview ? { resultPreview: this.resultPreview } : {}),
    };
  }
}

/** Claude Code's built-in agent types map to distinct office silhouettes. */
export function roleFor(agentType: string | undefined, isFork: boolean, workflowRunId?: string): AgentRole {
  if (isFork) return 'fork';
  if (workflowRunId) return 'workflow';
  switch (agentType) {
    case 'general-purpose':
      return 'general-purpose';
    case 'Explore':
      return 'Explore';
    case 'Plan':
      return 'Plan';
    case 'fork':
      return 'fork';
    case 'workflow-subagent':
      return 'workflow';
    default:
      return 'custom';
  }
}
