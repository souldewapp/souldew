// "Where am I" sign at the top of the play view's left column – like the place-name pop-up of the games:
// the route or town the player is in right now (read live from RAM, shared/live/location.mjs) and, in a run,
// whether that area still has its first encounter (one chip per player in a SoulLink group).
import { html, useEffect, useRef, useState } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { t, currentLang } from '../lib/i18n.mjs';
import { speciesName, gen4data, setRomSpecies, setRomTypes } from '../lib/data.mjs';
import { readLocation, readMusicInfo, locationLabel, sameLocation, canReadLocation, placeName } from '/shared/live/location.mjs';
import { pairState, encounter, players as getPlayers, slotsOf, isNuzlocke, genOfRun, setRomPlaces, areaForPlace } from '../lib/run.mjs';

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

// The running ROM's own data (server/lib/romloc.mjs, computed by the server from the file): its map → location step
// and place names (shared/live/romloc.mjs), and for GBA games its species table (shared/live/romspecies.mjs).
// `pending` while it loads; `data` null = the ROM has no location data (the tables still serve).
const ROMLOC = { src: null, data: null, species: null, wram: null, pending: false };

/** Starts loading the location data of the ROM at `src` (the /api/… URL the emulator loads); resolves when done. */
export function loadRomLocations(src) {
  if (!src || ROMLOC.src === src) return ROMLOC.p || Promise.resolve();
  Object.assign(ROMLOC, { src, data: null, species: null, wram: null, pending: true });
  setRomPlaces(null); // (another game's names don't apply any more)
  setRomSpecies(null);
  setRomTypes(null);
  const p = fetch(`/api/rom/locations?src=${encodeURIComponent(src)}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((j) => {
      if (ROMLOC.src !== src) return;
      Object.assign(ROMLOC, { data: j?.data || null, species: j?.species || null, wram: j?.wram || null, pending: false });
      setRomPlaces(ROMLOC.data); // catches made now are named like the sign names their place
      setRomSpecies(ROMLOC.species); // a ROM hack's own Pokémon get the game's names
      setRomTypes(j?.types || null); // … and the game's types (Fairy hacks)
    });
  ROMLOC.p = p;
  return p;
}

/** The running ROM's species table (romSpecies(): { engine, map, unknown } – GBA only), null while unknown. */
export const romSpeciesNow = () => ROMLOC.species;
/** A Game Boy hack's moved RAM variables (romwram.mjs gbWramShift), null: the retail addresses. */
export const romWramNow = () => ROMLOC.wram;
/** Has the running ROM's own data arrived (or failed)? */
export const romDataReady = () => !ROMLOC.pending;

/**
 * Current location for the live loop: { gen, id, name } or null. `entry` is the addresses.json entry,
 * `read` the emulator's bus read, `state` the live party reader's state (it knows where the save data is).
 * Cheap (a few bytes) – the tables load on the first call. The name: placeName (the game's own for a modified ROM, a
 * ROM in the app's language or a place the tables don't know; else the tables' translation).
 */
export function readHere(entry, read, state = null) {
  if (!MAPS) {
    load();
    return null;
  }
  const rom = ROMLOC.data;
  const r = readLocation(MAPS, entry, read, { rom, state });
  if (!r) return null;
  const lang = currentLang();
  const table = locationLabel(r.gen, r.id, { maps: MAPS, ...LOC, gen4: gen4data() }, lang === 'de' ? 'de' : 'en');
  const name = placeName(r, { rom, table, lang });
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

/**
 * Can this game show where the player is? true, false (no location data for it), or null while that isn't known
 * yet (the tables or the ROM's own location data are still loading). `entry` = the addresses.json entry of the running game.
 */
export function locationSupport(entry) {
  if (!entry) return false;
  if (!MAPS) return null;
  if (canReadLocation(MAPS, entry, ROMLOC.data)) return true;
  return ROMLOC.pending ? null : false;
}

/** Keeps the previous object while the place is the same (so the sign doesn't re-render every read). */
export const nextHere = (prev, next) => (sameLocation(prev, next) && prev?.name === next?.name ? prev : next);

/** The run area this place counts as (same logic as a catch there), or null when it isn't one. */
export function areaOfHere(doc, manifest, gen, here) {
  return areaForPlace(doc, manifest, gen, here);
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
 * `isRun` = show the area status, `game` = the addresses.json entry of the running game.
 */
export function LocationSign({ here, live, isRun, game }) {
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
    // a game without location data would wait forever: say so instead of "appears once you're in the game"
    const text = locationSupport(game) === false ? t('loc.none', 'Location isn’t available for this game yet') : t('loc.unknown', 'Location appears once you’re in the game');
    return html`<section class="loc-sign quiet" aria-live="polite"><${Post} /><span class="loc-wait">${text}</span></section>`;
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
