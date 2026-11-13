// "Share to Discord" (Live runs): the local server's side of the bot's contract (docs/DEVELOPMENT.md › "Live runs").
//
// The player links souldew to their Discord account once with a code from `/live connect`; the bot answers with a
// token for that player. The token is the only credential there is – souldew ships no key, secret or password of
// its own, only the bot's public address below. It is kept in its own file in the data folder (live-runs.json, next
// to config.json – never in a run folder, a run pack, the config the page reads, diagnostics or a log line), and only
// this module reads it: the page asks the local server, the local server asks the bot. A request to the bot never
// follows a redirect, so the token can't be carried to another host.
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { DATA_DIR, DEV, APP_ROOT } from './paths.mjs';
import { writeFileAtomic, httpError } from './fsutil.mjs';
import { buildMeta, metaProblem, normalizeCode, pngProblem } from '../../shared/liveruns.mjs';

/** The bot's public address (the contract's base URL). SOULDEW_LIVE_URL replaces it – for tests against a mock bot. */
export const LIVE_RUNS_URL = 'https://souldew-discord-bot.sweeparena.workers.dev';

/** The address in use: the variable when it is a valid https URL (or http on this computer, for tests), else the bot's. */
export function liveBase(env = process.env) {
  const v = env.SOULDEW_LIVE_URL;
  if (v) {
    try {
      const u = new URL(v);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return u.origin + u.pathname.replace(/\/+$/, '');
    } catch {
      // not a URL – the default
    }
  }
  return LIVE_RUNS_URL;
}

/** Where the token lives: the data folder (in development the ignored runs/ folder, like config.json). */
export const liveRunsFile = () => join(DEV ? join(APP_ROOT, 'runs') : DATA_DIR, 'live-runs.json');

let appVersion = null;
export function souldewVersion() {
  if (!appVersion) {
    try {
      appVersion = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
    } catch {
      appVersion = '0.0.0';
    }
  }
  return appVersion;
}

const TOKEN = /^[a-f0-9]{64}$/i;
const SHARED_KEEP = 400; // shared event ids remembered (the newest)

function readState() {
  try {
    const s = JSON.parse(readFileSync(liveRunsFile(), 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

function writeState(s) {
  const file = liveRunsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(s, null, 2));
  try {
    chmodSync(file, 0o600); // only this user (no effect on Windows, where the profile folder is private anyway)
  } catch {
    // a file system without modes
  }
}

const tokenOf = (s) => (typeof s.token === 'string' && TOKEN.test(s.token) ? s.token : null);
const cleanUser = (u) => ({ id: String(u?.id ?? '').slice(0, 32), name: String(u?.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) });

/** What the page may know: linked or not, the Discord name, the shared events. Never the token. */
export function publicState(s = readState()) {
  const linked = !!tokenOf(s);
  return { linked, user: linked && s.user ? cleanUser(s.user) : null, shared: s.shared && typeof s.shared === 'object' ? s.shared : {}, app: souldewVersion() };
}

function remember(eventId, entry) {
  const s = readState();
  const shared = { ...(s.shared || {}), [eventId]: entry };
  const keep = Object.entries(shared).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0)).slice(0, SHARED_KEEP);
  writeState({ ...s, shared: Object.fromEntries(keep) });
}

function forget() {
  const s = readState();
  delete s.token;
  delete s.user;
  writeState(s);
}

/** One request to the bot. Network trouble → { status: 0 }. The body is parsed JSON or {}. */
async function botFetch(path, { method = 'GET', token, json, form, timeout = 20000, fetchImpl = fetch } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetchImpl(`${liveBase()}${path}`, {
      method, headers, redirect: 'error', signal: AbortSignal.timeout(timeout),
      body: json ? JSON.stringify(json) : form || undefined,
    });
  } catch {
    return { status: 0, body: {} };
  }
  let body = {};
  try {
    body = await r.json();
  } catch {
    // an error page, not JSON
  }
  return { status: r.status, body: body && typeof body === 'object' ? body : {} };
}

const retryAfter = (body) => (Number.isFinite(body?.retryAfter) && body.retryAfter > 0 ? Math.ceil(body.retryAfter) : 60);

/**
 * What a bot answer means for the page: { ok: true } or { ok: false, error, … } with error one of
 * 'offline' (no answer), 'code' (bad link code), 'token' (connect again – the stored token is dropped; also what a
 * device gets after the same Discord account linked a sixth one), 'blocked', 'not-member', 'duplicate' (this event is
 * already posted – by this player or a partner, the id is the same for the whole run), 'rate' (+ retryAfter seconds),
 * 'invalid' (+ field, + reason: 'word' = the server's word filter refused a text), 'unavailable' (Discord or the bot
 * is down for a moment – try again later), 'server' (anything else).
 */
export function outcome(status, body = {}) {
  if (status === 0) return { ok: false, error: 'offline' };
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 401) return { ok: false, error: 'token' };
  if (status === 403) return { ok: false, error: body.error === 'blocked' ? 'blocked' : 'not-member' };
  if (status === 409) return { ok: false, error: 'duplicate' };
  if (status === 429) return { ok: false, error: 'rate', retryAfter: retryAfter(body) };
  if (status === 400 && body.error === 'code') return { ok: false, error: 'code' };
  if ([400, 413, 415, 422].includes(status)) {
    const field = typeof body.field === 'string' ? body.field.replace(/[^a-z]/gi, '').slice(0, 20) : body.error === 'image' ? 'image' : null;
    const reason = typeof body.reason === 'string' ? body.reason.replace(/[^a-z]/gi, '').slice(0, 20) : null;
    return { ok: false, error: 'invalid', field: field || null, reason };
  }
  if (status === 502 || status === 503) return { ok: false, error: 'unavailable' };
  return { ok: false, error: 'server' };
}

/** POST /live/link with the code from `/live connect`: stores the token, returns the public state (or an error). */
export async function link(code, opts = {}) {
  const c = normalizeCode(code);
  if (!c) return { ok: false, error: 'code' };
  const { status, body } = await botFetch('/live/link', { method: 'POST', json: { code: c, app: `souldew ${souldewVersion()}`, platform: process.platform }, ...opts });
  const o = outcome(status, body);
  if (!o.ok) return o;
  if (typeof body.token !== 'string' || !TOKEN.test(body.token)) return { ok: false, error: 'server' };
  writeState({ ...readState(), token: body.token, user: cleanUser(body.user), linkedAt: Date.now() });
  return { ok: true, ...publicState() };
}

/** DELETE /live/link, then forget the token here – also when the bot can't be reached (the token stays valid there). */
export async function unlink(opts = {}) {
  const token = tokenOf(readState());
  let reached = true;
  if (token) reached = (await botFetch('/live/link', { method: 'DELETE', token, ...opts })).status !== 0;
  forget();
  return { ok: true, reached, ...publicState() };
}

/** GET /live/me: the Discord name and today's posts. A revoked token is dropped (→ "Connect again"). */
export async function status(opts = {}) {
  const s = readState();
  const token = tokenOf(s);
  if (!token) return { ...publicState(s), limits: null };
  const { status: st, body } = await botFetch('/live/me', { token, timeout: 10000, ...opts });
  if (st === 401) {
    forget();
    return { ...publicState(), limits: null, expired: true };
  }
  if (st !== 200) return { ...publicState(s), limits: null, offline: st === 0 };
  const l = body.limits || {};
  const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
  if (body.user?.name && body.user.name !== s.user?.name) writeState({ ...s, user: cleanUser(body.user) });
  const perDay = n(l.perDay);
  const used = n(l.usedToday);
  return {
    ...publicState(),
    limits: { perDay, usedToday: used, left: perDay != null && used != null ? Math.max(0, perDay - used) : null, nextInSec: n(l.nextInSec) ?? 0 },
  };
}

/**
 * POST /live/post: the page's card (PNG bytes) and meta, checked again here – the meta is rebuilt with the
 * contract's limits and filters and gets this app's version. A 409 counts as shared (someone in the run posted it).
 */
export async function post({ meta: input, image }, opts = {}) {
  const token = tokenOf(readState());
  if (!token) return { ok: false, error: 'token' };
  const png = Buffer.isBuffer(image) ? image : typeof image === 'string' ? Buffer.from(image, 'base64') : null;
  const bad = pngProblem(png);
  if (bad) throw httpError(400, 'Ungültiges Kartenbild', 'liveCard', { what: bad });
  const { meta } = buildMeta({ ...(input && typeof input === 'object' ? input : {}), app: souldewVersion() });
  const field = metaProblem(meta);
  if (field) throw httpError(400, 'Ungültige Angaben', 'liveMeta', { field });
  const form = new FormData();
  form.append('meta', JSON.stringify(meta));
  form.append('image', new Blob([png], { type: 'image/png' }), 'card.png');
  const { status: st, body } = await botFetch('/live/post', { method: 'POST', token, form, timeout: 30000, ...opts });
  const o = outcome(st, body);
  if (o.ok) {
    const url = typeof body.url === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)?discord\.com\/channels\//i.test(body.url) ? body.url : null;
    remember(meta.eventId, { at: Date.now(), url });
    return { ok: true, eventId: meta.eventId, url };
  }
  if (o.error === 'duplicate') {
    remember(meta.eventId, { at: Date.now(), url: null, duplicate: true });
    return { ...o, eventId: meta.eventId };
  }
  if (o.error === 'token') forget();
  return { ...o, eventId: meta.eventId };
}
