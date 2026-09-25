import { fmtTokens } from '@shared/format';
import type { SessionView } from '@shared/model';

/**
 * The context meter from the Claude Code header: model, a small bar, and the
 * percentage. The tick marks where auto-compact will fire, which is the number
 * that actually matters when a session is filling up.
 */
export function ContextPill({ session }: { session: SessionView }): React.JSX.Element {
  const pct = Math.min(100, Math.round(session.context.pct));
  const level = pct >= 85 ? 'crit' : pct >= 60 ? 'warn' : 'ok';
  const threshold = session.context.autoCompactPct;

  return (
    <span
      className="ctx-pill"
      title={`${fmtTokens(session.context.used)} / ${fmtTokens(session.context.window)} tokens · auto-compact at ${threshold}%`}
    >
      <span className="ctx-pill__model">{session.model.label}</span>
      <span className="ctx-pill__bar" data-level={level}>
        <i style={{ width: `${pct}%` }} />
        {threshold > 0 && threshold < 100 && <u style={{ left: `${threshold}%` }} />}
      </span>
      <span>{pct}%</span>
    </span>
  );
}

export function PhaseBadge({ session }: { session: SessionView }): React.JSX.Element | null {
  switch (session.phase) {
    case 'working':
      return (
        <span className="badge">
          <i className="badge__dot" />
          running
        </span>
      );
    case 'attention':
      return (
        <span className="badge badge--attention">
          <i className="badge__dot" />
          {session.attention?.kind === 'question'
            ? 'question'
            : session.attention?.kind === 'planApproval'
              ? 'plan'
              : 'needs you'}
        </span>
      );
    case 'ended':
      return (
        <span className="badge badge--ended">
          <i className="badge__dot" />
          ended
        </span>
      );
    default:
      return null;
  }
}
