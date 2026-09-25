import { create } from 'zustand';

/**
 * Which view you are looking at.
 *
 * Two, answering two different questions: the office is "where is everyone",
 * the canvas is "what did it say". Both are views of the same `World`, not
 * separate apps.
 */
export type ViewMode = 'office' | 'canvas';

interface UiState {
  mode: ViewMode;
  inspectorOpen: boolean;
  selected: string | null;
  setMode(mode: ViewMode): void;
  toggleInspector(): void;
  select(id: string | null): void;
}

export const useUi = create<UiState>((set) => ({
  // The office is the ambient view, and the one you leave open.
  mode: 'office',
  inspectorOpen: false,
  selected: null,
  setMode: (mode) => set({ mode }),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  select: (selected) => set({ selected }),
}));
