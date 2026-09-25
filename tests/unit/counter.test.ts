import { describe, expect, it } from 'vitest';
import { modelInfo } from '@shared/format';
import { PHASE_LABEL } from '@shared/glance';
import type { SessionPhase, SessionView } from '@shared/model';
import {
  COUNTER_LEGEND,
  contextLevel,
  contextPercent,
  counterCounts,
  counterDots,
  type CounterCounts,
} from '@renderer/chrome/counter';

function session(id: string, phase: SessionPhase): SessionView {
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
    phase,
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
  };
}

function counts(patch: Partial<CounterCounts> = {}): CounterCounts {
  return { total: 0, working: 0, attention: 0, idle: 0, ...patch };
}

describe('counterCounts', () => {
  it('separates the three states that get a dot from the two that do not', () => {
    const list = [
      session('a', 'working'),
      session('b', 'working'),
      session('c', 'attention'),
      session('d', 'idle'),
      session('e', 'starting'),
      session('f', 'ended'),
    ];
    expect(counterCounts(list)).toEqual({ total: 6, working: 2, attention: 1, idle: 1 });
  });

  it('counts an empty world as empty rather than as quiet', () => {
    expect(counterCounts([])).toEqual({ total: 0, working: 0, attention: 0, idle: 0 });
  });
});

describe('counterDots', () => {
  it('shows work first and anything blocked second', () => {
    expect(counterDots(counts({ total: 3, working: 2, attention: 1 }))).toEqual([
      { phase: 'working', count: 2 },
      { phase: 'attention', count: 1 },
    ]);
  });

  it('leaves the attention dot off until something is actually waiting', () => {
    expect(counterDots(counts({ total: 2, working: 2 }))).toEqual([{ phase: 'working', count: 2 }]);
  });

  it('greys the first dot and counts the quiet ones when nothing is running', () => {
    expect(counterDots(counts({ total: 4, idle: 4 }))).toEqual([{ phase: 'idle', count: 4 }]);
    expect(counterDots(counts({ total: 3, attention: 1, idle: 2 }))).toEqual([
      { phase: 'idle', count: 2 },
      { phase: 'attention', count: 1 },
    ]);
  });

  it('still draws a dot for an empty world, so the chip never looks broken', () => {
    expect(counterDots(counts())).toEqual([{ phase: 'idle', count: 0 }]);
  });

  it('never grows past two dots, whatever the world is doing', () => {
    const worlds = [
      counts({ total: 9, working: 4, attention: 3, idle: 2 }),
      counts({ total: 2, attention: 2 }),
      counts({ total: 1, working: 1 }),
      counts(),
    ];
    for (const world of worlds) expect(counterDots(world).length).toBeLessThanOrEqual(2);
  });
});

describe('the legend', () => {
  it('explains every dot the chip can draw, and no dot it cannot', () => {
    const explained = new Set(COUNTER_LEGEND.map((entry) => entry.phase));
    const drawn = new Set(
      [
        counts({ total: 9, working: 4, attention: 3, idle: 2 }),
        counts({ total: 2, idle: 2 }),
        counts({ total: 1, attention: 1 }),
        counts(),
      ].flatMap((world) => counterDots(world).map((dot) => dot.phase)),
    );
    expect([...drawn].every((phase) => explained.has(phase))).toBe(true);
    expect(explained.size).toBe(3);
  });

  it('names each state the way the session rows name it', () => {
    expect(COUNTER_LEGEND.map((entry) => entry.name)).toEqual([
      PHASE_LABEL.working,
      PHASE_LABEL.attention,
      PHASE_LABEL.idle,
    ]);
  });

  it('says what causes each state rather than restating its name', () => {
    for (const entry of COUNTER_LEGEND) {
      expect(entry.why.length).toBeGreaterThan(12);
      expect(entry.why.toLowerCase()).not.toBe(entry.name.toLowerCase());
    }
  });
});

describe('context readout', () => {
  it('rounds, and never reads past a full window', () => {
    expect(contextPercent(0)).toBe(0);
    expect(contextPercent(41.4)).toBe(41);
    expect(contextPercent(41.6)).toBe(42);
    expect(contextPercent(103.2)).toBe(100);
    expect(contextPercent(-3)).toBe(0);
  });

  it('changes colour where the tray changes colour', () => {
    expect(contextLevel(0)).toBe('ok');
    expect(contextLevel(59)).toBe('ok');
    expect(contextLevel(60)).toBe('warn');
    expect(contextLevel(84)).toBe('warn');
    expect(contextLevel(85)).toBe('crit');
    expect(contextLevel(100)).toBe('crit');
  });
});
