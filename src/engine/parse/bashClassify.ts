/**
 * What a Bash call is actually doing, so the figure has somewhere to stand.
 *
 * Bash is ~80% of the tool calls in a real session, so routing on the tool name
 * alone would park almost the whole office at one workbench. The command text is
 * the only signal that separates `cat` from a test run.
 */

export type BashCategory = 'read' | 'search' | 'test' | 'build' | 'git' | 'net' | 'publish' | 'other';

/** A command that does several things takes its loudest one: `npm run build && git push` publishes. */
const PRIORITY: Record<BashCategory, number> = {
  publish: 7,
  test: 6,
  build: 5,
  git: 4,
  net: 3,
  search: 2,
  read: 1,
  other: 0,
};

export function classifyBash(command: string, description?: string): BashCategory {
  const text = typeof command === 'string' ? command : '';
  const category = classifyCommand(text, 0);
  // Claude's own one-line description is honest about intent but vague about mechanics,
  // so it only gets a vote when the command itself told us nothing.
  return category === 'other' ? fromDescription(description) : category;
}

function classifyCommand(text: string, depth: number): BashCategory {
  let best: BashCategory = 'other';
  for (const segment of splitSegments(dropHeredocBodies(text))) {
    const category = classifySegment(segment, depth);
    if (PRIORITY[category] > PRIORITY[best]) best = category;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/**
 * Heredoc bodies are payload, not commands — `cat <<'EOF' > file` writes a file,
 * and its lines would otherwise be classified as if someone typed them.
 */
function dropHeredocBodies(text: string): string {
  if (!text.includes('<<')) return text;
  const kept: string[] = [];
  let delimiter: string | null = null;
  for (const line of text.split('\n')) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    kept.push(line);
    const opened = HEREDOC.exec(line);
    if (opened) delimiter = opened[2] ?? null;
  }
  return kept.join('\n');
}

const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

/** Quote-aware split on `&&`, `||`, `;`, `|` and newlines; `2>&1` must survive. */
function splitSegments(text: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (ch === '\\' && next !== undefined) {
      if (next === '\n') {
        current += ' ';
      } else {
        current += ch + next;
      }
      i += 1;
      continue;
    }
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      current += ch;
      quote = ch;
      continue;
    }
    if (ch === '\n' || ch === ';') {
      segments.push(current);
      current = '';
      continue;
    }
    if (ch === '&' || ch === '|') {
      if (ch === '&' && next !== '&') {
        current += ch; // a lone `&` is a redirection target or a background marker
        continue;
      }
      if (next === ch) i += 1;
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);

  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/** Quote-aware tokenizer; quotes are stripped because only the words matter here. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    const next = segment[i + 1];

    if (ch === '\\' && next !== undefined && quote !== "'") {
      current += next;
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);

  return tokens;
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Wrappers that change how a command runs, never what it is. */
const PASSTHROUGH = new Set([
  'sudo',
  'doas',
  'time',
  'nohup',
  'command',
  'builtin',
  'exec',
  'stdbuf',
  'caffeinate',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
]);

const ONE_WORD_RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'uvx', 'xargs']);

const TWO_WORD_RUNNERS = new Set([
  'pnpm dlx',
  'yarn dlx',
  'npm exec',
  'pnpm exec',
  'yarn exec',
  'npm x',
  'bun x',
  'bundle exec',
  'poetry run',
  'pipenv run',
  'rye run',
  'uv run',
]);

/** Flags that swallow the token after them, which would otherwise look like the verb. */
const WRAPPER_VALUE_FLAGS = new Set(['-u', '-g', '-p', '--package', '-k', '--kill-after', '-n', '-I', '-P', '-i']);

function stripWrappers(tokens: readonly string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const raw = tokens[i]!;
    const verb = basename(raw);

    if (raw === '\\' || raw.length === 0) {
      i += 1;
      continue;
    }
    if (ASSIGNMENT.test(raw)) {
      i += 1;
      continue;
    }
    if (PASSTHROUGH.has(verb)) {
      i += 1;
      i = skipFlags(tokens, i);
      continue;
    }
    if (verb === 'env') {
      i += 1;
      i = skipFlags(tokens, i);
      while (i < tokens.length && ASSIGNMENT.test(tokens[i]!)) i += 1;
      continue;
    }
    if (verb === 'timeout' || verb === 'gtimeout') {
      i += 1;
      i = skipFlags(tokens, i);
      i += 1; // the duration
      continue;
    }
    if (ONE_WORD_RUNNERS.has(verb)) {
      i += 1;
      i = skipFlags(tokens, i);
      continue;
    }
    if (TWO_WORD_RUNNERS.has(`${verb} ${basename(tokens[i + 1] ?? '')}`)) {
      i += 2;
      i = skipFlags(tokens, i);
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

function skipFlags(tokens: readonly string[], from: number): number {
  let i = from;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token === '--') {
      i += 1;
      continue;
    }
    if (!isFlag(token)) break;
    i += WRAPPER_VALUE_FLAGS.has(token) ? 2 : 1;
  }
  return i;
}

function isFlag(token: string): boolean {
  return token.length > 1 && token.startsWith('-');
}

function basename(token: string): string {
  const parts = token.split('/');
  return parts[parts.length - 1] ?? token;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

/** Non-flag arguments, with the values of listed flags skipped (`git -C <dir> status`). */
function operands(args: readonly string[], valued: ReadonlySet<string> = EMPTY): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.length === 0 || arg === '--') continue;
    if (isFlag(arg)) {
      if (valued.has(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------

const SIMPLE_VERBS: Record<string, BashCategory> = {
  // read — anything whose whole job is to put file contents on stdout
  cat: 'read',
  bat: 'read',
  head: 'read',
  tail: 'read',
  less: 'read',
  more: 'read',
  jq: 'read',
  yq: 'read',
  wc: 'read',
  file: 'read',
  stat: 'read',
  plutil: 'read',
  column: 'read',
  nl: 'read',
  od: 'read',
  xxd: 'read',
  strings: 'read',
  pbpaste: 'read',
  awk: 'read', // in practice awk is used to print selected columns, not to transform files
  cut: 'read',
  sort: 'read',
  uniq: 'read',

  // search
  rg: 'search',
  grep: 'search',
  egrep: 'search',
  fgrep: 'search',
  ag: 'search',
  ack: 'search',
  find: 'search',
  fd: 'search',
  ls: 'search',
  tree: 'search',
  locate: 'search',
  mdfind: 'search',
  which: 'search',
  whereis: 'search',
  whence: 'search',

  // test
  vitest: 'test',
  jest: 'test',
  mocha: 'test',
  ava: 'test',
  pytest: 'test',
  'py.test': 'test',
  rspec: 'test',
  phpunit: 'test',
  tox: 'test',
  nox: 'test',
  ctest: 'test',
  cypress: 'test',

  // build — compilers plus the check/lint/format tooling that runs beside them
  tsc: 'build',
  webpack: 'build',
  rollup: 'build',
  esbuild: 'build',
  tsup: 'build',
  cmake: 'build',
  ninja: 'build',
  eslint: 'build',
  prettier: 'build',
  biome: 'build',
  stylelint: 'build',
  ruff: 'build',
  black: 'build',
  mypy: 'build',
  pyright: 'build',
  shellcheck: 'build',
  gofmt: 'build',
  rustfmt: 'build',
  'golangci-lint': 'build',
  solc: 'build',

  // net
  curl: 'net',
  wget: 'net',
  ping: 'net',
  dig: 'net',
  nslookup: 'net',
  host: 'net',
  nc: 'net',
  ncat: 'net',
  telnet: 'net',
  ssh: 'net',
  scp: 'net',
  sftp: 'net',
  aws: 'net',
  gcloud: 'net',
  az: 'net',
  kubectl: 'net',
  http: 'net',
  httpie: 'net',

  // publish
  twine: 'publish', // twine only ever uploads
};

/** Package-manager-ish front ends whose first operand names a script or subcommand. */
const RUNNERS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'turbo',
  'nx',
  'just',
  'uv',
  'poetry',
  'pipenv',
  'rye',
  'vite',
  'playwright',
  'task',
  'rake',
]);

/** Goal-driven build tools: they build unless a goal says otherwise. */
const GOAL_TOOLS = new Set(['make', 'gmake', 'mvn', 'mvnw', 'gradle', 'gradlew', 'bazel', 'sbt', 'ant', 'meson']);

function classifySegment(segment: string, depth: number): BashCategory {
  const cleaned = segment.replace(/^[(){}\s&]+/, '').replace(/[(){}\s]+$/, '');
  if (cleaned.length === 0) return 'other';
  // A heredoc authors content; the verb in front of it is writing, not reading.
  if (HEREDOC.test(cleaned)) return 'other';
  return classifyTokens(stripWrappers(tokenize(cleaned)), depth);
}

function classifyTokens(tokens: readonly string[], depth: number): BashCategory {
  const head = tokens[0];
  if (head === undefined) return 'other';
  const verb = basename(head);
  const args = tokens.slice(1);

  const simple = SIMPLE_VERBS[verb];
  if (simple !== undefined) return simple;

  if (RUNNERS.has(verb)) return classifyRunner(args);
  if (GOAL_TOOLS.has(verb)) return classifyGoals(args, 'build');

  switch (verb) {
    case 'git':
      return classifyGit(args);
    case 'gh':
      return classifyGh(args);
    case 'jj':
    case 'hg':
    case 'sl':
    case 'svn':
      return operands(args).includes('push') ? 'publish' : 'git';
    case 'go':
      return classifyGo(args);
    case 'cargo':
      return classifyCargo(args);
    case 'forge':
      return classifyForge(args);
    case 'dotnet':
      return classifyDotnet(args);
    case 'swift':
      return classifySwift(args);
    case 'docker':
    case 'podman':
      return classifyDocker(args);
    case 'sed':
      // `sed -i` edits in place; every other sed prints.
      return args.some((arg) => arg === '-i' || arg.startsWith('--in-place')) ? 'other' : 'read';
    case 'defaults':
      return operands(args)[0] === 'read' ? 'read' : 'other';
    case 'open':
      return operands(args).some(isUrl) ? 'net' : 'read';
    case 'rsync':
      // A local rsync is just a copy; the colon is what makes it a network call.
      return operands(args).some((arg) => /^[^/.-][^/]*:/.test(arg)) ? 'net' : 'other';
    case 'python':
    case 'python3':
    case 'py':
      return classifyModule(args, depth);
    case 'node':
      return args.includes('--test') ? 'test' : 'other';
    case 'bash':
    case 'sh':
    case 'zsh':
      return classifyShell(args, depth);
    default:
      return 'other';
  }
}

function classifyRunner(args: readonly string[]): BashCategory {
  const words = operands(args, RUNNER_VALUE_FLAGS);
  const first = words[0];
  if (first === undefined) return 'other';
  // `npm install --save-dev vitest` installs a test runner; it does not run tests.
  if (INSTALL_SUBCOMMANDS.has(first)) return 'other';

  const rest = first === 'run' || first === 'run-script' || first === 'task' ? words.slice(1) : words;
  let best: BashCategory = 'other';
  for (const word of rest) {
    const category = scriptCategory(word);
    if (category !== undefined && PRIORITY[category] > PRIORITY[best]) best = category;
  }
  return best;
}

const RUNNER_VALUE_FLAGS = new Set(['--filter', '-w', '--workspace', '-C', '--prefix', '--cwd']);

const INSTALL_SUBCOMMANDS = new Set([
  'install',
  'i',
  'add',
  'ci',
  'remove',
  'rm',
  'uninstall',
  'un',
  'update',
  'up',
  'upgrade',
  'link',
  'unlink',
  'audit',
  'dedupe',
  'outdated',
  'why',
  'init',
  'create',
  'cache',
  'config',
  'pack',
  'ls',
  'list',
  'info',
  'view',
  'store',
  'prune',
  'sync',
  'lock',
  'pip',
  'venv',
]);

/**
 * Script names carry the intent: `test:unit`, `build:web`, `lint`. Boundaries are
 * kept tight so a path argument like `data/test.json` never reads as a test run.
 */
function scriptCategory(name: string): BashCategory | undefined {
  const n = name.toLowerCase();
  if (/(^|[:._-])(publish|release|deploy)([:._-]|$)/.test(n)) return 'publish';
  if (/^t$/.test(n)) return 'test';
  if (/(^|[:._-])(test|tests|e2e|spec|specs|vitest|jest|pytest|coverage|cov|bench)([:._-]|$)/.test(n)) return 'test';
  if (
    /(^|[:._-])(build|compile|bundle|typecheck|types|tsc|lint|format|fmt|check|prettier|eslint|dist)([:._-]|$)/.test(n)
  ) {
    return 'build';
  }
  return undefined;
}

function classifyGoals(args: readonly string[], fallback: BashCategory): BashCategory {
  let best: BashCategory = fallback;
  for (const word of operands(args, GOAL_VALUE_FLAGS)) {
    const category = scriptCategory(word);
    if (category !== undefined && PRIORITY[category] > PRIORITY[best]) best = category;
  }
  return best;
}

const GOAL_VALUE_FLAGS = new Set(['-f', '-C', '-p', '--file', '--directory']);

const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

function classifyGit(args: readonly string[]): BashCategory {
  const sub = operands(args, GIT_VALUE_FLAGS)[0];
  if (sub === undefined) return 'git';
  // An annotated tag is still local; it only becomes a release once it is pushed.
  if (sub === 'push' || sub === 'send-email' || sub === 'request-pull') return 'publish';
  if (sub === 'grep' || sub === 'ls-files' || sub === 'ls-tree') return 'search';
  return 'git';
}

const GH_PUBLISHING: Record<string, ReadonlySet<string>> = {
  pr: new Set(['create', 'merge', 'comment', 'review', 'ready']),
  issue: new Set(['create', 'comment']),
  release: new Set(['create', 'upload', 'edit']),
  repo: new Set(['create']),
  gist: new Set(['create']),
};

function classifyGh(args: readonly string[]): BashCategory {
  const words = operands(args);
  const noun = words[0];
  if (noun === undefined) return 'git';
  if (noun === 'api') return 'net';
  const verb = words[1] ?? '';
  return GH_PUBLISHING[noun]?.has(verb) === true ? 'publish' : 'git';
}

function classifyGo(args: readonly string[]): BashCategory {
  const sub = operands(args)[0];
  if (sub === 'test') return 'test';
  if (sub === 'build' || sub === 'vet' || sub === 'fmt' || sub === 'install' || sub === 'generate') return 'build';
  return 'other';
}

function classifyCargo(args: readonly string[]): BashCategory {
  const sub = operands(args)[0];
  if (sub === 'test' || sub === 'nextest' || sub === 'bench' || sub === 't') return 'test';
  if (sub === 'publish') return 'publish';
  if (sub === 'build' || sub === 'b' || sub === 'check' || sub === 'c' || sub === 'clippy' || sub === 'fmt') {
    return 'build';
  }
  return 'other';
}

function classifyForge(args: readonly string[]): BashCategory {
  const sub = operands(args)[0];
  if (sub === 'test' || sub === 'coverage' || sub === 'snapshot') return 'test';
  if (sub === 'build' || sub === 'compile' || sub === 'fmt') return 'build';
  return 'other';
}

function classifyDotnet(args: readonly string[]): BashCategory {
  const words = operands(args);
  const sub = words[0];
  if (sub === 'test') return 'test';
  if (sub === 'nuget') return words[1] === 'push' ? 'publish' : 'other';
  // `dotnet publish` writes a build output directory — it is not a package release.
  if (sub === 'build' || sub === 'publish' || sub === 'restore' || sub === 'format') return 'build';
  return 'other';
}

function classifySwift(args: readonly string[]): BashCategory {
  const sub = operands(args)[0];
  if (sub === 'test') return 'test';
  if (sub === 'build') return 'build';
  return 'other';
}

function classifyDocker(args: readonly string[]): BashCategory {
  const sub = operands(args)[0];
  if (sub === 'build' || sub === 'buildx') return 'build';
  if (sub === 'push') return 'publish';
  return 'other';
}

/** `python -m pytest` is a test run; the module is the real verb. */
function classifyModule(args: readonly string[], depth: number): BashCategory {
  const flag = args.indexOf('-m');
  const moduleName = flag >= 0 ? args[flag + 1] : undefined;
  if (moduleName === undefined || depth >= MAX_DEPTH) return 'other';
  return classifyTokens([moduleName, ...args.slice(flag + 2)], depth + 1);
}

function classifyShell(args: readonly string[], depth: number): BashCategory {
  const flag = args.indexOf('-c');
  const script = flag >= 0 ? args[flag + 1] : undefined;
  if (script === undefined || depth >= MAX_DEPTH) return 'other';
  return classifyCommand(script, depth + 1);
}

const MAX_DEPTH = 2;

function isUrl(arg: string): boolean {
  return /^https?:\/\//i.test(arg);
}

// ---------------------------------------------------------------------------
// Description fallback
// ---------------------------------------------------------------------------

/** Checked in priority order, so "run tests and build" lands on test. */
const DESCRIPTION_HINTS: ReadonlyArray<readonly [RegExp, BashCategory]> = [
  [/\b(publish|publishing|release|releasing|deploy|deploying)\b/i, 'publish'],
  [/\b(tests?|testing|spec|specs)\b/i, 'test'],
  [/\b(build|building|compile|compiling|typecheck|type-check|lint|linting|format)\b/i, 'build'],
  [/\b(commit|commits|staged?|branch|rebase|stash|git)\b/i, 'git'],
  [/\b(download|downloads?|upload|fetch|curl|request|endpoint|api|network)\b/i, 'net'],
  [/\b(search|searching|grep|find|finding|locate|list|listing)\b/i, 'search'],
  [/\b(read|reads|reading|show|print|display|view|inspect|dump|check)\b/i, 'read'],
];

function fromDescription(description: string | undefined): BashCategory {
  if (typeof description !== 'string' || description.length === 0) return 'other';
  for (const [pattern, category] of DESCRIPTION_HINTS) {
    if (pattern.test(description)) return category;
  }
  return 'other';
}
