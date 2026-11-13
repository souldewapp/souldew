// souldew is open source: no key, token, secret or password may be in the repository or the built app. The only
// thing the app knows about the Discord bot is its public address (one constant in server/lib/liveruns.mjs); each
// player's token comes from linking and lives only in their own data folder. This scans every file that goes into
// the app (package.json "files") and the scripts and tests for anything that looks like a credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const rel = (p) => relative(ROOT, p).split(sep).join('/');

// what ships (package.json build.files) plus scripts and tests; binary assets and third-party code aside
const DIRS = ['electron', 'server', 'shared', 'web', 'scripts', 'test'];
const SKIP_DIRS = new Set(['vendor', 'assets', 'node_modules', 'emulatorjs']);
const TEXT = /\.(mjs|cjs|js|json|html|css|md|txt|lua|sh)$/;

function files() {
  const out = [join(ROOT, 'package.json')];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(p);
      } else if (TEXT.test(name) && st.size < 8 * 1024 * 1024) out.push(p);
    }
  };
  for (const d of DIRS) walk(join(ROOT, d));
  return out;
}

const PATTERNS = [
  ['Discord bot token', /\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,40}\b/],
  ['Discord webhook with its secret', /discord(?:app)?\.com\/api\/webhooks\/\d{15,}\/[A-Za-z0-9_-]{40,}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['bearer token in code', /Bearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ['named secret with a value', /\b(?:client[_-]?secret|bot[_-]?token|api[_-]?key|app[_-]?secret|hmac[_-]?key|signing[_-]?key|password)\b\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack / AWS / Google key', /\b(?:xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/],
];
// a bare 64-hex string is what a Live runs token looks like (and a SHA-256): nothing that ships may hold one but these
// (the tests compare against known hashes and make their tokens at run time)
const HEX64 = /\b[a-f0-9]{64}\b/i;
const HEX_OK = new Set(['server/lib/toolchain.mjs']); // the pinned SHA-256 of a download (a checksum, public)

test('no credentials anywhere in the app, the scripts or the tests', () => {
  const hits = [];
  for (const f of files()) {
    const text = readFileSync(f, 'utf8');
    for (const [name, re] of PATTERNS) if (re.test(text)) hits.push(`${rel(f)}: ${name}`);
    if (HEX64.test(text) && !HEX_OK.has(rel(f)) && !rel(f).startsWith('test/') && !rel(f).endsWith('.json')) hits.push(`${rel(f)}: 64-hex string`);
  }
  assert.deepEqual(hits, []);
});

test('Live runs: the bot’s address is one public constant, the app has no secret of its own', () => {
  const holders = files().filter((f) => readFileSync(f, 'utf8').includes(['souldew-discord-bot', 'sweeparena'].join('.')));
  assert.deepEqual(holders.map(rel), ['server/lib/liveruns.mjs']);
  for (const f of ['server/lib/liveruns.mjs', 'shared/liveruns.mjs', 'web/lib/liveshare.mjs', 'web/lib/livecard.mjs', 'web/views/liveshare.mjs']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    // no signing of requests with a key baked into the app – the per-player token and the bot's limits are the security
    assert.ok(!/createHmac|createSign|subtle\.sign|X-Signature|x-app-key/i.test(src), f);
  }
});

test('the scan finds what it looks for (samples made at run time, so this file holds none)', () => {
  const r = (n, chars = 'abcdef0123456789') => Array.from({ length: n }, (_, i) => chars[(i * 7) % chars.length]).join('');
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const samples = [
    `M${r(25, A)}.${r(6, A)}.${r(30, A)}`,
    `https://discord.com/api/webhooks/${'1'.repeat(18)}/${r(60, A)}`,
    `-----BEGIN ${'PRIVATE'} KEY-----`,
    `Authorization: ${'Bearer'} ${r(64)}`,
    `client_secret = '${r(20, A)}'`,
  ];
  for (const s of samples) assert.ok(PATTERNS.some(([, re]) => re.test(s)), s.slice(0, 20));
  assert.ok(HEX64.test(r(64)));
});
