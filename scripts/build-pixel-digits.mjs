// Builds web/assets/fonts/PixelDigits-<weight>.ttf: the digits 0–9 drawn on the same 5×7 pixel grid as
// Pixelify Sans, but with shapes that can't be mistaken for letters (Pixelify's "5" reads as "S").
// styles.css lists this face before Pixelify Sans with unicode-range U+0030-0039, so only digits use it.
// Run: node scripts/build-pixel-digits.mjs
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'assets', 'fonts');

const DIGITS = [
  ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
];

// Pixelify Sans (UPM 1000): ascent 920, descent 280, cap height ≈ 644 = 7 pixels of 92 units. Heavier
// weights keep the glyph box and grow the stroke, like Pixelify does. Advance = Pixelify's "5".
const WEIGHTS = { 400: { stroke: 92, adv: 586 }, 500: { stroke: 103, adv: 592 }, 600: { stroke: 114, adv: 597 }, 700: { stroke: 125, adv: 603 } };
const CAP = 644;
const ASC = 920;
const DESC = 280;

class Buf {
  constructor() { this.b = []; }
  u8(v) { this.b.push(v & 255); return this; }
  u16(v) { return this.u8(v >> 8).u8(v); }
  i16(v) { return this.u16(v < 0 ? v + 65536 : v); }
  u32(v) { return this.u16(Math.floor(v / 65536) & 0xffff).u16(v & 0xffff); }
  tag(s) { for (const c of s) this.u8(c.charCodeAt(0)); return this; }
  bytes(a) { for (const v of a) this.u8(v); return this; }
  pad() { while (this.b.length % 4) this.u8(0); return this; }
  get length() { return this.b.length; }
}

function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) sum = (sum + ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3])) >>> 0;
  return sum;
}

function build(weight) {
  const { stroke: s, adv } = WEIGHTS[weight];
  const q = (CAP - s) / 6; // pixel pitch: 7 rows end exactly at the cap height
  const ink = Math.round(4 * q + s);
  const lsb = Math.round((adv - ink) / 2);
  // one rectangle per horizontal run of pixels, clockwise (TrueType outer contours)
  const glyphs = [null, ...DIGITS.map((rows) => {
    const rects = [];
    rows.forEach((row, r) => {
      for (let c = 0; c < 5; c++) {
        if (row[c] !== '#') continue;
        let e = c;
        while (row[e + 1] === '#') e++;
        const top = Math.round(CAP - r * q);
        rects.push([lsb + Math.round(c * q), top - s, lsb + Math.round(e * q + s), top]);
        c = e;
      }
    });
    return rects;
  })];

  const glyf = new Buf();
  const loca = [];
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  let maxPts = 0;
  let maxCont = 0;
  for (const rects of glyphs) {
    loca.push(glyf.length);
    if (!rects) continue; // .notdef stays empty
    const xs = rects.flatMap((r) => [r[0], r[2]]);
    const ys = rects.flatMap((r) => [r[1], r[3]]);
    const gb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    bbox[0] = Math.min(bbox[0], gb[0]); bbox[1] = Math.min(bbox[1], gb[1]);
    bbox[2] = Math.max(bbox[2], gb[2]); bbox[3] = Math.max(bbox[3], gb[3]);
    maxPts = Math.max(maxPts, rects.length * 4);
    maxCont = Math.max(maxCont, rects.length);
    glyf.i16(rects.length).i16(gb[0]).i16(gb[1]).i16(gb[2]).i16(gb[3]);
    rects.forEach((_, i) => glyf.u16(i * 4 + 3));
    glyf.u16(0); // no instructions
    for (let i = 0; i < rects.length * 4; i++) glyf.u8(1); // on-curve, 16-bit deltas
    const pts = rects.flatMap(([x0, y0, x1, y1]) => [[x0, y0], [x0, y1], [x1, y1], [x1, y0]]);
    let px = 0;
    for (const [x] of pts) { glyf.i16(x - px); px = x; }
    let py = 0;
    for (const [, y] of pts) { glyf.i16(y - py); py = y; }
    glyf.pad();
  }
  loca.push(glyf.length);
  const n = glyphs.length;
  const lsbOf = (rects) => (rects ? Math.min(...rects.map((r) => r[0])) : 0);
  const advOf = (rects) => (rects ? adv : 500);

  const tables = {};
  tables.head = new Buf().u32(0x10000).u32(0x10000).u32(0).u32(0x5f0f3cf5).u16(0b11).u16(1000)
    .u32(0).u32(0xe3a0b000).u32(0).u32(0xe3a0b000) // created / modified: 2021-01-01
    .i16(bbox[0]).i16(bbox[1]).i16(bbox[2]).i16(bbox[3]).u16(weight >= 700 ? 1 : 0).u16(8).i16(2).i16(1).i16(0);
  tables.hhea = new Buf().u32(0x10000).i16(ASC).i16(-DESC).i16(0).u16(adv).i16(0).i16(Math.min(...glyphs.slice(1).map((g) => adv - Math.max(...g.map((r) => r[2])))))
    .i16(bbox[2]).i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(n);
  tables.hmtx = new Buf();
  for (const g of glyphs) tables.hmtx.u16(advOf(g)).i16(lsbOf(g));
  tables.maxp = new Buf().u32(0x10000).u16(n).u16(maxPts).u16(maxCont).u16(0).u16(0).u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);
  tables.loca = new Buf();
  for (const o of loca) tables.loca.u32(o);
  tables.glyf = glyf;
  // cmap: format 4, '0'–'9' → glyphs 1–10
  const sub = new Buf().u16(4).u16(32).u16(0).u16(4).u16(4).u16(1).u16(0)
    .u16(0x39).u16(0xffff).u16(0).u16(0x30).u16(0xffff).i16(1 - 0x30).i16(1).u16(0).u16(0);
  tables.cmap = new Buf().u16(0).u16(2).u16(0).u16(3).u32(20).u16(3).u16(1).u32(20).bytes(sub.b);
  const style = weight >= 700 ? 'Bold' : weight === 400 ? 'Regular' : weight === 500 ? 'Medium' : 'SemiBold';
  const names = ['', 'Pixel Digits', style, `PixelDigits-${style};1.0`, `Pixel Digits ${style}`, 'Version 1.0', `PixelDigits-${style}`];
  const recs = names.map((v, id) => [id, v]).filter(([, v]) => v);
  const strs = recs.map(([, v]) => { const b = []; for (const c of v) b.push(c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255); return b; });
  tables.name = new Buf().u16(0).u16(recs.length).u16(6 + recs.length * 12);
  let off = 0;
  recs.forEach(([id], i) => { tables.name.u16(3).u16(1).u16(0x409).u16(id).u16(strs[i].length).u16(off); off += strs[i].length; });
  for (const b of strs) tables.name.bytes(b);
  tables['OS/2'] = new Buf().u16(4).i16(adv).u16(weight).u16(5).u16(0)
    .i16(650).i16(600).i16(0).i16(75).i16(650).i16(600).i16(0).i16(350).i16(50).i16(300).i16(0)
    .bytes([2, 0, 0, 0, 0, 0, 0, 0, 0, 0]).u32(1).u32(0).u32(0).u32(0).tag('NONE')
    .u16((weight >= 700 ? 0x20 : 0x40) | 0x80).u16(0x30).u16(0x39).i16(ASC).i16(-DESC).i16(0).u16(ASC).u16(DESC)
    .u32(1).u32(0).i16(460).i16(CAP).u16(0).u16(0x20).u16(1);
  tables.post = new Buf().u32(0x30000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0);

  const tags = Object.keys(tables).sort();
  const font = new Buf().u32(0x10000).u16(tags.length);
  const es = Math.floor(Math.log2(tags.length));
  font.u16(16 * 2 ** es).u16(es).u16(tags.length * 16 - 16 * 2 ** es);
  let offset = 12 + tags.length * 16;
  const body = [];
  let headAt = 0;
  for (const tag of tags) {
    const data = tables[tag].b;
    if (tag === 'head') headAt = offset;
    const padded = [...data];
    while (padded.length % 4) padded.push(0);
    font.tag(tag).u32(checksum(padded)).u32(offset).u32(data.length);
    body.push(...padded);
    offset += padded.length;
  }
  font.bytes(body);
  const bytes = Uint8Array.from(font.b);
  const adj = (0xb1b0afba - checksum(bytes)) >>> 0;
  new DataView(bytes.buffer).setUint32(headAt + 8, adj);
  return bytes;
}

for (const w of Object.keys(WEIGHTS)) {
  const file = join(out, `PixelDigits-${w}.ttf`);
  writeFileSync(file, build(Number(w)));
  console.log('wrote', file);
}
