import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, InstancedMesh, Matrix4, MeshBasicMaterial, Object3D, SphereGeometry, type BufferGeometry } from 'three';
import { rng } from '@shared/rand';
import { createFacetMaterial } from '../material/facet';
import { buildProp, box, sphere, type Part } from '../props/kit';
import { perchTone } from './skyLayers';
import type { ResolvedTheme } from '../theme/themes';
import {
  FLIGHT,
  createBird,
  flockSize,
  shoo,
  stepBird,
  type Bird,
  type Perch,
  type Threat,
} from '../anim/birdFlight';
import { perchesFor } from '../anim/perches';
import type { ArchPlan } from '../world/architecture';
import type { Campus } from '../world/layout';

/**
 * Birds that land on the office.
 *
 * There are already birds in the sky — a flock painted into the atmosphere
 * quad, far off and permanently behind everything. They are weather. These are
 * the other kind: real geometry, at the office's own scale, that sits on the
 * tops of the things the office has built and leaves when somebody walks up.
 *
 * The whole point is the leaving. A campus full of architecture nobody touches
 * is a model; the moment something in it reacts to a figure crossing the floor,
 * the architecture becomes a place that figure is *in*.
 *
 * How they fly is in `anim/birdFlight`. What is here is the body, the wings,
 * and the three matrices per bird that put them where the model says.
 */

/**
 * How big a bird is, against a campus whose figures stand about 1.15 high.
 *
 * Authored at roughly life size against those figures and it vanished: a bird
 * is a thin dark dart seen from a long way up, so its *visual* mass is a
 * fraction of its dimensions, and at one-to-one it was three pixels of nothing
 * on a tower. This is an illustration rather than a scale model — the same
 * licence the office takes with every doorway in it — and a wingspan about the
 * height of a person is what makes the thing on the tower legible as a bird
 * instead of as a chip in the stone.
 */
const BIRD_SCALE = 1.75;
/** How far the body sits above whatever it is standing on, before scaling. */
const FOOT = 0.085;
/** The invisible sphere you actually click. Generous, because a bird is not. */
const HIT_RADIUS = 0.34;

/** Where the wing is hinged, in the body's own frame. */
const SHOULDER: [number, number, number] = [0.042, 0.03, 0.015];
/** Up at the top of the beat, down at the bottom. Radians. */
const FLAP_UP = 1.2;
const FLAP_DOWN = -0.68;
/** How far back the wing sweeps on the downstroke. */
const SWEEP = 0.28;
/**
 * Folded: swung back along the spine and laid *on* the body, not hung off it.
 *
 * The first pass drooped them, and a perched bird with its wings hanging down
 * is a bird with a cape. What a bird at rest actually does is close the wing
 * against its own back, where it all but disappears — so it sweeps nearly
 * straight back, lifts a little onto the shoulder, and shortens.
 */
const FOLD_FLAP = 0.13;
const FOLD_SWEEP = 1.5;
/** And a folded wing is a much shorter object than an open one. */
const FOLD_LENGTH = 0.68;
/** The flare: wings forward and high, which is what a landing looks like. */
const FLARE_SWEEP = -0.46;

export type { Perch } from '../anim/birdFlight';
export { perchesFor };

/**
 * A wing, as two folded panels.
 *
 * Not one swept surface. The office is flat-shaded facets all the way through
 * and a smoothly-curved wing would be the only object in it pretending to be
 * round — the same argument the drapes and the corbelled arches answer to. So
 * the wing steps: three panels, each shorter in the chord than the last and
 * each lifted a little further, and at the size a bird is on a tower the steps
 * read as the joint between the coverts, the secondaries and the primaries.
 *
 * `side` is +1 for the right wing. The left is the same panels mirrored, built
 * as its own geometry rather than drawn with a negative scale: mirroring a
 * matrix flips the winding, and a face the shader thinks is pointing away is a
 * hole.
 */
function wingParts(side: number): Part[] {
  const panels: [number, number, number, number, number][] = [
    // length, chord, x, sweep back, dihedral
    [0.26, 0.11, 0.128, 0.0, 0.0],
    [0.245, 0.048, 0.378, 0.058, 0.17],
  ];
  // Two, not three. Three panels put two steps in a blade that is four pixels
  // across at the size a bird actually is, and the joins read as a gap rather
  // than as a fold — the silhouette came out looking broken-winged.
  return panels.map(([length, chord, x, back, lift]) =>
    box(length, 0.012, chord, {
      color: '#ffffff',
      position: [side * x, -0.006, -back],
      rotation: [0, 0, side * lift],
      // Darker toward the tip, so the wing has a direction in it even flat on.
      grad: [0.88 - x * 0.5, 1],
    }),
  );
}

/** The body: a wedge, a head and a tail fan. No beak — see the note below. */
function bodyParts(): Part[] {
  return [
    // Slim and long. The first body was nearly as deep as it was wide and half
    // as long as the wingspan, which is a pigeon at best and reads as a lump.
    box(0.082, 0.075, 0.3, { color: '#ffffff', position: [0, -0.0375, 0], grad: [0.5, 1] }),
    sphere(0.044, { color: '#ffffff', position: [0, 0.026, 0.163] }, 10),
    // A tail rather than a cone pointing backwards: what says "bird" at this
    // distance is the flat fan behind, and it is also what banks visibly.
    box(0.062, 0.013, 0.2, {
      color: '#ffffff',
      position: [0, -0.008, -0.225],
      rotation: [-0.2, 0, 0],
      grad: [0.78, 1],
    }),
    // A beak is three pixels of noise at this size and always has been. The
    // head sphere sitting forward of the wedge is what gives it a front.
  ];
}

export function Birds({
  campus,
  plan,
  positions,
  seed,
  theme,
  /** Rain keeps them off the roofs; see `Atmosphere`. */
  grounded = false,
}: {
  campus: Campus;
  plan: ArchPlan;
  /** Everybody on the campus right now, agents and NPCs alike. */
  positions: () => Threat[];
  seed: number;
  theme: ResolvedTheme;
  grounded?: boolean;
}): React.JSX.Element | null {
  const perches = useMemo(() => perchesFor(campus, plan), [campus, plan]);

  const geometry = useMemo(
    () => ({
      body: buildProp(bodyParts()) as BufferGeometry,
      right: buildProp(wingParts(1)) as BufferGeometry,
      left: buildProp(wingParts(-1)) as BufferGeometry,
    }),
    [],
  );
  const material = useMemo(() => createFacetMaterial(), []);
  const bodies = useRef<InstancedMesh>(null);
  const rightWings = useRef<InstancedMesh>(null);
  const leftWings = useRef<InstancedMesh>(null);
  /*
   * Something big enough to hit.
   *
   * A bird is a couple of dozen pixels of thin dark geometry and its wings are
   * a millimetre thick, so pointing at the bird itself is pointing at nothing.
   * The same invisible-proxy trick the figures use, for the same reason.
   */
  const hits = useRef<InstancedMesh>(null);
  const hitGeometry = useMemo(() => new SphereGeometry(HIT_RADIUS, 8, 6), []);
  const hitMaterial = useMemo(
    () => new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
    [],
  );

  const scratch = useMemo(
    () => ({ body: new Object3D(), wing: new Object3D(), matrix: new Matrix4(), colour: new Color() }),
    [],
  );
  // Once per theme step, not once per bird per frame: parsing a hex allocates.
  scratch.colour.set(perchTone(theme));

  const birds = useMemo<Bird[]>(() => {
    const count = flockSize(perches.length);
    if (count === 0) return [];
    const random = rng(seed ^ 0xb1d5);
    return Array.from({ length: count }, (_, i) => createBird(perches, i, rng((random() * 0xffffffff) >>> 0)));
  }, [perches, seed]);

  /** Where the last bird went up, so the rest can catch it. See `FLIGHT.alarm`. */
  const alarm = useRef<{ at: [number, number, number]; age: number } | null>(null);

  const startle = (index: number): void => {
    const bird = birds[index];
    if (!bird || !shoo(bird, perches)) return;
    // Everything near it goes too, exactly as if a figure had walked up.
    alarm.current = { at: [...bird.at] as [number, number, number], age: 0 };
  };

  useFrame((_state, delta) => {
    const bodyMesh = bodies.current;
    const rightMesh = rightWings.current;
    const leftMesh = leftWings.current;
    if (!bodyMesh || !rightMesh || !leftMesh || birds.length === 0) return;
    const dt = Math.min(delta, 0.1);
    const threats = positions();
    if (alarm.current) alarm.current.age += dt * 1000;

    const context = {
      perches,
      threats,
      grounded,
      alarmAt: alarm.current?.at ?? null,
      alarmAgeMs: alarm.current?.age ?? 0,
    };

    for (let i = 0; i < birds.length; i += 1) {
      const bird = birds[i]!;
      const wasDown = bird.phase === 'perched' || bird.phase === 'alert';
      stepBird(bird, dt, context);
      // Somebody just went up. The rest of the flock has a moment to notice.
      if (wasDown && bird.phase === 'launch') alarm.current = { at: [...bird.at], age: 0 };

      const down = bird.phase === 'perched' || bird.phase === 'alert';
      // Perched birds bob; an alert one holds dead still, which is the tell.
      const bob = bird.phase === 'perched' ? Math.sin(bird.since * 1.9 + i) * 0.018 : 0;

      const frame = scratch.body;
      frame.position.set(bird.at[0], bird.at[1] + FOOT * BIRD_SCALE + bob, bird.at[2]);
      // Yaw first, then pitch, then bank — the order an aircraft is described
      // in, and the only one where the bank stays about the line of flight.
      frame.rotation.set(bird.pitch, bird.heading, bird.roll, 'YXZ');
      frame.scale.setScalar(BIRD_SCALE);
      frame.updateMatrix();
      bodyMesh.setMatrixAt(i, frame.matrix);
      bodyMesh.setColorAt(i, scratch.colour);

      const stroke = Math.sin(bird.beat);
      const flap = down
        ? FOLD_FLAP
        : FLAP_DOWN + (FLAP_UP - FLAP_DOWN) * (0.5 + 0.5 * stroke) * (0.28 + 0.72 * bird.power);
      // Swept back on the downstroke and gathered in on the up, which is what
      // makes a beat read as pulling air rather than as a hinge opening.
      const sweep = down
        ? FOLD_SWEEP
        : bird.phase === 'settle'
          ? FLARE_SWEEP
          : SWEEP * -stroke * bird.power;

      const hitMesh = hits.current;
      if (hitMesh) {
        // Only the ones you could actually shoo. A sphere round a bird already
        // in the air would eat clicks meant for the office behind it.
        const reach = down ? 1 : 0.0001;
        scratch.wing.position.set(0, 0.04, 0);
        scratch.wing.rotation.set(0, 0, 0);
        scratch.wing.scale.setScalar(reach);
        scratch.wing.updateMatrix();
        scratch.matrix.multiplyMatrices(frame.matrix, scratch.wing.matrix);
        hitMesh.setMatrixAt(i, scratch.matrix);
      }

      for (const [side, mesh] of [[1, rightMesh] as const, [-1, leftMesh] as const]) {
        const wing = scratch.wing;
        wing.position.set(side * SHOULDER[0], SHOULDER[1], SHOULDER[2]);
        wing.rotation.set(0, side * sweep, side * flap);
        // Euler XYZ, so the flap happens in the blade's own frame and the
        // sweep swings the flapped blade back — which is the order the two
        // joints actually work in, and the only one where a folded wing ends
        // up along the spine instead of pointing into it.
        wing.scale.set(down ? FOLD_LENGTH : 1, 1, down ? 0.85 : 1);
        wing.updateMatrix();
        scratch.matrix.multiplyMatrices(frame.matrix, wing.matrix);
        mesh.setMatrixAt(i, scratch.matrix);
        mesh.setColorAt(i, scratch.colour);
      }
    }

    const hitMesh = hits.current;
    if (hitMesh) {
      hitMesh.count = birds.length;
      hitMesh.instanceMatrix.needsUpdate = true;
      hitMesh.boundingSphere = null;
    }

    for (const mesh of [bodyMesh, rightMesh, leftMesh]) {
      mesh.count = birds.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      // Recomputed every frame: three.js caches an instanced mesh's bounding
      // sphere the first time it needs one, and a flock that flies out of a
      // stale sphere is silently culled. The same trap the figures fell into.
      mesh.boundingSphere = null;
    }
  });

  if (birds.length === 0) return null;
  return (
    <>
      <instancedMesh ref={bodies} args={[geometry.body, material, birds.length]} frustumCulled={false} />
      <instancedMesh ref={rightWings} args={[geometry.right, material, birds.length]} frustumCulled={false} />
      <instancedMesh ref={leftWings} args={[geometry.left, material, birds.length]} frustumCulled={false} />
      <instancedMesh
        ref={hits}
        args={[hitGeometry, hitMaterial, birds.length]}
        frustumCulled={false}
        onClick={(event) => {
          if (event.instanceId === undefined) return;
          event.stopPropagation();
          startle(event.instanceId);
        }}
        onPointerOver={(event) => {
          if (event.instanceId === undefined) return;
          event.stopPropagation();
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          document.body.style.cursor = '';
        }}
      />
    </>
  );
}

export { FLIGHT };
