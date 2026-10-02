import { modelInfo } from '../../../shared/format';

/**
 * A session's temperament, drawn once from its own seeded stream.
 *
 * Without it every desk works at the same speed with the same tools, and the
 * office reads as one process copied four times: the same walk to the same
 * bench, four abreast. A character is what makes one session hammer the
 * workshop with test runs while another sits in the commons handing work out.
 *
 * Nothing here is time- or environment-dependent: the same stream always
 * produces the same character, which is what makes a seed reproduce a world.
 */

/** The tool families a session draws from. Each one lands in a different zone. */
export type ToolFlavour = 'bash' | 'read' | 'edit' | 'grep' | 'web' | 'skill' | 'todo' | 'mcp' | 'publish';

export type ToolMix = Readonly<Record<ToolFlavour, number>>;

export type Range = readonly [number, number];

export interface Character {
  archetype: string;
  /** Scales every gap between beats: 0.6 is a restless desk, 1.9 a deliberate one. */
  tempo: number;
  /** Relative weights, not probabilities; `pickFlavour` normalises. */
  tools: ToolMix;
  /** Tool calls in a plain turn. */
  steps: Range;
  /**
   * Odds that a turn does something more interesting than tool calls.
   *
   * These are what put a figure somewhere other than its own desk, so the
   * balance between them is the balance of the whole office. Two rounds of
   * raising `fanOut` and `chats` — the two with the most to look at — starved
   * the rest: measured over five minutes of traffic, nobody planned, nobody
   * orchestrated and nobody watched anything, so the atelier, the war room and
   * the watchtower were furniture nobody touched. Every archetype now has at
   * least one of them it is *fond* of, and the sum stays well under one so a
   * plain turn of work is still the common case.
   */
  fanOut: number;
  orchestrates: number;
  plans: number;
  asks: number;
  watches: number;
  chats: number;
  /** Subagents per fan-out. */
  fanWidth: Range;
  /** The quiet stretch at the desk between turns, before tempo is applied. */
  quiet: Range;
  /** The `model` attachment id, which is the only place a `[1m]` window appears. */
  model: string;
  window: number;
  /** What subagents under this session run on. */
  agentModel: string;
  /** Tokens the context meter climbs per turn. */
  contextPerTurn: number;
  contextStart: number;
  lifetimeMs: number;
}

interface Archetype {
  name: string;
  tempo: Range;
  tools: ToolMix;
  steps: Range;
  fanOut: number;
  orchestrates: number;
  plans: number;
  asks: number;
  watches: number;
  chats: number;
  fanWidth: Range;
  quiet: Range;
  /** How fast this kind of work fills a context window, as a share of it. */
  burn: Range;
}

/**
 * Six ways to work. The weights are deliberately lopsided — an archetype that
 * does a bit of everything is indistinguishable from every other one at a
 * glance, and the glance is the whole product.
 */
const ARCHETYPES: readonly Archetype[] = [
  {
    name: 'builder',
    tempo: [0.8, 1.2],
    tools: { bash: 2, read: 4, edit: 6, grep: 2, web: 0.5, skill: 0.5, mcp: 0.4, publish: 1.2, todo: 1 },
    steps: [4, 9],
    fanOut: 0.14,
    orchestrates: 0.0,
    plans: 0.1,
    asks: 0.05,
    watches: 0.08,
    chats: 0.09,
    fanWidth: [1, 3],
    quiet: [14_000, 38_000],
    burn: [0.03, 0.06],
  },
  {
    name: 'runner',
    tempo: [0.6, 0.95],
    tools: { bash: 12, read: 2, edit: 2, grep: 1, web: 0.5, skill: 0.2, mcp: 0.8, publish: 1.0, todo: 0.5 },
    steps: [5, 11],
    fanOut: 0.09,
    orchestrates: 0.0,
    plans: 0.05,
    asks: 0.04,
    watches: 0.2,
    chats: 0.1,
    fanWidth: [1, 2],
    quiet: [9_000, 26_000],
    burn: [0.02, 0.05],
  },
  {
    name: 'delegator',
    tempo: [0.9, 1.4],
    tools: { bash: 1, read: 2, edit: 1, grep: 2, web: 1, skill: 0.5, mcp: 1.0, publish: 0.6, todo: 2 },
    steps: [2, 5],
    fanOut: 0.34,
    orchestrates: 0.14,
    plans: 0.07,
    asks: 0.05,
    watches: 0.08,
    chats: 0.18,
    fanWidth: [2, 5],
    quiet: [16_000, 44_000],
    burn: [0.04, 0.08],
  },
  {
    name: 'scout',
    tempo: [0.55, 0.9],
    tools: { bash: 2, read: 6, edit: 0.5, grep: 8, web: 1, skill: 1, mcp: 0.6, publish: 0.2, todo: 0.5 },
    steps: [6, 13],
    fanOut: 0.2,
    orchestrates: 0.0,
    plans: 0.08,
    asks: 0.04,
    watches: 0.05,
    chats: 0.09,
    fanWidth: [2, 4],
    quiet: [8_000, 22_000],
    burn: [0.05, 0.09],
  },
  {
    name: 'architect',
    tempo: [1.3, 1.9],
    tools: { bash: 1, read: 5, edit: 1, grep: 3, web: 2, skill: 2, mcp: 0.8, publish: 0.4, todo: 2 },
    steps: [2, 6],
    fanOut: 0.18,
    orchestrates: 0.08,
    plans: 0.26,
    asks: 0.14,
    watches: 0.06,
    chats: 0.12,
    fanWidth: [1, 3],
    quiet: [22_000, 55_000],
    burn: [0.03, 0.06],
  },
  {
    name: 'integrator',
    tempo: [0.85, 1.25],
    tools: { bash: 5, read: 3, edit: 3, grep: 2, web: 4, skill: 1, mcp: 2.5, publish: 1.8, todo: 1 },
    steps: [3, 8],
    fanOut: 0.16,
    orchestrates: 0.06,
    plans: 0.08,
    asks: 0.06,
    watches: 0.12,
    chats: 0.24,
    fanWidth: [1, 3],
    quiet: [13_000, 32_000],
    burn: [0.03, 0.07],
  },
];

/** Weighted so the office is mostly big models, with the odd cheap one. */
const MODELS: readonly { id: string; weight: number }[] = [
  { id: 'claude-opus-5[1m]', weight: 4 },
  { id: 'claude-opus-5', weight: 1 },
  { id: 'claude-sonnet-5', weight: 3 },
  { id: 'claude-haiku-4-5', weight: 2 },
  { id: 'claude-fable-5-1', weight: 1.5 },
];

const AGENT_MODELS: readonly { id: string; weight: number }[] = [
  { id: 'claude-opus-5', weight: 3 },
  { id: 'claude-sonnet-5', weight: 4 },
  { id: 'claude-haiku-4-5', weight: 2 },
];

const LIFETIME_MS: Range = [9 * 60_000, 34 * 60_000];

export function span(range: Range, random: () => number): number {
  return range[0] + random() * (range[1] - range[0]);
}

export function spanInt(range: Range, random: () => number): number {
  return range[0] + Math.floor(random() * (range[1] - range[0] + 1));
}

function weighted<T extends { weight: number }>(items: readonly T[], random: () => number): T {
  let total = 0;
  for (const item of items) total += item.weight;
  let roll = random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item;
  }
  return items[items.length - 1]!;
}

export function pickFlavour(mix: ToolMix, random: () => number): ToolFlavour {
  const flavours = Object.keys(mix) as ToolFlavour[];
  let total = 0;
  for (const flavour of flavours) total += mix[flavour];
  let roll = random() * total;
  for (const flavour of flavours) {
    roll -= mix[flavour];
    if (roll < 0) return flavour;
  }
  return 'bash';
}

export function deriveCharacter(random: () => number): Character {
  const base = ARCHETYPES[Math.floor(random() * ARCHETYPES.length)]!;
  const model = weighted(MODELS, random).id;
  const window = modelInfo(model).window;
  // Jitter around the archetype so two runners are still not the same session.
  const wobble = 0.85 + random() * 0.3;

  return {
    archetype: base.name,
    tempo: span(base.tempo, random),
    tools: base.tools,
    steps: base.steps,
    fanOut: base.fanOut * wobble,
    orchestrates: base.orchestrates * wobble,
    plans: base.plans * wobble,
    asks: base.asks * wobble,
    watches: base.watches * wobble,
    chats: base.chats * wobble,
    fanWidth: base.fanWidth,
    quiet: base.quiet,
    model,
    window,
    agentModel: weighted(AGENT_MODELS, random).id,
    contextPerTurn: Math.round(window * span(base.burn, random)),
    contextStart: Math.round(window * (0.02 + random() * 0.3)),
    lifetimeMs: span(LIFETIME_MS, random),
  };
}

/**
 * The per-message model id, which never carries the `[1m]` marker: only the
 * attachment does, and the reducer relies on that to size the window.
 */
export function messageModel(character: Character): string {
  return character.model.replace(/\[1m\]/i, '');
}
