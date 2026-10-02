import {
  BufferGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  OctahedronGeometry,
  BoxGeometry,
  TetrahedronGeometry,
  SphereGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AgentRole } from '@shared/model';
import { prepareGeometry } from '../props/kit';

/**
 * The figures.
 *
 * Simple solids, one silhouette per role, each with a ball head so it still
 * reads as somebody rather than an object. Shape carries the role, size carries
 * the model, and the gradient up the body carries the session color — so a
 * glance across the office tells you who is who without a single label.
 */

const HEAD_RADIUS = 0.17;
const BODY_HEIGHT = 0.78;
const HEAD_Y = BODY_HEIGHT + HEAD_RADIUS * 0.72;

/**
 * Everyone the office can draw.
 *
 * `npc` is not an agent role and never comes from the engine — it exists only
 * here, because the people who work in the office have to be told apart from
 * the people who are your sessions, and the only honest way to do that is to
 * make them a different shape.
 */
export type FigureShape = AgentRole | 'npc';

function bodyFor(role: FigureShape): BufferGeometry {
  switch (role) {
    case 'main':
      // A cone: the tallest, calmest silhouette on the floor.
      return new ConeGeometry(0.3, BODY_HEIGHT, 6).translate(0, BODY_HEIGHT / 2, 0);
    case 'general-purpose':
      return new CylinderGeometry(0.22, 0.26, BODY_HEIGHT, 10).translate(0, BODY_HEIGHT / 2, 0);
    case 'Explore':
      return new OctahedronGeometry(0.33).scale(1, 1.25, 1).translate(0, BODY_HEIGHT * 0.5, 0);
    case 'Plan':
      return new BoxGeometry(0.4, BODY_HEIGHT, 0.4).rotateY(Math.PI / 4).translate(0, BODY_HEIGHT / 2, 0);
    case 'workflow':
      return new TetrahedronGeometry(0.34).rotateY(Math.PI / 6).translate(0, BODY_HEIGHT * 0.42, 0);
    case 'fork':
      // Forks echo their parent, so they get the plainest body and read as a
      // copy through their translucency instead.
      return new CylinderGeometry(0.2, 0.24, BODY_HEIGHT, 8).translate(0, BODY_HEIGHT / 2, 0);
    case 'npc':
      /*
       * A soft capsule, and the only rounded body in the office.
       *
       * Everybody else is faceted — a cone, a cube on its corner, an
       * octahedron — because a flat-shaded solid is what carries a role. The
       * people who merely work here get the one silhouette that has no
       * corners at all, so they read as *not one of those* from across the
       * campus, at any angle, without being smaller or dimmer. Making them
       * small was the old answer and it was the wrong one: it said
       * "unimportant" when what was meant is "not yours".
       */
      return new CapsuleGeometry(0.26, BODY_HEIGHT - 0.52, 4, 12).translate(0, BODY_HEIGHT / 2, 0);
    default:
      return new CylinderGeometry(0.26, 0.26, BODY_HEIGHT, 6).translate(0, BODY_HEIGHT / 2, 0);
  }
}

/**
 * Makes two primitives mergeable.
 *
 * `mergeGeometries` returns null unless every input has exactly the same
 * attributes and the same indexed-ness — and three.js is not consistent about
 * either: a sphere is indexed, a polyhedron is not. Getting that wrong threw,
 * which unmounted the entire renderer and left a black window, and only for the
 * roles built from polyhedra. Normalising here makes the merge total.
 */
function mergeable(geometry: BufferGeometry): BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  if (flat !== geometry) geometry.dispose();
  // The facet material reads position and normal; anything else just has to
  // match across the parts, so the simplest thing is to have nothing else.
  for (const name of Object.keys(flat.attributes)) {
    if (name !== 'position' && name !== 'normal') flat.deleteAttribute(name);
  }
  return flat;
}

export function figureGeometry(role: FigureShape): BufferGeometry {
  const body = mergeable(bodyFor(role));
  const head = mergeable(new SphereGeometry(HEAD_RADIUS, 14, 10).translate(0, HEAD_Y, 0));
  const merged = mergeGeometries([body, head], false);
  body.dispose();
  head.dispose();
  if (!merged) throw new Error(`figureGeometry: could not build ${role}`);
  // The gradient runs from feet to crown, which is what makes the two-tone
  // session color read as a single figure instead of two stacked objects.
  return prepareGeometry(merged, [0, 1]);
}

export const FIGURE_ROLES: FigureShape[] = ['main', 'general-purpose', 'Explore', 'Plan', 'workflow', 'fork', 'custom', 'npc'];

/**
 * Model tier → body scale. Bigger model, bigger presence.
 *
 * Deliberately larger than life against the furniture: at true scale a person
 * on a nine-unit platform is a speck, and the office reads as empty. Chunky
 * figures are also what makes the silhouettes legible from across the campus.
 */
export function scaleForTier(tier: 0 | 1 | 2 | 3): number {
  // Deliberately larger than life, and larger again after the office was
  // judged from across the room: at a framing that holds a dozen platforms, a
  // person a metre tall is a speck, and the whole point of the office is
  // watching people move around it. The furniture cannot grow to match — the
  // walkable ring around it is already at its minimum — so the people do.
  return [1.38, 1.58, 1.8, 2.02][tier] ?? 1.8;
}

/** Subagents are a lighter tint of their session's color, one step per depth. */
export function depthTint(depth: number): number {
  return Math.min(0.55, depth * 0.22);
}
