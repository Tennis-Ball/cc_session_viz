/**
 * Office palettes.
 *
 * The office is unlit: every surface takes its color from which way the face
 * points, so a "theme" is just a set of tones plus a sky. Day/night is the same
 * palette interpolated along the clock, never a light being moved.
 *
 * A night half is not a day half turned down, for two reasons.
 *
 * The first is the eye. With no light to take away, a shape can only read by
 * differing from the shape behind it, so every night half here keeps the stone
 * pale and cool and spends all of the darkness on the sky. The campus separates
 * from the void because the void falls away, and the faces separate from each
 * other by hue and by a deliberately narrow spread of value — the wide day
 * ramp, reproduced at night, is what turns the far side of every object black.
 *
 * The second is the pipeline. A face is its baked vertex color multiplied by
 * its face tone, and that multiply happens in linear light: two values that
 * each look like a plausible night on their own land on near-black together.
 * So night tones sit high and the vertex colors sit high with them, and the
 * hour is carried by the sky and by hue rather than by either factor going dark.
 *
 * Sky hexes look a shade or two too bright for the hour they name, and have to.
 * The sky is its own quad and writes its color straight to the frame, while
 * everything in the office is tone mapped on the way out; the same hex lands
 * about a third as bright in the sky as it does on a wall. Judge these against
 * a screenshot, never against the swatch in the settings sheet.
 */

export interface OfficeTheme {
  id: string;
  name: string;
  /** Sky gradient, bottom → middle → top. */
  sky: [string, string, string];
  /** Face tones: up, camera-left, camera-right. */
  tones: { top: string; left: string; right: string };
  platform: { top: string; side: string };
  /** Accent used by shared-zone props (whiteboard, copier, shelves). */
  accent: string;
  /** Hairline outlines, only drawn by the Ink & Paper theme. */
  ink?: string;
  /**
   * Strength of the base-darkening gradient on every object, 0–1. Lighter at
   * night than by day in every theme: it multiplies, and the same strength
   * that carves a bright platform crushes a dim one.
   */
  gradient: number;
  /** How strongly lamps and screens glow; scaled again by time of day. */
  emissive: number;
}

export const OFFICE_THEMES: Record<string, { day: OfficeTheme; night: OfficeTheme }> = {
  monument: {
    day: {
      id: 'monument',
      name: 'Monument',
      sky: ['#FFE3C9', '#FFD2C4', '#C9C4EE'],
      tones: { top: '#FFF6EC', left: '#EBBFAE', right: '#B07E76' },
      platform: { top: '#FBEBDC', side: '#B5806F' },
      accent: '#F2705A',
      gradient: 0.35,
      emissive: 0.0,
    },
    // Moonlight on pale stone. The sky drops most of the way to black and the
    // campus only steps down, to a cool lavender grey: light enough that the
    // architecture still has three sides, far enough round the wheel from the
    // day's warm cream that nobody mistakes the hour.
    night: {
      id: 'monument',
      name: 'Monument',
      sky: ['#60568F', '#4B4278', '#2E2A56'],
      tones: { top: '#BFBCE6', left: '#8780C0', right: '#585488' },
      platform: { top: '#AFAAD6', side: '#7674BC' },
      accent: '#F2705A',
      gradient: 0.22,
      emissive: 1.0,
    },
  },
  ink: {
    day: {
      id: 'ink',
      name: 'Ink & Paper',
      sky: ['#FEE5C0', '#FEE5C0', '#FEE5C0'],
      tones: { top: '#FEE5C0', left: '#FEE5C0', right: '#FEE5C0' },
      platform: { top: '#FEE5C0', side: '#020202' },
      accent: '#FB303D',
      ink: '#020202',
      gradient: 0,
      emissive: 0,
    },
    // Still one flat two-color print, with the page turned cool and the light
    // behind it taken away. What changes at night is which of the two colors
    // does the drawing: by day the sky is paper and the black sides cut the
    // shapes out of it, at night the sky is gone and the pale page is the
    // shape. Both are needed, and neither ever crosses the other.
    //
    // The previous night half swapped them outright — pale ink on dark paper.
    // The swap cannot survive the interpolation: the ink has to travel from
    // black to cream while the paper travels the other way, and around a
    // dayFactor of 0.45 they meet, the two colors of a two-color print are the
    // same color, and the whole campus disappears for the length of dusk.
    night: {
      id: 'ink',
      name: 'Ink & Paper',
      sky: ['#3D3D47', '#3D3D47', '#3D3D47'],
      tones: { top: '#BABCC5', left: '#BABCC5', right: '#BABCC5' },
      platform: { top: '#BABCC5', side: '#2A2A3A' },
      accent: '#FB303D',
      ink: '#2A2A3A',
      gradient: 0,
      emissive: 0.6,
    },
  },
  sage: {
    day: {
      id: 'sage',
      name: 'Sage',
      sky: ['#E8F0DC', '#D6E7D2', '#AFCBD6'],
      tones: { top: '#F2F7E8', left: '#CFE0C4', right: '#A9C0A0' },
      platform: { top: '#E4EEDB', side: '#7E9A78' },
      accent: '#2E9E96',
      gradient: 0.32,
      emissive: 0,
    },
    // A petrol sky over stone that has cooled from garden green toward the
    // sea. Sage is the flattest palette of the four by day, so its night keeps
    // the tone spread narrow too and carries the hour in the turn of the hue.
    // It stops short of the accent's teal: any further and the whiteboards
    // and shelf backs stop standing out from the floor.
    night: {
      id: 'sage',
      name: 'Sage',
      sky: ['#426369', '#324F58', '#223B49'],
      tones: { top: '#B2CEC4', left: '#799F97', right: '#50726D' },
      platform: { top: '#A1BFB6', side: '#66968D' },
      accent: '#2E9E96',
      gradient: 0.22,
      emissive: 1.0,
    },
  },
  sorbet: {
    day: {
      id: 'sorbet',
      name: 'Sorbet',
      sky: ['#FFE9F0', '#FFD9E4', '#CDE4FF'],
      tones: { top: '#FFF3F6', left: '#F8D3DE', right: '#E0A8BE' },
      platform: { top: '#FCE6EC', side: '#C98AA0' },
      accent: '#8A6FD1',
      gradient: 0.3,
      emissive: 0,
    },
    // Plum sky, stone that keeps its blush. Sorbet is the warmest palette by
    // day and the only one whose accent is cooler than its stone, so its night
    // holds more pink in the tones than the others to keep that reading.
    night: {
      id: 'sorbet',
      name: 'Sorbet',
      sky: ['#69496E', '#513B5D', '#352647'],
      tones: { top: '#DCBFE2', left: '#A784B6', right: '#755C80' },
      platform: { top: '#CCADD6', side: '#9276B0' },
      accent: '#8A6FD1',
      gradient: 0.22,
      emissive: 1.0,
    },
  },
};

export type ThemeId = keyof typeof OFFICE_THEMES;

export interface ResolvedTheme extends OfficeTheme {
  /** 0 = deep night, 1 = full day. Drives lamp glow and sky blending. */
  dayFactor: number;
}

/**
 * Local time → how much daylight there is. Dawn and dusk get a wide ramp so the
 * office spends real minutes in golden hour rather than snapping.
 */
export function dayFactorFor(date: Date): number {
  const hours = date.getHours() + date.getMinutes() / 60;
  if (hours <= 5 || hours >= 21) return 0;
  if (hours >= 8 && hours <= 17) return 1;
  if (hours < 8) return smoothstep(5, 8, hours);
  return 1 - smoothstep(17, 21, hours);
}

export function resolveTheme(id: string, dayFactor: number): ResolvedTheme {
  const pair = OFFICE_THEMES[id] ?? OFFICE_THEMES['monument']!;
  const t = clamp01(dayFactor);
  return {
    ...pair.day,
    sky: [mixHex(pair.night.sky[0], pair.day.sky[0], t), mixHex(pair.night.sky[1], pair.day.sky[1], t), mixHex(pair.night.sky[2], pair.day.sky[2], t)],
    tones: {
      top: mixHex(pair.night.tones.top, pair.day.tones.top, t),
      left: mixHex(pair.night.tones.left, pair.day.tones.left, t),
      right: mixHex(pair.night.tones.right, pair.day.tones.right, t),
    },
    platform: {
      top: mixHex(pair.night.platform.top, pair.day.platform.top, t),
      side: mixHex(pair.night.platform.side, pair.day.platform.side, t),
    },
    gradient: pair.night.gradient + (pair.day.gradient - pair.night.gradient) * t,
    emissive: pair.night.emissive + (pair.day.emissive - pair.night.emissive) * t,
    ...(pair.day.ink ? { ink: mixHex(pair.night.ink ?? pair.day.ink, pair.day.ink, t) } : {}),
    dayFactor: t,
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Hex mix in sRGB: good enough for palette interpolation, and predictable. */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const mix = (x: number, y: number): number => Math.round(x + (y - x) * clamp01(t));
  return rgbToHex(mix(ar, br), mix(ag, bg), mix(ab, bb));
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const num = Number.parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/**
 * How many different stones a world is built from.
 *
 * Every platform in the office was the theme's one `platform.top`, and at a
 * glance the campus read as a single cream mat with holes in it rather than as
 * a group of separate masses. Monument Valley's whole look is large flat planes
 * of *distinct* colour sitting next to each other; one colour repeated thirty
 * times is a floor plan, however good the geometry standing on it is.
 *
 * Five is enough to tell rooms apart and few enough that the campus still reads
 * as one place. More than that and neighbouring platforms start differing by
 * less than the face shading already varies them by, which is just noise.
 */
export const STONE_COUNT = 5;

/**
 * A variant of the theme's platform stone.
 *
 * Deliberately *tonal*: the hue moves by a few degrees and the lightness by a
 * little, so the result reads as a different stone quarried from the same hill
 * rather than as paint. Anything stronger fights the session colours, which are
 * the only thing in the office that is allowed to be saturated, and turns a
 * calm scene into a set of building blocks.
 *
 * The shift is applied to both faces together so a platform's top and side stay
 * related — they are one material seen from two angles, and drifting them apart
 * is what makes flat shading look like a bug.
 */
export function stoneVariant(theme: OfficeTheme | ResolvedTheme, variant: number): { top: string; side: string } {
  const step = ((variant % STONE_COUNT) + STONE_COUNT) % STONE_COUNT;
  // Centred on zero so the middle variant is the theme exactly as authored.
  const offset = step - (STONE_COUNT - 1) / 2;
  /*
   * Weighted toward lightness rather than hue, which is the opposite of the
   * obvious choice and the one that actually works here.
   *
   * A platform top sits around 93% lightness, and at that end of the scale hue
   * has almost nowhere to go — five stones separated by hue alone were clearly
   * different on the rock below, which is mid-toned, and very nearly identical
   * on the floors above, which is where most of the frame is. Dropping the
   * lightness gives the pale end somewhere to move and lets the chroma show at
   * the same time, so a room reads as sand or as chalk rather than as two
   * cream-whites a few degrees apart.
   */
  const hue = offset * 14;
  const light = offset * -0.05;
  const saturation = 1 + offset * 0.2;
  return {
    top: shiftHex(theme.platform.top, hue, saturation, light),
    side: shiftHex(theme.platform.side, hue, saturation, light * 0.7),
  };
}

/** Moves a colour in HSL: hue in degrees, saturation as a factor, lightness as an offset. */
function shiftHex(hex: string, hue: number, saturation: number, light: number): string {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  const [r, g, b] = hslToRgb((h + hue / 360 + 1) % 1, clamp01(s * saturation), clamp01(l + light));
  return rgbToHex(r, g, b);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rd = r / 255;
  const gd = g / 255;
  const bd = b / 255;
  const max = Math.max(rd, gd, bd);
  const min = Math.min(rd, gd, bd);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rd ? (gd - bd) / d + (gd < bd ? 6 : 0) : max === gd ? (bd - rd) / d + 2 : (rd - gd) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    const x = (t + 1) % 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255),
  ];
}
