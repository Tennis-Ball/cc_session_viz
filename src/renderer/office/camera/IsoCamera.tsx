import { useCallback, useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import { setToneBasis } from '../material/facet';
import { usePrefs } from '../../store/prefs';
import { cameraState } from './cameraState';
import { fitView, type Point } from './fit';

/**
 * Orbit at a fixed distance, the way imisstheoffice does it.
 *
 * Dragging swings the camera around the office; zoom is a separate gesture and
 * the camera never moves closer. Elevation is clamped so the isometric read
 * survives every angle, and after a few idle seconds the slow drift resumes so
 * the scene is never quite still.
 */

/*
 * Polar is measured from straight up, so a *larger* number is a lower, more
 * side-on camera. The old comments here had it backwards, which is part of how
 * the range ended up where it did.
 *
 * The default sat at 0.955 — about 35° above the horizon — and read as looking
 * down on a model rather than standing in a place. Monument Valley's own angle
 * is lower than people remember. The range now reaches a genuinely side-on
 * 18°, where the terraces overlap and the campus has depth; the top is held at
 * 40° above the horizon, because past that the platforms flatten into a plan
 * and the architecture stops having a silhouette at all.
 */
const MIN_POLAR = 0.87; // ~40° above the horizon
const MAX_POLAR = 1.26; // ~18°, nearly side-on
const DEFAULT_POLAR = 1.03; // ~31°
const DEFAULT_AZIMUTH = Math.PI * 0.25;
const DISTANCE = 60;
const MIN_ZOOM = 8;
const MAX_ZOOM = 120;
/** How far the wheel can take you either side of the fitted framing. */
const MIN_USER_ZOOM = 0.5;
const MAX_USER_ZOOM = 6;
/**
 * Below these, the camera is *there*: it snaps and stops.
 *
 * Both are well under a pixel at this projection, so the snap itself is never
 * seen — what is seen is everything the office is made of finally holding
 * still.
 */
const PIVOT_SNAP = 0.004;
const ZOOM_SNAP = 0.0004;

interface IsoCameraProps {
  /** Everything that has to stay in frame, in world units. */
  frame: Point[];
}

export function IsoCamera({ frame }: IsoCameraProps): null {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const size = useThree((state) => state.size);
  const invalidate = useThree((state) => state.invalidate);

  const camera0 = usePrefs((s) => s.prefs.camera);
  const prefsLoaded = usePrefs((s) => s.loaded);
  const savePrefs = usePrefs((s) => s.update);

  const azimuth = useRef(DEFAULT_AZIMUTH);
  const polar = useRef(DEFAULT_POLAR);
  const userZoom = useRef(1);
  const hydrated = useRef(false);
  const velocity = useRef({ azimuth: 0, polar: 0 });
  const lastInput = useRef(0);
  const focus = useRef(new Vector3());
  const framed = useRef(false);

  // The office is always framed: the camera orbits at a fixed distance, so the
  // only way to keep it filling the window at every angle is to re-fit the
  // orthographic zoom and pivot as the angle changes. Both are damped, so this
  // reads as the camera holding the office rather than the office breathing.
  useEffect(() => {
    invalidate();
  }, [frame, invalidate]);

  // Restore the angle you left the office at, once, before the first frame.
  useEffect(() => {
    if (hydrated.current || !prefsLoaded) return;
    hydrated.current = true;
    azimuth.current = camera0.azimuth;
    polar.current = clamp(camera0.polar, MIN_POLAR, MAX_POLAR);
    userZoom.current = clamp(camera0.zoom, MIN_USER_ZOOM, MAX_USER_ZOOM);
    invalidate();
  }, [prefsLoaded, camera0, invalidate]);

  // Written back a beat after you stop moving: the orbit changes every frame
  // while dragging, and none of those intermediate angles are worth a write.
  const remember = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSave = useCallback((): void => {
    if (remember.current) clearTimeout(remember.current);
    remember.current = setTimeout(() => {
      savePrefs({
        camera: { azimuth: azimuth.current, polar: polar.current, zoom: userZoom.current },
      });
    }, 600);
  }, [savePrefs]);

  useEffect(() => {
    const element = gl.domElement;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      element.setPointerCapture(event.pointerId);
      lastInput.current = performance.now();
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      azimuth.current -= dx * 0.006;
      polar.current = clamp(polar.current - dy * 0.004, MIN_POLAR, MAX_POLAR);
      velocity.current = { azimuth: -dx * 0.0004, polar: 0 };
      lastInput.current = performance.now();
      invalidate();
    };

    const onPointerUp = (event: PointerEvent): void => {
      dragging = false;
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      scheduleSave();
    };

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      // Trackpad pinch arrives as ctrl+wheel; both gestures zoom, nothing pans
      // the camera out of its orbit.
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      userZoom.current = clamp(userZoom.current * factor, MIN_USER_ZOOM, MAX_USER_ZOOM);
      lastInput.current = performance.now();
      invalidate();
      scheduleSave();
    };

    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey) return;
      if (event.key === '[') azimuth.current += Math.PI / 4;
      else if (event.key === ']') azimuth.current -= Math.PI / 4;
      else if (event.key === '0') {
        azimuth.current = DEFAULT_AZIMUTH;
        polar.current = DEFAULT_POLAR;
        userZoom.current = 1;
      } else return;
      lastInput.current = performance.now();
      invalidate();
      scheduleSave();
    };

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);

    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      if (remember.current) clearTimeout(remember.current);
    };
  }, [gl, invalidate, scheduleSave]);

  useFrame((state, delta) => {
    // Inertia, then the idle drift once the user has let go for a while.
    if (Math.abs(velocity.current.azimuth) > 0.00001) {
      azimuth.current += velocity.current.azimuth;
      velocity.current.azimuth *= 0.92;
    }
    const a = azimuth.current;
    const p = polar.current;
    /*
     * Fitted at the angle the camera is actually at.
     *
     * The margin has to grow as the camera drops. Seen from side-on the campus
     * is shallow on screen but its towers are at their tallest, so the fit is
     * decided almost entirely by the two or three highest pieces — and with a
     * fill of 0.96 the tops of them sat against the edge of the window. There
     * is no cost to the extra room at a low angle: the office is narrow there
     * anyway.
     */
    const lowness = clamp((p - MIN_POLAR) / (MAX_POLAR - MIN_POLAR), 0, 1);
    const view = fitView(frame, azimuth.current, p, size, 0.95 - 0.09 * lowness);

    /**
     * The pivot eases toward the fit — and then *stops*.
     *
     * Stopping is the whole point, and leaving it out is the rest of the
     * flashing. An exponential ease never arrives: each frame it covers a
     * fraction of what is left, so the camera keeps moving by smaller and
     * smaller amounts for ever. Every one of those amounts is a fraction of a
     * pixel, which against flat-shaded geometry is exactly the sub-pixel crawl
     * that reads as the whole picture buzzing — the same failure the idle sway
     * caused, arriving by a different route and outliving the fix for it.
     *
     * So: ease while it matters, snap when it does not, and once snapped stop
     * touching the camera at all.
     */
    const ease = framed.current ? Math.min(1, delta * 3.5) : 1;
    framed.current = true;
    const wanted = view.centre;
    const gap = Math.max(
      Math.abs(wanted[0] - focus.current.x),
      Math.abs(wanted[1] - focus.current.y),
      Math.abs(wanted[2] - focus.current.z),
    );
    if (gap > PIVOT_SNAP) {
      focus.current.x += (wanted[0] - focus.current.x) * ease;
      focus.current.y += (wanted[1] - focus.current.y) * ease;
      focus.current.z += (wanted[2] - focus.current.z) * ease;
    } else if (gap > 0) {
      focus.current.set(wanted[0], wanted[1], wanted[2]);
    }

    const radius = DISTANCE * Math.sin(p);

    camera.position.set(
      focus.current.x + Math.sin(a) * radius,
      focus.current.y + DISTANCE * Math.cos(p),
      focus.current.z + Math.cos(a) * radius,
    );
    camera.lookAt(focus.current);

    // Zoom lags further behind than the pivot: the fit is a little tighter at
    // some angles than others, and a slow catch-up turns that into a drift you
    // never notice instead of a pulse you do.
    const target = clamp(view.zoom * userZoom.current, MIN_ZOOM, MAX_ZOOM);
    // Same rule as the pivot: ease while it is worth easing, then land exactly
    // on the number. Stopping *near* it left the image in a permanent, very
    // slightly wrong scale, and every reframe started the crawl again.
    if ('zoom' in camera && Math.abs(camera.zoom - target) > ZOOM_SNAP) {
      camera.zoom += (target - camera.zoom) * (framed.current ? Math.min(1, delta * 1.8) : 1);
      camera.updateProjectionMatrix();
    }

    // The tone basis rides with the camera, so no angle is ever the "dark side".
    setToneBasis(a);
    cameraState.azimuth = a;
    cameraState.polar = p;
    cameraState.zoom = camera.zoom;
    cameraState.reach = userZoom.current;
  });

  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
