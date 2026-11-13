// Paths derived from a run's files stay inside the run's folder (#20): the containment helpers in
// server/lib/fsutil.mjs (names and links) and every server route that builds a path from run.json's outputs or a
// file name in the URL – with a damaged / hand-edited run.json and a link that points out of the folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { safeJoin, realInside, realPathOf } from '../server/lib/fsutil.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'sls-runpaths-'));
process.env.SLS_DATA_DIR = DATA;
const { startServer, defaultSavePath, runPath } = await import('../server/app.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

/** Symbolic links need extra rights on Windows – those checks are skipped where they can't be made. */
function tryLink(target, path, type) {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false;
  }
}

test('safeJoin: names that leave the folder are refused, on POSIX and Windows rules', () => {
  assert.equal(safeJoin('/data/runs/aaaa0001', 'Ana - HG.nds', 'linux'), '/data/runs/aaaa0001/Ana - HG.nds');
  assert.equal(safeJoin('/data/runs/aaaa0001', '', 'linux'), '/data/runs/aaaa0001');
  assert.equal(safeJoin('/data/runs/aaaa0001', 'sub/../x.sav', 'linux'), '/data/runs/aaaa0001/x.sav');
  for (const bad of ['../x.nds', '../../config.json', '../aaaa0001-other/x', 'a/../../x']) {
    assert.equal(safeJoin('/data/runs/aaaa0001', bad, 'linux'), null, bad);
  }
  assert.equal(safeJoin('C:\\Data\\runs\\aaaa0001', '..\\x.nds', 'win32'), null);
  assert.equal(safeJoin('C:\\Data\\runs\\aaaa0001', '../x.nds', 'win32'), null);
  assert.equal(safeJoin('C:\\Data\\runs\\aaaa0001', 'x.nds', 'win32'), 'C:\\Data\\runs\\aaaa0001\\x.nds');
  assert.equal(safeJoin('C:\\Data\\runs\\aaaa0001', null, 'win32'), 'C:\\Data\\runs\\aaaa0001');
});

test('realInside: follows links, and a save not written yet resolves through its folder', () => {
  // a fake file system: /data/runs/r1/link -> /etc, /real is where /data really lives
  const links = { '/data': '/real/data', '/real/data/runs/r1/link': '/etc', '/real/data/runs/r1/link.nds': '/etc/passwd' };
  const exists = new Set(['/', '/real', '/real/data', '/real/data/runs', '/real/data/runs/r1', '/real/data/runs/r1/x.nds', '/etc', '/etc/passwd']);
  const realpath = (p) => {
    let cur = '/';
    for (const part of p.split('/').filter(Boolean)) {
      cur = posix.join(cur, part);
      if (links[cur]) cur = links[cur];
      if (!exists.has(cur)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return cur;
  };
  const opts = { realpath, platform: 'linux' };
  assert.equal(realPathOf('/data/runs/r1/new.sav', opts), '/real/data/runs/r1/new.sav');
  assert.ok(realInside('/data/runs/r1/x.nds', '/data/runs/r1', opts));
  assert.ok(realInside('/data/runs/r1/new.sav', '/data/runs/r1', opts), 'not written yet');
  assert.ok(realInside('/data/runs/r1', '/data/runs/r1', opts), 'the folder itself');
  assert.ok(!realInside('/data/runs/r1/link.nds', '/data/runs/r1', opts), 'a link to a file elsewhere');
  assert.ok(!realInside('/data/runs/r1/link/passwd', '/data/runs/r1', opts), 'through a linked folder');
  assert.ok(!realInside('/data/runs/r1/link/new.sav', '/data/runs/r1', opts), 'a new file in a linked folder');
  const eacces = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  assert.ok(!realInside('/data/runs/r1/x.nds', '/data/runs/r1', { realpath: eacces, platform: 'linux' }), 'unreadable = outside');
  // Windows: case-insensitive, other drives are outside
  const winReal = (p) => p;
  assert.ok(realInside('c:\\data\\RUNS\\r1\\x.nds', 'C:\\Data\\runs\\r1', { realpath: winReal, platform: 'win32' }));
  assert.ok(!realInside('D:\\Data\\runs\\r1\\x.nds', 'C:\\Data\\runs\\r1', { realpath: winReal, platform: 'win32' }));
  assert.equal(win32.basename(realPathOf('C:\\Data\\x.sav', { realpath: winReal, platform: 'win32' })), 'x.sav');
});

test('run outputs: a crafted rom name in run.json cannot reach files outside the run folder', async () => {
  const outside = join(DATA, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.nds'), 'SECRET ROM');
  writeFileSync(join(outside, 'secret.sav'), 'SECRET SAVE');
  const make = (id, outputs, system = 'nds') => {
    mkdirSync(join(DATA, 'runs', id), { recursive: true });
    const manifest = { id, name: 'X', mode: 'nuzlocke', players: { p1: { name: 'Ana' } }, game: { id: 'pokemon-heartgold', system }, outputs, createdAt: '2026-11-01' };
    writeFileSync(join(DATA, 'runs', id, 'run.json'), JSON.stringify(manifest));
    return manifest;
  };
  const crafted = make('bad00001', { p1: { rom: '../../outside/secret.nds', log: '../../outside/secret.sav' } });
  const absolute = make('bad00002', { p1: { rom: join(outside, 'secret.nds') } });
  const ok = make('aaaa0001', { p1: { rom: 'Ana - HeartGold.nds' } });
  writeFileSync(join(DATA, 'runs', 'aaaa0001', 'Ana - HeartGold.nds'), 'ROM');
  writeFileSync(join(DATA, 'runs', 'aaaa0001', 'Ana - HeartGold.sav'), 'SAVE');
  const ctr = make('aaaa0003', { p1: { rom: 'Ana - Sun.3ds' } }, '3ds');
  writeFileSync(join(DATA, 'runs', 'aaaa0003', 'Ana - Sun.3ds'), 'BIG ROM');
  const linked = make('aaaa0002', { p1: { rom: 'link.nds' } });
  const canLink = tryLink(join(outside, 'secret.nds'), join(DATA, 'runs', 'aaaa0002', 'link.nds'), 'file')
    && tryLink(join(outside, 'secret.sav'), join(DATA, 'runs', 'aaaa0002', 'link.sav'), 'file');

  assert.equal(defaultSavePath(crafted, 'p1'), null);
  assert.equal(defaultSavePath(absolute, 'p1') === null || defaultSavePath(absolute, 'p1').startsWith(join(DATA, 'runs', 'bad00002')), true,
    'an absolute name is taken as a name inside the run folder, never as the path it names');
  assert.equal(defaultSavePath(ok, 'p1'), join(DATA, 'runs', 'aaaa0001', 'Ana - HeartGold.sav'));
  assert.equal(defaultSavePath(ctr, 'p1'), null, 'a 3DS ROM is never its own "save"');
  assert.equal(defaultSavePath({ id: 'aaaa0001', outputs: { p1: { rom: 42 } } }, 'p1'), null);
  if (canLink) {
    assert.equal(defaultSavePath(linked, 'p1'), null, 'a save that is a link out of the folder');
    assert.equal(runPath('aaaa0002', 'link.nds'), null);
  }

  const { server, url } = await startServer({ port: 0, background: false });
  const app = { 'x-soullink': '1' };
  try {
    // the run's own files still work
    assert.equal(await (await fetch(`${url}/api/runs/aaaa0001/save/p1`)).text(), 'SAVE');
    assert.equal(await (await fetch(`${url}/api/runs/aaaa0001/file?name=${encodeURIComponent('Ana - HeartGold.nds')}`)).text(), 'ROM');
    assert.equal(await (await fetch(`${url}/api/runs/aaaa0001/download?what=save&slot=p1`)).text(), 'SAVE');

    // crafted names: nothing outside is read or written
    assert.equal((await fetch(`${url}/api/runs/bad00001/save/p1`)).status, 404);
    assert.equal((await fetch(`${url}/api/runs/bad00001/save/p1`, { method: 'PUT', headers: app, body: 'OVERWRITTEN' })).status, 409);
    assert.equal((await fetch(`${url}/api/runs/bad00001/download?what=rom&slot=p1`)).status, 400);
    assert.equal((await fetch(`${url}/api/runs/bad00001/download?what=spoiler&slot=p1`)).status, 400);
    assert.equal((await fetch(`${url}/api/runs/bad00001/download?what=save&slot=p1`)).status, 404);
    assert.ok(!(await (await fetch(`${url}/api/runs/bad00001/log/p1`)).text()).includes('SECRET'));
    assert.equal((await fetch(`${url}/api/runs/bad00001/file?name=${encodeURIComponent('../../outside/secret.nds')}`)).status, 400);
    const launch = await fetch(`${url}/api/emulators/mgba/launch`, { method: 'POST', headers: { ...app, 'content-type': 'application/json' }, body: JSON.stringify({ runId: 'bad00001', slot: 'p1' }) });
    assert.equal(launch.status, 409);
    assert.equal((await launch.json()).code, 'romNotBuilt');
    const reveal = await fetch(`${url}/api/runs/aaaa0001/reveal`, { method: 'POST', headers: { ...app, 'content-type': 'application/json' }, body: JSON.stringify({ file: '../../outside/secret.nds' }) });
    assert.equal(reveal.status, 500);

    // a 3DS run has no battery save: the ROM is neither served nor overwritten as one
    assert.equal((await fetch(`${url}/api/runs/aaaa0003/save/p1`)).status, 404);
    assert.equal((await fetch(`${url}/api/runs/aaaa0003/save/p1`, { method: 'PUT', headers: app, body: 'X' })).status, 409);
    assert.equal(readFileSync(join(DATA, 'runs', 'aaaa0003', 'Ana - Sun.3ds'), 'utf8'), 'BIG ROM');
    assert.equal((await fetch(`${url}/api/runs/aaaa0003/download?what=save&slot=p1`)).status, 404);

    if (canLink) {
      assert.equal((await fetch(`${url}/api/runs/aaaa0002/file?name=link.nds`)).status, 400);
      assert.equal((await fetch(`${url}/api/runs/aaaa0002/download?what=rom&slot=p1`)).status, 400);
      assert.equal((await fetch(`${url}/api/runs/aaaa0002/save/p1`)).status, 404);
      assert.equal((await fetch(`${url}/api/runs/aaaa0002/save/p1`, { method: 'PUT', headers: app, body: 'OVERWRITTEN' })).status, 409);
    }
    assert.equal(readFileSync(join(outside, 'secret.sav'), 'utf8'), 'SECRET SAVE');
    assert.equal(readFileSync(join(outside, 'secret.nds'), 'utf8'), 'SECRET ROM');
    assert.ok(!existsSync(join(DATA, 'secret.sav')));
  } finally {
    server.close();
  }
});
