// Invite by code: code → topic/pad derivation and the whole handshake over an in-memory broker – the run pack
// only arrives after "Allow", never in readable form on the relay, and wrong / declined / expired / reused /
// contested codes get nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { newCode, normalizeCode, formatCode, deriveCodeKeys, inviteCodeSupported, CodeHost, joinWithCode, confirmationCode, suggestSlot } from '../web/lib/invitecode.mjs';

/** In-memory MQTT broker: every client subscribed to `prefix/#` gets every publish (async, like a socket). */
function fakeMqtt() {
  const clients = new Set();
  const log = [];
  const mod = {
    connect() {
      const c = new EventEmitter();
      c.connected = false;
      c.subs = [];
      c.subscribe = (pattern) => c.subs.push(pattern.replace(/#$/, ''));
      c.publish = (topic, payload, opts = {}) => {
        const buf = Buffer.from(payload);
        log.push({ topic, opts, buf });
        for (const o of clients) if (o.connected && o.subs.some((p) => topic.startsWith(p))) setTimeout(() => o.emit('message', topic, buf), 1);
      };
      c.end = () => {
        c.connected = false;
        clients.delete(c);
      };
      clients.add(c);
      setTimeout(() => {
        c.connected = true;
        c.emit('connect');
      }, 1);
      return c;
    },
  };
  return { importer: async () => mod, log, clients };
}

const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
};
const pack = () => ({
  format: 'soullink-studio/run-pack@1', id: 'a1b2c3d4', name: 'Lou & Robin', room: 'room-0123456789', secret: 'SECRET-ROOM-KEY-0f9e8d7c',
  players: { p1: { name: 'Lou' }, p2: { name: 'Robin' } }, randomizer: { enabled: true, seeds: { p1: '1', p2: '2' }, values: {} },
});
async function hostOn(broker, o = {}) {
  const states = [];
  const host = new CodeHost({ pack: pack(), importers: { mqtt: broker.importer }, onState: (s) => states.push(s), ...o });
  await host.start();
  assert.equal(host.state.phase, 'waiting');
  return { host, states };
}
const guest = (broker, code, o = {}) => joinWithCode(code, { name: 'Robin', importers: { mqtt: broker.importer }, ...o });
const leaked = (broker, s) => broker.log.some((m) => m.buf.includes(Buffer.from(s)));

test('codes: 6 uniform digits, forgiving input, readable output', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = newCode();
    assert.match(c, /^\d{6}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 190);
  assert.equal(normalizeCode(' 123 456 '), '123456');
  assert.equal(normalizeCode('123-456'), '123456');
  assert.equal(normalizeCode('12345'), null);
  assert.equal(normalizeCode('12a456'), null);
  assert.equal(normalizeCode(null), null);
  assert.equal(formatCode('012345'), '012 345');
});

test('code derivation: deterministic, slow-KDF topic that does not show the code, separate pad', async () => {
  assert.equal(await inviteCodeSupported(), true);
  const a = await deriveCodeKeys('123456');
  const b = await deriveCodeKeys('123 456');
  const c = await deriveCodeKeys('123457');
  assert.equal(a.topic, b.topic);
  assert.deepEqual(a.pad, b.pad);
  assert.notEqual(a.topic, c.topic);
  assert.notDeepEqual(a.pad, c.pad);
  assert.match(a.topic, /^slstudio\/invite\/v1\/[0-9a-f]{32}$/);
  assert.ok(!a.topic.includes('123456'));
  assert.equal(a.pad.length, 32);
  assert.ok(!a.topic.includes(Buffer.from(a.pad.subarray(0, 8)).toString('hex')), 'the pad is not part of the topic');
  // the iteration count really goes into the result (a cheap derivation would not match)
  assert.notEqual((await deriveCodeKeys('123456', 1000)).topic, a.topic);
  await assert.rejects(deriveCodeKeys('12345'));
});

test('host allows → partner receives the pack; the relay never sees it, the code or the name in clear', async () => {
  const broker = fakeMqtt();
  const { host, states } = await hostOn(broker);
  const phases = [];
  const g = guest(broker, formatCode(host.code), { onState: (p) => phases.push(p) });
  await until(() => host.state.phase === 'request');
  assert.equal(host.state.request.name, 'Robin');
  assert.ok(phases.includes('waiting'));
  await host.allow({ confirmed: true });
  const got = await g.promise;
  assert.deepEqual(got, pack());
  await until(() => host.state.phase === 'done');
  assert.equal(host.state.acked, true);
  assert.ok(states.some((s) => s.phase === 'sending'));
  assert.equal(broker.clients.size, 0, 'both sides hung up');
  assert.ok(broker.log.length > 0 && broker.log.every((m) => m.opts.retain === false));
  for (const s of ['SECRET-ROOM-KEY', 'room-0123456789', 'Robin', 'Lou', host.code]) assert.ok(!leaked(broker, s), `${s} must not travel in clear`);
});

test('host declines → partner gets nothing, code stays open but the attempt counts', async () => {
  const broker = fakeMqtt();
  const { host } = await hostOn(broker);
  const g = guest(broker, host.code);
  await until(() => host.state.phase === 'request');
  await host.decline();
  await assert.rejects(g.promise, { code: 'declined' });
  assert.equal(host.state.phase, 'waiting');
  assert.equal(host.state.fails, 1);
  assert.ok(!leaked(broker, 'SECRET-ROOM-KEY'));
  host.cancel();
  assert.equal(host.state.phase, 'cancelled');
});

test('wrong code → nobody answers, the host never hears of it', async () => {
  const broker = fakeMqtt();
  const { host } = await hostOn(broker, { code: '111111' });
  const g = guest(broker, '111112', { noHostMs: 400 });
  await assert.rejects(g.promise, { code: 'no-host' });
  assert.equal(host.requests.size, 0);
  assert.equal(host.state.phase, 'waiting');
  await assert.rejects(guest(broker, '11111').promise, { code: 'bad' });
  host.cancel();
});

test('right topic but wrong key (brute-forced topic, guessed pad) → rejected, locked after 3 tries', async () => {
  const broker = fakeMqtt();
  const { host } = await hostOn(broker, { code: '222222' });
  const { topic } = await deriveCodeKeys('222222');
  const mod = await broker.importer();
  const attacker = mod.connect();
  const replies = [];
  attacker.on('connect', () => attacker.subscribe(`${topic}/#`));
  attacker.on('message', (t, buf) => replies.push({ t, buf }));
  await until(() => attacker.connected);
  for (let i = 0; i < 3; i++) {
    const rid = `attacker${i}xxxx`.slice(0, 12);
    attacker.publish(`${topic}/req/${rid}`, JSON.stringify({ v: 1, key: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') }));
    await until(() => replies.some((r) => r.t.endsWith(`/res/${rid}`)));
    // a "hello" sealed with a key the host doesn't share
    attacker.publish(`${topic}/hello/${rid}`, Buffer.concat([Buffer.from([0]), Buffer.from(crypto.getRandomValues(new Uint8Array(60)))]));
    await until(() => replies.some((r) => r.t.endsWith(`/pack/${rid}`)));
  }
  await until(() => host.state.phase === 'locked');
  assert.equal(host.state.fails, 3);
  assert.ok(replies.filter((r) => r.t.includes('/pack/')).every((r) => r.buf[0] === 0x7b), 'only plain error replies – never a sealed pack');
  // the real partner arrives too late: the code is dead
  await assert.rejects(guest(broker, '222222', { noHostMs: 400 }).promise, { code: 'no-host' });
  attacker.end();
});

test('code expires: a waiting partner is told, and so is one who comes later while the host app is open', async () => {
  const broker = fakeMqtt();
  const { host } = await hostOn(broker, { ttl: 1500, linger: 3000 });
  const g = guest(broker, host.code);
  // expect the rejection right away: it can land while we still wait for the request (a slow machine), and an
  // unawaited rejection would fail the test on its own
  const told = assert.rejects(g.promise, { code: 'expired' });
  await until(() => ['request', 'expired'].includes(host.state.phase));
  await told;
  assert.equal(host.state.phase, 'expired');
  // somebody types the code after the 15 minutes: "expired", not "nobody answered – check the digits"
  await assert.rejects(guest(broker, host.code, { noHostMs: 2000 }).promise, { code: 'expired' });
  assert.ok(!leaked(broker, 'SECRET-ROOM-KEY'));
  // the lingering answerer ends by itself …
  await until(() => broker.clients.size === 0, 6000);
  await assert.rejects(guest(broker, host.code, { noHostMs: 400 }).promise, { code: 'no-host' });
});

test('an expired code that still answers "expired" is shut down by a new code / cancel', async () => {
  const broker = fakeMqtt();
  const { host } = await hostOn(broker, { ttl: 300 });
  await until(() => host.state.phase === 'expired');
  assert.ok(broker.clients.size > 0, 'still answering latecomers');
  host.cancel(); // what startSession() does before a new code
  assert.equal(broker.clients.size, 0, 'relay closed');
  assert.equal(host.state.phase, 'expired', 'the dialog keeps saying why');
});

test('single use: once allowed, a second partner gets "used"', async () => {
  const broker = fakeMqtt();
  const { host } = await hostOn(broker);
  const g1 = guest(broker, host.code);
  await until(() => host.state.phase === 'request');
  // the first partner's receipt gets lost → the host keeps listening (and must still refuse everybody else)
  for (const c of broker.clients) {
    const pub = c.publish;
    c.publish = (topic, ...rest) => (topic.includes('/ack/') ? undefined : pub(topic, ...rest));
  }
  await host.allow({ confirmed: true });
  assert.equal((await g1.promise).secret, pack().secret);
  assert.equal(host.state.phase, 'sending');
  await assert.rejects(guest(broker, host.code, { name: 'Mallory' }).promise, { code: 'used' });
  host.cancel();
});

test('two people with the same code → the code is cancelled, nobody gets the pack', async () => {
  const broker = fakeMqtt();
  const { host } = await hostOn(broker);
  const g1 = guest(broker, host.code);
  await until(() => host.state.phase === 'request');
  const g2 = guest(broker, host.code, { name: 'Mallory' });
  await assert.rejects(g1.promise, { code: 'conflict' });
  await assert.rejects(g2.promise, (e) => ['conflict', 'no-host'].includes(e.code));
  assert.equal(host.state.phase, 'conflict');
  assert.ok(!leaked(broker, 'SECRET-ROOM-KEY'));
});

test('partner gives up while waiting → the host goes back to waiting, no false conflict', async () => {
  const broker = fakeMqtt();
  const { host } = await hostOn(broker);
  const g1 = guest(broker, host.code);
  await until(() => host.state.phase === 'request');
  g1.cancel();
  await assert.rejects(g1.promise, { code: 'cancelled' });
  await until(() => host.state.phase === 'waiting');
  const g2 = guest(broker, host.code);
  await until(() => host.state.phase === 'request');
  await host.allow({ confirmed: true });
  assert.equal((await g2.promise).secret, pack().secret);
});

test('allow() without confirmed does not seal the pack when a confirmation code is shown', async () => {
  const broker = fakeMqtt();
  const { host } = await hostOn(broker);
  const g = guest(broker, host.code);
  g.promise.catch(() => {});
  await until(() => host.state.phase === 'request' && host.state.request.confirm);
  await host.allow();
  assert.equal(host.state.phase, 'request', 'display-only confirm is not enough');
  await host.allow({ confirmed: true });
  assert.deepEqual(await g.promise, pack());
});

test('confirmation code: host and partner see the same 4 digits, other sessions see other ones', async () => {
  const broker = fakeMqtt();
  const { host } = await hostOn(broker);
  let seen = null;
  const g = guest(broker, host.code, { onState: (p, info) => p === 'waiting' && (seen = info?.confirm) });
  await until(() => host.state.phase === 'request' && seen);
  assert.match(host.state.request.confirm, /^\d{4}$/);
  assert.equal(seen, host.state.request.confirm, 'both sides derive the same confirmation code');
  await host.allow({ confirmed: true });
  await g.promise;

  // pure derivation: deterministic, bound to the secret, the request id and both masked keys
  const shared = crypto.getRandomValues(new Uint8Array(32));
  const pad = crypto.getRandomValues(new Uint8Array(32));
  const hm = crypto.getRandomValues(new Uint8Array(32));
  const gm = crypto.getRandomValues(new Uint8Array(32));
  const c = await confirmationCode(shared, pad, 'abcdefghijkl', hm, gm);
  assert.match(c, /^\d{4}$/);
  assert.equal(await confirmationCode(shared, pad, 'abcdefghijkl', hm, gm), c);
  const others = new Set();
  for (let i = 0; i < 20; i++) others.add(await confirmationCode(crypto.getRandomValues(new Uint8Array(32)), pad, 'abcdefghijkl', hm, gm));
  assert.ok(others.size >= 15, 'different secrets give (almost always) different codes');
});

test('host app closes or restarts while the request is open → the partner hears it within seconds, not after 15 min', async () => {
  const broker = fakeMqtt();
  const { host } = await hostOn(broker);
  const g = guest(broker, host.code, { hostGoneMs: 400 });
  await until(() => host.state.phase === 'request' && host.requests.get(host.state.request.rid)?.waitMsg);
  await new Promise((r) => setTimeout(r, 50)); // its first "still deciding" has reached the partner (under load, too)
  host.stop(); // a crash says nothing
  const t0 = Date.now();
  await assert.rejects(g.promise, { code: 'host-gone' });
  assert.ok(Date.now() - t0 < 5000);
});

test('the partner reloads their app while asking and tries again → no false "someone else used the code"', async () => {
  const broker = fakeMqtt();
  const { host } = await hostOn(broker);
  const before = new Set(broker.clients);
  // first attempt reaches "waiting for Allow" …
  const g1 = guest(broker, host.code);
  await until(() => host.state.phase === 'request');
  const rid1 = host.state.request.rid;
  // … then the app dies: its connection goes silent, no goodbye reaches the host
  for (const c of broker.clients) if (!before.has(c)) c.publish = () => {};
  g1.cancel();
  await g1.promise.catch(() => {});
  await new Promise((r) => setTimeout(r, 50)); // a resend still in flight would mark it as seen again
  host.requests.get(rid1).seen = Date.now() - 60000; // silent for a while (faster than waiting 9 s)
  // the same person again, with a new request: no conflict, the new one is shown and can be allowed
  const g2 = guest(broker, host.code);
  await until(() => host.state.phase === 'request' && host.state.request.rid !== rid1);
  await host.allow({ confirmed: true });
  assert.equal((await g2.promise).secret, pack().secret);
});

// --- runs with more than two players ---------------------------------------------------------------------
const pack4 = () => ({
  ...pack(), name: 'Lou, Robin, Mika & Sam',
  players: { p1: { name: 'Lou' }, p2: { name: 'Robin' }, p3: { name: 'Mika' }, p4: { name: 'Sam' } },
  randomizer: { enabled: true, seeds: { p1: '1', p2: '2', p3: '3', p4: '4' }, values: {} },
});

test('suggestSlot: the player with the same name (free first), else the first free one, null when all are taken', () => {
  const players = pack4().players;
  assert.equal(suggestSlot(players, ['p1']), 'p2');
  assert.equal(suggestSlot(players, ['p1', 'p2']), 'p3');
  assert.equal(suggestSlot(players, ['p1'], ' sam '), 'p4', 'the name decides when it matches a free player');
  assert.equal(suggestSlot(players, ['p1', 'p4'], 'Sam'), 'p4', '… a taken one too: that is Sam re-joining (the join page says it is taken)');
  assert.equal(suggestSlot(players, ['p1', 'p4'], 'Nobody'), 'p2');
  assert.equal(suggestSlot(players, ['p1', 'p2', 'p3', 'p4']), null);
  assert.equal(suggestSlot({ p1: { name: 'A' }, p2: { name: 'B' } }, ['p1']), 'p2', 'two-player runs as before');
  assert.equal(suggestSlot(null, []), null);
});

test('suggestSlot: everybody is in and the name does not match → the one who is away (re-joining after a reinstall)', () => {
  const players = pack4().players;
  const all = ['p1', 'p2', 'p3', 'p4'];
  assert.equal(suggestSlot(players, all, 'Somebody Else', ['p1', 'p2', 'p4']), 'p3', 'not p4 (live right now) and not null');
  assert.equal(suggestSlot(players, all, 'Sam', ['p1', 'p2', 'p3']), 'p4', 'a matching name still wins');
  assert.equal(suggestSlot(players, all, 'Sam', ['p1', 'p2', 'p3', 'p4']), 'p4', '… even when that player looks live (their old install may still be open)');
  assert.equal(suggestSlot(players, ['p1', 'p3'], 'Nobody', ['p1']), 'p2', 'a free seat still comes first – a new player');
  assert.equal(suggestSlot(players, all, 'Nobody', all), null, 'everybody is live: no guess');
});

test('third player: the host sends the pack with all players plus a seat hint; one code after the other', async () => {
  const broker = fakeMqtt();
  const taken = ['p1', 'p2'];
  const seat = (name) => ({ slot: suggestSlot(pack4().players, taken, name), taken: [...taken] });
  const { host } = await hostOn(broker, { pack: pack4(), seat });
  let got = null;
  const g = guest(broker, host.code, { name: 'Mika', onState: (p, info) => p === 'received' && (got = info) });
  await until(() => host.state.phase === 'request');
  await host.allow({ confirmed: true });
  const p = await g.promise;
  assert.deepEqual(Object.keys(p.players), ['p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(got, { slot: 'p3', taken: ['p1', 'p2'] });
  assert.equal(host.state.seat.slot, 'p3');
  await until(() => host.state.phase === 'done');
  assert.ok(!leaked(broker, 'Mika'), 'the name travels encrypted');
  // the fourth player gets their own, new code – the used one is dead
  taken.push('p3');
  const { host: host2 } = await hostOn(broker, { pack: pack4(), seat });
  assert.notEqual(host2.code, host.code);
  await assert.rejects(guest(broker, host.code, { noHostMs: 400 }).promise, { code: 'no-host' });
  let got2 = null;
  const g2 = guest(broker, host2.code, { name: 'Sam', onState: (ph, info) => ph === 'received' && (got2 = info) });
  await until(() => host2.state.phase === 'request');
  assert.match(host2.state.request.confirm, /^\d{4}$/, 'the 4-digit check works for every code');
  await host2.allow({ confirmed: true });
  await g2.promise;
  assert.deepEqual(got2, { slot: 'p4', taken: ['p1', 'p2', 'p3'] });
});

test('seat hint is checked against the pack, and an older host (no hint) still works', async () => {
  const broker = fakeMqtt();
  const { host } = await hostOn(broker, { pack: pack4(), seat: () => ({ slot: 'p9', taken: ['p1', 'x', 'p2'] }) });
  let got = null;
  const g = guest(broker, host.code, { onState: (p, info) => p === 'received' && (got = info) });
  await until(() => host.state.phase === 'request');
  await host.allow({ confirmed: true });
  await g.promise;
  assert.deepEqual(got, { slot: 'p3', taken: ['p1', 'p2'] });
  // no seat function: like an older host
  const { host: old } = await hostOn(broker);
  let got2 = null;
  const g2 = guest(broker, old.code, { name: 'robin', onState: (p, info) => p === 'received' && (got2 = info) });
  await until(() => old.state.phase === 'request');
  await old.allow({ confirmed: true });
  assert.deepEqual(await g2.promise, pack());
  assert.deepEqual(got2, { slot: 'p2', taken: [] }, 'a matching name is the only hint');
});

test('host app is closed on purpose (page hidden) → the waiting partner is told right away: host-gone', async () => {
  const broker = fakeMqtt();
  const { host } = await hostOn(broker);
  const g = guest(broker, host.code, { hostGoneMs: 60000 });
  g.promise.catch(() => {});
  try {
    await until(() => host.state.phase === 'request');
    host.leave();
    const t0 = Date.now();
    await assert.rejects(g.promise, { code: 'host-gone' });
    assert.ok(Date.now() - t0 < 1000, 'not after the host-gone timeout');
    assert.equal(host.state.phase, 'cancelled');
  } finally {
    g.cancel(); // a failing assertion must not leave the guest's 15-minute timers running
    host.stop();
  }
});
