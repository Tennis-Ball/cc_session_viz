import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Process inspection. A pid alone is not proof a session is alive: pids get
 * reused, so the registry's recorded start time has to match too.
 */
export interface ProcPort {
  isAlive(pid: number): boolean;
  /** pid -> `ps` lstart string (UTC), for pid-reuse detection. */
  startTimes(pids: number[]): Promise<Map<number, string>>;
  /** pid -> environment, used to read CMUX_WORKSPACE_ID for grouping. */
  envOf(pid: number): Promise<Record<string, string>>;
}

export class NodeProcPort implements ProcPort {
  isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means the process exists but belongs to someone else.
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  async startTimes(pids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (pids.length === 0) return out;
    try {
      const { stdout } = await run('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
        env: { ...process.env, TZ: 'UTC' },
        timeout: 4000,
      });
      for (const line of stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        if (match?.[1] && match[2]) out.set(Number(match[1]), match[2]);
      }
    } catch {
      // ps can fail if every pid died between the scan and the call.
    }
    return out;
  }

  async envOf(pid: number): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    try {
      const { stdout } = await run('ps', ['-Eww', '-o', 'command=', '-p', String(pid)], { timeout: 4000 });
      for (const token of stdout.split(/\s+/)) {
        const eq = token.indexOf('=');
        if (eq <= 0) continue;
        const key = token.slice(0, eq);
        if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
        env[key] = token.slice(eq + 1);
      }
    } catch {
      // Not fatal: cmux grouping is an enrichment, never a requirement.
    }
    return env;
  }
}
