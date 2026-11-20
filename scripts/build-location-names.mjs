// Place names in every language of the app (web/lib/i18n.mjs LANGS) for the location tables in shared/data:
// locations_gen2_crystal / _gen3 / _gen6 / _gen7 get their missing languages, locations_gen4 / _gen5 are written
// whole, and maps.json's gen1Locations (the Gen 1 town map, which PKHeX has no list for) take the names of the same
// places from the Gen 3 (FireRed/LeafGreen) and Gen 2 lists.
// Source: PKHeX PKHeX.Core/Resources/text/locations/gen<N>/text_<set>_<offset>_<lang>.txt (line index = id - offset).
// The English line of every id must equal the table's – a list that moved upstream stops the build instead of
// shifting every name. A name equal to the English one isn't stored (the readers fall back to `en`).
//
//   node scripts/build-location-names.mjs [dir]     dir: a folder with the PKHeX text files (default: fetched)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'data');
// Pinned to a PKHeX commit (master of 2026-11-16) so a re-run gives the same files; move it on purpose to take upstream fixes.
const BASE = 'https://raw.githubusercontent.com/kwsch/PKHeX/6c9583883c7551ac74a4b74180cead249d4277b8/PKHeX.Core/Resources/text/locations';
const LANGS = ['de', 'es', 'fr', 'it'];
const local = process.argv[2] || null;

const cache = new Map();
async function lines(gen, set, offset, lang) {
  const name = `text_${set}_${String(offset).padStart(5, '0')}_${lang}.txt`;
  if (cache.has(name)) return cache.get(name);
  let text;
  if (local && existsSync(join(local, name))) text = readFileSync(join(local, name), 'utf8');
  else {
    const r = await fetch(`${BASE}/gen${gen}/${name}`);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    text = await r.text();
  }
  const list = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  cache.set(name, list);
  return list;
}

const readJson = (f) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));
const writeJson = (f, v) => writeFileSync(join(DATA, f), `${JSON.stringify(v, null, 1)}\n`);
// a line that is no place name: empty, a row of dashes, or a template with text variables ("<player>'s <place>")
const usable = (s) => !!s && !s.includes('\\') && !/^[-－—\s]+$/.test(s);

/** `entry` with the names of line `i` of the lists in every language: en, de, es, fr, it first, then its other keys. */
function withNames(entry, i, lists) {
  const rest = Object.fromEntries(Object.entries(entry).filter(([k]) => k !== 'en' && !LANGS.includes(k)));
  const out = { en: entry.en };
  for (const l of LANGS) {
    const name = lists[l][i];
    if (usable(name) && name !== entry.en) out[l] = name;
  }
  return { ...out, ...rest };
}

/** The lists of one set and offset in English and every language. */
async function listsOf(gen, set, offset) {
  const out = { en: await lines(gen, set, offset, 'en') };
  for (const l of LANGS) out[l] = await lines(gen, set, offset, l);
  return out;
}

/** Adds the languages to an existing table ({ map: { id: { en, … } } }); `offsets` = the PKHeX files, highest first. */
async function extend(file, gen, set, offsets = [0]) {
  const json = readJson(file);
  for (const [id, entry] of Object.entries(json.map)) {
    const off = offsets.find((o) => Number(id) >= o);
    const lists = await listsOf(gen, set, off);
    const i = Number(id) - off;
    if (lists.en[i] !== entry.en) throw new Error(`${file} ${id}: "${entry.en}" is "${lists.en[i]}" in PKHeX`);
    json.map[id] = withNames(entry, i, lists);
  }
  writeJson(file, json);
  return json;
}

/** Writes a table whole from the PKHeX lists (every usable line is a place). */
async function build(file, gen, set, offsets, head) {
  const map = {};
  for (const off of [...offsets].sort((a, b) => a - b)) {
    const lists = await listsOf(gen, set, off);
    lists.en.forEach((en, i) => {
      if (usable(en)) map[String(off + i)] = withNames({ en }, i, lists);
    });
  }
  writeJson(file, { ...head, map });
  return { map };
}

const SPECIAL = [60000, 40000, 30000, 0];
const loc2 = await extend('locations_gen2_crystal.json', 2, 'gsc');
const loc3 = await extend('locations_gen3.json', 3, 'rsefrlg');
await extend('locations_gen6.json', 6, 'xy', SPECIAL);
await extend('locations_gen7.json', 7, 'sm', SPECIAL);
await build('locations_gen4.json', 4, 'hgss', [0, 2000, 3000], {
  _doc: 'Gen 4 met / egg location (PK4 0x80 / 0x7E, Platinum and HeartGold/SoulSilver also 0x46 / 0x44) -> name in every language of the app. Diamond/Pearl, Platinum and HeartGold/SoulSilver share the list: 0-111 Sinnoh, 112-125 Platinum, 126-234 Johto/Kanto. 2000s: trades, gifts and transfers, 3000s: event places. The English names equal gen4.json locations / locationsSpecial (which the save reader uses).',
  _source: 'PKHeX PKHeX.Core/Resources/text/locations/gen4/text_hgss_{00000,02000,03000}_{en,de,es,fr,it}.txt (line index = id offset). Written by scripts/build-location-names.mjs.',
});
await build('locations_gen5.json', 5, 'bw2', SPECIAL, {
  _doc: 'Gen 5 met / egg location (PK5 0x80 / 0x7E) -> name in every language of the app. Black/White and Black 2/White 2 share the list. 30000s: link trades and transfers, 40000s: event places, 60000s: eggs.',
  _source: 'PKHeX PKHeX.Core/Resources/text/locations/gen5/text_bw2_{00000,30000,40000,60000}_{en,de,es,fr,it}.txt (line index = id offset). Written by scripts/build-location-names.mjs.',
});

// The English names equal gen4.json's (what the save reader and older code show): a difference would rename places
const g4 = readJson('gen4.json');
const loc4 = readJson('locations_gen4.json').map;
g4.locations.forEach((en, i) => {
  if (usable(en) && loc4[i]?.en !== en) throw new Error(`gen4.json locations ${i}: "${en}" is "${loc4[i]?.en}" in PKHeX`);
});

// Gen 1 town map: the same place in FireRed/LeafGreen (else Crystal), without PKHeX's "(Kanto)" / "(Routes 5-6)" notes
const ALIAS = { 'Rocket HQ': 'Rocket Hideout' };
const bare = (s) => s.replace(/\s*\([^)]*\)$/, '');
const kanto = [...Object.values(loc3.map), ...Object.values(loc2.map)];
const maps = readJson('maps.json');
const missing = [];
for (const [id, entry] of Object.entries(maps.gen1Locations)) {
  const sea = /^Sea (Route \d+)$/.exec(entry.en); // the town map's "Sea Route 19": Route 19 everywhere else
  const want = (sea ? sea[1] : ALIAS[entry.en] || entry.en).toLowerCase();
  const hit = kanto.find((e) => e.en.toLowerCase() === want) || kanto.find((e) => bare(e.en).toLowerCase() === want);
  if (!hit) {
    missing.push(entry.en);
    continue;
  }
  const { en, de, ...rest } = entry;
  const out = { en, de };
  for (const l of LANGS) {
    if (l === 'de' && de) continue; // (the German town-map names are the game's own already)
    const v = hit[l] ? bare(hit[l]) : '';
    if (v && v !== en) out[l] = v;
  }
  maps.gen1Locations[id] = { ...out, ...rest };
}
writeJson('maps.json', maps);
if (missing.length) console.log(`Gen 1 places without a translation (English stays): ${missing.join(', ')}`);
console.log('location names written');
