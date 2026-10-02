import { describe, expect, it } from 'vitest';
import { buildCampus, walkableRing, type DeskRequest, type Platform } from '@renderer/office/world/layout';

/**
 * What a raised deck is allowed to put a ceiling over.
 *
 * Terraces standing on terraces are the best thing in the office and they were
 * being placed by a rule that could not see the room underneath: four corners
 * were offered and the one nearest the middle of the campus won, which is
 * reliably the one directly over the furniture. The Commons table and half the
 * Library spent their lives under somebody's balcony.
 *
 * There is no placement that misses entirely — the furniture is two thirds of
 * the floor — so this measures rather than forbids, and holds the mean well
 * under what a square deck in the worst corner used to manage (about 65%).
 */

function desks(count: number): DeskRequest[] {
  return Array.from({ length: count }, (_, i) => ({ id: `s${i}`, label: `s${i}`, colorIndex: i, seats: 1 }));
}

const span = (centreA: number, sizeA: number, centreB: number, sizeB: number): number =>
  Math.max(0, Math.min(centreA + sizeA / 2, centreB + sizeB / 2) - Math.max(centreA - sizeA / 2, centreB - sizeB / 2));

function coverage(deck: Platform, host: Platform): number {
  const ring = walkableRing(host);
  const furniture: [number, number] = [host.size[0] - 2 * ring[0], host.size[1] - 2 * ring[1]];
  const area =
    span(host.position[0], furniture[0], deck.position[0], deck.size[0]) *
    span(host.position[1], furniture[1], deck.position[1], deck.size[1]);
  return area / (furniture[0] * furniture[1]);
}

function decks(seed: number): { deck: Platform; host: Platform }[] {
  const campus = buildCampus(desks(6), new Map(), seed, 'ornate');
  const byId = new Map(campus.platforms.map((platform) => [platform.id, platform]));
  const out: { deck: Platform; host: Platform }[] = [];
  for (const platform of campus.platforms) {
    const host = platform.over ? byId.get(platform.over) : undefined;
    if (host) out.push({ deck: platform, host });
  }
  return out;
}

describe('raised decks', () => {
  it('leaves most of the room below in the open', () => {
    let covered = 0;
    let count = 0;
    let worst = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      for (const { deck, host } of decks(seed)) {
        const share = coverage(deck, host);
        covered += share;
        worst = Math.max(worst, share);
        count += 1;
      }
    }

    expect(count).toBeGreaterThan(20);
    expect(covered / count).toBeLessThan(0.4);
    // And no single one is allowed to be the old worst case.
    expect(worst).toBeLessThan(0.55);
  });

  it('builds a gallery along one side rather than a slab across the room', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      for (const { deck, host } of decks(seed)) {
        // Shallower than its host in at least one axis, or it is a lid.
        const fits = deck.size[0] < host.size[0] - 0.01 && deck.size[1] < host.size[1] - 0.01;
        expect(fits, `${deck.id} on ${host.id} @ seed ${seed}`).toBe(true);
      }
    }
  });
});
