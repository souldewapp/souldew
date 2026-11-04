// Streamer mode: souldew on a stream. It covers what nobody watching should see – invite codes, the run's keys
// and webhook, file paths, the randomizer's spoilers – and shows a small LIVE mark (styles.css html.streamer).
// One switch on the Stream page, kept per computer (every window follows it).
import { useEffect, useState } from '/vendor/htm-preact.mjs';

const KEY = 'sl-streamer';
const subs = new Set();
const read = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};
let on = read();
const apply = () => document.documentElement.classList.toggle('streamer', on);
apply();

export const isStreamer = () => on;

export function setStreamer(value) {
  on = !!value;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // private mode – it holds for this window
  }
  apply();
  for (const fn of subs) fn(on);
}

// another window of the app switched it
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  on = read();
  apply();
  for (const fn of subs) fn(on);
});

/** The current state, re-rendering when it changes. */
export function useStreamer() {
  const [value, set] = useState(on);
  useEffect(() => {
    subs.add(set);
    set(on);
    return () => subs.delete(set);
  }, []);
  return value;
}
