import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BoxGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  TorusGeometry,
  type BufferGeometry,
} from 'three';
import type { FigureShape } from '../figures/geometry';
import { createFacetMaterial } from '../material/facet';
import { figureGeometry } from '../figures/geometry';
import { prepareGeometry } from '../props/kit';
import type { FigureController, FigurePose } from '../anim/figureController';

/**
 * Everyone in the office, as one instanced mesh per silhouette.
 *
 * Figures move every frame, so they are written straight into instance matrices
 * — React never re-renders for a step taken.
 */

const CAPACITY = 96;
const _object = new Object3D();
const _color = new Color();

export interface FigureInstance {
  controller: FigureController;
  colorBottom: string;
  colorTop: string;
  translucent: boolean;
  /**
   * What a held thing looks like. The context stack is a sheaf of paper; what
   * somebody brings back from the coffee machine is not.
   */
  carryKind?: 'papers' | 'cup';
  /**
   * 0–1. A figure the pointer is on, or one that has been clicked. It grows a
   * little rather than changing colour: in a palette this close-toned, a tint
   * is easy to miss and easy to mistake for a state the office already uses.
   */
  highlight?: number;
}

export interface FigureInteraction {
  onHover(agentId: string | null): void;
  onSelect(agentId: string): void;
}

export function Figures({
  instances,
  interaction,
}: {
  instances: FigureInstance[];
  interaction?: FigureInteraction;
}): React.JSX.Element {
  const byRole = useMemo(() => {
    const groups = new Map<FigureShape, FigureInstance[]>();
    for (const instance of instances) {
      const role = instance.controller.role;
      const list = groups.get(role) ?? [];
      list.push(instance);
      groups.set(role, list);
    }
    return groups;
  }, [instances]);

  return (
    <>
      {[...byRole.entries()].map(([role, group]) => (
        <RoleBatch key={role} role={role} instances={group} />
      ))}
      {interaction && <HitProxies instances={instances} interaction={interaction} />}
      <Shadows instances={instances} />
      <Carried instances={instances} />
      <Halos instances={instances} />
    </>
  );
}

function RoleBatch({ role, instances }: { role: FigureShape; instances: FigureInstance[] }): React.JSX.Element {
  const mesh = useRef<InstancedMesh>(null);
  const geometry = useMemo(() => figureGeometry(role), [role]);
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
    const count = Math.min(instances.length, CAPACITY);
    instancedMesh.count = count;

    for (let i = 0; i < count; i++) {
      const instance = instances[i]!;
      const pose = instance.controller.pose();
      applyPose(_object, pose, 1 + 0.16 * (instance.highlight ?? 0));
      instancedMesh.setMatrixAt(i, _object.matrix);

      _color.set(instance.colorBottom);
      colors.bottom.setXYZ(i, _color.r, _color.g, _color.b);
      _color.set(instance.colorTop);
      colors.top.setXYZ(i, _color.r, _color.g, _color.b);
    }

    instancedMesh.instanceMatrix.needsUpdate = true;
    colors.bottom.needsUpdate = true;
    colors.top.needsUpdate = true;
  });

  return <instancedMesh ref={mesh} args={[geometry, material, CAPACITY]} frustumCulled={false} />;
}

/**
 * What the pointer actually hits.
 *
 * The figures used to carry their own pointer handlers, one batch per role,
 * which made the hitbox the model — and the model is a cone thirty centimetres
 * across with a ball on top, drawn at a zoom where the whole campus fits in a
 * window. Hitting it meant hitting a shape a few pixels wide with a hole
 * between the shoulders and the head, and only if it was one of the roles that
 * happened to be under the cursor. Half the clicks aimed at somebody landed on
 * the floor behind them.
 *
 * So the pointer gets a shape of its own: one capsule per figure, enclosing the
 * whole silhouette with a little to spare, invisible but still raycast. One
 * mesh for the entire population rather than one per role, which also means a
 * single index → id map and no chance of two batches disagreeing about who is
 * under the cursor.
 *
 * `colorWrite` off rather than `visible` off: an invisible object is skipped by
 * the raycaster, which would defeat the whole thing.
 */
export const HIT_RADIUS = 0.42;
export const HIT_HEIGHT = 1.15;
/**
 * How far below the floor the capsule starts.
 *
 * Not every body sits exactly on it — an Explore agent is an octahedron, and
 * its bottom point dips a couple of centimetres under. Two centimetres of
 * unclickable toe is not a bug anybody would file, but a hitbox that is
 * *asserted* to contain the model has to actually contain it, or the assertion
 * is the thing that rots.
 */
export const HIT_DROP = 0.06;

function HitProxies({
  instances,
  interaction,
}: {
  instances: FigureInstance[];
  interaction: FigureInteraction;
}): React.JSX.Element {
  const mesh = useRef<InstancedMesh>(null);
  const geometry = useMemo<BufferGeometry>(
    () => new CapsuleGeometry(HIT_RADIUS, HIT_HEIGHT - HIT_RADIUS * 2, 4, 8).translate(0, HIT_HEIGHT / 2 - HIT_DROP, 0),
    [],
  );
  const material = useMemo(
    () => new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
    [],
  );

  useFrame(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    const count = Math.min(instances.length, CAPACITY);
    instanced.count = count;
    for (let i = 0; i < count; i++) {
      const pose = instances[i]!.controller.pose();
      // Position and scale only. The capsule is a hitbox, so it does not want
      // the lean, the squash or the turn — all of which would make the target
      // move about under the cursor while the figure is being read.
      const scale = Math.max(0.0001, pose.scale);
      _object.position.set(pose.position[0], pose.position[1] + pose.seated * pose.seatHeight, pose.position[2]);
      _object.rotation.set(0, 0, 0);
      _object.scale.setScalar(scale);
      _object.updateMatrix();
      instanced.setMatrixAt(i, _object.matrix);
    }
    instanced.instanceMatrix.needsUpdate = true;
    /*
     * Thrown away every frame, because everybody moved.
     *
     * `InstancedMesh.raycast` tests a cached bounding sphere before it looks at
     * any instance, and computes that sphere exactly once — from wherever the
     * instances happened to be standing the first time anything raycast it.
     * Figures then walk out of it and stop being clickable, silently, with the
     * hitboxes still drawn in the right places. (The visible batches never hit
     * this: their first raycast happens while most of their ninety-six slots
     * are still at the origin, which yields a sphere big enough to cover the
     * campus by accident.) Clearing it costs one pass over a hundred matrices,
     * and only on the frames somebody is pointing at the office.
     */
    instanced.boundingSphere = null;
  });

  // Instance index → who that is. The order is whatever `instances` is in, and
  // it changes as the population does, so it is read at event time.
  const idAt = (index: number | undefined): string | null =>
    index === undefined ? null : (instances[index]?.controller.id ?? null);

  return (
    <instancedMesh
      ref={mesh}
      args={[geometry, material, CAPACITY]}
      frustumCulled={false}
      renderOrder={-1}
      onPointerMove={(event) => {
        event.stopPropagation();
        interaction.onHover(idAt(event.instanceId));
      }}
      onPointerOut={() => interaction.onHover(null)}
      onClick={(event) => {
        // A drag that happens to end on a figure is a camera move, not a click
        // on that figure.
        if (event.delta > 4) return;
        const id = idAt(event.instanceId);
        if (id) {
          event.stopPropagation();
          interaction.onSelect(id);
        }
      }}
    />
  );
}

/**
 * Pose → matrix, shared by every layer so a squashed figure keeps its shadow,
 * its halo and whatever it is carrying.
 *
 * Squash preserves volume: as a figure compresses it widens, which is what
 * makes the gesture read as weight rather than a scaling glitch.
 */
function applyPose(object: Object3D, pose: FigurePose, scale = 1): void {
  const width = pose.squash === 1 ? 1 : 1 / Math.sqrt(pose.squash);
  const s = Math.max(0.0001, pose.scale * scale);

  /*
   * Sitting is a shorter body lifted to the height of the actual seat.
   *
   * The lift is a world height that came from the chair, not a fraction of the
   * figure's own size: props are scaled to fill their platform, so the same
   * chair is half a metre high in one room and two thirds in another, and a
   * figure that guesses either sinks into the seat or hovers over it. Both of
   * those happened.
   */
  const sit = pose.seated;
  const shorten = 1 - 0.32 * sit;
  const broaden = 1 + 0.08 * sit;

  object.position.set(pose.position[0], pose.position[1] + sit * pose.seatHeight, pose.position[2]);
  object.rotation.set(0, pose.heading, 0);
  // The lean happens around the axis across the shoulders, after the turn, so
  // a figure always leans forward rather than sideways.
  object.rotateX(pose.tilt);
  object.scale.set(s * width * broaden, s * pose.squash * shorten, s * width * broaden);
  object.updateMatrix();
}


/**
 * Soft contact shadows.
 *
 * The office has no lights, so these are drawn: a blurred disc under each
 * figure. Without them the figures look pasted on rather than standing.
 */
function Shadows({ instances }: { instances: FigureInstance[] }): React.JSX.Element {
  const mesh = useRef<InstancedMesh>(null);
  const geometry = useMemo<BufferGeometry>(() => new CircleGeometry(0.42, 18).rotateX(-Math.PI / 2), []);
  const material = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
      gradient.addColorStop(0, 'rgba(0,0,0,0.42)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 64, 64);
    }
    return new MeshBasicMaterial({
      map: new CanvasTexture(canvas),
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
  }, []);

  useFrame(() => {
    const instancedMesh = mesh.current;
    if (!instancedMesh) return;
    const count = Math.min(instances.length, CAPACITY);
    instancedMesh.count = count;

    for (let i = 0; i < count; i++) {
      const pose = instances[i]!.controller.pose();
      const controller = instances[i]!.controller;
      /*
       * The shadow stays on the ground even when a beat lifts the figure; it
       * just shrinks, the way a contact shadow does.
       *
       * "The ground" has to mean *where the floor is now*, not where the
       * layout put it. A room arriving is drawn a long way down and rises into
       * place, and a pose carries that offset folded into its height — so this
       * difference, which is supposed to be a hop of a few centimetres, came
       * out as −24, which left the shadow hanging at the destination and blew
       * it up to forty times its size. A dark circle marking the spot a
       * platform was about to appear in, several seconds before it did.
       */
      const ground = controller.groundOffset;
      const hop = pose.position[1] - controller.position[1] - ground;
      _object.position.set(pose.position[0], controller.position[1] + ground + 0.02, pose.position[2]);
      _object.rotation.set(0, 0, 0);
      // Clamped both ways: a contact shadow shrinks as its owner leaves the
      // floor and there is no reading of it that makes it grow.
      const shrink = Math.min(0.35, Math.max(0, hop * 1.6));
      _object.scale.setScalar(Math.max(0.0001, pose.scale * (1 - shrink)));
      _object.updateMatrix();
      instancedMesh.setMatrixAt(i, _object.matrix);
    }
    instancedMesh.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={mesh} args={[geometry, material, CAPACITY]} frustumCulled={false} renderOrder={1} />;
}

/**
 * What a figure is carrying.
 *
 * Only compaction uses this so far: the session's context leaves the desk as a
 * stack of paper and goes to the Archive. Seeing the stack make the trip is the
 * difference between "the number went down" and "something was filed away".
 */
function Carried({ instances }: { instances: FigureInstance[] }): React.JSX.Element {
  return (
    <>
      <CarriedKind kind="papers" instances={instances} />
      <CarriedKind kind="cup" instances={instances} />
    </>
  );
}

function CarriedKind({
  kind,
  instances,
}: {
  kind: 'papers' | 'cup';
  instances: FigureInstance[];
}): React.JSX.Element {
  const mesh = useRef<InstancedMesh>(null);
  const geometry = useMemo(() => {
    // Small enough to read as held rather than hauled, and different enough in
    // silhouette that a cup is never mistaken for the context stack going to
    // the Archive — which is a thing the office means something by.
    const shape =
      kind === 'papers'
        ? new BoxGeometry(0.32, 0.22, 0.24)
        : new CylinderGeometry(0.1, 0.085, 0.17, 10).translate(0, 0.085, 0);
    return prepareGeometry(shape, [0.3, 1]);
  }, [kind]);
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

    let count = 0;
    for (const instance of instances) {
      if ((instance.carryKind ?? 'papers') !== kind) continue;
      const pose = instance.controller.pose();
      if (pose.carry <= 0.01 || count >= CAPACITY) continue;

      // Held out in front, at about chest height, and it grows into the hands.
      const reach = 0.34 * pose.scale;
      _object.position.set(
        pose.position[0] + Math.sin(pose.heading) * reach,
        pose.position[1] + 0.52 * pose.scale,
        pose.position[2] + Math.cos(pose.heading) * reach,
      );
      _object.rotation.set(0, pose.heading, 0);
      _object.scale.setScalar(Math.max(0.0001, pose.scale * pose.carry));
      _object.updateMatrix();
      instancedMesh.setMatrixAt(count, _object.matrix);

      _color.set(instance.colorTop);
      colors.bottom.setXYZ(count, _color.r, _color.g, _color.b);
      _color.set('#ffffff');
      colors.top.setXYZ(count, _color.r, _color.g, _color.b);
      count += 1;
    }

    instancedMesh.count = count;
    instancedMesh.instanceMatrix.needsUpdate = true;
    colors.bottom.needsUpdate = true;
    colors.top.needsUpdate = true;
  });

  return <instancedMesh ref={mesh} args={[geometry, material, CAPACITY]} frustumCulled={false} />;
}

/**
 * The one piece of UI in the world: a ring over the head of an agent that is
 * waiting on you. It pulses slowly — enough to catch the eye from across the
 * office, not enough to nag.
 */
function Halos({ instances }: { instances: FigureInstance[] }): React.JSX.Element {
  const mesh = useRef<InstancedMesh>(null);
  const geometry = useMemo(() => new TorusGeometry(0.34, 0.045, 8, 28).rotateX(Math.PI / 2), []);
  const material = useMemo(
    () => new MeshBasicMaterial({ color: new Color('#E5A32B'), transparent: true, depthWrite: false }),
    [],
  );

  useFrame((state) => {
    const instancedMesh = mesh.current;
    if (!instancedMesh) return;

    const pulse = 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 2.1);
    material.opacity = 0.45 + pulse * 0.4;

    let count = 0;
    for (const instance of instances) {
      const pose = instance.controller.pose();
      if (pose.attention <= 0) continue;
      // The ring rides above the head, so its height has to scale with the
      // figure the way the ring itself does. A fixed 1.32 put it inside an
      // opus-sized head and a foot above a haiku-sized one.
      _object.position.set(
        pose.position[0],
        pose.position[1] + (1.32 + pulse * 0.06) * pose.scale,
        pose.position[2],
      );
      _object.rotation.set(0, state.clock.elapsedTime * 0.6, 0);
      _object.scale.setScalar(pose.scale * (0.95 + pulse * 0.12));
      _object.updateMatrix();
      instancedMesh.setMatrixAt(count, _object.matrix);
      count += 1;
      if (count >= CAPACITY) break;
    }
    instancedMesh.count = count;
    instancedMesh.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={mesh} args={[geometry, material, CAPACITY]} frustumCulled={false} renderOrder={2} />;
}

export const FIGURE_MATRIX = new Matrix4();
