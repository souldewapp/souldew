// Builds build/icon.ico (Windows: app, installer and uninstaller icon) from build/icon.png (1024×1024).
// The macOS icon leaves a margin around the handheld (Apple's icon grid); Windows icons fill their square, so the
// margin is cropped first. Sizes 16–256 px: BMP entries with alpha up to 128 px (what every Windows tool reads),
// PNG for 256 px. Needs macOS (`sips` resizes); run it after changing the icon and commit build/icon.ico.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const build = fileURLToPath(new URL('../build/', import.meta.url));
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const CROP = 860; // of 1024: the handheld's body (824 px) plus a little air

/** Minimal PNG decoder for what sips writes: 8-bit RGBA (or RGB), not interlaced. → { width, height, rgba } */
function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('only 8-bit, non-interlaced PNGs');
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const v = line[x] + [0, a, b, (a + b) >> 1, paeth][filter];
      px[y * stride + x] = v & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = px[i * channels];
    rgba[i * 4 + 1] = px[i * channels + 1];
    rgba[i * 4 + 2] = px[i * channels + 2];
    rgba[i * 4 + 3] = channels === 4 ? px[i * channels + 3] : 255;
  }
  return { width, height, rgba };
}

/** An ICO image entry as a 32-bit BMP (BITMAPINFOHEADER, bottom-up BGRA, empty AND mask – the alpha decides). */
function bmpEntry({ width, height, rgba }) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8); // XOR image + AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = ((height - 1 - y) * width + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  const mask = Buffer.alloc(Math.ceil(width / 32) * 4 * height);
  return Buffer.concat([header, pixels, mask]);
}

const tmp = mkdtempSync(join(tmpdir(), 'souldew-ico-'));
try {
  const cropped = join(tmp, 'cropped.png');
  execFileSync('sips', ['-c', String(CROP), String(CROP), join(build, 'icon.png'), '--out', cropped], { stdio: 'ignore' });
  const images = SIZES.map((size) => {
    const file = join(tmp, `${size}.png`);
    execFileSync('sips', ['-z', String(size), String(size), cropped, '--out', file], { stdio: 'ignore' });
    const png = readFileSync(file);
    return { size, data: size >= 256 ? png : bmpEntry(decodePng(png)) };
  });
  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // icon
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    dir[e] = size >= 256 ? 0 : size; // 0 means 256
    dir[e + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  writeFileSync(join(build, 'icon.ico'), Buffer.concat([dir, ...images.map((x) => x.data)]));
  console.log(`build/icon.ico: ${SIZES.join(', ')} px (${offset} bytes)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
