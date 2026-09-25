import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Color, PlaneGeometry, ShaderMaterial } from 'three';
import type { ResolvedTheme } from '../theme/themes';

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
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    float h = clamp(vUv.y, 0.0, 1.0);
    vec3 color = h < 0.5
      ? mix(uBottom, uMiddle, smoothstep(0.0, 0.5, h))
      : mix(uMiddle, uTop, smoothstep(0.5, 1.0, h));

    color += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
    gl_FragColor = vec4(color, 1.0);
  }
`;

export function Sky({ theme }: { theme: ResolvedTheme }): React.JSX.Element {
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
        },
      }),
    [],
  );

  const current = useRef(theme);
  current.current = theme;
  const invalidate = useThree((state) => state.invalidate);

  useFrame(() => {
    const t = current.current;
    material.uniforms['uBottom']!.value.set(t.sky[0]);
    material.uniforms['uMiddle']!.value.set(t.sky[1]);
    material.uniforms['uTop']!.value.set(t.sky[2]);
    void invalidate;
  });

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={-1000} />;
}
