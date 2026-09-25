import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  TorusGeometry,
  type BufferGeometry,
} from 'three';
import type { AgentRole } from '@shared/model';
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
    const groups = new Map<AgentRole, FigureInstance[]>();
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
        <RoleBatch key={role} role={role} instances={group} {...(interaction ? { interaction } : {})} />
      ))}
      <Shadows instances={instances} />
      <Carried instances={instances} />
      <Halos instances={instances} />
    </>
  );
}

function RoleBatch({
  role,
  instances,
  interaction,
}: {
  role: AgentRole;
  instances: FigureInstance[];
  interaction?: FigureInteraction;
}): React.JSX.Element {
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

  // Instance index → who that is. The order is whatever `instances` is in, and
  // it changes as the population does, so it is read at event time.
  const idAt = (index: number | undefined): string | null =>
    index === undefined ? null : (instances[index]?.controller.id ?? null);

  return (
    <instancedMesh
      ref={mesh}
      args={[geometry, material, CAPACITY]}
      frustumCulled={false}
      onPointerMove={
        interaction
          ? (event) => {
              event.stopPropagation();
              interaction.onHover(idAt(event.instanceId));
            }
          : undefined
      }
      onPointerOut={interaction ? () => interaction.onHover(null) : undefined}
      onClick={
        interaction
          ? (event) => {
              // A drag that happens to end on a figure is a camera move, not a
              // click on that figure.
              if (event.delta > 4) return;
              const id = idAt(event.instanceId);
              if (id) {
                event.stopPropagation();
                interaction.onSelect(id);
              }
            }
          : undefined
      }
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
      // The shadow stays on the ground even when a beat lifts the figure; it
      // just shrinks, the way a contact shadow does.
      const lift = pose.position[1] - controller.position[1];
      _object.position.set(pose.position[0], controller.position[1] + 0.02, pose.position[2]);
      _object.rotation.set(0, 0, 0);
      _object.scale.setScalar(Math.max(0.0001, pose.scale * (1 - Math.min(0.35, lift * 1.6))));
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
  const mesh = useRef<InstancedMesh>(null);
  const geometry = useMemo(() => {
    const slab = new BoxGeometry(0.32, 0.22, 0.24);
    return prepareGeometry(slab, [0.3, 1]);
  }, []);
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
