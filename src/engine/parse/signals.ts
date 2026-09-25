import type { Ms } from '../../shared/model';

/**
 * Signals are the engine's internal vocabulary: everything the reducers care
 * about, with none of Claude Code's field names. `normalize.ts` is the only
 * place that translates, so a transcript format change is a one-file fix.
 */

export interface TaskNotification {
  taskId: string;
  toolUseId?: string;
  status?: string;
  summary?: string;
  result?: string;
  tokens?: number;
  toolUses?: number;
  durationMs?: number;
  /** Monitor events reuse the envelope with an <event> payload. */
  event?: string;
}

export type Signal = { at: Ms } & (
  | { s: 'envelope'; cwd?: string; version?: string; gitBranch?: string; sessionId?: string; agentId?: string }
  | { s: 'title'; kind: 'aiTitle' | 'agentName' | 'lastPrompt'; value: string }
  | { s: 'permissionMode'; mode: string }
  | { s: 'bridge'; bridgeSessionId: string | null }
  | { s: 'prLink'; number: number; url: string; repo: string }
  | { s: 'cost'; usd: number; linesAdded: number; linesRemoved: number }
  | { s: 'worktree'; name: string; branch: string; path: string; originalCwd?: string }
  | { s: 'relocated'; cwd: string }
  | { s: 'prompt'; text: string; source: 'typed' | 'queued' | 'system'; images: number; pasted: number }
  | { s: 'inbound'; via: 'task' | 'peer' | 'coordinator' | 'crossSession'; from: string; text: string }
  | { s: 'text'; messageId: string; text: string }
  | { s: 'thinking'; messageId: string; text: string | null; tokens?: number }
  | { s: 'toolUse'; messageId: string; id: string; name: string; input: Record<string, unknown> }
  | {
      s: 'toolResult';
      id: string;
      isError: boolean;
      denial?: string;
      text: string;
      result?: Record<string, unknown>;
    }
  | {
      s: 'usage';
      messageId: string;
      model: string;
      used: number;
      output: number;
      thinkingTokens?: number;
      effort?: string;
      speed?: string;
      error?: string;
      stopReason?: string;
      apiError?: boolean;
    }
  | { s: 'turnEnd'; durationMs: number; messageCount?: number }
  | { s: 'compact'; trigger: string; pre: number; post: number; durationMs?: number }
  | { s: 'queueOp'; op: string; content: string }
  | { s: 'modelAttachment'; modelId: string; marketingName?: string }
  | { s: 'planMode'; state: 'enter' | 'exit' | 'reentry'; planFilePath?: string }
  | { s: 'autoMode'; enabled: boolean }
  | { s: 'effortMode'; ultra: boolean }
  | { s: 'tasks'; items: { id: string; subject: string; activeForm?: string; status: string }[] }
  | {
      s: 'notice';
      level: 'info' | 'warning' | 'error';
      text: string;
      origin: 'system' | 'awaySummary' | 'refusalFallback' | 'hook' | 'localCommand';
    }
  | { s: 'interrupt'; forTool: boolean }
  | { s: 'hook'; ok: boolean; detail?: string }
  | { s: 'scheduledFire'; taskId: string; kind?: string; cron?: string }
  | { s: 'taskNotification'; notification: TaskNotification }
  /**
   * A live progress ping for a background agent, which Claude Code drops into
   * the transcript while it waits. It is the only *running* progress text there
   * is — everything else about a subagent arrives when it finishes.
   */
  | {
      s: 'agentProgress';
      taskId: string;
      status: string;
      description?: string;
      summary?: string;
    }
  | { s: 'remoteChange'; connected: boolean }
  | { s: 'unknown'; kind: string }
);

export type SignalKind = Signal['s'];

/**
 * A signal without its timestamp. The distribution matters: a plain
 * `Omit<Signal, 'at'>` would collapse the union down to its shared keys.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type SignalBody = DistributiveOmit<Signal, 'at'>;
