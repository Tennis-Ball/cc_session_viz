/**
 * Everything the app remembers between launches.
 *
 * One flat, versioned object, read tolerantly: a prefs file written by an older
 * build must never crash a newer one, and an unknown key is left alone rather
 * than dropped, so downgrading does not lose settings either.
 */

import type { DataMode } from './model';

export interface SoundPrefs {
  /** Ambient music. There are no sound effects: the office is quiet. */
  enabled: boolean;
  /** 0–1. */
  master: number;
}

/**
 * How busy a generated world is allowed to be.
 *
 * Two settings, not three. `composed` sat between them as the house style and
 * the three of them together were a slider pretending to be a choice: nobody
 * can hold three degrees of "how much architecture" in their head, and the
 * middle one is always the one nobody picks deliberately. Quiet is a few large
 * gestures and a great deal of sky; ornate is the house style, built out.
 */
export type OfficeDetail = 'quiet' | 'ornate';

/**
 * Weather over the office.
 *
 * Optional because it is scenery rather than information, and because an
 * ambient thing somebody leaves open all day should not decide on its own to
 * be grey. `clear` is the office as it has always been.
 */
export type Weather = 'clear' | 'cloudy' | 'rain';

/**
 * What stands behind the office.
 *
 * The void has no distance in it: every platform is equally far away because
 * there is nothing behind them to be further than. Something back there fixes
 * that — but it has to be built the way this world is built. The first attempt
 * was ridged noise, which is how you draw a mountain and is the one shape in
 * the vocabulary that is not made of flat faces and right angles; it read as a
 * photograph of a hill pasted behind a drawing.
 *
 * All three are the office's own geometry, seen from much further off, and all
 * three are *geometry* — they stand in the world and turn when it turns.
 * `isles` is an archipelago of small terraces on their own rock — the campus's
 * own silhouette, smaller and further off. `none` is the plain gradient, which
 * is what the app had and is still the quietest answer.
 *
 * There were three kinds. Spires and shoals were the vertical and horizontal
 * answers to the same question, and both were the wrong shape for this frame:
 * a tower out there competes with the office's own towers, and a reef lying
 * under everything is a bar across the bottom of the picture. The isles are
 * the one that reads as *somewhere else* rather than as more of here, so they
 * are what is left. A setting with three options and one good one is a choice
 * nobody should have to make.
 */
export type Horizon = 'none' | 'isles';

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

export interface Prefs {
  version: number;
  theme: {
    office: string;
    canvas: string;
    /** "HH:MM" pins the lighting; null follows the real clock. */
    pinnedClock: string | null;
  };
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
     * Room and desk names, floating over the campus.
     *
     * They are the only text in the world, and the only thing in it that is
     * not made of the same stone as everything else. For finding your own
     * session at a glance they are the whole point; for looking at the place
     * they are a dozen captions over a picture. Which of those you want is not
     * something the app can know.
     */
    labels: boolean;
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
    weather: Weather;
    horizon: Horizon;
  };
  /** Sessions started by the SDK rather than by a person. */
  hideSdkSessions: boolean;
  /** How long an ended session's desk is kept before it folds away. */
  endedGraceMs: number;
}

export const DETAILS: readonly OfficeDetail[] = ['quiet', 'ornate'];
export const WEATHERS: readonly Weather[] = ['clear', 'cloudy', 'rain'];
export const HORIZONS: readonly Horizon[] = ['none', 'isles'];

export const PREFS_VERSION = 5;

export const DEFAULT_PREFS: Prefs = {
  version: PREFS_VERSION,
  theme: { office: 'monument', canvas: 'nodeterm', pinnedClock: null },
  sound: { enabled: false, master: 0.5 },
  mode: 'real',
  camera: { azimuth: Math.PI * 0.25, polar: 1.03, zoom: 1 },
  office: { deskCells: {}, worldSeed: 0, npcs: true, labels: true, detail: 'ornate', weather: 'clear', horizon: 'isles' },
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
  // has a field for it. Version 4 drops three more the same way: `groups`,
  // which nothing ever created, and `canvas.sizes` / `canvas.offsets`, which
  // nothing ever read because a card on the board cannot be dragged or
  // resized. A settings file is a promise about what the app does; carrying
  // keys it has no code for is the same lie as a switch that does nothing.
  // Version 5 drops `motion` for the same reason — reduced motion follows the
  // system now — and retunes the camera below.
  const { azimuth, polar, zoom } = { ...DEFAULT_PREFS.camera, ...input.camera };
  /*
   * Version 5 gives the elevation back.
   *
   * The office was looked at from too high up, and the range did not reach far
   * enough down to fix it by hand — so the numbers moved, and every stored
   * camera would otherwise have kept the old view for ever. This is the same
   * argument as the sway above, and the same remedy: the one setting the fix
   * actually lives in is the one that gets dropped.
   */
  const camera = from < 5 ? { azimuth, polar: DEFAULT_PREFS.camera.polar, zoom } : { azimuth, polar, zoom };

  return {
    version: PREFS_VERSION,
    theme: { ...DEFAULT_PREFS.theme, ...input.theme },
    /*
     * Named, not spread.
     *
     * An early build had per-category toggles — `roomTone`, `keys`, `machines`,
     * `chimes` — and then the office decided it was quiet and the effects went
     * away. Spreading the stored object carried all four forward on every
     * write, so prefs files still list switches the app has had no code for in
     * months. That is the same lie as a dead switch in the UI, and it is the
     * reason this function lists sections by hand in the first place.
     */
    sound: {
      enabled: input.sound?.enabled ?? DEFAULT_PREFS.sound.enabled,
      master: typeof input.sound?.master === 'number' ? clamp01(input.sound.master) : DEFAULT_PREFS.sound.master,
    },
    mode: input.mode === 'simulation' ? 'simulation' : 'real',
    camera,
    office: {
      deskCells: prunedCells(input.office?.deskCells),
      // 0 means "not rolled yet"; the office rolls one and saves it.
      worldSeed: Number.isFinite(input.office?.worldSeed) ? (input.office?.worldSeed as number) : 0,
      npcs: input.office?.npcs ?? DEFAULT_PREFS.office.npcs,
      labels: input.office?.labels ?? DEFAULT_PREFS.office.labels,
      /*
       * A stored `composed` lands on `ornate`: it *was* the house style, and
       * ornate is now that style built out rather than the curiosity shop it
       * used to be. Quiet is the only other answer, and somebody who chose the
       * middle did not choose the sparse one.
       */
      detail: DETAILS.includes(input.office?.detail as OfficeDetail)
        ? (input.office?.detail as OfficeDetail)
        : DEFAULT_PREFS.office.detail,
      weather: WEATHERS.includes(input.office?.weather as Weather)
        ? (input.office?.weather as Weather)
        : DEFAULT_PREFS.office.weather,
      horizon: HORIZONS.includes(input.office?.horizon as Horizon)
        ? (input.office?.horizon as Horizon)
        : DEFAULT_PREFS.office.horizon,
    },
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

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
