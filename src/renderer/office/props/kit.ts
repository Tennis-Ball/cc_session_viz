import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Matrix4,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Every object in the office is built here, from a handful of primitives.
 *
 * One kit means one visual language: same corner treatment, same gradient, same
 * palette hooks everywhere, and one draw call per prop because the parts are
 * merged. Props never import three directly.
 */

export interface PartOptions {
  color: string;
  /** Lamps, screens and windows glow at night; nothing else does. */
  emissive?: number;
  position?: [number, number, number];
  /** Euler angles in radians. */
  rotation?: [number, number, number];
  scale?: [number, number, number];
  /**
   * Overrides the base-darkening ramp. Defaults to the part's own height, which
   * is what gives furniture its grounded look.
   */
  grad?: [number, number];
}

export interface Part {
  geometry: BufferGeometry;
  options: PartOptions;
}

const _matrix = new Matrix4();
const _euler = new Euler();
const _scale = new Vector3();
const _position = new Vector3();
const _color = new Color();

export function box(width: number, height: number, depth: number, options: PartOptions): Part {
  const geometry = new BoxGeometry(width, height, depth);
  geometry.translate(0, height / 2, 0); // sit on its own base
  return { geometry, options };
}

export function cylinder(radius: number, height: number, options: PartOptions, segments = 16, radiusTop = radius): Part {
  const geometry = new CylinderGeometry(radiusTop, radius, height, segments);
  geometry.translate(0, height / 2, 0);
  return { geometry, options };
}

export function cone(radius: number, height: number, options: PartOptions, segments = 18): Part {
  const geometry = new ConeGeometry(radius, height, segments);
  geometry.translate(0, height / 2, 0);
  return { geometry, options };
}

export function sphere(radius: number, options: PartOptions, segments = 18): Part {
  const geometry = new SphereGeometry(radius, segments, Math.max(6, Math.round(segments / 2)));
  return { geometry, options };
}

/**
 * A ring in the XY plane. `arc` under 2π sweeps counter-clockwise from +X, so
 * π gives the top half — an archway resting on its two ends rather than a
 * hoop with its bottom buried in the floor.
 */
export function torus(radius: number, tube: number, options: PartOptions, segments = 24, arc = Math.PI * 2): Part {
  const geometry = new TorusGeometry(radius, tube, 8, segments, arc);
  return { geometry, options };
}

/** A slab with a slightly tapered underside, the office's basic ground piece. */
export function slab(width: number, depth: number, thickness: number, options: PartOptions): Part {
  const geometry = new BoxGeometry(width, thickness, depth);
  const position = geometry.getAttribute('position');
  // Pinch the bottom face inward so platforms read as floating blocks.
  for (let i = 0; i < position.count; i++) {
    if (position.getY(i) < 0) {
      position.setX(i, position.getX(i) * 0.86);
      position.setZ(i, position.getZ(i) * 0.86);
    }
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.translate(0, thickness / 2, 0);
  return { geometry, options };
}

/** A flight of steps between two platform heights. */
export function stairs(steps: number, width: number, rise: number, run: number, options: PartOptions): Part[] {
  const parts: Part[] = [];
  for (let i = 0; i < steps; i++) {
    parts.push(
      box(width, rise, run, {
        ...options,
        position: [0, i * rise, i * run],
        grad: [0.25, 1],
      }),
    );
  }
  return parts;
}

/**
 * Merges parts into one geometry carrying the attributes the facet shader wants:
 * per-vertex color, a 0→1 base-to-top ramp, and an emissive flag.
 */
export function buildProp(parts: Part[]): BufferGeometry {
  const prepared: BufferGeometry[] = [];

  for (const part of parts) {
    const geometry = part.geometry.clone();
    const { position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1] } = part.options;

    _euler.set(rotation[0], rotation[1], rotation[2]);
    _scale.set(scale[0], scale[1], scale[2]);
    _position.set(position[0], position[1], position[2]);
    _matrix.makeRotationFromEuler(_euler);
    _matrix.scale(_scale);
    _matrix.setPosition(_position);
    geometry.applyMatrix4(_matrix);

    const count = geometry.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    const grads = new Float32Array(count);
    const emissives = new Float32Array(count);

    _color.set(part.options.color);
    const pos = geometry.getAttribute('position');
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const y = pos.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const span = Math.max(0.0001, maxY - minY);
    const [gradFrom, gradTo] = part.options.grad ?? [0, 1];

    for (let i = 0; i < count; i++) {
      colors[i * 3] = _color.r;
      colors[i * 3 + 1] = _color.g;
      colors[i * 3 + 2] = _color.b;
      const t = (pos.getY(i) - minY) / span;
      grads[i] = gradFrom + (gradTo - gradFrom) * t;
      emissives[i] = part.options.emissive ?? 0;
    }

    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.setAttribute('aGrad', new BufferAttribute(grads, 1));
    geometry.setAttribute('aEmissive', new BufferAttribute(emissives, 1));
    geometry.deleteAttribute('uv');
    prepared.push(geometry);
  }

  const merged = mergeGeometries(prepared, false);
  for (const geometry of prepared) geometry.dispose();
  if (!merged) throw new Error('buildProp: nothing to merge');
  return merged;
}

/** Bakes the shader attributes onto a standalone geometry (figures, shadows). */
export function prepareGeometry(geometry: BufferGeometry, grad: [number, number] = [0, 1]): BufferGeometry {
  const pos = geometry.getAttribute('position');
  const count = pos.count;
  const grads = new Float32Array(count);
  const emissives = new Float32Array(count);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const y = pos.getY(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(0.0001, maxY - minY);
  for (let i = 0; i < count; i++) {
    const t = (pos.getY(i) - minY) / span;
    grads[i] = grad[0] + (grad[1] - grad[0]) * t;
    emissives[i] = 0;
  }
  geometry.setAttribute('aGrad', new BufferAttribute(grads, 1));
  geometry.setAttribute('aEmissive', new BufferAttribute(emissives, 1));
  return geometry;
}
