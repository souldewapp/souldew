// Release notes in the update dialog: hard-wrapped CHANGELOG bullets become one list item each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unwrapNotes, inlineNotes, parseNotes } from '../shared/notes.mjs';
import { changelogSection } from '../scripts/release.mjs';

const WRAPPED = `- **Nintendo 3DS games play inside souldew**: X/Y run
  in the play view like every other game – both screens,
  controller and \`savestates\`.
- **Trophies**: Kalos counts.

### Fixes
- One
  two`;

test('continuation lines join the bullet they belong to', () => {
  assert.equal(unwrapNotes(WRAPPED), [
    '- **Nintendo 3DS games play inside souldew**: X/Y run in the play view like every other game – both screens, controller and `savestates`.',
    '- **Trophies**: Kalos counts.',
    '',
    '### Fixes',
    '- One two',
  ].join('\n'));
});

test('blocks: list, heading, list; paragraphs stay paragraphs', () => {
  const b = parseNotes(WRAPPED);
  assert.deepEqual(b.map((x) => x.type), ['list', 'heading', 'list']);
  assert.equal(b[0].items.length, 2);
  assert.equal(b[1].text, 'Fixes');
  assert.deepEqual(parseNotes('Fixes\nand more\n\nSecond'), [{ type: 'para', text: 'Fixes and more' }, { type: 'para', text: 'Second' }]);
  assert.deepEqual(parseNotes(''), []);
  assert.deepEqual(parseNotes(null), []);
});

test('bold and code pieces; markup characters never become HTML', () => {
  assert.deepEqual(inlineNotes('a **b** `c` <img>'), [
    { type: 'text', text: 'a ' }, { type: 'bold', text: 'b' }, { type: 'text', text: ' ' }, { type: 'code', text: 'c' }, { type: 'text', text: ' <img>' },
  ]);
  assert.deepEqual(inlineNotes('no ** closing'), [{ type: 'text', text: 'no ** closing' }]);
});

test('the real 2.5.0 section unwraps to one line per bullet', () => {
  const sec = changelogSection(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), '2.5.0');
  const lines = unwrapNotes(sec).split('\n').filter(Boolean);
  assert.ok(lines.length > 3);
  for (const l of lines) assert.match(l, /^(- |#)/, l.slice(0, 60));
  assert.ok(!/\n {2}/.test(unwrapNotes(sec)));
});
