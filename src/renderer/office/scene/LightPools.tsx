import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  Color,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  type BufferGeometry,
} from 'three';
import { levelY } from '../world/campusTemplate';
import type { Campus } from '../world/layout';
import type { Staging } from '../anim/staging';
import type { ResolvedTheme } from '../theme/themes';

/**
 * What a lamp throws on the floor.
 *
 * The office at night was the office by day with a different palette on it.
 * Every hex had been chosen with care and the result still read as "blue mode"
 * rather than as night, for a reason no palette can fix: a room at night is not
 * uniformly darker, it is dark *with bright places in it*. The eye reads night
 * from the contrast between a cool ambient and a few warm pools, and with no
 * lights in the scene there was nothing to make one.
 *
 * So the pools are drawn, the same way the contact shadows are. Each source
 * gets an additive disc lying on the floor beneath it, in the source's own
 * colour, fading in with the hour. No lighting, no shadow maps, no
 * postprocessing — one instanced mesh and one texture.
 */

/** Emissive strength above which a vertex counts as a light source. */
const SOURCE_THRESHOLD = 0.5;
/** Vertices closer together than this belong to the same lamp. */
const CLUSTER_RADIUS = 0.55;
/** Beyond this there is nothing left to light; a campus has a few dozen lamps. */
const MAX_POOLS = 160;

export interface LightSource {
  position: [number, number, number];
  color: Color;
  /** Half-width of the source, which sets how wide its pool spreads. */
  spread: number;
}

/**
 * Finds the lamps in a finished campus.
 *
 * Deliberately read back off the merged geometry rather than collected as the
 * props are built. Emissive is already a per-vertex attribute that every prop
 * sets and nothing else does, so the geometry is a complete and always-current
 * list of every light in the office — including ones added to a prop file
 * later, which a hand-maintained registry would quietly miss.
 */
export function lightSources(geometry: BufferGeometry): LightSource[] {
  const emissive = geometry.getAttribute('aEmissive');
  const position = geometry.getAttribute('position');
  const color = geometry.getAttribute('color');
  if (!emissive || !position) return [];

  const clusters: { x: number; y: number; z: number; n: number; r: number; g: number; b: number; extent: number }[] = [];

  for (let i = 0; i < emissive.count; i += 1) {
    if (emissive.getX(i) < SOURCE_THRESHOLD) continue;
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);

    let found = false;
    for (const cluster of clusters) {
      const dx = cluster.x / cluster.n - x;
      const dy = cluster.y / cluster.n - y;
      const dz = cluster.z / cluster.n - z;
      if (dx * dx + dy * dy + dz * dz > CLUSTER_RADIUS * CLUSTER_RADIUS) continue;
      cluster.x += x;
      cluster.y += y;
      cluster.z += z;
      cluster.n += 1;
      cluster.extent = Math.max(cluster.extent, Math.hypot(dx, dz));
      if (color) {
        cluster.r += color.getX(i);
        cluster.g += color.getY(i);
        cluster.b += color.getZ(i);
      }
      found = true;
      break;
    }
    if (found) continue;
    if (clusters.length >= MAX_POOLS) break;
    clusters.push({
      x,
      y,
      z,
      n: 1,
      extent: 0,
      r: color ? color.getX(i) : 1,
      g: color ? color.getY(i) : 1,
      b: color ? color.getZ(i) : 1,
    });
  }

  return clusters.map((cluster) => ({
    position: [cluster.x / cluster.n, cluster.y / cluster.n, cluster.z / cluster.n] as [number, number, number],
    // Averaged in the same space the geometry stores it, which is what the
    // shader multiplies — so a pool is exactly the colour of the thing casting
    // it, and a session-tinted monitor throws its session's colour.
    color: new Color(cluster.r / cluster.n, cluster.g / cluster.n, cluster.b / cluster.n),
    spread: Math.max(0.35, cluster.extent),
  }));
}

/**
 * Which floor a lamp is standing on.
 *
 * A monitor sits at desk height and a lantern halfway up a tower, so a pool
 * placed at the source's own height floats in the air. The platform under it
 * is the surface the light would actually fall on.
 */
function floorUnder(campus: Campus, x: number, z: number, y: number): { top: number; id: string } | null {
  let best: { top: number; id: string } | null = null;
  for (const platform of campus.platforms) {
    const [width, depth] = platform.size;
    const [px, pz] = platform.position;
    if (Math.abs(x - px) > width / 2 || Math.abs(z - pz) > depth / 2) continue;
    const top = levelY(platform.level);
    // The nearest floor at or below the lamp: an upper storey must not catch
    // the light belonging to the room beneath it.
    if (top > y + 0.2) continue;
    if (best === null || top > best.top) best = { top, id: platform.id };
  }
  return best;
}

export function LightPools({
  geometry,
  campus,
  theme,
  staging,
}: {
  geometry: BufferGeometry;
  campus: Campus;
  theme: ResolvedTheme;
  staging: Staging;
}): React.JSX.Element | null {
  const mesh = useRef<InstancedMesh>(null);

  const pools = useMemo(() => {
    const sources = lightSources(geometry);
    const placed: { at: [number, number, number]; color: Color; radius: number; on: string }[] = [];
    for (const source of sources) {
      const [x, y, z] = source.position;
      const floor = floorUnder(campus, x, z, y);
      if (floor === null) continue;
      const height = Math.max(0.2, y - floor.top);
      placed.push({
        // A lamp high above a floor throws a wider, fainter pool; keeping the
        // radius tied to height is the whole of what makes a tower lantern and
        // a desk lamp look like different fittings.
        at: [x, floor.top + 0.012, z],
        color: source.color,
        radius: Math.min(3.4, 0.9 + height * 0.55 + source.spread),
        // Whose floor it is, so a pool does not lie on a room that has not
        // arrived. The platform is drawn twenty units down while it rises;
        // this is not, because it is a different mesh.
        on: floor.id,
      });
    }
    return placed;
  }, [geometry, campus]);

  const disc = useMemo<BufferGeometry>(() => new CircleGeometry(1, 28).rotateX(-Math.PI / 2), []);

  const material = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const gradient = ctx.createRadialGradient(64, 64, 1, 64, 64, 62);
      // A hot centre that falls away fast, then a long tail. A linear falloff
      // reads as a flat disc of paint; this reads as light.
      gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
      gradient.addColorStop(0.28, 'rgba(255,255,255,0.4)');
      gradient.addColorStop(0.62, 'rgba(255,255,255,0.12)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 128, 128);
    }
    return new MeshBasicMaterial({
      map: new CanvasTexture(canvas),
      transparent: true,
      // Additive, because light adds. Multiplying a pool into the floor makes
      // a stain; adding it makes a glow, and adding it to a floor that is
      // already pale is what keeps the effect subtle by day without anyone
      // having to special-case the hour.
      blending: AdditiveBlending,
      depthWrite: false,
      vertexColors: true,
      opacity: 0,
    });
  }, []);

  const object = useMemo(() => new Object3D(), []);

  useFrame(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    // Lamps come up as the light goes down. Squared so the office is not
    // faintly glowing all afternoon.
    const night = theme.emissive * theme.emissive;
    material.opacity = night;
    instanced.visible = night > 0.01;
    if (!instanced.visible) return;

    for (let i = 0; i < pools.length; i += 1) {
      const pool = pools[i]!;
      // Down with the room it lies on, and small until the room is there: the
      // lamp is in the merged mesh and travels in the shader, the pool is not.
      const built = staging.valueOf(pool.on);
      object.position.set(pool.at[0], pool.at[1] + staging.offsetOf(pool.on), pool.at[2]);
      object.scale.set(pool.radius * built, 1, pool.radius * built);
      object.updateMatrix();
      instanced.setMatrixAt(i, object.matrix);
      instanced.setColorAt(i, pool.color);
    }
    instanced.count = pools.length;
    instanced.instanceMatrix.needsUpdate = true;
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
  });

  if (pools.length === 0) return null;
  return (
    <instancedMesh
      ref={mesh}
      args={[disc, material, Math.max(1, pools.length)]}
      frustumCulled={false}
      renderOrder={2}
    />
  );
}
