/** Formatting shared by the canvas TUI replica, the office labels and the tray. */

import type { ModelFamily, ModelInfo } from './model';

export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 100 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/** "just now" / "3m ago" / "2h ago", for the usage panel's freshness stamp. */
export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * The countdown under a usage bar. Minutes are as fine as it gets: a limit
 * ticking down by the second would pull the eye away from the sessions.
 */
export function fmtResetIn(msUntil: number): string {
  if (msUntil <= 0) return 'Resets now';
  const minutes = Math.floor(msUntil / 60_000);
  if (minutes < 1) return 'Resets in <1m';
  if (minutes < 60) return `Resets in ${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m ? `Resets in ${h}h ${m}m` : `Resets in ${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `Resets in ${d}d ${rh}h` : `Resets in ${d}d`;
}

export function fmtClock(at: number): string {
  return new Date(at)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .replace(/ /g, ' ');
}

const FAMILY_ORDER: Record<ModelFamily, 0 | 1 | 2 | 3> = {
  haiku: 0,
  sonnet: 1,
  opus: 2,
  fable: 3,
  unknown: 1,
};

/** "claude-opus-5[1m]" -> { label: "Opus 5", family: "opus", window: 1_000_000 } */
export function modelInfo(rawId: string | undefined): ModelInfo {
  const id = rawId ?? 'unknown';
  const oneM = /\[1m\]/i.test(id);
  const base = id.replace(/\[1m\]/i, '').replace(/^claude-/, '');
  const family: ModelFamily = /haiku/i.test(base)
    ? 'haiku'
    : /sonnet/i.test(base)
      ? 'sonnet'
      : /opus/i.test(base)
        ? 'opus'
        : /fable/i.test(base)
          ? 'fable'
          : 'unknown';
  // "haiku-4-5-20251001" -> "Haiku 4.5", "fable-5-1" -> "Fable 5.1", "opus-5" -> "Opus 5"
  const parts = base
    .replace(/-\d{8}$/, '')
    .split('-')
    .filter((part) => part.length > 0);
  const [name = '', ...rest] = parts;
  const version = rest.join('.');
  const label = [name.charAt(0).toUpperCase() + name.slice(1), version].filter(Boolean).join(' ');
  const window = oneM ? 1_000_000 : family === 'haiku' ? 200_000 : family === 'unknown' ? 200_000 : 1_000_000;
  return { id, family, label: label || 'Unknown', tier: FAMILY_ORDER[family], window };
}

/** Claude Code's whimsical turn-end verbs; picked deterministically from a seed. */
export const TURN_VERBS = [
  'Brewed',
  'Cogitated',
  'Deliberated',
  'Finagled',
  'Herded',
  'Meandered',
  'Mulled',
  'Percolated',
  'Pondered',
  'Puttered',
  'Ruminated',
  'Schlepped',
  'Simmered',
  'Spelunked',
  'Sussed',
  'Tinkered',
  'Undulated',
  'Whirred',
] as const;

export function turnVerb(seed: number): string {
  const idx = Math.abs(Math.trunc(seed)) % TURN_VERBS.length;
  return TURN_VERBS[idx]!;
}

export function repoName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** Stable small hash, used for verb seeds and deterministic layout choices. */
export function hash32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
