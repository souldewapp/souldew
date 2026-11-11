// Held items of a ROM hack on an expanded engine (Run & Bun): its item numbers aren't the retail ones, so no retail
// item name may show for them – not in the play view, not on the board, not in the stream API (audit 2.3.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { buildState } from '../shared/streamapi.mjs';

const ROOT = new URL('../', import.meta.url);

test('expanded-engine held items reach the run document marked, and the stream API names none of them', async () => {
  registerHooks({ resolve: (spec, ctx, next) => (spec.startsWith('/shared/') ? next(new URL(spec.slice(1), ROOT).href, ctx) : next(spec, ctx)) });
  const R = await import('../web/lib/run.mjs');
  const { RunDoc } = await import('../web/lib/doc.mjs');
  const doc = new RunDoc('t');
  doc.by = 'a';
  doc._persistSoon = () => {};
  const manifest = { id: 'aaaa0001', mode: 'nuzlocke', players: { p1: { name: 'A' } }, game: { system: 'gba', code: 'BPEE', hackId: 'run-and-bun' } };
  const own = { key: 'g3-1', species: 390, nickname: 'CHIMCHAR', level: 5, hp: 20, maxHp: 20, item: 13, itemOwn: true, metLocation: null };
  const retail = { key: 'g3-2', species: 263, nickname: 'ZIGZAGOON', level: 3, hp: 12, maxHp: 12, item: 13, metLocation: null };
  R.applySnapshot(doc, manifest, 3, 'p1', { source: 'live', party: [own, retail], here: { gen: 3, id: 0, name: 'Littleroot Town' } });
  const party = doc.get('live:p1').party;
  assert.equal(party[0].itemOwn, true, 'the mark survives into the run document');
  assert.equal(party[1].itemOwn, undefined);
  const raw = {};
  for (const k of ['live:p1']) raw[k] = { v: doc.get(k), t: 1, by: 'a' };
  const s = buildState(manifest, raw, { itemName: () => 'Potion' });
  const mons = JSON.stringify(s);
  assert.match(mons, /"item":\{"id":13,"name":null\}/, 'the own-numbered item: no retail name');
  assert.match(mons, /"item":\{"id":13,"name":"Potion"\}/, 'a retail-numbered one keeps its name');
});
