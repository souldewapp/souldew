// Tiny Nintendo 3DS files for tests: just the headers shared/ctr.mjs reads (NCSD / NCCH / CIA / 3DSX / Z3DS).

const w16 = (b, o, v) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
};
const w32 = (b, o, v) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
};
const w32be = (b, o, v) => {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
};
const ascii = (b, o, s) => {
  for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i);
};
/** title ID "0004000000055D00" → u64 little-endian at b[o] */
const tidLE = (b, o, tid) => {
  w32(b, o, parseInt(tid.slice(8), 16));
  w32(b, o + 4, parseInt(tid.slice(0, 8), 16));
};
const tidBE = (b, o, tid) => {
  w32be(b, o, parseInt(tid.slice(0, 8), 16));
  w32be(b, o + 4, parseInt(tid.slice(8), 16));
};

/** A 0x200-byte NCCH header. */
export function ncchHeader({ productCode = 'CTR-P-EKJA', titleId = '0004000000055D00', version = 0, encrypted = false } = {}) {
  const b = new Uint8Array(0x200);
  ascii(b, 0x100, 'NCCH');
  tidLE(b, 0x108, titleId);
  w16(b, 0x112, version);
  tidLE(b, 0x118, titleId);
  ascii(b, 0x150, productCode);
  b[0x18f] = encrypted ? 0 : 0x04;
  return b;
}

/** A cartridge image (.3ds/.cci): NCSD header, the game's NCCH at 0x4000 (or garbage there with `brokenPartition`). */
export function cci(opts = {}) {
  const b = new Uint8Array(0x4000 + 0x400);
  ascii(b, 0x100, 'NCSD');
  tidLE(b, 0x108, opts.titleId || '0004000000055D00');
  w32(b, 0x120, 0x4000 / 0x200);
  w32(b, 0x124, 2);
  if (!opts.brokenPartition) b.set(ncchHeader(opts), 0x4000);
  else b.fill(0x5a, 0x4000);
  return b;
}

const align = (n) => Math.ceil(n / 64) * 64;
/** A .cia with an RSA-2048-signed TMD; the first content is an NCCH (encrypted per `contentEncrypted`). */
export function cia({ titleId = '0004000000055E00', productCode = 'CTR-P-EK2A', version = 0x1450, contentEncrypted = false } = {}) {
  const certSize = 0xa00;
  const ticketSize = 0x350;
  const tmdSize = 0x140 + 0xc4 + 0x900 + 0x30;
  const certOff = align(0x2020);
  const ticketOff = certOff + align(certSize);
  const tmdOff = ticketOff + align(ticketSize);
  const contentOff = tmdOff + align(tmdSize);
  const b = new Uint8Array(contentOff + 0x200);
  w32(b, 0, 0x2020);
  w32(b, 0x08, certSize);
  w32(b, 0x0c, ticketSize);
  w32(b, 0x10, tmdSize);
  w32be(b, tmdOff, 0x10004); // RSA-2048 SHA-256
  const hdr = tmdOff + 0x140;
  tidBE(b, hdr + 0x4c, titleId);
  b[hdr + 0x9c] = version >> 8;
  b[hdr + 0x9d] = version & 0xff;
  b[hdr + 0x9f] = 1; // one content
  const chunk = hdr + 0xc4 + 0x900;
  b[chunk + 7] = contentEncrypted ? 1 : 0;
  // an encrypted content's bytes are random, not an NCCH
  if (contentEncrypted) b.fill(0x33, contentOff);
  else b.set(ncchHeader({ productCode, titleId }), contentOff);
  return b;
}

/** A homebrew .3dsx with an SMDH whose English title is `title`. */
export function threedsx(title = 'souldew test app') {
  const smdhOff = 0x100;
  const b = new Uint8Array(smdhOff + 0x36c0);
  ascii(b, 0, '3DSX');
  w16(b, 4, 0x2c);
  w32(b, 0x20, smdhOff);
  w32(b, 0x24, 0x36c0);
  ascii(b, smdhOff, 'SMDH');
  for (let i = 0; i < title.length; i++) w16(b, smdhOff + 8 + 0x200 + i * 2, title.charCodeAt(i)); // language 1 = English
  return b;
}

/** Azahar's compressed container (.zcci …): the 0x20-byte Z3DS header only. */
export function z3ds(underlying = 'NCSD') {
  const b = new Uint8Array(0x20);
  ascii(b, 0, 'Z3DS');
  ascii(b, 4, underlying);
  b[8] = 1;
  w16(b, 0x0a, 0x20);
  return b;
}

const utf16 = (s) => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) w16(b, i * 2, s.charCodeAt(i));
  return b;
};
const pad4 = (n) => (n + 3) & ~3;

/**
 * A RomFS level 3 (the files) holding `files` ({ 'a/0/1/3': bytes }): header, directory and file metadata, data – as
 * the 3DS lays it out (the hash tables are left empty: shared/live/ctrzones.mjs walks the tree).
 */
export function romfsLevel3(files) {
  const root = { name: '', dirs: new Map(), files: [] };
  for (const [path, data] of Object.entries(files)) {
    const parts = path.split('/');
    let d = root;
    for (const p of parts.slice(0, -1)) {
      if (!d.dirs.has(p)) d.dirs.set(p, { name: p, dirs: new Map(), files: [] });
      d = d.dirs.get(p);
    }
    d.files.push({ name: parts.at(-1), data });
  }
  // offsets: directories in breadth-first order, then files
  const dirList = [];
  const queue = [root];
  while (queue.length) {
    const d = queue.shift();
    dirList.push(d);
    queue.push(...d.dirs.values());
  }
  let o = 0;
  for (const d of dirList) {
    d.off = o;
    o += 0x18 + pad4(d.name.length * 2);
  }
  const dirLen = o;
  o = 0;
  let dataOff = 0;
  const fileList = dirList.flatMap((d) => d.files.map((f) => ({ ...f, parent: d })));
  for (const f of fileList) {
    f.off = o;
    o += 0x20 + pad4(f.name.length * 2);
    f.dataOff = dataOff;
    dataOff += (f.data.length + 15) & ~15;
  }
  const fileLen = o;
  const hdr = 0x28;
  const dirMeta = hdr;
  const fileMeta = dirMeta + dirLen;
  const data = (fileMeta + fileLen + 15) & ~15;
  const b = new Uint8Array(data + dataOff);
  w32(b, 0, 0x28);
  w32(b, 0x0c, dirMeta);
  w32(b, 0x10, dirLen);
  w32(b, 0x1c, fileMeta);
  w32(b, 0x20, fileLen);
  w32(b, 0x24, data);
  const NONE = 0xffffffff;
  for (const d of dirList) {
    const at = dirMeta + d.off;
    const kids = [...d.dirs.values()];
    w32(b, at + 0x04, NONE);
    w32(b, at + 0x08, kids.length ? kids[0].off : NONE);
    w32(b, at + 0x0c, d.files.length ? fileList.find((f) => f.parent === d).off : NONE);
    w32(b, at + 0x10, NONE);
    w32(b, at + 0x14, d.name.length * 2);
    b.set(utf16(d.name), at + 0x18);
  }
  for (const d of dirList) {
    const fs = fileList.filter((f) => f.parent === d);
    fs.forEach((f, i) => {
      const at = fileMeta + f.off;
      w32(b, at + 0x04, i + 1 < fs.length ? fs[i + 1].off : NONE);
      w32(b, at + 0x08, f.dataOff);
      w32(b, at + 0x10, f.data.length);
      w32(b, at + 0x18, NONE);
      w32(b, at + 0x1c, f.name.length * 2);
      b.set(utf16(f.name), at + 0x20);
      b.set(f.data, data + f.dataOff);
    });
  }
  // sibling links last: each directory wrote "none" as its own above
  for (const d of dirList) {
    const kids = [...d.dirs.values()];
    kids.forEach((k, i) => w32(b, dirMeta + k.off + 0x04, i + 1 < kids.length ? kids[i + 1].off : NONE));
  }
  return b;
}

/** A GARC archive of `files` (one sub-file each). */
export function garc(files) {
  const headerSize = 0x1c;
  const fato = 0x0c + files.length * 4;
  const fatb = 0x0c + files.length * 16;
  const dataOffset = headerSize + fato + fatb + 0x0c;
  let size = 0;
  const starts = files.map((f) => {
    const s = size;
    size += (f.length + 3) & ~3;
    return s;
  });
  const b = new Uint8Array(dataOffset + size);
  ascii(b, 0, 'CRAG');
  w32(b, 4, headerSize);
  w32(b, 0x10, dataOffset);
  ascii(b, headerSize, 'OTAF');
  w32(b, headerSize + 4, fato);
  const fb = headerSize + fato;
  ascii(b, fb, 'BTAF');
  w32(b, fb + 4, fatb);
  w32(b, fb + 8, files.length);
  files.forEach((f, i) => {
    const e = fb + 0x0c + i * 16;
    w32(b, e, 1);
    w32(b, e + 4, starts[i]);
    w32(b, e + 8, starts[i] + f.length);
    w32(b, e + 12, f.length);
    b.set(f, dataOffset + starts[i]);
  });
  ascii(b, fb + fatb, 'BMIF');
  return b;
}

/** LZ11 with literals only (what the reader must take as well as back references). */
export function lz11Literal(src) {
  const out = [0x11, src.length & 0xff, (src.length >> 8) & 0xff, (src.length >> 16) & 0xff];
  for (let i = 0; i < src.length; i += 8) {
    out.push(0);
    for (let k = i; k < Math.min(src.length, i + 8); k++) out.push(src[k]);
  }
  return Uint8Array.from(out);
}

/** A cartridge image whose game has an unencrypted RomFS holding `files`. */
export function cciWithRomfs(opts = {}, files = {}) {
  const l3 = romfsLevel3(files);
  const block = 0x1000;
  const masterHash = 0x20;
  const l3At = Math.ceil((0x60 + masterHash) / block) * block;
  const romfs = new Uint8Array(l3At + l3.length);
  ascii(romfs, 0, 'IVFC');
  w32(romfs, 0x08, masterHash);
  w32(romfs, 0x4c, 12); // level 3 block size 2^12
  romfs.set(l3, l3At);
  const ncchAt = 0x4000;
  const romfsAt = 0x200 * 4; // inside the NCCH, in media units
  const romfsUnits = Math.ceil(romfs.length / 0x200);
  const b = new Uint8Array(ncchAt + romfsAt + romfsUnits * 0x200);
  ascii(b, 0x100, 'NCSD');
  tidLE(b, 0x108, opts.titleId || '000400000011C400');
  w32(b, 0x120, ncchAt / 0x200);
  w32(b, 0x124, b.length / 0x200 - ncchAt / 0x200);
  b.set(ncchHeader({ productCode: 'CTR-P-ECRA', titleId: '000400000011C400', ...opts }), ncchAt);
  w32(b, ncchAt + 0x1b0, romfsAt / 0x200);
  w32(b, ncchAt + 0x1b4, romfsUnits);
  b.set(romfs, ncchAt + romfsAt);
  return b;
}
