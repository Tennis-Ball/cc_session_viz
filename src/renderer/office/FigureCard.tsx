import { ACTIVITY_LABEL } from '@shared/activity';
import { fmtDuration, fmtTokens, modelInfo } from '@shared/format';
import type { AgentView, SessionView } from '@shared/model';
import { paletteAt } from '@shared/palette';

/**
 * Who you are looking at.
 *
 * This used to float over the figure's head, which is the obvious thing to do
 * and the wrong one: the card is wider than the figure, so it covered the very
 * thing you pointed at, and it covered whatever was behind it too. Anchoring it
 * to a corner costs the direct connection between card and figure — so the
 * figure grows while it is the subject, and the card leads with the same colour
 * dot the desk and the canvas card use. That is enough to tie the two together
 * without putting a panel on top of the office.
 */
export function FigureCard({
  agent,
  session,
  npc,
  doing,
  talkingTo,
  pinned,
  onOpen,
  onClose,
}: {
  agent?: AgentView | undefined;
  session?: SessionView | undefined;
  npc: boolean;
  /** What a caretaker is up to, in words. See `describeNpc`. */
  doing?: string | undefined;
  /**
   * Who they have stopped to talk to, if anybody.
   *
   * Separate from the activity, and above it, because it is the thing you
   * clicked to find out: two figures standing together doing nothing is the
   * one state the office cannot explain by itself.
   */
  talkingTo?: string | undefined;
  pinned: boolean;
  onOpen: () => void;
  onClose: () => void;
}): React.JSX.Element {
  if (npc) {
    /*
     * What they are doing first, and the disclaimer after.
     *
     * This used to lead with "not one of your sessions, and not doing anything
     * on your behalf", which is true and is an apology rather than an answer.
     * You pointed at somebody carrying a cup across a courtyard and were told
     * it means nothing. The reason these people are here at all is that an
     * office with nobody in it is a diagram — so the card says what they are
     * up to, and then says, smaller, that it means nothing.
     */
    return (
      <aside className="figure-card figure-card--quiet">
        <h4>{talkingTo ?? doing ?? 'Someone who works here'}</h4>
        <p className="figure-card__note">
          Somebody who works here. Not one of your sessions, and nothing they do means anything.
        </p>
        {pinned && (
          <button className="figure-card__close" onClick={onClose}>
            Dismiss
          </button>
        )}
      </aside>
    );
  }

  if (!agent) return <></>;

  const colour = paletteAt(session?.colorIndex ?? 0);
  const model = modelInfo(agent.model.label ?? '');
  const detail = agent.activityDetail;

  return (
    <aside className="figure-card">
      <h4>
        <i className="figure-card__dot" style={{ background: colour.base }} />
        <span className="figure-card__name">{session?.title ?? agent.agentType ?? 'Agent'}</span>
      </h4>

      {talkingTo ? <p className="figure-card__talking">{talkingTo}</p> : null}

      <p className="figure-card__doing">
        {ACTIVITY_LABEL[agent.activity]}
        {detail?.target ? <span className="figure-card__target"> {detail.target}</span> : null}
      </p>

      <dl className="figure-card__facts">
        {agent.role !== 'main' && (
          <div>
            <dt>role</dt>
            <dd>{agent.agentType ?? agent.role}</dd>
          </div>
        )}
        <div>
          <dt>model</dt>
          <dd>{model.label}</dd>
        </div>
        {/*
          * The number the gauge on the desk is showing.
          *
          * The post outside encodes it as a level, which is what you want from
          * across a room and is not what you want once you have pointed at
          * something — and there was nowhere at all to read the actual figure.
          * The mark on the post is the compaction threshold, so that is named
          * here too, or the tick is a line with no caption anywhere.
          */}
        {session && session.context.window > 0 && (
          <div>
            <dt>context</dt>
            <dd>
              {Math.round(session.context.pct)}%
              {session.context.autoCompactPct > 0 && (
                <span className="figure-card__target"> · compacts at {Math.round(session.context.autoCompactPct)}%</span>
              )}
            </dd>
          </div>
        )}
        {agent.stats.toolUses > 0 && (
          <div>
            <dt>tools</dt>
            <dd>{agent.stats.toolUses}</dd>
          </div>
        )}
        {agent.stats.tokens > 0 && (
          <div>
            <dt>tokens</dt>
            <dd>{fmtTokens(agent.stats.tokens)}</dd>
          </div>
        )}
        {agent.stats.durationMs > 0 && (
          <div>
            <dt>for</dt>
            <dd>{fmtDuration(agent.stats.durationMs)}</dd>
          </div>
        )}
      </dl>

      {session && (
        <div className="figure-card__context">
          <span
            className="figure-card__bar"
            role="img"
            aria-label={`context ${Math.round(session.context.pct)}% full`}
          >
            <span style={{ width: `${Math.min(100, session.context.pct)}%`, background: colour.base }} />
          </span>
          <span className="figure-card__pct">{Math.round(session.context.pct)}%</span>
        </div>
      )}

      <div className="figure-card__actions">
        <button onClick={onOpen}>Open terminal</button>
        {pinned && <button onClick={onClose}>Dismiss</button>}
      </div>
    </aside>
  );
}
