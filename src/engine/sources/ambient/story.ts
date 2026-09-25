import type { SignalBody } from '../../parse/signals';
import { messageModel, pickFlavour, span, spanInt, type Character } from './character';
import {
  AGENT_SUMMARIES,
  AGENT_TASKS,
  ASSISTANT_LINES,
  BACKGROUND_COMMANDS,
  BASH_COMMANDS,
  Deck,
  PEER_MESSAGES,
  pickFrom,
  PROMPTS,
  QUESTIONS,
  SEARCH_QUERIES,
  SKILLS,
  TASK_LISTS,
  TOOL_RESULTS,
  WEB_QUERIES,
  WORKFLOWS,
  type Repo,
} from './corpus';

/**
 * One emulated session's life, told as signals.
 *
 * It emits exactly what the parser would have produced from a real transcript,
 * so the simulation exercises the same reducers, the same liveness machine and
 * the same rendering path as a live session. Pacing is tuned for watching
 * rather than realism: something interesting every twenty seconds or so, and
 * long enough gaps that the office is not a permanent stampede.
 *
 * Every decision here draws from `ctx.random`, which is the session's own
 * seeded stream. There is no wall clock and no ambient state in this module:
 * the same stream always tells the same story, however the ticks land.
 */

/** Matches the `autoCompactPct` the runtime is built with. */
export const AUTO_COMPACT_PCT = 80;

export interface Beat {
  /** Milliseconds until the *next* beat; the signals here land immediately. */
  after: number;
  signals: SignalBody[];
  /**
   * Marks the last beat a warm-started session replays. Everything after it
   * plays live, so a plan that is waiting for you when the office opens gets
   * approved a minute later rather than the instant you look at it.
   */
  pose?: true;
}

/** Carried across the whole session: ids stay unique, the meter stays honest. */
export interface StoryState {
  seq: number;
  contextUsed: number;
}

export interface StoryDecks {
  prompts: Deck<string>;
  lines: Deck<string>;
  commands: Deck<{ command: string; description: string }>;
  background: Deck<{ command: string; description: string }>;
  results: Deck<string>;
  tasks: Deck<{ type: string; description: string }>;
  summaries: Deck<string>;
  queries: Deck<string>;
  web: Deck<string>;
  skills: Deck<string>;
  todos: Deck<readonly { subject: string; activeForm: string }[]>;
  questions: Deck<string>;
  notes: Deck<string>;
  workflows: Deck<{ name: string; script: string }>;
}

export interface StoryContext {
  random: () => number;
  character: Character;
  /** Fixed for the session's life: a desk works on one checkout, not six. */
  repo: Repo;
  /** Distinguishes this session's ids inside the shared world store. */
  tag: string;
  decks: StoryDecks;
  state: StoryState;
  /** Names of other live sessions, for the occasional message between them. */
  peers: () => string[];
}

export function newStoryState(character: Character): StoryState {
  return { seq: 0, contextUsed: character.contextStart };
}

export function newDecks(random: () => number): StoryDecks {
  return {
    prompts: new Deck(PROMPTS, random),
    lines: new Deck(ASSISTANT_LINES, random),
    commands: new Deck(BASH_COMMANDS, random),
    background: new Deck(BACKGROUND_COMMANDS, random),
    results: new Deck(TOOL_RESULTS, random),
    tasks: new Deck(AGENT_TASKS, random),
    summaries: new Deck(AGENT_SUMMARIES, random),
    queries: new Deck(SEARCH_QUERIES, random),
    web: new Deck(WEB_QUERIES, random),
    skills: new Deck(SKILLS, random),
    todos: new Deck(TASK_LISTS, random),
    questions: new Deck(QUESTIONS, random),
    notes: new Deck(PEER_MESSAGES, random),
    workflows: new Deck(WORKFLOWS, random),
  };
}

// ---------------------------------------------------------------------------
// Beat construction
// ---------------------------------------------------------------------------

/** Every gap runs through the session's tempo: that is what separates desks. */
function beat(ctx: StoryContext, after: number, signals: SignalBody[]): Beat {
  return { after: Math.round(after * ctx.character.tempo), signals };
}

function held(base: Beat): Beat {
  return { ...base, pose: true };
}

function nextId(ctx: StoryContext, prefix: string): string {
  ctx.state.seq += 1;
  // The tag keeps watch and workflow ids unique in the world store, which is
  // shared across every session in the office.
  return `${prefix}_${ctx.tag}_${ctx.state.seq.toString(36)}`;
}

/** Sidecar agent ids are `a` followed by 16 hex digits, and that shape is checked. */
function agentId(ctx: StoryContext): string {
  const hex = '0123456789abcdef';
  let out = 'a';
  for (let i = 0; i < 16; i++) out += hex[Math.floor(ctx.random() * 16)]!;
  return out;
}

function filePath(ctx: StoryContext): string {
  return `/code/${ctx.repo.name}/${pickFrom(ctx.repo.files, ctx.random)}`;
}

// ---------------------------------------------------------------------------
// The shape of a turn
// ---------------------------------------------------------------------------

/** What you typed, and the model taking it in. Returns the turn's message id. */
function* prologue(ctx: StoryContext): Generator<Beat, string> {
  const character = ctx.character;
  const messageId = nextId(ctx, 'msg');

  yield beat(ctx, 1200, [
    { s: 'prompt', text: ctx.decks.prompts.draw(), source: 'typed', images: 0, pasted: 0 },
  ]);

  // The meter climbs with the conversation rather than jumping about; a bar
  // that jitters says nothing, and it is the only way compaction can ever land.
  ctx.state.contextUsed = Math.min(
    character.window,
    ctx.state.contextUsed + Math.round(character.contextPerTurn * (0.6 + ctx.random() * 0.8)),
  );

  yield beat(ctx, 2200 + ctx.random() * 3400, [
    { s: 'thinking', messageId, text: null },
    {
      s: 'usage',
      messageId,
      model: messageModel(character),
      used: ctx.state.contextUsed,
      output: 280 + Math.floor(ctx.random() * 900),
    },
  ]);

  return messageId;
}

function epilogue(ctx: StoryContext, messageId: string): Beat {
  return beat(ctx, 1500 + ctx.random() * 2200, [
    { s: 'text', messageId, text: ctx.decks.lines.draw() },
    { s: 'turnEnd', durationMs: 30_000 + Math.floor(ctx.random() * 240_000) },
  ]);
}

/** The quiet stretch at the desk. Without it the office is a stampede. */
function quiet(ctx: StoryContext, ms?: number): Beat {
  return beat(ctx, ms ?? span(ctx.character.quiet, ctx.random), []);
}

/**
 * A tool call and the result that lands later, as two beats so a warm start can
 * be caught between them with the tool still running.
 *
 * The first gap is how long the call takes, and it is the long one on purpose:
 * that is the stretch where the figure is at the workbench or the shelves. The
 * second is the pause before the next call, which reads as thinking. Getting
 * those the wrong way round parks the whole office at the whiteboard.
 */
function toolPair(ctx: StoryContext): readonly [Beat, Beat] {
  const id = nextId(ctx, 'toolu');
  const use = (after: number, name: string, input: Record<string, unknown>, extra: SignalBody[] = []): Beat =>
    beat(ctx, after, [{ s: 'toolUse', messageId: id, id, name, input }, ...extra]);
  const done = (after: number, text: string): Beat =>
    beat(ctx, after, [{ s: 'toolResult', id, isError: false, text }]);

  switch (pickFlavour(ctx.character.tools, ctx.random)) {
    case 'bash': {
      const bash = ctx.decks.commands.draw();
      return [use(2500 + ctx.random() * 7000, 'Bash', { ...bash }), done(700 + ctx.random() * 1600, ctx.decks.results.draw())];
    }
    case 'read':
      return [use(1400 + ctx.random() * 2600, 'Read', { file_path: filePath(ctx) }), done(500 + ctx.random() * 1100, 'file contents')];
    case 'edit':
      return [use(2000 + ctx.random() * 4000, 'Edit', { file_path: filePath(ctx) }), done(700 + ctx.random() * 1500, 'Applied 1 edit')];
    case 'grep':
      return [
        use(1200 + ctx.random() * 2400, 'Grep', { pattern: ctx.decks.queries.draw() }),
        done(500 + ctx.random() * 1200, '18 matches across 6 files'),
      ];
    case 'web':
      return [
        use(5000 + ctx.random() * 11_000, 'WebSearch', { query: ctx.decks.web.draw() }),
        done(900 + ctx.random() * 1800, '6 results'),
      ];
    case 'skill':
      return [use(1600 + ctx.random() * 2400, 'Skill', { skill: ctx.decks.skills.draw() }), done(500 + ctx.random() * 900, 'loaded')];
    case 'todo': {
      const items = ctx.decks.todos.draw();
      const cut = 1 + Math.floor(ctx.random() * items.length);
      return [
        use(1500 + ctx.random() * 2500, 'TodoWrite', { todos: items.length }, [
          {
            s: 'tasks',
            items: items.map((item, index) => ({
              id: `${id}:${index}`,
              subject: item.subject,
              activeForm: item.activeForm,
              status: index < cut - 1 ? 'completed' : index === cut - 1 ? 'in_progress' : 'pending',
            })),
          },
        ]),
        done(500 + ctx.random() * 700, 'ok'),
      ];
    }
  }
}

function* toolRun(ctx: StoryContext): Generator<Beat> {
  const [use, result] = toolPair(ctx);
  yield use;
  yield result;
}

/**
 * The one thing a turn does beyond calling tools, chosen by character: a
 * delegator fans out most turns, a runner leaves a server running, an architect
 * stops to ask. Most turns roll past all of them and are plainly just work.
 */
function* flourish(ctx: StoryContext): Generator<Beat> {
  const character = ctx.character;
  let roll = ctx.random();
  if ((roll -= character.fanOut) < 0) return yield* fanOut(ctx);
  if ((roll -= character.orchestrates) < 0) return yield* workflowRun(ctx);
  if ((roll -= character.plans) < 0) return yield* planMode(ctx);
  if ((roll -= character.asks) < 0) return yield* askQuestion(ctx);
  if ((roll -= character.watches) < 0) return yield* backgroundWatch(ctx);
  if ((roll -= character.chats) < 0) return yield* messagePeer(ctx);
}

export function* turn(ctx: StoryContext): Generator<Beat> {
  const messageId = yield* prologue(ctx);

  const steps = spanInt(ctx.character.steps, ctx.random);
  for (let i = 0; i < steps; i++) yield* toolRun(ctx);

  // A full window is not a flourish, it is the next thing that has to happen.
  if (ctx.state.contextUsed / ctx.character.window >= AUTO_COMPACT_PCT / 100) yield* compaction(ctx);
  else yield* flourish(ctx);

  yield epilogue(ctx, messageId);
  yield quiet(ctx);
}

/** The session's whole working life, one turn after another. */
export function* story(ctx: StoryContext): Generator<Beat> {
  for (;;) yield* turn(ctx);
}

// ---------------------------------------------------------------------------
// Flourishes
// ---------------------------------------------------------------------------

interface Launched {
  toolUseId: string;
  agent: string;
}

function launch(ctx: StoryContext): { beats: readonly [Beat, Beat]; launched: Launched } {
  const task = ctx.decks.tasks.draw();
  const id = nextId(ctx, 'toolu');
  const child = agentId(ctx);

  return {
    launched: { toolUseId: id, agent: child },
    beats: [
      beat(ctx, 800 + ctx.random() * 1200, [
        {
          s: 'toolUse',
          messageId: id,
          id,
          name: 'Agent',
          input: { subagent_type: task.type, description: task.description, prompt: task.description },
        },
      ]),
      beat(ctx, 400, [
        {
          s: 'toolResult',
          id,
          isError: false,
          text: 'Async agent launched successfully.',
          result: {
            isAsync: true,
            status: 'async_launched',
            agentId: child,
            resolvedModel: ctx.character.agentModel,
          },
        },
      ]),
    ],
  };
}

/** A fan-out: subagents that work for a while and hand back one at a time. */
function* fanOut(ctx: StoryContext, pose = false): Generator<Beat> {
  // A warm start's fan-out is the one thing the office is guaranteed to open
  // with, so it is always worth looking at: never a single agent.
  const count = Math.max(pose ? 2 : 1, spanInt(ctx.character.fanWidth, ctx.random));
  const launched: Launched[] = [];

  for (let i = 0; i < count; i++) {
    const one = launch(ctx);
    launched.push(one.launched);
    yield one.beats[0];
    yield one.beats[1];
  }

  // The wait is its own beat so a warm start can be caught here, with the whole
  // fan still out and nothing handed back yet.
  const working = beat(ctx, 30_000 + ctx.random() * 120_000, []);
  yield pose ? held(working) : working;

  for (const one of launched) {
    yield beat(ctx, 8000 + ctx.random() * 40_000, [
      {
        s: 'taskNotification',
        notification: {
          taskId: one.agent,
          toolUseId: one.toolUseId,
          status: 'completed',
          summary: 'Agent finished',
          result: ctx.decks.summaries.draw(),
          tokens: 40_000 + Math.floor(ctx.random() * 160_000),
          toolUses: 6 + Math.floor(ctx.random() * 34),
          durationMs: 60_000 + Math.floor(ctx.random() * 400_000),
        },
      },
    ]);
  }
}

function* workflowRun(ctx: StoryContext, pose = false): Generator<Beat> {
  const spec = ctx.decks.workflows.draw();
  const id = nextId(ctx, 'toolu');
  const runId = nextId(ctx, 'wf');

  yield beat(ctx, 1500, [
    { s: 'toolUse', messageId: id, id, name: 'Workflow', input: { name: spec.name, script: spec.script } },
  ]);
  const running = beat(ctx, 120_000 + ctx.random() * 240_000, [
    {
      s: 'toolResult',
      id,
      isError: false,
      text: 'Workflow started',
      result: { runId, workflowName: spec.name },
    },
  ]);
  yield pose ? held(running) : running;
  yield beat(ctx, 2000, [
    { s: 'text', messageId: id, text: `${spec.name} finished; the notes are on the branch.` },
  ]);
}

function* compaction(ctx: StoryContext): Generator<Beat> {
  const pre = ctx.state.contextUsed;
  const post = Math.round(pre * (0.12 + ctx.random() * 0.1));

  // The silence before is what the engine reads as "probably compacting".
  yield beat(ctx, 9000 + ctx.random() * 7000, []);
  ctx.state.contextUsed = post;
  yield beat(ctx, 1500, [
    {
      s: 'compact',
      trigger: ctx.random() < 0.25 ? 'manual' : 'auto',
      pre,
      post,
      durationMs: 8000 + Math.floor(ctx.random() * 20_000),
    },
  ]);
}

function* askQuestion(ctx: StoryContext, pose = false): Generator<Beat> {
  const id = nextId(ctx, 'toolu');
  const question = ctx.decks.questions.draw();

  // The `after` is how long the halo stays up: this is a person being waited on.
  const asking = beat(ctx, 45_000 + ctx.random() * 150_000, [
    {
      s: 'toolUse',
      messageId: id,
      id,
      name: 'AskUserQuestion',
      input: { questions: [{ question }], description: question },
    },
  ]);
  yield pose ? held(asking) : asking;
  yield beat(ctx, 1200, [{ s: 'toolResult', id, isError: false, text: 'answered' }]);
}

function* planMode(ctx: StoryContext, pose = false): Generator<Beat> {
  const id = nextId(ctx, 'toolu');

  yield beat(ctx, 8000 + ctx.random() * 14_000, [{ s: 'permissionMode', mode: 'plan' }]);
  const proposal = beat(ctx, 40_000 + ctx.random() * 140_000, [
    { s: 'toolUse', messageId: id, id, name: 'ExitPlanMode', input: {} },
  ]);
  yield pose ? held(proposal) : proposal;
  yield beat(ctx, 1500, [
    { s: 'toolResult', id, isError: false, text: 'approved' },
    { s: 'permissionMode', mode: 'auto' },
  ]);
}

function* backgroundWatch(ctx: StoryContext, pose = false): Generator<Beat> {
  const id = nextId(ctx, 'toolu');
  const taskId = nextId(ctx, 'bg');
  const command = ctx.decks.background.draw();

  yield beat(ctx, 1200, [
    { s: 'toolUse', messageId: id, id, name: 'Bash', input: { ...command, run_in_background: true } },
  ]);
  const started = beat(ctx, 60_000 + ctx.random() * 180_000, [
    { s: 'toolResult', id, isError: false, text: 'started', result: { backgroundTaskId: taskId } },
  ]);
  yield pose ? held(started) : started;
  yield beat(ctx, 1000, [
    {
      s: 'taskNotification',
      notification: { taskId, status: 'completed', summary: 'Background command completed (exit code 0)' },
    },
  ]);
}

function* messagePeer(ctx: StoryContext): Generator<Beat> {
  const others = ctx.peers();
  if (others.length === 0) return;
  const id = nextId(ctx, 'toolu');

  yield beat(ctx, 1500, [
    {
      s: 'toolUse',
      messageId: id,
      id,
      name: 'SendMessage',
      input: { to: pickFrom(others, ctx.random), message: ctx.decks.notes.draw() },
    },
  ]);
  yield beat(ctx, 800, [{ s: 'toolResult', id, isError: false, text: 'Message queued for delivery' }]);
}

// ---------------------------------------------------------------------------
// Warm start
// ---------------------------------------------------------------------------

/**
 * The pose a warm-started session is caught in.
 *
 * An office that opens empty and ramps up is an office you have to wait for.
 * Each of these is a run-up that leaves one session somewhere specific, so the
 * first frame already has work in flight, somebody waiting on you, and a
 * context bar worth reading.
 */
export type Opening =
  | 'midTurn'
  | 'justFinished'
  | 'fannedOut'
  | 'deepContext'
  | 'workflow'
  | 'awaitingPlan'
  | 'awaitingQuestion'
  | 'watching';

export function* opening(ctx: StoryContext, kind: Opening): Generator<Beat> {
  const messageId = yield* prologue(ctx);

  if (kind === 'justFinished') {
    for (let i = 0; i < 2; i++) yield* toolRun(ctx);
    yield held(epilogue(ctx, messageId));
    yield quiet(ctx, 50_000 + ctx.random() * 90_000);
    return;
  }

  switch (kind) {
    case 'midTurn':
    case 'deepContext': {
      const steps = Math.max(2, spanInt(ctx.character.steps, ctx.random));
      for (let i = 0; i < steps; i++) {
        const [use, result] = toolPair(ctx);
        // Caught with the tool still running, so the figure is at the bench.
        yield i === steps - 1 ? held(use) : use;
        yield result;
      }
      break;
    }
    case 'fannedOut':
      yield* toolRun(ctx);
      yield* fanOut(ctx, true);
      break;
    case 'workflow':
      yield* workflowRun(ctx, true);
      break;
    case 'awaitingPlan':
      yield* planMode(ctx, true);
      break;
    case 'awaitingQuestion':
      yield* toolRun(ctx);
      yield* askQuestion(ctx, true);
      break;
    case 'watching':
      yield* backgroundWatch(ctx, true);
      break;
  }

  // Whatever the pose was, the turn it belongs to still has to end.
  yield epilogue(ctx, messageId);
  yield quiet(ctx);
}
