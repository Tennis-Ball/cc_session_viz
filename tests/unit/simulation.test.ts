import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '@engine/ports/clock';
import { AmbientSource } from '@engine/sources/ambient';
import { WorldStore } from '@engine/state/worldStore';
import {
  AGENT_TASKS,
  ASSISTANT_LINES,
  BASH_COMMANDS,
  PROMPTS,
  REPOS,
  SEARCH_QUERIES,
} from '@engine/sources/ambient/corpus';

/**
 * The simulation has to hold two things at once: a different office every
 * launch, and the same office every time from one seed. Everything below is
 * about one of the two, or about the promise that none of it costs anything —
 * no model call, no socket, no file.
 */

const ORIGIN = Date.UTC(2026, 8, 19, 9, 30);
const TICK_MS = 250;

function office(seed: number): { store: WorldStore; clock: FakeClock; source: AmbientSource } {
  const store = new WorldStore();
  const clock = new FakeClock(ORIGIN);
  return { store, clock, source: new AmbientSource(store, clock, seed) };
}

/** The office at the moment it opens, with nothing ticked yet. */
function seated(seed: number): { store: WorldStore; source: AmbientSource } {
  const { store, source } = office(seed);
  source.setActive(true);
  return { store, source };
}

/** Runs the real interval loop against a pinned clock for `ms` of world time. */
function run(seed: number, ms: number): { store: WorldStore; source: AmbientSource } {
  const { store, clock, source } = office(seed);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.useFakeTimers();
  try {
    source.start();
    source.setActive(true);
    for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
      clock.advance(TICK_MS);
      vi.advanceTimersByTime(TICK_MS);
    }
  } finally {
    vi.useRealTimers();
    log.mockRestore();
  }
  return { store, source };
}

/**
 * Everything the renderer would draw, with nothing that varies for reasons
 * other than the seed. Two runs that match here are the same afternoon.
 */
function normalise(store: WorldStore): string {
  const world = store.snapshot();
  const by = <T extends { id: string }>(items: T[]): T[] => [...items].sort((a, b) => a.id.localeCompare(b.id));

  return JSON.stringify(
    {
      sessions: by(Object.values(world.sessions)).map((s) => ({
        id: s.id,
        title: s.title,
        repo: s.repo,
        branch: s.gitBranch,
        model: s.model.id,
        phase: s.phase,
        attention: s.attention?.kind ?? null,
        permissionMode: s.permissionMode,
        contextUsed: s.context.used,
        contextPct: Math.round(s.context.pct),
        compacting: s.context.compacting,
        turnOpen: s.turn !== undefined,
        unread: s.unread,
        lastActivityAt: s.lastActivityAt,
        tasks: s.tasks.map((task) => `${task.subject}:${task.status}`),
        colorIndex: s.colorIndex,
      })),
      agents: by(Object.values(world.agents)).map((a) => ({
        id: a.id,
        slotId: a.slotId,
        role: a.role,
        status: a.status,
        activity: a.activity,
        label: a.activityDetail?.label ?? null,
        tokens: a.stats.tokens,
        toolUses: a.stats.toolUses,
      })),
      watches: by(Object.values(world.watches)).map((w) => ({ id: w.id, kind: w.kind, status: w.status })),
      workflows: [...Object.values(world.workflows)]
        .sort((a, b) => a.runId.localeCompare(b.runId))
        .map((w) => ({ runId: w.runId, name: w.name, status: w.status, phases: w.phases.length })),
    },
    null,
    1,
  );
}

describe('the simulation is a pure function of its seed', () => {
  it('replays the same office from the same seed', () => {
    const a = run(20260919, 6 * 60_000);
    const b = run(20260919, 6 * 60_000);
    expect(normalise(a.store)).toBe(normalise(b.store));
    expect(a.source.seed).toBe(b.source.seed);
  });

  it('tells a different story from a different seed', () => {
    const a = run(20260919, 6 * 60_000);
    const b = run(77_001_313, 6 * 60_000);
    expect(normalise(a.store)).not.toBe(normalise(b.store));
  });

  it('gives every session its own character', () => {
    const { store } = run(4242, 8 * 60_000);
    const sessions = Object.values(store.snapshot().sessions);
    // Different repos, different models, different context depths: an office of
    // clones is the failure this guards against.
    expect(new Set(sessions.map((s) => s.repo)).size).toBeGreaterThan(1);
    expect(new Set(sessions.map((s) => s.colorIndex)).size).toBe(sessions.length);
  });

  it('takes its seed from the environment when one is pinned', () => {
    const before = process.env['CCV_SIM_SEED'];
    process.env['CCV_SIM_SEED'] = '1837462';
    try {
      const source = new AmbientSource(new WorldStore(), new FakeClock(ORIGIN));
      expect(source.seed).toBe(1_837_462);
    } finally {
      if (before === undefined) delete process.env['CCV_SIM_SEED'];
      else process.env['CCV_SIM_SEED'] = before;
    }
  });

  it('draws a fresh seed when nothing is pinned, and logs it', () => {
    const before = process.env['CCV_SIM_SEED'];
    delete process.env['CCV_SIM_SEED'];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const seeds = new Set<number>();
      for (let i = 0; i < 8; i++) {
        const source = new AmbientSource(new WorldStore(), new FakeClock(ORIGIN));
        source.start();
        source.stop();
        seeds.add(source.seed);
        expect(log).toHaveBeenCalledWith(`[simulation] seed ${source.seed}`);
      }
      expect(seeds.size).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
      log.mockRestore();
      if (before !== undefined) process.env['CCV_SIM_SEED'] = before;
    }
  });
});

describe('the office opens already at work', () => {
  it('seats a cast that is mid-flight, not ramping up', () => {
    const { store } = seated(20260919);
    const sessions = Object.values(store.snapshot().sessions);

    expect(sessions.length).toBeGreaterThanOrEqual(3);
    for (const session of sessions) {
      expect(session.ambient).toBe(true);
      // Nothing may claim to have happened after the office opened.
      expect(session.startedAt).toBeLessThan(ORIGIN);
      expect(session.lastActivityAt).toBeLessThanOrEqual(ORIGIN);
      expect(session.phase).not.toBe('starting');
    }

    expect(sessions.some((s) => s.turn !== undefined)).toBe(true);
    expect(sessions.some((s) => s.phase === 'idle' && s.lastTurn !== undefined)).toBe(true);
  });

  it('opens with a fan-out running and a context window nearly full', () => {
    const { store } = seated(20260919);
    const world = store.snapshot();

    const running = new Map<string, number>();
    for (const agent of Object.values(world.agents)) {
      if (agent.role === 'main' || agent.status !== 'running') continue;
      running.set(agent.slotId, (running.get(agent.slotId) ?? 0) + 1);
    }
    expect([...running.values()].some((count) => count >= 2)).toBe(true);

    const deepest = Math.max(...Object.values(world.sessions).map((s) => s.context.pct));
    expect(deepest).toBeGreaterThan(70);
  });

  it('has a transcript behind every card it opens with', () => {
    const { store, source } = seated(20260919);
    for (const session of Object.values(store.snapshot().sessions)) {
      const entries = source.logFor(session.id)?.all() ?? [];
      expect(entries.length).toBeGreaterThan(2);
      expect(entries.every((entry) => entry.at <= ORIGIN)).toBe(true);
    }
  });

  it('sometimes needs the user, and sometimes has a workflow or a watch going', () => {
    let attention = 0;
    let workflows = 0;
    let watches = 0;

    for (let seed = 1; seed <= 24; seed++) {
      const world = seated(seed * 7919).store.snapshot();
      if (Object.values(world.sessions).some((s) => s.phase === 'attention')) attention += 1;
      if (Object.keys(world.workflows).length > 0) workflows += 1;
      if (Object.keys(world.watches).length > 0) watches += 1;
    }

    // "Occasionally": present across a run of seeds, absent from plenty of them.
    expect(attention).toBeGreaterThan(0);
    expect(attention).toBeLessThan(24);
    expect(workflows).toBeGreaterThan(0);
    expect(watches).toBeGreaterThan(0);
  });
});

describe('the population moves', () => {
  it('drifts rather than sitting at a constant', () => {
    const { store, clock, source } = office(99_881);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    const counts = new Set<number>();
    try {
      source.start();
      source.setActive(true);
      for (let elapsed = 0; elapsed < 90 * 60_000; elapsed += TICK_MS) {
        clock.advance(TICK_MS);
        vi.advanceTimersByTime(TICK_MS);
        if (elapsed % 30_000 === 0) counts.add(Object.keys(store.snapshot().sessions).length);
      }
    } finally {
      vi.useRealTimers();
      log.mockRestore();
    }

    expect(counts.size).toBeGreaterThan(1);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...counts)).toBeLessThanOrEqual(6);
  });

  it('leaves nothing behind when it is switched off', () => {
    const { store, clock, source } = office(5150);
    source.setActive(true);
    expect(Object.keys(store.snapshot().sessions).length).toBeGreaterThan(0);
    source.setActive(false);
    clock.advance(60_000);
    source.stop();

    const world = store.snapshot();
    expect(world.sessions).toEqual({});
    expect(world.agents).toEqual({});
    expect(world.watches).toEqual({});
    expect(world.workflows).toEqual({});
  });
});

describe('the corpus is wide enough to watch', () => {
  it('has no duplicates and enough of everything', () => {
    const unique = <T>(items: readonly T[], key: (item: T) => string): number =>
      new Set(items.map(key)).size;

    expect(unique(PROMPTS, (p) => p)).toBe(PROMPTS.length);
    expect(PROMPTS.length).toBeGreaterThanOrEqual(40);
    expect(unique(BASH_COMMANDS, (c) => c.command)).toBe(BASH_COMMANDS.length);
    expect(BASH_COMMANDS.length).toBeGreaterThanOrEqual(30);
    expect(unique(ASSISTANT_LINES, (l) => l)).toBe(ASSISTANT_LINES.length);
    expect(unique(REPOS, (r) => r.name)).toBe(REPOS.length);
    expect(REPOS.length).toBeGreaterThanOrEqual(12);
    expect(unique(AGENT_TASKS, (t) => t.description)).toBe(AGENT_TASKS.length);
    expect(unique(SEARCH_QUERIES, (q) => q)).toBe(SEARCH_QUERIES.length);
  });

  it('never repeats a prompt at the same desk in a sitting', () => {
    const { store, source } = run(31_337, 45 * 60_000);
    let checked = 0;

    for (const session of Object.values(store.snapshot().sessions)) {
      const prompts = (source.logFor(session.id)?.all() ?? [])
        .filter((entry) => entry.k === 'user')
        .map((entry) => (entry.k === 'user' ? entry.text : ''));
      if (prompts.length < 4) continue;
      checked += 1;
      // The deck deals without replacement, so a repeat before the list is
      // exhausted would mean the picker regressed to a plain random draw.
      const window = prompts.slice(0, Math.min(prompts.length, PROMPTS.length));
      expect(new Set(window).size).toBe(window.length);
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// No credits, no network, no disk
// ---------------------------------------------------------------------------

const SRC = resolve(__dirname, '../../src');

/**
 * Every module the simulation can actually reach at runtime.
 *
 * `import type` is erased before anything runs, so it is stripped first: the
 * simulation names `LiveSlot` and `WorldStore` as types without ever pulling in
 * the modules that read the disk. Comments go too — the question is what the
 * code does, not what a doc comment mentions.
 */
function reachable(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    seen.set(file, source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, ''));

    const values = source.replace(/^\s*(?:import|export)\s+type\s[\s\S]*?from\s+['"][^'"]+['"];?/gm, '');
    for (const match of values.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const spec = resolve(dirname(file), match[1]!);
      const candidate = [`${spec}.ts`, `${spec}/index.ts`].find((path) => {
        try {
          readFileSync(path, 'utf8');
          return true;
        } catch {
          return false;
        }
      });
      if (candidate) queue.push(candidate);
    }
  }
  return seen;
}

const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
  [/from\s+['"]node:/, 'a node builtin'],
  [/from\s+['"](?:fs|path|os|net|http|https|dns|tls|child_process|worker_threads)['"]/, 'a bare node builtin'],
  [/\brequire\s*\(/, 'require()'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\b/, 'a socket'],
  [/\bspawn(?:Sync)?\s*\(/, 'a spawned process'],
  [/\bexec(?:Sync|File|FileSync)\s*\(/, 'a spawned process'],
  [/\b(?:writeFile|writeFileSync|appendFile|mkdir|mkdirSync|createWriteStream|unlink|rm|rmSync)\s*\(/, 'a file write'],
  [/\.claude\b/, "the user's ~/.claude tree"],
  [/\bhomedir\s*\(/, 'the home directory'],
  [/anthropic/i, 'a model API'],
  [/\bapiKey\b|\bAPI_KEY\b|\bBearer\b/, 'a credential'],
];

describe('the simulation costs nothing', () => {
  const modules = reachable(resolve(SRC, 'engine/sources/ambient/index.ts'));

  it('reaches only modules that touch neither the disk, the network, nor a model', () => {
    expect(modules.size).toBeGreaterThan(5);
    for (const [file, source] of modules) {
      for (const [pattern, what] of FORBIDDEN) {
        expect(pattern.test(source), `${file.slice(SRC.length + 1)} reaches ${what}`).toBe(false);
      }
    }
  });

  it('draws entropy exactly once, and only to choose the seed', () => {
    let draws = 0;
    for (const [file, source] of modules) {
      const hits = source.match(/Math\.random\s*\(/g)?.length ?? 0;
      draws += hits;
      if (hits > 0) expect(file).toBe(resolve(SRC, 'engine/sources/ambient/index.ts'));
    }
    expect(draws).toBe(1);
  });

  it('reads the wall clock only through the clock port', () => {
    for (const [file, source] of modules) {
      if (!/\bDate\.now\s*\(/.test(source)) continue;
      expect(file).toBe(resolve(SRC, 'engine/ports/clock.ts'));
    }
  });

  it('keeps no module-level mutable state, so two sources cannot interfere', () => {
    const a = seated(606);
    const b = seated(606);
    expect(normalise(a.store)).toBe(normalise(b.store));

    // Interleaved: the second office must not disturb the first one's ids.
    const c = office(606);
    const d = office(909);
    c.source.setActive(true);
    d.source.setActive(true);
    expect(normalise(c.store)).toBe(normalise(a.store));
  });
});
