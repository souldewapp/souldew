// "New attempt" after a run is over, with the real sync layer: every player gets the "run is over" notice with its
// "New attempt" button. Whoever presses it, all players must end up in ONE new run – same room and secret – and
// their edits must sync there (issue #6: two players both restarted → two runs with their own rooms → no sync).
// In-memory brokers only, no real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SyncLink } from '../web/lib/sync.mjs';
import { RunDoc } from '../web/lib/doc.mjs';
import { newAttempt, restartPlan, RESTART_KEY, CLAIM_TTL } from '../shared/restart.mjs';
import { readFileSync } from 'node:fs';

/** Minimal in-memory MQTT brokers: topics, retained messages (delivered on subscribe), async delivery. */
function fakeNet() {
  const brokers = new Map();
  const broker = (url) => {
    if (!brokers.has(url)) brokers.set(url, { clients: new Set(), retained: new Map() });
    return brokers.get(url);
  };
  const mod = {
    connect(url, opts = {}) {
      const c = new EventEmitter();
      Object.assign(c, { url, opts, connected: false, subs: [], ended: false });
      c.subscribe = (pattern) => {
        const prefix = pattern.replace(/#$/, '');
        c.subs.push(prefix);
        for (const [topic, buf] of broker(url).retained) if (topic.startsWith(prefix)) setTimeout(() => c.connected && c.emit('message', topic, buf, { retain: true }), 1);
      };
      c.publish = (topic, payload, o = {}) => {
        if (!c.connected) return;
        const b = broker(url);
        const buf = Buffer.from(payload);
        if (o.retain) {
          if (buf.length) b.retained.set(topic, buf);
          else b.retained.delete(topic);
        }
        for (const x of b.clients) if (x.connected && x.subs.some((p) => topic.startsWith(p))) setTimeout(() => x.connected && x.emit('message', topic, buf, { retain: false }), 1);
      };
      c.end = () => {
        c.ended = true;
        broker(url).clients.delete(c);
        c.connected = false;
      };
      setTimeout(() => {
        if (c.ended) return;
        broker(url).clients.add(c);
        c.connected = true;
        c.emit('connect');
      }, 1);
      return c;
    },
  };
  return { importer: async () => mod };
}
const noP2P = async () => ({ joinRoom: () => ({ makeAction: () => ({ send() {}, onMessage: null }), leave() {}, getPeers: () => ({}) }) });

const until = async (fn, ms = 8000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const links = [];
test.afterEach(() => {
  for (const l of links.splice(0)) l.stop();
});

const hex = () => Math.random().toString(16).slice(2, 10).padEnd(8, '0');
const OLD = { id: 'aaaa0001', name: 'Lou & Noa', room: 'old-room', secret: 'old-secret-123' };

/**
 * One computer: its copy of the old run (document + live link) and its run list. Like the app, it is in exactly one
 * run at a time – `run` is that run's manifest, `doc` / `link` its document and link.
 */
async function computer(net, slot, players) {
  const c = { slot, name: players[slot].name, runs: [{ id: OLD.id }], builds: 0 };
  await enter(net, c, { ...OLD, players });
  c.oldDoc = c.doc;
  return c;
}

/** Open a run on a computer (app.mjs: the run switch stops the old link, loads the doc, connects the new room). */
async function enter(net, c, m) {
  c.link?.stop();
  c.run = m;
  c.doc = Object.assign(new RunDoc(m.id), { by: `dev-${c.slot}`, _persistSoon() {} });
  c.link = new SyncLink({ room: m.room, secret: m.secret, slot: c.slot, name: c.name, doc: c.doc, importers: { mqtt: net.importer, trystero: noP2P } });
  links.push(c.link);
  await c.link.start();
  await until(() => c.link.status.relay === 'connected', 8000, `${c.slot} relay`);
}

/** POST /api/runs/build stand-in: takes `ms` like the randomizer does, then a new run with its own room and secret. */
const builder = (c, ms) => async () => {
  c.builds++;
  await sleep(ms);
  const id = hex();
  const manifest = { id, name: `${OLD.name} #2`, room: `room-${hex()}`, secret: `secret-${hex()}${hex()}`, players: c.run.players };
  c.runs.push({ id });
  return { manifest, pack: { format: 'soullink-studio/run-pack@1', ...manifest } };
};

/** The "New attempt" button in the run-over notice (views/restart.mjs RestartModal → newAttempt). */
function pressAgain(c, { buildMs = 400, fail = false } = {}) {
  return newAttempt({
    doc: c.oldDoc, me: c.slot, byName: c.name, runs: c.runs, settle: 250,
    build: fail ? async () => { c.builds++; throw new Error('Java missing'); } : builder(c, buildMs),
    discard: async (id) => { c.runs = c.runs.filter((r) => r.id !== id); c.discarded = id; },
  });
}

/** The app's offer check (app.mjs): another player's new run in the old doc that this computer doesn't have yet. */
const offerIn = (c) => {
  const r = c.oldDoc.get(RESTART_KEY);
  return r?.id && r.pack && r.by !== c.slot && !c.runs.some((x) => x.id === r.id) ? r : null;
};

/** What the app does with the button's result: play the new run, or join the other player's (RestartOffer). */
async function follow(net, c, res) {
  if (res.started) return enter(net, c, res.started.manifest);
  let plan = res.plan;
  if (plan.action === 'wait') plan = { action: 'join', offer: await until(() => offerIn(c), 8000, `${c.slot} gets the invite`) };
  if (plan.action === 'join') {
    c.runs.push({ id: plan.offer.pack.id }); // POST /api/runs/import
    return enter(net, c, plan.offer.pack);
  }
  throw new Error(`unexpected plan ${plan.action}`);
}

/** A player who doesn't press anything: the offer pops up, they join. */
async function acceptOffer(net, c) {
  const offer = await until(() => offerIn(c), 8000, `${c.slot} gets the invite`);
  c.runs.push({ id: offer.pack.id });
  await enter(net, c, offer.pack);
}

async function runOver(cs) {
  cs[0].oldDoc.set('run:status', { state: 'failed', by: cs[0].slot, at: Date.now(), auto: true });
  await until(() => cs.every((c) => c.oldDoc.get('run:status')?.state === 'failed'), 8000, 'everyone sees the run end');
}

/** Everyone is in the same new run, and an edit of each player reaches all the others there. */
async function assertSynced(cs) {
  const ids = new Set(cs.map((c) => c.run.id));
  const rooms = new Set(cs.map((c) => `${c.run.room}|${c.run.secret}`));
  assert.equal(ids.size, 1, `one new run for everyone, got ${[...ids]}`);
  assert.equal(rooms.size, 1, 'one room and secret for everyone');
  assert.notEqual(cs[0].run.id, OLD.id);
  for (const c of cs) c.doc.set(`enc:route-1:${c.slot}`, { species: 16, by: c.slot });
  for (const c of cs) {
    for (const o of cs) await until(() => c.doc.get(`enc:route-1:${o.slot}`)?.by === o.slot, 8000, `${c.slot} sees ${o.slot}'s edit in the new run`);
  }
}

const TWO = { p1: { name: 'Lou' }, p2: { name: 'Noa' } };
const FOUR = { p1: { name: 'Lou' }, p2: { name: 'Noa' }, p3: { name: 'Kim' }, p4: { name: 'Ari' } };

test('run over, the host presses "New attempt", the partner presses it too while the host builds: one new run, edits sync', async () => {
  const net = fakeNet();
  const host = await computer(net, 'p1', TWO);
  const guest = await computer(net, 'p2', TWO);
  await runOver([host, guest]);
  const h = pressAgain(host, { buildMs: 700 });
  await sleep(450); // the host's build is running – the guest still sees the run-over notice and presses too
  const g = await pressAgain(guest);
  assert.equal(g.plan?.action, 'wait', 'the guest waits for the host\'s invite instead of building a run of their own');
  assert.equal(g.plan.byName, 'Lou');
  assert.equal(guest.builds, 0);
  await Promise.all([h.then((res) => follow(net, host, res)), follow(net, guest, g)]);
  await assertSynced([host, guest]);
});

test('both press "New attempt" at the same moment: one claim wins on both computers, both play that run', async () => {
  const net = fakeNet();
  const host = await computer(net, 'p1', TWO);
  const guest = await computer(net, 'p2', TWO);
  await runOver([host, guest]);
  const [h, g] = await Promise.all([pressAgain(host), pressAgain(guest)]);
  assert.equal([h, g].filter((r) => r.started).length, 1, 'exactly one of them builds the new run');
  await Promise.all([follow(net, host, h), follow(net, guest, g)]);
  await assertSynced([host, guest]);
});

test('the partner presses "New attempt" after the host\'s new run is ready (offer dismissed): they join it, no second run', async () => {
  const net = fakeNet();
  const host = await computer(net, 'p1', TWO);
  const guest = await computer(net, 'p2', TWO);
  await runOver([host, guest]);
  const h = await pressAgain(host);
  assert.ok(h.started);
  await until(() => offerIn(guest), 8000, 'invite reaches the guest');
  const g = await pressAgain(guest);
  assert.equal(g.plan?.action, 'join');
  assert.equal(guest.builds, 0);
  await Promise.all([enter(net, host, h.started.manifest), follow(net, guest, g)]);
  await assertSynced([host, guest]);
});

test('only the host presses it (the usual way): the partner accepts the offer and the new run syncs', async () => {
  const net = fakeNet();
  const host = await computer(net, 'p1', TWO);
  const guest = await computer(net, 'p2', TWO);
  await runOver([host, guest]);
  const h = await pressAgain(host);
  await Promise.all([follow(net, host, h), acceptOffer(net, guest)]);
  await assertSynced([host, guest]);
});

test('four players: two press at the same moment, one during the build, one accepts the offer later – all in one run', async () => {
  const net = fakeNet();
  const cs = [];
  for (const s of ['p1', 'p2', 'p3', 'p4']) cs.push(await computer(net, s, FOUR));
  const [p1, p2, p3, p4] = cs;
  await runOver(cs);
  const first = [pressAgain(p1, { buildMs: 900 }), pressAgain(p3, { buildMs: 900 })];
  await sleep(500);
  const second = pressAgain(p2);
  const [r1, r3, r2] = await Promise.all([...first, second]);
  assert.equal([r1, r3, r2].filter((r) => r.started).length, 1, 'one new run is built for the group');
  assert.equal(p2.builds, 0);
  await Promise.all([follow(net, p1, r1), follow(net, p3, r3), follow(net, p2, r2), acceptOffer(net, p4)]);
  await assertSynced(cs);
});

test('a failed build gives the claim back: the partner is not left waiting and may start the new attempt', async () => {
  const net = fakeNet();
  const host = await computer(net, 'p1', TWO);
  const guest = await computer(net, 'p2', TWO);
  await runOver([host, guest]);
  await assert.rejects(pressAgain(host, { fail: true }), /Java missing/);
  await until(() => guest.oldDoc.get(RESTART_KEY) === undefined && host.oldDoc.get(RESTART_KEY) === undefined, 8000, 'claim cleared everywhere');
  const g = await pressAgain(guest);
  assert.ok(g.started, 'the guest builds it instead');
  await Promise.all([follow(net, guest, g), acceptOffer(net, host)]);
  await assertSynced([host, guest]);
});

test('restartPlan: claims, invites, stale claims, own entries – and 2.3.0 ignores a claim', () => {
  const now = 1_000_000_000;
  const runs = [{ id: OLD.id }];
  assert.deepEqual(restartPlan(null, { me: 'p2', runs, now }), { action: 'build' });
  assert.deepEqual(restartPlan({ by: 'p2', building: true, at: now }, { me: 'p2', runs, now }), { action: 'build' }, 'our own claim');
  assert.equal(restartPlan({ by: 'p1', building: true, at: now - 1000, byName: 'Lou' }, { me: 'p2', runs, now }).action, 'wait');
  assert.equal(restartPlan({ by: 'p1', building: true, at: now - CLAIM_TTL - 1 }, { me: 'p2', runs, now }).action, 'build', 'stale claim (app closed mid-build)');
  // a 2.3.0 invite (no claim, no byName) is joined just the same
  const invite = { id: 'bbbb0002', name: 'Lou & Noa #2', by: 'p1', at: now, pack: { id: 'bbbb0002' } };
  assert.deepEqual(restartPlan(invite, { me: 'p2', runs, now }), { action: 'join', offer: invite });
  assert.equal(restartPlan(invite, { me: 'p2', runs: [...runs, { id: 'bbbb0002' }], now }).action, 'open');
  // our own finished new attempt: pressing "New attempt" in the old run again opens it instead of building another
  assert.equal(restartPlan(invite, { me: invite.by, runs: [...runs, { id: invite.id }], now }).action, 'open');
  assert.equal(restartPlan(invite, { me: invite.by, runs, now }).action, 'build', 'unless it was deleted here');
  assert.equal(restartPlan('garbage', { me: 'p2', runs, now }).action, 'build');
  // app.mjs in 2.3.0 offers a join only for an entry with id and pack – a claim never looks like an invite there
  const v230offers = (r, me) => !!(r?.id && r.pack && r.by !== me);
  assert.equal(v230offers({ by: 'p1', building: true, at: now, claim: 'x' }, 'p2'), false);
});

test('no live document (run not open, solo): nothing is claimed, a saved invite of another player is joined', async () => {
  let built = 0;
  const build = async () => { built++; return { manifest: { id: 'cccc0003' }, pack: {} }; };
  const saved = { id: 'bbbb0002', name: 'X #2', by: 'p1', at: 1, pack: { id: 'bbbb0002' } };
  assert.equal((await newAttempt({ entry: saved, me: 'p2', runs: [], build })).plan.action, 'join');
  assert.equal(built, 0);
  assert.ok((await newAttempt({ entry: null, me: 'p1', runs: [], build })).started);
  assert.equal(built, 1);
});

// Found with two app instances over the real sync (#6): the joining player reloaded the join page of the new attempt
// (or restarted the app) – the page took the app's `me` while it was still the default p1, built the host's seat and
// renamed the host to the joiner's name for everyone. The seat now comes from the stored choice for the new run.
test('joining a new attempt: the seat comes from the stored choice, not the app default (#6); the file is named like the host’s', () => {
  const view = readFileSync(new URL('../web/views/soullink.mjs', import.meta.url), 'utf8');
  const join = view.slice(view.indexOf('function JoinRun()'));
  assert.match(join, /const \[slot, setSlot\] = useState\(pack \? mySlotIn\(pack\) : null\);/);
  assert.match(join, /setPack\(manifest\);\n\s+setSlot\(mySlotIn\(manifest\)\);/);
  assert.doesNotMatch(join.slice(0, join.indexOf('const build')), /setSlot\(me\)|useState\(pack && me/);
  // the RestartOffer stores the old run's seat for the new run before the join page opens
  const offer = readFileSync(new URL('../web/views/restart.mjs', import.meta.url), 'utf8');
  assert.match(offer, /setMe\(offer\.slot \|\| me, m\.id\);/);
  // a pre-patched hack (no patch file) is named by the hack, as the host's wizard names it
  assert.match(join, /gameTitle: pack\.patch\?\.name \|\| hackById\(pack\.game\?\.hackId\)\?\.name \|\|/);
});
