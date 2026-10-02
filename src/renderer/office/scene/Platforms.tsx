import { useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { EdgesGeometry, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { paletteAt } from '@shared/palette';
import { Staging } from '../anim/staging';
import { MAX_STAGES, createFacetMaterial, createInkMaterial, stageUniforms } from '../material/facet';
import { box, buildProp, slab, tagStage, type Part } from '../props/kit';
import { buildPropFor, propPalette } from '../props/registry';
import { stoneVariant, type ResolvedTheme } from '../theme/themes';
import { spiralShape, spiralStep, WALK } from '../world/spiral';
import { levelY, PLATFORM_THICKNESS } from '../world/campusTemplate';
import type { Campus, Connector, Platform } from '../world/layout';
import { campusArchGeometry, corbelArch, type ArchPlan } from '../world/architecture';
import { LightPools } from './LightPools';
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
  staging,
  onPick,
}: {
  campus: Campus;
  theme: ResolvedTheme;
  architecture: ArchPlan;
  /** Owned by the office, because the masts and the labels read it too. */
  staging: Staging;
  /** Where a double-click landed, in world space. See `nearestDesk`. */
  onPick?: (point: [number, number, number]) => void;
}): React.JSX.Element {
  const material = useMemo(() => createFacetMaterial({ staged: true }), []);

  /*
   * Arrivals and departures.
   *
   * Kept in a ref and ticked from `useFrame`, never in state: a room rising
   * takes ninety frames and re-rendering the office for each of them is the
   * one thing this view is built not to do. The only reason anything here
   * touches React at all is `revision` — the merged mesh has to be rebuilt on
   * the frames where the *set* of rooms changes, and not otherwise.
   */
  const [revision, setRevision] = useState(0);
  const previous = useRef(campus);

  const shown = useMemo(() => {
    // A room that has gone is kept for as long as it takes to sink, which is
    // why the reading is taken against the campus from a moment ago.
    if (previous.current !== campus) {
      staging.remember(previous.current);
      previous.current = campus;
    }
    staging.sync(campus, MAX_STAGES);
    return {
      platforms: [...campus.platforms, ...staging.sinking()],
      connectors: [...campus.connectors, ...staging.sinkingConnectors()],
    };
    // `revision` is the second half of the reason this recomputes: a room
    // finishing its descent has to leave the mesh, and nothing about the
    // campus changes when it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campus, staging, revision]);

  const palette = `${theme.id}:${Math.round(theme.dayFactor * 12)}`;
  const inked = theme.ink !== undefined;
  const built = useMemo(() => {
    REBUILDS.geometry += 1;
    const parts: BufferGeometry[] = [];
    /*
     * The outlines, built per room and tagged before they are merged.
     *
     * `EdgesGeometry` keeps `position` and discards everything else, so an
     * outline taken from the finished campus knows nothing about which room it
     * belongs to — which is why, in Ink & Paper, a room rising left its own
     * wireframe hanging above it. Taken per part, each set of lines can carry
     * the same staging slot its solid does.
     */
    const outlines: BufferGeometry[] = [];
    const edge = (geometry: BufferGeometry, slot: number): void => {
      if (!inked) return;
      outlines.push(tagStage(new EdgesGeometry(geometry, 30), slot));
    };
    const staged = (id: string): number => staging.slotOf(id);
    for (const platform of shown.platforms) {
      const piece = tagStage(platformGeometry(platform, theme), staged(platform.id));
      edge(piece, staged(platform.id));
      parts.push(piece);
    }
    // A walkway takes the stone of the platform it lands on, which for a stair
    // is the lower end — the one whose floor it continues. Both halves of that
    // stone come from the same platform, or the landing is a different colour
    // from the floor it lands on.
    const stoneOf = new Map(shown.platforms.map((p) => [p.id, [p.stone, p.stoneLevel] as const]));
    for (const connector of shown.connectors) {
      const [stone, level] = stoneOf.get(connector.from) ?? [0, 0];
      // A walkway rises with whichever end is doing the moving, so a bridge to
      // a new room arrives with it rather than reaching out over nothing.
      const slot = staging.walkwaySlot(connector.from, connector.to);
      const piece = tagStage(connectorGeometry(connector, theme, stone, level), slot);
      edge(piece, slot);
      parts.push(piece);
    }
    // The architecture merges in here rather than into a mesh of its own: it
    // is made of the same stone and lit by the same rules, and one more draw
    // call per frame for something that never moves would be a waste.
    //
    for (const platform of shown.platforms) {
      const raised = campusArchGeometry(
        { ...campus, platforms: [platform] },
        architecture,
        theme,
        () => true,
        () => staged(platform.id),
      );
      if (!raised) continue;
      edge(raised, staged(platform.id));
      parts.push(raised);
    }

    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    const lines = outlines.length > 0 ? mergeGeometries(outlines, false) : null;
    for (const outline of outlines) outline.dispose();
    return { geometry: merged ?? parts[0]!, lines };
    // `palette` stands in for the theme: rebuilding on every interpolated frame
    // would merge the whole campus sixty times a second for no visible gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, campus, architecture, palette, inked]);
  const geometry = built.geometry;

  /*
   * How far under the world a struck room sits.
   *
   * Far enough to be inside the void fade from every level the campus uses, so
   * a room that has not arrived is not merely low — it is gone. Measured off
   * the campus rather than fixed, because a hillside world can span twice the
   * height of a flat one, and a room that starts *above* the fade is a building
   * that drops into place out of clear sky.
   */
  const drop = useMemo(() => {
    let low = Infinity;
    let high = -Infinity;
    for (const platform of campus.platforms) {
      const y = levelY(platform.level);
      low = Math.min(low, y);
      high = Math.max(high, y);
    }
    if (!Number.isFinite(low)) return 24;
    // The span, the void fade below it, and headroom for whatever is standing
    // on the tallest terrace.
    return high - low + 24;
  }, [campus]);

  useFrame((_state, delta) => {
    const stage = stageUniforms(material);
    if (!stage) return;
    stage.uStageDrop.value = drop;
    staging.setDrop(drop);
    const { retired } = staging.step(Math.min(delta, 0.1));
    staging.write(stage.uStage.value);
    // The outlines travel with the solids they outline.
    const ink = edgeMaterial ? stageUniforms(edgeMaterial) : null;
    if (ink) {
      ink.uStageDrop.value = drop;
      ink.uStage.value.set(stage.uStage.value);
    }
    // Only when something finished: this is the frame a sunk room leaves the
    // mesh, and the only React render the whole animation costs.
    if (retired) setRevision((n) => n + 1);
  });

  /*
   * Ink & Paper's lines, and only its lines.
   *
   * The theme is named for a two-colour print and had no line in it at all:
   * what drew the shapes was a platform side the colour of ink, which on a
   * surface that size is not a line but a hole, and the campus came out as
   * black masses on cream. Every other theme is a solid; this one is a
   * drawing, and a drawing needs an edge.
   *
   * Cheap because everything above is already one merged geometry, so this is
   * one more buffer and one more draw call, built on exactly the occasions the
   * mesh itself is rebuilt. The threshold keeps it to real creases and
   * silhouettes rather than outlining every triangle in the campus.
   */
  const edgeMaterial = useMemo(() => (theme.ink === undefined ? null : createInkMaterial(theme.ink)), [theme.ink]);

  return (
    <>
      <mesh
        geometry={geometry}
        material={material}
        frustumCulled={false}
        onDoubleClick={(event) => {
          if (!onPick) return;
          // Only the nearest hit: a campus is a merged mesh, so a ray through
          // it reports every floor it passes through on the way down.
          event.stopPropagation();
          onPick([event.point.x, event.point.y, event.point.z]);
        }}
      />
      {built.lines && edgeMaterial && (
        <lineSegments geometry={built.lines} material={edgeMaterial} frustumCulled={false} />
      )}
      {/* Read off the same merged geometry, so every lamp in it is accounted for. */}
      <LightPools geometry={geometry} campus={campus} theme={theme} staging={staging} />
    </>
  );
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
  const stone = stoneVariant(theme, platform.stone, platform.stoneLevel);
  const parts: Part[] = [
    slab(width, depth, PLATFORM_THICKNESS, {
      color: stone.top,
      position: [platform.position[0], y - PLATFORM_THICKNESS, platform.position[1]],
      grad: [0.15, 1],
    }),
  ];

  /*
   * A desk platform wears its session's colour as a rug, and nothing else.
   *
   * There used to be a band of it around the whole rim as well, at full
   * strength. It was the only saturated thing in the frame and it was an
   * outline — which is how a web page marks a selected card, not how this
   * picture uses colour, and at the default framing it read as a stray piece
   * of interface pasted onto the scene. Monument Valley puts colour in planes.
   *
   * What the band was actually for — picking your own session out of a crowded
   * office, from any angle and any zoom — a floor could never do anyway, since
   * a floor is the first thing the next platform along hides. That job moved
   * to the pile; see `DeskPiles`. The rug can now go back to being a rug.
   */
  if (platform.kind === 'desk' && platform.colorIndex !== undefined) {
    const color = paletteAt(platform.colorIndex);
    parts.push(
      box(width * 0.52, 0.035, depth * 0.52, {
        color: mix(color.base, stone.top, 0.42),
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

export function connectorGeometry(
  connector: Connector,
  theme: ResolvedTheme,
  stone = 0,
  level = 0,
): BufferGeometry {
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
  const variant = stoneVariant(theme, stone, level);
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

    /*
     * A rail up one side, following the treads. Only sometimes: on every
     * flight it stops being a detail and starts being a fence.
     *
     * The handrail is *raked*, which it was not. A post every two steps each
     * carried its own flat bar at its own height, so a sloping flight got a
     * staircase of disconnected horizontal bars — from any distance, a dotted
     * line of little T shapes trailing off the side of the stair, which is one
     * of the things that read as "the generation is broken". A handrail is one
     * continuous thing at the pitch of the flight, and the only way to draw it
     * out of boxes is to tilt them.
     */
    if (railed && i % 2 === 0) {
      const side = (-landingSide * (width - CHEEK)) / 2;
      const pitch = Math.atan2(riser, tread);
      // Long enough to overlap its neighbour, so the run reads as unbroken.
      const bar = Math.hypot(tread * 2, riser * 2) * 1.08;
      parts.push(
        box(0.1, 0.62, 0.1, {
          color: paving,
          position: [x + (alongX ? 0 : side), top, z + (alongX ? side : 0)],
          grad: [0.6, 1],
        }),
        box(alongX ? bar : 0.11, 0.1, alongX ? 0.11 : bar, {
          color: paving,
          position: [x + (alongX ? 0 : side), top + 0.62, z + (alongX ? side : 0)],
          rotation: alongX ? [0, 0, dirX * pitch] : [-dirZ * pitch, 0, 0],
          grad: [0.85, 1],
        }),
      );
    }

    /*
     * The cheeks: the same steps again, thin and deeper, down each side.
     *
     * Stopped a wearing course *under* the tread, not level with it. Reaching
     * the walking surface put a stone-coloured face on the same plane as the
     * paving beside it, and the depth test picked between them per pixel — so
     * every flight in the office wore a dotted line of little grey diamonds
     * down it, which is one of the things that read as broken generation.
     * Nothing on a walkway may come up to the height you walk on except the
     * thing you walk on.
     */
    for (const side of [-1, 1]) {
      parts.push(
        box(alongX ? tread : CHEEK, height + 0.3 - WEARING_COURSE - 0.02, alongX ? CHEEK : tread, {
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
/*
 * A spiral is a *stair*, and a stair has a step height.
 *
 * Both the tread count and the sweep used to be constants: twenty-six treads
 * over one and a half turns, whatever the drop. Across a level and a half that
 * is a rise of six centimetres a tread against a tread twenty-two thick, and a
 * turn of twenty degrees against a tread long enough to overlap its neighbour
 * four times over — so the treads interpenetrated and splayed outward. Not a
 * helix: a fan of cards wrapped round a post, in every world, at every seed.
 *
 * Step height is the thing that is actually fixed in a stair. The count follows
 * the rise, the sweep follows the count, and the tread is cut to the arc it has
 * to fill — so a short flight makes a quarter turn of deep treads and a long
 * one makes three half-turns of shallow ones, which is what a spiral stair
 * does.
 */
/** What one step climbs. */
const RISER = 0.24;
/** And roughly how far round it goes; the sweep is snapped off this. */
const TURN_PER_TREAD = 0.44;

function spiralGeometry(connector: Connector, color: string, paving: string): BufferGeometry {
  // The curve itself lives in `world/spiral.ts`, because the router walks the
  // same one. They were worked out separately once and disagreed, and what
  // that drew was every figure walking straight through the newel.
  const shape = spiralShape(connector);
  const { low, high, rise, midX, midZ, reach, treads, tread } = shape;
  const alongX = connector.axis === 'x';
  const run = alongX ? Math.abs(high[0] - low[0]) : Math.abs(high[2] - low[2]);

  // Treads run from just inside the newel out to `reach`, centred on the line
  // `WALK` puts them — the same line the router walks, so a figure is always
  // on the middle of a step rather than off the edge of one.
  const depth = reach * (1 - WALK) * 2;
  const newel = Math.max(0.46, reach * 0.44);

  const parts: Part[] = [
    // The newel, from under the lower deck to the upper. Wide enough to hide
    // where the inner ends of the treads run into each other.
    box(newel, rise + 1.2, newel, {
      color,
      position: [midX, low[1] - 0.8, midZ],
      grad: [0.3, 1],
    }),
  ];

  for (let i = 0; i <= treads; i++) {
    const t = i / treads;
    const { at, angle } = spiralStep(shape, t);
    const [x, y, z] = at;
    parts.push(
      box(depth, 0.22 - WEARING_COURSE, tread, {
        color,
        position: [x, y - 0.22, z],
        rotation: [0, -angle, 0],
        grad: [0.42, 1],
      }),
      box(depth - 0.12, WEARING_COURSE, tread - 0.12, {
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
  const bridge = Math.max(0.5, run / 2 - reach + 0.45);
  /*
   * And no wider than the flight it serves.
   *
   * The landing used to be the connector's full width, which on a two-level
   * climb is four units against a helix two and a bit across — so it sat over
   * the stair like a lid and, from an isometric camera, the only thing you
   * could see of a spiral was its two landings. A landing is the foot of this
   * flight, not a piece of the platform, and it should be the size of the
   * flight.
   */
  const apron = Math.min(connector.width, reach * 1.8);
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
      box(alongX ? bridge : apron, 0.26 - WEARING_COURSE, alongX ? apron : bridge, {
        color,
        position: [
          end[0] + (alongX ? baseCentre : 0),
          y - 0.26,
          end[2] + (alongX ? 0 : baseCentre),
        ],
        grad: [0.45, 1],
      }),
      box(alongX ? deckRun : apron - 0.12, WEARING_COURSE, alongX ? apron - 0.12 : deckRun, {
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



