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
  MCP_SERVERS,
  PUBLISH_COMMANDS,
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
  /**
   * Whose transcript this beat belongs to. Absent means the main agent.
   *
   * Without it every signal the simulation produced landed on the main agent,
   * so a subagent existed as a card and a figure with no transcript at all —
   * and the canvas drew it as a 440×300 rectangle of nothing. Which is what a
   * new user saw, since the simulation is what runs when nothing else does.
   */
  agent?: string;
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
  servers: Deck<string>;
  publishes: Deck<{ command: string; description: string }>;
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
    servers: new Deck(MCP_SERVERS, random),
    publishes: new Deck(PUBLISH_COMMANDS, random),
  };
}

// ---------------------------------------------------------------------------
// Beat construction
// ---------------------------------------------------------------------------

/** Every gap runs through the session's tempo: that is what separates desks. */
function beat(ctx: StoryContext, after: number, signals: SignalBody[], agent?: string): Beat {
  return { after: Math.round(after * ctx.character.tempo), signals, ...(agent ? { agent } : {}) };
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
  /** How long the call is pending — the time the figure spends at the prop. */
  const call = (pending: number, name: string, input: Record<string, unknown>, extra: SignalBody[] = []): Beat =>
    beat(ctx, pending, [{ s: 'toolUse', messageId: id, id, name, input }, ...extra]);
  /** And the think afterwards, before whatever the agent does next. */
  const back = (think: number, text: string): Beat =>
    beat(ctx, think, [{ s: 'toolResult', id, isError: false, text }]);

  /*
   * The first number is how long the tool is *pending*, and it is the one that
   * decides what the office looks like.
   *
   * Every one of these used to be between half a second and two, whatever the
   * tool — so a test run and a file read took the same time, and the figure had
   * gone back to thinking before it could have walked anywhere. Measured over
   * five minutes, the workshop was never once used. These are the durations the
   * real tools take: a read is a moment, a suite of tests is most of a minute,
   * and a web search is somewhere between. The office reads them straight off,
   * so a session running tests is a figure standing at the copier while they
   * run, which is both what is happening and the thing worth seeing.
   *
   * They were also, for one round, on the wrong beat of the pair. A beat's
   * duration is the dwell that *follows* its signals, so the long number was
   * landing on the gap after the result rather than on the call: a test suite
   * was pending for three seconds and the session then sat doing nothing for
   * the best part of a minute. Two fifths of all agent-time was thinking at a
   * desk, and the props it was supposed to be standing at went unused. Hence
   * the names: whatever is in `call` is what you watch happen.
   */
  switch (pickFlavour(ctx.character.tools, ctx.random)) {
    case 'bash': {
      const bash = ctx.decks.commands.draw();
      const heavy = /test|build|install|bench|lint|tsc|vitest|jest|cargo|forge/.test(String(bash['command'] ?? ''));
      return [
        call(heavy ? 14_000 + ctx.random() * 42_000 : 1200 + ctx.random() * 6500, 'Bash', { ...bash }),
        back(2500 + ctx.random() * 7000, ctx.decks.results.draw()),
      ];
    }
    case 'read':
      return [call(900 + ctx.random() * 2600, 'Read', { file_path: filePath(ctx) }), back(1400 + ctx.random() * 2600, 'file contents')];
    case 'edit':
      return [call(1600 + ctx.random() * 4000, 'Edit', { file_path: filePath(ctx) }), back(2000 + ctx.random() * 4000, 'Applied 1 edit')];
    case 'grep':
      return [
        call(1100 + ctx.random() * 3400, 'Grep', { pattern: ctx.decks.queries.draw() }),
        back(1200 + ctx.random() * 2400, '18 matches across 6 files'),
      ];
    case 'web':
      return [
        call(7000 + ctx.random() * 16_000, 'WebSearch', { query: ctx.decks.web.draw() }),
        back(5000 + ctx.random() * 11_000, '6 results'),
      ];
    case 'skill':
      return [call(1800 + ctx.random() * 3600, 'Skill', { skill: ctx.decks.skills.draw() }), back(1600 + ctx.random() * 2400, 'loaded')];
    case 'mcp':
      return [
        call(2600 + ctx.random() * 7000, `mcp__${ctx.decks.servers.draw()}`, {}),
        back(2200 + ctx.random() * 5000, 'ok'),
      ];
    case 'publish': {
      const push = ctx.decks.publishes.draw();
      return [call(2600 + ctx.random() * 6000, 'Bash', { ...push }), back(3000 + ctx.random() * 6000, 'done')];
    }
    case 'todo': {
      const items = ctx.decks.todos.draw();
      const cut = 1 + Math.floor(ctx.random() * items.length);
      return [
        call(1500 + ctx.random() * 2500, 'TodoWrite', { todos: items.length }, [
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
        back(1500 + ctx.random() * 2500, 'ok'),
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
 *
 * The order matters, because the weights are subtracted in it: whatever is last
 * only happens on the tail of the roll, and on a busy archetype whose weights
 * nearly sum to one it hardly happens at all. Messaging a peer used to be last
 * and was effectively switched off for exactly the sessions — the delegator,
 * the integrator — that are meant to do it. The two things worth walking across
 * the office to watch go first.
 */
function* flourish(ctx: StoryContext): Generator<Beat> {
  const character = ctx.character;
  let roll = ctx.random();
  if ((roll -= character.fanOut) < 0) return yield* fanOut(ctx);
  if ((roll -= character.chats) < 0) return yield* messagePeer(ctx);
  if ((roll -= character.orchestrates) < 0) return yield* workflowRun(ctx);
  if ((roll -= character.plans) < 0) return yield* planMode(ctx);
  if ((roll -= character.asks) < 0) return yield* askQuestion(ctx);
  if ((roll -= character.watches) < 0) return yield* backgroundWatch(ctx);
}

export function* turn(ctx: StoryContext): Generator<Beat> {
  const messageId = yield* prologue(ctx);

  const steps = spanInt(ctx.character.steps, ctx.random);
  for (let i = 0; i < steps; i++) yield* toolRun(ctx);

  // Rarely, the API says no. Not a character trait: nobody is immune to it.
  if (ctx.random() < 0.05) yield* hiccup(ctx);

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

/**
 * One subagent, launched to block its parent or to run behind it.
 *
 * Every launch used to report `isAsync` — "Async agent launched successfully",
 * the shape of a *background* agent, whose parent carries straight on working
 * and whose Agent call is already finished. That is the uncommon case, and
 * modelling only it meant no agent in this office ever waited for anybody: the
 * Commons grew chairs for children who arrived while their parent sat at its
 * own desk. A blocking launch leaves the parent waiting on its children for as
 * long as they run, which is what sits it down at the round table with them.
 */
function launch(ctx: StoryContext, background: boolean): { beats: readonly [Beat, Beat]; launched: Launched } {
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
          text: background ? 'Async agent launched successfully.' : 'Agent started.',
          result: {
            isAsync: background,
            status: background ? 'async_launched' : 'launched',
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
  // Most fan-outs are waited on; the rest are left running in the background
  // while the parent gets on with something else. See `launch`.
  const background = ctx.random() < 0.35;

  for (let i = 0; i < count; i++) {
    const one = launch(ctx, background);
    launched.push(one.launched);
    yield one.beats[0];
    yield one.beats[1];
  }

  /*
   * The fan actually working, rather than a gap with a number on it.
   *
   * Each agent gets the shape of a real subagent transcript — the task it was
   * given, a think, a couple of calls, a finding — written to its own log. The
   * beats are interleaved across agents on purpose: they run at the same time,
   * and a card that fills top to bottom while its sibling sits empty reads as
   * one agent working and one stuck.
   */
  const rounds = 2 + Math.floor(ctx.random() * 2);
  for (const one of launched) {
    yield beat(ctx, 300 + ctx.random() * 500, [{ s: 'thinking', messageId: nextId(ctx, 'msg'), text: null }], one.agent);
  }
  for (let round = 0; round < rounds; round += 1) {
    for (const one of launched) {
      const [use, done] = toolPair(ctx);
      yield { ...use, after: Math.round(900 + ctx.random() * 2200), agent: one.agent };
      yield { ...done, after: Math.round(500 + ctx.random() * 1400), agent: one.agent };
    }
  }
  for (const one of launched) {
    yield beat(
      ctx,
      600 + ctx.random() * 1400,
      [{ s: 'text', messageId: nextId(ctx, 'msg'), text: ctx.decks.summaries.draw() }],
      one.agent,
    );
  }

  // Then, most of the time, the parent and one of them talk about it.
  if (launched.length > 0 && ctx.random() < 0.7) {
    yield* confer(ctx, launched[Math.floor(ctx.random() * launched.length)]!);
  }

  // The wait is its own beat so a warm start can be caught here, with the whole
  // fan still out and nothing handed back yet.
  const working = beat(ctx, 8000 + ctx.random() * 40_000, []);
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

  /*
   * How long the halo stays up.
   *
   * Shorter than it was, and the reason is arithmetic rather than taste.
   * Waiting is the one state that *parks* a session: a figure on the pedestal
   * is not reading, running or walking anywhere, so a long wait removes it from
   * the office entirely. At three-quarters of a minute, measured across a busy
   * house, one in seven of everybody was standing on a plinth doing nothing.
   * Long enough to catch, short enough that the office is still working.
   */
  const asking = beat(ctx, 26_000 + ctx.random() * 70_000, [
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

  /*
   * Longer at the whiteboard, shorter on the plinth.
   *
   * These two numbers are the whole of what plan mode looks like, and they were
   * the wrong way round: ten seconds of planning and up to three minutes of
   * waiting to be told yes. Planning is the part worth watching — it is the
   * only thing that uses the atelier — and waiting is the part that takes a
   * figure out of the office. So the thinking gets the time.
   */
  yield beat(ctx, 1500, [{ s: 'permissionMode', mode: 'plan' }]);
  // And it is spent reading, not staring at the board. See `research`.
  const digs = 2 + Math.floor(ctx.random() * 3);
  for (let i = 0; i < digs; i += 1) yield* research(ctx);
  const proposal = beat(ctx, 9000 + ctx.random() * 24_000, [
    { s: 'toolUse', messageId: id, id, name: 'ExitPlanMode', input: {} },
  ]);
  yield pose ? held(proposal) : proposal;
  yield beat(ctx, 1500, [
    { s: 'toolResult', id, isError: false, text: 'approved' },
    { s: 'permissionMode', mode: 'auto' },
  ]);
}

/**
 * The request that did not go through, and the wait before trying again.
 *
 * Rate limits and server errors are part of a working afternoon, and the office
 * has had a bench for them from the start — the hourglass in the lounge, which
 * nothing had ever sat on, because the simulation's requests never failed. Rare
 * on purpose, and long enough when it happens to see a figure sitting it out.
 */
function* hiccup(ctx: StoryContext): Generator<Beat> {
  const refused = nextId(ctx, 'msg');
  // The dwell after a beat is what it looks like, so the wait belongs here.
  yield beat(ctx, 12_000 + ctx.random() * 26_000, [
    {
      s: 'usage',
      messageId: refused,
      model: messageModel(ctx.character),
      used: ctx.state.contextUsed,
      output: 0,
      apiError: true,
      error: ctx.random() < 0.45 ? 'rate_limit' : 'server_error',
    },
  ]);

  // The retry that goes through, which is also what clears the condition.
  const retry = nextId(ctx, 'msg');
  yield beat(ctx, 1800 + ctx.random() * 2600, [
    { s: 'thinking', messageId: retry, text: null },
    {
      s: 'usage',
      messageId: retry,
      model: messageModel(ctx.character),
      used: ctx.state.contextUsed,
      output: 140 + Math.floor(ctx.random() * 600),
    },
  ]);
}

/**
 * Reading around before proposing something, which is what planning is.
 *
 * The plan stretch used to be one empty beat: the session entered plan mode and
 * sat there for the best part of a minute. The office drew that honestly — a
 * figure at a whiteboard, not moving — and it was very nearly the only thing
 * the atelier ever got. These are what fills it. Each one walks the figure off
 * to the library or the observatory and back to the board, which is both what
 * the agent is doing and the half of it worth watching; the long pause is now
 * in front of each call, where the thinking is.
 */
function* research(ctx: StoryContext): Generator<Beat> {
  const id = nextId(ctx, 'toolu');
  const call = (pending: number, name: string, input: Record<string, unknown>): Beat =>
    beat(ctx, pending, [{ s: 'toolUse', messageId: id, id, name, input }]);
  const board = (think: number, text: string): Beat =>
    beat(ctx, think, [{ s: 'toolResult', id, isError: false, text }]);

  /*
   * Both halves are generous on purpose. Each of these is a round trip — the
   * whiteboard, the library, the whiteboard — and a figure that is only away
   * for two seconds never commits to the walk at all, so the atelier would get
   * the whole stretch and the research would be invisible.
   */
  const roll = ctx.random();
  if (roll < 0.45) {
    yield call(5000 + ctx.random() * 4000, 'Read', { file_path: filePath(ctx) });
    yield board(7000 + ctx.random() * 6000, 'file contents');
    return;
  }
  if (roll < 0.8) {
    yield call(5000 + ctx.random() * 4500, 'Grep', { pattern: ctx.decks.queries.draw() });
    yield board(7000 + ctx.random() * 6000, '12 matches across 4 files');
    return;
  }
  yield call(7000 + ctx.random() * 9000, 'WebSearch', { query: ctx.decks.web.draw() });
  yield board(6500 + ctx.random() * 6000, '6 results');
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

/**
 * A word with one of the agents you sent out, and its answer.
 *
 * A fan-out used to be entirely one-way: the parent launched, the children
 * worked in silence, and a notification came back. That is a fair account of
 * the data and a poor account of the *place* — the whole reason the subagent
 * rises beside its parent rather than somewhere else is that the two of them
 * are working together, and nothing in the office ever showed them doing it.
 * A message each way is what the office turns into two figures standing
 * together talking, which is the thing to watch.
 */
function* confer(ctx: StoryContext, one: Launched): Generator<Beat> {
  const down = nextId(ctx, 'toolu');
  yield beat(ctx, 1200 + ctx.random() * 1800, [
    {
      s: 'toolUse',
      messageId: down,
      id: down,
      name: 'SendMessage',
      input: { to: one.agent, message: ctx.decks.notes.draw() },
    },
  ]);
  yield beat(ctx, 700, [{ s: 'toolResult', id: down, isError: false, text: 'Message queued for delivery' }]);

  const up = nextId(ctx, 'toolu');
  yield beat(
    ctx,
    2000 + ctx.random() * 4000,
    [
      {
        s: 'toolUse',
        messageId: up,
        id: up,
        name: 'SendMessage',
        input: { to: 'main', message: ctx.decks.summaries.draw() },
      },
    ],
    one.agent,
  );
  yield beat(ctx, 700, [{ s: 'toolResult', id: up, isError: false, text: 'Message queued for delivery' }], one.agent);
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
