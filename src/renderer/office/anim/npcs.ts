import { rng } from '@shared/rand';
import { ACTIVITY_ZONE, type Activity } from '@shared/activity';
import { FigureController, type ZoneResolver } from './figureController';

/**
 * The people who work here but are not your sessions.
 *
 * An office whose only occupants are the two agents you happen to be running
 * is not a quiet office, it is an empty one — and the shared rooms exist to be
 * walked through. They carry no state and mean nothing: reading anything into
 * where one of them is standing would be a mistake. They are still worth
 * clicking, because the first thing anyone does with a figure they cannot
 * identify is click it, and "somebody who works here" is a better answer than
 * nothing happening.
 *
 * They used to be smaller than the agents, which said *unimportant* when what
 * was meant is *not yours* — and left the office looking like it employed
 * children. They are full size now and told apart by silhouette instead: the
 * one rounded body in a campus of faceted solids. See `FigureShape`.
 *
 * They use the same controller, nav graph and occupancy grids as everyone
 * else, which is the point: if an NPC can walk somewhere, so can an agent, and
 * a routing bug shows up in a crowd long before it shows up in a pair.
 */

/** The same presence as an agent on a mid-sized model. */
const NPC_SCALE = 1.8;

/** How long one stays put before wandering off again. */
const DWELL_MIN_MS = 14_000;
const DWELL_MAX_MS = 38_000;
/** Sitting down with something is worth doing for longer than standing about. */
const SETTLED_MIN_MS = 26_000;
const SETTLED_MAX_MS = 70_000;

/**
 * Where they go. Shared rooms only: a desk belongs to a session, and the
 * pedestal means somebody needs you — putting one of them on either would be
 * saying something the office does not mean.
 */
/*
 * Weighted toward the things that look like somebody's afternoon rather than
 * somebody's errand. The office was full of people striding between rooms and
 * standing at things; what it was short of was anyone who had sat down.
 *
 * `idle` is the lounge — the sofa, and the coffee machine next to it — and it
 * is the most common entry on purpose. `reading` and `searching` are the
 * library, which is the other place with something to do.
 */
const ERRANDS: Activity[] = [
  'idle',
  'idle',
  'idle',
  'reading',
  'reading',
  'searching',
  'delegating',
  'running',
  'testing',
  'browsing',
  'messaging',
  'publishing',
  'watching',
  'compacting',
];

/**
 * Errands somebody comes away from holding something.
 *
 * The coffee machine is in the lounge and the mailroom counter hands things
 * over, so both end with a cup or a parcel in hand — which is the difference
 * between a figure that walked somewhere and a figure that went and did
 * something. They put it down when they next move on.
 */
const HANDS_FULL = new Set<Activity>(['idle', 'messaging', 'publishing']);

/** Errands that are worth settling into rather than passing through. */
const SETTLED = new Set<Activity>(['idle', 'reading', 'delegating']);

interface Npc {
  controller: FigureController;
  random: () => number;
  nextMove: number;
  /** What they are up to, in words. See `describe`. */
  activity: Activity;
  /** Stable per person, so the wording does not shuffle while you hover. */
  voice: number;
}

/**
 * What somebody is doing, in words, for the card that comes up when you point
 * at them.
 *
 * The card used to say "Someone who works here. Not one of your sessions, and
 * not doing anything on your behalf." — which is true, and is a disclaimer
 * rather than an answer. You pointed at a figure carrying a cup across a
 * courtyard and were told, correctly, that it means nothing. The whole reason
 * these people are here is that an office with nobody in it is a diagram, and
 * an office where you can find out that somebody has gone to get a coffee is a
 * place.
 *
 * Three states per errand — on the way, doing it, and settled into it — because
 * that is the difference the animation already draws and the card was throwing
 * away. Whether their hands are full is the fourth, and it is the one that
 * turns "in the lounge" into "sitting with a coffee".
 */
const DOING: Partial<Record<Activity, { going: string[]; there: string[]; settled: string[] }>> = {
  idle: {
    going: ['Off to find the coffee machine', 'Wandering toward the lounge'],
    there: ['Waiting on the coffee machine', 'Standing about in the lounge'],
    settled: ['Sat down with nothing to do', 'On the sofa, going nowhere'],
  },
  reading: {
    going: ['Off to find something to read', 'Heading for the shelves'],
    there: ['Picking something off a shelf', 'Reading standing up'],
    settled: ['Deep in something long', 'Reading, and in no hurry about it'],
  },
  searching: {
    going: ['Off to look something up', 'Heading for the library'],
    there: ['Working along the shelves', 'Looking for a book that is not there'],
    settled: ['Three books open at once', 'Still looking'],
  },
  delegating: {
    going: ['On their way to the table', 'Going to find somebody'],
    there: ['Waiting for the others', 'Hovering by the table'],
    settled: ['Round the table, mostly listening', 'In a meeting about nothing'],
  },
  running: { going: ['Off to the workshop'], there: ['Feeding the copier'], settled: ['Watching the copier'] },
  testing: { going: ['Off to the workshop'], there: ['Waiting on the copier'], settled: ['Waiting on the copier'] },
  browsing: { going: ['Off to the observatory'], there: ['At the telescope'], settled: ['Still at the telescope'] },
  messaging: { going: ['Off to the mailroom'], there: ['Posting something'], settled: ['Reading the noticeboard'] },
  publishing: { going: ['Taking something to the mailroom'], there: ['Sending something off'], settled: ['Waiting for a reply'] },
  watching: { going: ['Climbing the tower'], there: ['Up the tower, watching'], settled: ['Watching the horizon'] },
  compacting: { going: ['Off to the archive'], there: ['Filing things away'], settled: ['Lost in the filing'] },
};

const CARRYING: Partial<Record<Activity, string>> = {
  idle: 'Carrying a coffee back',
  messaging: 'Carrying a parcel from the mailroom',
  publishing: 'Carrying something to be sent',
};

export function describeNpc(npc: { controller: FigureController; activity: Activity; voice: number }): string {
  const pose = npc.controller.pose();
  const walking = npc.controller.phase === 'walking' || npc.controller.phase === 'arriving';
  // Hands full and on the move is the one that beats everything else: it is
  // the most legible thing they ever do, and it is visibly true on screen.
  if (walking && pose.carry > 0.4) return CARRYING[npc.activity] ?? 'Carrying something across the office';

  const lines = DOING[npc.activity];
  if (!lines) return walking ? 'On their way somewhere' : 'Getting on with something';
  const bucket = walking ? lines.going : pose.seated > 0.5 ? lines.settled : lines.there;
  const said = bucket[npc.voice % bucket.length] ?? bucket[0]!;
  if (!walking && pose.carry > 0.4 && npc.activity === 'idle') return 'Sitting with a coffee';
  return said;
}

export class NpcPopulation {
  private readonly npcs = new Map<string, Npc>();
  private readonly random: () => number;

  constructor(seed: number, private readonly count: number) {
    this.random = rng(seed ^ 0x5eed);
  }

  /** Every controller, so the scene can draw them alongside the agents. */
  controllers(): FigureController[] {
    return [...this.npcs.values()].map((npc) => npc.controller);
  }

  has(id: string): boolean {
    return this.npcs.has(id);
  }

  /** What this one is up to, in words, for the hover card. */
  describe(id: string): string | null {
    const npc = this.npcs.get(id);
    return npc ? describeNpc(npc) : null;
  }

  /**
   * Brings the crowd up to strength and re-homes it onto the current campus.
   * Called whenever the floor plan changes, exactly like the agents are.
   */
  settle(resolver: ZoneResolver, now: number): void {
    for (let i = this.npcs.size; i < this.count; i++) {
      const id = `npc:${i}`;
      const random = rng((this.random() * 0xffffffff) >>> 0);
      const activity = ERRANDS[Math.floor(random() * ERRANDS.length)]!;
      const target = resolver.platformFor(ACTIVITY_ZONE[activity].zone, id);
      if (!target) continue;
      const slot = resolver.claimSlot(id, target.platformId, ACTIVITY_ZONE[activity].slot, target.position);

      const controller = new FigureController(
        id,
        'npc',
        NPC_SCALE,
        {
          position: slot.position,
          platformId: target.platformId,
          zone: ACTIVITY_ZONE[activity].zone,
          facing: slot.facing,
          slot: ACTIVITY_ZONE[activity].slot,
          ...(slot.seat === undefined ? {} : { seat: slot.seat }),
        },
        resolver,
        now,
      );
      controller.setActivity(activity, now);
      controller.setHolding(HANDS_FULL.has(activity) && random() < 0.55);
      // Staggered, or the whole crowd sets off together on the first tick and
      // the office looks like a fire drill.
      this.npcs.set(id, {
        controller,
        random,
        nextMove: now + random() * DWELL_MAX_MS,
        activity,
        voice: Math.floor(random() * 997),
      });
    }

    for (const npc of this.npcs.values()) npc.controller.rehome(resolver, now);
  }

  update(dt: number, now: number, busy?: (id: string) => boolean): void {
    for (const npc of this.npcs.values()) {
      // Somebody mid-conversation does not walk off in the middle of it. The
      // errand clock is pushed rather than paused, so they set off shortly
      // after it ends rather than the instant it does.
      if (busy?.(npc.controller.id)) npc.nextMove = Math.max(npc.nextMove, now + 1200);
      if (now >= npc.nextMove) {
        const activity = ERRANDS[Math.floor(npc.random() * ERRANDS.length)]!;
        npc.activity = activity;
        npc.controller.setActivity(activity, now);
        // Whatever they were holding goes down when they set off, and they
        // come away from some errands with something new.
        npc.controller.setHolding(HANDS_FULL.has(activity) && npc.random() < 0.55);
        const [low, high] = SETTLED.has(activity)
          ? [SETTLED_MIN_MS, SETTLED_MAX_MS]
          : [DWELL_MIN_MS, DWELL_MAX_MS];
        npc.nextMove = now + low + npc.random() * (high - low);
      }
      npc.controller.update(dt, now);
    }
  }

  /** Sends everyone home, for when the option is switched off. */
  clear(release: (id: string) => void): void {
    for (const id of this.npcs.keys()) release(id);
    this.npcs.clear();
  }
}

/** A campus this size supports about this many of them. */
export function npcCountFor(platforms: number): number {
  return Math.max(2, Math.min(6, Math.round(platforms / 4)));
}
