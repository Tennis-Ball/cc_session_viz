/**
 * The title bar's session counter, as pure data.
 *
 * The chip and the legend under it have to agree about which dots exist: a
 * legend that explains a dot the chip never draws, or misses one it does, is
 * worse than no legend at all, so both read this module and a test holds them
 * together.
 */

import { PHASE_LABEL } from '@shared/glance';
import type { GlanceCounts } from '@shared/glance';
import type { SessionView } from '@shared/model';

/** The three states the chip has a dot for; `starting` and `ended` never get one. */
export type CounterPhase = 'working' | 'attention' | 'idle';

export interface CounterCounts extends GlanceCounts {
  idle: number;
}

export function counterCounts(sessions: readonly SessionView[]): CounterCounts {
  let working = 0;
  let attention = 0;
  let idle = 0;
  for (const session of sessions) {
    if (session.phase === 'working') working += 1;
    else if (session.phase === 'attention') attention += 1;
    else if (session.phase === 'idle') idle += 1;
  }
  return { total: sessions.length, working, attention, idle };
}

export interface CounterDot {
  phase: CounterPhase;
  count: number;
}

/**
 * What the chip draws: the work dot, then anything blocked.
 *
 * Two dots at most. The first one turns grey and counts the quiet sessions
 * when nothing is running, because a chip that emptied itself would read as
 * broken rather than as calm; the attention dot appears only when something is
 * genuinely waiting on an answer.
 */
export function counterDots(counts: CounterCounts): CounterDot[] {
  const dots: CounterDot[] = [
    counts.working > 0 ? { phase: 'working', count: counts.working } : { phase: 'idle', count: counts.idle },
  ];
  if (counts.attention > 0) dots.push({ phase: 'attention', count: counts.attention });
  return dots;
}

export interface LegendEntry {
  phase: CounterPhase;
  name: string;
  /** What puts a session in this state, in the words the app uses elsewhere. */
  why: string;
}

/**
 * Named from PHASE_LABEL so the legend reads as a key to the session rows
 * below it, which are labelled from the same map.
 */
export const COUNTER_LEGEND: readonly LegendEntry[] = [
  {
    phase: 'working',
    name: PHASE_LABEL.working,
    why: 'a turn is running — thinking, editing, calling tools',
  },
  {
    phase: 'attention',
    name: PHASE_LABEL.attention,
    why: 'stopped on a permission, a question or a plan',
  },
  {
    phase: 'idle',
    name: PHASE_LABEL.idle,
    why: 'nothing running; waiting on your next message',
  },
];

/** Clamped: a context window can be overshot, and a 103% bar is nonsense. */
export function contextPercent(pct: number): number {
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** The tray's thresholds, so a session is never amber there and green here. */
export function contextLevel(pct: number): 'ok' | 'warn' | 'crit' {
  if (pct >= 85) return 'crit';
  if (pct >= 60) return 'warn';
  return 'ok';
}
