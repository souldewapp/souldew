// Watches the emulator's battery save and emits parsed snapshots (debounced, retrying on
// half-written files). Polling (fs.watchFile) is used on purpose: emulators rewrite saves in
// place or via temp-file swaps, which native fs.watch reports inconsistently across platforms.
import { watchFile, unwatchFile, statSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseHgssSave } from '../../shared/gen4save.mjs';

export class SaveWatcher {
  constructor(data, emit) {
    this.data = data;
    this.emit = emit;
    this.watches = new Map(); // runId → { path, timer, lastHash, last }
  }

  status(runId) {
    const w = this.watches.get(runId);
    if (!w) return { watching: false };
    return { watching: true, path: w.path, exists: existsSync(w.path), lastHash: w.lastHash, lastAt: w.lastAt, error: w.error || null };
  }

  last(runId) {
    return this.watches.get(runId)?.last || null;
  }

  watch(runId, path) {
    this.unwatch(runId);
    const w = { path, timer: null, lastHash: null, lastAt: null, last: null, error: null, retries: 0 };
    this.watches.set(runId, w);
    const onChange = () => {
      clearTimeout(w.timer);
      w.retries = 0; // a new write gets its own mid-write retries
      // melonDS rewrites the file ~2–3 s after the game stops writing; wait for it to settle.
      w.timer = setTimeout(() => this.read(runId), 1500);
    };
    w.listener = onChange;
    watchFile(path, { interval: 1000 }, onChange);
    if (existsSync(path)) this.read(runId);
    return this.status(runId);
  }

  unwatch(runId) {
    const w = this.watches.get(runId);
    if (!w) return;
    clearTimeout(w.timer);
    unwatchFile(w.path, w.listener);
    this.watches.delete(runId);
  }

  read(runId, force = false) {
    const w = this.watches.get(runId);
    if (!w || !existsSync(w.path)) return null;
    let buf;
    try {
      buf = readFileSync(w.path);
    } catch (e) {
      w.error = e.message;
      return null;
    }
    const hash = createHash('sha1').update(buf).digest('hex');
    if (!force && hash === w.lastHash) return w.last;
    try {
      const parsed = parseHgssSave(new Uint8Array(buf), this.data);
      w.lastHash = hash;
      w.lastAt = new Date(statSync(w.path).mtimeMs).toISOString();
      w.error = null;
      w.retries = 0;
      w.last = { runId, at: w.lastAt, hash, save: parsed };
      this.emit('save', w.last);
      return w.last;
    } catch (e) {
      // Possibly caught mid-write → retry a few times before reporting.
      if (w.retries++ < 3) {
        w.timer = setTimeout(() => this.read(runId), 1500);
      } else {
        w.error = e.message;
        this.emit('save-error', { runId, error: e.message });
      }
      return null;
    }
  }
}
