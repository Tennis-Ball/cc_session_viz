/**
 * Engine <-> renderer protocol. Messages travel over a MessagePort handed out by
 * the main process, so they are structured-cloned rather than JSON encoded.
 */

import type { VisualEvent } from './events';
import type {
  AgentView,
  DataMode,
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
  /**
   * Settings the engine needs, rather than the renderer.
   *
   * Both of these decide which sessions *exist*, not how they are drawn, so
   * they have to be applied where slots are tracked. Sent once prefs have
   * hydrated and again whenever either changes.
   */
  | { type: 'setOptions'; hideSdkSessions: boolean; endedGraceMs: number }
  | { type: 'resync' };
