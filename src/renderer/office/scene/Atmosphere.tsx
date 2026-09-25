import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, PlaneGeometry, ShaderMaterial, Vector4 } from 'three';
import { cameraState } from '../camera/cameraState';
import type { ResolvedTheme } from '../theme/themes';
import {
  ATMOSPHERE,
  CLOUD_STRIDE,
  atmosphereTones,
  birdPresence,
  cloudField,
  cloudPresence,
  createFlock,
  flockAt,
  starPresence,
} from './skyLayers';

/**
 * Weather for the void: clouds, stars and the occasional flock of birds.
 *
 * All of it is screen space, on one quad, in one pass — for the same reason the
 * sky is. The office is drawn through an *orthographic* camera, so distance
 * buys no parallax: a cloud parked a kilometre away would still sweep across
 * the frame at exactly the rate the camera turns, and would rescale every time
 * the view re-fits itself around the platforms. Painting the sky on the screen
 * instead and answering the camera with a small bounded offset gives the one
 * thing distance was for — a hint that you are turning your head — without any
 * of what it costs.
 *
 * It is a second quad rather than more lines in Sky.tsx because it is depth
 * tested against the office. Sitting a hair in front of the far plane, every
 * fragment the office already covers is thrown away before this shader runs at
 * all, which is worth more than the draw call it costs — and it is also what
 * guarantees a bird can never cross in front of a desk.
 */

const f = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`);

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // Just inside the far plane: covered by anything the office drew, over the
    // sky, which does not test depth at all.
    gl_Position = vec4(position.xy, 0.9999, 1.0);
  }
`;

function buildFragment(): string {
  const c = ATMOSPHERE.cloud;
  const s = ATMOSPHERE.star;
  const b = ATMOSPHERE.bird;
  const clouds = c.far + c.near;

  return /* glsl */ `
    uniform float uTime;
    uniform float uAspect;
    uniform vec4 uClouds[${clouds}];
    uniform vec4 uFlock;
    uniform vec3 uCloudLight;
    uniform vec3 uCloudDark;
    uniform vec3 uStarColor;
    uniform vec3 uBirdColor;
    uniform float uCloud;
    uniform float uStar;
    uniform float uBird;
    varying vec2 vUv;

    float hash21(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    vec2 hash22(vec2 p) {
      return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453123);
    }

    /** Back-to-front "over", premultiplied — see premultipliedAlpha below. */
    void paint(inout vec4 dst, vec3 rgb, float a) {
      dst.rgb = rgb * a + dst.rgb * (1.0 - a);
      dst.a = a + dst.a * (1.0 - a);
    }

    float vnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 g = fract(p);
      g = g * g * (3.0 - 2.0 * g);
      return mix(
        mix(hash21(i), hash21(i + vec2(1.0, 0.0)), g.x),
        mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), g.x),
        g.y);
    }

    /**
     * One jittered star per cell, and most cells empty. A flat probability
     * reads as graph paper, so a slow noise opens voids and crowds patches —
     * that, not randomness, is what a night sky actually looks like. The jitter
     * is kept off the cell edges so a star never needs its neighbours sampled.
     */
    float starLayer(vec2 p, float density, float gate, float scale, float salt, float clump) {
      vec2 g = p * density + salt;
      vec2 cell = floor(g);
      if (hash21(cell + salt + 0.5) < gate - ${f(s.clump)} * clump) return 0.0;

      vec2 at = vec2(0.3) + 0.4 * hash22(cell + salt + 1.7);
      float b = hash21(cell + salt + 3.1);
      float bright = b * b * b;
      float radius = (0.1 + 0.13 * bright) * scale;
      float v = smoothstep(radius, 0.0, length(fract(g) - at));

      float amp = ${f(s.twinkle)} * (0.4 + 0.6 * bright);
      float tw = 1.0 - amp + amp * sin(uTime * (0.22 + 0.55 * hash21(cell + salt + 5.9)) + b * 31.4);
      return (v * v + v * 0.12 * bright) * (0.26 + 0.74 * bright) * tw;
    }

    float lozenge(vec2 p, float halfLen, float r) {
      p.x = max(abs(p.x) - halfLen, 0.0);
      return length(p) - r;
    }

    float smin(float a, float b, float k) {
      float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
      return mix(b, a, h) - k * h * (1.0 - h);
    }

    /**
     * Three stacked lozenges on a flat base: a shape you could cut out of paper
     * rather than one you could fly through. Everything else in this office is
     * built from a handful of primitives too.
     */
    float cloudShape(vec2 q, float r, float variant) {
      float a = fract(sin(variant * 12.9898 + 4.1) * 43758.5453123);
      float b = fract(sin(variant * 78.2330 + 1.7) * 43758.5453123);
      float d = lozenge(q + vec2(0.0, 0.02 * r), 0.52 * r, 0.30 * r);
      d = smin(d, lozenge(q - vec2((-0.34 + 0.16 * a) * r, (0.16 + 0.10 * b) * r), 0.16 * r, 0.26 * r), 0.14 * r);
      d = smin(d, lozenge(q - vec2((0.30 + 0.18 * b) * r, (0.13 + 0.12 * a) * r), 0.13 * r, 0.21 * r), 0.12 * r);
      // Sliced off along the bottom. Clouds here sit on a line, like everything
      // else on this floor plan.
      return max(d, -(q.y + 0.22 * r));
    }

    float ndot(vec2 a, vec2 b) { return a.x * b.x - a.y * b.y; }

    float sdRhombus(vec2 p, vec2 b) {
      p = abs(p);
      float h = clamp(ndot(b - 2.0 * p, b) / dot(b, b), -1.0, 1.0);
      float d = length(p - 0.5 * b * vec2(1.0 - h, 1.0 + h));
      return d * sign(p.x * b.y + p.y * b.x - b.x * b.y);
    }

    float sdHexagon(vec2 p, float apothem) {
      vec3 k = vec3(-0.8660254, 0.5, 0.5773503);
      p = abs(p);
      p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
      p -= vec2(clamp(p.x, -k.z * apothem, k.z * apothem), apothem);
      return length(p) * sign(p.y);
    }

    /**
     * A cube, drawn the way the office draws cubes: a hexagon with a lighter
     * top face and no outline. At this size and this far into the haze there is
     * nothing to gain from the third facet.
     */

    /** Distance to a stroke running from the bird's body out to a wing tip. */
    float spoke(vec2 p, vec2 tip) {
      float h = clamp(dot(p, tip) / dot(tip, tip), 0.0, 1.0);
      return length(p - tip * h);
    }

    void main() {
      vec2 p = vec2((vUv.x - 0.5) * uAspect, vUv.y);
      vec4 acc = vec4(0.0);

      // Back to front: stars, both cloud layers, then birds.
      if (uStar > 0.003 && vUv.y > ${f(s.horizon.lo)}) {
        float clump = (vnoise(p * 1.6) - 0.5) * 2.0;
        float lit = starLayer(p, ${f(s.densityBright)}, ${f(s.gateBright)}, 1.0, 0.0, clump)
          + starLayer(p, ${f(s.densityFaint)}, ${f(s.gateFaint)}, 0.72, 17.3, clump) * 0.55;
        lit *= smoothstep(${f(s.horizon.lo)}, ${f(s.horizon.hi)}, vUv.y);
        paint(acc, uStarColor, clamp(lit, 0.0, 1.0) * uStar);
      }


      if (uCloud > 0.003) {
        // Nothing survives down where the office is, however big the cloud.
        float guard = smoothstep(${f(c.guard.lo)}, ${f(c.guard.hi)}, vUv.y);
        for (int i = 0; i < ${clouds}; i++) {
          vec4 cloud = uClouds[i];
          vec2 q = p - cloud.xy;
          float r = cloud.z;
          if (abs(q.x) > r * 1.1 || q.y < -0.5 * r || q.y > 0.75 * r) continue;

          float soft = r * ${f(c.softness)};
          float cover = smoothstep(soft, -soft, cloudShape(q, r, float(i) + 1.0));
          if (cover <= 0.0) continue;
          // Lighter on top, like every other upward face in this office.
          vec3 tint = mix(uCloudDark, uCloudLight, smoothstep(-0.35 * r, 0.55 * r, q.y));
          paint(acc, tint, cover * cloud.w * guard * uCloud);
        }
      }

      if (uBird > 0.003 && uFlock.w > 0.001) {
        float nearest = 1.0;
        for (int i = 0; i < ${b.count}; i++) {
          float fi = float(i);
          // A loose V: rank back from the leader, alternating sides, and one
          // bird over on the last rank so the formation is never symmetrical.
          float rank = ceil(fi * 0.5);
          float side = mod(fi, 2.0) < 0.5 ? 1.0 : -1.0;
          vec2 offset = vec2(-rank * 0.34 * uFlock.z, side * rank * 0.26);
          offset.y += 0.09 * sin(uTime * 0.7 + fi * 1.9);

          vec2 q = p - uFlock.xy - offset * ${f(b.spread)};
          float lift = (0.30 + 0.38 * sin(uTime * ${f(b.flap)} + fi * 0.9)) * ${f(b.span)};
          nearest = min(nearest, min(
            spoke(q, vec2(-${f(b.span)}, lift)),
            spoke(q, vec2(${f(b.span)}, lift))));
        }
        float ink = smoothstep(${f(b.stroke)}, ${f(b.stroke)} * 0.35, nearest);
        paint(acc, uBirdColor, ink * uFlock.w * uBird);
      }

      // Same dither as the sky: a wide, low-contrast shape is exactly what bands.
      float dither = (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
      gl_FragColor = vec4(acc.rgb + dither * acc.a, acc.a);
    }
  `;
}

const FRAGMENT = buildFragment();

export function Atmosphere({
  theme,
  seed = ATMOSPHERE.seed,
}: {
  theme: ResolvedTheme;
  seed?: number;
}): React.JSX.Element {
  const kit = useMemo(() => {
    const clouds = new Float32Array((ATMOSPHERE.cloud.far + ATMOSPHERE.cloud.near) * CLOUD_STRIDE);
    return {
      geometry: new PlaneGeometry(2, 2),
      clouds,
      flock: createFlock(),
      material: new ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        // Depth *tested* against the office but never written: the sky is
        // something everything else is allowed to stand in front of.
        depthTest: true,
        depthWrite: false,
        premultipliedAlpha: true,
        uniforms: {
          uTime: { value: ATMOSPHERE.startTime },
          uAspect: { value: 1.6 },
          uClouds: { value: clouds },
          uFlock: { value: new Vector4(0, 0, 1, 0) },
          uCloudLight: { value: new Color('#FFFFFF') },
          uCloudDark: { value: new Color('#FFFFFF') },
          uStarColor: { value: new Color('#FFFFFF') },
          uBirdColor: { value: new Color('#000000') },
          uCloud: { value: 0 },
          uStar: { value: 0 },
          uBird: { value: 0 },
        },
      }),
    };
  }, []);

  // Colours are hex strings and parsing them allocates, so they move on the
  // theme's own clock — once a second — rather than sixty times a second.
  const birdBase = useRef(0);
  useEffect(() => {
    const tones = atmosphereTones(theme);
    const u = kit.material.uniforms;
    u['uCloudLight']!.value.set(tones.cloudLight);
    u['uCloudDark']!.value.set(tones.cloudDark);
    u['uStarColor']!.value.set(tones.star);
    u['uBirdColor']!.value.set(tones.bird);
    u['uCloud']!.value = cloudPresence(theme.dayFactor);
    u['uStar']!.value = starPresence(theme.dayFactor) * ATMOSPHERE.star.alpha;
    birdBase.current = birdPresence(theme.dayFactor) * ATMOSPHERE.bird.alpha;
  }, [theme, kit]);

  const clock = useRef(ATMOSPHERE.startTime);
  const drift = useRef(0);
  const birds = useRef(1);

  useFrame((state, delta) => {
    const reduced = document.documentElement.dataset['motion'] === 'reduced';
    const step = Math.min(delta, 0.1); // a backgrounded tab must not teleport the sky
    if (!reduced) {
      clock.current += step;
      // Frozen along with everything else: the camera keeps its idle drift even
      // under reduced motion, and a sky that answered it would still be moving.
      drift.current = Math.sin(cameraState.azimuth) * ATMOSPHERE.parallax;
    }

    const time = clock.current;
    const aspect = state.size.width / Math.max(1, state.size.height);
    cloudField(time, seed, aspect, drift.current, kit.clouds);
    flockAt(time, seed, aspect, kit.flock);

    // Freezing a flock mid-sky would leave six birds pinned there for good, so
    // reduced motion lets them finish leaving instead, over a couple of
    // seconds: a flock that blinks out is its own kind of movement.
    birds.current += ((reduced ? 0 : 1) - birds.current) * Math.min(1, step / ATMOSPHERE.bird.settle);

    const u = kit.material.uniforms;
    u['uTime']!.value = time;
    u['uAspect']!.value = aspect;
    u['uBird']!.value = birdBase.current * birds.current;
    u['uFlock']!.value.set(
      kit.flock.x,
      kit.flock.y,
      kit.flock.direction,
      kit.flock.active ? kit.flock.fade : 0,
    );
  });

  return (
    <mesh
      geometry={kit.geometry}
      material={kit.material}
      frustumCulled={false}
      renderOrder={-999}
    />
  );
}
