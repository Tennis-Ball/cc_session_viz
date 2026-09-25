import { ACTIVITY_LABEL, type Activity } from '../../shared/activity';
import { hash32, modelInfo, repoName } from '../../shared/format';
import type { AgentView, SessionView, SlotId } from '../../shared/model';
import type { WorldStore } from '../state/worldStore';
import { pick, rng, type DataSource } from './types';

/**
 * M0 placeholder source: plausible sessions with no disk access, so the shell,
 * protocol and renderer can be built before the live pipeline lands.
 *
 * M7 replaces this with the ambient generator, which drives the same shapes
 * through synthetic JSONL and the real parser.
 */

interface MockRepo {
  cwd: string;
  branch: string;
  model: string;
}

const REPOS: MockRepo[] = [
  { cwd: '/Users/you/code/aurora', branch: 'main', model: 'claude-opus-5[1m]' },
  { cwd: '/Users/you/code/ledger-api', branch: 'fix/settlement', model: 'claude-fable-5-1' },
  { cwd: '/Users/you/code/atrium', branch: 'office-mode', model: 'claude-sonnet-5' },
];

const WORK_ACTIVITIES: Activity[] = [
  'thinking',
  'responding',
  'editing',
  'reading',
  'searching',
  'running',
  'testing',
  'browsing',
  'delegating',
  'watching',
  'messaging',
];

const SUBAGENT_TYPES = ['Explore', 'general-purpose', 'Plan'] as const;

interface MockSession {
  slotId: SlotId;
  mainAgentId: string;
  nextChangeAt: number;
  subagents: string[];
}

export class MockSource implements DataSource {
  readonly kind = 'sim';
  private timer: NodeJS.Timeout | null = null;
  private readonly random: () => number;
  private readonly sessions: MockSession[] = [];

  constructor(
    private readonly store: WorldStore,
    seed = 20260919,
  ) {
    this.random = rng(seed);
  }

  start(): void {
    this.store.patchHealth({ source: 'sim', mode: 'simulation', ambientActive: true });
    const now = Date.now();
    REPOS.forEach((repo, index) => this.spawnSession(repo, index, now));
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private spawnSession(repo: MockRepo, index: number, now: number): void {
    const pid = 90000 + index;
    const slotId: SlotId = `${pid}@${now - index * 60_000}`;
    const mainAgentId = `main@${slotId}`;
    const model = modelInfo(repo.model);
    const repoShort = repoName(repo.cwd);

    const session: SessionView = {
      id: slotId,
      ambient: true,
      pid,
      startedAt: now - index * 60_000,
      version: '2.1.277',
      sessionId: `mock-${index}`,
      sessionChain: [{ sessionId: `mock-${index}`, reason: 'start', at: now }],
      cwd: repo.cwd,
      repo: repoShort,
      gitBranch: repo.branch,
      title: `${repoShort}-${10 + index}`,
      titleSource: 'registry',
      formerNames: [],
      phase: 'working',
      phaseSince: now,
      unread: false,
      lastActivityAt: now,
      mainAgentId,
      model,
      ultra: false,
      fast: false,
      permissionMode: 'auto',
      context: {
        used: Math.floor(120_000 + this.random() * 300_000),
        window: model.window,
        pct: 0,
        autoCompactPct: 65,
        compacting: 'no',
      },
      turn: { startedAt: now, outputTokens: 0, toolUses: 0, verbSeed: hash32(slotId) },
      queue: { count: 0, previews: [] },
      tasks: [],
      prs: [],
      conditions: [],
      colorIndex: index,
    };
    session.context.pct = (session.context.used / session.context.window) * 100;
    this.store.upsertSession(session);
    this.store.emit({ at: now, t: 'sessionAppeared', slot: slotId });

    this.store.upsertAgent({
      id: mainAgentId,
      slotId,
      ambient: true,
      role: 'main',
      agentType: 'main',
      description: 'main conversation',
      depth: 0,
      background: false,
      isFork: false,
      model,
      status: 'running',
      activity: 'thinking',
      startedAt: now,
      lastActivityAt: now,
      stats: { tokens: 0, toolUses: 0, durationMs: 0 },
    });

    this.sessions.push({ slotId, mainAgentId, nextChangeAt: now + 2000, subagents: [] });
  }

  private tick(): void {
    const now = Date.now();
    for (const mock of this.sessions) {
      if (now < mock.nextChangeAt) continue;
      mock.nextChangeAt = now + 2500 + this.random() * 5000;
      this.advance(mock, now);
    }
  }

  private advance(mock: MockSession, now: number): void {
    const session = this.store.snapshot().sessions[mock.slotId];
    const main = this.store.snapshot().agents[mock.mainAgentId];
    if (!session || !main) return;

    const roll = this.random();
    if (roll < 0.12 && mock.subagents.length < 3) {
      this.spawnSubagent(mock, now);
      return;
    }
    if (roll < 0.2 && mock.subagents.length > 0) {
      this.finishSubagent(mock, now);
      return;
    }

    const activity = pick(this.random, WORK_ACTIVITIES);
    this.store.upsertAgent({
      ...main,
      activity,
      activityDetail: { tool: activity, label: ACTIVITY_LABEL[activity], since: now },
      lastActivityAt: now,
      stats: { ...main.stats, toolUses: main.stats.toolUses + 1, durationMs: now - main.startedAt },
    });

    const used = Math.min(session.context.window, session.context.used + Math.floor(this.random() * 12_000));
    this.store.upsertSession({
      ...session,
      lastActivityAt: now,
      phase: 'working',
      context: { ...session.context, used, pct: (used / session.context.window) * 100 },
    });
  }

  private spawnSubagent(mock: MockSession, now: number): void {
    const agentType = pick(this.random, SUBAGENT_TYPES);
    const id = `a${Math.floor(this.random() * 1e16).toString(16).padStart(16, '0')}`;
    const parent = this.store.snapshot().agents[mock.mainAgentId];
    if (!parent) return;

    const agent: AgentView = {
      id,
      slotId: mock.slotId,
      ambient: true,
      role: agentType === 'general-purpose' ? 'general-purpose' : agentType,
      agentType,
      description: pick(this.random, ['map the parser', 'check the migration', 'trace the failing test']),
      parentId: mock.mainAgentId,
      depth: 1,
      background: true,
      isFork: false,
      model: modelInfo('claude-opus-5'),
      status: 'running',
      activity: 'searching',
      startedAt: now,
      lastActivityAt: now,
      stats: { tokens: 0, toolUses: 0, durationMs: 0 },
    };
    this.store.upsertAgent(agent);
    this.store.emit({ at: now, t: 'subagentSpawned', parent: mock.mainAgentId, child: id });
    mock.subagents.push(id);
  }

  private finishSubagent(mock: MockSession, now: number): void {
    const id = mock.subagents.shift();
    if (!id) return;
    const agent = this.store.snapshot().agents[id];
    if (!agent) return;
    this.store.upsertAgent({
      ...agent,
      status: 'done',
      activity: 'idle',
      endedAt: now,
      stats: { tokens: Math.floor(20_000 + this.random() * 80_000), toolUses: 7, durationMs: now - agent.startedAt },
    });
    this.store.emit({ at: now, t: 'subagentFinished', agent: id, status: 'done' });
  }
}
