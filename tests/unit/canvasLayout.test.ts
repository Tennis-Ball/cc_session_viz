import { describe, expect, it } from 'vitest';
import { modelInfo } from '@shared/format';
import { emptyWorld, type AgentView, type SessionView, type World } from '@shared/model';
import { agentNodeId, layoutCanvas, sessionNodeId, SIZES } from '@renderer/canvas/layout/canvasLayout';

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
    phase: 'working',
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

function agent(id: string, slotId: string, patch: Partial<AgentView> = {}): AgentView {
  return {
    id,
    slotId,
    ambient: false,
    role: 'Explore',
    agentType: 'Explore',
    description: id,
    depth: 1,
    background: true,
    isFork: false,
    model: modelInfo('claude-opus-5'),
    status: 'running',
    activity: 'searching',
    startedAt: 2000,
    lastActivityAt: 2000,
    stats: { tokens: 0, toolUses: 0, durationMs: 0 },
    parentId: `main@${slotId}`,
    ...patch,
  };
}

function world(sessions: SessionView[], agents: AgentView[] = []): World {
  const w = emptyWorld();
  for (const s of sessions) w.sessions[s.id] = s;
  for (const a of agents) w.agents[a.id] = a;
  return w;
}

describe('layoutCanvas', () => {
  it('places sessions left to right in start order', () => {
    const layout = layoutCanvas(world([session('b', { startedAt: 3000 }), session('a', { startedAt: 1000 })]));
    const [first, second] = layout.nodes;
    expect(first?.id).toBe(sessionNodeId('a'));
    expect(second?.id).toBe(sessionNodeId('b'));
    expect(second!.x).toBeGreaterThan(first!.x + SIZES.session.width);
  });

  it('hangs running agents below their session as terminal cards', () => {
    const layout = layoutCanvas(world([session('a')], [agent('a1', 'a'), agent('a2', 'a')]));
    const cards = layout.nodes.filter((n) => n.kind === 'runningAgent');
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.y).toBeGreaterThanOrEqual(SIZES.session.height);
      expect(card.width).toBe(SIZES.runningAgent.width);
    }
    // They share a row, centred under the parent.
    expect(cards[0]!.y).toBe(cards[1]!.y);
  });

  it('collapses finished agents into a compact grid, four per row', () => {
    const finished = Array.from({ length: 6 }, (_, i) =>
      agent(`f${i}`, 'a', { status: 'done', endedAt: 5000 + i }),
    );
    const layout = layoutCanvas(world([session('a')], finished));
    const compact = layout.nodes.filter((n) => n.kind === 'compactAgent');
    expect(compact).toHaveLength(6);
    const rows = new Set(compact.map((n) => n.y));
    expect(rows.size).toBe(2);
  });

  it('orders running agents before finished ones, newest finished first', () => {
    const layout = layoutCanvas(
      world(
        [session('a')],
        [
          agent('old', 'a', { status: 'done', endedAt: 100 }),
          agent('new', 'a', { status: 'done', endedAt: 900 }),
          agent('live', 'a'),
        ],
      ),
    );
    const ids = layout.nodes.filter((n) => n.agentId).map((n) => n.agentId);
    expect(ids).toEqual(['live', 'new', 'old']);
  });

  it('links each agent to its parent card, not always to the session', () => {
    const child = agent('child', 'a', { parentId: 'parent', depth: 2 });
    const layout = layoutCanvas(world([session('a')], [agent('parent', 'a'), child]));
    const edge = layout.edges.find((e) => e.target === agentNodeId('child'));
    expect(edge?.source).toBe(agentNodeId('parent'));

    const topLevel = layout.edges.find((e) => e.target === agentNodeId('parent'));
    expect(topLevel?.source).toBe(sessionNodeId('a'));
  });

  it('marks edges to running agents so they animate', () => {
    const layout = layoutCanvas(world([session('a')], [agent('live', 'a'), agent('dead', 'a', { status: 'done' })]));
    expect(layout.edges.find((e) => e.target === agentNodeId('live'))?.running).toBe(true);
    expect(layout.edges.find((e) => e.target === agentNodeId('dead'))?.running).toBe(false);
  });

  it('never overlaps two session columns, however many agents they carry', () => {
    const agents = Array.from({ length: 5 }, (_, i) => agent(`x${i}`, 'a'));
    const layout = layoutCanvas(world([session('a'), session('b', { startedAt: 9000 })], agents));
    const a = layout.nodes.filter((n) => n.sessionId === 'a');
    const b = layout.nodes.filter((n) => n.sessionId === 'b');
    const aRight = Math.max(...a.map((n) => n.x + n.width));
    const bLeft = Math.min(...b.map((n) => n.x));
    expect(bLeft).toBeGreaterThan(aRight);
  });

  it('handles an empty world', () => {
    expect(layoutCanvas(emptyWorld())).toEqual({ nodes: [], edges: [] });
  });
});
