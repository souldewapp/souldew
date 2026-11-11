// Shared UI pieces.
import { html, useState, useEffect, useRef, useMemo, createContext, useContext } from '/vendor/htm-preact.mjs';
import { spriteUrl, typeLabel, pokeapi, speciesName, FAKEMON as FAKEMON_ID } from './data.mjs';
import { t } from './i18n.mjs';
import { diagDump } from './diag.mjs';

export const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);
export { html };

export function Sprite({ id, shiny, size = 48, gen = 4, alt = '' }) {
  const [src, setSrc] = useState(null);
  useEffect(() => setSrc(spriteUrl(id, { gen, shiny })), [id, gen, shiny]);
  if (!id || !spriteUrl(id, { gen, shiny })) return html`<span class="sprite"><span style=${`display:inline-block;width:${size}px;height:${size}px`}></span></span>`;
  return html`<span class="sprite"><img class="pixel" src=${src} width=${size} height=${size} alt=${alt} loading="lazy"
    onError=${() => { const fb = spriteUrl(id, { gen: 9, shiny }); if (src !== fb) setSrc(fb); }} /></span>`;
}

export function Types({ types }) {
  return html`<span class="types">${(types || []).map((ty) => html`<span class=${`type t-${String(ty).toLowerCase()}`}>${typeLabel(ty)}</span>`)}</span>`;
}

/** Status light. Lit means live / online / connected and is green unless a color says otherwise. */
export function Led({ on, color = 'green', blink }) {
  return html`<span class=${`led ${color} ${on ? 'on' : ''} ${blink ? 'blink' : ''}`} aria-hidden="true"></span>`;
}

export function HpBar({ hp, max }) {
  if (!max) return null;
  const pct = Math.max(0, Math.min(100, Math.round((hp / max) * 100)));
  return html`<div class="hp" role="meter" aria-valuemin="0" aria-valuemax=${max} aria-valuenow=${hp} aria-label=${t('hp.label', 'HP')}>
    <i class=${pct <= 20 ? 'low' : pct <= 50 ? 'mid' : ''} style=${`width:${pct}%`}></i></div>`;
}

const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

/**
 * For drawers and panels that aren't a <dialog>: move focus inside when `active` turns on, keep Tab / Shift+Tab
 * inside (trap) and give focus back to the opener when it closes (restore) – if focus is still inside by then.
 */
export function useFocusTrap(ref, active, { trap = true, restore = true } = {}) {
  useEffect(() => {
    const box = ref.current;
    if (!active || !box) return undefined;
    const opener = document.activeElement;
    const list = () => [...box.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length);
    if (!box.contains(document.activeElement)) (list()[0] || box).focus?.({ preventScroll: true });
    const onKey = (e) => {
      if (!trap || e.key !== 'Tab') return;
      const els = list();
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      const inside = box.contains(document.activeElement);
      if (!inside || (e.shiftKey && document.activeElement === first)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (restore && opener?.isConnected && (box.contains(document.activeElement) || document.activeElement === document.body)) opener.focus?.({ preventScroll: true });
    };
  }, [active]);
}

let modalSeq = 0;
export function Modal({ open, onClose, title, children, footer, wide }) {
  const ref = useRef(null);
  const opener = useRef(null);
  const isOpen = useRef(open);
  isOpen.current = open;
  const [titleId] = useState(() => `modal-title-${++modalSeq}`);
  const restore = () => {
    const el = opener.current;
    opener.current = null;
    if (el?.isConnected) el.focus?.();
  };
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement;
      d.showModal();
    }
    if (!open && d.open) {
      d.close();
      restore();
    }
  }, [open]);
  useEffect(() => () => {
    // unmounted while open (most callers render the modal conditionally)
    isOpen.current = false;
    if (ref.current?.open) ref.current.close();
    restore();
  }, []);
  // Escape is handled on keydown (Chrome's close watcher may skip `cancel`); onClose syncs any other native close.
  return html`<dialog class=${`modal ${wide ? 'wide' : ''}`} ref=${ref} aria-modal="true" aria-labelledby=${titleId}
    onClick=${(e) => e.target === e.currentTarget && onClose?.()}
    onClose=${() => isOpen.current && onClose?.()}
    onCancel=${(e) => { e.preventDefault(); onClose?.(); }}
    onKeyDown=${(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose?.(); } }}>
    ${open && html`<div class="modal-body"><div class="modal-head"><h2 id=${titleId}>${title}</h2>
      <button type="button" class="modal-x" onClick=${() => onClose?.()} aria-label=${t('common.close', 'Close')} title=${t('common.close', 'Close')}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg></button></div>
      ${children}</div>${footer && html`<div class="modal-foot">${footer}</div>`}`}
  </dialog>`;
}

/**
 * Species autocomplete over all species the run's game holds (names in the UI language): National Dex 1…maxId plus
 * `extra` – a ROM hack's own Pokémon (FAKEMON ids, named as the game names them).
 */
export function SpeciesPicker({ value, onChange, autoFocus, maxId = 649, extra = [], typesOf }) {
  const [q, setQ] = useState(value ? speciesName(value) : '');
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  useEffect(() => setQ(value ? speciesName(value) : ''), [value]);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const num = Number(s);
    const out = [];
    const max = Math.min(maxId, (pokeapi()?.names?.en?.length || 650) - 1);
    const ids = [];
    for (let i = 1; i <= max; i++) ids.push(i);
    ids.push(...extra);
    for (const i of ids) if (out.length < 12 && ((num && i === num) || speciesName(i).toLowerCase().startsWith(s))) out.push(i);
    for (const i of ids) if (out.length < 12 && !out.includes(i) && speciesName(i).toLowerCase().includes(s)) out.push(i);
    return out;
  }, [q, maxId, extra]);
  const choose = (id) => {
    onChange(id);
    setQ(speciesName(id));
    setOpen(false);
  };
  return html`<div class="suggest">
    <input type="search" placeholder=${t('picker.placeholder', 'Search Pokémon (name or number)')} value=${q} autoFocus=${autoFocus} style="width:100%"
      onInput=${(e) => { setQ(e.target.value); setOpen(true); setHl(0); }}
      onFocus=${() => setOpen(true)} onBlur=${() => setTimeout(() => setOpen(false), 150)}
      onKeyDown=${(e) => {
        if (e.key === 'ArrowDown') { setHl((h) => Math.min(h + 1, results.length - 1)); e.preventDefault(); }
        if (e.key === 'ArrowUp') { setHl((h) => Math.max(h - 1, 0)); e.preventDefault(); }
        if (e.key === 'Enter' && results[hl]) { choose(results[hl]); e.preventDefault(); }
      }} />
    ${open && results.length > 0 && html`<div class="suggest-list" role="listbox">
      ${results.map((id, i) => html`<button type="button" class=${i === hl ? 'hl' : ''} onMouseDown=${(e) => { e.preventDefault(); choose(id); }}>
        <${Sprite} id=${id} size=${32} /> <span class="grow">${speciesName(id)}</span>${typesOf && html`<${Types} types=${typesOf(id)} />`}<span class="faint tiny">${id < FAKEMON_ID ? `#${id}` : ''}</span>
      </button>`)}
    </div>`}
  </div>`;
}

export function Toasts({ toasts, dismiss }) {
  return html`<div class="toasts" role="status" aria-live="polite">
    ${toasts.map((x) => html`<div class="toast" key=${x.id} onClick=${() => dismiss(x.id)}>
      <${Led} on color=${x.kind === 'death' ? 'red' : x.kind === 'ok' ? 'green' : 'amber'} />
      <div>${x.title && html`<strong>${x.title}</strong>`}<div class="small muted">${x.text}</div></div>
    </div>`)}
  </div>`;
}

export function copy(text) {
  return navigator.clipboard?.writeText(text);
}

export function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/**
 * "Save diagnostics": what the live tracker and the turbo mixer recorded this session, plus the graphics setup, as a
 * JSON file to attach to a bug report.
 */
export async function saveDiagnostics(extra = {}) {
  const info = await window.sls?.appInfo?.().catch(() => null);
  // graphics backend, Chromium switches, GPU feature status and graphics cards (desktop app only)
  const gpu = await window.sls?.gpuInfo?.().catch(() => null) ?? null;
  const dump = diagDump({ app: info ? { version: info.version, packaged: info.packaged, platform: info.platform } : null, gpu, userAgent: navigator.userAgent, lang: document.documentElement.lang, ...extra });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  download(`souldew-diagnostics-${stamp}.json`, JSON.stringify(dump));
}

export function openExternal(url) {
  if (window.sls?.openExternal) window.sls.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}
