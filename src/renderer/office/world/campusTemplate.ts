import type { ZoneId } from '@shared/activity';

/**
 * The floor plan, on a grid.
 *
 * Everything in the office is laid out in cells rather than free coordinates,
 * and that single decision is what makes it read as architecture instead of
 * scattered islands:
 *
 * - Platforms snap to whole cells, so edges line up across the whole campus.
 * - Neighbours are separated by exactly one empty cell, so every walkway is the
 *   same length and every staircase has the same pitch.
 * - Connections are axis-aligned and run between facing, overlapping edges. A
 *   diagonal bridge between two corners is what made the old layout look like a
 *   mistake; here it cannot be expressed.
 * - Connected platforms differ by at most one level, so a flight of stairs is
 *   always one storey and never a ladder.
 */

/** World units per grid cell. Also the length of every walkway and stair run. */
export const CELL = 4;
/**
 * Vertical distance between levels. With a one-cell run this is a ~32° pitch —
 * about what a real staircase climbs, and steep enough that a terrace above
 * you reads as *above* you rather than as a kerb.
 */
export const LEVEL_HEIGHT = 2.5;
/**
 * The most levels a single walkway may span.
 *
 * One was the old rule, and one level of 2 units across a campus 65 units wide
 * is not a landscape, it is a floor with kerbs — whatever the height field
 * asks for, flattening every edge to one flight takes it straight back out
 * again. Two gives the ground twice the range to work in, and the flight that
 * spans it is a grand stair with a landing rather than a step.
 */
export const MAX_FLIGHT = 2;
export const PLATFORM_THICKNESS = 0.55;
/** How wide walkways and staircases are. */
export const WALKWAY_WIDTH = 2.6;

export interface CellRect {
  /** West edge, in cells. */
  col: number;
  /** North edge, in cells. */
  row: number;
  cols: number;
  rows: number;
}

export interface ZoneSpec {
  id: ZoneId;
  cell: CellRect;
  level: number;
  /** Which prop builder fills it. */
  prop: string;
  label: string;
}

/**
 * The core, composed by hand.
 *
 * Read it as a plan: a lounge at the middle of a three-column spine, work rooms
 * stepping up to the north and down to the south, and the tower on top. The
 * gaps between the numbers are the walkways.
 */
export const CAMPUS: ZoneSpec[] = [
  // North terrace: thinking, planning, and the tower above it all.
  { id: 'warroom', cell: { col: 0, row: 0, cols: 3, rows: 2 }, level: 0, prop: 'warroom', label: 'War Room' },
  { id: 'atelier', cell: { col: 4, row: 0, cols: 3, rows: 2 }, level: 1, prop: 'atelier', label: 'Atelier' },
  { id: 'pedestal', cell: { col: 8, row: 0, cols: 2, rows: 2 }, level: 1, prop: 'pedestal', label: '' },
  { id: 'watchtower', cell: { col: 11, row: 0, cols: 2, rows: 2 }, level: 2, prop: 'watchtower', label: 'Watchtower' },

  // The spine: everything passes through the lounge.
  { id: 'commons', cell: { col: 0, row: 3, cols: 3, rows: 2 }, level: 0, prop: 'commons', label: 'Commons' },
  { id: 'lounge', cell: { col: 4, row: 3, cols: 3, rows: 2 }, level: 0, prop: 'lounge', label: 'Lounge' },
  { id: 'library', cell: { col: 8, row: 3, cols: 3, rows: 2 }, level: 0, prop: 'library', label: 'Library' },

  // South terrace, stepping down: the machinery and the paperwork.
  { id: 'mailroom', cell: { col: 0, row: 6, cols: 2, rows: 2 }, level: -1, prop: 'mailroom', label: 'Mailroom' },
  { id: 'observatory', cell: { col: 4, row: 6, cols: 2, rows: 2 }, level: 0, prop: 'observatory', label: 'Observatory' },
  { id: 'workshop', cell: { col: 8, row: 6, cols: 3, rows: 2 }, level: -1, prop: 'workshop', label: 'Workshop' },
  { id: 'archive', cell: { col: 8, row: 9, cols: 2, rows: 2 }, level: -2, prop: 'archive', label: 'Archive' },
];

export function zoneById(id: ZoneId): ZoneSpec | undefined {
  return CAMPUS.find((zone) => zone.id === id);
}

export function levelY(level: number): number {
  return level * LEVEL_HEIGHT;
}

/** Cell rectangle → world rectangle. Cell `k` spans `[k*CELL, (k+1)*CELL)`. */
export function cellToWorld(cell: CellRect): { position: [number, number]; size: [number, number] } {
  const width = cell.cols * CELL;
  const depth = cell.rows * CELL;
  return {
    position: [cell.col * CELL + width / 2, cell.row * CELL + depth / 2],
    size: [width, depth],
  };
}
