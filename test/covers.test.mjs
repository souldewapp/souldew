// The player's own cover pictures (server/lib/covers.mjs, /api/library/cover): only real images, at most 4 MB,
// stored under a hash of the entry id – never under a name taken from the request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'sls-covers-'));
process.env.SLS_DATA_DIR = DATA;
const { imageKind, COVERS_DIR, customCovers } = await import('../server/lib/covers.mjs');
const { startServer } = await import('../server/app.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([60, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(52, 3)]);

async function withServer(fn) {
  const { server, url } = await startServer({ port: 0, background: false });
  const log = console.error;
  console.error = () => {}; // every refused request is logged by the server – expected here
  try {
    return await fn(url);
  } finally {
    console.error = log;
    server.closeAllConnections();
    server.close();
  }
}
const put = (url, id, body, headers = {}) => fetch(`${url}/api/library/cover?id=${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'x-soullink': '1', ...headers }, body });
const get = (url, id) => fetch(`${url}/api/library/cover?id=${encodeURIComponent(id)}`);
const del = (url, id) => fetch(`${url}/api/library/cover?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'x-soullink': '1' } });

test('image formats are recognised by their first bytes only', () => {
  assert.equal(imageKind(PNG), 'png');
  assert.equal(imageKind(JPEG), 'jpg');
  assert.equal(imageKind(WEBP), 'webp');
  assert.equal(imageKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(imageKind(Buffer.from('GIF89a......')), null);
  assert.equal(imageKind(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])), null, 'a WAV is RIFF too');
  assert.equal(imageKind(Buffer.alloc(0)), null);
});

test('upload, serve with the right type, list with a cache-buster, replace, delete', async () => {
  await withServer(async (url) => {
    let r = await put(url, 'hack:radical-red', PNG);
    assert.equal(r.status, 200);
    const { url: first } = await r.json();
    assert.match(first, /^\/api\/library\/cover\?id=hack%3Aradical-red&v=\d+$/);

    r = await get(url, 'hack:radical-red');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);

    // the library listing names it (games and hacks by catalog id)
    let lib = await (await fetch(`${url}/api/library`)).json();
    assert.equal(lib.customCovers['hack:radical-red'], first);
    assert.equal(lib.customCovers['game:pokemon-red'], undefined);

    // a JPEG replaces the PNG: one file per entry, new type, new url
    await new Promise((res) => setTimeout(res, 20));
    r = await put(url, 'hack:radical-red', JPEG);
    const { url: second } = await r.json();
    assert.notEqual(second, first, 'the cache-buster changes');
    assert.equal(readdirSync(COVERS_DIR).length, 1);
    r = await get(url, 'hack:radical-red');
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.equal((await put(url, 'game:pokemon-green-jp', WEBP)).status, 200);
    assert.equal((await get(url, 'game:pokemon-green-jp')).headers.get('content-type'), 'image/webp');

    r = await del(url, 'hack:radical-red');
    assert.deepEqual(await r.json(), { removed: true });
    assert.equal((await get(url, 'hack:radical-red')).status, 404);
    assert.equal((await (await get(url, 'hack:radical-red')).json()).code, 'noCover');
    assert.deepEqual(await (await del(url, 'hack:radical-red')).json(), { removed: false });
    lib = await (await fetch(`${url}/api/library`)).json();
    assert.equal(lib.customCovers['hack:radical-red'], undefined);
    assert.ok(lib.customCovers['game:pokemon-green-jp']);
  });
});

test('ROMs the catalog does not know get theirs by CRC – on the ROM entry too', async () => {
  const lib = join(DATA, 'Library');
  mkdirSync(lib, { recursive: true });
  const rom = Buffer.alloc(0x8000);
  rom.write('HOMEBREW', 0x134, 'ascii');
  writeFileSync(join(lib, 'Fake.gb'), rom);
  await withServer(async (url) => {
    let listing = await (await fetch(`${url}/api/library`)).json();
    const r = listing.roms.find((x) => x.name === 'Fake.gb');
    assert.match(r.coverId, /^rom:[0-9A-F]{8}$/);
    assert.equal(r.customCover, null);
    assert.equal((await put(url, r.coverId, PNG)).status, 200);
    listing = await (await fetch(`${url}/api/library`)).json();
    const again = listing.roms.find((x) => x.name === 'Fake.gb');
    assert.equal(again.customCover, listing.customCovers[r.coverId]);
    assert.ok(again.customCover);
  });
});

test('only real images, at most 4 MB, never empty', async () => {
  await withServer(async (url) => {
    const svg = await put(url, 'game:pokemon-red', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { 'content-type': 'image/png' });
    assert.equal(svg.status, 415);
    assert.equal((await svg.json()).code, 'coverType');
    const html = await put(url, 'game:pokemon-red', Buffer.from('<html>'));
    assert.equal((await html.json()).code, 'coverType');
    const empty = await put(url, 'game:pokemon-red', Buffer.alloc(0));
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).code, 'emptyFile');
    const big = await put(url, 'game:pokemon-red', Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]));
    assert.equal(big.status, 413);
    assert.equal((await big.json()).code, 'coverTooLarge');
    assert.equal(existsSync(COVERS_DIR) ? readdirSync(COVERS_DIR).filter((n) => /^[0-9a-f]{24}\./.test(n)).every((n) => !n.endsWith('.tmp')) : true, true);
    assert.equal((await get(url, 'game:pokemon-red')).status, 404, 'nothing was stored');
  });
});

test('path safety: the id is checked and hashed, it never names a file', async () => {
  await withServer(async (url) => {
    for (const id of ['../../config', '..%2F..%2Fx', 'game:../../x', 'game:Pokemon Red', 'rom:../../etc/passwd', 'rom:12345', '/etc/passwd', 'game:', '', 'x'.repeat(300)]) {
      const r = await put(url, id, PNG);
      assert.equal(r.status, 400, id);
      assert.equal((await r.json()).code, 'badCoverId', id);
      assert.equal((await get(url, id)).status, 400, id);
      assert.equal((await del(url, id)).status, 400, id);
    }
    const r = await fetch(`${url}/api/library/cover`, { method: 'PUT', headers: { 'x-soullink': '1' }, body: PNG });
    assert.equal(r.status, 400, 'no id at all');
    assert.ok(!existsSync(join(DATA, 'config.png')) && !existsSync(join(DATA, 'config')));
    for (const n of existsSync(COVERS_DIR) ? readdirSync(COVERS_DIR) : []) assert.match(n, /^[0-9a-f]{24}\.(png|jpg|webp)$/);
    assert.deepEqual(customCovers(['../x', 'game:../x']), {});
  });
});

test('writing needs the app header; other sites cannot read the pictures', async () => {
  await withServer(async (url) => {
    const noHeader = await fetch(`${url}/api/library/cover?id=game:pokemon-red`, { method: 'PUT', body: PNG });
    assert.equal(noHeader.status, 403);
    const noHeaderDel = await fetch(`${url}/api/library/cover?id=game:pokemon-red`, { method: 'DELETE' });
    assert.equal(noHeaderDel.status, 403);
    const cross = await fetch(`${url}/api/library/cover?id=game:pokemon-red`, { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(cross.status, 403);
  });
});
