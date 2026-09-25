import { join } from 'node:path';
import type { FsPort } from '../ports/fs';

/**
 * Finds a session's files on disk.
 *
 * The project folder is derived from the cwd, but a session can *move*: entering
 * a git worktree relocates its transcript to a different project folder mid-run
 * (`relocated` / `worktree-state` lines). So the index is a lookup built by
 * scanning, and it is rebuilt whenever a path stops resolving.
 */

export interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  parentAgentId?: string;
  requestShape?: string;
  requestNonInteractive?: boolean;
  model?: string;
  isFork?: boolean;
  name?: string;
  stoppedByUser?: boolean;
}

export interface SubagentFile {
  agentId: string;
  jsonlPath: string;
  metaPath: string;
  meta: SubagentMeta | null;
  /** Set for agents under `subagents/workflows/<runId>/`. */
  workflowRunId?: string;
}

export interface WorkflowFiles {
  runId: string;
  summaryPath: string;
  journalPath: string;
  agentDir: string;
}

export class Locator {
  private index = new Map<string, string>(); // sessionId -> transcript path
  private indexedAt = 0;

  constructor(
    private readonly fs: FsPort,
    private readonly projectsDir: string,
  ) {}

  /** Scans every project folder. Cheap: a handful of directories. */
  async reindex(): Promise<void> {
    const next = new Map<string, string>();
    for (const project of await this.fs.readdir(this.projectsDir)) {
      const dir = join(this.projectsDir, project);
      for (const entry of await this.fs.readdir(dir)) {
        if (!entry.endsWith('.jsonl')) continue;
        next.set(entry.slice(0, -'.jsonl'.length), join(dir, entry));
      }
    }
    this.index = next;
    this.indexedAt = Date.now();
  }

  async transcriptPath(sessionId: string): Promise<string | null> {
    if (this.index.size === 0) await this.reindex();
    const cached = this.index.get(sessionId);
    if (cached && (await this.fs.stat(cached))) return cached;

    // Either the session is new or it relocated; a rescan answers both.
    if (Date.now() - this.indexedAt > 1000 || cached) await this.reindex();
    const found = this.index.get(sessionId);
    return found && (await this.fs.stat(found)) ? found : null;
  }

  /** `<transcript>/subagents/` holds the sidecars, including workflow agents. */
  async subagents(transcriptPath: string): Promise<SubagentFile[]> {
    const base = transcriptPath.replace(/\.jsonl$/, '');
    const dir = join(base, 'subagents');
    const out: SubagentFile[] = [];

    for (const entry of await this.fs.readdir(dir)) {
      if (!entry.startsWith('agent-') || !entry.endsWith('.jsonl')) continue;
      const agentId = entry.slice('agent-'.length, -'.jsonl'.length);
      out.push(await this.subagentFile(dir, agentId));
    }

    // Workflow agents sit one level deeper, one directory per run.
    const workflowsDir = join(dir, 'workflows');
    for (const runId of await this.fs.readdir(workflowsDir)) {
      const runDir = join(workflowsDir, runId);
      for (const entry of await this.fs.readdir(runDir)) {
        if (!entry.startsWith('agent-') || !entry.endsWith('.jsonl')) continue;
        const agentId = entry.slice('agent-'.length, -'.jsonl'.length);
        out.push({ ...(await this.subagentFile(runDir, agentId)), workflowRunId: runId });
      }
    }

    return out;
  }

  async workflows(transcriptPath: string): Promise<WorkflowFiles[]> {
    const base = transcriptPath.replace(/\.jsonl$/, '');
    const dir = join(base, 'workflows');
    const out: WorkflowFiles[] = [];
    for (const entry of await this.fs.readdir(dir)) {
      if (!entry.endsWith('.json')) continue;
      const runId = entry.slice(0, -'.json'.length);
      out.push({
        runId,
        summaryPath: join(dir, entry),
        journalPath: join(base, 'subagents', 'workflows', runId, 'journal.jsonl'),
        agentDir: join(base, 'subagents', 'workflows', runId),
      });
    }
    return out;
  }

  private async subagentFile(dir: string, agentId: string): Promise<SubagentFile> {
    const metaPath = join(dir, `agent-${agentId}.meta.json`);
    const text = await this.fs.readText(metaPath);
    let meta: SubagentMeta | null = null;
    if (text) {
      try {
        meta = JSON.parse(text) as SubagentMeta;
      } catch {
        meta = null;
      }
    }
    return { agentId, jsonlPath: join(dir, `agent-${agentId}.jsonl`), metaPath, meta };
  }
}
