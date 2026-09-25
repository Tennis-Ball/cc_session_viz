/**
 * Display-ready transcript entries: the input to the Claude Code TUI replica.
 * Payloads are already truncated here, so the renderer never holds megabytes.
 */

import type { Ms } from './model';

export type ToolStatus = 'pending' | 'ok' | 'error' | 'denied' | 'interrupted';

export interface ToolResultPreview {
  /** At most 8 lines / 4 KB. */
  head: string[];
  totalLines: number;
  summary?: string;
}

export type TranscriptEntry =
  | {
      k: 'user';
      id: string;
      at: Ms;
      text: string;
      source: 'typed' | 'queued' | 'system';
      images: number;
      pasted: number;
    }
  | { k: 'text'; id: string; at: Ms; text: string }
  | { k: 'thinking'; id: string; at: Ms; text: string | null; tokens?: number }
  | {
      k: 'tool';
      id: string; // toolUseId
      at: Ms;
      name: string;
      title: string; // "Bash", "Read", "Agent"
      arg: string; // rendered argument, already shortened
      status: ToolStatus;
      result?: ToolResultPreview;
      agentId?: string;
      bgTaskId?: string;
      diff?: { added: number; removed: number; hunk?: string[] };
    }
  | { k: 'turnEnd'; id: string; at: Ms; durationMs: number; verbSeed: number }
  | { k: 'compact'; id: string; at: Ms; trigger: string; pre: number; post: number }
  | { k: 'interrupt'; id: string; at: Ms; forTool: boolean }
  | {
      k: 'notice';
      id: string;
      at: Ms;
      level: 'info' | 'warning' | 'error';
      text: string;
      origin: 'system' | 'awaySummary' | 'refusalFallback' | 'hook' | 'localCommand';
    }
  | {
      k: 'inbound';
      id: string;
      at: Ms;
      from: string;
      via: 'task' | 'peer' | 'coordinator' | 'crossSession';
      text: string;
    }
  | { k: 'divider'; id: string; at: Ms; reason: 'clear' | 'resume'; sessionId: string };

export type TranscriptEntryKind = TranscriptEntry['k'];
