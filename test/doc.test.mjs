import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunDoc } from '../web/lib/doc.mjs';

const mk = (by) => { const d = new RunDoc('test'); d.by = by; d._persistSoon = () => {}; return d; };

test('LWW map converges regardless of merge order and duplicates', () => {
  const a = mk('a');
  const b = mk('b');
  a.set('enc:route-29:p1', { species: 16 });
  b.set('enc:route-29:p2', { species: 161 });
  b.set('pair:route-29', { state: 'dead' });
  a.set('rules', { typeClause: 'off' });
  b.set('rules', { typeClause: 'party' }); // later write wins
  const snapA = structuredClone(a.entries);
  const snapB = structuredClone(b.entries);
  a.merge(snapB); a.merge(snapB);
  b.merge(snapA);
  assert.deepEqual(a.entries, b.entries);
  assert.equal(a.get('rules').typeClause, 'party');
  assert.equal(a.get('pair:route-29').state, 'dead');
});

test('deletes are tombstones that win over older values', () => {
  const a = mk('a');
  const b = mk('b');
  a.set('enc:x:p1', { species: 1 });
  b.merge(structuredClone(a.entries));
  b.del('enc:x:p1');
  a.merge(structuredClone(b.entries));
  assert.equal(a.get('enc:x:p1'), undefined);
  assert.deepEqual(a.scan('enc:'), {});
});

test('a failed server save is retried with growing pauses until it succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 3) throw new Error('server restarting');
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true }) };
  };
  const flush = () => new Promise((r) => setImmediate(r));
  try {
    const d = new RunDoc('retry');
    d.by = 'a';
    d.set('enc:x:p1', { species: 1 });
    t.mock.timers.tick(600); // debounce → first try
    await flush();
    assert.equal(calls, 1);
    t.mock.timers.tick(1999);
    await flush();
    assert.equal(calls, 1); // not before the first pause is over
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls, 2);
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(calls, 3); // succeeded – no more tries
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = saved;
  }
});
