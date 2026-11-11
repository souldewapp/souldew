import { html } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { gameById, gameTitle, hackById } from '../lib/data.mjs';
import { runMode } from '/shared/slots.mjs';
import { Cart, coverOf } from './library.mjs';
import { RunCard, runState, useStatusPoll } from './soullink.mjs';

/** The Play page without a game picked (no rail item of its own anymore – reached after closing a game, from
 * "Play something else" and from first steps): the runs still going, to jump back in, and the games of the
 * library to play on their own. The record and all runs live in the SoulLink and Nuzlocke overviews. */
export function PlayHome() {
  const { status, library, navigate } = useApp();
  useStatusPoll();
  const runs = (status?.runs || []).filter((r) => Object.keys(r.outputs || {}).length && runState(r) === 'active')
    .sort((a, b) => (b.summary?.lastPlayed || 0) - (a.summary?.lastPlayed || 0));
  const roms = (library?.roms || []).slice(0, 24);
  const sections = html`<div class="row">
    <button class="btn" onClick=${() => navigate('soullink')}><${Icon} name="link" size=${16} />${t('play.toSoulLinks', 'All SoulLinks')}</button>
    <button class="btn" onClick=${() => navigate('nuzlocke')}><${Icon} name="ball" size=${16} />${t('play.toNuzlockes', 'All Nuzlockes')}</button></div>`;
  if (library && !roms.length && !runs.length) {
    return html`<div class="stack-l">
      <div class="topbar"><h1>${t('nav.play', 'Play')}</h1></div>
      <div class="panel empty-state">
        <${Icon} name="play" size=${64} />
        <h2>${t('play.emptyTitle', 'Nothing to play yet')}</h2>
        <p class="muted prose">${t('play.emptyTextRun', 'Add your Pokémon ROMs to the library – then you can play them right here or start a SoulLink or a Nuzlocke with them.')}</p>
        <div class="row"><button class="btn primary big" onClick=${() => navigate('library')}><${Icon} name="plus" size=${16} />${t('play.addGames', 'Add games')}</button></div>
      </div>
    </div>`;
  }
  return html`<div class="stack-l">
    <div class="topbar"><h1>${t('nav.play', 'Play')}</h1>${sections}</div>
    ${runs.length > 0 && html`<section class="stack"><h2>${t('play.continueRuns', 'Continue a run')}</h2><div class="shelf">
      ${runs.map((r) => html`<${RunCard} key=${r.id} r=${r} onOpen=${() => navigate('play', { run: r.id })}
        actions=${html`<button class="btn small go" onClick=${() => navigate('play', { run: r.id })}><${Icon} name="play" size=${14} />${t('runs.continue', 'Continue')}</button>
          <button class="btn small ghost" onClick=${() => navigate(runMode(r), { run: r.id })}>${t('runs.board', 'Board')}</button>`} />`)}</div></section>`}
    <section class="stack"><h2>${t('play.games', 'Just play')}</h2>
      ${roms.length === 0 ? html`<div class="row"><p class="muted">${t('play.noGamesText', 'Your library is empty – add a ROM to play it on its own.')}</p>
        <button class="btn small" onClick=${() => navigate('library')}><${Icon} name="plus" size=${14} />${t('play.addGames', 'Add games')}</button></div>` : html`<div class="shelf">
        ${roms.map((r) => {
          const g = gameById(r.gameId);
          const h = r.hackId ? hackById(r.hackId) : null; // a pre-patched ROM hack: shown as the hack
          return html`<${Cart} key=${r.id} title=${h ? h.name : g ? gameTitle(g) : r.title || r.name} cover=${coverOf(library, h ? { hackId: h.id } : { rom: r })} color=${h?.color || g?.color} system=${r.system} owned hack=${!!h}
            onClick=${() => navigate('play', { rom: r.id })} />`;
        })}</div>`}
    </section>
  </div>`;
}
