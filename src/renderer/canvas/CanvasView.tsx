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

function Board(): React.JSX.Element {
  const world = useWorld((s) => s.world);
  const [now, setNow] = useState(() => Date.now());
  const { setCenter } = useReactFlow();
  const framed = useRef(false);

  // Elapsed times and the spinner move on their own clock, not on world patches.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const { nodes, edges, cardIds } = useMemo(() => buildBoard(world, now), [world, now]);

  useEffect(() => {
    engineClient.subscribeTranscripts(cardIds);
  }, [cardIds]);

  // Open on the session that moved most recently, readable rather than zoomed
  // out to fit a board that can be thousands of pixels wide.
  useEffect(() => {
    if (framed.current || nodes.length === 0) return;
    framed.current = true;
    const newest = Object.values(world.sessions).sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    const focus = nodes.find((node) => node.id === `s:${newest?.id ?? ''}`) ?? nodes[0];
    if (!focus) return;
    const width = focus.width ?? SIZES.session.width;
    const height = focus.height ?? SIZES.session.height;
    requestAnimationFrame(() =>
      setCenter(focus.position.x + width / 2, focus.position.y + height / 2 + 120, { zoom: 0.68, duration: 0 }),
    );
  }, [nodes, world.sessions, setCenter]);

  return (
    <div className="canvas-view">
      <ReactFlow
        nodes={nodes}
        edges={edges}
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
        {/* The bottom-left corner belongs to the usage panel now. */}
        <Controls showInteractive={false} position="top-left" />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          maskColor="rgba(10,12,18,0.6)"
          nodeColor={(node) => (node.data as { color?: string }).color ?? '#d97757'}
        />
      </ReactFlow>
      <UsagePanel />
    </div>
  );
}

function buildBoard(world: World, now: number): { nodes: Node[]; edges: Edge[]; cardIds: string[] } {
  const layout = layoutCanvas(world);
  const nodes: Node[] = [];
  const cardIds: string[] = [];

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
    cardIds.push(placed.agentId ?? placed.sessionId);

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
        now,
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

  return { nodes, edges, cardIds };
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
