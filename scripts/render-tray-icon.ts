/**
 * Renders the menu bar template icon into `resources/`.
 *
 * A macOS template image carries no colour: the system throws the RGB away and
 * tints the alpha channel for the current menu bar, light or dark. So the shape
 * has to read at 16px from coverage alone. This draws the app's "main agent"
 * silhouette — a small isometric cone — by supersampling its analytic outline,
 * and writes the PNGs by hand (zlib plus a CRC and a chunk writer) rather than
 * taking an image dependency for two files of a few hundred bytes.
 *
 *   node scripts/render-tray-icon.ts [--out resources] [--check]
 *
 * Every file is decoded again after it is written, and `--check` verifies the
 * ones already on disk without touching them: a template image that fails to
 * decode shows up as a blank menu bar item with nothing in the log to explain
 * it, which is a bad afternoon.
 *
 * Node 24 runs this with native type stripping, so the syntax here stays
 * erasable: no enums, no parameter properties, no dependencies and no imports
 * from `src/`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..');

/**
 * The cone, in fractions of the icon box, so 1x and 2x are the same drawing.
 * It sits slightly low: the base ellipse is the visual weight, and a menu bar
 * item reads better bottom-heavy.
 */
const CONE = { cx: 0.5, apexY: 0.1, baseY: 0.815, rx: 0.345, ry: 0.125 };

/** Where the silhouette's straight edges meet the base ellipse. */
const HEIGHT = CONE.baseY - CONE.apexY;
const TANGENT_Y = CONE.baseY - (CONE.ry * CONE.ry) / HEIGHT;
const TANGENT_X = CONE.rx * Math.sqrt(Math.max(0, 1 - (CONE.ry * CONE.ry) / (HEIGHT * HEIGHT)));

/** Coverage samples per axis. 8 is 64 per pixel: smooth, and instant at this size. */
const SAMPLES = 8;

const TARGETS = [
  { file: 'trayTemplate.png', size: 16 },
  { file: 'trayTemplate@2x.png', size: 32 },
];

// ---------------------------------------------------------------------------
// the shape
// ---------------------------------------------------------------------------

function insideCone(x: number, y: number): boolean {
  const dx = (x - CONE.cx) / CONE.rx;
  const dy = (y - CONE.baseY) / CONE.ry;
  if (dx * dx + dy * dy <= 1) return true;
  if (y < CONE.apexY || y > TANGENT_Y) return false;
  const halfWidth = (TANGENT_X * (y - CONE.apexY)) / (TANGENT_Y - CONE.apexY);
  return Math.abs(x - CONE.cx) <= halfWidth;
}

/** RGBA, black throughout: only the alpha channel survives into the menu bar. */
function render(size: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        const y = (py + (sy + 0.5) / SAMPLES) / size;
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) / size;
          if (insideCone(x, y)) hits++;
        }
      }
      pixels[(py * size + px) * 4 + 3] = Math.round((hits / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return pixels;
}

// ---------------------------------------------------------------------------
// png
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(size: number, pixels: Uint8Array): Buffer {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    // Filter 0 (none): the image is mostly transparent, so the filters buy nothing.
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface Decoded {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  inked: number;
}

/** Decodes the file the way Electron will have to, and fails loudly if it can't. */
function decodePng(file: string): Decoded {
  const bytes = readFileSync(file);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${file}: not a PNG`);

  let header: { width: number; height: number; bitDepth: number; colorType: number } | null = null;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const declared = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== declared) {
      throw new Error(`${file}: ${type} chunk failed its CRC`);
    }
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8] ?? 0,
        colorType: data[9] ?? 0,
      };
    }
    if (type === 'IDAT') idat.push(Buffer.from(data));
    offset += 12 + length;
    if (type === 'IEND') break;
  }

  if (!header) throw new Error(`${file}: no IHDR`);
  if (header.colorType !== 6 || header.bitDepth !== 8) {
    throw new Error(`${file}: expected 8-bit RGBA, got colour type ${header.colorType}/${header.bitDepth}`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const expected = (header.width * 4 + 1) * header.height;
  if (raw.length !== expected) throw new Error(`${file}: ${raw.length} raw bytes, expected ${expected}`);

  let inked = 0;
  for (let y = 0; y < header.height; y++) {
    const row = y * (header.width * 4 + 1) + 1;
    for (let x = 0; x < header.width; x++) if ((raw[row + x * 4 + 3] ?? 0) > 0) inked++;
  }
  if (inked === 0) throw new Error(`${file}: fully transparent, which is a blank menu bar item`);

  return { ...header, inked };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const outArg = args.indexOf('--out');
  const outDir = join(REPO_ROOT, outArg >= 0 ? (args[outArg + 1] ?? 'resources') : 'resources');

  if (!check) mkdirSync(outDir, { recursive: true });

  for (const target of TARGETS) {
    const path = join(outDir, target.file);
    if (!check) writeFileSync(path, encodePng(target.size, render(target.size)));
    const png = decodePng(path);
    if (png.width !== target.size || png.height !== target.size) {
      throw new Error(`${path}: decoded ${png.width}x${png.height}, expected ${target.size}x${target.size}`);
    }
    console.log(
      `${check ? 'ok   ' : 'wrote'} ${relative(REPO_ROOT, path)} — ${png.width}x${png.height} rgba, ${png.inked} px of ink`,
    );
  }
}

const invokedDirectly = process.argv[1] ? process.argv[1].endsWith('render-tray-icon.ts') : false;
if (invokedDirectly) main();
