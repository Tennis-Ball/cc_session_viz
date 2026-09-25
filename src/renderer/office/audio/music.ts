/**
 * The music of the office.
 *
 * Wallpaper, not a soundtrack. Everything is synthesised — no samples to bundle
 * or license — and the piece is generated rather than looped, because anything
 * with a period short enough to hear becomes unbearable by the second hour.
 *
 * The shape is a slow chord pad with sparse bell notes drifting over it, both
 * soaked in a procedural reverb. Harmony walks a small Markov chain inside a
 * modal centre and occasionally drifts to a neighbouring key, so the ear never
 * gets a phrase it can predict. There is no pulse anywhere: chord changes and
 * motif notes are both irregular by construction, which is what stops this
 * reading as music you are supposed to listen to.
 *
 * Everything above the AudioContext is pure and lives at the top of the file:
 * the harmony walk, the voicing chooser and the event scheduler all run in a
 * test without any audio at all.
 */

export interface MusicOptions {
  /** 0–1 master volume. 0 means silent but still running. */
  volume: number;
  /** 0 = deep night, 1 = full day. From the office's clock-driven theme. */
  dayFactor: number;
  /** 0–1: how busy the office is (sessions working / total). Nudges density only. */
  intensity: number;
}

/** Injected so the generated piece is reproducible under test. */
export type Rng = () => number;

// ---------------------------------------------------------------- tuning

/** Two chords may overlap while they cross-fade, never three — see `advanceChord`. */
export const MAX_PAD_NOTES = 4;
export const MAX_MOTIF_VOICES = 4;
export const MAX_VOICES = MAX_PAD_NOTES * 2 + MAX_MOTIF_VOICES;

/** Chords before the key is allowed to move at all: roughly four minutes. */
const CHORDS_BEFORE_MODULATION = 16;
const MODULATION_CHANCE = 0.22;

/** How much of the chord is spent cross-fading. The rest is the hold. */
const CROSSFADE_SHARE = 0.32;
const MAX_CROSSFADE_SEC = 5;

const SCHEDULE_INTERVAL_MS = 25;
const LOOKAHEAD_SEC = 0.2;
const FADE_SEC = 2;

/** One `update` per second, so this is roughly an eight-second time constant. */
const OPTION_SMOOTHING = 0.12;

/** Zero is not a legal target for an exponential ramp, and is inaudible anyway. */
const SILENT = 0.0001;

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const pitchClass = (semitones: number): number => ((semitones % 12) + 12) % 12;

export function midiToHz(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

// ---------------------------------------------------------------- harmony

export type ModeName = 'lydian' | 'dorian';

/**
 * Lydian and Dorian rather than major and minor: both have one note that leans
 * out of the common-practice chord it sits on, which is exactly the colour that
 * keeps a slow pad sounding suspended instead of resolved.
 */
const SCALES: Record<ModeName, readonly number[]> = {
  lydian: [0, 2, 4, 6, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
};

interface ModeSpec {
  /** Scale degrees (0-based) used as chord roots. */
  degrees: readonly number[];
  labels: readonly string[];
  /** Weighted successors, as indices into `degrees`. Repeats are the weights. */
  transitions: readonly (readonly number[])[];
}

/**
 * Five chords per mode, each able to reach all four others.
 *
 * Reachability matters twice over: the repetition guard below throws candidates
 * away and can only do that safely if something legal is always left, and the
 * wider the alphabet the longer it takes for a phrase to come round again.
 */
const MODES: Record<ModeName, ModeSpec> = {
  lydian: {
    degrees: [0, 1, 5, 4, 2],
    labels: ['I', 'II', 'vi', 'V', 'iii'],
    transitions: [
      [1, 2, 3, 4, 2],
      [0, 2, 3, 4],
      [1, 3, 0, 4, 3],
      [0, 2, 1, 4],
      [2, 1, 0, 3],
    ],
  },
  dorian: {
    degrees: [0, 3, 6, 1, 4],
    labels: ['i', 'IV', 'bVII', 'ii', 'v'],
    transitions: [
      [1, 2, 3, 1, 4],
      [0, 2, 3, 4],
      [1, 0, 3, 0, 4],
      [0, 1, 2, 4],
      [0, 1, 2, 3],
    ],
  },
};

export interface Centre {
  /** Pitch class of the mode's tonic, 0–11. */
  tonicPc: number;
  mode: ModeName;
  name: string;
}

/**
 * A line of keys, not a ring.
 *
 * Neighbours share a pitch collection or sit one accidental apart, so a
 * modulation is a tilt rather than a cut; the walk reflects at the ends so the
 * key wanders instead of circling back to where it started.
 */
export const CENTRES: readonly Centre[] = [
  { tonicPc: 10, mode: 'lydian', name: 'Bb lydian' },
  { tonicPc: 7, mode: 'dorian', name: 'G dorian' },
  { tonicPc: 5, mode: 'lydian', name: 'F lydian' },
  { tonicPc: 2, mode: 'dorian', name: 'D dorian' },
  { tonicPc: 9, mode: 'dorian', name: 'A dorian' },
  { tonicPc: 0, mode: 'lydian', name: 'C lydian' },
];

export interface Chord {
  centre: number;
  name: string;
  tonicPc: number;
  mode: ModeName;
  /** Chord tones as semitones above the tonic pitch class, ascending, root first. */
  intervals: readonly number[];
  /** Every tone of the parent scale, semitones above the tonic pitch class. */
  scale: readonly number[];
  /** Identity for the repetition guard: centre and degree together. */
  key: number;
}

export interface HarmonyState {
  centre: number;
  degreeIndex: number;
  /** Which way the last modulation went, so the key drifts rather than see-saws. */
  drift: 1 | -1;
  chordsSinceModulation: number;
  /** Recent chord keys, newest last. */
  history: readonly number[];
}

function centreAt(index: number): Centre {
  const centre = CENTRES[index] ?? CENTRES[0];
  // CENTRES is a non-empty literal; the fallback only exists for the type.
  return centre ?? { tonicPc: 0, mode: 'lydian', name: 'C lydian' };
}

/** Semitones above the tonic for a scale step, wrapping into higher octaves. */
function scaleTone(mode: ModeName, step: number): number {
  const scale = SCALES[mode];
  const octave = Math.floor(step / scale.length);
  return (scale[step - octave * scale.length] ?? 0) + octave * 12;
}

export function chordOf(state: HarmonyState): Chord {
  const centre = centreAt(state.centre);
  const spec = MODES[centre.mode];
  const degree = spec.degrees[state.degreeIndex] ?? 0;
  // Stacked thirds inside the mode, which is what makes a chord belong to it.
  const intervals = [0, 2, 4, 6].map((step) => scaleTone(centre.mode, degree + step));
  return {
    centre: state.centre,
    name: `${centre.name} ${spec.labels[state.degreeIndex] ?? '?'}`,
    tonicPc: centre.tonicPc,
    mode: centre.mode,
    intervals,
    scale: SCALES[centre.mode],
    key: state.centre * 8 + state.degreeIndex,
  };
}

export function createHarmony(rng: Rng): HarmonyState {
  return {
    centre: Math.min(CENTRES.length - 1, Math.floor(rng() * CENTRES.length)),
    degreeIndex: 0,
    drift: rng() < 0.5 ? 1 : -1,
    chordsSinceModulation: 0,
    history: [],
  };
}

/** A-B-A-B is the pattern the ear locks onto first, so it is banned outright. */
function isSeesaw(history: readonly number[], candidate: number): boolean {
  const n = history.length;
  return n >= 3 && candidate === history[n - 2] && history[n - 1] === history[n - 3];
}

/**
 * Any phrase played twice in a row is a loop, and at ten-odd seconds a chord a
 * eight-chord phrase is still inside the few minutes the ear holds on to.
 */
function isStale(history: readonly number[], candidate: number): boolean {
  if (isSeesaw(history, candidate)) return true;
  const h = [...history, candidate];
  for (let len = 3; len <= 8; len++) {
    if (h.length < len * 2) break;
    let same = true;
    for (let i = 0; i < len && same; i++) same = h[h.length - 1 - i] === h[h.length - 1 - i - len];
    if (same) return true;
  }
  return false;
}

function pick<T>(items: readonly T[], rng: Rng, fallback: T): T {
  if (items.length === 0) return fallback;
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))] ?? fallback;
}

export function advanceHarmony(state: HarmonyState, rng: Rng): HarmonyState {
  const current = chordOf(state).key;
  // Long enough to see two eights: anything older is not a loop the ear keeps.
  const history = [...state.history, current].slice(-18);

  if (state.chordsSinceModulation >= CHORDS_BEFORE_MODULATION && rng() < MODULATION_CHANCE) {
    // Reflect at the ends rather than wrapping: the two ends of the line are
    // two accidentals apart and that step is audible as a jolt.
    let drift = state.drift;
    let centre = state.centre + drift;
    if (centre < 0 || centre >= CENTRES.length) {
      drift = drift === 1 ? -1 : 1;
      centre = state.centre + drift;
    }
    // Arriving on the new tonic is what makes the shift read as a new home.
    return { centre, degreeIndex: 0, drift, chordsSinceModulation: 0, history };
  }

  const spec = MODES[centreAt(state.centre).mode];
  const successors = spec.transitions[state.degreeIndex] ?? spec.degrees.map((_, i) => i);
  const legal = successors.filter((index) => index !== state.degreeIndex);
  const fresh = legal.filter((index) => !isStale(history, state.centre * 8 + index));
  // Staleness can empty the pool; the see-saw ban never can, because every
  // chord has three distinct successors and this rules out at most one.
  const pool = fresh.length > 0 ? fresh : legal.filter((index) => !isSeesaw(history, state.centre * 8 + index));

  return {
    centre: state.centre,
    degreeIndex: pick(pool.length > 0 ? pool : legal, rng, state.degreeIndex),
    drift: state.drift,
    chordsSinceModulation: state.chordsSinceModulation + 1,
    history,
  };
}

// ---------------------------------------------------------------- voicing

/**
 * Lays the chord out as midi notes with its root near `rootMidi`.
 *
 * Tones are stacked upward with at least a whole tone between them: seconds
 * beat badly on sustained sines, and a pad that beats sounds broken rather than
 * atmospheric. The seventh is optional and the top note sometimes lifts an
 * octave, which is the whole of the texture's variety.
 */
export function chooseVoicing(chord: Chord, rootMidi: number, rng: Rng): number[] {
  const count = rng() < 0.45 ? MAX_PAD_NOTES : MAX_PAD_NOTES - 1;
  const notes: number[] = [];
  let previous = -Infinity;

  for (let i = 0; i < count && i < chord.intervals.length; i++) {
    const pc = pitchClass(chord.tonicPc + (chord.intervals[i] ?? 0));
    if (i === 0) {
      previous = pc + 12 * Math.round((rootMidi - pc) / 12);
    } else {
      previous = pc + 12 * Math.ceil((previous + 2 - pc) / 12);
    }
    notes.push(previous);
  }

  const top = notes.length - 1;
  if (top > 1 && rng() < 0.3) notes[top] = (notes[top] ?? 0) + 12;
  return notes;
}

/**
 * One note of the current scale, near `centreMidi`, chord tones favoured.
 *
 * `avoid` is the note that just sounded: repeating a pitch immediately is the
 * one thing that makes sparse notes sound like a melody rather than weather.
 */
export function chooseMotifNote(chord: Chord, centreMidi: number, avoid: number, rng: Rng): number {
  const chordTones = new Set(chord.intervals.map((interval) => pitchClass(chord.tonicPc + interval)));
  const pool: number[] = [];

  for (const tone of chord.scale) {
    const pc = pitchClass(chord.tonicPc + tone);
    const base = pc + 12 * Math.round((centreMidi - pc) / 12);
    for (const note of [base - 12, base, base + 12]) {
      if (note < centreMidi - 8 || note > centreMidi + 12) continue;
      const weight = chordTones.has(pc) ? 3 : 1;
      for (let w = 0; w < weight; w++) pool.push(note);
    }
  }

  const fresh = pool.filter((note) => note !== avoid);
  return pick(fresh.length > 0 ? fresh : pool, rng, Math.round(centreMidi));
}

// ---------------------------------------------------------------- shape

/** Everything the options imply, in musical terms. Pure, and the only place day/night lives. */
export interface Shape {
  /** Midi note the chord's lowest voice sits nearest. */
  padRoot: number;
  /** Midi note the motif orbits. */
  motifCentre: number;
  /** Nominal seconds a chord sounds, before jitter. */
  chordSec: number;
  /** Nominal seconds between motif slots. */
  motifGapSec: number;
  /** How often a motif slot actually sounds; the rest are silence. */
  motifChance: number;
  motifDecaySec: number;
  padCutoffHz: number;
  padLevel: number;
  motifLevel: number;
  /** 0–1 blend from the short room toward the long hall. */
  hallMix: number;
  wetLevel: number;
}

/**
 * Day and night are a different piece of furniture, not a volume knob: the
 * register lifts, the chords move sooner, notes fall more often and ring less,
 * and the room shrinks from a cathedral to something closer to a hall.
 *
 * Intensity only ever leans on the two things a busy office should nudge —
 * how often a note falls, and how open the pad is. Everything else ignores it.
 */
export function shapeFor(options: MusicOptions): Shape {
  const day = clamp01(options.dayFactor);
  const busy = clamp01(options.intensity);
  const brightness = clamp01(0.3 + 0.55 * day + 0.15 * busy);

  return {
    padRoot: lerp(40, 52, day),
    motifCentre: lerp(64, 76, day),
    chordSec: lerp(16, 11, day),
    motifGapSec: lerp(11.5, 7, day) * (1 - 0.22 * busy),
    motifChance: clamp01(lerp(0.6, 0.78, day) + 0.08 * busy),
    motifDecaySec: lerp(6, 4.2, day),
    padCutoffHz: 360 * Math.pow(2, brightness * 3.4),
    padLevel: lerp(0.88, 1, day),
    motifLevel: lerp(0.6, 0.9, day),
    hallMix: lerp(0.85, 0.3, day),
    wetLevel: lerp(0.62, 0.48, day),
  };
}

/** Exponential approach, so a jump in the clock or the workload is never a jump in sound. */
export function smoothOptions(current: MusicOptions, target: MusicOptions, alpha = OPTION_SMOOTHING): MusicOptions {
  const t = clamp01(alpha);
  return {
    volume: lerp(clamp01(current.volume), clamp01(target.volume), t),
    dayFactor: lerp(clamp01(current.dayFactor), clamp01(target.dayFactor), t),
    intensity: lerp(clamp01(current.intensity), clamp01(target.intensity), t),
  };
}

// ---------------------------------------------------------------- scheduling

export interface ChordEvent {
  kind: 'chord';
  /** Context time. */
  at: number;
  /** Total sounding length, both cross-fades included. */
  durationSec: number;
  fadeSec: number;
  notes: number[];
  name: string;
}

export interface MotifEvent {
  kind: 'motif';
  at: number;
  note: number;
  /** 0–1, before the master and volume gains. */
  level: number;
  decaySec: number;
}

export type MusicEvent = ChordEvent | MotifEvent;

export function endOf(event: MusicEvent): number {
  return event.kind === 'chord' ? event.at + event.durationSec : event.at + event.decaySec;
}

function voicesOf(event: MusicEvent): number {
  return event.kind === 'chord' ? event.notes.length : 1;
}

/** The most notes sounding at once anywhere in the run. Proves the cap. */
export function peakVoices(events: readonly MusicEvent[], kind?: MusicEvent['kind']): number {
  const edges: { at: number; delta: number }[] = [];
  for (const event of events) {
    if (kind && event.kind !== kind) continue;
    edges.push({ at: event.at, delta: voicesOf(event) });
    edges.push({ at: endOf(event), delta: -voicesOf(event) });
  }
  // Ends before starts at the same instant: a note that stops is gone.
  edges.sort((a, b) => a.at - b.at || a.delta - b.delta);

  let live = 0;
  let peak = 0;
  for (const edge of edges) {
    live += edge.delta;
    peak = Math.max(peak, live);
  }
  return peak;
}

export interface SchedulerState {
  harmony: HarmonyState;
  /** The chord currently sounding — what the motif draws its notes from. */
  sounding: Chord;
  nextChordAt: number;
  nextMotifAt: number;
  /** End times of motif notes still ringing, for the concurrency cap. */
  motifEnds: number[];
  lastMotifNote: number;
}

export function createScheduler(startAt: number, rng: Rng): SchedulerState {
  const harmony = createHarmony(rng);
  return {
    harmony,
    sounding: chordOf(harmony),
    nextChordAt: startAt,
    // The pad establishes the key before anything is allowed to sing over it.
    nextMotifAt: startAt + 6,
    motifEnds: [],
    lastMotifNote: 0,
  };
}

/**
 * Drags a stalled scheduler back to the present.
 *
 * A throttled renderer (hidden window, sleeping machine) can leave the interval
 * unfired for minutes. Without this the next tick would try to schedule every
 * missed event at once, all of them in the past, which the spec turns into a
 * single burst of everything at the same instant.
 */
export function rebase(state: SchedulerState, now: number, tolerance = 1): boolean {
  const earliest = Math.min(state.nextChordAt, state.nextMotifAt);
  if (earliest >= now - tolerance) return false;
  const skew = now - earliest;
  state.nextChordAt += skew;
  state.nextMotifAt += skew;
  state.motifEnds = state.motifEnds.filter((end) => end > now);
  return true;
}

/**
 * Everything due between `state`'s cursors and `until`, in ascending time.
 *
 * Mutates the cursors, which is the point: the caller runs this every 25 ms
 * against `context.currentTime` and hands whatever comes back to the graph, so
 * note timing rides the audio clock rather than the timer.
 */
export function collectEvents(state: SchedulerState, until: number, shape: Shape, rng: Rng): MusicEvent[] {
  const events: MusicEvent[] = [];

  for (let guard = 0; guard < 128; guard++) {
    const next = Math.min(state.nextChordAt, state.nextMotifAt);
    if (next >= until) break;

    if (state.nextChordAt <= state.nextMotifAt) events.push(emitChord(state, shape, rng));
    else {
      const motif = emitMotif(state, shape, rng);
      if (motif) events.push(motif);
    }
  }
  return events;
}

function emitChord(state: SchedulerState, shape: Shape, rng: Rng): ChordEvent {
  const chord = chordOf(state.harmony);
  // Jittered length: equal chords are a bar line, and a bar line is a pulse.
  const durationSec = shape.chordSec * (0.85 + 0.3 * rng());
  const fadeSec = Math.min(MAX_CROSSFADE_SEC, durationSec * CROSSFADE_SHARE);

  const event: ChordEvent = {
    kind: 'chord',
    at: state.nextChordAt,
    durationSec,
    fadeSec,
    notes: chooseVoicing(chord, shape.padRoot, rng),
    name: chord.name,
  };

  state.sounding = chord;
  // The next chord starts inside this one's fade-out, so they cross rather than
  // butt together. `durationSec - fadeSec` always exceeds `fadeSec`, which is
  // what keeps three chords from ever sounding at once.
  state.nextChordAt += durationSec - fadeSec;
  state.harmony = advanceHarmony(state.harmony, rng);
  return event;
}

function emitMotif(state: SchedulerState, shape: Shape, rng: Rng): MotifEvent | null {
  const at = state.nextMotifAt;
  // Wide, uneven gaps. The slot may also pass in silence, which is what opens
  // the long holes that stop the motif reading as a line.
  state.nextMotifAt += shape.motifGapSec * (0.4 + 1.5 * rng());

  state.motifEnds = state.motifEnds.filter((end) => end > at);
  if (state.motifEnds.length >= MAX_MOTIF_VOICES) return null;
  if (rng() >= shape.motifChance) return null;

  const note = chooseMotifNote(state.sounding, shape.motifCentre, state.lastMotifNote, rng);
  const decaySec = shape.motifDecaySec * (0.8 + 0.4 * rng());
  state.lastMotifNote = note;
  state.motifEnds.push(at + decaySec);

  return { kind: 'motif', at, note, level: shape.motifLevel * (0.6 + 0.4 * rng()), decaySec };
}

// ---------------------------------------------------------------- the engine

/** Three detuned layers per chord note: the beating between them is the texture. */
const PAD_LAYERS: readonly (readonly [OscillatorType, number, number])[] = [
  ['sine', 0, 1],
  ['triangle', 7, 0.34],
  ['sine', -9, 0.6],
];
const PAD_PEAK = 0.13;

/** Ratio, weight, decay share. Slightly inharmonic, so it rings like metal rather than a flute. */
const MOTIF_PARTIALS: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [2.01, 0.3, 0.55],
  [3.02, 0.11, 0.3],
];
const MOTIF_PEAK = 0.05;

const ROOM_TAIL_SEC = 3;
const HALL_TAIL_SEC = 5;

const DEFAULTS: MusicOptions = { volume: 0.5, dayFactor: 0.5, intensity: 0 };

interface Graph {
  master: GainNode;
  mix: GainNode;
  padGain: GainNode;
  padFilter: BiquadFilterNode;
  padPan: StereoPannerNode;
  motifGain: GainNode;
  roomSend: GainNode;
  hallSend: GainNode;
  width: OscillatorNode;
}

export class OfficeMusic {
  private readonly rng: Rng;
  private context: AudioContext | null = null;
  private graph: Graph | null = null;
  private state: SchedulerState | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private teardown: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every start/stop so a late teardown from an old stop is ignored. */
  private generation = 0;

  private running = false;
  private disposed = false;
  private options: MusicOptions = DEFAULTS;
  private target: MusicOptions = DEFAULTS;
  private shape: Shape = shapeFor(DEFAULTS);

  /** Live sources, so a stop can silence what is already scheduled. */
  private voices = new Set<OscillatorNode>();

  constructor(rng: Rng = Math.random) {
    this.rng = rng;
  }

  get playing(): boolean {
    return this.running || this.teardown !== null;
  }

  start(): void {
    if (this.disposed) return;
    const context = this.ensureContext();
    if (!context) return;

    // A context created before any gesture starts suspended, and resume() can
    // reject for reasons we cannot do anything about. Ask every time; the tick
    // asks again until it takes.
    void context.resume().catch(() => undefined);
    if (this.running) return;

    this.running = true;
    this.generation++;
    if (this.teardown !== null) {
      clearTimeout(this.teardown);
      this.teardown = null;
    }

    const graph = this.ensureGraph(context);
    const now = context.currentTime;
    rampTo(graph.master.gain, 1, now, FADE_SEC);

    if (this.state) rebase(this.state, now + 0.1, 0);
    else this.state = createScheduler(now + 0.1, this.rng);

    this.applyShape(now);
    this.timer = setInterval(this.tick, SCHEDULE_INTERVAL_MS);
    this.tick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const context = this.context;
    const graph = this.graph;
    if (!context || !graph) return;

    rampTo(graph.master.gain, 0, context.currentTime, FADE_SEC);

    // Voices already scheduled keep playing under the fade; tearing them down
    // before it finishes is the one place this could click.
    const generation = this.generation;
    this.teardown = setTimeout(() => {
      if (generation !== this.generation) return;
      this.teardown = null;
      this.silence();
    }, FADE_SEC * 1000 + 250);
  }

  /** Called about once a second. Must be cheap. */
  update(options: MusicOptions): void {
    this.target = {
      volume: clamp01(options.volume),
      dayFactor: clamp01(options.dayFactor),
      intensity: clamp01(options.intensity),
    };
    // Snapping before the first note avoids a two-minute crawl up from nothing.
    this.options = this.playing ? smoothOptions(this.options, this.target) : this.target;
    this.shape = shapeFor(this.options);
    if (this.context) this.applyShape(this.context.currentTime);
  }

  dispose(): void {
    this.disposed = true;
    this.running = false;
    this.generation++;
    if (this.timer !== null) clearInterval(this.timer);
    if (this.teardown !== null) clearTimeout(this.teardown);
    this.timer = null;
    this.teardown = null;

    this.silence();
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.graph = null;
  }

  // ---------- plumbing ----------

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    const Ctor = typeof window === 'undefined' ? undefined : window.AudioContext;
    if (!Ctor) return null;
    try {
      // Nothing here is interactive, so trade latency for a quieter CPU.
      this.context = new Ctor({ latencyHint: 'playback' });
    } catch {
      return null;
    }
    return this.context;
  }

  private ensureGraph(context: AudioContext): Graph {
    if (this.graph) return this.graph;
    const now = context.currentTime;

    const master = context.createGain();
    master.gain.setValueAtTime(SILENT, now);
    master.connect(context.destination);

    const mix = context.createGain();
    mix.gain.setValueAtTime(clamp01(this.options.volume), now);
    mix.connect(master);

    // Gentle and slow: this exists so overlapping tails cannot clip, not to
    // shape anything. A fast release here would pump audibly under the pad.
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-20, now);
    compressor.knee.setValueAtTime(14, now);
    compressor.ratio.setValueAtTime(2.5, now);
    compressor.attack.setValueAtTime(0.08, now);
    compressor.release.setValueAtTime(0.8, now);
    compressor.connect(mix);

    const bus = context.createGain();
    bus.gain.setValueAtTime(1, now);

    const dry = context.createGain();
    dry.gain.setValueAtTime(0.7, now);
    bus.connect(dry).connect(compressor);

    const wet = context.createGain();
    wet.gain.setValueAtTime(1, now);
    wet.connect(compressor);

    // Two rooms rather than one: a convolver's tail cannot be shortened, so
    // day and night cross-fade between a short room and a long hall instead.
    const roomSend = context.createGain();
    roomSend.gain.setValueAtTime(0, now);
    const room = context.createConvolver();
    room.normalize = false;
    room.buffer = makeImpulse(context, ROOM_TAIL_SEC, this.rng);
    bus.connect(roomSend).connect(room).connect(wet);

    const hallSend = context.createGain();
    hallSend.gain.setValueAtTime(0, now);
    const hall = context.createConvolver();
    hall.normalize = false;
    hall.buffer = makeImpulse(context, HALL_TAIL_SEC, this.rng);
    bus.connect(hallSend).connect(hall).connect(wet);

    const padPan = context.createStereoPanner();
    padPan.pan.setValueAtTime(0, now);
    padPan.connect(bus);

    const padFilter = context.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.Q.setValueAtTime(0.5, now);
    padFilter.frequency.setValueAtTime(this.shape.padCutoffHz, now);
    padFilter.connect(padPan);

    const padGain = context.createGain();
    padGain.gain.setValueAtTime(this.shape.padLevel, now);
    padGain.connect(padFilter);

    const motifGain = context.createGain();
    motifGain.gain.setValueAtTime(1, now);
    motifGain.connect(bus);

    // A minute-long sweep across the stereo field, so the pad is never a lump
    // in the middle of the head. Modulating the param means it never steps.
    const width = context.createOscillator();
    width.type = 'sine';
    width.frequency.setValueAtTime(0.017, now);
    const widthDepth = context.createGain();
    widthDepth.gain.setValueAtTime(0.5, now);
    width.connect(widthDepth).connect(padPan.pan);
    width.start(now);

    this.graph = { master, mix, padGain, padFilter, padPan, motifGain, roomSend, hallSend, width };
    return this.graph;
  }

  private applyShape(now: number): void {
    const graph = this.graph;
    if (!graph) return;
    const shape = this.shape;

    // setTargetAtTime everywhere: these are continuous controls, and a jump on
    // the filter or a send is as audible as a jump on a gain.
    graph.mix.gain.setTargetAtTime(clamp01(this.options.volume), now, 0.4);
    graph.padFilter.frequency.setTargetAtTime(shape.padCutoffHz, now, 1.5);
    graph.padGain.gain.setTargetAtTime(shape.padLevel, now, 1.5);
    graph.roomSend.gain.setTargetAtTime(shape.wetLevel * (1 - shape.hallMix), now, 2);
    graph.hallSend.gain.setTargetAtTime(shape.wetLevel * shape.hallMix, now, 2);
  }

  private tick = (): void => {
    const context = this.context;
    const state = this.state;
    const graph = this.graph;
    if (!context || !state || !graph || !this.running) return;

    if (context.state !== 'running') {
      void context.resume().catch(() => undefined);
      return;
    }

    const now = context.currentTime;
    rebase(state, now + 0.05);
    for (const event of collectEvents(state, now + LOOKAHEAD_SEC, this.shape, this.rng)) {
      // Never schedule behind the clock: the spec collapses a past time to
      // "now", which would stack a whole burst on one instant.
      const at = Math.max(event.at, now + 0.01);
      if (event.kind === 'chord') this.renderChord(event, at, graph);
      else this.renderMotif(event, at, graph);
    }
  };

  private renderChord(event: ChordEvent, at: number, graph: Graph): void {
    const context = this.context;
    if (!context) return;

    const level = PAD_PEAK / Math.max(1, event.notes.length);
    const ends = at + event.durationSec;

    for (const note of event.notes) {
      const env = context.createGain();
      env.gain.setValueAtTime(SILENT, at);
      env.gain.linearRampToValueAtTime(level, at + event.fadeSec);
      env.gain.setValueAtTime(level, ends - event.fadeSec);
      env.gain.linearRampToValueAtTime(SILENT, ends);

      // Drift is a second gain rather than a modulation of the envelope: added
      // onto the envelope it would stop the fade-out reaching silence.
      const drift = context.createGain();
      drift.gain.setValueAtTime(1, at);
      env.connect(drift).connect(graph.padGain);

      const lfo = context.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(0.04 + this.rng() * 0.09, at);
      const depth = context.createGain();
      depth.gain.setValueAtTime(0.22, at);
      lfo.connect(depth).connect(drift.gain);

      const hz = midiToHz(note);
      for (const [type, cents, weight] of PAD_LAYERS) {
        const layer = context.createGain();
        layer.gain.setValueAtTime(weight, at);
        layer.connect(env);

        const osc = context.createOscillator();
        osc.type = type;
        osc.frequency.setValueAtTime(hz, at);
        osc.detune.setValueAtTime(cents + (this.rng() - 0.5) * 5, at);
        osc.connect(layer);
        this.launch(osc, at, ends + 0.05, () => layer.disconnect());
      }

      this.launch(lfo, at, ends + 0.05, () => {
        env.disconnect();
        drift.disconnect();
        depth.disconnect();
      });
    }
  }

  private renderMotif(event: MotifEvent, at: number, graph: Graph): void {
    const context = this.context;
    if (!context) return;

    const pan = context.createStereoPanner();
    pan.pan.setValueAtTime((this.rng() * 2 - 1) * 0.6, at);
    pan.connect(graph.motifGain);

    const hz = midiToHz(event.note);
    let last = true;
    for (const [ratio, weight, decayShare] of MOTIF_PARTIALS) {
      const stops = at + event.decaySec * decayShare;

      const gain = context.createGain();
      // Bell envelope: near-instant attack, then a decay long enough that the
      // note is gone before you notice it stopped.
      gain.gain.setValueAtTime(SILENT, at);
      gain.gain.exponentialRampToValueAtTime(Math.max(SILENT * 2, MOTIF_PEAK * event.level * weight), at + 0.018);
      gain.gain.exponentialRampToValueAtTime(SILENT, stops);
      gain.connect(pan);

      const osc = context.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(hz * ratio, at);
      osc.connect(gain);

      // The fundamental rings longest, so it owns the panner.
      const owner = last;
      last = false;
      this.launch(osc, at, stops + 0.05, () => {
        gain.disconnect();
        if (owner) pan.disconnect();
      });
    }
  }

  private launch(node: OscillatorNode, at: number, stops: number, done: () => void): void {
    node.onended = () => {
      node.disconnect();
      this.voices.delete(node);
      done();
    };
    node.start(at);
    node.stop(stops);
    this.voices.add(node);
  }

  /** Hard silence. Only ever called under an already-faded master. */
  private silence(): void {
    for (const voice of this.voices) {
      try {
        voice.stop();
      } catch {
        // Already stopped, or never started: nothing left to do either way.
      }
    }
    this.voices.clear();
    this.state = null;
    if (this.context && !this.disposed) void this.context.suspend().catch(() => undefined);
  }
}

/** Every gain move in this file goes through here: cancel, anchor, ramp. */
function rampTo(param: AudioParam, target: number, now: number, seconds: number): void {
  param.cancelScheduledValues(now);
  param.setValueAtTime(Math.max(SILENT, param.value), now);
  param.linearRampToValueAtTime(Math.max(SILENT, target), now + seconds);
}

/**
 * A room, made out of noise.
 *
 * Exponentially decaying filtered noise is the cheapest thing that convolves
 * into something that sounds like air rather than a delay line. The two decay
 * terms together reach exactly zero at the end of the buffer, which matters:
 * a truncated tail is a click on every single note.
 */
function makeImpulse(context: BaseAudioContext, seconds: number, rng: Rng): AudioBuffer {
  const rate = context.sampleRate;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = context.createBuffer(2, length, rate);
  const build = Math.max(1, rate * 0.02);
  let peak = 0;

  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let pole = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // One-pole low pass: a bright tail is a hiss, and hiss is fatiguing.
      pole += 0.22 * (rng() * 2 - 1 - pole);
      const value = pole * Math.min(1, i / build) * Math.pow(1 - t, 2.2) * Math.exp(-3.2 * t);
      data[i] = value;
      peak = Math.max(peak, Math.abs(value));
    }
  }

  // One factor for both channels: scaling them apart would skew the image.
  const scale = peak > 0 ? 0.6 / peak : 1;
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (data[i] ?? 0) * scale;
  }
  return buffer;
}

export const officeMusic = new OfficeMusic();
