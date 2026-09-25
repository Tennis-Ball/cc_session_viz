/**
 * The one palette. Office figures, canvas card dots, group frames and the tray
 * all index into this, so a session is the same color everywhere.
 */

export interface GradientPair {
  name: string;
  /** Base (lower body / card dot / frame stroke). */
  base: string;
  /** Top of the vertical gradient (lighter). */
  top: string;
}

export const SESSION_PALETTE: readonly GradientPair[] = [
  { name: 'coral', base: '#F2705A', top: '#FFB49A' },
  { name: 'teal', base: '#2E9E96', top: '#8EE0D0' },
  { name: 'lavender', base: '#8A6FD1', top: '#CBB6F5' },
  { name: 'sky', base: '#3E8CD8', top: '#A9D6F5' },
  { name: 'marigold', base: '#E5A32B', top: '#FBDC9B' },
  { name: 'rose', base: '#D85E86', top: '#F7B3C7' },
  { name: 'sage', base: '#6E9E62', top: '#BFE0A8' },
  { name: 'indigo', base: '#4A5AC0', top: '#A6B2F0' },
  { name: 'clay', base: '#C26A43', top: '#EFB68C' },
  { name: 'mint', base: '#3FA36B', top: '#A8E7BF' },
  { name: 'plum', base: '#8E4E86', top: '#D8A7D0' },
  { name: 'slate', base: '#5B7183', top: '#B4C6D3' },
] as const;

export function paletteAt(index: number): GradientPair {
  const pair = SESSION_PALETTE[((index % SESSION_PALETTE.length) + SESSION_PALETTE.length) % SESSION_PALETTE.length];
  // SESSION_PALETTE is non-empty, so this is always defined.
  return pair!;
}

/** Canvas-mode chrome, matching nodeterm's dark theme. */
export const CANVAS_TOKENS = {
  canvasBg: '#000000',
  canvasDot: '#303030',
  panel: '#282828',
  panelHeader: '#323232',
  surfaceDeep: '#1a1a1a',
  surfaceBlack: '#0a0a0c',
  terminalBg: '#1e1e1e',
  terminalFg: '#e6e6e6',
  border: 'rgba(255,255,255,0.10)',
  text: 'rgba(255,255,255,0.85)',
  muted: 'rgba(255,255,255,0.55)',
  faint: 'rgba(255,255,255,0.25)',
  accent: '#0a84ff',
  agent: '#d97757',
  danger: '#ff453a',
  warn: '#ff9f0a',
  caution: '#ffd60a',
  success: '#32d74b',
} as const;
