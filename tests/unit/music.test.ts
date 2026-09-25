import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  advanceHarmony,
  CENTRES,
  chooseMotifNote,
  chooseVoicing,
  chordOf,
  collectEvents,
  createHarmony,
  createScheduler,
  endOf,
  MAX_MOTIF_VOICES,
  MAX_PAD_NOTES,
  MAX_VOICES,
  midiToHz,
  OfficeMusic,
  peakVoices,
  rebase,
  shapeFor,
  smoothOptions,
  type ChordEvent,
  type MotifEvent,
  type MusicEvent,
  type MusicOptions,
  type Rng,
  type Shape,
} from '@renderer/office/audio/music';

/** Seeded so a failing run is a failing run again. */
function seeded(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const options = (partial: Partial<MusicOptions> = {}): MusicOptions => ({
  volume: 0.5,
  dayFactor: 0.5,
  intensity: 0,
  ...partial,
});

/** Runs the scheduler the way the engine does: a small window at a time. */
function run(seconds: number, shape: Shape, seed = 1): MusicEvent[] {
  const rng = seeded(seed);
  const state = createScheduler(0, rng);
  const events: MusicEvent[] = [];
  for (let t = 0; t < seconds; t += 0.2) events.push(...collectEvents(state, t + 0.2, shape, rng));
  return events;
}

const chords = (events: readonly MusicEvent[]): ChordEvent[] =>
  events.filter((e): e is ChordEvent => e.kind === 'chord');
const motifs = (events: readonly MusicEvent[]): MotifEvent[] =>
  events.filter((e): e is MotifEvent => e.kind === 'motif');

describe('harmony', () => {
  it('never repeats a chord, and never see-saws between two', () => {
    for (const seed of [1, 7, 42, 9001]) {
      const rng = seeded(seed);
      let harmony = createHarmony(rng);
      const keys: number[] = [];
      for (let i = 0; i < 300; i++) {
        keys.push(chordOf(harmony).key);
        harmony = advanceHarmony(harmony, rng);
      }

      for (let i = 0; i + 1 < keys.length; i++) {
        expect(keys[i], `seed ${seed} repeated at ${i}`).not.toBe(keys[i + 1]);
      }
      for (let i = 0; i + 3 < keys.length; i++) {
        const seesaw = keys[i] === keys[i + 2] && keys[i + 1] === keys[i + 3];
        expect(seesaw, `seed ${seed} see-sawed at ${i}`).toBe(false);
      }
    }
  });

  it('plays no phrase twice in a row within a short window', () => {
    const rng = seeded(3);
    let harmony = createHarmony(rng);
    const keys: number[] = [];
    for (let i = 0; i < 300; i++) {
      keys.push(chordOf(harmony).key);
      harmony = advanceHarmony(harmony, rng);
    }

    // Twelve chords is two to three minutes; nothing inside that should rhyme.
    for (let len = 3; len <= 6; len++) {
      for (let i = 0; i + len * 2 <= keys.length; i++) {
        const a = keys.slice(i, i + len).join(',');
        const b = keys.slice(i + len, i + len * 2).join(',');
        expect(a, `phrase of ${len} repeated at ${i}`).not.toBe(b);
      }
    }
  });

  it('holds a key for minutes before drifting to a neighbour', () => {
    const rng = seeded(11);
    let harmony = createHarmony(rng);
    const moves: number[] = [];
    let previous = harmony.centre;

    for (let i = 0; i < 400; i++) {
      harmony = advanceHarmony(harmony, rng);
      if (harmony.centre !== previous) {
        expect(Math.abs(harmony.centre - previous), 'modulation skipped a key').toBe(1);
        moves.push(i);
        previous = harmony.centre;
      }
    }

    expect(moves.length).toBeGreaterThan(2);
    for (let i = 0; i + 1 < moves.length; i++) {
      // At ten-plus seconds a chord, sixteen chords is several minutes.
      expect((moves[i + 1] ?? 0) - (moves[i] ?? 0)).toBeGreaterThanOrEqual(16);
    }
    expect(new Set(CENTRES.map((c) => c.name)).size).toBe(CENTRES.length);
  });
});

describe('voicing', () => {
  it('stacks upward with no seconds and stays near the target root', () => {
    const rng = seeded(5);
    let harmony = createHarmony(rng);

    for (let i = 0; i < 200; i++) {
      const chord = chordOf(harmony);
      const notes = chooseVoicing(chord, 48, rng);

      expect(notes.length).toBeGreaterThanOrEqual(3);
      expect(notes.length).toBeLessThanOrEqual(MAX_PAD_NOTES);
      expect(Math.abs((notes[0] ?? 0) - 48)).toBeLessThanOrEqual(6);
      for (let n = 1; n < notes.length; n++) {
        expect((notes[n] ?? 0) - (notes[n - 1] ?? 0)).toBeGreaterThanOrEqual(2);
      }
      // A voicing wider than two octaves stops reading as one chord.
      expect((notes[notes.length - 1] ?? 0) - (notes[0] ?? 0)).toBeLessThanOrEqual(24);

      const pitchClasses = new Set(chord.intervals.map((interval) => (((chord.tonicPc + interval) % 12) + 12) % 12));
      for (const note of notes) expect(pitchClasses.has(((note % 12) + 12) % 12)).toBe(true);

      harmony = advanceHarmony(harmony, rng);
    }
  });

  it('keeps motif notes in the scale and around the register', () => {
    const rng = seeded(8);
    let harmony = createHarmony(rng);
    let previous = 0;

    for (let i = 0; i < 300; i++) {
      const chord = chordOf(harmony);
      const note = chooseMotifNote(chord, 72, previous, rng);
      expect(note).toBeGreaterThanOrEqual(72 - 8);
      expect(note).toBeLessThanOrEqual(72 + 12);
      expect(note).not.toBe(previous);

      const scale = new Set(chord.scale.map((tone) => (((chord.tonicPc + tone) % 12) + 12) % 12));
      expect(scale.has(((note % 12) + 12) % 12)).toBe(true);

      previous = note;
      if (i % 3 === 0) harmony = advanceHarmony(harmony, rng);
    }
  });

  it('turns midi into the pitches it should', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 6);
    expect(midiToHz(57)).toBeCloseTo(220, 6);
    expect(midiToHz(60)).toBeCloseTo(261.626, 3);
  });
});

describe('shape', () => {
  it('lifts the register into the day and lowers it at night', () => {
    const night = shapeFor(options({ dayFactor: 0 }));
    const day = shapeFor(options({ dayFactor: 1 }));

    expect(day.padRoot).toBeGreaterThan(night.padRoot + 6);
    expect(day.motifCentre).toBeGreaterThan(night.motifCentre + 6);
    expect(day.padCutoffHz).toBeGreaterThan(night.padCutoffHz * 1.5);

    // Night is slower, sparser, longer-ringing and in a bigger room.
    expect(day.chordSec).toBeLessThan(night.chordSec);
    expect(day.motifGapSec).toBeLessThan(night.motifGapSec);
    expect(day.motifDecaySec).toBeLessThan(night.motifDecaySec);
    expect(day.hallMix).toBeLessThan(night.hallMix);
  });

  it('lets a busy office nudge density and brightness, and nothing else', () => {
    const calm = shapeFor(options({ intensity: 0 }));
    const busy = shapeFor(options({ intensity: 1 }));

    expect(busy.motifGapSec).toBeLessThan(calm.motifGapSec);
    expect(busy.motifChance).toBeGreaterThan(calm.motifChance);
    expect(busy.padCutoffHz).toBeGreaterThan(calm.padCutoffHz);

    // The piece itself must not change: same register, same key rate, same room.
    expect(busy.padRoot).toBe(calm.padRoot);
    expect(busy.motifCentre).toBe(calm.motifCentre);
    expect(busy.chordSec).toBe(calm.chordSec);
    expect(busy.hallMix).toBe(calm.hallMix);
    // And the nudge stays a nudge.
    expect(busy.motifGapSec).toBeGreaterThan(calm.motifGapSec * 0.7);
  });

  it('moves continuously, so the clock crossing midnight is never a step', () => {
    const fields = [
      'padRoot',
      'motifCentre',
      'chordSec',
      'motifGapSec',
      'motifChance',
      'motifDecaySec',
      'padCutoffHz',
      'padLevel',
      'motifLevel',
      'hallMix',
      'wetLevel',
    ] as const satisfies readonly (keyof Shape)[];

    for (const axis of ['dayFactor', 'intensity'] as const) {
      let previous = shapeFor(options({ [axis]: 0 }));
      for (let i = 1; i <= 500; i++) {
        const next = shapeFor(options({ [axis]: i / 500 }));
        for (const field of fields) {
          const delta = Math.abs(next[field] - previous[field]);
          const span = Math.max(1, Math.abs(previous[field]));
          expect(delta / span, `${axis} stepped in ${field} at ${i}`).toBeLessThan(0.02);
        }
        previous = next;
      }
    }
  });

  it('shrugs off nonsense instead of producing it', () => {
    const wild = shapeFor({ volume: 4, dayFactor: Number.NaN, intensity: -3 });
    const floor = shapeFor(options({ dayFactor: 0, intensity: 0 }));
    expect(wild).toEqual(floor);
  });
});

describe('option smoothing', () => {
  it('approaches the target without overshooting or jumping', () => {
    let current = options({ volume: 0, dayFactor: 0, intensity: 0 });
    const target = options({ volume: 1, dayFactor: 1, intensity: 1 });

    let previous = current;
    for (let i = 0; i < 200; i++) {
      current = smoothOptions(current, target);
      expect(current.dayFactor).toBeGreaterThanOrEqual(previous.dayFactor);
      expect(current.dayFactor).toBeLessThanOrEqual(1);
      // One second of change must never be a lurch.
      expect(current.dayFactor - previous.dayFactor).toBeLessThan(0.2);
      previous = current;
    }
    expect(current.dayFactor).toBeCloseTo(1, 4);
    expect(current.volume).toBeCloseTo(1, 4);
  });

  it('clamps whatever it is handed', () => {
    const settled = smoothOptions(options(), { volume: 9, dayFactor: -4, intensity: Number.NaN }, 1);
    expect(settled).toEqual({ volume: 1, dayFactor: 0, intensity: 0 });
  });
});

describe('scheduler', () => {
  it('emits in ascending time and never behind the window', () => {
    const events = run(3600, shapeFor(options()));
    expect(events.length).toBeGreaterThan(200);

    for (let i = 1; i < events.length; i++) {
      expect((events[i]?.at ?? 0) >= (events[i - 1]?.at ?? 0), `out of order at ${i}`).toBe(true);
    }
    for (const event of events) expect(event.at).toBeGreaterThanOrEqual(0);
  });

  it('holds each chord for eight to twenty seconds and cross-fades into the next', () => {
    const events = run(3600, shapeFor(options()));
    const played = chords(events);
    expect(played.length).toBeGreaterThan(200);

    for (const chord of played) {
      expect(chord.durationSec).toBeGreaterThanOrEqual(8);
      expect(chord.durationSec).toBeLessThanOrEqual(20);
      expect(chord.fadeSec).toBeGreaterThan(2);
      expect(chord.fadeSec).toBeLessThanOrEqual(5);
    }
    for (let i = 1; i < played.length; i++) {
      const previous = played[i - 1];
      const current = played[i];
      if (!previous || !current) continue;
      // Overlapping, but never so much that a third chord could join in.
      expect(current.at).toBeLessThan(endOf(previous));
      expect(current.at).toBeGreaterThan(previous.at + previous.fadeSec);
    }
  });

  it('drops motif notes at gaps with no pulse in them', () => {
    const played = motifs(run(3600, shapeFor(options())));
    expect(played.length).toBeGreaterThan(100);

    const gaps: number[] = [];
    for (let i = 1; i < played.length; i++) gaps.push((played[i]?.at ?? 0) - (played[i - 1]?.at ?? 0));

    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const spread = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);

    expect(mean).toBeGreaterThan(4);
    // Anything tighter than this would start to feel like a tempo.
    expect(spread / mean).toBeGreaterThan(0.35);
    expect(Math.min(...gaps)).toBeGreaterThan(1.5);
    expect(Math.max(...gaps)).toBeGreaterThan(mean * 2);
  });

  it('caps the voices however long it runs', () => {
    for (const day of [0, 0.5, 1]) {
      for (const seed of [1, 2, 3]) {
        const shape = shapeFor(options({ dayFactor: day, intensity: 1 }));
        const events = run(7200, shape, seed);

        expect(peakVoices(events), `day ${day} seed ${seed}`).toBeLessThanOrEqual(MAX_VOICES);
        expect(peakVoices(events, 'chord')).toBeLessThanOrEqual(MAX_PAD_NOTES * 2);
        expect(peakVoices(events, 'motif')).toBeLessThanOrEqual(MAX_MOTIF_VOICES);
      }
    }
  });

  it('puts the day in a higher register than the night', () => {
    const height = (day: number): number => {
      const events = run(1800, shapeFor(options({ dayFactor: day })), 4);
      const notes = [
        ...chords(events).flatMap((c) => c.notes),
        ...motifs(events).map((m) => m.note),
      ];
      return notes.reduce((a, b) => a + b, 0) / notes.length;
    };

    expect(height(1)).toBeGreaterThan(height(0) + 8);
  });

  it('is reproducible from its seed', () => {
    const shape = shapeFor(options());
    expect(run(900, shape, 77)).toEqual(run(900, shape, 77));
    expect(run(900, shape, 77)).not.toEqual(run(900, shape, 78));
  });

  it('catches up after a stall instead of dumping the backlog at once', () => {
    const rng = seeded(21);
    const shape = shapeFor(options());
    const state = createScheduler(0, rng);
    collectEvents(state, 20, shape, rng);

    // The window was hidden for five minutes and the timer never fired.
    const now = 320;
    expect(rebase(state, now)).toBe(true);
    const events = collectEvents(state, now + 0.2, shape, rng);

    expect(events.length).toBeLessThanOrEqual(2);
    for (const event of events) expect(event.at).toBeGreaterThanOrEqual(now - 1);
    expect(state.nextChordAt).toBeGreaterThanOrEqual(now);
  });

  it('leaves a scheduler that is keeping up alone', () => {
    const rng = seeded(22);
    const state = createScheduler(100, rng);
    expect(rebase(state, 100)).toBe(false);
    expect(state.nextChordAt).toBe(100);
  });
});

/**
 * A stub graph, only detailed enough to catch the two things that cannot be
 * heard from here: automation the spec would reject or collapse onto one
 * instant, and nodes that are never torn down.
 */
const faults: string[] = [];
let clock = 0;
let liveNodes = 0;
let liveSources = 0;
let peakSources = 0;

class FakeParam {
  private last = -Infinity;
  constructor(
    private readonly label: string,
    public value = 0,
  ) {}

  private at(time: number, what: string): void {
    if (!Number.isFinite(time)) faults.push(`${this.label}: ${what} at a non-finite time`);
    if (time < clock - 1e-9) faults.push(`${this.label}: ${what} scheduled behind the clock`);
    if (time < this.last - 1e-9) faults.push(`${this.label}: ${what} scheduled out of order`);
    this.last = time;
  }

  setValueAtTime(value: number, time: number): this {
    this.at(time, 'setValueAtTime');
    this.value = value;
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.at(time, 'linear ramp');
    this.value = value;
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    this.at(time, 'exponential ramp');
    if (value <= 0) faults.push(`${this.label}: exponential ramp to ${value}`);
    if (this.value <= 0) faults.push(`${this.label}: exponential ramp from ${this.value}`);
    this.value = value;
    return this;
  }

  setTargetAtTime(value: number, time: number, constant: number): this {
    if (time < clock - 1e-9) faults.push(`${this.label}: target behind the clock`);
    if (!(constant > 0)) faults.push(`${this.label}: target with a ${constant} time constant`);
    this.value = value;
    return this;
  }

  cancelScheduledValues(time: number): this {
    this.last = time;
    return this;
  }
}

class FakeNode {
  constructor() {
    liveNodes++;
  }
  connect(target: unknown): unknown {
    return target;
  }
  disconnect(): void {
    liveNodes--;
  }
}

class FakeSource extends FakeNode {
  type = 'sine';
  frequency = new FakeParam('frequency');
  detune = new FakeParam('detune');
  onended: (() => void) | null = null;
  private started = false;
  private stopsAt = Infinity;

  start(time: number): void {
    if (this.started) faults.push('source started twice');
    if (time < clock - 1e-9) faults.push('source started behind the clock');
    this.started = true;
    liveSources++;
    peakSources = Math.max(peakSources, liveSources);
  }

  stop(time?: number): void {
    if (!this.started) {
      faults.push('source stopped before it started');
      return;
    }
    this.stopsAt = Math.min(this.stopsAt, time ?? clock);
    scheduled.add(this);
  }

  /** True once the node has actually ended and fired its handler. */
  settle(): boolean {
    if (this.stopsAt > clock || !this.onended) return false;
    liveSources--;
    const ended = this.onended;
    this.onended = null;
    ended();
    return true;
  }
}

const scheduled = new Set<FakeSource>();
function settleSources(): void {
  for (const source of [...scheduled]) if (source.settle()) scheduled.delete(source);
}

class FakeContext {
  /** Low enough that generating two impulse responses stays instant. */
  sampleRate = 8000;
  state: 'suspended' | 'running' = 'suspended';
  destination = new FakeNode();
  resume: () => Promise<void> = () => {
    this.state = 'running';
    return Promise.resolve();
  };

  get currentTime(): number {
    return clock;
  }
  createGain(): FakeNode & { gain: FakeParam } {
    return Object.assign(new FakeNode(), { gain: new FakeParam('gain', 1) });
  }
  createOscillator(): FakeSource {
    return new FakeSource();
  }
  createStereoPanner(): FakeNode & { pan: FakeParam } {
    return Object.assign(new FakeNode(), { pan: new FakeParam('pan') });
  }
  createBiquadFilter(): FakeNode & { type: string; frequency: FakeParam; Q: FakeParam } {
    return Object.assign(new FakeNode(), { type: 'lowpass', frequency: new FakeParam('cutoff'), Q: new FakeParam('Q') });
  }
  createDynamicsCompressor(): FakeNode & Record<'threshold' | 'knee' | 'ratio' | 'attack' | 'release', FakeParam> {
    return Object.assign(new FakeNode(), {
      threshold: new FakeParam('threshold'),
      knee: new FakeParam('knee'),
      ratio: new FakeParam('ratio'),
      attack: new FakeParam('attack'),
      release: new FakeParam('release'),
    });
  }
  createConvolver(): FakeNode & { normalize: boolean; buffer: unknown } {
    return Object.assign(new FakeNode(), { normalize: true, buffer: null });
  }
  createBuffer(channels: number, length: number, sampleRate: number): unknown {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      length,
      sampleRate,
      getChannelData: (index: number): Float32Array => data[index] ?? new Float32Array(0),
    };
  }
  suspend(): Promise<void> {
    this.state = 'suspended';
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function install(context: FakeContext): void {
  const ctor = function FakeAudioContext(): FakeContext {
    return context;
  } as unknown as typeof AudioContext;
  (globalThis as { window?: unknown }).window = { AudioContext: ctor };
}

/** Advances the audio clock and the timer queue together. */
function elapse(seconds: number): void {
  for (let step = 0; step < seconds * 40; step++) {
    clock += 0.025;
    vi.advanceTimersByTime(25);
    settleSources();
  }
}

describe('engine', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { window?: unknown }).window;
    faults.length = 0;
    clock = 0;
    liveNodes = 0;
    liveSources = 0;
    peakSources = 0;
    scheduled.clear();
  });

  it('runs for half an hour without leaking a node or scheduling a click', () => {
    vi.useFakeTimers();
    install(new FakeContext());
    const music = new OfficeMusic(seeded(4));

    music.update(options({ dayFactor: 0 }));
    music.start();
    music.start(); // idempotent
    expect(music.playing).toBe(true);

    for (let minute = 0; minute < 30; minute++) {
      elapse(60);
      // The clock sweeps and the office fills up and empties: neither may
      // interrupt what is already scheduled.
      music.update(options({ dayFactor: minute / 29, intensity: (minute % 7) / 6 }));
    }

    expect(faults).toEqual([]);
    // Four pad notes twice over, four bells, three layers or partials each,
    // plus a drift oscillator per note. Bounded, and nowhere near unbounded.
    expect(peakSources).toBeGreaterThan(8);
    expect(peakSources).toBeLessThan(64);

    music.stop();
    elapse(6);
    expect(music.playing).toBe(false);

    // Only the permanent graph and its stereo-width oscillator are left.
    expect(liveSources).toBe(1);
    expect(liveNodes).toBeLessThan(24);
    expect(faults).toEqual([]);
    music.dispose();
  });

  it('waits out a context that will not resume, then picks it up', () => {
    vi.useFakeTimers();
    const context = new FakeContext();
    context.resume = () => Promise.reject(new Error('no gesture yet'));
    install(context);

    const music = new OfficeMusic(seeded(6));
    expect(() => music.start()).not.toThrow();
    elapse(30);
    // Suspended: the graph exists, but not one note has been committed to it.
    expect(liveSources).toBe(1);

    context.resume = () => {
      context.state = 'running';
      return Promise.resolve();
    };
    elapse(30);
    expect(liveSources).toBeGreaterThan(1);
    expect(faults).toEqual([]);
    music.dispose();
  });

  it('can be stopped and started again mid-fade', () => {
    vi.useFakeTimers();
    install(new FakeContext());
    const music = new OfficeMusic(seeded(9));

    music.start();
    elapse(60);
    music.stop();
    elapse(1);
    // Still audible under the fade, so starting again must not tear anything down.
    expect(music.playing).toBe(true);
    music.start();
    elapse(60);

    expect(music.playing).toBe(true);
    expect(faults).toEqual([]);
    music.dispose();
  });

  it('is inert where there is no audio at all', () => {
    delete (globalThis as { window?: unknown }).window;
    const music = new OfficeMusic(seeded(2));
    expect(() => {
      music.start();
      music.update(options({ volume: 1 }));
      music.stop();
      music.dispose();
      music.start();
    }).not.toThrow();
    expect(music.playing).toBe(false);
  });
});
