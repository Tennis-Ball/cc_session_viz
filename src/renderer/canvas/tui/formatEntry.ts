/**
 * One transcript entry to styled monospace lines: the whole body of a canvas
 * card, reconstructed to look like the Claude Code TUI it came from.
 *
 * Pure and cheap: the caller memoizes on `(entry.id, cols)`, so nothing here
 * may depend on wall-clock time — `ctx.now` is available for callers that want
 * it, but using it would make a memoized card go stale without an id change.
 */

import { fmtClock, fmtDuration, fmtTokens, turnVerb } from '@shared/format';
import type { TranscriptEntry } from '@shared/transcript';
import { markdownLite, mdInline } from './markdownLite';
import { formatterFor, headBody, resultClass, type ToolEntry, type ToolResultBody } from './toolFormatters';
import { span, wrapSpans, type TuiClass, type TuiSpan } from './wrap';

export type { TuiClass, TuiSpan } from './wrap';

export interface TuiLine {
  key: string;
  band?: 'user';
  spans: TuiSpan[];
}

export interface TuiContext {
  cols: number;
  cwd?: string;
  now?: number;
}

/** `  ⎿  ` is five cells, so every extra result line indents five. */
const ELBOW = '  ⎿  ';
const RESULT_INDENT = ELBOW.length;
const BULLET_INDENT = 2;

const NOTICE_CLASS: Record<'info' | 'warning' | 'error', TuiClass> = {
  info: 'notice',
  warning: 'notice-warn',
  error: 'notice-error',
};

const TOOL_BULLET: Record<ToolEntry['status'], TuiClass> = {
  pending: 'dim',
  ok: 'bullet-tool',
  error: 'bullet-error',
  denied: 'bullet-error',
  interrupted: 'bullet-error',
};

export function formatEntry(entry: TranscriptEntry, ctx: TuiContext): TuiLine[] {
  const lines: TuiLine[] = [];
  const add = (spans: TuiSpan[], indent: number, band?: 'user'): void => {
    for (const wrapped of wrapSpans(spans, ctx.cols, indent)) {
      const key = `${entry.id}#${lines.length}`;
      lines.push(band ? { key, band, spans: wrapped } : { key, spans: wrapped });
    }
  };

  switch (entry.k) {
    case 'user': {
      // A prompt is shown verbatim — no markdown — but each of its own lines
      // still starts a row, the way the composer laid it out.
      const rows = entry.text.replace(/\r\n?/g, '\n').split('\n');
      const markers = pasteMarkers(entry);
      rows.forEach((row, i) => {
        const spans: TuiSpan[] = [span(i === 0 ? '> ' : '  ', 'user'), span(row.trimEnd(), 'user')];
        if (i === rows.length - 1) for (const marker of markers) spans.push(span(` ${marker}`, 'dim'));
        add(spans, BULLET_INDENT, 'user');
      });
      break;
    }

    case 'text': {
      if (!entry.text.trim()) break;
      const blocks = markdownLite(entry.text);
      blocks.forEach((block, i) => {
        if (i === 0) add([span('● ', 'bullet'), ...block], BULLET_INDENT);
        else add([span('  '), ...block], BULLET_INDENT);
      });
      break;
    }

    case 'thinking': {
      const suffix = entry.text === null && entry.tokens ? ` (${fmtTokens(entry.tokens)} tokens)` : '';
      add([span(`✻ Thinking…${suffix}`, 'dim')], BULLET_INDENT);
      if (entry.text) {
        for (const line of entry.text.replace(/\r\n?/g, '\n').split('\n')) {
          if (!line.trim()) continue;
          add([span('  '), span(line.trim(), 'thinking')], BULLET_INDENT);
        }
      }
      break;
    }

    case 'tool': {
      const fmt = formatterFor(entry.name);
      const title = fmt.title(entry);
      const arg = fmt.arg(entry, ctx.cols);
      const header: TuiSpan[] = [span('● ', TOOL_BULLET[entry.status]), span(title, 'bold')];
      if (arg) header.push(span(`(${arg})`, 'plain'));
      add(header, BULLET_INDENT);

      const body = toolBody(entry, fmt.formatResult);
      if (!body) break;
      body.lines.forEach((spans, i) => {
        add([span(i === 0 ? ELBOW : ' '.repeat(RESULT_INDENT), 'dim'), ...spans], RESULT_INDENT);
      });
      const hidden = (entry.result?.totalLines ?? 0) - body.shown;
      if (hidden > 0) {
        add(
          [
            span(body.lines.length > 0 ? ' '.repeat(RESULT_INDENT) : ELBOW, 'dim'),
            span(`… +${hidden} lines (ctrl+o to expand)`, 'dim'),
          ],
          RESULT_INDENT,
        );
      }
      break;
    }

    case 'turnEnd':
      add(
        [
          span(
            `✻ ${turnVerb(entry.verbSeed)} for ${fmtDuration(entry.durationMs)} · done ${fmtClock(entry.at)}`,
            'turn',
          ),
        ],
        BULLET_INDENT,
      );
      break;

    case 'compact':
      add(
        [
          span(
            `✻ Conversation compacted · ${fmtTokens(entry.pre)} → ${fmtTokens(entry.post)} tokens`,
            'compact',
          ),
        ],
        BULLET_INDENT,
      );
      break;

    case 'interrupt': {
      // A tool's interruption hangs off the call above it; a turn's does not.
      const prefix = entry.forTool ? ELBOW : '⎿  ';
      add(
        [span(prefix, 'dim'), span('Interrupted · What should Claude do instead?', 'notice-error')],
        prefix.length,
      );
      break;
    }

    case 'notice':
      add([span('※ ', NOTICE_CLASS[entry.level]), ...mdInline(collapse(entry.text), NOTICE_CLASS[entry.level])], BULLET_INDENT);
      break;

    case 'inbound':
      add(
        [span('⎿  ', 'dim'), span(entry.from, 'bold'), span(` ${collapse(entry.text)}`, 'inbound')],
        3,
      );
      break;

    case 'divider':
      add([span(rule(entry.reason === 'clear' ? '/clear' : '/resume', ctx.cols), 'divider')], 0);
      break;

    default: {
      const unreachable: never = entry;
      void unreachable;
    }
  }

  return lines;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `[Image #1]`, `[Pasted text #2]` — the markers the composer leaves behind. */
function pasteMarkers(entry: Extract<TranscriptEntry, { k: 'user' }>): string[] {
  const markers: string[] = [];
  for (let i = 1; i <= entry.images; i++) markers.push(`[Image #${i}]`);
  for (let i = 1; i <= entry.pasted; i++) markers.push(`[Pasted text #${i}]`);
  return markers;
}

function toolBody(
  entry: ToolEntry,
  formatResult: (entry: ToolEntry) => ToolResultBody,
): ToolResultBody | undefined {
  const head = entry.result?.head ?? [];
  // A failure's output *is* the message: never paper over it with a tool's
  // usual summary line ("Found 1 match" for a grep that never ran).
  if (head.length > 0 && (entry.status === 'error' || entry.status === 'denied')) {
    return headBody(entry);
  }
  if (entry.result && (head.length > 0 || entry.result.totalLines > 0)) {
    return formatResult(entry);
  }
  // No output yet: only a finished call still owes the reader a line.
  switch (entry.status) {
    case 'pending':
      return undefined;
    case 'denied':
      return { lines: [[span('No (tell Claude what to do differently)', resultClass(entry))]], shown: 0 };
    case 'interrupted':
      return { lines: [[span('Interrupted · What should Claude do instead?', 'notice-error')]], shown: 0 };
    default:
      return entry.result ? formatResult(entry) : undefined;
  }
}

/** `──────── /clear ────────`, centred on the card. */
function rule(label: string, cols: number): string {
  const text = ` ${label} `;
  const width = Math.trunc(cols);
  if (!Number.isFinite(width) || width <= text.length) return text.trim();
  const left = Math.floor((width - text.length) / 2);
  return `${'─'.repeat(left)}${text}${'─'.repeat(width - text.length - left)}`;
}
