import { mixHex, type ResolvedTheme } from '../theme/themes';

/**
 * What lives in the sky, as numbers.
 *
 * Placement, flock paths and tones are pure functions of a clock and a seed —
 * never of the previous frame — so the same second of the same day draws the
 * same sky and a screenshot is reproducible. The shader in Atmosphere.tsx only
 * draws what these hand it; nothing in here knows about three.
 *
 * Positions are in *screen-heights*: x is measured from the centre of the frame
 * and spans ±aspect/2, y runs 0 at the bottom to 1 at the top. Working in one
 * unit means a cloud is the same size on a tall window as on a wide one, and
 * sizes below can be read as "fraction of the window's height".
 */

/**
 * Every knob worth turning. Tuning the sky means editing this table and
 * nothing else — the shader is generated from these values.
 */
export const ATMOSPHERE = {
  /** Fixed, so two runs at the same clock draw the same sky. */
  seed: 20260214,
  /** Where the sky's clock starts. Reduced motion freezes it here. */
  startTime: 0,
  /**
   * Screen-heights the sky slides at a quarter turn of the camera.
   *
   * A sine of the azimuth rather than a multiple of it: bounded, and it comes
   * home after a full orbit, so nothing ever has to wrap mid-frame.
   */
  parallax: 0.04,

  cloud: {
    /** The far layer is drawn first, so it sits behind the near one. */
    far: 3,
    near: 5,
    /**
     * Screen-heights per second. About three pixels a second on a laptop: eight
     * minutes for a near cloud to cross a 16:9 frame, nineteen for a far one.
     * Fast enough to see if you watch for it, slow enough that you will not.
     */
    driftFar: 0.0016,
    driftNear: 0.0038,
    /** How much of the camera parallax the far layer takes. */
    parallaxFar: 0.45,
    /** Cloud scale; a cloud is about 1.7× this wide and 0.8× this tall. */
    sizeFar: { min: 0.055, max: 0.095 },
    sizeNear: { min: 0.075, max: 0.155 },
    /** Bands well above the middle of the frame, which belongs to the office. */
    bandFar: { lo: 0.76, hi: 0.94 },
    bandNear: { lo: 0.7, hi: 0.9 },
    /** How far off-frame a cloud waits before drifting back in. */
    margin: 0.35,
    alphaFar: 0.3,
    alphaNear: 0.62,
    /** Edge feather as a fraction of the cloud's scale. Lower reads as cut paper. */
    softness: 0.12,
    /** Clouds dissolve before they reach the office. */
    guard: { lo: 0.6, hi: 0.67 },
    /** Where in the sky gradient a cloud borrows its colour from. */
    bandSky: 0.78,
    /** How far a cloud's tone moves off the sky toward the day's warm end. */
    warmth: 0.62,
    /** What a flat theme's clouds take from its ink instead. */
    inkTint: 0.07,
    /** Cloud presence at deep night; daylight ramps the rest. */
    nightFloor: 0.16,
  },

  star: {
    /** Cells per screen-height: higher is denser and smaller. */
    densityBright: 24,
    densityFaint: 44,
    /** Fraction of cells left empty. */
    gateBright: 0.8,
    gateFaint: 0.9,
    /** How hard the low-frequency clumping pushes the gate around. */
    clump: 0.2,
    alpha: 0.9,
    /** Twinkle depth: the brightest star dims by this much at the trough. */
    twinkle: 0.24,
    /** Stars stay out of the bright lower sky. */
    horizon: { lo: 0.16, hi: 0.52 },
    /** Daylight at which the last star has gone out. */
    fadeBy: 0.62,
  },

  bird: {
    /**
     * One slot may hold one flock, and most hold none. Together these give a
     * gap of about two minutes on average, and anywhere from half a minute to
     * eleven — which is what stops a rare thing from becoming a metronome.
     */
    period: 52,
    chance: 0.45,
    /** Seconds a flock takes to cross; about 27 of them are on screen. */
    cross: 34,
    count: 6,
    /** Wing half-span, screen-heights. */
    span: 0.011,
    /** Size of the whole formation, screen-heights. */
    spread: 0.075,
    /** Stroke width, screen-heights. About two CSS pixels on a laptop. */
    stroke: 0.0022,
    /** Radians per second; ~0.7 wingbeats a second. */
    flap: 4.2,
    band: { lo: 0.72, hi: 0.92 },
    margin: 0.22,
    alpha: 0.42,
    /** Seconds the birds take to leave once motion is switched to reduced. */
    settle: 1.4,
  },

};

/** Clouds are pale at noon and barely there at night. */
export function cloudPresence(dayFactor: number): number {
  const floor = ATMOSPHERE.cloud.nightFloor;
  return floor + (1 - floor) * clamp01(dayFactor);
}

/** Stars only after dark, and gone well before the sky is bright. */
export function starPresence(dayFactor: number): number {
  return smoothstep(ATMOSPHERE.star.fadeBy, 0.02, dayFactor);
}

/**
 * Birds mostly at dawn and dusk: the peak sits where the sky is changing, and
 * deep night empties it entirely. Noon keeps a little, because an empty noon
 * sky is the one a person stares at longest.
 */
export function birdPresence(dayFactor: number): number {
  const d = clamp01(dayFactor);
  const awake = smoothstep(0.05, 0.35, d);
  return awake * (0.45 + 0.55 * Math.sin(Math.PI * d));
}


/** Floats in each cloud's slot of the uniform array. */
export const CLOUD_STRIDE = 4;

/**
 * Where every cloud is, this instant.
 *
 * Each cloud owns a jittered slot on its layer and every cloud on a layer moves
 * at the same speed — same distance, same speed — so a layer keeps its spacing
 * forever instead of slowly clumping into one blob. The wrap happens here in
 * double precision rather than in the shader, where `mod(time * speed, span)`
 * goes visibly steppy after an hour of float32 drift.
 */
export function cloudField(
  time: number,
  seed: number,
  aspect: number,
  drift: number,
  out: Float32Array,
): void {
  const c = ATMOSPHERE.cloud;
  const span = aspect + c.margin * 2;

  for (let i = 0; i < c.far + c.near; i++) {
    const isFar = i < c.far;
    const slot = isFar ? i : i - c.far;
    const slots = isFar ? c.far : c.near;
    const size = isFar ? c.sizeFar : c.sizeNear;
    const band = isFar ? c.bandFar : c.bandNear;
    const speed = isFar ? c.driftFar : c.driftNear;
    const alpha = isFar ? c.alphaFar : c.alphaNear;
    const parallax = isFar ? c.parallaxFar : 1;

    const lane = (slot + 0.18 + 0.64 * rand(seed, i, 0)) * (span / slots);
    const base = i * CLOUD_STRIDE;
    out[base] = wrap(lane + time * speed + drift * parallax, span) - span / 2;
    out[base + 1] = band.lo + rand(seed, i, 1) * (band.hi - band.lo);
    out[base + 2] = size.min + rand(seed, i, 2) * (size.max - size.min);
    out[base + 3] = alpha * (0.72 + 0.28 * rand(seed, i, 3));
  }
}


export interface Flock {
  active: boolean;
  /** Centre of the formation, in screen-heights from the middle of the frame. */
  x: number;
  y: number;
  /** +1 flying right, −1 flying left. */
  direction: number;
  /** 0 at the frame edges, 1 mid-crossing. */
  fade: number;
}

export function createFlock(): Flock {
  return { active: false, x: 0, y: 0, direction: 1, fade: 0 };
}

/**
 * Where the flock is, if there is one.
 *
 * Time is cut into slots and most slots stay empty, which is what turns a fixed
 * period into the irregular "one every minute or two" the sky wants. Writes
 * into `out` rather than returning a fresh object: this runs every frame.
 */
export function flockAt(time: number, seed: number, aspect: number, out: Flock): Flock {
  const b = ATMOSPHERE.bird;
  out.active = false;
  out.fade = 0;
  if (!(time >= 0)) return out;

  const slot = Math.floor(time / b.period);
  if (rand(seed, slot, 11) > b.chance) return out;

  // Somewhere inside the slot, so two flocks in a row never keep the same beat.
  const start = rand(seed, slot, 12) * (b.period - b.cross);
  const u = (time - slot * b.period - start) / b.cross;
  if (u < 0 || u > 1) return out;

  const span = aspect + b.margin * 2;
  const direction = rand(seed, slot, 13) < 0.5 ? 1 : -1;
  const tilt = rand(seed, slot, 14) - 0.5;

  out.active = true;
  out.direction = direction;
  out.x = direction * (u * span - span / 2);
  // A shallow arc with a lean to it. Six dashes on a ruled line read as debris.
  out.y =
    b.band.lo +
    rand(seed, slot, 15) * (b.band.hi - b.band.lo) +
    Math.sin(u * Math.PI) * 0.02 +
    (u - 0.5) * tilt * 0.06;
  out.fade = smoothstep(0, 0.14, u) * smoothstep(1, 0.86, u);
  return out;
}

/**
 * A star's slow breath. Mirrored one-for-one in the shader, which is where it
 * actually runs; it lives here so the depth and the range are pinned down.
 */
export function twinkle(time: number, phase: number, rate: number, brightness: number): number {
  const amp = ATMOSPHERE.star.twinkle * (0.4 + 0.6 * clamp01(brightness));
  return 1 - amp + amp * Math.sin(time * rate + phase);
}

export interface AtmosphereTones {
  cloudLight: string;
  cloudDark: string;
  star: string;
  bird: string;
}

/**
 * What the sky's furniture is made of, for this theme at this hour.
 *
 * Everything starts from the sky the shape actually sits in and moves a short
 * way off it, which is what keeps the contrast low by construction: a cloud can
 * never be brighter than the palette allows, and dusk warms it without anyone
 * writing a dusk case.
 *
 * Ink & Paper has one flat colour and no gradient to catch, so its sky is
 * printed instead: a flat tint away from the paper, by a fixed amount. Not the
 * theme's own ink, which crosses straight through the paper colour halfway
 * through dusk and would take the clouds with it.
 */
export function atmosphereTones(theme: ResolvedTheme): AtmosphereTones {
  const c = ATMOSPHERE.cloud;
  const high = mixHex(theme.sky[1], theme.sky[2], c.bandSky);

  if (theme.ink !== undefined) {
    const inked = luma(high) > 0.5 ? '#000000' : '#FFFFFF';
    return {
      cloudLight: mixHex(high, inked, c.inkTint),
      cloudDark: mixHex(high, inked, c.inkTint * 1.8),
      star: mixHex(theme.tones.top, '#FFFFFF', 0.72),
      bird: mixHex(high, inked, 0.55),
    };
  }

  const warm = mixHex(theme.sky[0], theme.tones.top, 0.5);
  const shade = mixHex(theme.sky[0], theme.tones.left, 0.5);
  return {
    cloudLight: mixHex(high, warm, c.warmth),
    cloudDark: mixHex(high, shade, c.warmth * 0.55),
    star: mixHex(theme.tones.top, '#FFFFFF', 0.72),
    bird: mixHex(theme.tones.right, high, 0.35),
  };
}

/**
 * A 32-bit integer hash. Every bit of it is exact in JavaScript, which is the
 * point: `fract(sin(…))` is fine inside a shader but cannot be reproduced here,
 * and anything a test has to pin down has to be reproducible.
 */
function rand(seed: number, index: number, channel: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (index + 0x27d4eb2f), 0xc2b2ae35);
  h = Math.imul(h ^ Math.imul(channel, 0x165667b1), 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Rough perceived lightness, 0–1. Enough to ask "is this paper or is it night". */
function luma(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function wrap(value: number, span: number): number {
  return ((value % span) + span) % span;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
