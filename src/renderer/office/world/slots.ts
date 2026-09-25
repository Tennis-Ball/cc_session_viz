import type { SlotKind } from '@shared/activity';
import { levelY } from './campusTemplate';
import type { Campus, Platform } from './layout';
import type { Vec3 } from './navGraph';
import type { Occupancy } from './occupancy';
import type { PropSlot } from '../props/types';

/**
 * Who stands where.
 *
 * Each zone's props publish anchor points; this hands them out, one agent at a
 * time, and invents overflow spots around the rim when a zone is busier than it
 * was designed for. Without it, five agents reading at once would occupy the
 * same bookshelf.
 */

export interface SlotClaim {
  platformId: string;
  position: Vec3;
  facing: number;
  kind: SlotKind;
  /** Height of the seat, when this is somewhere you sit. */
  seat?: number;
}

interface SlotEntry extends SlotClaim {
  key: string;
  occupant: string | null;
}

export class SlotPool {
  private readonly slots = new Map<string, SlotEntry[]>();
  private readonly claims = new Map<string, SlotEntry>();

  constructor(
    private readonly campus: Campus,
    propSlots: Map<string, PropSlot[]>,
    private readonly occupancy: Map<string, Occupancy> = new Map(),
  ) {
    for (const platform of campus.platforms) {
      const entries: SlotEntry[] = [];
      const y = levelY(platform.level);
      const anchors = propSlots.get(platform.id) ?? [];
      const grid = this.occupancy.get(platform.id);

      anchors.forEach((slot, index) => {
        const x = platform.position[0] + slot.position[0];
        const z = platform.position[1] + slot.position[2];
        /**
         * Props are scaled to their platform, which can push an anchor into
         * the furniture it was measured against. Nudge it back out to the
         * nearest place a figure can actually stand — unless it is a seat.
         *
         * A chair is furniture, so the occupancy grid has it blocked, and a
         * seat anchor sits squarely inside it by definition. Nudging that one
         * "out" moves it off the chair and stands the figure next to it, which
         * is half of why nobody has ever sat down properly. Routing snaps its
         * own endpoints to free floor, so an anchor inside the furniture is
         * still walked to correctly; only the last step goes onto the chair.
         */
        /**
         * A seat is not the only anchor that belongs inside its own furniture.
         *
         * Anything the figure stands *on* rather than beside is raised, and
         * being raised is exactly what makes the grid call it blocked — the
         * pedestal's plinth is the whole prop, so the nudge pushed the one
         * awaiting figure several units off the plinth while it kept the
         * plinth's height, and it stood in mid air beside the glowing ring it
         * was supposed to be standing on.
         */
        const onProp = slot.seat !== undefined || slot.position[1] > 0.05;
        const [freeX, freeZ] = grid && !onProp ? grid.nearestFree(x, z) : [x, z];
        entries.push({
          key: `${platform.id}:${index}`,
          platformId: platform.id,
          kind: slot.kind,
          position: [freeX, y + slot.position[1], freeZ],
          facing: slot.facing,
          occupant: null,
          // The other half. Every prop that has a chair publishes how high its
          // seat is, and this dropped it on the floor: `SlotClaim.seat` was
          // declared, documented and never once assigned, so every claim came
          // back undefined and the controller — which sits only when it is
          // told a seat height — correctly concluded there was nothing to sit
          // on, anywhere in the office.
          ...(slot.seat === undefined ? {} : { seat: slot.seat }),
        });
      });

      this.slots.set(platform.id, entries);
    }
  }

  /** Nearest free slot of the requested kind, else any free slot, else the rim. */
  claim(agentId: string, platformId: string, kind: SlotKind, near?: Vec3): SlotClaim {
    this.release(agentId);
    const entries = this.slots.get(platformId) ?? [];

    const free = entries.filter((entry) => entry.occupant === null);
    const preferred = free.filter((entry) => entry.kind === kind);
    const pool = preferred.length ? preferred : free;

    const chosen = near ? nearest(pool, near) : pool[0];
    if (chosen) {
      chosen.occupant = agentId;
      this.claims.set(agentId, chosen);
      return chosen;
    }

    const overflow = this.overflowSlot(platformId, entries.length + this.overflowCount(platformId), kind);
    const grid = this.occupancy.get(platformId);
    if (grid) {
      const [x, z] = grid.nearestFree(overflow.position[0], overflow.position[2]);
      overflow.position = [x, overflow.position[1], z];
    }
    overflow.occupant = agentId;
    entries.push(overflow);
    this.slots.set(platformId, entries);
    this.claims.set(agentId, overflow);
    return overflow;
  }

  release(agentId: string): void {
    const claim = this.claims.get(agentId);
    if (!claim) return;
    claim.occupant = null;
    this.claims.delete(agentId);
  }

  claimOf(agentId: string): SlotClaim | undefined {
    return this.claims.get(agentId);
  }

  private overflowCount(platformId: string): number {
    return (this.slots.get(platformId) ?? []).filter((entry) => entry.key.includes(':overflow')).length;
  }

  /** Extra standing room on the platform rim, spread so nobody overlaps. */
  private overflowSlot(platformId: string, index: number, kind: SlotKind): SlotEntry {
    const platform = this.platform(platformId);
    const y = platform ? levelY(platform.level) : 0;
    const [width, depth] = platform?.size ?? [6, 6];
    // A spiral, not a ring: on a busy zone a fixed radius stacks everyone on
    // top of each other. Golden angle keeps successive rings out of phase.
    const angle = index * 2.399963;
    const limit = Math.min(width, depth) / 2 - 0.6;
    const radius = Math.min(limit, 0.9 + Math.sqrt(index + 1) * 0.7);

    return {
      key: `${platformId}:overflow:${index}`,
      platformId,
      kind,
      position: [
        (platform?.position[0] ?? 0) + Math.cos(angle) * radius,
        y,
        (platform?.position[1] ?? 0) + Math.sin(angle) * radius,
      ],
      facing: angle + Math.PI,
      occupant: null,
    };
  }

  private platform(platformId: string): Platform | undefined {
    return this.campus.platforms.find((candidate) => candidate.id === platformId);
  }
}

function nearest(entries: SlotEntry[], point: Vec3): SlotEntry | undefined {
  let best: SlotEntry | undefined;
  let bestDistance = Infinity;
  for (const entry of entries) {
    const distance = Math.hypot(entry.position[0] - point[0], entry.position[2] - point[2]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry;
    }
  }
  return best;
}
