import { BaseEdge, getBezierPath, type Edge, type EdgeProps } from '@xyflow/react';

export type SubagentEdgeData = { running: boolean };
export type SubagentEdgeType = Edge<SubagentEdgeData, 'subagent'>;

/**
 * Parent → subagent link. Copper, thin, and dashed while the child is working,
 * so a glance at the board shows which branches are still live.
 */
export function SubagentEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps<SubagentEdgeType>): React.JSX.Element {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.35,
  });

  const running = data?.running ?? false;
  return (
    <BaseEdge
      path={path}
      markerEnd={markerEnd}
      style={{
        stroke: '#d97757',
        strokeWidth: 1.5,
        opacity: running ? 0.95 : 0.4,
        strokeDasharray: running ? '5 5' : undefined,
        animation: running ? 'dashdraw 0.6s linear infinite' : undefined,
      }}
    />
  );
}
