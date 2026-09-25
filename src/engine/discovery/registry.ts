import { join } from 'node:path';
import type { Clock } from '../ports/clock';
import type { FsPort } from '../ports/fs';
import type { ProcPort } from '../ports/proc';

/**
 * `~/.claude/sessions/<pid>.json` is Claude Code's live registry: one file per
 * running process, rewritten as its status changes. It is the authoritative
 * answer to "which sessions exist right now", which transcripts alone cannot
 * give (a quiet session looks identical to a dead one on disk).
 */

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  procStart: string;
  version: string;
  kind: string;
  entrypoint: string;
  name?: string;
  nameSource?: string;
  status?: string;
  waitingFor?: string;
  statusUpdatedAt?: number;
  bridgeSessionId?: string | null;
  formerNames?: { name: string; until?: number; sessionId?: string }[];
  messagingSocketPath?: string;
}

export interface LiveSlot extends RegistryEntry {
  /** `${pid}@${startedAt}`: stable across /clear and /resume. */
  slotId: string;
  /** False once the process is gone or a different process reused the pid. */
  alive: boolean;
}

const START_TIME_TOLERANCE_MS = 2000;
const START_TIME_RECHECK_MS = 10_000;

export class Registry {
  private startTimeCheckedAt = 0;
  private verified = new Map<number, boolean>();

  constructor(
    private readonly fs: FsPort,
    private readonly proc: ProcPort,
    private readonly clock: Clock,
    private readonly dir: string,
  ) {}

  /** Reads every registry file and prunes entries whose process is gone. */
  async scan(): Promise<LiveSlot[]> {
    const names = (await this.fs.readdir(this.dir)).filter((n) => n.endsWith('.json'));
    const entries: RegistryEntry[] = [];

    for (const name of names) {
      const text = await this.fs.readText(join(this.dir, name));
      if (!text) continue;
      try {
        const parsed = JSON.parse(text) as RegistryEntry;
        if (typeof parsed.pid === 'number' && typeof parsed.sessionId === 'string') entries.push(parsed);
      } catch {
        // A half-written registry file shows up again on the next scan.
      }
    }

    await this.verifyStartTimes(entries);

    return entries.map((entry) => ({
      ...entry,
      slotId: `${entry.pid}@${entry.startedAt}`,
      alive: this.proc.isAlive(entry.pid) && this.verified.get(entry.pid) !== false,
    }));
  }

  /**
   * Guards against pid reuse: a recycled pid would otherwise resurrect a dead
   * session. Batched into one `ps` call every 10s, since it is not free.
   */
  private async verifyStartTimes(entries: RegistryEntry[]): Promise<void> {
    const now = this.clock.now();
    if (now - this.startTimeCheckedAt < START_TIME_RECHECK_MS) return;
    this.startTimeCheckedAt = now;

    const pids = entries.map((e) => e.pid).filter((pid) => this.proc.isAlive(pid));
    const starts = await this.proc.startTimes(pids);
    const next = new Map<number, boolean>();

    for (const entry of entries) {
      const actual = starts.get(entry.pid);
      if (!actual) continue; // process gone; isAlive already covers it
      next.set(entry.pid, matchesStart(entry.procStart, actual));
    }
    this.verified = next;
  }
}

/**
 * `procStart` and `ps -o lstart=` are both UTC strings, but they can differ by a
 * second either way, so compare as parsed times with a tolerance.
 */
export function matchesStart(recorded: string, actual: string): boolean {
  if (recorded === actual) return true;
  const a = Date.parse(`${recorded} UTC`);
  const b = Date.parse(`${actual} UTC`);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.abs(a - b) <= START_TIME_TOLERANCE_MS;
}
