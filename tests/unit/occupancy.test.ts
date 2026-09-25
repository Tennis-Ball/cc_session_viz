import { describe, expect, it } from 'vitest';
import { BoxGeometry } from 'three';
import { buildOccupancy } from '@renderer/office/world/occupancy';
import { buildCampus, type DeskRequest, type Platform } from '@renderer/office/world/layout';
import { buildPropFor, propPalette } from '@renderer/office/props/registry';
import { NavGraph } from '@renderer/office/world/navGraph';
import { resolveTheme } from '@renderer/office/theme/themes';
import { levelY } from '@renderer/office/world/campusTemplate';
import type { Occupancy } from '@renderer/office/world/occupancy';

const THEME = resolveTheme('monument', 1);

function desks(count: number): DeskRequest[] {
  return Array.from({ length: count }, (_, i) => ({ id: `s${i}`, label: `s${i}`, colorIndex: i, seats: 1 }));
}

/** A platform with one solid block standing in the middle of it. */
function blockedPlatform(): { platform: Platform; grid: Occupancy } {
  const platform: Platform = {
    id: 'test',
    kind: 'zone',
    cell: { col: 0, row: 0, cols: 3, rows: 3 },
    position: [6, 6],
    level: 0,
    stone: 0,
    size: [12, 12],
    label: 'Test',
  };
  // A 4x4 block, one unit tall, centred on the platform.
  const geometry = new BoxGeometry(4, 1, 4).translate(0, 0.5, 0);
  return { platform, grid: buildOccupancy(platform, geometry) };
}

describe('occupancy', () => {
  it('knows what is furniture and what is floor', () => {
    const { platform, grid } = blockedPlatform();
    expect(grid.isFree(platform.position[0], platform.position[1])).toBe(false);
    expect(grid.isFree(platform.position[0] - 5, platform.position[1] - 5)).toBe(true);
  });

  it('pushes a standing spot out of the furniture it landed in', () => {
    const { platform, grid } = blockedPlatform();
    const [x, z] = grid.nearestFree(platform.position[0], platform.position[1]);
    expect(grid.isFree(x, z)).toBe(true);
    // Out, but not thrown across the room.
    expect(Math.hypot(x - platform.position[0], z - platform.position[1])).toBeLessThan(4.5);
  });

  it('walks around a block rather than through it', () => {
    const { grid } = blockedPlatform();
    // Straight across would pass through the middle.
    const route = grid.route([1, 6], [11, 6]);
    expect(route.length).toBeGreaterThan(2);

    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1]!;
      const b = route[i]!;
      const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.2);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[1] + (b[1] - a[1]) * t;
        expect(grid.isFree(x, z), `route passes through furniture at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBe(true);
      }
    }
  });

  it('goes straight when nothing is in the way', () => {
    const { grid } = blockedPlatform();
    expect(grid.route([1, 1], [1, 11])).toHaveLength(2);
  });

  it('keeps every real route clear of the real furniture', () => {
    const campus = buildCampus(desks(6));
    const doorways = new Map<string, [number, number][]>();
    for (const connector of campus.connectors) {
      doorways.set(connector.from, [...(doorways.get(connector.from) ?? []), [connector.a[0], connector.a[2]]]);
      doorways.set(connector.to, [...(doorways.get(connector.to) ?? []), [connector.b[0], connector.b[2]]]);
    }
    const grids = new Map<string, Occupancy>();
    for (const platform of campus.platforms) {
      const prop = buildPropFor(platform, propPalette(THEME, platform));
      grids.set(platform.id, buildOccupancy(platform, prop?.geometry ?? null, doorways.get(platform.id) ?? []));
    }
    const nav = new NavGraph(campus, grids);

    // Every zone to every other zone: the routes figures actually take.
    const zones = campus.platforms.filter((p) => p.kind === 'zone');
    for (const from of zones) {
      for (const to of zones) {
        if (from.id === to.id) continue;
        const start = nav.standable(from.id, [from.position[0], levelY(from.level), from.position[1]]);
        const end = nav.standable(to.id, [to.position[0], levelY(to.level), to.position[1]]);
        const route = nav.path(from.id, start, to.id, end);
        expect(route.length, `${from.id} → ${to.id}`).toBeGreaterThan(1);

        // Wherever a leg sits squarely on one platform, it must stay walkable.
        for (let i = 1; i < route.length; i++) {
          const a = route[i - 1]!;
          const b = route[i]!;
          if (Math.abs(a[1] - b[1]) > 0.01) continue; // a staircase, not a floor
          const platform = campus.platforms.find(
            (p) =>
              Math.abs(a[1] - levelY(p.level)) < 0.01 &&
              inside(p, a[0], a[2]) &&
              inside(p, b[0], b[2]),
          );
          if (!platform) continue;
          const grid = grids.get(platform.id)!;
          const steps = Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / 0.25);
          for (let s = 1; s < steps; s++) {
            const t = s / steps;
            const x = a[0] + (b[0] - a[0]) * t;
            const z = a[2] + (b[2] - a[2]) * t;
            expect(grid.isFree(x, z), `${from.id} → ${to.id} clips ${platform.id} at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBe(
              true,
            );
          }
        }
      }
    }
  });
  it('leaves a way from every door to every seat on every platform', () => {
    const campus = buildCampus(desks(8));
    const doorways = new Map<string, [number, number][]>();
    for (const connector of campus.connectors) {
      doorways.set(connector.from, [...(doorways.get(connector.from) ?? []), [connector.a[0], connector.a[2]]]);
      doorways.set(connector.to, [...(doorways.get(connector.to) ?? []), [connector.b[0], connector.b[2]]]);
    }

    for (const platform of campus.platforms) {
      const prop = buildPropFor(platform, propPalette(THEME, platform));
      const doors = doorways.get(platform.id) ?? [];
      const grid = buildOccupancy(platform, prop?.geometry ?? null, doors);

      // Anywhere a figure might need to be: the doors, and every anchor the
      // prop publishes.
      const spots: [number, number][] = [
        ...doors,
        ...(prop?.slots ?? []).map(
          (slot) => [platform.position[0] + slot.position[0], platform.position[1] + slot.position[2]] as [number, number],
        ),
      ].map(([x, z]) => grid.nearestFree(x, z));

      for (const from of spots) {
        for (const to of spots) {
          const route = grid.route(from, to);
          for (let i = 1; i < route.length; i++) {
            const a = route[i - 1]!;
            const b = route[i]!;
            const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.15));
            for (let s = 0; s <= steps; s++) {
              const t = s / steps;
              const x = a[0] + (b[0] - a[0]) * t;
              const z = a[1] + (b[1] - a[1]) * t;
              expect(
                grid.isFree(x, z),
                `${platform.id}: ${from.map((v) => v.toFixed(1))} → ${to.map((v) => v.toFixed(1))} clips at ${x.toFixed(2)}, ${z.toFixed(2)} (leg ${a.map((v) => v.toFixed(1))} → ${b.map((v) => v.toFixed(1))})`,
              ).toBe(true);
            }
          }
        }
      }
    }
  });
});

function inside(platform: Platform, x: number, z: number): boolean {
  return (
    Math.abs(x - platform.position[0]) <= platform.size[0] / 2 &&
    Math.abs(z - platform.position[1]) <= platform.size[1] / 2
  );
}
