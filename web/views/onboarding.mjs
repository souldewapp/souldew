import { html, useState, useRef, useEffect } from '/vendor/htm-preact.mjs';
import { useApp, Sprite } from '../lib/ui.mjs';
import { Icon, AppMark } from '../lib/icons.mjs';
import { LANGS, t, setLang, currentLang } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { PRESETS, presetMap, activePreset, keyLabel, padFamily, padLabel } from '../lib/controls.mjs';
import { addGamesFlow, DropZone, DiscoverModal } from './library.mjs';
import { ThemePicker, usePads, FAMILY_NAMES, PAD_POS } from './settings.mjs';

/**
 * Welcome tour, once: language → name → how a SoulLink works (and the solo Nuzlocke) → look & accessibility →
 * controls → games → how to start (new run / join / just play). It ends where the chosen path begins; the "First steps" checklist
 * (firststeps.mjs) takes over from there.
 */
export function Onboarding({ onDone }) {
  const { status, reloadStatus, reloadLibrary, library, toast, navigate } = useApp();
  const cfg = status?.config || {};
  const [step, setStep] = useState(0);
  const [name, setName] = useState(cfg.playerName || '');
  const [theme, setTheme] = useState(cfg.theme || 'classic');
  const [anim, setAnim] = useState(cfg.bootAnimation !== false);
  const [sounds, setSounds] = useState(cfg.sounds !== false);
  const [controls, setControls] = useState(cfg.controls || null);
  const [discover, setDiscover] = useState(false);
  const [, force] = useState(0);
  const nameRef = useRef(null);
  const panelRef = useRef(null);
  const pads = usePads();
  // Move focus into the new step so keyboard and screen-reader users land on its first control.
  useEffect(() => {
    const id = setTimeout(() => {
      if (step === 1) return nameRef.current?.focus();
      const root = panelRef.current;
      const el = root?.querySelector('[aria-checked="true"]') || root?.querySelector('button:not([disabled]), input, select, textarea, [href]');
      (el || root)?.focus();
    }, 30);
    return () => clearTimeout(id);
  }, [step]);
  const owned = library?.roms?.length || 0;
  const save = (patch) => api.post('/api/config', patch).catch(() => {});

  const finish = async (path) => {
    await api.post('/api/config', { onboarded: true, playerName: name.trim(), lang: currentLang(), theme, bootAnimation: anim, sounds, controls });
    await reloadStatus();
    onDone();
    if (path === 'host') navigate('soullink', { new: '' });
    else if (path === 'nuzlocke') navigate('nuzlocke', { new: '' });
    else if (path === 'join') navigate('soullink', { join: '' });
    else navigate('library');
  };

  const choice = (icon, title, text, path, primary) => html`<button type="button" class=${`onb-choice ${primary ? 'primary' : ''}`} onClick=${() => finish(path)}>
    <span class="onb-choice-icon"><${Icon} name=${icon} size=${22} /></span><b>${title}</b><span class="small muted">${text}</span></button>`;

  const STEPS = [
    { id: 'lang', label: t('onb.sLang', 'Language'), body: html`<div class="stack-l">
      <div class="onb-hero"><${AppMark} size=${88} /><div><h1>${t('onb.welcome', 'Welcome to souldew')}</h1>
        <p class="muted">${t('onb.tagline', 'Play Pokémon SoulLinks together: built-in emulator, live tracking of both teams, randomizer and rules – all in one app.')}</p></div></div>
      <p class="small muted">${t('onb.pickLanguage', 'Choose your language. You can change it later in the settings.')}</p>
      <div class="lang-grid" role="radiogroup">
        ${LANGS.map((l) => html`<button role="radio" aria-checked=${currentLang() === l.id} class=${currentLang() === l.id ? 'on' : ''}
          onClick=${async () => { await setLang(l.id); await save({ lang: l.id }); force((x) => x + 1); }}>
          <b>${l.native}</b>${l.name !== l.native && html`<span>${l.name}</span>`}</button>`)}
      </div>
    </div>` },
    { id: 'name', label: t('onb.sName', 'Name'), valid: () => name.trim().length > 0, body: html`<div class="stack-l">
      <div class="stack-s"><h1>${t('onb.nameTitleAny', 'What’s your name?')}</h1>
        <p class="muted">${t('onb.nameTextAny', 'Your name appears on the board – and in the apps of the other players when you play a SoulLink together.')}</p></div>
      <input type="text" ref=${nameRef} value=${name} maxLength="20" placeholder=${t('onb.namePlaceholder', 'Your name')} class="onb-name"
        onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && name.trim() && setStep(2)} />
    </div>` },
    { id: 'how', label: t('onb.sHow', 'SoulLink'), body: html`<div class="stack-l">
      <div class="stack-s"><h1>${t('onb.howTitle', 'How a SoulLink works')}</h1>
        <p class="muted">${t('onb.howTextAny', '2 to 4 players, one game each, one fate. The app keeps score for you – live.')}</p></div>
      <div class="onb-pair" aria-hidden="true">
        <div class="onb-mon p1"><${Sprite} id=${152} size=${56} gen=${4} /><span>${name.trim() || t('common.you', 'you')}</span></div>
        <svg viewBox="0 0 120 26" preserveAspectRatio="none"><path d="M1 13 C 30 2, 50 24, 60 13 S 92 2, 119 13" /></svg>
        <div class="onb-mon p2"><${Sprite} id=${155} size=${56} gen=${4} /><span>${t('common.partner', 'Partner')}</span></div>
      </div>
      <div class="explain">
        <div class="screen"><b>${t('onb.how1Title', '1 · Catch together')}</b><span class="small">${t('onb.how1Any', 'On every route, each of you keeps only the first Pokémon you meet. Those catches are linked – a pair, or a group with 3–4 players.')}</span></div>
        <div class="screen"><b>${t('onb.how2Title', '2 · Share a fate')}</b><span class="small">${t('onb.how2Any', 'If one Pokémon faints, the ones linked to it die too. Linked Pokémon always join or leave the team together.')}</span></div>
        <div class="screen"><b>${t('onb.how3Title', '3 · See it live')}</b><span class="small">${t('onb.how3', 'The built-in emulator reads your team while you play and syncs it to the others in real time.')}</span></div>
        <div class="screen"><b>${t('onb.how4Title', '4 · Until the end')}</b><span class="small">${t('onb.how4Any', 'If one of you loses the whole team, the run is over for everyone – then you start a new attempt with one click.')}</span></div>
      </div>
      <p class="small muted"><b>${t('onb.soloTitle', 'Playing alone?')}</b> ${t('onb.soloText', 'Start a solo Nuzlocke: only the first Pokémon of each area counts and a fainted Pokémon is dead. The app tracks your run just the same – no partner needed.')}</p>
    </div>` },
    { id: 'look', label: t('onb.sLook', 'Look'), body: html`<div class="stack-l">
      <div class="stack-s"><h1>${t('onb.lookTitle', 'How should it look?')}</h1>
        <p class="muted">${t('onb.lookText', 'Pick a colour scheme – the colour-blind ones keep alive, dead and warnings apart for red-green or blue-yellow colour vision.')}</p></div>
      <${ThemePicker} value=${theme} onPick=${(id) => { setTheme(id); save({ theme: id }); }} />
      <div class="stack-s">
        <label class="check"><input type="checkbox" checked=${anim} onChange=${(e) => setAnim(e.target.checked)} /><span>${t('set.boot', 'Play animations (start-up, inserting the cartridge)')}</span></label>
        <label class="check"><input type="checkbox" checked=${sounds} onChange=${(e) => setSounds(e.target.checked)} /><span>${t('set.soundsAll', 'Sounds on this computer (start-up chime, catches, deaths, badges, pings)')}</span></label>
      </div>
    </div>` },
    { id: 'controls', label: t('onb.sControls', 'Controls'), body: html`<div class="stack-l">
      <div class="stack-s"><h1>${t('onb.controlsTitle', 'Keyboard or controller?')}</h1>
        <p class="muted">${t('onb.controlsText', 'Both work right away. Pick the keys that suit you – every button can be changed later in the settings.')}</p></div>
      <div class="onb-keys" role="radiogroup">
        ${PRESETS.map((p) => {
          const on = activePreset(controls) === p.id;
          return html`<button type="button" role="radio" aria-checked=${on} class=${`theme-card ${on ? 'on' : ''}`} onClick=${() => setControls(p.id === PRESETS[0].id ? null : presetMap(p.id))}>
            <b>${p.id === 'arrows' ? t('ctl.presetArrows', 'Arrow keys') : 'WASD'}</b>
            <span class="hint">${t('onb.keysHint', 'D-pad: {dpad} · A / B: {a} / {b} · Start: {start}', {
              dpad: ['up', 'left', 'down', 'right'].map((b) => keyLabel(presetMap(p.id)[b])).join(' '), a: keyLabel(presetMap(p.id).a), b: keyLabel(presetMap(p.id).b), start: keyLabel(presetMap(p.id).start) })}</span></button>`;
        })}
      </div>
      <div class=${`pad-status ${pads[0] ? 'on' : ''}`} role="status">
        <span class=${`led green ${pads[0] ? 'on' : ''}`}></span>
        ${pads[0] ? html`<span><b>${FAMILY_NAMES()[padFamily(pads[0].id)]}</b> ${t('onb.padReady', 'is ready – A is {a}, B is {b}.', { a: padLabel('BUTTON_2', padFamily(pads[0].id), PAD_POS()), b: padLabel('BUTTON_1', padFamily(pads[0].id), PAD_POS()) })}</span>`
          : html`<span class="small">${t('onb.padNone', 'Controller? Connect it now (USB or Bluetooth) and press a button – PlayStation, Xbox, Switch and others work.')}</span>`}
      </div>
    </div>` },
    { id: 'games', label: t('onb.sGames', 'Games'), body: html`<div class="stack-l">
      <div class="stack-s"><h1>${t('onb.gamesTitle', 'Add your games')}</h1>
        <p class="muted">${t('onb.gamesText', 'Add the ROMs you own (.gb, .gbc, .gba, .nds or .zip) and any ROM-hack patches. They are copied into your souldew library.')}</p></div>
      <${DropZone} onAdded=${() => reloadLibrary()} />
      <div class="row">
        <button class="btn go" onClick=${() => setDiscover(true)}><${Icon} name="search" size=${16} />${t('disc.button', 'Search my Mac')}</button>
        <button class="btn" onClick=${() => addGamesFlow({ reloadLibrary, toast })}><${Icon} name="plus" size=${16} />${t('lib.addFiles', 'Add files')}</button>
        ${window.sls && html`<button class="btn ghost" onClick=${() => addGamesFlow({ reloadLibrary, folder: true, toast })}><${Icon} name="folder" size=${16} />${t('lib.addFolder', 'Use a folder')}</button>`}
        <span class="spacer"></span>
        <span class=${`small ${owned ? 'onb-ok' : 'muted'}`}>${t('onb.gamesFound', '{count} game in your library|{count} games in your library', { count: owned })}</span>
      </div>
      <p class="small faint">${t('onb.gamesLegal', 'souldew does not download games. Use dumps of cartridges you own.')}</p>
    </div>` },
    { id: 'start', label: t('onb.sStart', 'Start'), body: html`<div class="stack-l">
      <div class="stack-s"><h1>${t('onb.startTitle', 'How do you want to start?')}</h1>
        <p class="muted">${t('onb.startTextAny', 'A SoulLink needs 2–4 players: one hosts, the others join with a code. A Nuzlocke you play on your own.')}</p></div>
      <div class="onb-choices four">
        ${choice('link', t('onb.startHostLink', 'Host a SoulLink'), t('onb.startHostTextLink', 'For 2–4 players: pick game and randomizer, then invite the others with a 6-digit code.'), 'host', true)}
        ${choice('user', t('onb.startNuzlocke', 'Start a Nuzlocke'), t('onb.startNuzlockeText', 'Just you: pick game, randomizer and the Nuzlocke rules.'), 'nuzlocke')}
        ${choice('load', t('onb.startJoin', 'I got a code'), t('onb.startJoinTextAny', 'Somebody hosts a SoulLink – enter their code and your app fetches the run.'), 'join')}
        ${choice('play', t('onb.startSolo', 'Just look around'), t('onb.startSoloText', 'To the library – the “First steps” guide shows the way whenever you’re ready.'), 'solo')}
      </div>
    </div>` },
  ];
  const total = STEPS.length;
  const cur = STEPS[step];
  const canNext = !cur.valid || cur.valid();
  return html`<div class="onboard" role="dialog" aria-modal="true" aria-label=${t('onb.welcome', 'Welcome to souldew')}>
    <div class="onboard-card">
      <ol class="onb-progress" aria-label=${t('onb.progress', 'Step {n} of {all}', { n: step + 1, all: total })}>
        ${STEPS.map((s, i) => html`<li class=${i < step ? 'done' : i === step ? 'on' : ''} aria-current=${i === step ? 'step' : undefined}><i></i><span>${s.label}</span></li>`)}
      </ol>
      <div class="panel onb-panel" ref=${panelRef} tabindex="-1" key=${cur.id}>${cur.body}</div>
      ${discover && html`<${DiscoverModal} onClose=${() => setDiscover(false)} />`}
      <div class="row">
        ${step > 0 && html`<button class="btn ghost" onClick=${() => setStep(step - 1)}>${t('common.back', 'Back')}</button>`}
        <span class="spacer"></span>
        ${cur.id === 'games' && owned === 0 && html`<button class="btn ghost" onClick=${() => setStep(step + 1)}>${t('onb.later', 'Later')}</button>`}
        ${step < total - 1 && html`<button class="btn primary big" disabled=${!canNext} onClick=${() => setStep(step + 1)}>${t('common.next', 'Next')}</button>`}
      </div>
    </div>
  </div>`;
}
