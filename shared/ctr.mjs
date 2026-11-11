// Nintendo 3DS game files: what a file is and which game it holds, read from a few header bytes only (3DS games are
// 1–4 GB – nothing here reads the whole file). `readAt(offset, length)` returns the bytes there (a Uint8Array,
// shorter at the end of the file, or null).
//
//   .3ds / .cci  NCSD: a cartridge image, partition 0 is the game's NCCH
//   .cxi         NCCH: one partition on its own
//   .cia         CTR Importable Archive: installed into Azahar's system memory (File › Install CIA), not started from
//                the file. The title ID comes from its TMD, the product code from the first content if that isn't
//                encrypted
//   .3dsx        homebrew, optionally with an SMDH (icon + names)
//   .zcci .zcxi .z3dsx .zcia   Azahar's compressed variants (Zstandard, "Z3DS") – recognised by the name only
//
// Product codes look like "CTR-P-EKJA": the last four letters are the game code ("EKJA" = Pokémon X). Title IDs are
// 16 hex digits ("0004000000055D00"); games start with 00040000, updates with 0004000E, DLC with 0004008C.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const hex8 = (n) => n.toString(16).toUpperCase().padStart(8, '0');
/** u64 little-endian as 16 hex digits (title IDs don't fit a JS number exactly). */
const id64 = (b, o) => hex8(u32(b, o + 4)) + hex8(u32(b, o));
const id64be = (b, o) => hex8(u32be(b, o)) + hex8(u32be(b, o + 4));

function ascii(b, a, len) {
  let s = '';
  for (let i = a; i < a + len && i < b.length; i++) {
    const c = b[i];
    if (c === 0) break;
    if (c < 0x20 || c > 0x7e) return '';
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/** 3DS file extensions Azahar starts directly, plus .cia (installed first). */
export const CTR_EXTENSIONS = ['3ds', 'cci', 'cxi', 'cia', '3dsx', 'zcci', 'zcxi', 'z3dsx', 'zcia'];
/** Started by Azahar from the file (a .cia is installed in Azahar instead). */
export const CTR_BOOTABLE = ['3ds', 'cci', 'cxi', '3dsx', 'zcci', 'zcxi', 'z3dsx'];

/** The four-letter game code of a product code ("CTR-P-EKJA" → "EKJA"), or ''. */
export function gameCodeOf(productCode) {
  const m = /^(?:CTR|KTR)-[A-Z]-([A-Z0-9]{4})$/.exec(String(productCode || '').trim().toUpperCase());
  return m ? m[1] : '';
}

/** What a title ID stands for: 'game', 'update', 'dlc', 'system' or 'other'. */
export function titleKind(titleId) {
  const hi = String(titleId || '').toUpperCase().slice(0, 8);
  if (hi === '00040000') return 'game';
  if (hi === '0004000E') return 'update';
  if (hi === '0004008C') return 'dlc';
  if (/^000400(10|30|1B|9B|DB)$/.test(hi)) return 'system';
  return 'other';
}

/** NCCH header (0x200 bytes at `b[o]`): product code, program ID, version, whether its contents are encrypted. */
function ncch(b, o = 0) {
  if (!b || b.length < o + 0x200 || tag(b, o + 0x100) !== 'NCCH') return null;
  const productCode = ascii(b, o + 0x150, 16);
  const flags7 = b[o + 0x18f];
  return {
    productCode,
    code: gameCodeOf(productCode),
    titleId: id64(b, o + 0x118),
    version: u16(b, o + 0x112),
    encrypted: !(flags7 & 0x04), // flag "NoCrypto"
  };
}

/** SMDH (homebrew / game icon file): the English short title, else the first one set. */
export function smdhTitle(b) {
  if (!b || b.length < 0x2008 || tag(b, 0) !== 'SMDH') return '';
  const title = (lang) => {
    let s = '';
    for (let i = 0; i < 0x40; i++) {
      const c = u16(b, 8 + lang * 0x200 + i * 2);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return [...s].map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? ' ' : ch)).join('').trim();
  };
  for (const lang of [1, 0, 2, 3, 4, 5]) {
    const s = title(lang);
    if (s) return s;
  }
  return '';
}

const align = (n, a) => Math.ceil(n / a) * a;
/** Size of a signature block by its type (TMD / ticket), signature and padding included. */
function sigBlock(type) {
  switch (type) {
    case 0x10000: case 0x10003: return 0x200 + 0x3c + 4;
    case 0x10001: case 0x10004: return 0x100 + 0x3c + 4;
    case 0x10002: case 0x10005: return 0x3c + 0x40 + 4;
    default: return 0;
  }
}

/**
 * Identify a 3DS file. `ext` is the file extension (lower case, no dot). Returns
 * { system: '3ds', format, title, code, productCode, titleId, kind, version, encrypted } – fields it can't read are
 * '' / null – or null when the bytes are no 3DS file of that kind. Never throws.
 */
export function identifyCtr(readAt, ext = '') {
  ext = String(ext).toLowerCase().replace(/^\./, '');
  try {
    if (/^z/.test(ext) && CTR_EXTENSIONS.includes(ext)) {
      // Azahar's Z3DS container: "Z3DS" + the underlying format's magic; the content itself is compressed
      const h = readAt(0, 8);
      if (!h || h.length < 8 || tag(h, 0) !== 'Z3DS') return null;
      return { system: '3ds', format: ext, title: '', code: '', productCode: '', titleId: null, kind: null, version: null, encrypted: false, compressed: true };
    }
    if (ext === '3dsx') {
      const h = readAt(0, 0x2c);
      if (!h || h.length < 0x20 || tag(h, 0) !== '3DSX') return null;
      let title = '';
      if (u16(h, 4) > 0x20 && h.length >= 0x2c) {
        const off = u32(h, 0x20);
        const size = u32(h, 0x24);
        if (size >= 0x36c0 && size < 0x10000) title = smdhTitle(readAt(off, 0x2008));
      }
      return { system: '3ds', format: '3dsx', title, code: '', productCode: '', titleId: null, kind: 'homebrew', version: null, encrypted: false };
    }
    if (ext === 'cia') {
      const h = readAt(0, 0x20);
      if (!h || h.length < 0x20 || u32(h, 0) !== 0x2020) return null;
      const certOff = align(0x2020, 64);
      const ticketOff = certOff + align(u32(h, 0x08), 64);
      const tmdOff = ticketOff + align(u32(h, 0x0c), 64);
      const tmdSize = u32(h, 0x10);
      const contentOff = tmdOff + align(tmdSize, 64);
      if (!tmdSize || tmdSize > 0x100000) return null;
      const tmd = readAt(tmdOff, Math.min(tmdSize, 0x2000));
      const sig = tmd && tmd.length >= 4 ? sigBlock(u32be(tmd, 0)) : 0;
      if (!sig || tmd.length < sig + 0xc4 + 0x900 + 0x30) return null;
      const hdr = sig; // TMD header after the signature block
      const titleId = id64be(tmd, hdr + 0x4c);
      const version = (tmd[hdr + 0x9c] << 8) | tmd[hdr + 0x9d];
      const chunk = hdr + 0xc4 + 0x900; // first content chunk record
      const contentEncrypted = !!(((tmd[chunk + 6] << 8) | tmd[chunk + 7]) & 1);
      const n = contentEncrypted ? null : ncch(readAt(contentOff, 0x200));
      return { system: '3ds', format: 'cia', title: '', code: n?.code || '', productCode: n?.productCode || '', titleId, kind: titleKind(titleId), version,
        encrypted: contentEncrypted || !!n?.encrypted };
    }
    // .3ds / .cci (NCSD) or .cxi (NCCH) – decided by the header, not the name
    const h = readAt(0, 0x200);
    if (!h || h.length < 0x200) return null;
    let n = null;
    let format = 'cxi';
    if (tag(h, 0x100) === 'NCSD') {
      format = 'cci';
      const unit = 0x200 * 2 ** (h[0x188 + 6] || 0);
      const off = u32(h, 0x120) * unit;
      if (!off) return null;
      n = ncch(readAt(off, 0x200));
      if (!n) {
        // encrypted or damaged partition: the cartridge's media ID is the game's title ID
        return { system: '3ds', format, title: '', code: '', productCode: '', titleId: id64(h, 0x108), kind: titleKind(id64(h, 0x108)), version: null, encrypted: true };
      }
    } else {
      n = ncch(h);
      if (!n) return null;
    }
    return { system: '3ds', format, title: '', code: n.code, productCode: n.productCode, titleId: n.titleId, kind: titleKind(n.titleId), version: n.version, encrypted: n.encrypted };
  } catch {
    return null;
  }
}

/** identifyCtr over an in-memory file (tests, small files). */
export function identifyCtrBytes(u8, ext) {
  return identifyCtr((o, n) => (o >= u8.length ? new Uint8Array(0) : u8.subarray(o, Math.min(u8.length, o + n))), ext);
}
