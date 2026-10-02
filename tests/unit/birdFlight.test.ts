import { describe, expect, it } from 'vitest';
import { rng } from '@shared/rand';
import {
  FLIGHT,
  angleTo,
  createBird,
  flockSize,
  shoo,
  stepBird,
  type Bird,
  type FlightContext,
  type Perch,
  type Threat,
} from '@renderer/office/anim/birdFlight';

function perches(n: number): Perch[] {
  // A ring of towers, which is roughly what a campus offers.
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    at: [Math.cos((i / n) * Math.PI * 2) * 14, 3 + (i % 3) * 1.4, Math.sin((i / n) * Math.PI * 2) * 14] as [
      number,
      number,
      number,
    ],
  }));
}

function context(over: Partial<FlightContext> = {}): FlightContext {
  return { perches: perches(8), threats: [], grounded: false, alarmAt: null, alarmAgeMs: 0, ...over };
}

function fly(bird: Bird, seconds: number, ctx: FlightContext, dt = 1 / 60): void {
  for (let t = 0; t < seconds; t += dt) stepBird(bird, dt, ctx);
}

describe('the flock', () => {
  it('leaves most perches empty', () => {
    expect(flockSize(2)).toBe(0);
    for (const n of [3, 6, 12, 30, 80]) {
      // Empty perches are what make the occupied ones read as chosen.
      expect(flockSize(n)).toBeLessThan(n);
      expect(flockSize(n)).toBeLessThanOrEqual(FLIGHT.maxBirds);
    }
  });

  it('starts every bird on a perch, staggered', () => {
    const ring = perches(8);
    const birds = Array.from({ length: 5 }, (_, i) => createBird(ring, i, rng(i + 1)));
    for (const bird of birds) {
      expect(bird.phase).toBe('perched');
      expect(ring[bird.perch]!.at).toEqual(bird.at);
    }
    // No two of them get restless on the same second.
    const waits = birds.map((b) => Math.round(b.patience));
    expect(new Set(waits).size).toBe(waits.length);
  });
});

describe('sitting still', () => {
  it('stays put until its patience runs out', () => {
    const ring = perches(8);
    const bird = createBird(ring, 0, rng(7));
    const at = [...bird.at];
    fly(bird, Math.max(0, bird.patience - 1), context({ perches: ring }));
    expect(bird.phase).toBe('perched');
    expect(bird.at).toEqual(at);
    expect(bird.speed).toBe(0);
  });

  it('looks at somebody before it decides about them', () => {
    const ring = perches(8);
    const bird = createBird(ring, 0, rng(7));
    bird.patience = 1e6;
    // Inside the notice ring, outside the spook ring: the interesting gap.
    const between = (FLIGHT.notice + FLIGHT.spook) / 2;
    const threat: Threat = { at: [bird.at[0] + between, bird.at[1], bird.at[2]], npc: false };
    fly(bird, 0.5, context({ perches: ring, threats: [threat] }));

    expect(bird.phase).toBe('alert');
    // Still on its perch, and turned toward whatever it is.
    expect(bird.at[1]).toBeCloseTo(ring[bird.perch]!.at[1], 6);
    expect(Math.abs(angleTo(bird.heading, Math.PI / 2))).toBeLessThan(0.6);
  });

  it('goes when the figure keeps coming', () => {
    const ring = perches(8);
    const bird = createBird(ring, 0, rng(7));
    bird.patience = 1e6;
    const threat: Threat = { at: [bird.at[0] + FLIGHT.spook * 0.5, bird.at[1], bird.at[2]], npc: false };
    fly(bird, 0.2, context({ perches: ring, threats: [threat] }));
    expect(bird.phase).not.toBe('perched');
    expect(bird.phase).not.toBe('alert');
  });

  it('ignores somebody on the floor below', () => {
    const ring = perches(8);
    const bird = createBird(ring, 0, rng(7));
    bird.patience = 1e6;
    // Right underneath, and a long way down: not walking up to it.
    const threat: Threat = { at: [bird.at[0], bird.at[1] - FLIGHT.reach - 3, bird.at[2]], npc: false };
    fly(bird, 2, context({ perches: ring, threats: [threat] }));
    expect(bird.phase).toBe('perched');
  });

  it('gives an NPC a longer reach than an agent', () => {
    const ring = perches(8);
    const shooed = (npc: boolean): boolean => {
      const bird = createBird(ring, 0, rng(7));
      bird.patience = 1e6;
      const between = (FLIGHT.spook + FLIGHT.shoo) / 2;
      const threat: Threat = { at: [bird.at[0] + between, bird.at[1], bird.at[2]], npc };
      fly(bird, 0.2, context({ perches: ring, threats: [threat] }));
      return bird.phase !== 'perched' && bird.phase !== 'alert';
    };
    // Shooing is deliberate, so it works from further out than simply walking by.
    expect(shooed(true)).toBe(true);
    expect(shooed(false)).toBe(false);
  });

  it('follows the rest of the flock up, after its own delay', () => {
    const ring = perches(8);
    const bird = createBird(ring, 0, rng(7));
    bird.patience = 1e6;
    const near: [number, number, number] = [bird.at[0] + 1, bird.at[1], bird.at[2]];

    // Too soon: it has not reacted yet.
    stepBird(bird, 1 / 60, context({ perches: ring, alarmAt: near, alarmAgeMs: 0 }));
    expect(bird.phase).toBe('perched');

    // And too far away is never news at all.
    const far: [number, number, number] = [bird.at[0] + FLIGHT.alarm * 3, bird.at[1], bird.at[2]];
    fly(bird, 0.3, context({ perches: ring, alarmAt: far, alarmAgeMs: bird.follows + 10 }));
    expect(bird.phase).toBe('perched');

    stepBird(bird, 1 / 60, context({ perches: ring, alarmAt: near, alarmAgeMs: bird.follows + 10 }));
    expect(bird.phase).toBe('launch');
  });
});

describe('flying', () => {
  it('climbs out, crosses, and lands on the perch it aimed at', () => {
    const ring = perches(8);
    const bird = createBird(ring, 0, rng(3));
    bird.patience = 0;
    const ctx = context({ perches: ring });

    const seen = new Set<string>();
    let landed: number | null = null;
    for (let t = 0; t < 40; t += 1 / 60) {
      const before = bird.target;
      stepBird(bird, 1 / 60, ctx);
      seen.add(bird.phase);
      if (bird.phase === 'perched' && before >= 0) {
        landed = before;
        break;
      }
    }

    expect(landed).not.toBeNull();
    // Every stage of it, in the one crossing.
    expect(seen).toContain('launch');
    expect(seen).toContain('cruise');
    expect(seen).toContain('approach');
    expect(seen).toContain('settle');
    // And down exactly on the spot, not near it.
    expect(bird.at).toEqual(ring[landed!]!.at);
    expect(bird.perch).toBe(landed);
  });

  it('climbs well above both perches before crossing', () => {
    const ring = perches(8);
    const bird = createBird(ring, 0, rng(3));
    bird.patience = 0;
    const ctx = context({ perches: ring });
    const start = bird.at[1];

    let top = start;
    for (let t = 0; t < 40; t += 1 / 60) {
      stepBird(bird, 1 / 60, ctx);
      top = Math.max(top, bird.at[1]);
      if (bird.phase === 'perched' && bird.since > 0.1) break;
    }
    expect(top).toBeGreaterThan(start + FLIGHT.cruiseLift[0] * 0.6);
  });

  it('banks into its turns and holds level when it is not turning', () => {
    const ring = perches(8);
    const bird = createBird(ring, 0, rng(11));
    bird.patience = 0;
    const ctx = context({ perches: ring });
    fly(bird, 0.1, ctx);

    // A hard turn demanded of it: point it the wrong way and let it steer.
    bird.phase = 'cruise';
    bird.heading += Math.PI * 0.8;
    let banked = 0;
    for (let t = 0; t < 1; t += 1 / 60) {
      stepBird(bird, 1 / 60, ctx);
      banked = Math.max(banked, Math.abs(bird.roll));
    }
    // The bank is the whole reason this reads as flight rather than as a
    // cursor sliding between two points.
    expect(banked).toBeGreaterThan(0.25);
    expect(banked).toBeLessThanOrEqual(FLIGHT.rollMax + 1e-6);
  });

  it('never flaps flat out the whole way across', () => {
    const ring = perches(8);
    const bird = createBird(ring, 0, rng(5));
    bird.patience = 0;
    const ctx = context({ perches: ring });

    let glided = 0;
    let beat = 0;
    const dt = 1 / 60;
    for (let t = 0; t < 30; t += dt) {
      stepBird(bird, dt, ctx);
      if (bird.phase === 'cruise') {
        if (bird.power < 0.25) glided += dt;
        else beat += dt;
      }
    }
    // The glide is the elegant half: it is the only moment the silhouette is
    // still. A bird that beats steadily is a toy.
    expect(glided).toBeGreaterThan(0.3);
    expect(beat).toBeGreaterThan(0.1);
  });

  it('circles rather than landing while it is raining', () => {
    const ring = perches(8);
    const bird = createBird(ring, 0, rng(9));
    bird.patience = 0;
    const ctx = context({ perches: ring, grounded: true });
    fly(bird, 40, ctx);
    // Nothing settles in a shower, and nothing flies off the edge of the world
    // either: a bird with nowhere in mind turns.
    expect(bird.phase).not.toBe('perched');
    expect(Math.hypot(bird.at[0], bird.at[2])).toBeLessThan(120);
  });

  it('stays finite and inside the world for a long run', () => {
    const ring = perches(8);
    const birds = Array.from({ length: 6 }, (_, i) => {
      const bird = createBird(ring, i, rng(i * 31 + 1));
      bird.patience = i * 0.4;
      return bird;
    });
    const ctx = context({ perches: ring });
    for (let t = 0; t < 600; t += 1 / 30) {
      for (const bird of birds) stepBird(bird, 1 / 30, ctx);
    }
    for (const bird of birds) {
      for (const v of [...bird.at, bird.heading, bird.roll, bird.pitch, bird.speed, bird.power]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(Math.hypot(bird.at[0], bird.at[2])).toBeLessThan(200);
      expect(Math.abs(bird.roll)).toBeLessThanOrEqual(FLIGHT.rollMax + 1e-6);
    }
  });

  it('is the same flight for the same seed', () => {
    const ring = perches(8);
    const run = (): number[] => {
      const bird = createBird(ring, 0, rng(4242));
      bird.patience = 0;
      const ctx = context({ perches: ring });
      const trace: number[] = [];
      for (let t = 0; t < 12; t += 1 / 60) {
        stepBird(bird, 1 / 60, ctx);
        trace.push(bird.at[0], bird.at[1], bird.at[2], bird.roll);
      }
      return trace;
    };
    expect(run()).toEqual(run());
  });
});

describe('angleTo', () => {
  it('always takes the short way round', () => {
    expect(angleTo(0, 0.5)).toBeCloseTo(0.5, 9);
    expect(angleTo(0.5, 0)).toBeCloseTo(-0.5, 9);
    // The whole point: across the seam, not the long way about.
    expect(angleTo(Math.PI * 0.95, -Math.PI * 0.95)).toBeCloseTo(Math.PI * 0.1, 6);
    expect(angleTo(-Math.PI * 0.95, Math.PI * 0.95)).toBeCloseTo(-Math.PI * 0.1, 6);
    for (let a = -7; a < 7; a += 0.31) {
      for (let b = -7; b < 7; b += 0.29) {
        expect(Math.abs(angleTo(a, b))).toBeLessThanOrEqual(Math.PI + 1e-9);
      }
    }
  });
});

describe('shooing a bird by hand', () => {
  /** A bird settled on a perch, which is the only state worth clicking. */
  function settled(): { bird: Bird; ctx: FlightContext } {
    const ctx = context();
    const bird = createBird(ctx.perches, 0, rng(12));
    for (let i = 0; i < 400 && bird.phase !== 'perched'; i += 1) stepBird(bird, 1 / 30, ctx);
    expect(bird.phase).toBe('perched');
    return { bird, ctx };
  }

  it('puts a perched bird back up', () => {
    const { bird, ctx } = settled();
    expect(shoo(bird, ctx.perches)).toBe(true);
    expect(bird.phase).toBe('launch');
  });

  it('takes a bird that has already noticed you', () => {
    const { bird, ctx } = settled();
    bird.phase = 'alert';
    expect(shoo(bird, ctx.perches)).toBe(true);
    expect(bird.phase).toBe('launch');
  });

  it('does nothing to one that is already flying, and says so', () => {
    const { bird, ctx } = settled();
    shoo(bird, ctx.perches);
    fly(bird, 3, ctx);
    const was = bird.phase;
    expect(shoo(bird, ctx.perches)).toBe(false);
    expect(bird.phase).toBe(was);
  });

  it('sends it somewhere else, not back where it was', () => {
    const { bird, ctx } = settled();
    const from = bird.perch;
    shoo(bird, ctx.perches);
    // It flies a while and lands again; the point of shooing it is that it goes.
    fly(bird, 40, ctx);
    expect(bird.perch).not.toBe(from);
  });
});
