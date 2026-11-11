// Live link between the players of a run (1–4: p1..p4). Two transports run side by side:
//  1. Trystero (WebRTC, signalling over public Nostr relays) – direct, fast, end-to-end encrypted. One room
//     per run; every player is a peer in it (a full mesh), document ops go to all of them.
//  2. MQTT relay over WSS (public brokers) – works behind any NAT and keeps an encrypted,
//     retained snapshot of each player's document (one topic per slot) so the others catch up even
//     when you are offline. Payloads are AES-GCM encrypted with a key derived from the run secret.
// Document merges are idempotent (LWW map), so receiving the same change twice is harmless.
// Presence is tracked per slot: status.partners = { [slot]: { seen, via, p2p } } for every other player
// that is live; status.partner / partnerSeen stay as "the partner heard from most recently" (older callers).

// The app's former name, kept on purpose: every app in a run must meet in the same rooms, older versions too.
const APP_ID = 'soullink-studio-v1';
export const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
const enc = new TextEncoder();
const dec = new TextDecoder();

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function deriveKey(room, secret) {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(`${APP_ID}:${room}`), iterations: 100000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function gzip(bytes) {
  if (typeof CompressionStream === 'undefined') return { bytes, z: false };
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), z: true };
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** AES-GCM box: [gzip flag][12-byte IV][ciphertext]. Also used by the invite-code handshake (invitecode.mjs). */
export async function seal(key, obj) {
  const { bytes, z } = await gzip(enc.encode(JSON.stringify(obj)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = z ? 1 : 0;
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}

// Partner screen (mini view of the partner's game) – timings and size limits.
const SCREEN = {
  tick: 1500, // sender: one step (and one still picture on the image path) every 1.5 s
  wantEvery: 10000, // viewer: "I'm watching" heartbeat
  wantTtl: 25000, // sender: stop when no heartbeat came for this long
  target: 20 * 1024, // still pictures aim below this …
  maxBytes: 40 * 1024, // … and are dropped above this
  resendSame: 6000, // an unchanged picture is resent only this often (keeps the "x s ago" honest)
  streamGrace: 8000, // viewer: announced video that hasn't arrived after this long → ask for pictures
};
const FRAME_TYPES = ['image/jpeg', 'image/webp', 'image/png'];

function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(str) {
  const s = atob(str);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

function fnv(u8) {
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 0x01000193);
  return h >>> 0;
}

const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const newId = () => Math.random().toString(36).slice(2, 12);
// Relay limits. Public brokers cap the payload (often 256 KB … 1 MB, some less) and drop the connection on a
// bigger one – which would repeat on every reconnect. Document messages are split into parts below this size.
const RELAY_MAX = 64 * 1024;
const HEARTBEAT = 15000; // retained "online" presence, refreshed this often
const P2P_RETRY = 90000; // P2P down while the relay hears a partner → rejoin the P2P room this often
// P2P up to some partners but not to another one that the relay hears: rejoining drops the working links for a
// moment (and their video), and the missing player retries from their side anyway – so only now and then.
const P2P_PARTIAL_RETRY = 5 * 60000;
const ALL_SLOTS = ['p1', 'p2', 'p3', 'p4']; // when the caller doesn't pass the run's slots
const RETAINED_FRESH = 35000; // a retained "online" counts only when it is younger than this (by its own timestamp)
/** No sign of life for this long → the partner counts as gone (app.mjs uses the same window). */
export const PARTNER_TTL = 45000;
const OTHER_BROKER_LIVE = 30000; // partner heard on another broker within this → one broker's last will is not "offline"

/** All public brokers at once, used like one client: publishes go to every broker that is up, so all players
 *  share a broker as long as any broker works for all of them. `only` limits a publish to some brokers. */
function relayGroup(clients) {
  return {
    clients,
    get connected() {
      return clients.some((c) => c.connected);
    },
    publish(topic, payload, opts, only) {
      for (const c of only || clients) if (c.connected) c.publish(topic, payload, opts);
    },
    end(force) {
      for (const c of clients) {
        try {
          c.end(force);
        } catch {
          // ignore
        }
      }
    },
  };
}
const NO_SCREEN ={ known: false, active: false, mode: null, url: null, blob: null, at: 0, since: 0, system: null };

/** Message carrying one still picture of the sender's game. */
export function screenFrame(from, bytes, mime, system, at = Date.now()) {
  return { kind: 'screen-frame', from, at, mime: FRAME_TYPES.includes(mime) ? mime : 'image/jpeg', system: system || null, data: b64(bytes) };
}

/** Validates a received 'screen-frame' → { bytes, blob, mime, system, at } or null. */
export function readScreenFrame(msg) {
  if (!msg || typeof msg.data !== 'string' || !msg.data || msg.data.length > SCREEN.maxBytes * 1.5) return null;
  if (!FRAME_TYPES.includes(msg.mime)) return null;
  try {
    const bytes = unb64(msg.data);
    return { bytes, blob: new Blob([bytes], { type: msg.mime }), mime: msg.mime, system: typeof msg.system === 'string' ? msg.system : null, at: Number(msg.at) || 0 };
  } catch {
    return null;
  }
}

export async function open(key, buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const iv = u8.subarray(1, 13);
  let pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, u8.subarray(13)));
  if (u8[0] === 1) pt = await gunzip(pt);
  return JSON.parse(dec.decode(pt));
}

/** Trystero's Nostr sockets: there are some and none is open or opening. */
function signallingDead(mod) {
  try {
    const socks = Object.values(mod.getRelaySockets?.() || {});
    return socks.length > 0 && socks.every((ws) => ws.readyState > 1);
  } catch {
    return false;
  }
}

export class SyncLink {
  /**
   * @param {object} o { room, secret, slot, name, doc, slots?, onStatus, onMessage }
   * slots (optional): the run's slots, e.g. ['p1','p2','p3'] – picks the default partner screen; all four if absent.
   * onMessage(msg) receives non-doc messages (chat, pings) from the other players (msg.from = their slot).
   * onPartnerScreen(view, slot) (optional) receives every change of any partner's screen – see watchPartnerScreen().
   * importers (optional, for tests/Node): { mqtt: () => import('mqtt'), trystero: () => … }
   */
  constructor(o) {
    Object.assign(this, o);
    this.status = { p2p: 'off', relay: 'off', partners: {}, partner: null, partnerSeen: null, lastSync: null, error: null };
    this.unsubs = [];
    this.stopped = false;
    this.pending = {};
    this.flushTimer = null;
    this.snapshotTimer = null;
    // partner screen – sender side
    this.share = null; // our outgoing picture (startScreenShare)
    this.screenWants = new Map(); // slot → { at } of the last "I'm watching you" from that player
    this.partnerWants = 0; // newest of those (0: nobody watches)
    // partner screen – viewer side, per watched slot
    this.screens = {}; // slot → what we know about that player's picture (NO_SCREEN shape)
    this.peerStreams = {}; // slot → their video (P2P), kept while its track is merely disabled
    this.screenWatchers = new Set(); // { fn, slot } per watchPartnerScreen() call
    this.wantSlots = new Set(); // slots we last told "I'm watching"
    this.wantTimer = null;
    this.onWantVis = null;
    this.iid = newId(); // this link instance – tells our own relay echo apart from another device of the same slot
    this.peers = new Map(); // P2P peer id → its slot (null until its hello arrived)
    this.seenIds = new Set(); // ids of recent chat/screen messages (they may arrive over P2P and several brokers)
    this.clockOffsets = {}; // slot → our clock minus theirs, from their live messages
    this.clockOffset = 0; // the same for whoever spoke last (older callers)
  }

  /** The other slots of the run (all four when the caller didn't say). */
  get others() {
    return (Array.isArray(this.slots) && this.slots.length ? this.slots : ALL_SLOTS).filter((s) => s !== this.slot);
  }

  /** Slots with a live direct (P2P) link right now. */
  _p2pSlots(p2p = this.status.p2p) {
    if (p2p !== 'connected') return new Set();
    return new Set([...this.peers.values()].filter((s) => s && s !== this.slot));
  }

  _peersOf(slot) {
    return [...this.peers].filter(([, s]) => s === slot).map(([id]) => id);
  }

  /** partners → the compatible single-partner fields: the one heard from most recently. */
  _withLatest(partners) {
    let partner = null;
    let partnerSeen = null;
    for (const [slot, p] of Object.entries(partners)) {
      if (partnerSeen === null || p.seen > partnerSeen) {
        partnerSeen = p.seen;
        partner = { slot, via: p.via };
      }
    }
    return { partners, partner, partnerSeen };
  }

  /** A sign of life from `slot` (seen: when, on our clock; via: keep the old path when null). */
  _alive(slot, via, seen = Date.now()) {
    if (!this.others.includes(slot)) return; // ourselves (another device) or no player of this run
    const old = this.status.partners[slot];
    const p = { seen: Math.max(seen, old?.seen || 0), via: via || old?.via || 'relay', p2p: this._p2pSlots().has(slot) };
    this._set(this._withLatest({ ...this.status.partners, [slot]: p }));
  }

  _gone(slot) {
    if (!this.status.partners[slot]) return;
    const partners = { ...this.status.partners };
    delete partners[slot];
    this._set(this._withLatest(partners));
  }

  _set(patch) {
    const status = { ...this.status, ...patch };
    // keep the per-player "direct link" flags in step with the peers
    const direct = this._p2pSlots(status.p2p);
    if (Object.entries(status.partners).some(([slot, p]) => p.p2p !== direct.has(slot))) {
      status.partners = Object.fromEntries(Object.entries(status.partners).map(([slot, p]) => [slot, { ...p, p2p: direct.has(slot) }]));
    }
    this.status = status;
    if (!this.stopped) this.onStatus?.(this.status);
  }

  // stop() may run while start() is still awaiting – every await is followed by a stopped check.
  async start() {
    const key = await deriveKey(this.room, this.secret);
    if (this.stopped) return;
    const hash = await sha256hex(`${this.room}:${this.secret}`);
    if (this.stopped) return;
    this.key = key;
    this.topic = `slstudio/v1/${hash.slice(0, 32)}`;
    this.unsubs.push(this.doc.onLocalChange((entries) => this._queue(entries)));
    await Promise.allSettled([this._startP2P(), this._startRelay()]);
    if (this.stopped) return;
    this.startedAt = Date.now();
    this.lastTick = Date.now();
    this.heartbeat = setInterval(() => {
      // A long gap between ticks means the computer slept: the P2P sockets are dead even if nobody said so.
      const now = Date.now();
      if (now - this.lastTick > HEARTBEAT * 2 + 5000) this._restartP2P('wake');
      this.lastTick = now;
      this._presence();
    }, HEARTBEAT);
    this.liveCheck = setInterval(() => this._checkPartner(), 5000);
    if (typeof window !== 'undefined' && window.addEventListener) {
      this.onOnline = () => this._restartP2P('online'); // Wi-Fi back / network changed
      window.addEventListener('online', this.onOnline);
    }
  }

  /**
   * Leave and rejoin the P2P room – after sleep, a network change, or when P2P stays down while the relay hears the
   * partner (the Nostr relays can drop us silently). Data keeps flowing over the relay in the meantime.
   */
  async _restartP2P(reason) {
    if (this.stopped || this.p2pRestarting) return;
    this.p2pRestarting = true;
    this.p2pRestartAt = Date.now();
    try {
      if (this.share) this._dropStream(this.share);
      try {
        this.trysteroRoom?.leave();
      } catch {
        // already gone
      }
      this.trysteroRoom = null;
      this.ops = null;
      this.peers.clear();
      this.peerId = null;
      this._set({ p2p: 'connecting' }); // no direct link to anybody until the room is joined again
      this.p2pRestarts = (this.p2pRestarts || 0) + 1;
      this.lastP2PRestart = reason;
      // Trystero pauses its signalling-relay reconnects on the window's 'offline' event and resumes them on
      // 'online' – but leaving the room (our own 'online' handler runs first) drops its listener before it fires,
      // so the pause would never end and P2P stays dead until a reload. Resuming is harmless when nothing is paused.
      try {
        this.trysteroMod?.resumeRelayReconnection?.();
      } catch {
        // older Trystero builds have no pause
      }
      await this._startP2P();
    } finally {
      this.p2pRestarting = false;
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.heartbeat);
    clearInterval(this.liveCheck);
    if (this.onOnline && typeof window !== 'undefined') window.removeEventListener('online', this.onOnline);
    clearTimeout(this.flushTimer);
    clearTimeout(this.snapshotTimer);
    this.stopScreenShare(true);
    this._wantLoop(false);
    this._clearPartnerScreen();
    this.screenWatchers.clear();
    for (const u of this.unsubs) u();
    this.unsubs = [];
    // Changes made right before leaving (a death, "the run was restarted" …) must still reach the partner:
    // send what is queued and the retained catch-up snapshot, then close the relay gracefully.
    const pending = this.pending;
    this.pending = {};
    const hasPending = Object.keys(pending).length > 0;
    if (hasPending) this._p2pSend({ kind: 'ops', from: this.slot, dev: this.iid, at: Date.now(), ops: pending }); // the relay below still carries it
    try {
      this.trysteroRoom?.leave();
    } catch {
      // ignore
    }
    const client = this.mqtt;
    if (client) {
      // "Offline" first and synchronously: on page unload (pagehide) nothing after the first await may run, and a
      // retained "online" would make the others see us live. `bye` marks it as meant for every broker.
      try {
        client.publish(`${this.topic}/presence/${this.slot}`, JSON.stringify({ online: false, at: Date.now(), bye: true }), { retain: true });
      } catch {
        // ignore
      }
      (async () => {
        try {
          if (client.connected && (hasPending || this.snapshotDue)) {
            if (hasPending) for (const part of await this._sealParts('ops', pending)) client.publish(`${this.topic}/ops/${this.slot}`, part);
            await this._publishSnapshot(client);
            // the last ops arrive live and count as a sign of life: say goodbye once more after them, or the others
            // would see us online until the partner timeout runs out
            client.publish(`${this.topic}/presence/${this.slot}`, JSON.stringify({ online: false, at: Date.now(), bye: true }), { retain: true });
          }
          client.end(false); // graceful: queued packets go out first
        } catch {
          try {
            client.end(true);
          } catch {
            // ignore
          }
        }
      })();
    }
    this.status = { ...this.status, p2p: 'off', relay: 'off', partners: {}, partner: null, partnerSeen: null };
    this.onStatus?.(this.status);
  }

  // --- outgoing ---------------------------------------------------------------
  _queue(entries) {
    Object.assign(this.pending, entries);
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this._flush(), 120);
  }

  async _flush() {
    const ops = this.pending;
    this.pending = {};
    if (!Object.keys(ops).length) return;
    // Mark the catch-up snapshot as due before the first await: a stop() while the ops are being sealed
    // then still publishes them (in the snapshot) instead of losing them.
    this.snapshotDue = true;
    const msg = { kind: 'ops', from: this.slot, dev: this.iid, at: Date.now(), ops };
    this._p2pSend(msg);
    if (this.mqtt?.connected) {
      const parts = await this._sealParts('ops', ops);
      if (this.stopped) return;
      for (const part of parts) this.mqtt.publish(`${this.topic}/ops/${this.slot}`, part);
    }
    this._snapshotSoon();
  }

  /** Sends over the direct link if it is up; false when it isn't (or the send failed right away). */
  _p2pSend(msg, opts) {
    if (!this.ops || this.status.p2p !== 'connected') return false;
    try {
      const r = opts ? this.ops.send(msg, opts) : this.ops.send(msg);
      r?.catch?.((e) => console.warn('p2p send failed', e));
      return true;
    } catch (e) {
      console.warn('p2p send failed', e);
      return false;
    }
  }

  /** Message for the partner that is not part of the document (chat, ping, sound). Goes over P2P *and* the
   *  relay – a direct link can look connected while its data channel is already dead; the id drops the copy. */
  async sendMessage(payload) {
    if (this.stopped) return;
    const msg = { kind: 'msg', mid: newId(), from: this.slot, name: this.name, at: Date.now(), payload };
    this._p2pSend(msg);
    if (this.mqtt?.connected && this.key) {
      const sealed = await seal(this.key, msg);
      if (!this.stopped && this.mqtt?.connected) this.mqtt.publish(`${this.topic}/msg/${this.slot}`, sealed);
    }
  }

  /** Document entries as relay messages below RELAY_MAX each: keys are spread over parts by a stable hash, and
   *  every part is a valid piece of the LWW map on its own (merging any subset is safe). → [Uint8Array] */
  async _sealParts(kind, entries) {
    const pack = (ops, i, n) => seal(this.key, { kind, from: this.slot, dev: this.iid, at: Date.now(), ops, ...(n > 1 ? { part: i, parts: n } : {}) });
    const whole = await pack(entries, 0, 1);
    if (whole.length <= RELAY_MAX) return [whole];
    let n = 2;
    while (n < whole.length / (RELAY_MAX * 0.6)) n *= 2;
    for (; ; n *= 2) {
      const parts = Array.from({ length: n }, () => ({}));
      for (const [k, e] of Object.entries(entries)) parts[fnv(enc.encode(k)) % n][k] = e;
      const sealed = await Promise.all(parts.map((ops, i) => pack(ops, i, n)));
      if (n >= 256 || sealed.every((s) => s.length <= RELAY_MAX)) {
        // a single huge entry can't be split – leave it out rather than get disconnected for it
        return sealed.filter((s) => s.length <= RELAY_MAX * 2 || (console.warn('relay: document part too large, skipped', s.length), false));
      }
    }
  }

  /** Retained catch-up copy of our whole document: part 0 on state/<slot>, more parts on state/<slot>/<i>. */
  async _publishSnapshot(client = this.mqtt) {
    const parts = await this._sealParts('snapshot', this.doc.entries);
    if (!client?.connected) return false;
    parts.forEach((part, i) => client.publish(`${this.topic}/state/${this.slot}${i ? `/${i}` : ''}`, part, { retain: true, qos: 1 }));
    // the document got smaller (unlikely) → clear retained parts we no longer use
    for (let i = parts.length; i < (this.snapParts || 0); i++) client.publish(`${this.topic}/state/${this.slot}/${i}`, new Uint8Array(0), { retain: true, qos: 1 });
    this.snapParts = parts.length;
    return true;
  }

  _snapshotSoon() {
    clearTimeout(this.snapshotTimer);
    if (this.stopped) return;
    this.snapshotDue = true; // stop() publishes it right away if it hasn't gone out yet
    this.snapshotTimer = setTimeout(async () => {
      if (this.stopped || !this.mqtt?.connected) return;
      // snapshotDue stays set while sealing: a stop() meanwhile publishes the snapshot itself
      const sent = await this._publishSnapshot();
      if (sent && !this.stopped) this.snapshotDue = false;
    }, 3000);
  }

  _presence(only) {
    if (this.mqtt?.connected) {
      this.mqtt.publish(`${this.topic}/presence/${this.slot}`, JSON.stringify({ online: true, at: Date.now(), name: this.name }), { retain: true }, only ? [only] : undefined);
    }
    // sign of life over the direct link too – with the relay blocked, partnerSeen would otherwise go stale
    if (!only) this._p2pSend({ kind: 'alive', from: this.slot, at: Date.now() });
    this._checkPartner();
  }

  /** Per player: no sign of life for PARTNER_TTL (and no direct link to them) → that player is gone. */
  _checkPartner() {
    if (this.stopped) return;
    const now = Date.now();
    const direct = this._p2pSlots();
    for (const [slot, p] of Object.entries(this.status.partners)) if (!direct.has(slot) && !(now - p.seen <= PARTNER_TTL)) this._gone(slot);
    // The relay hears a partner but P2P to them never came (back): rejoin the room now and then – often while
    // there's no direct link at all, rarely while it would cost the links that work (see P2P_PARTIAL_RETRY).
    const rtc = !!this.importers?.trystero || typeof globalThis.RTCPeerConnection === 'function';
    const missingSlots = Object.keys(this.status.partners).filter((slot) => !direct.has(slot));
    const missing = missingSlots.length > 0;
    // Trystero only listens to signalling events newer than "now" on our clock: when ours is ahead of a missing
    // partner's, their announcements count only once that much real time has passed – and every rejoin starts
    // that wait again. So rejoin less often than the skew (offset = our clock minus theirs, plus latency).
    const ahead = Math.max(0, ...missingSlots.map((slot) => this.clockOffsets[slot] || 0));
    const every = Math.max(this.status.p2p === 'connected' ? P2P_PARTIAL_RETRY : P2P_RETRY, ahead > 10000 ? ahead * 1.5 + 30000 : 0);
    if (rtc && missing && now - (this.p2pRestartAt || this.startedAt || now) > every) this._restartP2P('stale');
  }

  // --- incoming ---------------------------------------------------------------
  _receive(msg, via, peerId) {
    if (this.stopped || !msg || typeof msg !== 'object') return;
    const data = msg.kind === 'ops' || msg.kind === 'snapshot' || msg.kind === 'hello';
    if (via === 'p2p' && peerId && typeof msg.from === 'string') this._peerSlot(peerId, msg.from);
    const helloBack = () => {
      // reply once with our full state so both sides are complete
      if (msg.kind === 'hello' && via === 'p2p' && !msg.reply) {
        this._p2pSend({ kind: 'hello', reply: true, from: this.slot, dev: this.iid, at: Date.now(), ops: this.doc.entries }, peerId ? { target: peerId } : undefined);
      }
    };
    if (msg.from === this.slot) {
      // The same player on another device / window, or this computer's previous session (its retained snapshot):
      // its document changes count – merges are idempotent – but it is not the partner. Our own echo is skipped.
      if (!data || msg.dev === this.iid) return;
      const changed = this.doc.merge(msg.ops || {}, { live: false, offset: 0 });
      helloBack();
      return changed;
    }
    // Retained snapshots can be hours old – they carry data, not a sign of life.
    if (msg.kind !== 'snapshot') {
      const at = Number(msg.at);
      if (at > 0 && msg.kind !== 'screen-frame') this._offset(msg.from, Date.now() - at); // ≈ clock difference (+ latency)
      this._alive(msg.from, via);
    }
    if (data) {
      // `live`: ops are only ever sent right after the change; `offset` lets listeners judge the sender's
      // timestamps – the offset of *that* player's clock, each partner's computer may be off differently
      const offset = typeof msg.from === 'string' ? this.clockOffsets[msg.from] ?? 0 : 0;
      const changed = this.doc.merge(msg.ops || {}, { live: msg.kind === 'ops', offset, from: msg.from });
      this._set({ lastSync: Date.now() });
      helloBack();
      return changed;
    }
    if (this._dup(msg.mid)) return null; // same chat / screen message over P2P and the relay (or two brokers)
    if (msg.kind === 'msg') this.onMessage?.(msg);
    else if (typeof msg.kind === 'string' && msg.kind.startsWith('screen-')) this._screenIn(msg);
    return null;
  }

  _offset(slot, ms) {
    if (typeof slot !== 'string' || !Number.isFinite(ms)) return;
    this.clockOffsets[slot] = ms;
    this.clockOffset = ms;
  }

  async _startP2P() {
    try {
      this._set({ p2p: 'connecting' });
      // After a network drop the module's signalling sockets can stay closed for good (seen with public relays:
      // P2P never came back without a reload). All of them dead → a fresh module instance with new sockets.
      const fresh = this.trysteroMod && signallingDead(this.trysteroMod) ? (this.trysteroFresh = (this.trysteroFresh || 0) + 1) : 0;
      const mod = await (this.importers?.trystero ? this.importers.trystero(fresh) : import(`/vendor/trystero-nostr.min.js${fresh ? `?fresh=${fresh}` : ''}`));
      if (this.stopped) return;
      this.trysteroMod = mod;
      const { joinRoom } = mod;
      const room = joinRoom({ appId: APP_ID, password: this.secret }, this.room);
      this.trysteroRoom = room;
      const action = room.makeAction('ops');
      this.ops = action;
      // The vendored Trystero passes the sender as { peerId, …metadata } (older builds: the bare id). Without the id
      // no peer ever gets its slot – no per-player direct flags, no video, and a needless room rejoin every 5 min.
      action.onMessage = (data, from) => this._receive(data, 'p2p', typeof from === 'string' ? from : from?.peerId);
      // One peer per other player – plus possibly the same player in a second window / on a second device. The
      // link counts as connected while any peer that may be a partner is there; ops go to all peers at once.
      room.onPeerJoin = (peerId) => {
        if (this.stopped) return;
        if (!this.peers.has(peerId)) this.peers.set(peerId, null);
        if (!this.peerId) this.peerId = peerId;
        this._p2pStatus();
        try {
          action.send({ kind: 'hello', from: this.slot, dev: this.iid, at: Date.now(), ops: this.doc.entries }, { target: peerId })?.catch?.(() => {});
        } catch (e) {
          console.warn('p2p hello failed', e);
        }
        if (this.screenWatchers.size) this._sendWant();
        if (this.share) setTimeout(() => this._shareTick(), 0);
      };
      room.onPeerLeave = (peerId) => {
        if (this.stopped) return;
        const slot = this.peers.get(peerId);
        this.peers.delete(peerId);
        this._peerGone(peerId, slot);
        this._p2pStatus();
      };
      room.onPeerStream = (stream, peerId, meta) => this._peerStreamIn(stream, peerId, meta);
      this._set({ p2p: 'waiting' });
    } catch (e) {
      console.warn('P2P unavailable', e);
      this._set({ p2p: 'error', error: `P2P: ${e.message}` });
    }
  }

  _p2pStatus() {
    if (this.stopped || !this.trysteroRoom) return;
    const partnerThere = [...this.peers.values()].some((slot) => slot !== this.slot);
    const p2p = partnerThere ? 'connected' : 'waiting';
    const direct = this._p2pSlots(p2p);
    const flags = Object.entries(this.status.partners).some(([slot, p]) => p.p2p !== direct.has(slot));
    if (this.status.p2p !== p2p || flags) this._set({ p2p }); // _set refreshes the per-player flags
  }

  /** A peer told us its slot (hello / any message): keep peerId pointing at a partner, not at our own twin. */
  _peerSlot(peerId, slot) {
    if (!this.peers.has(peerId) || this.peers.get(peerId) === slot) return;
    const was = this.peers.get(peerId);
    this.peers.set(peerId, slot);
    if (slot !== this.slot && (!this.peerId || this.peers.get(this.peerId) === this.slot)) this.peerId = peerId;
    else if (slot === this.slot) this._peerGone(peerId, was);
    this._p2pStatus();
  }

  /** A peer left (or turned out to be our own twin): forget it for the screen share on both sides. */
  _peerGone(peerId, slot) {
    if (this.peerId === peerId || this.peers.get(this.peerId) === this.slot) this.peerId = [...this.peers].find(([, s]) => s !== this.slot)?.[0] || null;
    if (this.share) {
      this.share.streamPeers.delete(peerId);
      this.share.noStream = false; // a fresh link may carry video again
    }
    if (slot && slot !== this.slot && this.peerStreams[slot] && !this._peersOf(slot).length) {
      delete this.peerStreams[slot];
      if (this.screens[slot]?.mode === 'stream') this._emitScreen(slot, { active: false, mode: null });
    }
  }

  _dup(mid) {
    if (typeof mid !== 'string' || !mid) return false;
    if (this.seenIds.has(mid)) return true;
    this.seenIds.add(mid);
    if (this.seenIds.size > 256) this.seenIds.delete(this.seenIds.values().next().value);
    return false;
  }

  // One MQTT connection per public broker, all on the same topic, used together (relayGroup). The old single
  // connection rotated to the next broker on failures – which mqtt.js never reported more than once per outage,
  // so a dead first broker stalled the relay for good, and two players could end up on different brokers.
  async _startRelay() {
    if (this.stopped) return;
    try {
      const mod = await (this.importers?.mqtt ? this.importers.mqtt() : import('/vendor/mqtt.esm.js'));
      if (this.stopped) return;
      const mqtt = mod.default || mod;
      this._set({ relay: 'connecting' });
      this.mqtt = relayGroup(BROKERS.map((url) => this._relayClient(mqtt, url)));
    } catch (e) {
      console.warn('relay unavailable', e);
      this._set({ relay: 'error', error: `Relay: ${e.message}` });
    }
  }

  _relayClient(mqtt, url) {
    const client = mqtt.connect(url, {
      clientId: `sl_${this.slot}_${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 4000,
      connectTimeout: 8000,
      keepalive: 30, // a vanished app (sleep, crash) is noticed – and its last will sent – after ~45 s
      clean: true,
      will: { topic: `${this.topic}/presence/${this.slot}`, payload: JSON.stringify({ online: false, at: Date.now() }), retain: true, qos: 0 },
    });
    client.host = url.replace(/^wss:\/\//, '').split(/[:/]/)[0];
    client.partnerAt = 0; // last live message from any partner on this broker
    client.heard = {}; // slot → last live message from that player on this broker
    client.gone = {}; // slot → this broker delivered their last will
    client.on('connect', () => {
      if (this.stopped) return client.end(true);
      this._relayStatus();
      client.subscribe(`${this.topic}/#`, { qos: 0 });
      this._presence(client);
      this._snapshotSoon();
      if (this.screenWatchers.size) this._sendWant();
    });
    client.on('message', (topic, payload, packet) => this._relayIn(client, topic, payload, packet));
    client.on('error', (e) => !this.stopped && this._set({ error: `Relay: ${e.message}` }));
    client.on('close', () => !this.stopped && this._relayStatus());
    client.on('offline', () => !this.stopped && this._relayStatus());
    return client;
  }

  _relayStatus() {
    const up = (this.mqtt?.clients || []).filter((c) => c.connected);
    if (up.length) this._set({ relay: 'connected', broker: up.map((c) => c.host).join(', ') });
    else this._set({ relay: this.status.relay === 'connected' || this.status.relay === 'reconnecting' ? 'reconnecting' : 'connecting' });
  }

  async _relayIn(client, topic, payload, packet) {
    if (this.stopped || !topic.startsWith(`${this.topic}/`)) return;
    const [kind, from] = topic.slice(this.topic.length + 1).split('/');
    const own = from === this.slot;
    // Our own topics come back to us: only document data matters there (see _receive).
    if (own && kind !== 'state' && kind !== 'ops') return;
    if (!payload?.length) return; // a cleared retained message
    const retained = !!packet?.retain;
    try {
      if (kind === 'presence') return this._presenceIn(client, from, JSON.parse(dec.decode(payload)), retained);
      if (!own && !retained) this._heard(client, from);
      const msg = await open(this.key, payload);
      this._receive(msg, 'relay');
    } catch (e) {
      // wrong key (other run on same topic is practically impossible) or truncated message
      console.warn('relay message rejected', kind, e.message);
    }
  }

  _heard(client, slot) {
    const now = Date.now();
    client.partnerAt = now;
    client.heard[slot] = now;
    client.gone[slot] = false;
  }

  /** Presence of one player (topic presence/<slot>) – every player's is judged on its own. */
  _presenceIn(client, from, p, retained) {
    const now = Date.now();
    if (p?.online) {
      // A live heartbeat is proof of life right now – measured on our clock, as theirs may be minutes off.
      // A retained one is only the last word of a session that may have ended without a goodbye (page closed,
      // crash, sleep – the last will comes only after the keepalive): it counts only while its own timestamp is
      // fresh, and only from when it was sent.
      let seen = now;
      if (retained) {
        const age = now - Number(p.at);
        if (!(Math.abs(age) < RETAINED_FRESH)) return;
        seen = now - Math.max(0, age);
      } else {
        this._heard(client, from);
        const at = Number(p.at);
        if (at > 0) this._offset(from, now - at);
      }
      this._alive(from, null, seen);
      return;
    }
    if (this._p2pSlots().has(from)) return; // the direct link still hears them
    // "Offline" is retained per broker: an old one on one broker means nothing while the player is live on
    // another. A last will (no `bye`) only says this one broker lost them – it counts once no other broker heard
    // from them lately (or those lost them too).
    const seen = this.status.partners[from]?.seen;
    if (retained && seen && now - seen < OTHER_BROKER_LIVE) return;
    if (!retained && !p?.bye) {
      client.gone[from] = true;
      const elsewhere = (this.mqtt?.clients || []).some((c) => c !== client && c.connected && !c.gone?.[from] && now - (c.heard?.[from] || 0) < OTHER_BROKER_LIVE);
      if (elsewhere) return;
    }
    this._gone(from);
  }

  // --- partner screen ------------------------------------------------------------
  // Sender: startScreenShare(source) sends our game picture, but only while somebody watches it (their
  // 'screen-want' heartbeat, addressed to our slot) – so players on an older app version or with the mini view
  // hidden cost nothing. Several players may watch us at once and one picture serves them all: with a direct
  // P2P link to every watcher it is a WebRTC video track, added for each watcher's peer (and taken away when they
  // stop watching); as soon as one watcher is reachable over the relay only (or asked for pictures because the
  // video never arrived), everybody gets a small encrypted JPEG every 1.5 s instead – one broadcast on our own
  // relay topic (never retained) that every watcher reads. One format for all keeps the sender simple; mixed
  // links are rare. Paused game / hidden window → the video track is disabled and no pictures are sent.
  // Viewer: watchPartnerScreen(fn, slot) → fn({ slot, known, active, mode, stream, url, blob, at, since, system }).

  /**
   * @param {object} source
   *   getStream?: () => MediaStream|null|Promise   live video of the game (P2P path)
   *   getSnapshot?: ({ maxW, quality, type }) => Promise<Blob|null>   small still picture (relay path)
   *   isActive?: () => boolean   false while the game is paused / not running
   *   system?: 'nds'|'gba'|'gbc'|'gb'
   */
  startScreenShare(source = {}) {
    if (this.stopped) return;
    this.stopScreenShare(true);
    const s = {
      src: source, mode: null, stream: null, streamPeers: new Set(), limited: new Set(), noStream: false,
      busy: false, lastState: 0, lastFrame: 0, lastHash: 0, q: { maxW: 192, quality: 0.5, type: 'image/jpeg' },
    };
    this.share = s;
    s.timer = setInterval(() => this._shareTick(), SCREEN.tick);
    s.onVis = () => this._shareTick();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', s.onVis);
    this._shareTick();
  }

  stopScreenShare(silent = false) {
    const s = this.share;
    if (!s) return;
    this.share = null;
    clearInterval(s.timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', s.onVis);
    this._dropStream(s);
    if (!silent && s.mode) this._screenSend({ kind: 'screen-state', from: this.slot, active: false, mode: null }).catch(() => {});
  }

  _dropStream(s) {
    const stream = s.stream;
    s.stream = null;
    s.streamPeers = new Set();
    s.limited = new Set();
    if (!stream) return;
    try {
      this.trysteroRoom?.removeStream(stream);
    } catch {
      // peer already gone
    }
    for (const tr of stream.getTracks()) tr.stop();
  }

  /** Slots that watch our picture right now (their "I'm watching" is fresh). */
  _watching() {
    const now = Date.now();
    return [...this.screenWants].filter(([, w]) => now - w.at < SCREEN.wantTtl).map(([slot]) => slot);
  }

  async _shareTick() {
    const s = this.share;
    if (!s || s.busy || this.stopped || !this.key) return;
    s.busy = true;
    try {
      await this._shareStep(s);
    } catch (e) {
      console.warn('screen share', e);
    } finally {
      s.busy = false;
    }
  }

  async _shareStep(s) {
    // A covered window counts as hidden, but the desktop app keeps the game running there (no background
    // throttling) – so in the app only the emulator decides; in a browser a hidden tab really stops.
    let active = typeof document === 'undefined' || !document.hidden || !!globalThis.sls?.native;
    const backgrounded = !active; // tab in the background: the game may well run, there's just no picture
    try {
      if (active && s.src.isActive) active = !!s.src.isActive();
    } catch {
      active = false; // emulator iframe gone / not ready
    }
    const watchers = this._watching();
    const wanted = watchers.length > 0;
    // video only when every watcher has a direct link – see above
    const direct = this._p2pSlots();
    const targets = watchers.flatMap((slot) => this._peersOf(slot));
    const p2p = wanted && !!this.trysteroRoom && watchers.every((slot) => direct.has(slot));
    let mode = null;
    if (active && wanted) mode = p2p && s.src.getStream && !s.noStream && (await this._ensureStream(s, targets)) ? 'stream' : 'image';
    if (this.stopped || this.share !== s) return;
    if (s.stream) for (const tr of s.stream.getVideoTracks()) tr.enabled = mode === 'stream';
    if (mode === 'stream' && s.limited.size < s.streamPeers.size) this._limitBitrate(s);
    const now = Date.now();
    if (mode !== s.mode || (wanted && now - s.lastState > SCREEN.wantEvery)) {
      s.mode = mode;
      s.lastState = now;
      await this._screenSend({ kind: 'screen-state', from: this.slot, active: !!mode, mode, system: s.src.system || null, ...(backgrounded ? { paused: true } : {}) });
    }
    if (mode === 'image') await this._sendFrame(s);
  }

  /** Our video on the peers in `targets` (the watchers' peers): added for new ones, taken from those who left. */
  async _ensureStream(s, targets) {
    const live = s.stream?.getVideoTracks().some((tr) => tr.readyState === 'live');
    if (!live) {
      this._dropStream(s); // the game was restarted / the iframe reloaded → fresh canvas, fresh track
      let stream = null;
      try {
        stream = await s.src.getStream();
      } catch {
        stream = null;
      }
      if (this.stopped || this.share !== s) {
        stream?.getTracks().forEach((tr) => tr.stop());
        return false;
      }
      if (!stream?.getVideoTracks().length) return false; // canvas not there yet → pictures for now, retry next tick
      stream.getAudioTracks().forEach((tr) => {
        tr.stop();
        stream.removeTrack(tr);
      });
      s.stream = stream;
    }
    for (const peer of [...s.streamPeers]) {
      if (targets.includes(peer)) continue;
      s.streamPeers.delete(peer);
      s.limited.delete(peer);
      try {
        this.trysteroRoom.removeStream(s.stream, { target: peer });
      } catch {
        // peer already gone
      }
    }
    const add = targets.filter((peer) => !s.streamPeers.has(peer));
    if (!add.length) return true;
    for (const peer of add) s.streamPeers.add(peer);
    try {
      const meta = { kind: 'screen', from: this.slot, system: s.src.system || null };
      const sent = add.flatMap((target) => [].concat(this.trysteroRoom.addStream(s.stream, { target, metadata: meta }) || []));
      await timeout(Promise.all(sent), 10000);
    } catch (e) {
      console.warn('screen stream unavailable, sending pictures', e);
      if (this.share === s) {
        s.noStream = true;
        this._dropStream(s);
      }
      return false;
    }
    return !this.stopped && this.share === s;
  }

  // Canvas tracks run at the canvas' full size (often > 1000 px on a retina screen) – cap what goes out.
  _limitBitrate(s) {
    const track = s.stream?.getVideoTracks()[0];
    for (const peer of s.streamPeers) {
      if (s.limited.has(peer)) continue;
      try {
        const pc = this.trysteroRoom?.getPeers?.()[peer];
        const sender = pc?.getSenders?.().find((x) => x.track === track);
        if (!sender) continue;
        const p = sender.getParameters();
        if (!p.encodings?.length) continue; // not negotiated yet → next tick
        const w = track.getSettings?.().width || 0;
        Object.assign(p.encodings[0], { maxBitrate: 400000, maxFramerate: 15, scaleResolutionDownBy: Math.max(1, w / 384) });
        s.limited.add(peer);
        sender.setParameters(p).catch(() => s.limited.delete(peer));
      } catch {
        // best effort
      }
    }
  }

  async _sendFrame(s) {
    if (!s.src.getSnapshot) return;
    if (!(this.ops && this.status.p2p === 'connected') && !this.mqtt?.connected) return;
    let blob = null;
    try {
      blob = await s.src.getSnapshot({ ...s.q });
    } catch {
      blob = null;
    }
    if (this.stopped || this.share !== s || !blob?.size) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (this.stopped || this.share !== s) return;
    // keep pictures small: step quality (then size) down when over target, back up when well under
    if (bytes.length > SCREEN.target) {
      s.q.quality = Math.max(0.25, Math.round((s.q.quality - 0.1) * 100) / 100);
      if (s.q.quality <= 0.3) s.q.maxW = Math.max(128, s.q.maxW - 32);
    } else if (bytes.length < SCREEN.target / 2 && s.q.quality < 0.5) {
      s.q.quality = Math.round((s.q.quality + 0.05) * 100) / 100;
    }
    if (bytes.length > SCREEN.maxBytes) return;
    const now = Date.now();
    const h = fnv(bytes);
    if (h === s.lastHash && now - s.lastFrame < SCREEN.resendSame) return;
    s.lastHash = h;
    s.lastFrame = now;
    await this._screenSend(screenFrame(this.slot, bytes, blob.type, s.src.system, now), true);
  }

  /**
   * P2P when connected (to every peer), and the relay's screen topic – encrypted, not retained. `slots`: who it is
   * for (our watchers by default; the watched player for a 'screen-want').
   */
  async _screenSend(msg, oneWay = false, slots = this._watching()) {
    if (this.stopped) return;
    if (!msg.mid) msg = { ...msg, mid: newId() }; // the copy over the other path / another broker is dropped
    if (this._p2pSend(msg)) {
      // Pictures go one way only while every watcher really talks to us directly – after their app came
      // back on the relay alone, a stale P2P link would swallow them.
      const direct = this._p2pSlots();
      if (oneWay && slots.length && slots.every((sl) => direct.has(sl) && this.status.partners[sl]?.via === 'p2p')) return;
    }
    if (!this.mqtt?.connected || !this.key) return;
    const sealed = await seal(this.key, msg);
    if (this.stopped || !this.mqtt?.connected) return;
    if (sealed.length > SCREEN.maxBytes * 1.6) return;
    // pictures are the bulk of the traffic: only to the brokers those players were heard on lately (else all)
    const now = Date.now();
    const there = this.mqtt.clients?.filter((c) => c.connected && slots.some((sl) => now - (c.heard?.[sl] || 0) < OTHER_BROKER_LIVE * 1.5));
    this.mqtt.publish(`${this.topic}/screen/${this.slot}`, sealed, { qos: 0, retain: false }, there?.length ? there : undefined);
  }

  // viewer ------------------------------------------------------------------------
  /** Whose picture a watcher gets when it doesn't name one: the first other player that is online, else the first. */
  defaultScreenSlot() {
    const others = this.others;
    return others.find((s) => this.status.partners[s]) || others[0] || null;
  }

  /**
   * Subscribe to one partner's picture (slot; default: defaultScreenSlot() at the time of the call). While anyone
   * watches (and this window is visible) we ask that player to send it. fn gets the current view right away.
   * Returns the unsubscribe function; to switch to another player, unsubscribe and watch again.
   */
  watchPartnerScreen(fn, slot) {
    if (typeof fn === 'string' && typeof slot === 'function') [fn, slot] = [slot, fn]; // (slot, fn) works too
    if (!this.others.includes(slot)) slot = this.defaultScreenSlot();
    if (this.stopped || !slot) {
      fn(this._screenView(slot));
      return () => {};
    }
    const w = { fn, slot };
    this.screenWatchers.add(w);
    fn(this._screenView(slot));
    if (!this.wantTimer) this._wantLoop(true);
    else this._sendWant();
    return () => {
      if (!this.screenWatchers.delete(w)) return;
      if (!this.screenWatchers.size) this._wantLoop(false);
      else this._sendWant(); // tells the player nobody watches anymore, if this was the last one on them
      if (!this._watched(slot) && this.screens[slot]?.url) this._emitScreen(slot, { url: null, blob: null }, true);
    };
  }

  _watched(slot) {
    for (const w of this.screenWatchers) if (w.slot === slot) return true;
    return false;
  }

  _wantLoop(on) {
    clearInterval(this.wantTimer);
    this.wantTimer = null;
    if (this.onWantVis && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onWantVis);
    this.onWantVis = null;
    if (!on) {
      this._sendWant(false);
      return;
    }
    this.wantTimer = setInterval(() => this._sendWant(), SCREEN.wantEvery);
    this.onWantVis = () => this._sendWant();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onWantVis);
    this._sendWant();
  }

  /** "I'm watching you" to every watched player (and "not anymore" to those we stopped watching). */
  _sendWant(want) {
    if (this.stopped || !this.key) return;
    const visible = typeof document === 'undefined' || !document.hidden;
    const on = new Set(want === false || !visible ? [] : [...this.screenWatchers].map((w) => w.slot));
    for (const slot of new Set([...on, ...this.wantSlots])) {
      const ps = this.screens[slot] || NO_SCREEN;
      // video was announced but never arrived (media blocked between us) → ask for still pictures instead
      const images = ps.mode === 'stream' && !this.peerStreams[slot] && ps.since > 0 && Date.now() - ps.since > SCREEN.streamGrace;
      this._screenSend({ kind: 'screen-want', from: this.slot, to: slot, want: on.has(slot), images }, false, [slot]).catch(() => {});
    }
    this.wantSlots = on;
  }

  _screenIn(msg) {
    if (msg.kind === 'screen-want') {
      // meant for another player's picture; older apps send no `to` – they only know one partner: us
      if (msg.to !== undefined && msg.to !== this.slot) return;
      const now = Date.now();
      const was = now - (this.screenWants.get(msg.from)?.at || 0) < SCREEN.wantTtl;
      if (msg.want) this.screenWants.set(msg.from, { at: now });
      else this.screenWants.delete(msg.from);
      this.partnerWants = Math.max(0, ...[...this.screenWants.values()].map((w) => w.at));
      if (this.share) {
        if (msg.images && !this.share.noStream) {
          this.share.noStream = true;
          this._dropStream(this.share);
        }
        if (msg.want && !was) this.share.lastState = 0;
        if (!!msg.want !== was) setTimeout(() => this._shareTick(), 0);
      }
      return;
    }
    const slot = msg.from;
    if (!this.others.includes(slot)) return;
    const ps = this.screens[slot] || NO_SCREEN;
    if (msg.kind === 'screen-state') {
      const mode = msg.active ? (msg.mode === 'stream' ? 'stream' : 'image') : null;
      const patch = { known: true, active: !!msg.active, paused: !msg.active && !!msg.paused, mode, system: typeof msg.system === 'string' ? msg.system : ps.system };
      if (mode === 'stream' && ps.mode !== 'stream') patch.since = Date.now();
      if (mode !== 'image') Object.assign(patch, { url: null, blob: null });
      this._emitScreen(slot, patch);
      return;
    }
    if (msg.kind === 'screen-frame') {
      if (!this._watched(slot) && !this.onPartnerScreen) return;
      const frame = readScreenFrame(msg);
      if (!frame) return;
      const url = typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(frame.blob) : null;
      this._emitScreen(slot, { known: true, active: true, mode: 'image', url, blob: frame.blob, at: Date.now(), system: frame.system || ps.system });
    }
  }

  _peerStreamIn(stream, peerId, meta) {
    if (this.stopped || (meta && meta.kind && meta.kind !== 'screen')) return;
    const slot = typeof meta?.from === 'string' && this.others.includes(meta.from) ? meta.from : this.peers.get(peerId);
    if (!slot || slot === this.slot) return;
    this.peerStreams[slot] = stream;
    const gone = () => {
      if (this.peerStreams[slot] !== stream || stream.getVideoTracks().some((tr) => tr.readyState === 'live')) return;
      delete this.peerStreams[slot];
      if (this.screens[slot]?.mode === 'stream') this._emitScreen(slot, { active: false, mode: null });
    };
    stream.getVideoTracks().forEach((tr) => tr.addEventListener?.('ended', gone));
    stream.addEventListener?.('removetrack', gone);
    this._emitScreen(slot, { known: true, active: true, mode: 'stream', system: meta?.system || this.screens[slot]?.system || null, url: null, blob: null, at: Date.now() });
  }

  _screenView(slot) {
    const ps = (slot && this.screens[slot]) || NO_SCREEN;
    return { ...ps, slot: slot || null, stream: ps.mode === 'stream' ? this.peerStreams[slot] || null : null };
  }

  _emitScreen(slot, patch, quiet = false) {
    const old = this.screens[slot]?.url;
    this.screens[slot] = { ...(this.screens[slot] || NO_SCREEN), ...patch };
    // the <img> has decoded the previous picture by now; give it a moment before the URL goes away
    if (old && old !== this.screens[slot].url) setTimeout(() => URL.revokeObjectURL(old), 1000);
    if (quiet) return;
    const view = this._screenView(slot);
    for (const w of this.screenWatchers) {
      if (w.slot !== slot) continue;
      try {
        w.fn(view);
      } catch (e) {
        console.warn('partner screen watcher', e);
      }
    }
    try {
      this.onPartnerScreen?.(view, slot);
    } catch (e) {
      console.warn('onPartnerScreen', e);
    }
  }

  _clearPartnerScreen() {
    this.peerStreams = {};
    const slots = new Set([...Object.keys(this.screens), ...[...this.screenWatchers].map((w) => w.slot)]);
    for (const slot of slots) this._emitScreen(slot, { ...NO_SCREEN });
  }
}
