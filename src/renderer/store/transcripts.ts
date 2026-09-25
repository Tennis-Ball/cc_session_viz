import { create } from 'zustand';
import type { TranscriptEntry } from '@shared/transcript';

interface CardTranscript {
  entries: TranscriptEntry[];
  hasMore: boolean;
}

interface TranscriptState {
  byCard: Record<string, CardTranscript>;
  reset(id: string, entries: TranscriptEntry[], hasMore: boolean): void;
  merge(id: string, append: TranscriptEntry[], update: TranscriptEntry[], hasMore: boolean): void;
  drop(ids: string[]): void;
}

const MAX_ENTRIES = 400;

export const useTranscripts = create<TranscriptState>((set) => ({
  byCard: {},

  reset: (id, entries, hasMore) =>
    set((state) => ({ byCard: { ...state.byCard, [id]: { entries: entries.slice(-MAX_ENTRIES), hasMore } } })),

  merge: (id, append, update, hasMore) =>
    set((state) => {
      const current = state.byCard[id]?.entries ?? [];
      let entries = current;

      if (update.length) {
        // Tool entries are drawn pending, then replaced when their result lands.
        const patches = new Map(update.map((entry) => [entry.id, entry]));
        entries = entries.map((entry) => patches.get(entry.id) ?? entry);
      }
      if (append.length) entries = [...entries, ...append];
      if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);

      return { byCard: { ...state.byCard, [id]: { entries, hasMore } } };
    }),

  drop: (ids) =>
    set((state) => {
      if (ids.length === 0) return state;
      const byCard = { ...state.byCard };
      for (const id of ids) delete byCard[id];
      return { byCard };
    }),
}));
