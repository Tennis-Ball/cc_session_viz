/**
 * The words the simulation puts on screen.
 *
 * Invented, but shaped like the real thing: repo names, file paths, commands and
 * task descriptions that look like work without ever reusing a real transcript.
 * Nothing in here comes from, or is derived from, anybody's `~/.claude`.
 *
 * Breadth is the point. Somebody who sits with the office for a quarter of an
 * hour should not read the same prompt twice, so the lists are long and every
 * draw goes through a `Deck` rather than a plain random pick, which collides
 * after a handful of draws.
 */

export interface Repo {
  name: string;
  branch: string;
  files: readonly string[];
}

export const REPOS: readonly Repo[] = [
  {
    name: 'aurora',
    branch: 'main',
    files: ['src/render/frame.ts', 'src/render/atlas.ts', 'src/render/passes/bloom.ts', 'src/app.tsx', 'src/store/scene.ts'],
  },
  {
    name: 'ledger-api',
    branch: 'fix/settlement',
    files: ['internal/ledger/post.go', 'internal/ledger/fees.go', 'internal/ledger/window.go', 'cmd/server/main.go'],
  },
  {
    name: 'harbor',
    branch: 'feat/queues',
    files: ['packages/core/src/queue.ts', 'packages/core/src/retry.ts', 'packages/core/src/ack.ts', 'packages/cli/src/run.ts'],
  },
  {
    name: 'tidepool',
    branch: 'main',
    files: ['app/models/tide.rb', 'app/jobs/sync_job.rb', 'app/services/ingest.rb', 'config/schedule.rb'],
  },
  {
    name: 'mosaic',
    branch: 'perf/tiles',
    files: ['crates/tiler/src/lib.rs', 'crates/tiler/src/cache.rs', 'crates/tiler/src/quad.rs', 'benches/tiles.rs'],
  },
  {
    name: 'northwind',
    branch: 'chore/deps',
    files: ['web/src/routes/+page.svelte', 'web/src/lib/api.ts', 'web/src/lib/session.ts', 'web/vite.config.ts'],
  },
  {
    name: 'basalt',
    branch: 'feat/schema',
    files: ['server/schema/graph.ts', 'server/schema/resolvers.ts', 'server/db/migrate.ts', 'server/db/pool.ts'],
  },
  {
    name: 'kestrel',
    branch: 'fix/backpressure',
    files: ['src/stream/pipe.rs', 'src/stream/window.rs', 'src/net/frame.rs', 'src/main.rs'],
  },
  {
    name: 'saltmarsh',
    branch: 'main',
    files: ['pkg/index/segment.go', 'pkg/index/merge.go', 'pkg/query/plan.go', 'pkg/query/exec.go'],
  },
  {
    name: 'lantern',
    branch: 'feat/telemetry',
    files: ['src/collector/spans.ts', 'src/collector/batch.ts', 'src/export/otlp.ts', 'src/config.ts'],
  },
  {
    name: 'quarry',
    branch: 'perf/compaction',
    files: ['store/sst/writer.cc', 'store/sst/reader.cc', 'store/compact.cc', 'store/manifest.cc'],
  },
  {
    name: 'plumbline',
    branch: 'fix/drift',
    files: ['terraform/modules/network/main.tf', 'scripts/plan.sh', 'internal/drift/compare.go'],
  },
  {
    name: 'foxglove',
    branch: 'feat/editor',
    files: ['packages/editor/src/doc.ts', 'packages/editor/src/ot.ts', 'packages/editor/src/cursor.ts'],
  },
  {
    name: 'driftwood',
    branch: 'main',
    files: ['lib/parser/lexer.ex', 'lib/parser/ast.ex', 'lib/runtime/eval.ex', 'test/parser_test.exs'],
  },
];

export const PROMPTS: readonly string[] = [
  'the settlement job double-counts fees when a retry lands mid-window — find out why',
  'make the tile cache survive a cold start without blocking the first frame',
  'walk the queue code and tell me where a message can be acknowledged twice',
  'tighten the retry backoff, it hammers the upstream on a 500',
  'the build got 40s slower this week — figure out what changed',
  'add a regression test for the case we fixed yesterday',
  "clean up the api client, it's grown three ways to do the same thing",
  'why does the sync job hold a transaction open for six seconds?',
  'trace how a tide reading gets from the ingest endpoint to the chart',
  'plan the migration off the old queue before we touch any code',
  'the p99 doubled after the deploy and the p50 did not — where is the tail coming from?',
  'find every place we parse a timestamp without a timezone',
  'the compaction thread starves readers under load; show me the lock order',
  'split the god object in the scheduler into something I can test',
  'we leak a file descriptor per failed connection — track it down',
  'make the migration reversible, right now a rollback drops the column',
  'why do two of the integration tests only fail together?',
  'the editor loses a keystroke when two cursors land on the same line',
  'audit the error paths in the ingest pipeline for silent swallows',
  'the backpressure window never shrinks once it has grown — is that deliberate?',
  'give me a map of who writes to the manifest and under which lock',
  'the CLI prints a stack trace for a user error; make it a sentence',
  'we allocate a new buffer per frame — find the hot ones and pool them',
  'the resolver fans out N+1 queries for nested fields, fix the batching',
  'document the invariants the segment writer relies on, I keep breaking them',
  'the terraform plan shows drift on every run for one module only',
  'a websocket reconnect duplicates every pending message, reproduce it',
  'why is the cold start 900ms when the handler is 12 lines?',
  'the lexer chokes on a trailing comment with no newline',
  'make the retry budget shared across the pool instead of per-connection',
  'the bloom pass renders one frame late on resize',
  'we have two truth sources for a session id — pick one and delete the other',
  'the nightly job silently skips a shard when the manifest is being rewritten',
  'add structured logging to the ack path, I cannot debug it from the output',
  'the OTLP exporter drops spans when the batch is full instead of blocking',
  'find the deadlock between the merge thread and the checkpoint thread',
  'the fee calculation rounds twice, once in cents and once in basis points',
  'our pool grows without bound under a slow consumer — cap it and prove it',
  'the query planner picks a full scan for a covered index, work out why',
  'wire a health check that actually fails when the downstream is down',
  'the diff view shows a phantom change for CRLF files',
  'cut the startup work down, half of it is loading config we never read',
];

export const ASSISTANT_LINES: readonly string[] = [
  'The double-count comes from the retry path reusing the same idempotency key window.',
  'Cache warm-up is synchronous today. Moving it behind a promise lets the first frame render immediately.',
  'Found three places that acknowledge: the worker, the sweeper, and the shutdown hook.',
  'Backoff is linear, not exponential — one 500 turns into a thundering herd.',
  'The slowdown is a new dependency pulling in a second copy of the parser.',
  "I'll add the test next to the existing case so they fail together if it regresses.",
  'Two of the three clients can go; the third is the only one with retry handling.',
  'The transaction stays open across an HTTP call. That is the six seconds.',
  'The tail is one shard: its compaction has been running since the deploy.',
  'Nine call sites parse a bare timestamp. Six of them are in code paths that cross a timezone.',
  'Readers take the manifest lock before the segment lock; the compactor takes them the other way round.',
  'The scheduler only needs two of its eleven fields to decide anything. The rest can move out.',
  'The descriptor leaks on the error return before the defer is registered.',
  'The down migration drops the column instead of restoring the default — that is why a rollback loses data.',
  'They share a module-level fixture, so whichever runs second sees the first one’s writes.',
  'Both cursors resolve against the pre-edit document, so the second transform is applied to stale offsets.',
  'Four error paths return nil after logging at debug level. Nothing upstream can tell they happened.',
  'The window only grows: there is no shrink path at all, which I do not think was deliberate.',
  'Three writers, two locks, and one of the writers takes neither.',
  'It is a user error wrapped in a panic handler; unwrapping it one level gives a clean message.',
  'The per-frame allocation is the atlas staging buffer. Pooling it removes most of the churn.',
  'The batcher keys on the parent id but the loader keys on the row id, so nothing ever coalesces.',
  'The writer assumes the footer is written last; the crash path breaks that and leaves a readable header.',
  'The module reads a value the provider normalises, so the plan always differs by whitespace.',
  'The reconnect replays the pending queue without clearing it first.',
  'Most of the cold start is config parsing for features that are switched off.',
  'The lexer expects a newline to terminate a comment and falls off the end of the buffer.',
  'The budget is per-connection, so a pool of fifty retries fifty times.',
];

export const BASH_COMMANDS: readonly { command: string; description: string }[] = [
  { command: 'npm test -- --run queue', description: 'Run the queue tests' },
  { command: 'rg -n "acknowledge" packages/core/src', description: 'Search for acknowledgements' },
  { command: 'git diff --stat HEAD~1', description: 'Check what changed' },
  { command: 'cargo test -p tiler', description: 'Run the tiler tests' },
  { command: 'go test ./internal/ledger/...', description: 'Run the ledger tests' },
  { command: 'npm run build', description: 'Build the project' },
  { command: 'sed -n "1,80p" src/render/frame.ts', description: 'Read the frame loop' },
  { command: 'gh pr view 214 --json title,body', description: 'Look at the PR' },
  { command: 'npm run typecheck', description: 'Typecheck the workspace' },
  { command: 'pytest -k ingest -x', description: 'Run the ingest tests' },
  { command: 'cargo clippy --all-targets', description: 'Lint the crates' },
  { command: 'git log --oneline -20', description: 'Read recent history' },
  { command: 'git blame -L 40,70 internal/ledger/fees.go', description: 'Find who touched the fee maths' },
  { command: 'rg -n "TODO|FIXME" --glob "!node_modules"', description: 'Find leftover notes' },
  { command: 'go vet ./...', description: 'Vet the packages' },
  { command: 'find . -name "*.sql" -newer go.mod', description: 'Find recent migrations' },
  { command: 'jq ".scripts" package.json', description: 'Read the scripts block' },
  { command: 'curl -s localhost:8080/healthz', description: 'Check the health endpoint' },
  { command: 'kubectl get pods -l app=ledger', description: 'Check the running pods' },
  { command: 'npm run test:e2e -- --grep queue', description: 'Run the end to end tests' },
  { command: 'tail -n 120 var/log/sync.log', description: 'Read the sync log' },
  { command: 'git stash list', description: 'Check for stashed work' },
  { command: 'make bench', description: 'Run the benchmarks' },
  { command: 'forge test --match-contract Settlement', description: 'Run the settlement tests' },
  { command: 'mix test test/parser_test.exs', description: 'Run the parser tests' },
  { command: 'rg -n "class .*Scheduler" --type ts', description: 'Locate the scheduler' },
  { command: 'git diff --cached', description: 'Review what is staged' },
  { command: 'tree -L 2 packages', description: 'List the workspace layout' },
  { command: 'wc -l src/**/*.ts', description: 'Measure the source' },
  { command: 'npx vitest run tests/unit/retry.test.ts', description: 'Run one test file' },
  { command: 'cargo build --release', description: 'Build in release mode' },
  { command: 'gh run list --limit 5', description: 'Check recent CI runs' },
  { command: 'git bisect log', description: 'Review the bisect so far' },
  { command: 'dig +short api.internal', description: 'Resolve the internal host' },
  { command: 'cat terraform/modules/network/main.tf', description: 'Read the network module' },
  { command: 'npm run lint -- --max-warnings 0', description: 'Lint with no tolerance' },
];

/** Long-running commands: these are the ones that park a lantern on the watchtower. */
export const BACKGROUND_COMMANDS: readonly { command: string; description: string }[] = [
  { command: 'npm run dev', description: 'Start the dev server' },
  { command: 'cargo watch -x test', description: 'Watch and re-run the tests' },
  { command: 'npm run test:e2e', description: 'Run the end to end suite' },
  { command: 'go run ./cmd/server', description: 'Run the server locally' },
  { command: 'make bench-all', description: 'Run the full benchmark sweep' },
  { command: 'docker compose up', description: 'Bring the stack up' },
  { command: 'npm run build -- --watch', description: 'Rebuild on change' },
  { command: 'mix phx.server', description: 'Start the app server' },
];

export const TOOL_RESULTS: readonly string[] = [
  'ok',
  '3 files changed, 41 insertions(+), 12 deletions(-)',
  'PASS  12 passed, 0 failed (3.2s)',
  'packages/core/src/queue.ts:88:  await ack(message)\npackages/core/src/retry.ts:24:  await ack(message)',
  'Compiling tiler v0.4.1\n    Finished test profile in 6.02s',
  'ok  \tinternal/ledger\t1.284s\nok  \tinternal/ledger/fees\t0.221s',
  'FAIL  1 failed, 46 passed (8.9s)\n  ✕ retries share a budget across the pool',
  '  frame.ts:118  const staging = new Float32Array(size)\n  atlas.ts:64   const scratch = new Uint8Array(w * h)',
  'No files changed, working tree clean',
  'warning: unused variable `window`\n  --> src/stream/pipe.rs:212:9',
  'benchmark: tiles/quad     time: [1.842 ms 1.871 ms 1.903 ms]',
  '{"status":"ok","uptime":"4h12m"}',
  'NAME                    READY   STATUS    RESTARTS\nledger-7c9f8d6b4-k2xqz   1/1     Running   0',
  '18 matches across 6 files',
  'Applied 1 edit',
  'Finished in 12.4s — 2 shards, 0 skipped',
];

export const SEARCH_QUERIES: readonly string[] = [
  'acknowledge',
  'retry',
  'idempotency',
  'cache warm',
  'transaction',
  'backpressure',
  'compaction',
  'manifest',
  'deadline',
  'checkpoint',
  'timezone',
  'flush',
  'reconnect',
  'batch size',
  'lock order',
  'file descriptor',
  'rollback',
  'span exporter',
];

export const WEB_QUERIES: readonly string[] = [
  'postgres advisory lock vs row lock throughput',
  'exponential backoff with full jitter reference implementation',
  'wgpu render pass resize invalidation',
  'otlp batch span processor dropping spans',
  'rust tokio semaphore fairness',
  'go context cancellation propagation pitfalls',
  'sqlite wal checkpoint starvation',
  'crdt cursor transform stale offsets',
  'terraform provider normalisation drift',
  'lsm tree compaction read amplification',
];

export const AGENT_TASKS: readonly { type: string; description: string }[] = [
  { type: 'Explore', description: 'Map the queue acknowledgement paths' },
  { type: 'Explore', description: 'Trace the ingest pipeline' },
  { type: 'Explore', description: 'Find every timestamp parse without a zone' },
  { type: 'Explore', description: 'Locate the lock order between merge and checkpoint' },
  { type: 'Explore', description: 'List the callers of the manifest writer' },
  { type: 'general-purpose', description: 'Write the regression test' },
  { type: 'general-purpose', description: 'Review the diff for edge cases' },
  { type: 'general-purpose', description: 'Pool the per-frame staging buffers' },
  { type: 'general-purpose', description: 'Make the down migration restore the default' },
  { type: 'general-purpose', description: 'Turn the panic into a user-facing message' },
  { type: 'Plan', description: 'Draft the migration plan' },
  { type: 'Plan', description: 'Sequence the scheduler split' },
  { type: 'Plan', description: 'Work out a safe rollout for the shared retry budget' },
  { type: 'reviewer', description: 'Check the error paths for silent swallows' },
  { type: 'reviewer', description: 'Sanity-check the rounding in the fee maths' },
  { type: 'bench', description: 'Measure the tiler before and after' },
  { type: 'bench', description: 'Profile the cold start' },
  { type: 'docs', description: 'Write down the segment writer invariants' },
];

export const AGENT_SUMMARIES: readonly string[] = [
  'Mapped the acknowledgement paths; three writers, two of them on the error branch.',
  'Traced the pipeline end to end. Two hops drop the trace context.',
  'Nine call sites, six of them cross a timezone boundary.',
  'The merge thread takes the manifest lock second; everyone else takes it first.',
  'Wrote the test next to the existing case; it fails on the old code and passes on the fix.',
  'Reviewed the diff. One edge case: an empty batch still allocates.',
  'Pooled the staging buffers. Allocation count per frame drops from 14 to 2.',
  'The down migration now restores the default before dropping the constraint.',
  'Benchmarked both: 1.87ms before, 1.12ms after, over 200 samples.',
  'Wrote up the invariants; two of them are only enforced in debug builds.',
];

export const SKILLS: readonly string[] = [
  'migration-safety',
  'perf-profiling',
  'api-review',
  'incident-writeup',
  'schema-design',
  'release-checklist',
  'flaky-test-triage',
  'query-planning',
  'rollout-plan',
  'observability',
];

export const TASK_LISTS: readonly { subject: string; activeForm: string }[][] = [
  [
    { subject: 'Reproduce the double count', activeForm: 'Reproducing the double count' },
    { subject: 'Narrow the retry window', activeForm: 'Narrowing the retry window' },
    { subject: 'Add the regression test', activeForm: 'Adding the regression test' },
  ],
  [
    { subject: 'Measure the cold start', activeForm: 'Measuring the cold start' },
    { subject: 'Move warm-up off the first frame', activeForm: 'Moving warm-up off the first frame' },
  ],
  [
    { subject: 'List the acknowledgement sites', activeForm: 'Listing the acknowledgement sites' },
    { subject: 'Pick one owner', activeForm: 'Picking one owner' },
    { subject: 'Delete the other two', activeForm: 'Deleting the other two' },
    { subject: 'Run the suite', activeForm: 'Running the suite' },
  ],
  [
    { subject: 'Find the lock order', activeForm: 'Finding the lock order' },
    { subject: 'Write the invariant down', activeForm: 'Writing the invariant down' },
  ],
  [
    { subject: 'Cap the pool', activeForm: 'Capping the pool' },
    { subject: 'Prove it with a bench', activeForm: 'Proving it with a bench' },
    { subject: 'Document the new limit', activeForm: 'Documenting the new limit' },
  ],
];

export const PEER_MESSAGES: readonly string[] = [
  'handing this branch over',
  'the fix is on the settlement branch, it needs your migration',
  'I am holding the lock on the manifest tests, give me ten minutes',
  'found the leak, it is in your error path not mine',
  'your benchmark numbers disagree with mine — which build?',
  'taking the queue work, leave the retry budget to me',
  'pushed the plan, tell me if the ordering is wrong',
  'the flake is real and it is ours',
];

export const WORKFLOWS: readonly { name: string; script: string }[] = [
  {
    name: 'release-audit',
    script:
      "export const meta = { name: 'release-audit', phases: [{ title: 'Collect changes' }, { title: 'Check migrations' }, { title: 'Draft notes' }] };",
  },
  {
    name: 'perf-sweep',
    script:
      "export const meta = { name: 'perf-sweep', phases: [{ title: 'Baseline' }, { title: 'Patch' }, { title: 'Re-measure' }, { title: 'Report' }] };",
  },
  {
    name: 'dependency-upgrade',
    script:
      "export const meta = { name: 'dependency-upgrade', phases: [{ title: 'Inventory' }, { title: 'Upgrade' }, { title: 'Run the suite' }] };",
  },
  {
    name: 'incident-review',
    script:
      "export const meta = { name: 'incident-review', phases: [{ title: 'Timeline' }, { title: 'Contributing factors' }, { title: 'Actions' }] };",
  },
  {
    name: 'schema-migration',
    script:
      "export const meta = { name: 'schema-migration', phases: [{ title: 'Plan' }, { title: 'Write the migration' }, { title: 'Backfill' }, { title: 'Verify' }] };",
  },
];

export const QUESTIONS: readonly string[] = [
  'Should the retry budget be shared per pool or per host?',
  'Roll the migration forward, or ship the revert first?',
  'Is a 5% regression on cold start acceptable for this?',
  'Which of the three clients do you want to keep?',
  'Do you want the flake quarantined or fixed before the release?',
];

export function pickFrom<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]!;
}

/**
 * Draws without replacement, reshuffling only when the deck runs out.
 *
 * A plain random pick over forty prompts repeats within a dozen draws, which is
 * exactly the length of time somebody watches the office for. Dealing from a
 * shuffled deck instead means a repeat is impossible until the whole list has
 * been through.
 */
export class Deck<T> {
  private order: readonly T[] = [];
  private next = 0;

  constructor(
    private readonly items: readonly T[],
    private readonly random: () => number,
  ) {}

  draw(): T {
    if (this.next >= this.order.length) this.reshuffle();
    const item = this.order[this.next];
    this.next += 1;
    return item!;
  }

  private reshuffle(): void {
    const last = this.order[this.order.length - 1];
    const shuffled = [...this.items];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      const a = shuffled[i]!;
      shuffled[i] = shuffled[j]!;
      shuffled[j] = a;
    }
    // Reshuffling is the one moment a repeat can slip through, so the deck
    // never opens with the card it just closed on.
    if (shuffled.length > 1 && shuffled[0] === last) {
      const a = shuffled[0]!;
      shuffled[0] = shuffled[shuffled.length - 1]!;
      shuffled[shuffled.length - 1] = a;
    }
    this.order = shuffled;
    this.next = 0;
  }
}
