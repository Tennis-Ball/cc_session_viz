import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiveSource } from '@engine/sources/live';
import { WorldStore } from '@engine/state/worldStore';
import { FakeClock } from '@engine/ports/clock';
import type { FileStat, FsPort } from '@engine/ports/fs';
import type { ProcPort } from '@engine/ports/proc';

/**
 * End-to-end engine test: a recorded ~/.claude tree goes in, a World comes out.
 *
 * These fixtures are anonymized copies of real sessions, so they carry the
 * shapes that actually break the parser — split assistant lines, duplicated
 * task-notifications, sidecar-only subagents, workflow run records.
 */

const FIXTURES = resolve(__dirname, '../../fixtures');

/** Serves a fixture directory as if it were ~/.claude, plus in-memory overlays. */
class FixtureFs implements FsPort {
  constructor(
    private readonly root: string,
    private readonly overlay: Map<string, string> = new Map(),
  ) {}

  private real(path: string): string {
    return path.startsWith(this.root) ? path : join(this.root, path);
  }

  async stat(path: string): Promise<FileStat | null> {
    const overlaid = this.overlay.get(this.real(path));
    if (overlaid !== undefined) {
      return { size: Buffer.byteLength(overlaid), mtimeMs: 0, birthtimeMs: 0, ino: 1 };
    }
    try {
      const s = statSync(this.real(path));
      return { size: s.size, mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs, ino: Number(s.ino) };
    } catch {
      return null;
    }
  }
  async readdir(path: string): Promise<string[]> {
    const dir = this.real(path);
    const extra = [...this.overlay.keys()]
      .filter((key) => key.startsWith(`${dir}/`))
      .map((key) => key.slice(dir.length + 1))
      .filter((rest) => !rest.includes('/'));
    try {
      return [...readdirSync(dir), ...extra];
    } catch {
      return extra;
    }
  }
  async readText(path: string): Promise<string | null> {
    const overlaid = this.overlay.get(this.real(path));
    if (overlaid !== undefined) return overlaid;
    try {
      return readFileSync(this.real(path), 'utf8');
    } catch {
      return null;
    }
  }
  async readRange(path: string, start: number, end: number): Promise<Buffer> {
    try {
      return readFileSync(this.real(path)).subarray(start, end);
    } catch {
      return Buffer.alloc(0);
    }
  }
  watch(): () => void {
    return () => {};
  }
}

/** Every recorded pid is "alive", with a matching start time. */
class FixtureProc implements ProcPort {
  constructor(private readonly starts: Map<number, string>) {}
  isAlive(): boolean {
    return true;
  }
  async startTimes(pids: number[]): Promise<Map<number, string>> {
    return new Map(pids.map((pid) => [pid, this.starts.get(pid) ?? '']));
  }
  async envOf(): Promise<Record<string, string>> {
    return {};
  }
}

interface RegistryFile {
  pid: number;
  procStart: string;
  startedAt: number;
}

/**
 * Not every recording caught a live registry entry, so one is synthesized from
 * the transcript. That is exactly what the registry would have said while the
 * session was running.
 */
function synthesizeRegistry(root: string, overlay: Map<string, string>): number {
  const projects = join(root, 'projects');
  let latest = 0;
  let pid = 4000;

  for (const project of readdirSync(projects)) {
    for (const entry of readdirSync(join(projects, project))) {
      if (!entry.endsWith('.jsonl')) continue;
      const path = join(projects, project, entry);
      const firstLine = readFileSync(path, 'utf8').split('\n', 1)[0] ?? '{}';
      const parsed = JSON.parse(firstLine) as { cwd?: string; version?: string; timestamp?: string };
      const startedAt = Date.parse(parsed.timestamp ?? '') || Date.now();
      latest = Math.max(latest, statSync(path).mtimeMs);
      pid += 1;

      overlay.set(
        join(root, 'sessions', `${pid}.json`),
        JSON.stringify({
          pid,
          sessionId: entry.slice(0, -'.jsonl'.length),
          cwd: parsed.cwd ?? '/tmp/fixture',
          startedAt,
          procStart: 'fixture',
          version: parsed.version ?? '2.1.0',
          kind: 'interactive',
          entrypoint: 'cli',
          status: 'idle',
          name: 'fixture-session',
          nameSource: 'derived',
        }),
      );
    }
  }
  return latest;
}

async function loadFixture(name: string): Promise<{ store: WorldStore; source: LiveSource }> {
  const root = join(FIXTURES, name);
  const overlay = new Map<string, string>();
  const starts = new Map<number, string>();
  let clockNow = 0;

  let hasRegistry = false;
  try {
    for (const file of readdirSync(join(root, 'sessions'))) {
      const entry = JSON.parse(readFileSync(join(root, 'sessions', file), 'utf8')) as RegistryFile;
      starts.set(entry.pid, entry.procStart);
      clockNow = Math.max(clockNow, entry.startedAt);
      hasRegistry = true;
    }
  } catch {
    hasRegistry = false;
  }
  if (!hasRegistry) clockNow = synthesizeRegistry(root, overlay);

  const store = new WorldStore();
  const source = new LiveSource(store, {
    claudeDir: root,
    fs: new FixtureFs(root, overlay),
    proc: new FixtureProc(starts),
    // Sit "now" after the recording so nothing looks like it is from the future.
    clock: new FakeClock(clockNow + 60_000),
  });
  await source.start();
  source.stop();
  return { store, source };
}

describe('LiveSource over recorded sessions', () => {
  it('builds a session with its subagents from the sidecars', async () => {
    const { store } = await loadFixture('subagents-basic');
    const world = store.snapshot();

    const sessions = Object.values(world.sessions);
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;

    expect(session.cwd).toMatch(/^\/Users\//);
    expect(session.title.length).toBeGreaterThan(0);
    expect(session.model.label).toMatch(/Opus|Sonnet|Haiku|Fable/);
    // Context has to come out of the deduped usage, not stay at zero.
    expect(session.context.used).toBeGreaterThan(1000);
    expect(session.context.pct).toBeGreaterThan(0);
    expect(session.context.pct).toBeLessThanOrEqual(100);

    const agents = Object.values(world.agents).filter((a) => a.role !== 'main');
    expect(agents.length).toBeGreaterThanOrEqual(4);
    for (const agent of agents) {
      expect(agent.slotId).toBe(session.id);
      expect(agent.parentId).toBeDefined();
    }
  });

  it('closes out subagents that reported completion', async () => {
    const { store } = await loadFixture('subagents-basic');
    const agents = Object.values(store.snapshot().agents).filter((a) => a.role !== 'main');
    const finished = agents.filter((a) => a.status !== 'running');
    expect(finished.length).toBeGreaterThan(0);
    // Completion notifications carry real usage numbers.
    expect(finished.some((a) => a.stats.tokens > 0 && a.stats.durationMs > 0)).toBe(true);
  });

  it('applies a compaction to the context meter', async () => {
    const { store } = await loadFixture('compaction');
    const session = Object.values(store.snapshot().sessions)[0]!;
    expect(session.context.lastCompact).toBeDefined();
    expect(session.context.lastCompact!.pre).toBeGreaterThan(session.context.lastCompact!.post);
    expect(session.context.compacting).not.toBe('confirmed');
  });

  it('follows plan mode from entering it to the plan being approved', async () => {
    const { store, source } = await loadFixture('plan-mode');
    const session = Object.values(store.snapshot().sessions)[0]!;
    const entries = source.logFor(session.id)?.all() ?? [];

    const exitPlan = entries.filter((entry) => entry.k === 'tool' && entry.name === 'ExitPlanMode');
    expect(exitPlan.length).toBeGreaterThan(0);
    // An approved plan clears the waiting state rather than leaving a halo up.
    expect(exitPlan.every((entry) => entry.k === 'tool' && entry.status !== 'pending')).toBe(true);
    expect(session.plan?.awaitingApproval ?? false).toBe(false);
  });

  it('reconstructs workflow runs, their phases and their agents', async () => {
    const { store } = await loadFixture('workflows');
    const world = store.snapshot();
    const runs = Object.values(world.workflows);
    expect(runs.length).toBeGreaterThan(0);

    const run = runs[0]!;
    expect(run.name.length).toBeGreaterThan(0);
    const workflowAgents = Object.values(world.agents).filter((a) => a.workflowRunId);
    expect(workflowAgents.length).toBeGreaterThan(0);
    for (const agent of workflowAgents) expect(agent.role).toBe('workflow');
  });

  it('records a transcript the canvas card can render', async () => {
    const { store, source } = await loadFixture('subagents-basic');
    const session = Object.values(store.snapshot().sessions)[0]!;

    const log = source.logFor(session.id);
    expect(log).toBeDefined();
    const entries = log!.all();
    expect(entries.length).toBeGreaterThan(5);

    const kinds = new Set(entries.map((entry) => entry.k));
    expect(kinds.has('tool')).toBe(true);
    expect(kinds.has('user') || kinds.has('text')).toBe(true);

    // Tool entries must be resolved, not left pending forever.
    const tools = entries.filter((entry) => entry.k === 'tool');
    expect(tools.some((entry) => entry.k === 'tool' && entry.status === 'ok')).toBe(true);

    // And a subagent's own card has its own transcript.
    const agent = Object.values(store.snapshot().agents).find((a) => a.role !== 'main');
    expect(source.logFor(agent!.id)?.all().length ?? 0).toBeGreaterThan(0);
  });

  it('never reports unknown line types for a recorded session', async () => {
    const { store } = await loadFixture('subagents-basic');
    expect(store.snapshot().health.unknownSignals).toBe(0);
  });
});

/**
 * The two settings that decide which sessions exist.
 *
 * Both shipped as controls in the settings sheet that were wired to nothing:
 * SDK runs were filtered by a hardcoded condition and the grace period was a
 * module constant, so moving either did exactly nothing and there was no test
 * that would have noticed. These run against an in-memory registry rather than
 * a recording, because what is being asserted is the filtering, not the parser.
 */
describe('LiveSource options', () => {
  const ROOT = '/fake/.claude';

  function registry(pid: number, entrypoint: string, kind: string): string {
    return JSON.stringify({
      pid,
      sessionId: `session-${pid}`,
      cwd: '/tmp/work',
      startedAt: 1_000,
      procStart: 'fake',
      version: '2.1.0',
      kind,
      entrypoint,
      status: 'idle',
      name: `s${pid}`,
      nameSource: 'derived',
    });
  }

  async function open(options: { hideSdkSessions: boolean; endedGraceMs: number }) {
    const overlay = new Map<string, string>([
      [`${ROOT}/sessions/100.json`, registry(100, 'cli', 'interactive')],
      [`${ROOT}/sessions/200.json`, registry(200, 'sdk-cli', 'interactive')],
    ]);
    const store = new WorldStore();
    const clock = new FakeClock(10_000);
    const source = new LiveSource(store, {
      claudeDir: ROOT,
      fs: new FixtureFs(ROOT, overlay),
      proc: new FixtureProc(new Map([[100, 'fake'], [200, 'fake']])),
      clock,
    });
    source.setOptions(options);
    await source.start();
    return { store, source, overlay, clock };
  }

  it('hides SDK runs, and shows them when asked to', async () => {
    const hidden = await open({ hideSdkSessions: true, endedGraceMs: 60_000 });
    expect(Object.values(hidden.store.snapshot().sessions).map((s) => s.pid)).toEqual([100]);
    hidden.source.stop();

    const shown = await open({ hideSdkSessions: false, endedGraceMs: 60_000 });
    expect(Object.values(shown.store.snapshot().sessions).map((s) => s.pid).sort()).toEqual([100, 200]);
    shown.source.stop();
  });

  it('retires an SDK desk at once when the setting is turned back on', async () => {
    const { store, source } = await open({ hideSdkSessions: false, endedGraceMs: 10 * 60_000 });
    expect(Object.keys(store.snapshot().sessions)).toHaveLength(2);

    // Not left to time out through the grace period: it has not ended, it is
    // being hidden, and a desk that lingers makes the switch look broken.
    source.setOptions({ hideSdkSessions: true, endedGraceMs: 10 * 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Object.values(store.snapshot().sessions).map((s) => s.pid)).toEqual([100]);
    source.stop();
  });
});
