import { useEffect, useMemo, useState } from 'react';
import { fmtDuration, fmtTokens } from '@shared/format';
import type { SessionView } from '@shared/model';
import type { TranscriptEntry } from '@shared/transcript';
import { useTranscripts } from '../../store/transcripts';
import { formatEntry, type TuiLine } from './formatEntry';

const EMPTY: TranscriptEntry[] = [];

/**
 * The card body: transcript entries rendered as Claude Code renders them.
 *
 * Only the tail is drawn. Cards are small and the board can hold dozens, so
 * anything above `maxLines` is never in the DOM at all.
 */
export function TuiView({
  cardId,
  cols,
  maxLines,
  waitingFor,
}: {
  cardId: string;
  cols: number;
  maxLines: number;
  /**
   * What this card is for, shown until its first line arrives.
   *
   * A subagent is a card the moment it is spawned and its transcript does not
   * exist until it writes one, which for a card 440×300 meant a rectangle of
   * pure black with an ellipsis in the corner — on a board where two of them
   * sat under a session that was plainly working. An empty terminal reads as
   * broken; an agent that has not said anything yet reads as an agent that has
   * not said anything yet, and the difference is one line of text.
   */
  waitingFor?: string;
}): React.JSX.Element {
  const entries = useTranscripts((s) => s.byCard[cardId]?.entries) ?? EMPTY;

  const lines = useMemo(() => {
    const out: TuiLine[] = [];
    // Walk backwards: only the last screenful is ever formatted.
    for (let i = entries.length - 1; i >= 0 && out.length < maxLines + 8; i--) {
      const entry = entries[i];
      if (!entry) continue;
      out.unshift(...formatEntry(entry, { cols }));
    }
    return out.slice(-maxLines);
  }, [entries, cols, maxLines]);

  if (lines.length === 0) {
    return (
      <div className="tui">
        <div className="tui__line">
          <span className="dim">{waitingFor ? `✶ ${waitingFor}…` : '…'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="tui">
      {lines.map((line) => (
        <div className="tui__line" key={line.key} data-band={line.band}>
          {line.spans.map((span, index) => (
            <span key={index} className={span.cls}>
              {span.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

const GLYPHS = ['✢', '✳', '✶', '✻', '✽'] as const;

/** Claude Code's working line, including its wandering glyph. */
export function Spinner({ session, now }: { session: SessionView; now: number }): React.JSX.Element | null {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!session.turn) return;
    const timer = setInterval(() => setFrame((f) => f + 1), 110);
    return () => clearInterval(timer);
  }, [session.turn]);

  if (!session.turn) return null;
  const elapsed = fmtDuration(now - session.turn.startedAt);
  const label = session.turn.activeForm ?? 'Working';
  const glyph = GLYPHS[frame % GLYPHS.length];

  return (
    <div className="tui__line tui__spinner">
      <span>{glyph} </span>
      <span>
        {label}… ({elapsed}
        {session.turn.outputTokens > 0 ? ` · ↓ ${fmtTokens(session.turn.outputTokens)} tokens` : ''})
      </span>
    </div>
  );
}
