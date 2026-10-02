import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  PanOnScrollMode,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { paletteAt } from '@shared/palette';
import type { World } from '@shared/model';
import { engineClient } from '../engine/client';
import { useWorld } from '../store/world';
import { SubagentEdge } from './edges/SubagentEdge';
import { layoutCanvas, SIZES } from './layout/canvasLayout';
import { CompactAgentNode } from './nodes/CompactAgentNode';
import { TerminalNode } from './nodes/TerminalNode';
import { UsagePanel } from './panels/UsagePanel';
import './canvas.css';

const nodeTypes = { terminal: TerminalNode, compactAgent: CompactAgentNode };
const edgeTypes = { subagent: SubagentEdge };

/** Menlo 13px advance width; measured once so wrapping matches the real thing. */
const CHAR_WIDTH = measureCharWidth();
const BODY_PADDING = 20;
const LINE_HEIGHT = 17.2;

export function CanvasView(): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <Board />
    </ReactFlowProvider>
  );
}

/**
 * Below this the body is unreadable anyway, so it stops streaming.
 *
 * Every card on the board was subscribed regardless of where the viewport was
 * or how far out it was zoomed, so a board of thirty sessions streamed thirty
 * transcripts at 4 Hz to draw text the size of a hair. The engine was already
 * built to be told what is visible; nothing was telling it.
 */
const READABLE_ZOOM = 0.3;
/** How far outside the window a card still counts as worth streaming. */
const PREFETCH = 600;

function Board(): React.JSX.Element {
  const world = useWorld((s) => s.world);
  const { fitView, getViewport } = useReactFlow();
  const framed = useRef(false);
  const [viewport, setViewport] = useState(() => getViewport());

  const { nodes, edges, cards } = useMemo(() => buildBoard(world), [world]);

  /*
   * Which cards are actually on screen.
   *
   * Recomputed from the viewport rather than from the node list, so panning
   * changes the subscription and a world patch does not. `subscribeTranscripts`
   * dedupes, so a pan that does not cross a card boundary costs nothing.
   */
  const visibleIds = useMemo(() => {
    if (viewport.zoom < READABLE_ZOOM) return [];
    const { x, y, zoom } = viewport;
    const left = (-x - PREFETCH) / zoom;
    const top = (-y - PREFETCH) / zoom;
    const right = (-x + window.innerWidth + PREFETCH) / zoom;
    const bottom = (-y + window.innerHeight + PREFETCH) / zoom;
    return cards
      .filter((card) => card.x < right && card.x + card.width > left && card.y < bottom && card.y + card.height > top)
      .map((card) => card.cardId);
  }, [cards, viewport]);

  useEffect(() => {
    engineClient.subscribeTranscripts(visibleIds);
  }, [visibleIds]);

  /*
   * Open on the whole board, clamped to a readable scale.
   *
   * This used to centre on one session and nudge it 120px down, which put the
   * rest of the board off the right-hand edge and left more than half the
   * window empty — on a view whose entire job is showing how sessions relate to
   * each other. Fitting says how much there is; the clamp stops a single
   * session being blown up to fill a 1440px window.
   */
  useEffect(() => {
    if (framed.current || nodes.length === 0) return;
    framed.current = true;
    requestAnimationFrame(() => fitView({ padding: 0.12, maxZoom: 0.75, minZoom: 0.08, duration: 0 }));
  }, [nodes, fitView]);

  return (
    <div className="canvas-view">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        /*
         * On move *end*, not on move. React Flow fires `onMove` for every
         * frame of a pan, and rebuilding the visible-card set sixty times a
         * second during a drag costs more than the streaming it is there to
         * save. What LOD needs to know is where the board came to rest.
         */
        onMoveEnd={(_event, next) => setViewport(next)}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        minZoom={0.05}
        maxZoom={2}
        onlyRenderVisibleElements
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        /*
         * Trackpad behaviour, the way a map behaves on macOS: two fingers move
         * the board in both directions, and the only thing that changes the
         * scale is a pinch. Scroll-to-zoom is the default here and it makes a
         * board like this feel like it is fighting you.
         */
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Free}
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        preventScrolling
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={2.5} color="#303030" />
        {/*
         * Both in one corner, and styled in canvas.css rather than left as
         * React Flow's defaults. They were a stock square button stack in one
         * corner and a minimap whose mask was within a shade of the background
         * in another — three different visual languages on a view that is
         * otherwise a careful reproduction of a terminal.
         */}
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          maskColor="rgba(8,9,12,0.72)"
          maskStrokeColor="rgba(217,119,87,0.55)"
          maskStrokeWidth={2}
          nodeColor={(node) => (node.data as { color?: string }).color ?? '#d97757'}
          nodeStrokeWidth={0}
          nodeBorderRadius={3}
        />
        <Controls showInteractive={false} position="bottom-right" orientation="horizontal" />
      </ReactFlow>
      <UsagePanel />
    </div>
  );
}

interface BoardCard {
  cardId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function buildBoard(world: World): { nodes: Node[]; edges: Edge[]; cards: BoardCard[] } {
  const layout = layoutCanvas(world);
  const nodes: Node[] = [];
  const cards: BoardCard[] = [];

  const watchesBySlot = new Map<string, typeof world.watches[string][]>();
  for (const watch of Object.values(world.watches)) {
    if (watch.status !== 'active' && watch.status !== 'fired') continue;
    const list = watchesBySlot.get(watch.slotId) ?? [];
    list.push(watch);
    watchesBySlot.set(watch.slotId, list);
  }
  const workflowsBySlot = new Map<string, typeof world.workflows[string][]>();
  for (const run of Object.values(world.workflows)) {
    if (run.status !== 'running') continue;
    const list = workflowsBySlot.get(run.slotId) ?? [];
    list.push(run);
    workflowsBySlot.set(run.slotId, list);
  }

  for (const placed of layout.nodes) {
    const session = world.sessions[placed.sessionId];
    if (!session) continue;
    const color = paletteAt(session.colorIndex).base;

    if (placed.kind === 'compactAgent') {
      const agent = placed.agentId ? world.agents[placed.agentId] : undefined;
      if (!agent) continue;
      nodes.push({
        id: placed.id,
        type: 'compactAgent',
        position: { x: placed.x, y: placed.y },
        width: placed.width,
        height: placed.height,
        data: { agent, color },
        draggable: false,
      });
      continue;
    }

    const agent = placed.agentId ? world.agents[placed.agentId] : undefined;
    if (placed.agentId && !agent) continue;
    cards.push({
      cardId: placed.agentId ?? placed.sessionId,
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height,
    });

    // Body height minus the status footer decides how many lines fit.
    const chrome = placed.kind === 'session' ? 34 + 46 : 34;
    nodes.push({
      id: placed.id,
      type: 'terminal',
      position: { x: placed.x, y: placed.y },
      width: placed.width,
      height: placed.height,
      data: {
        session,
        ...(agent ? { agent } : {}),
        watches: watchesBySlot.get(session.id) ?? [],
        workflows: workflowsBySlot.get(session.id) ?? [],
        color,
        cols: Math.max(20, Math.floor((placed.width - BODY_PADDING) / CHAR_WIDTH)),
        bodyLines: Math.max(3, Math.floor((placed.height - chrome) / LINE_HEIGHT) - 1),
      },
      draggable: false,
    });
  }

  const edges: Edge[] = layout.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'subagent',
    data: { running: edge.running },
  }));

  return { nodes, edges, cards };
}

function measureCharWidth(): number {
  const fallback = 7.8;
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return fallback;
    ctx.font = '13px Menlo, Monaco, monospace';
    const width = ctx.measureText('0'.repeat(50)).width / 50;
    return width > 0 ? width : fallback;
  } catch {
    return fallback;
  }
}

/** Keeps the layout constants importable by tests without pulling in React Flow. */
export { SIZES };
