import type { AgentView, SessionView, World } from '@shared/model';

/**
 * Pure layout for the canvas board.
 *
 * Sessions sit in a row of columns; each column carries its own agents beneath
 * it — running ones as live terminal cards, finished ones as compact cards in a
 * grid. Keeping this pure means the same arrangement can be asserted in tests
 * and reused by the minimap and ⌘K without a React render.
 */

export const SIZES = {
  session: { width: 640, height: 440 },
  runningAgent: { width: 440, height: 300 },
  compactAgent: { width: 230, height: 96 },
} as const;

const GAP = { column: 120, sibling: 40, level: 110, compactRow: 16, row: 220 } as const;
const COMPACT_COLUMNS = 4;
/** Sessions wrap into rows so the board stays roughly square, not a mile wide. */
const MAX_ROW_WIDTH = 3400;

export interface PlacedNode {
  id: string;
  kind: 'session' | 'runningAgent' | 'compactAgent';
  x: number;
  y: number;
  width: number;
  height: number;
  sessionId: string;
  agentId?: string;
}

export interface PlacedEdge {
  id: string;
  source: string;
  target: string;
  running: boolean;
  colorIndex: number;
}

export interface CanvasLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
}

/**
 * How much a session wants looking at. Higher sorts earlier.
 *
 * The board used to be in the order the sessions happened to start, which is
 * no order at all once there are more than about six of them: every card is
 * the same size and the same shape, so a wall of them has no shape and nothing
 * tells you where to begin. Reading order is the cheapest structure a board can
 * have, and the only ranking worth using is the one that matches why the app is
 * open — the session that needs you, then the ones that are working, then
 * whatever moved most recently.
 */
function priority(session: SessionView): number {
  if (session.phase === 'attention') return 4;
  if (session.phase === 'working') return 3;
  if (session.unread) return 2;
  if (session.phase === 'ended') return 0;
  return 1;
}

export function layoutCanvas(world: World): CanvasLayout {
  const sessions = Object.values(world.sessions).sort((a, b) => {
    const rank = priority(b) - priority(a);
    if (rank !== 0) return rank;
    // Within a band, most recently active first, and `startedAt` only as a
    // tiebreak — two idle sessions with no activity at all should still land in
    // a stable order rather than swapping places on every patch.
    if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
    return a.startedAt - b.startedAt;
  });
  const agentsBySession = new Map<string, AgentView[]>();
  for (const agent of Object.values(world.agents)) {
    if (agent.role === 'main') continue;
    const list = agentsBySession.get(agent.slotId) ?? [];
    list.push(agent);
    agentsBySession.set(agent.slotId, list);
  }

  const nodes: PlacedNode[] = [];
  const edges: PlacedEdge[] = [];

  // Measure every column first: wrapping needs to know how wide each one is.
  const columns = sessions.map((session) => {
    const agents = sortAgents(agentsBySession.get(session.id) ?? []);
    const running = agents.filter((a) => a.status === 'running');
    const finished = agents.filter((a) => a.status !== 'running');
    const runningWidth = blockWidth(running.length, SIZES.runningAgent.width, GAP.sibling);
    const compactWidth = blockWidth(
      Math.min(finished.length, COMPACT_COLUMNS),
      SIZES.compactAgent.width,
      GAP.sibling,
    );
    const compactRows = Math.ceil(finished.length / COMPACT_COLUMNS);
    const height =
      SIZES.session.height +
      (running.length ? GAP.level + SIZES.runningAgent.height : 0) +
      (finished.length ? GAP.level + compactRows * (SIZES.compactAgent.height + GAP.compactRow) : 0);
    return {
      session,
      running,
      finished,
      width: Math.max(SIZES.session.width, runningWidth, compactWidth),
      height,
    };
  });

  let cursorX = 0;
  let rowY = 0;
  let rowHeight = 0;

  for (const column of columns) {
    if (cursorX > 0 && cursorX + column.width > MAX_ROW_WIDTH) {
      cursorX = 0;
      rowY += rowHeight + GAP.row;
      rowHeight = 0;
    }
    const centre = cursorX + column.width / 2;
    const { session, running, finished } = column;

    nodes.push({
      id: sessionNodeId(session.id),
      kind: 'session',
      x: centre - SIZES.session.width / 2,
      y: rowY,
      ...SIZES.session,
      sessionId: session.id,
    });

    let y = rowY + SIZES.session.height + GAP.level;
    const runningWidth = blockWidth(running.length, SIZES.runningAgent.width, GAP.sibling);

    running.forEach((agent, index) => {
      nodes.push({
        id: agentNodeId(agent.id),
        kind: 'runningAgent',
        x: centre - runningWidth / 2 + index * (SIZES.runningAgent.width + GAP.sibling),
        y,
        ...SIZES.runningAgent,
        sessionId: session.id,
        agentId: agent.id,
      });
      edges.push(edgeFor(session, agent, true));
    });
    if (running.length) y += SIZES.runningAgent.height + GAP.level;

    const compactWidth = blockWidth(
      Math.min(finished.length, COMPACT_COLUMNS),
      SIZES.compactAgent.width,
      GAP.sibling,
    );
    finished.forEach((agent, index) => {
      nodes.push({
        id: agentNodeId(agent.id),
        kind: 'compactAgent',
        x: centre - compactWidth / 2 + (index % COMPACT_COLUMNS) * (SIZES.compactAgent.width + GAP.sibling),
        y: y + Math.floor(index / COMPACT_COLUMNS) * (SIZES.compactAgent.height + GAP.compactRow),
        ...SIZES.compactAgent,
        sessionId: session.id,
        agentId: agent.id,
      });
      edges.push(edgeFor(session, agent, false));
    });

    cursorX += column.width + GAP.column;
    rowHeight = Math.max(rowHeight, column.height);
  }

  return { nodes, edges };
}

export function sessionNodeId(slotId: string): string {
  return `s:${slotId}`;
}

export function agentNodeId(agentId: string): string {
  return `a:${agentId}`;
}

/** Running agents first (most recent last), then the freshest finished ones. */
function sortAgents(agents: AgentView[]): AgentView[] {
  return [...agents].sort((a, b) => {
    const aRunning = a.status === 'running' ? 0 : 1;
    const bRunning = b.status === 'running' ? 0 : 1;
    if (aRunning !== bRunning) return aRunning - bRunning;
    if (aRunning === 0) return a.startedAt - b.startedAt;
    return (b.endedAt ?? b.lastActivityAt) - (a.endedAt ?? a.lastActivityAt);
  });
}

function blockWidth(count: number, width: number, gap: number): number {
  return count === 0 ? 0 : count * width + (count - 1) * gap;
}

function edgeFor(session: SessionView, agent: AgentView, running: boolean): PlacedEdge {
  // Nested agents hang off their parent's card, not the session's.
  const source = agent.parentId && agent.parentId !== session.mainAgentId ? agentNodeId(agent.parentId) : sessionNodeId(session.id);
  return {
    id: `e:${agent.id}`,
    source,
    target: agentNodeId(agent.id),
    running,
    colorIndex: session.colorIndex,
  };
}
