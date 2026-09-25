import type { Attention, AttentionKind, SessionPhase } from '../../shared/model';

/**
 * Turns noisy evidence into a stable phase.
 *
 * Four sources disagree constantly:
 *  - the process (authoritative for "ended", useless for anything else)
 *  - the registry's status field (lags the transcript by a second or so)
 *  - cmux's hook state (the only source that sees permission prompts)
 *  - the transcript (silent for minutes while a model thinks)
 *
 * Without hysteresis the office would flicker: figures would walk to the lounge
 * during a long think, and halos would flash for auto-approved tools.
 */

export interface LivenessEvidence {
  now: number;
  /** Process is alive *and* its start time still matches the registry. */
  processAlive: boolean;
  registryStatus?: string | undefined;
  registryWaitingFor?: string | undefined;
  /** Precise attention signal from cmux's hooks, when cmux is running. */
  cmuxAttention?: { kind: AttentionKind; detail?: string } | null;
  /** A human prompt has arrived with no turn end or interrupt yet. */
  openTurn: boolean;
  /** AskUserQuestion / ExitPlanMode sitting unanswered. */
  pendingAttention?: { kind: AttentionKind; since: number; detail?: string } | null;
  /** Fallback guess: a normally fast tool has been pending too long. */
  probablePermission?: { since: number; detail?: string } | null;
  lastLineAt: number;
  foregroundSubagentRunning: boolean;
}

export interface LivenessResult {
  phase: SessionPhase;
  since: number;
  attention?: Attention;
}

const ATTENTION_DWELL_MS = 800; // absorbs instantly auto-approved tools
const IDLE_DWELL_MS = 1500;
const MIN_PHASE_MS = 1000;
const REGISTRY_TRUST_WINDOW_MS = 3000; // transcript beats a stale "idle"
const SILENT_THINK_MS = 10 * 60 * 1000;

export class LivenessMachine {
  private phase: SessionPhase = 'starting';
  private since = 0;
  private attention: Attention | undefined;
  private candidate: SessionPhase | null = null;
  private candidateSince = 0;
  private endedStrikes = 0;

  update(ev: LivenessEvidence): LivenessResult {
    if (this.since === 0) this.since = ev.now;

    // 1. Ended is final, but needs two strikes: a single kill(0) miss during
    //    process teardown would otherwise bury a session that is still writing.
    if (!ev.processAlive) {
      this.endedStrikes += 1;
      if (this.endedStrikes >= 2 || this.phase === 'ended') return this.commit('ended', ev.now, undefined);
    } else {
      this.endedStrikes = 0;
    }
    if (this.phase === 'ended') return this.result();

    const attention = this.detectAttention(ev);
    const target: SessionPhase = attention ? 'attention' : this.detectWork(ev) ? 'working' : 'idle';

    // Attention and work are entered immediately; only settling down waits.
    if (target === this.phase) {
      this.candidate = null;
      if (target === 'attention' && attention) this.attention = attention;
      return this.result();
    }

    if (target === 'attention') return this.commit('attention', ev.now, attention);
    if (target === 'working' && this.phase !== 'working') return this.commit('working', ev.now, undefined);

    // target === 'idle'
    if (this.candidate !== 'idle') {
      this.candidate = 'idle';
      this.candidateSince = ev.now;
      return this.result();
    }
    const heldLongEnough = ev.now - this.candidateSince >= IDLE_DWELL_MS;
    const dwelled = ev.now - this.since >= MIN_PHASE_MS;
    if (heldLongEnough && dwelled) return this.commit('idle', ev.now, undefined);
    return this.result();
  }

  private detectAttention(ev: LivenessEvidence): Attention | undefined {
    if (ev.cmuxAttention) {
      return {
        kind: ev.cmuxAttention.kind,
        since: ev.now,
        source: 'cmux',
        ...(ev.cmuxAttention.detail ? { detail: ev.cmuxAttention.detail } : {}),
      };
    }
    if (ev.registryStatus === 'waiting') {
      return {
        kind: 'permission',
        since: ev.now,
        source: 'registry',
        ...(ev.registryWaitingFor ? { detail: ev.registryWaitingFor } : {}),
      };
    }
    if (ev.pendingAttention && ev.now - ev.pendingAttention.since >= ATTENTION_DWELL_MS) {
      return {
        kind: ev.pendingAttention.kind,
        since: ev.pendingAttention.since,
        source: 'transcript',
        ...(ev.pendingAttention.detail ? { detail: ev.pendingAttention.detail } : {}),
      };
    }
    if (ev.probablePermission) {
      return {
        kind: 'probablePermission',
        since: ev.probablePermission.since,
        source: 'heuristic',
        ...(ev.probablePermission.detail ? { detail: ev.probablePermission.detail } : {}),
      };
    }
    return undefined;
  }

  private detectWork(ev: LivenessEvidence): boolean {
    const freshLine = ev.now - ev.lastLineAt < REGISTRY_TRUST_WINDOW_MS;
    if (ev.registryStatus === 'busy') return true;
    // The registry write lags, so a line that just landed outranks "idle".
    if (freshLine) return true;
    if (ev.foregroundSubagentRunning) return true;
    // Thinking can stay silent for minutes; only a long gap counts as idle.
    return ev.openTurn && ev.now - ev.lastLineAt < SILENT_THINK_MS;
  }

  private commit(phase: SessionPhase, now: number, attention: Attention | undefined): LivenessResult {
    if (this.phase !== phase) {
      this.phase = phase;
      this.since = now;
    }
    this.attention = attention;
    this.candidate = null;
    return this.result();
  }

  private result(): LivenessResult {
    return {
      phase: this.phase,
      since: this.since,
      ...(this.attention && this.phase === 'attention' ? { attention: this.attention } : {}),
    };
  }
}
