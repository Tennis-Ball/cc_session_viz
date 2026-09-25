import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { fmtDuration, fmtTokens } from '@shared/format';
import type { AgentView } from '@shared/model';

export type CompactAgentNodeData = { agent: AgentView };
export type CompactAgentNodeType = Node<CompactAgentNodeData, 'compactAgent'>;

const STATE_LABEL: Record<AgentView['status'], string> = {
  running: 'working',
  waiting: 'waiting',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
  stale: 'idle',
};

/** A finished subagent: enough to read the outcome without opening anything. */
export function CompactAgentNode({ data }: NodeProps<CompactAgentNodeType>): React.JSX.Element {
  const { agent } = data;
  return (
    <div className="agent-node" data-status={agent.status}>
      <Handle type="target" position={Position.Top} />
      <div className="agent-node__head">
        <i className="agent-node__dot" />
        <span className="agent-node__type">{agent.agentType}</span>
        <span className="agent-node__state">{STATE_LABEL[agent.status]}</span>
      </div>
      <div className="agent-node__task">{agent.description || agent.name || '—'}</div>
      <div className="agent-node__meta">
        {fmtDuration(agent.stats.durationMs)} · ↓ {fmtTokens(agent.stats.tokens)} tokens · {agent.stats.toolUses} tools
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
