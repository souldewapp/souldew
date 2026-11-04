// Content-Security-Policy of the HTML pages (server/lib/csp.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inlineScriptHashes, brokerOrigins, trysteroRelays, cspFor } from '../server/lib/csp.mjs';

const sha = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const directive = (policy, name) => policy.split('; ').find((d) => d.startsWith(`${name} `))?.split(' ').slice(1) || null;

test('inline scripts are hashed exactly as the browser sees them, external ones are skipped', () => {
  const html = '<script src="/app.mjs"></script>\r\n<script type="module">\r\nconsole.log(1)\r\n</script><SCRIPT>x()</SCRIPT >';
  assert.deepEqual(inlineScriptHashes(html), [sha('\nconsole.log(1)\n'), sha('x()')]);
});

test('broker origins and Trystero relays are read from the sources', () => {
  assert.deepEqual(brokerOrigins("export const BROKERS = ['wss://a.example:8084/mqtt', 'wss://b.example/mqtt'];"), ['wss://a.example:8084', 'wss://b.example']);
  assert.deepEqual(trysteroRelays('Ar=(/* @__PURE__ */ `nos.lol,r.example:8443`.split(`,`)).map(e=>`wss://`+e);'), ['wss://nos.lol', 'wss://r.example:8443']);
  // the real vendored files still have the expected shape (otherwise the policy falls back to any wss:)
  assert.ok(brokerOrigins(readFileSync(new URL('../web/lib/sync.mjs', import.meta.url), 'utf8')).length >= 1);
  assert.ok(trysteroRelays(readFileSync(new URL('../web/vendor/trystero-nostr.min.js', import.meta.url), 'utf8')).length >= 5);
});

test('app pages: same-origin scripts only, sync relays allowed', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const p = cspFor(html, { connect: ['wss://relay.example'] });
  assert.deepEqual(directive(p, 'script-src'), ["'self'"]);
  assert.ok(directive(p, 'connect-src').includes('wss://relay.example'));
  assert.deepEqual(directive(p, 'object-src'), ["'none'"]);
  assert.ok(!p.includes("'unsafe-eval'"));
});

test('emulator page: inline script hash, wasm + blob cores, no outside network', () => {
  const html = readFileSync(new URL('../web/player.html', import.meta.url), 'utf8');
  const p = cspFor(html, { connect: ['wss://relay.example'] });
  const script = directive(p, 'script-src');
  for (const s of inlineScriptHashes(html)) assert.ok(script.includes(s));
  assert.ok(script.includes("'wasm-unsafe-eval'") && script.includes('blob:'));
  assert.ok(!script.includes("'unsafe-inline'"));
  assert.deepEqual(directive(p, 'connect-src'), ["'self'", 'blob:', 'data:']);
});
