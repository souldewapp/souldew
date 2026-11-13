// "Share to Discord" (Live runs): event ids, the post's text and its limits, the link code and the card's PNG
// check (shared/liveruns.mjs), the card model from a run doc (web/lib/liveshare.mjs), and the local server against a
// mock of the bot (the contract's routes – never the real bot): linking, status, posting, every error status, and
// that the player's token never reaches the page, the config, a run folder or a log line.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { registerHooks } from 'node:module';
import {
  eventIdFor, buildMeta, metaProblem, normalizeCode, pngProblem, cleanText, hasLink, clip, LIMITS, CARD_W, CARD_H,
} from '../shared/liveruns.mjs';
import { LIVE_FIXTURES } from './fixtures/livecards.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'souldew-live-'));
process.env.SLS_DATA_DIR = DATA;

// web/lib/*.mjs import browser paths (/shared/…, /vendor/…): map them onto the project folder
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(`${ROOT}node_modules/htm/preact/standalone.module.js`, ctx);
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});

// ---- a PNG of any size (grey, 8 bit) ----
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function png(w = CARD_W, h = CARD_H) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 0x40);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------------------------------------------
test('event ids: stable, the same for every player of the run, unique per event, within 64 characters', () => {
  const a = eventIdFor('8f2c11aa', 'death', { area: 'route-29', at: 1763040000000 });
  assert.equal(a, eventIdFor('8f2c11aa', 'death', { area: 'route-29', at: 1763040000000 }));
  assert.match(a, /^run-8f2c11aa:death:route-29:[a-z0-9]+$/);
  assert.notEqual(a, eventIdFor('8f2c11aa', 'death', { area: 'route-30', at: 1763040000000 }), 'another group');
  assert.notEqual(a, eventIdFor('8f2c11aa', 'death', { area: 'route-29', at: 1763040000001 }), 'died again after an undo');
  assert.notEqual(a, eventIdFor('0000aaaa', 'death', { area: 'route-29', at: 1763040000000 }), 'another run');
  const wipe = eventIdFor('8f2c11aa', 'wipe', { at: 1763040000000 });
  const won = eventIdFor('8f2c11aa', 'victory', { at: 1763040000000 });
  assert.match(wipe, /^run-8f2c11aa:wipe:/);
  assert.match(won, /^run-8f2c11aa:victory:/);
  // a long custom area name: hashed, still stable and short
  const long = eventIdFor('8f2c11aa', 'death', { area: `custom-${'x'.repeat(200)}`, at: 1 });
  assert.ok(long.length <= LIMITS.eventId);
  assert.equal(long, eventIdFor('8f2c11aa', 'death', { area: `custom-${'x'.repeat(200)}`, at: 1 }));
  assert.notEqual(long, eventIdFor('8f2c11aa', 'death', { area: `custom-${'y'.repeat(200)}`, at: 1 }));
  for (const id of [a, wipe, won, long]) assert.ok(id.length <= 64 && /^[a-z0-9:-]+$/.test(id), id);
});

test('meta: cleaned and cut to the contract, links and control characters out, file names never sent', () => {
  const { meta, changed } = buildMeta({
    eventId: 'run-8f2c11aa:death:route-29:abc', kind: 'death', mode: 'soullink',
    game: 'Pokémon HeartGold Version', run: 'Robin – HeartGold.nds', players: ['Robin', 'Kim', 'Lou', 'Sam', 'Fifth'],
    headline: 'Ember and Chomp are gone', detail: 'Ember fell – see https://evil.example/x and www.spam.io or discord.gg/abc',
  });
  assert.equal(meta.v, 1);
  assert.equal(meta.run, 'Robin – HeartGold');
  assert.deepEqual(meta.players, ['Robin', 'Kim', 'Lou', 'Sam']);
  assert.ok(!hasLink(meta.detail), meta.detail);
  assert.deepEqual(changed, ['detail']);
  assert.equal(metaProblem(meta), null);

  const long = buildMeta({ eventId: 'e', kind: 'nope', mode: 'x', game: 'G'.repeat(99), run: 'R'.repeat(99), players: ['P'.repeat(50)], headline: 'H'.repeat(300), detail: 'D'.repeat(600) }).meta;
  assert.equal(long.kind, 'death');
  assert.equal(long.mode, 'soullink');
  assert.equal(long.game.length, LIMITS.game);
  assert.equal(long.run.length, LIMITS.run);
  assert.equal(long.players[0].length, LIMITS.player);
  assert.equal(long.headline.length, LIMITS.headline);
  assert.equal(long.detail.length, LIMITS.detail);
  assert.ok(long.headline.endsWith('…'));
  assert.equal(metaProblem(long), null);

  // control characters, bidi overrides and zero-width characters
  assert.equal(cleanText('Em\u0000ber\n‮Kim​!', 40), 'Em ber Kim!');
  // a nickname with a link word: taken out, and the page is told
  const nick = buildMeta({ eventId: 'e', headline: 'HTTPMON is gone', players: ['wwW.Bob'] });
  assert.equal(nick.meta.headline, 'MON is gone');
  assert.deepEqual(nick.changed.sort(), ['headline', 'players']);
  // emoji are never cut in half
  assert.equal(clip('😀😀😀', 4), '😀…');
  // run, detail and players may be empty; the headline may not
  assert.equal(metaProblem(buildMeta({ eventId: 'e', headline: 'x' }).meta), null);
  assert.equal(metaProblem(buildMeta({ eventId: 'e', headline: '' }).meta), 'headline');
  assert.equal(metaProblem({ ...buildMeta({ eventId: 'e', headline: 'x' }).meta, detail: 'http://x' }), 'detail');
  // `app` only as a version
  assert.equal(buildMeta({ eventId: 'e', headline: 'x', app: '2.6.0-beta.1' }).meta.app, '2.6.0-beta.1');
  assert.equal(buildMeta({ eventId: 'e', headline: 'x', app: 'evil' }).meta.app, undefined);
});

test('link code and card PNG checks', () => {
  assert.equal(normalizeCode('k7q-4m2'), 'K7Q-4M2');
  assert.equal(normalizeCode(' K7Q 4M2 '), 'K7Q-4M2');
  assert.equal(normalizeCode('K7Q4M2'), 'K7Q-4M2');
  assert.equal(normalizeCode('K7Q-4M0'), null, '0 is not in the alphabet');
  assert.equal(normalizeCode('K7Q-4M'), null);
  assert.equal(pngProblem(png()), null);
  assert.equal(pngProblem(png(1280, 720)), 'dimensions');
  assert.equal(pngProblem(Buffer.from('GIF89a…'.repeat(10))), 'signature');
  assert.equal(pngProblem(Buffer.alloc(0)), 'empty');
  assert.equal(pngProblem(Buffer.concat([png(), Buffer.alloc(1.6 * 1024 * 1024)])), 'size');
});

test('bot answers → what the page shows', async () => {
  const { outcome } = await import('../server/lib/liveruns.mjs');
  assert.deepEqual(outcome(200, {}), { ok: true });
  assert.deepEqual(outcome(0), { ok: false, error: 'offline' });
  assert.deepEqual(outcome(401, { error: 'token' }), { ok: false, error: 'token' });
  assert.deepEqual(outcome(403, { error: 'blocked' }), { ok: false, error: 'blocked' });
  assert.deepEqual(outcome(403, { error: 'not-member' }), { ok: false, error: 'not-member' });
  assert.deepEqual(outcome(409, { error: 'duplicate' }), { ok: false, error: 'duplicate' });
  assert.deepEqual(outcome(429, { error: 'rate', retryAfter: 140 }), { ok: false, error: 'rate', retryAfter: 140 });
  assert.deepEqual(outcome(429, {}), { ok: false, error: 'rate', retryAfter: 60 });
  assert.deepEqual(outcome(400, { error: 'code' }), { ok: false, error: 'code' });
  assert.deepEqual(outcome(422, { error: 'meta', field: 'headline', reason: 'word' }), { ok: false, error: 'invalid', field: 'headline', reason: 'word' });
  assert.deepEqual(outcome(413, { error: 'image' }), { ok: false, error: 'invalid', field: 'image', reason: null });
  assert.deepEqual(outcome(415, { error: 'meta', field: 'body' }), { ok: false, error: 'invalid', field: 'body', reason: null });
  assert.deepEqual(outcome(502, { error: 'discord' }), { ok: false, error: 'unavailable' });
  assert.deepEqual(outcome(503, { error: 'unavailable' }), { ok: false, error: 'unavailable' });
  assert.deepEqual(outcome(405, {}), { ok: false, error: 'server' });
});

test('the base URL: the bot by default, SOULDEW_LIVE_URL only as https or on this computer', async () => {
  const { liveBase, LIVE_RUNS_URL } = await import('../server/lib/liveruns.mjs');
  assert.equal(liveBase({}), LIVE_RUNS_URL);
  assert.equal(liveBase({ SOULDEW_LIVE_URL: 'http://127.0.0.1:5555/' }), 'http://127.0.0.1:5555');
  assert.equal(liveBase({ SOULDEW_LIVE_URL: 'https://staging.example/bot/' }), 'https://staging.example/bot');
  assert.equal(liveBase({ SOULDEW_LIVE_URL: 'http://evil.example' }), LIVE_RUNS_URL, 'no plain http to another host');
  assert.equal(liveBase({ SOULDEW_LIVE_URL: 'nonsense' }), LIVE_RUNS_URL);
});

// ---------------------------------------------------------------------------------------------------------------
// The card model from a run doc (the fixtures scripts/render-live-cards.mjs paints)
test('card model: headline, killer, place and teams from the run doc', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (!u.startsWith('/shared/')) return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ games: [], hacks: [] }) };
    const body = readFileSync(new URL(`..${u}`, import.meta.url), 'utf8');
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => JSON.parse(body) };
  };
  globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
  try {
    const { loadData } = await import('../web/lib/data.mjs');
    await loadData();
  } finally {
    globalThis.fetch = realFetch;
  }
  const { RunDoc } = await import('../web/lib/doc.mjs');
  const L = await import('../web/lib/liveshare.mjs');
  const build = (name) => {
    const f = LIVE_FIXTURES.find((x) => x.name === name);
    const doc = new RunDoc(f.manifest.id);
    doc._persistSoon = () => {};
    doc.batch(f.entries);
    const event = f.event.kind === 'death' ? L.deathEvent(doc, f.manifest, f.event.area) : L.endEvent(f.manifest, doc.get('run:status'));
    return { f, doc, event, ...L.cardModel({ doc, manifest: f.manifest, gen: f.gen, event }) };
  };

  const two = build('soullink-2-death');
  assert.equal(two.event.id, eventIdFor('8f2c11aa', 'death', { area: 'route-29', at: 1763040000000 }), 'the id comes from the run, not the player');
  assert.equal(two.model.headline, 'Ember and Chomp are gone');
  assert.deepEqual(two.model.highlights.map((h) => h.text), ['Ember', 'Chomp']);
  assert.equal(two.model.cause.species, 241);
  assert.equal(two.model.cause.level, 19);
  assert.equal(two.model.cause.chip, 'Trainer battle');
  assert.equal(two.model.cause.place, 'Goldenrod Gym');
  assert.equal(two.model.teams.length, 2);
  const states = (slot) => Object.fromEntries(two.model.teams.find((x) => x.slot === slot).mons.map((m) => [m.name, m.state]));
  assert.equal(states('p1').Ember, 'fallen');
  assert.equal(states('p2').Chomp, 'fallen', 'the linked partner is marked too');
  assert.equal(states('p2').Hops, 'dead', 'an earlier death is greyed');
  assert.equal(states('p1').Pidge, 'alive');
  assert.ok(two.model.teams[0].mons.some((m) => m.name === 'Wooper' && m.sub === ''), 'a nickname that is the species name shows once');
  assert.equal(two.metaInput.detail, 'Ember (Lv 18 Cyndaquil) fell to Miltank Lv 19 in a trainer battle · Goldenrod Gym · Kim’s Chomp went with it');
  const { meta } = buildMeta(two.metaInput);
  assert.equal(metaProblem(meta), null);
  assert.deepEqual(meta.players, ['Robin', 'Kim']);
  assert.equal(meta.kind, 'death');
  assert.equal(meta.mode, 'soullink');

  const four = build('soullink-4-death');
  assert.equal(four.model.teams.length, 4);
  assert.equal(four.model.headline, 'Leaflet, Venny, Dune & Puff are gone');
  assert.ok(four.model.teams.every((tm) => tm.mons.some((m) => m.state === 'fallen')), 'every player’s linked Pokémon is marked');

  const solo = build('nuzlocke-death');
  assert.equal(solo.model.mode, 'nuzlocke');
  assert.equal(solo.model.teams.length, 1);
  assert.equal(solo.model.headline, 'Blaze is gone');
  assert.equal(solo.model.cause.chip, 'Wild battle');
  assert.equal(solo.model.cause.place, 'Mt. Moon');
  assert.equal(buildMeta(solo.metaInput).meta.mode, 'nuzlocke');

  const wipe = build('nuzlocke-wipe');
  assert.equal(wipe.event.kind, 'wipe');
  assert.equal(wipe.model.headline, 'Lou’s Nuzlocke is over');
  assert.equal(wipe.model.cause.species, 74, 'the last one to fall and its killer');
  const won = build('soullink-2-victory');
  assert.equal(won.event.kind, 'victory');
  assert.equal(won.model.headline, 'Robin & Kim beat the Champion!');
  assert.equal(won.model.cause.title, 'Volt', 'the strongest Pokémon still standing');

  // no file names, paths or invite codes anywhere on a card or in its text (streamer mode)
  for (const f of LIVE_FIXTURES) {
    const { model, metaInput } = build(f.name);
    const all = JSON.stringify({ model, metaInput });
    assert.ok(!/\.(nds|gba|gbc|gb|3ds|sav|zip)\b|[/\\]Users[/\\]|room|secret/i.test(all), f.name);
    // never "faint" in the new texts
    assert.ok(!/faint/i.test(all), f.name);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The local server against a mock of the bot

/** The contract's routes, in memory. `force` answers the next request with a fixed status. */
function mockBot() {
  const s = { codes: new Map([['K7Q4M2', { id: '123', name: 'Ash' }], ['ABC234', { id: '123', name: 'Ash' }]]), tokens: new Map(), posts: [], ids: new Set(), force: null, requests: [] };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    s.requests.push({ method: req.method, path: url.pathname, headers: req.headers });
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (s.force) {
      const f = s.force;
      s.force = null;
      return json(f.status, f.body);
    }
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (url.pathname === '/live/link' && req.method === 'POST') {
      const { code, app, platform } = JSON.parse(body.toString());
      s.lastLink = { code, app, platform };
      const key = String(code).replace('-', '');
      if (!s.codes.has(key)) return json(400, { error: 'code' });
      const user = s.codes.get(key);
      s.codes.delete(key);
      const tok = randomBytes(32).toString('hex');
      s.tokens.set(tok, user);
      return json(200, { token: tok, user });
    }
    if (url.pathname === '/live/link' && req.method === 'DELETE') {
      s.tokens.delete(token);
      return json(200, { ok: true });
    }
    if (url.pathname === '/live/me' && req.method === 'GET') {
      if (!s.tokens.has(token)) return json(401, { error: 'token' });
      return json(200, { user: s.tokens.get(token), limits: { perDay: 10, usedToday: s.posts.length, nextInSec: 0 } });
    }
    if (url.pathname === '/live/post' && req.method === 'POST') {
      if (!s.tokens.has(token)) return json(401, { error: 'token' });
      const ct = String(req.headers['content-type'] || '');
      if (!ct.startsWith('multipart/form-data')) return json(415, { error: 'meta', field: 'body' });
      const form = await new Request('http://x/', { method: 'POST', headers: { 'content-type': ct }, body }).formData();
      const image = form.get('image');
      if (!image || image.type !== 'image/png') return json(415, { error: 'image' });
      const meta = JSON.parse(form.get('meta'));
      if (pngProblem(Buffer.from(await image.arrayBuffer()))) return json(422, { error: 'image' });
      if (metaProblem(meta)) return json(422, { error: 'meta', field: metaProblem(meta), reason: 'length' });
      if (s.ids.has(meta.eventId)) return json(409, { error: 'duplicate' });
      s.ids.add(meta.eventId);
      s.posts.push({ meta, name: image.name, size: image.size });
      return json(200, { ok: true, url: 'https://discord.com/channels/1/2/3' });
    }
    return json(405, { error: 'method' });
  });
  return { s, server };
}

let bot;
let app;
let base;
const seen = []; // every answer of the local server and every log line, checked for the token at the end
const logs = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };

before(async () => {
  bot = mockBot();
  await new Promise((r) => bot.server.listen(0, '127.0.0.1', r));
  process.env.SOULDEW_LIVE_URL = `http://127.0.0.1:${bot.server.address().port}`;
  for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { logs.push(a.map(String).join(' ')); };
  const { startServer } = await import('../server/app.mjs');
  app = await startServer({ port: 0, background: false });
  base = app.url;
});
after(() => {
  Object.assign(console, realConsole);
  app?.server.close();
  bot?.server.close();
  rmSync(DATA, { recursive: true, force: true });
});

async function call(method, path, body) {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'x-soullink': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  seen.push(text);
  return { status: r.status, body: JSON.parse(text) };
}
const card = () => png().toString('base64');
const metaFor = (eventId, extra = {}) => ({ v: 1, eventId, kind: 'death', mode: 'soullink', game: 'Pokémon HeartGold', run: 'Robin & Kim', players: ['Robin', 'Kim'], headline: 'Ember and Chomp are gone', detail: 'Ember (Lv 18 Cyndaquil) fell to Miltank Lv 19', ...extra });
const token = () => [...bot.s.tokens.keys()][0];

test('server: link with the code, status with today’s posts, the token stays on the server', async () => {
  assert.deepEqual((await call('GET', '/api/liveruns')).body.linked, false);
  // a wrong code: the bot says so (the code isn't used up)
  assert.equal((await call('POST', '/api/liveruns/link', { code: 'ZZZ-ZZZ' })).body.error, 'code');
  // a malformed one never reaches the bot
  const before = bot.s.requests.length;
  assert.equal((await call('POST', '/api/liveruns/link', { code: 'nope' })).body.error, 'code');
  assert.equal(bot.s.requests.length, before);

  const r = await call('POST', '/api/liveruns/link', { code: 'k7q 4m2' });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.linked, true);
  assert.equal(r.body.user.name, 'Ash');
  assert.equal(bot.s.lastLink.code, 'K7Q-4M2');
  assert.match(bot.s.lastLink.app, /^souldew \d+\.\d+\.\d+/);
  assert.equal(bot.s.lastLink.platform, process.platform);
  assert.ok(token());
  // where it is kept: live-runs.json in the data folder, readable only by this user, not config.json
  const file = join(DATA, 'live-runs.json');
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).token === token());
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o077, 0);

  const st = await call('GET', '/api/liveruns?check=1');
  assert.equal(st.body.linked, true);
  assert.equal(st.body.limits.perDay, 10);
  assert.equal(st.body.limits.left, 10);
  assert.equal(bot.s.requests.at(-1).headers.authorization, `Bearer ${token()}`);
});

test('server: posting – multipart with meta and image/png, the app version filled in, shared remembered', async () => {
  const id = eventIdFor('8f2c11aa', 'death', { area: 'route-29', at: 1763040000000 });
  const r = await call('POST', '/api/liveruns/post', { meta: metaFor(id, { app: '9.9.9', detail: 'see http://spam.example' }), image: card() });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.url, 'https://discord.com/channels/1/2/3');
  const sent = bot.s.posts.at(-1);
  assert.equal(sent.meta.eventId, id);
  assert.equal(sent.meta.app, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, 'the running version, not what the page says');
  assert.ok(!hasLink(sent.meta.detail));
  assert.equal(sent.name, 'card.png');
  assert.equal((await call('GET', '/api/liveruns')).body.shared[id].url, 'https://discord.com/channels/1/2/3');
  assert.equal((await call('GET', '/api/liveruns?check=1')).body.limits.left, 9);

  // the same event again (this player or a partner – the id is the same for the run): already shared
  const again = await call('POST', '/api/liveruns/post', { meta: metaFor(id), image: card() });
  assert.equal(again.body.error, 'duplicate');
  assert.equal(bot.s.posts.length, 1);

  // a broken card or text never reaches the bot
  const n = bot.s.requests.length;
  assert.equal((await call('POST', '/api/liveruns/post', { meta: metaFor('x'), image: png(800, 600).toString('base64') })).status, 400);
  assert.equal((await call('POST', '/api/liveruns/post', { meta: metaFor('x', { headline: '' }), image: card() })).status, 400);
  assert.equal(bot.s.requests.length, n);
});

test('server: every error status of the bot', async () => {
  const post = async (force) => {
    bot.s.force = force;
    return (await call('POST', '/api/liveruns/post', { meta: metaFor(`run-x:death:a:${Math.random().toString(36).slice(2, 8)}`), image: card() })).body;
  };
  const rate = await post({ status: 429, body: { error: 'rate', retryAfter: 140 } });
  assert.equal(rate.error, 'rate');
  assert.equal(rate.retryAfter, 140);
  assert.equal((await post({ status: 403, body: { error: 'blocked' } })).error, 'blocked');
  assert.equal((await post({ status: 403, body: { error: 'not-member' } })).error, 'not-member');
  const word = await post({ status: 422, body: { error: 'meta', field: 'headline', reason: 'word' } });
  assert.deepEqual([word.error, word.field, word.reason], ['invalid', 'headline', 'word']);
  assert.equal((await post({ status: 502, body: { error: 'discord' } })).error, 'unavailable');
  assert.equal((await post({ status: 503, body: { error: 'unavailable' } })).error, 'unavailable');
  assert.equal((await post({ status: 500, body: {} })).error, 'server');
  assert.equal((await call('GET', '/api/liveruns')).body.linked, true, 'none of these ends the link');
  // 401: the token is revoked (or a sixth device was linked) – it is dropped here, the page says "Connect again"
  assert.equal((await post({ status: 401, body: { error: 'token' } })).error, 'token');
  assert.equal((await call('GET', '/api/liveruns')).body.linked, false);
  assert.equal(JSON.parse(readFileSync(join(DATA, 'live-runs.json'), 'utf8')).token, undefined);
});

test('server: a revoked token found by the status check; unlinking', async () => {
  assert.equal((await call('POST', '/api/liveruns/link', { code: 'ABC-234' })).body.linked, true);
  const tok = token();
  bot.s.tokens.clear(); // revoked in Discord
  const st = await call('GET', '/api/liveruns?check=1');
  assert.equal(st.body.linked, false);
  assert.equal(st.body.expired, true);
  // link again and unlink: the bot is told, the token is gone here
  bot.s.codes.set('XYZ234', { id: '123', name: 'Ash' });
  await call('POST', '/api/liveruns/link', { code: 'XYZ-234' });
  const t2 = token();
  assert.notEqual(t2, tok);
  const un = await call('DELETE', '/api/liveruns/link');
  assert.equal(un.body.linked, false);
  assert.equal(un.body.reached, true);
  assert.equal(bot.s.tokens.size, 0);
  assert.equal(bot.s.requests.at(-1).headers.authorization, `Bearer ${t2}`);
  // keep one linked for the leak check below
  bot.s.codes.set('QRS234', { id: '123', name: 'Ash' });
  await call('POST', '/api/liveruns/link', { code: 'QRS-234' });
  seen.push(tok, t2); // (only so the next test knows them – it checks they appear nowhere but the token file)
});

test('the token never reaches the page, the config, a run folder, an export or a log line', async () => {
  const tokens = [...new Set([token(), ...seen.filter((x) => /^[a-f0-9]{64}$/.test(x))])].filter(Boolean);
  assert.ok(tokens.length >= 2);
  // what the page can ask for
  for (const path of ['/api/status', '/api/liveruns', '/api/liveruns?check=1', '/api/catalog']) await call('GET', path);
  await call('POST', '/api/config', { playerName: 'Ash' }); // answers with the whole config
  const answers = seen.filter((x) => !/^[a-f0-9]{64}$/.test(x)).join('\n');
  for (const tk of tokens) {
    assert.ok(!answers.includes(tk), 'an API answer');
    assert.ok(!logs.join('\n').includes(tk), 'a log line');
  }
  // on disk: only live-runs.json holds it – not config.json, not the runs folder (run packs and exports come from there)
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(DATA);
  const holders = files.filter((f) => tokens.some((tk) => readFileSync(f, 'latin1').includes(tk)));
  assert.deepEqual(holders, [join(DATA, 'live-runs.json')]);
  assert.ok(!existsSync(join(DATA, 'runs', 'live-runs.json')));
  // the page's code never handles a bot token: no Authorization header, no bot address, no token file in web/
  const web = [];
  const walkWeb = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (['vendor', 'assets', 'i18n'].includes(name)) continue;
      if (statSync(p).isDirectory()) walkWeb(p);
      else if (/\.(mjs|js|html)$/.test(name)) web.push(readFileSync(p, 'utf8'));
    }
  };
  walkWeb(new URL('../web/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const src = web.join('\n');
  assert.ok(!/Authorization|Bearer |live-runs\.json|workers\.dev|\/live\/(?:post|link|me)\b/.test(src));
});
