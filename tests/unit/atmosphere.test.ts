import { describe, expect, it } from 'vitest';
import {
  ATMOSPHERE,
  CLOUD_STRIDE,
  atmosphereTones,
  birdPresence,
  cloudField,
  cloudPresence,
  createFlock,
  flockAt,
  starPresence,
  twinkle,
} from '@renderer/office/scene/skyLayers';
import { OFFICE_THEMES, resolveTheme } from '@renderer/office/theme/themes';

const SEED = ATMOSPHERE.seed;
const ASPECT = 16 / 9;
const CLOUDS = ATMOSPHERE.cloud.far + ATMOSPHERE.cloud.near;

function field(time: number, seed = SEED, drift = 0): Float32Array {
  const out = new Float32Array(CLOUDS * CLOUD_STRIDE);
  cloudField(time, seed, ASPECT, drift, out);
  return out;
}

/** [x, y, scale, alpha] for one cloud. */
function cloud(out: Float32Array, index: number): [number, number, number, number] {
  const base = index * CLOUD_STRIDE;
  return [out[base]!, out[base + 1]!, out[base + 2]!, out[base + 3]!];
}

describe('day and night drive everything', () => {
  it('shows clouds by day and all but hides them at night', () => {
    expect(cloudPresence(1)).toBe(1);
    expect(cloudPresence(0)).toBeCloseTo(ATMOSPHERE.cloud.nightFloor, 5);
    // Nothing switches: the whole ramp is monotone.
    for (let d = 0; d < 1; d += 0.05) expect(cloudPresence(d + 0.05)).toBeGreaterThan(cloudPresence(d));
  });

  it('lights the stars only after dark', () => {
    expect(starPresence(0)).toBeCloseTo(1, 5);
    expect(starPresence(1)).toBe(0);
    // Gone before the sky is anywhere near bright, and still strong at dusk.
    expect(starPresence(ATMOSPHERE.star.fadeBy)).toBe(0);
    expect(starPresence(0.25)).toBeGreaterThan(0.5);
    for (let d = 0; d < 1; d += 0.05) expect(starPresence(d + 0.05)).toBeLessThanOrEqual(starPresence(d));
  });

  it('flies the birds at dawn and dusk, never at midnight', () => {
    expect(birdPresence(0)).toBe(0);
    const dusk = birdPresence(0.5);
    expect(dusk).toBeGreaterThan(birdPresence(1));
    expect(dusk).toBeGreaterThan(birdPresence(0.1));
    expect(birdPresence(1)).toBeGreaterThan(0.2); // noon keeps a few
  });

});

describe('cloud placement', () => {
  it('keeps every cloud above the office and inside the frame', () => {
    const span = ASPECT + ATMOSPHERE.cloud.margin * 2;
    for (let t = 0; t < 4000; t += 37) {
      const out = field(t);
      for (let i = 0; i < CLOUDS; i++) {
        const [x, y, r, a] = cloud(out, i);
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
        expect(Math.abs(x)).toBeLessThanOrEqual(span / 2 + 1e-6);
        // The lowest a cloud reaches: its flat base, plus the edge feather.
        expect(y - r * 0.34).toBeGreaterThan(ATMOSPHERE.cloud.guard.lo);
        expect(a).toBeGreaterThan(0);
        expect(a).toBeLessThanOrEqual(ATMOSPHERE.cloud.alphaNear);
      }
    }
  });

  it('drifts slowly enough to take minutes to cross', () => {
    const start = field(0);
    const later = field(60);
    const moved = cloud(later, CLOUDS - 1)[0] - cloud(start, CLOUDS - 1)[0];
    expect(moved).toBeCloseTo(ATMOSPHERE.cloud.driftNear * 60, 5);
    // A near cloud needs three minutes or more to cross a 16:9 frame.
    expect(ASPECT / ATMOSPHERE.cloud.driftNear).toBeGreaterThan(180);
    expect(ATMOSPHERE.cloud.driftFar).toBeLessThan(ATMOSPHERE.cloud.driftNear);
  });

  it('never lets two clouds on a layer drift into each other', () => {
    // Same layer, same distance, same speed — so the ring of gaps between them
    // is fixed for good. Only which cloud is leftmost changes, as they wrap.
    const span = ASPECT + ATMOSPHERE.cloud.margin * 2;
    const gaps = (time: number): number[] => {
      const out = field(time);
      const xs: number[] = [];
      for (let i = ATMOSPHERE.cloud.far; i < CLOUDS; i++) xs.push(cloud(out, i)[0]);
      xs.sort((a, b) => a - b);
      const ring = xs.slice(1).map((x, i) => x - xs[i]!);
      ring.push(xs[0]! + span - xs[xs.length - 1]!);
      return ring.sort((a, b) => a - b);
    };
    const a = gaps(0);
    const b = gaps(9_000);
    expect(Math.min(...a)).toBeGreaterThan(0.1); // and never on top of each other
    for (let i = 0; i < a.length; i++) expect(b[i]!).toBeCloseTo(a[i]!, 4);
  });

  it('wraps cleanly rather than drifting out of precision', () => {
    const out = field(60 * 60 * 24); // a day of drift
    for (let i = 0; i < CLOUDS; i++) {
      expect(Number.isFinite(cloud(out, i)[0])).toBe(true);
      expect(Math.abs(cloud(out, i)[0])).toBeLessThan(ASPECT);
    }
  });

  it('is the same sky for the same seed, and a different one otherwise', () => {
    expect([...field(120)]).toEqual([...field(120)]);
    expect([...field(120)]).not.toEqual([...field(120, SEED + 1)]);
  });

  it('answers the camera without breaking the wrap', () => {
    const still = cloud(field(120), CLOUDS - 1)[0];
    const turned = cloud(field(120, SEED, ATMOSPHERE.parallax), CLOUDS - 1)[0];
    expect(turned - still).toBeCloseTo(ATMOSPHERE.parallax, 5);
    // A quarter turn must be a nudge, not a sweep.
    expect(ATMOSPHERE.parallax).toBeLessThan(0.1);
  });
});


describe('flocks', () => {
  it('comes past about once every minute or two', () => {
    const flock = createFlock();
    const starts: number[] = [];
    let flying = false;
    for (let t = 0; t < 7200; t += 0.5) {
      const active = flockAt(t, SEED, ASPECT, flock).active;
      if (active && !flying) starts.push(t);
      flying = active;
    }
    expect(starts.length).toBeGreaterThan(20);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(mean).toBeGreaterThan(60);
    expect(mean).toBeLessThan(200);
    // And the sky is empty far more often than not.
    let flown = 0;
    for (let t = 0; t < 7200; t += 0.5) if (flockAt(t, SEED, ASPECT, flock).active) flown++;
    expect(flown / (7200 / 0.5)).toBeLessThan(0.4);
  });

  it('crosses in one direction, high up, fading in and out at the edges', () => {
    const flock = createFlock();
    let found = false;
    for (let slot = 0; slot < 200 && !found; slot++) {
      const path: { x: number; y: number; fade: number; direction: number }[] = [];
      for (let t = slot * ATMOSPHERE.bird.period; t < (slot + 1) * ATMOSPHERE.bird.period; t += 0.25) {
        flockAt(t, SEED, ASPECT, flock);
        if (flock.active) path.push({ ...flock });
      }
      if (path.length < 20) continue;
      found = true;

      const direction = path[0]!.direction;
      for (let i = 1; i < path.length; i++) {
        expect(Math.sign(path[i]!.x - path[i - 1]!.x)).toBe(direction);
        expect(path[i]!.direction).toBe(direction);
        // Never anywhere near the office.
        expect(path[i]!.y).toBeGreaterThan(ATMOSPHERE.bird.band.lo - 0.05);
        expect(path[i]!.y).toBeLessThan(ATMOSPHERE.bird.band.hi + 0.05);
      }
      expect(path[0]!.fade).toBeLessThan(0.1);
      expect(path[path.length - 1]!.fade).toBeLessThan(0.1);
      expect(Math.max(...path.map((p) => p.fade))).toBeCloseTo(1, 2);
      // It starts and ends off-frame, so nobody sees a bird appear.
      expect(Math.abs(path[0]!.x)).toBeGreaterThan(ASPECT / 2);
      expect(Math.abs(path[path.length - 1]!.x)).toBeGreaterThan(ASPECT / 2);
    }
    expect(found).toBe(true);
  });

  it('leaves the sky quiet where reduced motion freezes it', () => {
    const flock = createFlock();
    expect(flockAt(ATMOSPHERE.startTime, SEED, ASPECT, flock).active).toBe(false);
  });

  it('is the same flock for the same seed', () => {
    const a = flockAt(900, SEED, ASPECT, createFlock());
    const b = flockAt(900, SEED, ASPECT, createFlock());
    expect(a).toEqual(b);
  });
});

describe('twinkle', () => {
  it('breathes gently and never goes dark', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < 60; t += 0.1) {
      const v = twinkle(t, 1.3, 0.5, 1);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(hi).toBeCloseTo(1, 2);
    expect(lo).toBeCloseTo(1 - 2 * ATMOSPHERE.star.twinkle, 2);
    // A faint star barely twinkles at all; only the bright ones do.
    expect(1 - twinkle(0.5, 0, 1, 0)).toBeLessThan(1 - twinkle(0.5, 0, 1, 1));
  });
});

describe('tones', () => {
  const channels = (hex: string): [number, number, number] => {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const distance = (a: string, b: string): number => {
    const [ar, ag, ab] = channels(a);
    const [br, bg, bb] = channels(b);
    return Math.max(Math.abs(ar - br), Math.abs(ag - bg), Math.abs(ab - bb));
  };

  it('gives every theme a cloud you can see but would not notice', () => {
    for (const id of Object.keys(OFFICE_THEMES)) {
      for (const dayFactor of [0, 0.35, 0.7, 1]) {
        const theme = resolveTheme(id, dayFactor);
        const tones = atmosphereTones(theme);
        // The sky the clouds actually sit in, not the sky at the horizon.
        const where = `${id}@${dayFactor}`;
        const light = channels(tones.cloudLight);
        expect(light.every((c) => c >= 0 && c <= 255), where).toBe(true);
        // Far enough off the sky to read as a shape…
        const apart = distance(tones.cloudLight, theme.sky[2]);
        expect(apart, where).toBeGreaterThan(4);
        // …and never so far that it competes with the office.
        expect(distance(tones.cloudLight, tones.cloudDark), where).toBeLessThan(60);
      }
    }
  });

  it('prints the flat theme rather than lighting it', () => {
    const ink = resolveTheme('ink', 1);
    const tones = atmosphereTones(ink);
    // Ink & Paper has one sky colour, so a cloud that borrowed it would vanish.
    expect(tones.cloudLight).not.toBe(ink.sky[1]);
    expect(distance(tones.cloudLight, ink.sky[1])).toBeGreaterThan(4);
    // Its birds are ink on paper, not a tone from a gradient it does not have.
    expect(distance(tones.bird, ink.sky[1])).toBeGreaterThan(40);
  });

  it('keeps stars near white in every palette', () => {
    for (const id of Object.keys(OFFICE_THEMES)) {
      const tones = atmosphereTones(resolveTheme(id, 0));
      expect(Math.min(...channels(tones.star))).toBeGreaterThan(140);
    }
  });
});
