// Trophies: the Pokédex across every run, the achievements and the medal case – plus the unlock toast.
// Everything is computed by the server from the run docs (server/lib/trophies.mjs); this page only shows it.
import { html, useState, useEffect, useMemo, useRef } from '/vendor/htm-preact.mjs';
import { useApp, Types, Modal } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, currentLang } from '../lib/i18n.mjs';
import { speciesName, baseTypes, typeLabel } from '../lib/data.mjs';
import { useTrophies } from '../lib/trophies.mjs';
import { Medal } from '../lib/medals.mjs';
import { achText, catLabel, rarityLabel, tierLabel, medalName, medalHow } from '../lib/trophytexts.mjs';
import { GENERATIONS, SUPPORTED_MAX, MAX_SPECIES, CATEGORIES, TIERS, POINTS, obtainable } from '/shared/trophies.mjs';

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
const TYPES = ['normal', 'fire', 'water', 'grass', 'electric', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'];
const pad = (id) => `#${String(id).padStart(4, '0')}`;
const sprite = (id, shiny) => `/sprites/${shiny ? 'shiny' : 'default'}/${id}.png`;
const day = (at) => (at ? new Intl.DateTimeFormat(currentLang(), { dateStyle: 'medium' }).format(at) : '');
const ACH_ICON = {
  firstRun: 'play', runs10: 'reset', allGens: 'globe', level100: 'fast', firstEvolution: 'fast', evolutions25: 'fast', firstBadge: 'badge', badges8: 'badge',
  badges16: 'badge', badges50: 'badge', firstWin: 'trophy', winSoulLink: 'trophy', winNuzlocke: 'trophy', wins5: 'trophy', hardcoreWin: 'crown',
  firstCatch: 'ball', catches50: 'ball', catches250: 'ball', seen100: 'eye', firstShiny: 'star', shiny5: 'star', jealous: 'star', legendary: 'crown', legendary5: 'crown',
  oneHp: 'heart', cleanBadge: 'check', cleanFour: 'check', deathlessWin: 'crown', underdog: 'bolt', underdog3: 'bolt',
  soulTwins: 'link', telepathy: 'link', groupLink: 'user', fellowship: 'user', carried: 'user', atlas: 'user', notMe: 'user',
  randoStart: 'dice', rando10: 'dice', randoWin: 'dice', randoLegend: 'crown', randoDex: 'dice', randoHack: 'dice', bothWorlds: 'globe',
  cemetery: 'grave', lavender: 'grave', bloodbath: 'grave', doubleTrouble: 'grave', starterDown: 'grave', tooSoon: 'grave', glowUp: 'grave',
  speedrun: 'clock', nightOwl: 'clock', tenthTime: 'reset', candyCrush: 'candy', nameGame: 'user', butterfingers: 'ball', zubat: 'ball',
  bidoof: 'crown', skillIssue: 'close', rival: 'user', magikarp: 'grave', rattata: 'grave', nuzlose: 'reset', starterTrio: 'ball', eevee: 'star',
};
const CAT_ICON = { journey: 'map', collection: 'ball', skill: 'bolt', soullink: 'link', randomizer: 'dice', fun: 'heart' };

/** The rarity-coloured tile of an achievement. */
function AchIcon({ a, size = 22 }) {
  const shown = a.ok || !a.hidden;
  return html`<span class=${`ach-icon r-${a.rarity} ${a.ok ? 'got' : ''}`} aria-hidden="true">
    <${Icon} name=${shown ? ACH_ICON[a.id] || CAT_ICON[a.cat] : 'lock'} size=${size} /></span>`;
}

// ---- Pokédex -------------------------------------------------------------------------

function stateOf(e, id) {
  if (!obtainable(id)) return 'locked';
  if (e?.caught) return 'caught';
  if (e && e.seenAt !== null && e.seenAt !== undefined) return 'seen';
  return 'unknown';
}

function DexCell({ id, e, on, onPick }) {
  const st = stateOf(e, id);
  const name = speciesName(id);
  const label = `${pad(id)} ${name} – ${{ caught: t('dex.caught', 'caught'), seen: t('dex.seen', 'seen'), unknown: t('dex.unknown', 'not seen yet'), locked: t('dex.locked', 'not in souldew’s games yet') }[st]}`;
  return html`<button type="button" class=${`dex-cell ${st} ${on ? 'on' : ''}`} onClick=${() => onPick(id)} aria-pressed=${on} aria-label=${label} title=${label} data-id=${id}>
    <span class="dex-no">${pad(id)}</span>
    <span class="dex-art"><img class="pixel" src=${sprite(id)} alt="" loading="lazy" decoding="async" width="68" height="68"
      onError=${(ev) => ev.currentTarget.parentNode.classList.add('broken')} /></span>
    <span class="dex-name">${name}</span>
    <span class="dex-marks">
      ${e?.shiny > 0 && html`<span class="dex-mark shiny" title=${t('dex.shinyCaught', 'Shiny caught')}><${Icon} name="star" size=${11} /></span>`}
      ${e?.died > 0 && html`<span class="dex-mark died" title=${t('dex.diedN', '{n} died|{n} died', { n: e.died, count: e.died })}><${Icon} name="grave" size=${11} /></span>`}
      ${st === 'locked' && html`<span class="dex-mark lock"><${Icon} name="lock" size=${11} /></span>`}
    </span>
  </button>`;
}

function DexDetail({ id, e, navigate, runs }) {
  const [shiny, setShiny] = useState(false);
  useEffect(() => setShiny(false), [id]);
  if (!id) return null;
  const st = stateOf(e, id);
  const types = baseTypes(id, 9);
  const gen = GENERATIONS.find((g) => id >= g.from && id <= g.to);
  const first = e?.first;
  const live = new Set((runs || []).filter((r) => !r.archived).map((r) => r.id));
  const openRun = (h) => live.has(h.runId) && navigate(h.mode === 'nuzlocke' ? 'nuzlocke' : 'soullink', { run: h.runId });
  const status = {
    caught: t('dex.caughtTimes', 'Caught {n}×', { n: e?.caught || 0 }),
    seen: t('dex.seenOnly', 'Seen, not caught yet'),
    unknown: t('dex.notSeen', 'Not seen yet'),
    locked: t('dex.lockedShort', 'Not catchable yet'),
  }[st];
  return html`<aside class=${`dex-detail screen ${st}`} aria-live="polite">
    <div class="dd-head">
      <span class="dd-no">${pad(id)}</span>
      <h2 class="dd-name">${speciesName(id)}</h2>
      <span class="dd-gen">${t('dex.genRegion', 'Gen {gen} · {region}', { gen: ROMAN[gen?.gen || 0], region: gen?.region || '' })}</span>
    </div>
    <div class="dd-stage">
      <img class="pixel" src=${sprite(id, shiny)} alt=${speciesName(id)} width="192" height="192" onError=${(ev) => ev.currentTarget.parentNode.classList.add('broken')} />
      ${e?.shiny > 0 && html`<button type="button" class=${`dd-shiny ${shiny ? 'on' : ''}`} onClick=${() => setShiny(!shiny)} aria-pressed=${shiny}
        title=${t('dex.showShiny', 'Show the shiny colours')}><${Icon} name="star" size=${14} /></button>`}
    </div>
    <div class="dd-types">${st !== 'unknown' ? html`<${Types} types=${types} />` : html`<span class="faint tiny">${t('dex.typesUnknown', 'Types: ???')}</span>`}</div>
    <div class=${`dd-status ${st}`}><span class="dd-dot"></span>${status}</div>
    ${st === 'locked' && html`<p class="dd-note">${t('dex.lockedText', 'Gen {gen} isn’t in any game souldew plays yet (it plays Gen 1–5). This Pokémon is listed for completeness – it becomes catchable once souldew supports its generation.', { gen: ROMAN[gen?.gen || 0] })}</p>`}
    ${st === 'unknown' && html`<p class="dd-note">${t('dex.unknownText', 'Meet it in one of your runs – in battle, as a catch, or on your partner’s side – and it shows up here.')}</p>`}
    ${st === 'seen' && html`<p class="dd-note">${t('dex.seenText', 'You’ve met it, but it never joined your team.')}</p>`}
    ${first && html`<dl class="dd-facts">
      <dt>${t('dex.firstCatch', 'First catch')}</dt><dd>${day(first.at) || '–'}</dd>
      <dt>${t('dex.run', 'Run')}</dt><dd>${first.runName || '–'}</dd>
      <dt>${t('dex.route', 'Route')}</dt><dd>${first.area === 'starter' ? t('area.starter', 'Starter') : first.areaName || '–'}</dd>
      <dt>${t('dex.nickname', 'Nickname')}</dt><dd>${first.nickname || '–'}</dd>
      ${first.evolved && html`<dt>${t('dex.how', 'How')}</dt><dd>${t('dex.evolvedFrom', 'evolved from {name}', { name: speciesName(first.as) })}</dd>`}
      <dt>${t('dex.shinies', 'Shiny')}</dt><dd>${e.shiny ? `${e.shiny}×` : '–'}</dd>
      <dt>${t('dex.died', 'Died')}</dt><dd class=${e.died ? 'dd-dead' : ''}>${e.died ? `${e.died}×` : '–'}</dd>
    </dl>`}
    ${e?.history?.length > 0 && html`<div class="dd-history">
      <h3>${t('dex.history', 'Your history')}</h3>
      <ol>${e.history.map((h) => html`<li class=${h.dead ? 'dead' : ''}>
        <button type="button" class="dd-run" onClick=${() => openRun(h)} disabled=${!live.has(h.runId)} title=${live.has(h.runId) ? t('dex.openRun', 'Open this run') : t('dex.runGone', 'This run was deleted')}>
          <b>${h.nickname || speciesName(h.as)}</b>
          <span>${[h.runName, h.area === 'starter' ? t('area.starter', 'Starter') : h.areaName, h.level ? t('dex.lv', 'Lv. {lv}', { lv: h.level }) : ''].filter(Boolean).join(' · ')}</span>
        </button>
        <span class="dd-when">${h.dead ? html`<${Icon} name="grave" size=${12} />` : h.shiny ? html`<${Icon} name="star" size=${12} />` : ''}${day(h.at)}</span>
      </li>`)}</ol>
    </div>`}
  </aside>`;
}

/** Narrow window: the species detail opens as a dialog instead of the screen beside the grid. */
function useNarrow(query = '(max-width: 960px)') {
  const [narrow, setNarrow] = useState(() => !!globalThis.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = globalThis.matchMedia?.(query);
    if (!mq) return undefined;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

function Pokedex({ tr }) {
  const { navigate } = useApp();
  const narrow = useNarrow();
  const [sheet, setSheet] = useState(false);
  const [q, setQ] = useState('');
  const [show, setShow] = useState('all');
  const [gen, setGen] = useState(0);
  const [type, setType] = useState('');
  const [pick, setPick] = useState(null);
  const dex = tr.dex || {};
  const per = Object.fromEntries((tr.totals?.perGen || []).map((g) => [g.gen, g]));
  const ids = useMemo(() => {
    const s = q.trim().toLowerCase();
    const n = Number(s.replace('#', ''));
    const out = [];
    for (let id = 1; id <= MAX_SPECIES; id++) {
      const e = dex[id];
      const st = stateOf(e, id);
      if (gen && !(id >= GENERATIONS[gen - 1].from && id <= GENERATIONS[gen - 1].to)) continue;
      if (show === 'caught' && st !== 'caught') continue;
      if (show === 'seen' && st !== 'seen') continue;
      if (show === 'missing' && (st === 'caught' || st === 'locked')) continue;
      if (type && !baseTypes(id, 9).includes(type)) continue;
      if (s && !(n && n === id) && !speciesName(id).toLowerCase().includes(s)) continue;
      out.push(id);
    }
    return out;
  }, [dex, q, show, gen, type, currentLang()]);
  // the first caught one (or the first shown) is selected to begin with
  useEffect(() => {
    if (pick && ids.includes(pick)) return;
    setPick(ids.find((id) => dex[id]?.caught) || ids[0] || null);
  }, [ids]);
  const groups = GENERATIONS.map((g) => ({ ...g, ids: ids.filter((id) => id >= g.from && id <= g.to) })).filter((g) => g.ids.length);
  const gridRef = useRef(null);
  // arrow keys move through the grid like a Pokédex
  const onKey = (ev) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key) || !ev.target.closest?.('.dex-cell')) return;
    const cells = [...gridRef.current.querySelectorAll('.dex-cell')];
    const i = cells.indexOf(ev.target.closest('.dex-cell'));
    const cols = Math.max(1, Math.round(gridRef.current.querySelector('.dex-grid')?.clientWidth / (cells[0]?.offsetWidth + 8)) || 1);
    const j = i + ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[ev.key]);
    if (cells[j]) {
      ev.preventDefault();
      cells[j].focus();
      setPick(Number(cells[j].dataset.id));
    }
  };
  return html`<div class="dex-wrap">
    <div class="dex-tools">
      <input type="search" placeholder=${t('dex.search', 'Search name or number')} value=${q} onInput=${(ev) => setQ(ev.target.value)} aria-label=${t('dex.search', 'Search name or number')} />
      <div class="seg" role="group" aria-label=${t('dex.filter', 'Show')}>
        ${[['all', t('dex.fAll', 'All')], ['caught', t('dex.fCaught', 'Caught')], ['seen', t('dex.fSeen', 'Seen')], ['missing', t('dex.fMissing', 'Missing')]].map(([k, l]) => html`<button type="button" class=${show === k ? 'on' : ''} aria-pressed=${show === k} onClick=${() => setShow(k)}>${l}</button>`)}
      </div>
      <select value=${type} onChange=${(ev) => setType(ev.target.value)} aria-label=${t('dex.type', 'Type')}>
        <option value="">${t('dex.allTypes', 'All types')}</option>
        ${TYPES.map((ty) => html`<option value=${ty}>${typeLabel(ty)}</option>`)}
      </select>
    </div>
    <div class="dex-gens" role="group" aria-label=${t('dex.generation', 'Generation')}>
      <button type="button" class=${`gen-chip ${gen === 0 ? 'on' : ''}`} aria-pressed=${gen === 0} onClick=${() => setGen(0)}>
        <b>${t('dex.national', 'National')}</b><span>${tr.totals?.caught || 0}/${SUPPORTED_MAX}</span>
        <i class="gen-bar"><i style=${`width:${Math.round(((tr.totals?.caught || 0) / SUPPORTED_MAX) * 100)}%`}></i></i></button>
      ${GENERATIONS.map((g) => {
        const p = per[g.gen];
        return html`<button type="button" class=${`gen-chip ${gen === g.gen ? 'on' : ''} ${p?.supported ? '' : 'locked'}`} aria-pressed=${gen === g.gen} onClick=${() => setGen(gen === g.gen ? 0 : g.gen)}
          title=${p?.supported ? `${g.region} · #${g.from}–#${g.to}` : t('dex.genLocked', 'Gen {gen} isn’t in souldew’s games yet', { gen: ROMAN[g.gen] })}>
          <b>${ROMAN[g.gen]}</b><span>${p?.supported ? `${p.caught}/${p.total}` : html`<${Icon} name="lock" size=${11} />`}</span>
          <i class="gen-bar"><i style=${`width:${p?.supported ? Math.round((p.caught / p.total) * 100) : 0}%`}></i></i></button>`;
      })}
    </div>
    <div class="dex-body">
      <div class="dex-list" ref=${gridRef} onKeyDown=${onKey}>
        ${groups.length === 0 && html`<div class="empty-state"><${Icon} name="search" size=${64} /><p class="muted">${t('dex.none', 'No Pokémon match these filters.')}</p></div>`}
        ${groups.map((g) => {
          const p = per[g.gen];
          return html`<section class=${`dex-sec ${p?.supported ? '' : 'locked'}`} key=${g.gen}>
            <header class="dex-sec-head">
              <h3><span class="dex-roman">${ROMAN[g.gen]}</span>${g.region}</h3>
              <span class="faint tiny">#${g.from}–#${g.to}</span>
              <span class="spacer"></span>
              ${p?.supported ? html`<span class="dex-count"><b>${p.caught}</b>/${p.total}</span>`
                : html`<span class="chip"><${Icon} name="lock" size=${11} />${t('dex.genSoon', 'Not in souldew’s games yet')}</span>`}
            </header>
            <div class="dex-grid">${g.ids.map((id) => html`<${DexCell} key=${id} id=${id} e=${dex[id]} on=${pick === id} onPick=${(x) => { setPick(x); if (narrow) setSheet(true); }} />`)}</div>
          </section>`;
        })}
      </div>
      ${!narrow && html`<${DexDetail} id=${pick} e=${dex[pick]} navigate=${navigate} runs=${tr.runs} />`}
    </div>
    ${narrow && html`<${Modal} open=${sheet} onClose=${() => setSheet(false)} title=${pick ? `${pad(pick)} ${speciesName(pick)}` : ''}>
      <${DexDetail} id=${pick} e=${dex[pick]} navigate=${navigate} runs=${tr.runs} />
    <//>`}
  </div>`;
}

// ---- achievements --------------------------------------------------------------------

function AchCard({ a }) {
  const secret = a.hidden && !a.ok;
  const { name, desc } = achText(a.id, a.target);
  const pct = Math.round((a.n / a.target) * 100);
  return html`<article class=${`ach-card r-${a.rarity} ${a.ok ? 'got' : 'open'} ${secret ? 'secret' : ''}`}>
    <${AchIcon} a=${a} />
    <div class="ach-text">
      <h3>${secret ? t('trophy.secret', 'Secret achievement') : name}</h3>
      <p>${secret ? t('trophy.secretText', 'Keep playing – you’ll know it when it happens.') : desc}</p>
      <div class="ach-foot">
        <span class=${`rarity r-${a.rarity}`}>${rarityLabel(a.rarity)}</span>
        <span class="faint tiny num">${t('trophy.points', '{n} pts', { n: POINTS[a.rarity] })}</span>
        <span class="spacer"></span>
        ${a.ok ? html`<span class="ach-date"><${Icon} name="check" size=${12} />${day(a.at)}</span>`
          : a.target > 1 && !secret ? html`<span class="ach-prog" role="meter" aria-valuemin="0" aria-valuemax=${a.target} aria-valuenow=${a.n} aria-label=${t('trophy.progress', 'Progress')}>
              <i class="ach-bar"><i style=${`width:${pct}%`}></i></i><span class="num">${a.n}/${a.target}</span></span>` : null}
      </div>
    </div>
  </article>`;
}

function Achievements({ tr }) {
  const [cat, setCat] = useState('all');
  const [show, setShow] = useState('all');
  const list = tr.achievements || [];
  const shown = list.filter((a) => (cat === 'all' || a.cat === cat) && (show === 'all' || (show === 'got' ? a.ok : !a.ok)));
  const recent = list.filter((a) => a.ok).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 4);
  const order = (a) => (a.ok ? 0 : a.target > 1 && a.n > 0 ? 1 : a.hidden ? 3 : 2);
  const sorted = [...shown].sort((a, b) => order(a) - order(b) || (a.ok && b.ok ? (b.at || 0) - (a.at || 0) : 0));
  return html`<div class="stack-l">
    ${recent.length > 0 && html`<section class="ach-recent" aria-label=${t('trophy.recent', 'Recently unlocked')}>
      <h3 class="eyebrow">${t('trophy.recent', 'Recently unlocked')}</h3>
      <div class="ach-recent-row">${recent.map((a) => html`<div class=${`ach-mini r-${a.rarity}`}><${AchIcon} a=${a} size=${18} />
        <div><b>${achText(a.id, a.target).name}</b><span class="faint tiny">${rarityLabel(a.rarity)} · ${day(a.at)}</span></div></div>`)}</div>
    </section>`}
    <div class="ach-cats" role="group" aria-label=${t('trophy.category', 'Category')}>
      <button type="button" class=${`cat-chip ${cat === 'all' ? 'on' : ''}`} aria-pressed=${cat === 'all'} onClick=${() => setCat('all')}>
        <b>${t('trophy.all', 'All')}</b><span class="num">${list.filter((a) => a.ok).length}/${list.length}</span></button>
      ${CATEGORIES.map((c) => {
        const l = list.filter((a) => a.cat === c);
        const m = (tr.medals || []).find((x) => x.id === `cat-${c}`);
        return html`<button type="button" class=${`cat-chip ${cat === c ? 'on' : ''}`} aria-pressed=${cat === c} onClick=${() => setCat(cat === c ? 'all' : c)}>
          <${Medal} kind=${c} tier=${m?.tier >= 0 ? TIERS[m.tier] : null} size=${18} shine=${false} />
          <b>${catLabel(c)}</b><span class="num">${l.filter((a) => a.ok).length}/${l.length}</span></button>`;
      })}
      <span class="spacer"></span>
      <div class="seg" role="group" aria-label=${t('dex.filter', 'Show')}>
        ${[['all', t('dex.fAll', 'All')], ['got', t('trophy.fGot', 'Unlocked')], ['open', t('trophy.fOpen', 'Locked')]].map(([k, l]) => html`<button type="button" class=${show === k ? 'on' : ''} aria-pressed=${show === k} onClick=${() => setShow(k)}>${l}</button>`)}
      </div>
    </div>
    <div class="ach-grid">${sorted.map((a) => html`<${AchCard} key=${a.id} a=${a} />`)}</div>
  </div>`;
}

// ---- medal case ----------------------------------------------------------------------

function medalInfo(m) {
  const g = m.kind === 'dex' ? GENERATIONS.find((x) => x.gen === m.gen) : null;
  return g ? { ...m, from: g.from, to: g.to } : m;
}

function MedalSlot({ m, big, onOpen }) {
  const tier = m.tier >= 0 ? TIERS[m.tier] : null;
  const next = m.steps.find((s, i) => i > m.tier && s > m.value);
  return html`<button type="button" class=${`medal-slot ${big ? 'big' : ''} ${tier ? `got t-${tier}` : 'empty'}`} onClick=${() => onOpen(m)}
    aria-label=${`${medalName(m)} – ${tier ? tierLabel(tier) : t('medal.none', 'not earned yet')}`}>
    <span class="medal-cushion"><${Medal} kind=${m.kind === 'category' ? m.cat : m.kind} gen=${m.gen} tier=${tier} size=${big ? 104 : 66} /></span>
    <b class="medal-name">${medalName(m)}</b>
    <span class=${`medal-tier ${tier ? `t-${tier}` : ''}`}>${tier ? tierLabel(tier) : t('medal.none', 'not earned yet')}</span>
    <span class="medal-next faint tiny num">${next !== undefined ? t('medal.next', '{n}/{of} → {tier}', { n: m.value, of: next, tier: tierLabel(TIERS[m.steps.indexOf(next)]) }) : t('medal.maxed', 'Top tier')}</span>
  </button>`;
}

function MedalCase({ tr }) {
  const [open, setOpen] = useState(null);
  const ms = (tr.medals || []).map(medalInfo);
  const champ = ms.find((m) => m.kind === 'champion');
  const cats = ms.filter((m) => m.kind === 'category');
  const dex = ms.filter((m) => m.kind === 'dex');
  const earned = ms.filter((m) => m.tier >= 0).length;
  return html`<div class="case">
    <div class="case-lid"><span class="case-plate">${t('medal.caseTitle', 'Medal case')}</span><span class="case-count num">${t('medal.earned', '{n} of {all} earned', { n: earned, all: ms.length })}</span></div>
    <div class="case-felt">
      ${champ && html`<div class="case-row champ"><${MedalSlot} m=${champ} big onOpen=${setOpen} /></div>`}
      <h3 class="case-label">${t('medal.trophyRow', 'Trophy medals')}</h3>
      <div class="case-row">${cats.map((m) => html`<${MedalSlot} key=${m.id} m=${m} onOpen=${setOpen} />`)}</div>
      <h3 class="case-label">${t('medal.dexRow', 'Pokédex medals')}</h3>
      <div class="case-row">${dex.map((m) => html`<${MedalSlot} key=${m.id} m=${m} onOpen=${setOpen} />`)}</div>
    </div>
    <${Modal} open=${!!open} onClose=${() => setOpen(null)} title=${open ? medalName(open) : ''}>
      ${open && html`<div class="stack">
        <p class="muted">${medalHow(open)}</p>
        <ol class="tier-ladder">${TIERS.map((tier, i) => html`<li class=${`${i <= open.tier ? 'got' : ''} t-${tier}`}>
          <${Medal} kind=${open.kind === 'category' ? open.cat : open.kind} gen=${open.gen} tier=${i <= open.tier ? tier : null} size=${40} shine=${false} />
          <b>${tierLabel(tier)}</b><span class="num">${Math.min(open.value, open.steps[i])}/${open.steps[i]}</span>
          ${i <= open.tier && html`<${Icon} name="check" size=${14} />`}
        </li>`)}</ol>
      </div>`}
    <//>
  </div>`;
}

// ---- the page --------------------------------------------------------------------------

export function TrophiesView() {
  const { route, navigate } = useApp();
  const tr = useTrophies();
  const tab = ['dex', 'ach', 'medals'].includes(route.params.tab) ? route.params.tab : 'ach';
  const got = (tr?.achievements || []).filter((a) => a.ok);
  const points = got.reduce((s, a) => s + (POINTS[a.rarity] || 0), 0);
  const medalsEarned = (tr?.medals || []).filter((m) => m.tier >= 0).length;
  return html`<div class="trophies">
    <div class="topbar"><h1>${t('trophy.title', 'Trophies')}</h1></div>
    <div class="trophy-nav" role="tablist">${[
      ['ach', 'trophy', t('trophy.tabAch', 'Achievements'), tr ? `${got.length}/${tr.achievements?.length || 0}` : ''],
      ['dex', 'ball', t('trophy.tabDex', 'Pokédex'), tr ? `${tr.totals?.caught || 0}/${SUPPORTED_MAX}` : ''],
      ['medals', 'badge', t('trophy.tabMedals', 'Medals'), tr ? `${medalsEarned}/${tr.medals?.length || 0}` : ''],
    ].map(([k, icon, label, count]) => html`<button type="button" role="tab" key=${k} aria-selected=${tab === k} class=${`tn-${k} ${tab === k ? 'on' : ''}`} onClick=${() => navigate('trophies', { tab: k })}>
        <span class="tn-icon"><${Icon} name=${icon} size=${22} /></span>
        <span class="tn-label">${label}</span>
        ${count && html`<span class="tn-count num">${count}</span>`}
      </button>`)}</div>
    ${!tr ? html`<div class="panel trophy-loading"><span class="faint">${t('trophy.loading', 'Counting your runs …')}</span></div>` : html`
      <div class="trophy-card">
        <div class="tc-stat"><b class="num">${tr.totals?.caught || 0}<small>/${SUPPORTED_MAX}</small></b><span>${t('trophy.statCaught', 'species caught')}</span></div>
        <div class="tc-stat"><b class="num">${tr.totals?.seen || 0}</b><span>${t('trophy.statSeen', 'seen')}</span></div>
        <div class="tc-stat"><b class="num">${got.length}<small>/${tr.achievements?.length || 0}</small></b><span>${t('trophy.statAch', 'achievements')}</span></div>
        <div class="tc-stat"><b class="num">${medalsEarned}</b><span>${t('trophy.statMedals', 'medals')}</span></div>
        <div class="tc-stat score"><b class="num">${points.toLocaleString(currentLang())}</b><span>${t('trophy.statPoints', 'trophy points')}</span></div>
      </div>
      ${tab === 'dex' && html`<${Pokedex} tr=${tr} />`}
      ${tab === 'ach' && html`<${Achievements} tr=${tr} />`}
      ${tab === 'medals' && html`<${MedalCase} tr=${tr} />`}`}
  </div>`;
}

// ---- unlock toast ----------------------------------------------------------------------

/**
 * The unlock toast: a plate that drops in at the top, one per new achievement (no sound). A click opens the
 * achievements. `items`: [{ key, a }] – the caller removes them (dismiss).
 */
export function TrophyToasts({ items, dismiss, navigate }) {
  return html`<div class="trophy-toasts" role="status" aria-live="polite">
    ${items.map(({ key, a }) => {
      const { name, desc } = achText(a.id, a.target);
      return html`<button type="button" key=${key} class=${`trophy-toast r-${a.rarity}`} onClick=${() => { dismiss(key); navigate('trophies', { tab: 'ach' }); }}>
        <span class="tt-glow" aria-hidden="true"></span>
        <${AchIcon} a=${{ ...a, ok: true }} size=${26} />
        <span class="tt-text">
          <span class="tt-kicker">${t('trophy.unlocked', 'Achievement unlocked')}</span>
          <b>${name}</b>
          <span class="tt-desc">${desc}</span>
        </span>
        <span class=${`rarity r-${a.rarity}`}>${rarityLabel(a.rarity)}<br /><span class="num">+${POINTS[a.rarity]}</span></span>
      </button>`;
    })}
  </div>`;
}
