import type { WebGLRenderer } from 'three';

/**
 * What the screen actually did, frame by frame.
 *
 * The flashing in the office has now survived three fixes that were each
 * reasoned from the outside — camera easing, an idle sway, geometry rebuilds —
 * and the reason is that every one of those measurements was taken with
 * `capturePage()`, which asks for a *fresh* frame. A fresh frame is exactly the
 * thing that is not flashing. What flashes is the sequence, so the sequence is
 * what has to be recorded, from inside, off the real framebuffer, without
 * asking for anything to be redrawn.
 *
 * So: wrap `gl.render`, and once the renderer has finished a frame, read the
 * default framebuffer back and reduce it to a small grid. Coarse is fine —
 * flashing is not a subtle effect, and anything too small to survive the
 * downsample is too small to be what he is seeing.
 *
 * The obvious way to do that is `blitFramebuffer` into a small texture, which
 * is what this did first, and it silently returned black for every frame of a
 * whole run — the canvas is created with `antialias: true`, so the default
 * framebuffer is multisampled, and WebGL2 rejects a blit out of a multisampled
 * buffer that either scales or filters. The read cost a diagnostic that said
 * the picture was perfectly steady, which is exactly the answer a broken probe
 * gives. Hence `mean`: every record carries the average colour it sampled, so
 * an instrument that is looking at nothing says so instead of reporting calm.
 *
 * `readPixels` on the default framebuffer resolves the samples implicitly and
 * is allowed. It is a full-resolution read and a GPU sync, so it is not free —
 * it perturbs frame pacing, and pacing is therefore read from the unperturbed
 * render callback timing rather than from the read.
 *
 * Opt-in, and only ever mounted behind `?probe=1`.
 */

const GRID_WIDTH = 160;
const GRID_HEIGHT = 100;
/** Per-channel difference that counts as a changed pixel, out of 255. */
const THRESHOLD = 6;

export interface FrameRecord {
  /** Milliseconds since the recording started. */
  t: number;
  /** Cells that differ from the previous frame, out of GRID_WIDTH * GRID_HEIGHT. */
  changed: number;
  /**
   * Cells that differ from the frame *before* the previous one — the tell for
   * alternation. A figure walking changes steadily, so it differs from both.
   * Something toggling between two states returns to where it was, so it
   * differs from the previous frame and matches the one before it: `changed`
   * high, `alternating` near zero.
   */
  sameAsTwoAgo: number;
  /** Bounding box of the change, in grid cells: [x0, y0, x1, y1]. */
  box: [number, number, number, number] | null;
  /** Mean signed luminance change, so a whole-screen brighten/darken shows up. */
  luma: number;
  /** Mean colour of the whole grid. Reads the instrument itself: a probe that
   *  samples an empty buffer reports a perfectly steady picture. */
  mean: [number, number, number];
  /**
   * Pixels that changed at the canvas's real resolution, and the canvas size
   * they are out of.
   *
   * The grid above is a twelve-times downsample, which is blind to exactly the
   * thing flat-shaded geometry does when it buzzes: an antialiased silhouette
   * shifting by a fraction of a pixel rewrites a one-pixel-wide line along
   * every edge in the office, and averaging that into 7x8 blocks erases it.
   * Reported separately, because "eleven of sixteen thousand cells" and "forty
   * thousand of two million pixels" are the same frame described as calm and as
   * a mess.
   */
  pixels: number;
  area: [number, number];
}

export interface FlickerProbe {
  /**
   * Records the next `frames` rendered frames and resolves with them.
   *
   * `light` skips the pixel work and records only when each frame was drawn.
   * Reading four point nine million pixels and histogramming them costs about
   * eighteen milliseconds, which is more than a frame: measuring the content and
   * measuring the pacing at the same time gives an honest answer to neither.
   */
  record(frames: number, light?: boolean): Promise<FrameRecord[]>;
  /**
   * How often each part of the picture changed, as a GRID_WIDTH x GRID_HEIGHT
   * map accumulated at full resolution over the last recording.
   *
   * This is the question that matters and the one a single frame cannot answer.
   * Change spread thinly over every silhouette in the office is the whole scene
   * moving by a sub-pixel amount; change pooled in a few places is figures
   * walking, which is what is supposed to happen.
   */
  heat(): number[];
  dispose(): void;
}

export function attachFlickerProbe(renderer: WebGLRenderer): FlickerProbe {
  const gl = renderer.getContext() as WebGL2RenderingContext;

  let full = new Uint8Array(0);
  let fullPrevious = new Uint8Array(0);
  const heat = new Array<number>(GRID_WIDTH * GRID_HEIGHT).fill(0);
  const pixels = new Uint8Array(GRID_WIDTH * GRID_HEIGHT * 4);
  let previous: Uint8Array | null = null;
  let twoAgo: Uint8Array | null = null;

  let wanted = 0;
  let light = false;
  let records: FrameRecord[] = [];
  let started = 0;
  let resolve: ((records: FrameRecord[]) => void) | null = null;

  const original = renderer.render.bind(renderer);

  renderer.render = function patched(scene, camera): void {
    const before = performance.now();
    original(scene, camera);
    if (wanted <= 0) return;
    // Timed before the read, so the cost of reading never lands in the pacing.
    const at = before - started;

    if (light) {
      records.push({ t: at, changed: 0, sameAsTwoAgo: 0, box: null, luma: 0, mean: [0, 0, 0], pixels: 0, area: [0, 0] });
      wanted -= 1;
      if (wanted === 0 && resolve) {
        const done = records;
        resolve(done);
        resolve = null;
        records = [];
      }
      return;
    }

    const canvas = gl.canvas as HTMLCanvasElement;
    const width = canvas.width;
    const height = canvas.height;
    if (full.length !== width * height * 4) full = new Uint8Array(width * height * 4);

    // The frame that was just drawn is in the default framebuffer; three.js may
    // have left a render target bound, so say so explicitly.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, full);
    reduce(full, width, height, pixels);

    // Full resolution, and where: one pass over the real frame, counting
    // changed pixels and dropping each into its grid cell.
    let moved = 0;
    if (fullPrevious.length === full.length) {
      for (let y = 0; y < height; y += 1) {
        const row = y * width;
        const cellRow = Math.min(GRID_HEIGHT - 1, Math.floor(((height - 1 - y) / height) * GRID_HEIGHT)) * GRID_WIDTH;
        for (let x = 0; x < width; x += 1) {
          const at4 = (row + x) * 4;
          if (
            Math.abs((full[at4] ?? 0) - (fullPrevious[at4] ?? 0)) <= THRESHOLD &&
            Math.abs((full[at4 + 1] ?? 0) - (fullPrevious[at4 + 1] ?? 0)) <= THRESHOLD &&
            Math.abs((full[at4 + 2] ?? 0) - (fullPrevious[at4 + 2] ?? 0)) <= THRESHOLD
          ) {
            continue;
          }
          moved += 1;
          const cell = cellRow + Math.min(GRID_WIDTH - 1, Math.floor((x / width) * GRID_WIDTH));
          heat[cell] = (heat[cell] ?? 0) + 1;
        }
      }
    }
    if (fullPrevious.length !== full.length) fullPrevious = new Uint8Array(full.length);
    fullPrevious.set(full);

    const record = compare(pixels, previous, twoAgo, at);
    record.pixels = moved;
    record.area = [width, height];
    records.push(record);

    twoAgo = previous;
    previous = pixels.slice();

    wanted -= 1;
    if (wanted === 0 && resolve) {
      const done = records;
      resolve(done);
      resolve = null;
      records = [];
    }
  };

  return {
    record(frames: number, lightweight = false): Promise<FrameRecord[]> {
      light = lightweight;
      previous = null;
      twoAgo = null;
      records = [];
      started = performance.now();
      heat.fill(0);
      fullPrevious = new Uint8Array(0);
      wanted = frames;
      return new Promise((settle) => {
        resolve = settle;
      });
    },
    heat(): number[] {
      return [...heat];
    },
    dispose(): void {
      renderer.render = original;
    },
  };
}

/** Box-filters the full frame down to the grid, one sample per cell. */
function reduce(full: Uint8Array, width: number, height: number, out: Uint8Array): void {
  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    // readPixels is bottom-up; the flip only matters for reading the boxes.
    const sourceY = Math.min(height - 1, Math.floor(((GRID_HEIGHT - 1 - y) / GRID_HEIGHT) * height));
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x / GRID_WIDTH) * width));
      const from = (sourceY * width + sourceX) * 4;
      const to = (y * GRID_WIDTH + x) * 4;
      out[to] = full[from] ?? 0;
      out[to + 1] = full[from + 1] ?? 0;
      out[to + 2] = full[from + 2] ?? 0;
      out[to + 3] = 255;
    }
  }
}

function compare(
  current: Uint8Array,
  previous: Uint8Array | null,
  twoAgo: Uint8Array | null,
  t: number,
): FrameRecord {
  const mean = meanOf(current);
  if (!previous) return { t, changed: 0, sameAsTwoAgo: 0, box: null, luma: 0, mean, pixels: 0, area: [0, 0] };

  let changed = 0;
  let sameAsTwoAgo = 0;
  let luma = 0;
  let x0 = GRID_WIDTH;
  let y0 = GRID_HEIGHT;
  let x1 = -1;
  let y1 = -1;

  for (let index = 0; index < GRID_WIDTH * GRID_HEIGHT; index += 1) {
    const at = index * 4;
    const dr = (current[at] ?? 0) - (previous[at] ?? 0);
    const dg = (current[at + 1] ?? 0) - (previous[at + 1] ?? 0);
    const db = (current[at + 2] ?? 0) - (previous[at + 2] ?? 0);
    if (Math.abs(dr) <= THRESHOLD && Math.abs(dg) <= THRESHOLD && Math.abs(db) <= THRESHOLD) continue;

    changed += 1;
    luma += dr * 0.299 + dg * 0.587 + db * 0.114;

    const x = index % GRID_WIDTH;
    const y = Math.floor(index / GRID_WIDTH);
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;

    if (twoAgo) {
      const er = (current[at] ?? 0) - (twoAgo[at] ?? 0);
      const eg = (current[at + 1] ?? 0) - (twoAgo[at + 1] ?? 0);
      const eb = (current[at + 2] ?? 0) - (twoAgo[at + 2] ?? 0);
      if (Math.abs(er) <= THRESHOLD && Math.abs(eg) <= THRESHOLD && Math.abs(eb) <= THRESHOLD) {
        sameAsTwoAgo += 1;
      }
    }
  }

  return {
    t,
    changed,
    sameAsTwoAgo,
    box: x1 < 0 ? null : [x0, y0, x1, y1],
    luma: changed ? luma / changed : 0,
    mean,
    pixels: 0,
    area: [0, 0],
  };
}

function meanOf(pixels: Uint8Array): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  const cells = GRID_WIDTH * GRID_HEIGHT;
  for (let index = 0; index < cells; index += 1) {
    r += pixels[index * 4] ?? 0;
    g += pixels[index * 4 + 1] ?? 0;
    b += pixels[index * 4 + 2] ?? 0;
  }
  return [Math.round(r / cells), Math.round(g / cells), Math.round(b / cells)];
}
