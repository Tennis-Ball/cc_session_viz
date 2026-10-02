import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, PlaneGeometry, ShaderMaterial, Vector3, Vector4 } from 'three';
import { cameraState } from '../camera/cameraState';
import { setFlash } from '../material/facet';
import { mixHex, type ResolvedTheme } from '../theme/themes';
import type { Weather } from '@shared/prefs';
import {
  ATMOSPHERE,
  CLOUD_STRIDE,
  SHAPE_STRIDE,
  atmosphereTones,
  birdPresence,
  cloudField,
  cloudPresence,
  createFlash,
  createFlock,
  flashAt,
  flockAt,
  overcastTones,
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

  return (/* glsl */ `
    uniform float uTime;
    uniform float uAspect;
    uniform vec4 uClouds[${clouds}];
    uniform vec4 uCloudShape[${clouds}];
    uniform vec4 uFlock;
    uniform vec3 uCloudLight;
    uniform vec3 uCloudDark;
    uniform vec3 uStarColor;
    uniform vec3 uBirdColor;
    uniform float uCloud;
    uniform float uStar;
    uniform float uBird;
    uniform float uRain;
    uniform vec3 uRainColor;
    /** x, y, strength. See flashAt(). */
    uniform vec3 uFlash;
    /** 0 none, 1 monoliths, 2 terraces. */
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

    /**
     * A long low sheet: the shape a covered sky is actually made of.
     *
     * Overcast used to be the fair-weather cloud at higher opacity, and that is
     * why it read as haze — eight puffs you can see through do not become a lid
     * however solid you make them. What makes a grey day grey is that the
     * shapes are *wide and flat and overlapping*, so the sky stops having gaps
     * in it. The roll along the top is the only detail it needs; the underside
     * is a straight line because that is what a cloud base is.
     */
    float stratusShape(vec2 q, float r, float stretch, float variant) {
      float halfLen = r * stretch * 0.8;
      float u = q.x / max(r, 0.0001);
      // Undulating along the top, at three scales, so a bank of them has
      // modelling in it instead of being a ruled band.
      float roll = r * (0.13 * sin(u * 0.8 + variant * 2.3)
                      + 0.06 * sin(u * 2.1 + variant * 5.1)
                      + 0.03 * sin(u * 4.7 + variant * 1.7));
      /*
       * A rectangle, not a lozenge.
       *
       * Thick, because at 0.2r the sheet was thinner than its own edge feather
       * and dissolved itself — which is why overcast came out as haze. And
       * square-ended, because a long shape with round caps is a sausage: the
       * cap is the same curve at both ends and the eye reads the pair of them
       * as one object rather than as a bank of cloud. Chebyshev gives flat
       * sides and hard corners, which is the cut-paper the cumulus is already
       * made of; the taper is what keeps the ends from looking guillotined.
       */
      float reach = clamp(abs(q.x) / max(halfLen, 0.0001), 0.0, 1.0);
      float halfH = r * 0.5 * (1.0 - 0.72 * reach * reach * reach);
      float d = max(abs(q.y - roll) - halfH, abs(q.x) - halfLen);
      return max(d, -(q.y + 0.34 * r));
    }

    /**
     * Three thin strokes, miles up and barely there.
     *
     * A clear sky with nothing in it is the emptiest the frame ever gets, and
     * this is the cheapest thing that can be put in it that does not make it
     * look like weather. It is drawn faint and left alone.
     */
    float cirrusShape(vec2 q, float r, float stretch, float variant) {
      float d = 1e9;
      for (int k = 0; k < 3; k++) {
        float fk = float(k);
        float off = (fk - 1.0) * r * 0.26;
        float lead = sin(variant * 3.7 + fk * 2.1) * r * stretch * 0.18;
        d = min(d, lozenge(vec2(q.x - lead, q.y - off), r * stretch * (0.42 + 0.2 * fk), r * 0.034));
      }
      return d;
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
          if (cloud.w <= 0.001) continue;
          vec4 form = uCloudShape[i];
          float kind = form.x;
          float stretch = form.y;
          float r = cloud.z;

          vec2 q = p - cloud.xy;
          // Tilted before it is shaped, which is the only way a cirrus stroke
          // gets to lie across the sky at an angle.
          float ct = cos(form.z), st = sin(form.z);
          q = vec2(q.x * ct - q.y * st, q.x * st + q.y * ct);

          float halfW = r * max(1.15, stretch * 1.1);
          if (abs(q.x) > halfW || q.y < -0.9 * r || q.y > 1.1 * r) continue;

          /*
           * The feather, which a stretched shape may not simply scale.
           *
           * Widening it with the stretch is the obvious move and it is wrong:
           * the feather is measured off the *distance field*, so on a long
           * flat sheet it eats in from the top and bottom exactly as fast as
           * from the ends, and a sheet is thin. Held near constant instead,
           * the ends still soften — they are the only part of the outline with
           * any curvature — and the body of the lid survives.
           */
          float soft = r * ${f(c.softness)} * (kind > 1.5 ? 0.8 : 1.0);
          float d = kind > 1.5
            ? cirrusShape(q, r, stretch, form.w)
            : kind > 0.5
              ? stratusShape(q, r, stretch, form.w)
              : cloudShape(q, r, form.w);
          float cover = smoothstep(soft, -soft, d);
          if (cover <= 0.0) continue;

          // Lighter on top, like every other upward face in this office.
          vec3 tint = mix(uCloudDark, uCloudLight, smoothstep(-0.35 * r, 0.55 * r, q.y));

          /*
           * And lit from inside if there is a storm in it.
           *
           * Distance-weighted, so one cloud carries the stroke and its
           * neighbours only catch the edge of it — which is what makes the
           * flash have a *place* rather than being the screen going bright.
           */
          if (uFlash.z > 0.001) {
            float near = exp(-dot((cloud.xy - uFlash.xy) / ${f(ATMOSPHERE.flash.spread)}, (cloud.xy - uFlash.xy) / ${f(ATMOSPHERE.flash.spread)}));
            tint += uFlash.z * near * 1.6;
          }
          // Cirrus is the faintest thing in the sky and stays that way.
          float weight = kind > 1.5 ? 0.42 : 1.0;
          paint(acc, tint, cover * cloud.w * weight * guard * uCloud);
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

      /*
       * Rain: slanted strokes, in front of everything else in the sky.
       *
       * Drawn as a hatch rather than as particles — a few thousand quads for
       * something this far away would cost more than the whole office does,
       * and the office is a drawing, so what it wants is the *mark* rain makes
       * rather than the physics. Three layers at different speeds and lengths
       * give it depth; the guard keeps it out of the bottom of the frame for
       * the same reason the clouds stay up there.
       */
      if (uRain > 0.003) {
        float guard = smoothstep(0.02, 0.22, vUv.y);
        float wet = 0.0;
        for (int layer = 0; layer < 3; layer++) {
          float fl = float(layer);
          float scale = 26.0 + fl * 16.0;
          float speed = 0.55 + fl * 0.35;
          // Slanted, and each layer slanted a little differently so the three
          // never line up into a plaid.
          /*
           * Plus uTime, not minus.
           *
           * A feature sits at a fixed q.y, so q.y = p.y * scale - t solves
           * to p.y = q.y / scale + t -- the streak climbs. The rain has been
           * falling upward since the day it was written, which is exactly the
           * kind of thing that is invisible in the code and obvious on screen.
           * With the sign the other way the pattern slides down *along* its own
           * slant, which is also why the streaks do not need to be re-angled.
           */
          vec2 q = vec2(p.x * scale + p.y * (3.2 + fl * 0.6), p.y * scale + uTime * scale * speed);
          vec2 cell = floor(q);
          vec2 f2 = fract(q);
          vec2 r = hash22(cell);
          /*
           * A scatter of fine dashes, which is what this was before it was
           * "improved".
           *
           * It had been made denser, longer and darker on the reasoning that
           * rain reads as rain at the point the strokes start overlapping.
           * True of rain you are standing in, and wrong for rain seen across
           * a valley — and wrong for this scene whatever the meteorology,
           * because long dark strokes at a third of the cells are the loudest
           * thing in a picture somebody is going to leave open all afternoon.
           * Short, fine and sparse: the mark rain makes, not the weather.
           *
           * Then brought back up, because sparse had gone past "quiet" into
           * "nobody can tell it is raining" — which is the other way of getting
           * weather wrong. A quarter of the cells, a stroke half again as fine
           * as the dramatic version and half again as strong as the invisible
           * one. The test is whether you notice it without being told, not
           * whether you can find it.
           */
          if (r.x > 0.25 + fl * 0.05) continue;
          float streak = smoothstep(0.05, 0.0, abs(f2.x - r.y))
            * smoothstep(0.0, 0.08, f2.y) * smoothstep(0.68, 0.3, f2.y);
          wet = max(wet, streak * (0.66 - fl * 0.14));
        }
        paint(acc, uRainColor, clamp(wet, 0.0, 1.0) * guard * uRain);
      }

      // Same dither as the sky: a wide, low-contrast shape is exactly what bands.
      float dither = (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
      gl_FragColor = vec4(acc.rgb + dither * acc.a, acc.a);
    }
  `);
}

const FRAGMENT = buildFragment();

export function Atmosphere({
  theme,
  seed = ATMOSPHERE.seed,
  weather = 'clear',
}: {
  theme: ResolvedTheme;
  seed?: number;
  weather?: Weather;
}): React.JSX.Element {
  const kit = useMemo(() => {
    const slots = ATMOSPHERE.cloud.far + ATMOSPHERE.cloud.near;
    const clouds = new Float32Array(slots * CLOUD_STRIDE);
    const shapes = new Float32Array(slots * SHAPE_STRIDE);
    return {
      geometry: new PlaneGeometry(2, 2),
      clouds,
      shapes,
      flock: createFlock(),
      flash: createFlash(),
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
          uCloudShape: { value: shapes },
          uFlock: { value: new Vector4(0, 0, 1, 0) },
          uFlash: { value: new Vector3(0, 0.8, 0) },
          uCloudLight: { value: new Color('#FFFFFF') },
          uCloudDark: { value: new Color('#FFFFFF') },
          uStarColor: { value: new Color('#FFFFFF') },
          uBirdColor: { value: new Color('#000000') },
          uRain: { value: 0 },
          uRainColor: { value: new Color('#B9C6DA') },
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
  /*
   * Weather arrives; it does not cut.
   *
   * Which clouds a sky holds, how many and what shape, is a discrete choice —
   * a cumulus does not become a stratus by degrees, and trying to interpolate
   * one into the other is a great deal of arithmetic in aid of a shape that is
   * neither. What *can* be done smoothly is the layer's presence, so the sky
   * lets go of the weather it had, changes its mind while there is nothing
   * much up there, and gathers the new one. It takes about two seconds and it
   * is the difference between the weather changing and the picture changing.
   */
  const [drawn, setDrawn] = useState<Weather>(weather);
  const presence = useRef(1);

  useEffect(() => {
    const u = kit.material.uniforms;
    const grey = ATMOSPHERE.cloud.weather[drawn]?.grey ?? 0;
    const tones = overcastTones(atmosphereTones(theme), theme, grey);
    u['uCloudLight']!.value.set(tones.cloudLight);
    u['uCloudDark']!.value.set(tones.cloudDark);
    u['uStarColor']!.value.set(tones.star);
    u['uBirdColor']!.value.set(tones.bird);
    /*
     * Weather rides on top of the hour rather than replacing it.
     *
     * Overcast is more cloud, not different cloud, and rain is overcast with
     * something falling through it. Stars go out when it is covered, for the
     * obvious reason, and the flock thins — birds sit a shower out, which is
     * also what the perching ones do (see `Birds`).
     */
    const covered = drawn === 'clear' ? 0 : drawn === 'cloudy' ? 0.75 : 1;
    /*
     * Presence, not opacity.
     *
     * Overcast is more cloud *and different cloud* — the count and the shape
     * come out of `cloudField`, which is where the weather actually lands. All
     * that is left here is how strongly the layer is drawn at all, and pushing
     * that past about 1.2 is what made a grey day look like a dirty window.
     */
    u['uCloud']!.value = Math.min(1.15, cloudPresence(theme.dayFactor) * (1 + covered * 0.55));
    u['uStar']!.value = starPresence(theme.dayFactor) * ATMOSPHERE.star.alpha * (1 - covered);
    rain.current = drawn === 'rain' ? 0.82 : 0;
    u['uRainColor']!.value.set(mixHex(tones.cloudDark, theme.sky[2], 0.38));
    birdBase.current = birdPresence(theme.dayFactor) * ATMOSPHERE.bird.alpha * (1 - covered * 0.8);

    storm.current = drawn === 'rain';
    cloudBase.current = u['uCloud']!.value;
  }, [theme, kit, drawn]);

  const clock = useRef(ATMOSPHERE.startTime);
  const drift = useRef(0);
  const birds = useRef(1);
  const storm = useRef(false);
  const rain = useRef(0);
  /** What the layer would be drawn at if the weather were not changing. */
  const cloudBase = useRef(0);

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
    cloudField(time, seed, aspect, drift.current, kit.clouds, kit.shapes, drawn);
    flockAt(time, seed, aspect, kit.flock);
    // Only in the rain, and only sometimes even then.
    if (storm.current) flashAt(time, seed, aspect, kit.flash);
    else kit.flash.strength = 0;
    // The campus catches it too; see `uFlash`.
    setFlash(kit.flash.strength);

    // Freezing a flock mid-sky would leave six birds pinned there for good, so
    // reduced motion lets them finish leaving instead, over a couple of
    // seconds: a flock that blinks out is its own kind of movement.
    birds.current += ((reduced ? 0 : 1) - birds.current) * Math.min(1, step / ATMOSPHERE.bird.settle);

    /*
     * Letting go, and gathering again.
     *
     * Out faster than in: a sky clears quicker than it closes over, and the
     * half you are waiting through should be the shorter one.
     */
    const wanted = drawn === weather ? 1 : 0;
    const rate = wanted === 1 ? 0.85 : 1.6;
    presence.current += (wanted - presence.current) * Math.min(1, step * rate * 2.2);
    if (wanted === 0 && presence.current < 0.02) setDrawn(weather);

    const u = kit.material.uniforms;
    u['uTime']!.value = time;
    u['uAspect']!.value = aspect;
    u['uCloud']!.value = cloudBase.current * presence.current;
    u['uRain']!.value = rain.current * presence.current;
    u['uBird']!.value = birdBase.current * birds.current;
    u['uFlash']!.value.set(kit.flash.x, kit.flash.y, kit.flash.strength);
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
