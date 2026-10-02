import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { Group } from 'three';
import { paletteAt } from '@shared/palette';
import type { World } from '@shared/model';
import { cameraState } from '../camera/cameraState';
import { levelY } from '../world/campusTemplate';
import type { Campus, Platform } from '../world/layout';
import type { Staging } from '../anim/staging';

/**
 * The only text in the world.
 *
 * Zone names sit low and quiet; a desk carries its session's name so you can
 * find your own work without clicking anything. Labels are HTML rather than 3D
 * text so they stay crisp at every zoom and need no bundled font.
 *
 * Each one rides on the edge of its platform nearest the camera, recomputed as
 * you orbit — a label pinned to a fixed side ends up behind the furniture, or
 * underneath the platform, as soon as you swing round.
 */
/**
 * Pulled back past this much, the office is a map and the labels come off.
 *
 * Text is the one thing in the scene that does not shrink: it is HTML, so it
 * holds its point size while the campus it belongs to gets smaller. Zoomed
 * out, a dozen names that were comfortably spaced become a heap of overlapping
 * words sitting on top of a small picture — the labels end up the loudest thing
 * in a frame where they are the least useful, because at that size you are
 * looking at the shape of the whole place rather than reading a room's name.
 *
 * What survives instead is what is built to: the masts, which are geometry and
 * scale with everything else, and the attention halo. That is the overview.
 *
 * Measured on the viewer's own zoom rather than on the camera's. The camera's
 * zoom is the *fit* times that, and the fit falls whenever the view gets
 * harder to frame — a low camera angle, a wide window, a campus with more
 * desks out. So the labels used to half-disappear the moment you tipped the
 * camera down, at the very angle where they are most readable and the office
 * has not got any smaller. That is the "not legible from all angles" report.
 */
const MAP_REACH = 0.62;
/** A band rather than a line, so a slow pinch fades rather than flicks. */
const MAP_FADE = 0.2;

export function Labels({
  campus,
  world,
  staging,
}: {
  campus: Campus;
  world: World;
  staging: Staging;
}): React.JSX.Element {
  const labelled = useMemo(() => campus.platforms.filter((platform) => platform.label), [campus]);
  const groups = useRef<(Group | null)[]>([]);
  const shown = useRef(1);

  useFrame(() => {
    // Screen-down, projected onto the ground: the direction that reads as
    // "toward the viewer" from this angle.
    const toward = { x: Math.sin(cameraState.azimuth), z: Math.cos(cameraState.azimuth) };
    const presence = Math.max(0, Math.min(1, (cameraState.reach - MAP_REACH) / MAP_FADE));
    const changed = Math.abs(presence - shown.current) > 0.001;
    shown.current = presence;

    for (let i = 0; i < labelled.length; i++) {
      const group = groups.current[i];
      const platform = labelled[i];
      if (!group || !platform) continue;
      const reach = supportRadius(platform, toward) + 0.55;
      group.position.set(
        platform.position[0] + toward.x * reach,
        levelY(platform.level) + 0.12,
        platform.position[1] + toward.z * reach,
      );
      /*
       * A name only once the room it belongs to has nearly arrived.
       *
       * Not moved down with the platform, the way the mast is: a label is HTML
       * at a projected point and nothing occludes it, so a nameplate riding a
       * room up from twenty units below would track across the bottom of the
       * frame over everything in its way. Withheld instead — which is also the
       * honest reading, since the room has no name until it is a room.
       */
      // Measured in units off home rather than in progress: the rise is eased
      // hard, so two-thirds of the way through the *curve* is still eight
      // units down in the fog — and a nameplate was appearing over open sky.
      const wanted = presence > 0.02 && staging.offsetOf(platform.id) > -0.9;
      if (group.visible !== wanted) group.visible = wanted;
    }

    if (changed) {
      const root = document.documentElement.style;
      root.setProperty('--office-label-presence', presence.toFixed(3));
    }
  });

  return (
    <>
      {labelled.map((platform, index) => {
        const isDesk = platform.kind === 'desk';
        const color = isDesk && platform.colorIndex !== undefined ? paletteAt(platform.colorIndex).base : undefined;

        return (
          <group
            key={platform.id}
            ref={(node) => {
              groups.current[index] = node;
            }}
          >
            <Html center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
              <span className={isDesk ? 'office-label office-label--desk' : 'office-label'}>
                {color && <i className="office-label__dot" style={{ background: color }} />}
                {nameOf(platform, world)}
              </span>
            </Html>
          </group>
        );
      })}
    </>
  );
}

/** How far a platform reaches in a direction — its support along that axis. */
function supportRadius(platform: Platform, toward: { x: number; z: number }): number {
  return Math.abs(toward.x) * (platform.size[0] / 2) + Math.abs(toward.z) * (platform.size[1] / 2);
}

/**
 * A desk's nameplate, read live rather than off the platform.
 *
 * The floor plan is built from what changes the floor plan, and a title does
 * not; baking it into the platform is what made a rename rebuild the campus.
 */
function nameOf(platform: Platform, world: World): string {
  if (platform.kind !== 'desk' || !platform.ownerId) return platform.label;
  const session = world.sessions[platform.ownerId];
  return session ? shortLabel(session.title) : platform.label;
}

/**
 * Session titles are sentences. A nameplate is not a place for a sentence: it
 * runs across the office and over everything else. Cut it at a word boundary.
 */
function shortLabel(title: string): string {
  const limit = 26;
  if (title.length <= limit) return title;
  const cut = title.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > 12 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
