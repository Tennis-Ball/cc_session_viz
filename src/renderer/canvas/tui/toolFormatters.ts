/**
 * Per-tool header and result rendering for the TUI replica.
 *
 * Claude Code says something different about every tool — `Read 128 lines`,
 * `Found 12 matches`, `Updated wrap.ts with 3 additions` — and those lines are
 * most of what makes a card readable at a glance. Each formatter takes the
 * already-truncated entry and returns display text only; nothing here touches
 * the transcript.
 */

import { fmtDuration, fmtTokens } from '@shared/format';
import type { TranscriptEntry } from '@shared/transcript';
import { span, truncateCells, type TuiClass, type TuiSpan } from './wrap';

export type ToolEntry = Extract<TranscriptEntry, { k: 'tool' }>;

export interface ToolResultBody {
  lines: TuiSpan[][];
  /**
   * How many of `result.totalLines` these lines account for. The caller turns
   * the remainder into `… +N lines (ctrl+o to expand)`; a formatter that
   * summarises the whole result (`Read 128 lines`) claims all of them.
   */
  shown: number;
}

export interface ToolFormatter {
  title: (entry: ToolEntry) => string;
  /** `cols` is passed so a header can truncate itself onto one line. */
  arg: (entry: ToolEntry, cols: number) => string;
  formatResult: (entry: ToolEntry) => ToolResultBody;
}

/** Claude Code shows three lines of command output, four of everything else. */
const BASH_HEAD_LINES = 3;
const HEAD_LINES = 4;
const HUNK_LINES = 4;

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Result text turns red when the call failed; the bullet alone is too quiet. */
export function resultClass(entry: ToolEntry): TuiClass {
  return entry.status === 'error' || entry.status === 'denied' ? 'notice-error' : 'result';
}

function textBody(entry: ToolEntry, text: string, shown: number, cls?: TuiClass): ToolResultBody {
  return { lines: [[span(text, cls ?? resultClass(entry))]], shown };
}

function totalLines(entry: ToolEntry): number {
  return entry.result?.totalLines ?? 0;
}

/** First integer in the engine's summary, when it wrote one. */
function summaryCount(entry: ToolEntry): number | undefined {
  const match = /(\d[\d,]*)/.exec(entry.result?.summary ?? '');
  if (!match?.[1]) return undefined;
  const n = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** Best available count of "things" a result covers. */
function count(entry: ToolEntry): number {
  return summaryCount(entry) ?? totalLines(entry);
}

/** Up to `max` raw output lines, or `(no content)` for a silent tool. */
export function headBody(entry: ToolEntry, max = HEAD_LINES): ToolResultBody {
  const head = entry.result?.head ?? [];
  const kept = head.slice(0, max).map((line) => [span(line.replace(/\t/g, '  '), resultClass(entry))]);
  if (kept.length === 0) return { lines: [[span('(no content)', 'dim')]], shown: 0 };
  return { lines: kept, shown: kept.length };
}

const GENERIC: ToolFormatter = {
  title: (entry) => mcpTitle(entry.title || entry.name),
  arg: (entry) => oneLine(entry.arg),
  formatResult: (entry) => headBody(entry),
};

/** `mcp__server__tool` is unreadable as-is; the TUI shows `server · tool`. */
function mcpTitle(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const [, server = '', ...rest] = name.split('__');
  const tool = rest.join('__');
  return tool ? `${server} · ${tool}` : server;
}

function editResult(entry: ToolEntry): ToolResultBody {
  const diff = entry.diff;
  if (!diff) return headBody(entry);
  const file = basename(entry.arg) || 'file';
  const parts: string[] = [];
  if (diff.added > 0) parts.push(plural(diff.added, 'addition', 'additions'));
  if (diff.removed > 0) parts.push(plural(diff.removed, 'removal', 'removals'));
  const text = parts.length > 0 ? `Updated ${file} with ${parts.join(' and ')}` : `Updated ${file}`;

  const lines: TuiSpan[][] = [[span(text, resultClass(entry))]];
  for (const line of (diff.hunk ?? []).slice(0, HUNK_LINES)) {
    lines.push([span(line.replace(/\t/g, '  '), 'code')]);
  }
  return { lines, shown: totalLines(entry) };
}

const TOKEN_UNITS: Record<string, number> = { k: 1_000, m: 1_000_000 };

/** `Done (7 tool uses · 45.2k tokens · 12s)`, rebuilt from whatever we have. */
function agentResult(entry: ToolEntry): ToolResultBody {
  const source = [entry.result?.summary ?? '', ...(entry.result?.head ?? [])].join('\n');
  const ready = /^\s*(Done \(.*\))\s*$/m.exec(source);
  if (ready?.[1]) return textBody(entry, ready[1], totalLines(entry));

  const uses = /(\d+)\s*tool\s*uses?/i.exec(source);
  const tokens = /([\d.]+)\s*([km])?\s*tokens/i.exec(source);
  const ms = /(\d+)\s*ms\b/i.exec(source);
  const secs = /(?:(\d+)m\s*)?(\d+(?:\.\d+)?)s\b/i.exec(source);

  const parts: string[] = [];
  if (uses?.[1]) parts.push(plural(Number(uses[1]), 'tool use', 'tool uses'));
  if (tokens?.[1]) {
    const unit = TOKEN_UNITS[(tokens[2] ?? '').toLowerCase()] ?? 1;
    parts.push(`${fmtTokens(Number(tokens[1]) * unit)} tokens`);
  }
  if (ms?.[1]) parts.push(fmtDuration(Number(ms[1])));
  else if (secs?.[2]) parts.push(fmtDuration((Number(secs[1] ?? 0) * 60 + Number(secs[2])) * 1000));

  const text = parts.length > 0 ? `Done (${parts.join(' · ')})` : 'Done';
  return textBody(entry, text, totalLines(entry));
}

const TASK_ROW = /^\s*(?:[-*]\s+)?(?:\[([ xX])\]|([☒☑✔✓])|([☐□]))\s*(.*)$/;

function taskResult(entry: ToolEntry): ToolResultBody {
  const head = entry.result?.head ?? [];
  const lines: TuiSpan[][] = [];
  for (const raw of head) {
    if (!raw.trim()) continue;
    const row = TASK_ROW.exec(raw);
    const done = row ? row[1] === 'x' || row[1] === 'X' || row[2] !== undefined : false;
    const label = row ? (row[4] ?? '') : raw.trim();
    lines.push([span(`${done ? '☒' : '☐'} ${label}`, done ? 'task-done' : 'task-open')]);
  }
  if (lines.length === 0) return headBody(entry);
  return { lines, shown: lines.length };
}

function host(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url.trim());
  return (match?.[1] ?? url).replace(/^www\./, '');
}

const READ: ToolFormatter = {
  title: () => 'Read',
  arg: (entry) => basename(entry.arg),
  formatResult: (entry) => {
    const n = summaryCount(entry) ?? (totalLines(entry) || (entry.result?.head.length ?? 0));
    return textBody(entry, `Read ${plural(n, 'line', 'lines')}`, totalLines(entry));
  },
};

const EDIT: ToolFormatter = {
  // Claude Code labels an Edit "Update"; only Write keeps its own name.
  title: (entry) => (entry.name === 'Write' ? 'Write' : 'Update'),
  arg: (entry) => basename(entry.arg),
  formatResult: editResult,
};

const AGENT: ToolFormatter = {
  title: () => 'Agent',
  arg: (entry) => oneLine(entry.arg),
  formatResult: agentResult,
};

const TASKS: ToolFormatter = {
  title: (entry) => entry.title || entry.name,
  arg: () => '',
  formatResult: taskResult,
};

export const TOOL_FORMATTERS: Readonly<Record<string, ToolFormatter>> = {
  Bash: {
    title: () => 'Bash',
    // The command is the header: one line, clipped so it never wraps away.
    arg: (entry, cols) => truncateCells(oneLine(entry.arg), Math.max(8, cols - 8)),
    formatResult: (entry) => headBody(entry, BASH_HEAD_LINES),
  },
  BashOutput: {
    title: () => 'BashOutput',
    arg: (entry, cols) => truncateCells(oneLine(entry.arg), Math.max(8, cols - 14)),
    formatResult: (entry) => headBody(entry, BASH_HEAD_LINES),
  },
  Read: READ,
  NotebookRead: READ,
  Edit: EDIT,
  Write: EDIT,
  MultiEdit: EDIT,
  NotebookEdit: EDIT,
  Grep: {
    title: () => 'Grep',
    arg: (entry) => oneLine(entry.arg),
    formatResult: (entry) =>
      textBody(entry, `Found ${plural(count(entry), 'match', 'matches')}`, totalLines(entry)),
  },
  Glob: {
    title: () => 'Glob',
    arg: (entry) => oneLine(entry.arg),
    formatResult: (entry) =>
      textBody(entry, `Found ${plural(count(entry), 'file', 'files')}`, totalLines(entry)),
  },
  Agent: AGENT,
  Task: AGENT,
  Workflow: {
    title: () => 'Workflow',
    arg: (entry) => oneLine(entry.arg),
    formatResult: (entry) =>
      textBody(entry, '/workflows to view dynamic workflow runs', totalLines(entry), 'dim'),
  },
  Skill: {
    title: () => 'Skill',
    arg: (entry) => oneLine(entry.arg),
    formatResult: (entry) => headBody(entry),
  },
  WebFetch: {
    title: () => 'WebFetch',
    arg: (entry) => host(entry.arg),
    formatResult: (entry) =>
      textBody(entry, `Received ${plural(count(entry), 'line', 'lines')}`, totalLines(entry)),
  },
  WebSearch: {
    title: () => 'WebSearch',
    arg: (entry) => `"${oneLine(entry.arg)}"`,
    formatResult: (entry) =>
      textBody(entry, `Received ${plural(count(entry), 'line', 'lines')}`, totalLines(entry)),
  },
  TodoWrite: TASKS,
  TaskCreate: TASKS,
  TaskUpdate: TASKS,
};

export function formatterFor(name: string): ToolFormatter {
  return TOOL_FORMATTERS[name] ?? GENERIC;
}
