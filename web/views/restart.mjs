// Ending a run and trying again: the "run is over" notice, the "new attempt" dialog (a new run with the old
// run's settings and new seeds) and the offer to the other players to join that new attempt. A run has 1–4
// players; a solo Nuzlocke has nobody to tell.
import { html, useState } from '/vendor/htm-preact.mjs';
import { useApp, Modal, Sprite } from '../lib/ui.mjs';
import { counts, players as getPlayers, live, resumeRun, runMode, slotsOf, runStats } from '../lib/run.mjs';
import { speciesName } from '../lib/data.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { restartRun } from '../lib/restart.mjs';
import { api } from '../lib/api.mjs';
import { numberedName, baseName } from '/shared/restart.mjs';

/** r: the old run (status list entry or manifest). rules: its live doc rules, if at hand (board). */
export function RestartModal({ r, rules, onClose }) {
  const { navigate, setRunId, setMe, reloadStatus, toast, status, doc, manifest, me } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const next = numberedName(baseName(r.name), status?.runs);
  const solo = runMode(r) === 'nuzlocke';
  const n = slotsOf(r).length;
  // a manifest knows; a run-list entry may not (then the line is left out rather than guessed)
  const randomized = r.randomizer ? r.randomizer.enabled !== false : typeof r.randomized === 'boolean' ? r.randomized : null;
  const close = () => !busy && onClose();
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await restartRun(r, { runs: status?.runs, ...(rules ? { rules } : {}) });
      // Tell the partner through the old run's document: it syncs right away when they're connected, otherwise
      // the next time they open the old run – and their app offers to join the new one.
      if (doc && manifest?.id === r.id && runMode(r) !== 'nuzlocke') doc.set('run:restart', { id: res.manifest.id, name: res.manifest.name, by: me, at: Date.now(), pack: res.pack });
      await reloadStatus();
      setRunId(res.manifest.id);
      setMe(res.mySlot, res.manifest.id);
      toast({ kind: 'ok', title: t('restart.done', 'New run started'), text: res.manifest.name });
      onClose();
      navigate('soullink', { run: res.manifest.id });
    } catch (e) {
      setError(e.code === 'no-rom' ? t('restart.noRom', 'The game of this run isn’t in your library anymore. Add it again or pick another one under “Change settings first”.')
        : e.code === 'no-patch' ? t('restart.noPatch', 'The ROM hack of this run isn’t in your library anymore. Add it again or pick another one under “Change settings first”.')
        : e.message);
      setBusy(false);
    }
  };
  const edit = () => {
    onClose();
    navigate('soullink', { new: '', from: r.id });
  };
  return html`<${Modal} open=${true} onClose=${close} title=${t('restart.title', 'New attempt')}
    footer=${html`<button class="btn ghost" disabled=${busy} onClick=${close}>${t('common.cancel', 'Cancel')}</button>
      <button class="btn ghost" disabled=${busy} onClick=${edit}>${t('restart.edit', 'Adjust settings …')}</button>
      <button class="btn primary" disabled=${busy} onClick=${go}><${Icon} name="reset" size=${14} />${busy ? t('new.building', 'Building …') : t('restart.go', 'Start new attempt')}</button>`}>
    <p>${t('restart.text', 'This creates the new run “{name}”:', { name: next })}</p>
    <ul class="restart-list">
      <li>${solo ? t('restart.same1Solo', 'same game or ROM hack, same rules') : t('restart.same1', 'same game or ROM hack, same rules, same players')}</li>
      ${randomized === true && html`<li>${t('restart.same2', 'randomizer with the same options – but a new seed, so new Pokémon')}</li>`}
      ${randomized === false && html`<li>${t('restart.same2NoRnd', 'no randomizer – the same Pokémon as last time')}</li>`}
      ${!solo && html`<li>${n > 2 ? t('restart.same3Group', 'the other players get an invitation to join right away') : t('restart.same3', 'your partner gets an invitation to join right away')}</li>`}
    </ul>
    <p class="small faint">${t('restart.note', 'Saves, encounters and the board start empty. “{old}” stays in your list as it is.', { old: r.name })}</p>
    ${busy && html`<p class="small muted" role="status">${t('restart.building', 'Building the new games – this can take a minute …')}</p>`}
    ${error && html`<div class="warning error" role="alert">${error}</div>`}
  <//>`;
}

/**
 * The partner restarted the run: offer to join the new one. offer = the old doc's `run:restart` entry
 * ({ id, name, by, pack }). Joining imports the pack and opens the usual join page (own ROM, slot preselected).
 */
export function RestartOffer({ offer, onClose }) {
  const { navigate, setRunId, setMe, reloadStatus, doc, manifest, closeSession, me } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!offer) return null;
  const name = (manifest?.players?.[offer.by]?.name) || (doc?.get(`player:${offer.by}`)?.name) || t('common.partner', 'Partner');
  // The running game belongs to the old run – close it first (asks when progress isn't saved in-game).
  const join = () => closeSession(doJoin);
  const doJoin = async () => {
    setBusy(true);
    setError(null);
    try {
      const m = await api.post('/api/runs/import', { pack: offer.pack });
      await reloadStatus();
      setRunId(m.id);
      // a new attempt keeps every player's slot – ours is the one we had in the old run
      setMe(me, m.id);
      onClose();
      navigate('soullink', { join: '' });
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return html`<${Modal} open=${true} onClose=${() => !busy && onClose()} title=${t('restart.offerTitle', '{name} started a new attempt', { name })}
    footer=${html`<button class="btn ghost" disabled=${busy} onClick=${onClose}>${t('restart.offerLater', 'Later')}</button>
      <button class="btn primary" disabled=${busy} onClick=${join}><${Icon} name="reset" size=${14} />${t('restart.offerJoin', 'Join “{run}”', { run: offer.name })}</button>`}>
    <p>${manifest?.randomizer?.enabled === false
      ? t('restart.offerTextNoRnd', 'Same game, same rules – a fresh start. Your app builds the new game from your own copy, like the first time.')
      : t('restart.offerText', 'Same game, same rules, same randomizer settings – new seeds. Your app builds the new game from your own copy, like the first time.')}</p>
    ${error && html`<div class="warning error" role="alert">${error}</div>`}
  <//>`;
}

/**
 * The run just ended (a team wiped – in a Nuzlocke a blackout or a death in a deathless run –, or someone marked
 * it failed / won): a notice for every player with the next steps – a new attempt, the board, or (if it was a
 * mistake) playing on.
 */
export function RunOverNotice({ status, onClose }) {
  const { doc, manifest, me, navigate, runData } = useApp();
  const [restart, setRestart] = useState(false);
  if (!status || !doc || !manifest) return null;
  if (restart) return html`<${RestartModal} r=${manifest} rules=${doc.get('rules')} onClose=${() => { setRestart(false); onClose(); }} />`;
  const names = getPlayers(doc, manifest);
  const c = counts(doc, manifest);
  const won = status.state === 'won';
  const solo = runMode(manifest) === 'nuzlocke';
  const n = slotsOf(manifest).length;
  const who = names[status.by]?.name || '';
  const team = (live(doc, status.by)?.party || []).filter((m) => m.species && !m.egg);
  const gen = runData?.gen || 4;
  const text = won ? (solo ? t('over.wonTextSolo', 'Champion beaten – congratulations, you made it!')
    : n > 2 ? t('over.wonTextGroup', 'Champion beaten – congratulations to all of you!') : t('over.wonText', 'Champion beaten – congratulations to both of you!'))
    : !status.auto ? (status.by === me ? t('over.failedMine', 'You ended the run as failed.') : t('over.failedText', '{name} ended the run as failed.', { name: who }))
      : solo ? (status.reason === 'deathless' ? t('over.deathlessSolo', 'A Pokémon died – in a deathless run that ends the Nuzlocke.')
        : t('over.blackoutSolo', 'Your team blacked out – the Nuzlocke is over.'))
        : status.by === me ? (n > 2 ? t('over.wipedMineGroup', 'Your team blacked out – the run is over for everyone.') : t('over.wipedMine', 'Your whole team is down – the SoulLink is over.'))
          : n > 2 ? t('over.wipedGroup', '{name} blacked out – the run is over for everyone.', { name: who })
            : t('over.wipedPartner', '{name}’s whole team is down – the SoulLink is over.', { name: who });
  // a Nuzlocke's summary: its own numbers (run.mjs runStats); a SoulLink counts its groups
  const st = solo ? runStats(doc, manifest, 'p1') : null;
  const killer = st?.deadliest?.[0];
  return html`<${Modal} open=${true} onClose=${onClose} title=${won ? t('over.wonTitle', 'Run won!') : t('over.failedTitle', 'Run failed')}
    footer=${html`${!won && html`<button class="btn ghost" onClick=${() => { resumeRun(doc, me); onClose(); }}
        title=${t('over.resumeHint', 'Undo: the run goes on as before, tracking resumes.')}>${t('over.resume', 'Mistake – play on')}</button>`}
      <button class="btn ghost" onClick=${() => { onClose(); navigate('soullink', { run: manifest.id }); }}>${t('over.board', 'To the board')}</button>
      ${!won && html`<button class="btn primary" onClick=${() => setRestart(true)}><${Icon} name="reset" size=${14} />${t('over.again', 'New attempt …')}</button>`}`}>
    <div class=${`run-over ${won ? 'won' : 'failed'}`}>
      ${team.length > 0 && html`<div class="run-over-team">${team.map((m) => html`<${Sprite} id=${m.species} size=${48} gen=${gen} />`)}</div>`}
      <p class="run-over-text">${text}</p>
      <p class="small muted">${solo ? t('over.statsSolo', '{caught} caught · {alive} alive · {dead} died · {missed} got away', { caught: st.caught, alive: st.alive, dead: st.dead, missed: st.missed })
        : n > 2 ? t('over.statsGroup', '{alive} groups alive · {dead} died', { alive: c.linked, dead: c.dead })
          : t('over.stats', '{alive} pairs alive · {dead} died', { alive: c.linked, dead: c.dead })}</p>
      ${solo && (killer || st.bossesBeaten != null) && html`<p class="small muted">${[
        st.bossesBeaten != null ? t('over.bosses', 'Bosses beaten: {n}', { n: st.bossesBeaten }) : null,
        killer ? t('over.deadliest', 'Deadliest opponent: {name} ({n}×)', { name: speciesName(killer.species), n: killer.kills }) : null,
      ].filter(Boolean).join(' · ')}</p>`}
      ${!won && html`<p class="small faint">${t('over.stopped', 'Tracking is stopped – nothing is recorded anymore until you start a new attempt or play on.')}</p>`}
    </div>
  <//>`;
}
