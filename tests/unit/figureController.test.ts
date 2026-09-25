import { describe, expect, it } from 'vitest';
import { ACTIVITY_ZONE, type Activity, type ZoneId } from '@shared/activity';
import { FigureController, type ZoneResolver } from '@renderer/office/anim/figureController';
import { buildCampus, type Campus, type DeskRequest } from '@renderer/office/world/layout';
import { NavGraph, type Vec3 } from '@renderer/office/world/navGraph';
import { SlotPool } from '@renderer/office/world/slots';
import { levelY } from '@renderer/office/world/campusTemplate';

function desks(ids: string[]): DeskRequest[] {
  return ids.map((id, i) => ({ id, label: id, colorIndex: i, seats: 1 }));
}

/**
 * The same wiring OfficeView uses, minus React: a figure asks for a zone, the
 * resolver turns it into a platform, a seat, and a route.
 */
function resolverFor(campus: Campus, deskOwner: string): ZoneResolver & { nav: NavGraph } {
  const nav = new NavGraph(campus);
  const slots = new SlotPool(campus, new Map());
  const find = (id: string): { platformId: string; position: Vec3 } | null => {
    const platform = campus.platforms.find((p) => p.id === id);
    if (!platform) return null;
    return { platformId: platform.id, position: [platform.position[0], levelY(platform.level), platform.position[1]] };
  };
  return {
    nav,
    platformFor: (zone: ZoneId) => find(zone === 'desk' ? `desk:${deskOwner}` : `zone:${zone}`),
    claimSlot: (agentId, platformId, kind, near) => slots.claim(agentId, platformId, kind, near),
    platformAt: (position) =>
      campus.platforms.find(
        (p) =>
          Math.abs(position[0] - p.position[0]) <= p.size[0] / 2 &&
          Math.abs(position[2] - p.position[1]) <= p.size[1] / 2 &&
          Math.abs(position[1] - levelY(p.level)) < 1.2,
      )?.id ?? nav.nearestPlatform(position),
    route: (fromPlatform, from, toPlatform, to) => {
      const origin = nav.has(fromPlatform) ? fromPlatform : (nav.nearestPlatform(from) ?? toPlatform);
      return nav.path(origin, from, toPlatform, to);
    },
  };
}

function spawn(resolver: ZoneResolver, id: string): FigureController {
  const home = resolver.platformFor('desk', id)!;
  const slot = resolver.claimSlot(id, home.platformId, 'deskSeat', home.position);
  return new FigureController(
    id,
    'main',
    1,
    { position: slot.position, platformId: home.platformId, zone: 'desk', facing: slot.facing, slot: 'deskSeat', seat: 0.5 },
    resolver,
    0,
  );
}

/** Walks a figure until it settles, with a cap so a stuck one fails the test. */
function settle(figure: FigureController, startedAt: number): number {
  let now = startedAt;
  for (let step = 0; step < 20000 && figure.phase !== 'standing'; step++) {
    now += 16;
    figure.update(0.016, now);
  }
  return now;
}

/** Runs the figure for a stretch of wall-clock with one activity in play. */
function run(figure: FigureController, from: number, seconds: number, activity: Activity): number {
  let now = from;
  const until = from + seconds * 1000;
  while (now < until) {
    now += 16;
    figure.setActivity(activity, now);
    figure.update(0.016, now);
  }
  return now;
}

describe('figure controller', () => {
  it('sits down at a desk and stands up to leave', () => {
    const campus = buildCampus(desks(['a']));
    const resolver = resolverFor(campus, 'a');
    const figure = spawn(resolver, 'agent');

    // Settled at its own desk, which is a seat.
    let now = settle(figure, 0);
    now = run(figure, now, 4, 'editing');
    expect(figure.pose().seated, 'an agent at its desk should be sitting').toBeGreaterThan(0.9);

    // Sent to the library, which is somewhere you stand. Catch it in transit:
    // a figure that slides across the office still seated is the bug here.
    now = run(figure, now, 20, 'reading');
    let sawWalking = false;
    for (let step = 0; step < 2000 && figure.phase !== 'standing'; step++) {
      now += 16;
      figure.setActivity('reading', now);
      figure.update(0.016, now);
      if (figure.phase === 'walking') {
        sawWalking = true;
        expect(figure.pose().seated, 'walking while seated').toBeLessThan(0.75);
      }
    }
    expect(sawWalking, 'the figure never actually walked anywhere').toBe(true);

    now = run(figure, now, 4, 'reading');
    expect(figure.pose().seated, 'a reading stand is not a chair').toBeLessThan(0.1);
  });

  it('materialises at a seat rather than the world origin', () => {
    const campus = buildCampus(desks(['a']));
    const resolver = resolverFor(campus, 'a');
    const figure = spawn(resolver, 'agent');

    const desk = campus.platforms.find((p) => p.id === 'desk:a')!;
    expect(Math.abs(figure.position[0] - desk.position[0])).toBeLessThanOrEqual(desk.size[0] / 2);
    expect(Math.abs(figure.position[2] - desk.position[1])).toBeLessThanOrEqual(desk.size[1] / 2);
  });

  it('ignores a brief errand but follows a real shift of work', () => {
    const campus = buildCampus(desks(['a']));
    const resolver = resolverFor(campus, 'a');
    const figure = spawn(resolver, 'agent');

    // Settled at its desk, writing.
    let now = run(figure, 0, 6, 'responding');
    expect(figure.currentZone).toBe('desk');

    // A one-second read in the middle of a writing session is not a journey.
    now = run(figure, now, 1, 'reading');
    now = run(figure, now, 1, 'responding');
    expect(figure.currentZone).toBe('desk');

    // Several seconds of reading is.
    now = run(figure, now, 6, 'reading');
    settle(figure, now);
    expect(figure.currentZone).toBe(ACTIVITY_ZONE.reading.zone);
    expect(figure.platform).toBe('zone:library');
  });

  it('drops everything when the session needs you', () => {
    const campus = buildCampus(desks(['a']));
    const resolver = resolverFor(campus, 'a');
    const figure = spawn(resolver, 'agent');
    const now = run(figure, 0, 6, 'responding');

    figure.setActivity('awaiting', now, true);
    expect(figure.currentZone).toBe(ACTIVITY_ZONE.awaiting.zone);
  });

  it('re-homes onto a platform that still exists when its desk is removed', () => {
    const before = buildCampus(desks(['a', 'b']));
    const resolver = resolverFor(before, 'a');
    const figure = spawn(resolver, 'agent');
    figure.update(0.016, 800);
    expect(figure.platform).toBe('desk:a');

    // Session "a" ends; the floor plan is rebuilt without its desk.
    const after = buildCampus(desks(['b']));
    expect(after.platforms.some((p) => p.id === 'desk:a')).toBe(false);

    const rebuilt = resolverFor(after, 'b');
    figure.rehome(rebuilt, 900);
    settle(figure, 900);

    expect(after.platforms.some((p) => p.id === figure.platform)).toBe(true);
  });

  it('routes over the walkways after a rebuild instead of across the void', () => {
    const campus = buildCampus(desks(['a']));
    const resolver = resolverFor(campus, 'a');

    // A figure carrying a platform id from an older campus.
    const figure = new FigureController(
      'agent',
      'main',
      1,
      { position: [0, 0, 2], platformId: 'desk:ghost', zone: null, facing: 0 },
      resolver,
      0,
    );
    figure.update(0.016, 800);
    const now = run(figure, 800, 6, 'browsing');

    expect(figure.platform).toBe('zone:observatory');
    settle(figure, now);
    expect(figure.phase).toBe('standing');
  });

  it('knows which platforms it still has', () => {
    const campus = buildCampus(desks(['a']));
    const nav = new NavGraph(campus);
    const library = campus.platforms.find((p) => p.id === 'zone:library')!;

    expect(nav.has('zone:library')).toBe(true);
    expect(nav.has('desk:gone')).toBe(false);
    expect(nav.nearestPlatform([library.position[0], levelY(library.level), library.position[1]])).toBe('zone:library');
  });
});
