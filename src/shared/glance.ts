/**
 * The menu bar glance, as pure data.
 *
 * Main owns the tray title but never owns a world — only a renderer does — so
 * the popover reports counts and main formats them here. The popover sorts and
 * phrases the same sessions with the rest of this module, which keeps the one
 * line in the menu bar and the list under it saying the same thing.
 */

import { ACTIVITY_LABEL } from './activity';
import { fmtDuration } from './format';
import type { AgentView, AttentionKind, SessionPhase, SessionView } from './model';

/** The tray asks the main window to switch modes, so both sides need the names. */
export type ViewMode = 'office' | 'canvas';

export interface GlanceCounts {
  total: number;
  working: number;
  attention: number;
}

export function countGlance(sessions: readonly SessionView[]): GlanceCounts {
  let working = 0;
  let attention = 0;
  for (const session of sessions) {
    if (session.phase === 'working') working += 1;
    else if (session.phase === 'attention') attention += 1;
  }
  return { total: sessions.length, working, attention };
}

/**
 * `2● 1!` — working, then waiting on you.
 *
 * Empty when nothing is happening: an idle app should leave the menu bar as it
 * found it, icon only.
 */
export function trayTitle(counts: GlanceCounts): string {
  const parts: string[] = [];
  if (counts.working > 0) parts.push(`${counts.working}●`);
  if (counts.attention > 0) parts.push(`${counts.attention}!`);
  return parts.join(' ');
}

/** Anything that wants an answer outranks anything that is getting on with it. */
const PHASE_RANK: Record<SessionPhase, number> = {
  attention: 0,
  working: 1,
  starting: 2,
  idle: 3,
  ended: 4,
};

export const PHASE_LABEL: Record<SessionPhase, string> = {
  starting: 'starting',
  working: 'working',
  attention: 'needs you',
  idle: 'idle',
  ended: 'ended',
};

export function sortForGlance(sessions: readonly SessionView[]): SessionView[] {
  return [...sessions].sort((a, b) => {
    const rank = PHASE_RANK[a.phase] - PHASE_RANK[b.phase];
    if (rank !== 0) return rank;
    // Among the blocked ones, whoever has been waiting longest gets answered first.
    if (a.phase === 'attention') {
      return (a.attention?.since ?? a.phaseSince) - (b.attention?.since ?? b.phaseSince);
    }
    if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
    return a.id.localeCompare(b.id);
  });
}

const ATTENTION_PHRASE: Record<AttentionKind, string> = {
  permission: 'Waiting for permission',
  question: 'Asking you a question',
  planApproval: 'Waiting on plan approval',
  probablePermission: 'Probably waiting for permission',
};

/**
 * The one line under a session's name: what its main agent is doing right now.
 *
 * A blocked session says what it is blocked on instead, and a quiet one says
 * how long it has been quiet — repeating "idle" next to the idle chip tells
 * nobody anything.
 */
export function glancePhrase(
  session: SessionView,
  agent: AgentView | undefined,
  now: number,
  /**
   * The session's subagents. A session that has handed its work to a fan-out
   * has a main agent sitting idle while a great deal happens, and reporting
   * that as "Quiet for 3s" next to a WORKING tag is a flat contradiction —
   * which is exactly what it said before this argument existed.
   */
  helpers: readonly AgentView[] = [],
): string {
  if (session.phase === 'attention') {
    return ATTENTION_PHRASE[session.attention?.kind ?? 'permission'];
  }
  if (session.phase === 'ended') return 'Ended';

  const activity = agent?.activity;
  if (agent && activity && activity !== 'idle' && activity !== 'offline') {
    return capitalize(agent.activityDetail?.label ?? ACTIVITY_LABEL[activity]);
  }

  const busy = helpers.filter(
    (helper) =>
      helper.id !== agent?.id &&
      helper.status === 'running' &&
      helper.activity !== 'idle' &&
      helper.activity !== 'offline',
  );
  // One is worth naming; a fan-out of six is not a sentence, it is a number.
  const only = busy[0];
  if (busy.length === 1 && only) {
    return capitalize(only.activityDetail?.label ?? ACTIVITY_LABEL[only.activity]);
  }
  if (busy.length > 1) return `${busy.length} agents working`;

  return `Quiet for ${fmtDuration(Math.max(0, now - session.lastActivityAt))}`;
}

/** The header line: totals, worth reading in one glance or not at all. */
export function glanceSummary(counts: GlanceCounts): string {
  if (counts.total === 0) return 'Nothing running';
  const parts = [`${counts.total} session${counts.total === 1 ? '' : 's'}`];
  if (counts.working > 0) parts.push(`${counts.working} working`);
  if (counts.attention > 0) parts.push(`${counts.attention} needs you`);
  if (counts.working === 0 && counts.attention === 0) parts.push('all quiet');
  return parts.join(' · ');
}

function capitalize(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}
