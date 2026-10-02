import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { BufferAttribute, BufferGeometry, EdgesGeometry, type Group } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Horizon } from '@shared/prefs';
import { box, buildProp, type Part } from '../props/kit';
import { createFacetMaterial, createInkMaterial } from '../material/facet';
import { buildScenery } from '../world/scenery';
import { cameraState } from '../camera/cameraState';
import { horizonTones } from './skyLayers';
import type { ResolvedTheme } from '../theme/themes';

/**
 * The distance, built rather than painted.
 *
 * One merged mesh of stepped stone standing just past the campus, drawn through
 * the same facet material as everything else — so it takes the hour, the sun,
 * the overcast and the lightning without knowing any of them exist, and it
 * turns when you orbit, which is the entire reason it is here and not in the
 * atmosphere shader.
 *
 * It is not in the camera's fitting frame (see `OfficeView`), so however far it
 * sprawls the office stays the size it was. It is not pickable, and it never
 * moves: the whole thing is built once per seed, theme, kind and campus size.
 *
 * `scenery.ts` has the placement, and the reasoning behind it: what looks like
 * a horizon problem is really a projection problem, and the numbers there are
 * not free to be prettier than they are.
 */

/**
 * How much of the camera's turn the distance is allowed to answer.
 *
 * An orthographic camera has no perspective, so a thing thirty units out and a
 * thing three hundred units out swing across the frame by exactly the same
 * amount when you orbit — and the distance, which has to sit close to be in
 * frame at all, therefore wheeled about as violently as the office did. It
 * read as scenery on a turntable rather than as somewhere else.
 *
 * The group turns *with* the camera at this fraction, leaving the rest as
 * apparent motion. At 0.94 a full revolution of the office drifts the distance
 * by about twenty degrees: enough that turning round shows you something new,
 * far too little to be the thing your eye follows. It is the one cue the
 * projection will not give for free, so it is put in by hand.
 */
const PARALLAX = 0.94;

/**
 * How much sky is in the nearest landmark, and in the furthest.
 *
 * High, and it should be: this is not atmosphere over a few hundred metres, it
 * is the only thing saying "that is somewhere else" to a camera with no
 * perspective at all. At the near end a landmark is a suggestion of a shape; at
 * the far end it is barely a change in the sky. Anything more solid than that
 * and it stops being the distance and becomes another platform that has come
 * adrift, which is what it was twice reported as.
 *
 * Raised when the isles were made large. The two go together and neither works
 * alone: a big shape at this haze is a coastline a long way off, a small one is
 * a chip of gravel near by, and a big one any more solid than this is a second
 * campus.
 *
 * Then brought back a little, once the band was moved into the sky where it can
 * actually be seen. At 0.93 the archipelago was a suggestion you had to be
 * looking for; at 0.82 the cuboids are legible as cuboids and it reads as more
 * buildings. This is the setting where a landmark is a pale shape with an edge
 * you can find and a face you cannot.
 */
const HAZE_NEAR = 0.78;
const HAZE_FAR = 0.93;

export function Distance({
  theme,
  seed,
  kind,
  floorY,
  centre,
  spread,
}: {
  theme: ResolvedTheme;
  seed: number;
  kind: Horizon;
  floorY: number;
  /** The middle of the campus in plan — the camera's pivot, not the origin. */
  centre: [number, number];
  /** Half the campus footprint; everything here stands past it. */
  spread: number;
}): React.JSX.Element | null {
  const built = useMemo(() => {
    const pieces = buildScenery(kind, seed, floorY, spread);
    if (pieces.length === 0) return null;

    const stone = horizonTones(theme);
    const parts: Part[] = pieces.map((piece) =>
      box(piece.size[0], piece.size[1], piece.size[2], {
        color: piece.rock ? stone.near : stone.far,
        position: [piece.at[0], piece.at[1], piece.at[2]],
        rotation: [0, piece.yaw, 0],
        grad: piece.grad,
      }),
    );

    const geometry = buildProp(parts);
    /*
     * The haze, baked per vertex and spent in the shader.
     *
     * Depth fog is measured along the view axis, so it pales whatever is
     * behind the office and leaves whatever is beside it at full strength —
     * and under an orthographic camera "beside" is most of the ring. So the
     * amount has to come from the radius, which is what `wash` is.
     *
     * What it may *not* do is decide the colour. That was the last version:
     * the stone was mixed toward `theme.sky[0]` on the way in, and `sky[0]` is
     * the bottom of a vertical gradient painted in screen space. A landmark
     * beside the office at mid-frame sits in front of sky several shades
     * deeper, so it came out as a pale slab hanging in a dark sky — seventy
     * levels of red clear of its background at eighty-six per cent mixed. The
     * fragment already works the sky out for the fog and the void; this hands
     * it the amount and lets it pick.
     */
    const hazeOf = (index: number): number => HAZE_NEAR + pieces[index]!.wash * (HAZE_FAR - HAZE_NEAR);
    const haze = new Float32Array(geometry.getAttribute('position').count);
    let at = 0;
    for (let i = 0; i < parts.length; i += 1) {
      const vertices = parts[i]!.geometry.getAttribute('position').count;
      haze.fill(hazeOf(i), at, at + vertices);
      at += vertices;
    }
    geometry.setAttribute('aWash', new BufferAttribute(haze, 1));

    // The flat theme draws everything as outline; the distance is no exception,
    // or it is the one part of the office that is not a print. Its strokes take
    // the same haze, in alpha rather than in colour: a fill that has dissolved
    // inside an outline that has not is a wireframe hanging in the sky.
    let lines: BufferGeometry | null = null;
    if (theme.ink !== undefined) {
      const edges = parts.map((part) => {
        const moved = part.geometry.clone();
        const [px, py, pz] = part.options.position ?? [0, 0, 0];
        moved.translate(px, py, pz);
        const cut = new EdgesGeometry(moved, 30);
        moved.dispose();
        return cut;
      });
      lines = mergeGeometries(edges, false) as BufferGeometry | null;
      if (lines) {
        const strokes = new Float32Array(lines.getAttribute('position').count);
        let mark = 0;
        for (let i = 0; i < edges.length; i += 1) {
          const vertices = edges[i]!.getAttribute('position').count;
          strokes.fill(hazeOf(i), mark, mark + vertices);
          mark += vertices;
        }
        lines.setAttribute('aWash', new BufferAttribute(strokes, 1));
      }
      for (const cut of edges) cut.dispose();
    }

    return { geometry, lines };
  }, [kind, seed, theme, floorY, spread]);

  const material = useMemo(() => createFacetMaterial({ aerial: true }), []);
  const drift = useRef<Group>(null);

  useFrame(() => {
    /*
     * Negative, because a rotation about +Y takes a bearing *away*.
     *
     * `scenery` lays the band out astern along -z and across along +x, and this
     * is what keeps those two pointing where they say they do. With the sign
     * the other way round the band swung at nearly twice the rate of the
     * camera, so a quarter turn put the whole horizon behind the office and a
     * half turn put it under the keels.
     */
    if (drift.current) drift.current.rotation.y = -cameraState.azimuth * PARALLAX;
  });
  const ink = useMemo(
    () => (theme.ink === undefined ? null : createInkMaterial(theme.ink, { aerial: true })),
    [theme.ink],
  );

  useEffect(
    () => () => {
      built?.geometry.dispose();
      built?.lines?.dispose();
    },
    [built],
  );

  if (!built) return null;
  return (
    /*
     * Positioned at the campus, and turning about *that*.
     *
     * The group used to sit at the scene origin, which is a corner of the
     * campus rather than the middle of it — so every degree of camera swung
     * the whole archipelago around a point tens of units off to one side, and
     * a quarter turn threw it out of the window altogether. The report was
     * that the background behaves badly when you rotate; this is why. The
     * pieces are built about nothing now and the group puts them where the
     * camera is actually looking.
     */
    <group ref={drift} position={[centre[0], 0, centre[1]]}>
      {/*
        * Drawn before the office and never picked. `renderOrder` is belt and
        * braces — the depth buffer already sorts it — but it keeps the distance
        * out of the way of the transparent passes that come after, and a
        * double-click meant for a platform must never land on scenery.
        */}
      <mesh geometry={built.geometry} material={material} frustumCulled={false} renderOrder={-1} raycast={() => null} />
      {built.lines && ink && (
        <lineSegments geometry={built.lines} material={ink} frustumCulled={false} renderOrder={-1} raycast={() => null} />
      )}
    </group>
  );
}
