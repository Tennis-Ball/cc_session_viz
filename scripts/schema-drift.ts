/**
 * Read-only probe of ~/.claude: tallies every line type, attachment type, tool
 * name and enum value the transcripts contain, and flags anything the engine
 * does not know about yet.
 *
 * Claude Code's transcript format moves fast, so this is the early-warning
 * system for `engine/parse/normalize.ts`.
 *
 *   node scripts/schema-drift.ts [--days 7] [--files 40] [--json out.json]
 *
 * It opens files for reading only and writes nothing except the optional report.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CLAUDE_DIR = join(homedir(), '.claude');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;

interface Args {
  days: number;
  files: number;
  json?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { days: 7, files: 40 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--days' && value) args.days = Number(value);
    if (flag === '--files' && value) args.files = Number(value);
    if (flag === '--json' && value) args.json = value;
  }
  return args;
}

class Tally {
  private readonly counts = new Map<string, number>();
  add(key: string, n = 1): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
  }
  top(limit = 100): [string, number][] {
    return [...this.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }
  keys(): string[] {
    return [...this.counts.keys()];
  }
}

/** Reads the head and tail of a file without loading the middle. */
function readEnds(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      const buf = Buffer.allocUnsafe(size);
      readSync(fd, buf, 0, size, 0);
      return buf.toString('utf8');
    }
    const head = Buffer.allocUnsafe(HEAD_BYTES);
    readSync(fd, head, 0, HEAD_BYTES, 0);
    const tail = Buffer.allocUnsafe(TAIL_BYTES);
    readSync(fd, tail, 0, TAIL_BYTES, size - TAIL_BYTES);
    return `${head.toString('utf8')}\n${tail.toString('utf8')}`;
  } finally {
    closeSync(fd);
  }
}

interface Report {
  scannedFiles: number;
  scannedLines: number;
  parseFailures: number;
  lineTypes: [string, number][];
  systemSubtypes: [string, number][];
  attachmentTypes: [string, number][];
  toolNames: [string, number][];
  originKinds: [string, number][];
  permissionModes: [string, number][];
  stopReasons: [string, number][];
  assistantErrors: [string, number][];
  usageSpeeds: [string, number][];
  efforts: [string, number][];
  toolDenialKinds: [string, number][];
  contentBlockTypes: [string, number][];
  toolUseResultKeys: [string, number][];
  subagentMetaKeys: [string, number][];
  subagentTypes: [string, number][];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cutoff = Date.now() - args.days * 24 * 60 * 60 * 1000;

  const files: { path: string; mtime: number }[] = [];
  for (const project of readdirSync(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, project);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const path = join(dir, entry);
      const mtime = statSync(path).mtimeMs;
      if (mtime >= cutoff) files.push({ path, mtime });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const selected = files.slice(0, args.files);

  const lineTypes = new Tally();
  const systemSubtypes = new Tally();
  const attachmentTypes = new Tally();
  const toolNames = new Tally();
  const originKinds = new Tally();
  const permissionModes = new Tally();
  const stopReasons = new Tally();
  const assistantErrors = new Tally();
  const usageSpeeds = new Tally();
  const efforts = new Tally();
  const toolDenialKinds = new Tally();
  const contentBlockTypes = new Tally();
  const toolUseResultKeys = new Tally();
  const subagentTypes = new Tally();

  let scannedLines = 0;
  let parseFailures = 0;

  for (const { path } of selected) {
    for (const raw of readEnds(path).split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('{')) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        parseFailures++;
        continue;
      }
      scannedLines++;

      const type = String(entry['type'] ?? '(none)');
      lineTypes.add(type);

      if (type === 'system' && entry['subtype']) systemSubtypes.add(String(entry['subtype']));
      if (type === 'attachment') {
        const attachment = entry['attachment'] as { type?: string } | undefined;
        attachmentTypes.add(String(attachment?.type ?? '(none)'));
      }
      if (entry['permissionMode']) permissionModes.add(String(entry['permissionMode']));
      if (entry['toolDenialKind']) toolDenialKinds.add(String(entry['toolDenialKind']));
      if (entry['effort']) efforts.add(String(entry['effort']));

      const origin = entry['origin'] as { kind?: string } | undefined;
      if (origin?.kind) originKinds.add(origin.kind);

      const result = entry['toolUseResult'];
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        for (const key of Object.keys(result as Record<string, unknown>)) toolUseResultKeys.add(key);
      }

      const message = entry['message'] as
        | { content?: unknown; stop_reason?: string; usage?: { speed?: string } }
        | undefined;
      if (message?.stop_reason) stopReasons.add(message.stop_reason);
      if (message?.usage?.speed) usageSpeeds.add(message.usage.speed);
      if (entry['error']) assistantErrors.add(String(entry['error']));

      const content = message?.content;
      if (Array.isArray(content)) {
        for (const block of content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
          if (!block?.type) continue;
          contentBlockTypes.add(block.type);
          if (block.type === 'tool_use' && block.name) {
            toolNames.add(block.name);
            if ((block.name === 'Agent' || block.name === 'Task') && block.input?.['subagent_type']) {
              subagentTypes.add(String(block.input['subagent_type']));
            }
          }
        }
      }
    }
  }

  // Subagent sidecars carry the spawn metadata the transcripts don't.
  const subagentMetaKeys = new Tally();
  for (const { path } of selected) {
    const dir = path.replace(/\.jsonl$/, '');
    let entries: string[];
    try {
      entries = readdirSync(join(dir, 'subagents'));
    } catch {
      continue;
    }
    for (const entry of entries.filter((e) => e.endsWith('.meta.json')).slice(0, 20)) {
      try {
        const meta = JSON.parse(readFileSync(join(dir, 'subagents', entry), 'utf8')) as Record<string, unknown>;
        for (const key of Object.keys(meta)) subagentMetaKeys.add(key);
      } catch {
        parseFailures++;
      }
    }
  }

  const report: Report = {
    scannedFiles: selected.length,
    scannedLines,
    parseFailures,
    lineTypes: lineTypes.top(),
    systemSubtypes: systemSubtypes.top(),
    attachmentTypes: attachmentTypes.top(),
    toolNames: toolNames.top(),
    originKinds: originKinds.top(),
    permissionModes: permissionModes.top(),
    stopReasons: stopReasons.top(),
    assistantErrors: assistantErrors.top(),
    usageSpeeds: usageSpeeds.top(),
    efforts: efforts.top(),
    toolDenialKinds: toolDenialKinds.top(),
    contentBlockTypes: contentBlockTypes.top(),
    toolUseResultKeys: toolUseResultKeys.top(),
    subagentMetaKeys: subagentMetaKeys.top(),
    subagentTypes: subagentTypes.top(),
  };

  console.log(`scanned ${report.scannedFiles} transcripts, ${report.scannedLines} lines\n`);
  for (const [section, rows] of Object.entries(report)) {
    if (!Array.isArray(rows)) continue;
    console.log(`## ${section}`);
    for (const [key, count] of rows as [string, number][]) console.log(`  ${String(count).padStart(7)}  ${key}`);
    console.log('');
  }

  if (args.json) {
    writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report written to ${args.json}`);
  }
}

main();
