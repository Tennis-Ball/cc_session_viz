/**
 * Transient events that drive choreography and sound.
 *
 * Invariant: every visible *state* is recoverable from `World` alone. Losing
 * events only costs an animation, which is why they are dropped while hidden.
 */

import type { AgentId, AgentStatus, MessageLink, Ms, SlotId } from './model';
import type { Activity } from './activity';

export type VisualEvent = { at: Ms } & (
  | { t: 'sessionAppeared'; slot: SlotId }
  | { t: 'sessionEnded'; slot: SlotId }
  | { t: 'cleared'; slot: SlotId }
  | { t: 'resumed'; slot: SlotId }
  | { t: 'renamed'; slot: SlotId; from: string; to: string }
  | { t: 'turnStarted'; slot: SlotId; preview: string }
  | { t: 'turnEnded'; slot: SlotId; durationMs: number }
  | { t: 'toolStarted'; agent: AgentId; tool: string; activity: Activity; label: string; toolUseId: string }
  | { t: 'toolFinished'; agent: AgentId; toolUseId: string; ok: boolean }
  | { t: 'subagentSpawned'; parent: AgentId; child: AgentId }
  | { t: 'subagentFinished'; agent: AgentId; status: AgentStatus }
  | { t: 'subagentRevived'; agent: AgentId }
  | { t: 'workflowStarted'; runId: string }
  | { t: 'workflowPhase'; runId: string; index: number }
  | { t: 'workflowEnded'; runId: string }
  | { t: 'compactProbable'; slot: SlotId }
  | { t: 'compacted'; slot: SlotId; pre: number; post: number; trigger: string }
  | { t: 'message'; link: MessageLink }
  | { t: 'watchStarted'; watch: string }
  | { t: 'watchPulse'; watch: string }
  | { t: 'watchEnded'; watch: string }
  | { t: 'wakeupFired'; watch: string }
  | { t: 'interrupted'; slot: SlotId }
  | { t: 'denied'; agent: AgentId; kind: string }
  | { t: 'apiError'; agent: AgentId; kind: string }
  | { t: 'modelChanged'; agent: AgentId; from: string; to: string }
  | { t: 'promptQueued'; slot: SlotId }
  | { t: 'prLinked'; slot: SlotId; number: number }
  | { t: 'skillUsed'; agent: AgentId; skill: string }
  | { t: 'hook'; slot: SlotId; ok: boolean }
  | { t: 'fileEdited'; agent: AgentId; path: string }
  | { t: 'published'; agent: AgentId }
);

export type VisualEventType = VisualEvent['t'];
