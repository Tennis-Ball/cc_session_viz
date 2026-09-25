import type { BufferGeometry } from 'three';
import type { SlotKind } from '@shared/activity';

/**
 * Contract every prop follows.
 *
 * A prop is one merged geometry (one draw call) plus the anchor points where
 * figures stand. Props never pick their own colors: the palette comes from the
 * active theme, which is how the whole office stays one picture.
 *
 * Units are roughly metres. A figure is ~1.0 tall, a desk 0.72 high, and a
 * platform slab 0.5 thick.
 */

export interface PropPalette {
  /** Main body of furniture. */
  surface: string;
  /** Secondary surfaces: drawers, seat cushions, shelf backs. */
  surfaceAlt: string;
  /** The zone's identity color, used sparingly. */
  accent: string;
  /** Legs, frames, thin structure. */
  dark: string;
  /** Screens and lamps; these are the only emissive parts. */
  screen: string;
  paper: string;
  plant: string;
  metal: string;
}

export interface PropSlot {
  kind: SlotKind;
  /** Where the figure stands, relative to the prop's origin. */
  position: [number, number, number];
  /** Yaw in radians the figure faces while standing here. */
  facing: number;
  /**
   * Height of the seat surface, for the slots you sit at.
   *
   * It has to come from the prop, not from the figure: props are scaled to
   * fill whatever platform they land on, so the same chair is 0.42 high on one
   * and 0.65 on another. Guessing a fraction of the figure's own height — the
   * first attempt — put small figures inside the chair and tall ones above it.
   */
  seat?: number;
}

export interface PropBuild {
  geometry: BufferGeometry;
  slots: PropSlot[];
  /** Width and depth the layout should keep clear, in units. */
  footprint: [number, number];
}

export interface PropOptions {
  /** Deterministic variation, so the same pod looks the same every launch. */
  seed?: number;
  /** Desk pods tint their own surfaces with the session color. */
  tint?: string;
}

export type PropBuilder = (palette: PropPalette, options?: PropOptions) => PropBuild;
