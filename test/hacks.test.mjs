// ROM hacks in the catalog: a patch file is linked to the right hack (the longest name that fits wins), and what the
// library says about live tracking (catalog `live` / `liveNote`) is one of the states the hack details can show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';

// the server modules read their data directory at import time → a scratch dir first
const DATA = mkdtempSync(join(tmpdir(), 'sls-hacks-'));
process.env.SLS_DATA_DIR = DATA;
const { scanLibrary } = await import('../server/lib/library.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const catalog = JSON.parse(readFileSync(new URL('../shared/data/catalog.json', import.meta.url), 'utf8'));
const i18n = (lang) => JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));

test('a patch is linked to the hack with the longest fitting name (Too Many Types 2)', () => {
  const dir = join(DATA, 'Patches');
  mkdirSync(dir, { recursive: true });
  const ips = Buffer.from('PATCHEOF', 'latin1'); // an empty IPS patch
  const files = {
    'Pokemon Too Many Types v1.6.ips': 'too-many-types',
    'Too Many Types 2 v1.5.3.ips': 'too-many-types-2',
    'Pokemon Run&Bun 1.07.ips': 'run-and-bun',
  };
  for (const f of Object.keys(files)) writeFileSync(join(dir, f), ips);
  const res = scanLibrary({ libraryFolders: [dir] });
  const got = Object.fromEntries(res.patches.map((p) => [`${p.name}`, p.hackId]));
  for (const [f, id] of Object.entries(files)) assert.equal(got[f.replace(/\.ips$/, '')] ?? got[f], id, f);
});

test('catalog: the live-tracking state of a hack is one the library can show, in every language', () => {
  const states = ['yes', 'partial', 'untested', 'no'];
  const keyOf = { yes: 'lib.liveYes', partial: 'lib.livePartial', untested: 'lib.liveUntested', no: 'lib.liveNo' };
  const langs = ['en', 'de', 'es', 'fr', 'it'].map((l) => [l, i18n(l)]);
  const withLive = catalog.hacks.filter((h) => h.live);
  assert.ok(withLive.some((h) => h.id === 'run-and-bun'));
  for (const id of ['too-many-types', 'too-many-types-2']) assert.ok(catalog.hacks.some((h) => h.id === id), id);
  for (const h of withLive) {
    assert.ok(states.includes(h.live), `${h.id}: ${h.live}`);
    for (const [l, d] of langs) {
      assert.ok(d[keyOf[h.live]], `${l}: ${keyOf[h.live]}`);
      if (h.liveNote) assert.ok(d[`lib.liveNote.${h.liveNote}`], `${l}: lib.liveNote.${h.liveNote} (${h.id})`);
    }
  }
});

test('the species picker of a run offers every Pokémon its game holds (Run & Bun’s Sinnoh starters, a hack’s own creatures)', async () => {
  // web/lib/data.mjs imports browser paths (/shared/…): map them onto the project folder
  const ROOT = new URL('../', import.meta.url).href;
  registerHooks({ resolve: (spec, ctx, next) => (spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx)) });
  const { RunData, FAKEMON } = await import('../web/lib/data.mjs');
  const rd = new RunData();
  rd.gen = 3;
  assert.equal(rd.maxSpecies(), 386, 'a retail GBA game: Gen 1–3');
  assert.deepEqual(rd.ownSpecies(), []);
  // Run & Bun: species by name in National Dex order – Chimchar (#390) and everything up to Gen 8
  rd.romSpecies = { engine: 'expanded', map: Object.assign([0], { 390: 390, 905: 905, 1100: 263 }), unknown: {} };
  assert.equal(rd.maxSpecies(), 905);
  // a hack's own creatures (names the base game doesn't know) are offered under the game's names
  rd.romSpecies = { engine: 'vanilla', map: [0, 0, 152], unknown: { 1: 'Goomba' } };
  assert.equal(rd.maxSpecies(), 386);
  assert.deepEqual(rd.ownSpecies(), [FAKEMON + 1]);
  // a randomized run: its Pokémon list counts too
  const rd4 = new RunData();
  rd4.gen = 4;
  rd4.byId = { p1: new Map([[1, {}], [600, {}]]) };
  assert.equal(rd4.maxSpecies(), 600);
});
