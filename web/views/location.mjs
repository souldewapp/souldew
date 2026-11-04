// "Where am I" sign at the top of the play view's left column – like the place-name pop-up of the games:
// the route or town the player is in right now (read live from RAM, shared/live/location.mjs) and, in a run,
// whether that area still has its first encounter (one chip per player in a SoulLink group).
import { html, useEffect, useRef, useState } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { t, currentLang } from '../lib/i18n.mjs';
import { speciesName, gen4data } from '../lib/data.mjs';
import { readLocation, readMusicInfo, locationLabel, sameLocation } from '/shared/live/location.mjs';
import { areaForMetLocation } from '/shared/routes.mjs';
import { profileOf, progression, pairState, encounter, players as getPlayers, slotsOf, isNuzlocke, genOfRun } from '../lib/run.mjs';

let MAPS = null; // shared/data/maps.json once loaded
let LOC = null; // { loc2, loc3 } for the names
const load = () => {
  const j = (f) => fetch(`/shared/data/${f}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  load.p ||= Promise.all([j('maps.json'), j('locations_gen2_crystal.json'), j('locations_gen3.json')]).then(([maps, loc2, loc3]) => {
    MAPS = maps;
    LOC = { loc2, loc3 };
  });
  return load.p;
};

/**
 * Current location for the live loop: { gen, id, name } or null. `entry` is the addresses.json entry,
 * `read` the emulator's bus read. Cheap (a few bytes) – the tables load on the first call.
 */
export function readHere(entry, read) {
  if (!MAPS) {
    load();
    return null;
  }
  const r = readLocation(MAPS, entry, read);
  if (!r) return null;
  const name = locationLabel(r.gen, r.id, { maps: MAPS, ...LOC, gen4: gen4data() }, currentLang() === 'de' ? 'de' : 'en');
  return name ? { gen: r.gen, id: r.id, name } : null;
}

/** What the music is right now (readMusicInfo, for a MusicKeyTracker), or null – cheap, read every few frames. */
export function musicInfo(entry, read) {
  if (!MAPS) {
    load();
    return null;
  }
  return readMusicInfo(MAPS, entry, read);
}

/** Keeps the previous object while the place is the same (so the sign doesn't re-render every read). */
export const nextHere = (prev, next) => (sameLocation(prev, next) && prev?.name === next?.name ? prev : next);

/** The run area this place counts as (same logic as a catch there), or null when it isn't one. */
export function areaOfHere(doc, manifest, gen, here) {
  if (!doc || !manifest || !here || here.gen !== gen) return null;
  if (profileOf(manifest).curated) return areaForMetLocation(here.id);
  const name = here.name.toLowerCase();
  const list = progression(doc, manifest).filter((x) => x.kind === 'area' && !x.special);
  const hit = list.find((x) => (x.met || []).includes(here.id) && x.key.startsWith(`m${gen}-`)) || list.find((x) => String(x.name || '').toLowerCase() === name);
  return hit?.key || `m${gen}-${here.id}`;
}

function chipFor(st, enc) {
  if (st === 'dead' && enc?.species) return { cls: 'dead', text: t('loc.dead', 'Dead: {species}', { species: enc.nickname || speciesName(enc.species) }) };
  if (st === 'dead') return { cls: 'used', text: t('loc.used', 'Area used up') };
  if (enc?.outcome === 'caught') return { cls: 'caught', text: t('loc.caught', 'Caught: {species}', { species: enc.nickname || speciesName(enc.species) }) };
  // a missed encounter uses the area up for the whole group
  if (enc?.outcome === 'missed' || st === 'failed') return { cls: 'used', text: t('loc.used', 'Area used up') };
  return { cls: 'open', text: t('loc.open', 'First encounter open') };
}

function Status({ area }) {
  const { doc, manifest } = useApp();
  if (!area || !doc || !manifest) return null;
  const slots = slotsOf(manifest);
  const st = pairState(doc, area, manifest);
  if (isNuzlocke(manifest) || slots.length < 2) {
    const c = chipFor(st.state, st.encs[slots[0]]);
    return html`<div class="loc-status"><span class=${`loc-chip ${c.cls}`}>${c.text}</span></div>`;
  }
  const names = getPlayers(doc, manifest);
  return html`<ul class="loc-status group">${slots.map((s) => {
    const c = chipFor(st.state, st.encs[s]);
    return html`<li key=${s} style=${`--acc:var(--${s})`}><b class="loc-who" title=${names[s]?.name}>${names[s]?.name}</b><span class=${`loc-chip ${c.cls}`}>${c.text}</span></li>`;
  })}</ul>`;
}

const Post = () => html`<svg class="loc-post" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" shape-rendering="crispEdges">
  <path fill="currentColor" d="M7 9h2v7H7z" /><path fill="currentColor" d="M2 2h10l3 3-3 3H2z" opacity=".95" /><path fill="var(--shell-2)" d="M4 4h6v2H4z" />
</svg>`;

/**
 * The sign. `here` = readHere() result (null: nothing known yet), `live` = the live read is running,
 * `isRun` = show the area status.
 */
export function LocationSign({ here, live, isRun }) {
  const { doc, manifest, runData, me } = useApp();
  const [, force] = useState(0);
  const prev = useRef(null);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (!MAPS) load().then(() => force((n) => n + 1));
  }, []);
  useEffect(() => {
    // a new place → the sign slides in again (not on the first read of the session)
    if (here && prev.current && !sameLocation(prev.current, here)) setFlash((n) => n + 1);
    if (here) prev.current = here;
  }, [here?.gen, here?.id]);
  if (!here) {
    if (!live) return null;
    return html`<section class="loc-sign quiet" aria-live="polite"><${Post} /><span class="loc-wait">${t('loc.unknown', 'Location appears once you’re in the game')}</span></section>`;
  }
  const area = isRun ? areaOfHere(doc, manifest, genOfRun(manifest, runData), here) : null;
  const mine = area && doc && me ? chipFor(pairState(doc, area, manifest).state, encounter(doc, area, me)).cls : null;
  return html`<section class="loc-sign" aria-live="polite" aria-label=${t('loc.label', 'You are here: {place}', { place: here.name })}>
    <div class="loc-plate" key=${flash} data-state=${mine || 'none'}>
      <i class="loc-shine" aria-hidden="true"></i>
      <span class="loc-k"><${Post} />${t('loc.here', 'You are here')}</span>
      <b class="loc-name" title=${here.name}>${here.name}</b>
    </div>
    ${isRun && html`<${Status} area=${area} />`}
  </section>`;
}
