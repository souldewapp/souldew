// Partner screen: another player's game, live and small in the bottom-right corner while you play. With three
// or four players one partner is shown at a time – the first one online, or whoever was picked (person button).
// Picture transport lives in SyncLink (lib/sync.mjs): WebRTC video when the direct link is up, small
// encrypted stills every ~1.5 s over the relay otherwise. Nothing is sent unless this view is shown.
import { html, useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { useApp } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { othersOf, players as getPlayers } from '../lib/run.mjs';
import { PARTNER_TTL } from '../lib/sync.mjs';

const PREF = 'sl-partnerscreen'; // per computer: { hidden, big, watch: { [run id]: slot } }
const STALE_MS = 20000; // a still picture older than this means the partner stopped sending
const AR = { nds: 256 / 384, gba: 3 / 2, gbc: 10 / 9, gb: 10 / 9 };

function loadPref() {
  try {
    return { hidden: false, big: false, ...JSON.parse(localStorage.getItem(PREF) || '{}') };
  } catch {
    return { hidden: false, big: false };
  }
}

function savePref(p) {
  try {
    localStorage.setItem(PREF, JSON.stringify(p));
  } catch {
    // private mode
  }
}

/** Screen source for SyncLink.startScreenShare() backed by the emulator iframe's window.__emu. */
export function emuScreenSource(getEmu, system) {
  const emu = () => {
    try {
      const e = getEmu?.();
      return e?.ready ? e : null;
    } catch {
      return null; // iframe navigated away
    }
  };
  return {
    system,
    getStream: () => emu()?.captureStream?.(15) || null,
    getSnapshot: (opts) => emu()?.snapshot?.(opts) || null,
    isActive: () => {
      const e = emu();
      return !!e && !e.paused();
    },
  };
}

/** Shares our game picture with the partner while `enabled` (re-attaches when the link is replaced). */
export function useScreenShare(link, getEmu, { system, enabled = true } = {}) {
  const ref = useRef(getEmu);
  ref.current = getEmu;
  useEffect(() => {
    if (!link || !enabled || !link.startScreenShare) return undefined;
    link.startScreenShare(emuScreenSource(() => ref.current?.(), system));
    return () => link.stopScreenShare();
  }, [link, enabled, system]);
}

/**
 * Floating mini view of another player's game.
 *   link        – the current SyncLink (useApp().link)
 *   slot        – optional: always show this player (otherwise: the picked one, else the first one online)
 *   partnerName – optional name for the header (default: the shown player's name)
 *   system      – 'nds' | 'gba' | 'gbc' | 'gb' (aspect until the first picture arrives)
 *   getEmu      – optional () => iframe.contentWindow.__emu; when given, our own picture is shared too
 *                 (unless switched off in Settings → "Share my screen with my partner")
 */
export function PartnerScreen({ link, slot: fixedSlot, partnerName, system, getEmu }) {
  const { status, manifest, doc, me, linkStatus } = useApp() || {};
  const shareOn = status?.config?.shareScreen !== false;
  useScreenShare(link, getEmu, { system, enabled: !!getEmu && shareOn });

  const [pref, setPref] = useState(loadPref);
  const [view, setView] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const [, tick] = useState(0);
  const [measured, setMeasured] = useState(null); // width / height of the picture actually received
  const video = useRef(null);
  const update = (patch) => {
    const next = { ...pref, ...patch };
    setPref(next);
    savePref(next);
  };

  // Whom to show: fixed by the caller, else picked here earlier (per run), else the first one online, else the first.
  const others = manifest && me ? othersOf(me, manifest) : link?.others || [];
  const names = manifest && doc ? getPlayers(doc, manifest) : manifest?.players || {};
  const now = Date.now();
  const online = others.filter((s) => linkStatus?.partners?.[s] && now - linkStatus.partners[s].seen < PARTNER_TTL);
  const picked = manifest && pref.watch?.[manifest.id];
  const slot = (others.includes(fixedSlot) && fixedSlot) || (others.includes(picked) && picked) || online[0] || others[0] || null;
  const name = (fixedSlot || others.length > 1 ? names[slot]?.name : partnerName || names[slot]?.name) || t('common.partner', 'Partner');
  const next = !fixedSlot && manifest && others.length > 1 ? others[(others.indexOf(slot) + 1) % others.length] : null;
  const nextName = next ? names[next]?.name || next.toUpperCase() : '';
  const pick = () => {
    setMeasured(null);
    update({ watch: { ...(pref.watch || {}), [manifest.id]: next } });
  };

  // Watching is what makes that player send – hidden mini view → no subscription → no traffic.
  useEffect(() => {
    setView(null);
    if (!link?.watchPartnerScreen || pref.hidden || !slot) return undefined;
    return link.watchPartnerScreen((v) => setView(v), slot);
  }, [link, pref.hidden, slot]);

  const stream = view?.mode === 'stream' ? view.stream : null;
  const imageMode = view?.mode === 'image' && !!view.url;
  const age = imageMode ? Date.now() - view.at : 0;
  const live = !!view?.active && (!!stream || (imageMode && age < STALE_MS));
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (stream) el.play?.().catch(() => {});
  }, [stream, live]);

  // Age label for still pictures (and noticing when they stop coming).
  useEffect(() => {
    if (!imageMode) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [imageMode]);

  useEffect(() => {
    if (live) setDismissed(false);
  }, [live]);

  if (!link) return null;
  // Clicking here must not take the keyboard away from the game iframe.
  const keepFocus = (e) => e.preventDefault();
  const switcher = next && html`<button class="ps-btn" onMouseDown=${keepFocus} onClick=${pick}
    title=${t('ps.switch', 'Show {name}’s screen instead', { name: nextName })} aria-label=${t('ps.switch', 'Show {name}’s screen instead', { name: nextName })}><${Icon} name="user" size=${12} /></button>`;
  if (pref.hidden) {
    return html`<button class="ps-tab" onMouseDown=${keepFocus} onClick=${() => update({ hidden: false })} title=${t('ps.show', 'Show {name}’s screen', { name })}>
      <span class="ps-dot" aria-hidden="true"></span>${t('ps.showShort', '{name}’s screen', { name })}</button>`;
  }
  if (!live) {
    // Only claim "not playing" when the partner's app can share at all (it told us its state once). With more
    // partners the pill stays anyway – it holds the button to watch somebody else.
    if ((!view?.known && !next) || dismissed) return null;
    return html`<div class="ps-pill" role="status">
      <span class="ps-dot off" aria-hidden="true"></span><span>${!view?.known
        ? t('ps.noPicture', 'No picture from {name} right now', { name })
        : view.active
        ? t('ps.connecting', 'Connecting to {name}’s picture …', { name })
        : view.paused
          ? t('ps.paused', '{name}’s game is in a background tab – no picture right now', { name })
          : t('ps.notPlaying', '{name} isn’t playing right now', { name })}</span>
      ${switcher}
      <button class="ps-x" onMouseDown=${keepFocus} onClick=${() => setDismissed(true)} aria-label=${t('common.close', 'Close')} title=${t('common.close', 'Close')}><${Icon} name="close" size=${10} /></button>
    </div>`;
  }

  const sys = view.system || system;
  // the real picture decides (a DS can be shown with its screens side by side); the system is the fallback
  const ar = measured || AR[sys] || 3 / 2;
  const measure = (w, h) => w && h && Math.abs(w / h - (measured || 0)) > 0.01 && setMeasured(w / h);
  const secs = Math.round(age / 1000);
  const label = stream || secs < 4 ? t('ps.live', 'live') : t('ps.ago', '{n} s ago', { n: secs });
  return html`<section class=${`ps ${pref.big ? 'big' : ''} ${ar < 1 ? 'portrait' : ar > 2 ? 'wide' : ''}`} aria-label=${t('ps.title', '{name}’s game', { name })}>
    <header class="ps-head">
      <span class=${`ps-dot ${stream || secs < 4 ? '' : 'stale'}`} aria-hidden="true"></span>
      <b class="px ps-name">${name}</b>
      <span class="ps-age mono">${label}</span>
      <span class="spacer"></span>
      ${switcher}
      <button class="ps-btn" onMouseDown=${keepFocus} onClick=${() => update({ big: !pref.big })} aria-pressed=${pref.big}
        title=${pref.big ? t('ps.smaller', 'Smaller') : t('ps.bigger', 'Bigger')} aria-label=${pref.big ? t('ps.smaller', 'Smaller') : t('ps.bigger', 'Bigger')}>
        <${Icon} name=${pref.big ? 'shrink' : 'full'} size=${12} /></button>
      <button class="ps-btn" onMouseDown=${keepFocus} onClick=${() => update({ hidden: true })} title=${t('ps.hide', 'Hide')} aria-label=${t('ps.hide', 'Hide')}><${Icon} name="close" size=${12} /></button>
    </header>
    <div class="ps-screen" style=${`aspect-ratio:${ar}`}>
      ${stream
        ? html`<video ref=${video} autoplay muted playsinline disablepictureinpicture
            onLoadedMetadata=${(e) => measure(e.target.videoWidth, e.target.videoHeight)} onResize=${(e) => measure(e.target.videoWidth, e.target.videoHeight)}></video>`
        : html`<img src=${view.url} alt=${t('ps.alt', 'What {name} sees right now', { name })} onLoad=${(e) => measure(e.target.naturalWidth, e.target.naturalHeight)} />`}
    </div>
  </section>`;
}
