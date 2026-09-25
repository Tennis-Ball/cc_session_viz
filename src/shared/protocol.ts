/**
 * Engine <-> renderer protocol. Messages travel over a MessagePort handed out by
 * the main process, so they are structured-cloned rather than JSON encoded.
 */

import type { VisualEvent } from './events';
import type {
  AgentView,
  DataMode,
  Group,
  MessageLink,
  SessionView,
  SlotId,
  UsageSnapshot,
  WatchTask,
  WorkflowRun,
  World,
  WorldHealth,
} from './model';
import type { TranscriptEntry } from './transcript';

export const PROTOCOL_VERSION = 1;

/** Flush cadence, picked by window state. */
export const FLUSH_MS = { focused: 100, visible: 500, hidden: 2000 } as const;
export const EVENT_BATCH_MS = 50;
export const TRANSCRIPT_FLUSH_MS = 250;

export interface EntityPatch<T> {
  upsert?: T[];
  remove?: string[];
}

export type EngineMsg =
  | { type: 'hello'; protocol: number; world: World }
  | {
      type: 'patch';
      rev: number;
      baseRev: number;
      sessions?: EntityPatch<SessionView>;
      agents?: EntityPatch<AgentView>;
      workflows?: EntityPatch<WorkflowRun>;
      watches?: EntityPatch<WatchTask>;
      groups?: EntityPatch<Group>;
      links?: { append: MessageLink[] };
      usage?: UsageSnapshot | null;
      health?: WorldHealth;
    }
  | { type: 'events'; events: VisualEvent[] }
  | {
      type: 'transcript';
      /** A SlotId (main transcript) or an AgentId (subagent transcript). */
      id: string;
      reset?: boolean;
      append?: TranscriptEntry[];
      update?: TranscriptEntry[];
      /** True while older entries remain on disk. */
      hasMore?: boolean;
    };

export type UiMsg =
  | { type: 'subscribeTranscripts'; ids: string[]; depth: 'tail' | 'full' }
  | { type: 'visibility'; visible: boolean; focused: boolean }
  | { type: 'markSeen'; slot: SlotId }
  | { type: 'loadEarlier'; id: string; beforeEntryId: string }
  | { type: 'setDataMode'; mode: DataMode }
  | { type: 'resync' };
