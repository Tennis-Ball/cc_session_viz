import {
  Color,
  LineBasicMaterial,
  MeshBasicMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type WebGLProgramParametersWithUniforms,
} from 'three';
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
  /**
   * The sky, as its three stops, so anything dissolving can melt into the
   * *exact* colour behind it.
   *
   * It used to be one colour — the middle stop — and the sky is a vertical
   * gradient, so at the bottom of the frame, which is precisely where the rock
   * columns dissolve, the fade was aiming at a blue several shades darker than
   * the sky actually was there. The result was a pale ghost of a column
   * hanging under every platform: not a rendering glitch so much as a fade
   * that had been told the wrong answer.
   *
   * Held in the colour space the sky quad paints in rather than the one the
   * theme is written in; `asPainted` is where that is done and why.
   */
  uSkyBottom: { value: Color };
  uSkyMiddle: { value: Color };
  uSkyTop: { value: Color };
  /**
   * And the sun's glow on it, because the sky is not only its ramp.
   *
   * `Sky` lifts a wide, soft lobe of the gradient toward white where the sun
   * is. Leaving it out of the reconstruction put a four-per-cent error into
   * every fading fragment on the sunward half of the frame — small, but it is
   * a *silhouette* error, and a silhouette is the one thing an eye finds for
   * free. Cheap to carry and it closes the match at every hour.
   */
  uSkyGlow: { value: Color };
  /** Where the sun is, in the same screen coordinates `Sky` uses. */
  uSun: { value: Vector2 };
  uSunStrength: { value: number };
  uAspect: { value: number };
  /** Drawing-buffer height, so the ramp can be read off gl_FragCoord. */
  uViewport: { value: number };
  /** The same flattening Sky applies under cloud, or the two drift apart. */
  uOvercast: { value: number };
  uFogNear: { value: number };
  uFogFar: { value: number };
  /** Below this world height, everything dissolves into the void. */
  uVoidY: { value: number };
  uVoidFade: { value: number };
  uNight: { value: number };
  /**
   * Lightning, on the campus rather than only in the sky.
   *
   * A storm that lights its own cloud and leaves the building it is over
   * completely unchanged is a picture with a weather effect pasted on top of
   * it. One line and a sixth of a second of a few per cent more light is the
   * difference between those two things, and it is the cheapest thing in this
   * file. Kept small on purpose: the office has to stay readable *through* it.
   */
  uFlash: { value: number };
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
  uSkyBottom: { value: new Color('#FFE3C9') },
  uSkyMiddle: { value: new Color('#FFD2C4') },
  uSkyTop: { value: new Color('#C9C4EE') },
  uSkyGlow: { value: new Color('#FFF0D2') },
  uSun: { value: new Vector2(0.5, 0.4) },
  uSunStrength: { value: 0 },
  uAspect: { value: 1 },
  uViewport: { value: 1000 },
  uOvercast: { value: 0 },
  uFogNear: { value: FOG_NEAR },
  uFogFar: { value: FOG_FAR },
  uVoidY: { value: -5 },
  uVoidFade: { value: 7 },
  uNight: { value: 0 },
  uFlash: { value: 0 },
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
  /**
   * Platforms that can arrive and leave. See `MAX_STAGES`.
   *
   * A variant rather than something every facet material carries, because the
   * campus is one merged mesh and this is the only mesh in the office that has
   * to animate a *part* of itself.
   */
  staged?: boolean;
  /**
   * Aerial perspective, baked per vertex. See `Distance`.
   *
   * The distance has to look further off than it is, and under an orthographic
   * camera the only cues left are scale and haze. Haze means "closer to the
   * sky", and *which* sky is the whole difficulty: it is a vertical gradient
   * painted in screen space, so a landmark hanging beside the office at
   * mid-frame has to fade toward a colour several shades deeper than the one
   * at the horizon. Mixing toward a single stop on the CPU — which is what
   * this did — leaves a pale slab hanging in a dark sky, however far the mix
   * is pushed: at eighty-six per cent toward `sky[0]` the block still stood
   * seventy levels of red clear of the sky behind it.
   *
   * So the amount is baked and the *colour* is the one the fragment already
   * works out for the fog and the void. One attribute, one term, and a
   * landmark is the right shade of nothing at every height, hour and theme.
   */
  aerial?: boolean;
}

/**
 * How many things can be arriving or leaving at once.
 *
 * One slot per platform, plus slot 0 for everything that is simply there. A
 * campus is a dozen rooms and up to about thirty desks; this is past the
 * biggest world the layout will build and still four uniform vec4s.
 */
export const MAX_STAGES = 64;

export interface StageUniforms {
  /** 0 = fully struck, 1 = settled. Slot 0 is pinned at 1. */
  uStage: { value: Float32Array };
  /** How far a struck platform sits below where it belongs. */
  uStageDrop: { value: number };
}

export function createFacetMaterial(options: FacetOptions = {}): MeshBasicMaterial {
  const material = new MeshBasicMaterial({
    vertexColors: !options.instancedGradient,
    transparent: options.transparent ?? false,
    opacity: options.opacity ?? 1,
    fog: false,
  });

  const instanced = options.instancedGradient === true;
  const staged = options.staged === true;
  const aerial = options.aerial === true;

  /*
   * Per material, not shared.
   *
   * Everything else the facet shader knows is a property of the scene — the
   * hour, the fog, where the light is — and is written once for all of it.
   * Which platforms are half-built is a property of *this mesh*, so it is the
   * one thing that does not go in the module-level block.
   */
  const stage: StageUniforms | null = staged
    ? { uStage: { value: settledStages() }, uStageDrop: { value: 0 } }
    : null;
  if (stage) material.userData['stage'] = stage;

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, facetUniforms);
    if (stage) Object.assign(shader.uniforms, stage);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aGrad;
        attribute float aEmissive;
        ${aerial ? 'attribute float aWash;\n        varying float vFacetWash;' : ''}
        ${staged ? `attribute float aStage;
        uniform float uStage[${MAX_STAGES}];
        uniform float uStageDrop;` : ''}
        ${instanced ? 'attribute vec3 aColorBottom;\nattribute vec3 aColorTop;' : ''}
        varying vec3 vFacetNormal;
        varying float vFacetGrad;
        varying float vFacetDepth;
        varying float vFacetWorldY;
        varying float vFacetEmissive;
        ${instanced ? 'varying vec3 vFacetBottom;\nvarying vec3 vFacetTop;' : ''}`,
      )
      /*
       * Struck platforms sit below the world and rise into it.
       *
       * Dropped rather than faded, so the *existing* void fade does the
       * dissolving — which means an arriving room is occluded correctly by
       * everything it passes behind, costs no transparency and no sorting, and
       * comes up out of the same haze the campus already stands in. Injected
       * before `project_vertex` so the drop is in `transformed` by the time
       * the facet block reads it back out as a world position.
       */
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        ${staged ? 'transformed.y -= (1.0 - uStage[int(aStage)]) * uStageDrop;' : ''}`,
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
        ${aerial ? 'vFacetWash = aWash;' : ''}
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
        uniform vec3 uSkyBottom;
        uniform vec3 uSkyMiddle;
        uniform vec3 uSkyTop;
        uniform vec3 uSkyGlow;
        uniform vec2 uSun;
        uniform float uSunStrength;
        uniform float uAspect;
        uniform float uViewport;
        uniform float uOvercast;
        uniform float uFogNear;
        uniform float uFogFar;
        uniform float uVoidY;
        uniform float uVoidFade;
        uniform float uNight;
        uniform float uFlash;
        varying vec3 vFacetNormal;
        varying float vFacetGrad;
        varying float vFacetDepth;
        varying float vFacetWorldY;
        varying float vFacetEmissive;
        ${aerial ? 'varying float vFacetWash;' : ''}
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

        // A storm, briefly, over everything. Multiplied rather than added, so
        // it lifts what is already there instead of washing toward white.
        diffuseColor.rgb *= 1.0 + uFlash * 0.16;

        /*
         * Whatever the sky is doing at this pixel, which is what a thing
         * disappearing has to become.
         *
         * The same three-weight ramp Sky.tsx draws, read off the fragment's
         * own height rather than off the geometry — the sky is painted in
         * screen space, so "the colour behind this pixel" is a function of
         * where the pixel is and nothing else. Getting this wrong is invisible
         * in the middle of the frame and unmissable at the bottom of it.
         */
        float skyH = clamp(gl_FragCoord.y / uViewport, 0.0, 1.0);
        float wB = (1.0 - skyH) * (1.0 - skyH);
        float wT = skyH * skyH;
        float wM = 2.0 * skyH * (1.0 - skyH);
        vec3 sky = (uSkyBottom * wB + uSkyMiddle * wM + uSkyTop * wT) / (wB + wM + wT);
        // Then the sun, in the order Sky paints it: ramp, glow, overcast.
        vec2 sunTo = vec2((gl_FragCoord.x / (uViewport * uAspect) - uSun.x) * uAspect, skyH - uSun.y);
        float sunNear = exp(-dot(sunTo, sunTo) * 3.4);
        float sunWide = exp(-dot(sunTo, sunTo) * 0.55);
        sky = mix(sky, uSkyGlow, clamp((sunNear * 0.75 + sunWide * 0.45) * uSunStrength, 0.0, 1.0));
        sky = mix(sky, mix(uSkyMiddle, vec3(dot(uSkyMiddle, vec3(0.299, 0.587, 0.114))), 0.35), uOvercast * 0.55);

        float fog = smoothstep(uFogNear, uFogFar, vFacetDepth);
        float depthIntoVoid = smoothstep(uVoidY, uVoidY - uVoidFade, vFacetWorldY);
        ${aerial ? 'float aerialHaze = vFacetWash;' : 'float aerialHaze = 0.0;'}
        diffuseColor.rgb = mix(diffuseColor.rgb, sky, clamp(fog + depthIntoVoid + aerialHaze, 0.0, 1.0));`,
      );
  };

  // Variants must not share a compiled program.
  material.customProgramCacheKey = () =>
    `facet:${instanced ? 'inst' : 'vc'}${staged ? ':staged' : ''}${aerial ? ':aerial' : ''}`;
  return material;
}

/**
 * Ink & Paper's lines, which have to obey the same two rules the solids do.
 *
 * `EdgesGeometry` throws every attribute away but `position`, so the lines knew
 * nothing about staging and nothing about the void: a room rising left its own
 * outline hanging in the air above it, and a rock column that had dissolved
 * into the sky kept its edges — a wireframe of a platform that was not there.
 * Both are the same omission, and both are fixed by giving the line material
 * the two things the facet material already had.
 *
 * The lines are built per platform and tagged before they are merged; see
 * `Platforms`.
 */
export function createInkMaterial(color: string, options: { aerial?: boolean } = {}): LineBasicMaterial {
  const material = new LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const stage: StageUniforms = { uStage: { value: settledStages() }, uStageDrop: { value: 0 } };
  material.userData['stage'] = stage;
  const aerial = options.aerial === true;

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, facetUniforms, stage);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aStage;
        uniform float uStage[${MAX_STAGES}];
        uniform float uStageDrop;
        ${aerial ? 'attribute float aWash;\n        varying float vInkWash;' : ''}
        varying float vInkDepth;
        varying float vInkY;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        transformed.y -= (1.0 - uStage[int(aStage)]) * uStageDrop;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vInkY = (modelMatrix * vec4(transformed, 1.0)).y;
        ${aerial ? 'vInkWash = aWash;' : ''}
        vInkDepth = -mvPosition.z;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uFogNear;
        uniform float uFogFar;
        uniform float uVoidY;
        uniform float uVoidFade;
        ${aerial ? 'varying float vInkWash;' : ''}
        varying float vInkDepth;
        varying float vInkY;`,
      )
      .replace(
        '#include <premultiplied_alpha_fragment>',
        `// A line does not fade toward the sky — it fades *out*. Tinting a
        // stroke the colour of the paper it is drawn on leaves a pale stroke;
        // what is wanted is no stroke.
        //
        // Which is also why the distance's outlines have to carry its haze.
        // The fill dissolves and the stroke does not, and what is left is the
        // one thing worse than a slab hanging in the sky beside the office: a
        // wireframe of one.
        float inkFog = smoothstep(uFogNear, uFogFar, vInkDepth);
        float inkVoid = smoothstep(uVoidY, uVoidY - uVoidFade, vInkY);
        ${aerial ? 'float inkHaze = vInkWash;' : 'float inkHaze = 0.0;'}
        gl_FragColor.a *= 1.0 - clamp(inkFog + inkVoid + inkHaze, 0.0, 1.0);
        #include <premultiplied_alpha_fragment>`,
      );
  };

  material.customProgramCacheKey = () => `ink:staged${aerial ? ':aerial' : ''}`;
  return material;
}

/** Everything present and settled, which is what a world starts as. */
function settledStages(): Float32Array {
  return new Float32Array(MAX_STAGES).fill(1);
}

/** The staging block a `staged` material carries, or null. */
export function stageUniforms(material: MeshBasicMaterial | LineBasicMaterial): StageUniforms | null {
  return (material.userData['stage'] as StageUniforms | undefined) ?? null;
}

/** Pushes a resolved theme into the shared uniforms. One call per frame at most. */
export function applyTheme(theme: ResolvedTheme): void {
  facetUniforms.uTop.value.set(theme.tones.top);
  facetUniforms.uLeft.value.set(theme.tones.left);
  facetUniforms.uRight.value.set(theme.tones.right);
  asPainted(facetUniforms.uSkyBottom.value, theme.sky[0]);
  asPainted(facetUniforms.uSkyMiddle.value, theme.sky[1]);
  asPainted(facetUniforms.uSkyTop.value, theme.sky[2]);
  facetUniforms.uGradient.value = theme.gradient;
  facetUniforms.uNight.value = theme.emissive;
}

/**
 * A sky colour as the sky quad actually paints it, not as the theme spells it.
 *
 * `Sky` is a `ShaderMaterial` that writes `gl_FragColor` itself, so nothing
 * converts its output: the linear numbers three stores for `#DCE4F0` go
 * straight into an sRGB drawing buffer and are read back as `#B6C6DE`. The
 * office's own material goes through three's `colorspace_fragment` and comes
 * out at `#DCE4F0` exactly. Both are internally consistent; they are simply
 * not the same colour, by about a fifth of the red channel — so every rock
 * column that dissolved into "the sky" dissolved into something paler and
 * flatter than the sky behind it, and hung there as a grey ghost with a hard
 * silhouette and a visible flat bottom. That is the reflection under the
 * world.
 *
 * Measured rather than reasoned: the ramp at the foot of the frame renders
 * rgb(182,198,222) and the fade settled at rgb(211,215,221), which is
 * `srgbToLinear` applied once too few times.
 *
 * Matching the *painting* rather than the *palette* is deliberate. The other
 * repair is to encode the sky quad properly, which is more correct in the
 * abstract and would lighten every sky in the app by that same fifth —
 * thirty-odd triples, all of them tuned by eye against what is on the screen
 * now. The picture is the thing being tuned; this makes the fade agree with
 * it, in one place, with nothing else to keep in step.
 */
function asPainted(target: Color, hex: string): void {
  PAINTED.set(hex);
  // Reading the linear values back *as* sRGB is exactly what the framebuffer
  // does to them, which is why this is the transform and not an approximation.
  target.setRGB(PAINTED.r, PAINTED.g, PAINTED.b, SRGBColorSpace);
}

const PAINTED = new Color();

/**
 * Where the sun is on the sky, and how hard it is glowing.
 *
 * Pushed from `Sky`, which owns all of it, for the same reason the ramp is:
 * two places computing the same glow is two places for them to drift apart.
 */
export function setSkyLight(x: number, y: number, strength: number, glow: string, aspect: number): void {
  facetUniforms.uSun.value.set(x, y);
  facetUniforms.uSunStrength.value = strength;
  asPainted(facetUniforms.uSkyGlow.value, glow);
  facetUniforms.uAspect.value = aspect;
}

/** How tall the drawing buffer is, in the units `gl_FragCoord` counts in. */
export function setViewportHeight(pixels: number): void {
  facetUniforms.uViewport.value = Math.max(1, pixels);
}

/** Kept in step with the sky's own flattening; see `Sky`. */
export function setOvercast(amount: number): void {
  facetUniforms.uOvercast.value = amount;
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
 * Where the light is, as an offset on the basis. Module state because the
 * camera writes the basis every frame and the clock writes the sun once a
 * second, and threading a second argument from one to the other means the
 * camera has to know about the time of day.
 */
let sunOffset = 0.35;

/** Called by the atmosphere, which is the only thing that knows about storms. */
export function setFlash(strength: number): void {
  facetUniforms.uFlash.value = strength;
}

/** Called by whoever owns the clock; see `sunOffsetFor`. */
export function setSunOffset(offset: number): void {
  sunOffset = offset;
}

/**
 * Re-aims the tone basis at the camera. Without this, orbiting to the far side
 * would show every object's dark faces and the scene would read as unlit mush.
 */
export function setToneBasis(azimuth: number): void {
  const left = azimuth + Math.PI * 0.75 + sunOffset;
  const right = azimuth + Math.PI * 0.25 + sunOffset;
  LEFT.set(Math.sin(left), 0, Math.cos(left)).normalize();
  RIGHT.set(Math.sin(right), 0, Math.cos(right)).normalize();
  facetUniforms.uLeftDir.value.copy(LEFT);
  facetUniforms.uRightDir.value.copy(RIGHT);
}
