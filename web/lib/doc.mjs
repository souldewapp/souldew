// Shared run document: a last-writer-wins map (a tiny state-based CRDT).
// Every key holds { v, t, by }: value, logical timestamp, device id. Merging keeps the entry
// with the larger (t, by) pair, so both players converge no matter the order messages arrive
// in, duplicates (P2P + relay) are harmless, and offline edits merge cleanly later.

import { api } from './api.mjs';

/** Waits before retrying a failed server save (then it waits for the next change). */
const SAVE_RETRY_MS = [2000, 5000, 15000, 30000];

const DEVICE_KEY = 'sl-device-id';

export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return 'dev-' + Math.random().toString(36).slice(2, 8);
  }
}

const newer = (a, b) => !b || a.t > b.t || (a.t === b.t && a.by > b.by);
/** Keys that would reach Object.prototype through plain-object access. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Remote timestamps are clamped to now + 1 day (the server's merge of uploads, mergeDocEntries in
 *  server/lib/build.mjs, uses the same bounds). */
const MAX_SKEW = 86400000;

export class RunDoc {
  constructor(runId) {
    this.runId = runId;
    this.entries = {};
    this.clock = 0;
    this.by = deviceId();
    this.listeners = new Set();
    this.localListeners = new Set(); // called with entries changed locally (to broadcast)
    this.saveTimer = null;
  }

  tick() {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }

  get(key, fallback = undefined) {
    const e = this.entries[key];
    return e && e.v !== null ? e.v : fallback;
  }

  /** All live entries whose key starts with prefix → { suffix: value }. */
  scan(prefix) {
    const out = {};
    for (const [k, e] of Object.entries(this.entries)) {
      if (k.startsWith(prefix) && e.v !== null) out[k.slice(prefix.length)] = e.v;
    }
    return out;
  }

  set(key, value) {
    const entry = { v: value === undefined ? null : value, t: this.tick(), by: this.by };
    this.entries[key] = entry;
    this._changed([key], { [key]: entry });
  }

  /** Several writes as one change notification / one network message. */
  batch(writes) {
    const changed = {};
    for (const [key, value] of Object.entries(writes)) {
      const entry = { v: value === undefined ? null : value, t: this.tick(), by: this.by };
      this.entries[key] = entry;
      changed[key] = entry;
    }
    const keys = Object.keys(changed);
    if (keys.length) this._changed(keys, changed);
  }

  del(key) {
    this.set(key, null);
  }

  /** info (optional, from the link): { live: sent right after the change, offset: our clock minus the sender's }
   *  – handed to subscribers as their third argument. */
  merge(remote, info = null) {
    const changed = [];
    const maxT = Date.now() + MAX_SKEW;
    for (const [k, raw] of Object.entries(remote || {})) {
      // Entries come from the partner (untrusted): no prototype keys, sane shape, no timestamps far in the
      // future (one would win every later edit of that key forever).
      if (UNSAFE_KEYS.has(k) || !raw || typeof raw !== 'object' || typeof raw.t !== 'number' || !Number.isFinite(raw.t)) continue;
      const e = { v: raw.v === undefined ? null : raw.v, t: Math.min(raw.t, maxT), by: typeof raw.by === 'string' ? raw.by.slice(0, 64) : '' };
      if (newer(e, Object.hasOwn(this.entries, k) ? this.entries[k] : undefined)) {
        this.entries[k] = e;
        changed.push(k);
      }
      if (e.t > this.clock) this.clock = e.t;
    }
    if (changed.length) this._changed(changed, null, true, info);
    return changed;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onLocalChange(fn) {
    this.localListeners.add(fn);
    return () => this.localListeners.delete(fn);
  }

  _changed(keys, localEntries, remote = false, info = null) {
    if (localEntries) for (const fn of this.localListeners) fn(localEntries);
    for (const fn of this.listeners) fn(keys, remote, info);
    this._persistSoon();
  }

  _persistSoon() {
    try {
      localStorage.setItem(`sl-doc-${this.runId}`, JSON.stringify(this.entries));
    } catch {
      // quota / private mode — server copy still works
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this._saveToServer(), 600);
  }

  /**
   * Write the doc to the server. A failed write (server busy, app restarting) is tried again a few times, more
   * slowly each time – a newer change restarts that anyway. The localStorage copy keeps it safe meanwhile.
   */
  _saveToServer(attempt = 0) {
    return api.put(`/api/runs/${this.runId}/doc`, this.entries).catch(() => {
      if (attempt >= SAVE_RETRY_MS.length) return;
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this._saveToServer(attempt + 1), SAVE_RETRY_MS[attempt]);
    });
  }

  async load() {
    let local = null;
    try {
      local = JSON.parse(localStorage.getItem(`sl-doc-${this.runId}`) || 'null');
    } catch {
      local = null;
    }
    const server = await api.get(`/api/runs/${this.runId}/doc`).catch(() => null);
    // Merge both: whichever copy is newer per key wins.
    this.merge(server || {});
    this.merge(local || {});
    return this;
  }
}
