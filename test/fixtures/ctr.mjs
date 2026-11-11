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
