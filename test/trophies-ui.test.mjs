// Trophies on the page: every achievement of the rules has its name and description in every language, and the
// medal renderer draws every medal / tier without gaps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/vendor/htm-preact.mjs') return next(ROOT + 'node_modules/htm/preact/standalone.module.js', ctx);
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { ACHIEVEMENTS, CATEGORIES, TIERS } = await import('../shared/trophies.mjs');
const { achIds, achText } = await import('../web/lib/trophytexts.mjs');
const { medalPixels } = await import('../web/lib/medals.mjs');
const i18n = (lang) => JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));

test('every achievement has a name and a description – and no text is left without a rule', () => {
  assert.deepEqual([...achIds()].sort(), ACHIEVEMENTS.map((a) => a.id).sort());
  for (const a of ACHIEVEMENTS) {
    const { name, desc } = achText(a.id, a.target || 1);
    assert.ok(name && desc && !desc.includes('{n}'), a.id);
  }
});

test('trophy texts are translated in every language, placeholders and plurals kept', () => {
  const en = i18n('en');
  const keys = Object.keys(en).filter((k) => /^(ach|trophy|dex|medal)\./.test(k) || k === 'nav.trophies');
  assert.ok(keys.length >= 2 * ACHIEVEMENTS.length);
  for (const lang of ['de', 'fr', 'es', 'it']) {
    const tr = i18n(lang);
    for (const k of keys) {
      assert.ok(typeof tr[k] === 'string' && tr[k].length > 0, `${lang}: ${k}`);
      for (const ph of en[k].match(/\{\w+\}/g) || []) assert.ok(tr[k].includes(ph), `${lang}: ${k} keeps ${ph}`);
      assert.equal(tr[k].includes('|'), en[k].includes('|'), `${lang}: ${k} plural forms`);
    }
  }
  // German: our medals are "Orden", gym badges in the texts "Arenaorden" – never the English word
  assert.equal(i18n('de')['trophy.tabMedals'], 'Orden');
  assert.match(i18n('de')['ach.firstBadge.d'], /Arenaorden/);
});

test('medals: every kind and tier is drawn, locked ones in the same shape', () => {
  for (const kind of [...CATEGORIES, 'dex', 'champion']) {
    const locked = medalPixels(kind, 'locked', 1);
    assert.ok(locked.length >= 4, kind);
    for (const tier of TIERS) {
      const px = medalPixels(kind, tier, 3);
      assert.ok(px.length >= 5, `${kind} ${tier}`);
      assert.ok(px.every(([c, d]) => /^#[0-9a-f]{6}$/i.test(c) && /^M\d/.test(d)));
    }
  }
});

test('medals: each regional dex medal has its own numeral, Kanto I to Alola VII', () => {
  const look = (gen) => JSON.stringify(medalPixels('dex', 'gold', gen));
  const all = [1, 2, 3, 4, 5, 6, 7].map(look);
  assert.equal(new Set(all).size, 7, 'no two generations share a medal');
});

test('watchRun: live moments of my player – 1 HP, a badge won underleveled, Bidoof team, species met – go out with the next sync', async () => {
  const sent = [];
  globalThis.fetch = async (url, o) => {
    sent.push({ url, body: JSON.parse(o.body) });
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ fresh: ['oneHp'], backfilled: [], achievements: [{ id: 'oneHp', ok: true }] }) };
  };
  const { RunDoc } = await import('../web/lib/doc.mjs');
  const T = await import('../web/lib/trophies.mjs');
  const doc = new RunDoc('t');
  doc._persistSoon = () => {};
  const manifest = { id: 'abcd1234', mode: 'nuzlocke', players: { p1: { name: 'Lou' } }, game: { id: 'pokemon-crystal', system: 'gbc' } };
  doc.set('live:p1', { source: 'live', badges: 0, party: [{ species: 155, level: 7, hp: 20, maxHp: 22 }] });
  const unlocked = [];
  const offToast = T.onTrophyUnlock((x) => unlocked.push(...x.fresh));
  const off = T.watchRun(doc, manifest, 'p1', () => ['normal']);
  // Falkner's ace is level 9 in Crystal: a level-7 team that wins the badge is underleveled
  doc.set('live:p1', { source: 'live', badges: 1, party: [{ species: 155, level: 7, hp: 1, maxHp: 22 }] });
  doc.set('where:p1', { gen: 2, id: 1, fight: { kind: 'wild', species: 163, level: 3 } });
  doc.set('live:p1', { source: 'live', badges: 1, party: Array.from({ length: 6 }, () => ({ species: 399, level: 8, hp: 20, maxHp: 20 })) });
  doc.set('live:p1', { source: 'save', badges: 1, party: [{ species: 155, level: 7, hp: 1, maxHp: 22 }] }); // a save file: no live moment
  await T.syncTrophies();
  off();
  offToast();
  const body = sent.at(-1).body;
  assert.equal(sent.at(-1).url, '/api/trophies/sync');
  const types = body.moments.map((m) => m.type).sort();
  assert.deepEqual(types, ['badge', 'hp1', 'monotype']);
  const badge = body.moments.find((m) => m.type === 'badge');
  assert.deepEqual([badge.n, badge.top, badge.cap, badge.runId], [1, 7, 9, 'abcd1234']);
  assert.deepEqual(body.seen, [163]);
  assert.deepEqual(unlocked, ['oneHp'], 'fresh unlocks reach the toast listeners');
});
