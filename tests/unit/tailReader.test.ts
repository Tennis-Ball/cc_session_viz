import { describe, expect, it } from 'vitest';
import { TailReader } from '@engine/io/tailReader';
import type { FileStat, FsPort } from '@engine/ports/fs';

/** In-memory file whose contents and inode the test controls. */
class MemoryFs implements FsPort {
  content = '';
  ino = 1;

  async stat(): Promise<FileStat | null> {
    const size = Buffer.byteLength(this.content);
    return { size, mtimeMs: 0, birthtimeMs: 0, ino: this.ino };
  }
  async readdir(): Promise<string[]> {
    return [];
  }
  async readText(): Promise<string | null> {
    return this.content;
  }
  async readRange(_path: string, start: number, end: number): Promise<Buffer> {
    return Buffer.from(this.content).subarray(start, end);
  }
  watch(): () => void {
    return () => {};
  }
}

describe('TailReader', () => {
  it('returns only complete lines and never repeats one', async () => {
    const fs = new MemoryFs();
    const reader = new TailReader(fs, 'x.jsonl');
    fs.content = '{"a":1}\n{"b":2}\n';

    expect((await reader.read()).lines).toEqual(['{"a":1}', '{"b":2}']);
    expect((await reader.read()).lines).toEqual([]);

    fs.content += '{"c":3}\n';
    expect((await reader.read()).lines).toEqual(['{"c":3}']);
  });

  it('holds back a half-written last line until it is finished', async () => {
    const fs = new MemoryFs();
    const reader = new TailReader(fs, 'x.jsonl');
    fs.content = '{"a":1}\n{"partial":';

    expect((await reader.read()).lines).toEqual(['{"a":1}']);

    fs.content += 'true}\n';
    expect((await reader.read()).lines).toEqual(['{"partial":true}']);
  });

  it('restarts when the file shrinks or the path points at a new file', async () => {
    const fs = new MemoryFs();
    const reader = new TailReader(fs, 'x.jsonl');
    fs.content = '{"a":1}\n{"b":2}\n';
    await reader.read();

    // /clear writes a brand new transcript at a new path; a truncation looks
    // the same from here and must not leave the reader past the end.
    fs.content = '{"fresh":1}\n';
    const result = await reader.read();
    expect(result.reset).toBe(true);
    expect(result.lines).toEqual(['{"fresh":1}']);
  });

  it('notices a new inode at the same path', async () => {
    const fs = new MemoryFs();
    const reader = new TailReader(fs, 'x.jsonl');
    fs.content = '{"a":1}\n';
    await reader.read();

    fs.ino = 2;
    fs.content = '{"a":1}\n{"b":2}\n';
    const result = await reader.read();
    expect(result.reset).toBe(true);
    expect(result.lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('drops the fragment at a mid-file seek, which always lands inside a line', async () => {
    const fs = new MemoryFs();
    fs.content = '{"old":1}\n{"new":2}\n';
    const reader = new TailReader(fs, 'x.jsonl');
    reader.seek(4, 1); // mid-way through the first line

    expect((await reader.read()).lines).toEqual(['{"new":2}']);
  });

  it('keeps whole lines when seeking to a line boundary', async () => {
    const fs = new MemoryFs();
    fs.content = '{"old":1}\n{"new":2}\n';
    const reader = new TailReader(fs, 'x.jsonl');
    reader.seek(0, 1, false);

    expect((await reader.read()).lines).toEqual(['{"old":1}', '{"new":2}']);
  });

  it('caps a single read so a huge backlog cannot stall the engine', async () => {
    const fs = new MemoryFs();
    fs.content = `${'x'.repeat(40)}\n`.repeat(100);
    const reader = new TailReader(fs, 'x.jsonl');

    const first = await reader.read(200);
    expect(first.lines.length).toBeGreaterThan(0);
    expect(first.lines.length).toBeLessThan(100);

    const rest = await reader.read();
    expect(first.lines.length + rest.lines.length).toBe(100);
  });
});
