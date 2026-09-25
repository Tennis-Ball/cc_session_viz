import { fmtDuration, fmtTokens, turnVerb } from '@shared/format';
import type { SessionView, WatchTask, WorkflowRun } from '@shared/model';

/**
 * The two lines Claude Code keeps pinned under its input box: the status line
 * and the permission-mode line, plus rows for background work in flight.
 */
export function StatusLine({
  session,
  watches,
  workflows,
  now,
}: {
  session: SessionView;
  watches: WatchTask[];
  workflows: WorkflowRun[];
  now: number;
}): React.JSX.Element {
  const pct = Math.min(100, Math.round(session.context.pct));
  const level = pct >= 85 ? 'crit' : pct >= 60 ? 'warn' : 'ok';
  const branch = session.worktree?.branch ?? session.gitBranch;
  const uptime = fmtDuration(now - session.startedAt);

  return (
    <div>
      <div className="statusline">
        <span>[{session.model.label}]</span>
        <span>▣ {session.repo}</span>
        <span className="statusline__bar" data-level={level}>
          <i
            style={{
              width: `${pct}%`,
              background: level === 'crit' ? 'var(--danger)' : level === 'warn' ? 'var(--caution)' : '#30d158',
            }}
          />
        </span>
        <span>
          {fmtTokens(session.context.used)}/{fmtTokens(session.context.window)} ({pct}%)
        </span>
        {branch && <span>⎇ {branch}</span>}
        <span>● {uptime}</span>
      </div>

      <div className="statusline">
        <span className="statusline__mode">
          {session.permissionMode === 'plan'
            ? '⏸ plan mode on'
            : session.permissionMode === 'auto'
              ? '⏵⏵ auto mode on (shift+tab to cycle)'
              : `⏵ ${session.permissionMode}`}
        </span>
        {session.effort && <span>· {session.effort} effort</span>}
        {session.prs[0] && <span>· PR #{session.prs[0].number}</span>}
        {session.remote && <span>· {session.remote.connected ? 'rc' : 'rc offline'}</span>}
        {session.lastTurn && (
          <span>
            · ✻ {turnVerb(session.lastTurn.verbSeed)} for {fmtDuration(session.lastTurn.durationMs)}
          </span>
        )}
      </div>

      {watches.map((watch) => (
        <div className="statusline" key={watch.id}>
          <span>○ {watch.label}</span>
          <span>
            {watch.kind} · {fmtDuration(now - watch.startedAt)}
            {watch.eventCount > 0 ? ` · ${watch.eventCount} events` : ''}
          </span>
        </div>
      ))}

      {workflows.map((run) => (
        <div className="statusline" key={run.runId}>
          <span>○ {run.name}</span>
          <span>
            {run.phases.filter((p) => p.status === 'done').length}/{run.phases.length} phases ·{' '}
            {run.agentCount} agents
          </span>
        </div>
      ))}
    </div>
  );
}
