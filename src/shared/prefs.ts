/**
 * Everything the app remembers between launches.
 *
 * One flat, versioned object, read tolerantly: a prefs file written by an older
 * build must never crash a newer one, and an unknown key is left alone rather
 * than dropped, so downgrading does not lose settings either.
 */

import type { DataMode } from './model';

export type MotionMode = 'auto' | 'reduced' | 'full';

export interface SoundPrefs {
  /** Ambient music. There are no sound effects: the office is quiet. */
  enabled: boolean;
  /** 0–1. */
  master: number;
}

/** How busy a generated world is allowed to be. */
export type OfficeDetail = 'quiet' | 'composed' | 'ornate';

export interface CameraPrefs {
  azimuth: number;
  polar: number;
  /** Multiplier on the fitted framing, not an absolute zoom. */
  zoom: number;
}

/*
 * There was an idle sway here, and a setting to turn it on.
 *
 * It was kept as a choice on the theory that at high pixel density the crawl
 * would be invisible and the breathing lovely. It is not: two degrees over
 * ninety seconds moves every edge in the office by a fraction of a pixel per
 * frame, which is the worst possible amount — flat-shaded geometry against
 * flat-shaded geometry has no gradient for the sampler to hide in, so the
 * silhouettes crawl instead of drifting. Offering it at all meant the app
 * shipped a switch whose only function was to make the picture buzz, and it
 * got turned on and reported as a bug. Removed rather than defaulted off.
 */

export interface GroupPref {
  id: string;
  name: string;
  colorIndex: number;
  /** Slot ids the user put in this group by hand. */
  members: string[];
}

export interface Prefs {
  version: number;
  theme: {
    office: string;
    canvas: string;
    /** "HH:MM" pins the lighting; null follows the real clock. */
    pinnedClock: string | null;
  };
  motion: MotionMode;
  sound: SoundPrefs;
  /** Real sessions, or the generated office. Never both. */
  mode: DataMode;
  camera: CameraPrefs;
  office: {
    /** Desk placements, so the floor plan survives a restart. */
    deskCells: Record<string, [number, number]>;
    /**
     * The world's seed: which way its terraces step, what it is built out of.
     * Rolled once on first run and kept, because an office that rearranges
     * itself every launch is a different place each time rather than yours.
     */
    worldSeed: number;
    /** Caretakers: figures that stand for nothing, so the place feels lived in. */
    npcs: boolean;
    /**
     * How much the world builds on itself.
     *
     * The vocabulary grew faster than the restraint did: colonnades, domes,
     * minarets, screens, ghats, aqueducts, raised terraces, roofs, lifts,
     * spirals — every one of them good, and all of them at once is a curiosity
     * shop. Elegance here is a subtraction problem, and how much to subtract is
     * a matter of taste rather than of correctness, so it is a setting.
     *
     * `quiet` is a few large gestures and a great deal of nothing. `composed`
     * is the house style. `ornate` builds everything it is allowed to.
     */
    detail: OfficeDetail;
  };
  canvas: {
    sizes: Record<string, [number, number]>;
    offsets: Record<string, [number, number]>;
  };
  groups: GroupPref[];
  /** Sessions started by the SDK rather than by a person. */
  hideSdkSessions: boolean;
  /** How long an ended session's desk is kept before it folds away. */
  endedGraceMs: number;
}

export const DETAILS: readonly OfficeDetail[] = ['quiet', 'composed', 'ornate'];

export const PREFS_VERSION = 3;

export const DEFAULT_PREFS: Prefs = {
  version: PREFS_VERSION,
  theme: { office: 'monument', canvas: 'nodeterm', pinnedClock: null },
  motion: 'auto',
  sound: { enabled: false, master: 0.5 },
  mode: 'real',
  camera: { azimuth: Math.PI * 0.25, polar: 0.955, zoom: 1 },
  office: { deskCells: {}, worldSeed: 0, npcs: true, detail: 'composed' },
  canvas: { sizes: {}, offsets: {} },
  groups: [],
  hideSdkSessions: true,
  endedGraceMs: 10 * 60_000,
};

/** A deep partial, so a caller can patch one nested field. */
export type PrefsPatch = {
  [K in keyof Prefs]?: Prefs[K] extends object ? Partial<Prefs[K]> : Prefs[K];
};

/**
 * Fills in whatever the stored file is missing.
 *
 * Deliberately shallow-per-section: sections are small and independent, and a
 * generic deep merge would happily merge a `Record` of desk cells into the
 * defaults and resurrect desks the user has long since closed.
 *
 * Listing the sections by hand is also how a retired one is migrated away: a
 * file written by an older build still carries `usage.source`, and simply not
 * reading it forward drops it the next time prefs are written.
 */
export function mergePrefs(stored: unknown): Prefs {
  if (!stored || typeof stored !== 'object') return structuredCloneish(DEFAULT_PREFS);
  const input = stored as Partial<Prefs>;
  const from = typeof input.version === 'number' ? input.version : 0;

  /*
   * Changing a default does nothing for anyone who already has a prefs file:
   * the stored value wins, for ever. The idle camera sway shipped on, was
   * found to make every edge in the office crawl, and was turned off — and the
   * only people who saw the fix were the ones who had never opened the app.
   * A version bump that drops the stored value is what actually delivers it.
   */
  // `drift` was version 2's mistake and is gone; a stored one is dropped on
  // the floor here rather than carried forward into an object that no longer
  // has a field for it.
  const { azimuth, polar, zoom } = { ...DEFAULT_PREFS.camera, ...input.camera };
  const camera = { azimuth, polar, zoom };
  void from;

  return {
    version: PREFS_VERSION,
    theme: { ...DEFAULT_PREFS.theme, ...input.theme },
    motion: input.motion ?? DEFAULT_PREFS.motion,
    sound: { ...DEFAULT_PREFS.sound, ...input.sound },
    mode: input.mode === 'simulation' ? 'simulation' : 'real',
    camera,
    office: {
      deskCells: prunedCells(input.office?.deskCells),
      // 0 means "not rolled yet"; the office rolls one and saves it.
      worldSeed: Number.isFinite(input.office?.worldSeed) ? (input.office?.worldSeed as number) : 0,
      npcs: input.office?.npcs ?? DEFAULT_PREFS.office.npcs,
      detail: DETAILS.includes(input.office?.detail as OfficeDetail)
        ? (input.office?.detail as OfficeDetail)
        : DEFAULT_PREFS.office.detail,
    },
    canvas: { sizes: input.canvas?.sizes ?? {}, offsets: input.canvas?.offsets ?? {} },
    groups: Array.isArray(input.groups) ? input.groups : [],
    hideSdkSessions: input.hideSdkSessions ?? DEFAULT_PREFS.hideSdkSessions,
    endedGraceMs: input.endedGraceMs ?? DEFAULT_PREFS.endedGraceMs,
  };
}

/** Applies a patch section by section, so `{theme:{office:'ink'}}` keeps the rest. */
export function applyPatch(current: Prefs, patch: PrefsPatch): Prefs {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const field = key as keyof Prefs;
    const existing = current[field];
    if (value && typeof value === 'object' && !Array.isArray(value) && existing && typeof existing === 'object') {
      (next as Record<string, unknown>)[field] = { ...(existing as object), ...(value as object) };
    } else {
      (next as Record<string, unknown>)[field] = value;
    }
  }
  next.version = PREFS_VERSION;
  return next;
}

/**
 * Desk placements accumulate: a slot id is remembered for ever and a busy
 * machine had eighty-one of them for a dozen live sessions. They are only ever
 * consulted for sessions that exist, so the tail is dead weight in a file that
 * is rewritten constantly — and a long enough tail starts costing real time on
 * every save.
 */
const MAX_REMEMBERED_DESKS = 48;

function prunedCells(cells: Record<string, [number, number]> | undefined): Record<string, [number, number]> {
  if (!cells) return {};
  const entries = Object.entries(cells);
  if (entries.length <= MAX_REMEMBERED_DESKS) return cells;
  return Object.fromEntries(entries.slice(-MAX_REMEMBERED_DESKS));
}

function structuredCloneish(prefs: Prefs): Prefs {
  return JSON.parse(JSON.stringify(prefs)) as Prefs;
}
