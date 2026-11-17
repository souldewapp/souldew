import { html, useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { useApp, openExternal, copy } from '../lib/ui.mjs';
import { LINKS } from '../lib/links.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, LANGS, setLang, currentLang } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { applyTheme } from '../lib/theme.mjs';
import { BUTTONS, RESERVED, PRESETS, bindable, keyLabel, resolve as resolveControls, presetMap, activePreset, detectLayout, currentLayout,
  PAD_LABELS, PAD_PRESETS, PAD_HOTKEYS, padMap, padFamily, padLabel, pickPad, padKey, looksLikePad,
  HOTKEYS, resolveHotkeys, hotkeyBindable, sameCombo, padHotkeys } from '../lib/controls.mjs';
import { SHORTCUTS, buttonLabel, comboLabel } from './guide.mjs';
import { UpdateSection } from './update.mjs';
import { PLATFORM, IS_TOUCH, IS_ANDROID, soundsText } from '../lib/platform.mjs';
import { gpuBackends } from '/shared/gpu.mjs';
import { LiveRunsSettings } from './liveshare.mjs';
import { suspendPadNav } from '../lib/padnav.mjs';

const SYSTEMS = [['gb', 'Game Boy'], ['gbc', 'Game Boy Color'], ['gba', 'Game Boy Advance'], ['nds', 'Nintendo DS'], ['3ds', 'Nintendo 3DS']];
/** Systems the built-in player runs only with an extra part: 3DS needs souldew's 3DS host (status.ctr). */
const externalOnly = (sys, status) => sys === '3ds' && !status?.ctr?.ok;
const SYS_SHORT = { nds: 'DS', gba: 'GBA', gb: 'GB' };

function shortcutAction(code, controls) {
  const k = RESERVED[code];
  if (k === 'Esc') return t('ctl.escape', 'Cancel / leave fullscreen');
  const all = SHORTCUTS(controls);
  const hit = all.find(([s]) => s === k) || (/\d$/.test(k) && all.find(([s]) => s === '1–4'));
  return hit ? hit[1] : '';
}

/** The fast-forward hotkeys' names (lib/controls.mjs HOTKEYS) – rows below the game buttons, here and in Controller. */
const hotkeyLabel = (id) => (id === 'ffHold' ? t('ctl.ffHold', 'Fast-forward (hold)') : t('ctl.ffToggle', 'Fast-forward on / off'));
const isHotkey = (id) => HOTKEYS.some((h) => h.id === id);
/** The hotkeys a stored mapping sets itself – kept when the game buttons change (a preset, a new key). */
const savedHotkeys = (saved) => Object.fromEntries(HOTKEYS.filter((h) => saved?.[h.id]).map((h) => [h.id, saved[h.id]]));

// "WASD" is printed as the layout prints those keys (ZQSD on AZERTY)
const presetLabel = (id) => (id === 'arrows' ? t('ctl.presetArrows', 'Arrow keys')
  : ['up', 'left', 'down', 'right'].map((b) => keyLabel(presetMap(id)[b])).join(''));

function ControlsSection({ saved, save }) {
  const [, setLayoutTick] = useState(0);
  const lang = currentLang();
  useEffect(() => { detectLayout(lang).then(() => setLayoutTick((x) => x + 1)); }, [lang]);
  const map = resolveControls(saved);
  const hot = resolveHotkeys(saved); // the fast-forward keys – rows of their own below the game buttons
  const active = activePreset(saved); // null = custom (the game buttons; the hotkeys don't count)
  const [listen, setListen] = useState(null); // button or hotkey waiting for its new key
  const [msg, setMsg] = useState(null); // { text, swap?: { id, other, k } }
  const bound = useRef(0);
  const store = (next) => { setMsg(null); save({ controls: next }); };
  const keyOf = (id) => (isHotkey(id) ? hot[id] : map[id]);
  const nameOf = (id) => (isHotkey(id) ? hotkeyLabel(id) : buttonLabel(id));
  // what a row may take over from another in a swap: a game button takes no Tab and no Shift
  const fits = (id, k) => !!k && (isHotkey(id) ? hotkeyBindable(k.keyCode) : bindable(k.keyCode) && !(k.keyCode in RESERVED));
  const plain = (id, k) => (isHotkey(id) || !k ? k : { keyCode: k.keyCode, key: k.key, ...(k.code ? { code: k.code } : {}) });
  useEffect(() => {
    if (!listen) return;
    const onKey = (e) => {
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setListen(null); setMsg(null); return; }
      const hk = isHotkey(listen);
      // a hotkey may have Shift (Shift+Tab), the game buttons are keys of their own
      const k = { keyCode: e.keyCode, key: e.key, code: e.code, ...(hk && e.shiftKey ? { shift: true } : {}) };
      if (hk && (e.ctrlKey || e.altKey || e.metaKey)) return setMsg({ text: t('ctl.hotkeyUnbindable', 'This key can’t be used for this shortcut. Press another key.') });
      if (e.keyCode in RESERVED && !(hk && hotkeyBindable(e.keyCode))) {
        if (!shortcutAction(e.keyCode, saved)) return setMsg({ text: t('ctl.unbindable', 'This key can’t be used for the game. Press another key.') });
        return setMsg({ text: t('ctl.reserved', '{key} is already a shortcut while playing ({action}). Press another key.', { key: keyLabel(k), action: shortcutAction(e.keyCode, saved) }) });
      }
      if (hk ? !hotkeyBindable(e.keyCode) : !bindable(e.keyCode)) {
        return setMsg({ text: hk ? t('ctl.hotkeyUnbindable', 'This key can’t be used for this shortcut. Press another key.') : t('ctl.unbindable', 'This key can’t be used for the game. Press another key.') });
      }
      bound.current = Date.now();
      setListen(null);
      // taken: a game button with this key – or, for a hotkey, the other hotkey with this key and Shift
      const other = [...BUTTONS.map((b) => b.id), ...HOTKEYS.map((h) => h.id)].find((id) => id !== listen && keyOf(id)
        && (isHotkey(id) && hk ? sameCombo(keyOf(id), k) : keyOf(id).keyCode === e.keyCode));
      if (other) {
        return setMsg({ text: t('ctl.taken', '{key} is already used for {button}.', { key: comboLabel(k), button: nameOf(other) }),
          ...(fits(other, keyOf(listen)) ? { swap: { id: listen, other, k } } : {}) });
      }
      // (a new hotkey leaves the game buttons as they are stored – the default preset keeps following the layout)
      if (!(hk ? sameCombo(hot[listen], k) : map[listen]?.keyCode === e.keyCode)) store(hk ? { ...(saved || {}), [listen]: k } : { ...savedHotkeys(saved), ...map, [listen]: k });
      else setMsg(null);
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [listen, saved]);
  const swap = () => {
    const { id, other, k } = msg.swap;
    const base = isHotkey(id) && isHotkey(other) ? saved || {} : { ...savedHotkeys(saved), ...map };
    store({ ...base, [id]: k, [other]: plain(other, keyOf(id)) });
  };
  // the default preset is stored as "nothing saved", so it keeps following the keyboard layout (own hotkeys stay)
  const pick = (id) => {
    setListen(null);
    if (id === active) return;
    const own = savedHotkeys(saved);
    store(id === PRESETS[0].id ? (Object.keys(own).length ? own : null) : { ...presetMap(id), ...own });
  };
  const lay = currentLayout();
  return html`<section class="panel stack">
    <h2>${t('set.controls', 'Controls')}</h2>
    <p class="small muted">${t('set.controlsText', 'Keyboard keys for the built-in emulator. Click a key, then press the new one. Changes apply right away, also to a game that is running.')}</p>
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
      <tr><th colspan="3">${t('guide.shortcuts', 'Shortcuts while playing')}</th></tr>
      ${HOTKEYS.map((h) => html`<tr><td>${hotkeyLabel(h.id)}</td><td>
        <button type="button" class=${`kbd ctl-key${listen === h.id ? ' on' : ''}`} aria-label=${`${hotkeyLabel(h.id)}: ${comboLabel(hot[h.id])}`}
          onClick=${() => { if (Date.now() - bound.current < 400) return; setMsg(null); setListen(listen === h.id ? null : h.id); }}
          onBlur=${() => setListen((l) => (l === h.id ? null : l))}>${listen === h.id ? t('ctl.press', 'Press a key …') : comboLabel(hot[h.id])}</button></td>
        <td class="small faint">${['nds', 'gba', 'gb'].map((s) => SYS_SHORT[s]).join(' · ')}</td></tr>`)}
    </tbody></table>
    ${msg && html`<div class="note row" role="status"><span class="grow">${msg.text}</span>
      ${msg.swap && html`<button class="btn small" onClick=${swap}>${t('ctl.swap', 'Swap keys')}</button>`}
      <button class="btn small ghost" onClick=${() => setMsg(null)}>${t('common.cancel', 'Cancel')}</button></div>`}
    <div class="row"><span class="small faint">${t('ctl.touch', 'Touch screen (DS): mouse click.')}</span></div>
  </section>`;
}

export const GPU_LABELS = () => ({ auto: t('set.gpuAuto', 'Automatic'), d3d11: 'Direct3D 11', vulkan: 'Vulkan', gl: 'OpenGL' });

/**
 * Graphics backend (Windows and Linux, desktop app only – shared/gpu.mjs): Chromium reads it at start, so a change
 * needs a restart. The app tells which backend this session runs with; while that differs from the saved choice,
 * the hint with "Restart now" stays.
 */
function GraphicsSetting({ cfg, save }) {
  const [active, setActive] = useState(null);
  const [safe, setSafe] = useState(false);
  const native = typeof window.sls?.gpuInfo === 'function' && gpuBackends(PLATFORM).length > 1;
  useEffect(() => {
    if (native) {
      window.sls.gpuInfo().then((g) => {
        setActive(g?.backend || 'auto');
        setSafe(!!g?.safe);
      }).catch(() => {});
    }
  }, [native]);
  if (!native) return null;
  const value = cfg.gpuBackend || 'auto';
  const labels = GPU_LABELS();
  return html`<div class="stack">
    ${safe && html`<div class="note row" role="status"><span class="grow">${t('set.gpuSafeNote', 'souldew runs in safe graphics mode (software rendering, slower). If the window stays blank in a normal start, pick another graphics backend here – Vulkan or OpenGL often help – then restart normally.')}</span>
      <button class="btn small" onClick=${() => window.sls.relaunch?.()}>${t('set.gpuSafeRestart', 'Restart normally')}</button></div>`}
    <div class="grid-2"><label class="field"><span>${t('set.gpu', 'Graphics backend')}</span>
      <select value=${value} onChange=${(e) => save({ gpuBackend: e.target.value })}>
        ${gpuBackends(PLATFORM).map((b) => html`<option value=${b}>${labels[b]}</option>`)}</select></label></div>
    <span class="small faint">${t('set.gpuHint', 'If the game stutters or the sound crackles, try Vulkan. Automatic lets the system decide.')}</span>
    ${!safe && active && active !== value && html`<div class="note row" role="status"><span class="grow">${t('set.gpuRestart', 'The new graphics backend is used after a restart of souldew.')}</span>
      <button class="btn small" onClick=${() => window.sls.relaunch?.()}>${t('upd.restart', 'Restart now')}</button></div>`}
  </div>`;
}

/** The 3DS renderer's names (server/lib/ctrrenderer.mjs). */
export const CTR_RENDERER_LABELS = () => ({
  auto: t('set.ctrRendererAuto', 'Automatic'),
  vulkan: 'Vulkan',
  compat: t('set.ctrRendererCompat', 'Vulkan (compatibility)'),
  software: t('set.ctrRendererSoftware', 'Software'),
});

/**
 * How the built-in 3DS player draws. "Automatic" starts with Vulkan and steps down by itself when a graphics driver
 * can't run it (remembered for that card and driver); the others are fixed.
 */
function CtrRendererSetting({ cfg, status, save }) {
  if (!status?.ctr?.ok) return null;
  const value = cfg.ctrRenderer || 'auto';
  const labels = CTR_RENDERER_LABELS();
  const now = status.ctr.renderer;
  return html`<div class="stack-s">
    <div class="grid-2"><label class="field"><span>${t('set.ctrRenderer', '3DS renderer')}</span>
      <select value=${value} onChange=${(e) => save({ ctrRenderer: e.target.value })}>
        ${['auto', 'vulkan', 'compat', 'software'].map((m) => html`<option value=${m}>${labels[m]}</option>`)}</select></label></div>
    <span class="small faint">${t('set.ctrRendererHint', 'How souldew’s built-in 3DS player draws the game. Automatic starts with Vulkan; if the game stops right after starting, it switches to Vulkan (compatibility) and then to Software, and remembers that for this graphics card and driver. Software works on every PC but is much slower. Applies to the next 3DS game you start.')}</span>
    ${value === 'auto' && now && now !== 'vulkan' && html`<span class="small muted" role="status">${t('set.ctrRendererLearned', 'This graphics card currently plays 3DS games with: {mode}', { mode: labels[now] || now })}</span>`}
  </div>`;
}

/**
 * The built-in 3DS player's internal resolution (issue #59): 1× is the 3DS's own, 2× and 3× draw the games sharper and
 * cost the graphics card more. The host takes it at its start – it applies to the next 3DS game.
 */
function CtrScaleSetting({ cfg, status, save }) {
  if (!status?.ctr?.ok) return null;
  const value = [1, 2, 3].includes(cfg.ctrScale) ? cfg.ctrScale : 1;
  const labels = { 1: t('set.ctrScale1', '1× (native)'), 2: '2×', 3: '3×' };
  return html`<div class="stack-s">
    <div class="grid-2"><label class="field"><span>${t('set.ctrScale', '3DS resolution')}</span>
      <select value=${value} onChange=${(e) => save({ ctrScale: Number(e.target.value) })}>
        ${[1, 2, 3].map((n) => html`<option value=${n}>${labels[n]}</option>`)}</select></label></div>
    <span class="small faint">${t('set.ctrScaleHint', 'Draws the 3DS games at two or three times their own resolution – sharper and less pixelated, but more work for the graphics card. Applies to the next 3DS game you start. The Software renderer always plays at 1×, and so does the automatic step down after a crash.')}</span>
  </div>`;
}

/** The notice after souldew put the graphics backend back to "Automatic" itself (shown once, see app.mjs). */
export function gpuFallbackText(notice) {
  const backend = GPU_LABELS()[notice.from] || notice.from;
  return notice.reason === 'gpu-crash'
    ? t('set.gpuFallbackCrash', 'The graphics backend {backend} kept crashing. souldew uses “Automatic” again from the next start – you can change it in Settings.', { backend })
    : t('set.gpuFallbackStart', 'souldew didn’t open with the graphics backend {backend}, so it uses “Automatic” again. You can change it in Settings.', { backend });
}

/** Connected controllers (polled – the Gamepad API has no "button pressed" event). */
export function usePads() {
  const [pads, setPads] = useState([]);
  useEffect(() => {
    let last = '';
    const read = () => {
      const now = [...(navigator.getGamepads?.() || [])].filter((g) => g && g.connected)
        .map((g) => ({ id: g.id, index: g.index, family: padFamily(g.id), standard: g.mapping === 'standard', axes: g.axes.length, buttons: g.buttons.length, pressed: g.buttons.map((b) => b.pressed) }));
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

/** A device's name as the browser reports it, without the vendor/product part in brackets. */
export const padName = (id) => String(id || '').replace(/\s*\(.*\)\s*$/, '') || String(id || '');

/**
 * Which connected device plays (lib/controls.mjs pickPad): "Automatic" or one the player picked – remembered as
 * config.pads.device. Shown as soon as there is a choice to make: two devices, one that doesn't look like a controller,
 * or a remembered one.
 */
function PadPicker({ pads, saved, pad, onPick }) {
  const wanted = saved?.device ? padKey(saved.device) : '';
  const missing = wanted && !pads.some((p) => padKey(p.id) === wanted);
  if (pads.length < 2 && !wanted && (!pads.length || looksLikePad(pads[0]))) return null;
  const auto = pickPad(pads);
  // the same model twice has the same id – they are told apart by their slot
  const twice = (p) => pads.filter((q) => q.id === p.id).length > 1;
  const label = (p) => `${padName(p.id)}${twice(p) ? ` (${p.index + 1})` : ''}${looksLikePad(p) ? '' : ` – ${t('pad.notAPad', 'doesn’t look like a controller')}`}`;
  return html`<div class="grid-2"><label class="field"><span>${t('pad.use', 'Controller to use')}</span>
    <select value=${wanted} onChange=${(e) => onPick(e.target.value || null)}>
      <option value="">${auto ? t('pad.auto', 'Automatic – {name}', { name: padName(auto.id) }) : t('pad.autoNone', 'Automatic')}</option>
      ${pads.filter((p, i) => pads.findIndex((q) => q.id === p.id) === i).map((p) => html`<option value=${padKey(p.id)}>${label(p)}</option>`)}
      ${missing && html`<option value=${wanted}>${t('pad.missing', '{name} (not connected)', { name: padName(wanted) })}</option>`}
    </select></label>
    <span class="small faint pad-pick-hint">${pad && wanted && padKey(pad.id) === wanted ? t('pad.remembered', 'souldew remembers this controller and uses it whenever it is connected.')
      : t('pad.autoHint', 'Automatic picks a real controller and skips microphones, headsets and other devices the system lists as controllers.')}</span></div>`;
}

function PadSection({ saved, save, nav, saveNav }) {
  const pads = usePads();
  const pad = pickPad(pads, saved?.device);
  const odd = !pad && pads.length ? pads : null; // only devices that don't look like a controller
  const keep = saved?.device ? { device: saved.device } : {};
  const family = pad?.family || 'generic';
  const map = padMap(saved);
  const hot = padHotkeys(saved); // the fast-forward buttons – none unless picked here
  const preset = PAD_PRESETS.find((p) => p.id === saved?.preset) || PAD_PRESETS[0];
  const custom = !!saved?.map && (BUTTONS.some((b) => map[b.id] !== preset.map[b.id]) || HOTKEYS.some((h) => hot[h.id]));
  // what is stored: every game button, the hotkeys only when they have a button (the config takes no empty labels)
  const stored = (m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v));
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
    const all = { ...map, ...hot };
    const hk = isHotkey(listen);
    const other = Object.keys(all).find((id) => id !== listen && all[id] === label);
    // a hotkey doesn't push a game button off its button (that one would be left without any) – press another one
    if (hk && other && !isHotkey(other)) {
      setMsg(t('ctl.taken', '{key} is already used for {button}.', { key: padLabel(label, family, PAD_POS()), button: buttonLabel(other) }));
      return;
    }
    const next = { ...all, [listen]: label, ...(other ? { [other]: all[listen] } : {}) };
    setListen(null);
    setMsg(other ? t('pad.swapped', '{button} was on {other} – the two swapped.', { button: padLabel(label, family, PAD_POS()), other: isHotkey(other) ? hotkeyLabel(other) : buttonLabel(other) }) : null);
    save({ pads: { preset: preset.id, map: stored(next), ...keep } });
  }, [pad?.pressed?.join(), listen]);
  useEffect(() => {
    if (!listen) return undefined;
    const esc = (e) => e.key === 'Escape' && (setListen(null), (before.current = null));
    addEventListener('keydown', esc);
    // the next button pressed is the new one – it must not also move the focus (lib/padnav.mjs)
    const resume = suspendPadNav();
    return () => {
      removeEventListener('keydown', esc);
      resume();
    };
  }, [listen]);
  const pick = (id) => { setListen(null); setMsg(null); save({ pads: { preset: id, ...keep } }); };
  const choose = (device) => {
    setListen(null);
    setMsg(null);
    save({ pads: { ...(saved?.preset ? { preset: saved.preset } : {}), ...(saved?.map ? { map: saved.map } : {}), ...(device ? { device } : {}) } });
  };
  return html`<section class="panel stack">
    <h2>${t('pad.title', 'Controller')}</h2>
    <p class="small muted">${t('pad.text', 'PlayStation, Xbox, Switch and other controllers work over USB or Bluetooth. Click a button in the table, then press the new one on the controller. Changes apply right away, also to a game that is running.')}</p>
    <div class=${`pad-status ${pad ? 'on' : ''}`} role="status">
      <span class=${`led green ${pad ? 'on' : ''}`}></span>
      ${pad ? html`<span><b>${FAMILY_NAMES()[family]}</b> <span class="small faint">${padName(pad.id)}</span>${!pad.standard ? html` <span class="chip">${t('pad.nonStandard', 'unusual layout – check the buttons below')}</span>` : ''}</span>`
        : odd ? html`<span class="small">${t('pad.onlyOdd', 'No controller found – {name} doesn’t look like one. Connect your controller and press a button on it, or pick the device below if it is one.', { name: odd.map((p) => padName(p.id)).join(', ') })}</span>`
        : html`<span class="small">${t('pad.none', 'No controller found. Connect one and press any button on it.')}</span>`}
    </div>
    <${PadPicker} pads=${pads} saved=${saved} pad=${pad} onPick=${choose} />
    <label class="check"><input type="checkbox" checked=${nav} onChange=${(e) => saveNav(e.target.checked)} /><span>${t('pad.nav', 'Navigate the app with a controller')}
      <span class="hint">${t('pad.navHint', 'D-pad or left stick moves between buttons, A presses, B goes back, L and R switch sections or tabs, Start jumps to the sidebar, the right stick scrolls. While a game runs, the controller belongs to the game – pause it ({button} or Home) to use the menus.', { button: padLabel('LEFT_BOTTOM_SHOULDER', family) })}</span></span></label>
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
      <tr><th colspan="2">${t('guide.shortcuts', 'Shortcuts while playing')}</th></tr>
      ${HOTKEYS.map((h) => {
        const lit = pad && hot[h.id] && pad.pressed[PAD_LABELS.indexOf(hot[h.id])];
        return html`<tr class=${lit ? 'pad-lit' : ''}><td>${hotkeyLabel(h.id)}</td><td>
          <button type="button" class=${`kbd ctl-key${listen === h.id ? ' on' : ''}`} disabled=${!pad}
            title=${pad ? '' : t('pad.connectFirst', 'Connect a controller first')}
            onClick=${() => { before.current = null; setMsg(null); setListen(listen === h.id ? null : h.id); }}>
            ${listen === h.id ? t('pad.press', 'Press a button …') : padLabel(hot[h.id], family, PAD_POS())}</button></td></tr>`;
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
      <label class="check"><input type="checkbox" checked=${cfg.fullTurbo !== false} onChange=${(e) => save({ fullTurbo: e.target.checked })} /><span>${t('set.fullTurbo', 'Full-power turbo: no brake while fast-forwarding')}
        <span class="hint">${t('set.fullTurboHint', 'The game may use almost all of the computer’s time while fast-forwarding, and DS games skip drawing frames nobody sees. Never steps down. If the app reacts sluggishly while fast-forwarding, turn it off. Normal speed stays the same.')}</span></span></label>
      <label class="check"><input type="checkbox" disabled=${cfg.fullTurbo !== false} checked=${cfg.speedGuard === true && cfg.fullTurbo === false} onChange=${(e) => save({ speedGuard: e.target.checked })} /><span>${t('set.speedGuard', 'Step down when the computer can’t keep up')}
        <span class="hint">${cfg.fullTurbo !== false ? t('set.speedGuardFull', 'Not with full-power turbo.') : t('set.speedGuardHint', 'Off: the speed you pick stays as it is, the bar shows when a scene runs slower. On: a level that isn’t reached for a few seconds drops to the highest one that holds.')}</span></span></label>
      <label class="check"><input type="checkbox" checked=${cfg.turboMax === true} onChange=${(e) => save({ turboMax: e.target.checked })} /><span>${t('set.turboMax', 'Turbo step “Max”: as fast as this computer can')}
        <span class="hint">${t('set.turboMaxHint', 'After 4× comes “Max” – no speed limit at all. How fast it gets depends on the game and the computer.')}</span></span></label>
      <label class="check"><input type="checkbox" checked=${cfg.sounds !== false} onChange=${(e) => save({ sounds: e.target.checked })} /><span>${soundsText()}</span></label>
      <label class="check"><input type="checkbox" checked=${cfg.shareScreen !== false} onChange=${(e) => save({ shareScreen: e.target.checked })} /><span>${t('set.shareScreenAll', 'Share my screen with the other players')}
        <span class="hint">${t('set.shareScreenHint', 'While you play, the others see your game small in a corner. It is only sent while someone is watching.')}</span></span></label>
      <label class="check"><input type="checkbox" checked=${cfg.presence !== false} onChange=${(e) => save({ presence: e.target.checked })} /><span>${t('set.presence', 'Count me in “playing now” (anonymous)')}
        <span class="hint">${t('set.presenceHint', 'Only while a game runs: system, solo/Nuzlocke/SoulLink and app version with a random id, for the player count on the souldew Discord – no name, no game, no IP stored.')}
          ${' '}<a href=${LINKS.privacy} onClick=${(e) => { e.preventDefault(); e.stopPropagation(); openExternal(currentLang() === 'de' ? LINKS.privacy : LINKS.privacyDocs); }}>${t('set.presenceMore', 'What exactly is sent')}</a></span></span></label>
      <${GraphicsSetting} cfg=${cfg} save=${save} />
      <div><button class="btn ghost small" onClick=${() => save({ onboarded: false })}>${t('set.replayOnboarding', 'Show the welcome tour again')}</button></div>
    </section>

    <section class="panel stack">
      <h2>${t('set.appearance', 'Appearance')}</h2>
      <p class="small muted">${t('set.themeText', 'Colour scheme of the whole app. The colour-blind schemes replace the green/red signals (alive, dead, warnings) with colours that stay apart with that colour vision.')}</p>
      <${ThemePicker} value=${cfg.theme} onPick=${(id) => save({ theme: id })} />
    </section>

    ${!IS_TOUCH && html`<${ControlsSection} saved=${cfg.controls || null} save=${(p) => save(p).catch((e) => toast({ kind: 'death', title: t('set.controls', 'Controls'), text: e.message }))} />`}
    <${PadSection} saved=${cfg.pads || null} save=${(p) => save(p).catch((e) => toast({ kind: 'death', title: t('pad.title', 'Controller'), text: e.message }))}
      nav=${cfg.padNav !== false} saveNav=${(on) => save({ padNav: on })} />

    ${IS_TOUCH ? html`<section class="panel stack">
      <h2>${t('set.emulators', 'Emulators')}</h2>
      <p class="small muted">${t('set.emuDevice', 'Games run in the built-in emulator: Game Boy, Game Boy Color, Game Boy Advance and Nintendo DS, with live sync. Nintendo 3DS games and external emulators (Azahar, melonDS, mGBA) are not available on phones and tablets.')}</p>
    </section>` : html`<section class="panel stack">
      <h2>${t('set.emulators', 'Emulators')}</h2>
      <p class="small muted">${t('set.emuText', 'The built-in emulator plays every system up to the Nintendo 3DS and has the best live sync. 3DS games can also run in Azahar (for example when a graphics card can’t run the built-in 3DS player). External emulators are optional otherwise.')}</p>
      ${status?.native?.ok && html`<label class="check"><input type="checkbox" checked=${cfg.nativeCore !== false} onChange=${(e) => save({ nativeCore: e.target.checked })} /><span>${t('set.native', 'Fast player for DS, GBA and Game Boy')}
        <span class="hint">${t('set.nativeHint', 'Runs the game with the real emulators (melonDS, mGBA, Gambatte) directly on your computer: full speed even on weaker PCs, and fast-forward that really reaches 4× and more. Live sync, cheats, save states and the in-game save work as before. Save states from the other player can’t be loaded here (and the other way round). Off: the browser emulator as before. Applies to the next game you start.')}</span></span></label>`}
      <${CtrRendererSetting} cfg=${cfg} status=${status} save=${save} />
      <${CtrScaleSetting} cfg=${cfg} status=${status} save=${save} />
      <table class="data"><thead><tr><th>${t('set.system', 'System')}</th><th>${t('set.useEmu', 'Play with')}</th></tr></thead><tbody>
        ${SYSTEMS.map(([sys, label]) => html`<tr><td>${label}</td><td>
          <select value=${externalOnly(sys, status) ? Object.keys(status?.emulators || {}).find((id) => status.emulators[id].systems.includes(sys)) : cfg.emulatorFor?.[sys] || 'builtin'}
            disabled=${externalOnly(sys, status)} onChange=${(e) => save({ emulatorFor: { ...(cfg.emulatorFor || {}), [sys]: e.target.value } })}>
            ${!externalOnly(sys, status) && html`<option value="builtin">${t('set.builtin', 'Built-in (live)')}</option>`}
            ${Object.entries(status?.emulators || {}).filter(([, e]) => e.systems.includes(sys)).map(([id, e]) => html`<option value=${id} disabled=${!e.installed && !externalOnly(sys, status)}>${e.name}${e.live === 'script' ? ` (${t('set.liveScript', 'live via script')})` : e.live === 'rpc' ? ` (${t('set.liveRpc', 'live via RPC')})` : ` (${t('set.liveSave', 'syncs on save')})`}${e.installed ? '' : ` – ${t('set.notInstalled', 'not installed')}`}</option>`)}
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
    </section>`}

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

    <section class="panel stack" id="set-discord">
      <h2>Discord</h2>
      <${LiveRunsSettings} />
    </section>

    <section class="panel stack">
      <h2>${t('set.about', 'About')}</h2>
      <${UpdateSection} />
      <dl class="facts small">
        ${IS_ANDROID && window.SouldewApp?.appVersion && html`<dt>${t('set.androidApp', 'Android app')}</dt><dd>${window.SouldewApp.appVersion()}</dd>`}
        <dt>${t('set.randomizer', 'Randomizer')}</dt><dd>Universal Pokémon Randomizer ZX ${status?.upr?.version} · Java ${status?.java?.version || t('set.javaMissing', 'not found')}${status?.java?.bundled ? ` (${t('set.bundled', 'bundled')})` : ''}</dd>
        <dt>${t('set.data', 'Pokémon data')}</dt><dd>PokeAPI · ${t('set.covers', 'covers')}: libretro-thumbnails</dd>
        <dt>${t('set.emuCore', 'Built-in emulator')}</dt><dd>EmulatorJS (melonDS, DeSmuME, mGBA, Gambatte) · ${t('set.nativeShort', 'Fast player')}: melonDS DS, mGBA, Gambatte (libretro) · 3DS: Azahar (libretro)</dd>
      </dl>
      <div class="row">
        <button class="btn small" onClick=${() => openExternal(LINKS.github)}><${Icon} name="external" size=${14} />${t('set.github', 'souldew on GitHub')}</button>
        <button class="btn small" onClick=${() => openExternal(LINKS.issues)}><${Icon} name="external" size=${14} />${t('set.reportBug', 'Report a bug')}</button>
        <button class="btn small" onClick=${() => openExternal(LINKS.coffee)}><${Icon} name="coffee" size=${14} />${t('rail.coffee', 'Buy me a coffee')}</button>
        ${IS_ANDROID && html`<button class="btn small" onClick=${() => openExternal(LINKS.coffeeAndroid)}><${Icon} name="coffee" size=${14} />${t('nag.androidBuy', 'Support the Android app')}</button>`}
      </div>
      <label class="check small"><input type="checkbox" checked=${cfg.nagOff !== true} onChange=${(e) => save({ nagOff: !e.target.checked })} /><span>${t('set.nag', 'Show the joke license window now and then')}
        <span class="hint">${t('set.nagHint', 'A parody of old shareware nag screens. souldew stays free either way.')}</span></span></label>
      <label class="check small"><input type="checkbox" checked=${cfg.stream?.coffee !== false} onChange=${async (e) => { const on = e.target.checked; try { await api.post('/api/stream', { coffee: on }); reloadStatus?.(); } catch { toast({ kind: 'warn', title: t('set.saveFailed', 'Couldn’t save the setting') }); } }} /><span>${t('set.coffeePop', 'Coffee hint on legendary encounters in stream overlays')}
        <span class="hint">${t('set.coffeePopHint', 'Now and then a cheeky toast about the legendary pops up in your Alerts overlay, with the coffee link.')}</span></span></label>
      <p class="tiny faint">${t('set.legal', 'Pokémon and all related names are trademarks of Nintendo, Game Freak and The Pokémon Company. souldew is a fan project and does not include or download games.')}</p>
    </section>
  </div>`;
}
