// The open stream API (/api/v1, shared/streamapi.mjs + server/lib/streamapi.mjs) and the coffee pop-up on legendary
// encounters (shared/coffee.mjs, shared/legendaries.mjs, shared/qr.mjs): payload shape, nothing secret, events,
// access rules (localhost / token / CORS), the deterministic 25 % roll and its limits, the jokes in five languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { LEGENDARY, MYTHICAL, legendaryKind, isLegendary, legendariesUpTo } from '../shared/legendaries.mjs';
import { decideCoffee, recordCoffee, coffeeRoll, coffeeTexts, coffeeJokeId, COFFEE, COFFEE_TEXT, COFFEE_SHORT, COFFEE_URL } from '../shared/coffee.mjs';
import { qrMatrix, qrSvg, qrPath } from '../shared/qr.mjs';
import { buildState, eventsBetween, legendaryEncounters, spriteSource, spriteUrls, API_PREFIX } from '../shared/streamapi.mjs';
import { v1AccessError, localOrigin, requestToken, streamSettings } from '../server/lib/streamapi.mjs';
import { LINKS } from '../shared/links.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'sls-streamapi-'));
process.env.SLS_DATA_DIR = DATA;
const { startServer } = await import('../server/app.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

// ---- legendaries -------------------------------------------------------------------------------------------------

test('legendary and mythical list: every generation, no overlaps, the famous ones in the right box', () => {
  const all = [...LEGENDARY, ...MYTHICAL];
  assert.equal(new Set(all).size, all.length, 'no species twice');
  assert.ok(all.every((id) => Number.isInteger(id) && id >= 1 && id <= 1025));
  const upTo = (max, list) => list.filter((id) => id <= max).length;
  // Gen 1–5 as the games have them: 5, +6, +10, +14, +13
  assert.deepEqual([151, 251, 386, 493, 649].map((m) => upTo(m, all)), [5, 11, 21, 35, 48]);
  for (const id of [144, 145, 146, 150, 243, 244, 245, 249, 250, 380, 381, 382, 383, 384, 483, 484, 487, 643, 644, 646, 1007]) assert.equal(legendaryKind(id), 'legendary', `#${id}`);
  for (const id of [151, 251, 385, 386, 490, 491, 492, 493, 494, 647, 648, 649, 1025]) assert.equal(legendaryKind(id), 'mythical', `#${id}`);
  for (const id of [129, 25, 793, 1005, 0, null, 'x']) assert.equal(isLegendary(id), false, `#${id} is neither`);
  assert.deepEqual(legendariesUpTo(1), [144, 145, 146, 150, 151]);
  assert.ok(legendariesUpTo(5).every((id) => id <= 649) && legendariesUpTo(5).includes(649));
});

// ---- coffee pop-up rules -----------------------------------------------------------------------------------------

test('coffee roll: deterministic per run and species, about one in four', () => {
  assert.equal(coffeeRoll('c0ffee01:150'), coffeeRoll('c0ffee01:150'));
  assert.notEqual(coffeeRoll('c0ffee01:150'), coffeeRoll('c0ffee02:150'));
  let lucky = 0;
  for (let i = 0; i < 4000; i++) if (coffeeRoll(`run${i}:384`) < COFFEE.chance) lucky++;
  assert.ok(lucky > 880 && lucky < 1120, `≈25 %: ${lucky}/4000`);
});

test('coffee decision: off, not legendary, one roll per species and run, 20-minute cooldown', () => {
  const now = 10_000_000;
  const base = { runId: 'aaaa0001', species: 150, now };
  assert.deepEqual(decideCoffee({ ...base, enabled: false }), { show: false, reason: 'off', record: false });
  assert.equal(decideCoffee({ ...base, species: 16 }).reason, 'notLegendary');
  assert.equal(decideCoffee({ ...base, roll: 0.9 }).reason, 'unlucky');
  assert.equal(decideCoffee({ ...base, roll: 0.9 }).record, true, 'an unlucky species stays unlucky for this run');
  const ok = decideCoffee({ ...base, roll: 0.1 });
  assert.deepEqual([ok.show, ok.reason], [true, 'ok']);
  let h = recordCoffee({}, 'aaaa0001', 150, ok, now);
  assert.equal(h.last, now);
  assert.deepEqual(h.runs.aaaa0001, [150]);
  assert.equal(decideCoffee({ ...base, history: h, roll: 0.1 }).reason, 'seen', 'once per species per run');
  const cool = decideCoffee({ ...base, species: 384, history: h, roll: 0.1, now: now + 19 * 60 * 1000 });
  assert.deepEqual([cool.show, cool.reason, cool.record], [false, 'cooldown', false], 'a lucky roll in the cooldown waits for the next encounter');
  assert.equal(decideCoffee({ ...base, species: 384, history: h, roll: 0.1, now: now + 21 * 60 * 1000 }).show, true);
  assert.equal(decideCoffee({ ...base, runId: 'bbbb0002', history: h, roll: 0.1, now: now + 21 * 60 * 1000 }).show, true, 'a new run rolls again');
  // the default roll is the deterministic one
  assert.equal(decideCoffee(base).show, coffeeRoll('aaaa0001:150') < 0.25);
  // history stays small
  for (let i = 0; i < 60; i++) h = recordCoffee(h, `run${i}`, 150, { record: true, show: false }, now);
  assert.equal(Object.keys(h.runs).length, 40);
  assert.equal(h.last, now, 'an unshown roll keeps the cooldown clock');
});

test('coffee jokes: every language has the same jokes, each names the Pokémon', () => {
  const keys = Object.keys(COFFEE_TEXT.en.species).sort();
  for (const [lang, L] of Object.entries(COFFEE_TEXT)) {
    assert.deepEqual(Object.keys(L.species).sort(), keys, `${lang}: same species jokes`);
    assert.equal(L.generic.length, COFFEE_TEXT.en.generic.length, `${lang}: same number of generic jokes`);
    for (const tpl of [...Object.values(L.species), ...L.generic]) assert.match(tpl, /\{name\}/, `${lang}: ${tpl}`);
    for (const k of ['legendary', 'mythical', 'cta', 'scan']) assert.ok(L[k], `${lang}.${k}`);
  }
  // the species jokes are about legendaries from Gen 1–5
  for (const k of keys) if (/^\d+$/.test(k)) assert.ok(isLegendary(Number(k)) && Number(k) <= 649, k);
  const mewtwo = coffeeTexts({ species: 150, name: 'Mewtwo', lang: 'en' });
  assert.equal(mewtwo.joke, 'Mewtwo has entered the chat. souldew’s developer has entered the coffee shortage.');
  assert.equal(mewtwo.kicker, 'Legendary encounter');
  assert.equal(coffeeTexts({ species: 384, name: 'Rayquaza' }).joke, 'This Rayquaza won’t catch itself. The dev’s rent won’t pay itself either.');
  assert.equal(coffeeTexts({ species: 151, name: 'Mew', lang: 'de' }).kicker, 'Mysteriöse Begegnung');
  assert.match(coffeeTexts({ species: 377, name: 'Regirock', lang: 'fr' }).joke, /^Regirock ne parle qu’en braille/, 'the Regis share one joke');
  // a legendary without its own joke gets a generic one – the same idea in every language
  const id = coffeeJokeId(716, 'aaaa0001');
  assert.match(id, /^generic:\d$/);
  assert.equal(coffeeJokeId(716, 'aaaa0001'), id);
  const n = Number(id.split(':')[1]);
  assert.equal(coffeeTexts({ species: 716, name: 'Xerneas', lang: 'it', jokeId: id }).joke, COFFEE_TEXT.it.generic[n].replace('{name}', 'Xerneas'));
  assert.equal(coffeeTexts({ species: 150, name: 'Mewtu', lang: 'xx' }).cta, COFFEE_TEXT.en.cta, 'unknown language → English');
  assert.equal(COFFEE_URL, LINKS.coffee);
  assert.equal(COFFEE_SHORT, 'buymeacoffee.com/souldew');
});

test('QR code: the coffee link encodes to a stable, valid symbol (decoded with OpenCV when it was made)', () => {
  const m = qrMatrix(LINKS.coffee);
  assert.equal(m.length, 29, 'version 3');
  const sig = createHash('sha256').update(m.map((r) => r.map(Number).join('')).join('\n')).digest('hex');
  assert.equal(sig, 'f220005fcbb077d88121016a031f2cb182e4efa53a686af732aadbcf970c486f');
  // the three finder patterns and the timing line
  for (const [x, y] of [[0, 0], [22, 0], [0, 22]]) {
    for (let i = 0; i < 7; i++) assert.ok(m[y][x + i] && m[y + 6][x + i] && m[y + i][x] && m[y + i][x + 6]);
    assert.ok(m[y + 3][x + 3] && !m[y + 1][x + 1]);
  }
  for (let i = 8; i < 21; i++) assert.equal(m[6][i], i % 2 === 0);
  assert.equal(qrMatrix('HELLO').length, 21);
  assert.equal(qrMatrix(`https://example.com/${'x'.repeat(120)}`).length, 49, 'longer links get a bigger version');
  assert.throws(() => qrMatrix('x'.repeat(400)), /too long/);
  assert.match(qrSvg('HELLO'), /^<svg [^>]*viewBox="0 0 29 29"/);
  assert.match(qrPath([[true, true, false, true]], 0), /^M0 0h2v1h-2zM3 0h1v1h-1z$/);
});

// ---- the state -----------------------------------------------------------------------------------------------------

const e = (v, t = 1) => ({ v, t, by: 'DEVICE-ID-123' });
const mon = (key, area, species, level, o = {}) => ({ key, area, species, nick: '', level, hp: 20, maxHp: 30, status: 0, moves: [33, 45], item: 0, ...o });
const manifest = (o = {}) => ({
  id: 'c0ffee02', name: 'Ana & Ben', room: 'room-SECRET-ROOM', secret: 'TOP-SECRET-KEY', mode: 'soullink', createdAt: '2026-10-01T10:00:00Z',
  players: { p1: { name: 'Ana' }, p2: { name: 'Ben' } }, base: { crc: '1', name: 'Pokemon HeartGold.nds' }, game: { id: 'pokemon-heartgold', system: 'nds', code: 'IPKE' },
  outputs: { p1: { rom: 'Ana - Private Folder.nds', log: 'Ana - Spoiler-Log.txt' } }, rules: { discordWebhook: 'https://discord.com/api/webhooks/1/SECRET-HOOK' }, ...o,
});
const NOW = 1_800_000_000_000;
const docOf = () => ({
  'player:p1': e({ name: 'Ana' }), 'player:p2': e({ name: 'Ben' }),
  rules: e({ dupes: 'line', discordWebhook: 'https://discord.com/api/webhooks/1/SECRET-HOOK' }),
  'enc:route-29:p1': e({ outcome: 'caught', species: 16, level: 5, nickname: 'Pip', at: 10 }),
  'enc:route-29:p2': e({ outcome: 'caught', species: 19, level: 5, nickname: '', at: 11 }),
  'enc:cherrygrove:p1': e({ outcome: 'caught', species: 41, level: 7, nickname: '', at: 20 }),
  'enc:cherrygrove:p2': e({ outcome: 'caught', species: 74, level: 7, nickname: '', at: 21 }),
  'enc:route-30:p1': e({ outcome: 'missed', species: 13, at: 30 }),
  'pair:cherrygrove': e({ state: 'dead', diedAt: 500, by: 'p2', level: 9, killer: { species: 241, level: 19, kind: 'trainer' }, cause: 'secret note' }),
  'live:p1': e({ source: 'live', trainer: 'ANA', badges: 2, playTime: { h: 3, m: 7 }, at: NOW - 1000,
    party: [mon('a', 'route-29', 17, 18, { nick: 'Pip', item: 245, shiny: true }), mon('b', 'cherrygrove', 41, 172, { hp: 0 })] }),
  'live:p2': e({ source: 'live', badges: 1, at: NOW - 1000, party: [mon('c', 'route-29', 20, 17, { status: 8 })] }),
  'where:p1': e({ gen: 4, id: 177, name: 'Route 29', at: NOW - 500 }),
  'boss:falkner': e(true),
  'feed:x1': e({ at: 100, type: 'catch', slot: 'p1', area: 'route-29', species: 16, text: 'old', msg: { key: 'secret.key' } }, 5),
});
const lookups = { speciesName: (id) => `S${id}`, itemName: (id, gen) => (id === 245 && gen === 4 ? 'Pink Bow' : null), gameName: (id) => (id === 'pokemon-heartgold' ? 'Pokémon HeartGold' : null) };

test('state: players, party with HP/status/item/shiny/sprites, links, graveyard, encounters – nothing secret', () => {
  const s = buildState(manifest(), docOf(), { ...lookups, base: 'http://127.0.0.1:47390', now: NOW });
  const text = JSON.stringify(s);
  for (const bad of ['SECRET', 'room-', 'DEVICE-ID', 'Private Folder', 'Spoiler-Log', 'webhook', 'secret note', 'moves', 'ANA', 'secret.key']) assert.ok(!text.includes(bad), `leaks ${bad}`);
  assert.deepEqual(Object.keys(s), ['api', 'run', 'players', 'links', 'graveyard', 'encounters', 'feed', 'lang', 'generatedAt', 'updatedAt']);
  assert.equal(s.api, 1);
  assert.deepEqual(s.run.game, { id: 'pokemon-heartgold', name: 'Pokémon HeartGold', system: 'nds' });
  assert.equal(s.run.rules.dupes, 'line', 'the run’s own rules …');
  assert.equal(s.run.rules.typeClause, 'global', '… over the defaults');
  assert.deepEqual(s.run.counts, { alive: 1, dead: 1, caught: 2, missed: 1, encounters: 3 });
  const [ana, ben] = s.players;
  assert.deepEqual([ana.slot, ana.name, ana.color, ana.live, ana.badges], ['p1', 'Ana', '#7f9ddb', true, 2]);
  assert.deepEqual(ana.playTime, { h: 3, m: 7 });
  assert.deepEqual(ana.levelCap, { cap: 19, boss: { key: 'whitney', name: 'Whitney' } }, 'HeartGold: the third gym after two badges');
  assert.deepEqual(ana.location, { id: 177, gen: 4, name: 'Route 29', at: NOW - 500, battle: null });
  const pip = ana.party[0];
  assert.deepEqual([pip.species, pip.name, pip.nickname, pip.level, pip.hp, pip.maxHp, pip.status, pip.shiny, pip.alive, pip.areaName], [17, 'S17', 'Pip', 18, 20, 30, '', true, true, 'Route 29']);
  assert.deepEqual(pip.item, { id: 245, name: 'Pink Bow' });
  assert.equal(pip.sprites.front, 'http://127.0.0.1:47390/api/v1/sprites/gen4/front-shiny/17.png', 'the game’s own sprite, shiny');
  assert.equal(pip.sprites.icon, 'http://127.0.0.1:47390/api/v1/sprites/icon/front/17.png');
  const fainted = ana.party[1];
  assert.deepEqual([fainted.level, fainted.fainted, fainted.dead, fainted.alive], [null, true, true, false], 'Lv 172 is garbage; its link is dead');
  assert.equal(ben.party[0].status, 'psn');
  assert.deepEqual(s.encounters.map((x) => [x.area, x.state]), [['route-29', 'alive'], ['cherrygrove', 'dead'], ['route-30', 'failed']]);
  assert.equal(s.encounters[2].results.p2, null);
  assert.deepEqual(s.links.map((l) => [l.area, l.state]), [['route-29', 'alive'], ['cherrygrove', 'dead']]);
  assert.equal(s.links[1].members.p2.inParty, false, 'Ben’s Geodude comes from the encounter');
  assert.equal(s.graveyard[0].killer.name, 'S241');
  assert.deepEqual([s.graveyard[0].diedAt, s.graveyard[0].by, s.graveyard[0].level], [500, 'p2', 9]);
  assert.deepEqual(s.feed[0], { id: 'x1', at: 100, type: 'catch', slot: 'p1', area: 'route-29', areaName: 'Route 29', species: 16, name: 'S16' });
  assert.equal(s.updatedAt, 5);
});

test('sprites: the game’s style where the species exists, the modern default beyond; impossible ones are null', () => {
  assert.deepEqual(spriteSource('gen4', 'front', 25), { set: 'gen4', path: 'versions/generation-iv/heartgold-soulsilver/25.png', ext: 'png' });
  assert.deepEqual(spriteSource('gen3', 'back-shiny', 25), { set: 'gen3backshiny', path: 'versions/generation-iii/emerald/back/shiny/25.png', ext: 'png' });
  assert.deepEqual(spriteSource('default', 'front-shiny', 900), { set: 'shiny', path: 'shiny/900.png', ext: 'png' });
  assert.deepEqual(spriteSource('animated', 'front', 150), { set: 'gen5anim', path: 'versions/generation-v/black-white/animated/150.gif', ext: 'gif' });
  for (const bad of [['gen1', 'front-shiny', 25], ['gen3', 'front', 400], ['artwork', 'back', 25], ['icon', 'back', 25], ['icon', 'front', 900], ['gen9', 'front', 1], ['gen4', 'front', 0], ['../x', 'front', 1]]) {
    assert.equal(spriteSource(...bad), null, bad.join('/'));
  }
  const u = spriteUrls(400, { gen: 3, base: 'http://localhost:1' });
  assert.equal(u.style, 'default');
  assert.equal(u.front, `http://localhost:1${API_PREFIX}/sprites/default/front/400.png`);
  assert.equal(spriteUrls(25, { gen: 1, shiny: true }).front, '/api/v1/sprites/gen1/front/25.png', 'Gen 1 has no shiny sprites');
  assert.equal(spriteUrls(25, { gen: 1 }).frontShiny, null);
});

test('events: catch, death, level-up, evolution, faint, badge, location, battles, legendary encounters, run end', () => {
  const build = (d, now = NOW) => buildState(manifest(), d, { ...lookups, now });
  const d0 = docOf();
  const s0 = build(d0);
  assert.deepEqual(eventsBetween(null, s0), [], 'nothing on the first state');
  assert.deepEqual(eventsBetween(s0, build(d0)), [], 'nothing when nothing changed');
  const d1 = structuredClone(d0);
  d1['enc:route-30:p2'] = e({ outcome: 'caught', species: 10, level: 4, at: 40 });
  d1['enc:route-31:p1'] = e({ outcome: 'caught', species: 69, level: 5, at: 50 });
  d1['enc:route-31:p2'] = e({ outcome: 'caught', species: 43, level: 5, at: 51 });
  d1['enc:route-32:p1'] = e({ outcome: 'missed', species: 179, at: 60 });
  d1['enc:route-29:p1'] = d0['enc:route-29:p1'];
  d1['pair:route-29'] = e({ state: 'dead', diedAt: 900, by: 'p1', killer: { species: 95, level: 12, kind: 'wild' } });
  d1['live:p1'].v.badges = 3;
  d1['live:p1'].v.party[0] = mon('a', 'route-29', 18, 20, { nick: 'Pip' });
  d1['live:p2'].v.party[0] = mon('c', 'route-29', 20, 17, { hp: 0 });
  d1['where:p1'] = e({ gen: 4, id: 178, name: 'Route 30', at: NOW, fight: { kind: 'wild', species: 245, level: 40 } });
  d1['run:status'] = e({ state: 'failed', reason: 'wipe', at: NOW, by: 'p2' });
  const s1 = build(d1);
  const ev = eventsBetween(s0, s1);
  const types = ev.map((x) => x.type);
  assert.deepEqual(types, ['run-end', 'death', 'catch', 'catch', 'catch', 'missed', 'badge', 'location', 'battle-start', 'encounter', 'evolve', 'level-up', 'faint']);
  const of = (t) => ev.find((x) => x.type === t);
  assert.deepEqual([of('run-end').state, of('run-end').reason, of('run-end').slot], ['failed', 'wipe', 'p2']);
  assert.deepEqual([of('missed').slot, of('missed').area, of('missed').species], ['p1', 'route-32', 179]);
  const catches = ev.filter((x) => x.type === 'catch');
  assert.deepEqual(catches.map((c) => [c.area, c.slot, c.complete]), [['route-30', 'p2', false], ['route-31', 'p1', true], ['route-31', 'p2', true]]);
  assert.equal(of('death').area, 'route-29');
  assert.deepEqual(of('death').members.map((m) => m.slot), ['p1', 'p2']);
  assert.deepEqual(of('death').killer, { species: 95, name: 'S95', level: 12, kind: 'wild' });
  assert.equal(of('badge').badges, 3);
  assert.deepEqual(of('location').to, { id: 178, name: 'Route 30' });
  assert.deepEqual([of('encounter').species, of('encounter').name, of('encounter').legendary, of('encounter').kind], [245, 'S245', 'legendary', 'wild']);
  assert.deepEqual([of('evolve').from, of('evolve').to], [17, 18]);
  assert.deepEqual([of('level-up').from, of('level-up').to], [18, 20]);
  assert.equal(of('faint').slot, 'p2');
  assert.deepEqual(legendaryEncounters(ev).map((x) => x.species), [245]);
  assert.ok(ev.every((x) => x.run === 'c0ffee02' && x.at === NOW));
  // battle over, run resumed, a party change
  const d2 = structuredClone(d1);
  d2['where:p1'] = e({ gen: 4, id: 178, name: 'Route 30', at: NOW });
  d2['run:status'] = e(null, 9);
  d2['live:p2'].v.party.push(mon('z', null, 152, 5));
  assert.deepEqual(eventsBetween(s1, build(d2)).map((x) => x.type), ['run-start', 'battle-end', 'party']);
  // a trainer battle isn't an encounter
  const d3 = structuredClone(d2);
  d3['where:p1'] = e({ gen: 4, id: 178, name: 'Route 30', at: NOW, fight: { kind: 'trainer', species: 150, level: 70 } });
  assert.deepEqual(eventsBetween(build(d2), build(d3)).map((x) => x.type), ['battle-start']);
});

test('access: pages from this computer, OBS and curl may read; other sites need the token', () => {
  const req = (origin, headers = {}) => ({ headers: { ...(origin === undefined ? {} : { origin }), ...headers } });
  const url = new URL('http://127.0.0.1/api/v1');
  for (const o of [undefined, 'null', 'http://localhost:8080', 'http://127.0.0.1:5500', 'http://[::1]:3000', 'http://absolute']) assert.ok(localOrigin(o), String(o));
  for (const o of ['https://evil.example', 'http://localhost.evil.example', 'http://127.0.0.1.nip.io']) assert.ok(!localOrigin(o), o);
  assert.equal(v1AccessError(req(undefined), url), null);
  assert.equal(v1AccessError(req('https://evil.example'), url).status, 403);
  assert.equal(v1AccessError(req('https://evil.example'), url, { open: true }), null, 'sprites and the QR code are open');
  // Without a token, reject browser cross-site (same gate as /api/); same-site localhost layouts stay allowed.
  assert.equal(v1AccessError(req(undefined, { 'sec-fetch-site': 'cross-site' }), url).status, 403);
  assert.equal(v1AccessError(req('http://localhost:8080', { 'sec-fetch-site': 'same-site' }), url), null);
  assert.equal(v1AccessError(req(undefined, { 'sec-fetch-site': 'none' }), url), null);
  const token = 'abcdefghijklmnopqrstuv';
  assert.equal(v1AccessError(req(undefined), url, { token }).status, 401, 'with a token, everyone needs it');
  assert.equal(v1AccessError(req('https://my.layout.example'), new URL(`http://127.0.0.1/api/v1?token=${token}`), { token }), null);
  assert.equal(v1AccessError(req('https://my.layout.example', { 'sec-fetch-site': 'cross-site' }), new URL(`http://127.0.0.1/api/v1?token=${token}`), { token }), null, 'token overrides site');
  assert.equal(v1AccessError(req(undefined, { authorization: `Bearer ${token}` }), url, { token }), null);
  assert.equal(requestToken(req(undefined, { 'x-souldew-token': 'x' }), url), 'x');
  assert.equal(v1AccessError(req(undefined, { authorization: 'Bearer wrong' }), url, { token }).status, 401);
  assert.deepEqual(streamSettings({}), { token: '', coffee: true, corner: 'bl' }, 'pop-up on by default');
  assert.deepEqual(streamSettings({ stream: { token: 'short', coffee: false, corner: 'tr' } }), { token: '', coffee: false, corner: 'tr' });
});

// ---- the server ------------------------------------------------------------------------------------------------

function sse(url, headers = {}) {
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const waiting = [];
  const got = [];
  let buf = '';
  const req = request(url, { headers }, (res) => {
    resolveReady({ status: res.statusCode, headers: res.headers });
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!ev) continue;
        got.push([ev, JSON.parse(data)]);
        for (const w of [...waiting]) w();
      }
    });
  });
  req.end();
  const next = (name, ms = 3000) => new Promise((resolve, reject) => {
    const check = () => {
      const i = got.findIndex(([n]) => n === name);
      if (i < 0) return false;
      resolve(got.splice(i, 1)[0][1]);
      return true;
    };
    if (check()) return;
    const t = setTimeout(() => reject(new Error(`no ${name}: got ${got.map(([n]) => n)}`)), ms);
    const w = () => {
      if (check()) {
        clearTimeout(t);
        waiting.splice(waiting.indexOf(w), 1);
      }
    };
    waiting.push(w);
  });
  return { ready, next, got, close: () => req.destroy() };
}

test('server: /api/v1 JSON, CORS, token, read-only, sprites, live events and the coffee pop-up', async () => {
  // a legendary whose roll for this run is lucky – the pop-up must show
  const lucky = [144, 145, 146, 150, 243, 244, 245, 249, 250, 377, 382, 383, 384].find((id) => coffeeRoll(`c0ffee02:${id}`) < COFFEE.chance);
  const unlucky = [144, 145, 146, 150, 243, 244, 245, 249, 250].find((id) => coffeeRoll(`c0ffee02:${id}`) >= COFFEE.chance);
  assert.ok(lucky && unlucky);
  const dir = join(DATA, 'runs', 'c0ffee02');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(manifest()));
  const doc = docOf();
  doc['live:p1'].v.at = Date.now();
  doc['where:p1'].v.at = Date.now();
  writeFileSync(join(dir, 'doc.json'), JSON.stringify(doc));
  mkdirSync(join(DATA, 'cache', 'sprites', 'gen4'), { recursive: true });
  writeFileSync(join(DATA, 'cache', 'sprites', 'gen4', '25.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { server, url } = await startServer({ port: 0, background: false });
  const put = (body) => fetch(`${url}/api/runs/c0ffee02/doc`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify(body) });
  try {
    const index = await (await fetch(`${url}/api/v1`)).json();
    assert.equal(index.api, 1);
    assert.equal(index.currentRun, 'c0ffee02');
    assert.equal(index.docs, LINKS.streamApiDocs);
    const runs = await (await fetch(`${url}/api/v1/runs`)).json();
    assert.deepEqual(runs.map((r) => [r.id, r.current, r.players.length]), [['c0ffee02', true, 2]]);

    const r = await fetch(`${url}/api/v1/runs/current?lang=de`, { headers: { origin: 'http://localhost:8080' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:8080');
    const text = await r.text();
    for (const bad of ['SECRET', 'DEVICE-ID', 'Private Folder', 'Spoiler']) assert.ok(!text.includes(bad), bad);
    const st = JSON.parse(text);
    assert.equal(st.players[0].party[0].name, 'Tauboga', 'species names in the asked language');
    assert.equal(st.players[0].party[0].item.name, 'Giftstich', 'held item named from the Gen 4 table (item 245: Poison Barb)');
    assert.match(st.players[0].party[0].sprites.front, /^http:\/\/localhost:\d+\/api\/v1\/sprites\/gen4\/front-shiny\/17\.png$/, 'absolute URLs for pages opened from disk');
    assert.equal((await (await fetch(`${url}/api/v1/runs/c0ffee02/players/p2`)).json()).name, 'Ben');
    assert.equal((await (await fetch(`${url}/api/v1/runs/c0ffee02/graveyard`)).json())[0].area, 'cherrygrove');
    assert.equal((await fetch(`${url}/api/v1/runs/c0ffee02/players/p3`)).status, 404);
    assert.equal((await fetch(`${url}/api/v1/runs/deadbeef`)).status, 404);
    assert.equal((await fetch(`${url}/api/v1/nope`)).status, 404);

    // other websites: no; file:// pages and OBS: yes; read-only
    assert.equal((await fetch(`${url}/api/v1/runs/current`, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${url}/api/v1/runs/current`, { headers: { origin: 'null' } })).status, 200);
    assert.equal((await fetch(`${url}/api/v1/runs/current`, { method: 'POST', body: '{}' })).status, 405);
    const pre = await fetch(`${url}/api/v1/runs/current`, { method: 'OPTIONS', headers: { origin: 'https://my.layout.example', 'access-control-request-method': 'GET', 'access-control-request-private-network': 'true' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
    assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
    // the app's own API stays closed to other origins, as before
    assert.equal((await fetch(`${url}/api/runs/c0ffee02/doc`, { headers: { origin: 'http://localhost:8080' } })).status, 403);

    // sprites: the app's cache, open to every page, only real sprite paths
    const sp = await fetch(`${url}/api/v1/sprites/gen4/front/25.png`, { headers: { origin: 'https://my.layout.example' } });
    assert.equal(sp.status, 200);
    assert.equal(sp.headers.get('content-type'), 'image/png');
    assert.equal(sp.headers.get('access-control-allow-origin'), 'https://my.layout.example');
    assert.equal((await fetch(`${url}/api/v1/sprites/gen1/front-shiny/25.png`)).status, 404);
    assert.equal((await fetch(`${url}/api/v1/sprites/gen4/front/25.gif`)).status, 404);
    const qr = await fetch(`${url}/api/v1/coffee/qr.svg`);
    assert.equal(qr.headers.get('content-type'), 'image/svg+xml');
    assert.match(await qr.text(), /<path fill="#111" d="M4 4h7/);
    assert.deepEqual(Object.keys(await (await fetch(`${url}/api/v1/coffee`)).json()), ['url', 'short', 'qr', 'enabled', 'corner', 'chance', 'cooldownMinutes', 'showSeconds']);

    // settings: on by default, corner, token
    const set = (body) => fetch(`${url}/api/stream`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify(body) }).then((x) => x.json());
    const s0 = await (await fetch(`${url}/api/stream`, { headers: { 'sec-fetch-site': 'same-origin' } })).json();
    assert.deepEqual([s0.coffee, s0.corner, s0.token], [true, 'bl', '']);
    assert.match(s0.base, /^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/);
    assert.equal((await set({ corner: 'tr' })).corner, 'tr');
    assert.equal((await set({ corner: 'middle' })).corner, 'tr', 'only the four corners');
    const tok = (await set({ token: 'new' })).token;
    assert.match(tok, /^[A-Za-z0-9_-]{24}$/);
    assert.equal((await fetch(`${url}/api/v1/runs/current`)).status, 401);
    assert.equal((await fetch(`${url}/api/v1/runs/current?token=${tok}`, { headers: { origin: 'https://my.layout.example' } })).status, 200);
    assert.equal((await fetch(`${url}/api/v1/sprites/gen4/front/25.png`)).status, 200, 'sprites need no token');
    assert.equal((await set({ token: '' })).token, '');
    assert.equal((await fetch(`${url}/api/stream`, { method: 'POST', body: '{}' })).status, 403, 'settings are the app’s, not the open API’s');

    // live: state first, then events after the app uploads its doc
    const es = sse(`${url}/api/v1/runs/current/events?lang=en`, { origin: 'null' });
    const ready = await es.ready;
    assert.equal(ready.status, 200);
    assert.match(ready.headers['content-type'], /text\/event-stream/);
    assert.equal(ready.headers['access-control-allow-origin'], '*');
    assert.equal((await es.next('hello')).run, 'c0ffee02');
    assert.equal((await es.next('state')).players.length, 2);
    const overlay = sse(`${url}/api/runs/c0ffee02/overlay/events?lang=en&w=popup`);
    await overlay.ready;
    await overlay.next('snapshot');

    assert.equal((await put({ 'enc:route-31:p1': e({ outcome: 'caught', species: 69, level: 5, at: 50 }, Date.now()) })).status, 200);
    const caught = await es.next('catch');
    assert.deepEqual([caught.slot, caught.area, caught.species, caught.name], ['p1', 'route-31', 69, 'Bellsprout']);
    assert.equal((await es.next('state')).encounters.length, 4);

    // an unlucky legendary: the encounter and the legendary event, no pop-up
    await put({ 'where:p1': e({ gen: 4, id: 177, name: 'Route 29', at: Date.now(), fight: { kind: 'wild', species: unlucky, level: 50 } }, Date.now()) });
    assert.equal((await es.next('encounter')).species, unlucky);
    assert.equal((await es.next('legendary')).species, unlucky);
    // the lucky one: the coffee event (API) and the pop-up in the overlay snapshot
    await put({ 'where:p1': e({ gen: 4, id: 177, name: 'Route 29', at: Date.now(), fight: { kind: 'wild', species: lucky, level: 50 } }, Date.now() + 1) });
    const coffee = await es.next('coffee');
    assert.deepEqual([coffee.species, coffee.slot, coffee.player, coffee.corner, coffee.layer, coffee.url], [lucky, 'p1', 'Ana', 'tr', true, LINKS.coffee]);
    assert.ok(coffee.joke.includes(coffee.name) && coffee.cta && coffee.kicker && coffee.qr.endsWith('/api/v1/coffee/qr.svg'));
    let snap = await overlay.next('snapshot');
    while (!snap.popup) snap = await overlay.next('snapshot');
    assert.equal(snap.popup.species, lucky);
    assert.ok(snap.species[lucky], 'the overlay gets the name with it');
    const cfg = JSON.parse(readFileSync(join(DATA, 'config.json'), 'utf8'));
    assert.deepEqual(cfg.coffeeHistory.runs.c0ffee02.sort(), [lucky, unlucky].sort(), 'both rolls remembered');
    // the same legendary again: no second pop-up (once per species and run)
    await put({ 'where:p1': e({ gen: 4, id: 177, name: 'Route 29', at: Date.now() }, Date.now() + 2) });
    await put({ 'where:p1': e({ gen: 4, id: 177, name: 'Route 29', at: Date.now(), fight: { kind: 'wild', species: lucky, level: 50 } }, Date.now() + 3) });
    await es.next('legendary');
    await new Promise((res) => setTimeout(res, 100));
    assert.ok(!es.got.some(([n]) => n === 'coffee'));

    // switched off: the preview still works (it is a preview), real encounters don't pop
    await set({ coffee: false });
    const pv = await (await fetch(`${url}/api/runs/c0ffee02/coffee/preview`, { method: 'POST', headers: { 'x-soullink': '1' } })).json();
    assert.equal(pv.ok, true);
    assert.ok(isLegendary(pv.popup.species) && pv.popup.species <= 493, 'a legendary of the run’s generation');
    assert.equal(pv.popup.test, true);
    assert.equal((await es.next('coffee')).test, true);
    assert.equal((await fetch(`${url}/api/runs/c0ffee02/coffee/preview`, { method: 'POST' })).status, 403);
    es.close();
    overlay.close();
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
