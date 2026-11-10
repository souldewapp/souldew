// Location data read from the game ROM itself, so the "where am I" sign works without hand-made tables – for
// randomized games, other languages and ROM hacks that keep the engine's formats (their own maps and place names
// included). What stays built in is knowledge per engine, not per game:
//   Gen 3  the region map's section table (x, y, width, height, name pointer – Ruby/Sapphire/Emerald) or the
//          name pointer table (FireRed/LeafGreen); the section id itself is read live from gMapHeader in RAM.
//   Gen 4  the map header table in the ARM9 binary (24 bytes per map, location name index at +0x12) and the game's
//          location-name text file (encrypted msg format). The current map id is read live from the save data
//          (shared/live/location.mjs finds it through the NitroSDK module params, like the party reader).
//   Gen 5  the zone headers (a/0/1/2, 48 bytes per zone, name index at +0x1A) and the location-name text file of
//          a/0/0/2 (#89 Black/White, #109 Black 2/White 2) – checked against the US/EU ROMs of all four games: the
//          names equal PKHeX's Gen 5 met locations.
// The location name index is the same number the game stores as a catch's met location, so a place read this way
// pairs with catches exactly like the table-based one (shared/live/location.mjs). Tables are found by their
// structure (signature scans), not by fixed offsets; anything that doesn't validate gives null, never a guess.
import { ndsHeader, listNdsFiles, parseNarc, ndsArm9, ndsFile } from '../nds.mjs';

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Language of a game code's last letter (E/O English, D German, …); null when unknown. */
export function langOfCode(code) {
  return { E: 'en', O: 'en', P: 'en', D: 'de', F: 'fr', I: 'it', S: 'es', H: 'nl', J: 'ja', K: 'ko' }[String(code || '').slice(3, 4).toUpperCase()] || null;
}

/** "ROUTE 101" → "Route 101", "MT. PYRE" → "Mt. Pyre", "S.S. TIDAL" stays; mixed-case names stay as they are. */
export function prettyName(s) {
  if (!s || /[a-zà-ÿ]/.test(s)) return s;
  return s.toLowerCase().replace(/(^|[\s.\-(])([a-zà-ÿ])/g, (_, a, b) => a + b.toUpperCase());
}

// ---------------------------------------------------------------- Gen 3 (GBA)

// argument bytes of the 0xFC control codes (pokeemerald include/characters.h); the code byte itself not counted
const FC_ARGS = [1, 1, 1, 1, 3, 1, 1, 0, 1, 0, 0, 2, 1, 1, 1, 0, 2, 1, 1, 1, 1, 0, 0, 0, 0];

/**
 * A Gen 3 string at a ROM pointer, or null when it isn't one (not a ROM address, unknown byte, too long). An empty
 * string (just the terminator) is '' – Emerald's MAPSEC_DYNAMIC has one, in the middle of the table. `ph` = the team
 * names the game puts in for its placeholders ("{AQUA} HIDEOUT").
 */
function gen3String(rom, ptr, table, max = 40, ph = null) {
  if (ptr < 0x08000000 || ptr >= 0x08000000 + rom.length) return null;
  const o = ptr - 0x08000000;
  let s = '';
  for (let k = 0; k < max && o + k < rom.length; k++) {
    const c = rom[o + k];
    if (c === 0xff) return s.replace(/\s+/g, ' ').trim();
    if (c === 0xfc) {
      k += 1 + (FC_ARGS[rom[o + k + 1]] ?? 0); // formatting (colour, spacing): a space at most
      s += ' ';
      continue;
    }
    if (c === 0xfd) {
      // a placeholder: the team names are known per game (pokeemerald PLACEHOLDER_ID_AQUA 8 / _MAGMA 9), any other
      // one depends on the game state – left out
      s += ph?.[rom[o + k + 1]] || '';
      k += 1;
      continue;
    }
    if (c === 0xfe) {
      s += ' ';
      continue;
    }
    const ch = table[c.toString(16).toUpperCase().padStart(2, '0')];
    if (ch === undefined) return null;
    s += ch;
  }
  return null;
}

/** What the team placeholders say in a game: Ruby swaps them (its villains are Team Magma) – pokeruby src/strings. */
const gen3Teams = (code) => (String(code || '').startsWith('AXV') ? { 8: 'MAGMA', 9: 'AQUA' } : { 8: 'AQUA', 9: 'MAGMA' });

/** Longest run of `stride`-byte entries passing `ok(offset)`, over 4-byte aligned offsets: { start, len }. */
function longestRun(bytes, stride, ok, from = 0, to = bytes.length) {
  let best = { start: -1, len: 0 };
  for (let r = 0; r < stride; r += 4) {
    let run = 0;
    let start = 0;
    for (let o = from + r; o + stride <= to; o += stride) {
      if (ok(o)) {
        if (!run) start = o;
        run++;
        if (run > best.len) best = { start, len: run };
      } else run = 0;
    }
  }
  return best;
}

/**
 * Gen 3 place names by region map section id (MAPSEC). Ruby/Sapphire/Emerald: struct RegionMapLocation
 * { u8 x, y, width, height; const u8 *name } – one per section, section 0 first. FireRed/LeafGreen: const u8 *name[]
 * for the Kanto sections, starting at section 0x58.
 */
export function gen3Names(rom, charset, code = String.fromCharCode(...rom.subarray(0xac, 0xb0))) {
  const table = charset?.table || charset || {};
  const teams = gen3Teams(code);
  const str = (p) => gen3String(rom, p, table, 40, teams);
  const struct = longestRun(rom, 8, (o) => rom[o] < 32 && rom[o + 1] < 32 && rom[o + 2] >= 1 && rom[o + 2] <= 16 && rom[o + 3] >= 1 && rom[o + 3] <= 16 && str(u32(rom, o + 4)) !== null);
  if (struct.len >= 60) {
    const names = [];
    for (let i = 0; i < struct.len; i++) names.push(prettyName(str(u32(rom, struct.start + i * 8 + 4))));
    return { names, base: 0, layout: 'regionMapLocations', offset: struct.start };
  }
  // FireRed/LeafGreen: short one-line names only (move descriptions & co. are pointer tables too, with longer text)
  const shortName = (p) => {
    const s = str(p);
    return !!s && s.length <= 20 && !/[a-z]/.test(s);
  };
  const ptrs = longestRun(rom, 4, (o) => shortName(u32(rom, o)));
  if (ptrs.len >= 60) {
    const names = new Array(0x58).fill(null);
    for (let i = 0; i < ptrs.len; i++) names.push(prettyName(str(u32(rom, ptrs.start + i * 4))));
    return { names, base: 0x58, layout: 'mapNamePointers', offset: ptrs.start };
  }
  return null;
}

// ---------------------------------------------------------------- Gen 4 (DS)

/** Decrypts a Gen 4 message file (pokeheartgold/pokeplatinum msgdata format) → strings; `chars` = gen4.json chars. */
export function gen4Messages(buf, chars) {
  const n = u16(buf, 0);
  const seed = u16(buf, 2);
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = (((seed * 0x2fd) & 0xffff) * (i + 1)) & 0xffff;
    const k32 = (k | (k << 16)) >>> 0;
    const off = (u32(buf, 4 + i * 8) ^ k32) >>> 0;
    const len = (u32(buf, 8 + i * 8) ^ k32) >>> 0;
    if (off + len * 2 > buf.length) {
      out.push('');
      continue;
    }
    let ck = (0x91bd3 * (i + 1)) & 0xffff;
    const cs = [];
    for (let j = 0; j < len; j++) {
      cs.push(u16(buf, off + j * 2) ^ ck);
      ck = (ck + 0x493d) & 0xffff;
    }
    let s = '';
    for (let j = 0; j < cs.length; j++) {
      const c = cs[j];
      if (c === 0xffff) break;
      if (c === 0xe000 || c === 0x25bc || c === 0x25bd) s += ' ';
      else if (c === 0xfffe) j += 2 + (cs[j + 2] || 0); // variable: type, argument count, arguments
      else s += chars?.[c] ?? chars?.[String(c)] ?? '';
    }
    out.push(s.replace(/\s+/g, ' ').trim());
  }
  return out;
}

// HGSS: wild/area bytes, ?, matrix, scripts, level scripts, text, music day, music night, events, name+icon …
// DP/Pt: area, matrix, scripts, level scripts, text, music day, music night, wild, events, name … – music sits at
// u16 5/6 (DP/Pt) or 6/7 (HGSS); the name index is the byte at +0x12 in all of them (u16 in DP, < 256 anyway).
const GEN4 = {
  hgss: { msgNarc: 'a/0/2/7', msgFile: 279 },
  pt: { msgNarc: 'msgdata/pl_msg.narc', msgFile: 433 },
  dp: { msgNarc: 'msgdata/msg.narc', msgFile: 382 },
};

function gen4Family(code, files) {
  const c = String(code || '').slice(0, 3).toUpperCase();
  if (c === 'IPK' || c === 'IPG') return 'hgss';
  if (c === 'CPU') return 'pt';
  if (c === 'ADA' || c === 'APA') return 'dp';
  // a hack with another game code: tell the engines apart by their file layout
  const has = (p) => files.some((f) => f.path === p);
  if (has('a/0/2/7') && has('a/0/1/2')) return 'hgss';
  if (has('msgdata/pl_msg.narc')) return 'pt';
  if (has('msgdata/msg.narc')) return 'dp';
  return null;
}

/** The map header table: map id → location name index (an array), found by its shape in the ARM9 binary. */
export function gen4MapLocations(arm9) {
  const music = (v) => v >= 1000 && v <= 1300;
  let best = { start: -1, len: 0, at: 0 };
  for (const at of [5, 6]) {
    const run = longestRun(arm9, 24, (o) => music(u16(arm9, o + at * 2)) && music(u16(arm9, o + at * 2 + 2)));
    if (run.len > best.len) best = { ...run, at };
  }
  if (best.len < 100) return null;
  const map = [];
  for (let i = 0; i < best.len; i++) map.push(arm9[best.start + i * 24 + 0x12]);
  return { map, offset: best.start };
}

function gen4(rom, h, files, opts) {
  const family = gen4Family(h.code, files);
  if (!family) return null;
  const arm9 = ndsArm9(rom);
  const headers = gen4MapLocations(arm9.bytes);
  if (!headers) return null;
  const narc = ndsFile(rom, GEN4[family].msgNarc, files);
  if (!narc) return null;
  const msg = parseNarc(narc)[GEN4[family].msgFile];
  if (!msg) return null;
  const names = gen4Messages(msg, opts.gen4Chars);
  const max = Math.max(...headers.map);
  if (names.length <= max) return null; // not the location names: a hack moved the file
  return { gen: 4, family, mapLoc: headers.map, names, source: { headers: headers.offset, msg: `${GEN4[family].msgNarc}#${GEN4[family].msgFile}` } };
}

// ---------------------------------------------------------------- Gen 5 (DS)

/** Decrypts a Gen 5 message file → strings of its first section (BW/B2W2 text format). */
export function gen5Messages(buf) {
  const sections = u16(buf, 0);
  const n = u16(buf, 2);
  if (!sections || 12 + sections * 4 > buf.length) return [];
  const sec = u32(buf, 12);
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = sec + 4 + i * 8;
    if (e + 8 > buf.length) break;
    const off = sec + u32(buf, e);
    const len = u16(buf, e + 4);
    if (!len || off + len * 2 > buf.length) {
      out.push('');
      continue;
    }
    const cs = new Array(len);
    let key = u16(buf, off + (len - 1) * 2) ^ 0xffff;
    for (let j = len - 1; j >= 0; j--) {
      cs[j] = u16(buf, off + j * 2) ^ key;
      key = ((key >> 3) | (key << 13)) & 0xffff;
    }
    let s = '';
    for (let j = 0; j < len; j++) {
      const c = cs[j];
      if (c === 0xffff) break;
      if (c === 0xfffe) s += ' ';
      else if (c === 0xf000) {
        s = ''; // a name built from variables ("{player}'s {…}") isn't a place to show
        break;
      } else if (c >= 0x20 && c < 0xd800) s += String.fromCharCode(c);
    }
    out.push(s.replace(/\s+/g, ' ').trim());
  }
  return out;
}

const GEN5 = {
  bw: { msgFile: 89 },
  b2w2: { msgFile: 109 },
};

function gen5Family(code) {
  const c = String(code || '').slice(0, 3).toUpperCase();
  if (c === 'IRB' || c === 'IRA') return 'bw';
  if (c === 'IRE' || c === 'IRD') return 'b2w2';
  return null;
}

/** Zone headers (a/0/1/2: one file, 48 bytes per zone) → zone id → location name index. */
export function gen5ZoneLocations(zones) {
  if (!zones || zones.length < 48 * 50 || zones.length % 48) return null;
  const map = [];
  for (let o = 0; o < zones.length; o += 48) map.push(zones[o + 0x1a]);
  return map;
}

function gen5(rom, h, files) {
  const family = gen5Family(h.code);
  if (!family) return null;
  const zoneNarc = ndsFile(rom, 'a/0/1/2', files);
  const msgNarc = ndsFile(rom, 'a/0/0/2', files);
  if (!zoneNarc || !msgNarc) return null;
  const map = gen5ZoneLocations(parseNarc(zoneNarc)[0]);
  const msg = parseNarc(msgNarc)[GEN5[family].msgFile];
  if (!map || !msg) return null;
  const names = gen5Messages(msg);
  // a hack may pad the file with empty entries for places still to come (Blaze Black 2 Redux: 660, 155 used)
  while (names.length && !names[names.length - 1]) names.pop();
  // fail closed: nearly every zone must name an existing place, and most places must have a name
  const inRange = map.filter((v) => v < names.length).length;
  if (names.length < 50 || inRange < map.length * 0.95 || names.filter(Boolean).length < names.length * 0.6) return null;
  return { gen: 5, family, mapLoc: map.map((v) => (v < names.length ? v : 0)), names, source: { zones: 'a/0/1/2#0', msg: `a/0/0/2#${GEN5[family].msgFile}` } };
}

// ---------------------------------------------------------------- entry point

/**
 * Location data of a ROM: { gen, family, code, lang, names, mapLoc, source } or null when the ROM isn't one
 * of the supported engines (or a table doesn't validate). `names[id]` = place name (the game's own text, in the
 * ROM's language), `mapLoc[mapId]` = location id (Gen 4/5; null for Gen 3, whose RAM holds the location id itself).
 * `opts` = { gen3Charset: charset_gen3.json, gen4Chars: gen4.json chars }. Never throws.
 */
export function romLocations(rom, opts = {}) {
  try {
    if (!rom || rom.length < 0x200) return null;
    // GBA: fixed byte 0x96 at 0xB2, game code at 0xAC
    if (rom[0xb2] === 0x96 && rom[3] === 0xea) {
      const code = String.fromCharCode(...rom.subarray(0xac, 0xb0));
      const g = gen3Names(rom, opts.gen3Charset);
      return g ? { gen: 3, family: g.layout === 'mapNamePointers' ? 'frlg' : 'rse', code, lang: langOfCode(code), names: g.names, mapLoc: null, source: { names: g.offset } } : null;
    }
    const h = ndsHeader(rom);
    if (!/^[A-Z0-9]{4}$/.test(h.code) || h.fnt.offset + h.fnt.size > rom.length || h.fat.offset + h.fat.size > rom.length) return null;
    const files = listNdsFiles(rom);
    const r = gen5Family(h.code) ? gen5(rom, h, files) : gen4(rom, h, files, opts);
    return r ? { code: h.code, lang: langOfCode(h.code), ...r } : null;
  } catch {
    return null;
  }
}
