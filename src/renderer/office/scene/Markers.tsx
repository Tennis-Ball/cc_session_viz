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
import { ACTIVITY_ZONE } from '@shared/activity';
import { paletteAt } from '@shared/palette';
import type { World } from '@shared/model';
import { createFacetMaterial } from '../material/facet';
import { box, buildProp } from '../props/kit';
import { buildPropFor } from '../props/registry';
import { levelY } from '../world/campusTemplate';
import type { Campus } from '../world/layout';
import type { Staging } from '../anim/staging';

/**
 * The two things the office could not say.
 *
 * It was a place with people in it, and it read beautifully as that and as
 * nothing else. Two questions it could not answer at a glance, both of which
 * are the entire reason to have it open: *which desk is mine*, and *how full
 * is that session's context*. A pill in the title bar carried more information
 * than the whole campus.
 *
 * Both answers are vertical on purpose. The office is an isometric picture
 * where almost everything is a floor, and a floor is the one surface that gets
 * hidden behind the next platform along and vanishes when you zoom out. What
 * survives distance and rotation is height.
 */

/*
 * The gauge on every desk: the work piled up beside it.
 *
 * Third design. A flag on a mast was legible from anywhere and meant nothing —
 * there is no reading of a flag halfway up a pole that says "fifty-seven per
 * cent". A *gauge* on that mast said it without being told, and was the right
 * information in the wrong object: thirty sessions gave thirty thin painted
 * spikes standing at the corners of thirty platforms, which is a pincushion,
 * not an office. Worse, a pole 0.14 across standing 0.55 in from a corner puts
 * its foot on the platform's silhouette in an isometric view, so every one of
 * them looked like it was floating beside its desk rather than standing on it.
 *
 * A pile of paper is the same reading and costs the office nothing, because it
 * is *furniture*. It is low and wide instead of tall and thin, so it reads as
 * mass at a distance where a spike reads as a scratch; it sits well inside the
 * deck where nothing can make it look unsupported; and nobody has to be told
 * what a growing stack of paper beside a desk means. The rule across it is
 * where Claude Code would compact, and past that the paper takes the accent —
 * so "how much room is left" and "how close is the edge" are both still
 * answerable at a glance.
 */
/** The tray it stands in, which is there even when there is nothing in it. */
const TRAY = [1.05, 0.11, 0.78] as const;
/** A full context, in units of paper. */
const PAPER_TOP = 1.15;
const PAPER = [0.88, 0.62] as const;
/** Half the tray's depth: where the back stop stands and the rule is marked. */
const BACK = TRAY[2] / 2;
/** The back stop is a shade taller than a full pile, so nothing overtops it. */
const BACKSTOP = PAPER_TOP + 0.12;
/** The compaction rule, standing proud of the stop so it reads as a line. */
const RULE = [TRAY[0] * 0.96, 0.07, 0.1] as const;
/** Clear of the tray below. */
const FILL_BASE = TRAY[1];
const FILL_TOP = FILL_BASE + PAPER_TOP;
/**
 * How far in from the back corner the pile stands.
 *
 * Generous, and clamped against the deck: the whole fault with the mast was
 * that it stood where a platform's two rims meet, which is the one place on a
 * floor that reads as thin air.
 */
const INSET_X = 1.45;
const INSET_Z = 1.2;

export interface DeskMarker {
  slotId: string;
  /** The platform it stands on, so it can rise and sink with it. */
  platformId: string;
  at: [number, number, number];
  colorIndex: number;
}

/**
 * Every desk platform's pile, from the floor plan alone.
 *
 * Squeezed between two bounds: outside the pod's own footprint, so it never
 * stands in the desk, and inside the rim by a clear margin, so it never looks
 * like it is hanging off the corner. A deck too small to satisfy both takes the
 * rim bound, because a pile touching the desk is untidy and a pile over the
 * drop is broken.
 */
export function deskMarkers(campus: Campus): DeskMarker[] {
  const out: DeskMarker[] = [];
  for (const platform of campus.platforms) {
    if (platform.kind !== 'desk' || platform.colorIndex === undefined) continue;
    const [width, depth] = platform.size;
    const keep = buildPropFor(platform, PILE_PALETTE)?.footprint ?? [0, 0];
    const x = Math.min(width / 2 - Math.max(INSET_X, TRAY[0] * 0.8), keep[0] / 2 + TRAY[0] * 0.75);
    const z = Math.min(depth / 2 - Math.max(INSET_Z, TRAY[2] * 0.9), keep[1] / 2 + TRAY[2] * 0.85);
    out.push({
      slotId: platform.ownerId ?? platform.id,
      platformId: platform.id,
      at: [
        platform.position[0] + Math.max(0, x),
        levelY(platform.level),
        platform.position[1] - Math.max(0, z),
      ],
      colorIndex: platform.colorIndex,
    });
  }
  return out;
}

/**
 * Any palette gives the same footprint; this one is never drawn.
 *
 * The pile needs to know how much floor the desk is using, and a prop's shape
 * does not depend on its colours — only its colours do. Asking for the real
 * theme here would make the floor plan a function of the hour.
 */
const PILE_PALETTE = {
  surface: '#ffffff',
  surfaceAlt: '#ffffff',
  accent: '#ffffff',
  dark: '#ffffff',
  screen: '#ffffff',
  paper: '#ffffff',
  plant: '#ffffff',
  metal: '#ffffff',
};

/**
 * How high the fill stands, for a context of 0–1 of the window.
 *
 * Measured from the base of the gauge rather than from the floor, because what
 * is being read is a level in a vessel: an empty session should look empty, and
 * at the old flag's lowest position it looked like a flag flown low.
 */
export function fillHeight(pct: number): number {
  // `Math.min/max` propagate NaN rather than clamping it, and a NaN here
  // becomes a NaN scale on an instance matrix — which does not draw a wrong
  // gauge, it quietly corrupts the mesh's bounds and takes the rest of them
  // with it. A session with no usage yet reads as empty.
  const t = Number.isFinite(pct) ? Math.min(1, Math.max(0, pct / 100)) : 0;
  return PAPER_TOP * t;
}

/** And where the compaction mark is ruled across it. */
export function tickHeight(autoCompactPct: number): number {
  return FILL_BASE + fillHeight(autoCompactPct);
}

/**
 * A pile per desk: a tray, the session's paper stacked in it, and a rule where
 * compaction waits.
 *
 * Fourth in a line that has each fixed the last one's real fault — a rim band
 * (an outline, which is how a web page marks a card, not how this picture uses
 * colour), a flag (legible, meaningless), a mast gauge (meaningful, and a
 * pincushion). The rug inside the pod still carries the session's colour as an
 * area; this carries it as a quantity, in an object that was already in the
 * brief for a desk.
 */
export function DeskPiles({
  campus,
  world,
  staging,
  accent,
}: {
  campus: Campus;
  world: World;
  staging: Staging;
  /** What the gauge turns when it is past the compaction mark. */
  accent: string;
}): React.JSX.Element | null {
  const markers = useMemo(() => deskMarkers(campus), [campus]);

  const material = useMemo(() => createFacetMaterial(), []);
  const trayGeometry = useMemo<BufferGeometry>(
    () =>
      buildProp([
        box(TRAY[0] * 1.08, TRAY[1] * 0.55, TRAY[2] * 1.1, { color: '#ffffff', grad: [0.4, 0.86] }),
        box(TRAY[0], TRAY[1], TRAY[2], { color: '#ffffff', grad: [0.55, 1] }),
        /*
         * The back stop, which is what the compaction rule is marked on.
         *
         * Without it the rule is a band floating over a short pile, waiting for
         * the paper to reach it — which is the one thing a mark must not look
         * like. An in-tray has a back; put the mark where a person would put a
         * pencil line, and an empty desk still shows you where the edge is.
         */
        box(TRAY[0], BACKSTOP, 0.06, { color: '#ffffff', position: [0, TRAY[1], -BACK], grad: [0.62, 1] }),
      ]),
    [],
  );
  /*
   * A unit block of paper, scaled in Y to the reading.
   *
   * Cut as a few courses rather than one box: a single slab stretched to full
   * height is a brick, and the whole point of choosing paper is that a pile of
   * it is obviously *countable*. The courses stretch with it, which reads as
   * the sheets getting thicker and is exactly what a stylised pile should do.
   */
  const paperGeometry = useMemo<BufferGeometry>(() => {
    const courses = 5;
    const parts = [];
    for (let i = 0; i < courses; i += 1) {
      const t = i / courses;
      parts.push(
        box(PAPER[0] - t * 0.06, 1 / courses - 0.012, PAPER[1] - t * 0.05, {
          color: '#ffffff',
          position: [(i % 2 === 0 ? 1 : -1) * 0.018, i / courses, 0],
          grad: [0.78, 1],
        }),
      );
    }
    return buildProp(parts);
  }, []);
  const ruleGeometry = useMemo<BufferGeometry>(
    () => buildProp([box(RULE[0], RULE[1], RULE[2], { color: '#ffffff', grad: [0.9, 1] })]),
    [],
  );
  // Ruled on the back stop, not across the pile, so it is legible at nought
  // per cent and never sits in mid air.
  const ruleAt = BACK + 0.01;

  const trays = useRef<InstancedMesh>(null);
  const papers = useRef<InstancedMesh>(null);
  const rules = useRef<InstancedMesh>(null);
  const object = useMemo(() => new Object3D(), []);
  const color = useMemo(() => new Color(), []);
  /** Smoothed per slot, so a compaction lowers the level rather than teleporting it. */
  const levels = useRef(new Map<string, number>());

  const worldRef = useRef(world);
  worldRef.current = world;
  const accentRef = useRef(accent);
  accentRef.current = accent;

  useFrame((_state, delta) => {
    const trayMesh = trays.current;
    const paperMesh = papers.current;
    const ruleMesh = rules.current;
    if (!trayMesh || !paperMesh || !ruleMesh) return;
    const sessions = worldRef.current.sessions;

    for (let i = 0; i < markers.length; i += 1) {
      const marker = markers[i]!;
      const tone = paletteAt(marker.colorIndex);
      // Down with its platform while that platform is still on its way up. A
      // gauge standing in clear air over a half-built room was the most
      // visible thing in the whole arrival.
      const lift = staging.offsetOf(marker.platformId);
      const foot = marker.at[1] + lift;

      object.position.set(marker.at[0], foot, marker.at[2]);
      object.rotation.set(0, 0, 0);
      object.scale.set(1, 1, 1);
      object.updateMatrix();
      trayMesh.setMatrixAt(i, object.matrix);
      color.set(tone.base);
      // The empty tray is the session's colour knocked right back, so a desk
      // with nothing on it still says whose it is.
      trayMesh.setColorAt(i, color.lerp(TRAY_TONE, 0.66));

      const session = sessions[marker.slotId];
      const target = fillHeight(session?.context.pct ?? 0);
      const previous = levels.current.get(marker.slotId) ?? target;
      // Eased rather than snapped: context moves in steps as usage lands, and
      // a level that jumps draws far more attention than the change deserves.
      const next = previous + (target - previous) * Math.min(1, delta * 2.4);
      levels.current.set(marker.slotId, next);

      object.position.set(marker.at[0], foot + FILL_BASE, marker.at[2]);
      object.scale.set(1, Math.max(0.0001, next), 1);
      object.updateMatrix();
      paperMesh.setMatrixAt(i, object.matrix);

      const threshold = session?.context.autoCompactPct ?? 0;
      const over = threshold > 0 && (session?.context.pct ?? 0) >= threshold;
      // Paper, tinted with whose it is — not a block of saturated colour. Past
      // the mark it stops being an identity and starts being a warning, and
      // then it is allowed to be loud.
      color.set(over ? accentRef.current : tone.base);
      // Toward paper either way. A warning is allowed to be the loudest thing
      // on a desk; it is not allowed to be the loudest thing in the office.
      color.lerp(PAPER_TONE, over ? 0.3 : 0.58);
      paperMesh.setColorAt(i, color);

      object.position.set(marker.at[0], foot + tickHeight(threshold), marker.at[2] - ruleAt);
      object.scale.set(1, 1, 1);
      object.updateMatrix();
      ruleMesh.setMatrixAt(i, object.matrix);
      // Sunk into the tray rather than special-cased when there is no
      // threshold to draw: a rule lying on an empty pile reads as a reading of
      // zero, and there is nothing to read.
      color.set(threshold > 0 ? RULE_TONE : TRAY_TONE);
      ruleMesh.setColorAt(i, color);
    }

    for (const mesh of [trayMesh, paperMesh, ruleMesh]) {
      mesh.count = markers.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.boundingSphere = null;
    }
  });

  if (markers.length === 0) return null;
  return (
    <>
      <instancedMesh ref={trays} args={[trayGeometry, material, markers.length]} frustumCulled={false} />
      <instancedMesh ref={papers} args={[paperGeometry, material, markers.length]} frustumCulled={false} />
      <instancedMesh ref={rules} args={[ruleGeometry, material, markers.length]} frustumCulled={false} />
    </>
  );
}

const TRAY_TONE = new Color('#CFC8D2');
const PAPER_TONE = new Color('#F6F1EC');
const RULE_TONE = new Color('#4A4450');

/**
 * How busy each room is, as warmth on its floor.
 *
 * The campus is mostly empty architecture, and with four sessions running about
 * eighty per cent of the frame is scenery. Nothing said where the work *was*
 * without finding and following individual figures, which is the opposite of
 * peripheral vision. A room with three agents in it now glows a little; a room
 * with none does not, and the shape of the afternoon is readable from across
 * the desk without reading a word.
 *
 * Counted from activity rather than from figure positions on purpose: a figure
 * spends real seconds walking, and a room should be warm because work is
 * happening in it, not because somebody is on their way there.
 */
export function ZoneWarmth({
  campus,
  world,
  accent,
}: {
  campus: Campus;
  world: World;
  accent: string;
}): React.JSX.Element | null {
  const zones = useMemo(
    () =>
      campus.platforms
        .filter((platform) => platform.kind === 'zone' && platform.zone)
        .map((platform) => ({
          zone: platform.zone!,
          at: [platform.position[0], levelY(platform.level) + 0.008, platform.position[1]] as [number, number, number],
          radius: Math.min(platform.size[0], platform.size[1]) * 0.44,
        })),
    [campus],
  );

  const disc = useMemo<BufferGeometry>(() => new CircleGeometry(1, 32).rotateX(-Math.PI / 2), []);
  const material = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const gradient = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
      gradient.addColorStop(0, 'rgba(255,255,255,0.5)');
      gradient.addColorStop(0.55, 'rgba(255,255,255,0.18)');
      gradient.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 128, 128);
    }
    return new MeshBasicMaterial({
      map: new CanvasTexture(canvas),
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      vertexColors: true,
      opacity: 1,
    });
  }, []);

  const mesh = useRef<InstancedMesh>(null);
  const object = useMemo(() => new Object3D(), []);
  const color = useMemo(() => new Color(), []);
  const warmth = useRef(new Map<string, number>());
  const worldRef = useRef(world);
  worldRef.current = world;

  useFrame((_state, delta) => {
    const instanced = mesh.current;
    if (!instanced) return;

    // One pass over the agents, not one per zone.
    const counts = new Map<string, number>();
    for (const agent of Object.values(worldRef.current.agents)) {
      if (agent.status !== 'running' && agent.status !== 'waiting') continue;
      const target = ACTIVITY_ZONE[agent.activity];
      if (!target || target.zone === 'desk') continue;
      counts.set(target.zone, (counts.get(target.zone) ?? 0) + 1);
    }

    for (let i = 0; i < zones.length; i += 1) {
      const zone = zones[i]!;
      // Saturating rather than linear: the difference between nobody and
      // somebody is the one worth seeing, and a fourth agent in a room should
      // not make it four times as bright as the room with one.
      const occupancy = counts.get(zone.zone) ?? 0;
      const target = occupancy === 0 ? 0 : Math.min(1, 0.55 + occupancy * 0.2);
      const previous = warmth.current.get(zone.zone) ?? 0;
      const next = previous + (target - previous) * Math.min(1, delta * 1.6);
      warmth.current.set(zone.zone, next);

      object.position.set(zone.at[0], zone.at[1], zone.at[2]);
      object.scale.set(zone.radius, 1, zone.radius);
      object.updateMatrix();
      instanced.setMatrixAt(i, object.matrix);
      color.set(accent);
      // Instance colour carries the strength as well as the hue, which is what
      // lets one additive material serve every room at a different brightness.
      color.multiplyScalar(next * 0.95);
      instanced.setColorAt(i, color);
    }

    instanced.count = zones.length;
    instanced.instanceMatrix.needsUpdate = true;
    if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
  });

  if (zones.length === 0) return null;
  return <instancedMesh ref={mesh} args={[disc, material, zones.length]} frustumCulled={false} renderOrder={1} />;
}
