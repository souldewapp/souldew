import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { useApp, Modal, Led } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, ago } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { catalog, gameById, hackById, gameTitle } from '../lib/data.mjs';
import { PRESETS, DEFAULT_VALUES, localizeRandomizer, randomSeed, sameSettings, withDefaults, fieldActive, fieldEnabled, forGen, buildValues } from '/shared/randomizer-options.mjs';
import { Cart, coverOf } from './library.mjs';
import { RestartModal } from './restart.mjs';
import { mySlotIn } from '../lib/restart.mjs';
import { numberedName } from '/shared/restart.mjs';
import { ALL_SLOTS, slotsOf, runMode, othersOf, defaultRunName } from '/shared/slots.mjs';
import { NUZLOCKE_RULES, joinNames } from '../lib/run.mjs';
import { suggestSlot } from '../lib/invitecode.mjs';
import { Board, InviteBody } from './board.mjs';
import { JoinCode } from './invitecode.mjs';
import { NuzlockeRules, TypeHelpRule } from './nuzrules.mjs';
import { FirstSteps } from './firststeps.mjs';

/**
 * The SoulLink and the Nuzlocke section – one view, two modes (route `soullink` / `nuzlocke`):
 *   no params        → the overview of that mode's runs (never straight into the last board)
 *   ?run=<id>        → that run's board
 *   ?new=<gameId>[&hack=<hackId>] → the new-run wizard of that mode (`new=` with no game: pick one)
 *   ?new=&from=<id>  → a new attempt of a run, in the mode of that run
 *   ?join=1          → join a SoulLink with a code (SoulLink only)
 * A run opened under the other mode's route (old links, restarts, the board's "Play" round trip) moves to its own
 * section in place.
 */
export function SoulLinkView({ mode = 'soullink' }) {
  const { route, runId, setRunId, manifest, missingRun, navigate } = useApp();
  const p = route.params;
  useEffect(() => {
    if (p.run && p.run !== runId) setRunId(p.run);
  }, [p.run]);
  // (`home`: the board's "All runs" – the overview of the section the open run belongs to)
  const own = useOwnSection(mode, p.join !== undefined ? 'soullink'
    : p.home !== undefined && !p.run ? manifest && runMode(manifest)
      : p.run && p.new === undefined && manifest?.id === p.run ? runMode(manifest) : null);
  if (!own) return null;
  if (p.new !== undefined && p.from) return html`<${RestartRun} key=${p.from} from=${p.from} mode=${mode} />`;
  if (p.new !== undefined) return html`<${NewRun} key=${mode} mode=${mode} gameId=${p.new} hackId=${p.hack} />`;
  if (p.join !== undefined) return html`<${JoinRun} />`;
  if (!p.run) return html`<${RunsHome} key=${mode} mode=${mode} />`;
  if (!manifest && missingRun === p.run) {
    return html`<div class="panel empty-state"><${Icon} name=${mode === 'nuzlocke' ? 'ball' : 'link'} size=${56} /><h2>${mode === 'nuzlocke' ? t('runs.notFoundSolo', 'Nuzlocke not found') : t('runs.notFound', 'SoulLink not found')}</h2>
      <p class="muted">${t('runs.notFoundText', 'This run doesn’t exist anymore – it may have been deleted.')}</p>
      <button class="btn primary" onClick=${() => navigate(mode)}>${mode === 'nuzlocke' ? t('runs.toListSolo', 'All Nuzlockes') : t('runs.toList', 'All SoulLink runs')}</button></div>`;
  }
  if (!manifest || manifest.id !== p.run) return html`<div class="empty-state"><p class="muted">${t('common.loading', 'Loading …')}</p></div>`;
  if (!Object.keys(manifest.outputs || {}).length && manifest.imported) return html`<${JoinRun} />`;
  return html`<${Board} />`;
}

export const NuzlockeView = () => html`<${SoulLinkView} mode="nuzlocke" />`;

/** want: the section a run (or page) belongs to. Elsewhere → the same address under that section, without a new
 * history entry (Back must not land on the redirect again). Returns whether this view is the right one. */
function useOwnSection(mode, want) {
  const wrong = !!want && want !== mode;
  useEffect(() => {
    if (wrong) location.replace(location.hash.replace(/^#\/[a-z]+/, `#/${want}`));
  }, [wrong, want]);
  return !wrong;
}

// ---- run lists ------------------------------------------------------------------------
const LIVE_MS = 120000;
export const runState = (r) => r.summary?.status?.state || 'active';
export const stateLabel = (s) => ({ active: t('runs.stActive', 'active'), failed: t('runs.stFailed', 'failed'), won: t('runs.stWon', 'won'), ended: t('runs.stEnded', 'ended') }[s] || s);

/** Run lists show live dots → refresh the status (summaries) while a list is on screen. */
export function useStatusPoll() {
  const { reloadStatus } = useApp();
  useEffect(() => {
    reloadStatus();
    const id = setInterval(reloadStatus, 30000);
    return () => clearInterval(id);
  }, []);
}

/** Players live in a run: recent live:<slot> timestamps; for the open run the doc + link are fresher. */
function liveOf(r, { runId, doc, me, onlineSlots }) {
  const cur = r.id === runId && doc ? doc : null;
  return slotsOf(r).map((s) => {
    const at = cur ? cur.get(`live:${s}`)?.at : r.summary?.live?.[s];
    const playing = !!at && Date.now() - at < LIVE_MS;
    const online = !!cur && s !== me && !!onlineSlots?.has(s);
    const name = (cur && cur.get(`player:${s}`)?.name) || r.summary?.names?.[s] || r.players?.[s]?.name || s.toUpperCase();
    return playing || online ? { slot: s, name, playing } : null;
  }).filter(Boolean);
}

/** "Nuzlocke" / "SoulLink · 3" – how a run is played, for lists. */
export const modeLabel = (r) => (runMode(r) === 'nuzlocke' ? t('runs.modeSolo', 'Solo Nuzlocke') : t('runs.modeLink', 'SoulLink · {n}', { n: slotsOf(r).length }));

function RunCaption({ r }) {
  const app = useApp();
  const st = runState(r);
  const s = r.summary || {};
  const who = slotsOf(r).map((x) => r.summary?.names?.[x] || r.players?.[x]?.name || x.toUpperCase()).join(', ');
  return html`<div class="run-cap">
    <span class="tiny muted ellipsis" title=${who}><b>${modeLabel(r)}</b> · ${who}</span>
    <div class="row tight"><span class=${`chip run-st ${st}`}>${stateLabel(st)}</span>
      <span class="tiny muted"><b class="alive-t">${s.alive || 0}</b> ${t('board.alive', 'alive')} · <b class="dead-t">${s.dead || 0}</b> ${t('board.dead', 'dead')}</span></div>
    ${liveOf(r, app).map((x) => html`<span class="tiny live-tag"><${Led} on color="green" blink=${!x.playing} />${x.playing ? t('runs.live', '{name} live', { name: x.name }) : t('runs.online', '{name} online', { name: x.name })}</span>`)}
  </div>`;
}

/** Cartridge + status caption + a small menu (restart / delete); actions: buttons under the caption. */
export function RunCard({ r, sub, onOpen, actions }) {
  const { library } = useApp();
  const [menu, setMenu] = useState(false);
  const [del, setDel] = useState(false);
  const [restart, setRestart] = useState(false);
  const g = gameById(r.game?.id);
  const h = r.game?.hackId ? hackById(r.game.hackId) : null;
  const st = runState(r);
  // the menu closes when the pointer leaves the card or the keyboard focus leaves the menu
  return html`<div class=${`run-card ${st}`} onMouseLeave=${() => setMenu(false)} onKeyDown=${(e) => e.key === 'Escape' && setMenu(false)}
    onfocusout=${(e) => menu && !(e.currentTarget.contains(e.relatedTarget) && e.relatedTarget.closest('.run-menu, .run-menu-btn')) && setMenu(false)}>
    <${Cart} title=${r.name || (h ? h.name : g ? gameTitle(g) : r.game?.title) || t('runs.untitled', 'Run')} sub=${sub ?? (h ? h.name : g ? gameTitle(g) : r.game?.title || '')} cover=${coverOf(library, { gameId: r.game?.id, hackId: r.game?.hackId })}
      color=${h?.color || g?.color} system=${r.game?.system} hack=${!!h} missing=${st !== 'active'} owned=${st === 'active'} onClick=${onOpen} />
    <button class="run-menu-btn" aria-haspopup="menu" aria-expanded=${menu} aria-label=${t('runs.menu', 'Run options')} onClick=${() => setMenu(!menu)}>⋯</button>
    ${menu && html`<div class="run-menu" role="menu">
      ${st !== 'active' && html`<button role="menuitem" onClick=${() => { setMenu(false); setRestart(true); }}><${Icon} name="reset" size=${14} />${t('runs.restart', 'New attempt …')}</button>`}
      <button role="menuitem" class="danger" onClick=${() => { setMenu(false); setDel(true); }}><${Icon} name="close" size=${14} />${t('runs.delete', 'Delete run')}</button>
    </div>`}
    <${RunCaption} r=${r} />
    ${actions && html`<div class="run-actions">${actions}</div>`}
    ${del && html`<${DeleteRunModal} r=${r} onClose=${() => setDel(false)} />`}
    ${restart && html`<${RestartModal} r=${r} onClose=${() => setRestart(false)} />`}
  </div>`;
}

export function DeleteRunModal({ r, onClose }) {
  const { runId, setRunId, reloadStatus, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/runs/${r.id}`, { method: 'DELETE', headers: { 'x-soullink': '1' } });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
      try { localStorage.removeItem(`sl-doc-${r.id}`); } catch { /* private mode */ }
      if (r.id === runId) setRunId(null);
      await reloadStatus();
      toast({ kind: 'ok', title: t('runs.deleted', 'Run deleted'), text: r.name });
      onClose();
    } catch (e) {
      toast({ kind: 'death', title: t('runs.deleteFailed', 'Could not delete the run'), text: e.message });
      setBusy(false);
    }
  };
  return html`<${Modal} open=${true} onClose=${onClose} title=${t('runs.deleteTitle', 'Delete “{name}”?', { name: r.name })}
    footer=${html`<button class="btn ghost" onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
      <button class="btn danger" disabled=${busy} onClick=${go}>${t('runs.deleteConfirm', 'Delete run')}</button>`}>
    <p class="muted">${t('runs.deleteText', 'This removes the run from this computer: the games built for it, the save files, the board with all encounters and deaths, and the invite.')}</p>
    <p class="small faint">${runMode(r) === 'nuzlocke' ? t('runs.deleteTrashSolo', 'The folder is moved to the trash folder inside the app data (runs/.trash) – you can restore it by hand.')
      : slotsOf(r).length > 2 ? t('runs.deleteTrashGroup', 'The folder is moved to the trash folder inside the app data (runs/.trash) – you can restore it by hand. The copies of the other players are not affected.')
        : t('runs.deleteTrash', 'The folder is moved to the trash folder inside the app data (runs/.trash) – you can restore it by hand. Your partner’s copy is not affected.')}</p>
  <//>`;
}

/** The record of one mode: how many runs, how they ended, losses, the best run so far. */
function RunStats({ runs, mode }) {
  if (!runs.length) return null;
  const n = (s) => runs.filter((r) => runState(r) === s).length;
  const deaths = runs.reduce((a, r) => a + (r.summary?.dead || 0), 0);
  const best = runs.map((r) => ({ r, badges: Math.max(0, ...Object.values(r.summary?.badges || {}).map((b) => b || 0)), alive: r.summary?.alive || 0 }))
    .sort((x, y) => y.badges - x.badges || y.alive - x.alive)[0];
  const stat = (v, label, cls = '') => html`<div class=${`stat center ${cls} ${v === 0 ? 'zero' : ''}`}><b>${v}</b><span>${label}</span></div>`;
  const vars = best && { name: best.r.name, mode: modeLabel(best.r), badges: best.badges, alive: best.alive };
  return html`<section class="panel run-stats" aria-label=${t('runs.statsAria', 'Your record')}>
    <div class="stat-strip">
      ${stat(runs.length, t('play.statRuns', 'runs'))}
      ${stat(n('active'), stateLabel('active'), 'alive')}
      ${stat(n('failed'), stateLabel('failed'), 'dead')}
      ${stat(n('won'), stateLabel('won'))}
      ${n('ended') > 0 && stat(n('ended'), stateLabel('ended'))}
      ${stat(deaths, t('play.statLosses', 'losses'), 'dead')}
    </div>
    ${best && (best.badges > 0 || best.alive > 0) && html`<p class="small muted">${mode === 'nuzlocke' ? t('runs.bestRunSolo', 'Best run: {name} – badges: {badges} · alive: {alive}', vars)
      : t('play.bestRun', 'Best run: {name} ({mode}) – badges: {badges} · alive: {alive}', vars)}</p>`}
  </section>`;
}

/** The game of a run of this section runs right now (full or in the corner): the way back to it. */
function RunningHere({ mode }) {
  const { session, status, navigate, closeSession } = useApp();
  const run = session?.target.runId && (status?.runs || []).find((r) => r.id === session.target.runId);
  if (!run || runMode(run) !== mode) return null;
  return html`<div class="panel row running-banner">
    <${Led} on color="green" /><span class="grow">${t('play.runningNow', 'Running now:')} <b>${session.target.label}</b></span>
    <button class="btn small primary" onClick=${() => navigate('play', session.target.params)}><${Icon} name="play" size=${14} />${t('play.backToGame', 'Back to the game')}</button>
    <button class="btn small ghost" onClick=${() => closeSession()}>${t('play.close', 'Close game')}</button>
  </div>`;
}

/** Overview of one mode (the SoulLink or the Nuzlocke section): record, running game, the runs, and how to start one. */
function RunsHome({ mode }) {
  const { status, navigate, setRunId, session, me, runId } = useApp();
  useStatusPoll();
  const solo = mode === 'nuzlocke';
  const all = (status?.runs || []).filter((r) => runMode(r) === mode);
  // still going first, then the one played last
  const when = (r) => r.summary?.lastPlayed || Date.parse(r.updatedAt) || 0;
  const runs = [...all].sort((a, b) => (runState(a) === 'active' ? 0 : 1) - (runState(b) === 'active' ? 0 : 1) || when(b) - when(a));
  const board = (r) => { setRunId(r.id); navigate(mode, { run: r.id }); };
  const actions = (r) => {
    const playing = session?.target.runId === r.id;
    // my game of the run: the open run knows my slot, other runs went by the slot stored for them
    const built = Object.keys(r.outputs || {}).length > 0 && (r.id !== runId || !!r.outputs?.[me]);
    if (!built) return html`<button class="btn small" onClick=${() => board(r)}>${solo ? t('runs.buildGame', 'Build your game') : t('runs.finishJoin', 'Finish joining')}</button>`;
    return html`${playing ? html`<button class="btn small primary" onClick=${() => navigate('play', session.target.params)}><${Icon} name="play" size=${14} />${t('play.backToGame', 'Back to the game')}</button>`
      : runState(r) === 'active' && html`<button class="btn small go" onClick=${() => navigate('play', { run: r.id })}><${Icon} name="play" size=${14} />${t('runs.continue', 'Continue')}</button>`}
      <button class="btn small ghost" onClick=${() => board(r)}>${t('runs.board', 'Board')}</button>`;
  };
  const newRun = () => navigate(mode, { new: '' });
  const hostBtn = (big) => html`<button class=${`btn primary ${big ? 'big' : ''}`} onClick=${newRun}><${Icon} name="plus" size=${16} />${solo ? t('runs.newSolo', 'New Nuzlocke') : t('runs.hostLink', 'Host new SoulLink')}</button>`;
  const joinBtn = (big) => html`<button class=${`btn ${big ? 'big' : ''}`} onClick=${() => navigate('soullink', { join: 1 })}><${Icon} name="load" size=${16} />${t('runs.joinCode', 'Join with code')}</button>`;
  return html`<div class="stack-l">
    <div class="topbar"><div class="stack-s" style="gap:2px; margin-right:auto"><h1>${solo ? t('nav.nuzlocke', 'Nuzlocke') : t('nav.soullink', 'SoulLink')}</h1>
        <span class="small muted">${solo ? t('runs.leadSolo', 'Solo runs – just you against the game, tracked live.') : t('runs.leadLink', 'Runs for 2–4 players – the catches of each area are linked.')}</span></div>
      ${runs.length > 0 && html`<div class="row">${!solo && joinBtn(false)}${hostBtn(false)}</div>`}</div>
    <${FirstSteps} mode=${mode} />
    <${RunningHere} mode=${mode} />
    <${RunStats} runs=${all} mode=${mode} />
    ${runs.length > 0 && html`<section class="stack"><h2>${solo ? t('runs.yourSolos', 'Your Nuzlockes') : t('runs.yourLinks', 'Your SoulLinks')}</h2><div class="shelf">
      ${runs.map((r) => {
        const g = gameById(r.game?.id);
        const h = r.game?.hackId ? hackById(r.game.hackId) : null;
        return html`<${RunCard} key=${r.id} r=${r} sub=${[h ? h.name : g ? gameTitle(g) : r.game?.title, ago(when(r))].filter(Boolean).join(' · ')}
          onOpen=${() => board(r)} actions=${actions(r)} />`;
      })}
    </div></section>`}
    ${runs.length === 0 && (solo ? html`<div class="grid-2 entry-choices">
      <section class="panel entry host">
        <div class="row nowrap"><${Icon} name="plus" size=${28} /><h2>${t('runs.soloTitle', 'Start a Nuzlocke')}</h2></div>
        <p class="muted">${t('runs.soloText', 'Just you and the game – no invite, no partner. The app tracks catches and deaths live while you play.')}</p>
        <ol class="small muted steps">
          <li>${t('runs.host1', 'Pick the game, ROM hack and randomizer settings')}</li>
          <li>${t('runs.solo2', 'Choose the rules – Classic, Hardcore or your own')}</li>
          <li>${t('runs.solo3', 'The app builds your game – start playing')}</li>
        </ol>
        ${hostBtn(true)}
      </section>
      <section class="panel entry rules">
        <div class="row nowrap"><${Icon} name="grave" size=${28} /><h2>${t('runs.soloRulesTitle', 'The rules in short')}</h2></div>
        <ul class="small muted steps">
          <li>${t('runs.soloRule1', 'Only the first Pokémon you meet in each area counts.')}</li>
          <li>${t('runs.soloRule2', 'Fainted means dead – it goes to the graveyard.')}</li>
          <li>${t('runs.soloRule3', 'A blackout ends the run. Each rule can be changed when you start.')}</li>
        </ul>
      </section>
    </div>` : html`<div class="grid-2 entry-choices">
      <section class="panel entry host">
        <div class="row nowrap"><${Icon} name="plus" size=${28} /><h2>${t('runs.hostTitleLink', 'Host a new SoulLink')}</h2></div>
        <p class="muted">${t('runs.hostTextLink', 'A SoulLink for 2–4 players: you set it up and invite the others with a code.')}</p>
        <ol class="small muted steps">
          <li>${t('runs.host1', 'Pick the game, ROM hack and randomizer settings')}</li>
          <li>${t('runs.host2Link', 'The app builds the games – for everyone or just for you')}</li>
          <li>${t('runs.host3Link', 'Give the others the 6-digit invite code')}</li>
        </ol>
        ${hostBtn(true)}
      </section>
      <section class="panel entry join">
        <div class="row nowrap"><${Icon} name="load" size=${28} /><h2>${t('runs.joinTitle', 'Got an invite? Join')}</h2></div>
        <p class="muted">${t('runs.joinTextAny', 'Somebody created a SoulLink and gives you an invite code.')}</p>
        <ol class="small muted steps">
          <li>${t('runs.join1Code', 'Enter the 6-digit code (or open an invite file)')}</li>
          <li>${t('runs.join2', 'Add your own copy of the same game to the library')}</li>
          <li>${t('runs.join3', 'The app builds your game and connects you')}</li>
        </ol>
        ${joinBtn(true)}
      </section>
    </div>`)}
  </div>`;
}

/** "Start over" for a failed / ended run: same game & settings, new seeds, new run (and invite) – in its own mode. */
function RestartRun({ from, mode }) {
  const [old, setOld] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    // rules live in the run doc (the partner may have changed them) – fall back to the manifest copy
    Promise.all([api.get(`/api/runs/${from}`), api.get(`/api/runs/${from}/doc`).catch(() => null)])
      .then(([m, doc]) => setOld(doc?.rules?.v ? { ...m, rules: doc.rules.v } : m)).catch((e) => setError(e.message));
  }, [from]);
  const own = useOwnSection(mode, old ? runMode(old) : null);
  if (error) return html`<div class="warning error" role="alert">${error}</div>`;
  if (!old) return html`<div class="empty-state"><p class="muted">${t('common.loading', 'Loading …')}</p></div>`;
  if (!own) return null;
  return html`<${NewRun} gameId=${old.game?.id || ''} hackId=${old.game?.hackId} from=${old} mode=${runMode(old)} />`;
}

function Field({ f, value, onChange, disabled, values, gen }) {
  if (f.type === 'head') return html`<div class="small muted" style="grid-column: 1 / -1; margin: 10px 0 2px; font-weight: 600">${f.label}</div>`;
  const dep = !fieldEnabled(f, values);
  if (f.type === 'bool') {
    return html`<label class="check" style=${dep ? 'opacity:.45' : ''}><input type="checkbox" checked=${!!value} disabled=${disabled || dep} onChange=${(e) => onChange(e.target.checked)} />
      <span>${f.label}${f.help && html`<span class="hint">${f.help}</span>`}</span></label>`;
  }
  if (f.type === 'int') {
    return html`<label class="field" style=${dep ? 'opacity:.45' : ''}><span>${f.label}</span>
      <input type="number" min=${f.min} max=${f.max} value=${value ?? f.min} disabled=${disabled || dep} onChange=${(e) => onChange(Math.max(f.min, Math.min(f.max, Number(e.target.value) || 0)))} /></label>`;
  }
  // options of other generations stay hidden – unless an old run already uses one
  const options = f.options.filter(([v, , more]) => v === value || forGen(more, gen));
  return html`<label class="field" style=${`grid-column: 1 / -1${dep ? '; opacity:.45' : ''}`}><span>${f.label}</span>
    <select value=${value} disabled=${disabled || dep} onChange=${(e) => onChange(f.numeric ? Number(e.target.value) : e.target.value)}>${options.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>
    ${f.help && html`<span class="faint small">${f.help}</span>`}</label>`;
}

/** One-line summary of a saved preset (wild · starters · trainers), from the localized option labels. */
function presetSummary(values, groups) {
  const fields = groups.flatMap((g) => g.fields);
  const parts = ['wildPokemonMod', 'startersMod', 'trainersMod'].map((key) => {
    const f = fields.find((x) => x.key === key);
    const v = values[key];
    if (!f || !v || v === 'UNCHANGED') return null;
    return `${f.label}: ${f.options.find(([o]) => o === v)?.[1] || v}`;
  }).filter(Boolean);
  return parts.length ? parts.join(' · ') : t('new.presetVanilla', 'Wild Pokémon, starters and trainers unchanged');
}

/** "My presets": the user's saved randomizer settings – pick, rename, delete, save the current ones. */
function MyPresets({ presets, setPresets, presetId, basedOn, values, groups, onPick }) {
  const { toast } = useApp();
  const [mode, setMode] = useState(null); // { kind: 'new' | 'rename' | 'delete', id?, name? }
  const [busy, setBusy] = useState(false);
  const current = presetId === 'custom' ? presets.find((p) => p.id === basedOn) : null; // a saved preset, edited since
  async function run(fn, done) {
    setBusy(true);
    try {
      const res = await fn();
      setPresets(res.presets);
      setMode(null);
      if (done) done(res);
    } catch (e) {
      toast({ kind: 'death', title: t('new.presetFailed', 'Could not change the preset'), text: e.message });
    }
    setBusy(false);
  }
  const save = () => run(() => api.post('/api/randomizer/presets', { name: mode.name, values }), (res) => {
    onPick(res.preset);
    toast({ kind: 'ok', title: t('new.presetSavedToast', 'Preset saved'), text: res.preset.name });
  });
  const rename = () => run(() => api.post('/api/randomizer/presets', { id: mode.id, name: mode.name }));
  const remove = () => run(() => api.del(`/api/randomizer/presets/${mode.id}`));
  const nameInput = (onEnter) => html`<input type="text" class="grow" maxLength="40" value=${mode.name} placeholder=${t('new.presetName', 'Preset name')}
    ref=${(el) => el && !el.dataset.focused && (el.dataset.focused = '1', el.focus())}
    onInput=${(e) => setMode({ ...mode, name: e.target.value })} onKeyDown=${(e) => { if (e.key === 'Enter' && mode.name.trim()) onEnter(); if (e.key === 'Escape') setMode(null); }} />`;

  return html`<div class="stack" style="gap:8px">
    ${presets.length > 0 && html`<div class="small muted">${t('new.myPresets', 'My presets')}</div>`}
    ${presets.map((p) => mode?.id === p.id && mode.kind === 'rename'
      ? html`<div class="row nowrap">${nameInput(rename)}
          <button class="btn small" disabled=${busy || !mode.name.trim()} onClick=${rename}>${t('common.save', 'Save')}</button>
          <button class="btn small ghost" onClick=${() => setMode(null)}>${t('common.cancel', 'Cancel')}</button></div>`
      : mode?.id === p.id && mode.kind === 'delete'
        ? html`<div class="row nowrap warning info"><span class="grow">${t('new.presetDeleteAsk', 'Delete the preset “{name}”?', { name: p.name })}</span>
            <button class="btn small danger" disabled=${busy} onClick=${remove}>${t('new.presetDelete', 'Delete')}</button>
            <button class="btn small ghost" onClick=${() => setMode(null)}>${t('common.cancel', 'Cancel')}</button></div>`
        : html`<div class="row nowrap" style="align-items:stretch">
            <button class=${`preset grow ${presetId === p.id ? 'on' : ''}`} role="radio" aria-checked=${presetId === p.id} onClick=${() => onPick(p)}>
              <span class="radio"></span><span><b>${p.name}</b></span><span class="desc">${presetSummary(p.values, groups)}</span></button>
            <div class="stack" style="gap:4px; justify-content:center">
              <button class="btn small ghost" onClick=${() => setMode({ kind: 'rename', id: p.id, name: p.name })}>${t('new.presetRename', 'Rename')}</button>
              <button class="btn small ghost" onClick=${() => setMode({ kind: 'delete', id: p.id })}>${t('new.presetDelete', 'Delete')}</button>
            </div></div>`)}
    ${mode?.kind === 'new'
      ? html`<div class="row nowrap">${nameInput(save)}
          <button class="btn small primary" disabled=${busy || !mode.name.trim()} onClick=${save}>${t('common.save', 'Save')}</button>
          <button class="btn small ghost" onClick=${() => setMode(null)}>${t('common.cancel', 'Cancel')}</button></div>`
      : html`<div class="row">
          <button class="btn small ghost" onClick=${() => setMode({ kind: 'new', name: '' })}><${Icon} name="save" size=${14} />${t('new.presetSave', 'Save current settings as preset')}</button>
          ${current && !sameSettings(current.values, values) && html`<button class="btn small ghost" disabled=${busy}
            onClick=${() => run(() => api.post('/api/randomizer/presets', { id: current.id, name: current.name, values }), (res) => onPick(res.preset))}>${t('new.presetUpdate', 'Update “{name}”', { name: current.name })}</button>`}
        </div>`}
  </div>`;
}

/** Owned ROMs + patches that fit a catalog game (or any owned ROM). */
function useGameChoices(gameId, hackId) {
  const { library } = useApp();
  const cat = catalog();
  const rootOf = (id) => cat.games.find((g) => g.id === id)?.variantOf || id;
  const roms = (library?.roms || []).filter((r) => !gameId || rootOf(r.gameId) === gameId);
  const allRoms = library?.roms || [];
  const patchesFor = (rom) => (library?.patches || []).filter((p) => rom && (!p.expectedCrc || p.expectedCrc === rom.crc));
  return { roms: roms.length ? roms : allRoms, patchesFor, preferredPatch: (rom) => patchesFor(rom).find((p) => p.hackId === hackId) };
}

/** First step of a new SoulLink: how many play – one card per head count, the player figures show it.
 * (A solo Nuzlocke has its own wizard in the Nuzlocke section.) */
function ShapeCards({ count, onPick }) {
  const hint = {
    2: t('new.modeLink2Hint', 'The classic: two games, the catches of each area are linked as a pair.'),
    3: t('new.modeLink3Hint', 'Three players – the catches of each area form a linked group.'),
    4: t('new.modeLink4Hint', 'Four players, four teams – one fate per area.'),
  };
  return html`<div role="radiogroup" aria-label=${t('new.modeAriaLink', 'Number of players')} style="display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:10px">
    ${[2, 3, 4].map((n) => {
      const on = n === count;
      return html`<button type="button" role="radio" aria-checked=${on} class=${`theme-card ${on ? 'on' : ''}`} onClick=${() => onPick(n)}>
        <span class="row tight" aria-hidden="true" style="gap:2px">${ALL_SLOTS.slice(0, n).map((s) => html`<span style=${`color:var(--${s}, var(--ink-2))`}><${Icon} name="user" size=${18} /></span>`)}</span>
        <b>${t('new.modeLink', 'SoulLink · {n} players', { n })}</b>
        <span class="hint">${hint[n]}</span></button>`;
    })}
  </div>`;
}

/** Names for a restart: this computer's player first, then the others in their order. */
function namesFrom(from, fallback) {
  const mine = mySlotIn(from);
  const order = [mine, ...othersOf(mine, from)].filter((s) => from.players?.[s]);
  const out = { p1: '', p2: '', p3: '', p4: '' };
  order.forEach((s, i) => { out[ALL_SLOTS[i]] = from.players[s].name || ''; });
  if (!out.p1) out.p1 = fallback;
  return out;
}

/** The new-run wizard of one mode: a SoulLink (2–4 players, invite at the end) or a solo Nuzlocke (rules step).
 * A restart (`from`) always keeps the mode of the old run. */
function NewRun({ gameId, hackId, from, mode: sectionMode }) {
  const { status, navigate, reloadStatus, setRunId, setMe } = useApp();
  const { roms, patchesFor, preferredPatch } = useGameChoices(gameId || null, hackId);
  // `from`: restart of an old run – same game, hack, settings, mode and players; seeds stay fresh.
  const [romId, setRomId] = useState(() => (from && roms.find((r) => r.crc === from.base?.crc))?.id || roms[0]?.id || null);
  const rom = roms.find((r) => r.id === romId) || roms[0];
  const [patchId, setPatchId] = useState(() => (from ? (from.patch ? (patchesFor(rom).find((p) => p.sha1 && p.sha1 === from.patch.sha1) || preferredPatch(rom))?.id || null : null) : preferredPatch(rom)?.id || null));
  const [inspect, setInspect] = useState(null);
  const [randomize, setRandomize] = useState(from ? from.randomizer?.enabled !== false : true);
  const oldValues = from?.randomizer?.values && Object.keys(from.randomizer.values).length ? from.randomizer.values : null;
  const [presetId, setPresetId] = useState(oldValues ? PRESETS.find((p) => sameSettings(p.values, oldValues))?.id || 'custom' : 'soullink');
  const [values, setValues] = useState(oldValues || PRESETS[0].values);
  const [myPresets, setMyPresets] = useState([]);
  const [basedOn, setBasedOn] = useState(null); // saved preset the current values came from
  const rnd = localizeRandomizer(t);
  const mode = from ? runMode(from) : sectionMode;
  const solo = mode === 'nuzlocke';
  const [count, setCount] = useState(from && !solo ? Math.max(2, slotsOf(from).length) : 2);
  const slots = ALL_SLOTS.slice(0, solo ? 1 : count);
  // a restarted Nuzlocke keeps its rules; a SoulLink's rules don't fit a Nuzlocke (and the other way round)
  const [nzRules, setNzRules] = useState(() => (from && runMode(from) === 'nuzlocke' && from.rules ? { ...NUZLOCKE_RULES, ...from.rules } : { ...NUZLOCKE_RULES }));
  // the host's call for everyone: the battle helper's type matchups (a restart keeps the old run's choice)
  const [typeHelp, setTypeHelp] = useState(() => from?.rules?.typeHelp !== false);
  const [seedMode, setSeedMode] = useState(from?.randomizer?.sharedSeed ? 'shared' : 'separate');
  const [seeds, setSeeds] = useState(() => Object.fromEntries(ALL_SLOTS.map((s) => [s, randomSeed()])));
  const [names, setNames] = useState(() => (from ? namesFrom(from, status?.config?.playerName || '') : { p1: status?.config?.playerName || '', p2: '', p3: '', p4: '' }));
  const [buildFor, setBuildFor] = useState('all');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!rom) return;
    let off = false;
    setInspect(null);
    setError(null); // an error of the previous pick (e.g. a patch that didn't fit) doesn't apply to this one
    api.post('/api/rom/inspect', { romId: rom.id, patchId }).then((r) => !off && setInspect(r))
      .catch((e) => { if (!off) { setInspect({ failed: true, info: { unsupported: true } }); setError(e.message); } });
    return () => { off = true; };
  }, [rom?.id, patchId]);

  useEffect(() => {
    let off = false;
    api.get('/api/randomizer/presets').then((r) => {
      if (off) return;
      setMyPresets(r.presets);
      // a restarted run whose settings came from a saved preset
      const mine = presetId === 'custom' && r.presets.find((p) => sameSettings(p.values, values));
      if (mine) { setPresetId(mine.id); setBasedOn(mine.id); }
    }).catch(() => {});
    return () => { off = true; };
  }, []);
  const pickPreset = (p, saved) => {
    setPresetId(p.id);
    setValues(withDefaults(p.values));
    setBasedOn(saved ? p.id : null);
  };
  const gen = inspect?.info?.generation || null;
  const changedIn = (g) => g.fields.filter((f) => f.type !== 'head' && forGen(f, gen) && fieldActive(f, values)
    && JSON.stringify(values[f.key] ?? DEFAULT_VALUES[f.key]) !== JSON.stringify(DEFAULT_VALUES[f.key])).length;

  const game = rom ? gameById(rom.gameId) : null;
  const patch = patchesFor(rom).find((p) => p.id === patchId);
  const hack = patch?.hackId ? hackById(patch.hackId) : null;
  const canRandomize = inspect && !inspect.info?.unsupported;
  const step = { who: 1, game: 2, randomizer: 3, rules: 4, build: 5 };
  const seedSlots = solo || seedMode === 'shared' ? ['p1'] : slots;

  async function build() {
    setBusy(true);
    setError(null);
    setLog([]);
    const players = Object.fromEntries(slots.map((s, i) => [s, { name: names[s].trim() || `P${i + 1}` }]));
    try {
      const res = await api.post('/api/runs/build', {
        // buildValues: drop what this generation lacks – stored in the run, so the other players build the same
        romId: rom.id, patchId, values: buildValues(values, gen), randomize: randomize && canRandomize, mode,
        seeds: Object.fromEntries(slots.map((s) => [s, seeds[seedSlots.includes(s) ? s : 'p1']])), sharedSeed: !solo && seedMode === 'shared',
        players, buildFor: solo || buildFor === 'all' ? slots : ['p1'],
        gameId: game?.variantOf || game?.id || null, gameTitle: hack?.name || (game ? gameTitle(game) : rom.title), hackId: hack?.id || null,
        name: numberedName(defaultRunName(players, mode), status?.runs),
        rules: { ...(solo ? nzRules : from && runMode(from) === 'soullink' ? from.rules || {} : {}), typeHelp },
      });
      setLog(res.log);
      await reloadStatus();
      setRunId(res.manifest.id);
      setMe('p1', res.manifest.id);
      const full = await api.get(`/api/runs/${res.manifest.id}`);
      setResult(full);
      if (names.p1.trim()) api.post('/api/config', { playerName: names.p1.trim() }).catch(() => {});
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }

  if (!roms.length) {
    return html`<div class="panel empty-state"><h2>${t('new.noRoms', 'Add a game first')}</h2>
      <p class="muted">${t('new.noRomsTextRun', 'A run needs a game from your library.')}</p>
      <button class="btn primary" onClick=${() => navigate('library')}>${t('nav.library', 'Library')}</button></div>`;
  }

  if (result) {
    const soloDone = runMode(result) === 'nuzlocke';
    return html`<div class="stack-l">
      <div class="topbar"><h1>${soloDone ? t('new.doneSolo', 'Your Nuzlocke is ready') : t('new.done', 'Your SoulLink is ready')}</h1></div>
      ${soloDone ? html`<section class="panel stack"><p class="muted">${t('new.doneSoloText', 'Your game is built. Start playing – the app files your catches and deaths live, and the board keeps the score.')}</p></section>`
        : html`<section class="panel stack invite-panel"><${InviteBody} manifest=${result} /></section>`}
      ${from && !soloDone && html`<p class="warning info">${t('new.restartInviteHint', 'This is a new run – the invite of “{old}” doesn’t work for it. Send the new one.', { old: from.name })}</p>`}
      <div class="row">
        <button class=${`btn ${soloDone ? 'primary big' : ''}`} onClick=${() => navigate('play', { run: result.id })}><${Icon} name="play" size=${16} />${t('new.playNow', 'Start playing')}</button>
        <button class="btn ghost" onClick=${() => navigate(runMode(result), { run: result.id })}>${soloDone ? t('new.toBoardRun', 'Open the board') : t('new.toBoard', 'Open SoulLink board')}</button>
      </div>
    </div>`;
  }

  const others = slots.slice(1).map((s) => names[s].trim() || t('new.playerN', 'Player {n}', { n: s.slice(1) }));
  return html`<div class="stack-l">
    <div class="topbar"><h1>${from ? t('new.restartTitle', 'New attempt') : solo ? t('new.titleSolo', 'New Nuzlocke') : t('new.titleLink', 'New SoulLink')}</h1>
      <span class="small muted">${solo ? t('new.hostHintSolo', 'Just you – no invite needed.')
        : count > 2 ? t('new.hostHintGroup', 'You host this run – at the end you get an invite code for the others.')
          : t('new.hostHint', 'You host this run – at the end you get an invite for the others.')}</span></div>
    ${from && html`<p class="warning info">${runMode(from) === 'nuzlocke'
      ? t('new.restartTextSolo', 'Same game, ROM hack, randomizer settings and rules as “{old}” – but a new seed, so a new world.', { old: from.name })
      : t('new.restartTextAll', 'Same game, ROM hack, randomizer settings and players as “{old}” – but new seeds, so new worlds. Afterwards {names} need the new invite.', { old: from.name, names: others.join(', ') || t('common.partner', 'Partner') })}</p>`}
    ${error && html`<div class="warning error" role="alert">${error}</div>`}

    <section class="panel stack">
      <h2>${solo ? t('new.stepYou', '{n} · You', { n: step.who }) : t('new.stepWho', '{n} · Who plays', { n: step.who })}</h2>
      ${!solo && html`<${ShapeCards} count=${count} onPick=${setCount} />`}
      <div class="grid-2">
        ${slots.map((s, i) => html`<label class="field" key=${s}><span class="who-label">${!solo && html`<span class="who-mark" style=${`color:var(--${s})`} aria-hidden="true"><${Icon} name="user" size=${13} /></span>`}${i === 0 ? (solo ? t('code.yourName', 'Your name') : t('new.you', 'You'))
          : count === 2 ? t('new.partner', 'Your partner') : t('new.playerN', 'Player {n}', { n: i + 1 })}</span>
          <input type="text" value=${names[s]} maxLength="20" placeholder=${t('new.playerN', 'Player {n}', { n: i + 1 })}
            onInput=${(e) => setNames({ ...names, [s]: e.target.value })} /></label>`)}
      </div>
    </section>

    <section class="panel stack">
      <h2>${t('new.stepGame', '{n} · Game', { n: step.game })}</h2>
      <div class="grid-2">
        <label class="field"><span>${t('new.game', 'Game from your library')}</span>
          <select value=${rom?.id} onChange=${(e) => { setRomId(e.target.value); const r = roms.find((x) => x.id === e.target.value); setPatchId(preferredPatch(r)?.id || null); }}>
            ${roms.map((r) => html`<option value=${r.id}>${gameById(r.gameId) ? gameTitle(gameById(r.gameId)) : r.title || r.name}</option>`)}
          </select></label>
        <label class="field"><span>${t('new.hack', 'ROM hack (optional)')}</span>
          <select value=${patchId || ''} onChange=${(e) => setPatchId(e.target.value || null)}>
            <option value="">${t('new.noHack', 'Original game')}</option>
            ${patchesFor(rom).map((p) => html`<option value=${p.id}>${p.hackId ? hackById(p.hackId)?.name : p.name}</option>`)}
          </select></label>
      </div>
      <p class="small muted">${!inspect ? t('new.checking', 'Checking the game …')
        : inspect.failed ? t('new.checkFailed', 'This combination of game and ROM hack doesn’t work – see the message above.')
        : inspect.info?.missingTool === 'java' ? (solo ? t('new.noJavaSolo', 'Java wasn’t found, so the randomizer can’t run. Install Java (e.g. Temurin 21 from adoptium.net) and restart the app – or play the Nuzlocke without the randomizer.')
          : t('new.noJava', 'Java wasn’t found, so the randomizer can’t run. Install Java (e.g. Temurin 21 from adoptium.net) and restart the app – or play a regular SoulLink.'))
        : inspect.info?.missingTool === 'upr' ? (solo ? t('new.noUprSolo', 'The randomizer (Universal Pokémon Randomizer ZX) is missing – you can still play the Nuzlocke without it.')
          : t('new.noUpr', 'The randomizer (Universal Pokémon Randomizer ZX) is missing – or play a regular SoulLink.'))
        : inspect.info?.unsupported ? (solo ? t('new.noRandomizerSolo', 'This game can’t be randomized – you can still play the Nuzlocke without the randomizer.')
          : t('new.noRandomizer', 'This game can’t be randomized – you can still play a regular SoulLink.'))
        : t('new.ok', '{n} Pokémon · randomizer supported', { n: inspect.info.pokemonCount })}${inspect && inspect.info && inspect.info.staticsSupported === false ? ` · ${t('new.noStatics', 'gifts & legendaries stay as in the hack')}` : ''}</p>
    </section>

    <section class="panel stack">
      <div class="row"><h2>${t('new.stepRandomizer', '{n} · Randomizer', { n: step.randomizer })}</h2><span class="spacer"></span>
        <label class="check"><input type="checkbox" checked=${randomize && canRandomize} disabled=${!canRandomize} onChange=${(e) => setRandomize(e.target.checked)} /><span>${t('common.on', 'On')}</span></label></div>
      ${randomize && canRandomize && html`<div class="stack">
        <div class="preset-list" role="radiogroup">
          ${rnd.presets.map((p) => html`<button class=${`preset ${presetId === p.id ? 'on' : ''}`} role="radio" aria-checked=${presetId === p.id} onClick=${() => pickPreset(p, false)}>
            <span class="radio"></span><span><b>${p.name}</b>${p.id === 'soullink' ? html` <span class="faint small">${t('new.recommended', 'recommended')}</span>` : ''}</span><span class="desc">${p.description}</span></button>`)}
          <${MyPresets} presets=${myPresets} setPresets=${setMyPresets} presetId=${presetId} basedOn=${basedOn} values=${values} groups=${rnd.groups}
            onPick=${(p) => pickPreset(p, true)} />
        </div>
        ${!solo && html`<div class="seg">
          <button class=${seedMode === 'separate' ? 'on' : ''} aria-pressed=${seedMode === 'separate'} onClick=${() => setSeedMode('separate')}>${t('new.ownWorld', 'Each player gets their own world')}</button>
          <button class=${seedMode === 'shared' ? 'on' : ''} aria-pressed=${seedMode === 'shared'} onClick=${() => setSeedMode('shared')}>${count > 2 ? t('new.sameWorldAll', 'Same world for everyone') : t('new.sameWorld', 'Same world for both')}</button>
        </div>`}
        <details class="group"><summary>${t('new.advanced', 'Advanced settings')}</summary>
          <div class="stack" style="padding:4px 0 6px">
            ${rnd.groups.filter((g) => g.fields.some((f) => f.type !== 'head' && forGen(f, gen))).map((g) => html`<details class="group">
              <summary>${g.title}${changedIn(g) > 0 && html`<span class="faint small">${t('new.changedCount', '{n} changed', { n: changedIn(g) })}</span>`}</summary><div class="group-body">
              ${g.fields.filter((f) => forGen(f, gen)).map((f) => html`<${Field} f=${f} gen=${gen} values=${values} value=${values[f.key] ?? DEFAULT_VALUES[f.key]} disabled=${g.id === 'statics' && inspect?.info?.staticsSupported === false}
                onChange=${(v) => { setValues({ ...values, [f.key]: v }); setPresetId('custom'); }} />`)}
            </div></details>`)}
            <details class="group"><summary>${t('new.tweaks', 'Game tweaks')}</summary><div class="group-body">
              ${Object.entries(rnd.tweaks).filter(([k]) => !inspect?.info?.miscTweaks || inspect.info.miscTweaks.includes(k)).map(([k, label]) => html`<label class="check">
                <input type="checkbox" checked=${(values['@miscTweaks'] || []).includes(k)} onChange=${(e) => {
                  const set = new Set(values['@miscTweaks'] || []);
                  if (e.target.checked) set.add(k); else set.delete(k);
                  setValues({ ...values, '@miscTweaks': [...set] });
                  setPresetId('custom');
                }} /><span>${label}</span></label>`)}
            </div></details>
            <details class="group"><summary>${solo ? t('new.seed', 'Seed') : t('new.seeds', 'Seeds')}</summary><div class="stack" style="padding:4px 14px 12px">
              ${seedSlots.map((s) => html`<div class="row nowrap" key=${s}>
                <span class="small muted ellipsis" style="width:90px">${solo ? t('new.seed', 'Seed') : seedMode === 'shared' ? (count > 2 ? t('new.everyone', 'Everyone') : t('new.both', 'Both'))
                  : names[s].trim() || s.toUpperCase()}</span>
                <input type="text" class="mono grow" value=${seeds[s]} onInput=${(e) => setSeeds({ ...seeds, [s]: e.target.value.replace(/[^\d-]/g, '') })} />
                <button class="btn small ghost" onClick=${() => setSeeds({ ...seeds, [s]: randomSeed() })}>${t('new.reroll', 'Reroll')}</button></div>`)}
            </div></details>
          </div>
        </details>
      </div>`}
    </section>

    <section class="panel stack">
      <h2>${t('new.stepRules', '{n} · Rules', { n: step.rules })}</h2>
      ${solo ? html`<p class="small muted">${t('new.rulesHint', 'You can change them later on the board (Rules tab).')}</p>
        <${NuzlockeRules} variant="wizard" value=${nzRules} onChange=${(patch) => setNzRules((v) => ({ ...v, ...patch }))} />`
        : html`<p class="small muted">${count > 2 ? t('new.rulesHintGroup', 'Type rule, dupes clause, level caps and the rest are set together on the board (Rules tab). This one is yours as the host – it applies to everyone, and only you can change it later.')
          : t('new.rulesHintLink', 'Type rule, dupes clause, level caps and the rest are set together on the board (Rules tab). This one is yours as the host – it applies to both of you, and only you can change it later.')}</p>`}
      <div class=${solo ? 'rule-sep' : ''}><${TypeHelpRule} value=${typeHelp} solo=${solo} onChange=${setTypeHelp} /></div>
    </section>

    <section class="panel stack">
      <h2>${t('new.stepBuild', '{n} · Build', { n: step.build })}</h2>
      ${!solo && html`<div class="row small"><span class="muted">${t('new.buildFor', 'Build games for')}</span>
        <div class="seg" role="group" aria-label=${t('new.buildFor', 'Build games for')}><button class=${buildFor === 'all' ? 'on' : ''} aria-pressed=${buildFor === 'all'} onClick=${() => setBuildFor('all')}>${count > 2 ? t('new.forAll', 'All of us') : t('new.forBoth', 'Both of us')}</button>
          <button class=${buildFor === 'me' ? 'on' : ''} aria-pressed=${buildFor === 'me'} onClick=${() => setBuildFor('me')}>${t('new.forMe', 'Only me')}</button></div></div>`}
      <div class="row">
        <button class="btn primary big" disabled=${busy || !inspect || inspect.failed} onClick=${build}><${Icon} name=${solo ? 'play' : 'link'} size=${16} />${busy ? t('new.building', 'Building …')
          : solo ? t('new.createSolo', 'Start Nuzlocke') : t('new.create', 'Create SoulLink')}</button>
      </div>
      ${log.length > 0 && html`<div class="log">${log.join('\n')}</div>`}
    </section>
  </div>`;
}

/** Invite input: drop or pick the .soullink.json file, or paste the copied invite text. */
function InviteDrop({ onText }) {
  const [over, setOver] = useState(false);
  const [text, setText] = useState('');
  const fromFile = (f) => f && f.text().then(onText, () => {}); // (an unreadable file: nothing happens, like a cancelled pick)
  return html`<div class="stack">
    <label class=${`dropzone ${over ? 'over' : ''}`}
      onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)}
      onDrop=${(e) => { e.preventDefault(); setOver(false); fromFile(e.dataTransfer.files[0]); }}>
      <input type="file" accept=".json,application/json" class="sr-only" onChange=${(e) => fromFile(e.target.files[0])} />
      <${Icon} name="load" size=${32} />
      <p class="px" style="font-size:15px;margin-top:6px">${t('join.drop', 'Drop the invite here or click to open it')}</p>
      <p class="small faint">${t('join.fileHint', 'The file ends with .soullink.json')}</p>
    </label>
    <div class="row"><input type="text" class="grow mono small" value=${text} placeholder=${t('join.pastePh', '… or paste the copied invite')}
      onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && text.trim() && onText(text.trim())} />
      <button class="btn" disabled=${!text.trim()} onClick=${() => onText(text.trim())}>${t('join.paste', 'Use invite')}</button></div>
  </div>`;
}

function JoinRun() {
  const { manifest, reloadStatus, setRunId, setMe, toast, library, navigate, reloadManifest, me, status, doc } = useApp();
  const [pack, setPack] = useState(manifest?.imported && !Object.keys(manifest.outputs || {}).length ? manifest : null);
  const [slot, setSlot] = useState(pack && me ? me : null); // a restart offer already knows our slot
  const [taken, setTaken] = useState([]); // slots the host says have somebody already (code invites only)
  // what this player calls themselves – typed with the code, else the name from the settings. It wins over the
  // name the host put into the run for this seat.
  const [myName, setMyName] = useState(status?.config?.playerName || '');
  // An invite imported elsewhere (restart offer) can finish loading after this page opened.
  useEffect(() => {
    if (!pack && manifest?.imported && !Object.keys(manifest.outputs || {}).length) {
      setPack(manifest);
      if (me) setSlot(me);
    }
  }, [manifest?.id]);
  const slots = pack ? slotsOf(pack) : [];
  // Without a hint (invite file) the host is taken to be P1 – the first free player after them is us.
  const mine = slots.includes(slot) ? slot : suggestSlot(pack?.players, ['p1']) || slots[0] || 'p1';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [log, setLog] = useState([]);
  const baseCrc = pack?.base?.crc;
  const rom = library?.roms?.find((r) => r.crc === baseCrc);
  const patch = pack?.patch ? library?.patches?.find((p) => p.sha1 === pack.patch.sha1) || library?.patches?.find((p) => p.expectedCrc === baseCrc) : null;

  // seat: the host's hint with a code invite – { slot, taken } (see JoinCode); none with an invite file
  const load = async (text, seat = null) => {
    setError(null);
    try {
      const m = await api.post('/api/runs/import', { pack: JSON.parse(String(text).replace(/^\uFEFF/, '').trim()) }); // an editor may have added a BOM
      const s = runMode(m) === 'nuzlocke' ? 'p1'
        : seat?.slot ?? suggestSlot(m.players, seat ? seat.taken || [] : ['p1'], status?.config?.playerName) ?? slotsOf(m).at(-1);
      await reloadStatus();
      setRunId(m.id);
      setMe(s, m.id);
      setSlot(s);
      setTaken(seat?.taken || []);
      if (seat?.name) setMyName(seat.name);
      setPack(m);
    } catch (e) {
      // a cut-off or edited file fails in JSON.parse – the browser's own message (English, "position 5") helps nobody
      setError(e instanceof SyntaxError ? t('join.notJson', 'This invite is incomplete or damaged. Ask for the invite file again, or copy the whole text.')
        : e.code === 'runIsLocal' ? t('join.ownRun', 'You created this run on this computer – it’s already in your runs. The invite is for the other players.')
          : t('join.bad', 'This is not a valid SoulLink invite: {msg}', { msg: e.message }));
    }
  };
  const withMyName = () => (myName.trim() && pack.players?.[mine] ? { ...pack.players, [mine]: { ...pack.players[mine], name: myName.trim() } } : pack.players);
  const build = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/api/runs/build', {
        runId: pack.id, romId: rom.id, patchId: patch?.id || null, values: pack.randomizer.values, randomize: pack.randomizer.enabled,
        seeds: pack.randomizer.seeds, sharedSeed: pack.randomizer.sharedSeed, players: withMyName(), buildFor: [mine], name: pack.name, mode: runMode(pack),
        expectedOutputs: pack.expectedOutputs, rules: pack.rules, gameId: pack.game?.id, hackId: pack.game?.hackId,
        // same file name as the host's ("Robin – Silberne Edition Randomized.gbc", not the raw header title)
        gameTitle: pack.patch?.name || (gameById(pack.game?.id) ? gameTitle(gameById(pack.game.id)) : undefined),
      });
      setLog(res.log);
      setMe(mine, pack.id);
      // The shared doc still has the host's name for this seat. Ours goes in as the newest write, so the sync hands
      // it to everyone – right away when the run's doc is open, else once it opens (app.mjs).
      const name = myName.trim();
      if (name && doc?.runId === pack.id) doc.set(`player:${mine}`, { ...(doc.get(`player:${mine}`) || {}), name });
      else if (name) try { localStorage.setItem(`sl-joinname-${pack.id}`, JSON.stringify({ slot: mine, name })); } catch {}
      await reloadStatus();
      await reloadManifest(pack.id);
      toast({ kind: 'ok', title: t('join.ready', 'You’re in!'), text: t('join.readyText', 'Your game is built – have fun.') });
      navigate('soullink', { run: pack.id });
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };

  return html`<div class="stack-l">
    <div class="topbar"><h1>${t('join.title', 'Join a SoulLink')}</h1>
      <button class="btn small ghost" onClick=${() => navigate('soullink', { new: '' })}>${t('join.hostInstead', 'No invite? Host one yourself')}</button></div>
    <p class="muted">${t('join.introAny', 'Somebody created the run. Enter the code they give you – the app fetches the invite, builds the same game from your own copy and connects you.')}</p>
    ${error && html`<div class="warning error" role="alert">${error}</div>`}
    <section class="panel stack">
      <h2>${pack ? t('join.step1', '1 · Open the invite') : t('join.step1Code', '1 · Enter the invite code')}</h2>
      ${pack ? html`<p class="note">${t('join.loaded', 'Invite from {name}: {run}', { name: pack.players?.p1?.name || 'P1',
          run: runMode(pack) === 'nuzlocke' ? t('runs.modeSolo', 'Solo Nuzlocke')
            : t('join.loadedLink', 'SoulLink with {n} players ({names})', { n: slots.length, names: joinNames(slots.map((s) => pack.players?.[s]?.name || s.toUpperCase())) }) })}</p>`
        : html`<${JoinCode} onPack=${(p, seat) => load(JSON.stringify(p), seat)} />
          <details class="group"><summary>${t('join.fileInstead', 'Or use an invite file')}</summary><div style="padding:4px 14px 12px"><${InviteDrop} onText=${load} /></div></details>`}
    </section>
    ${pack && html`<section class="panel stack">
      <h2>${t('join.step2', '2 · Your game')}</h2>
      ${rom ? html`<p class="small"><span class="chip ok">${t('join.found', 'Found in your library')}</span> <span class="mono">${rom.name}</span></p>`
        : html`<p class="warning">${t('join.missing', 'Add your own copy of the base game (CRC32 {crc}) to the library first.', { crc: baseCrc })}</p>
          <div><button class="btn" onClick=${() => navigate('library')}>${t('nav.library', 'Library')}</button></div>`}
      ${pack.patch && (patch ? html`<p class="small"><span class="chip ok">${t('join.patchFound', 'Patch found')}</span> <span class="mono">${patch.name}</span></p>`
        : html`<p class="warning">${t('join.patchMissing', 'Add the patch for {hack} to your library.', { hack: pack.patch.name })}</p>`)}
      ${slots.length > 1 && html`<div class="row small"><span class="muted">${t('join.iAm', 'I am')}</span>
        <div class="seg" role="radiogroup">${slots.map((s) => html`<button role="radio" aria-checked=${mine === s} class=${mine === s ? 'on' : ''} onClick=${() => setSlot(s)}
          title=${taken.includes(s) ? t('join.takenTitle', 'Already in the run') : ''} style=${taken.includes(s) && mine !== s ? 'opacity:.55' : ''}>${pack.players?.[s]?.name || s.toUpperCase()}</button>`)}</div></div>
        ${myName.trim() && pack.players?.[mine]?.name !== myName.trim() && html`<p class="small muted">${t('join.asName', 'You’ll play as {name} – that’s the name the others see.', { name: myName.trim() })}</p>`}
        ${taken.includes(mine) && html`<p class="small warning info">${t('join.takenHint', 'The host’s app says {name} is already in the run. Only pick it if that’s you on another computer.', { name: pack.players?.[mine]?.name || mine.toUpperCase() })}</p>`}`}
      <div><button class="btn primary big" disabled=${busy || !rom || (pack.patch && !patch)} onClick=${build}>${busy ? t('new.building', 'Building …') : t('join.build', 'Build my game & join')}</button></div>
      ${log.length > 0 && html`<div class="log">${log.join('\n')}</div>`}
    </section>`}
  </div>`;
}
