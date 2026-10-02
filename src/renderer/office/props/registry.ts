import { paletteAt } from '@shared/palette';
import type { ResolvedTheme } from '../theme/themes';
import { walkableRing, FILL, WALK_MARGIN, type Platform } from '../world/layout';
import { buildArchive } from './archive';
import { buildAtelier } from './atelier';
import { buildCommons, buildWarRoom } from './commons';
import { buildDeskPod } from './deskPod';
import { buildLibrary } from './library';
import { buildHourglass, buildLounge, buildPedestal } from './lounge';
import { buildMailroom } from './mailroom';
import { buildObservatory } from './observatory';
import { buildWatchtower } from './watchtower';
import { buildWorkshop } from './workshop';
import type { PropBuild, PropOptions, PropPalette } from './types';

/**
 * Which prop fills which platform.
 *
 * Props are looked up by name so the campus template stays data, and a missing
 * builder degrades to an empty platform instead of a blank screen.
 */

type Builder = (palette: PropPalette, options?: PropOptions) => PropBuild;

const REGISTRY = new Map<string, Builder>([
  ['deskPod', buildDeskPod],
  ['atelier', buildAtelier],
  ['library', buildLibrary],
  ['archive', buildArchive],
  ['workshop', buildWorkshop],
  ['observatory', buildObservatory],
  ['commons', buildCommons],
  ['warroom', buildWarRoom],
  ['watchtower', buildWatchtower],
  ['mailroom', buildMailroom],
  ['lounge', buildLounge],
  ['pedestal', buildPedestal],
  ['hourglass', buildHourglass],
]);

export function registerProp(name: string, builder: Builder): void {
  REGISTRY.set(name, builder);
}

const MAX_UPSCALE = 2;

/**
 * How much of one axis the furniture may take.
 *
 * `WALK_MARGIN` is a *rim*, and subtracting two of them is only sensible while
 * the platform is comfortably wider than both. A stacked desk deck is 3.2 deep
 * and two margins are 2.7 of that, so the allowance came out at half a unit and
 * `fitToPlatform` clamped the pod to its 0.35 floor — a sixth the size of every
 * other desk in the office, which are all sitting at the 2.0 cap. A raised desk
 * was a rug with a speck on it, and the report was the honest one: you cannot
 * see the session desks.
 *
 * So the rim gives way on a small platform rather than eating it. The lower
 * bound is a *fraction*, which cannot collapse however narrow the deck gets,
 * and the walkability check is what actually guarantees the floor still joins
 * up — which is what it was always for.
 */
const MIN_SHARE = 0.62;

function allowance(size: number): number {
  return Math.max(size * MIN_SHARE, Math.min(size * FILL, size - 2 * WALK_MARGIN));
}
/**
 * Height follows width, but only partly.
 *
 * Scaling a prop uniformly to fill a floor turns a bookcase into a tower: in an
 * isometric view height costs far more screen than footprint does. Damping the
 * vertical keeps the floor furnished and the skyline calm.
 */
const HEIGHT_DAMPING = 0.55;

export function buildPropFor(platform: Platform, palette: PropPalette): PropBuild | null {
  const name = platform.kind === 'desk' ? 'deskPod' : (platform.prop ?? '');
  const builder = REGISTRY.get(name);
  if (!builder) return null;
  const seed = hashString(platform.id);
  const tint = platform.colorIndex !== undefined ? paletteAt(platform.colorIndex).base : undefined;
  return fitToPlatform(builder(palette, { seed, ...(tint ? { tint } : {}) }), platform);
}

/**
 * Sizes and centres a prop on its platform.
 *
 * Props were each modelled to look right on their own, which left most zones as
 * a large empty floor with a small object somewhere on it — the furniture was
 * too small to read, and the platform looked like a mistake. Rather than hand-
 * tune twelve builders against every platform size, measure what each one
 * actually occupies and scale it to fill its floor.
 *
 * Height scales with it, which is the point: a taller bookcase reads from
 * across the campus where a low one does not.
 */
function fitToPlatform(prop: PropBuild, platform: Platform): PropBuild {
  prop.geometry.computeBoundingBox();
  const box = prop.geometry.boundingBox;
  if (!box) return prop;

  const width = Math.max(0.001, box.max.x - box.min.x);
  const depth = Math.max(0.001, box.max.z - box.min.z);
  const allowedWidth = allowance(platform.size[0]);
  const allowedDepth = allowance(platform.size[1]);
  const scale = Math.min(MAX_UPSCALE, Math.max(0.35, Math.min(allowedWidth / width, allowedDepth / depth)));

  // Centre horizontally; the base stays on the floor, so y is never moved.
  const offsetX = -((box.min.x + box.max.x) / 2) * scale;
  const offsetZ = -((box.min.z + box.max.z) / 2) * scale;

  const heightScale = 1 + (scale - 1) * HEIGHT_DAMPING;
  prop.geometry.scale(scale, heightScale, scale);
  prop.geometry.translate(offsetX, 0, offsetZ);

  return {
    geometry: prop.geometry,
    footprint: [prop.footprint[0] * scale, prop.footprint[1] * scale],
    slots: prop.slots.map((slot) => ({
      ...slot,
      ...(slot.seat === undefined ? {} : { seat: slot.seat * heightScale }),
      position: [
        slot.position[0] * scale + offsetX,
        slot.position[1] * heightScale,
        slot.position[2] * scale + offsetZ,
      ] as [number, number, number],
    })),
  };
}

/**
 * Theme + platform identity → the colors a prop is allowed to use.
 *
 * Zone props take the theme's accent; a desk takes its session's color, which is
 * what makes your own desk findable from across the office.
 */
export function propPalette(theme: ResolvedTheme, platform: Platform): PropPalette {
  const accent = platform.colorIndex !== undefined ? paletteAt(platform.colorIndex).base : theme.accent;
  return {
    surface: theme.tones.top,
    surfaceAlt: theme.platform.top,
    accent,
    dark: theme.platform.side,
    screen: accent,
    paper: theme.tones.top,
    plant: theme.id === 'ink' ? theme.accent : '#6E9E62',
    metal: theme.tones.left,
  };
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
