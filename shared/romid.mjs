// Identify a Game Boy / Game Boy Color / Game Boy Advance / Nintendo DS ROM from its header.

const ascii = (u8, a, b) => {
  let s = '';
  for (let i = a; i < b; i++) {
    const c = u8[i];
    if (c === 0) break;
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '';
  }
  return s.trim();
};

export const SYSTEMS = {
  gb: { name: 'Game Boy', ext: ['gb'] },
  gbc: { name: 'Game Boy Color', ext: ['gbc'] },
  gba: { name: 'Game Boy Advance', ext: ['gba'] },
  nds: { name: 'Nintendo DS', ext: ['nds'] },
};

export const ROM_EXTENSIONS = ['gb', 'gbc', 'gba', 'nds'];
export const PATCH_EXTENSIONS = ['xdelta', 'vcdiff', 'xdelta3', 'bps', 'ips', 'ups'];

const NINTENDO_LOGO_START = [0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b];

/**
 * @param {Uint8Array} head  at least the first 0x200 bytes
 * @param {string} [ext]     file extension hint
 * @returns {{system, title, code, version}|null}
 */
export function identifyRom(head, ext = '') {
  ext = ext.toLowerCase().replace(/^\./, '');
  // Nintendo DS: unit code at 0x12, ARM9 entry etc. – use the extension + header sanity.
  if (ext === 'nds' || (head.length >= 0x160 && head[0x15c] === 0x56 && head[0x15d] === 0xcf)) {
    return { system: 'nds', title: ascii(head, 0, 12), code: ascii(head, 0x0c, 0x10), version: head[0x1e] };
  }
  // GBA: fixed value 0x96 at 0xB2.
  if (ext === 'gba' || (head.length > 0xb2 && head[0xb2] === 0x96)) {
    return { system: 'gba', title: ascii(head, 0xa0, 0xac), code: ascii(head, 0xac, 0xb0), version: head[0xbc] };
  }
  // GB/GBC: Nintendo logo at 0x104.
  if (head.length > 0x150 && NINTENDO_LOGO_START.every((b, i) => head[0x104 + i] === b)) {
    const cgb = head[0x143];
    const system = cgb === 0x80 || cgb === 0xc0 ? 'gbc' : ext === 'gbc' ? 'gbc' : 'gb';
    // Newer carts use 0x13F–0x142 for a manufacturer code; older titles span to 0x143.
    const title = ascii(head, 0x134, cgb & 0x80 ? 0x13f : 0x144);
    const code = cgb & 0x80 ? ascii(head, 0x13f, 0x143) : '';
    return { system, title, code, version: head[0x14c] };
  }
  return null;
}

/** Match an identified ROM against the catalog (by CRC first, then serial/title). */
export function matchCatalog(rom, catalog) {
  if (!catalog?.games) return null;
  if (rom.crc) {
    const byCrc = catalog.games.find((g) => (g.crc32 || []).map((c) => String(c).toUpperCase()).includes(rom.crc));
    if (byCrc) return { game: byCrc, exact: true };
  }
  const code = (rom.code || '').toUpperCase();
  const title = (rom.title || '').toUpperCase();
  const codes = (g) => [g.gameCode, g.serial, g.productCode].filter(Boolean).map((c) => String(c).toUpperCase());
  const bySerial = (rom.system === 'gba' || rom.system === 'nds') && code && catalog.games.find((g) => g.system === rom.system && codes(g).includes(code));
  if (bySerial) return { game: bySerial, exact: false };
  const byTitle = catalog.games.find((g) => (g.system === rom.system || (g.system === 'gbc' && rom.system === 'gb')) && g.headerTitle && String(g.headerTitle).toUpperCase() === title);
  if (byTitle) return { game: byTitle, exact: false };
  return null;
}
