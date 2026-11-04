// Save states of the built-in emulator: the overview panel (picture, time and team per state) and the
// guard that warns before progress since the last in-game save could get lost (closing, quitting).
import { html, useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { Sprite, useFocusTrap } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, ago } from '../lib/i18n.mjs';

// Slot numbers match server/app.mjs: 1–8 are the player's, 99 is "where you left off", 96–98 are older copies of 99.
export const MANUAL_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8];
export const AUTO_SLOT = 99;
export const BACKUP_SLOTS = [98, 97, 96]; // newest first
/** Thumbnail options for __emu.snapshot(). */
export const SHOT = { maxW: 192, type: 'image/jpeg', quality: 0.72 };

export const slotName = (slot) => (slot === AUTO_SLOT ? t('states.auto', 'Where you left off')
  : BACKUP_SLOTS.includes(slot) ? t('states.backup', 'Backup {n}', { n: AUTO_SLOT - slot })
    : t('states.slot', 'Slot {n}', { n: slot }));

const qs = (id, slot) => `id=${encodeURIComponent(id)}${slot ? `&slot=${slot}` : ''}`;
const APP = { 'x-soullink': '1' };

function base64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/** What the card shows next to a state: the live team (species, level) and badges at the time it was taken. */
export function stateInfo({ party, badges, core }) {
  const team = (party || []).filter((m) => m?.species).slice(0, 6).map((m) => ({ species: m.species, level: m.level, ...(m.shiny ? { shiny: true } : {}) }));
  return { core: core || '', party: team, ...(badges !== undefined && badges !== null ? { badges } : {}) };
}

/**
 * Picture + info for a state that was just written. Best effort – the state itself is what counts.
 * `shot` is a promise of the picture, started right when the state was taken so both match.
 */
export async function describeState(id, slot, shot, info) {
  let thumb = null;
  try {
    const blob = await shot;
    if (blob) thumb = base64(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    // no picture this time
  }
  try {
    await fetch(`/api/saves/state/info?${qs(id, slot)}`, { method: 'PUT', headers: { ...APP, 'Content-Type': 'application/json' }, body: JSON.stringify({ thumb, info }) });
  } catch {
    // the card falls back to the slot number
  }
}

export const firstFreeSlot = (list) => MANUAL_SLOTS.find((n) => !list?.some((s) => s.slot === n)) || null;

/**
 * The save-state overview, opened from the session bar: 8 slots of your own plus the automatic ones.
 * Loading goes through the session's usual confirmation (onLoad), saving straight to disk (onSave).
 */
export function StatePanel({ id, core, gen, version, selected, onLoad, onSave, onClose }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState(false);
  const [armed, setArmed] = useState(null); // { slot, what: 'save' | 'del' } – second click needed
  const [ver, setVer] = useState(0);
  const armTimer = useRef(null);
  const panel = useRef(null);
  // keyboard: focus moves into the panel when it opens and back to the "Save states" button when it closes
  useFocusTrap(panel, true, { trap: false });
  useEffect(() => {
    let gone = false;
    fetch(`/api/saves/states?${qs(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((l) => !gone && (setList(l), setError(false)))
      .catch(() => !gone && setError(true));
    return () => {
      gone = true;
    };
  }, [id, version, ver]);
  useEffect(() => () => clearTimeout(armTimer.current), []);
  // closes on Escape and on any click outside it (also a click into the game frame)
  useEffect(() => {
    const away = (e) => !e.target?.closest?.('.states-panel, .states-btn') && onClose();
    const esc = (e) => e.key === 'Escape' && onClose();
    addEventListener('pointerdown', away);
    addEventListener('keydown', esc);
    window.addEventListener('blur', away);
    return () => {
      removeEventListener('pointerdown', away);
      removeEventListener('keydown', esc);
      window.removeEventListener('blur', away);
    };
  }, [onClose]);
  const arm = (a) => {
    setArmed(a);
    clearTimeout(armTimer.current);
    if (a) armTimer.current = setTimeout(() => setArmed(null), 4000);
  };
  const isArmed = (slot, what) => armed?.slot === slot && armed.what === what;
  const del = async (slot) => {
    arm(null);
    try {
      await fetch(`/api/saves/state?${qs(id, slot)}`, { method: 'DELETE', headers: APP });
    } catch {
      // the list below shows what is really there
    }
    setVer((v) => v + 1);
  };
  const byslot = (n) => list?.find((s) => s.slot === n) || null;
  const free = list ? firstFreeSlot(list) : null;
  const autos = [AUTO_SLOT, ...BACKUP_SLOTS].map(byslot).filter(Boolean);

  const card = (slot, s, manual) => {
    const otherCore = s?.info && (s.info.core || '') !== (core || '');
    const team = s?.info?.party || [];
    const top = team.reduce((m, p) => Math.max(m, p.level || 0), 0);
    return html`<li class=${`state-card ${s ? '' : 'empty'} ${manual && selected === slot ? 'sel' : ''}`} key=${slot}>
      <div class="state-thumb" aria-hidden="true">
        ${s?.thumb ? html`<img src=${`/api/saves/state/thumb?${qs(id, slot)}&v=${s.at}`} alt="" loading="lazy" />` : html`<span class="px">${manual ? slot : ''}</span>`}
      </div>
      <div class="state-meta">
        <b class="px ellipsis">${slotName(slot)}</b>
        <span class="tiny faint" title=${s ? new Date(s.at).toLocaleString() : undefined}>${s ? ago(s.at) : t('states.empty', 'Empty')}</span>
      </div>
      ${team.length > 0 && html`<div class="state-team" title=${team.map((m) => `${t('common.lv', 'Lv')} ${m.level}`).join(' · ')}>
        ${team.map((m) => html`<${Sprite} id=${m.species} shiny=${m.shiny} size=${22} gen=${gen} />`)}
        <span class="px tiny">${s.info.badges !== undefined ? html`${t('states.badges', '{n} badge|{n} badges', { n: s.info.badges, count: s.info.badges })} · ` : ''}${t('common.lv', 'Lv')} ${top}</span>
      </div>`}
      <div class="state-actions">
        ${s && html`<button class="btn small primary" disabled=${otherCore} title=${otherCore ? t('states.otherCore', 'Made with another emulator core – can’t be loaded here') : undefined}
          onClick=${() => onLoad(slot)}>${t('states.load', 'Load')}</button>`}
        ${manual && html`<button class="btn small" onClick=${() => (s && !isArmed(slot, 'save') ? arm({ slot, what: 'save' }) : (arm(null), onSave(slot)))}>
          ${!s ? t('states.saveHere', 'Save here') : isArmed(slot, 'save') ? t('states.sureOverwrite', 'Overwrite?') : t('states.overwrite', 'Overwrite')}</button>`}
        ${s && slot !== AUTO_SLOT && html`<button class=${`btn small ghost ${isArmed(slot, 'del') ? 'danger' : ''}`}
          onClick=${() => (isArmed(slot, 'del') ? del(slot) : arm({ slot, what: 'del' }))}>
          ${isArmed(slot, 'del') ? t('states.sureDelete', 'Delete?') : t('states.delete', 'Delete')}</button>`}
      </div>
    </li>`;
  };

  return html`<div class="states-panel" role="dialog" aria-label=${t('states.title', 'Save states')} ref=${panel} tabIndex="-1">
    <div class="states-head">
      <b class="px">${t('states.title', 'Save states')}</b>
      <span class="tiny faint grow">${t('states.keysHint', 'F5 saves to the selected slot, F8 loads it.')}</span>
      <button class="btn small primary" disabled=${!free} title=${free ? undefined : t('states.full', 'All 8 slots are used – overwrite or delete one')}
        onClick=${() => free && onSave(free)}><${Icon} name="plus" size=${14} />${t('states.new', 'New save state')}</button>
      <button class="btn icon" aria-label=${t('common.close', 'Close')} title=${t('common.close', 'Close')} onClick=${onClose}><${Icon} name="close" size=${14} /></button>
    </div>
    ${error && html`<p class="small muted">${t('states.listFailed', 'Couldn’t read the save states. Try again in a moment.')}</p>`}
    <ul class="states-grid">${MANUAL_SLOTS.map((n) => card(n, byslot(n), true))}</ul>
    <div class="states-sub tiny faint">${t('states.autoTitle', 'Automatic – taken while you play and when you close the game')}</div>
    ${autos.length ? html`<ul class="states-grid">${autos.map((s) => card(s.slot, s, false))}</ul>`
      : html`<p class="small muted">${list ? t('states.autoNone', 'None yet.') : '…'}</p>`}
  </div>`;
}

// ---- "not saved in-game" guard ------------------------------------------------------

const PLAY_LIMIT = 10 * 60 * 1000; // this much play without an in-game save counts as progress, too
const fingerprint = (party, badges) => (party?.length ? `${party.map((m) => `${m.species}:${m.level}`).join(',')}|${badges ?? ''}` : null);
const store = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k) || 'null');
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // private mode
    }
  },
};

let current = null; // the running game's guard, read by the app shell before it closes the game

/** Unsaved progress of the running game ({ savedAt, hasSave, label }) or null. */
export function unsavedProgress() {
  return current?.dirty ? current : null;
}

/** Warning texts, shared by the in-app dialog and the desktop app's quit dialog. */
export function unsavedTexts(u) {
  return {
    title: t('unsaved.title', 'Not saved in the game yet'),
    text: `${u?.savedAt ? t('unsaved.since', 'Your last in-game save was {when}.', { when: ago(u.savedAt) })
      : u?.hasSave ? t('unsaved.sinceSession', 'You haven’t saved in the game since you started playing.')
        : t('unsaved.never', 'You haven’t saved in the game yet.')} ${t('unsaved.text', 'A save state of where you left off is kept, but only an in-game save is safe – save in the game menu first.')}`,
    keep: t('unsaved.keep', 'Keep playing'),
    close: t('unsaved.close', 'Close anyway'),
    quit: t('unsaved.quit', 'Quit anyway'),
  };
}

/**
 * Tracks progress since the last in-game save: the live team changed (species, levels, badges) or
 * 10+ minutes of play went by. Nothing changed → no warning. The session calls `saved(hash)` after an
 * in-game save reached the disk and `loaded(hash)` after reading the save on disk.
 */
export function useSaveGuard({ id, label, party, badges, running, paused }) {
  const key = `sl-ingame-${id}`;
  const [savedAt, setSavedAt] = useState(null);
  const [hasSave, setHasSave] = useState(false);
  const [dirty, setDirty] = useState(false);
  const r = useRef({ base: null, fp: null, play: 0 });
  const live = useRef({});
  live.current = { running, paused };
  const check = () => setDirty(!!((r.current.base && r.current.fp && r.current.fp !== r.current.base) || r.current.play >= PLAY_LIMIT));
  const fp = fingerprint(party, badges);
  useEffect(() => {
    r.current.fp = fp;
    if (fp && !r.current.base) r.current.base = fp; // first team seen since the last save
    check();
  }, [fp]);
  // count play time (not while paused or in the background)
  useEffect(() => {
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      if (live.current.running && !live.current.paused && document.visibilityState === 'visible') r.current.play += now - last;
      last = now;
      check();
    }, 5000);
    return () => clearInterval(timer);
  }, []);
  const api = useRef(null);
  if (!api.current) {
    api.current = {
      saved(h) {
        const at = Date.now();
        r.current.base = r.current.fp;
        r.current.play = 0;
        store.set(key, { at, h });
        setSavedAt(at);
        setHasSave(true);
        setDirty(false);
      },
      loaded(h) {
        const rec = store.get(key);
        setHasSave(true);
        if (rec?.h === h) setSavedAt(rec.at);
      },
    };
  }
  // register for the app shell (closing, switching runs) and the desktop app (quitting)
  useEffect(() => {
    current = { dirty, savedAt, hasSave, label };
    const push = () => window.sls?.setUnsaved?.(dirty ? unsavedTexts(current) : null);
    push();
    if (!dirty || !window.sls?.setUnsaved) return;
    const timer = setInterval(push, 60000); // keeps "{when}" in the quit dialog current
    return () => clearInterval(timer);
  }, [dirty, savedAt, hasSave, label]);
  useEffect(() => () => {
    current = null;
    window.sls?.setUnsaved?.(null);
  }, []);
  // In a browser tab: the browser's own "leave the page?" prompt. (In the desktop app the native dialog asks.)
  useEffect(() => {
    if (window.sls?.native) return;
    const onLeave = (e) => {
      if (!current?.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    addEventListener('beforeunload', onLeave);
    return () => removeEventListener('beforeunload', onLeave);
  }, []);
  return { savedAt, hasSave, dirty, saved: api.current.saved, loaded: api.current.loaded };
}

/** "Last saved in-game: 12 min ago" for the session header; amber while there is unsaved progress. */
export function SaveAge({ savedAt, hasSave, dirty }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, []);
  const text = savedAt ? t('states.lastSaved', 'Last saved in-game: {when}', { when: ago(savedAt) })
    : hasSave ? t('states.lastSavedBefore', 'Last saved in-game: before this session') : t('states.notSaved', 'Not saved in-game yet');
  return html`<span class=${`save-age ${dirty ? 'dirty' : ''}`} title=${dirty ? `${text} – ${t('states.unsavedHint', 'progress since then isn’t saved in the game yet')}` : text}>
    <${Icon} name="save" size=${12} /><span class="ellipsis">${text}</span></span>`;
}
