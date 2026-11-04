// "First steps": the tutorial after the welcome tour – a checklist from an empty app to the first linked catch.
// Each step ticks itself off from what the app sees (library, runs, live data) and has one button that leads there.
// Someone who only plays solo Nuzlockes has nobody to connect with: that step drops out for them.
// Shown on the start pages until done or hidden; the pill in the side rail brings it back.
import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { slotsOf, runMode } from '/shared/slots.mjs';

const HIDE_KEY = 'sl-firststeps-hidden';
const OPEN_EVENT = 'sl-firststeps-open';

function readHidden() {
  try {
    return localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
}
function writeHidden(v) {
  try {
    if (v) localStorage.setItem(HIDE_KEY, '1');
    else localStorage.removeItem(HIDE_KEY);
  } catch {
    // storage blocked – it just shows again next time
  }
}

/**
 * The steps and whether each is done, from the app's state. `mode` 'nuzlocke': the solo path of the Nuzlocke
 * overview – no co-players to connect, only Nuzlocke runs count.
 */
export function useFirstSteps(mode) {
  const { library, status, partnerOnline, session, navigate } = useApp();
  const nuzlocke = mode === 'nuzlocke';
  const runs = (status?.runs || []).filter((r) => !nuzlocke || runMode(r) === 'nuzlocke');
  const live = (r) => r.summary?.live || {};
  const soloOnly = nuzlocke || (runs.length > 0 && runs.every((r) => runMode(r) === 'nuzlocke'));
  const done = {
    game: (library?.roms?.length || 0) > 0,
    run: runs.length > 0,
    // joined somebody's run, or two players of one run have played
    partner: partnerOnline || runs.some((r) => runMode(r) !== 'nuzlocke' && (r.imported || slotsOf(r).filter((s) => live(r)[s]).length > 1)),
    play: !!session || runs.some((r) => Object.values(live(r)).some(Boolean)),
    catch: runs.some((r) => (r.summary?.caught || 0) > 0),
  };
  const firstRun = runs.find((r) => Object.keys(r.outputs || {}).length) || runs[0];
  // a run's board sits in the section of its mode (SoulLink or Nuzlocke)
  const toBoard = () => (firstRun ? navigate(runMode(firstRun), { run: firstRun.id }) : navigate('soullink'));
  const steps = [
    { id: 'game', title: t('fs.game', 'Add your game'), text: t('fs.gameText', 'Drop the ROM of a Pokémon game you own into the library (or pick a folder).'),
      action: t('fs.gameGo', 'Open the library'), go: () => navigate('library') },
    nuzlocke ? { id: 'run', title: t('fs.runSolo', 'Start a Nuzlocke'), text: t('fs.runSoloText', 'Pick your game, the rules (Classic, Hardcore or your own) and build – you play it on your own.'),
      action: t('runs.newSolo', 'New Nuzlocke'), go: () => navigate('nuzlocke', { new: '' }) }
    : { id: 'run', title: t('fs.runAny', 'Start a SoulLink (2–4) or a solo Nuzlocke – or join one'),
      text: t('fs.runTextNav', 'SoulLink (in the sidebar): one of you hosts (game, randomizer, rules), the others join with the 6-digit code. A Nuzlocke you start under “Nuzlocke” and play on your own.'),
      action: t('fs.runGoLink', 'SoulLink'), go: () => navigate('soullink'),
      alt: { action: t('fs.runGoSolo', 'Nuzlocke'), go: () => navigate('nuzlocke') } },
    { id: 'partner', title: t('fs.partner', 'Connect with your co-players'), text: t('fs.playersText', 'The host creates a code on the board (“Invite player”) and tells it to the others – their apps fetch the run once the host allows it.'),
      action: t('fs.playersGo', 'Invite players'), go: toBoard },
    { id: 'play', title: t('fs.play', 'Start the game'), text: soloOnly ? t('fs.playTextSoloNav', 'Press “Play” on the board or “Continue” in the overview. Your team shows up live on the board as soon as you have Pokémon.')
      : t('fs.playTextAllNav', 'Press “Play” on the board or “Continue” in the overview. Your team shows up live on everyone’s board as soon as you have Pokémon.'),
      action: t('fs.playGo', 'Play'), go: () => (firstRun ? navigate('play', { run: firstRun.id }) : navigate('play')) },
    soloOnly
      ? { id: 'catch', title: t('fs.catchSolo', 'Your first catch'), text: t('fs.catchSoloText', 'Catch the first Pokémon of an area – the app files it as that area’s encounter.'),
        action: t('fs.catchGo', 'To the board'), go: toBoard }
      : { id: 'catch', title: t('fs.catch', 'Your first linked catch'), text: t('fs.catchTextAll', 'Catch the first Pokémon of an area – the app files it, and the others’ catches there are linked to it.'),
        action: t('fs.catchGo', 'To the board'), go: toBoard },
  ].filter((s) => !(soloOnly && s.id === 'partner')).map((s) => ({ ...s, done: done[s.id] }));
  return { steps, soloOnly, count: steps.filter((s) => s.done).length, complete: steps.every((s) => s.done) };
}

/** The checklist card at the top of the start pages. */
export function FirstSteps({ mode } = {}) {
  const { steps, soloOnly, count, complete } = useFirstSteps(mode);
  const [hidden, setHidden] = useState(readHidden);
  useEffect(() => {
    const open = () => setHidden(false);
    addEventListener(OPEN_EVENT, open);
    return () => removeEventListener(OPEN_EVENT, open);
  }, []);
  if (hidden || complete) return null;
  const next = steps.find((s) => !s.done);
  return html`<section class="panel first-steps" aria-label=${t('fs.title', 'First steps')}>
    <div class="fs-head">
      <div><h2>${t('fs.title', 'First steps')}</h2><p class="small muted">${soloOnly ? t('fs.leadSolo', 'From zero to your first catch – {done} of {all} done.', { done: count, all: steps.length })
        : t('fs.lead', 'From zero to your first linked catch – {done} of {all} done.', { done: count, all: steps.length })}</p></div>
      <div class="fs-bar" role="progressbar" aria-valuemin="0" aria-valuemax=${steps.length} aria-valuenow=${count}><i style=${`width:${(count / steps.length) * 100}%`}></i></div>
      <button class="btn small ghost" onClick=${() => { writeHidden(true); setHidden(true); }}>${t('fs.hide', 'Hide')}</button>
    </div>
    <ol class="fs-list">
      ${steps.map((s, i) => html`<li class=${`fs-step ${s.done ? 'done' : ''} ${s === next ? 'next' : ''}`}>
        <span class="fs-num" aria-hidden="true">${s.done ? html`<${Icon} name="check" size=${12} />` : i + 1}</span>
        <div class="fs-body"><b>${s.title}</b>${s === next && html`<span class="small muted">${s.text}</span>`}</div>
        ${s === next && html`<div class="fs-actions"><button class="btn small primary" onClick=${s.go}>${s.action}</button>
          ${s.alt && html`<button class="btn small" onClick=${s.alt.go}>${s.alt.action}</button>`}</div>`}
        ${s.done && html`<span class="sr-only">${t('fs.doneSr', 'done')}</span>`}
      </li>`)}
    </ol>
  </section>`;
}

/** Side-rail pill: progress at a glance, a click brings the checklist back. */
export function FirstStepsPill() {
  const { steps, count, complete } = useFirstSteps();
  const { navigate } = useApp();
  if (complete) return null;
  return html`<button class="fs-pill no-drag" onClick=${() => { writeHidden(false); navigate('library'); setTimeout(() => dispatchEvent(new Event(OPEN_EVENT)), 0); }}
    title=${t('fs.pillHint', 'Show the first steps')}>
    <span class="fs-pill-ring" style=${`--p:${count / steps.length}`}></span>
    <span><b>${t('fs.title', 'First steps')}</b><span class="tiny muted">${t('fs.pillCount', '{done} of {all}', { done: count, all: steps.length })}</span></span>
  </button>`;
}
