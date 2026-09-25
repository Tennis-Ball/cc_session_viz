import { useMemo } from 'react';
import type { BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { paletteAt } from '@shared/palette';
import { createFacetMaterial } from '../material/facet';
import { box, buildProp, slab, type Part } from '../props/kit';
import { buildPropFor, propPalette } from '../props/registry';
import { stoneVariant, type ResolvedTheme } from '../theme/themes';
import { levelY, PLATFORM_THICKNESS } from '../world/campusTemplate';
import type { Campus, Connector, Platform } from '../world/layout';
import { campusArchGeometry, corbelArch, type ArchPlan } from '../world/architecture';
import { REBUILDS } from '../OfficeView';

/**
 * Every platform and walkway, as one merged mesh.
 *
 * Surface colours are baked into the geometry, so the mesh has to be rebuilt
 * when the palette moves — but only when it moves *visibly*. The clock nudges
 * the theme every second; quantising it means about a dozen rebuilds across a
 * whole day instead of eighty-six thousand, and an immediate one when you pick
 * a different theme.
 */
export function Platforms({
  campus,
  theme,
  architecture,
}: {
  campus: Campus;
  theme: ResolvedTheme;
  architecture: ArchPlan;
}): React.JSX.Element {
  const material = useMemo(() => createFacetMaterial(), []);

  const palette = `${theme.id}:${Math.round(theme.dayFactor * 12)}`;
  const geometry = useMemo(() => {
    REBUILDS.geometry += 1;
    const parts: BufferGeometry[] = [];
    for (const platform of campus.platforms) parts.push(platformGeometry(platform, theme));
    // A walkway takes the stone of the platform it lands on, which for a stair
    // is the lower end — the one whose floor it continues.
    const stoneOf = new Map(campus.platforms.map((platform) => [platform.id, platform.stone]));
    for (const connector of campus.connectors) {
      parts.push(connectorGeometry(connector, theme, stoneOf.get(connector.from) ?? 0));
    }
    // The architecture merges in here rather than into a mesh of its own: it
    // is made of the same stone and lit by the same rules, and one more draw
    // call per frame for something that never moves would be a waste.
    //
    const built = campusArchGeometry(campus, architecture, theme);
    if (built) parts.push(built);
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    return merged ?? parts[0]!;
    // `palette` stands in for the theme: rebuilding on every interpolated frame
    // would merge the whole campus sixty times a second for no visible gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campus, architecture, palette]);

  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}



/** Blend two hex colours; `t` is how far to move from `a` toward `b`. */
function mix(a: string, b: string, t: number): string {
  const parse = (hex: string): [number, number, number] => {
    const value = Number.parseInt(hex.replace('#', ''), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  };
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const channel = (x: number, y: number): number => Math.round(x + (y - x) * t);
  return `#${((1 << 24) | (channel(ar, br) << 16) | (channel(ag, bg) << 8) | channel(ab, bb)).toString(16).slice(1)}`;
}

/*
 * Exported for `coplanar.test.ts`, which is the only thing outside this file
 * that uses them. The surfaces people walk on are built here, and the way they
 * fail is invisible from a still camera, so they are asserted rather than
 * eyeballed.
 */
export function platformGeometry(platform: Platform, theme: ResolvedTheme): BufferGeometry {
  const y = levelY(platform.level);
  const [width, depth] = platform.size;
  // Each room is cut from its own stone, so the campus reads as a group of
  // masses rather than one continuous floor. See `stoneVariant`.
  const stone = stoneVariant(theme, platform.stone);
  const parts: Part[] = [
    slab(width, depth, PLATFORM_THICKNESS, {
      color: stone.top,
      position: [platform.position[0], y - PLATFORM_THICKNESS, platform.position[1]],
      grad: [0.15, 1],
    }),
  ];

  // A desk platform wears its session's colour, which is how you pick your own
  // session out of a crowded office. It goes on as an inlay rather than as a
  // painted floor: a band around the rim carries the colour at full strength,
  // and the rug inside it is muted into the stone so the platform still reads
  // as stone.
  if (platform.kind === 'desk' && platform.colorIndex !== undefined) {
    const color = paletteAt(platform.colorIndex);
    parts.push(
      box(width + 0.12, 0.13, depth + 0.12, {
        color: color.base,
        position: [platform.position[0], y - 0.17, platform.position[1]],
        grad: [0.82, 1],
      }),
      box(width * 0.46, 0.035, depth * 0.46, {
        color: mix(color.base, stone.top, 0.55),
        position: [platform.position[0], y + FLOOR_LIFT, platform.position[1]],
        grad: [0.85, 1],
      }),
    );
  }

  const prop = buildPropFor(platform, propPalette(theme, platform));
  const geometries: BufferGeometry[] = [buildProp(parts)];
  if (prop) {
    const moved = prop.geometry.clone();
    moved.translate(platform.position[0], y, platform.position[1]);
    geometries.push(moved);
  }

  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  return merged ?? geometries[0]!;
}

/** A bridge is a thin slab; a flight of stairs is one box per step. */
/**
 * A walkway, drawn as the thing it is.
 *
 * Connectors are axis-aligned and always span exactly one cell, so a flight of
 * stairs is always the same pitch and can be built honestly: a run of treads,
 * each sitting on the one below, with a stepped cheek down each side to tie
 * them together. The old version strung boxes along an arbitrary diagonal,
 * which is why the stairs looked broken from most angles.
 */
const STAIR_STEPS = 8;
const CHEEK = 0.16;

/**
 * How much of a walkway's thickness is the surface you walk on.
 *
 * Everything you can walk on is built as two boxes: a dark structural base and
 * a pale paving course on top of it. There is one rule, and it is the whole
 * reason this constant is named rather than inlined: **a base of nominal
 * thickness `T` is built `T - WEARING_COURSE` tall and positioned at `top - T`,
 * so its own top face ends up at `top - WEARING_COURSE` — underneath the
 * paving, where nothing can see it.**
 *
 * Get it wrong by writing the height as plain `T` and the base's top face lands
 * on exactly the same plane as the paving's. Both face up, they cover the same
 * footprint, they are different colours, and the campus is one merged mesh with
 * one material — so there is nothing to break the depth tie and the winner is
 * decided per pixel by a rounding error. It looks perfect from a standing
 * camera, because the comparison is deterministic: the pattern only starts
 * flickering when you orbit, and then the entire landing strobes between dark
 * and pale.
 *
 * Four of the five surfaces added in the last round got this wrong — the stair
 * landing, both spiral pieces and the lift deck — which is what the flashing
 * was. `coplanar.test.ts` now fails the build for it rather than leaving it to
 * be noticed.
 */
const WEARING_COURSE = 0.07;

/**
 * How far anything lying *on* the floor is lifted off it.
 *
 * The whole campus is one merged mesh with one material, so two surfaces at
 * exactly the same height have nothing to break the tie: the depth buffer
 * picks whichever won by a rounding error, and which one wins changes as the
 * camera turns. That is the flashing — a rug, a chalk line or a walkway
 * blinking in and out against the floor it lies on. Polygon offset cannot help
 * here because both surfaces share one material, so the separation has to be
 * real. Small enough to be invisible, large enough to beat float precision at
 * this scale.
 */
const FLOOR_LIFT = 0.012;

/** A stable 0–1 from a coordinate, so one flight always looks the same way. */
function fract(value: number): number {
  const x = Math.sin(value * 43.7) * 43758.5453;
  return x - Math.floor(x);
}

export function connectorGeometry(connector: Connector, theme: ResolvedTheme, stone = 0): BufferGeometry {
  /*
   * A walkway is cut from the stone of the platform it lands on.
   *
   * Once rooms stopped all being the same cream, a walkway left on the base
   * tone became a visibly different colour lying across the floor it joins —
   * and where a connector genuinely rests *on* a platform, as a stacked
   * terrace's lift does, that is two different colours on one plane, which is
   * the flashing all over again. Taking the lower platform's stone keeps the
   * walkway part of the room it arrives in.
   */
  const variant = stoneVariant(theme, stone);
  const color = variant.side;
  /**
   * You walk on the same stone the platforms are paved with.
   *
   * Cutting the whole walkway from the dark side colour is what made the
   * campus read as cream terraces joined by brown planks: in an isometric view
   * the tread of a step is most of what you see of it, so the stairs were the
   * loudest thing in the frame and the platforms the quietest. Capping every
   * tread and every bridge in the platform tone puts the emphasis back where
   * it belongs and leaves the dark stone doing what it is good at — the risers
   * and the undersides, which is where the depth reads from.
   */
  const paving = variant.top;
  const width = connector.width;
  const alongX = connector.axis === 'x';

  if (connector.kind === 'bridge') {
    const [ax, ay, az] = connector.a;
    const [bx, , bz] = connector.b;
    const run = alongX ? Math.abs(bx - ax) : Math.abs(bz - az);
    // A shade longer than the gap so it tucks under both platform edges
    // instead of leaving a hairline of sky at each end.
    const length = run + 0.5;
    const midX = (ax + bx) / 2;
    const midZ = (az + bz) / 2;
    const parts: Part[] = [
      // The structure runs long, under both platform edges, so there is no
      // hairline of sky where it meets them.
      box(alongX ? length : width, 0.24 - WEARING_COURSE, alongX ? width : length, {
        color,
        position: [midX, ay - 0.24, midZ],
        grad: [0.45, 1],
      }),
      // The deck does not: it stops at the rims. Running it under the
      // platforms too would put its top face at exactly floor height over the
      // overlap, which is the one thing guaranteed to flash.
      box(alongX ? run : width - 0.12, WEARING_COURSE, alongX ? width - 0.12 : run, {
        color: paving,
        position: [midX, ay - WEARING_COURSE, midZ],
        grad: [0.88, 1],
      }),
    ];

    /**
     * What holds the bridge up, which until now was nothing.
     *
     * A bridge was a plank: a slab of the right length laid across a gap, and
     * from the isometric angle — where you can see clean under it — that is
     * exactly what it looked like. Every other span in this office grew a
     * reason to exist; the commonest one had none. An arch and two piers
     * underneath cost three boxes and a torus, are never in anybody's way
     * because they hang below the deck, and turn the most-repeated element in
     * the campus from a plank into a viaduct.
     */
    const radius = Math.min(run * 0.44, width * 0.9);
    parts.push(...corbelArch(
      { shape: 'arch', tone: 'stone', radius, tube: 0.16, at: [midX, ay - 0.24 - radius - 0.34, midZ], turned: !alongX, grad: [0.42, 0.92] },
      color,
    ));
    for (const side of [-1, 1]) {
      // A pier at each abutment, dropping away under the rim it springs from.
      parts.push(
        box(alongX ? 0.42 : width * 0.62, 1.9, alongX ? width * 0.62 : 0.42, {
          color,
          position: [
            midX + (alongX ? (side * run) / 2 : 0),
            ay - 0.24 - 1.9,
            midZ + (alongX ? 0 : (side * run) / 2),
          ],
          grad: [0.3, 0.85],
        }),
      );
    }

    return buildProp(parts);
  }

  if (connector.style === 'spiral') return spiralGeometry(connector, color, paving);
  if (connector.style === 'lift') return liftGeometry(connector, color, paving);

  // Build from the low end upward, which is also the way it is walked.
  const up = connector.b[1] >= connector.a[1];
  const low = up ? connector.a : connector.b;
  const high = up ? connector.b : connector.a;

  const dirX = alongX ? Math.sign(high[0] - low[0]) : 0;
  const dirZ = alongX ? 0 : Math.sign(high[2] - low[2]);
  const run = alongX ? Math.abs(high[0] - low[0]) : Math.abs(high[2] - low[2]);
  const rise = high[1] - low[1];

  /**
   * Step count follows the rise, not the flight.
   *
   * A connector may now climb two levels in the same one-cell run, and dividing
   * whatever that is into a fixed eight gives a flight whose risers are taller
   * than its treads — a ladder. Keeping the riser near a constant instead makes
   * the tall flight what it should be: more steps, steeper, read as a temple
   * stair rather than a broken staircase.
   */
  const steps = Math.max(STAIR_STEPS, Math.round(rise / 0.32));
  const grand = steps > STAIR_STEPS * 1.4;
  const tread = run / steps;
  const riser = rise / steps;
  const parts: Part[] = [];

  // A landing a third of the way up, jutting to one side. The walked line stays
  // dead straight down the middle — the nav graph crosses a connector as a
  // single segment and a genuinely dog-legged flight would leave figures
  // walking through the turn — but the silhouette bends, which is the part you
  // actually see from an isometric camera.
  //
  // A grand flight gets neither landing nor rail: it is already wide, and
  // hanging a shelf and a fence off something that size makes it fussy. It
  // flares at the foot instead, the way a stair up to a temple does.
  const landingAt = grand ? -1 : Math.floor(steps * (0.35 + 0.3 * fract(connector.a[0] + connector.b[2])));
  const landingSide = fract(connector.a[2] * 3.7) < 0.5 ? -1 : 1;
  const railed = !grand && fract(connector.b[0] * 1.9 + connector.a[2]) < 0.45;
  const flare = grand ? width * 0.3 : 0;

  for (let i = 0; i < steps; i++) {
    const along = (i + 0.5) * tread;
    const x = low[0] + dirX * along;
    const z = low[2] + dirZ * along;
    const top = low[1] + (i + 1) * riser;
    // Each tread reaches a little below the one behind it, so the underside is
    // continuous rather than a row of floating slabs.
    const height = riser + 0.14;
    // The bottom few steps of a grand flight run wider than the ones above, so
    // the stair spreads into the terrace it lands on instead of butting it.
    const spread = width + flare * Math.max(0, 1 - i / 3);

    parts.push(
      box(alongX ? tread : spread, height - WEARING_COURSE, alongX ? spread : tread, {
        color,
        position: [x, top - height, z],
        grad: [0.4, 1],
      }),
      // The tread itself, paved like the platforms it runs between.
      box(alongX ? tread : spread - 2 * CHEEK, WEARING_COURSE, alongX ? spread - 2 * CHEEK : tread, {
        color: paving,
        position: [x, top - WEARING_COURSE, z],
        grad: [0.9, 1],
      }),
    );

    if (i === landingAt) {
      const reach = width * 0.72;
      parts.push(
        box(alongX ? tread * 1.9 : reach, 0.2 - WEARING_COURSE, alongX ? reach : tread * 1.9, {
          color,
          position: [
            x + (alongX ? 0 : (landingSide * (width + reach)) / 2),
            top - 0.2,
            z + (alongX ? (landingSide * (width + reach)) / 2 : 0),
          ],
          grad: [0.4, 1],
        }),
        box(alongX ? tread * 1.9 : reach, WEARING_COURSE, alongX ? reach : tread * 1.9, {
          color: paving,
          position: [
            x + (alongX ? 0 : (landingSide * (width + reach)) / 2),
            top - WEARING_COURSE,
            z + (alongX ? (landingSide * (width + reach)) / 2 : 0),
          ],
          grad: [0.9, 1],
        }),
      );
    }

    // A rail up one side, following the treads. Only sometimes: on every
    // flight it stops being a detail and starts being a fence.
    if (railed && i % 2 === 0) {
      parts.push(
        box(alongX ? 0.1 : 0.1, 0.62, alongX ? 0.1 : 0.1, {
          color: paving,
          position: [
            x + (alongX ? 0 : (-landingSide * (width - CHEEK)) / 2),
            top,
            z + (alongX ? (-landingSide * (width - CHEEK)) / 2 : 0),
          ],
          grad: [0.6, 1],
        }),
        box(alongX ? tread * 2.1 : 0.11, 0.1, alongX ? 0.11 : tread * 2.1, {
          color: paving,
          position: [
            x + (alongX ? 0 : (-landingSide * (width - CHEEK)) / 2),
            top + 0.62,
            z + (alongX ? (-landingSide * (width - CHEEK)) / 2 : 0),
          ],
          grad: [0.85, 1],
        }),
      );
    }

    // The cheeks: the same steps again, thin and deeper, down each side.
    for (const side of [-1, 1]) {
      parts.push(
        box(alongX ? tread : CHEEK, height + 0.3, alongX ? CHEEK : tread, {
          color: theme.platform.side,
          position: [
            x + (alongX ? 0 : (side * (spread - CHEEK)) / 2),
            top - height - 0.3,
            z + (alongX ? (side * (spread - CHEEK)) / 2 : 0),
          ],
          grad: [0.28, 0.8],
        }),
      );
    }
  }

  return buildProp(parts);
}

/**
 * A stair that turns about its own newel.
 *
 * Treads are wedges, and a wedge is a box rotated about one end — which is all
 * a box can be in this kit, so each tread is drawn at its own mid-radius and
 * yawed. It climbs the same rise over the same run as the straight flight it
 * replaces, so the nav graph, which crosses a connector as one segment, is
 * never any the wiser: the figure still walks the chord while the stone turns
 * around it.
 */
/**
 * Enough treads that the flight reads as a helix rather than a pinwheel.
 *
 * Fourteen over one and a half turns is thirty-eight degrees a step: the
 * treads splay apart, the gaps between them are wider than the treads, and
 * what you see from across the campus is a fan. Twice as many, on a tighter
 * radius, makes each tread overlap the one below it — which is what a spiral
 * stair actually looks like and, not coincidentally, how one stays walkable.
 */
const SPIRAL_TREADS = 26;

function spiralGeometry(connector: Connector, color: string, paving: string): BufferGeometry {
  const up = connector.b[1] >= connector.a[1];
  const low = up ? connector.a : connector.b;
  const high = up ? connector.b : connector.a;

  const midX = (low[0] + high[0]) / 2;
  const midZ = (low[2] + high[2]) / 2;
  const rise = high[1] - low[1];
  const alongX = connector.axis === 'x';
  const run = alongX ? Math.abs(high[0] - low[0]) : Math.abs(high[2] - low[2]);

  /**
   * Where it starts, where it ends, and why it is one and a half turns.
   *
   * The first version swept 1.35 turns from wherever the low end happened to
   * be, which left the top tread sixty degrees away from the platform it was
   * supposed to arrive at, and the bottom tread already a step up and a step
   * round from the one it left. It was a corkscrew floating in the gap with no
   * way on and no way off.
   *
   * A spiral has to land square at both ends, and it does that when its sweep
   * is an odd multiple of half a turn: the low end points one way, the high
   * end points exactly opposite, which is where the other platform is. Three
   * half-turns gives a proper twist and still arrives facing the right way.
   */
  const turn = fract(low[0] * 2.3 + high[2]) < 0.5 ? 1 : -1;
  const start = Math.atan2(low[2] - midZ, low[0] - midX);
  const sweep = Math.PI * 3 * turn;

  const reach = Math.max(0.95, (run / 2) * 0.62);
  const tread = 0.72;

  const parts: Part[] = [
    // The newel, from under the lower deck to the upper.
    box(0.4, rise + 1.2, 0.4, {
      color,
      position: [midX, low[1] - 0.8, midZ],
      grad: [0.3, 1],
    }),
  ];

  for (let i = 0; i <= SPIRAL_TREADS; i++) {
    const t = i / SPIRAL_TREADS;
    const angle = start + sweep * t;
    const y = low[1] + rise * t;
    const x = midX + Math.cos(angle) * reach * 0.5;
    const z = midZ + Math.sin(angle) * reach * 0.5;
    parts.push(
      box(reach, 0.22 - WEARING_COURSE, tread, {
        color,
        position: [x, y - 0.22, z],
        rotation: [0, -angle, 0],
        grad: [0.42, 1],
      }),
      box(reach - 0.12, WEARING_COURSE, tread - 0.12, {
        color: paving,
        position: [x, y - WEARING_COURSE, z],
        rotation: [0, -angle, 0],
        grad: [0.9, 1],
      }),
    );
  }

  /**
   * A landing at each end, bridging from the deck in to the first tread.
   *
   * The treads no longer run all the way out to the rims — that is what made
   * the flight a fan — so something has to cover the gap, and a landing is
   * what a stair uses. It reaches from just under the platform edge to where
   * the helix begins, which is also where a figure crossing the connector
   * actually walks.
   */
  const bridge = Math.max(0.6, run / 2 - reach * 0.5 + 0.5);
  /*
   * How far the landing tucks back under the platform, so there is no hairline
   * of sky where the two meet. Only the *base* is allowed to do that: its top
   * sits a wearing course down, which is inside the platform's own slab and
   * therefore invisible. The paving has to stop dead on the rim, exactly as the
   * bridge deck does — carry it under the platform as well and its top face
   * lands on the floor plane it is overlapping, which is the one thing
   * guaranteed to flash.
   */
  const TUCK = 0.25;
  for (const [end, y] of [
    [low, low[1]],
    [high, high[1]],
  ] as const) {
    const toward = alongX ? Math.sign(midX - end[0]) : Math.sign(midZ - end[2]);
    // Base: spans from TUCK inside the rim out to the foot of the helix.
    const baseCentre = (toward * bridge) / 2 - toward * TUCK;
    // Paving: shorter by the tuck, and shifted out so its near edge is the rim.
    const deckRun = bridge - TUCK;
    const deckCentre = (toward * deckRun) / 2;
    parts.push(
      box(alongX ? bridge : connector.width, 0.26 - WEARING_COURSE, alongX ? connector.width : bridge, {
        color,
        position: [
          end[0] + (alongX ? baseCentre : 0),
          y - 0.26,
          end[2] + (alongX ? 0 : baseCentre),
        ],
        grad: [0.45, 1],
      }),
      box(alongX ? deckRun : connector.width - 0.12, WEARING_COURSE, alongX ? connector.width - 0.12 : deckRun, {
        color: paving,
        position: [
          end[0] + (alongX ? deckCentre : 0),
          y - WEARING_COURSE,
          end[2] + (alongX ? 0 : deckCentre),
        ],
        grad: [0.9, 1],
      }),
    );
  }

  return buildProp(parts);
}

/**
 * A lift: an open tower you ride up the inside of.
 *
 * Nothing about it moves, and it does not need to. The route through a lift is
 * an L — in at the bottom, straight up, out at the top — so a figure crossing
 * one rises *inside the frame*, between its corner posts, in full view. The
 * tower supplies the reason; the figure supplies the motion.
 */
function liftGeometry(connector: Connector, color: string, paving: string): BufferGeometry {
  const up = connector.b[1] >= connector.a[1];
  const low = up ? connector.a : connector.b;
  const high = up ? connector.b : connector.a;

  // The shaft stands over the high end — that is where `via` sends the figure.
  const x = high[0];
  const z = high[2];
  const rise = high[1] - low[1];
  const half = Math.max(0.75, connector.width * 0.45);
  const post = 0.17;
  const parts: Part[] = [];

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(
        box(post, rise + 1.5, post, {
          color: paving,
          position: [x + sx * half, low[1] - 0.9, z + sz * half],
          grad: [0.5, 1],
        }),
      );
    }
  }

  // Cross-braces up the frame, which is what stops four posts reading as four
  // posts and starts them reading as a tower.
  const rungs = Math.max(2, Math.round(rise / 1.3));
  for (let i = 1; i <= rungs; i++) {
    const y = low[1] + (rise * i) / rungs;
    for (const sz of [-1, 1]) {
      parts.push(
        box(half * 2 + post, 0.12, post * 0.8, {
          color,
          position: [x, y, z + sz * half],
          grad: [0.6, 1],
        }),
      );
    }
    for (const sx of [-1, 1]) {
      parts.push(
        box(post * 0.8, 0.12, half * 2 + post, {
          color,
          position: [x + sx * half, y, z],
          grad: [0.6, 1],
        }),
      );
    }
  }

  // The cab, parked at the bottom, and the head the rope runs over. Both in
  // the paving tone: a lift cut from the dark side colour reads as timber
  // scaffolding, and there is no timber anywhere else in this office.
  parts.push(
    box(half * 1.6, 0.14, half * 1.6, {
      color: paving,
      position: [x, low[1] - 0.14, z],
      grad: [0.9, 1],
    }),
    box(half * 1.75, 0.16, half * 1.75, {
      color,
      position: [x, low[1] - 0.3, z],
      grad: [0.45, 1],
    }),
    // A head frame, stepped, so the tower ends rather than stops.
    box(half * 2.1, 0.2, half * 2.1, {
      color: paving,
      position: [x, high[1] + 0.5, z],
      grad: [0.72, 1],
    }),
    box(half * 1.5, 0.22, half * 1.5, {
      color,
      position: [x, high[1] + 0.7, z],
      grad: [0.55, 1],
    }),
  );

  // The walk in: a short deck from the lower platform to the foot of the shaft.
  const alongX = connector.axis === 'x';
  const run = alongX ? Math.abs(x - low[0]) : Math.abs(z - low[2]);
  if (run > 0.2) {
    parts.push(
      box(alongX ? run + 0.4 : connector.width, 0.22 - WEARING_COURSE, alongX ? connector.width : run + 0.4, {
        color,
        position: [alongX ? (x + low[0]) / 2 : x, low[1] - 0.22, alongX ? z : (z + low[2]) / 2],
        grad: [0.45, 1],
      }),
      // Lifted clear of the floor rather than let into it. A lift serving a
      // stacked terrace stands *on* its host, so this deck lies across the
      // host's own paving instead of bridging a gap — an apron at the foot of
      // the shaft, which is what it should have looked like anyway.
      box(alongX ? run : connector.width - 0.12, WEARING_COURSE, alongX ? connector.width - 0.12 : run, {
        color: paving,
        position: [alongX ? (x + low[0]) / 2 : x, low[1] + FLOOR_LIFT, alongX ? z : (z + low[2]) / 2],
        grad: [0.9, 1],
      }),
    );
  }

  return buildProp(parts);
}
