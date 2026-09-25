import { rng } from '@shared/rand';
import { ACTIVITY_ZONE, type Activity } from '@shared/activity';
import { FigureController, type ZoneResolver } from './figureController';

/**
 * The people who work here but are not your sessions.
 *
 * An office whose only occupants are the two agents you happen to be running
 * is not a quiet office, it is an empty one — and the shared rooms exist to be
 * walked through. These are the caretakers: they cross the campus, stop
 * somewhere for a while, and move on. They carry no state and mean nothing.
 * Reading anything into where one of them is standing would be a mistake, so
 * they are deliberately not clickable and never wear a session's colour.
 *
 * They use the same controller, nav graph and occupancy grids as everyone
 * else, which is the point: if an NPC can walk somewhere, so can an agent, and
 * a routing bug shows up in a crowd long before it shows up in a pair.
 */

/** Small enough to read as background, not so small as to look like children. */
const NPC_SCALE = 0.82;

/** How long one stays put before wandering off again. */
const DWELL_MIN_MS = 14_000;
const DWELL_MAX_MS = 38_000;

/**
 * Where they go. Shared rooms only: a desk belongs to a session, and the
 * pedestal means somebody needs you — putting a caretaker on either would be
 * saying something the office does not mean.
 */
const ERRANDS: Activity[] = [
  'idle',
  'idle',
  'reading',
  'searching',
  'running',
  'testing',
  'browsing',
  'messaging',
  'publishing',
  'delegating',
  'watching',
  'compacting',
];

interface Npc {
  controller: FigureController;
  random: () => number;
  nextMove: number;
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
        'general-purpose',
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
      // Staggered, or the whole crowd sets off together on the first tick and
      // the office looks like a fire drill.
      this.npcs.set(id, { controller, random, nextMove: now + random() * DWELL_MAX_MS });
    }

    for (const npc of this.npcs.values()) npc.controller.rehome(resolver, now);
  }

  update(dt: number, now: number): void {
    for (const npc of this.npcs.values()) {
      if (now >= npc.nextMove) {
        npc.controller.setActivity(ERRANDS[Math.floor(npc.random() * ERRANDS.length)]!, now);
        npc.nextMove = now + DWELL_MIN_MS + npc.random() * (DWELL_MAX_MS - DWELL_MIN_MS);
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

/** A campus this size supports about this many caretakers. */
export function npcCountFor(platforms: number): number {
  return Math.max(2, Math.min(6, Math.round(platforms / 4)));
}
