import { html, useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { useApp, openExternal, copy } from '../lib/ui.mjs';
import { LINKS } from '../lib/links.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, LANGS, setLang, currentLang } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { applyTheme } from '../lib/theme.mjs';
import { BUTTONS, RESERVED, PRESETS, bindable, keyLabel, resolve as resolveControls, presetMap, activePreset, detectLayout, currentLayout,
  PAD_LABELS, PAD_PRESETS, PAD_HOTKEYS, padMap, padFamily, padLabel } from '../lib/controls.mjs';
import { SHORTCUTS, buttonLabel } from './guide.mjs';
import { UpdateSection } from './update.mjs';

const SYSTEMS = [['gb', 'Game Boy'], ['gbc', 'Game Boy Color'], ['gba', 'Game Boy Advance'], ['nds', 'Nintendo DS']];
const SYS_SHORT = { nds: 'DS', gba: 'GBA', gb: 'GB' };

function shortcutAction(code) {
  const k = RESERVED[code];
  if (k === 'Esc') return t('ctl.escape', 'Cancel / leave fullscreen');
  const hit = SHORTCUTS().find(([s]) => s === k) || (/\d$/.test(k) && SHORTCUTS().find(([s]) => s === '1–4'));
  return hit ? hit[1] : '';
}

// "WASD" is printed as the layout prints those keys (ZQSD on AZERTY)
const presetLabel = (id) => (id === 'arrows' ? t('ctl.presetArrows', 'Arrow keys')
  : ['up', 'left', 'down', 'right'].map((b) => keyLabel(presetMap(id)[b])).join(''));

function ControlsSection({ saved, save }) {
  const [, setLayoutTick] = useState(0);
  const lang = currentLang();
  useEffect(() => { detectLayout(lang).then(() => setLayoutTick((x) => x + 1)); }, [lang]);
  const map = resolveControls(saved);
  const active = activePreset(saved); // null = custom
  const [listen, setListen] = useState(null); // button waiting for its new key
  const [msg, setMsg] = useState(null); // { text, swap?: { id, other, k } }
  const bound = useRef(0);
  const store = (next) => { setMsg(null); save({ controls: next }); };
  useEffect(() => {
    if (!listen) return;
    const onKey = (e) => {
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setListen(null); setMsg(null); return; }
      const k = { keyCode: e.keyCode, key: e.key, code: e.code };
      if (e.keyCode in RESERVED) return setMsg({ text: t('ctl.reserved', '{key} is already a shortcut while playing ({action}). Press another key.', { key: keyLabel(k), action: shortcutAction(e.keyCode) }) });
      if (!bindable(e.keyCode)) return setMsg({ text: t('ctl.unbindable', 'This key can’t be used for the game. Press another key.') });
      bound.current = Date.now();
      setListen(null);
      const other = BUTTONS.find((b) => b.id !== listen && map[b.id]?.keyCode === e.keyCode);
      if (other) return setMsg({ text: t('ctl.taken', '{key} is already used for {button}.', { key: keyLabel(k), button: buttonLabel(other.id) }), swap: { id: listen, other: other.id, k } });
      if (map[listen]?.keyCode !== e.keyCode) store({ ...map, [listen]: k });
      else setMsg(null);
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [listen, saved]);
  const swap = () => { const { id, other, k } = msg.swap; store({ ...map, [id]: k, [other]: map[id] }); };
  // the default preset is stored as "nothing saved", so it keeps following the keyboard layout
  const pick = (id) => { setListen(null); if (id !== active) store(id === PRESETS[0].id ? null : presetMap(id)); };
  const lay = currentLayout();
  return html`<section class="panel stack">
    <h2>${t('set.controls', 'Controls')}</h2>
    <p class="small muted">${t('set.controlsText', 'Keyboard keys for the built-in emulator. Click a key, then press the new one. Changes apply the next time a game starts.')}</p>
    <div class="row">
      <div class="seg" role="group" aria-label=${t('ctl.presets', 'Key presets')}>
        ${PRESETS.map((p) => html`<button type="button" class=${active === p.id ? 'on' : ''} aria-pressed=${active === p.id} onClick=${() => pick(p.id)}>${presetLabel(p.id)}</button>`)}
        <button type="button" class=${active ? '' : 'on'} aria-pressed=${!active} disabled=${!!active} title=${t('ctl.customHint', 'Your own keys – click a key in the table to change it')}>${t('ctl.custom', 'Custom')}</button>
      </div>
      <span class="small faint">${lay.real ? t('ctl.layoutSystem', 'Key names follow your keyboard layout.')
        : t('ctl.layoutGuess', 'Key names assume a {layout} keyboard (from the app language).', { layout: lay.id.toUpperCase() })}</span>
    </div>
    <table class="data"><thead><tr><th>${t('keys.button', 'Console button')}</th><th>${t('keys.key', 'Key')}</th><th>${t('set.system', 'System')}</th></tr></thead><tbody>
      ${BUTTONS.map((b) => html`<tr><td>${buttonLabel(b.id)}</td><td>
        <button type="button" class=${`kbd ctl-key${listen === b.id ? ' on' : ''}`} aria-label=${`${buttonLabel(b.id)}: ${keyLabel(map[b.id])}`}
          onClick=${() => { if (Date.now() - bound.current < 400) return; setMsg(null); setListen(listen === b.id ? null : b.id); }}
          onBlur=${() => setListen((l) => (l === b.id ? null : l))}>${listen === b.id ? t('ctl.press', 'Press a key …') : keyLabel(map[b.id])}</button></td>
        <td class="small faint">${(b.systems || ['nds', 'gba', 'gb']).map((s) => SYS_SHORT[s]).join(' · ')}</td></tr>`)}
    </tbody></table>
    ${msg && html`<div class="note row" role="status"><span class="grow">${msg.text}</span>
      ${msg.swap && html`<button class="btn small" onClick=${swap}>${t('ctl.swap', 'Swap keys')}</button>`}
      <button class="btn small ghost" onClick=${() => setMsg(null)}>${t('common.cancel', 'Cancel')}</button></div>`}
    <div class="row"><span class="small faint">${t('ctl.touch', 'Touch screen (DS): mouse click.')}</span></div>
  </section>`;
}

/** Connected controllers (polled – the Gamepad API has no "button pressed" event). */
export function usePads() {
  const [pads, setPads] = useState([]);
  useEffect(() => {
    let last = '';
    const read = () => {
      const now = [...(navigator.getGamepads?.() || [])].filter((g) => g && g.connected)
        .map((g) => ({ id: g.id, index: g.index, family: padFamily(g.id), standard: g.mapping === 'standard', pressed: g.buttons.map((b) => b.pressed) }));
      const sig = JSON.stringify(now);
      if (sig !== last) setPads(now); // re-render only when something changed
      last = sig;
    };
    read();
    const id = setInterval(read, 60);
    return () => clearInterval(id);
  }, []);
  return pads;
}

/** Face buttons of a controller we can't name: where they sit. */
export const PAD_POS = () => ({ BUTTON_1: t('pad.posBottom', 'bottom button'), BUTTON_2: t('pad.posRight', 'right button'), BUTTON_3: t('pad.posLeft', 'left button'), BUTTON_4: t('pad.posTop', 'top button') });

export const FAMILY_NAMES = () => ({ playstation: 'PlayStation (DualSense / DualShock)', xbox: 'Xbox', switch: t('pad.switch', 'Nintendo Switch (Pro Controller / Joy-Con)'), generic: t('pad.generic', 'Controller') });

function PadSection({ saved, save }) {
  const pads = usePads();
  const pad = pads[0];
  const family = pad?.family || 'generic';
  const map = padMap(saved);
  const preset = PAD_PRESETS.find((p) => p.id === saved?.preset) || PAD_PRESETS[0];
  const custom = !!saved?.map && BUTTONS.some((b) => map[b.id] !== preset.map[b.id]);
  const [listen, setListen] = useState(null);
  const [msg, setMsg] = useState(null);
  const before = useRef(null);
  // waiting for a button: the first one that goes down (and wasn't down when we started listening) is the new one
  useEffect(() => {
    if (!listen || !pad) return;
    if (!before.current) before.current = pad.pressed;
    const i = pad.pressed.findIndex((p, k) => p && !before.current[k] && k < PAD_LABELS.length);
    if (i < 0) return;
    const label = PAD_LABELS[i];
    before.current = null;
    if (label in PAD_HOTKEYS) {
      setMsg(t('pad.hotkey', '{button} is already used while playing ({action}). Press another button.', { button: padLabel(label, family, PAD_POS()), action: PAD_HOTKEYS[label] === 'turbo' ? t('keys.turbo', 'Turbo') : t('keys.pause', 'Pause / resume') }));
      return;
    }
    const other = BUTTONS.find((b) => b.id !== listen && map[b.id] === label);
    const next = { ...map, [listen]: label, ...(other ? { [other.id]: map[listen] } : {}) };
    setListen(null);
    setMsg(other ? t('pad.swapped', '{button} was on {other} – the two swapped.', { button: padLabel(label, family, PAD_POS()), other: buttonLabel(other.id) }) : null);
    save({ pads: { preset: preset.id, map: next } });
  }, [pad?.pressed?.join(), listen]);
  useEffect(() => {
    if (!listen) return undefined;
    const esc = (e) => e.key === 'Escape' && (setListen(null), (before.current = null));
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [listen]);
  const pick = (id) => { setListen(null); setMsg(null); save({ pads: { preset: id } }); };
  return html`<section class="panel stack">
    <h2>${t('pad.title', 'Controller')}</h2>
    <p class="small muted">${t('pad.text', 'PlayStation, Xbox, Switch and other controllers work over USB or Bluetooth. Click a button in the table, then press the new one on the controller. Changes apply the next time a game starts.')}</p>
    <div class=${`pad-status ${pad ? 'on' : ''}`} role="status">
      <span class=${`led green ${pad ? 'on' : ''}`}></span>
      ${pad ? html`<span><b>${FAMILY_NAMES()[family]}</b> <span class="small faint">${pad.id.replace(/\s*\(.*\)\s*$/, '')}</span>${!pad.standard ? html` <span class="chip">${t('pad.nonStandard', 'unusual layout – check the buttons below')}</span>` : ''}</span>`
        : html`<span class="small">${t('pad.none', 'No controller found. Connect one and press any button on it.')}</span>`}
      ${pads.length > 1 && html`<span class="small faint">${t('pad.more', '+{n} more – the first one plays', { n: pads.length - 1 })}</span>`}
    </div>
    <div class="row">
      <div class="seg" role="group" aria-label=${t('pad.layouts', 'Button layout')}>
        ${PAD_PRESETS.map((p) => html`<button type="button" class=${!custom && preset.id === p.id ? 'on' : ''} aria-pressed=${!custom && preset.id === p.id} onClick=${() => pick(p.id)}>${p.id === 'nintendo' ? t('pad.nintendo', 'Nintendo layout (A right)') : t('pad.xbox', 'Xbox layout (A bottom)')}</button>`)}
        <button type="button" class=${custom ? 'on' : ''} aria-pressed=${custom} disabled=${!custom}>${t('ctl.custom', 'Custom')}</button>
      </div>
    </div>
    <table class="data"><thead><tr><th>${t('keys.button', 'Console button')}</th><th>${t('pad.button', 'Controller button')}</th></tr></thead><tbody>
      ${BUTTONS.map((b) => {
        const lit = pad && map[b.id] && pad.pressed[PAD_LABELS.indexOf(map[b.id])];
        return html`<tr class=${lit ? 'pad-lit' : ''}><td>${buttonLabel(b.id)}</td><td>
          <button type="button" class=${`kbd ctl-key${listen === b.id ? ' on' : ''}`} disabled=${!pad}
            title=${pad ? '' : t('pad.connectFirst', 'Connect a controller first')}
            onClick=${() => { before.current = null; setMsg(null); setListen(listen === b.id ? null : b.id); }}>
            ${listen === b.id ? t('pad.press', 'Press a button …') : padLabel(map[b.id], family, PAD_POS())}</button></td></tr>`;
      })}
    </tbody></table>
    ${msg && html`<div class="note" role="status">${msg}</div>`}
    <ul class="small muted pad-hints">
      <li>${t('pad.stick', 'Left stick: moves like the D-pad.')}</li>
      <li>${t('pad.turbo', '{button}: turbo on / off.', { button: padLabel('RIGHT_BOTTOM_SHOULDER', family) })}</li>
      <li>${t('pad.pause', '{button} or the Home button: pause.', { button: padLabel('LEFT_BOTTOM_SHOULDER', family) })}</li>
    </ul>
  </section>`;
}

/** Colour scheme cards (Settings and the welcome tour); a pick applies at once. */
export function ThemePicker({ value, onPick }) {
  const cur = value || 'classic';
  return html`<div class="theme-picker" role="radiogroup" aria-label=${t('set.theme', 'Colour scheme')}>
    ${THEMES().map(([id, name, hint]) => html`<button type="button" role="radio" aria-checked=${cur === id}
      class=${`theme-card ${cur === id ? 'on' : ''}`} data-theme-preview=${id} onClick=${() => { applyTheme(id); onPick(id); }}>
      <span class="theme-swatches" aria-hidden="true"><i class="sw ok"></i><i class="sw bad"></i><i class="sw warn"></i><i class="sw p1"></i><i class="sw p2"></i><i class="sw p3"></i><i class="sw p4"></i></span>
      <b>${name}</b><span class="hint">${hint}</span></button>`)}
  </div>`;
}

const THEMES = () => [
  ['classic', t('theme.classic', 'Classic'), t('theme.classicHint', 'Dark, the original colours')],
  ['contrast', t('theme.contrast', 'High contrast'), t('theme.contrastHint', 'Black background, brighter text and edges')],
  ['deutan', t('theme.deutan', 'Red-green safe'), t('theme.deutanHint', 'For deuteranopia / protanopia: blue and orange instead of green and red')],
  ['tritan', t('theme.tritan', 'Blue-yellow safe'), t('theme.tritanHint', 'For tritanopia: teal and magenta instead of blue and yellow')],
];

export function SettingsView() {
  const { status, reloadStatus, toast, library, reloadLibrary } = useApp();
  const cfg = status?.config || {};
  const [name, setName] = useState(cfg.playerName || '');
  const [busy, setBusy] = useState(null);
  const nameChanged = name.trim() !== (cfg.playerName || '');
  const save = async (patch) => {
    try {
      await api.post('/api/config', patch);
    } catch (e) {
      toast({ kind: 'death', title: t('set.saveFailed', 'Couldn’t save the setting'), text: e.message });
    }
    await reloadStatus(); // also puts a failed change back on screen
  };
  const folders = async (body) => {
    try {
      await api.post('/api/library/folders', body);
    } catch (e) {
      toast({ kind: 'death', title: t('set.library', 'Library'), text: e.message });
    }
    await reloadStatus();
    await reloadLibrary();
  };
  const install = async (id) => {
    setBusy(id);
    try {
      await api.post(`/api/emulators/${id}/install`);
      await reloadStatus();
      toast({ kind: 'ok', title: status.emulators[id].name, text: t('set.installed', 'Installed') });
    } catch (e) {
      toast({ kind: 'death', title: status.emulators[id].name, text: e.message });
    }
    setBusy(null);
  };
  return html`<div class="stack-l">
    <div class="topbar"><h1>${t('nav.settings', 'Settings')}</h1></div>

    <section class="panel stack">
      <h2>${t('set.general', 'General')}</h2>
      <div class="grid-2">
        <label class="field"><span>${t('set.language', 'Language')}</span>
          <select value=${currentLang()} onChange=${async (e) => { await setLang(e.target.value); await save({ lang: e.target.value }); }}>
            ${LANGS.map((l) => html`<option value=${l.id}>${l.native}</option>`)}</select></label>
        <label class="field"><span>${t('set.name', 'Your name')}</span>
          <div class="row nowrap"><input type="text" class="grow" value=${name} maxLength="20" onInput=${(e) => setName(e.target.value)}
            onKeyDown=${(e) => e.key === 'Enter' && nameChanged && save({ playerName: name.trim() })} />
          <button class="btn" disabled=${!nameChanged} onClick=${() => save({ playerName: name.trim() })}>${t('common.save', 'Save')}</button></div></label>
      </div>
      <label class="check"><input type="checkbox" checked=${cfg.bootAnimation !== false} onChange=${(e) => save({ bootAnimation: e.target.checked })} /><span>${t('set.boot', 'Play animations (start-up, inserting the cartridge)')}</span></label>
      <label class="check"><input type="checkbox" checked=${cfg.speedGuard === true} onChange=${(e) => save({ speedGuard: e.target.checked })} /><span>${t('set.speedGuard', 'Step down when the computer can’t keep up')}
        <span class="hint">${t('set.speedGuardHint', 'Off: the speed you pick stays as it is, the bar shows when a scene runs slower. On: a level that isn’t reached for a few seconds drops to the highest one that holds.')}</span></span></label>
      <label class="check"><input type="checkbox" checked=${cfg.turboMax === true} onChange=${(e) => save({ turboMax: e.target.checked })} /><span>${t('set.turboMax', 'Turbo step “Max”: as fast as this computer can')}
        <span class="hint">${t('set.turboMaxHint', 'After 4× comes “Max” – no speed limit at all. How fast it gets depends on the game and the computer.')}</span></span></label>
      <label class="check"><input type="checkbox" checked=${cfg.sounds !== false} onChange=${(e) => save({ sounds: e.target.checked })} /><span>${t('set.soundsAll', 'Sounds on this computer (start-up chime, catches, deaths, badges, pings)')}</span></label>
      <label class="check"><input type="checkbox" checked=${cfg.shareScreen !== false} onChange=${(e) => save({ shareScreen: e.target.checked })} /><span>${t('set.shareScreenAll', 'Share my screen with the other players')}
        <span class="hint">${t('set.shareScreenHint', 'While you play, the others see your game small in a corner. It is only sent while someone is watching.')}</span></span></label>
      <div><button class="btn ghost small" onClick=${() => save({ onboarded: false })}>${t('set.replayOnboarding', 'Show the welcome tour again')}</button></div>
    </section>

    <section class="panel stack">
      <h2>${t('set.appearance', 'Appearance')}</h2>
      <p class="small muted">${t('set.themeText', 'Colour scheme of the whole app. The colour-blind schemes replace the green/red signals (alive, dead, warnings) with colours that stay apart with that colour vision.')}</p>
      <${ThemePicker} value=${cfg.theme} onPick=${(id) => save({ theme: id })} />
    </section>

    <${ControlsSection} saved=${cfg.controls || null} save=${(p) => save(p).catch((e) => toast({ kind: 'death', title: t('set.controls', 'Controls'), text: e.message }))} />
    <${PadSection} saved=${cfg.pads || null} save=${(p) => save(p).catch((e) => toast({ kind: 'death', title: t('pad.title', 'Controller'), text: e.message }))} />

    <section class="panel stack">
      <h2>${t('set.emulators', 'Emulators')}</h2>
      <p class="small muted">${t('set.emuText', 'The built-in emulator works for every system and has the best live sync. External emulators are optional.')}</p>
      <table class="data"><thead><tr><th>${t('set.system', 'System')}</th><th>${t('set.useEmu', 'Play with')}</th></tr></thead><tbody>
        ${SYSTEMS.map(([sys, label]) => html`<tr><td>${label}</td><td>
          <select value=${cfg.emulatorFor?.[sys] || 'builtin'} onChange=${(e) => save({ emulatorFor: { ...(cfg.emulatorFor || {}), [sys]: e.target.value } })}>
            <option value="builtin">${t('set.builtin', 'Built-in (live)')}</option>
            ${Object.entries(status?.emulators || {}).filter(([, e]) => e.systems.includes(sys)).map(([id, e]) => html`<option value=${id} disabled=${!e.installed}>${e.name}${e.live === 'script' ? ` (${t('set.liveScript', 'live via script')})` : ` (${t('set.liveSave', 'syncs on save')})`}${e.installed ? '' : ` – ${t('set.notInstalled', 'not installed')}`}</option>`)}
          </select></td></tr>`)}
      </tbody></table>
      ${Object.entries(status?.emulators || {}).map(([id, e]) => html`<div class="check-item">
        <span class=${`led green ${e.installed ? 'on' : ''}`}></span>
        <div><b style="font-weight:500">${e.name}</b> <span class="small muted">${e.systems.map((s) => s.toUpperCase()).join(' · ')}</span>
          <div class=${`tiny faint ${e.installed ? 'sm-secret' : ''}`}>${e.installed ? e.path : t('set.notInstalled', 'not installed')}</div></div>
        ${e.installed ? html`<span class="chip ok">${t('set.installed', 'Installed')}</span>` : html`<button class="btn small" disabled=${!!busy} onClick=${() => install(id)}>${busy === id ? t('set.installing', 'Installing …') : t('set.install', 'Install')}</button>`}
      </div>`)}
      ${status?.emulators?.mgba?.installed && html`<div class="note">${t('set.mgbaScriptAgain', 'For live data with mGBA: Tools › Scripting… › File › Load script… and pick this file (again after every mGBA restart):')} <span class="code">${status.live?.script}</span>
        <button class="btn small ghost" onClick=${() => { copy(status.live?.script || ''); toast({ kind: 'ok', title: t('common.copied', 'Copied'), text: status.live?.script }); }}>${t('common.copy', 'Copy')}</button></div>`}
    </section>

    <section class="panel stack">
      <h2>${t('set.library', 'Library')}</h2>
      <p class="small muted">${t('set.libraryText', 'Games you add are copied into the library folder. You can also include folders where your ROMs already are.')}</p>
      <div class="row"><span class="code grow ellipsis" title=${library?.libraryDir}>${library?.libraryDir}</span>
        ${window.sls && html`<button class="btn small ghost" onClick=${() => api.post('/api/library/reveal', {})}><${Icon} name="folder" size=${14} />${t('lib.reveal', 'Show folder')}</button>`}</div>
      ${(cfg.libraryFolders || []).map((f) => html`<div class="row"><span class="code grow ellipsis" title=${f}>${f}</span>
        <button class="btn small ghost" onClick=${() => folders({ remove: f })}>${t('common.remove', 'Remove')}</button></div>`)}
      ${window.sls && html`<div><button class="btn small" onClick=${async () => {
        const paths = await window.sls.pickFiles({ folder: true, title: t('set.addFolder', 'Include a folder') });
        if (paths?.[0]) await folders({ add: paths[0] });
      }}><${Icon} name="plus" size=${14} />${t('set.addFolder', 'Include a folder')}</button></div>`}
    </section>

    <section class="panel stack">
      <h2>${t('set.about', 'About')}</h2>
      <${UpdateSection} />
      <dl class="facts small">
        <dt>${t('set.randomizer', 'Randomizer')}</dt><dd>Universal Pokémon Randomizer ZX ${status?.upr?.version} · Java ${status?.java?.version || t('set.javaMissing', 'not found')}${status?.java?.bundled ? ` (${t('set.bundled', 'bundled')})` : ''}</dd>
        <dt>${t('set.data', 'Pokémon data')}</dt><dd>PokeAPI · ${t('set.covers', 'covers')}: libretro-thumbnails</dd>
        <dt>${t('set.emuCore', 'Built-in emulator')}</dt><dd>EmulatorJS (melonDS, DeSmuME, mGBA, Gambatte)</dd>
      </dl>
      <div class="row">
        <button class="btn small" onClick=${() => openExternal(LINKS.github)}><${Icon} name="external" size=${14} />${t('set.github', 'souldew on GitHub')}</button>
        <button class="btn small" onClick=${() => openExternal(LINKS.issues)}><${Icon} name="external" size=${14} />${t('set.reportBug', 'Report a bug')}</button>
        <button class="btn small" onClick=${() => openExternal(LINKS.coffee)}><${Icon} name="coffee" size=${14} />${t('rail.coffee', 'Buy me a coffee')}</button>
      </div>
      <p class="tiny faint">${t('set.legal', 'Pokémon and all related names are trademarks of Nintendo, Game Freak and The Pokémon Company. souldew is a fan project and does not include or download games.')}</p>
    </section>
  </div>`;
}
