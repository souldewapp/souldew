// Nintendo 3DS Pokémon games: which place each zone (map) belongs to, read from the game's own RomFS – the place sign
// ("You are here") turns the zone the game reports in memory into the place name a catch there gets.
//
//   X/Y          a/0/1/2   Omega Ruby/Alpha Sapphire   a/0/1/3      the encounter GARC; its last (X/Y) or second-to-last
//                (ORAS) file is the zone table (one entry per encounter file before it), 56 bytes per zone, the place
//                (met location) at +0x1C (9 bits) – pk3DS RSWE/XYWE (which sorts it first when unpacking)
//   Sun/Moon, Ultra Sun/Ultra Moon   a/0/7/7                        the zone GARC; its first file (LZ11-packed): 0x54
//                bytes per zone, the place at +0x1C (u32) – pk3DS ZoneData7
//
// `readAt(offset, length)` reads the ROM file (a .3ds/.cci cartridge image or a .cxi), so a 4 GB game is read a few
// KB at a time. The RomFS must be unencrypted (Azahar plays decrypted games only).

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 0x100000000;
const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** The zone table of each game family: GARC path, entry size, how the place is stored. */
export const ZONE_TABLES = {
  xy: { path: 'a/0/1/2', file: -1, size: 56, gen: 6 },
  oras: { path: 'a/0/1/3', file: -2, size: 56, gen: 6 },
  sm: { path: 'a/0/7/7', file: 0, size: 0x54, gen: 7 },
  usum: { path: 'a/0/7/7', file: 0, size: 0x54, gen: 7 },
};
const FAMILY = { EKJA: 'xy', EK2A: 'xy', ECRA: 'oras', ECRP: 'oras', ECLA: 'oras', BNDA: 'sm', BNEA: 'sm', A2AA: 'usum', A2BA: 'usum' };
const FAMILY_TID = { '0004000000055D00': 'xy', '0004000000055E00': 'xy', '000400000011C400': 'oras', '000400000011C500': 'oras', '0004000000164800': 'sm', '0004000000175E00': 'sm', '00040000001B5000': 'usum', '00040000001B5100': 'usum' };

/** The game family of a product/game code or title ID ('xy' | 'oras' | 'sm' | 'usum'), or null. */
export function familyOf({ code, titleId } = {}) {
  return FAMILY[String(code || '').toUpperCase()] || FAMILY_TID[String(titleId || '').toUpperCase()] || null;
}

/** The game's NCCH: offset in the file (a cartridge image's partition 0, or the file itself). */
function ncchOffset(readAt) {
  const h = readAt(0, 0x200);
  if (!h || h.length < 0x200) return -1;
  if (tag(h, 0x100) === 'NCSD') {
    const unit = 0x200 * 2 ** (h[0x188 + 6] || 0);
    return u32(h, 0x120) * unit;
  }
  return tag(h, 0x100) === 'NCCH' ? 0 : -1;
}

/** Level 3 of the RomFS (the files): its offset in the file and its header. */
function romfs(readAt) {
  const n = ncchOffset(readAt);
  if (n < 0) return null;
  const h = readAt(n, 0x200);
  if (!h || tag(h, 0x100) !== 'NCCH') return null;
  if (!(h[0x18f] & 0x04)) return null; // encrypted contents
  const unit = 0x200 * 2 ** (h[0x188 + 6] || 0);
  const off = n + u32(h, 0x1b0) * unit;
  if (!u32(h, 0x1b4)) return null;
  const ivfc = readAt(off, 0x60);
  if (!ivfc || tag(ivfc, 0) !== 'IVFC') return null;
  const masterHash = u32(ivfc, 0x08);
  const l3Block = 2 ** u32(ivfc, 0x4c);
  const l3 = off + Math.ceil((0x60 + masterHash) / l3Block) * l3Block;
  const hdr = readAt(l3, 0x28);
  if (!hdr || u32(hdr, 0) !== 0x28) return null;
  return {
    base: l3,
    dirMeta: { off: u32(hdr, 0x0c), len: u32(hdr, 0x10) },
    fileMeta: { off: u32(hdr, 0x1c), len: u32(hdr, 0x20) },
    data: u32(hdr, 0x24),
  };
}

const name16 = (b, o, len) => {
  let s = '';
  for (let i = 0; i < len; i += 2) s += String.fromCharCode(u16(b, o + i));
  return s;
};

/** A RomFS file by path ('a/0/1/3'): { offset, size } in the ROM file, or null. */
export function romfsFile(readAt, path) {
  const fs = romfs(readAt);
  if (!fs || fs.dirMeta.len > 4 * 1024 * 1024 || fs.fileMeta.len > 8 * 1024 * 1024) return null;
  const dirs = readAt(fs.base + fs.dirMeta.off, fs.dirMeta.len);
  const files = readAt(fs.base + fs.fileMeta.off, fs.fileMeta.len);
  if (!dirs || !files) return null;
  const parts = String(path).split('/');
  let dir = 0; // root
  for (let k = 0; k < parts.length; k++) {
    const last = k === parts.length - 1;
    if (!last) {
      let child = u32(dirs, dir + 0x08);
      let found = -1;
      for (let guard = 0; child !== 0xffffffff && guard < 100000; guard++) {
        if (child + 0x18 > dirs.length) return null;
        if (name16(dirs, child + 0x18, u32(dirs, child + 0x14)) === parts[k]) {
          found = child;
          break;
        }
        child = u32(dirs, child + 0x04);
      }
      if (found < 0) return null;
      dir = found;
    } else {
      let f = u32(dirs, dir + 0x0c);
      for (let guard = 0; f !== 0xffffffff && guard < 100000; guard++) {
        if (f + 0x20 > files.length) return null;
        if (name16(files, f + 0x20, u32(files, f + 0x1c)) === parts[k]) {
          return { offset: fs.base + fs.data + u64(files, f + 0x08), size: u64(files, f + 0x10) };
        }
        f = u32(files, f + 0x04);
      }
    }
  }
  return null;
}

/**
 * File `index` of a GARC archive at `at` in the ROM file (negative: from the end, -1 = the last): its bytes, or null.
 * Only the first sub-file of an entry is read (the zone tables have one).
 */
export function garcFile(readAt, at, index = 0, maxSize = 1024 * 1024) {
  const h = readAt(at, 0x1c);
  if (!h || tag(h, 0) !== 'CRAG') return null;
  const headerSize = u32(h, 4);
  const dataOffset = u32(h, 0x10);
  const fato = readAt(at + headerSize, 0x0c);
  if (!fato || tag(fato, 0) !== 'OTAF') return null;
  const fatbAt = at + headerSize + u32(fato, 4);
  const fatbHead = readAt(fatbAt, 0x0c);
  if (!fatbHead || tag(fatbHead, 0) !== 'BTAF') return null;
  const size = u32(fatbHead, 4);
  const count = u32(fatbHead, 8);
  if (size > 4 * 1024 * 1024 || !count) return null;
  const fatb = readAt(fatbAt, size);
  const want = index < 0 ? count + index : index;
  if (want < 0 || want >= count) return null;
  // entries: a bit vector (u32), then start / end / length for each set bit
  let p = 0x0c;
  for (let i = 0; i < count; i++) {
    const bits = u32(fatb, p);
    p += 4;
    let first = null;
    for (let b = 0; b < 32; b++) {
      if (!(bits & (1 << b))) continue;
      if (!first) first = { start: u32(fatb, p), length: u32(fatb, p + 8) };
      p += 12;
    }
    if (i === want) {
      if (!first || !first.length || first.length > maxSize) return null;
      return readAt(at + dataOffset + first.start, first.length);
    }
  }
  return null;
}

/** Nintendo's LZ11 (a GARC file starting with 0x11): the unpacked bytes, or the input when it isn't LZ11. */
export function lz11(src, maxSize = 4 * 1024 * 1024) {
  if (!src || src.length < 4 || src[0] !== 0x11) return src;
  let size = src[1] | (src[2] << 8) | (src[3] << 16);
  let p = 4;
  if (!size) {
    size = u32(src, 4);
    p = 8;
  }
  if (size > maxSize) return null;
  const out = new Uint8Array(size);
  let o = 0;
  while (o < size && p < src.length) {
    const flags = src[p++];
    for (let bit = 7; bit >= 0 && o < size; bit--) {
      if (!(flags & (1 << bit))) {
        if (p >= src.length) return null;
        out[o++] = src[p++];
        continue;
      }
      const b0 = src[p];
      let len;
      let disp;
      if (b0 >> 4 === 0) {
        len = (((b0 & 0xf) << 4) | (src[p + 1] >> 4)) + 0x11;
        disp = (((src[p + 1] & 0xf) << 8) | src[p + 2]) + 1;
        p += 3;
      } else if (b0 >> 4 === 1) {
        len = (((b0 & 0xf) << 12) | (src[p + 1] << 4) | (src[p + 2] >> 4)) + 0x111;
        disp = (((src[p + 2] & 0xf) << 8) | src[p + 3]) + 1;
        p += 4;
      } else {
        len = (b0 >> 4) + 1;
        disp = (((b0 & 0xf) << 8) | src[p + 1]) + 1;
        p += 2;
      }
      if (disp > o) return null;
      for (let i = 0; i < len && o < size; i++, o++) out[o] = out[o - disp];
    }
  }
  return o === size ? out : null;
}

/**
 * The place of every zone: { family, gen, places: number[] } (places[zone] = place id, the met location's numbering),
 * or null. Never throws.
 */
export function ctrZonePlaces(readAt, ids = {}) {
  try {
    const family = familyOf(ids);
    const t = family && ZONE_TABLES[family];
    if (!t) return null;
    const f = romfsFile(readAt, t.path);
    if (!f) return null;
    // X/Y keep the zone table last in the GARC, Omega Ruby/Alpha Sapphire second to last (then their encounter
    // storage): the one whose size fits a table of that many zones
    const candidates = t.gen === 6 ? [-1, -2] : [t.file];
    let table = null;
    for (const i of candidates) {
      const b = lz11(garcFile(readAt, f.offset, i));
      if (b && b.length >= t.size && b.length % t.size === 0) {
        table = b;
        break;
      }
    }
    if (!table) return null;
    const places = [];
    for (let o = 0; o < table.length; o += t.size) places.push(t.gen === 6 ? table[o + 0x1c] | ((table[o + 0x1d] & 1) << 8) : u32(table, o + 0x1c));
    return { family, gen: t.gen, places };
  } catch {
    return null;
  }
}
