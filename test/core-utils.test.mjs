import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identifyRom, matchCatalog } from '../shared/romid.mjs';
import { t, ago, setLang, currentLang } from '../web/lib/i18n.mjs';

// ---- ROM identification from the cartridge header ------------------------------------------------

const ascii = (u8, at, s) => [...s].forEach((c, i) => { u8[at + i] = c.charCodeAt(0); });

function gbHeader({ title, cgb = 0, manufacturer = '' }) {
  const h = new Uint8Array(0x200);
  [0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b].forEach((b, i) => { h[0x104 + i] = b; }); // Nintendo logo start
  ascii(h, 0x134, title);
  if (manufacturer) ascii(h, 0x13f, manufacturer);
  h[0x143] = cgb;
  h[0x14c] = 1;
  return h;
}

test('identifyRom: Game Boy, Game Boy Color (CGB flag), GBA and DS headers', () => {
  assert.deepEqual(identifyRom(gbHeader({ title: 'POKEMON RED' })), { system: 'gb', title: 'POKEMON RED', code: '', version: 1 });
  // a CGB cart ends its title at 0x13F – the four bytes after it are the manufacturer code
  assert.deepEqual(identifyRom(gbHeader({ title: 'POKEMON_SLV', cgb: 0x80, manufacturer: 'AAXE' })), { system: 'gbc', title: 'POKEMON_SLV', code: 'AAXE', version: 1 });
  // a plain GB header in a .gbc file is taken as GBC (the extension decides for dual carts)
  assert.equal(identifyRom(gbHeader({ title: 'TETRIS' }), '.GBC').system, 'gbc');

  const gba = new Uint8Array(0x200);
  ascii(gba, 0xa0, 'POKEMON EMER');
  ascii(gba, 0xac, 'BPEE');
  gba[0xb2] = 0x96;
  assert.deepEqual(identifyRom(gba), { system: 'gba', title: 'POKEMON EMER', code: 'BPEE', version: 0 });

  const nds = new Uint8Array(0x200);
  ascii(nds, 0, 'POKEMON HG');
  ascii(nds, 0x0c, 'IPKE');
  assert.deepEqual(identifyRom(nds, 'nds'), { system: 'nds', title: 'POKEMON HG', code: 'IPKE', version: 0 });
});

test('identifyRom: no known header → null; control characters are dropped from the title', () => {
  assert.equal(identifyRom(new Uint8Array(0x200)), null);
  assert.equal(identifyRom(new Uint8Array(0x10)), null); // too short for any header
  const h = gbHeader({ title: 'AB\u0001CD' });
  assert.equal(identifyRom(h).title, 'ABCD');
});

test('matchCatalog: CRC wins, then the serial (GBA/DS), then the header title', () => {
  const catalog = { games: [
    { id: 'red', system: 'gb', headerTitle: 'POKEMON RED', crc32: ['9F7FDD53'] },
    { id: 'silver', system: 'gbc', headerTitle: 'POKEMON_SLV' },
    { id: 'emerald', system: 'gba', gameCode: 'BPEE', headerTitle: 'POKEMON EMER' },
  ] };
  assert.deepEqual(matchCatalog({ system: 'gb', title: 'SOMETHING', crc: '9F7FDD53' }, catalog), { game: catalog.games[0], exact: true });
  assert.equal(matchCatalog({ system: 'gba', title: 'HACKED TITLE', code: 'bpee' }, catalog).game.id, 'emerald');
  // a GB-mode read of a GBC game still finds it by title
  assert.deepEqual(matchCatalog({ system: 'gb', title: 'pokemon_slv' }, catalog), { game: catalog.games[1], exact: false });
  assert.equal(matchCatalog({ system: 'nds', title: 'UNKNOWN', code: 'XXXX' }, catalog), null);
  assert.equal(matchCatalog({ system: 'gb', title: 'X' }, null), null);
});

// ---- translations -----------------------------------------------------------------------------

test('t(): English default, {vars} filled, missing vars kept, one|other plurals', () => {
  assert.equal(currentLang(), 'en');
  assert.equal(t('demo.hello', 'Hello {name}', { name: 'Kim' }), 'Hello Kim');
  assert.equal(t('demo.keep', 'Hi {name}, {other}', { name: 'Kim' }), 'Hi Kim, {other}');
  assert.equal(t('demo.zero', '{n} left', { n: 0 }), '0 left');
  assert.equal(t('demo.count', 'one area|{count} areas', { count: 1 }), 'one area');
  assert.equal(t('demo.count', 'one area|{count} areas', { count: 3 }), '3 areas');
  assert.equal(t('demo.nokey'), 'demo.nokey'); // no default: the key itself
});

test('setLang(): loads the dictionary, falls back to the English default per missing key, unknown language → en', async () => {
  const saved = { fetch: globalThis.fetch, document: globalThis.document };
  globalThis.document = { documentElement: {} };
  globalThis.fetch = async (url) => ({ json: async () => (url.endsWith('/de.json') ? { 'demo.hello': 'Hallo {name}' } : {}) });
  try {
    assert.equal(await setLang('de'), 'de');
    assert.equal(t('demo.hello', 'Hello {name}', { name: 'Kim' }), 'Hallo Kim');
    assert.equal(t('demo.only.en', 'Only English'), 'Only English');
    assert.equal(document.documentElement.lang, 'de');
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal(await setLang('fr'), 'fr'); // dictionary unreachable: English defaults, no crash
    assert.equal(t('demo.hello', 'Hello {name}', { name: 'Kim' }), 'Hello Kim');
    assert.equal(await setLang('xx'), 'en');
  } finally {
    await setLang('en');
    globalThis.fetch = saved.fetch;
    globalThis.document = saved.document;
  }
});

test('ago(): nothing → dash, the last few seconds → "just now", then relative units', () => {
  assert.equal(ago(0), '–');
  assert.equal(ago(Date.now() - 3000), 'just now');
  assert.match(ago(Date.now() - 5 * 60 * 1000), /5 minutes ago/);
  assert.match(ago(Date.now() - 3 * 3600 * 1000), /3 hours ago/);
  assert.match(ago(Date.now() - 2 * 86400 * 1000), /2 days ago/);
});

// ---- server errors in the player's language ----------------------------------------------------

test('serverErrorText: known code → translated text with vars, unknown code → the server’s message, nothing → HTTP status', async () => {
  const { serverErrorText } = await import('../web/lib/errors.mjs');
  assert.equal(serverErrorText({ code: 'runNotFound', error: 'Run nicht gefunden' }, 404), 'Run not found');
  assert.equal(serverErrorText({ code: 'presetLimit', vars: { max: 30 }, error: 'Höchstens 30 Presets möglich' }), 'At most 30 presets');
  assert.equal(serverErrorText({ code: 'somethingNew', error: 'Neuer Fehler' }, 400), 'Neuer Fehler');
  assert.equal(serverErrorText({}, 502), 'HTTP 502');
});

test('every error code the server sends has a text in the UI', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { serverErrorText } = await import('../web/lib/errors.mjs');
  const dir = new URL('../server/', import.meta.url);
  const files = ['app.mjs', ...readdirSync(new URL('lib/', dir)).filter((f) => f.endsWith('.mjs')).map((f) => `lib/${f}`)];
  const codes = new Set();
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/httpError\(\d+, (?:'[^']*'|`[^`]*`), '([A-Za-z]+)'/g)) codes.add(m[1]);
    for (const m of src.matchAll(/error: '[^']*', code: '([A-Za-z]+)'/g)) codes.add(m[1]);
  }
  assert.ok(codes.size > 30, `found only ${codes.size} codes – did the pattern break?`);
  for (const code of codes) assert.notEqual(serverErrorText({ code, error: '__fallback__' }), '__fallback__', `no UI text for ${code}`);
});
