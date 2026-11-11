// Party menu: Pokémon shown like the in-game party screen (Gen 4/5 style) –
// a grid of rounded panels, two per row, lead slot slightly emphasized.
//
// Usage:
//   <PartyGrid party=${mons} gen=${4} accent="var(--p1)" />            board / pages
//   <PartyGrid party=${mons} gen=${4} compact />                       ~300px sidebar (2 × ~145px)
//   <PartyGrid party=${mons} gen=${4} layout="row" />                  overlay strip (6 in a row, 3 × 2 when narrow)
//   <TeamColumns slots=${['p1','p2','p3']} teams=${{ p1: [...] }} … />  one party menu per player (1–4 columns)
//
// Mon shape: { species, nickname|nick, level, hp, maxHp, shiny, gender ('M'|'F'|'-'|null),
//              status (raw status byte or 'slp'|'psn'|'brn'|'frz'|'par'|'tox'|'fnt'), item, area? }
import { html } from '/vendor/htm-preact.mjs';
import { Sprite, HpBar, Types } from '../lib/ui.mjs';
import { speciesName, itemName } from '../lib/data.mjs';
import { t } from '../lib/i18n.mjs';

const nameOf = (m) => m.nickname || m.nick || speciesName(m.species);
/** A level worth showing: 1–100 (a garbage value from an older partner app or a bad read shows nothing). */
export const shownLevel = (l) => (Number.isInteger(l) && l >= 1 && l <= 100 ? l : null);

/** Normalizes a status (raw Gen 1–5 status byte, or a string) to slp/psn/tox/brn/frz/par/fnt or ''. */
export function statusOf(m) {
  if (!m) return '';
  if (m.maxHp > 0 && m.hp === 0) return 'fnt';
  const s = m.status;
  if (!s) return '';
  if (typeof s === 'string') {
    const k = s.toLowerCase().slice(0, 3);
    return { sle: 'slp', poi: 'psn', bur: 'brn', fre: 'frz', fro: 'frz', fai: 'fnt', ko: 'fnt' }[k] || (['slp', 'psn', 'tox', 'brn', 'frz', 'par', 'fnt'].includes(k) ? k : '');
  }
  if (typeof s !== 'number') return '';
  if (s & 7) return 'slp';
  if (s & 0x80) return 'tox';
  if (s & 0x08) return 'psn';
  if (s & 0x10) return 'brn';
  if (s & 0x20) return 'frz';
  if (s & 0x40) return 'par';
  return '';
}

export function statusLabel(k) {
  return {
    slp: t('party.slp', 'SLP'), psn: t('party.psn', 'PSN'), tox: t('party.tox', 'TOX'), brn: t('party.brn', 'BRN'),
    frz: t('party.frz', 'FRZ'), par: t('party.par', 'PAR'), fnt: t('party.fnt', 'FNT'),
  }[k] || '';
}

/**
 * One party-menu panel.
 * Props: mon (null → empty slot), gen, lead, compact, accent, dead (pair died → red tint even with HP left),
 * types (shown instead of the HP bar when no HP is known), caption (small line at the bottom, e.g. the area),
 * placeholder (text for an empty slot), onPick (makes it a button), size (sprite px override).
 */
export function PartyPanel({ mon, gen = 4, lead, compact, accent, dead, types, caption, placeholder, onPick, size, index = 0, noItems = false }) {
  const style = accent ? `--acc:${accent}` : '';
  if (!mon) {
    return html`<div class=${`pp empty ${compact ? 'compact' : ''}`} style=${style} aria-label=${placeholder || t('party.empty', 'Empty slot')}>
      ${placeholder ? html`<span class="pp-ph">${placeholder}</span>` : html`<span class="pp-ball" aria-hidden="true"></span>`}
    </div>`;
  }
  const st = statusOf(mon);
  const fainted = st === 'fnt' || dead;
  const name = nameOf(mon);
  const species = speciesName(mon.species);
  const showSpecies = species && name.toLowerCase() !== species.toLowerCase();
  const g = mon.gender === 'M' || mon.gender === 'F' ? mon.gender : null;
  // (noItems: this game's held items can't be named with confidence – shared/live/features.mjs – so none are shown)
  const hasItem = !noItems && mon.item !== undefined && mon.item !== null && mon.item !== 0 && mon.item !== '';
  // the held item by name (Gen 3–5; a ROM hack's own item by the name the game gives it – '' when that isn't known: Gen
  // 1/2, a hack whose item table wasn't found)
  const item = hasItem ? (typeof mon.item === 'string' ? mon.item : mon.itemOwn ? mon.itemName || '' : itemName(mon.item, gen)) : '';
  const px = size || (compact ? 40 : 56);
  const lv = shownLevel(mon.level);
  const cls = `pp ${compact ? 'compact' : ''} ${lead ? 'lead' : ''} ${fainted ? 'fainted' : ''} ${mon.shiny ? 'shiny' : ''} ${onPick ? 'pick' : ''}`;
  const label = [name, showSpecies ? species : '', lv ? `${t('common.lv', 'Lv')} ${lv}` : '', mon.maxHp ? `${mon.hp}/${mon.maxHp} ${t('hp.label', 'HP')}` : '', st ? statusLabel(st) : '', item ? t('party.holds', 'holds {item}', { item }) : ''].filter(Boolean).join(', ');
  const body = html`
    <span class="pp-sprite" style=${`--sp:${px}px`}>
      <${Sprite} id=${mon.species} shiny=${mon.shiny} size=${px} gen=${gen} />
      ${hasItem && html`<i class="pp-item" title=${item || t('party.item', 'Holds an item')}></i>`}
    </span>
    <span class="pp-top">
      <span class="pp-name">${name}</span>
      ${g && html`<span class=${`pp-g ${g === 'M' ? 'm' : 'f'}`} aria-hidden="true">${g === 'M' ? '♂' : '♀'}</span>`}
      ${mon.shiny && html`<span class="pp-shiny" title=${t('common.shiny', 'shiny')} aria-hidden="true">★</span>`}
    </span>
    <span class="pp-meta">
      ${lv ? html`<span class="pp-lv">${t('common.lv', 'Lv')}${compact ? '' : ' '}${lv}</span>` : ''}
      ${st && html`<span class=${`pp-st ${st}`}>${statusLabel(st)}</span>`}
      ${showSpecies && !compact && html`<span class="pp-species">${species}</span>`}
      ${item && !compact && html`<span class="pp-held">${item}</span>`}
    </span>
    ${mon.maxHp
      ? html`<span class="pp-hp"><span class="pp-hpl" aria-hidden="true">${t('hp.label', 'HP')}</span><${HpBar} hp=${mon.hp} max=${mon.maxHp} />
          <span class="pp-hpn">${mon.hp}/${mon.maxHp}</span></span>`
      : types && html`<span class="pp-hp pp-types"><${Types} types=${types} /></span>`}
    ${caption && html`<span class="pp-cap">${caption}</span>`}`;
  return onPick
    ? html`<button type="button" class=${cls} style=${style} title=${label} aria-label=${label} onClick=${() => onPick(mon, index)}>${body}</button>`
    : html`<div class=${cls} style=${style} title=${label} role="group" aria-label=${label}>${body}</div>`;
}

/**
 * The party menu grid (up to 6 panels, empty slots padded).
 * Props: party, gen, compact, accent ('var(--p1)' …), emptySlots (pad to 6), onPick(mon, index),
 * layout ('grid' = 2 columns | 'row' = 6 in a row, 3 × 2 when narrow), typesOf(species) for mons without HP,
 * caption(mon) → small text under a panel (e.g. area name), isDead(mon) → force the fainted look.
 */
export function PartyGrid({ party, gen = 4, compact, accent, emptySlots = true, onPick, layout = 'grid', typesOf, caption, isDead, label, noItems = false }) {
  const mons = (party || []).filter((m) => m && m.species).slice(0, 6);
  const pad = emptySlots ? Math.max(0, 6 - mons.length) : 0;
  const small = compact || layout === 'row';
  return html`<div class=${`party-wrap ${layout === 'row' ? 'row' : ''}`}>
    <div class=${`party ${layout === 'row' ? 'row' : ''} ${small ? 'compact' : ''}`} role="list" aria-label=${label || t('party.title', 'Party')}>
      ${mons.map((m, i) => html`<div role="listitem" class="party-cell" key=${m.key || `${i}-${m.species}`}>
        <${PartyPanel} mon=${m} gen=${gen} lead=${i === 0} compact=${small} accent=${accent} index=${i} onPick=${onPick} noItems=${noItems}
          dead=${isDead ? isDead(m) : false} types=${typesOf && !m.maxHp ? typesOf(m.species) : null} caption=${caption ? caption(m) : null} /></div>`)}
      ${Array.from({ length: pad }, (_, i) => html`<div role="listitem" class="party-cell" key=${`empty-${i}`}><${PartyPanel} mon=${null} compact=${small} accent=${accent} /></div>`)}
    </div>
  </div>`;
}

/**
 * Every player's party menu next to each other – one column per player (1–4). Each column gets its player
 * colour (`--p1` … `--p4`) as the accent and a header with name and team size; four columns fall back to
 * 2 × 2 when the board is narrow, a solo run is one column.
 * Props: slots (['p1', …]), teams ({ slot: [mon] }), names ({ slot: name }), gen, typesOf(species, slot),
 * caption(mon, slot), isDead(mon, slot), me (marks the own column), head (false → no header).
 */
export function TeamColumns({ slots, teams, names, gen = 4, typesOf, caption, isDead, me, head = true }) {
  return html`<div class=${`team-cols n${slots.length}`}>
    ${slots.map((s) => html`<div class="team-col stack-s" key=${s}>
      ${head && html`<div class=${`pair-who who-${s}`}><span>${names?.[s] || s.toUpperCase()}</span>
        ${s === me && slots.length > 1 && html`<span class="tiny faint">(${t('common.you', 'you')})</span>`}
        <span class="tiny faint">${(teams?.[s] || []).filter((m) => m?.species).length}/6</span></div>`}
      <${PartyGrid} party=${teams?.[s] || []} gen=${gen} accent=${`var(--${s})`} label=${names?.[s] || ''}
        typesOf=${typesOf ? (id) => typesOf(id, s) : null} caption=${caption ? (m) => caption(m, s) : null} isDead=${isDead ? (m) => isDead(m, s) : null} />
    </div>`)}
  </div>`;
}
