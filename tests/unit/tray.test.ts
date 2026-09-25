import { describe, expect, it } from 'vitest';
import { modelInfo } from '@shared/format';
import {
  countGlance,
  glancePhrase,
  glanceSummary,
  sortForGlance,
  trayTitle,
  type GlanceCounts,
} from '@shared/glance';
import type { AgentView, SessionView } from '@shared/model';

function session(id: string, patch: Partial<SessionView> = {}): SessionView {
  return {
    id,
    ambient: false,
    pid: 1,
    startedAt: 1000,
    version: '2.1.277',
    sessionId: `sid-${id}`,
    sessionChain: [],
    cwd: `/code/${id}`,
    repo: id,
    title: id,
    titleSource: 'registry',
    formerNames: [],
    phase: 'idle',
    phaseSince: 0,
    unread: false,
    lastActivityAt: 0,
    mainAgentId: `main@${id}`,
    model: modelInfo('claude-opus-5'),
    ultra: false,
    fast: false,
    permissionMode: 'auto',
    context: { used: 0, window: 1_000_000, pct: 0, autoCompactPct: 80, compacting: 'no' },
    queue: { count: 0, previews: [] },
    tasks: [],
    prs: [],
    conditions: [],
    colorIndex: 0,
    ...patch,
  };
}

function mainAgent(slotId: string, patch: Partial<AgentView> = {}): AgentView {
  return {
    id: `main@${slotId}`,
    slotId,
    ambient: false,
    role: 'main',
    agentType: 'main',
    description: '',
    depth: 0,
    background: false,
    isFork: false,
    model: modelInfo('claude-opus-5'),
    status: 'running',
    activity: 'idle',
    startedAt: 1000,
    lastActivityAt: 1000,
    stats: { tokens: 0, toolUses: 0, durationMs: 0 },
    ...patch,
  };
}

function counts(working: number, attention: number, total = working + attention): GlanceCounts {
  return { total, working, attention };
}

describe('trayTitle', () => {
  it('reads working then needs-you', () => {
    expect(trayTitle(counts(2, 1))).toBe('2● 1!');
    expect(trayTitle(counts(3, 0))).toBe('3●');
    expect(trayTitle(counts(0, 2))).toBe('2!');
  });

  it('is empty when nothing is happening, so the menu bar shows the icon alone', () => {
    expect(trayTitle(counts(0, 0, 4))).toBe('');
    expect(trayTitle(counts(0, 0, 0))).toBe('');
  });
});

describe('countGlance', () => {
  it('counts only the two phases the title cares about', () => {
    const list = [
      session('a', { phase: 'working' }),
      session('b', { phase: 'attention' }),
      session('c', { phase: 'idle' }),
      session('d', { phase: 'starting' }),
      session('e', { phase: 'ended' }),
    ];
    expect(countGlance(list)).toEqual({ total: 5, working: 1, attention: 1 });
  });
});

describe('sortForGlance', () => {
  it('puts anything waiting on you first, then work, then the quiet ones', () => {
    const list = [
      session('idle', { phase: 'idle' }),
      session('ended', { phase: 'ended' }),
      session('working', { phase: 'working' }),
      session('starting', { phase: 'starting' }),
      session('blocked', { phase: 'attention' }),
    ];
    expect(sortForGlance(list).map((s) => s.id)).toEqual(['blocked', 'working', 'starting', 'idle', 'ended']);
  });

  it('answers the longest wait first', () => {
    const older = session('older', {
      phase: 'attention',
      attention: { kind: 'permission', since: 1000, source: 'cmux' },
    });
    const newer = session('newer', {
      phase: 'attention',
      attention: { kind: 'question', since: 5000, source: 'transcript' },
    });
    expect(sortForGlance([newer, older]).map((s) => s.id)).toEqual(['older', 'newer']);
  });

  it('orders the rest by most recent activity, and stays stable when that ties', () => {
    const stale = session('stale', { phase: 'working', lastActivityAt: 10 });
    const fresh = session('fresh', { phase: 'working', lastActivityAt: 90 });
    expect(sortForGlance([stale, fresh]).map((s) => s.id)).toEqual(['fresh', 'stale']);

    const a = session('a', { phase: 'idle', lastActivityAt: 10 });
    const b = session('b', { phase: 'idle', lastActivityAt: 10 });
    expect(sortForGlance([b, a]).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('does not reorder the array it was handed', () => {
    const list = [session('b', { phase: 'idle' }), session('a', { phase: 'attention' })];
    sortForGlance(list);
    expect(list.map((s) => s.id)).toEqual(['b', 'a']);
  });
});

describe('glancePhrase', () => {
  const now = 100_000;

  it('takes the detail the main agent is on', () => {
    const agent = mainAgent('a', {
      activity: 'reading',
      activityDetail: { tool: 'Read', label: 'reading parse.ts', target: 'parse.ts', since: 0 },
    });
    expect(glancePhrase(session('a', { phase: 'working' }), agent, now)).toBe('Reading parse.ts');
  });

  it('falls back to the activity label when there is no detail', () => {
    const agent = mainAgent('a', { activity: 'testing' });
    expect(glancePhrase(session('a', { phase: 'working' }), agent, now)).toBe('Running tests');
  });

  it('says what a blocked session is blocked on, whatever its agent was doing', () => {
    const agent = mainAgent('a', { activity: 'editing' });
    const blocked = session('a', {
      phase: 'attention',
      attention: { kind: 'planApproval', since: 0, source: 'transcript' },
    });
    expect(glancePhrase(blocked, agent, now)).toBe('Waiting on plan approval');
    expect(
      glancePhrase(
        session('a', { phase: 'attention', attention: { kind: 'question', since: 0, source: 'cmux' } }),
        agent,
        now,
      ),
    ).toBe('Asking you a question');
  });

  it('measures the silence instead of repeating "idle" next to the idle chip', () => {
    const quiet = session('a', { phase: 'idle', lastActivityAt: now - 240_000 });
    expect(glancePhrase(quiet, mainAgent('a'), now)).toBe('Quiet for 4m');
    expect(glancePhrase(quiet, undefined, now)).toBe('Quiet for 4m');
  });

  /**
   * A session that has fanned out sits with an idle main agent while a great
   * deal happens. Reporting that as "Quiet for 3s" beside a WORKING tag is a
   * flat contradiction, and it is the state a busy session spends most of its
   * time in.
   */
  it('reports the subagents when the main agent has handed off', () => {
    const working = session('a', { phase: 'working', lastActivityAt: now - 3000 });
    const idleMain = mainAgent('a');
    const helper = (id: string, patch: Partial<AgentView> = {}): AgentView => ({
      ...mainAgent('a'),
      id,
      role: 'Explore',
      agentType: 'Explore',
      activity: 'searching',
      ...patch,
    });

    expect(glancePhrase(working, idleMain, now, [helper('x')])).toBe('Searching');
    expect(
      glancePhrase(working, idleMain, now, [
        helper('x', {
          activityDetail: { tool: 'Grep', label: 'searching for rng', since: 0 },
        }),
      ]),
    ).toBe('Searching for rng');
    expect(glancePhrase(working, idleMain, now, [helper('x'), helper('y'), helper('z')])).toBe(
      '3 agents working',
    );

    // A finished fan-out is silence again, not three ghosts still working.
    expect(glancePhrase(working, idleMain, now, [helper('x', { status: 'done' })])).toBe('Quiet for 3s');
  });

  it('never counts backwards from a clock that drifted', () => {
    const future = session('a', { phase: 'idle', lastActivityAt: now + 5000 });
    expect(glancePhrase(future, undefined, now)).toBe('Quiet for 0s');
  });

  it('marks ended sessions plainly', () => {
    expect(glancePhrase(session('a', { phase: 'ended' }), mainAgent('a', { activity: 'offline' }), now)).toBe(
      'Ended',
    );
  });
});

describe('glanceSummary', () => {
  it('reads as one line', () => {
    expect(glanceSummary(counts(2, 1, 4))).toBe('4 sessions · 2 working · 1 needs you');
    expect(glanceSummary(counts(1, 0, 1))).toBe('1 session · 1 working');
    expect(glanceSummary(counts(0, 0, 3))).toBe('3 sessions · all quiet');
    expect(glanceSummary(counts(0, 0, 0))).toBe('Nothing running');
  });
});
