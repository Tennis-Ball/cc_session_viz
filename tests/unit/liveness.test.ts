import { describe, expect, it } from 'vitest';
import { LivenessMachine, type LivenessEvidence } from '@engine/state/liveness';

const BASE: LivenessEvidence = {
  now: 0,
  processAlive: true,
  openTurn: false,
  lastLineAt: 0,
  foregroundSubagentRunning: false,
};

function evidence(now: number, patch: Partial<LivenessEvidence> = {}): LivenessEvidence {
  return { ...BASE, now, lastLineAt: patch.lastLineAt ?? 0, ...patch };
}

describe('LivenessMachine', () => {
  it('goes to work the moment the registry says busy', () => {
    const fsm = new LivenessMachine();
    expect(fsm.update(evidence(1000, { registryStatus: 'busy' })).phase).toBe('working');
  });

  it('waits before settling into idle, so a pause mid-turn does not empty the desk', () => {
    const fsm = new LivenessMachine();
    fsm.update(evidence(0, { registryStatus: 'busy' }));

    expect(fsm.update(evidence(5000, { registryStatus: 'idle' })).phase).toBe('working');
    expect(fsm.update(evidence(6000, { registryStatus: 'idle' })).phase).toBe('working');
    expect(fsm.update(evidence(6600, { registryStatus: 'idle' })).phase).toBe('idle');
  });

  it('trusts a fresh transcript line over a stale "idle" registry write', () => {
    const fsm = new LivenessMachine();
    const result = fsm.update(evidence(10_000, { registryStatus: 'idle', lastLineAt: 9_000 }));
    expect(result.phase).toBe('working');
  });

  it('keeps a silently thinking session at work for minutes', () => {
    const fsm = new LivenessMachine();
    fsm.update(evidence(0, { openTurn: true, lastLineAt: 0 }));
    // Thinking can go ~3 minutes without writing a line.
    expect(fsm.update(evidence(200_000, { openTurn: true, lastLineAt: 0 })).phase).toBe('working');
    // Ten minutes of silence with no registry support settles to idle, after
    // the usual dwell so a single quiet sample can't empty the desk.
    fsm.update(evidence(700_000, { openTurn: true, lastLineAt: 0 }));
    expect(fsm.update(evidence(702_000, { openTurn: true, lastLineAt: 0 })).phase).toBe('idle');
  });

  it('ignores an attention signal that resolves instantly', () => {
    const fsm = new LivenessMachine();
    fsm.update(evidence(0, { registryStatus: 'busy' }));
    // A tool that is auto-approved 200ms later must never raise the halo.
    const pending = { kind: 'question' as const, since: 1000 };
    expect(fsm.update(evidence(1200, { registryStatus: 'busy', pendingAttention: pending })).phase).toBe('working');
    expect(fsm.update(evidence(1400, { registryStatus: 'busy' })).phase).toBe('working');
  });

  it('raises attention once a prompt has been waiting, and drops it immediately after', () => {
    const fsm = new LivenessMachine();
    fsm.update(evidence(0, { registryStatus: 'busy' }));
    const pending = { kind: 'planApproval' as const, since: 1000 };

    const raised = fsm.update(evidence(2000, { registryStatus: 'busy', pendingAttention: pending }));
    expect(raised.phase).toBe('attention');
    expect(raised.attention).toMatchObject({ kind: 'planApproval', source: 'transcript' });

    expect(fsm.update(evidence(2100, { registryStatus: 'busy' })).phase).toBe('working');
  });

  it('prefers cmux, which is the only source that sees permission prompts', () => {
    const fsm = new LivenessMachine();
    const result = fsm.update(
      evidence(1000, { registryStatus: 'busy', cmuxAttention: { kind: 'permission', detail: 'Edit' } }),
    );
    expect(result.attention).toMatchObject({ kind: 'permission', source: 'cmux', detail: 'Edit' });
  });

  it('labels the guessed permission prompt as a heuristic', () => {
    const fsm = new LivenessMachine();
    const result = fsm.update(evidence(20_000, { registryStatus: 'busy', probablePermission: { since: 9_000 } }));
    expect(result.attention).toMatchObject({ kind: 'probablePermission', source: 'heuristic' });
  });

  it('needs two misses before declaring a session ended, then stays ended', () => {
    const fsm = new LivenessMachine();
    fsm.update(evidence(0, { registryStatus: 'busy' }));

    expect(fsm.update(evidence(1000, { processAlive: false })).phase).not.toBe('ended');
    expect(fsm.update(evidence(2000, { processAlive: false })).phase).toBe('ended');
    // Even if the pid is reused by something else, the session stays gone.
    expect(fsm.update(evidence(3000, { processAlive: true, registryStatus: 'busy' })).phase).toBe('ended');
  });
});
