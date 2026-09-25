/**
 * What an agent is doing, and where that puts it in the office.
 *
 * Every Activity maps to exactly one zone; the zone's slot type decides which
 * piece of furniture the figure walks to.
 */

export type Activity =
  | 'idle' // lounge sofa
  | 'thinking' // atelier at the start of a turn, otherwise in place
  | 'planning' // atelier whiteboard (plan mode)
  | 'tasking' // atelier sticky notes (TaskCreate/TaskUpdate/TodoWrite)
  | 'responding' // home desk, typing
  | 'editing' // home desk (Edit/Write/NotebookEdit)
  | 'reading' // library reading stand
  | 'searching' // library shelves
  | 'learning' // library skill shelf (Skill)
  | 'compacting' // archive cabinets
  | 'running' // workshop bench (generic Bash)
  | 'testing' // workshop copier (test/build commands)
  | 'tooling' // workshop server rack (mcp__*)
  | 'browsing' // observatory telescope
  | 'delegating' // commons round table (Agent spawn)
  | 'orchestrating' // war room (Workflow)
  | 'watching' // watchtower (Monitor, background tasks, wakeups, cron)
  | 'messaging' // mailroom counter
  | 'publishing' // mailroom paper plane (SendUserFile/Artifact/gh pr create)
  | 'awaiting' // pedestal halo, or the whiteboard for plan approval
  | 'stalled' // hourglass bench (API error, rate limit)
  | 'offline';

export type ZoneId =
  | 'desk'
  | 'atelier'
  | 'library'
  | 'archive'
  | 'workshop'
  | 'observatory'
  | 'commons'
  | 'warroom'
  | 'watchtower'
  | 'mailroom'
  | 'lounge'
  | 'pedestal';

export type SlotKind =
  | 'deskSeat'
  | 'whiteboard'
  | 'stickyWall'
  | 'readStand'
  | 'shelf'
  | 'skillShelf'
  | 'cabinet'
  | 'bench'
  | 'copier'
  | 'rack'
  | 'telescope'
  | 'tableSeat'
  | 'warTableSeat'
  | 'deck'
  | 'counter'
  | 'sofa'
  | 'hourglass'
  | 'plinth';

export interface ZoneTarget {
  zone: ZoneId;
  slot: SlotKind;
}

/**
 * Where each activity puts a figure.
 *
 * One rule decides most of the feel of the office: **thinking happens at your
 * desk**. It is tempting to send it to the whiteboard — thinking looks like
 * standing at a whiteboard — but every single turn begins with a thinking
 * block, and over an hour of real traffic thinking outnumbers every other
 * activity roughly two to one. Routing it to the atelier put the entire
 * population at one whiteboard permanently: the desks sat empty, the other
 * rooms never got used, and the office read as one crowded room surrounded by
 * furniture nobody touched.
 *
 * So the desk is home, and you go somewhere for a *reason*: to the library to
 * read, to the workshop to run something, to the atelier when you are actually
 * planning rather than merely thinking. The walk is the information.
 */
export const ACTIVITY_ZONE: Record<Activity, ZoneTarget> = {
  idle: { zone: 'lounge', slot: 'sofa' },
  thinking: { zone: 'desk', slot: 'deskSeat' },
  planning: { zone: 'atelier', slot: 'whiteboard' },
  tasking: { zone: 'atelier', slot: 'stickyWall' },
  responding: { zone: 'desk', slot: 'deskSeat' },
  editing: { zone: 'desk', slot: 'deskSeat' },
  reading: { zone: 'library', slot: 'readStand' },
  searching: { zone: 'library', slot: 'shelf' },
  learning: { zone: 'library', slot: 'skillShelf' },
  compacting: { zone: 'archive', slot: 'cabinet' },
  running: { zone: 'workshop', slot: 'bench' },
  testing: { zone: 'workshop', slot: 'copier' },
  tooling: { zone: 'workshop', slot: 'rack' },
  browsing: { zone: 'observatory', slot: 'telescope' },
  delegating: { zone: 'commons', slot: 'tableSeat' },
  orchestrating: { zone: 'warroom', slot: 'warTableSeat' },
  watching: { zone: 'watchtower', slot: 'deck' },
  messaging: { zone: 'mailroom', slot: 'counter' },
  publishing: { zone: 'mailroom', slot: 'counter' },
  awaiting: { zone: 'pedestal', slot: 'plinth' },
  stalled: { zone: 'lounge', slot: 'hourglass' },
  offline: { zone: 'lounge', slot: 'sofa' },
};

/** Short human phrase for an activity, used in the inspector, tray and hover card. */
export const ACTIVITY_LABEL: Record<Activity, string> = {
  idle: 'idle',
  thinking: 'thinking',
  planning: 'planning',
  tasking: 'writing tasks',
  responding: 'writing',
  editing: 'editing',
  reading: 'reading',
  searching: 'searching',
  learning: 'reading a skill',
  compacting: 'compacting',
  running: 'running a command',
  testing: 'running tests',
  tooling: 'calling a tool',
  browsing: 'browsing',
  delegating: 'delegating',
  orchestrating: 'orchestrating',
  watching: 'watching',
  messaging: 'messaging',
  publishing: 'publishing',
  awaiting: 'waiting on you',
  stalled: 'stalled',
  offline: 'offline',
};
