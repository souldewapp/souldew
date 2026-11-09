// "Show type matchup help": a run rule the host sets for everyone – default on (older runs too), only the host may
// switch it, every switch is logged, and the play view's battle helper hides the matchups when it's off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// web/lib/run.mjs imports browser paths (/shared/…): map them onto the project folder.
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');

const HG = { id: 'run1', game: { code: 'IPKE', system: 'nds' } };
const PAIR = { ...HG, players: { p1: { name: 'Tim' }, p2: { name: 'Robin' } } };
const SOLO = { ...HG, mode: 'nuzlocke', players: { p1: { name: 'Lou' } } };
function mkDoc(rules) {
  const d = new RunDoc('t');
  d.by = 'a';
  d._persistSoon = () => {};
  if (rules) d.set('rules', rules);
  return d;
}

test('type matchup help: on by default and for older runs without the field', () => {
  assert.equal(R.typeHelpOn(mkDoc(), PAIR), true);
  assert.equal(R.typeHelpOn(mkDoc(), SOLO), true);
  assert.equal(R.typeHelpOn(mkDoc({ typeClause: 'party', dupes: 'both' }), PAIR), true, 'old rules without typeHelp');
  assert.equal(R.typeHelpOn(mkDoc({ typeHelp: false }), PAIR), false);
  assert.equal(R.typeHelpOn(mkDoc({ typeHelp: false }), SOLO), false);
  assert.equal(R.typeHelpOn(mkDoc({ typeHelp: true }), PAIR), true);
  assert.equal(R.typeHelpOn(null, PAIR), true, 'no run document (plain play): help stays');
  // not a rule set of its own: a Classic Nuzlocke without the help is still Classic
  assert.equal(R.presetOf({ ...R.rules(mkDoc(), SOLO), typeHelp: false }), 'classic');
});

test('type matchup help: synced through the shared rules – what the host sets, every player reads', () => {
  const host = mkDoc();
  host.set('rules', { ...(host.get('rules') || {}), typeHelp: false });
  const partner = new RunDoc('t');
  partner.by = 'b';
  partner._persistSoon = () => {};
  partner.merge(host.entries);
  assert.equal(R.typeHelpOn(partner, PAIR), false);
});

test('type matchup help: only the host may switch it', () => {
  assert.equal(R.HOST_SLOT, 'p1');
  assert.equal(R.isHost('p1'), true);
  assert.equal(R.isHost('p2'), false);
  assert.equal(R.isHost(undefined), true, 'solo / no slot yet = the creator');
  assert.deepEqual(R.allowedRulesPatch({ typeHelp: false, dupes: 'off' }, 'p2'), { dupes: 'off' });
  assert.deepEqual(R.allowedRulesPatch({ typeHelp: false }, 'p3'), {});
  assert.deepEqual(R.allowedRulesPatch({ typeHelp: false, dupes: 'off' }, 'p1'), { typeHelp: false, dupes: 'off' });
  assert.deepEqual(R.allowedRulesPatch({ dupes: 'off' }, 'p2'), { dupes: 'off' });
});

test('type matchup help: switching it is logged like the cheats rule', () => {
  const d = mkDoc();
  R.logTypeHelpRule(d, PAIR, 'p1', false);
  R.logTypeHelpRule(d, SOLO, 'p1', true);
  assert.deepEqual(R.feedList(d).map((f) => [f.type, f.slot, f.text]).sort(), [
    ['rule', 'p1', 'Type matchup help turned on for this run'],
    ['rule', 'p1', 'turned the type matchup help off for everyone'],
  ]);
});

test('type matchup help: the battle helper hides the matchups when it is off, the board and wizard offer it', () => {
  const panel = readFileSync(new URL('../web/views/session-info.mjs', import.meta.url), 'utf8');
  assert.match(panel, /const help = !isRun \|\| typeHelpOn\(doc, manifest\)/);
  assert.match(panel, /\$\{help && html`<div class="bt-block">\s*<h4>\$\{t\('battle\.danger'/);
  for (const block of ['myMoves.length > 0', 'chart && html`<${TypeChart}', 'myChart && html`<${TypeChart}']) {
    const at = panel.indexOf(block);
    assert.ok(at > 0, block);
    assert.match(panel.slice(at - 12, at), /help && /, `${block} is behind the help switch`);
  }
  const board = readFileSync(new URL('../web/views/board.mjs', import.meta.url), 'utf8');
  assert.match(board, /allowedRulesPatch\(asked, me\)/);
  assert.match(board, /locked=\$\{!isHost\(me\)\}/);
  const wizard = readFileSync(new URL('../web/views/soullink.mjs', import.meta.url), 'utf8');
  assert.match(wizard, /typeHelp \},/);
});
