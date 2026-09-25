import type { EntryLog } from '../state/entryLog';
import type { WorldStore } from '../state/worldStore';

/**
 * Every data source writes into the same WorldStore, so live, sim, replay and
 * ambient all exercise identical reducers and renderers.
 */
export interface DataSource {
  readonly kind: 'live' | 'sim' | 'replay';
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  /** Transcript log for a canvas card, when the source has one. */
  logFor?(cardId: string): EntryLog | undefined;
}

export type SourceFactory = (store: WorldStore) => DataSource;

/** Deterministic PRNG (mulberry32) so scenarios and screenshots are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}
