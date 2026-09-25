import { describe, expect, it } from 'vitest';
import { buildCampus, type DeskRequest } from '@renderer/office/world/layout';
import { buildPropFor, propPalette } from '@renderer/office/props/registry';
import { SlotPool } from '@renderer/office/world/slots';
import { levelY } from '@renderer/office/world/campusTemplate';
import { resolveTheme } from '@renderer/office/theme/themes';
import type { PropSlot } from '@renderer/office/props/types';

const THEME = resolveTheme('monument', 1);

function desks(count: number): DeskRequest[] {
  return Array.from({ length: count }, (_, i) => ({ id: `s${i}`, label: `s${i}`, colorIndex: i, seats: 1 }));
}

describe('office slots', () => {
  it('never seats anybody off the edge of their own platform', () => {
    const campus = buildCampus(desks(8));
    for (const platform of campus.platforms) {
      const prop = buildPropFor(platform, propPalette(THEME, platform));
      if (!prop) continue;
      for (const slot of prop.slots) {
        expect(Math.abs(slot.position[0]), `${platform.id} ${slot.kind} x`).toBeLessThanOrEqual(platform.size[0] / 2);
        expect(Math.abs(slot.position[2]), `${platform.id} ${slot.kind} z`).toBeLessThanOrEqual(platform.size[1] / 2);
      }
    }
  });

  it('keeps overflow standing room on the platform too', () => {
    const campus = buildCampus(desks(4));
    const map = new Map<string, PropSlot[]>();
    for (const platform of campus.platforms) {
      const prop = buildPropFor(platform, propPalette(THEME, platform));
      if (prop) map.set(platform.id, prop.slots);
    }
    const pool = new SlotPool(campus, map);

    for (const platform of campus.platforms) {
      // Far more agents than the zone was designed for.
      for (let i = 0; i < 14; i++) {
        const claim = pool.claim(`${platform.id}:agent${i}`, platform.id, 'bench');
        expect(Math.abs(claim.position[0] - platform.position[0]), `${platform.id} #${i} x`).toBeLessThanOrEqual(
          platform.size[0] / 2,
        );
        expect(Math.abs(claim.position[2] - platform.position[1]), `${platform.id} #${i} z`).toBeLessThanOrEqual(
          platform.size[1] / 2,
        );
        // Prop slots can sit on a step or a deck; nobody stands below the floor.
        expect(claim.position[1]).toBeGreaterThanOrEqual(levelY(platform.level) - 0.01);
      }
    }
  });
});
