// Invite files arriving at the import route: anything malformed is a 400 with a translatable code (never a
// 500 or a bare German message), a pack can be imported twice, and the host's own run is not replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'sls-conn-'));
process.env.SLS_DATA_DIR = DATA;
const { startServer } = await import('../server/app.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const pack = (o = {}) => ({
  format: 'soullink-studio/run-pack@1', id: 'a1b2c3d4', name: 'Duo', room: 'room-0123456789', secret: 'SECRET-ROOM-KEY-0f9e8d7c', mode: 'soullink',
  players: { p1: { name: 'Ana' }, p2: { name: 'Ben' } }, base: { crc: 'E25703ED', name: 'Fake.gb' }, patch: null,
  randomizer: { enabled: false, values: {}, seeds: { p1: '1', p2: '2' } }, outputs: { p1: { sha1: 'x' } }, rules: null, game: null, ...o,
});

test('import route: damaged invites get a 400 with a code the app translates; importing twice is fine', async () => {
  const { server, url } = await startServer({ port: 0, background: false });
  const post = async (body) => {
    const r = await fetch(`${url}/api/runs/import`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    for (const body of [{ pack: { ...pack(), format: 'other' } }, { pack: 'hello' }, { pack: null }, { pack: [1] }, {}]) {
      const r = await post(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.code, 'packInvalid');
    }
    for (const id of ['zz', 5, '../../etc', 'A1B2C3D4']) {
      const r = await post({ pack: pack({ id }) });
      assert.equal(r.status, 400, String(id));
      assert.equal(r.body.code, 'packBroken');
      assert.equal(r.body.vars.what, 'id');
    }
    const r = await post({ pack: pack({ secret: 5 }) });
    assert.deepEqual([r.status, r.body.code, r.body.vars.what], [400, 'packBroken', 'secret']);
    const a = await post({ pack: pack() });
    const b = await post({ pack: pack({ name: 'Duo 2' }) });
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal(b.body.name, 'Duo 2');
    assert.equal(b.body.imported, true);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
