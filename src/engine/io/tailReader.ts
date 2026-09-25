import type { FsPort } from '../ports/fs';

const CHUNK = 1024 * 1024;

/**
 * Incremental reader for append-only JSONL.
 *
 * Transcripts reach 70 MB, so nothing may be read twice. Three cases have to be
 * handled or the parser sees corrupt input:
 *  - the last line is usually half-written, so it is held back until it ends;
 *  - a shrinking file (or a new inode at the same path) means a new session file;
 *  - a single read is capped so a huge backlog can't stall the engine.
 */
export class TailReader {
  private offset = 0;
  private carry = '';
  private ino: number | null = null;

  constructor(
    private readonly fs: FsPort,
    readonly path: string,
  ) {}

  private dropFirstLine = false;

  /**
   * Start tailing from a byte offset (used by the cold-load window). An offset
   * mid-file almost certainly lands inside a line, so the first fragment is
   * dropped rather than handed to the parser as a broken record.
   */
  seek(offset: number, ino: number | null = null, dropPartial = offset > 0): void {
    this.offset = offset;
    this.carry = '';
    this.ino = ino;
    this.dropFirstLine = dropPartial;
  }

  get position(): number {
    return this.offset;
  }

  /** Returns complete lines appended since the last call. */
  async read(maxBytes = 16 * 1024 * 1024): Promise<{ lines: string[]; reset: boolean }> {
    const stat = await this.fs.stat(this.path);
    if (!stat) return { lines: [], reset: false };

    let reset = false;
    if (this.ino !== null && stat.ino !== this.ino) {
      // The path now points at a different file (/clear writes a new transcript).
      reset = true;
      this.offset = 0;
      this.carry = '';
    }
    this.ino = stat.ino;

    if (stat.size < this.offset) {
      reset = true;
      this.offset = 0;
      this.carry = '';
    }
    if (stat.size === this.offset) return { lines: [], reset };

    const end = Math.min(stat.size, this.offset + maxBytes);
    const lines: string[] = [];

    while (this.offset < end) {
      const stop = Math.min(end, this.offset + CHUNK);
      const buf = await this.fs.readRange(this.path, this.offset, stop);
      if (buf.length === 0) break;
      this.offset += buf.length;

      const text = this.carry + buf.toString('utf8');
      const parts = text.split('\n');
      // The tail piece may be a partial line; keep it for the next round.
      this.carry = parts.pop() ?? '';
      for (const part of parts) {
        if (this.dropFirstLine) {
          this.dropFirstLine = false;
          continue;
        }
        if (part.length > 0) lines.push(part);
      }
    }

    return { lines, reset };
  }
}
