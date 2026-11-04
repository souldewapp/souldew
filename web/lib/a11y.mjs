// Keyboard behaviour for the app's button-based radio groups and tab lists. Every option stays a plain
// <button> (Tab reaches each one, Enter/Space pick it); the arrow keys additionally move through the group and
// pick the next option, the way a native radio group or tab strip works.

const STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** Index of the option an arrow / Home / End key moves to (wraps around), or -1 for any other key. */
export function rovingIndex(key, index, count) {
  if (count < 1) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (!(key in STEP)) return -1;
  return (index + STEP[key] + count) % count;
}

/** Document keydown handler: arrow keys inside a [role=radiogroup] / [role=tablist] focus and pick the next option. */
export function groupArrowKeys(e) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  const item = e.target?.closest?.('[role=radio], [role=tab]');
  const group = item?.closest('[role=radiogroup], [role=tablist]');
  if (!group) return;
  const role = item.getAttribute('role');
  const items = [...group.querySelectorAll(`[role=${role}]`)]
    .filter((el) => el.closest('[role=radiogroup], [role=tablist]') === group && !el.disabled && el.offsetParent);
  const next = items[rovingIndex(e.key, items.indexOf(item), items.length)];
  if (!next) return;
  e.preventDefault();
  next.focus();
  if (next !== item) next.click();
}
