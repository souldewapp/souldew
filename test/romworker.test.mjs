// The ROM's data (place names, species, types, level caps …) is computed in a worker thread: a big ROM takes seconds the
// first time, and the server – in the app it shares Electron's main thread – must keep answering meanwhile. A scan that
// fails or takes too long is "unknown" and is tried again next time; a finished one comes from the disk cache after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'sls-romworker-'));
process.env.SLS_DATA_DIR = DATA;
process.env.SLS_ROMDATA_TEST_DELAY_MS = '1200'; // every scan takes a while (romdata-worker.mjs)
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const { startServer } = await import('../server/app.mjs');
const { runDir } = await import('../server/lib/build.mjs');
const { romDataFor, ROMDATA_NONE } = await import('../server/lib/romloc.mjs');
const { SHARED_DIR, CACHE_DIR } = await import('../server/lib/paths.mjs');

/** A small GBA ROM: header only – nothing to find in it, but a scan all the same. */
function writeRom(dir, name, fill = 0) {
  mkdirSync(dir, { recursive: true });
  const rom = new Uint8Array(0x40000).fill(fill);
  rom[3] = 0xea;
  rom[0xb2] = 0x96;
  rom.set([...'BPRE'].map((c) => c.charCodeAt(0)), 0xac);
  writeFileSync(join(dir, name), rom);
  return join(dir, name);
}

test('a request is answered while a ROM is being scanned; the scan\'s result arrives after, then comes from the cache', async () => {
  const { server, url } = await startServer({ port: 0, background: false });
  try {
    writeRom(runDir('abcdef12'), 'rom.gba');
    const src = encodeURIComponent('/api/runs/abcdef12/file?name=rom.gba');
    const t0 = Date.now();
    let scanAt = 0;
    const scan = fetch(`${url}/api/rom/locations?src=${src}`).then(async (r) => {
      scanAt = Date.now();
      return { status: r.status, body: await r.json() };
    });
    await new Promise((r) => setTimeout(r, 150));
    const status = await fetch(`${url}/api/status`);
    const statusAt = Date.now();
    assert.equal(status.status, 200);
    assert.ok(statusAt - t0 < 1000, `the other request waited ${statusAt - t0} ms`);
    const res = await scan;
    assert.ok(scanAt > statusAt, 'answered while the scan was still running');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), Object.keys(ROMDATA_NONE).sort());
    assert.equal(res.body.header.system, 'gba', 'the scan\'s own result');
    assert.ok(scanAt - t0 >= 1100);
    // the same ROM again: from memory, no second scan
    const t1 = Date.now();
    await fetch(`${url}/api/rom/locations?src=${src}`).then((r) => r.json());
    assert.ok(Date.now() - t1 < 500);
    assert.ok(readdirSync(join(CACHE_DIR, 'romloc')).length >= 1, 'written to the disk cache');
  } finally {
    server.close();
  }
});

test('a scan that takes too long gives "unknown" – remembered in memory only, scanned again once the file changes; two requests share one scan', async () => {
  const dir = join(DATA, 'roms');
  const file = writeRom(dir, 'slow.gba', 1);
  const before = existsSync(join(CACHE_DIR, 'romloc')) ? readdirSync(join(CACHE_DIR, 'romloc')).length : 0;
  const r = await romDataFor({ file }, { sharedDir: SHARED_DIR, cacheDir: CACHE_DIR, timeoutMs: 200 });
  assert.deepEqual(r, { ...ROMDATA_NONE });
  const after = existsSync(join(CACHE_DIR, 'romloc')) ? readdirSync(join(CACHE_DIR, 'romloc')).length : 0;
  assert.equal(after, before, 'nothing written for a scan that didn\'t finish');
  // the same file again: "unknown" at once (a damaged file isn't scanned on every click)
  const t0 = Date.now();
  assert.deepEqual(await romDataFor({ file }, { sharedDir: SHARED_DIR, cacheDir: CACHE_DIR }), { ...ROMDATA_NONE });
  assert.ok(Date.now() - t0 < 300);
  // the file changed: the worker (ended after the timeout) is started anew and gives the real result
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const [a, b] = await Promise.all([romDataFor({ file }, { sharedDir: SHARED_DIR, cacheDir: CACHE_DIR }), romDataFor({ file }, { sharedDir: SHARED_DIR, cacheDir: CACHE_DIR })]);
  assert.equal(a.header.system, 'gba');
  assert.equal(a, b, 'one scan for both');
  // a file that can't be read: "unknown", no throw
  assert.deepEqual(await romDataFor({ file: join(dir, 'missing.gba') }, { sharedDir: SHARED_DIR, cacheDir: CACHE_DIR }), { ...ROMDATA_NONE });
});
