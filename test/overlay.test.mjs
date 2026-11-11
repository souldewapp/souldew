// Stream overlays: what the overlay endpoint hands out (nothing secret), how a snapshot becomes teams, linked
// groups, counters and alerts, and the live push (SSE) from a doc upload to an open overlay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { overlaySnapshot, teamOf, groupsOf, countersOf, alertsBetween, pickSlots, overlayUrl, areaLabel, statusKey, playTimeText,
  overlayRun, currentRunId } from '../shared/overlay.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'sls-overlay-'));
process.env.SLS_DATA_DIR = DATA;
const { startServer } = await import('../server/app.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const manifest = (o = {}) => ({
  id: 'c0ffee01', name: 'Ana & Ben', room: 'room-SECRET-ROOM', secret: 'TOP-SECRET-KEY', mode: 'soullink', createdAt: '2026-10-01T10:00:00Z',
  players: { p1: { name: 'Ana' }, p2: { name: 'Ben' } }, base: { crc: '1', name: 'Pokemon HeartGold.nds' },
  outputs: { p1: { rom: 'Ana - Private Folder.nds', log: 'Ana - Spoiler-Log.txt' } }, rules: { discordWebhook: 'https://discord.com/api/webhooks/1/SECRET-HOOK' }, ...o,
});
const e = (v, t = 1) => ({ v, t, by: 'DEVICE-ID-123' });
const mon = (key, area, species, level, o = {}) => ({ key, area, species, nick: '', level, hp: 20, maxHp: 30, status: 0, moves: [1, 2, 3, 4], ...o });
const doc = () => ({
  'player:p1': e({ name: 'Ana' }), 'player:p2': e({ name: 'Ben' }),
  'enc:route-29:p1': e({ outcome: 'caught', species: 16, level: 5, nickname: 'Pip', by: 'p1' }),
  'enc:route-29:p2': e({ outcome: 'caught', species: 19, level: 5, nickname: '' }),
  'enc:cherrygrove:p1': e({ outcome: 'caught', species: 41, level: 7, nickname: '' }),
  'enc:cherrygrove:p2': e({ outcome: 'caught', species: 74, level: 7, nickname: '' }),
  'enc:route-30:p1': e({ outcome: 'missed', species: 13 }),
  'enc:route-30:p2': e({ outcome: 'caught', species: 10, level: 4, nickname: '' }),
  'pair:cherrygrove': e({ state: 'dead', diedAt: 5, killer: { species: 241, level: 19, kind: 'trainer' }, cause: 'secret note' }),
  'live:p1': e({ source: 'live', trainer: 'ANA', badges: 2, playTime: { h: 3, m: 7 }, party: [mon('a', 'route-29', 17, 18, { nick: 'Pip' }), mon('b', 'cherrygrove', 41, 172, { hp: 0 })], at: 9 }),
  'live:p2': e({ source: 'live', badges: 1, party: [mon('c', 'route-29', 20, 17, { status: 8 })], at: 9 }),
  'where:p1': e({ gen: 4, id: 177, name: 'Route 29', at: 9, fight: { kind: 'wild', species: 161, level: 3 } }),
  'area:m4-999': e({ name: 'Secret Garden', met: [999] }),
  'run:resumed': e({ attempt: 2 }),
  'feed:x1': e({ at: 100, type: 'catch', slot: 'p1', area: 'route-29', species: 16, text: 'old' }),
});

test('snapshot: no room, secret, webhook, file names or device ids – only what an overlay shows', () => {
  const s = overlaySnapshot(manifest(), doc(), { speciesName: (id) => `S${id}` });
  const text = JSON.stringify(s);
  for (const bad of ['SECRET', 'room-', 'DEVICE-ID', 'Private Folder', 'Spoiler-Log', 'webhook', 'secret note', 'moves', 'ANA']) assert.ok(!text.includes(bad), `leaks ${bad}`);
  assert.deepEqual(s.slots, ['p1', 'p2']);
  assert.equal(s.players.p2.name, 'Ben');
  assert.equal(s.gen, 4, 'the generation from the base ROM when the manifest has no game');
  assert.equal(s.species[241], 'S241', 'names for every species the overlay may show – the killer too');
  assert.equal(s.species[161], 'S161');
  assert.equal(s.species[197], 'S197', 'and for the test alerts, which reach the app’s preview without the event stream');
  assert.equal(s.areas['route-29'], 'Route 29');
  assert.ok(!('run:resumed' in s.doc) && !('area:m4-999' in s.doc));
  assert.equal(s.doc['where:p1'].fight.species, 161);
});

test('area names: the doc’s own entry, the route list, the location tables, else the key', () => {
  assert.equal(areaLabel('m4-999', { doc: doc() }), 'Secret Garden');
  assert.equal(areaLabel('route-29'), 'Route 29');
  assert.equal(areaLabel('m2-1', { tables: { loc2: { map: { 1: { en: 'New Bark Town', de: 'Neuborkia' } } } }, lang: 'de' }), 'Neuborkia');
  assert.equal(areaLabel('m4-126', { tables: { gen4: { locations: { 126: 'New Bark Town' } } } }), 'New Bark Town');
  assert.equal(areaLabel('mystery'), 'mystery');
});

test('teams and linked groups: one column per area, box members filled in, garbage levels hidden', () => {
  const S = overlaySnapshot(manifest(), doc());
  const a = teamOf(S, 'p1');
  assert.deepEqual(a.map((m) => [m.area, m.level, m.status]), [['route-29', 18, ''], ['cherrygrove', null, 'fnt']], 'Lv 172 is never shown');
  assert.equal(teamOf(S, 'p2')[0].status, 'psn');
  const g = groupsOf(S, ['p1', 'p2']);
  assert.deepEqual(g.map((x) => x.area), ['route-29', 'cherrygrove']);
  assert.equal(g[1].dead, true);
  assert.equal(g[1].members.p2.box, true, 'Ben’s Geodude is in the box – shown from the encounter');
  assert.equal(g[1].members.p2.species, 74);
  assert.deepEqual(pickSlots(S, ['p2', 'p9']), ['p2']);
  assert.deepEqual(pickSlots(S, []), ['p1', 'p2']);
  // without live data the board's team stands in
  const d = doc();
  delete d['live:p2'];
  d['party:p2'] = e(['route-29', 'route-30']);
  assert.deepEqual(teamOf(overlaySnapshot(manifest(), d), 'p2').map((m) => m.species), [19, 10]);
});

test('counters: alive / dead groups, complete catches, missed areas, badges per player', () => {
  const c = countersOf(overlaySnapshot(manifest(), doc()));
  assert.deepEqual({ ...c, badges: undefined }, { alive: 1, dead: 1, caught: 2, missed: 1, encounters: 3, badges: undefined });
  assert.deepEqual(c.badges, { p1: 2, p2: 1 });
});

test('alerts: nothing old on the first snapshot, then deaths with the whole group, catches, level milestones, the run’s end', () => {
  const now = 1_000_000;
  const seen = new Set();
  const d = doc();
  d['feed:x1'].v.at = now - 1000;
  const S1 = overlaySnapshot(manifest(), d);
  assert.deepEqual(alertsBetween(null, S1, seen, now), [], 'what happened before the overlay opened is not announced');
  const d2 = doc();
  d2['feed:x2'] = e({ at: now, type: 'death', slot: 'p1', area: 'cherrygrove' });
  d2['feed:x3'] = e({ at: now - 10 * 60 * 1000, type: 'catch', slot: 'p2', area: 'route-30', species: 10 }); // arrives late from a sync
  d2['feed:x4'] = e({ at: now + 1, type: 'catch', slot: 'p2', area: 'route-29', species: 19 });
  d2['live:p1'].v.party[0].level = 20; // 18 → 20: a 20th level
  d2['live:p2'].v.party[0].level = 30; // 17 → 30 at once: a bad read or a loaded state, not a milestone
  d2['run:status'] = e({ state: 'failed', reason: 'wipe', at: now, by: 'p2' });
  const S2 = overlaySnapshot(manifest(), d2);
  const out = alertsBetween(S1, S2, seen, now);
  assert.deepEqual(out.map((a) => a.type), ['death', 'catch', 'run', 'level']);
  assert.deepEqual(out[0].members.map((m) => [m.slot, m.species]), [['p1', 41], ['p2', 74]]);
  assert.equal(out[0].killer.species, 241);
  assert.equal(out[1].complete, true, 'both players caught on Route 29');
  assert.equal(out[2].state, 'failed');
  assert.deepEqual([out[3].slot, out[3].level], ['p1', 20]);
  assert.deepEqual(alertsBetween(S2, S2, seen, now), [], 'each alert once');
});

test('helpers: status bytes, play time, OBS URL with its layer size', () => {
  assert.equal(statusKey({ status: 3 }), 'slp');
  assert.equal(statusKey({ status: 0x80 }), 'tox');
  assert.equal(statusKey({ status: 'brn' }), 'brn');
  assert.equal(statusKey({ hp: 0, maxHp: 10 }), 'fnt');
  assert.equal(playTimeText({ h: 12, m: 5 }), '12:05');
  assert.equal(playTimeText(3700), '1:01');
  assert.equal(playTimeText(null), '');
  const u = new URL(overlayUrl('http://localhost:47390', 'c0ffee01', { w: 'team', layout: 'v', hp: 0, nick: null, sound: true }, [300.4, 800], 'souldew · Team'));
  assert.equal(u.pathname, '/overlay');
  assert.deepEqual(Object.fromEntries(u.searchParams), { run: 'c0ffee01', w: 'team', layout: 'v', hp: '0', sound: '1', 'layer-width': '300', 'layer-height': '800', 'layer-name': 'souldew · Team' });
});

// ---- links that keep working across runs (issue #8) ---------------------------------------------------------

test('overlay links: "current" follows the run being played, a run ID stays on that run, old links keep working', () => {
  assert.equal(overlayRun('c0ffee01'), 'c0ffee01', 'an old link with its run ID');
  assert.equal(overlayRun('C0FFEE01'), 'c0ffee01');
  for (const v of [null, undefined, '', 'current', 'CURRENT', ' current ']) assert.equal(overlayRun(v), 'current', `${v}`);
  for (const v of ['c0ffee0', 'c0ffee011', 'zzzzzzzz', '../c0ffee01', 'c0ffee01?x']) assert.equal(overlayRun(v), null, v);
  const u = (id) => new URL(overlayUrl('http://localhost:47390', id, { w: 'team' })).searchParams.get('run');
  assert.equal(u('current'), 'current');
  assert.equal(u(null), 'current', 'no run given: the link follows');
  assert.equal(u('c0ffee01'), 'c0ffee01');
});

test('current run: the one open in the app while it exists, else the one played last, else none', () => {
  const runs = [{ id: 'aaaa0001', playedAt: 300 }, { id: 'bbbb0002', playedAt: 900 }, { id: 'cccc0003', playedAt: 0 }];
  assert.equal(currentRunId({ lastRun: 'aaaa0001', runs }), 'aaaa0001', 'open in the app beats played later');
  assert.equal(currentRunId({ lastRun: 'cccc0003', runs }), 'cccc0003', 'a brand-new run without a doc yet');
  assert.equal(currentRunId({ lastRun: 'dddd0004', runs }), 'bbbb0002', 'a deleted run falls back to the one played last');
  assert.equal(currentRunId({ lastRun: null, runs }), 'bbbb0002');
  assert.equal(currentRunId({ runs: [{ id: 'eeee0005' }] }), 'eeee0005');
  assert.equal(currentRunId({ lastRun: 'aaaa0001', runs: [] }), null);
  assert.equal(currentRunId(), null);
});

// ---- the server: snapshot route, live push, test alerts ----------------------------------------------------

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

test('server: overlay snapshot, live push after a doc upload, test alerts and the "live in OBS" count', async () => {
  const dir = join(DATA, 'runs', 'c0ffee01');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest()));
  writeFileSync(join(dir, 'doc.json'), JSON.stringify(doc()));
  const { server, url } = await startServer({ port: 0, background: false });
  try {
    const r = await fetch(`${url}/api/runs/c0ffee01/overlay?lang=de`);
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(!text.includes('SECRET') && !text.includes('DEVICE-ID'));
    assert.equal(JSON.parse(text).species[16], 'Taubsi', 'species names in the overlay’s language');
    assert.equal((await fetch(`${url}/api/runs/deadbeef/overlay`)).status, 404);
    // a page on another site can't read it
    assert.equal((await fetch(`${url}/api/runs/c0ffee01/overlay`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);

    const obs = sse(`${url}/api/runs/c0ffee01/overlay/events?lang=en&w=alerts`);
    const preview = sse(`${url}/api/runs/c0ffee01/overlay/events?lang=en&w=team&preview=1`);
    assert.equal(await obs.ready, 200);
    await preview.ready;
    const first = await obs.next('snapshot');
    assert.equal(first.players.p1.name, 'Ana');
    await preview.next('snapshot');
    const clients = await (await fetch(`${url}/api/runs/c0ffee01/overlay/clients`)).json();
    assert.deepEqual(clients, { widgets: { alerts: 1 }, total: 1 }, 'the app’s own previews don’t count as OBS');

    // the app uploads its doc → the overlay hears it at once
    const put = await fetch(`${url}/api/runs/c0ffee01/doc`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-soullink': '1' },
      body: JSON.stringify({ 'pair:route-29': e({ state: 'dead', diedAt: 7 }, 50) }) });
    assert.equal(put.status, 200);
    const pushed = await obs.next('snapshot');
    assert.equal(pushed.doc['pair:route-29'].state, 'dead');

    const t = await (await fetch(`${url}/api/runs/c0ffee01/overlay/test`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: '{"type":"death"}' })).json();
    assert.deepEqual(t, { ok: true, overlays: 1 });
    const sample = await obs.next('test');
    assert.equal(sample.type, 'death');
    assert.equal(sample.species[241], 'Miltank');
    // a test alert changes something → it needs the app's header like every other write
    assert.equal((await fetch(`${url}/api/runs/c0ffee01/overlay/test`, { method: 'POST', body: '{}' })).status, 403);
    obs.close();
    preview.close();

    // the old overlay URL still opens the overlay page
    const page = await fetch(`${url}/overlay?run=c0ffee01`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /souldew overlay/);
    assert.match(page.headers.get('content-security-policy') || '', /script-src 'self' 'sha256-/);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
