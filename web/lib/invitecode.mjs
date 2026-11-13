// Invite by code: the host shows a 6-digit code, the partner types it in, and the run pack (the same JSON as
// the invite file) travels over the public MQTT relay – encrypted, and only after the host pressed "Allow".
// A run has up to 4 players: every code admits one person; the host invites the others one after another with
// a new code each. Next to the pack the host sends which player slot it suggests and which slots are taken
// already (as far as it knows: itself, players seen online or with data in the run, earlier codes), so the new
// player's app can preselect "I am …" (suggestSlot).
//
// Threat model – the relay is public: anyone can subscribe to every topic and publish anything.
//  - Rendezvous topic = PBKDF2(code, fixed app salt, 1M rounds). It doesn't show the code, but there are only
//    10^6 codes: a GPU finds the code behind a topic in minutes. So the code counts as guessable and is never
//    used on its own as an encryption key.
//  - The pack is encrypted with a key from an X25519 exchange whose public keys are masked with a pad derived
//    from the code (EKE-style PAKE). A passive observer – even one who knows the code – only sees masked keys
//    and would have to solve Diffie-Hellman to read anything. Every 32-byte string unmasks to a usable X25519
//    key, so the masked keys don't tell right and wrong pads apart (only leak: ~1 bit per key, curve vs. twist –
//    irrelevant for a code that is used once).
//  - Somebody actively using the code (guessed, brute-forced from the topic) can only *ask* to join: the host
//    sees their name and must allow it. Two different valid requests for one code cancel it (somebody else has
//    the code); the partner likewise gives up when two different hosts answer.
//  - Garbage or a wrong pad → no key → counted: 3 failed or declined attempts or 8 requests lock the code. It
//    expires after 15 minutes (latecomers are told so for another 30 while the host app stays open) and is
//    single-use (after "Allow" nobody else gets an answer).
//  - The 4 confirmation digits (confirmationCode) are enforced, not just shown: "Allow" only seals and sends the
//    pack when the host typed the digits the partner's app shows and they equal the host's own (allow({ confirm })).
//    Somebody in the middle runs two separate exchanges, so the digits differ unless they get lucky (1 in 10^4)
//    or grind their own key against them – see the residual risks.
//  - Residual risk: a GPU attacker who cracks the topic in time and whose made-up name the host allows gets the
//    pack (= the room key) only if they also tell the host the right 4 digits – i.e. if the host takes the digits
//    from them instead of from the person they gave the code to. Somebody in the middle who can keep the partner's
//    messages from the host (a public relay rarely allows that: two requests cancel the code) could pick their
//    ephemeral key until both sides show the same digits – nothing commits a side to its key before it sees the
//    other's; closing that needs a commit-then-reveal step, i.e. a new wire version. Flooding the topic or forging
//    error replies (denial of service) is always possible on a public broker.
// Relay only, no Trystero: its room password would be the bare 6-digit code, and the handshake is a few messages.
//
// Wire format, <T> = slstudio/invite/v1/<topic id>, rid = the partner's random request id, nothing retained:
//   req/<rid>    partner → host  JSON { v, key: masked B }               resent until answered
//   res/<rid>    host → partner  JSON { v, key: masked A } | { v, error }
//   hello/<rid>  partner → host  sealed { kind: 'hello', name }          resent until the host decided
//   pack/<rid>   host → partner  sealed { kind: 'pack', ok, pack?, slot?, taken? } | JSON { v, error }
//   ack/<rid>    partner → host  sealed { kind: 'ack' }    bye/<rid>  sealed { kind: 'bye' } when the partner gives up
import { BROKERS, seal, open } from './sync.mjs';

export const CODE_TTL = 15 * 60000;
export const KDF_ITERATIONS = 1000000;
// Protocol ids from the app's former name – they must never change, or codes and packs of other versions stop working.
const SALT = 'soullink-studio/invite-code@1';
const PACK_FORMAT = 'soullink-studio/run-pack@1';
const MAX_FAILS = 3; // wrong key or declined
const MAX_REQUESTS = 8; // different request ids per code
const RESEND = 3000;
const NO_HOST = 20000; // partner: no answer for this long → wrong code or the host's app isn't showing it
const ACK_WAIT = 60000; // host: after "Allow", wait this long for the partner's receipt
// host: after expiry keep answering "expired" this long – somebody typing the code late learns it ran out
// instead of "nobody answered, check the digits"
const LINGER = 30 * 60000;
const HOST_GONE = 15000;
const STALE = RESEND * 3; // host: a waiting partner resends every RESEND – silent this long = gone (app closed / reloaded) // partner: the host answered "still deciding" before and then went quiet this long → gone
const enc = new TextEncoder();
const dec = new TextDecoder();

const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (u8) => btoa(String.fromCharCode(...u8));
function unb64(s) {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
const xor = (a, b) => a.map((x, i) => x ^ b[i]);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
};
/** Plain JSON control messages start with '{' – sealed ones with the 0/1 gzip flag. */
function json(u8) {
  if (u8[0] !== 0x7b) return null;
  try {
    return JSON.parse(dec.decode(u8));
  } catch {
    return null;
  }
}
const errMsg = (error) => enc.encode(JSON.stringify({ v: 1, error }));
const RID = /^[a-z0-9]{12}$/;
const randomId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

/** Uniform 6-digit code (rejection sampling – no modulo bias). */
export function newCode() {
  const n = new Uint32Array(1);
  do crypto.getRandomValues(n);
  while (n[0] >= 4294000000);
  return String(n[0] % 1000000).padStart(6, '0');
}

/** "123 456", "123-456", " 123456 " → "123456"; anything else → null. */
export function normalizeCode(s) {
  const d = String(s ?? '').replace(/[\s\-–.]/g, '');
  return /^\d{6}$/.test(d) ? d : null;
}

export const formatCode = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;

/** The 4 confirmation digits as typed: "12 34", " 1234 " → "1234"; anything else → null. */
export function normalizeConfirm(s) {
  const d = String(s ?? '').replace(/[\s\-–.]/g, '');
  return /^\d{4}$/.test(d) ? d : null;
}

/** Code → rendezvous topic + 32-byte pad that masks the X25519 keys. Slow on purpose (see the threat model). */
export async function deriveCodeKeys(code, iterations = KDF_ITERATIONS) {
  const c = normalizeCode(code);
  if (!c) throw new Error('invalid code');
  const base = await crypto.subtle.importKey('raw', enc.encode(c), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(SALT), iterations, hash: 'SHA-256' }, base, 384));
  return { topic: `slstudio/invite/v1/${hex(bits.subarray(0, 16))}`, pad: bits.slice(16, 48) };
}

let supported = null;
/** X25519 in WebCrypto (Chromium 133+, Firefox 130+, Safari 17+, Node 20+). Without it: invite file only. */
export function inviteCodeSupported() {
  supported ??= crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']).then(() => true, () => false);
  return supported;
}

async function ephemeral(pad) {
  const kp = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  // X25519 ignores the top bit – randomize it, or a cleared bit would mark the right pad
  pub[31] |= crypto.getRandomValues(new Uint8Array(1))[0] & 0x80;
  return { priv: kp.privateKey, masked: xor(pub, pad) };
}

/**
 * 4-digit confirmation code both sides show ("Check that your partner sees the same code"). HKDF from the same
 * X25519 secret as the session key, but with its own label, so it says nothing about the AES key. Somebody in
 * the middle (who knows the code) runs two separate exchanges – host and partner then see different digits.
 */
export async function confirmationCode(shared, pad, rid, hostMasked, guestMasked) {
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const info = concat(enc.encode(`${SALT}|confirm|${rid}|`), hostMasked, guestMasked);
  const bits = new DataView(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: pad, info }, ikm, 32));
  return String(bits.getUint32(0) % 10000).padStart(4, '0'); // modulo bias ~1e-6 – irrelevant for a visual check
}

/**
 * AES key both sides share only if they used the same pad (code). Bound to request id and both masked keys.
 * → { key, confirm } (confirm: see confirmationCode).
 */
async function sessionKey(priv, theirMasked, pad, rid, hostMasked, guestMasked) {
  const pub = xor(theirMasked, pad);
  pub[31] &= 0x7f;
  const theirs = await crypto.subtle.importKey('raw', pub, { name: 'X25519' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: theirs }, priv, 256); // throws for low-order points
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const info = concat(enc.encode(`${SALT}|${rid}|`), hostMasked, guestMasked);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: pad, info }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { key, confirm: await confirmationCode(shared, pad, rid, hostMasked, guestMasked) };
}

/** One connection per public broker, all on the same topic – whichever works carries the handshake. */
async function connectRelay(topic, importers, onMessage, onUp) {
  const mod = await (importers?.mqtt ? importers.mqtt() : import('/vendor/mqtt.esm.js'));
  const mqtt = mod.default || mod;
  const id = Math.random().toString(16).slice(2, 10);
  const clients = BROKERS.map((url, i) => {
    const c = mqtt.connect(url, { clientId: `sli_${id}_${i}`, reconnectPeriod: 4000, connectTimeout: 8000, clean: true });
    c.on('connect', () => {
      c.subscribe(`${topic}/#`, { qos: 0 });
      onUp?.();
    });
    c.on('message', (t, payload) => {
      const [kind, rid] = t.slice(topic.length + 1).split('/');
      if (RID.test(rid || '')) onMessage(kind, rid, new Uint8Array(payload));
    });
    c.on('error', () => {}); // another broker may still work
    return c;
  });
  return {
    send(kind, rid, payload) {
      for (const c of clients) if (c.connected) c.publish(`${topic}/${kind}/${rid}`, payload, { qos: 0, retain: false });
    },
    end() {
      for (const c of clients) {
        try {
          c.end(false); // not forced: the last ack / error still goes out
        } catch {
          // ignore
        }
      }
    },
  };
}

const CLOSED = ['done', 'expired', 'locked', 'conflict', 'cancelled', 'error'];
// what a partner who knocks on a closed code is told
const WIRE_ERROR = { sending: 'used', done: 'used', cancelled: 'expired', error: 'expired' };

/**
 * Which player a newcomer should be: the free slot whose name matches theirs; else a taken one with their name –
 * somebody re-joining (another computer, or a code that broke off after the seat was handed out; the join page
 * says it is taken); else the first free one; else – every slot taken, no name matches – the first taken one
 * that isn't live right now: somebody re-joining after a reinstall under another name (the players who are
 * live can't be the newcomer); null when there is none.
 * players: the pack's { p1: {name}, … }; taken: slots that already have somebody; online (optional): slots
 * that are live right now, the host's own included.
 */
export function suggestSlot(players, taken = [], name = '', online = null) {
  const all = Object.keys(players || {}).filter((s) => /^p[1-4]$/.test(s)).sort();
  const free = all.filter((s) => !taken.includes(s));
  const n = String(name || '').trim().toLowerCase();
  const named = (s) => n && String(players[s]?.name || '').trim().toLowerCase() === n;
  const away = Array.isArray(online) ? all.find((s) => !online.includes(s)) : null;
  return free.find(named) || all.find(named) || free[0] || away || null;
}

/** The host's seat hint, checked against the pack (it is only a suggestion – the joiner can change it). */
function seatOf(msg, pack) {
  const slots = Object.keys(pack?.players || {});
  const taken = Array.isArray(msg.taken) ? msg.taken.filter((s) => slots.includes(s)) : [];
  const slot = slots.includes(msg.slot) ? msg.slot : suggestSlot(pack?.players, taken);
  return { slot, taken };
}

/**
 * Host side. new CodeHost({ pack, onState, seat? }).start(); then allow({ confirm }) / decline() / cancel().
 * allow() needs the 4 digits the partner's app shows (typed by the host) and refuses – nothing is sealed or sent,
 * returns false – unless they equal request.confirm; the host may correct them and try again, or decline.
 * seat (optional): (requestName) → { slot, taken } – evaluated on "Allow", sent along with the pack.
 * state: { phase, code, expiresAt, request: { rid, name, confirm } | null, fails, admitted (name), seat, acked, error }
 * phase: starting → waiting ⇄ request → sending → done; or expired | locked | conflict | cancelled | error.
 * Test-only options: importers, ttl, linger, iterations, code.
 */
export class CodeHost {
  constructor(o) {
    Object.assign(this, o);
    this.code = o.code || newCode();
    this.requests = new Map(); // rid → { rid, state: 'new'|'keyed'|'pending'|'declined'|'failed'|'gone'|'sent', key, reply, packMsg }
    this.fails = 0;
    this.state = { phase: 'starting', code: this.code, expiresAt: Date.now() + (o.ttl || CODE_TTL), request: null, fails: 0, acked: false, error: null };
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.onState?.(this.state);
  }

  get _open() {
    return this.state.phase === 'waiting' || this.state.phase === 'request';
  }

  async start() {
    try {
      const { topic, pad } = await deriveCodeKeys(this.code, this.iterations);
      this.pad = pad;
      this.me = await ephemeral(pad);
      if (this.stopped) return;
      const relay = await connectRelay(topic, this.importers, (kind, rid, payload) => this._in(kind, rid, payload).catch((e) => console.warn('invite code', e)));
      if (this.stopped) return relay.end();
      this.relay = relay;
      this.timer = setTimeout(() => this._close('expired'), Math.max(0, this.state.expiresAt - Date.now()));
      this._set({ phase: 'waiting' });
    } catch (e) {
      this._close('error', { error: e.message });
    }
  }

  async _in(kind, rid, payload) {
    if (this.stopped) return;
    if (this.lingering) return kind === 'req' ? this.relay?.send('res', rid, errMsg('expired')) : undefined;
    if (kind === 'req') return this._request(rid, payload);
    const r = this.requests.get(rid);
    if (!r?.key) return;
    r.seen = Date.now();
    if (kind === 'hello') return this._hello(r, payload);
    if (kind !== 'ack' && kind !== 'bye') return;
    const m = await open(r.key, payload).catch(() => null);
    if (m?.kind !== kind) return;
    if (kind === 'ack' && r.state === 'sent') this._close('done', { acked: true });
    else if (kind === 'bye' && r.state !== 'sent') {
      r.state = 'gone';
      if (this.state.request?.rid === rid) this._set({ phase: 'waiting', request: null });
    }
  }

  async _request(rid, payload) {
    const known = this.requests.get(rid);
    if (known) {
      known.seen = Date.now();
      if (known.reply) this.relay?.send('res', rid, known.reply); // the partner didn't get our answer yet
      return;
    }
    if (!this._open) return this.relay?.send('res', rid, errMsg(WIRE_ERROR[this.state.phase] || this.state.phase));
    const m = json(payload);
    const theirs = m?.v === 1 && typeof m.key === 'string' ? unb64(m.key) : null;
    if (theirs?.length !== 32) return;
    if (this.requests.size >= MAX_REQUESTS) {
      this.relay?.send('res', rid, errMsg('locked'));
      return this._close('locked');
    }
    const r = { rid, state: 'new', seen: Date.now() };
    this.requests.set(rid, r); // before the await – resends of the same request wait for this one
    try {
      ({ key: r.key, confirm: r.confirm } = await sessionKey(this.me.priv, theirs, this.pad, rid, this.me.masked, theirs));
    } catch {
      r.state = 'failed';
      return this._fail();
    }
    if (this.stopped) return;
    r.state = 'keyed';
    r.reply = enc.encode(JSON.stringify({ v: 1, key: b64(this.me.masked) }));
    this.relay?.send('res', rid, r.reply);
  }

  async _hello(r, payload) {
    if (r.state === 'sent') return r.packMsg && this.relay?.send('pack', r.rid, r.packMsg); // our pack got lost → again
    // Still deciding: answer every resent hello with "wait", so the partner can tell a slow host from a closed one.
    // Older partners ignore it (it isn't a pack).
    if (r.state === 'pending') return this._wait(r);
    if (r.state !== 'keyed') return; // pending: the host decides; failed / declined / gone: done with it
    const m = await open(r.key, payload).catch(() => null);
    if (r.state !== 'keyed' || this.stopped) return;
    if (m?.kind !== 'hello') {
      // other pad = other code → the partner's key doesn't match ours
      r.state = 'failed';
      this.relay?.send('pack', r.rid, errMsg('bad'));
      return this._fail();
    }
    if (!this._open) return;
    // A request that went silent is gone (its app was closed or reloaded – the same person trying again
    // mustn't count as a second one); a second person who really knows the code while one still waits → nobody gets in.
    for (const x of this.requests.values()) if (x !== r && x.state === 'pending' && Date.now() - x.seen > STALE) x.state = 'gone';
    if ([...this.requests.values()].some((x) => x !== r && x.state === 'pending')) return this._close('conflict');
    r.state = 'pending';
    const name = String(m.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
    this._set({ phase: 'request', request: { rid: r.rid, name, confirm: r.confirm } });
    this._wait(r);
  }

  async _wait(r) {
    r.waitMsg ||= await seal(r.key, { kind: 'wait' });
    if (!this.stopped && r.state === 'pending') this.relay?.send('pack', r.rid, r.waitMsg);
  }

  _fail() {
    this.fails++;
    this._set({ fails: this.fails });
    if (this.fails >= MAX_FAILS) this._close('locked');
  }

  async allow({ confirm } = {}) {
    const r = this.requests.get(this.state.request?.rid);
    if (!r || r.state !== 'pending' || this.state.phase !== 'request') return false;
    // The room key only goes to the person who sees our digits: a request whose digits the host didn't confirm –
    // not typed, mistyped, or the other ones somebody in the middle produces – gets nothing.
    if (!r.confirm || normalizeConfirm(confirm) !== r.confirm) return false;
    r.state = 'sent'; // single use: from here on every other request is answered with 'used'
    clearTimeout(this.timer);
    let seat = null;
    try {
      seat = this.seat?.(this.state.request.name) || null;
    } catch (e) {
      console.warn('invite seat', e); // only a hint – the pack goes out anyway
    }
    if (seat) seat = seatOf(seat, this.pack);
    this._set({ phase: 'sending', admitted: this.state.request.name, seat });
    r.packMsg = await seal(r.key, { kind: 'pack', ok: true, pack: this.pack, ...(seat || {}) });
    if (this.stopped) return;
    this.relay?.send('pack', r.rid, r.packMsg);
    this.timer = setTimeout(() => this._close('done', { acked: false }), ACK_WAIT);
    return true;
  }

  async decline() {
    const r = this.requests.get(this.state.request?.rid);
    if (!r || r.state !== 'pending') return;
    r.state = 'declined';
    this._set({ phase: 'waiting', request: null });
    const no = await seal(r.key, { kind: 'pack', ok: false });
    this.relay?.send('pack', r.rid, no);
    this._fail(); // a declined stranger used up one attempt
  }

  cancel() {
    if (this.lingering) return this.stop(); // expired code still answering latecomers – the dialog keeps its text
    this._close('cancelled');
  }

  /** The host's app is closing (page hidden): whoever waits hears "host gone" now, not after HOST_GONE. */
  leave() {
    if (this.lingering) return this.stop();
    this._close('cancelled', null, 'host-gone');
  }

  _close(phase, patch, wire = WIRE_ERROR[phase] || phase) {
    if (CLOSED.includes(this.state.phase)) return;
    // tell whoever is still waiting, so their app doesn't just time out
    for (const r of this.requests.values()) {
      if (r.state === 'pending' || r.state === 'keyed') this.relay?.send('pack', r.rid, errMsg(wire));
    }
    if (phase === 'expired' && this.relay) {
      clearTimeout(this.timer);
      this.lingering = true;
      this.timer = setTimeout(() => this.stop(), this.linger || LINGER);
    } else this.stop();
    this._set({ phase, request: null, ...patch });
  }

  stop() {
    this.stopped = true;
    this.lingering = false;
    clearTimeout(this.timer);
    this.relay?.end();
    this.relay = null;
  }
}

/** Partner side errors carry a code: no-host | offline | bad | expired | used | locked | conflict | declined | timeout | host-gone | unsupported | cancelled. */
function codeError(code) {
  const e = new Error(`invite code: ${code}`);
  e.code = code;
  return e;
}

/**
 * Partner side: joinWithCode(code, { name, onState }) → { promise (→ run pack), cancel() }.
 * onState(phase, info): 'deriving' → 'connecting' → 'searching' → 'waiting' (for the host's "Allow") → 'received';
 * with 'waiting' info = { confirm }: the 4 digits the joining player tells the host – the host types them to allow;
 * with 'received' info = { slot, taken }: the player the host suggests (see suggestSlot) – right before the
 * promise resolves. Older hosts send no hint: then slot is the first player whose name matches, else null.
 * Test-only options: importers, iterations, noHostMs, ttl, hostGoneMs.
 */
export function joinWithCode(code, o = {}) {
  let relay = null;
  let key = null;
  let finished = false;
  const timers = [];
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = (err, pack) => (err ? reject(err) : resolve(pack));
  });
  const finish = async (err, pack, farewell) => {
    if (finished) return;
    finished = true;
    timers.forEach((x) => clearTimeout(x) || clearInterval(x));
    try {
      if (farewell && key && relay) relay.send(farewell, rid, await seal(key, { kind: farewell }));
    } catch {
      // best effort
    }
    relay?.end();
    settle(err, pack);
  };
  const rid = randomId();
  const c = normalizeCode(code);

  (async () => {
    if (!c) throw codeError('bad');
    if (!(await inviteCodeSupported())) throw codeError('unsupported');
    o.onState?.('deriving');
    const { topic, pad } = await deriveCodeKeys(c, o.iterations);
    const me = await ephemeral(pad);
    if (finished) return;
    const req = enc.encode(JSON.stringify({ v: 1, key: b64(me.masked) }));
    let hostMasked = null;
    let hello = null;
    let hostAlive = 0; // last "wait" from the host (newer hosts send one per hello while deciding)
    let up = false;
    o.onState?.('connecting');
    timers.push(setTimeout(() => !up && finish(codeError('offline')), 15000));
    relay = await connectRelay(topic, o.importers, (kind, from, payload) => {
      if (from !== rid || finished) return;
      if (kind === 'res') onRes(payload).catch(() => finish(codeError('bad'), null, 'bye'));
      else if (kind === 'pack') onPack(payload);
    }, () => {
      if (up || finished) return;
      up = true;
      o.onState?.('searching');
      relay?.send('req', rid, req);
      timers.push(setInterval(() => !hostMasked && relay.send('req', rid, req), RESEND));
      timers.push(setTimeout(() => !hostMasked && finish(codeError('no-host')), o.noHostMs || NO_HOST));
    });
    if (finished) return relay.end();

    async function onRes(payload) {
      const m = json(payload);
      if (m?.error) return finish(codeError(String(m.error)));
      const theirs = typeof m?.key === 'string' ? unb64(m.key) : null;
      if (theirs?.length !== 32) return;
      if (hostMasked) {
        // somebody else answers this code too → we can't tell who is real
        if (!same(hostMasked, theirs)) finish(codeError('conflict'), null, 'bye');
        return;
      }
      hostMasked = theirs;
      let confirm;
      ({ key, confirm } = await sessionKey(me.priv, theirs, pad, rid, theirs, me.masked));
      hello = await seal(key, { kind: 'hello', name: String(o.name || '').slice(0, 24) });
      if (finished) return;
      relay.send('hello', rid, hello);
      timers.push(setInterval(() => relay.send('hello', rid, hello), RESEND));
      timers.push(setTimeout(() => finish(codeError('timeout'), null, 'bye'), o.ttl || CODE_TTL));
      // A host that answered "wait" and then stopped (app closed or restarted) won't decide anymore.
      timers.push(setInterval(() => hostAlive && Date.now() - hostAlive > (o.hostGoneMs || HOST_GONE) && finish(codeError('host-gone'), null, 'bye'), 1000));
      o.onState?.('waiting', { confirm });
    }

    async function onPack(payload) {
      const m = json(payload);
      if (m?.error) return finish(codeError(String(m.error)));
      if (!key) return;
      const msg = await open(key, payload).catch(() => null);
      if (msg?.kind === 'wait') {
        hostAlive = Date.now();
        return;
      }
      if (msg?.kind !== 'pack' || finished) return; // forged / foreign – ignore
      if (!msg.ok) return finish(codeError('declined'));
      if (msg.pack?.format !== PACK_FORMAT) return finish(codeError('bad'), null, 'bye');
      // an older host sends no hint – then only a matching name says who this is
      const named = Object.keys(msg.pack.players || {}).find((s) => o.name && String(msg.pack.players[s]?.name || '').trim().toLowerCase() === String(o.name).trim().toLowerCase());
      const seat = 'slot' in msg || 'taken' in msg ? seatOf(msg, msg.pack) : { slot: named || null, taken: [] };
      o.onState?.('received', seat);
      finish(null, msg.pack, 'ack');
    }
  })().catch((e) => finish(e.code ? e : Object.assign(e, { code: 'error' })));

  return { promise, cancel: () => finish(codeError('cancelled'), null, 'bye') };
}
