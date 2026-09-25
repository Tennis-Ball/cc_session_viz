#!/usr/bin/env node
/**
 * Draws the app icon and packs it into `resources/icon.icns`.
 *
 * The icon is generated rather than checked in as a binary so it can be edited
 * the way everything else in the office is: by changing numbers and re-running.
 * Node built-ins only — a PNG is a handful of chunks and a deflate stream, and
 * an image library is not worth the dependency for one square.
 *
 *   node scripts/render-icon.ts
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'resources');
const ICONSET = join(OUT, 'icon.iconset');

/** Supersampling. The whole image is one analytic composite, so this is cheap. */
const SS = 3;

type Rgb = [number, number, number];

const SKY_TOP: Rgb = [201, 196, 238]; // the Monument theme's dusk
const SKY_BOTTOM: Rgb = [255, 210, 196];
const PLATFORM_TOP: Rgb = [251, 235, 220];
const PLATFORM_SIDE: Rgb = [181, 128, 111];
const FIGURE_TOP: Rgb = [255, 179, 158];
const FIGURE_BOTTOM: Rgb = [242, 112, 90];

/**
 * One pixel of the icon, in unit coordinates (0–1 across the square).
 *
 * Composited back to front: sky, platform side, platform top, contact shadow,
 * figure. Everything is an analytic shape, so there is no geometry to build and
 * the same function renders every size.
 */
function shade(x: number, y: number): [Rgb, number] {
  // The rounded-square mask macOS expects, as a superellipse.
  const alpha = squircle(x, y, 0.5, 0.5, 0.415, 4.6);
  if (alpha <= 0) return [[0, 0, 0], 0];

  let colour = lerp3(SKY_BOTTOM, SKY_TOP, smoothstep(0.15, 0.95, 1 - y));

  // Platform: an isometric diamond with a slab of side below it.
  const cx = 0.5;
  const cy = 0.615;
  const halfW = 0.3;
  const halfH = 0.15;
  const depth = 0.075;

  const side = diamond(x, y - depth, cx, cy, halfW, halfH) && y > cy - halfH;
  if (side) colour = PLATFORM_SIDE;
  if (diamond(x, y, cx, cy, halfW, halfH)) {
    // A touch of shading across the top face keeps it from reading as a sticker.
    const across = (x - (cx - halfW)) / (2 * halfW);
    colour = lerp3(PLATFORM_TOP, mix3(PLATFORM_TOP, PLATFORM_SIDE, 0.28), across);
  }

  // Contact shadow, on the platform only.
  const baseY = cy - 0.035;
  if (diamond(x, y, cx, cy, halfW, halfH)) {
    const shadow = ellipse(x, y, cx + 0.015, baseY + 0.012, 0.115, 0.055);
    if (shadow > 0) colour = mix3(colour, PLATFORM_SIDE, 0.3 * shadow);
  }

  // The figure: a cone with a ball head, which is what a main agent looks like.
  const apexY = baseY - 0.235;
  const cone = coneCoverage(x, y, cx, baseY, apexY, 0.105, 0.05);
  const head = ellipse(x, y, cx, apexY - 0.052, 0.058, 0.058);
  const figure = Math.max(cone, head);
  if (figure > 0) {
    const t = clamp01((y - (apexY - 0.11)) / (baseY - apexY + 0.11));
    colour = mix3(colour, lerp3(FIGURE_TOP, FIGURE_BOTTOM, t), figure);
  }

  return [colour, alpha];
}

function render(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SS);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [colour, alpha] = shade(
            (px * SS + sx + 0.5) * step,
            (py * SS + sy + 0.5) * step,
          );
          r += colour[0] * alpha;
          g += colour[1] * alpha;
          b += colour[2] * alpha;
          a += alpha;
        }
      }
      const samples = SS * SS;
      const offset = (py * size + px) * 4;
      // Straight alpha: divide the premultiplied sum back out.
      pixels[offset] = a > 0 ? Math.round(r / a) : 0;
      pixels[offset + 1] = a > 0 ? Math.round(g / a) : 0;
      pixels[offset + 2] = a > 0 ? Math.round(b / a) : 0;
      pixels[offset + 3] = Math.round((a / samples) * 255);
    }
  }
  return encodePng(pixels, size, size);
}

// ---------- shapes ----------

function squircle(x: number, y: number, cx: number, cy: number, radius: number, power: number): number {
  const d = Math.pow(Math.abs((x - cx) / radius), power) + Math.pow(Math.abs((y - cy) / radius), power);
  return d <= 1 ? 1 : 0;
}

function diamond(x: number, y: number, cx: number, cy: number, halfW: number, halfH: number): boolean {
  return Math.abs(x - cx) / halfW + Math.abs(y - cy) / halfH <= 1;
}

function ellipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number): number {
  const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
  return d <= 1 ? 1 : 0;
}

/** A cone seen from the side: a triangle capped by half of its base ellipse. */
function coneCoverage(
  x: number,
  y: number,
  cx: number,
  baseY: number,
  apexY: number,
  halfW: number,
  baseRy: number,
): number {
  if (y > baseY + baseRy || y < apexY) return 0;
  if (y > baseY) return ellipse(x, y, cx, baseY, halfW, baseRy);
  const t = (y - apexY) / (baseY - apexY);
  return Math.abs(x - cx) <= halfW * t ? 1 : 0;
}

// ---------- colour ----------

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function lerp3(a: Rgb, b: Rgb, t: number): Rgb {
  return mix3(a, b, clamp01(t));
}

function mix3(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// ---------- PNG ----------

function encodePng(pixels: Buffer, width: number, height: number): Buffer {
  // One filter byte (0 = none) in front of each scanline.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- main ----------

const SIZES: [string, number][] = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

mkdirSync(ICONSET, { recursive: true });
for (const [name, size] of SIZES) {
  writeFileSync(join(ICONSET, name), render(size));
}
// A 512 alongside it, for anywhere that wants a plain PNG.
writeFileSync(join(OUT, 'icon.png'), render(512));

try {
  execFileSync('iconutil', ['-c', 'icns', ICONSET, '-o', join(OUT, 'icon.icns')]);
  rmSync(ICONSET, { recursive: true, force: true });
  console.log('wrote resources/icon.icns and resources/icon.png');
} catch (error) {
  console.error('iconutil failed; the .iconset is left in place at', ICONSET);
  throw error;
}
