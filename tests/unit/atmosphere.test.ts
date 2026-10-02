import { describe, expect, it } from 'vitest';
import {
  ATMOSPHERE,
  CIRRUS,
  CLOUD_STRIDE,
  CUMULUS,
  SHAPE_STRIDE,
  STRATUS,
  createFlash,
  flashAt,
  horizonTones,
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

/**
 * How far a cloud moved, across the wrap.
 *
 * Lanes are spaced by the slot count, so which cloud happens to be mid-wrap at
 * a given second is an accident of how many slots there are — and a test that
 * reads one cloud's raw x twice is really testing that. The shortest signed
 * distance on the ring is what "moved" means here.
 */
function moved(before: Float32Array, after: Float32Array, index: number): number {
  const span = ASPECT + ATMOSPHERE.cloud.margin * 2;
  const d = (cloud(after, index)[0] - cloud(before, index)[0] + span * 1.5) % span;
  return d - span / 2;
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
        // A slot the weather has left empty still holds a real position: the
        // placement is the invariant, and a cloud that jumped somewhere new on
        // fading in would pop rather than gather.
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(ATMOSPHERE.cloud.alphaNear * ATMOSPHERE.cloud.weather['rain']!.alpha);
      }
    }
  });

  it('empties most of a clear sky and fills a covered one', () => {
    const drawn = (weather: string): number => {
      const out = new Float32Array(CLOUDS * CLOUD_STRIDE);
      cloudField(0, SEED, ASPECT, 0, out, undefined, weather);
      let n = 0;
      for (let i = 0; i < CLOUDS; i++) if (cloud(out, i)[3] > 0) n += 1;
      return n;
    };
    // The point of the whole exercise: a grey day is more shapes, not the same
    // shapes turned up, which is what made overcast read as haze.
    expect(drawn('clear')).toBeLessThan(drawn('cloudy'));
    expect(drawn('cloudy')).toBe(CLOUDS);
    expect(drawn('clear')).toBeGreaterThan(2);
  });

  it('gives rain a lid, and a cloudy day puffs and wisps like a clear one', () => {
    const kinds = (weather: string): Set<number> => {
      const out = new Float32Array(CLOUDS * CLOUD_STRIDE);
      const shape = new Float32Array(CLOUDS * SHAPE_STRIDE);
      cloudField(0, SEED, ASPECT, 0, out, shape, weather);
      const seen = new Set<number>();
      for (let i = 0; i < CLOUDS; i++) if (cloud(out, i)[3] > 0) seen.add(shape[i * SHAPE_STRIDE]!);
      return seen;
    };
    expect(kinds('clear')).toContain(CUMULUS);
    expect(kinds('clear')).toContain(CIRRUS);
    // A cloudy day is a *busy* sky, not a dim one: the same bright shapes as a
    // clear one, more of them and bigger. Only rain gets the lid, and nothing
    // wispy goes in front of a lid.
    expect(kinds('cloudy')).toContain(CUMULUS);
    expect(kinds('cloudy')).not.toContain(STRATUS);
    expect(kinds('rain')).toEqual(new Set([STRATUS]));
  });

  it('keeps the grey for the rain', () => {
    // Giving a cloudy day any grey at all made it read as a dirty version of
    // clear rather than as a different day.
    expect(ATMOSPHERE.cloud.weather['cloudy']!.grey).toBe(0);
    expect(ATMOSPHERE.cloud.weather['rain']!.grey).toBeGreaterThan(0.5);
    // And makes it bigger instead, which is where its weight comes from.
    expect(ATMOSPHERE.cloud.weather['cloudy']!.size).toBeGreaterThan(
      ATMOSPHERE.cloud.weather['clear']!.size,
    );
  });

  it('keeps every weather clear of the guard', () => {
    // The one rule the weather is not allowed to bend. A sheet that reaches
    // down into the fade comes out half-dissolved, which is the haze the whole
    // exercise was meant to stop being.
    for (const weather of ['clear', 'cloudy', 'rain']) {
      for (let t = 0; t < 2000; t += 53) {
        const out = new Float32Array(CLOUDS * CLOUD_STRIDE);
        cloudField(t, SEED, ASPECT, 0, out, undefined, weather);
        for (let i = 0; i < CLOUDS; i++) {
          const [, y, r] = cloud(out, i);
          expect(y - r * 0.34).toBeGreaterThan(ATMOSPHERE.cloud.guard.lo);
        }
      }
    }
  });

  it('drifts slowly enough to take minutes to cross', () => {
    const start = field(0);
    const later = field(60);
    expect(moved(start, later, CLOUDS - 1)).toBeCloseTo(ATMOSPHERE.cloud.driftNear * 60, 5);
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
    const still = field(120);
    const turned = field(120, SEED, ATMOSPHERE.parallax);
    expect(moved(still, turned, CLOUDS - 1)).toBeCloseTo(ATMOSPHERE.parallax, 5);
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

describe('sheet lightning', () => {
  it('flashes often enough to be seen and rarely enough to ignore', () => {
    const out = createFlash();
    let lit = 0;
    let peak = 0;
    let strikes = 0;
    let was = false;
    const step = 0.02;
    const window = 600;
    for (let t = 0; t < window; t += step) {
      flashAt(t, SEED, ASPECT, out);
      const on = out.strength > 0.01;
      if (on) lit += step;
      if (on && !was) strikes += 1;
      was = on;
      peak = Math.max(peak, out.strength);
    }

    /*
     * Both ends, because only one of them was ever in danger.
     *
     * The first numbers put a strike on screen one and a half per cent of the
     * time, which is not "rare" — it is "never": a minute of watching a storm
     * produced nothing at all, and an effect nobody sees is an effect that was
     * not built. The ceiling is the easy half and the floor is the one that
     * was missing.
     */
    expect(strikes / (window / 60)).toBeGreaterThan(1.5); // more than one a minute
    expect(lit / window).toBeLessThan(0.06); // and under a sixteenth of the time
    // Bounded: the point of it is that you can look at the office while it
    // happens, which a full-frame white frame would not allow.
    expect(peak).toBeGreaterThan(0.2);
    expect(peak).toBeLessThanOrEqual(ATMOSPHERE.flash.strength);
  });

  it('strikes twice and dies away', () => {
    const out = createFlash();
    // Find a slot that fires, then walk the envelope inside it.
    let base = -1;
    for (let slot = 0; slot < 40 && base < 0; slot++) {
      for (let u = 0; u < 1; u += 0.01) {
        flashAt(slot * ATMOSPHERE.flash.period + u * ATMOSPHERE.flash.period, SEED, ASPECT, out);
        if (out.strength > 0.05) {
          base = slot * ATMOSPHERE.flash.period + u * ATMOSPHERE.flash.period;
          break;
        }
      }
    }
    expect(base).toBeGreaterThanOrEqual(0);

    const curve: number[] = [];
    for (let t = 0; t < ATMOSPHERE.flash.lasts; t += 0.01) {
      flashAt(base + t, SEED, ASPECT, out);
      curve.push(out.strength);
    }
    // Two rises: a hard leading edge and a weaker second stroke. That shape is
    // the whole of why it reads as lightning rather than as a light switch.
    let rises = 0;
    for (let i = 2; i < curve.length; i++) {
      if (curve[i]! > curve[i - 1]! && curve[i - 1]! <= curve[i - 2]!) rises += 1;
    }
    expect(rises).toBeGreaterThanOrEqual(1);
    expect(curve[curve.length - 1]!).toBeLessThan(curve[0]! * 0.5);
  });

  it('is the same storm for the same seed', () => {
    const a = createFlash();
    const b = createFlash();
    flashAt(217.5, SEED, ASPECT, a);
    flashAt(217.5, SEED, ASPECT, b);
    expect(a).toEqual(b);
  });
});

describe('the distance', () => {
  it('cuts the rock further off the sky than the deck above it', () => {
    for (const id of Object.keys(OFFICE_THEMES)) {
      for (const day of [0, 0.5, 1]) {
        const resolved = resolveTheme(id, day);
        const { near, far } = horizonTones(resolved);
        const horizon = resolved.sky[0];
        // Two tones is what makes a distant fragment read as a terrace on its
        // own rock rather than as one flat slab.
        expect(distance(near, horizon)).toBeGreaterThan(distance(far, horizon));
        // And both close enough to the sky to be scenery rather than an event.
        expect(distance(near, horizon)).toBeLessThan(0.36);
      }
    }
  });
});

/** Rough RGB distance, 0–1. Enough to ask "is this a shade off that". */
function distance(a: string, b: string): number {
  const rgb = (hex: string): number[] => {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return Math.hypot(ar! - br!, ag! - bg!, ab! - bb!) / 441.7;
}

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
