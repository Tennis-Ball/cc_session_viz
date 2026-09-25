import type { TranscriptEntry } from '../../shared/transcript';

const MAX_ENTRIES = 600;
const HEAD_LINES = 8;
const HEAD_CHARS = 4000;

/**
 * The rolling transcript behind one canvas card.
 *
 * Entries are display-ready and already truncated: the renderer must never hold
 * a 70 MB transcript, and the canvas only ever shows the tail anyway. Tool
 * entries are mutable, because a call is drawn as soon as it starts and updated
 * in place when its result lands.
 */
export class EntryLog {
  private entries: TranscriptEntry[] = [];
  private readonly byId = new Map<string, TranscriptEntry>();
  private appended: TranscriptEntry[] = [];
  private updated = new Map<string, TranscriptEntry>();
  /** True once entries have been dropped off the front. */
  hasMore = false;

  append(entry: TranscriptEntry): void {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.appended.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      const dropped = this.entries.splice(0, this.entries.length - MAX_ENTRIES);
      for (const old of dropped) this.byId.delete(old.id);
      this.hasMore = true;
    }
  }

  /** Replaces an entry in place, e.g. a pending tool call gaining its result. */
  replace(entry: TranscriptEntry): void {
    const index = this.entries.findIndex((e) => e.id === entry.id);
    if (index < 0) {
      this.append(entry);
      return;
    }
    this.entries[index] = entry;
    this.byId.set(entry.id, entry);
    // An entry appended in this same batch only needs to go out once.
    const pendingIndex = this.appended.findIndex((e) => e.id === entry.id);
    if (pendingIndex >= 0) this.appended[pendingIndex] = entry;
    else this.updated.set(entry.id, entry);
  }

  get(id: string): TranscriptEntry | undefined {
    return this.byId.get(id);
  }

  all(): TranscriptEntry[] {
    return this.entries;
  }

  drain(): { append: TranscriptEntry[]; update: TranscriptEntry[] } {
    const append = this.appended;
    const update = [...this.updated.values()];
    this.appended = [];
    this.updated = new Map();
    return { append, update };
  }

  /** Called on /clear: the card keeps its place but the conversation restarts. */
  reset(divider: TranscriptEntry): void {
    this.entries = [];
    this.byId.clear();
    this.hasMore = false;
    this.append(divider);
  }
}

/** Shortens tool output to what a card can show, keeping the real line count. */
export function previewResult(text: string): { head: string[]; totalLines: number } {
  if (!text) return { head: [], totalLines: 0 };
  const clipped = text.length > HEAD_CHARS ? text.slice(0, HEAD_CHARS) : text;
  const lines = clipped.split('\n');
  const totalLines = text.split('\n').length;
  return { head: lines.slice(0, HEAD_LINES), totalLines };
}

/**
 * The one-line summary Claude Code shows instead of raw output for tools whose
 * result is a count rather than text.
 */
export function summarizeResult(
  toolName: string,
  result: Record<string, unknown> | undefined,
  text: string,
): string | undefined {
  const num = (key: string): number | undefined => {
    const value = result?.[key];
    return typeof value === 'number' ? value : undefined;
  };

  switch (toolName) {
    case 'Read':
    case 'NotebookRead': {
      const file = result?.['file'] as { numLines?: number } | undefined;
      const lines = file?.numLines ?? (text ? text.split('\n').length : 0);
      return lines ? `Read ${lines} lines` : undefined;
    }
    case 'Grep': {
      const matches = num('matches') ?? (text ? text.split('\n').filter(Boolean).length : 0);
      return `Found ${matches} ${matches === 1 ? 'match' : 'matches'}`;
    }
    case 'Glob': {
      const files = text ? text.split('\n').filter(Boolean).length : 0;
      return `Found ${files} ${files === 1 ? 'file' : 'files'}`;
    }
    case 'Agent':
    case 'Task':
      // The real numbers only arrive with the completion notification.
      return result?.['status'] === 'async_launched' ? 'Running…' : undefined;
    default:
      return undefined;
  }
}

export interface EntryDiff {
  added: number;
  removed: number;
  hunk?: string[];
}

/** Pulls an addition/removal count out of Claude Code's structuredPatch. */
export function diffOf(result: Record<string, unknown> | undefined): EntryDiff | undefined {
  const patch = result?.['structuredPatch'];
  if (!Array.isArray(patch)) return undefined;
  let added = 0;
  let removed = 0;
  const hunk: string[] = [];
  for (const part of patch as { lines?: unknown }[]) {
    if (!Array.isArray(part.lines)) continue;
    for (const raw of part.lines as unknown[]) {
      const line = String(raw);
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
      if (hunk.length < 6) hunk.push(line);
    }
  }
  return { added, removed, ...(hunk.length ? { hunk } : {}) };
}
