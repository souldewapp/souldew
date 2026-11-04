// NDS ROM filesystem helpers: header, FNT/FAT listing, NARC parsing, file-level diff.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function ndsHeader(rom) {
  const ascii = (a, n) => String.fromCharCode(...rom.subarray(a, a + n)).replace(/\0+$/, '');
  return {
    title: ascii(0, 12),
    code: ascii(12, 4),
    arm9: { offset: u32(rom, 0x20), size: u32(rom, 0x2c) },
    arm7: { offset: u32(rom, 0x30), size: u32(rom, 0x3c) },
    fnt: { offset: u32(rom, 0x40), size: u32(rom, 0x44) },
    fat: { offset: u32(rom, 0x48), size: u32(rom, 0x4c) },
    ovt9: { offset: u32(rom, 0x50), size: u32(rom, 0x54) },
  };
}

/** List all files: [{ id, path, start, end }]. Overlay files get "overlay9/<n>". */
export function listNdsFiles(rom) {
  const h = ndsHeader(rom);
  const fatCount = h.fat.size / 8;
  const files = new Array(fatCount);
  for (let i = 0; i < fatCount; i++) {
    files[i] = { id: i, path: null, start: u32(rom, h.fat.offset + i * 8), end: u32(rom, h.fat.offset + i * 8 + 4) };
  }
  const fnt = h.fnt.offset;
  const walk = (dirId, prefix) => {
    const entry = fnt + (dirId & 0xfff) * 8;
    let p = fnt + u32(rom, entry);
    let fileId = u16(rom, entry + 4);
    for (;;) {
      const len = rom[p++];
      if (len === 0) break;
      const isDir = len & 0x80;
      const name = String.fromCharCode(...rom.subarray(p, p + (len & 0x7f)));
      p += len & 0x7f;
      if (isDir) {
        const sub = u16(rom, p);
        p += 2;
        walk(sub, `${prefix}${name}/`);
      } else {
        if (files[fileId]) files[fileId].path = prefix + name;
        fileId++;
      }
    }
  };
  walk(0xf000, '');
  const ovCount = h.ovt9.size / 32;
  for (let i = 0; i < ovCount; i++) {
    const fid = u32(rom, h.ovt9.offset + i * 32 + 24);
    if (files[fid] && !files[fid].path) files[fid].path = `overlay9/${u32(rom, h.ovt9.offset + i * 32)}`;
  }
  for (const f of files) if (f && !f.path) f.path = `#${f.id}`;
  return files;
}

/** NARC → array of Uint8Array subfiles. */
export function parseNarc(narc) {
  if (u32(narc, 0) !== 0x4352414e) throw new Error('not a NARC');
  let p = u16(narc, 0x0c);
  let fatb = -1;
  let fimg = -1;
  while (p < narc.length) {
    const magic = u32(narc, p);
    const size = u32(narc, p + 4);
    if (magic === 0x46415442) fatb = p; // 'BTAF'
    if (magic === 0x46494d47) fimg = p; // 'GMIF'
    p += size;
  }
  const count = u32(narc, fatb + 8);
  const base = fimg + 8;
  const out = [];
  for (let i = 0; i < count; i++) {
    const s = u32(narc, fatb + 12 + i * 8);
    const e = u32(narc, fatb + 16 + i * 8);
    out.push(narc.subarray(base + s, base + e));
  }
  return out;
}

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** File-level diff between two ROMs (and sub-file diff for NARCs). */
export function diffRoms(a, b) {
  const fa = listNdsFiles(a);
  const fb = new Map(listNdsFiles(b).map((f) => [f.path, f]));
  const changed = [];
  const ha = ndsHeader(a);
  const hb = ndsHeader(b);
  if (!same(a.subarray(ha.arm9.offset, ha.arm9.offset + ha.arm9.size), b.subarray(hb.arm9.offset, hb.arm9.offset + hb.arm9.size))) {
    changed.push({ path: 'arm9.bin', sizeA: ha.arm9.size, sizeB: hb.arm9.size });
  }
  for (const f of fa) {
    const g = fb.get(f.path);
    if (!g) {
      changed.push({ path: f.path, removed: true });
      continue;
    }
    const da = a.subarray(f.start, f.end);
    const db = b.subarray(g.start, g.end);
    if (same(da, db)) continue;
    const entry = { path: f.path, sizeA: da.length, sizeB: db.length };
    if (u32(da, 0) === 0x4352414e && u32(db, 0) === 0x4352414e) {
      try {
        const na = parseNarc(da);
        const nb = parseNarc(db);
        entry.subfiles = [];
        for (let i = 0; i < Math.max(na.length, nb.length); i++) {
          if (!na[i] || !nb[i] || !same(na[i], nb[i])) entry.subfiles.push(i);
        }
      } catch {
        // not a parseable NARC — file-level info is enough
      }
    }
    changed.push(entry);
  }
  return changed;
}
