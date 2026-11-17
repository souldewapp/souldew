// Pokémon Locator: where each Pokémon can be found in one of your own Gen 3 games (Ruby, Sapphire, FireRed, Emerald and
// hacks that keep their encounter tables' layout) – and which Pokémon an area has. Everything comes from the ROM itself
// (shared/live/romwild.mjs, served by /api/rom/wild), so a hack's changed encounters and own Pokémon show as they are.
// A game whose tables can't be read with confidence is left out of the list instead of showing made-up places.
import { html, useState, useEffect, useMemo } from '/vendor/htm-preact.mjs';
import { useApp, Sprite } from '../lib/ui.mjs';
import { t } from '../lib/i18n.mjs';
import { speciesName, gameById, gameTitle } from '../lib/data.mjs';
import { IS_TOUCH } from '../lib/platform.mjs';
import { METHODS, methodSlots, methodRate, mergeSlots, wildMons, whereIs, areaGroups, areaLabel } from '/shared/finder.mjs';

const METHOD_LABEL = () => ({
  land: t('finder.land', 'Grass / walking'),
  surf: t('finder.surf', 'Surfing'),
  rock: t('finder.rock', 'Rock Smash'),
  old: t('finder.old', 'Old Rod'),
  good: t('finder.good', 'Good Rod'),
  super: t('finder.super', 'Super Rod'),
});

const cache = new Map(); // rom id → wild table | null (unreadable) – a ROM doesn't change while the app runs

/** The wild table of a library ROM: undefined while loading, null when it can't be read. */
function useWild(romId) {
  const [state, setState] = useState(() => (cache.has(romId) ? cache.get(romId) : undefined));
  useEffect(() => {
    if (!romId) return undefined;
    if (cache.has(romId)) {
      setState(cache.get(romId));
      return undefined;
    }
    let off = false;
    setState(undefined);
    const src = `/api/library/rom?id=${encodeURIComponent(romId)}`;
    fetch(`/api/rom/wild?src=${encodeURIComponent(src)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((j) => {
      const w = j?.wild?.areas?.length ? j.wild : null;
      cache.set(romId, w);
      if (!off) setState(w);
    });
    return () => { off = true; };
  }, [romId]);
  return state;
}

/** How a Pokémon of the table is named: the app's name for its Dex number, else the game's own name (a hack's Pokémon). */
const nameOf = (wild, x) => (x.s ? speciesName(x.s) : titleCase(wild.names?.[x.i] || '') || `#${x.i}`);
const titleCase = (s) => s.toLowerCase().replace(/(^|[ -])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase());
const levels = (min, max) => (min === max ? `${min}` : `${min}–${max}`);
const pctText = (p) => `${p}%`;

/** An area table's heading: "Route 102", with the map number and "table 2 of 9" where a name stands for several. */
function mapLabel(a, several) {
  return [areaLabel(a), several && a.name ? `(${a.group}.${a.num})` : '', a.variants ? t('finder.variant', 'table {n} of {total}', { n: a.variant, total: a.variants }) : ''].filter(Boolean).join(' ');
}

function SpeciesSearch({ wild, picked, onPick }) {
  const [q, setQ] = useState('');
  const mons = useMemo(() => [...wildMons(wild).entries()].map(([key, x]) => ({ key, ...x, name: nameOf(wild, x) })).sort((a, b) => a.name.localeCompare(b.name)), [wild]);
  const s = q.trim().toLowerCase();
  const hits = s ? mons.filter((m) => m.name.toLowerCase().includes(s) || (m.s && String(m.s) === s)).slice(0, 24) : [];
  return html`<div class="stack-s">
    <input type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autoFocus=${!IS_TOUCH} value=${q} style="width:100%"
      placeholder=${t('finder.search', 'Search a Pokémon (name or number)')} aria-label=${t('finder.search', 'Search a Pokémon (name or number)')}
      onInput=${(e) => setQ(e.target.value)} />
    ${s && html`<div class="finder-picks" role="listbox" aria-label=${t('finder.matches', 'Matching Pokémon')}>
      ${hits.map((m) => html`<button type="button" role="option" aria-selected=${picked === m.key} class=${`finder-pick ${picked === m.key ? 'on' : ''}`} onClick=${() => onPick(m.key)}>
        <${Sprite} id=${m.s} size=${32} /><span>${m.name}</span></button>`)}
      ${!hits.length && html`<p class="muted small">${t('finder.noMon', 'None of the wild Pokémon in this game has that name.')}</p>`}
    </div>`}
  </div>`;
}

function WhereList({ wild, keyOf }) {
  const rows = useMemo(() => whereIs(wild, keyOf), [wild, keyOf]);
  const mon = wildMons(wild).get(keyOf);
  const label = METHOD_LABEL();
  const several = (a) => wild.areas.filter((x) => areaLabel(x) === areaLabel(a)).length > 1;
  return html`<div class="stack-s">
    <h3 class="finder-h"><${Sprite} id=${mon?.s} size=${40} />${mon ? nameOf(wild, mon) : ''}</h3>
    ${rows.length === 0 ? html`<p class="muted">${t('finder.nowhere', 'Not in the wild here – it has to be bred, traded, gifted or found another way.')}</p>` : html`
      <div class="finder-table" role="table" aria-label=${t('finder.where', 'Where to find it')}>
        <div class="finder-row head" role="row"><span role="columnheader">${t('finder.area', 'Area')}</span><span role="columnheader">${t('finder.method', 'Method')}</span>
          <span role="columnheader">${t('finder.level', 'Level')}</span><span role="columnheader">${t('finder.chance', 'Chance')}</span>
          <span role="columnheader" title=${t('finder.rateHint', 'The encounter rate in the game’s data: the higher, the more steps with an encounter.')}>${t('finder.rate', 'Rate')}</span></div>
        ${rows.map((r) => html`<div class="finder-row" role="row">
          <span role="cell" class="finder-area">${mapLabel(r.area, several(r.area))}</span><span role="cell">${label[r.method]}</span>
          <span role="cell">${levels(r.min, r.max)}</span><span role="cell">${pctText(r.pct)}</span><span role="cell" class="faint">${r.rate ?? '–'}</span></div>`)}
      </div>`}
  </div>`;
}

function AreaPicker({ wild }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const groups = useMemo(() => areaGroups(wild, q), [wild, q]);
  const group = groups.find((g) => g.name === sel);
  const label = METHOD_LABEL();
  return html`<div class="finder-areas">
    <div class="stack-s">
      <input type="search" inputmode="search" enterkeyhint="search" autocomplete="off" value=${q} style="width:100%"
        placeholder=${t('finder.areaSearch', 'Search an area')} aria-label=${t('finder.areaSearch', 'Search an area')} onInput=${(e) => setQ(e.target.value)} />
      <div class="finder-list" role="listbox" aria-label=${t('finder.areas', 'Areas')}>
        ${groups.map((g) => html`<button type="button" role="option" aria-selected=${sel === g.name} class=${`finder-pick ${sel === g.name ? 'on' : ''}`} onClick=${() => setSel(g.name)}>
          <span class="grow">${g.name}</span><span class="faint tiny">${g.areas.length > 1 ? g.areas.length : ''}</span></button>`)}
        ${!groups.length && html`<p class="muted small">${t('finder.noArea', 'No area has that name.')}</p>`}
      </div>
    </div>
    <div class="stack">
      ${!group && html`<p class="muted">${t('finder.pickArea', 'Pick an area to see its Pokémon.')}</p>`}
      ${group && group.areas.map((a) => {
        const ms = methodSlots(a);
        return html`<section class="finder-area-card">
          <h3 class="finder-h">${mapLabel(a, group.areas.length > 1)}</h3>
          ${METHODS.filter((m) => ms[m]).map((m) => html`<div class="finder-method">
            <div class="finder-mh"><b>${label[m]}</b><span class="faint tiny" title=${t('finder.rateHint', 'The encounter rate in the game’s data: the higher, the more steps with an encounter.')}>${t('finder.rateN', 'rate {n}', { n: methodRate(a, m) ?? '–' })}</span></div>
            <ul class="finder-mons">${mergeSlots(ms[m]).map((x) => html`<li><${Sprite} id=${x.s} size=${28} /><span class="grow">${nameOf(wild, x)}</span>
              <span class="finder-lv">${t('finder.lv', 'Lv. {lv}', { lv: levels(x.min, x.max) })}</span><span class="finder-pct">${pctText(x.pct)}</span></li>`)}</ul>
          </div>`)}
        </section>`;
      })}
    </div>
  </div>`;
}

export function FinderView() {
  const { library } = useApp();
  const roms = useMemo(() => (library?.roms || []).filter((r) => r.system === 'gba'), [library]);
  const [romId, setRomId] = useState(() => roms[0]?.id || '');
  const [mode, setMode] = useState('mon');
  const [picked, setPicked] = useState(null);
  useEffect(() => { if (!roms.some((r) => r.id === romId)) setRomId(roms[0]?.id || ''); }, [roms]);
  const wild = useWild(romId);
  useEffect(() => setPicked(null), [romId]);
  const rom = roms.find((r) => r.id === romId);
  const titleOf = (r) => r.customHack || (r.gameId && gameById(r.gameId) ? gameTitle(gameById(r.gameId)) : r.title || r.name);
  return html`<div class=${`finder ${IS_TOUCH ? 'touch' : ''}`}>
    <div class="topbar"><h1>${t('finder.title', 'Pokémon Locator')}</h1></div>
    ${!library && html`<p class="muted">${t('finder.loading', 'Reading…')}</p>`}
    ${library && !roms.length && html`<div class="panel"><p>${t('finder.noRoms', 'Add a Game Boy Advance Pokémon game to your library (Ruby, Sapphire, FireRed, Emerald or a hack of them) and the Locator shows where its Pokémon live.')}</p></div>`}
    ${roms.length > 0 && html`<div class="panel stack">
      <div class="row">
        <label class="field grow">${t('finder.game', 'Game')}
          <select value=${romId} onChange=${(e) => setRomId(e.target.value)}>${roms.map((r) => html`<option value=${r.id} selected=${r.id === romId}>${titleOf(r)}</option>`)}</select></label>
        <div class="seg" role="tablist" aria-label=${t('finder.mode', 'Search by')}>
          <button type="button" role="tab" aria-selected=${mode === 'mon'} class=${mode === 'mon' ? 'on' : ''} onClick=${() => setMode('mon')}>${t('finder.byMon', 'Pokémon')}</button>
          <button type="button" role="tab" aria-selected=${mode === 'area'} class=${mode === 'area' ? 'on' : ''} onClick=${() => setMode('area')}>${t('finder.byArea', 'Area')}</button>
        </div>
      </div>
      ${wild === undefined && html`<p class="muted" role="status">${t('finder.reading', 'Reading the encounter tables from {game}…', { game: rom ? titleOf(rom) : '' })}</p>`}
      ${wild === null && html`<p class="warning info" role="status">${t('finder.unreadable', 'souldew can’t read the wild encounters of this game with confidence (another engine, or a hack that moved the tables), so it shows nothing instead of guessing.')}</p>`}
      ${wild && mode === 'mon' && html`<${SpeciesSearch} wild=${wild} picked=${picked} onPick=${setPicked} />`}
      ${wild && mode === 'mon' && picked && html`<${WhereList} wild=${wild} keyOf=${picked} />`}
      ${wild && mode === 'area' && html`<${AreaPicker} wild=${wild} />`}
      ${wild && html`<p class="muted tiny finder-note">${t('finder.note', 'Read from the game file itself. The chance of each slot is the retail games’ fixed one (the file stores slots, not percentages) – a hack that changed that in its code isn’t reflected. Not covered yet: Repels, the Black and White Flutes, Sweet Scent, chaining, abilities like Static or Magnet Pull, held items, swarms, roaming Pokémon, Feebas’s tiles, and gift or static encounters.')}</p>`}
    </div>`}
  </div>`;
}
