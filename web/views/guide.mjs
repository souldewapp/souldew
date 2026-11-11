import { html, useState } from '/vendor/htm-preact.mjs';
import { useApp, saveDiagnostics } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { resolve as resolveControls, keyLabel } from '../lib/controls.mjs';
import { shortcut } from '../lib/platform.mjs';

export const SHORTCUTS = () => [
  ['Tab', t('keys.turboHold', 'Hold for fast forward')],
  ['T', t('keys.turboToggle', 'Toggle turbo (2× → 3× → 4×)')],
  ['P', t('keys.pause', 'Pause / resume')],
  ['F5', t('keys.quicksaveSel', 'Quick save state (selected slot)')],
  ['F8', t('keys.quickloadSel', 'Quick load state (selected slot)')],
  [shortcut('Shift+1–4', { space: true }), t('keys.saveSlot', 'Save to slot 1–4')],
  ['1–4', t('keys.loadSlot', 'Load slot 1–4')],
  ['F12', t('keys.screenshot', 'Screenshot')],
  ['M', t('keys.mute', 'Sound on/off')],
  ['+ / –', t('keys.volume', 'Louder / quieter')],
  ['F', t('keys.fullscreen', 'Fullscreen game')],
  ['R', t('keys.reset', 'Reset the game (asks first)')],
  // menu accelerators (electron/main.mjs) – only exist in the desktop app; ⌘ on a Mac, Ctrl on Windows
  ...(window.sls?.native ? [
    [shortcut('Mod+1–5', { space: true }), t('keys.sectionsNavStream', 'Library · SoulLink · Nuzlocke · Connection · Stream')],
    [shortcut('Mod+O', { space: true }), t('keys.add', 'Add games')],
    [shortcut('Mod+B', { space: true }), t('keys.sidebar', 'Show / hide the sidebar')],
  ] : []),
];

export const buttonLabel = (id) => ({
  up: t('ctl.up', 'D-Pad up'), down: t('ctl.down', 'D-Pad down'), left: t('ctl.left', 'D-Pad left'), right: t('ctl.right', 'D-Pad right'),
}[id] || ({ start: 'Start', select: 'Select' }[id] || id.toUpperCase()));

/** Current game-button keys (Settings › Controls, defaults otherwise). */
export function ControlsTable() {
  const { status } = useApp();
  const m = resolveControls(status?.config?.controls);
  const k = (id) => keyLabel(m[id]);
  return html`<table class="data"><thead><tr><th>${t('keys.button', 'Console button')}</th><th>${t('keys.key', 'Key')}</th></tr></thead><tbody>
    ${[['D-Pad', ['up', 'down', 'left', 'right'].map(k).join(' ')], ['A', k('a')], ['B', k('b')], ['X (DS)', k('x')], ['Y (DS)', k('y')], ['L / R', `${k('l')} / ${k('r')}`],
      ['Start', k('start')], ['Select', k('select')], [t('keys.touch', 'Touch screen (DS)'), t('keys.mouse', 'Mouse')]]
      .map(([a, b]) => html`<tr><td>${a}</td><td><span class="kbd">${b}</span></td></tr>`)}
  </tbody></table>`;
}

/** group: a run of 3–4 players – "the others' computers" instead of the partner's. */
export function ConnectionFlow({ group = false } = {}) {
  return html`<div class="flow" aria-label=${t('conn.flowAria', 'How the connection works')}>
    <div class="box"><b>${t('conn.yourComputer', 'Your computer')}</b><span>${t('conn.local', 'souldew, local')}</span></div>
    <span class="arrow" aria-hidden="true">⇄</span>
    <div class="box"><b>${t('conn.relays', 'Public relays')}</b><span>${t('conn.relaysSub', 'only see encrypted data')}</span></div>
    <span class="arrow" aria-hidden="true">⇄</span>
    <div class="box"><b>${group ? t('conn.friendGroup', 'The others’ computers') : t('conn.friend', 'Your partner’s computer')}</b><span>${t('conn.local', 'souldew, local')}</span></div>
  </div>`;
}

export function ConnectionText({ group = false } = {}) {
  return html`<div class="prose small muted">
    <p>${group ? t('conn.p1Group', 'The app runs locally on every computer, but it may use the internet. That is how your apps find each other – no server of your own, no account, no router settings:')
      : t('conn.p1', 'The app runs locally on both computers, but it may use the internet. That is how your two apps find each other – no server of your own, no account, no router settings:')}</p>
    <p><b>${t('conn.direct', 'Direct:')}</b> ${group ? t('conn.p2Group', 'All apps announce themselves with your room code on public Nostr relays. The relays only introduce you – after that your apps talk directly (WebRTC, like a video call).')
      : t('conn.p2', 'Both apps announce themselves with your room code on public Nostr relays. The relays only introduce you – after that your apps talk directly (WebRTC, like a video call).')}</p>
    <p><b>${t('conn.relay', 'Relay:')}</b> ${t('conn.p3', 'If a router blocks direct connections, data goes through a public MQTT server instead. It also keeps your latest state, so the others catch up even if you are not online at the same time.')}</p>
    <p>${t('conn.p4', 'Everything is encrypted with the key from your invite. Only tracker data travels – never ROMs or save files.')}</p>
  </div>`;
}

export function GuideView() {
  const { route } = useApp();
  const [tab, setTab] = useState(route.params.tab || 'start');
  return html`<div class="stack-l">
    <div class="topbar"><h1>${t('guide.title', 'Help')}</h1></div>
    <div class="tabs" role="tablist">
      ${[['start', t('guide.start', 'Getting started')], ['keys', t('guide.keys', 'Controls & shortcuts')], ['faq', t('guide.faq', 'Questions')]]
        .map(([k, l]) => html`<button role="tab" aria-selected=${tab === k} class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}
    </div>
    ${tab === 'start' && html`<section class="panel steps-list">
      ${[
        [t('guide.s1t', 'Add your games'), t('guide.s1', 'Library › Add files. ROMs (.gb, .gbc, .gba, .nds, .zip) and ROM-hack patches are copied into your library.')],
        [t('guide.s2t', 'Create a SoulLink'), t('guide.s2Nav', 'SoulLink › Host new SoulLink: pick a game (and optionally a hack), the number of players, a randomizer preset and the names. The app builds the games in seconds.')],
        [t('guide.s3t', 'Invite the others'), t('guide.s3Nav', 'Create a code for each player (or send the invite file). Everyone adds their own copy of the game and gets an identical game – no ROM ever has to be shared. Playing alone? Use Nuzlocke › New Nuzlocke instead and skip this step.')],
        [t('guide.s4t', 'Play'), t('guide.s4Nav', 'Press “Play” on the board or “Continue” in the overview. Your team, levels and HP are read live and appear on everyone’s board within a second. The game keeps running in the corner while you look elsewhere – the green light in the sidebar shows where it belongs.')],
        [t('guide.s5t', 'Live together'), t('guide.s5', 'If a linked Pokémon faints, the pair dies for both of you automatically. The board, the graveyard and the log keep the score.')],
      ].map(([title, text], i) => html`<div class="step"><span class="n">${i + 1}</span><div><h3>${title}</h3><p>${text}</p></div><span></span></div>`)}
    </section>`}
    ${tab === 'keys' && html`<div class="grid-2">
      <section class="panel stack"><h2>${t('guide.shortcuts', 'Shortcuts while playing')}</h2>
        <div class="keys">${SHORTCUTS().map(([k, l]) => html`<span class="kbd">${k}</span><span>${l}</span>`)}</div></section>
      <section class="panel stack"><h2>${t('guide.controls', 'Game controls')}</h2><${ControlsTable} />
        <p class="small faint">${t('guide.gamepad', 'Game controllers work too – just plug them in.')} ${t('guide.changeKeys', 'You can change the keys in Settings › Controls.')}</p></section>
    </div>`}
    ${tab === 'faq' && html`<section class="panel faq">
      <details open><summary>${t('faq.q1', 'How do we connect if the app runs locally?')}</summary><div class="stack" style="margin-top:10px"><${ConnectionFlow} /><${ConnectionText} /></div></details>
      <details><summary>${t('faq.q2', 'Can the app change my running game?')}</summary><div class="prose small muted" style="margin-top:8px">
        <p>${t('faq.a2a', 'It reads your game live – team, HP, levels, catches – but it never writes into the running game. That keeps your save safe.')}</p>
        <p>${t('faq.a2b', 'Between sessions it can edit your save file: dead Pokémon can be moved into PC box 18 (graveyard). This only works while the game is closed, and a backup is made first.')}</p></div></details>
      <details><summary>${t('faq.q3', 'Do we have to share ROM files?')}</summary><div class="prose small muted" style="margin-top:8px"><p>${t('faq.a3', 'No. Everyone uses their own copy. The invite only contains settings, seeds and the room key; the randomizer rebuilds the identical game from your own ROM, and the app checks the checksum.')}</p></div></details>
      <details><summary>${t('faq.q4', 'Which games are supported?')}</summary><div class="prose small muted" style="margin-top:8px"><p>${t('faq.a4', 'All main Pokémon games on Game Boy, Game Boy Color, Game Boy Advance and Nintendo DS (Gen 1–5) and their ROM hacks, plus X/Y to Ultra Sun/Ultra Moon on Nintendo 3DS (Gen 6–7). Live tracking works for the English and German releases; ROM hacks work when they keep the original memory layout.')}</p></div></details>
      <details><summary>${t('faq.q5', 'Can I use melonDS or mGBA instead?')}</summary><div class="prose small muted" style="margin-top:8px"><p>${t('faq.a5', 'Yes – choose them in the settings. mGBA streams live data through a small script you load once (Tools › Scripting). melonDS has no scripting, so it syncs after every in-game save.')}</p></div></details>
      <details><summary>${t('faq.q6', 'What if one of us is offline?')}</summary><div class="prose small muted" style="margin-top:8px"><p>${t('faq.a6', 'Nothing gets lost. Each app keeps its own copy and both merge automatically when you’re connected again.')}</p></div></details>
      <details><summary>${t('faq.q7', 'Something doesn’t work right (music, live tracking)?')}</summary><div class="stack" style="margin-top:8px">
        <p class="prose small muted">${t('faq.a7', 'Right after it happens, save the diagnostics and send the file along with what you did. It holds what souldew read from the game and decided this session (song numbers, levels, what the turbo sound played) – no ROM, save file or invite.')}</p>
        <div class="row"><button class="btn small" onClick=${() => saveDiagnostics()}><${Icon} name="save" size=${14} />${t('play.diag', 'Save diagnostics')}</button></div></div></details>
    </section>`}
  </div>`;
}
