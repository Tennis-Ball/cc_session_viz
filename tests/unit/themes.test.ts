import { describe, expect, it } from 'vitest';
import { EMISSIVE_FLOOR, EMISSIVE_GAIN, facetUniforms, setVoidPlane } from '@renderer/office/material/facet';
import { OFFICE_THEMES, dayFactorFor, mixHex, resolveTheme } from '@renderer/office/theme/themes';
import { LEVEL_HEIGHT, PLATFORM_THICKNESS, levelY } from '@renderer/office/world/campusTemplate';
import { bedrockOf, lowestFloor } from '@renderer/office/world/architecture';
import { buildCampus } from '@renderer/office/world/layout';

/**
 * What the office actually looks like, in pixels.
 *
 * Palettes cannot be judged from their hexes. Two things stand between a hex
 * and the frame, and both of them bite hardest at night:
 *
 * The office multiplies. A face is its baked vertex color times its face tone,
 * in linear light, and two values that each look like a plausible night on
 * their own land on near-black together. Comparing `platform.top` against
 * `tones.right` as written says nothing about whether the platform will still
 * have a visible edge.
 *
 * The sky does not. It is drawn on its own quad, which writes its color
 * straight to the frame with no tone mapping and no encode, while everything
 * in the office is tone mapped on the way out. The same hex is about three
 * times brighter on a wall than it is in the sky, so "is the campus lighter
 * than the void" cannot be asked of the hexes either.
 *
 * So these tests reproduce both paths and measure the result. The reproduction
 * is a copy and a copy can drift — the tone map belongs to the renderer, and
 * nothing here can run GLSL. It is still worth having: it is the only thing
 * that fails when a palette stops being legible, and the screenshots in
 * artifacts/shots are what catch the copy going stale.
 */

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

type Rgb = [number, number, number];

function linearOf(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(srgbToLinear) as Rgb;
}

/**
 * ACES filmic, as three.js writes it — react-three-fiber turns it on for every
 * Canvas unless the Canvas asks to be flat, and this one does not.
 */
const ACES_IN = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
] as const;
const ACES_OUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
] as const;

function transform(m: readonly (readonly number[])[], v: Rgb): Rgb {
  return m.map((row) => row[0]! * v[0] + row[1]! * v[1] + row[2]! * v[2]) as Rgb;
}

function toneMap(linear: Rgb): Rgb {
  const scaled = linear.map((x) => x / 0.6) as Rgb;
  const fitted = transform(ACES_IN, scaled).map(
    (x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081),
  ) as Rgb;
  return transform(ACES_OUT, fitted).map((x) => Math.min(1, Math.max(0, x))) as Rgb;
}

const encode = (linear: Rgb): Rgb => linear.map((x) => Math.round(linearToSrgb(x) * 255)) as Rgb;

interface FaceOptions {
  /** 0 at the object's base, 1 at its top: what the base-darkening rides on. */
  grad?: number;
  gradient?: number;
  /** aEmissive × uNight, 0–1. */
  glow?: number;
}

/** One pixel of the office: a part's color, seen on a face pointing some way. */
function face(color: string, tone: string, options: FaceOptions = {}): Rgb {
  const { grad = 1, gradient = 0, glow = 0 } = options;
  const part = linearOf(color);
  const lit = linearOf(tone);
  let out = part.map((c, i) => c * lit[i]!) as Rgb;
  out = out.map((c) => c * (1 - gradient + gradient * grad)) as Rgb;
  if (glow > 0) {
    const emitted = part.map((c) => c * EMISSIVE_GAIN + EMISSIVE_FLOOR) as Rgb;
    out = out.map((c, i) => c + (emitted[i]! - c) * glow) as Rgb;
  }
  return encode(toneMap(out));
}

/** One pixel of the sky, which never meets the tone map or the encode. */
const sky = (hex: string): Rgb => linearOf(hex).map((x) => Math.round(x * 255)) as Rgb;

// ---------- perception ----------

/**
 * CIE Lab, so that two colors can be compared the way an eye compares them.
 *
 * Relative-luminance contrast is the wrong tool here twice over. It is blind
 * to hue, which is exactly what these night palettes lean on, and its 0.05
 * term swamps everything once the numbers get as small as a night sky, where
 * a black shape on a near-black sky and a legible one score about the same.
 */
const WHITE: Rgb = [0.95047, 1, 1.08883];
function lab(rgb: Rgb): Rgb {
  const [r, g, b] = rgb.map((x) => srgbToLinear(x / 255)) as Rgb;
  const xyz: Rgb = [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    0.0193339 * r + 0.119192 * g + 0.9503041 * b,
  ];
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = xyz.map((v, i) => f(v / WHITE[i]!));
  return [116 * fy! - 16, 500 * (fx! - fy!), 200 * (fy! - fz!)];
}

const difference = (a: Rgb, b: Rgb): number => {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};
const lightness = (rgb: Rgb): number => lab(rgb)[0];
const chroma = (rgb: Rgb): number => Math.hypot(lab(rgb)[1], lab(rgb)[2]);

const THEMES = Object.keys(OFFICE_THEMES);
const HOURS = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1];

/** The handful of pixels that decide whether the office can be read. */
function pixels(theme: ReturnType<typeof resolveTheme>) {
  const gradient = theme.gradient;
  const { tones, platform } = theme;
  return {
    /** Paving, and most of what is on screen. */
    floor: face(platform.top, tones.top, { gradient }),
    /** The same slab seen edge-on, which is what gives a platform thickness. */
    rimLeft: face(platform.top, tones.left, { grad: 0.15, gradient }),
    rimRight: face(platform.top, tones.right, { grad: 0.15, gradient }),
    /** A stair: paved tread over dark-stone riser. */
    tread: face(platform.top, tones.top, { grad: 0.9, gradient }),
    riser: face(platform.side, tones.right, { grad: 0.4, gradient }),
    /** A desk seen from the side, and the legs under it. */
    furniture: face(tones.top, tones.right, { grad: 0.7, gradient }),
    structure: face(platform.side, tones.top, { grad: 0.5, gradient }),
    /** Two figures far apart in the session palette, standing on the paving. */
    coral: face('#F2705A', tones.left, { grad: 0.5, gradient }),
    slate: face('#5B7183', tones.left, { grad: 0.5, gradient }),
    /** A zone's identity color on a whiteboard or a shelf back. */
    accent: face(theme.accent, tones.top, { grad: 0.9, gradient }),
    sky: sky(theme.sky[1]),
    horizon: sky(theme.sky[0]),
  };
}

/**
 * Every threshold below is a Lab difference, read off one scale: about 2.3 is
 * the least two flat patches can differ and still be told apart, 10 is a
 * difference nobody has to go looking for, and 25 is two colors no one would
 * call the same. Each one is then held a clear margin under what the palettes
 * actually manage, so they fail on a regression rather than on a nudge — and
 * the day halves have to clear them too, which is what keeps them honest.
 */
describe('the office reads at every hour', () => {
  for (const id of THEMES) {
    for (const dayFactor of HOURS) {
      const where = `${id} @ ${dayFactor}`;
      const theme = resolveTheme(id, dayFactor);
      const p = pixels(theme);
      const flat = theme.ink !== undefined;

      it(`tells a platform from the void — ${where}`, () => {
        expect(difference(p.floor, p.sky), where).toBeGreaterThan(14);
        expect(difference(p.floor, p.horizon), where).toBeGreaterThan(12);
      });

      it(`tells a stair from the platform it climbs — ${where}`, () => {
        expect(difference(p.tread, p.riser), where).toBeGreaterThan(30);
        expect(difference(p.structure, p.floor), where).toBeGreaterThan(15);
      });

      it(`tells a figure and a zone color from the floor — ${where}`, () => {
        expect(difference(p.coral, p.floor), where).toBeGreaterThan(25);
        expect(difference(p.slate, p.floor), where).toBeGreaterThan(25);
        expect(difference(p.accent, p.floor), where).toBeGreaterThan(20);
      });

      // Ink & Paper has one tone for every face on purpose, so it has no
      // shading to measure and no furniture silhouette to lose. It earns its
      // exemption in "the flat theme stays flat" below instead.
      if (flat) continue;

      it(`keeps the three faces of a box apart — ${where}`, () => {
        expect(difference(p.floor, p.rimRight), where).toBeGreaterThan(18);
        expect(difference(p.floor, p.rimLeft), where).toBeGreaterThan(12);
        expect(difference(p.rimLeft, p.rimRight), where).toBeGreaterThan(8);
      });

      it(`tells furniture from the floor under it — ${where}`, () => {
        expect(difference(p.furniture, p.floor), where).toBeGreaterThan(12);
      });
    }
  }
});

describe('night is night', () => {
  it('drops the sky far further than it drops the campus', () => {
    for (const id of THEMES) {
      const night = pixels(resolveTheme(id, 0));
      const day = pixels(resolveTheme(id, 1));
      // The void really does go dark…
      expect(lightness(night.sky), id).toBeLessThan(12);
      expect(lightness(day.sky) - lightness(night.sky), id).toBeGreaterThan(40);
      // …while the stone only steps down, which is the whole trick: it stays
      // moonlit rather than dim, and the contrast moves into the sky and the
      // hue. A night campus below about 40 is the mush this was written for.
      expect(lightness(night.floor), id).toBeGreaterThan(40);
      expect(lightness(night.floor), id).toBeLessThan(lightness(day.floor) - 8);
    }
  });

  it('is a different palette, not the day one turned down', () => {
    for (const id of THEMES) {
      const night = pixels(resolveTheme(id, 0));
      const day = resolveTheme(id, 1);
      // Dim the day paving in linear light until it is exactly as light as
      // the night paving, and the two should still be plainly different
      // colors. If they are not, the night half is a brightness knob.
      const lit = linearOf(day.platform.top).map((c, i) => c * linearOf(day.tones.top)[i]!) as [
        number,
        number,
        number,
      ];
      const target = lightness(night.floor);
      let low = 0;
      let high = 1;
      for (let i = 0; i < 40; i++) {
        const mid = (low + high) / 2;
        if (lightness(encode(toneMap(lit.map((c) => c * mid) as typeof lit))) > target) high = mid;
        else low = mid;
      }
      const dimmed = encode(toneMap(lit.map((c) => c * low) as typeof lit));
      expect(difference(dimmed, night.floor), id).toBeGreaterThan(10);
    }
  });

  it('never darkens a base harder at night than by day', () => {
    // The base gradient multiplies whatever is already there, so the same
    // strength that carves a bright day platform crushes a night one.
    for (const id of THEMES) {
      const pair = OFFICE_THEMES[id]!;
      expect(pair.night.gradient, id).toBeLessThanOrEqual(pair.day.gradient);
    }
  });
});

describe('the flat theme stays flat', () => {
  const flat = THEMES.filter((id) => OFFICE_THEMES[id]!.day.ink !== undefined);

  it('has one to find', () => {
    expect(flat).toEqual(['ink']);
  });

  it('gives every face the same tone and no gradient, all day', () => {
    for (const id of flat) {
      for (const dayFactor of HOURS) {
        const theme = resolveTheme(id, dayFactor);
        expect(theme.gradient, id).toBe(0);
        expect(theme.tones.left, `${id} @ ${dayFactor}`).toBe(theme.tones.top);
        expect(theme.tones.right, `${id} @ ${dayFactor}`).toBe(theme.tones.top);
        // A print's furniture is the same color as the page it sits on; only
        // the ink draws it. Giving it a tone of its own would be shading.
        expect(theme.platform.top, `${id} @ ${dayFactor}`).toBe(theme.tones.top);
      }
    }
  });

  it('never lets the ink pass through the paper', () => {
    // The interpolation is a straight line between the two halves, so a night
    // half that swaps ink and paper has to cross in the middle: somewhere
    // around dusk the two colors of a two-color print become one color and
    // the campus vanishes. Whatever the night half does, it must not do that.
    for (const id of flat) {
      for (const dayFactor of HOURS) {
        const theme = resolveTheme(id, dayFactor);
        const paper = face(theme.platform.top, theme.tones.top);
        const ink = face(theme.platform.side, theme.tones.right, { grad: 0.4 });
        expect(difference(paper, ink), `${id} @ ${dayFactor}`).toBeGreaterThan(40);
      }
    }
  });
});

describe('lamps and screens', () => {
  // Every source in the office: session colors on monitors, theme accents on
  // lamps, shelf backs and halos.
  const SOURCES = ['#F2705A', '#3E8CD8', '#2E9E96', '#8A6FD1', '#E5A32B', '#6E9E62'];

  it('only glows after dark', () => {
    for (const id of THEMES) {
      expect(resolveTheme(id, 1).emissive, id).toBe(0);
      expect(resolveTheme(id, 0).emissive, id).toBeGreaterThan(0);
      // And arrives over the evening rather than switching on.
      expect(resolveTheme(id, 0.5).emissive, id).toBeCloseTo(resolveTheme(id, 0).emissive / 2, 5);
    }
  });

  it('reads as a light without blowing out', () => {
    for (const id of THEMES) {
      const theme = resolveTheme(id, 0);
      for (const source of SOURCES) {
        const where = `${id} ${source}`;
        const options = { grad: 0.9, gradient: theme.gradient };
        const unlit = face(source, theme.tones.top, options);
        const lit = face(source, theme.tones.top, { ...options, glow: theme.emissive });
        expect(difference(lit, unlit), where).toBeGreaterThan(24);
        expect(lightness(lit), where).toBeGreaterThan(lightness(unlit));
        // Clipping to white is how a glow stops being a color and starts
        // being a hole in the picture.
        expect(lightness(lit), where).toBeLessThan(92);
        expect(chroma(lit), where).toBeGreaterThan(20);
      }
    }
  });

  it('keeps one source from looking like another', () => {
    // The emissive term takes the part's own color, not the shaded one, so a
    // monitor carrying a session color and a lamp carrying the theme accent
    // stay different lights. Lifting the shaded color instead pushes every
    // source toward the same pale near-white.
    for (const id of THEMES) {
      const theme = resolveTheme(id, 0);
      const lights = SOURCES.map((source) =>
        face(source, theme.tones.top, { grad: 0.9, gradient: theme.gradient, glow: theme.emissive }),
      );
      for (let i = 0; i < lights.length; i++) {
        for (let j = i + 1; j < lights.length; j++) {
          expect(difference(lights[i]!, lights[j]!), `${id} ${SOURCES[i]}/${SOURCES[j]}`).toBeGreaterThan(18);
        }
      }
    }
  });
});

describe('the void', () => {
  /**
   * The height fog is there to end the waterfalls and the rock under the
   * campus, not to eat the campus. A world is a landform now, so how deep its
   * lowest terrace sits is the world's business and the void has to follow it:
   * this is the same sum `OfficeView` does when a campus changes.
   */
  it('starts below the lowest platform anything stands on, whatever the world', () => {
    for (const seed of [0, 7, 40503, 99001, 1863896729]) {
      const campus = buildCampus([], new Map(), seed);
      setVoidPlane(lowestFloor(campus) - 5.5, 7.5);

      const deepest = lowestFloor(campus) - PLATFORM_THICKNESS;

      expect(facetUniforms.uVoidY.value, `seed ${seed}`).toBeLessThan(deepest);
      // With most of a slab spare, so a stair cheek hanging off the bottom
      // terrace does not pick up a fade either.
      expect(deepest - facetUniforms.uVoidY.value, `seed ${seed}`).toBeGreaterThan(PLATFORM_THICKNESS * 0.75);
      // And the fade itself reaches far enough past that to finish a waterfall.
      expect(facetUniforms.uVoidFade.value, `seed ${seed}`).toBeGreaterThan(LEVEL_HEIGHT);
      // The rock has to end below where the fade has finished, or the office
      // stands on a row of flat-bottomed boxes hanging in the sky.
      const faded = facetUniforms.uVoidY.value - facetUniforms.uVoidFade.value;
      expect(bedrockOf(campus), `seed ${seed}`).toBeLessThan(faded);
    }
  });
});

describe('resolveTheme', () => {
  it('lands exactly on each half at the ends', () => {
    // mixHex writes lower case, so compare the colours rather than the text.
    const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
    for (const id of THEMES) {
      const pair = OFFICE_THEMES[id]!;
      for (const [dayFactor, half] of [
        [1, pair.day],
        [0, pair.night],
      ] as const) {
        const got = resolveTheme(id, dayFactor);
        expect(same(got.tones.top, half.tones.top), `${id} @ ${dayFactor}`).toBe(true);
        expect(same(got.tones.right, half.tones.right), `${id} @ ${dayFactor}`).toBe(true);
        expect(same(got.platform.side, half.platform.side), `${id} @ ${dayFactor}`).toBe(true);
        expect(same(got.sky[1], half.sky[1]), `${id} @ ${dayFactor}`).toBe(true);
      }
    }
  });

  it('clamps, and falls back to a theme that exists', () => {
    expect(resolveTheme('monument', -3).dayFactor).toBe(0);
    expect(resolveTheme('monument', 9).dayFactor).toBe(1);
    expect(resolveTheme('no-such-theme', 0.4).id).toBe('monument');
  });

  it('agrees with the clock about when it is dark', () => {
    const at = (hours: number, minutes = 0): number => {
      const date = new Date();
      date.setHours(hours, minutes, 0, 0);
      return dayFactorFor(date);
    };
    expect(at(2)).toBe(0);
    expect(at(22)).toBe(0);
    expect(at(13)).toBe(1);
    expect(at(19, 30)).toBeGreaterThan(0);
    expect(at(19, 30)).toBeLessThan(1);
  });

  it('mixes hex without drifting off the ends', () => {
    expect(mixHex('#000000', '#FFFFFF', 0)).toBe('#000000');
    expect(mixHex('#000000', '#FFFFFF', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#FFFFFF', 0.5)).toBe('#808080');
  });
});
