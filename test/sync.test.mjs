// Connection / sync layer under bad conditions: partner offline, brokers down, crashes, two devices for one
// player, oversized documents, clock skew – and runs with three or four players. Only in-memory fakes – no real
// broker or Nostr relay is contacted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SyncLink, BROKERS, PARTNER_TTL } from '../web/lib/sync.mjs';
import { RunDoc } from '../web/lib/doc.mjs';

/**
 * In-memory network of MQTT brokers (one per URL) that behaves like mqtt.js + a real broker where it matters:
 * retained messages (delivered on subscribe with packet.retain), last wills on an abrupt drop, 'offline' only
 * once per outage, reconnect every reconnectPeriod (sped up), and an optional payload limit that drops the
 * connection like public brokers do.
 */
function fakeNet({ maxPayload = Infinity } = {}) {
  const brokers = new Map();
  const broker = (url) => {
    if (!brokers.has(url)) brokers.set(url, { up: true, clients: new Set(), retained: new Map() });
    return brokers.get(url);
  };
  const log = [];
  const deliver = (b, topic, buf, retainFlag) => {
    if (retainFlag) {
      if (buf.length) b.retained.set(topic, buf);
      else b.retained.delete(topic);
    }
    for (const o of b.clients) {
      if (o.connected && o.subs.some((p) => topic.startsWith(p))) setTimeout(() => o.connected && o.emit('message', topic, buf, { retain: false }), 1);
    }
  };
  const drop = (c) => {
    // abrupt: the broker publishes the last will
    const b = broker(c.url);
    if (!b.clients.has(c)) return;
    b.clients.delete(c);
    const was = c.connected;
    c.connected = false;
    const w = c.opts.will;
    if (w) deliver(b, w.topic, Buffer.from(w.payload), w.retain);
    if (was) c.emit('close');
    c.retry();
  };
  const mod = {
    connect(url, opts = {}) {
      const c = new EventEmitter();
      Object.assign(c, { url, opts, connected: false, subs: [], ended: false, reconnecting: false, timer: null });
      c.subscribe = (pattern) => {
        const prefix = pattern.replace(/#$/, '');
        c.subs.push(prefix);
        for (const [topic, buf] of broker(url).retained) if (topic.startsWith(prefix)) setTimeout(() => c.connected && c.emit('message', topic, buf, { retain: true }), 1);
      };
      c.publish = (topic, payload, o = {}) => {
        if (!c.connected) return;
        const buf = Buffer.from(typeof payload === 'string' ? payload : payload);
        log.push({ url, topic, size: buf.length, opts: o, buf });
        if (buf.length > maxPayload) return setTimeout(() => drop(c), 1); // like a broker over its limit
        deliver(broker(url), topic, buf, !!o.retain);
      };
      c.end = (force) => {
        if (c.ended) return;
        c.ended = true;
        clearTimeout(c.timer);
        if (force) drop(c);
        else {
          broker(url).clients.delete(c);
          c.connected = false;
        }
      };
      c.retry = () => {
        if (c.ended) return;
        if (!c.reconnecting) {
          c.reconnecting = true;
          c.emit('offline'); // mqtt.js: once per outage, not per failed attempt
        }
        clearTimeout(c.timer);
        c.timer = setTimeout(c.attempt, Math.min(opts.reconnectPeriod || 1000, 60));
      };
      c.attempt = () => {
        if (c.ended) return;
        const b = broker(url);
        if (!b.up) {
          c.emit('error', new Error('connack timeout'));
          return c.retry();
        }
        b.clients.add(c);
        c.connected = true;
        c.reconnecting = false;
        c.subs = [];
        c.emit('connect');
      };
      setTimeout(c.attempt, 1);
      return c;
    },
  };
  return {
    importer: async () => mod,
    log,
    brokers,
    down(url) {
      const b = broker(url);
      b.up = false;
      for (const c of [...b.clients]) drop(c);
    },
    up(url) {
      broker(url).up = true;
    },
    /** The app vanishes without stop() (crash, tab killed): sockets close abruptly → last wills fire. */
    crash(link) {
      link.stopped = true;
      clearInterval(link.heartbeat);
      clearInterval(link.liveCheck);
      clearTimeout(link.flushTimer);
      clearTimeout(link.snapshotTimer);
      for (const c of link.mqtt?.clients || []) {
        c.ended = true;
        clearTimeout(c.timer);
        const b = broker(c.url);
        if (b.clients.delete(c)) {
          c.connected = false;
          const w = c.opts.will;
          deliver(b, w.topic, Buffer.from(w.payload), w.retain);
        }
      }
    },
    /** The page is gone and its sockets with it, but the brokers have not noticed yet (no last will so far). */
    vanish(link) {
      link.stopped = true;
      clearInterval(link.heartbeat);
      clearInterval(link.liveCheck);
      clearTimeout(link.flushTimer);
      clearTimeout(link.snapshotTimer);
      for (const c of link.mqtt?.clients || []) {
        c.ended = true;
        clearTimeout(c.timer);
        broker(c.url).clients.delete(c);
        c.connected = false;
      }
    },
  };
}

const noP2P = async () => ({
  joinRoom: () => ({ makeAction: () => ({ send() {}, onMessage: null }), leave() {}, getPeers: () => ({}) }),
});

/** In-memory Trystero: every room sees every other one; `dead` rooms report connected but drop all data.
 *  addStream / removeStream reach the target peer (onPeerStream / the stream's 'removetrack'). */
function fakeTrystero() {
  const rooms = [];
  const mod = {
    joinRoom() {
      const id = `peer${rooms.length}`;
      const room = { id, actions: {}, left: false, dead: false, sent: [] };
      room.addStream = (stream, { target, metadata }) => {
        room.sent.push({ stream, target });
        for (const o of rooms) if (o.id === target && !o.left) setTimeout(() => o.onPeerStream?.(stream, id, metadata), 1);
        return [Promise.resolve()];
      };
      room.removeStream = (stream, { target } = {}) => {
        room.sent = room.sent.filter((x) => x.stream !== stream || (target && x.target !== target));
      };
      room.makeAction = (name) => (room.actions[name] = {
        send(msg, opts) {
          if (room.dead) return Promise.resolve();
          for (const o of rooms) {
            if (o === room || o.left || o.dead || (opts?.target && opts.target !== o.id)) continue;
            // like the vendored Trystero: the sender comes as { peerId } (plus any metadata), not as a bare id
            setTimeout(() => o.actions[name]?.onMessage?.(structuredClone(msg), { peerId: id }), 1);
          }
          return Promise.resolve();
        },
      });
      room.getPeers = () => ({});
      room.leave = () => {
        room.left = true;
        for (const o of rooms) if (o !== room && !o.left) o.onPeerLeave?.(id);
      };
      for (const o of rooms) {
        if (o.left) continue;
        setTimeout(() => {
          o.onPeerJoin?.(id);
          room.onPeerJoin?.(o.id);
        }, 5);
      }
      rooms.push(room);
      return room;
    },
  };
  return { importer: async () => mod, rooms };
}

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
const mkDoc = (by) => Object.assign(new RunDoc('sync-test'), { by, _persistSoon() {} });
const links = [];
function mkLink(net, slot, doc, o = {}) {
  const l = new SyncLink({ room: 'room-s', secret: 'secret-s', slot, name: slot, doc, importers: { mqtt: net.importer, trystero: o.trystero || noP2P }, ...o });
  links.push(l);
  return l;
}
const relayUp = (l) => until(() => l.status.relay === 'connected', 8000, `${l.slot} relay`);
test.afterEach(() => {
  for (const l of links.splice(0)) l.stop();
});

test('partner offline: changes arrive from the retained snapshot when they come online – both ways', async () => {
  const net = fakeNet();
  const da = mkDoc('a');
  const db = mkDoc('b');
  const a = mkLink(net, 'p1', da);
  await a.start();
  await relayUp(a);
  da.set('enc:route-1:p1', { species: 16 });
  await sleep(200);
  a.stop();
  const b = mkLink(net, 'p2', db);
  await b.start();
  await until(() => db.get('enc:route-1:p1')?.species === 16, 8000, 'B gets A');
  db.set('enc:route-1:p2', { species: 19 });
  b.stop(); // leaves right away – stop() publishes the snapshot
  const a2 = mkLink(net, 'p1', da);
  await a2.start();
  await until(() => da.get('enc:route-1:p2')?.species === 19, 8000, 'A gets B');
});

test('both offline at different times: every change survives and both converge', async () => {
  const net = fakeNet();
  const da = mkDoc('a');
  const db = mkDoc('b');
  let a = mkLink(net, 'p1', da);
  await a.start();
  await relayUp(a);
  da.set('x', 1);
  da.set('shared', 'from A');
  a.stop();
  await sleep(50);
  let b = mkLink(net, 'p2', db);
  await b.start();
  await until(() => db.get('x') === 1);
  db.set('y', 2);
  db.set('shared', 'from B (later)');
  b.stop();
  await sleep(50);
  a = mkLink(net, 'p1', da);
  await a.start();
  await until(() => da.get('y') === 2);
  da.set('z', 3);
  b = mkLink(net, 'p2', db);
  await b.start();
  await until(() => db.get('z') === 3 && da.get('z') === 3);
  assert.deepEqual(da.entries, db.entries);
  assert.equal(da.get('shared'), 'from B (later)');
});

test('LWW clock skew: an edit made after seeing the partner\'s value wins even on a clock 10 minutes behind', () => {
  const real = Date.now;
  try {
    const a = mkDoc('a');
    const b = mkDoc('b');
    a.set('rules', 'A at 12:00');
    Date.now = () => real() - 10 * 60000; // B's computer is 10 minutes behind
    b.merge(structuredClone(a.entries));
    b.set('rules', 'B, later');
    Date.now = real;
    a.merge(structuredClone(b.entries));
    assert.equal(a.get('rules'), 'B, later');
    // and an old value from the slow clock never overrides a newer one it had seen
    Date.now = () => real() - 10 * 60000;
    const stale = { rules: { v: 'old', t: Date.now() - 1000, by: 'b' } };
    Date.now = real;
    a.merge(stale);
    assert.equal(a.get('rules'), 'B, later');
  } finally {
    Date.now = real;
  }
});

test('first broker down from the start: the relay still connects and both players meet', async () => {
  const net = fakeNet();
  net.down(BROKERS[0]);
  const da = mkDoc('a');
  const db = mkDoc('b');
  const a = mkLink(net, 'p1', da);
  const b = mkLink(net, 'p2', db);
  await Promise.all([a.start(), b.start()]);
  await relayUp(a);
  await relayUp(b);
  assert.ok(!a.status.broker.includes(new URL(BROKERS[0]).hostname));
  da.set('k', 'v');
  await until(() => db.get('k') === 'v', 8000, 'B gets the change');
});

test('brokers failing at different times can not leave the players on different brokers', async () => {
  const net = fakeNet();
  const [b0, b1, b2] = BROKERS;
  net.down(b0);
  net.down(b2);
  const da = mkDoc('a');
  const db = mkDoc('b');
  const a = mkLink(net, 'p1', da);
  await a.start();
  await relayUp(a); // A only reaches broker 1
  net.up(b0);
  net.down(b1); // … now broker 1 is gone, broker 0 is back
  const b = mkLink(net, 'p2', db);
  await b.start();
  await relayUp(b);
  da.set('k', 'late');
  await until(() => db.get('k') === 'late', 8000, 'B gets the change over broker 0');
  db.set('k2', 'back');
  await until(() => da.get('k2') === 'back');
});

test('page closed without stop() and before the last will: the partner does not look live for long', async () => {
  const net = fakeNet();
  const a = mkLink(net, 'p1', mkDoc('a'));
  await a.start();
  await relayUp(a);
  // A's last heartbeat is 30 s old by the time B opens the run, and no last will has been published yet
  const real = Date.now;
  const b = mkLink(net, 'p2', mkDoc('b'));
  try {
    net.vanish(a);
    Date.now = () => real() + 30000;
    await b.start();
    await relayUp(b);
    await sleep(150);
    assert.ok(b.status.partnerSeen <= real() + 1000, 'seen counts from the heartbeat, not from now');
    Date.now = () => real() + 40000; // > RETAINED_FRESH: a retained "online" this old is ignored
    const b2 = mkLink(net, 'p2', mkDoc('b2'));
    await b2.start();
    await relayUp(b2);
    await sleep(150);
    assert.equal(b2.status.partner, null);
    // the first one drops the partner once PARTNER_TTL passed since that heartbeat
    Date.now = () => real() + PARTNER_TTL + 1000;
    b._checkPartner();
    assert.equal(b.status.partner, null);
  } finally {
    Date.now = real;
  }
});

test('stop() (pagehide) says offline at once – before any await', async () => {
  const net = fakeNet();
  const a = mkLink(net, 'p1', mkDoc('a'));
  const b = mkLink(net, 'p2', mkDoc('b'));
  await Promise.all([a.start(), b.start()]);
  await relayUp(a);
  await relayUp(b);
  await until(() => b.status.partner, 8000, 'B sees A');
  const before = net.log.length;
  a.stop();
  const sync = net.log.slice(before).filter((m) => m.topic.endsWith('/presence/p1'));
  assert.ok(sync.length >= 1 && sync.every((m) => JSON.parse(m.buf).online === false && m.opts.retain), 'offline published synchronously');
  await until(() => b.status.partner === null, 4000, 'B sees A leave');
});

test('crash: last wills make the partner go offline, also when it was on several brokers', async () => {
  const net = fakeNet();
  const a = mkLink(net, 'p1', mkDoc('a'));
  const b = mkLink(net, 'p2', mkDoc('b'));
  await Promise.all([a.start(), b.start()]);
  await until(() => a.mqtt.clients.every((c) => c.connected) && b.mqtt.clients.every((c) => c.connected));
  await until(() => b.status.partner && b.mqtt.clients.every((c) => c.partnerAt > 0), 8000, 'B hears A on every broker');
  net.crash(a);
  await until(() => b.status.partner === null, 4000, 'B sees A gone');
});

test('one broker losing the partner (its last will) does not flip them offline while another broker hears them', async () => {
  const net = fakeNet();
  const a = mkLink(net, 'p1', mkDoc('a'));
  const b = mkLink(net, 'p2', mkDoc('b'));
  await Promise.all([a.start(), b.start()]);
  await until(() => b.status.partner && b.mqtt.clients.every((c) => c.partnerAt > 0), 8000, 'B hears A on every broker');
  const ca = a.mqtt.clients.find((c) => c.url === BROKERS[1]);
  ca.end(true); // only A's connection to broker 1 dies abruptly
  await sleep(100);
  assert.ok(b.status.partner, 'still online');
});

test('a retained presence with a skewed clock: live heartbeats count on our clock', async () => {
  const net = fakeNet();
  const b = mkLink(net, 'p2', mkDoc('b'));
  await b.start();
  await relayUp(b);
  const raw = b.mqtt.clients.find((c) => c.connected);
  // the partner's computer is 10 minutes behind: its live heartbeat carries an "old" timestamp
  const other = (await net.importer()).connect(raw.url, {});
  await until(() => other.connected);
  other.publish(`${b.topic}/presence/p1`, JSON.stringify({ online: true, at: Date.now() - 600000, name: 'p1' }), { retain: true });
  await until(() => b.status.partner, 3000, 'partner seen');
  assert.ok(Date.now() - b.status.partnerSeen < 1000);
  assert.ok(Math.abs(b.clockOffset - 600000) < 2000);
  other.end();
});

test('stop() while ops are being sealed still delivers them (catch-up snapshot)', async () => {
  const net = fakeNet();
  const da = mkDoc('a');
  const db = mkDoc('b');
  const a = mkLink(net, 'p1', da);
  await a.start();
  await relayUp(a);
  await until(() => net.log.some((m) => m.topic.endsWith('/state/p1')), 8000, 'connect snapshot'); // snapshotDue is false now
  da.set('last-word', 'dead');
  clearTimeout(a.flushTimer);
  a._flush(); // is now awaiting the seal …
  a.stop(); // … when the run is switched
  const b = mkLink(net, 'p2', db);
  await b.start();
  await until(() => db.get('last-word') === 'dead', 8000, 'B gets it from the retained snapshot');
});

test('same player on two devices: the second one keeps the first one\'s changes in the shared snapshot', async () => {
  const net = fakeNet();
  const d1 = mkDoc('dev1');
  const d2 = mkDoc('dev2');
  const dp = mkDoc('partner');
  const a1 = mkLink(net, 'p1', d1);
  await a1.start();
  await relayUp(a1);
  d1.set('enc:a:p1', 'caught on device 1');
  a1.stop();
  await sleep(50);
  const a2 = mkLink(net, 'p1', d2); // same slot, other computer, knows nothing yet
  await a2.start();
  await until(() => d2.get('enc:a:p1') === 'caught on device 1', 8000, 'device 2 picks up device 1');
  d2.set('enc:b:p1', 'caught on device 2');
  a2.stop();
  const p = mkLink(net, 'p2', dp);
  await p.start();
  await until(() => dp.get('enc:b:p1') && dp.get('enc:a:p1'), 8000, 'partner gets both');
  assert.equal(p.status.partner, null, 'own-slot traffic never counts as the partner');
});

test('a snapshot larger than the broker limit is split into parts and still arrives complete', async () => {
  const net = fakeNet({ maxPayload: 100 * 1024 });
  const da = mkDoc('a');
  const db = mkDoc('b');
  const writes = {};
  // ~600 KB of barely compressible feed entries (a long run)
  for (let i = 0; i < 1500; i++) writes[`feed:${i.toString(36)}`] = { at: i, text: Math.random().toString(36).repeat(10) };
  da.batch(writes);
  const a = mkLink(net, 'p1', da);
  await a.start();
  await relayUp(a);
  await until(() => net.log.filter((m) => m.topic.includes('/state/p1')).length >= 2, 8000, 'snapshot parts');
  assert.ok(net.log.every((m) => m.size <= 100 * 1024), 'nothing over the limit was published');
  assert.equal(a.status.relay, 'connected');
  a.stop();
  const b = mkLink(net, 'p2', db);
  await b.start();
  await until(() => Object.keys(db.scan('feed:')).length === 1500, 8000, 'all entries');
  // ops batches are split the same way
  const big = {};
  for (let i = 0; i < 800; i++) big[`feed:big-${i}`] = { text: Math.random().toString(36).repeat(10) };
  const a2 = mkLink(net, 'p1', da);
  await a2.start();
  await relayUp(a2);
  da.batch(big);
  await until(() => Object.keys(db.scan('feed:')).length === 2300, 8000, 'big ops batch');
  assert.ok(net.log.some((m) => m.topic.endsWith('/ops/p1')), 'went out as ops');
  assert.ok(net.log.every((m) => m.size <= 100 * 1024), 'nothing over the limit was published');
});

test('P2P looks connected but its data channel is dead: chat still arrives over the relay, exactly once', async () => {
  const net = fakeNet();
  const tr = fakeTrystero();
  const got = [];
  const a = mkLink(net, 'p1', mkDoc('a'), { trystero: tr.importer });
  const b = mkLink(net, 'p2', mkDoc('b'), { trystero: tr.importer, onMessage: (m) => got.push(m) });
  await Promise.all([a.start(), b.start()]);
  await until(() => a.status.p2p === 'connected' && b.status.p2p === 'connected');
  await relayUp(a);
  await relayUp(b);
  await a.sendMessage({ type: 'ping', text: 'healthy' });
  await until(() => got.length === 1);
  await sleep(200);
  assert.equal(got.length, 1, 'P2P + relay copies are deduplicated');
  tr.rooms[0].dead = true;
  await a.sendMessage({ type: 'ping', text: 'dead channel' });
  await until(() => got.some((m) => m.payload.text === 'dead channel'), 4000, 'relay carries it');
});

test('same player in a second window: its leaving does not drop the direct link to the partner', async () => {
  const net = fakeNet();
  const tr = fakeTrystero();
  const p1 = mkLink(net, 'p1', mkDoc('a'), { trystero: tr.importer });
  const p2 = mkLink(net, 'p2', mkDoc('b'), { trystero: tr.importer });
  await Promise.all([p1.start(), p2.start()]);
  await until(() => p2.status.p2p === 'connected');
  const twin = mkLink(net, 'p1', mkDoc('a2'), { trystero: tr.importer });
  await twin.start();
  await until(() => p2.peers.size === 2 && [...p2.peers.values()].every(Boolean), 4000, 'slots known');
  assert.equal(p2.peers.get(p2.peerId), 'p1');
  twin.stop();
  await sleep(50);
  assert.equal(p2.status.p2p, 'connected');
  assert.equal(p1.status.p2p, 'connected', "the twin never counted as p1's partner");
});

test('doc listeners get the partner\'s clock offset with live ops', async () => {
  const net = fakeNet();
  const db = mkDoc('b');
  const b = mkLink(net, 'p2', db);
  await b.start();
  const seen = [];
  db.subscribe((keys, remote, info) => seen.push({ keys, remote, info }));
  b._receive({ kind: 'ops', from: 'p1', at: Date.now() - 600000, ops: { 'feed:1': { v: { at: Date.now() - 600000 }, t: Date.now() - 600000, by: 'a' } } }, 'relay');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].info.live, true);
  assert.ok(Math.abs(seen[0].info.offset - 600000) < 1000);
});

test('many connect / disconnect cycles leave no timers or connections behind', async () => {
  const net = fakeNet();
  for (let i = 0; i < 15; i++) {
    const l = mkLink(net, 'p1', mkDoc('a'));
    const s = l.start();
    if (i % 2) await s;
    l.watchPartnerScreen(() => {});
    l.stop();
    await s;
    assert.equal(l.wantTimer, null);
  }
  await sleep(100);
  for (const b of net.brokers.values()) assert.equal(b.clients.size, 0);
});

test('after sleep or a network change P2P is rejoined, and a P2P link that never comes back is retried', async () => {
  const net = fakeNet();
  const tr = fakeTrystero();
  const a = mkLink(net, 'p1', mkDoc('a'), { trystero: tr.importer });
  const b = mkLink(net, 'p2', mkDoc('b'), { trystero: tr.importer });
  try {
    await Promise.all([a.start(), b.start()]);
    await until(() => a.status.p2p === 'connected' && b.status.p2p === 'connected');
    await relayUp(a);
    await relayUp(b);
    // a's computer sleeps: its sockets die silently, b sees the peer leave, a still believes it is connected
    const old = a.trysteroRoom; // a's room – not tr.rooms[0]: which link joins first is up to Promise.all
    old.dead = true;
    old.left = true;
    b.trysteroRoom.onPeerLeave?.(old.id);
    await until(() => b.status.p2p === 'waiting', 2000, 'b notices');
    // wake: the heartbeat gap (or the browser's online event) rejoins
    await a._restartP2P('wake');
    await until(() => a.status.p2p === 'connected' && b.status.p2p === 'connected', 4000, 'P2P back');
    assert.equal(a.p2pRestarts, 1);
    assert.notEqual(a.trysteroRoom, old);
    // P2P down while the relay hears the partner: the periodic check retries
    tr.rooms.filter((r) => !r.left).forEach((r) => { r.dead = true; r.left = true; });
    b.trysteroRoom.onPeerLeave?.(a.trysteroRoom.id);
    await until(() => b.status.p2p === 'waiting', 2000);
    b._alive('p1', 'relay'); // the relay hears a
    b.p2pRestartAt = Date.now() - 100000;
    b._checkPartner();
    await until(() => b.p2pRestarts === 1, 2000, 'stale check rejoined');
    b._checkPartner(); // and not again right away
    await sleep(50);
    assert.equal(b.p2pRestarts, 1);
  } finally {
    a.stop();
    b.stop();
  }
});

// --- three and four players ------------------------------------------------------------------------------
const SLOTS4 = ['p1', 'p2', 'p3', 'p4'];
const others = (l) => SLOTS4.slice(0, l.slots.length).filter((s) => s !== l.slot);
const seesAll = (l) => others(l).every((s) => l.status.partners[s]);

test('four players in one room: everyone sees everyone (per slot) and every change reaches all', async () => {
  const net = fakeNet();
  const docs = SLOTS4.map((s) => mkDoc(s));
  const ls = SLOTS4.map((s, i) => mkLink(net, s, docs[i], { slots: SLOTS4 }));
  await Promise.all(ls.map((l) => l.start()));
  await until(() => ls.every(seesAll), 8000, 'all presences');
  for (const l of ls) {
    assert.deepEqual(Object.keys(l.status.partners).sort(), others(l));
    assert.ok(Object.values(l.status.partners).every((p) => p.via === 'relay' && p.seen > 0 && p.p2p === false));
    assert.ok(others(l).includes(l.status.partner.slot), 'the compatible single partner is one of them');
  }
  ls.forEach((l, i) => docs[i].set(`enc:route-1:${l.slot}`, { species: i + 1 }));
  await until(() => docs.every((d) => SLOTS4.every((s, i) => d.get(`enc:route-1:${s}`)?.species === i + 1)), 8000, 'all ops everywhere');
  // chat goes to everyone, exactly once each
  const got = { p2: [], p3: [], p4: [] };
  for (const l of ls.slice(1)) l.onMessage = (m) => got[l.slot].push(m);
  await ls[0].sendMessage({ type: 'ping', text: 'hi all' });
  await until(() => Object.values(got).every((g) => g.length === 1));
  assert.ok(Object.values(got).every((g) => g[0].from === 'p1'));
});

test('p3 and p4 offline: their retained snapshots catch the others up', async () => {
  const net = fakeNet();
  const d3 = mkDoc('c');
  const d4 = mkDoc('d');
  const c = mkLink(net, 'p3', d3, { slots: SLOTS4 });
  const d = mkLink(net, 'p4', d4, { slots: SLOTS4 });
  await Promise.all([c.start(), d.start()]);
  await relayUp(c);
  await relayUp(d);
  d3.set('enc:route-2:p3', { species: 25 });
  d4.set('enc:route-2:p4', { species: 133 });
  c.stop();
  d.stop();
  const d1 = mkDoc('a');
  const a = mkLink(net, 'p1', d1, { slots: SLOTS4 });
  await a.start();
  await until(() => d1.get('enc:route-2:p3')?.species === 25 && d1.get('enc:route-2:p4')?.species === 133, 8000, 'p1 gets both');
  await sleep(100);
  assert.deepEqual(a.status.partners, {}, 'retained data and goodbyes are no sign of life');
});

test('presence is judged per player: one leaving (last will or TTL) leaves the others online', async () => {
  const net = fakeNet();
  const real = Date.now;
  const [a, b, c] = ['p1', 'p2', 'p3'].map((s) => mkLink(net, s, mkDoc(s), { slots: ['p1', 'p2', 'p3'] }));
  try {
    await Promise.all([a, b, c].map((l) => l.start()));
    await until(() => [a, b, c].every(seesAll), 8000, 'all presences');
    await until(() => a.mqtt.clients.every((cl) => cl.heard.p3 > 0), 8000, 'a hears p3 on every broker');
    net.crash(c); // last wills on every broker
    await until(() => !a.status.partners.p3 && !b.status.partners.p3, 4000, 'p3 gone');
    assert.ok(a.status.partners.p2 && b.status.partners.p1, 'the others stay');
    assert.equal(a.status.partner.slot, 'p2');
    // TTL: p2 vanishes silently, p3 comes back and keeps talking
    const c2 = mkLink(net, 'p3', mkDoc('c2'), { slots: ['p1', 'p2', 'p3'] });
    await c2.start();
    await until(() => a.status.partners.p3, 8000, 'p3 back');
    net.vanish(b);
    Date.now = () => real() + PARTNER_TTL + 1000;
    c2._presence(); // a live heartbeat "now"
    await until(() => a.status.partners.p3?.seen > real() + PARTNER_TTL, 2000, 'fresh heartbeat');
    a._checkPartner();
    assert.equal(a.status.partners.p2, undefined, 'p2 timed out');
    assert.ok(a.status.partners.p3, 'p3 still live');
    assert.deepEqual(a.status.partner, { slot: 'p3', via: 'relay' });
  } finally {
    Date.now = real;
  }
});

test('clock offsets are kept per player: merged ops carry their sender\'s offset', async () => {
  const net = fakeNet();
  const da = mkDoc('a');
  const a = mkLink(net, 'p1', da, { slots: ['p1', 'p2', 'p3'] });
  await a.start();
  const seen = [];
  da.subscribe((keys, remote, info) => seen.push(info));
  const now = Date.now();
  a._receive({ kind: 'alive', from: 'p2', at: now - 600000 }, 'relay'); // p2's clock is 10 min behind
  a._receive({ kind: 'alive', from: 'p3', at: now + 300000 }, 'relay'); // p3's 5 min ahead
  a._receive({ kind: 'snapshot', from: 'p2', ops: { k2: { v: 1, t: now - 600000, by: 'b' } } }, 'relay');
  a._receive({ kind: 'snapshot', from: 'p3', ops: { k3: { v: 1, t: now + 300000, by: 'c' } } }, 'relay');
  assert.equal(seen.length, 2);
  assert.ok(Math.abs(seen[0].offset - 600000) < 1000, 'p2 offset');
  assert.ok(Math.abs(seen[1].offset + 300000) < 1000, 'p3 offset');
  assert.equal(seen[1].from, 'p3');
  assert.ok(Math.abs(a.clockOffsets.p2 - 600000) < 1000 && Math.abs(a.clockOffsets.p3 + 300000) < 1000);
});

test('P2P with three players: one room, every peer known by slot, ops reach all directly, one leaving keeps the rest', async () => {
  const net = fakeNet();
  for (const url of BROKERS) net.down(url); // no relay at all: whatever arrives came over P2P
  const tr = fakeTrystero();
  const docs = ['a', 'b', 'c'].map(mkDoc);
  const ls = ['p1', 'p2', 'p3'].map((s, i) => mkLink(net, s, docs[i], { trystero: tr.importer, slots: ['p1', 'p2', 'p3'] }));
  await Promise.all(ls.map((l) => l.start()));
  await until(() => ls.every((l) => l.status.p2p === 'connected' && l.peers.size === 2 && [...l.peers.values()].every(Boolean)), 4000, 'mesh');
  docs[0].set('from-p1', 1);
  docs[2].set('from-p3', 3);
  await until(() => docs.every((d) => d.get('from-p1') === 1 && d.get('from-p3') === 3), 4000, 'ops over P2P');
  await until(() => ls.every((l) => seesAll(l) && Object.values(l.status.partners).every((p) => p.via === 'p2p' && p.p2p)), 4000, 'presence over P2P');
  assert.deepEqual([...ls[0].peers.values()].sort(), ['p2', 'p3']);
  ls[2].stop();
  await sleep(50);
  assert.equal(ls[0].status.p2p, 'connected');
  assert.equal(ls[0].status.partners.p2.p2p, true);
  assert.equal(ls[0].status.partners.p3?.p2p ?? false, false, 'p3 has no direct link anymore');
  docs[1].set('after', 'p3 left');
  await until(() => docs[0].get('after') === 'p3 left', 4000);
});

test('P2P to some players but not to another one the relay hears: retried, but only rarely', async () => {
  const net = fakeNet();
  const tr = fakeTrystero();
  const [a, b] = ['p1', 'p2'].map((s) => mkLink(net, s, mkDoc(s), { trystero: tr.importer, slots: ['p1', 'p2', 'p3'] }));
  const c = mkLink(net, 'p3', mkDoc('c'), { slots: ['p1', 'p2', 'p3'] }); // p3: relay only (no WebRTC there)
  await Promise.all([a, b, c].map((l) => l.start()));
  await until(() => a.status.p2p === 'connected' && a.status.partners.p3, 8000);
  a.p2pRestartAt = Date.now() - 100000; // > P2P_RETRY, < the partial retry
  a._checkPartner();
  await sleep(50);
  assert.equal(a.p2pRestarts, undefined, 'the working link to p2 is not dropped for p3 every 90 s');
  a.p2pRestartAt = Date.now() - 10 * 60000;
  a._checkPartner();
  await until(() => a.p2pRestarts === 1, 2000, 'but now and then');
});

function fakeStream(id) {
  const track = { kind: 'video', readyState: 'live', enabled: true, stop() { this.readyState = 'ended'; }, getSettings: () => ({ width: 768 }), addEventListener() {} };
  return { id, track, getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track], removeTrack() {}, addEventListener() {} };
}
const jpeg = (n, seed = 1) => {
  const u8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) u8[i] = ((i + seed) * 2654435761) >>> 24;
  u8.set([0xff, 0xd8, 0xff]);
  return u8;
};

test('partner screen with three players: each viewer picks whom to watch, one picture serves several watchers', async () => {
  const net = fakeNet();
  const slots = ['p1', 'p2', 'p3'];
  const [a, b, c] = slots.map((s) => mkLink(net, s, mkDoc(s), { slots }));
  await Promise.all([a, b, c].map((l) => l.start()));
  await until(() => [a, b, c].every(seesAll), 8000, 'all presences');
  const shots = { p2: 0, p3: 0 };
  const share = (l, seed) => l.startScreenShare({ system: 'gba', isActive: () => true, getSnapshot: async () => (shots[l.slot]++, new Blob([jpeg(3000 + seed, seed)], { type: 'image/jpeg' })) });
  share(b, 2);
  share(c, 3);
  assert.equal(a.defaultScreenSlot(), 'p2', 'default: the first other player online');
  const va = [];
  const stopA = a.watchPartnerScreen((v) => va.push(v), 'p3');
  assert.equal(va[0].slot, 'p3');
  const vb = [];
  b.watchPartnerScreen((v) => vb.push(v), 'p3');
  await until(() => va.some((v) => v.blob) && vb.some((v) => v.blob), 6000, 'both get p3');
  assert.ok(va.every((v) => v.slot === 'p3') && vb.every((v) => v.slot === 'p3'), 'nothing from p2 shows up for p3');
  assert.deepEqual(c._watching().sort(), ['p1', 'p2']);
  assert.equal(shots.p2, 0, 'nobody watches p2 – it sends nothing');
  // one picture per tick for both watchers – not one each
  const frames = () => net.log.filter((m) => m.topic.endsWith('/screen/p3') && m.size > 2000 && m.url === BROKERS[0]).length;
  const n0 = frames();
  await sleep(3200);
  assert.ok(frames() - n0 <= 3, `one broadcast per tick (${frames() - n0})`);
  // p1 stops watching: p3 keeps sending for p2
  stopA();
  await until(() => c._watching().join() === 'p2', 4000, 'p1 told p3');
  const n1 = shots.p3;
  await sleep(1700);
  assert.ok(shots.p3 > n1, 'still sending for p2');
  // p1 switches to p2 → p2 starts sending
  const va2 = [];
  a.watchPartnerScreen((v) => va2.push(v), 'p2');
  await until(() => va2.some((v) => v.blob && v.slot === 'p2'), 6000, 'p1 sees p2');
});

test('partner screen over P2P: video to every watcher\'s peer, taken away from one who stops watching', async () => {
  const net = fakeNet();
  const tr = fakeTrystero();
  const slots = ['p1', 'p2', 'p3'];
  const [a, b, c] = slots.map((s) => mkLink(net, s, mkDoc(s), { slots, trystero: tr.importer }));
  await Promise.all([a, b, c].map((l) => l.start()));
  await until(() => [a, b, c].every((l) => l.status.p2p === 'connected' && l.peers.size === 2 && [...l.peers.values()].every(Boolean)), 4000, 'mesh');
  await until(() => [a, b, c].every((l) => seesAll(l) && Object.values(l.status.partners).every((p) => p.p2p)), 8000, 'direct to all');
  const stream = fakeStream('game-p3');
  c.startScreenShare({ system: 'nds', isActive: () => true, getStream: () => stream, getSnapshot: async () => null });
  const va = [];
  const vb = [];
  const stopA = a.watchPartnerScreen((v) => va.push(v), 'p3');
  b.watchPartnerScreen((v) => vb.push(v), 'p3');
  await until(() => va.some((v) => v.mode === 'stream' && v.stream === stream) && vb.some((v) => v.mode === 'stream' && v.stream === stream), 6000, 'both get the video');
  assert.equal(c.share.streamPeers.size, 2);
  assert.equal(c.trysteroRoom.sent.length, 2, 'added once per watcher');
  stopA();
  await until(() => c.share.streamPeers.size === 1 && c.trysteroRoom.sent.length === 1, 6000, 'removed for p1');
  assert.equal(stream.track.enabled, true, 'p2 still watches');
});

test('rejoining P2P resumes the signalling relays Trystero paused on "offline" (else they stay dead until a reload)', async () => {
  // Trystero pauses its Nostr reconnects on the window's 'offline' event and resumes them on 'online' – but our own
  // 'online' handler leaves the room first, which drops Trystero's listener before it runs: the pause never ends.
  const net = fakeNet();
  const tr = fakeTrystero();
  const mod = await tr.importer();
  let resumed = 0;
  const importer = async () => ({ ...mod, resumeRelayReconnection: () => resumed++ });
  const a = mkLink(net, 'p1', mkDoc('a'), { trystero: importer });
  await a.start();
  const before = resumed;
  await a._restartP2P('online');
  assert.ok(resumed > before, 'resumeRelayReconnection called on rejoin');
});

test('rejoining P2P while every signalling socket of Trystero is dead loads a fresh Trystero (no reload needed)', async () => {
  // After a network drop the cached module's relay clients may never reconnect: P2P stayed down for good.
  const net = fakeNet();
  const tr = fakeTrystero();
  const mod = await tr.importer();
  const socks = { 'wss://a': { readyState: 1 }, 'wss://b': { readyState: 1 } };
  const calls = [];
  const importer = async (fresh) => (calls.push(fresh || 0), { ...mod, getRelaySockets: () => (fresh ? {} : socks) });
  const a = mkLink(net, 'p1', mkDoc('a'), { trystero: importer });
  await a.start();
  await a._restartP2P('online'); // sockets alive → same module
  assert.deepEqual(calls.map(Boolean), [false, false]);
  socks['wss://a'].readyState = 3;
  socks['wss://b'].readyState = 3;
  await a._restartP2P('stale');
  assert.ok(calls.at(-1) > 0, 'fresh instance requested');
  assert.equal(a.status.p2p, 'waiting');
});

test('our clock minutes ahead of a partner: the P2P rejoin waits longer than the skew (each rejoin restarts Trystero\'s wait)', async () => {
  // Trystero subscribes to signalling events "since now" on our clock: ahead by 5 min, it ignores the partner's
  // announcements for 5 min of real time – a rejoin every 90 s would keep P2P down for good.
  const net = fakeNet();
  const a = mkLink(net, 'p1', mkDoc('a'), { trystero: fakeTrystero().importer });
  await a.start();
  a._offset('p2', 5 * 60000);
  a._alive('p2', 'relay');
  a.p2pRestartAt = Date.now() - 100000;
  a._checkPartner();
  await sleep(30);
  assert.equal(a.p2pRestarts || 0, 0, 'no rejoin 100 s after the last one');
  a.p2pRestartAt = Date.now() - 10 * 60000;
  a._checkPartner();
  await until(() => a.p2pRestarts === 1, 2000, 'rejoin once the skew has passed');
});
