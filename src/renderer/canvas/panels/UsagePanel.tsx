import { useEffect, useState } from 'react';
import { fmtAgo, fmtResetIn } from '@shared/format';
import type { UsageBar, UsageState } from '@shared/model';
import { useWorld } from '../../store/world';

/**
 * Plan limits in the corner of the board.
 *
 * Deliberately quiet: the cards are what you came to look at, so this is a
 * small card of thin bars that says where the day stands and gets out of the
 * way. Every number here comes from the account itself — there is no estimate
 * to fall back on, so when the account cannot be reached the panel says what
 * happened and what would fix it instead of drawing a bar nobody can trust.
 */

/** Minutes are the finest unit on show, so a slow tick is enough. */
const TICK_MS = 30_000;

interface Trouble {
  /** Header badge: two words at most, lowercase, no alarm. */
  tag: string;
  /** What happened, said once, when there are no numbers to show instead. */
  title: string;
  /** The next move. Every one of these is something the user can actually do. */
  hint: string;
}

/**
 * The credentials are read once per run and never refreshed here — that is
 * Claude Code's to do — so anything that needs new credentials also needs
 * Atrium reopened, and the advice says so rather than implying a retry that
 * will not happen.
 */
const TROUBLE: Record<Exclude<UsageState, 'live'>, Trouble> = {
  signedOut: {
    tag: 'signed out',
    title: 'No account credentials on this Mac.',
    hint: 'Sign in with Claude Code, then reopen Atrium.',
  },
  expired: {
    tag: 'expired',
    title: 'The saved credentials have expired.',
    hint: 'Run Claude Code once to refresh them, then reopen Atrium.',
  },
  noAccess: {
    tag: 'no access',
    title: 'Keychain access was declined.',
    hint: 'Atrium reads the Claude Code credentials once per run. Allow the prompt and reopen Atrium.',
  },
  offline: {
    tag: 'offline',
    title: "Can't reach the usage service.",
    hint: 'Trying again in a couple of minutes.',
  },
  timedOut: {
    tag: 'timed out',
    title: 'The usage check took too long.',
    hint: 'Trying again in a couple of minutes.',
  },
  serverError: {
    tag: 'unavailable',
    title: 'The usage service turned the check away.',
    hint: 'Trying again in a couple of minutes.',
  },
  unreadable: {
    tag: 'unreadable',
    title: 'The reply was not a shape Atrium knows.',
    hint: 'Your account is fine; Atrium may need an update.',
  },
};

export function UsagePanel(): React.JSX.Element | null {
  const usage = useWorld((s) => s.world.usage);
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Nothing to say until the first snapshot lands; an empty frame is noise.
  if (!usage) return null;

  const trouble = usage.state === 'live' ? null : TROUBLE[usage.state];
  const headline = trouble && usage.detail ? `${trouble.title} (${usage.detail})` : trouble?.title;
  // Numbers plus a problem means the last reading survived a failed refresh.
  // The age stamp carries the caveat, so the body only needs the way out.
  const stale = trouble !== null && usage.bars.length > 0;

  return (
    <section className="usage-panel" data-open={open} data-state={usage.state} aria-label="Plan usage">
      <button className="usage-panel__head" onClick={() => setOpen((value) => !value)}>
        <span className="usage-panel__mark">✦</span>
        <span className="usage-panel__title">Usage</span>
        {usage.updatedAt > 0 && (
          <>
            <span className="usage-panel__sep">·</span>
            <span className="usage-panel__stamp">Updated {fmtAgo(now - usage.updatedAt)}</span>
          </>
        )}
        {trouble && (
          <span className="usage-panel__tag" title={headline}>
            {trouble.tag}
          </span>
        )}
      </button>

      {open && (
        <div className="usage-panel__body">
          {usage.bars.map((bar) => (
            <Row key={bar.id} bar={bar} now={now} />
          ))}

          {trouble && (
            <p className="usage-panel__trouble">
              {!stale && <strong>{headline}</strong>}
              <span>{trouble.hint}</span>
            </p>
          )}

          {/* Whose limits these are. Worth saying on a machine that has been
              signed in as more than one person, and worth nothing at all when
              there is no name to give, so it is left out rather than faked. */}
          {usage.account && <footer className="usage-panel__foot">{usage.account}</footer>}
        </div>
      )}
    </section>
  );
}

function Row({ bar, now }: { bar: UsageBar; now: number }): React.JSX.Element {
  const pct = Math.min(100, Math.round(bar.pct));
  // The account's own severity wins where it has one; otherwise the same
  // thresholds as the context pill, so a full bar means the same thing wherever
  // it appears on the board.
  const level =
    bar.severity === 'locked' || bar.severity === 'critical'
      ? 'crit'
      : bar.severity === 'warning'
        ? 'warn'
        : pct >= 85
          ? 'crit'
          : pct >= 60
            ? 'warn'
            : 'ok';

  return (
    <div className="usage-row" data-binding={bar.binding === true} title={detailOf(bar)}>
      <div className="usage-row__head">
        <span className="usage-row__label">{bar.label}</span>
        <span className="usage-row__pct">{pct}% used</span>
      </div>
      <span className="usage-row__bar" data-level={level}>
        <i style={{ width: `${pct}%` }} />
      </span>
      {bar.resetsAt !== undefined && <span className="usage-row__reset">{fmtResetIn(bar.resetsAt - now)}</span>}
    </div>
  );
}

function detailOf(bar: UsageBar): string {
  if (bar.severity === 'locked') return `${bar.label}: locked until it resets`;
  return bar.binding ? `${bar.label}: the limit in force right now` : bar.label;
}
