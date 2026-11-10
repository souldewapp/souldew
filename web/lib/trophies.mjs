// The trophies on the page: one shared store (the server computes everything – server/lib/trophies.mjs), the
// sync that hands it this computer's slots, seen species and live moments, and the watcher of the open run that
// notices those moments while you play (a Pokémon at 1 HP, a badge won underleveled, a full monotype team …).
import { useState, useEffect } from '/vendor/htm-preact.mjs';
import { api } from './api.mjs';
import { levelCap } from './run.mjs';
import { mySlotIn } from './restart.mjs';

let state = null;
let inflight = null;
const subs = new Set();
const freshSubs = new Set();
const pending = { slots: {}, seen: new Set(), moments: [] };
let timer = 0;
let lastSync = 0;
/** At most one sync this often while a game runs (the run doc changes several times a minute). */
const MIN_GAP = 5000;

const notify = () => subs.forEach((fn) => fn(state));

/** Send what is pending and take the new picture; fresh unlocks go to the toast listeners. */
export function syncTrophies() {
  clearTimeout(timer);
  timer = 0;
  if (inflight) return inflight.then(() => syncTrophies());
  const body = { slots: pending.slots, seen: [...pending.seen], moments: pending.moments };
  pending.slots = {};
  pending.seen = new Set();
  pending.moments = [];
  lastSync = Date.now();
  inflight = api.post('/api/trophies/sync', body).then((res) => {
    state = res;
    notify();
    const fresh = res.fresh || [];
    if (fresh.length || res.backfilled?.length) freshSubs.forEach((fn) => fn({ fresh, backfilled: res.backfilled || [], state: res }));
    return res;
  }).catch(() => {
    // server busy / restarting: hand the moments back for the next try
    Object.assign(pending.slots, body.slots);
    body.seen.forEach((s) => pending.seen.add(s));
    pending.moments.push(...body.moments);
    return state;
  }).finally(() => {
    inflight = null;
  });
  return inflight;
}

/** A sync soon – after the run doc reached the server (it saves 600 ms after a change). */
export function syncSoon(delay = 2500) {
  if (timer) return;
  const wait = Math.max(delay, MIN_GAP - (Date.now() - lastSync));
  timer = setTimeout(syncTrophies, wait);
}

/** Which slot this computer plays in each known run (the server can't tell – it's a choice stored in the page). */
export function rememberSlots(runs) {
  for (const r of runs || []) if (r?.id) pending.slots[r.id] = mySlotIn(r);
}

export function onTrophyUnlock(fn) {
  freshSubs.add(fn);
  return () => freshSubs.delete(fn);
}

/** The current trophies (loads them the first time). */
export function useTrophies() {
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    if (!state) syncTrophies();
    else setS(state);
    return () => subs.delete(setS);
  }, []);
  return s;
}

const BIDOOF = new Set([399, 400]);

/**
 * Watch the open run for live moments of this computer's player. `types(species)`: the run's types (randomized
 * runs have their own). Returns the unsubscribe function.
 */
export function watchRun(doc, manifest, me, types) {
  const said = new Set();
  const moment = (m) => {
    const key = `${m.type}:${m.species || m.n || m.ptype || ''}`;
    if (said.has(key)) return;
    said.add(key);
    pending.moments.push({ ...m, runId: manifest.id, at: Date.now() });
  };
  const liveNow = () => doc.get(`live:${me}`, null);
  const best = (l) => Math.max(Number(l?.badges) || 0, Number(l?.badgesBest) || 0);
  const top = (l) => Math.max(0, ...(l?.party || []).filter((m) => !m.egg).map((m) => m.level || 0));
  const capNow = () => {
    try {
      return levelCap(doc, manifest, me).cap || null;
    } catch {
      return null;
    }
  };
  let prev = liveNow() ? { badges: best(liveNow()), top: top(liveNow()), cap: capNow() } : null;
  let lastFight = null;
  const onLive = () => {
    const l = liveNow();
    if (!l) return;
    const mons = (l.party || []).filter((m) => !m.egg && m.species);
    if (l.source === 'live') {
      for (const m of mons) if (m.hp === 1 && m.maxHp > 1) moment({ type: 'hp1', species: m.species });
      if (mons.length >= 6 && mons.every((m) => BIDOOF.has(m.species))) moment({ type: 'bidoof' });
      if (mons.length >= 6 && types) {
        const shared = mons.map((m) => types(m.species) || []).reduce((a, b) => a.filter((x) => b.includes(x)));
        if (shared.length) moment({ type: 'monotype', ptype: shared[0] });
      }
    }
    const b = best(l);
    // one badge more than the last picture: judged by the team and cap from just before it
    if (prev && b === prev.badges + 1) moment({ type: 'badge', n: b, top: prev.top || null, cap: prev.cap || null });
    prev = { badges: b, top: top(l), cap: capNow() };
  };
  const off = doc.subscribe((keys) => {
    let changed = false;
    for (const k of keys) {
      if (k === `live:${me}`) onLive();
      else if (k === `where:${me}`) {
        const f = doc.get(k, null)?.fight;
        if (f?.species && f.species !== lastFight) {
          lastFight = f.species;
          pending.seen.add(f.species);
        }
      }
      if (k.startsWith('enc:') || k.startsWith('pair:') || k.startsWith('feed:') || k === 'run:status' || k === `live:${me}`) changed = true;
    }
    if (changed || pending.moments.length) syncSoon();
  });
  return off;
}
