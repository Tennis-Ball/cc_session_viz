/**
 * Records an anonymized copy of a real `~/.claude` session into `fixtures/`.
 *
 * The engine's parser and reducers are tested against real transcript shapes,
 * but real transcripts are private. So this keeps every bit of *structure* —
 * field names, enum values, id shapes, timestamps, usage numbers, line order —
 * and swaps the human-readable *content* for deterministic lorem-ish filler of
 * roughly the same length and line count.
 *
 *   node scripts/record-fixture.ts --name <fixtureName> [--session <id|latest>]
 *                                  [--max-lines 4000] [--tail] [--list]
 *
 * `--list` prints the candidate sessions and exits. With no `--session` it takes
 * the most recently modified transcript that has subagents. `--max-lines` keeps
 * the first 200 lines (where the session metadata lives) plus the tail, and
 * records the gap in the manifest; `--tail` keeps the tail alone.
 *
 * Three more knobs exist for fitting a large session under the size budget:
 * `--sub-lines N` caps each subagent transcript, `--budget BYTES` stops adding
 * sidecars once the fixture reaches that size, and `--seed N` selects the
 * anonymization seed (the same seed reproduces a fixture byte for byte).
 *
 * It opens `~/.claude` for reading only and writes nothing outside `fixtures/`.
 *
 * Node 24 runs this with native type stripping, so the syntax here stays
 * erasable: no enums, no parameter properties, no namespaces, no dependencies
 * and no imports from `src/`.
 */

import {
  readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync,
  openSync, readSync, closeSync, fstatSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, extname } from 'node:path';

const CLAUDE_DIR = join(homedir(), '.claude');
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
const SESSIONS_DIR = join(CLAUDE_DIR, 'sessions');
const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');

/** Per-fixture byte budget; subagent transcripts are capped to stay under it. */
const DEFAULT_BUDGET_BYTES = 3 * 1024 * 1024;
/** `--max-lines` keeps this many lines from the head, where session metadata lives. */
const HEAD_LINES = 200;

// ---------------------------------------------------------------------------
// deterministic randomness
// ---------------------------------------------------------------------------

/** FNV-1a, salted with the seed. Same string + seed always lands on the same hash. */
function hash32(input: string, seed: number): number {
  let h = (2166136261 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** xorshift32 stream seeded from `input`, so every string gets its own sequence. */
function makeRng(input: string, seed: number): () => number {
  let x = hash32(input, seed) || 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}

function pick<T>(items: readonly T[], rnd: () => number): T {
  return items[Math.floor(rnd() * items.length) % items.length] as T;
}

// ---------------------------------------------------------------------------
// pseudo-text
// ---------------------------------------------------------------------------

const LOREM = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do',
  'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna', 'aliqua', 'enim',
  'ad', 'minim', 'veniam', 'quis', 'nostrud', 'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip',
  'ex', 'ea', 'commodo', 'consequat', 'duis', 'aute', 'irure', 'in', 'reprehenderit', 'voluptate',
  'velit', 'esse', 'cillum', 'eu', 'fugiat', 'nulla', 'pariatur', 'excepteur', 'sint', 'occaecat',
  'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui', 'officia', 'deserunt', 'mollit', 'anim',
  'id', 'est', 'laborum', 'curabitur', 'pretium', 'tincidunt', 'lacus', 'nulla', 'gravida', 'orci',
  'vehicula', 'condimentum', 'integer', 'ultrices', 'neque', 'faucibus', 'rhoncus', 'mattis', 'placerat', 'viverra',
];

const WORDISH = ['alpha', 'bravo', 'cedar', 'delta', 'ember', 'flint', 'grove', 'harbor', 'ivory', 'juniper', 'kestrel', 'lumen', 'marble', 'nimbus', 'onyx', 'pebble', 'quarry', 'ripple', 'summit', 'thicket'];

/** Lorem of exactly `length` characters (as close as a word stream allows). */
function loremOfLength(length: number, rnd: () => number): string {
  if (length <= 0) return '';
  let out = '';
  while (out.length < length) {
    const word = pick(LOREM, rnd);
    out += out.length === 0 ? word : ` ${word}`;
  }
  if (out.length > length) out = out.slice(0, length).replace(/\s$/, '.');
  return out;
}

/** A single lowercase word of roughly `length` characters, for path/host segments. */
function wordOfLength(length: number, rnd: () => number): string {
  if (length <= 0) return '';
  let out = '';
  while (out.length < length) out += pick(WORDISH, rnd);
  return out.slice(0, length);
}

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\bghp_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bgho_[A-Za-z0-9]{16,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./,
];

const LONG_BASE64 = /[A-Za-z0-9+/_-]{200,}={0,2}/;

function looksLikeSecret(value: string): boolean {
  for (const re of SECRET_PATTERNS) if (re.test(value)) return true;
  return false;
}

const REDACTED = '[redacted]';

// ---------------------------------------------------------------------------
// id remapping — new value, identical shape
// ---------------------------------------------------------------------------

const HEX = '0123456789abcdef';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_ID_RE = /^a[0-9a-f]{16}$/;
const PREFIXED_RE = /^([A-Za-z][A-Za-z0-9]{0,7}[_:])(.+)$/;

/** Replaces each character with one of the same class, so length and separators survive. */
function scramble(token: string, seed: number): string {
  const rnd = makeRng(`id:${token}`, seed);
  const hexish = /^[0-9a-f:_-]+$/.test(token);
  let out = '';
  for (const ch of token) {
    if (ch >= '0' && ch <= '9') out += hexish ? pick(HEX.split(''), rnd) : String(Math.floor(rnd() * 10));
    else if (ch >= 'a' && ch <= 'z') out += hexish ? pick(HEX.split(''), rnd) : pick(LOWER.split(''), rnd);
    else if (ch >= 'A' && ch <= 'Z') out += pick(UPPER.split(''), rnd);
    else out += ch;
  }
  return out;
}

const idCache = new Map<string, string>();

/**
 * Remaps an id to a fresh one of the exact same shape: `toolu_01…` keeps its
 * prefix and version digits, uuid v4 keeps its version and variant nibbles,
 * `a`+16 hex keeps its leading `a`. Cached so the same id maps to the same
 * replacement everywhere, which is what keeps cross-file references intact.
 */
function remapId(value: string, seed: number): string {
  if (!value) return value;
  const cacheKey = `${seed}\u0000${value}`;
  const hit = idCache.get(cacheKey);
  if (hit !== undefined) return hit;

  let out: string;
  if (UUID_RE.test(value)) {
    const rnd = makeRng(`uuid:${value}`, seed);
    const hex = (n: number): string => {
      let s = '';
      for (let i = 0; i < n; i++) s += pick(HEX.split(''), rnd);
      return s;
    };
    out = `${hex(8)}-${hex(4)}-${value[14]}${hex(3)}-${value[19]}${hex(3)}-${hex(12)}`;
  } else if (AGENT_ID_RE.test(value)) {
    out = `a${scramble(value.slice(1), seed)}`;
  } else {
    const prefixed = PREFIXED_RE.exec(value);
    if (prefixed) {
      const prefix = prefixed[1] as string;
      let rest = prefixed[2] as string;
      let keep = '';
      const version = /^(\d{2})(.+)$/.exec(rest);
      if (version) {
        keep = version[1] as string;
        rest = version[2] as string;
      }
      out = `${prefix}${keep}${scramble(rest, seed)}`;
    } else {
      out = scramble(value, seed);
    }
  }
  idCache.set(cacheKey, out);
  return out;
}

function looksLikeId(value: string): boolean {
  return UUID_RE.test(value) || AGENT_ID_RE.test(value) || /^[A-Za-z][A-Za-z0-9]{0,7}[_:][A-Za-z0-9_-]{6,}$/.test(value);
}

/**
 * An opaque handle with no prefix to give it away — a task id, a backup file's
 * hash name. Routed through `remapId` rather than word-replaced, so that
 * `<task-id>x</task-id>` and the `…/tasks/x.output` beside it stay the same `x`.
 */
function looksLikeOpaqueToken(value: string): boolean {
  return /^[0-9a-z]{8,}$/.test(value) && /\d/.test(value) && /[a-z]/.test(value);
}

// ---------------------------------------------------------------------------
// paths and urls
// ---------------------------------------------------------------------------

/** Directory names the engine navigates by, so they have to stay literal. */
const LITERAL_SEGMENTS = new Set([
  '', 'Users', 'home', 'private', 'tmp', 'var', 'usr', 'opt', 'etc', 'mnt', 'workspace',
  '.claude', 'projects', 'sessions', 'subagents', 'workflows', 'tasks', 'tool-results',
  'scratchpad', 'node_modules', '.git', 'src', 'tests', 'scripts', 'fixtures', 'dist', 'out',
]);


const pathCache = new Map<string, string>();
/** Exact segment substitutions, so an encoded-cwd directory name and the cwd it
 * encodes never drift apart. The recorder seeds this before it writes anything. */
const segmentAliases = new Map<string, string>();

function registerPathAlias(from: string, to: string): void {
  segmentAliases.set(from, to);
}

/**
 * Rewrites an absolute path keeping its depth, its extension and the layout
 * segments the engine reads (`projects`, `subagents`, `workflows`, …). Session
 * and agent ids inside the path go through `remapId`, so a path in a transcript
 * still points at the fixture file that was written for it.
 */
function pseudoPath(value: string, seed: number): string {
  const cacheKey = `${seed}\u0000${value}`;
  const hit = pathCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const trailing = value.endsWith('/') ? '/' : '';
  const segments = value.replace(/\/+$/, '').split('/');
  const out = segments
    .map((segment, index) => {
      const alias = segmentAliases.get(segment);
      if (alias !== undefined) return alias;
      if (LITERAL_SEGMENTS.has(segment)) return segment;
      if (segment === '.' || segment === '..') return segment;
      if (/^claude-\d+$/.test(segment)) return segment;
      if (looksLikeId(segment) || looksLikeOpaqueToken(segment)) return remapId(segment, seed);
      // `-Users-choim-code-repo` — an encoded-cwd directory the recorder never saw.
      if (/^-[A-Za-z]/.test(segment) && segment.includes('-') && index <= 6) {
        return encodeCwd(pseudoPath(segment.replace(/-/g, '/'), seed));
      }
      const rnd = makeRng(`path:${segment}`, seed);
      // The username right under /Users or /home gets one stable pseudonym.
      if (index === 2 && (segments[1] === 'Users' || segments[1] === 'home')) {
        return wordOfLength(Math.max(3, segment.length), rnd);
      }
      const dot = segment.lastIndexOf('.');
      if (dot > 0 && dot >= segment.length - 12) {
        const ext = segment.slice(dot);
        const stem = segment.slice(0, dot);
        if (looksLikeId(stem) || looksLikeOpaqueToken(stem)) return `${remapId(stem, seed)}${ext}`;
        return `${wordOfLength(Math.max(2, stem.length), rnd)}${ext}`;
      }
      if (segment.startsWith('.')) return `.${wordOfLength(Math.max(2, segment.length - 1), rnd)}`;
      return wordOfLength(Math.max(2, segment.length), rnd);
    })
    .join('/') + trailing;

  pathCache.set(cacheKey, out);
  return out;
}

/** Claude Code's project-directory encoding: `/`, `.` and `_` all become `-`. */
function encodeCwd(cwd: string): string {
  return cwd.replace(/[/._]/g, '-');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

/** Keeps the `local@host.tld` shape and the TLD; the identity goes. */
function pseudoEmail(value: string, seed: number): string {
  const rnd = makeRng(`mail:${value}`, seed);
  const at = value.lastIndexOf('@');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const labels = domain.split('.');
  const host = labels
    .map((label, i) => (i === labels.length - 1 ? label : wordOfLength(Math.max(2, label.length), rnd)))
    .join('.');
  return `${wordOfLength(Math.max(2, local.length), rnd)}@${host}`;
}


/** Keeps the scheme, the label count and the TLD; everything else becomes filler. */
function pseudoUrl(scheme: string, rest: string, seed: number): string {
  const rnd = makeRng(`url:${rest}`, seed);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? '' : rest.slice(slash);
  const portAt = authority.lastIndexOf(':');
  const host = portAt > 0 ? authority.slice(0, portAt) : authority;
  const port = portAt > 0 ? authority.slice(portAt) : '';
  const labels = host.split('.');
  const newHost = labels
    .map((label, i) => (i === labels.length - 1 && labels.length > 1 ? label : wordOfLength(Math.max(2, label.length), rnd)))
    .join('.');
  const newTail = tail
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (/^\d+$/.test(segment)) return String(Math.floor(rnd() * 10 ** segment.length)).padStart(segment.length, '0');
      return wordOfLength(segment.length, rnd);
    })
    .join('/');
  return `${scheme}://${newHost}${port}${newTail}`;
}

// ---------------------------------------------------------------------------
// text anonymization
// ---------------------------------------------------------------------------

/** Markup and bracket markers the engine parses out of plain text. */
const MARKER_RE = new RegExp(
  [
    '<\\/?[a-z][a-z0-9-]*(?:\\s+[a-zA-Z-]+="[^"]*")*\\s*\\/?>',
    '\\[Request interrupted by user[^\\]]*\\]',
    '\\[Pasted text #\\d+ \\+\\d+ lines\\]',
    '\\[Image #\\d+\\]',
    'Async agent launched successfully',
  ].join('|'),
  'g',
);

/** Inside these tags the payload is an id, not prose. */
const ID_TAGS = new Set(['task-id', 'tool-use-id', 'toolu-id', 'agent-id', 'session-id', 'run-id', 'uuid', 'id']);
/** Inside these the payload is an enum or a literal the engine switches on. */
const VERBATIM_TAGS = new Set(['status', 'kind', 'type', 'command-name', 'command-message', 'state', 'result-status']);
/** Inside these the payload is a filesystem path. */
const PATH_TAGS = new Set(['output-file', 'file', 'path', 'file-path', 'cwd']);

/**
 * A preserved tag keeps its name and its attribute *names*, because that is the
 * structure the engine parses. Attribute values are content: an id is remapped so
 * `<agent-message from="a1…">` still points at the right agent, and anything else
 * (`<code class="language-solidity">`) is replaced at the same length.
 */
function remapTagAttributes(tag: string, seed: number): string {
  return tag.replace(/="([^"]*)"/g, (_whole, value: string) => {
    if (looksLikeId(value)) return `="${remapId(value, seed)}"`;
    const replaced = value.replace(/[A-Za-z0-9]+/g, (run) => {
      const rnd = makeRng(`attr:${run}`, seed);
      if (/^\d+$/.test(run)) return String(Math.floor(rnd() * 10 ** run.length)).padStart(run.length, '0');
      return wordOfLength(run.length, rnd);
    });
    return `="${replaced}"`;
  });
}

function tagName(tag: string): string | null {
  const m = /^<\/?([a-z][a-z0-9-]*)/.exec(tag);
  return m ? (m[1] as string) : null;
}

/** A url, an address or an absolute path sitting inside a sentence. */
const EMBEDDED_RE = new RegExp(
  [
    '(\\b[a-z][a-z0-9+.-]*:\\/\\/[^\\s"\'`,;)\\]}<>]+)',
    '([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})',
    '((?:\\/(?:Users|home|private|tmp|var|opt|usr|etc)\\/[^\\s"\'`,;:)\\]}]*)|(?:[A-Z]:\\\\Users\\\\[^\\s"\'`,;)\\]}]*))',
  ].join('|'),
  'g',
);

/**
 * Prose becomes lorem, but a url, address or path embedded in it keeps its own
 * shape — a sentence that mentioned a `.ts` file still mentions a `.ts` file, so
 * the engine's path-sniffing and the renderer's line wrapping stay meaningful.
 */
function renderProse(chunk: string, seed: number): string {
  if (!chunk) return chunk;
  let out = '';
  let cursor = 0;
  EMBEDDED_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EMBEDDED_RE.exec(chunk)) !== null) {
    out += pseudoLine(chunk.slice(cursor, match.index), seed);
    const token = match[0] as string;
    if (match[1]) {
      const url = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(token);
      out += url ? pseudoUrl(url[1] as string, url[2] as string, seed) : token;
    } else if (match[2]) {
      out += pseudoEmail(token, seed);
    } else {
      out += pseudoPath(token, seed);
    }
    cursor = match.index + token.length;
  }
  return out + pseudoLine(chunk.slice(cursor), seed);
}

/** One line of prose becomes lorem of the same length, keeping its indentation. */
function pseudoLine(line: string, seed: number): string {
  if (!line.trim()) return line;
  const leading = /^\s*/.exec(line)?.[0] ?? '';
  const trailing = /\s*$/.exec(line)?.[0] ?? '';
  const body = line.slice(leading.length, line.length - trailing.length);
  if (!body) return line;
  const rnd = makeRng(`text:${body}`, seed);
  return `${leading}${loremOfLength(body.length, rnd)}${trailing}`;
}

/**
 * Turns human text into lorem of the same length and line count, leaving the
 * structural markers the engine parses (`<task-notification>` and its inner
 * tags, `<agent-message …>`, `[Image #N]`, …) exactly where they were.
 */
function pseudoText(value: string, seed: number): string {
  if (!value) return value;
  const lines = value.split('\n');
  const out: string[] = [];
  let openTag: string | null = null;

  for (const line of lines) {
    let cursor = 0;
    let rebuilt = '';
    // A tag context never survives its own line. Prose that happens to mention
    // `<type>` must not switch the rest of the document to verbatim.
    openTag = null;
    MARKER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MARKER_RE.exec(line)) !== null) {
      const gap = line.slice(cursor, match.index);
      rebuilt += renderGap(gap, openTag, seed);
      const marker = match[0] as string;
      cursor = match.index + marker.length;
      if (marker.startsWith('<')) {
        rebuilt += remapTagAttributes(marker, seed);
        const name = tagName(marker);
        // Only an opening tag that is actually closed later on this line opens a
        // context; a lone `<type>` in a sentence is just a marker.
        const closed = name !== null && line.indexOf(`</${name}>`, cursor) !== -1;
        openTag = !marker.startsWith('</') && !marker.endsWith('/>') && closed ? name : null;
      } else {
        rebuilt += marker;
      }
    }
    rebuilt += renderGap(line.slice(cursor), openTag, seed);
    out.push(rebuilt);
  }
  return out.join('\n');
}

function renderGap(gap: string, openTag: string | null, seed: number): string {
  if (!gap) return gap;
  if (openTag) {
    const trimmed = gap.trim();
    if (ID_TAGS.has(openTag)) return trimmed ? gap.replace(trimmed, remapId(trimmed, seed)) : gap;
    if (VERBATIM_TAGS.has(openTag)) return gap;
    if (PATH_TAGS.has(openTag)) return trimmed ? gap.replace(trimmed, pseudoPath(trimmed, seed)) : gap;
  }
  return renderProse(gap, seed);
}

// ---------------------------------------------------------------------------
// the key policy
// ---------------------------------------------------------------------------

/** Values that are human-authored prose, command text or tool output. */
const TEXT_KEYS = new Set([
  'text', 'thinking', 'content', 'command', 'description', 'summary', 'title', 'aiTitle',
  'agentName', 'lastPrompt', 'prompt', 'plan', 'stdout', 'stderr', 'query', 'snippet',
  'script', 'instructions', 'systemPrompt', 'result', 'oldString', 'newString',
  'old_string', 'new_string', 'bashFirstSteer', 'hookAdditionalContext', 'note', 'detail',
  'activeForm', 'subject', 'question', 'header', 'feedback', 'userFeedback', 'workflowName',
  'answers', 'matches', 'workspaceTitle', 'awaySummary', 'bashEditDiff', 'steer',
]);

/** Identifiers: remapped, but the shape survives exactly. */
const ID_KEYS = new Set([
  'uuid', 'parentUuid', 'sessionId', 'session_id', 'leafUuid', 'messageId', 'snapshotMessageId',
  'source_uuid', 'tool_use_id', 'toolUseId', 'toolUseID', 'agentId', 'runId', 'taskId',
  'requestId', 'promptId', 'bridgeSessionId', 'ownerAccountUuid', 'ownerOrganizationUuid',
  'interruptedMessageId', 'sourceToolAssistantUUID', 'backgroundTaskId', 'signature', 'atis',
  'commit', 'key', 'workspaceId', 'surfaceId', 'slug', 'caller', 'spawnToolUseId', 'id',
]);

/** Filesystem paths: depth and extension survive. */
const PATH_KEYS = new Set([
  'cwd', 'file_path', 'filePath', 'path', 'planFilePath', 'outputFile', 'trackingPath',
  'scriptPath', 'workingDirectory', 'scratchpadDirectory', 'messagingSocketPath',
  'originalFile', 'filename', 'output-file', 'projectDir', 'worktreePath',
]);

/**
 * Agent and skill identifiers that ship with Claude Code. These are enum values
 * the engine switches on, so they survive verbatim — unlike a `plugin:skill`
 * name from someone's private plugin, which carries the org name.
 */
const BUILTIN_NAMES = new Set([
  'main', 'general-purpose', 'Explore', 'Plan', 'workflow', 'fork', 'custom', 'claude',
  'statusline-setup', 'output-style-setup', 'code-review', 'security-review', 'init',
]);

/** Keys holding `plugin:skill` / agent-type names, some of which are private. */
const QUALIFIED_NAME_KEYS = new Set([
  'names', 'addedNames', 'removedNames', 'surfacedNames', 'readdedNames', 'addedTypes',
  'removedTypes', 'invokedSkills', 'skills', 'plugin', 'skill', 'pluginName', 'skillName',
  'attributionSkill', 'attributionPlugin', 'attributionAgent', 'commandName', 'agentName_',
]);

/** Agent-type fields: enum-like, but able to carry a `plugin:` prefix. */
const AGENT_TYPE_KEYS = new Set(['subagent_type', 'agentType']);

const qualifiedCache = new Map<string, string>();

/**
 * Rewrites `olympix:auth` as `marble:kestrel`: the `:` the engine splits on stays,
 * each half keeps its length, and built-in names pass through untouched.
 */
function pseudoQualifiedName(value: string, seed: number): string {
  if (BUILTIN_NAMES.has(value)) return value;
  const cacheKey = `${seed}\u0000${value}`;
  const hit = qualifiedCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const out = value
    .split(':')
    .map((part) => (BUILTIN_NAMES.has(part) ? part : wordOfLength(Math.max(2, part.length), makeRng(`qual:${part}`, seed))))
    .join(':');
  qualifiedCache.set(cacheKey, out);
  return out;
}

/** Structural values the engine switches on. Never touched. */
const PRESERVE_KEYS = new Set([
  'type', 'subtype', 'role', 'name', 'subagent_type', 'model', 'advisorModel', 'defaultModel',
  'resolvedModel', 'modelId', 'marketingName', 'knowledgeCutoff', 'permissionMode', 'mode',
  'commandMode', 'stop_reason', 'stop_sequence', 'toolDenialKind', 'status', 'level', 'effort',
  'perTurnEffort', 'speed', 'service_tier', 'inference_geo', 'media_type', 'kind', 'operation',
  'source', 'userType', 'entrypoint', 'promptSource', 'titleSource', 'agentType',
  'requestShape', 'hookEvent', 'hookName', 'platform', 'nameSource', 'pidDomain', 'version',
  'timestamp', 'startedAt', 'updatedAt', 'statusUpdatedAt', 'nameSince', 'startTime', 'procStart',
  'date', 'osVersion', 'shell', 'reminderType',
  'is_error', 'interrupted', '$schema', 'enum', 'required', 'format',
]);
// `error`, `stopReason`, `reason` and `gitBranch` are deliberately absent: short
// enum values survive via the enum-ish rule below, while long ones are prose.

const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?$/;
const SEMVER_RE = /^v?\d+\.\d+(\.\d+)?([-+][\w.]+)?$/;
const MODEL_RE = /^(claude|gpt|gemini|o\d)[\w.\[\]-]*$/i;
/** Short, whitespace-free, punctuation-light: an enum or a slug, not prose. */
const ENUMISH_RE = /^[A-Za-z][A-Za-z0-9_.:@[\]-]{0,40}$/;

function isStructural(value: string): boolean {
  return ISO_RE.test(value) || SEMVER_RE.test(value) || MODEL_RE.test(value) || /^-?\d+(\.\d+)?$/.test(value);
}

/**
 * The single decision point for every string in a transcript. Order matters:
 * explicit secrets first, then the key policy, then generic long-blob
 * redaction, then the structural escape hatch, then prose.
 */
function anonymizeValue(key: string, value: string, seed: number, parent: Record<string, unknown>): string {
  if (looksLikeSecret(value)) return REDACTED;

  // `name` is a tool name everywhere except a session-registry entry (prose) and
  // an invoked skill, which is the only `name` that carries a `plugin:` prefix.
  if (key === 'name' && 'pid' in parent) return pseudoText(value, seed);
  if (key === 'name' && value.includes(':')) return pseudoQualifiedName(value, seed);
  if (QUALIFIED_NAME_KEYS.has(key)) return pseudoQualifiedName(value, seed);
  // Agent types are enum values the engine branches on, so an unqualified one is
  // kept exactly. Only a `plugin:agent` type is rewritten, because the plugin
  // segment is an org name; the `:` the engine splits on stays put.
  if (AGENT_TYPE_KEYS.has(key)) return value.includes(':') ? pseudoQualifiedName(value, seed) : value;
  // Prose — except that a `content` block can hold base64 rather than words, in
  // which case it is dropped instead of being reproduced at full length.
  if (TEXT_KEYS.has(key)) return LONG_BASE64.test(value) && !/\s/.test(value) ? REDACTED : pseudoText(value, seed);
  if (ID_KEYS.has(key)) return looksLikeId(value) || /^[0-9a-zA-Z_:-]+$/.test(value) ? remapId(value, seed) : pseudoText(value, seed);
  if (PATH_KEYS.has(key)) return pseudoPath(value, seed);
  if (PRESERVE_KEYS.has(key)) return value;

  if (LONG_BASE64.test(value) && !/\s/.test(value)) return REDACTED;
  // An address identifies a person, so it never reaches the enum-ish escape hatch.
  if (EMAIL_RE.test(value)) return pseudoEmail(value, seed);
  if (isStructural(value)) return value;
  if (looksLikeId(value)) return remapId(value, seed);
  if (ENUMISH_RE.test(value) && !value.includes('/')) return value;
  return pseudoText(value, seed);
}

/**
 * Schema field names are structure and always survive. A key that is itself a
 * file path — `trackedFileBackups` is keyed by repo-relative path — is *data*
 * wearing a key's clothes, so it gets the same treatment as a path value.
 */
function anonymizeKey(key: string, seed: number): string {
  // No schema field name contains whitespace, so this one is prose — an
  // `answers` map is keyed by the question that was asked.
  if (/\s/.test(key)) return pseudoText(key, seed);
  if (EMAIL_RE.test(key)) return pseudoEmail(key, seed);
  if (key.includes('/') || key.includes('\\') || /^[\w@ .-]+\.[A-Za-z0-9]{1,8}$/.test(key)) {
    return pseudoPath(key, seed);
  }
  return key;
}

function walk(node: unknown, key: string, seed: number, parent: Record<string, unknown>): unknown {
  if (typeof node === 'string') return anonymizeValue(key, node, seed, parent);
  if (Array.isArray(node)) return node.map((item) => walk(item, key, seed, parent));
  if (node && typeof node === 'object') {
    const source = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source)) out[anonymizeKey(k, seed)] = walk(v, k, seed, source);
    return out;
  }
  return node;
}

/**
 * Anonymizes one JSONL line. Every key, every non-string value and the key order
 * survive; the strings go through `anonymizeValue`. The same line and seed always
 * produce the same output.
 */
export function anonymizeLine(line: string, seed: number): string {
  const trimmed = line.trim();
  if (!trimmed) return line;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return pseudoText(line, seed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return pseudoText(line, seed);
  }
  return JSON.stringify(walk(parsed, '', seed, {}));
}

export { anonymizeValue, anonymizeKey, pseudoText, pseudoPath, pseudoUrl, pseudoEmail, pseudoQualifiedName, remapId, encodeCwd, looksLikeSecret, registerPathAlias };

// ---------------------------------------------------------------------------
// candidate discovery
// ---------------------------------------------------------------------------

interface Candidate {
  sessionId: string;
  project: string;
  transcript: string;
  sideDir: string;
  cwd: string;
  size: number;
  mtime: number;
  subagents: number;
  workflows: number;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Reads the first `bytes` of a file without pulling a 60 MB transcript into memory. */
function readHead(path: string, bytes: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = Math.min(fstatSync(fd).size, bytes);
    const buf = Buffer.allocUnsafe(size);
    readSync(fd, buf, 0, size, 0);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Picks the first value of `field` that any line near the top of the file carries. */
function readHeadField(transcript: string, field: string): string {
  for (const line of readHead(transcript, 256 * 1024).split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const value = entry[field];
      if (typeof value === 'string' && value) return value;
    } catch {
      continue;
    }
  }
  return '';
}

function findCandidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const project of safeReaddir(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, project);
    for (const entry of safeReaddir(dir)) {
      if (!entry.endsWith('.jsonl')) continue;
      const transcript = join(dir, entry);
      let stat;
      try {
        stat = statSync(transcript);
      } catch {
        continue;
      }
      const sessionId = entry.replace(/\.jsonl$/, '');
      const sideDir = join(dir, sessionId);
      const subagents = safeReaddir(join(sideDir, 'subagents')).filter((f) => f.endsWith('.jsonl')).length;
      const workflows = safeReaddir(join(sideDir, 'workflows')).filter((f) => f.endsWith('.json')).length;
      out.push({
        sessionId,
        project,
        transcript,
        sideDir,
        cwd: '',
        size: stat.size,
        mtime: stat.mtimeMs,
        subagents,
        workflows,
      });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** The live registry entry for a session, if its process is still listed. */
function findRegistryEntry(sessionId: string): { path: string; pid: string } | null {
  for (const entry of safeReaddir(SESSIONS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const path = join(SESSIONS_DIR, entry);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sessionId?: string };
      if (parsed.sessionId === sessionId) return { path, pid: entry.replace(/\.json$/, '') };
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// recording
// ---------------------------------------------------------------------------

interface Args {
  name: string;
  session: string;
  maxLines: number;
  subLines: number;
  tail: boolean;
  list: boolean;
  seed: number;
  budget: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { name: '', session: '', maxLines: 4000, subLines: 0, tail: false, list: false, seed: 1337, budget: DEFAULT_BUDGET_BYTES };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--name' && value) args.name = value;
    if (flag === '--session' && value) args.session = value;
    if (flag === '--max-lines' && value) args.maxLines = Number(value);
    if (flag === '--sub-lines' && value) args.subLines = Number(value);
    if (flag === '--seed' && value) args.seed = Number(value);
    if (flag === '--budget' && value) args.budget = Number(value);
    if (flag === '--tail') args.tail = true;
    if (flag === '--list') args.list = true;
  }
  return args;
}

interface Capped {
  lines: string[];
  omitted: number;
}

/** Keeps the first `HEAD_LINES` (session metadata) plus the tail, noting the gap. */
function capLines(lines: string[], maxLines: number, tailOnly: boolean): Capped {
  if (lines.length <= maxLines) return { lines, omitted: 0 };
  if (tailOnly) return { lines: lines.slice(lines.length - maxLines), omitted: lines.length - maxLines };
  const head = Math.min(HEAD_LINES, maxLines);
  const tail = maxLines - head;
  return {
    lines: [...lines.slice(0, head), ...lines.slice(lines.length - tail)],
    omitted: lines.length - maxLines,
  };
}

interface ManifestFile {
  path: string;
  lines: number;
  omittedLines?: number;
}

interface Coverage {
  lineTypes: Record<string, number>;
  attachmentTypes: Record<string, number>;
  toolNames: Record<string, number>;
  markers: Record<string, number>;
  sessionIds: Set<string>;
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/** Tallies the nuances a fixture is meant to cover, so the manifest can advertise them. */
function tally(line: string, coverage: Coverage): void {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const type = String(entry['type'] ?? '(none)');
  bump(coverage.lineTypes, entry['subtype'] ? `${type}/${String(entry['subtype'])}` : type);
  if (typeof entry['sessionId'] === 'string') coverage.sessionIds.add(entry['sessionId']);
  const attachment = entry['attachment'] as { type?: string } | undefined;
  if (attachment?.type) bump(coverage.attachmentTypes, attachment.type);
  const origin = entry['origin'] as { kind?: string } | undefined;
  if (origin?.kind) bump(coverage.markers, `origin:${origin.kind}`);
  if (entry['subtype'] === 'compact_boundary') bump(coverage.markers, 'compact_boundary');
  if (entry['toolDenialKind']) bump(coverage.markers, `denial:${String(entry['toolDenialKind'])}`);
  const message = entry['message'] as { content?: unknown } | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content as { type?: string; name?: string }[]) {
      if (block?.type === 'tool_use' && block.name) bump(coverage.toolNames, block.name);
    }
  }
  if (line.includes('task-notification')) bump(coverage.markers, 'task-notification');
  if (line.includes('<agent-message')) bump(coverage.markers, 'agent-message');
  if (line.includes('Request interrupted by user')) bump(coverage.markers, 'interrupted');
}

interface Writer {
  write: (relPath: string, lines: string[], omitted: number) => void;
  files: ManifestFile[];
  bytes: number;
  coverage: Coverage;
}

function makeWriter(root: string, coverage: Coverage): Writer {
  const writer: Writer = {
    files: [],
    bytes: 0,
    coverage,
    write: (relPath, lines, omitted) => {
      const target = join(root, relPath);
      mkdirSync(dirname(target), { recursive: true });
      const body = lines.length ? `${lines.join('\n')}\n` : '';
      writeFileSync(target, body);
      writer.bytes += Buffer.byteLength(body);
      const file: ManifestFile = { path: relPath, lines: lines.length };
      if (omitted > 0) file.omittedLines = omitted;
      writer.files.push(file);
      for (const line of lines) tally(line, coverage);
    },
  };
  return writer;
}

function record(args: Args): void {
  const candidates = findCandidates();
  if (!candidates.length) throw new Error(`no transcripts under ${PROJECTS_DIR}`);

  let chosen: Candidate | undefined;
  if (args.session && args.session !== 'latest') {
    chosen = candidates.find((c) => c.sessionId === args.session || c.sessionId.startsWith(args.session));
    if (!chosen) throw new Error(`no session matching "${args.session}" (try --list)`);
  } else if (args.session === 'latest') {
    chosen = candidates[0];
  } else {
    chosen = candidates.find((c) => c.subagents > 0) ?? candidates[0];
  }
  const session = chosen as Candidate;
  session.cwd = readHeadField(session.transcript, 'cwd');

  const seed = args.seed;
  const fakeCwd = session.cwd ? pseudoPath(session.cwd, seed) : '/Users/user/code/project';
  const fakeProject = encodeCwd(fakeCwd);
  const fakeSessionId = remapId(session.sessionId, seed);
  // The encoded-cwd directory turns up inside scratchpad and output-file paths as
  // one opaque segment; pin it so it always agrees with the directory we write.
  registerPathAlias(session.project, fakeProject);

  const root = join(FIXTURES_DIR, args.name);
  const coverage: Coverage = { lineTypes: {}, attachmentTypes: {}, toolNames: {}, markers: {}, sessionIds: new Set<string>() };
  const writer = makeWriter(root, coverage);
  const notes: string[] = [];

  const readLines = (path: string): string[] => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const anonAll = (lines: string[]): string[] => lines.map((l) => anonymizeLine(l, seed));

  // main transcript
  const mainRaw = readLines(session.transcript);
  const mainCapped = capLines(mainRaw, args.maxLines, args.tail);
  writer.write(join('projects', fakeProject, `${fakeSessionId}.jsonl`), anonAll(mainCapped.lines), mainCapped.omitted);
  if (mainCapped.omitted > 0) {
    notes.push(
      `main transcript capped at ${args.maxLines} lines of ${mainRaw.length}: ` +
        (args.tail ? `tail only, ${mainCapped.omitted} earlier lines omitted` : `first ${HEAD_LINES} kept, then a gap of ${mainCapped.omitted} lines, then the tail`),
    );
  }

  // subagent sidecars, including the nested workflow runs
  const subCap = args.subLines > 0 ? args.subLines : Math.max(40, Math.min(args.maxLines, 400));
  const sideRoot = join('projects', fakeProject, fakeSessionId);
  let droppedForBudget = 0;

  const copySubagentDir = (fromDir: string, toRel: string): void => {
    const entries = safeReaddir(fromDir).sort();
    for (const entry of entries) {
      const from = join(fromDir, entry);
      let stat;
      try {
        stat = statSync(from);
      } catch {
        continue;
      }
      if (stat.isDirectory()) continue;
      if (!entry.endsWith('.jsonl') && !entry.endsWith('.json')) continue;
      if (writer.bytes > args.budget) {
        droppedForBudget++;
        continue;
      }
      const agentMatch = /^agent-([0-9a-z]+)(\..+)$/.exec(entry);
      const outName = agentMatch
        ? `agent-${remapId(agentMatch[1] as string, seed)}${agentMatch[2] as string}`
        : entry;
      const raw = readLines(from);
      const capped = capLines(raw, entry.endsWith('.jsonl') ? subCap : args.maxLines, args.tail);
      writer.write(join(toRel, outName), anonAll(capped.lines), capped.omitted);
    }
  };

  // Workflow run records and the agents that ran inside them come first: the
  // budget must never starve the structure a workflow fixture exists to show.
  const workflowsDir = join(session.sideDir, 'workflows');
  for (const entry of safeReaddir(workflowsDir).sort()) {
    if (!entry.endsWith('.json')) continue;
    const runId = entry.replace(/\.json$/, '');
    const raw = readLines(join(workflowsDir, entry));
    writer.write(join(sideRoot, 'workflows', `${remapId(runId, seed)}.json`), anonAll(raw), 0);
  }

  const subagentsDir = join(session.sideDir, 'subagents');
  if (existsSync(subagentsDir)) {
    const nested = join(subagentsDir, 'workflows');
    for (const runId of safeReaddir(nested).sort()) {
      const runDir = join(nested, runId);
      try {
        if (!statSync(runDir).isDirectory()) continue;
      } catch {
        continue;
      }
      copySubagentDir(runDir, join(sideRoot, 'subagents', 'workflows', remapId(runId, seed)));
    }
    copySubagentDir(subagentsDir, join(sideRoot, 'subagents'));
  }

  // live registry entry, when the session's process is still listed
  const registry = findRegistryEntry(session.sessionId);
  if (registry) {
    const raw = readLines(registry.path);
    writer.write(join('sessions', `${registry.pid}.json`), anonAll(raw), 0);
    notes.push(`includes the live registry entry for pid ${registry.pid}`);
  } else {
    notes.push('no live registry entry matched this session');
  }
  // A transcript can carry lines from a prior sessionId after /clear or /resume.
  const sessionCount = Math.max(1, coverage.sessionIds.size);

  if (droppedForBudget > 0) {
    notes.push(`${droppedForBudget} sidecar file(s) omitted once the ${(args.budget / 1024 / 1024).toFixed(1)} MB budget was reached`);
  }
  notes.push(`subagent transcripts capped at ${subCap} lines each`);
  // Deliberately never the real session id or cwd: the manifest ships with the fixture.
  notes.push(`recorded as session ${fakeSessionId} under cwd ${fakeCwd}; ids are remapped but keep their original shape`);
  notes.push(`anonymized with seed ${seed}; re-running with the same seed reproduces these files byte for byte`);

  const manifest = {
    recordedAt: new Date().toISOString(),
    ccVersion: readHeadField(session.transcript, 'version') || 'unknown',
    sessionCount,
    files: writer.files,
    anonymized: true,
    notes,
    coverage: {
      lineTypes: coverage.lineTypes,
      attachmentTypes: coverage.attachmentTypes,
      toolNames: coverage.toolNames,
      markers: coverage.markers,
    },
  };
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  verify(root, writer.files, args.name, session);

  const totalKb = (writer.bytes / 1024).toFixed(0);
  console.log(`\nrecorded fixtures/${args.name}: ${writer.files.length} files, ${totalKb} KB`);
  console.log(`  session   ${session.sessionId} -> ${fakeSessionId}`);
  console.log(`  cc version ${manifest.ccVersion}`);
  console.log(`  markers   ${Object.entries(coverage.markers).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`);
  console.log(`  tools     ${Object.entries(coverage.toolNames).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`);
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

/** Path words that identify nobody, so finding one in a fixture proves nothing. */
const GENERIC_PATH_WORDS = new Set([
  'code', 'repo', 'repos', 'work', 'dev', 'personal', 'projects', 'project', 'main',
  'user', 'users', 'home', 'data', 'temp', 'claude', 'session', 'sessions', 'viz',
  'cost', 'audit', 'opt', 'website', 'app', 'apps', 'lib', 'core', 'api', 'web',
]);

function checkLeaks(path: string, body: string, forbidden: Set<string>, realUser: string, problems: string[]): void {
  if (body.includes(`/Users/${realUser}`)) problems.push(`${path}: leaks /Users/${realUser}`);
  if (body.includes(`/home/${realUser}`)) problems.push(`${path}: leaks /home/${realUser}`);
  for (const word of forbidden) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(body)) problems.push(`${path}: leaks real identifier "${word}"`);
  }
  for (const re of SECRET_PATTERNS) {
    if (re.test(body)) problems.push(`${path}: matches secret pattern ${re}`);
  }
}

/** Re-reads everything just written and fails loudly if real content survived. */
function verify(root: string, files: ManifestFile[], name: string, session: Candidate): void {
  const realUser = basename(homedir());
  // The username, plus the distinctive words from *every* project on this machine
  // — not just this session's cwd. A transcript routinely discusses other repos,
  // and that cross-project prose is exactly what a narrower check would miss.
  const forbidden = new Set<string>([realUser]);
  const addWords = (text: string): void => {
    for (const word of text.split(/[/\-_. ]+/)) {
      if (word.length <= 3) continue;
      if (LITERAL_SEGMENTS.has(word) || GENERIC_PATH_WORDS.has(word.toLowerCase())) continue;
      forbidden.add(word);
    }
  };
  addWords(session.cwd);
  for (const project of safeReaddir(PROJECTS_DIR)) addWords(project);
  forbidden.delete('');
  if (session.sessionId) forbidden.add(session.sessionId);

  let totalLines = 0;
  const problems: string[] = [];
  // The manifest ships with the fixture, so it gets the same scrutiny.
  const checked: ManifestFile[] = [...files, { path: 'manifest.json', lines: -1 }];

  for (const file of checked) {
    const body = readFileSync(join(root, file.path), 'utf8');
    const lines = body.split('\n').filter((l) => l.trim().length > 0);
    if (file.lines < 0) {
      try {
        JSON.parse(body);
      } catch (err) {
        problems.push(`manifest.json: not valid JSON (${String(err)})`);
      }
      checkLeaks(file.path, body, forbidden, realUser, problems);
      continue;
    }
    totalLines += lines.length;
    if (lines.length !== file.lines) problems.push(`${file.path}: manifest says ${file.lines} lines, file has ${lines.length}`);
    for (let i = 0; i < lines.length; i++) {
      try {
        JSON.parse(lines[i] as string);
      } catch (err) {
        problems.push(`${file.path}:${i + 1}: not valid JSON (${String(err)})`);
      }
    }
    checkLeaks(file.path, body, forbidden, realUser, problems);
    if (extname(file.path) === '.jsonl' && lines.length === 0) problems.push(`${file.path}: empty`);
  }

  console.log(`verified fixtures/${name}: ${files.length} files, ${totalLines} lines re-parsed`);
  if (problems.length) {
    for (const problem of problems.slice(0, 20)) console.error(`  FAIL ${problem}`);
    throw new Error(`${problems.length} verification problem(s) in fixtures/${name}`);
  }
  console.log('  no real paths, names or secret-shaped strings survived');
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function listCandidates(): void {
  const candidates = findCandidates();
  console.log(`${'sessionId'.padEnd(38)}${'size'.padStart(9)}  ${'sub'.padStart(4)} ${'wf'.padStart(3)}  ${'modified'.padEnd(22)}cwd`);
  for (const candidate of candidates) {
    const cwd = readHeadField(candidate.transcript, 'cwd') || `(${candidate.project})`;
    console.log(
      `${candidate.sessionId.padEnd(38)}${`${(candidate.size / 1024).toFixed(0)}K`.padStart(9)}  ` +
        `${String(candidate.subagents).padStart(4)} ${String(candidate.workflows).padStart(3)}  ` +
        `${new Date(candidate.mtime).toISOString().slice(0, 19).padEnd(22)}${cwd}`,
    );
  }
  console.log(`\n${candidates.length} transcripts, ${candidates.filter((c) => c.subagents > 0).length} with subagents.`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    listCandidates();
    return;
  }
  if (!args.name) {
    console.error('usage: node scripts/record-fixture.ts --name <fixtureName> [--session <id|latest>] [--max-lines N] [--sub-lines N] [--tail] [--list]');
    process.exitCode = 1;
    return;
  }
  record(args);
}

const invokedDirectly = process.argv[1] ? process.argv[1].endsWith('record-fixture.ts') : false;
if (invokedDirectly) main();
