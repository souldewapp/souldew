// Server robustness: damaged run files, doc merging on upload, failed builds, upload names and streaming,
// odd zip entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { crc32 } from '../shared/checksum.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'sls-fix-'));
process.env.SLS_DATA_DIR = DATA;
const { listRuns, readManifest, runSummary, mergeDocEntries, buildRun } = await import('../server/lib/build.mjs');
const { uploadTarget, scanLibrary, resolveId } = await import('../server/lib/library.mjs');
const { readDoc, streamToFile } = await import('../server/app.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const quiet = async (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
};

test('run.json that is not an object, or names another id, cannot break the run list', async () => {
  const put = (id, text) => {
    mkdirSync(join(DATA, 'runs', id), { recursive: true });
    writeFileSync(join(DATA, 'runs', id, 'run.json'), text);
  };
  put('11111111', '{}'); // no id at all – used to reach runDir(undefined) in /api/status
  put('22222222', '[]');
  put('33333333', 'null');
  put('44444444', JSON.stringify({ id: '99999999', game: { id: 'x' } })); // copied folder
  put('55555555', JSON.stringify({ id: '55555555', game: { id: 'x' }, updatedAt: '2026-01-01' }));
  const runs = await quiet(() => listRuns());
  assert.deepEqual(runs.map((m) => m.id).sort(), ['11111111', '44444444', '55555555']);
  // what /api/status does for every run
  for (const m of runs) assert.equal(typeof runSummary(m.id).alive, 'number');
  assert.equal(readManifest('44444444').id, '44444444');
  assert.throws(() => readManifest('22222222'), /kein Objekt/);
});

test('doc upload merges per key: newer wins, an older upload cannot roll entries back', () => {
  const stored = { a: { v: 1, t: 10, by: 'x' }, b: { v: 'keep', t: 50, by: 'x' }, c: { v: null, t: 30, by: 'y' } };
  const incoming = { a: { v: 2, t: 20, by: 'x' }, b: { v: 'stale', t: 40, by: 'x' }, d: { v: 4, t: 1, by: 'z' }, bad: { v: 1 }, ['__proto__']: { v: 1, t: 99 } };
  const m = mergeDocEntries(stored, JSON.parse(JSON.stringify(incoming)));
  assert.deepEqual(m.a, { v: 2, t: 20, by: 'x' });
  assert.equal(m.b.v, 'keep');
  assert.deepEqual(m.c, { v: null, t: 30, by: 'y' }); // tombstones stay
  assert.equal(m.d.v, 4);
  assert.ok(!('bad' in m));
  assert.equal(Object.getPrototypeOf(m), Object.prototype);
  assert.ok(!Object.hasOwn(m, '__proto__'));
  // equal timestamps: the device id decides, like web/lib/doc.mjs
  assert.equal(mergeDocEntries({ k: { v: 1, t: 5, by: 'a' } }, { k: { v: 2, t: 5, by: 'b' } }).k.v, 2);
  assert.equal(mergeDocEntries({ k: { v: 1, t: 5, by: 'b' } }, { k: { v: 2, t: 5, by: 'a' } }).k.v, 1);
  assert.deepEqual(mergeDocEntries(null, { k: { v: 1, t: 1, by: '' } }), { k: { v: 1, t: 1, by: '' } });
});

test('a damaged doc.json reads as null and is kept as a copy', async () => {
  const dir = join(DATA, 'runs', '66666666');
  mkdirSync(dir, { recursive: true });
  assert.equal(readDoc('66666666'), null); // none yet
  writeFileSync(join(dir, 'doc.json'), '{"a":{"v":1,"t":');
  assert.equal(await quiet(() => readDoc('66666666')), null);
  assert.ok(readdirSync(dir).some((n) => n.startsWith('doc.json.corrupt-')));
  writeFileSync(join(dir, 'doc.json'), '{"a":{"v":1,"t":2,"by":"x"}}');
  assert.deepEqual(readDoc('66666666'), { a: { v: 1, t: 2, by: 'x' } });
});

test('a new run that fails to build leaves no folder behind; an imported run keeps its folder', async () => {
  const before = readdirSync(join(DATA, 'runs')).sort();
  await assert.rejects(buildRun({ romId: join(DATA, 'Library', 'missing.nds'), buildFor: ['p1'], config: {} }));
  assert.deepEqual(readdirSync(join(DATA, 'runs')).sort(), before);
  const id = '77777777';
  mkdirSync(join(DATA, 'runs', id), { recursive: true });
  writeFileSync(join(DATA, 'runs', id, 'run.json'), JSON.stringify({ id, imported: true, game: { id: 'x' } }));
  await assert.rejects(buildRun({ identity: { id, room: 'r', secret: 's' }, romId: join(DATA, 'Library', 'missing.nds'), buildFor: ['p2'], config: {} }));
  assert.ok(existsSync(join(DATA, 'runs', id, 'run.json')));
});

test('upload names are safe on every platform', () => {
  const name = (n) => uploadTarget(n).split(/[\\/]/).pop();
  assert.equal(name('../../evil.nds'), 'evil.nds');
  assert.equal(name('C:\\Users\\me\\Pokémon.nds'), 'Pokémon.nds');
  assert.equal(name('Poke\u0301mon.gba'), 'Pokémon.gba'); // NFD from macOS → NFC
  assert.equal(name('a:b*c?.gb'), 'a_b_c_.gb');
  assert.equal(name('tab\there.gbc'), 'tab_here.gbc');
  assert.equal(name('CON.nds'), '_CON.nds');
  assert.equal(name('.hidden.zip'), '_hidden.zip');
  const long = name(`${'ü'.repeat(300)}.nds`);
  assert.ok(Buffer.byteLength(long) <= 200 && long.endsWith('.nds'));
  assert.throws(() => uploadTarget('notes.txt'), (e) => e.status === 400);
  assert.equal(name('game.nds. '), 'game.nds'); // Windows drops trailing dots / spaces
});

test('uploads stream to disk with a size limit and leave no temp file on failure', async () => {
  const dir = join(DATA, 'up');
  mkdirSync(dir);
  const req = (chunks, headers = {}) => Object.assign(Readable.from(chunks.map((c) => Buffer.from(c))), { headers });
  await streamToFile(req(['abc', 'def']), join(dir, 'ok.gba'), 10);
  assert.equal(readFileSync(join(dir, 'ok.gba'), 'utf8'), 'abcdef');
  await assert.rejects(streamToFile(req(['123456', '789012']), join(dir, 'big.gba'), 10), (e) => e.status === 413);
  await assert.rejects(streamToFile(req(['x'], { 'content-length': '999' }), join(dir, 'big2.gba'), 10), (e) => e.status === 413);
  await assert.rejects(streamToFile(req([]), join(dir, 'empty.gba'), 10), (e) => e.status === 400);
  await assert.rejects(streamToFile(req(['abc']), join(dir, 'no', 'such', 'dir.gba'), 10));
  assert.deepEqual(readdirSync(dir), ['ok.gba']);
});

const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name);
    const crc = le(crc32(data));
    const head = Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...crc, ...le(data.length), ...le(data.length), n.length, 0, 0, 0]);
    local.push(head, n, Buffer.from(data));
    central.push(Buffer.from([0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...crc, ...le(data.length), ...le(data.length),
      n.length, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le(offset)]), n);
    offset += head.length + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, entries.length, 0, entries.length, 0, ...le(cd.length), ...le(offset), 0, 0]);
  return Buffer.concat([...local, cd, eocd]);
}

test('zip scan skips macOS resource forks, names Windows-style entries by their file name, ids may contain ::', () => {
  const lib = join(DATA, 'Library');
  mkdirSync(lib, { recursive: true });
  const gba = new Uint8Array(0x200);
  gba[0xb2] = 0x96;
  writeFileSync(join(lib, 'mac.zip'), makeZip([
    { name: '__MACOSX/._good.gba', data: new Uint8Array(0x200) },
    { name: '._other.gba', data: new Uint8Array(0x200) },
    { name: 'dir\\win.gba', data: gba },
    { name: 'odd::name.gba', data: gba },
  ]));
  const res = scanLibrary({});
  const fromZip = res.roms.filter((r) => r.container === 'mac.zip');
  assert.deepEqual(fromZip.map((r) => r.name).sort(), ['odd::name.gba', 'win.gba']);
  const odd = fromZip.find((r) => r.name === 'odd::name.gba');
  assert.equal(resolveId(odd.id).entry, 'odd::name.gba');
});

test('config: theme and controller settings are stored only in a valid shape', async () => {
  const { startServer } = await import('../server/app.mjs');
  const { server, url } = await startServer({ port: 0, background: false }); // no sprite downloads, no bridge port
  const post = (body) => fetch(`${url}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    let c = await post({ theme: 'deutan', pads: { preset: 'xbox', map: { a: 'BUTTON_4' } } });
    assert.equal(c.theme, 'deutan');
    assert.deepEqual(c.pads, { preset: 'xbox', map: { a: 'BUTTON_4' } });
    c = await post({ theme: '"><script>', pads: { preset: 'evil', map: { a: '<img onerror=1>' } } });
    assert.equal(c.theme, 'deutan', 'an unknown scheme is ignored');
    assert.deepEqual(c.pads, { preset: 'xbox', map: { a: 'BUTTON_4' } }, 'a bad controller map is ignored');
    assert.equal(c.speedGuard, undefined, 'stepping down is off unless switched on');
    c = await post({ speedGuard: 'yes' });
    assert.equal(c.speedGuard, false, 'only a real true switches it on');
    c = await post({ speedGuard: true });
    assert.equal(c.speedGuard, true);
    assert.equal(c.turboMax, undefined, 'the "Max" turbo step is off unless switched on');
    c = await post({ turboMax: 1 });
    assert.equal(c.turboMax, false, 'only a real true adds it');
    c = await post({ turboMax: true });
    assert.equal(c.turboMax, true);
    c = await post({ pads: { map: { a: 'BUTTON_2', 'x-y': 'BUTTON_1' } } });
    assert.deepEqual(c.pads, { map: { a: 'BUTTON_2' } }, 'odd button names are dropped');
  } finally {
    server.closeAllConnections(); // fetch keeps the connection alive – close() alone would wait for it
    server.close();
  }
});

test('search this Mac: finds ROMs in the usual folders (also inside zips), skips app bundles, marks what the library has', async () => {
  const { discoverRoms } = await import('../server/lib/library.mjs');
  const home = mkdtempSync(join(tmpdir(), 'sls-home-'));
  const gb = (title) => {
    const b = Buffer.alloc(0x8000);
    Buffer.from([0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b]).copy(b, 0x104);
    b.write(title, 0x134, 'ascii');
    return b;
  };
  mkdirSync(join(home, 'Downloads', 'old stuff', 'deeper'), { recursive: true });
  mkdirSync(join(home, 'Desktop', 'Emu.app', 'Contents'), { recursive: true });
  writeFileSync(join(home, 'Downloads', 'Pokemon Red.gb'), gb('POKEMON RED'));
  writeFileSync(join(home, 'Downloads', 'old stuff', 'deeper', 'blue.gb'), gb('POKEMON BLUE'));
  writeFileSync(join(home, 'Downloads', 'notes.txt'), 'not a rom');
  writeFileSync(join(home, 'Desktop', 'Emu.app', 'Contents', 'bundled.gb'), gb('POKEMON GREEN')); // inside an app – never looked at
  try {
    const roots = [join(home, 'Downloads'), join(home, 'Desktop')];
    const known = [{ system: 'gb', title: 'POKEMON BLUE', code: '', size: 0x8000 }];
    const r = discoverRoms({ roots, known });
    const byTitle = Object.fromEntries(r.found.map((f) => [f.title, f]));
    assert.deepEqual(Object.keys(byTitle).sort(), ['POKEMON BLUE', 'POKEMON RED']);
    assert.equal(byTitle['POKEMON RED'].gameId, 'pokemon-red');
    assert.equal(byTitle['POKEMON RED'].inLibrary, false);
    assert.equal(byTitle['POKEMON BLUE'].inLibrary, true, 'already in the library');
    assert.equal(r.found[0].title, 'POKEMON RED', 'new, recognised games first');
    assert.equal(r.truncated, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
