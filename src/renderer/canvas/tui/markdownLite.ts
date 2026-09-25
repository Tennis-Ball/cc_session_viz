/**
 * The sliver of markdown Claude Code's TUI actually renders: inline emphasis,
 * code spans, headings, list bullets and fenced blocks. There is no block
 * parser — assistant text is streamed prose, not a document, and a real parser
 * would mangle half-written output mid-turn.
 *
 * Everything here is defensive: malformed markdown renders as literal text
 * rather than throwing, and a lone `*` or backtick inside a word stays put.
 */

import { span, type TuiClass, type TuiSpan } from './wrap';

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const FENCE = /^\s*(?:```|~~~)/;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

function runLength(text: string, at: number, ch: string): number {
  let n = 0;
  while (text[at + n] === ch) n++;
  return n;
}

/** Index of the backtick run of exactly `n` that closes a code span. */
function closingTicks(text: string, from: number, n: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== '`') continue;
    const run = runLength(text, i, '`');
    if (run === n) return i;
    i += run - 1;
  }
  return -1;
}

/** Index of the `*` run that closes emphasis opened with `n` asterisks. */
function closingStars(text: string, from: number, n: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== '*') continue;
    if (runLength(text, i, '*') < n) continue;
    // A closer hugs its content: "* foo *" is arithmetic, not emphasis.
    if (i > from && !/\s/.test(text[i - 1] ?? ' ')) return i;
  }
  return -1;
}

/**
 * Inline markdown only. `base` classes the runs that carry no emphasis of
 * their own, which is how a heading makes its whole line bold.
 */
export function mdInline(text: string, base?: TuiClass): TuiSpan[] {
  const out: TuiSpan[] = [];
  let plain = '';

  const flush = (): void => {
    if (plain) out.push(span(plain, base));
    plain = '';
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '`') {
      const ticks = runLength(text, i, '`');
      const close = closingTicks(text, i + ticks, ticks);
      if (close > i + ticks) {
        flush();
        out.push(span(text.slice(i + ticks, close), 'code'));
        i = close + ticks;
        continue;
      }
    } else if (ch === '*') {
      const stars = Math.min(runLength(text, i, '*'), 2);
      const next = text[i + stars];
      const opens = next !== undefined && !/\s/.test(next) && !isWordChar(text[i - 1]);
      const close = opens ? closingStars(text, i + stars, stars) : -1;
      if (close > 0) {
        flush();
        // *italic* is rendered bold-ish: the TUI has no italic that reads well.
        for (const s of mdInline(text.slice(i + stars, close), 'bold')) out.push(s);
        i = close + stars;
        continue;
      }
    }

    plain += ch;
    i++;
  }

  flush();
  return out;
}

/**
 * One assistant message to styled lines, unwrapped. The caller wraps, because
 * only it knows the indent the continuation lines need.
 */
export function markdownLite(text: string): TuiSpan[][] {
  const lines: TuiSpan[][] = [];
  let fenced = false;

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\t/g, '  ');

    if (FENCE.test(line)) {
      fenced = !fenced;
      lines.push(line ? [span(line, 'dim')] : []);
      continue;
    }
    if (fenced) {
      // Verbatim: indentation and punctuation are the point inside a fence.
      lines.push(line ? [span(line, 'dim')] : []);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      lines.push(mdInline(heading[2] ?? '', 'bold'));
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      lines.push([span(`${bullet[1] ?? ''}• `, 'plain'), ...mdInline(bullet[2] ?? '')]);
      continue;
    }

    lines.push(mdInline(line));
  }

  return lines;
}
