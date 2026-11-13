// Pokélink bridge: souldew's teams in the shape Pokélink themes read, and the socket.io handshake those themes
// make (socket.io-client 2.x → Engine.IO 3) – the list arrives on connect, changes are pushed, other sites get nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer as netServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pokelinkPlayers, pokelinkMon, pokelinkGame, newDeaths, startPokelinkBridge, originAllowed } from '../server/lib/pokelink.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'sls-pokelink-'));
process.env.SLS_DATA_DIR = DATA;
const { startServer } = await import('../server/app.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const e = (v) => ({ v, t: 1, by: 'DEVICE-ID' });
const manifest = { id: 'c0ffee01', mode: 'soullink', players: { p1: { name: 'Ana' }, p2: { name: 'Ben' } }, game: { id: 'pokemon-heartgold', system: 'nds', title: 'HeartGold' }, secret: 'TOP-SECRET' };
const data = { names: Object.assign([], { 155: 'Cyndaquil', 16: 'Pidgey', 19: 'Rattata', 35: 'Clefairy' }), types: Object.assign([], { 155: ['fire'], 16: ['normal', 'flying'], 35: ['fairy'] }),
  typesGen: { 35: { 5: ['normal'] } }, typeNames: { fire: 'Fire', normal: 'Normal', flying: 'Flying', fairy: 'Fairy' }, moveNames: Object.assign([], { 33: 'Tackle', 52: 'Ember' }), moveTypes: Object.assign([], { 33: 'normal', 52: 'fire' }) };
const doc = (o = {}) => ({
  'player:p1': e({ name: 'Ana' }), 'player:p2': e({ name: 'Ben' }),
  'live:p1': e({ badges: 3, party: [{ key: 'aa-1-2', area: 'route-29', species: 155, nick: 'Sparky', level: 14, hp: 30, maxHp: 41, status: 8, shiny: true, gender: 'F', item: 213, moves: [33, 52] }, { key: 'bb', area: 'cherrygrove', species: 16, nick: '', level: 172, hp: 99, maxHp: 20, status: 0 }] }),
  'party:p2': e(['route-29']), 'enc:route-29:p2': e({ outcome: 'caught', species: 19, level: 4, nickname: 'Rat' }),
  'pair:cherrygrove': e({ state: 'dead' }),
  ...o,
});

test('players: every souldew player as a Pokélink user (by name and by slot), six slots, trainer with badges', () => {
  const list = pokelinkPlayers(manifest, doc(), data);
  assert.deepEqual(list.map((p) => p.username), ['Ana', 'p1', 'Ben', 'p2']);
  const ana = list[0];
  assert.equal(ana.party.length, 6);
  assert.deepEqual(ana.party.map((s) => s.slotId), [1, 2, 3, 4, 5, 6]);
  assert.equal(ana.party[2].pokemon, null, 'empty slots are sent, so a mon that left the party disappears from the theme');
  assert.deepEqual(ana.trainer.game, { id: 'POKEMON HG', friendlyName: 'Pokémon HeartGold', generation: 4 });
  assert.equal(ana.trainer.badges.length, 16);
  assert.deepEqual(ana.trainer.badges.slice(0, 4).map((b) => [b.name, b.value]), [['Zephyr', 1], ['Hive', 1], ['Plain', 1], ['Fog', 0]]);
  assert.equal(list[2].party[0].pokemon.nickname, 'Rat', 'no live party: the board’s team');
  assert.ok(!JSON.stringify(list).includes('SECRET') && !JSON.stringify(list).includes('DEVICE'));
});

test('mon: the fields the themes read (transformPokemon), sanitised', () => {
  const [ana] = pokelinkPlayers(manifest, doc(), data);
  const m = ana.party[0].pokemon;
  assert.equal(m.speciesName, 'Cyndaquil', 'English name – the themes build the sprite file name from it');
  assert.equal(m.nickname, 'Sparky');
  assert.deepEqual(m.hp, { current: 30, max: 41 });
  assert.equal(m.isShiny, 1);
  assert.equal(m.isFemale, 1);
  assert.equal(m.isGenderless, 0);
  assert.equal(m.heldItem, 213);
  assert.equal(m.status.psn, 1);
  assert.deepEqual(m.types, [{ label: 'Fire' }]);
  assert.equal(m.move1.name, 'Tackle');
  assert.equal(m.move2.type, 'Fire');
  assert.equal(m.move3.name, '--', 'unused moves the way the themes skip them');
  assert.equal(m.locationMet, 'Route 29');
  const torn = ana.party[1].pokemon;
  assert.equal(torn.level, 1, 'a level outside 1–100 is never shown');
  assert.deepEqual(torn.hp, { current: 20, max: 20 }, 'HP above max is not passed on');
  assert.equal(torn.dead, true, 'its link is in the graveyard');
  assert.equal(torn.nickname, 'Pidgey', 'no nickname: the species name');
  // Clefairy was Normal before gen 6
  assert.deepEqual(pokelinkMon({ species: 35, level: 5 }, { gen: 4, data }).types, [{ label: 'Normal' }]);
  assert.equal(pokelinkMon({ species: 35, level: 5 }, { data }).isGenderless, 1, 'no gender read: no symbol');
});

test('game ids: catalog ids → Pokélink’s cartridge titles; deaths between two lists', () => {
  assert.equal(pokelinkGame({ game: { id: 'pokemon-crystal-de', system: 'gbc' } }).id, 'PM_CRYSTAL');
  assert.equal(pokelinkGame({ game: { id: 'pokemon-firered', system: 'gba' } }).id, 'POKEMON FIRE');
  assert.equal(pokelinkGame({ game: { id: 'pokemon-platinum', system: 'nds' } }).id, 'POKEMON PL');
  const before = pokelinkPlayers(manifest, doc({ 'pair:cherrygrove': e({ state: 'alive' }) }), data);
  const after = pokelinkPlayers(manifest, doc(), data);
  assert.deepEqual(newDeaths(before, after).map((d) => [d.username, d.pokemon.pid]), [['Ana', 'bb'], ['p1', 'bb']]);
  assert.deepEqual(newDeaths(after, after), []);
});

test('origins: themes from disk, souldew’s own pages and Pokélink’s hosting – other local servers only when switched on (#25)', () => {
  const own = { ports: [47390, 3000] };
  for (const o of [undefined, 'null', 'http://absolute', 'http://localhost:47390', 'http://127.0.0.1:3000', 'http://[::1]:47390', 'https://themes.pokelink.xyz', 'https://pokelink.app', 'https://pokelinkapp.github.io']) {
    assert.ok(originAllowed(o, own), o);
  }
  for (const o of ['https://evil.example', 'https://pokelink.xyz.evil.example', 'http://localhost.evil.example', 'http://pokelink.xyz', 'https://pokelink.xyz:8443']) {
    assert.ok(!originAllowed(o, own), o);
    assert.ok(!originAllowed(o, { ...own, localPages: true }), `${o} (local pages on)`);
  }
  // another page on this computer (a dev server, another program's web page): not by default
  for (const o of ['http://localhost:8080', 'http://127.0.0.1', 'https://localhost', 'http://localhost:5173']) {
    assert.ok(!originAllowed(o, own), o);
    assert.ok(originAllowed(o, { ...own, localPages: true }), `${o} (local pages on)`);
  }
  assert.ok(!originAllowed('http://localhost:8080'), 'no settings – the strict default');
});

/** A raw GET (node's fetch won't let a test set Host). */
const get = (port, path, headers = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.end();
});

/** Engine.IO 3 polling payload "<len>:<packet><len>:<packet>…" → packets. */
function packets(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    const c = body.indexOf(':', i);
    if (c < 0) break;
    const n = Number(body.slice(i, c));
    out.push(body.slice(c + 1, c + 1 + n));
    i = c + 1 + n;
  }
  return out;
}

test('socket.io handshake the way a theme’s socket.io-client 2.2 makes it: players on connect, pushes after a change', async (t) => {
  let current = pokelinkPlayers(manifest, doc(), data);
  const bridge = await startPokelinkBridge({ port: 0, players: () => current });
  t.after(() => bridge.close());
  const origin = { Origin: 'null' }; // a theme opened from disk
  const open = await get(bridge.port, '/socket.io/?EIO=3&transport=polling&t=1', origin);
  assert.equal(open.status, 200);
  assert.equal(open.headers['access-control-allow-origin'], 'null');
  const first = packets(open.body);
  assert.equal(first[0][0], '0', 'open packet');
  const { sid } = JSON.parse(first[0].slice(1));
  // collect messages until the list has come
  const seen = [];
  for (let i = 0; i < 6 && !seen.some((p) => p.startsWith('42["client:players:list"')); i++) {
    seen.push(...packets((await get(bridge.port, `/socket.io/?EIO=3&transport=polling&t=${i + 2}&sid=${sid}`, origin)).body));
  }
  const list = JSON.parse(seen.find((p) => p.startsWith('42["client:players:list"')).slice(2))[1];
  assert.equal(list[0].username, 'Ana');
  assert.equal(list[0].party[0].pokemon.speciesName, 'Cyndaquil');

  current = pokelinkPlayers(manifest, doc({ 'live:p1': e({ badges: 4, party: [{ key: 'aa-1-2', area: 'route-29', species: 155, nick: 'Sparky', level: 15, hp: 41, maxHp: 44, status: 0 }] }) }), data);
  bridge.push();
  const more = [];
  for (let i = 0; i < 4 && !more.some((p) => p.startsWith('42["player:trainer:updated"')); i++) {
    more.push(...packets((await get(bridge.port, `/socket.io/?EIO=3&transport=polling&t=${i + 20}&sid=${sid}`, origin)).body));
  }
  const party = JSON.parse(more.find((p) => p.startsWith('42["client:party:updated"')).slice(2))[1];
  assert.equal(party.username, 'Ana');
  assert.equal(party.update.party[0].pokemon.level, 15);
  assert.ok(!more.some((p) => p.includes('"username":"Ben"')), 'only who changed');
  assert.ok(more.some((p) => p.startsWith('42["player:trainer:updated"')));
});

test('bridge: a run that can’t be read (damaged run.json) doesn’t throw out of push() or a new connection', async (t) => {
  let broken = true;
  const good = pokelinkPlayers(manifest, doc(), data);
  const bridge = await startPokelinkBridge({ port: 0, players: () => { if (broken) throw new SyntaxError('Unexpected token in JSON'); return good; } });
  t.after(() => bridge.close());
  assert.doesNotThrow(() => bridge.push());
  const origin = { Origin: 'null' };
  const open = await get(bridge.port, '/socket.io/?EIO=3&transport=polling&t=1', origin);
  const { sid } = JSON.parse(packets(open.body)[0].slice(1));
  const seen = [];
  for (let i = 0; i < 6 && !seen.some((p) => p.startsWith('42["client:players:list"')); i++) {
    seen.push(...packets((await get(bridge.port, `/socket.io/?EIO=3&transport=polling&t=${i + 2}&sid=${sid}`, origin)).body));
  }
  assert.deepEqual(JSON.parse(seen.find((p) => p.startsWith('42["client:players:list"')).slice(2))[1], [], 'an empty list instead of a crash');
  broken = false;
  bridge.push(); // readable again: the players come through
  const more = [];
  for (let i = 0; i < 4 && !more.some((p) => p.startsWith('42["client:party:updated"')); i++) {
    more.push(...packets((await get(bridge.port, `/socket.io/?EIO=3&transport=polling&t=${i + 20}&sid=${sid}`, origin)).body));
  }
  assert.ok(more.some((p) => p.startsWith('42["client:party:updated"')));
});

test('bridge: another website or a foreign Host name gets nothing', async (t) => {
  const bridge = await startPokelinkBridge({ port: 0, players: () => [] });
  t.after(() => bridge.close());
  const evil = await get(bridge.port, '/socket.io/?EIO=3&transport=polling&t=1', { Origin: 'https://evil.example' });
  assert.notEqual(evil.status, 200);
  assert.ok(!evil.headers['access-control-allow-origin']);
  const rebind = await get(bridge.port, '/socket.io/?EIO=3&transport=polling&t=1', { Host: 'attacker.example:3000' });
  assert.equal(rebind.status, 403);
  const pna = await get(bridge.port, '/socket.io/?EIO=3&transport=polling&t=1', { Origin: 'https://themes.pokelink.xyz', 'Access-Control-Request-Private-Network': 'true' });
  assert.equal(pna.headers['access-control-allow-private-network'], 'true');
});

test('bridge: a page of another local web server only gets in once the Stream page allows it (#25)', async (t) => {
  let localPages = false;
  const bridge = await startPokelinkBridge({ port: 0, players: () => [], access: () => ({ appPort: 47390, localPages }) });
  t.after(() => bridge.close());
  const poll = (origin) => get(bridge.port, '/socket.io/?EIO=3&transport=polling&t=1', { Origin: origin });
  const dev = await poll('http://localhost:5173');
  assert.notEqual(dev.status, 200);
  assert.ok(!dev.headers['access-control-allow-origin']);
  assert.equal((await poll('http://localhost:47390')).status, 200, 'souldew’s own page');
  assert.equal((await poll(`http://127.0.0.1:${bridge.port}`)).status, 200, 'the bridge’s own address');
  assert.equal((await poll('null')).status, 200, 'a theme opened from disk');
  localPages = true;
  const later = await poll('http://localhost:5173');
  assert.equal(later.status, 200);
  assert.equal(later.headers['access-control-allow-origin'], 'http://localhost:5173');
});

const freePort = () => new Promise((resolve) => {
  const s = netServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

test('app API: the Stream page switches the bridge on and off; it serves the run with the newest doc', async (t) => {
  const runs = join(DATA, 'runs');
  mkdirSync(join(runs, 'c0ffee01'), { recursive: true });
  writeFileSync(join(runs, 'c0ffee01', 'run.json'), JSON.stringify(manifest));
  writeFileSync(join(runs, 'c0ffee01', 'doc.json'), JSON.stringify(doc()));
  const { server, url } = await startServer({ port: 0, background: false });
  t.after(() => server.close());
  const api = async (method, body) => (await fetch(`${url}/api/pokelink`, { method, headers: { 'x-soullink': '1', 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json();
  assert.equal((await api('GET')).running, false, 'off until switched on');
  const port = await freePort();
  const on = await api('POST', { enabled: true, port });
  assert.equal(on.running, true);
  assert.equal(on.port, port);
  assert.equal(on.run, 'c0ffee01');
  const open = await get(port, '/socket.io/?EIO=3&transport=polling&t=1', { Origin: 'null' });
  assert.equal(open.status, 200);
  // souldew's own page may read; another local server only after the switch, which takes effect at once
  const appPort = new URL(url).port;
  assert.equal((await get(port, '/socket.io/?EIO=3&transport=polling&t=2', { Origin: `http://localhost:${appPort}` })).status, 200);
  assert.equal(on.localPages, false);
  assert.notEqual((await get(port, '/socket.io/?EIO=3&transport=polling&t=3', { Origin: 'http://localhost:5173' })).status, 200);
  assert.equal((await api('POST', { localPages: true })).localPages, true);
  assert.equal((await get(port, '/socket.io/?EIO=3&transport=polling&t=4', { Origin: 'http://localhost:5173' })).status, 200);
  assert.equal((await api('POST', { localPages: false })).localPages, false);
  const off = await api('POST', { enabled: false });
  assert.equal(off.running, false);
  await assert.rejects(get(port, '/', {}), 'the port is closed again');
});
