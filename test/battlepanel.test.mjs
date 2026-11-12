// The play view's battle helper: where the player puts it (left or right of the game, folded in – #10) and which
// generation it judges by (the running game's, from its memory table entry: a DS game is Gen 4 or 5, a 3DS game 6 or
// 7 – the system alone made every 3DS battle a Gen 4 one: no Fairy attacks, Steel resisting Ghost, Tackle at 35).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moveInfo, effectiveness } from '../shared/typechart.mjs';

const src = (f) => readFileSync(new URL(`../web/views/${f}`, import.meta.url), 'utf8');
const MOVES = JSON.parse(readFileSync(new URL('../shared/data/moves.json', import.meta.url), 'utf8'));

test('battle helper left or right of the game and folded in, remembered per profile (#10)', () => {
  const panel = src('session-info.mjs');
  // remembered in this profile, left and unfolded by default, anything else read as the default
  assert.match(panel, /const PANEL_KEY = 'sl-battle-panel';/);
  assert.match(panel, /const PANEL_DEFAULT = \{ side: 'left', collapsed: false \};/);
  assert.match(panel, /side: v\?\.side === 'right' \? 'right' : 'left', collapsed: v\?\.collapsed === true/);
  assert.match(panel, /localStorage\.setItem\(PANEL_KEY, JSON\.stringify\(next\)\)/);
  // two buttons on the panel: move it to the other side, fold it in / out
  assert.match(panel, /onClick=\$\{\(\) => onPrefs\(\{ side: other \}\)\}/);
  assert.match(panel, /aria-expanded=\$\{!collapsed\} onClick=\$\{\(\) => onPrefs\(\{ collapsed: !collapsed \}\)\}/);
  // the play view hands the choice over and places the panel by it
  const play = src('play.mjs');
  assert.match(play, /const \[panelPrefs, setPanelPrefs\] = useBattlePanelPrefs\(\);/);
  assert.match(play, /const panelSide = panelPrefs\.side === 'right' \? 'right' : 'left';/);
  assert.match(play, /side=\$\{panelSide\} collapsed=\$\{panelPrefs\.collapsed\} onPrefs=\$\{setPanelPrefs\}/);
});

test('the battle helper, team and savestates judge by the running game\'s generation, not the system\'s', () => {
  const play = src('play.mjs');
  assert.match(play, /if \(Number\.isInteger\(entry\.gen\)\) setLiveGen\(/);
  assert.match(play, /const gameGen = liveGen \|\| GEN\[target\.system\] \|\| null;/);
  assert.equal(play.split('gen=${GEN[target.system]}').length - 1, 0, 'no component gets the system\'s generation');
  for (const c of ['BattlePanel', 'StatePanel', 'LinkedPairs', 'PartyGrid']) assert.match(play, new RegExp(`<\\$\\{${c}\\}[^>]*gen=\\$\\{gameGen\\}`), c);
  // what it changes: a Gen 7 battle (Sun's Rowlet against a Fairy or Steel type) …
  assert.equal(moveInfo(MOVES, 33, 7).power, 40); // Tackle
  assert.equal(moveInfo(MOVES, 33, 4).power, 35);
  assert.equal(effectiveness('ghost', ['steel'], 7), 1);
  assert.equal(effectiveness('ghost', ['steel'], 4), 0.5);
  // … and Black/White's moves by Gen 5 (Tackle 50), not Gen 4
  assert.equal(moveInfo(MOVES, 33, 5).power, 50);
});
