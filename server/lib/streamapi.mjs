// The open stream API on the app's local server: /api/v1 (docs/STREAM_API.md). Read-only JSON of the current run,
// a Server-Sent Events stream of what changes, the sprites the app shows, and the coffee pop-up on legendary
// encounters (shared/coffee.mjs) – which the app's own overlays (web/overlay.html) show as well.
//
// Safe by default: the server only listens on 127.0.0.1 (server/app.mjs), nothing here writes, and the data is the
// same stream-safe subset the overlays get (shared/streamapi.mjs). Without the optional token: OBS (its browser
// sources and local-file sources), scripts and souldew's own pages may read it; pages opened in a browser from disk and
// pages of other local web servers only when the Stream page allows them (`stream.localPages`); other websites never.

import { timingSafeEqual } from 'node:crypto';
import { appOrigins } from './guard.mjs';
import { buildState, eventsBetween, legendaryEncounters, spriteSource, spriteUrls, apiLang, API_VERSION, API_PREFIX, EVENT_TYPES, PLAYER_COLORS } from '../../shared/streamapi.mjs';
import { decideCoffee, recordCoffee, coffeeTexts, coffeeJokeId, COFFEE, COFFEE_CORNERS, DEFAULT_CORNER, COFFEE_URL, COFFEE_SHORT } from '../../shared/coffee.mjs';
import { legendaryKind, legendariesUpTo, LEGENDARY, MYTHICAL } from '../../shared/legendaries.mjs';
import { qrSvg } from '../../shared/qr.mjs';
import { runGen } from '../../shared/overlay.mjs';
import { slotsOf, runMode } from '../../shared/slots.mjs';

/**
 * The stream settings in config.json (`stream`): token ('' = none), coffee pop-up on/off and its corner, and
 * localPages: whether pages opened from disk and pages of other local web servers may read without the token (off
 * unless switched on – installs from before the switch existed get it on once, see streamMigration).
 */
export function streamSettings(config) {
  const s = config?.stream && typeof config.stream === 'object' ? config.stream : {};
  return {
    token: typeof s.token === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(s.token) ? s.token : '',
    coffee: s.coffee !== false,
    corner: COFFEE_CORNERS.includes(s.corner) ? s.corner : DEFAULT_CORNER,
    localPages: s.localPages === true,
  };
}

/**
 * The config patch that brings `stream.localPages` in, or null when it is there. Up to 2.5.0 every page on this
 * computer could read the API without a token, and streamers built layouts on that (a page opened from disk, a local
 * web server): an install that was set up before (onboarded) keeps that, a new one starts with the stricter rule.
 */
export function streamMigration(config) {
  const s = config?.stream && typeof config.stream === 'object' ? config.stream : {};
  if (typeof s.localPages === 'boolean') return null;
  return { stream: { ...s, localPages: !!config?.onboarded } };
}

// The API's errors – for other people's layouts, not shown in souldew's UI: { error, code } with this status.
export const API_ERRORS = {
  tokenRequired: [401, 'This stream API needs its token (?token=… or Authorization: Bearer …)'],
  foreignOrigin: [403, 'Only pages from this computer may read the stream API – or set a token in souldew'],
  localPage: [403, 'Pages opened from disk or served by another local web server need the token – or switch on "Pages on this computer without a token" on souldew’s Stream page'],
  readOnly: [405, 'The stream API is read-only'],
  noSprite: [404, 'No such sprite'],
  noSpecies: [404, 'Unknown species'],
  noPlayer: [404, 'No such player in this run'],
  notFound: [404, 'Unknown endpoint – see /api/v1'],
};
const apiError = (code) => ({ status: API_ERRORS[code][0], error: API_ERRORS[code][1], code });

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/** An Origin that belongs to this computer: none (OBS, curl), `null` (a file opened in a browser), localhost, OBS's local files. */
export const localOrigin = (origin) => origin === undefined || origin === 'null' || origin === 'http://absolute' || LOCAL_ORIGIN.test(String(origin));

/**
 * Who reads without the token no matter what: requests without an Origin (OBS's browser sources, curl, scripts,
 * <img>), OBS's "Local file" sources (OBS serves them from http://absolute/<path>) and souldew's own pages (the
 * port in the request's Host). `null` – a file opened in a browser, but also a sandboxed frame on any website – and
 * other localhost ports are left to the localPages switch.
 */
export function trustedOrigin(origin, hostHeader) {
  if (origin === undefined || origin === 'http://absolute') return true;
  const port = Number(String(hostHeader || '').match(/:(\d{1,5})$/)?.[1] || 80);
  return appOrigins(port).includes(String(origin).toLowerCase());
}

/** The token a request carries: ?token=, `Authorization: Bearer …` or `X-Souldew-Token`. */
export function requestToken(req, url) {
  const q = url?.searchParams?.get('token');
  if (q) return q;
  const auth = String(req.headers?.authorization || '');
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return String(req.headers?.['x-souldew-token'] || '');
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * May this request read the API's data? `public` assets (sprites, the QR code, the legendary list) are open to any
 * page. Data: with a token set, the token is required (from anywhere); without one, OBS, scripts and souldew's own
 * pages (trustedOrigin), plus – with localPages – pages opened from disk and other localhost pages; never websites.
 * → null (fine) or { status, error, code }.
 */
export function v1AccessError(req, url, { token = '', open = false, localPages = false } = {}) {
  if (open) return null;
  const origin = req.headers?.origin;
  if (token) return sameToken(requestToken(req, url), token) ? null : apiError('tokenRequired');
  if (trustedOrigin(origin, req.headers?.host)) return null;
  if (!localOrigin(origin)) return apiError('foreignOrigin');
  return localPages ? null : apiError('localPage');
}

/** CORS headers for an answer: the asking origin (or *), never credentials. */
export function corsHeaders(req) {
  const origin = req.headers?.origin;
  return {
    'Access-Control-Allow-Origin': origin && origin !== 'null' ? origin : '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, X-Souldew-Token, Last-Event-ID, Cache-Control',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

const ENDPOINTS = [
  'GET /api/v1', 'GET /api/v1/runs', 'GET /api/v1/runs/{id|current}', 'GET /api/v1/runs/{id|current}/players', 'GET /api/v1/runs/{id|current}/players/{p1-p4}',
  'GET /api/v1/runs/{id|current}/links', 'GET /api/v1/runs/{id|current}/graveyard', 'GET /api/v1/runs/{id|current}/encounters', 'GET /api/v1/runs/{id|current}/feed',
  'GET /api/v1/runs/{id|current}/events (Server-Sent Events)', 'GET /api/v1/events?run={id|current} (Server-Sent Events)',
  'GET /api/v1/species/{id}', 'GET /api/v1/legendaries', 'GET /api/v1/sprites/{style}/{variant}/{id}.png', 'GET /api/v1/coffee', 'GET /api/v1/coffee/qr.svg',
];

/**
 * The hub. `deps`: readManifest(id), readDoc(id), listRuns(), activeRun() (the run being played), lookups(lang) →
 * { speciesName, itemName, tables, gameName }, loadConfig(), saveConfig(patch), serveSprite(res, src, headers),
 * popupLayer(runId) (is the app's pop-up overlay open in OBS?), onPopup(runId) (push the overlays), docs (URL).
 */
export function createStreamHub(deps) {
  const subs = new Map(); // res → { run, lang, base, follow } – `follow`: opened for `current`, moves along with it
  const last = new Map(); // runId → Map(variant → state)
  const popups = new Map(); // runId → popup
  const sigs = new Map(); // `${runId}|${variant}` → the last state sent, without its time
  let seq = 0;
  const settings = () => streamSettings(deps.loadConfig());

  const ping = setInterval(() => {
    for (const res of subs.keys()) res.write(': ping\n\n');
  }, 20000);
  ping.unref?.();

  const resolveRun = (id) => {
    const runId = id === 'current' || !id ? deps.activeRun() : id;
    const manifest = runId && /^[a-f0-9]{8}$/.test(runId) ? deps.readManifest(runId) : null;
    if (!manifest) throw Object.assign(new Error(id === 'current' ? 'No run yet' : 'Run not found'), { status: 404, code: id === 'current' ? 'noRun' : 'runNotFound' });
    return manifest;
  };
  const stateOf = (manifest, lang, base, now = Date.now()) => {
    const L = deps.lookups(lang);
    return buildState(manifest, deps.readDoc(manifest.id) || {}, { ...L, lang, base, now });
  };
  const variants = (runId) => {
    if (!last.has(runId)) last.set(runId, new Map());
    return last.get(runId);
  };

  /** A popup in `lang` for `base`: the language-neutral core plus names, texts and URLs. */
  const localize = (p, lang, base) => {
    const L = deps.lookups(lang);
    const name = L.speciesName(p.species);
    return { ...p, name, ...coffeeTexts({ species: p.species, name, lang, jokeId: p.jokeId }), qr: `${base}${API_PREFIX}/coffee/qr.svg`, sprites: spriteUrls(p.species, { gen: p.gen, base }) };
  };
  const send = (res, event, data) => res.write(`id: ${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  function makePopup(manifest, { slot = null, species, level = null, test = false, now = Date.now() }) {
    const s = settings();
    const p = {
      id: `coffee:${manifest.id}:${species}:${now}`, type: 'coffee', run: manifest.id, at: now, slot,
      player: slot ? (deps.readDoc(manifest.id)?.[`player:${slot}`]?.v?.name || manifest.players?.[slot]?.name || slot.toUpperCase()) : null,
      species, level, kind: legendaryKind(species), gen: runGen(manifest), jokeId: coffeeJokeId(species, manifest.id), corner: s.corner,
      showMs: COFFEE.showMs, layer: !!deps.popupLayer?.(manifest.id), ...(test ? { test: true } : {}),
    };
    popups.set(manifest.id, p);
    for (const [res, c] of subs) if (c.run === manifest.id) send(res, 'coffee', localize(p, c.lang, c.base));
    deps.onPopup?.(manifest.id, p);
    return p;
  }

  /** Someone watches `runId`: an API client or one of the app's overlays (nobody → no work on every upload). */
  const listening = (runId) => [...subs.values()].some((c) => c.run === runId) || !!deps.overlayListening?.(runId);

  /** The doc of `runId` changed: diff every state someone listens to, send the events, maybe pop the coffee. */
  function docChanged(runId, now = Date.now()) {
    if (!listening(runId)) {
      last.delete(runId);
      return;
    }
    let manifest;
    try {
      manifest = resolveRun(runId);
    } catch {
      return;
    }
    const want = new Set(['en|']); // the plain English state drives the coffee pop-up
    for (const c of subs.values()) if (c.run === runId) want.add(`${c.lang}|${c.base}`);
    const v = variants(runId);
    for (const k of v.keys()) if (!want.has(k)) v.delete(k);
    for (const key of want) {
      const [lang, base] = key.split('|');
      const next = stateOf(manifest, lang, base, now);
      const events = eventsBetween(v.get(key), next);
      v.set(key, next);
      if (key === 'en|') {
        for (const e of legendaryEncounters(events)) {
          for (const [res, c] of subs) {
            if (c.run === runId) send(res, 'legendary', { ...e, type: 'legendary', name: deps.lookups(c.lang).speciesName(e.species), sprites: spriteUrls(e.species, { gen: next.run.gen, base: c.base }) });
          }
          const where = next.players.find((p) => p.slot === e.slot)?.location;
          if (!Number.isFinite(where?.at) || Math.abs(now - where.at) > COFFEE.freshMs) continue; // a late sync, not live tracking
          const cfg = deps.loadConfig();
          const decision = decideCoffee({ enabled: settings().coffee, history: cfg.coffeeHistory, runId, species: e.species, now });
          if (decision.record || decision.show) deps.saveConfig({ coffeeHistory: recordCoffee(cfg.coffeeHistory, runId, e.species, decision, now) });
          if (decision.show) makePopup(manifest, { slot: e.slot, species: e.species, level: e.level, now });
        }
      }
      // a new state only when something in it changed (uploads arrive every 600 ms while playing)
      const sig = JSON.stringify({ ...next, generatedAt: 0 });
      const changed = sigs.get(`${runId}|${key}`) !== sig;
      sigs.set(`${runId}|${key}`, sig);
      if (!events.length && !changed) continue;
      for (const [res, c] of subs) {
        if (c.run !== runId || `${c.lang}|${c.base}` !== key) continue;
        for (const e of events) send(res, e.type, e);
        if (changed) send(res, 'state', next);
      }
    }
  }

  /** Remember the current state of `runId` (before the first change), so the change after it can be diffed. */
  function prime(runId) {
    if (!listening(runId)) return;
    const v = variants(runId);
    if (v.has('en|')) return;
    try {
      v.set('en|', stateOf(resolveRun(runId), 'en', ''));
    } catch {
      // unknown run
    }
  }

  /** The pop-up of `runId` while it is on screen (for the overlays' snapshot), else null. */
  function popupFor(runId, now = Date.now()) {
    const p = popups.get(runId);
    return p && now - p.at < COFFEE.showMs + 3000 ? p : null;
  }

  /** "Preview pop-up": a sample with a legendary of the run's generation, to every overlay and API client. */
  function previewCoffee(runId, now = Date.now()) {
    const manifest = resolveRun(runId);
    const pool = legendariesUpTo(runGen(manifest));
    const species = pool[Math.floor(Math.random() * pool.length)] || 150;
    return makePopup(manifest, { slot: slotsOf(manifest)[0], species, level: 70, test: true, now });
  }

  /** `hello` and the full `state` of `manifest` – when a stream opens, and again when a `current` stream moves on. */
  function greet(res, manifest, lang, base, first = stateOf(manifest, lang, base)) {
    send(res, 'hello', { api: API_VERSION, run: manifest.id, lang, events: EVENT_TYPES });
    send(res, 'state', first);
    const v = variants(manifest.id);
    if (!v.has(`${lang}|${base}`)) {
      v.set(`${lang}|${base}`, first);
      sigs.set(`${manifest.id}|${lang}|${base}`, JSON.stringify({ ...first, generatedAt: 0 }));
    }
  }

  function openStream(req, res, manifest, lang, base, follow = false) {
    const first = stateOf(manifest, lang, base); // throws before the stream opens
    res.writeHead(200, { ...corsHeaders(req), 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    greet(res, manifest, lang, base, first);
    subs.set(res, { run: manifest.id, lang, base, follow });
    prime(manifest.id);
    res.on('close', () => subs.delete(res));
  }

  /** Another run became current (`runId`, null = none): the streams opened for `current` switch to it – a fresh `hello`
   *  and `state` (`hello` with run null when there is no run any more). */
  function follow(runId) {
    let manifest = null;
    try {
      manifest = runId ? resolveRun(runId) : null;
    } catch {
      manifest = null;
    }
    for (const [res, c] of subs) {
      if (!c.follow || c.run === (manifest?.id || null)) continue;
      c.run = manifest?.id || null;
      if (manifest) greet(res, manifest, c.lang, c.base);
      else send(res, 'hello', { api: API_VERSION, run: null, lang: c.lang, events: EVENT_TYPES });
    }
    if (manifest) prime(manifest.id);
  }

  const json = (req, res, status, body, extra = {}) => {
    res.writeHead(status, { ...corsHeaders(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
    return true;
  };
  const fail = (req, res, code, extra = {}) => {
    const e = apiError(code);
    return json(req, res, e.status, { error: e.error, code }, extra);
  };

  /** Answer a request below /api/v1 (true when it was one). */
  async function handle(req, res, path, url) {
    if (path !== API_PREFIX && !path.startsWith(`${API_PREFIX}/`)) return false;
    const sub = path.slice(API_PREFIX.length).replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') {
      // CORS preflight (a custom header such as Authorization) – and Chrome's Private Network Access check
      res.writeHead(204, { ...corsHeaders(req), ...(req.headers['access-control-request-private-network'] ? { 'Access-Control-Allow-Private-Network': 'true' } : {}) });
      res.end();
      return true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return fail(req, res, 'readOnly', { Allow: 'GET, HEAD, OPTIONS' });
    }
    const sprite = sub.match(/^\/sprites\/([a-z0-9]+)\/([a-z-]+)\/(\d{1,4})\.(png|gif)$/);
    const open = !!sprite || sub === '/coffee/qr.svg' || sub === '/legendaries';
    const s = settings();
    const denied = v1AccessError(req, url, { token: s.token, open, localPages: s.localPages });
    if (denied) {
      return json(req, res, denied.status, { error: denied.error, code: denied.code });
    }
    const lang = apiLang(url.searchParams.get('lang'));
    const base = `http://${String(req.headers.host || '127.0.0.1').toLowerCase()}`;
    try {
      if (sprite) {
        const src = spriteSource(sprite[1], sprite[2], Number(sprite[3]));
        if (!src || src.ext !== sprite[4]) return fail(req, res, 'noSprite');
        await deps.serveSprite(res, src, corsHeaders(req));
        return true;
      }
      if (sub === '/coffee/qr.svg') {
        res.writeHead(200, { ...corsHeaders(req), 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : qrSvg(COFFEE_URL));
        return true;
      }
      if (sub === '/legendaries') return json(req, res, 200, { legendary: LEGENDARY, mythical: MYTHICAL });
      if (sub === '/') {
        let current = null;
        try { current = deps.activeRun() || null; } catch { /* no run */ }
        return json(req, res, 200, { api: API_VERSION, name: 'souldew stream API', docs: deps.docs, currentRun: current, auth: { token: !!s.token, localPages: !s.token && s.localPages }, languages: ['en', 'de', 'fr', 'es', 'it'], endpoints: ENDPOINTS, events: EVENT_TYPES });
      }
      if (sub === '/runs') {
        const current = deps.activeRun();
        return json(req, res, 200, deps.listRuns().map((m) => ({
          id: m.id, name: String(m.name || '').slice(0, 80), mode: runMode(m), gen: runGen(m), current: m.id === current,
          players: slotsOf(m).map((slot) => ({ slot, name: String(m.players?.[slot]?.name || slot.toUpperCase()).slice(0, 24), color: PLAYER_COLORS[slot] })),
          createdAt: m.createdAt || null,
        })));
      }
      if (sub === '/events') {
        const want = url.searchParams.get('run') || 'current';
        openStream(req, res, resolveRun(want), lang, base, want === 'current');
        return true;
      }
      if (sub === '/coffee') {
        return json(req, res, 200, { url: COFFEE_URL, short: COFFEE_SHORT, qr: `${base}${API_PREFIX}/coffee/qr.svg`, enabled: s.coffee, corner: s.corner,
          chance: COFFEE.chance, cooldownMinutes: COFFEE.cooldownMs / 60000, showSeconds: COFFEE.showMs / 1000 });
      }
      const sp = sub.match(/^\/species\/(\d{1,4})$/);
      if (sp) {
        const id = Number(sp[1]);
        if (id < 1 || id > 1025) return fail(req, res, 'noSpecies');
        const gen = Number(url.searchParams.get('gen')) || 5;
        return json(req, res, 200, { id, name: deps.lookups(lang).speciesName(id), legendary: legendaryKind(id), sprites: spriteUrls(id, { gen, base, shiny: url.searchParams.get('shiny') === '1' }) });
      }
      const run = sub.match(/^\/runs\/(current|[a-f0-9]{8})(?:\/(players|links|graveyard|encounters|feed|events)(?:\/(p[1-4]))?)?$/);
      if (run) {
        const manifest = resolveRun(run[1]);
        if (run[2] === 'events') {
          openStream(req, res, manifest, lang, base, run[1] === 'current');
          return true;
        }
        const st = stateOf(manifest, lang, base);
        if (!run[2]) return json(req, res, 200, st);
        if (run[3]) {
          if (run[2] !== 'players') return fail(req, res, 'notFound');
          const p = st.players.find((x) => x.slot === run[3]);
          return p ? json(req, res, 200, p) : fail(req, res, 'noPlayer');
        }
        return json(req, res, 200, st[run[2]]);
      }
      return fail(req, res, 'notFound');
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return true;
      }
      return json(req, res, e.status || 500, { error: e.message, code: e.code || 'error' });
    }
  }

  return {
    handle, docChanged, prime, popupFor, previewCoffee, settings, follow,
    clients: (runId) => [...subs.values()].filter((c) => !runId || c.run === runId).length,
    followers: () => [...subs.values()].filter((c) => c.follow).length,
    close: () => {
      clearInterval(ping);
      for (const res of subs.keys()) res.end();
      subs.clear();
    },
  };
}
