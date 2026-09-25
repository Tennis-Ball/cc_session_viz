import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { BoxGeometry, Color, InstancedBufferAttribute, InstancedMesh, Object3D } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createFacetMaterial } from '../material/facet';
import { prepareGeometry } from '../props/kit';
import type { FlightPool } from '../anim/flights';

/**
 * Envelopes in transit.
 *
 * Drawn as folded paper: a flat sheet with a raised spine, so it reads as a
 * note from any camera angle rather than a disappearing plane at grazing ones.
 */

const CAPACITY = 24;
const _object = new Object3D();
const _color = new Color();

function envelopeGeometry(): ReturnType<typeof prepareGeometry> {
  const sheet = new BoxGeometry(0.42, 0.03, 0.3);
  const spine = new BoxGeometry(0.42, 0.13, 0.04).translate(0, 0.07, 0);
  const merged = mergeGeometries([sheet, spine], false);
  sheet.dispose();
  spine.dispose();
  if (!merged) throw new Error('envelopeGeometry: merge failed');
  return prepareGeometry(merged, [0.35, 1]);
}

export function Envelopes({ pool }: { pool: FlightPool }): React.JSX.Element {
  const mesh = useRef<InstancedMesh>(null);
  const geometry = useMemo(envelopeGeometry, []);
  const material = useMemo(() => createFacetMaterial({ instancedGradient: true }), []);
  const colors = useMemo(
    () => ({
      bottom: new InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3),
      top: new InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3),
    }),
    [],
  );

  useLayoutEffect(() => {
    geometry.setAttribute('aColorBottom', colors.bottom);
    geometry.setAttribute('aColorTop', colors.top);
  }, [geometry, colors]);

  useFrame(() => {
    const instancedMesh = mesh.current;
    if (!instancedMesh) return;

    const poses = pool.poses(performance.now());
    const count = Math.min(poses.length, CAPACITY);
    instancedMesh.count = count;
    if (count === 0) return;

    for (let i = 0; i < count; i++) {
      const pose = poses[i]!;
      _object.position.set(pose.position[0], pose.position[1], pose.position[2]);
      // Banking into the direction of travel keeps it from looking like a
      // sliding sticker.
      _object.rotation.set(0.32, pose.heading, 0.16);
      _object.scale.setScalar(Math.max(0.0001, 0.6 + pose.presence * 0.4));
      _object.updateMatrix();
      instancedMesh.setMatrixAt(i, _object.matrix);

      _color.set(pose.color);
      colors.bottom.setXYZ(i, _color.r, _color.g, _color.b);
      _color.set('#ffffff').lerp(new Color(pose.color), 0.25);
      colors.top.setXYZ(i, _color.r, _color.g, _color.b);
    }

    instancedMesh.instanceMatrix.needsUpdate = true;
    colors.bottom.needsUpdate = true;
    colors.top.needsUpdate = true;
  });

  return <instancedMesh ref={mesh} args={[geometry, material, CAPACITY]} frustumCulled={false} renderOrder={2} />;
}
