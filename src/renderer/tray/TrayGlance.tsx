import { useEffect, useMemo, useState } from 'react';
import { fmtTokens } from '@shared/format';
import { countGlance, glancePhrase, glanceSummary, PHASE_LABEL, sortForGlance } from '@shared/glance';
import type { AgentView, SessionView, World } from '@shared/model';
import { paletteAt } from '@shared/palette';
import { engineClient } from '../engine/client';
import { useWorld } from '../store/world';
import './tray.css';

/**
 * The menu bar popover: every session on one line, the ones waiting on you
 * first. It is the same renderer bundle as the window, so it speaks to the
 * engine through the same client and store.
 */
export function TrayGlance(): React.JSX.Element {
  const world = useWorld((s) => s.world);
  const connected = useWorld((s) => s.connected);
  const now = useNow();

  useEffect(() => engineClient.start(), []);

  const sessions = useMemo(() => sortForGlance(Object.values(world.sessions)), [world.sessions]);
  const counts = useMemo(() => countGlance(sessions), [sessions]);
  const { total, working, attention } = counts;

  // Main formats the menu bar title, but only a renderer knows the numbers.
  useEffect(() => {
    window.atrium.tray.report({ total, working, attention });
  }, [total, working, attention]);

  return (
    <div className="glance">
      <header className="glance__head">
        <span className="glance__wordmark">Atrium</span>
        <span className="glance__summary">{glanceSummary(counts)}</span>
      </header>

      {sessions.length === 0 ? (
        <Empty connected={connected} />
      ) : (
        <ol className="glance__list">
          {sessions.map((session) => (
            <GlanceRow
              key={session.id}
              session={session}
              main={world.agents[session.mainAgentId]}
                    helpers={helpersFor(world, session.id)}
              now={now}
            />
          ))}
        </ol>
      )}

      <footer className="glance__actions">
        <button onClick={() => window.atrium.tray.openMain('office')}>Open Office</button>
        <button onClick={() => window.atrium.tray.openMain('canvas')}>Open Canvas</button>
      </footer>
    </div>
  );
}

function GlanceRow({
  session,
  main,
  helpers,
  now,
}: {
  session: SessionView;
  main: AgentView | undefined;
  helpers: readonly AgentView[];
  now: number;
}): React.JSX.Element {
  const color = paletteAt(session.colorIndex);
  const pct = Math.min(100, Math.round(session.context.pct));
  const level = pct >= 85 ? 'crit' : pct >= 60 ? 'warn' : 'ok';

  return (
    <li className="glance-row" data-phase={session.phase}>
      <i className="glance-row__dot" style={{ background: color.base }} />
      <div className="glance-row__body">
        <div className="glance-row__line">
          <span className="glance-row__title">{session.title}</span>
          <span className="glance-row__phase">{PHASE_LABEL[session.phase]}</span>
        </div>
        <div className="glance-row__line">
          <span className="glance-row__phrase">{glancePhrase(session, main, now, helpers)}</span>
          <span
            className="glance-row__context"
            title={`${fmtTokens(session.context.used)} / ${fmtTokens(session.context.window)} tokens`}
          >
            <span className="glance-row__bar" data-level={level}>
              <i style={{ width: `${pct}%` }} />
            </span>
            {pct}%
          </span>
        </div>
      </div>
    </li>
  );
}

/** Nothing running is the normal state, so it gets a picture rather than a line. */
function Empty({ connected }: { connected: boolean }): React.JSX.Element {
  return (
    <div className="glance__empty">
      <svg viewBox="0 0 32 32" width="44" height="44" aria-hidden="true">
        <path d="M16 3.2 L26.87 25.38 L5.13 25.38 Z" fill="currentColor" />
        <ellipse cx="16" cy="26.08" rx="11.04" ry="4" fill="currentColor" />
      </svg>
      <p>{connected ? 'No sessions running' : 'Looking for sessions'}</p>
    </div>
  );
}

/**
 * A once-a-second clock for the "quiet for 4m" line, stopped while the popover
 * is hidden — which is nearly all of the time.
 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  const [visible, setVisible] = useState(false);

  useEffect(() => window.atrium.window.onState((state) => setVisible(state.visible)), []);

  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [visible]);

  return now;
}

/**
 * A session's subagents. Recomputed per render rather than memoised: a handful
 * of sessions with a handful of agents each is nothing, and a stale list here
 * would show the wrong thing at exactly the moment a fan-out starts.
 */
function helpersFor(world: World, slotId: string): AgentView[] {
  return Object.values(world.agents).filter((agent) => agent.slotId === slotId && agent.role !== 'main');
}
