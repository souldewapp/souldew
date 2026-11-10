// The joke license window: when it may show up, that it never blocks and never asks for money, and that the server
// keeps its state tidy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NAG, nagState, countLaunch, shouldNag } from '../web/lib/nag.mjs';

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 10, 12);

test('nag: never in the first four launches, then a chance per launch', () => {
  assert.equal(NAG.FROM_LAUNCH, 5);
  for (let n = 0; n < NAG.FROM_LAUNCH; n++) assert.equal(shouldNag({ launches: n, now: NOW, rand: () => 0 }), false, `launch ${n}`);
  assert.equal(shouldNag({ launches: 5, now: NOW, rand: () => 0 }), true);
  assert.equal(shouldNag({ launches: 5, now: NOW, rand: () => NAG.CHANCE - 0.001 }), true);
  assert.equal(shouldNag({ launches: 5, now: NOW, rand: () => NAG.CHANCE }), false);
  assert.equal(shouldNag({ launches: 500, now: NOW, rand: () => 0.99 }), false);
  // roughly CHANCE of the launches
  let hits = 0;
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 10000; i++) hits += shouldNag({ launches: 9, now: NOW, rand }) ? 1 : 0;
  assert.ok(Math.abs(hits / 10000 - NAG.CHANCE) < 0.02, String(hits));
});

test('nag: at most once every few days, off when switched off, a clock gone backwards counts as just shown', () => {
  const always = () => 0;
  assert.equal(shouldNag({ launches: 9, lastShown: NOW - (NAG.MIN_DAYS * DAY - 1), now: NOW, rand: always }), false);
  assert.equal(shouldNag({ launches: 9, lastShown: NOW - NAG.MIN_DAYS * DAY, now: NOW, rand: always }), true);
  assert.equal(shouldNag({ launches: 9, lastShown: NOW + DAY, now: NOW, rand: always }), false);
  assert.equal(shouldNag({ launches: 9, off: true, now: NOW, rand: always }), false);
});

test('nag: launch counting survives junk in the config', () => {
  assert.deepEqual(nagState(null), { launches: 0, lastShown: null });
  assert.deepEqual(nagState({ launches: -3, lastShown: 'x' }), { launches: 0, lastShown: null });
  assert.deepEqual(nagState({ launches: 2.5, lastShown: NaN }), { launches: 0, lastShown: null });
  assert.deepEqual(nagState({ launches: 4, lastShown: NOW }), { launches: 4, lastShown: NOW });
  assert.deepEqual(countLaunch(undefined), { launches: 1, lastShown: null });
  assert.deepEqual(countLaunch({ launches: 4, lastShown: NOW }), { launches: 5, lastShown: NOW });
});

test('nag window: always closable, never claims payment is required, own artwork only', () => {
  const src = readFileSync(new URL('../web/views/nag.mjs', import.meta.url), 'utf8');
  assert.match(src, /onCancel=\$\{\(e\) => \{ e\.preventDefault\(\); close\(\); \}\}/, 'Esc closes');
  assert.match(src, /e\.target === e\.currentTarget && close\(\)/, 'the backdrop closes');
  assert.match(src, /class="nag-x" onClick=\$\{close\}/, 'the title bar × closes');
  assert.match(src, /LINKS\.coffee/);
  assert.doesNotMatch(src, /winrar|rarlab/i);
  for (const lang of ['en', 'de', 'es', 'fr', 'it']) {
    const j = JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
    const keys = Object.keys(j).filter((k) => k.startsWith('nag.') || k === 'set.nag' || k === 'set.nagHint');
    assert.equal(keys.length, 17, `${lang}: all nag texts`);
    for (const k of keys) assert.doesNotMatch(j[k], /winrar/i, `${lang} ${k}`);
    assert.match(j['nag.free'], /souldew/);
  }
  const app = readFileSync(new URL('../web/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /sessionStorage\.getItem\('sl-nag-counted'\)/, 'a reload is no new launch');
  assert.match(app, /!!status\.config\?\.onboarded && !sessionRef\.current && !document\.querySelector\('dialog\[open\]'\)/, 'never over onboarding, a game or a dialog');
});

test('nag: the server keeps only a clean state and the off switch', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sls-nag-'));
  process.env.SLS_DATA_DIR = dir;
  const { startServer } = await import('../server/app.mjs');
  const { url, server } = await startServer({ port: 0, background: false });
  try {
    const H = { 'x-soullink': '1', 'content-type': 'application/json' };
    const post = (body) => fetch(`${url}/api/config`, { method: 'POST', headers: H, body: JSON.stringify(body) }).then((r) => r.json());
    let c = await post({ nag: { launches: 6, lastShown: NOW, extra: 'x' }, nagOff: 'yes' });
    assert.deepEqual(c.nag, { launches: 6, lastShown: NOW });
    assert.equal(c.nagOff, false);
    c = await post({ nag: 'junk' });
    assert.deepEqual(c.nag, { launches: 6, lastShown: NOW }, 'junk is ignored');
    c = await post({ nag: { launches: -1 }, nagOff: true });
    assert.deepEqual(c.nag, { launches: 0, lastShown: null });
    const s = await fetch(`${url}/api/status`, { headers: H }).then((r) => r.json());
    assert.equal(s.config.nagOff, true);
    assert.deepEqual(s.config.nag, { launches: 0, lastShown: null });
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
