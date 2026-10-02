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

/**
 * Five palettes per theme, not two.
 *
 * Day and night alone cannot produce a golden hour, and not for want of good
 * hexes: the midpoint of a lerp between a warm palette and a cool one is by
 * construction less saturated than either end, and golden hour is *more*
 * saturated than noon. Two keyframes can only ever give the office a muddy
 * mauve halfway and call it dawn.
 *
 * So the cycle is authored where it bends. Noon is the coolest, flattest hour
 * — which is also true outdoors, and which leaves the warmth somewhere to go;
 * golden hour is the one that glows; dusk is the blue hour before the stars;
 * dawn is golden hour's colder cousin, because the air at six in the morning
 * has not been warmed by anything yet.
 *
 * Authoring noon cool is the part that pays for itself twice. The old day half
 * was already a sunset, so the office looked the same from breakfast to
 * bedtime and every visible change happened while you were asleep.
 */
export interface ThemeCycle {
  night: OfficeTheme;
  dawn: OfficeTheme;
  day: OfficeTheme;
  golden: OfficeTheme;
  dusk: OfficeTheme;
}

export const OFFICE_THEMES: Record<string, ThemeCycle> = {
  monument: {
    // Moonlight on pale stone. The sky drops most of the way to black and the
    // campus only steps down, to a cool lavender grey: light enough that the
    // architecture still has three sides, far enough round the wheel from the
    // day's cream that nobody mistakes the hour.
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
    // Cold light with a rose in it. Dawn is the one hour whose warmth sits in
    // the sky and not on the stone, so the platforms stay nearly as cool as
    // they were at night while the horizon goes pink above them.
    dawn: {
      id: 'monument',
      name: 'Monument',
      sky: ['#F3C0B4', '#D2A2B4', '#7E77AE'],
      tones: { top: '#F4EFF2', left: '#D6C2C8', right: '#98868F' },
      platform: { top: '#EDE4E6', side: '#A08D96' },
      accent: '#F2705A',
      gradient: 0.28,
      emissive: 0.4,
    },
    // Noon: the coolest and flattest of the five. Nothing here glows, which is
    // what makes the two golden keyframes either side of it read as light
    // rather than as paint.
    day: {
      id: 'monument',
      name: 'Monument',
      sky: ['#DCE4F0', '#BCCFEC', '#8AA4D8'],
      tones: { top: '#FFFBF6', left: '#DECFC6', right: '#9E8F8B' },
      platform: { top: '#F7EFE8', side: '#A08A84' },
      accent: '#F2705A',
      gradient: 0.34,
      emissive: 0.0,
    },
    // The hour the office was always trying to be. Warmer and *more* saturated
    // than noon in every channel, which is the thing a two-point lerp could
    // not reach.
    golden: {
      id: 'monument',
      name: 'Monument',
      sky: ['#FFD9AC', '#FFC3B0', '#C6B2E4'],
      tones: { top: '#FFF2DE', left: '#F0B89E', right: '#B07A68' },
      platform: { top: '#FCE6CE', side: '#B67A6A' },
      accent: '#F2705A',
      gradient: 0.36,
      emissive: 0.12,
    },
    // Blue hour: the sun is gone, the sky has not finished. Stone turns violet
    // before the sky does, so the campus is already night-coloured while the
    // horizon still carries the last of the pink.
    dusk: {
      id: 'monument',
      name: 'Monument',
      sky: ['#C98CA4', '#8A6C9E', '#473F73'],
      tones: { top: '#DCD1E6', left: '#AF97B2', right: '#736285' },
      platform: { top: '#D0C5DE', side: '#8A77A4' },
      accent: '#F2705A',
      gradient: 0.28,
      emissive: 0.75,
    },
  },
  /*
   * Ink & Paper is a two-colour print, and prints do not have a golden hour.
   *
   * Its five keyframes are really two: a warm page and a cold one, with the
   * turn happening across dusk. What it gets instead of light is *line* — see
   * `theme.ink` and the edge pass in `Platforms`. The sides used to do the
   * drawing by being nearly black, which on a surface the size of a platform
   * is not a line, it is a hole; they are a paper shade now and the ink draws
   * the shapes.
   */
  ink: {
    night: {
      id: 'ink',
      name: 'Ink & Paper',
      sky: ['#3D3D47', '#3D3D47', '#3D3D47'],
      tones: { top: '#BABCC5', left: '#BABCC5', right: '#BABCC5' },
      platform: { top: '#BABCC5', side: '#9A9DA8' },
      accent: '#FB303D',
      ink: '#20202C',
      gradient: 0,
      emissive: 0.6,
    },
    dawn: {
      id: 'ink',
      name: 'Ink & Paper',
      sky: ['#F7E4CE', '#F7E4CE', '#F7E4CE'],
      tones: { top: '#F7E4CE', left: '#F7E4CE', right: '#F7E4CE' },
      platform: { top: '#F7E4CE', side: '#D6C4AA' },
      accent: '#FB303D',
      ink: '#14121A',
      gradient: 0,
      emissive: 0.2,
    },
    day: {
      id: 'ink',
      name: 'Ink & Paper',
      sky: ['#FEE5C0', '#FEE5C0', '#FEE5C0'],
      tones: { top: '#FEE5C0', left: '#FEE5C0', right: '#FEE5C0' },
      platform: { top: '#FEE5C0', side: '#DCC3A0' },
      accent: '#FB303D',
      ink: '#14121A',
      gradient: 0,
      emissive: 0,
    },
    golden: {
      id: 'ink',
      name: 'Ink & Paper',
      sky: ['#FFD9A2', '#FFD9A2', '#FFD9A2'],
      tones: { top: '#FFD9A2', left: '#FFD9A2', right: '#FFD9A2' },
      platform: { top: '#FFD9A2', side: '#DDB682' },
      accent: '#FB303D',
      ink: '#181119',
      gradient: 0,
      emissive: 0.1,
    },
    dusk: {
      id: 'ink',
      name: 'Ink & Paper',
      sky: ['#6E5F66', '#6E5F66', '#6E5F66'],
      tones: { top: '#D3CBC6', left: '#D3CBC6', right: '#D3CBC6' },
      platform: { top: '#D3CBC6', side: '#AFA8A6' },
      accent: '#FB303D',
      ink: '#1D1A24',
      gradient: 0,
      emissive: 0.45,
    },
  },
  sage: {
    // A petrol sky over stone that has cooled from garden green toward the
    // sea. It stops short of the accent's teal: any further and the
    // whiteboards and shelf backs stop standing out from the floor.
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
    dawn: {
      id: 'sage',
      name: 'Sage',
      sky: ['#D9CEC2', '#B4C0BE', '#7A93A4'],
      tones: { top: '#E8EEE4', left: '#C2D0C6', right: '#93A79F' },
      platform: { top: '#DCE6DC', side: '#8C9E96' },
      accent: '#2E9E96',
      gradient: 0.28,
      emissive: 0.4,
    },
    day: {
      id: 'sage',
      name: 'Sage',
      sky: ['#D4E4E2', '#AECCD8', '#6E9EBE'],
      tones: { top: '#F4F8F0', left: '#C6D8C4', right: '#8EA898' },
      platform: { top: '#E7F0E6', side: '#6E8C76' },
      accent: '#2E9E96',
      gradient: 0.32,
      emissive: 0,
    },
    golden: {
      id: 'sage',
      name: 'Sage',
      sky: ['#F6E4C2', '#E4DCB8', '#A9C0CE'],
      tones: { top: '#F6F2DC', left: '#D6DCB0', right: '#9CA878' },
      platform: { top: '#EDEBCE', side: '#87946A' },
      accent: '#2E9E96',
      gradient: 0.34,
      emissive: 0.12,
    },
    dusk: {
      id: 'sage',
      name: 'Sage',
      sky: ['#9C8E9C', '#6E7A88', '#3C4E60'],
      tones: { top: '#C8D6CE', left: '#93AAA6', right: '#6A8480' },
      platform: { top: '#BACCC4', side: '#76988F' },
      accent: '#2E9E96',
      gradient: 0.26,
      emissive: 0.75,
    },
  },
  sorbet: {
    // Plum sky, stone that keeps its blush. Sorbet is the only theme whose
    // accent is cooler than its stone, so its night holds more pink in the
    // tones than the others to keep that reading.
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
    dawn: {
      id: 'sorbet',
      name: 'Sorbet',
      sky: ['#F4C6CE', '#DCACC8', '#8A82B8'],
      tones: { top: '#FAEDF0', left: '#E6CAD6', right: '#A98FA6' },
      platform: { top: '#F4E2E8', side: '#AE8FA2' },
      accent: '#8A6FD1',
      gradient: 0.26,
      emissive: 0.4,
    },
    day: {
      id: 'sorbet',
      name: 'Sorbet',
      sky: ['#E2DEF0', '#C4CCEE', '#8296DE'],
      tones: { top: '#FFF8FA', left: '#EACFDA', right: '#AE93A0' },
      platform: { top: '#FAEDF1', side: '#AE8496' },
      accent: '#8A6FD1',
      gradient: 0.3,
      emissive: 0,
    },
    golden: {
      id: 'sorbet',
      name: 'Sorbet',
      sky: ['#FFDCC6', '#FFC8D2', '#D2B6EE'],
      tones: { top: '#FFEEE2', left: '#F8C8CE', right: '#DC9AA6' },
      platform: { top: '#FEE2E2', side: '#CE8496' },
      accent: '#8A6FD1',
      gradient: 0.32,
      emissive: 0.12,
    },
    dusk: {
      id: 'sorbet',
      name: 'Sorbet',
      sky: ['#C286A8', '#8E5F84', '#4E3A60'],
      tones: { top: '#EAD2E6', left: '#C29ABC', right: '#8E6E8E' },
      platform: { top: '#E0C4DE', side: '#A582B4' },
      accent: '#8A6FD1',
      gradient: 0.26,
      emissive: 0.75,
    },
  },
};

export type ThemeId = keyof typeof OFFICE_THEMES;

export interface ResolvedTheme extends OfficeTheme {
  /** 0 = deep night, 1 = full day. Drives lamp glow and sky blending. */
  dayFactor: number;
  /**
   * Which side of noon. Dawn and dusk sit at the same amount of daylight and
   * are not the same colour, so one number cannot place the office on the
   * cycle: this is the other half of the coordinate.
   */
  falling: boolean;
}

/**
 * Local time → how much daylight there is. Dawn and dusk get a wide ramp so the
 * office spends real minutes in each of them rather than snapping.
 */
export function dayFactorFor(date: Date): number {
  const hours = date.getHours() + date.getMinutes() / 60;
  if (hours <= 5 || hours >= 21) return 0;
  if (hours >= 8 && hours <= 17) return 1;
  if (hours < 8) return smoothstep(5, 8, hours);
  return 1 - smoothstep(17, 21, hours);
}

/** True from solar noon onward, which is what tells dusk from dawn. */
export function isFalling(date: Date): boolean {
  const hours = date.getHours() + date.getMinutes() / 60;
  return hours >= 12.5 || hours < 0.5;
}

/**
 * Where each keyframe sits on the daylight ramp.
 *
 * The morning has one waypoint and the evening has two, which is not an
 * oversight: the sun sets through a longer and more interesting set of colours
 * than it rises through, and the evening is when somebody is actually watching.
 * Positions are in `dayFactor`, so they follow whatever `dayFactorFor` does
 * with the clock rather than pinning the look to an hour.
 */
const RISING: readonly [number, keyof ThemeCycle][] = [
  [0, 'night'],
  [0.45, 'dawn'],
  [1, 'day'],
];
const FALLING: readonly [number, keyof ThemeCycle][] = [
  [0, 'night'],
  [0.35, 'dusk'],
  [0.8, 'golden'],
  [1, 'day'],
];

export function resolveTheme(id: string, dayFactor: number, falling = false): ResolvedTheme {
  const cycle = OFFICE_THEMES[id] ?? OFFICE_THEMES['monument']!;
  const t = clamp01(dayFactor);
  const stops = falling ? FALLING : RISING;

  // The bracketing pair, and how far between them. Both lists end at 1, so
  // there is always a segment to land in.
  let index = 0;
  while (index < stops.length - 2 && t > stops[index + 1]![0]) index += 1;
  const [fromAt, fromKey] = stops[index]!;
  const [toAt, toKey] = stops[index + 1]!;
  const span = toAt - fromAt;
  const k = span <= 0 ? 1 : clamp01((t - fromAt) / span);
  const a = cycle[fromKey];
  const b = cycle[toKey];

  return {
    ...b,
    sky: [mixHex(a.sky[0], b.sky[0], k), mixHex(a.sky[1], b.sky[1], k), mixHex(a.sky[2], b.sky[2], k)],
    tones: {
      top: mixHex(a.tones.top, b.tones.top, k),
      left: mixHex(a.tones.left, b.tones.left, k),
      right: mixHex(a.tones.right, b.tones.right, k),
    },
    platform: {
      top: mixHex(a.platform.top, b.platform.top, k),
      side: mixHex(a.platform.side, b.platform.side, k),
    },
    gradient: a.gradient + (b.gradient - a.gradient) * k,
    emissive: a.emissive + (b.emissive - a.emissive) * k,
    ...(b.ink !== undefined ? { ink: mixHex(a.ink ?? b.ink, b.ink, k) } : {}),
    dayFactor: t,
    falling,
  };
}

/**
 * Where the light is coming from, as an offset on the tone basis.
 *
 * Without this the office is lit identically at six in the morning and eight
 * at night, and orbiting reads as turning a model on a table rather than
 * walking around a place: the tone basis follows the camera, so if nothing
 * else moves, nothing about the light ever changes.
 *
 * The sweep is deliberately less than the sun's real one. The basis is what
 * keeps every face readable from every angle, and swinging it far enough to be
 * literal puts the dark side of the campus toward the viewer twice a day.
 */
/**
 * Where the sun is, as a world azimuth.
 *
 * Rises in one quarter, sets in the opposite one, and passes overhead in
 * between — which is the whole of what makes the sky change through the day
 * rather than merely change colour. The office itself is lit by the tone basis
 * (see `sunOffsetFor`); this is for anything that has to know where in the sky
 * to draw the light, which so far is the glow on the sky quad.
 */
export function sunAzimuthFor(dayFactor: number, falling: boolean): number {
  const arc = falling ? 1 - clamp01(dayFactor) * 0.5 : clamp01(dayFactor) * 0.5;
  return Math.PI * (0.5 - arc);
}

export function sunOffsetFor(dayFactor: number, falling: boolean): number {
  // 0 at first light, 1 at last: the sun's whole arc laid out along the ramp.
  const arc = falling ? 1 - clamp01(dayFactor) * 0.5 : clamp01(dayFactor) * 0.5;
  return 0.35 + (arc - 0.5) * 1.1;
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

/**
 * Perceived brightness, 0–1. Used to decide what colour something drawn *on*
 * a surface has to be, which is a question the hour cannot answer: a platform
 * top is pale at midnight too.
 */
export function luma(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
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
export function stoneVariant(
  theme: OfficeTheme | ResolvedTheme,
  variant: number,
  level = 0,
): { top: string; side: string } {
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
   * on the floors above, which is where most of the frame is.
   *
   * Saturation used to rise with the hue shift, on the theory that a stone
   * needed help to read as its own colour. It does not: the two ends of the
   * range are also the two furthest from the theme's hue, so the loudest stone
   * was also the most saturated one, and in Monument that lands on mustard. On
   * a big platform it became the brightest thing in a frame that meant nothing
   * by it. Saturation now falls slightly at the extremes, which is what stone
   * does — the further a rock is from the local colour, the paler it tends to
   * be.
   */
  const hue = offset * 9;
  const light = offset * -0.035;
  const saturation = 1 - Math.abs(offset) * 0.06;

  /*
   * Terraces, on top of the variant.
   *
   * The campus is stacked, and nothing about its colour said so: a platform
   * three levels down was the same rock as one at the top, so height had to be
   * read entirely from geometry. Biasing lightness and warmth by level gives
   * the place strata — lower is darker and warmer, the way a quarry face is —
   * which is a depth cue the flat shading cannot provide on its own.
   *
   * It is deliberately smaller than the variant step, so it never overrules
   * the one job the variant has: telling neighbouring rooms apart.
   */
  const terrace = Math.max(-3, Math.min(3, level));
  const levelLight = terrace * 0.018;
  const levelHue = terrace * 2.5;

  return {
    top: shiftHex(theme.platform.top, hue + levelHue, saturation, light + levelLight),
    side: shiftHex(theme.platform.side, hue + levelHue, saturation, (light + levelLight) * 0.7),
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
