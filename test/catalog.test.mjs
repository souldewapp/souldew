import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../shared/data/catalog.json', import.meta.url), 'utf8'));

test('catalog: ROM hacks are listed for recognition but carry no links to them', () => {
  assert.ok(catalog.hacks.length > 0, 'the hacks stay in the catalog');
  for (const h of catalog.hacks) {
    assert.ok(h.id && h.name && h.baseGameId, `${h.id} keeps what the library needs to recognise it`);
    assert.equal(h.url, undefined, `${h.id} has no url`);
    assert.equal(h.links, undefined, `${h.id} has no links`);
    assert.ok(!(h.uncertainFields || []).includes('url'), `${h.id} has no url in uncertainFields`);
    assert.doesNotMatch(JSON.stringify(h), /https?:\/\//, `${h.id} mentions no web address`);
  }
});

test('library view: no outbound link for a ROM hack', () => {
  const src = readFileSync(new URL('../web/views/library.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /openExternal/);
  assert.doesNotMatch(src, /\bh\.url\b|\bh\.links\b/);
});
