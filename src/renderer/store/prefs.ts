import { create } from 'zustand';
import { applyPatch, DEFAULT_PREFS, type Prefs, type PrefsPatch } from '@shared/prefs';

/**
 * Prefs in the renderer.
 *
 * Optimistic: the store updates immediately and the write goes to main in the
 * background, so a theme switch never waits on disk. Main echoes the result
 * back, which is what keeps a second window in step.
 */
interface PrefsState {
  prefs: Prefs;
  loaded: boolean;
  hydrate(): Promise<void>;
  update(patch: PrefsPatch): void;
  replace(prefs: Prefs): void;
}

export const usePrefs = create<PrefsState>((set, get) => ({
  prefs: DEFAULT_PREFS,
  loaded: false,

  hydrate: async () => {
    if (get().loaded) return;
    try {
      const prefs = await window.atrium.prefs.get();
      set({ prefs, loaded: true });
    } catch {
      set({ loaded: true });
    }
    window.atrium.prefs.onChange((prefs) => set({ prefs }));
  },

  update: (patch) => {
    set((state) => ({ prefs: applyPatch(state.prefs, patch) }));
    void window.atrium.prefs.set(patch);
  },

  replace: (prefs) => set({ prefs }),
}));
