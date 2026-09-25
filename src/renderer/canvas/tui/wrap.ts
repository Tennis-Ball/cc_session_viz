/**
 * Monospace line breaking for the TUI replica, plus the span vocabulary the
 * rest of the layer speaks.
 *
 * The types live here rather than in formatEntry because this is the lowest
 * layer — markdownLite and toolFormatters both need TuiSpan and neither should
 * import the module that imports them. formatEntry re-exports them, so the
 * public contract is still `formatEntry.ts`.
 */

export type TuiClass =
  | 'dim'
  | 'bold'
  | 'code'
  | 'user'
  | 'bullet'
  | 'bullet-tool'
  | 'bullet-error'
  | 'result'
  | 'thinking'
  | 'turn'
  | 'compact'
  | 'notice'
  | 'notice-warn'
  | 'notice-error'
  | 'inbound'
  | 'divider'
  | 'task-done'
  | 'task-open'
  | 'plain';

export interface TuiSpan {
  text: string;
  cls?: TuiClass;
}

/** Omits `cls` entirely when absent, so emitted spans compare cleanly. */
export function span(text: string, cls?: TuiClass): TuiSpan {
  return cls === undefined ? { text } : { text, cls };
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function isZeroWidth(cp: number): boolean {
  return (
    cp === 0x200d ||
    cp === 0x200b ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  );
}

/** Terminal cells a string occupies. CJK and emoji count double. */
export function cells(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isZeroWidth(cp)) continue;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

/** Truncates to `max` cells, spending the last cell on an ellipsis. */
export function truncateCells(text: string, max: number): string {
  if (max <= 0) return '';
  if (cells(text) <= max) return text;
  let width = 0;
  let cut = 0;
  for (const ch of text) {
    const cw = cells(ch);
    if (width + cw > max - 1) break;
    width += cw;
    cut += ch.length;
  }
  return `${text.slice(0, cut)}…`;
}

interface Chunk {
  text: string;
  cls?: TuiClass;
  w: number;
  space: boolean;
}

function chunksOf(spans: readonly TuiSpan[]): Chunk[] {
  const out: Chunk[] = [];
  for (const s of spans) {
    if (!s.text) continue;
    for (const piece of s.text.split(/(\s+)/)) {
      if (!piece) continue;
      out.push({ text: piece, cls: s.cls, w: cells(piece), space: /^\s+$/.test(piece) });
    }
  }
  return out;
}

/** Splits `text` at `room` cells; `atLeastOne` guarantees forward progress. */
function splitByCells(text: string, room: number, atLeastOne: boolean): [string, string] {
  let width = 0;
  let cut = 0;
  for (const ch of text) {
    const cw = cells(ch);
    if (width + cw > room) break;
    width += cw;
    cut += ch.length;
  }
  if (cut === 0 && atLeastOne) {
    const first = [...text][0] ?? '';
    return [first, text.slice(first.length)];
  }
  return [text.slice(0, cut), text.slice(cut)];
}

function trimEnd(line: TuiSpan[]): TuiSpan[] {
  const out = [...line];
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    const trimmed = last.text.replace(/\s+$/, '');
    if (trimmed === last.text) break;
    out.pop();
    if (trimmed) {
      out.push(span(trimmed, last.cls));
      break;
    }
  }
  return out;
}

/**
 * Wraps one logical line of spans to `cols` cells, breaking on spaces where it
 * can and hard-breaking anything long enough to never fit (paths, urls).
 * Continuation lines are prefixed with `indent` spaces. A non-positive `cols`
 * degrades to no wrapping — a card mid-resize must not spin.
 */
export function wrapSpans(spans: readonly TuiSpan[], cols: number, indent = 0): TuiSpan[][] {
  const chunks = chunksOf(spans);
  if (chunks.length === 0) return [[]];

  const width = Math.trunc(cols);
  if (!Number.isFinite(width) || width <= 0) {
    const single: TuiSpan[] = [];
    for (const chunk of chunks) pushInto(single, chunk.text, chunk.cls);
    return [trimEnd(single)];
  }

  // An indent at or past the right edge would make every wrapped line empty.
  const pad = Math.max(0, Math.min(Math.trunc(indent) || 0, width - 1));
  const padText = ' '.repeat(pad);

  const lines: TuiSpan[][] = [];
  let line: TuiSpan[] = [];
  let used = 0;
  let content = false;

  const flush = (): void => {
    lines.push(trimEnd(line));
    line = pad > 0 ? [span(padText)] : [];
    used = pad;
    content = false;
  };

  for (const chunk of chunks) {
    if (chunk.space) {
      const leading = !content;
      // Whitespace that opens the caller's line is an indent and survives;
      // whitespace that would open a *wrapped* line is just a break we ate.
      if (leading && lines.length > 0) continue;
      if (used + chunk.w > width) {
        if (!leading) {
          flush();
          continue;
        }
        const [head] = splitByCells(chunk.text, width - used, false);
        if (head) {
          pushInto(line, head, chunk.cls);
          used += cells(head);
        }
        continue;
      }
      pushInto(line, chunk.text, chunk.cls);
      used += chunk.w;
      continue;
    }

    let rest = chunk.text;
    let restW = chunk.w;
    if (content && used + restW > width) flush();
    while (used + restW > width) {
      const [head, tail] = splitByCells(rest, width - used, !content);
      if (!head) {
        flush();
        continue;
      }
      pushInto(line, head, chunk.cls);
      content = true;
      flush();
      rest = tail;
      restW = cells(rest);
    }
    if (rest) {
      pushInto(line, rest, chunk.cls);
      used += restW;
      content = true;
    }
  }

  if (content || lines.length === 0) lines.push(trimEnd(line));
  return lines;
}

function pushInto(line: TuiSpan[], text: string, cls?: TuiClass): void {
  const last = line[line.length - 1];
  if (last && last.cls === cls) {
    line[line.length - 1] = span(last.text + text, cls);
    return;
  }
  line.push(span(text, cls));
}
