// Content-Security-Policy for the app's HTML pages, sent as a response header by the static handler.
// Inline <script> blocks are allowed by their SHA-256 hash, computed from the file when it is served,
// so editing an inline script never needs a manual hash update (and nothing else inline can run).
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WEB_DIR } from './paths.mjs';

/** 'sha256-…' sources for every inline <script> (no src attribute) in an HTML document. */
export function inlineScriptHashes(html) {
  // The HTML parser turns CRLF / CR into LF before the browser hashes the script text.
  const text = String(html).replace(/\r\n?/g, '\n');
  const out = [];
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\ssrc\s*=/i.test(` ${m[1]}`)) continue;
    out.push(`'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  }
  return [...new Set(out)];
}

/** Origins of the public MQTT brokers (BROKERS in web/lib/sync.mjs). */
export function brokerOrigins(syncSource) {
  const list = String(syncSource).match(/BROKERS\s*=\s*\[([^\]]*)\]/);
  const urls = list ? [...list[1].matchAll(/['"`](wss:\/\/[^'"`]+)['"`]/g)].map((m) => m[1]) : [];
  return [...new Set(urls.map((u) => { try { return new URL(u).origin.replace(/^https?:/, 'wss:'); } catch { return null; } }).filter(Boolean))];
}

/** Default Nostr relays the vendored Trystero build connects to (a comma list prefixed with wss://). */
export function trysteroRelays(trysteroSource) {
  const m = String(trysteroSource).match(/`([a-z0-9.,:-]+)`\.split\(`,`\)\)\.map\(\(?\w+\)?=>`wss:\/\/`\+\w+\)/i);
  return m ? m[1].split(',').filter(Boolean).map((h) => `wss://${h}`) : [];
}

let relayCache = null;
function syncSources() {
  if (relayCache) return relayCache;
  let brokers = [];
  let relays = [];
  try {
    brokers = brokerOrigins(readFileSync(join(WEB_DIR, 'lib', 'sync.mjs'), 'utf8'));
  } catch {
    // fall through to the generic wss: below
  }
  try {
    relays = trysteroRelays(readFileSync(join(WEB_DIR, 'vendor', 'trystero-nostr.min.js'), 'utf8'));
  } catch {
    // idem
  }
  // If either list can't be read (format changed) allow any wss: host rather than silently breaking sync.
  relayCache = brokers.length && relays.length ? [...brokers, ...relays] : ['wss:'];
  return relayCache;
}

/**
 * The policy for one HTML page.
 *   emulator – the page boots EmulatorJS (player.html, emu-test.html): its cores are compiled to WASM, the
 *              core's JS is injected as a blob: <script>, and the 7z/zip extractors run in blob: workers
 *              that inherit this policy and call eval() (Emscripten's old cwrap) → 'unsafe-eval'.
 *              No outside network at all: that also blocks EmulatorJS' update check and CDN fallback.
 *   otherwise – the app UI / OBS overlay: same-origin scripts only, plus the sync relays.
 */
export function cspFor(html, { connect = syncSources() } = {}) {
  const emulator = /vendor\/emulatorjs\//.test(html);
  const hashes = inlineScriptHashes(html);
  const script = ["'self'", ...hashes, ...(emulator ? ["'wasm-unsafe-eval'", "'unsafe-eval'", 'blob:'] : [])];
  const directives = {
    'default-src': ["'self'"],
    'script-src': script,
    'worker-src': ["'self'", 'blob:'],
    'child-src': ["'self'", 'blob:'],
    'frame-src': ["'self'"],
    'connect-src': ["'self'", 'blob:', 'data:', ...(emulator ? [] : connect)],
    'img-src': ["'self'", 'data:', 'blob:', 'https://raw.githubusercontent.com'],
    'media-src': ["'self'", 'data:', 'blob:'],
    'style-src': ["'self'", "'unsafe-inline'"],
    'font-src': ["'self'", 'data:'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'self'"],
  };
  return Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

const cache = new Map(); // path → { mtimeMs, size, header }
/** Extra response headers for a file the static handler serves: the CSP for .html pages, {} otherwise. */
export function pageHeaders(path) {
  if (!/\.html?$/i.test(path)) return {};
  try {
    const st = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.headers;
    const headers = {
      'Content-Security-Policy': cspFor(readFileSync(path, 'utf8')),
      // Cross-origin isolation: lets the emulator use threads (SharedArrayBuffer) – the multi-threaded DS core
      // keeps fast-forward at full speed. Everything the pages load is same-origin, so nothing else changes.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    };
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, headers });
    return headers;
  } catch {
    return {}; // missing file → serveFile answers 404 anyway
  }
}
