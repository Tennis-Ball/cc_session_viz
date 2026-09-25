import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtTokens } from '@shared/format';
import { glancePhrase, glanceSummary, PHASE_LABEL, sortForGlance } from '@shared/glance';
import type { AgentView, SessionView, World } from '@shared/model';
import { paletteAt } from '@shared/palette';
import { useUi } from '../store/ui';
import { useWorld } from '../store/world';
import { COUNTER_LEGEND, contextLevel, contextPercent, counterCounts, counterDots } from './counter';
import './counter.css';

/** Long enough that crossing the title bar never opens it; short enough to feel like a tooltip. */
const OPEN_DELAY_MS = 240;
/** Covers the trip from the chip down into the panel and back. */
const CLOSE_DELAY_MS = 160;

/**
 * The counter in the title bar, and the panel that explains it.
 *
 * The chip is two coloured numbers with no caption, which is fine once you know
 * them and opaque until then, so the panel is both a key to the dots and the
 * same one-line-per-session list the menu bar popover shows — sorted and
 * phrased by `@shared/glance`, so the two never disagree.
 *
 * Hover opens it after a beat because reading the counter is the common case
 * and should cost nothing; a click pins it, because clicking a row is the other
 * thing you want to do and a panel that vanishes when you aim at it is useless.
 */
export function SessionCounter(): React.JSX.Element {
  const world = useWorld((s) => s.world);
  const connected = useWorld((s) => s.connected);
  const select = useUi((s) => s.select);
  const setMode = useUi((s) => s.setMode);

  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessions = useMemo(() => sortForGlance(Object.values(world.sessions)), [world.sessions]);
  const counts = useMemo(() => counterCounts(sessions), [sessions]);
  const dots = counterDots(counts);
  const now = useNow(open);

  const cancel = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const schedule = useCallback(
    (next: boolean, delay: number): void => {
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        setOpen(next);
      }, delay);
    },
    [cancel],
  );

  const close = useCallback((): void => {
    cancel();
    setPinned(false);
    setOpen(false);
  }, [cancel]);

  // Pinned wins over the pointer in both directions: once you have clicked it
  // open, leaving does not close it, and nothing reopens it behind your back.
  const onEnter = useCallback((): void => {
    if (pinned) return;
    schedule(true, OPEN_DELAY_MS);
  }, [pinned, schedule]);

  const onLeave = useCallback((): void => {
    if (pinned) {
      cancel();
      return;
    }
    schedule(false, CLOSE_DELAY_MS);
  }, [pinned, cancel, schedule]);

  const onToggle = useCallback((): void => {
    cancel();
    if (pinned) {
      setPinned(false);
      setOpen(false);
      return;
    }
    setPinned(true);
    setOpen(true);
  }, [pinned, cancel]);

  useEffect(() => cancel, [cancel]);

  // Escape closes it from anywhere; focus is never trapped, so the panel's
  // buttons are simply next in the tab order after the chip.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  // A pinned panel has no pointer to leave, so it needs the click-away instead.
  useEffect(() => {
    if (!open || !pinned) return;
    const onDown = (event: PointerEvent): void => {
      if (!anchor.current?.contains(event.target as Node)) close();
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open, pinned, close]);

  // Clicking a row goes where the office goes when you click a figure: the
  // counter answers "who needs me", the canvas answers "what did they say".
  const openSession = useCallback(
    (session: SessionView): void => {
      select(session.mainAgentId);
      setMode('canvas');
      close();
    },
    [select, setMode, close],
  );

  return (
    <div className="counter" ref={anchor} onPointerEnter={onEnter} onPointerLeave={onLeave}>
      <button
        className="chip counter__chip"
        aria-expanded={open}
        aria-controls="session-counter"
        aria-label={`Sessions: ${glanceSummary(counts)}`}
        onClick={onToggle}
      >
        {dots.map((dot) => (
          <span key={dot.phase} className="counter__count">
            <i className={`dot dot--${dot.phase}`} />
            {dot.count}
          </span>
        ))}
      </button>

      {open && (
        <div className="counter__pop" id="session-counter">
          <div className="counter__panel" role="group" aria-label="Session activity">
            <header className="counter__head">
              <span className="counter__wordmark">Sessions</span>
              <span className="counter__summary">{glanceSummary(counts)}</span>
            </header>

            <div className="counter__legend">
              <p className="counter__note">Each dot counts the sessions in one state.</p>
              <ul>
                {COUNTER_LEGEND.map((entry) => (
                  <li key={entry.phase}>
                    <i className={`dot dot--${entry.phase}`} />
                    <span className="counter__legend-name">{entry.name}</span>
                    <span className="counter__legend-why">{entry.why}</span>
                  </li>
                ))}
              </ul>
            </div>

            {sessions.length === 0 ? (
              <p className="counter__empty">
                {connected ? 'No sessions yet — the first one appears here as it starts.' : 'Looking for sessions…'}
              </p>
            ) : (
              <ul className="counter__list">
                {sessions.map((session) => (
                  <CounterRow
                    key={session.id}
                    session={session}
                    main={world.agents[session.mainAgentId]}
                    helpers={helpersFor(world, session.id)}
                    now={now}
                    onOpen={openSession}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CounterRow({
  session,
  main,
  helpers,
  now,
  onOpen,
}: {
  session: SessionView;
  main: AgentView | undefined;
  helpers: readonly AgentView[];
  now: number;
  onOpen: (session: SessionView) => void;
}): React.JSX.Element {
  const color = paletteAt(session.colorIndex);
  const pct = contextPercent(session.context.pct);

  return (
    <li>
      <button className="counter-row" data-phase={session.phase} onClick={() => onOpen(session)}>
        <i className="counter-row__dot" style={{ background: color.base }} />
        <span className="counter-row__body">
          <span className="counter-row__line">
            <span className="counter-row__title">{session.title}</span>
            <span className="counter-row__phase">{PHASE_LABEL[session.phase]}</span>
          </span>
          <span className="counter-row__line">
            <span className="counter-row__phrase">{glancePhrase(session, main, now, helpers)}</span>
            <span
              className="counter-row__context"
              title={`${fmtTokens(session.context.used)} / ${fmtTokens(session.context.window)} tokens`}
            >
              <span className="counter-row__bar" data-level={contextLevel(pct)}>
                <i style={{ width: `${pct}%` }} />
              </span>
              {pct}%
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}

/** The "quiet for 4m" lines need a clock, but only while somebody is reading them. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

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
