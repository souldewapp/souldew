// Location data read from the ROM itself (shared/live/romloc.mjs) and its use by readLocation (ctx.rom).
// Synthetic files check the formats; real ROMs – when present – check the result against the tables:
//   SOULDEW_TEST_ROMS=/folder/with/roms node --test test/romloc.test.mjs
// (any .nds/.gba in the folder; never commit ROMs). Without the variable those tests are skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gen4Messages, gen5Messages, gen4MapLocations, gen5ZoneLocations, gen3Names, romLocations, prettyName, langOfCode } from '../shared/live/romloc.mjs';
import { readLocation, canReadLocation } from '../shared/live/location.mjs';
import { blzDecompress } from '../shared/nds.mjs';
import { romCrc } from '../server/lib/romloc.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url), 'utf8'));
const maps = json('maps.json');
const gen4 = json('gen4.json');
const cs3 = json('charset_gen3.json');
const loc3 = json('locations_gen3.json');
const opts = { gen3Charset: cs3, gen4Chars: gen4.chars };

const put16 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };
const put32 = (b, o, v) => { put16(b, o, v & 0xffff); put16(b, o + 2, (v >>> 16) & 0xffff); };
function bus(cells) {
  const mem = new Map();
  for (const [a, bytes] of Object.entries(cells)) bytes.forEach((b, i) => mem.set(Number(a) + i, b));
  return (addr, len) => Uint8Array.from({ length: len }, (_, i) => mem.get(addr + i) ?? 0);
}
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

// the Gen 4 code of a character (inverse of gen4.json chars)
const code4 = Object.fromEntries(Object.entries(gen4.chars).map(([k, v]) => [v, Number(k)]));

/** Builds an encrypted Gen 4 message file (the inverse of gen4Messages). */
function gen4File(strings, seed = 0x1234) {
  const enc = strings.map((s) => [...[...s].map((c) => code4[c]), 0xffff]);
  const head = 4 + strings.length * 8;
  const size = head + enc.reduce((n, e) => n + e.length * 2, 0);
  const b = new Uint8Array(size);
  put16(b, 0, strings.length);
  put16(b, 2, seed);
  let off = head;
  enc.forEach((e, i) => {
    const k = (((seed * 0x2fd) & 0xffff) * (i + 1)) & 0xffff;
    const k32 = (k | (k << 16)) >>> 0;
    put32(b, 4 + i * 8, (off ^ k32) >>> 0);
    put32(b, 8 + i * 8, (e.length ^ k32) >>> 0);
    let ck = (0x91bd3 * (i + 1)) & 0xffff;
    e.forEach((c, j) => {
      put16(b, off + j * 2, c ^ ck);
      ck = (ck + 0x493d) & 0xffff;
    });
    off += e.length * 2;
  });
  return b;
}

/** Builds a Gen 5 message file (one section; the inverse of gen5Messages). */
function gen5File(strings) {
  const enc = strings.map((s) => [...[...s].map((c) => c.charCodeAt(0)), 0xffff]);
  const secOff = 16;
  const table = 4 + strings.length * 8;
  const size = secOff + table + enc.reduce((n, e) => n + e.length * 2, 0);
  const b = new Uint8Array(size);
  put16(b, 0, 1);
  put16(b, 2, strings.length);
  put32(b, 12, secOff);
  put32(b, secOff, size - secOff);
  let off = table;
  enc.forEach((e, i) => {
    put32(b, secOff + 4 + i * 8, off);
    put16(b, secOff + 8 + i * 8, e.length);
    // encrypted backwards from any start key: the terminator then encrypts to 0xFFFF ^ key, which is how
    // gen5Messages finds the key again
    let k = 0x7a3c;
    for (let j = e.length - 1; j >= 0; j--) {
      put16(b, secOff + off + j * 2, e[j] ^ k);
      k = ((k >> 3) | (k << 13)) & 0xffff;
    }
    off += e.length * 2;
  });
  return b;
}

test('Gen 4 message files decrypt (location names)', () => {
  const names = ['Mystery Zone', 'New Bark Town', 'Route 29', 'Cherrygrove City'];
  assert.deepEqual(gen4Messages(gen4File(names), gen4.chars), names);
});

test('Gen 5 message files decrypt; names built from variables are left out', () => {
  const names = ['', 'Mystery Zone', 'Nuvema Town', 'Route 1', 'Café Sonata'];
  assert.deepEqual(gen5Messages(gen5File(names)), names);
  const f = gen5File(['A', 'B']);
  assert.deepEqual(gen5Messages(f.subarray(0, 8)), [], 'a cut-off file gives nothing, not garbage');
});

test('Gen 4 map header table is found by its shape (music ids), name index at +0x12', () => {
  const arm9 = new Uint8Array(0x8000).fill(0x55);
  const T = 0x1004;
  const want = [];
  for (let i = 0; i < 150; i++) {
    const o = T + i * 24;
    arm9.fill(0, o, o + 24);
    put16(arm9, o + 12, 1000 + (i % 40)); // HGSS: music at u16 6 and 7
    put16(arm9, o + 14, 1000 + (i % 40));
    arm9[o + 0x12] = i % 90;
    want.push(i % 90);
  }
  const r = gen4MapLocations(arm9);
  assert.equal(r.offset, T);
  assert.deepEqual(r.map, want);
  assert.equal(gen4MapLocations(new Uint8Array(0x4000)), null, 'no table, no guess');
});

test('Gen 5 zone headers → name index at +0x1A', () => {
  const z = new Uint8Array(48 * 60);
  for (let i = 0; i < 60; i++) z[i * 48 + 0x1a] = i + 3;
  assert.deepEqual(gen5ZoneLocations(z).slice(0, 3), [3, 4, 5]);
  assert.equal(gen5ZoneLocations(z.subarray(0, 100)), null);
});

test('Gen 3 region map table: names by section, all-caps names prettified', () => {
  const rom = new Uint8Array(0x4000);
  rom[0xb2] = 0x96;
  const enc = (s) => [...s].map((c) => parseInt(Object.entries(cs3.table).find(([, v]) => v === c)[0], 16));
  let str = 0x2000;
  for (let i = 0; i < 70; i++) {
    const o = 0x400 + i * 8;
    rom.set([i % 28, i % 20, 1, 1], o);
    put32(rom, o + 4, 0x08000000 + str);
    const bytes = [...enc(i === 0 ? 'LITTLEROOT' : `ROUTE ${100 + i}`), 0xfc, 0x00, 0x00, ...(i === 0 ? enc('TOWN') : []), 0xff];
    rom.set(bytes, str);
    str += bytes.length;
  }
  const g = gen3Names(rom, cs3);
  assert.equal(g.offset, 0x400);
  assert.equal(g.names[0], 'Littleroot Town');
  assert.equal(g.names[5], 'Route 105');
  assert.equal(prettyName('MT. PYRE'), 'Mt. Pyre');
  assert.equal(prettyName('S.S. TIDAL'), 'S.S. Tidal');
  assert.equal(prettyName('Route 1'), 'Route 1');
  assert.equal(langOfCode('IPKD'), 'de');
  assert.equal(langOfCode('IREO'), 'en');
});

test('Gen 3 FireRed/LeafGreen names: the place-name table, not the longer Fame Checker one (German ROMs, #16)', () => {
  const rom = new Uint8Array(0x8000);
  rom[0xb2] = 0x96;
  rom.set([...'BPRD'].map((c) => c.charCodeAt(0)), 0xac);
  const enc = (t) => [...t].map((c) => parseInt(Object.entries(cs3.table).find(([, v]) => v === c)[0], 16));
  let str = 0x4000;
  const ptr = (t) => {
    const at = str;
    const bytes = [...enc(t), 0xff];
    rom.set(bytes, at);
    str += bytes.length;
    return 0x08000000 + at;
  };
  // the German Fame Checker: places and people, many of them twice – 120 entries, longer than the place names
  const fame = ['ALABASTIA', 'POKéMON-LABOR', 'POKéMON-LABOR', 'VERTANIA CITY', 'ARENA MARMORIA', 'ARENA MARMORIA', 'PROF. EICH', 'SCHILD'];
  for (let i = 0; i < 120; i++) put32(rom, 0x400 + i * 4, ptr(fame[i % fame.length]));
  // the place names by section from 0x58: 80 of them, one with a lower-case letter in it
  const places = Array.from({ length: 80 }, (_, i) => (i === 0 ? 'ALABASTIA' : i === 13 ? 'ROUTE 1' : i === 43 ? 'DIGDAs HÖHLE' : i === 47 ? 'POKéMON-HAUS' : `ORT ${i}`));
  places.forEach((t, i) => put32(rom, 0x1000 + i * 4, ptr(t)));
  const g = gen3Names(rom, cs3);
  assert.equal(g.layout, 'mapNamePointers');
  assert.equal(g.offset, 0x1000, 'the table with the most different names');
  assert.deepEqual([g.names[0x58], g.names[0x58 + 13], g.names[0x58 + 43], g.names[0x58 + 47]], ['Alabastia', 'Route 1', 'Digdas Höhle', 'Pokémon-Haus']);
  assert.equal(g.names.length, 0x58 + 80);
  assert.equal(prettyName('POKéMON LEAGUE'), 'Pokémon League');
  assert.equal(prettyName('Pokémon League'), 'Pokémon League');
});

test('BLZ: an uncompressed binary passes through', () => {
  const b = Uint8Array.from({ length: 64 }, (_, i) => (i < 60 ? i : 0)); // size increase 0 = not compressed
  assert.equal(blzDecompress(b), b);
  assert.throws(() => blzDecompress(Uint8Array.from({ length: 64 }, (_, i) => i)), /BLZ/, 'a footer that can\'t be right');
});

test('readLocation with ROM data: Gen 4 map id → the ROM\'s location, through the module params pointer', () => {
  const save = 0x02230000;
  const rom = { gen: 4, family: 'hgss', code: 'IPKD', lang: 'de', mapLoc: [0, 0, 7, 9], names: ['Geheimort', 'A', 'B', 'C', 'D', 'E', 'F', 'Rosalia City', 'G', 'Route 29'] };
  // German HeartGold: no maps.json entry, a scanned party – the module params still lead to the save data
  const entry = { id: 'heartgold_us~IPKD', gen: 4, partyCoreOffset: '0xA0' };
  const read = bus({ 0x02000ba8: le32(0x02111860), 0x02111880: le32(save), [save + 0x1244]: le32(3) });
  assert.equal(canReadLocation(maps, entry, null), false, 'without ROM data the language has no location');
  assert.equal(canReadLocation(maps, entry, rom), true);
  assert.deepEqual(readLocation(maps, entry, read, { rom }), { gen: 4, id: 9, map: 3, romName: 'Route 29' });
  // the party reader already knows the save data: that wins
  const read2 = bus({ [0x02240000 + 0x1244]: le32(2) });
  assert.deepEqual(readLocation(maps, entry, read2, { rom, state: { saveBase: 0x02240000 } }), { gen: 4, id: 7, map: 2, romName: 'Rosalia City' });
  // only a scanned party: save data = party core − partyCoreOffset
  const read3 = bus({ [0x02250000 + 0x1244]: le32(3) });
  assert.equal(readLocation(maps, entry, read3, { rom, state: { partyAddr: 0x02250000 + 0xa0 } }).id, 9);
});

test('readLocation with ROM data: the vanilla table and the ROM agree; the ROM wins for a hack', () => {
  const save = 0x02230000;
  const read = bus({ 0x02000ba8: le32(0x02111860), 0x02111880: le32(save), [save + 0x1244]: le32(6) });
  const t = maps.tables.gen4.hgss;
  assert.equal(readLocation(maps, 'heartgold_us', read).id, t[6]);
  const hack = { gen: 4, family: 'hgss', code: 'IPKE', lang: 'en', mapLoc: t.map((v, i) => (i === 6 ? 200 : v)), names: Array.from({ length: 235 }, (_, i) => (i === 200 ? 'Hack Town' : `L${i}`)) };
  assert.deepEqual(readLocation(maps, 'heartgold_us', read, { rom: hack }), { gen: 4, id: 200, map: 6, romName: 'Hack Town' });
});

test('readLocation with ROM data: Gen 5 zone id behind the main pointer (Black 2), parent zone as fallback (#1)', () => {
  const base = 0x02200000;
  const rom = { gen: 5, family: 'b2w2', code: 'IREO', lang: 'en', mapLoc: [0, 0, 0, 117], names: Object.assign(new Array(118).fill(''), { 117: 'Aspertia City' }) };
  const read = bus({ 0x02000024: le32(base), [base + 0x41b5c]: le16(3) });
  assert.equal(canReadLocation(maps, { id: 'black2_us', gen: 5 }, rom), true);
  assert.deepEqual(readLocation(maps, { id: 'black2_us', gen: 5 }, read, { rom }), { gen: 5, id: 117, map: 3, romName: 'Aspertia City' });
  const read2 = bus({ 0x02000024: le32(base), [base + 0x41b5c]: le16(1), [base + 0x41b44]: le16(3) });
  assert.equal(readLocation(maps, { id: 'black2_us', gen: 5 }, read2, { rom }).id, 117, 'zone without a name → its parent');
  assert.equal(canReadLocation(maps, { id: 'black2_us', gen: 5 }, null), false, 'Gen 5 needs the ROM data');
});

// ---------------------------------------------------------------- real ROMs (optional)

const DIR = process.env.SOULDEW_TEST_ROMS;
const roms = DIR && existsSync(DIR) ? readdirSync(DIR).filter((f) => /\.(nds|gba)$/i.test(f)).map((f) => join(DIR, f)) : [];
// only retail dumps can be compared with the tables (a hack or a randomized game is checked in test/romdata.test.mjs)
const RETAIL = new Set(json('catalog.json').games.flatMap((g) => g.crc32 || []).map((c) => String(c).toUpperCase()));
const retail = (bytes) => RETAIL.has(romCrc(bytes));

test('real ROMs: the ROM-derived locations match the tables', { skip: roms.length ? false : 'set SOULDEW_TEST_ROMS to a folder with ROMs' }, () => {
  const table4 = { hgss: maps.tables.gen4.hgss, pt: maps.tables.gen4.pt, dp: maps.tables.gen4.dp };
  for (const f of roms) {
    const bytes = new Uint8Array(readFileSync(f));
    if (!retail(bytes)) continue;
    const r = romLocations(bytes, opts);
    assert.ok(r, `${f}: location data found`);
    if (r.gen === 4) {
      const t = table4[r.family];
      assert.deepEqual(r.mapLoc.slice(0, t.length), t, `${f}: map → location equals maps.json ${r.family}`);
      // gen4.json holds the HeartGold/SoulSilver names; Diamond/Pearl/Platinum have their own list
      if (r.lang === 'en' && r.family === 'hgss') assert.deepEqual(r.names, gen4.locations, `${f}: names equal gen4.json`);
      if (r.lang === 'en' && r.family !== 'hgss') assert.equal(r.names[1], 'Twinleaf Town', f);
    } else if (r.gen === 3) {
      assert.equal(r.vanilla, undefined, 'romLocations itself knows nothing about checksums (the server adds it)');
      // the table's labels carry notes for the other versions: "Battle Tower (RS) / Battle Frontier (E)"
      const variants = (label) => label.split(' / ').map((x) => x.replace(/\s*\([^)]*\)/g, '').trim().toLowerCase());
      let same = 0;
      for (const [k, v] of Object.entries(loc3.map)) {
        const n = r.names[Number(k)];
        if (!n || r.lang !== 'en') continue;
        assert.ok(variants(v.en).some((x) => x.startsWith(n.toLowerCase()) || n.toLowerCase().startsWith(x) || n.toLowerCase().endsWith(x)), `${f}: section ${k} "${n}" vs "${v.en}"`);
        same++;
      }
      if (r.lang === 'en') assert.ok(same >= 80, `${f}: ${same} sections compared`);
      // a German ROM against the app's German names (FireRed/LeafGreen: the Fame Checker's table was read once, #16)
      if (r.lang === 'de') {
        const de = Object.entries(loc3.map).filter(([k, v]) => v.de && r.names[Number(k)]);
        const hits = de.filter(([k, v]) => variants(v.de).some((x) => x.toLowerCase() === r.names[Number(k)].toLowerCase()));
        assert.ok(de.length >= 80 && hits.length >= de.length * 0.8, `${f}: ${hits.length} of ${de.length} German names agree`);
      }
    } else if (r.gen === 5) {
      if (r.lang === 'en') {
        assert.equal(r.names[4], 'Nuvema Town', f);
        if (r.family === 'b2w2') assert.equal(r.names[r.mapLoc[427]], 'Aspertia City', `${f}: the player's home zone`);
      }
      assert.ok(r.mapLoc.every((v) => v < r.names.length), f);
    }
  }
});
