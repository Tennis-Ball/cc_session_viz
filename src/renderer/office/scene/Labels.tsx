import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { Group } from 'three';
import { paletteAt } from '@shared/palette';
import type { World } from '@shared/model';
import { cameraState } from '../camera/cameraState';
import { levelY } from '../world/campusTemplate';
import type { Campus, Platform } from '../world/layout';

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
export function Labels({ campus, world }: { campus: Campus; world: World }): React.JSX.Element {
  const labelled = useMemo(() => campus.platforms.filter((platform) => platform.label), [campus]);
  const groups = useRef<(Group | null)[]>([]);

  useFrame(() => {
    // Screen-down, projected onto the ground: the direction that reads as
    // "toward the viewer" from this angle.
    const toward = { x: Math.sin(cameraState.azimuth), z: Math.cos(cameraState.azimuth) };

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
  const session = world.sessions[platform.ownerId] ?? Object.values(world.sessions).find((s) => s.groupId === platform.ownerId);
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
