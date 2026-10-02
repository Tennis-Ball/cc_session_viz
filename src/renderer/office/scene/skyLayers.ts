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
    /*
     * The far layer is drawn first, so it sits behind the near one.
     *
     * There is room for more of them than a clear sky ever uses. Overcast used
     * to be the same eight clouds at higher opacity, which is not what a grey
     * day looks like at all — it reads as haze, because haze is exactly what
     * "the same few shapes, more of them visible" is. A covered sky needs more
     * shapes, wider ones, and lower down, so the slots are sized for the
     * heaviest weather and a clear day simply leaves most of them empty.
     */
    far: 6,
    near: 8,
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

    /**
     * How the sky is furnished, per weather.
     *
     * `fill` is the fraction of the slots that hold anything at all, `size`
     * and `stretch` are how big and how wide the shapes get, and `sheet` says
     * whether they are puffs or a lid.
     *
     * Cloudy and rain were the same sky at two greys, which is wrong about
     * both of them. A cloudy day is not a dim one — it is a *busy* one: a lot
     * of bright cumulus, bigger than fair-weather ones and spread over more of
     * the sky, with the sun still on them. What makes a sky grey is rain, and
     * that is a different shape as well as a different colour: a low flat lid
     * with no gaps in it. Giving cloudy any grey at all made it look like a
     * dirty version of clear rather than a different day.
     *
     * `drop` slides the band down toward the office and is deliberately tiny.
     * A lid you can feel wants to come much lower than this, and it cannot:
     * `guard` dissolves anything that reaches down to where the campus is, and
     * that rule is worth more than the extra weight.
     */
    weather: {
      clear: { fill: 0.5, drop: 0, size: 1, stretch: 1, sheet: false, alpha: 1, cirrus: 0.55, spread: 1, grey: 0 },
      // Bright, big and plentiful. No grey: the sun is still on these.
      cloudy: { fill: 1, drop: 0.02, size: 1.34, stretch: 1.2, sheet: false, alpha: 1.05, cirrus: 0.22, spread: 1.5, grey: 0 },
      /*
       * And the lid, which is the only one that is actually grey.
       *
       * Pulled back from a storm to a wet afternoon. It had been tuned up —
       * a near-black sheet at alpha 1.35 with the rain falling in long dark
       * strokes through it — and the result was dramatic and the opposite of
       * what this scene is for: a thing you glance at for hours should not
       * have weather that takes the frame over. A grey day is still grey; it
       * is just not a front page.
       */
      rain: { fill: 1, drop: 0.04, size: 1, stretch: 2.6, sheet: true, alpha: 1.05, cirrus: 0, spread: 1.7, grey: 0.52 },
    } as Record<
      string,
      {
        fill: number;
        drop: number;
        size: number;
        stretch: number;
        sheet: boolean;
        alpha: number;
        cirrus: number;
        spread: number;
        grey: number;
      }
    >,
  },

  /**
   * Sheet lightning.
   *
   * Never a drawn bolt. A fork of white lines would be the only hard-edged,
   * high-contrast thing in a frame made entirely of soft flat shapes, and it is
   * the one element in the sky that cannot be glanced at — which is the whole
   * problem with weather effects in something you leave open all day. What a
   * storm a few miles off actually does is light its own cloud from inside,
   * twice, and go out, and that reads as lightning without ever once pulling
   * the eye off the office.
   */
  flash: {
    /*
     * Seconds per slot, and how often a slot holds anything.
     *
     * The first numbers gave a strike about every forty seconds, lasting two
     * thirds of one — one and a half per cent of the time — and the effect of
     * that is not "rare", it is "never": nobody watching a storm for a minute
     * saw a single one, which is the same as not having built it. About every
     * twenty seconds is still occasional enough to stay out of the way of the
     * office and often enough to be a thing the weather does.
     */
    period: 13,
    chance: 0.62,
    /** Seconds the whole thing lasts, blink and all. */
    lasts: 0.75,
    /** Peak lift on the cloud it happens inside. */
    strength: 0.72,
    /**
     * How wide the glow spreads, in screen-heights.
     *
     * Tighter than it looks like it wants to be. Spread across half the sky
     * the stroke lights everything a little and nothing much, which reads as
     * the exposure changing rather than as lightning; concentrated, one cloud
     * is plainly the one it happened in and its neighbours catch the edge.
     */
    spread: 0.3,
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
/** And in its shape slot: kind, stretch, tilt, variant. */
export const SHAPE_STRIDE = 4;

/**
 * What kind of cloud a slot holds.
 *
 * Three, because there are three that read differently at a glance and no
 * fourth that does. A cumulus has a top and a flat base and casts the sky as
 * fair; a stratus is a long low sheet and is the only thing that makes a sky
 * look *covered* rather than dirty; a cirrus is a few thin strokes miles up and
 * is what an empty blue sky has in it instead of nothing.
 */
export const CUMULUS = 0;
export const STRATUS = 1;
export const CIRRUS = 2;

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
  /** Kind, stretch, tilt and variant per cloud. Optional so a test can skip it. */
  shape?: Float32Array,
  weather: string = 'clear',
): void {
  const c = ATMOSPHERE.cloud;
  const span = aspect + c.margin * 2;
  const w = c.weather[weather] ?? c.weather['clear']!;

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
    /*
     * The band, slid down by the weather.
     *
     * Every slot still gets a real position even when the weather leaves it
     * empty: the placement is what the tests pin down, and a slot that jumps
     * somewhere new the moment it fades in would pop rather than gather.
     */
    const scale = (size.min + rand(seed, i, 2) * (size.max - size.min)) * w.size;
    /*
     * The band, slid down by the weather and then clamped off the guard.
     *
     * A cloud's flat base sits about `0.34 × scale` below its centre, and the
     * guard starts eating anything that gets down to `guard.lo`. Without the
     * clamp a heavy sky drops its lowest sheets straight into the fade and the
     * lid comes out half-dissolved — which looks exactly like the haze this
     * was all meant to stop being.
     */
    const floorY = c.guard.lo + scale * 0.46 + 0.02;
    /*
     * And spread across more of the band when it is covered.
     *
     * The guard will not let the lid come down to the office, so the only
     * room a heavy sky has is upward — and a bank of sheets stacked at four
     * heights reads as a ceiling with depth in it, where one course at one
     * height reads as a stripe. Spreading rather than dropping is the move the
     * constraint allows.
     */
    const reach = (band.hi - band.lo) * w.spread;
    out[base + 1] = Math.max(floorY, band.lo - w.drop + rand(seed, i, 1) * reach);
    out[base + 2] = scale;

    // Which slots are used at all, decided by a per-slot draw against the
    // weather's fill rather than by taking the first N — so turning the
    // weather up adds clouds between the ones already there.
    const drawn = rand(seed, i, 4) < w.fill;
    out[base + 3] = drawn ? Math.min(1, alpha * w.alpha) * (0.72 + 0.28 * rand(seed, i, 3)) : 0;

    if (!shape) continue;
    const kindRoll = rand(seed, i, 5);
    // Cirrus belongs to a clear sky and to the far layer: it is the highest
    // thing there is, and putting a wisp in front of an overcast sheet is
    // backwards.
    const kind = w.cirrus > 0 && isFar && kindRoll < w.cirrus ? CIRRUS : w.sheet ? STRATUS : CUMULUS;
    const sbase = i * SHAPE_STRIDE;
    shape[sbase] = kind;
    shape[sbase + 1] = kind === CIRRUS ? 2.8 + rand(seed, i, 6) * 1.6 : w.stretch * (0.8 + rand(seed, i, 6) * 0.45);
    // A cumulus ignores stretch — only the sheet shape reads it — so a busy
    // sky gets its weight from `size` instead; see above.
    shape[sbase + 2] = (rand(seed, i, 7) - 0.5) * (kind === CIRRUS ? 0.22 : 0.06);
    shape[sbase + 3] = i + 1;
  }
}

export interface Flash {
  /** 0 when nothing is happening. */
  strength: number;
  /** Where it is, in screen-heights from the centre. */
  x: number;
  y: number;
}

/**
 * Sheet lightning, on the same slot-and-chance clock the flock uses.
 *
 * The envelope is the whole of it: a hard leading edge, a dip, a second
 * weaker stroke, and a long tail. That double-stroke is what the eye reads as
 * lightning rather than as somebody turning a light on, and it is the reason
 * this is worth a function instead of a sine.
 */
export function flashAt(time: number, seed: number, aspect: number, out: Flash): Flash {
  const f = ATMOSPHERE.flash;
  out.strength = 0;
  if (!(time >= 0)) return out;

  const slot = Math.floor(time / f.period);
  if (rand(seed, slot, 21) > f.chance) return out;

  const start = rand(seed, slot, 22) * (f.period - f.lasts);
  const u = (time - slot * f.period - start) / f.lasts;
  if (u < 0 || u > 1) return out;

  // Two strokes and a decay. Nothing here is symmetrical, on purpose.
  const first = Math.exp(-u * 26) ;
  const second = 0.52 * Math.exp(-Math.abs(u - 0.26) * 34);
  const afterglow = 0.3 * Math.exp(-u * 4.2);
  out.strength = Math.min(1, (first + second + afterglow)) * f.strength;
  out.x = (rand(seed, slot, 23) - 0.5) * aspect * 0.8;
  out.y = ATMOSPHERE.cloud.bandNear.lo + rand(seed, slot, 24) * 0.14;
  return out;
}

export function createFlash(): Flash {
  return { strength: 0, x: 0, y: 0.8 };
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
 * The same tones, with the weather taken into account.
 *
 * A fair-weather cloud borrows the warm end of the palette, which is right for
 * a cloud with sun on it and quite wrong for a lid: an overcast sky is grey
 * because it is *unlit*, and a warm grey lid reads as smog. Pulling both tones
 * toward the neutral of the sky they sit in — and darkening the underside,
 * which is the half you can actually see — is what makes the difference
 * between weather and a dirty window.
 */
export function overcastTones(tones: AtmosphereTones, theme: ResolvedTheme, grey: number): AtmosphereTones {
  if (grey <= 0) return tones;
  const neutral = mixHex(theme.sky[2], greyOf(theme.sky[2]), 0.88);
  return {
    ...tones,
    cloudLight: mixHex(tones.cloudLight, neutral, grey * 0.85),
    // The base of a sheet is the part in its own shadow, and it is the part
    // the office is looking up at.
    cloudDark: mixHex(tones.cloudDark, mixHex(neutral, '#3A3D48', 0.4), grey * 0.95),
  };
}

function greyOf(hex: string): string {
  const v = Math.round(luma(hex) * 255);
  return `#${((1 << 24) | (v << 16) | (v << 8) | v).toString(16).slice(1)}`;
}

/**
 * The birds that land on the office, as a colour.
 *
 * Not the flock in the sky — those are a mark on a background and can be as
 * dark as ink. These are lit by the same shader as everything else, which
 * multiplies whatever it is given by a near-white face tone, so a colour
 * chosen to look right in the palette comes out almost exactly that colour on
 * screen. The first pass used a near-black and the birds landed on the campus
 * as holes in it.
 *
 * Dark enough to read against a pale terrace, light enough to keep a facet on
 * it, and taken off the theme so it is never a colour the office does not
 * already own.
 */
export function perchTone(theme: ResolvedTheme): string {
  if (theme.ink !== undefined) return mixHex(theme.ink, theme.tones.top, 0.28);
  return mixHex(theme.tones.right, '#3B3743', 0.42);
}

export interface RidgeTones {
  near: string;
  far: string;
}

/**
 * What the distance is made of.
 *
 * A shade off the sky it stands against, and nothing else. Everything starts
 * from `sky[0]` — the bottom of the gradient, which is the band the distance
 * actually sits in — so it warms at dusk and goes blue at noon without anybody
 * writing a case for either, and it can never come out darker than the palette
 * allows.
 *
 * `near` is the rock and `far` is the deck above it, which is the same two-tone
 * split every platform in the office is cut from; `Distance` then washes both
 * toward the sky by how far out the piece stands. There is no top-face tone
 * here any more: these are real solids now, and the facet shader gives every
 * upward face its own colour the way it does for the office itself.
 */
export function horizonTones(theme: ResolvedTheme): RidgeTones {
  const horizon = theme.sky[0];
  if (theme.ink !== undefined) {
    // The flat theme prints them instead, away from the paper by a fixed
    // amount — the same reasoning its clouds answer to.
    const inked = luma(horizon) > 0.5 ? '#000000' : '#FFFFFF';
    return { near: mixHex(horizon, inked, 0.2), far: mixHex(horizon, inked, 0.1) };
  }
  /*
   * Darker than the sky it stands against, always.
   *
   * Taking the rock off the palette alone worked by day and lost the horizon
   * entirely after dark, because at midnight the deep face tone is *lighter*
   * than the sky and the ridge came out as a pale band nobody could see.
   * Shading the horizon itself is the rule that holds at every hour: a
   * backlit mountain is a hole in whatever is behind it, which by day is a
   * blue-grey band and at night is a piece of sky with no stars in it.
   */
  const rock = mixHex(shade(horizon, 0.62), theme.tones.right, 0.28);
  return { near: mixHex(horizon, rock, 0.8), far: mixHex(horizon, rock, 0.38) };
}

/** Multiplies every channel, which is the one operation that never inverts. */
function shade(hex: string, by: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const c = (v: number): number => Math.max(0, Math.min(255, Math.round(v * by)));
  const out = (c((n >> 16) & 255) << 16) | (c((n >> 8) & 255) << 8) | c(n & 255);
  return `#${((1 << 24) | out).toString(16).slice(1)}`;
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
