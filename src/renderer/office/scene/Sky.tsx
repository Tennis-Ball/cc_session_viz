import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, PlaneGeometry, ShaderMaterial, Vector2 } from 'three';
import { mixHex, sunAzimuthFor, type ResolvedTheme } from '../theme/themes';
import { setOvercast, setSkyLight, setViewportHeight } from '../material/facet';
import { cameraState } from '../camera/cameraState';

/**
 * The void the office floats in: a screen-space vertical gradient.
 *
 * Painting it in screen space rather than on a sky dome keeps the gradient
 * perfectly vertical from every camera angle, which is what makes the scene
 * read as a printed page rather than a 3D environment. A touch of dithering
 * kills the banding a wide flat gradient would otherwise show.
 *
 * The gradient and nothing else. Everything in front of it — stars, clouds,
 * birds — belongs to Atmosphere, which draws on its own quad so that the office
 * can occlude it.
 */

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.9999, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uBottom;
  uniform vec3 uMiddle;
  uniform vec3 uTop;
  uniform vec3 uGlow;
  uniform vec2 uSun;
  uniform float uSunStrength;
  uniform float uAspect;
  uniform float uOvercast;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    float h = clamp(vUv.y, 0.0, 1.0);

    /*
     * One curve rather than two segments meeting at the middle.
     *
     * The three stops used to be joined by a pair of smoothsteps hinged at
     * h = 0.5, which puts a crease exactly halfway up every frame: both halves
     * are smooth and the *slope* is not, and a wide flat gradient is the one
     * place an eye can see that. Weighting the three against each other gives
     * a single continuous ramp with no seam to find.
     */
    float wBottom = pow(1.0 - h, 2.0);
    float wTop = pow(h, 2.0);
    float wMiddle = 2.0 * h * (1.0 - h);
    float sum = wBottom + wMiddle + wTop;
    vec3 color = (uBottom * wBottom + uMiddle * wMiddle + uTop * wTop) / sum;

    /*
     * The sun, as a glow rather than a disc.
     *
     * A disc would be the only hard-edged circle in a scene made entirely of
     * flat facets, and at this scale it reads as a sticker. What actually says
     * "the light is over there" is the sky being warmer on one side — and it
     * moves through the day, which is what turns a palette that changes colour
     * into a sky that has a time in it.
     */
    if (uSunStrength > 0.001) {
      vec2 d = vec2((vUv.x - uSun.x) * uAspect, vUv.y - uSun.y);
      float near = exp(-dot(d, d) * 3.4);
      float wide = exp(-dot(d, d) * 0.55);
      color = mix(color, uGlow, clamp((near * 0.75 + wide * 0.45) * uSunStrength, 0.0, 1.0));
    }

    // Overcast flattens the sky toward its own middle: less range top to
    // bottom, and the warmth taken out of it.
    color = mix(color, mix(uMiddle, vec3(dot(uMiddle, vec3(0.299, 0.587, 0.114))), 0.35), uOvercast * 0.55);

    color += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
    gl_FragColor = vec4(color, 1.0);
  }
`;

export function Sky({ theme, overcast = 0 }: { theme: ResolvedTheme; overcast?: number }): React.JSX.Element {
  const geometry = useMemo(() => new PlaneGeometry(2, 2), []);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        depthWrite: false,
        depthTest: false,
        uniforms: {
          uBottom: { value: new Color('#FFE3C9') },
          uMiddle: { value: new Color('#FFD2C4') },
          uTop: { value: new Color('#C9C4EE') },
          uGlow: { value: new Color('#FFF0D2') },
          uSun: { value: new Vector2(0.5, 0.4) },
          uSunStrength: { value: 0 },
          uAspect: { value: 1 },
          uOvercast: { value: 0 },
        },
      }),
    [],
  );

  const current = useRef(theme);
  current.current = theme;
  const wanted = useRef(overcast);
  wanted.current = overcast;
  /** Eased, so the sky flattens and opens over a couple of seconds. */
  const cover = useRef(overcast);
  const size = useThree((state) => state.size);

  useFrame((state, delta) => {
    const t = current.current;
    cover.current += (wanted.current - cover.current) * Math.min(1, Math.min(delta, 0.1) * 1.1);

    /*
     * Tell the office what the sky is, so that anything dissolving into it
     * dissolves into the right colour.
     *
     * From here rather than from the office, because this is the component
     * that decides what the background looks like — the ramp, the flattening
     * under cloud, and the pixel height the ramp is measured in. Anywhere else
     * and the two are free to drift, which is exactly what a ghost of a rock
     * column hanging below a platform was.
     */
    setViewportHeight(state.gl.domElement.height);
    setOvercast(cover.current);
    material.uniforms['uBottom']!.value.set(t.sky[0]);
    material.uniforms['uMiddle']!.value.set(t.sky[1]);
    material.uniforms['uTop']!.value.set(t.sky[2]);
    material.uniforms['uAspect']!.value = size.width / Math.max(1, size.height);
    material.uniforms['uOvercast']!.value = cover.current;

    /*
     * Where the sun lands on screen.
     *
     * The sky is drawn in screen space, so this is a bearing rather than a
     * position: how far round the sun is from whatever the camera is facing.
     * Behind the camera it fades out entirely — there is no glow on the wrong
     * side of the sky, and orbiting past it is most of how the sun reads as
     * being somewhere rather than everywhere.
     */
    const bearing = sunAzimuthFor(t.dayFactor, t.falling) - cameraState.azimuth - Math.PI;
    const facing = Math.max(0, Math.cos(bearing));
    material.uniforms['uSun']!.value.set(0.5 + 0.34 * Math.sin(bearing), 0.1 + 0.46 * t.dayFactor);
    // Weakest at noon, when a real sun is small and white, and strongest at
    // the two ends — which is exactly when the palette is doing the least.
    const strength = (0.32 + 0.5 * (1 - t.dayFactor)) * facing * (0.25 + 0.75 * t.dayFactor);
    const lit = strength * (1 - cover.current * 0.85);
    const glow = mixHex(t.sky[0], '#FFFFFF', 0.35);
    material.uniforms['uSunStrength']!.value = lit;
    material.uniforms['uGlow']!.value.set(glow);
    // And the same glow to the office, so a fragment fading out lands on the
    // sky that is actually behind it rather than on the ramp without the sun.
    setSkyLight(
      material.uniforms['uSun']!.value.x,
      material.uniforms['uSun']!.value.y,
      lit,
      glow,
      material.uniforms['uAspect']!.value,
    );
  });

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={-1000} />;
}
