// Overlay links that keep working across runs (issue #8): an overlay on /overlay?run=current – and a stream API stream
// on /api/v1/runs/current/events – follows the run being played and switches live when another run becomes current;
// links with a run ID stay on their run. Its own file: the server reads its data folder once, and this one starts empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

const root = mkdtempSync(join(tmpdir(), 'sls-follow-'));
process.env.SLS_DATA_DIR = root;
const { startServer } = await import('../server/app.mjs');
test.after(() => rmSync(root, { recursive: true, force: true }));

const manifest = (o = {}) => ({ id: 'aaaa0001', name: 'Run', mode: 'soullink', createdAt: '2026-11-01T10:00:00Z',
  players: { p1: { name: 'Ana' }, p2: { name: 'Ben' } }, game: { id: 'heartgold', system: 'nds' }, ...o });
const e = (v, t = 1) => ({ v, t, by: 'dev' });
const doc = () => ({
  'player:p1': e({ name: 'Ana' }), 'player:p2': e({ name: 'Ben' }),
  'enc:route-29:p1': e({ outcome: 'caught', species: 16, level: 5, nickname: '' }),
  'enc:route-29:p2': e({ outcome: 'caught', species: 19, level: 5, nickname: '' }),
});

function sse(url, headers = {}) {
  const events = [];
  let wake = null;
  const req = request(url, { headers: { accept: 'text/event-stream', ...headers } });
  let buf = '';
  const ready = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      resolve(res.statusCode);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev) events.push({ ev, data: JSON.parse(data) });
          wake?.();
        }
      });
    });
    req.on('error', reject);
  });
  req.end();
  const next = async (ev, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const at = events.findIndex((x) => x.ev === ev);
      if (at >= 0) return events.splice(at, 1)[0].data;
      if (Date.now() > end) throw new Error(`no ${ev} event`);
      await new Promise((r) => { wake = r; setTimeout(r, 50); });
    }
  };
  return { ready, next, close: () => req.destroy() };
}

test('server: an overlay on run=current follows the run being played – live, without reloading', async () => {
  const write = (id, name, o = {}) => {
    const dir = join(root, 'runs', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest({ id, name, ...o })));
    writeFileSync(join(dir, 'doc.json'), JSON.stringify(doc()));
  };
  const { server, url } = await startServer({ port: 0, background: false });
  const post = (path, body) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify(body) });
  try {
    // no run yet: the stream opens anyway and says so; polling gets a 404
    assert.equal((await fetch(`${url}/api/runs/current/overlay`)).status, 404);
    const obs = sse(`${url}/api/runs/current/overlay/events?lang=en&w=alerts`);
    assert.equal(await obs.ready, 200);
    await obs.next('norun');

    // a run appears (built or joined → the app opens it): the overlay gets it at once
    write('aaaa0001', 'First run');
    assert.equal((await post('/api/config', { lastRun: 'aaaa0001' })).status, 200);
    assert.equal((await obs.next('snapshot')).id, 'aaaa0001');
    assert.equal((await (await fetch(`${url}/api/runs/current/overlay`)).json()).id, 'aaaa0001');
    // it counts as live in OBS for that run, and test alerts reach it
    assert.deepEqual(await (await fetch(`${url}/api/runs/aaaa0001/overlay/clients`)).json(), { widgets: { alerts: 1 }, total: 1 });
    assert.deepEqual(await (await post('/api/runs/aaaa0001/overlay/test', { type: 'catch' })).json(), { ok: true, overlays: 1 });
    await obs.next('test');

    // an old link pinned to the first run, and the stream API on `current`
    const pinned = sse(`${url}/api/runs/aaaa0001/overlay/events?lang=en&w=team`);
    await pinned.ready;
    await pinned.next('snapshot');
    const api = sse(`${url}/api/v1/runs/current/events?lang=en`);
    assert.equal(await api.ready, 200);
    assert.equal((await api.next('hello')).run, 'aaaa0001');
    await api.next('state');

    // a new run starts: the follower switches, the pinned link stays, the API stream says hello again
    write('bbbb0002', 'Second run', { mode: 'nuzlocke', players: { p1: { name: 'Robin' } } });
    await post('/api/config', { lastRun: 'bbbb0002' });
    const next = await obs.next('snapshot');
    assert.deepEqual([next.id, next.name, next.slots], ['bbbb0002', 'Second run', ['p1']]);
    assert.equal((await api.next('hello')).run, 'bbbb0002');
    assert.equal((await api.next('state')).run.id, 'bbbb0002');
    assert.deepEqual(await (await fetch(`${url}/api/runs/bbbb0002/overlay/clients`)).json(), { widgets: { alerts: 1 }, total: 1 });
    assert.deepEqual(await (await fetch(`${url}/api/runs/aaaa0001/overlay/clients`)).json(), { widgets: { team: 1 }, total: 1 }, 'the pinned one stays');
    // uploads to the new run reach the follower, not the pinned overlay
    await fetch(`${url}/api/runs/bbbb0002/doc`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify({ 'pair:route-29': e({ state: 'dead' }, 99) }) });
    assert.equal((await obs.next('snapshot')).doc['pair:route-29'].state, 'dead');
    await assert.rejects(pinned.next('snapshot', 400), /no snapshot/);
    assert.equal((await (await fetch(`${url}/api/stream`, { headers: { 'sec-fetch-site': 'same-origin' } })).json()).current, 'bbbb0002', 'the Stream page knows which run is current');

    // the open run is deleted: back to the one played last
    assert.equal((await fetch(`${url}/api/runs/bbbb0002`, { method: 'DELETE', headers: { 'x-soullink': '1' } })).status, 200);
    assert.equal((await obs.next('snapshot')).id, 'aaaa0001');
    obs.close();
    pinned.close();
    api.close();
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
