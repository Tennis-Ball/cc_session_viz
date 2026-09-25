import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { paletteAt } from '@shared/palette';
import type { AgentView, SessionView, WatchTask, WorkflowRun } from '@shared/model';
import { ContextPill, PhaseBadge } from '../header/ContextPill';
import { Spinner, TuiView } from '../tui/TuiView';
import { StatusLine } from '../tui/StatusLine';

export type TerminalNodeData = {
  session: SessionView;
  /** Present when this card is a running subagent rather than the session. */
  agent?: AgentView;
  watches: WatchTask[];
  workflows: WorkflowRun[];
  now: number;
  cols: number;
  bodyLines: number;
};
export type TerminalNodeType = Node<TerminalNodeData, 'terminal'>;

export function TerminalNode({ data }: NodeProps<TerminalNodeType>): React.JSX.Element {
  const { session, agent, watches, workflows, now, cols, bodyLines } = data;
  const color = paletteAt(session.colorIndex);
  const cardId = agent ? agent.id : session.id;
  const title = agent ? `${agent.agentType} · ${agent.description || 'subagent'}` : session.title;

  return (
    <div
      className="term-node"
      data-phase={agent ? (agent.status === 'running' ? 'working' : 'idle') : session.phase}
      data-unread={!agent && session.unread}
      style={{ ['--node-color' as string]: agent ? 'var(--agent)' : color.base }}
    >
      <Handle type="target" position={Position.Top} />

      <header className="term-node__header">
        <i className="term-node__dot" style={{ background: agent ? 'var(--agent)' : color.base }} />
        <span className="term-node__title">{title}</span>
        {!agent && <ContextPill session={session} />}
        {!agent && <PhaseBadge session={session} />}
        <span className="term-node__spacer" />
        {session.ambient && <span className="mini-chip mini-chip--simulated">sim</span>}
        {!agent && session.worktree && <span className="mini-chip">⎇ {session.worktree.name}</span>}
        {!agent && session.prs[0] && <span className="mini-chip">PR #{session.prs[0].number}</span>}
        {agent?.background && <span className="mini-chip">background</span>}
      </header>

      <div className="term-node__body">
        <TuiView cardId={cardId} cols={cols} maxLines={bodyLines} />
        {!agent && <Spinner session={session} now={now} />}
      </div>

      {!agent && (
        <footer className="term-node__status">
          <StatusLine session={session} watches={watches} workflows={workflows} now={now} />
        </footer>
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
