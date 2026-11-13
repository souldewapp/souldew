// Release notes as written in CHANGELOG.md: "- " bullets whose text is hard-wrapped onto indented
// continuation lines, **bold** and `code`. The update dialog shows them as a list, and the update
// feed carries them unwrapped so that older apps (which print the text as it is) don't break lines mid-sentence.

const BULLET = /^\s*[-*]\s+/;
const HEADING = /^\s*#{1,6}\s+/;

/**
 * Joins hard-wrapped lines: a line that is neither blank, a bullet nor a heading continues the line before it.
 * @param {string} text
 * @returns {string}
 */
export function unwrapNotes(text) {
  const out = [];
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const prev = out.length ? out[out.length - 1] : '';
    const continues = line.trim() && prev.trim() && !BULLET.test(line) && !HEADING.test(line) && !HEADING.test(prev);
    if (continues) out[out.length - 1] = `${prev} ${line.trim()}`;
    else out.push(BULLET.test(line) || HEADING.test(line) ? line.trim() : line.trim() ? line.trim() : '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Splits a line into plain text, **bold** and `code` pieces.
 * @param {string} s
 * @returns {{ type: 'text' | 'bold' | 'code', text: string }[]}
 */
export function inlineNotes(s) {
  const parts = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let at = 0;
  for (let m; (m = re.exec(s));) {
    if (m.index > at) parts.push({ type: 'text', text: s.slice(at, m.index) });
    parts.push(m[1] != null ? { type: 'bold', text: m[1] } : { type: 'code', text: m[2] });
    at = m.index + m[0].length;
  }
  if (at < s.length) parts.push({ type: 'text', text: s.slice(at) });
  return parts;
}

/**
 * Blocks for display: headings, bullet lists and paragraphs (unwrapped first).
 * @param {string} text
 * @returns {({ type: 'heading' | 'para', text: string } | { type: 'list', items: string[] })[]}
 */
export function parseNotes(text) {
  const blocks = [];
  for (const line of unwrapNotes(text).split('\n')) {
    if (!line.trim()) continue;
    if (HEADING.test(line)) blocks.push({ type: 'heading', text: line.replace(HEADING, '') });
    else if (BULLET.test(line)) {
      const last = blocks[blocks.length - 1];
      const item = line.replace(BULLET, '');
      if (last?.type === 'list') last.items.push(item);
      else blocks.push({ type: 'list', items: [item] });
    } else blocks.push({ type: 'para', text: line });
  }
  return blocks;
}
