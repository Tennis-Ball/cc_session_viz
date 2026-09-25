import { Color, MeshBasicMaterial, Vector3, type WebGLProgramParametersWithUniforms } from 'three';
import type { ResolvedTheme } from '../theme/themes';

/**
 * The one material the whole office is made of.
 *
 * There are no lights. A face takes its tone from the direction it points —
 * up, camera-left, camera-right — plus a gentle darkening toward its base and a
 * fade into the sky with distance and depth. That is what keeps a procedural
 * scene looking drawn rather than rendered.
 *
 * The tone basis follows the camera, so orbiting never turns the office into a
 * wall of shadow; the sun offset shifts it slightly as the day moves.
 */

export interface FacetUniforms {
  uTop: { value: Color };
  uLeft: { value: Color };
  uRight: { value: Color };
  uLeftDir: { value: Vector3 };
  uRightDir: { value: Vector3 };
  uGradient: { value: number };
  uFogColor: { value: Color };
  uFogNear: { value: number };
  uFogFar: { value: number };
  /** Below this world height, everything dissolves into the void. */
  uVoidY: { value: number };
  uVoidFade: { value: number };
  uNight: { value: number };
}

/** Shared by reference with every compiled shader: one write updates the scene. */
/**
 * Where distance starts eating colour, in *view* depth — distance from the
 * camera, not from the centre of the campus. The camera orbits at 60, so the
 * focus sits at 60 and a wide campus spans roughly 35–85; these are past all of
 * it, deliberately. The office reads as clear air, and what makes its far
 * platforms recede is the void plane below them, not haze in front of them.
 */
const FOG_NEAR = 95;
const FOG_FAR = 260;

export const facetUniforms: FacetUniforms = {
  uTop: { value: new Color('#FFF1E2') },
  uLeft: { value: new Color('#F0CFC0') },
  uRight: { value: new Color('#D9A99C') },
  uLeftDir: { value: new Vector3(-0.7071, 0, 0.7071) },
  uRightDir: { value: new Vector3(0.7071, 0, 0.7071) },
  uGradient: { value: 0.35 },
  uFogColor: { value: new Color('#FFD2C4') },
  uFogNear: { value: FOG_NEAR },
  uFogFar: { value: FOG_FAR },
  uVoidY: { value: -5 },
  uVoidFade: { value: 7 },
  uNight: { value: 0 },
};

/**
 * What a lamp or a screen puts out, from its own unshaded color.
 *
 * Exported because they are a palette decision as much as a shader one, and a
 * test has no way to run the shader: the gain is what makes a source read as a
 * source, and the floor is the only thing keeping a dark-bodied one visible.
 */
export const EMISSIVE_GAIN = 1.8;
export const EMISSIVE_FLOOR = 0.03;

export interface FacetOptions {
  /** Figures carry two instanced colors and blend them up their body. */
  instancedGradient?: boolean;
  transparent?: boolean;
  opacity?: number;
}

export function createFacetMaterial(options: FacetOptions = {}): MeshBasicMaterial {
  const material = new MeshBasicMaterial({
    vertexColors: !options.instancedGradient,
    transparent: options.transparent ?? false,
    opacity: options.opacity ?? 1,
    fog: false,
  });

  const instanced = options.instancedGradient === true;

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, facetUniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aGrad;
        attribute float aEmissive;
        ${instanced ? 'attribute vec3 aColorBottom;\nattribute vec3 aColorTop;' : ''}
        varying vec3 vFacetNormal;
        varying float vFacetGrad;
        varying float vFacetDepth;
        varying float vFacetWorldY;
        varying float vFacetEmissive;
        ${instanced ? 'varying vec3 vFacetBottom;\nvarying vec3 vFacetTop;' : ''}`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec3 facetNormal = normal;
        vec4 facetWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          facetNormal = mat3(instanceMatrix) * facetNormal;
          facetWorld = instanceMatrix * facetWorld;
        #endif
        facetWorld = modelMatrix * facetWorld;
        vFacetNormal = normalize(mat3(modelMatrix) * facetNormal);
        vFacetWorldY = facetWorld.y;
        vFacetDepth = -mvPosition.z;
        vFacetGrad = aGrad;
        vFacetEmissive = aEmissive;
        ${instanced ? 'vFacetBottom = aColorBottom;\n        vFacetTop = aColorTop;' : ''}`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uTop;
        uniform vec3 uLeft;
        uniform vec3 uRight;
        uniform vec3 uLeftDir;
        uniform vec3 uRightDir;
        uniform float uGradient;
        uniform vec3 uFogColor;
        uniform float uFogNear;
        uniform float uFogFar;
        uniform float uVoidY;
        uniform float uVoidFade;
        uniform float uNight;
        varying vec3 vFacetNormal;
        varying float vFacetGrad;
        varying float vFacetDepth;
        varying float vFacetWorldY;
        varying float vFacetEmissive;
        ${instanced ? 'varying vec3 vFacetBottom;\nvarying vec3 vFacetTop;' : ''}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        ${instanced ? 'diffuseColor.rgb = mix(vFacetBottom, vFacetTop, clamp(vFacetGrad, 0.0, 1.0));' : ''}

        // The part's own color, before the face tone and the base gradient
        // take anything off it. Only the emissive term wants it.
        vec3 unshaded = diffuseColor.rgb;

        // Face tone. The fourth power keeps edges crisp instead of smeared.
        float wTop = pow(max(vFacetNormal.y, 0.0), 3.0);
        float wLeft = pow(max(dot(vFacetNormal, uLeftDir), 0.0), 4.0);
        float wRight = pow(max(dot(vFacetNormal, uRightDir), 0.0), 4.0);
        float wSum = wTop + wLeft + wRight;

        // A face pointing away from all three basis directions has no weight
        // at all, and dividing by very nearly nothing turns it black. Boxes
        // never show it — their six faces are axis-aligned and the two facing
        // away are the two you cannot see. Anything round shows it everywhere:
        // a cylinder has a band down each side facing neither basis, which is
        // why columns, rings and plant stems came out as black bars. Those
        // faces get the turned-away tone instead of a division by zero.
        vec3 lit = (uTop * wTop + uLeft * wLeft + uRight * wRight) / max(wSum, 0.0001);
        // The turned-away tone. It used to be the two side tones blended and
        // knocked back, which in a warm theme is a dark brown — and a dark
        // brown multiplied into anything cool comes out grey. A waterfall seen
        // face on was a slab of wet slate. Lifting it toward the up-tone keeps
        // it clearly the dark side of a thing while leaving enough light in it
        // that the thing's own colour survives the multiply.
        vec3 shade = mix(mix(uLeft, uRight, 0.6), uTop, 0.4) * 0.94;
        vec3 tone = mix(shade, lit, smoothstep(0.0, 0.3, wSum));

        diffuseColor.rgb *= tone;
        diffuseColor.rgb *= mix(1.0 - uGradient, 1.0, clamp(vFacetGrad, 0.0, 1.0));

        // Lamps and screens are the only things that emit, and only at night.
        //
        // What they emit comes off the unshaded color, not off the shaded one:
        // a screen is a source, so which way it happens to face and how dark
        // the night around it is have nothing to say about it. Scaling the
        // shaded color and then lifting it by a flat quarter — which is what
        // this did — pushed every source to the same pale near-white, so a
        // monitor carrying a session's color and a desk lamp carrying the
        // theme's accent lit up identically. The small addition that is left
        // is only there so a source with a dark body still reads as lit.
        diffuseColor.rgb = mix(diffuseColor.rgb, unshaded * ${EMISSIVE_GAIN.toFixed(2)} + ${EMISSIVE_FLOOR.toFixed(3)}, vFacetEmissive * uNight);

        float fog = smoothstep(uFogNear, uFogFar, vFacetDepth);
        float depthIntoVoid = smoothstep(uVoidY, uVoidY - uVoidFade, vFacetWorldY);
        diffuseColor.rgb = mix(diffuseColor.rgb, uFogColor, clamp(fog + depthIntoVoid, 0.0, 1.0));`,
      );
  };

  // Variants must not share a compiled program.
  material.customProgramCacheKey = () => `facet:${instanced ? 'inst' : 'vc'}`;
  return material;
}

/** Pushes a resolved theme into the shared uniforms. One call per frame at most. */
export function applyTheme(theme: ResolvedTheme): void {
  facetUniforms.uTop.value.set(theme.tones.top);
  facetUniforms.uLeft.value.set(theme.tones.left);
  facetUniforms.uRight.value.set(theme.tones.right);
  facetUniforms.uFogColor.value.set(theme.sky[1]);
  facetUniforms.uGradient.value = theme.gradient;
  facetUniforms.uNight.value = theme.emissive;
}

/**
 * Where the world dissolves.
 *
 * Fixed, this was a number chosen for a campus that never strayed far from
 * y = 0. Now that a world can be a hillside, the lowest terrace may sit well
 * under the old plane, and everything below it faded into the sky — a floor
 * you could see through. The void follows the ground instead: it is a property
 * of the campus, set once when the campus changes.
 */
export function setVoidPlane(y: number, fade = 7): void {
  facetUniforms.uVoidY.value = y;
  facetUniforms.uVoidFade.value = fade;
}

const LEFT = new Vector3();
const RIGHT = new Vector3();

/**
 * Re-aims the tone basis at the camera. Without this, orbiting to the far side
 * would show every object's dark faces and the scene would read as unlit mush.
 */
export function setToneBasis(azimuth: number, sunOffset = 0.35): void {
  const left = azimuth + Math.PI * 0.75 + sunOffset;
  const right = azimuth + Math.PI * 0.25 + sunOffset;
  LEFT.set(Math.sin(left), 0, Math.cos(left)).normalize();
  RIGHT.set(Math.sin(right), 0, Math.cos(right)).normalize();
  facetUniforms.uLeftDir.value.copy(LEFT);
  facetUniforms.uRightDir.value.copy(RIGHT);
}
