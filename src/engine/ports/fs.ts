import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';

/**
 * Filesystem access, behind a port so sim/replay/tests can serve a virtual
 * ~/.claude through the exact same parsing path as the real one.
 */

export interface FileStat {
  size: number;
  mtimeMs: number;
  /** Creation time: for a subagent transcript this is when the agent started. */
  birthtimeMs: number;
  ino: number;
}

export type WatchListener = (path: string) => void;

export interface FsPort {
  stat(path: string): Promise<FileStat | null>;
  readdir(path: string): Promise<string[]>;
  /** Whole-file read for small JSON sidecars; null when missing or unreadable. */
  readText(path: string): Promise<string | null>;
  /** Byte range read, used for incremental tailing. */
  readRange(path: string, start: number, end: number): Promise<Buffer>;
  /** Recursive directory watch. Events are hints only; truth comes from stat. */
  watch(dir: string, listener: WatchListener): () => void;
}

export class NodeFsPort implements FsPort {
  async stat(path: string): Promise<FileStat | null> {
    try {
      const s = await stat(path);
      return { size: s.size, mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs, ino: Number(s.ino) };
    } catch {
      return null;
    }
  }

  async readdir(path: string): Promise<string[]> {
    try {
      return await readdir(path);
    } catch {
      return [];
    }
  }

  async readText(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  }

  async readRange(path: string, start: number, end: number): Promise<Buffer> {
    if (end <= start) return Buffer.alloc(0);
    const handle = await open(path, 'r');
    try {
      const length = end - start;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    } catch {
      return Buffer.alloc(0);
    } finally {
      await handle.close();
    }
  }

  /**
   * macOS backs recursive fs.watch with FSEvents: one kernel stream for the
   * whole tree and no native module to rebuild for Electron. Events coalesce and
   * can be lost across sleep, so callers must keep a safety stat poll.
   */
  watch(dir: string, listener: WatchListener): () => void {
    let watcher: FSWatcher | null = null;
    try {
      watcher = fsWatch(dir, { recursive: true, persistent: true }, (_event, filename) => {
        if (filename) listener(String(filename));
      });
      watcher.on('error', (err) => console.warn(`[fs] watch error on ${dir}:`, err));
    } catch (err) {
      console.warn(`[fs] could not watch ${dir}:`, err);
    }
    return () => watcher?.close();
  }
}
