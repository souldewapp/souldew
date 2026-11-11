// SoulLink companion inside the game session: the level cap, what may still be caught, the linked groups
// side by side (one column per player; a solo Nuzlocke gets its team list instead), a battle helper (opponent,
// type matchups, catch rules), the shiny/legendary encounter effect and the prominent "pair died" alert.
import { html, useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { useApp, Sprite, Types, HpBar, Modal, useFocusTrap } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { speciesName, typeLabel, moveName, romOwnTypesNow } from '../lib/data.mjs';
import {
  party as partyAreas, live, pairState, encounter, levelCap, rules as getRules, dupeOf, players as getPlayers,
  areaName, causeText, slotsOf, othersOf, openAreas, isNuzlocke, pairTypeClash, typeHelpOn,
} from '../lib/run.mjs';
import { statusOf, statusLabel, shownLevel } from './party.mjs';
import { effectiveness, defenseChart, moveInfo, matchup } from '/shared/typechart.mjs';
import { isLegendary } from '/shared/legendaries.mjs';
import { RestartModal } from './restart.mjs';

// legendary or mythical, Gen 1–9 (PokeAPI's split)
export { isLegendary };

let MOVES = null;
function useMoves() {
  const [m, setM] = useState(null);
  useEffect(() => {
    MOVES ||= fetch('/shared/data/moves.json').then((r) => r.json()).catch(() => null);
    MOVES.then(setM);
  }, []);
  return m;
}

const multLabel = (m) => ({ 0: t('fx.none', 'no effect'), 0.25: t('fx.quarter', 'barely'), 0.5: t('fx.half', 'not very'), 1: t('fx.normal', 'normal'), 2: t('fx.super', 'super'), 4: t('fx.ultra', 'super ×4') }[m]);
const multText = (m) => (m === 0.5 ? '×½' : m === 0.25 ? '×¼' : `×${m}`);
const multClass = (m) => (m === 0 ? 'x0' : m < 1 ? 'xlow' : m > 1 ? 'xhigh' : 'x1');


/** Primary types already taken under the type rule: [{ type, species, slot }]. `manifest`: whose teams count. */
export function blockedTypes(doc, rd, me, manifest) {
  const r = getRules(doc, manifest);
  if (r.typeClause === 'off' || !rd) return [];
  const all = slotsOf(manifest);
  const slots = r.typeClause === 'global' ? all : [me];
  const out = new Map();
  for (const s of slots) {
    for (const area of partyAreas(doc, s)) {
      if (!['linked', 'waiting'].includes(pairState(doc, area, all).state)) continue;
      const e = encounter(doc, area, s);
      const type = e?.species && rd.types(e.species, s)[0];
      if (type && !out.has(type)) out.set(type, { type, species: e.species, slot: s });
    }
  }
  return [...out.values()];
}

/** Level cap + "type taken" chips – the rules you need while playing. */
export function RunStrip({ mine, onRules }) {
  const { doc, manifest, me, runData } = useApp();
  const [restart, setRestart] = useState(false);
  if (!doc || !manifest) return null;
  const st = doc.get('run:status', null);
  if (st) {
    // ended: no cap or rules to watch anymore – what happened and the way on
    const label = { failed: t('end.bannerFailed', 'This run has failed'), won: t('end.bannerWon', 'You made it – run won!'), ended: t('end.bannerEnded', 'This run has ended') }[st.state] || st.state;
    return html`<section class=${`run-strip ended ${st.state}`}>
      <div class="rs-row"><${Icon} name=${st.state === 'won' ? 'heart' : 'grave'} size=${18} /><b class="grow">${label}</b></div>
      <p class="tiny muted rs-ended">${t('over.stoppedShort', 'Tracking is stopped.')}</p>
      ${st.state !== 'won' && html`<button class="btn small primary" onClick=${() => setRestart(true)}><${Icon} name="reset" size=${14} />${t('over.again', 'New attempt …')}</button>`}
      ${restart && html`<${RestartModal} r=${manifest} rules=${doc.get('rules')} onClose=${() => setRestart(false)} />`}
    </section>`;
  }
  const r = getRules(doc, manifest);
  const names = getPlayers(doc, manifest);
  const solo = isNuzlocke(manifest);
  const { cap, boss, vanilla } = r.levelCaps ? levelCap(doc, manifest, me) : {};
  const top = Math.max(0, ...(mine || []).filter((m) => !m.isEgg).map((m) => m.level || 0));
  const state = !cap || !top ? 'ok' : top > cap ? 'over' : top >= cap - 2 ? 'near' : 'ok';
  const blocked = blockedTypes(doc, runData, me, manifest);
  const open = solo ? openAreas(doc, manifest, me).length : null;
  return html`<section class="run-strip">
    <div class="rs-row">
      ${cap ? html`<div class=${`cap ${state}`} title=${vanilla ? t('cap.vanillaHint', 'Ace level of the next boss in the unmodified game') : ''}>
        <span class="cap-k">${t('cap.title', 'Level cap')}</span><b class="num">${cap}</b>
        ${boss?.name && html`<span class="cap-boss">${boss.name}</span>`}
        ${top > 0 && html`<span class="cap-top">${t('cap.yourTop', 'yours: Lv {lv}', { lv: top })}</span>`}
      </div>` : r.levelCaps ? html`<div class="cap"><span class="cap-k">${t('cap.title', 'Level cap')}</span><span class="cap-top">${t('cap.unknown', 'unknown for this game')}</span></div>`
        : html`<div class="cap"><span class="cap-k">${t('cap.off', 'No level caps')}</span></div>`}
      <button class="btn small ghost rs-rules" onClick=${onRules} title=${t('session.rulesHint', 'Change the run rules without leaving the game')}><${Icon} name="scroll" size=${14} />${t('session.rules', 'Rules')}</button>
    </div>
    ${state === 'near' && html`<p class="rs-warn near">${top === cap ? t('cap.at', 'At the cap – don’t level further before {boss}.', { boss: boss?.name || '' }) : t('cap.near', 'Close to the cap: {n} level left.|Close to the cap: {n} levels left.', { n: cap - top, count: cap - top })}</p>`}
    ${state === 'over' && html`<p class="rs-warn over">${t('cap.over', 'Over the cap! Level {lv} > {cap} – box or swap before the next boss.', { lv: top, cap })}</p>`}
    ${solo && html`<div class="rs-chips">
      <span class="rs-chip open" title=${t('session.openHint', 'Areas without an encounter yet')}><b class="num">${open}</b> ${t('session.openAreas', 'open area|open areas', { count: open })}</span>
      ${r.noBattleItems && html`<span class="rs-chip honour" title=${t('nz.honourHint', 'The app can’t check this – it only reminds you. Keep it yourself.')}>${t('session.noItems', 'No bag items in battle')}</span>`}
      ${r.setMode && html`<span class="rs-chip honour" title=${t('nz.honourHint', 'The app can’t check this – it only reminds you. Keep it yourself.')}>${t('session.setMode', 'Set mode')}</span>`}
      ${r.centerLimit > 0 && html`<${CenterCounter} limit=${r.centerLimit} />`}
    </div>`}
    ${blocked.length > 0 && html`<div class="rs-types">
      <span class="rs-k">${r.typeClause === 'global' ? slotsOf(manifest).length > 2 ? t('rules.takenAll', 'Type taken (all teams)') : t('rules.takenBoth', 'Type taken (both teams)') : solo ? t('rules.takenSolo', 'Type taken') : t('rules.takenMine', 'Type taken (your team)')}</span>
      ${blocked.map((b) => html`<span class=${`type t-${b.type}`} title=${`${speciesName(b.species)}${solo ? '' : ` · ${names[b.slot]?.name || ''}`}`}>${typeLabel(b.type)}</span>`)}
    </div>`}
  </section>`;
}

/**
 * Pokémon Center visits since the last badge, counted by hand (the app can't tell a Center heal from a bed or a
 * Full Restore). Doc key `center:<slot>` = { [badge count]: visits } – a new badge starts a fresh count.
 */
function CenterCounter({ limit }) {
  const { doc, me } = useApp();
  const badges = live(doc, me)?.badges ?? 0;
  const all = doc.get(`center:${me}`, null) || {};
  const used = all[badges] || 0;
  const bump = (d) => doc.set(`center:${me}`, { ...all, [badges]: Math.max(0, used + d) });
  return html`<span class=${`rs-chip honour center ${used >= limit ? 'full' : ''}`} title=${t('session.centerHint', 'Pokémon Center visits since the last badge – count them yourself.')}>
    ${t('session.center', 'Center')} <b class="num">${used}/${limit}</b>
    <button class="rs-step" onClick=${() => bump(-1)} disabled=${used === 0} aria-label=${t('session.centerLess', 'One visit less')}>−</button>
    <button class="rs-step" onClick=${() => bump(1)} aria-label=${t('session.centerMore', 'Count a visit')}>+</button>
  </span>`;
}

function PairMon({ mon, enc, dead, gen, side }) {
  const species = mon?.species || enc?.species;
  if (!species) return html`<div class=${`pm empty ${side}`}><span>${enc?.outcome === 'missed' ? t('routes.failed', 'missed') : t('pairs.open', 'open')}</span></div>`;
  const boxed = !mon;
  const lv = shownLevel(mon?.level) || shownLevel(enc?.level);
  const st = !dead && mon ? statusOf(mon) : '';
  return html`<div class=${`pm ${side} ${dead ? 'dead' : ''} ${boxed ? 'boxed' : ''} ${st === 'fnt' ? 'fainted' : st ? 'has-st' : ''}`}>
    <${Sprite} id=${species} shiny=${mon?.shiny || enc?.shiny} size=${32} gen=${gen} />
    <div class="pm-body">
      <span class="pm-name" title=${mon?.nick || enc?.nickname || speciesName(species)}>${mon?.nick || enc?.nickname || speciesName(species)}</span>
      <div class="pm-row">
        ${lv && html`<span class="pm-lv num">${t('common.lv', 'Lv')} ${lv}</span>`}
        ${mon?.maxHp && !dead ? html`<${HpBar} hp=${mon.hp} max=${mon.maxHp} />` : html`<span class="pm-sub">${dead ? t('routes.dead', 'dead') : t('pairs.boxed', 'in the box')}</span>`}
      </div>
    </div>
    ${st && st !== 'fnt' && html`<span class=${`pp-st pm-st ${st}`} title=${statusLabel(st)}>${statusLabel(st)}</span>`}
  </div>`;
}

/** A player's live party with the own (fresher, from RAM) HP and levels folded in. */
function teamOf(doc, slot, me, mine) {
  const fresh = new Map((mine || []).map((m) => [m.key, m]));
  return (live(doc, slot)?.party || []).map((m) => {
    const f = slot === me && fresh.get(m.key);
    // a partner on an older version may still send a garbage level (a torn RAM read): never show it
    return f ? { ...m, hp: f.hp, maxHp: f.maxHp, level: shownLevel(f.level) ?? shownLevel(m.level), status: f.status ?? m.status } : { ...m, level: shownLevel(m.level) };
  });
}

/**
 * Linked groups side by side: one column per player, one row per area that is in anybody's team. Two players keep
 * the pair look (mon | link | mon); three or four get a compact row per area (area + link state over N small cells).
 * A solo Nuzlocke has nobody to link with – it shows the team list instead.
 * `mine` is the freshest own party read from RAM (HP changes every frame there).
 */
export function LinkedPairs({ mine, gen, compact }) {
  const { doc, manifest, me } = useApp();
  if (!doc || !manifest) return null;
  if (isNuzlocke(manifest)) return html`<${TeamList} mine=${mine} gen=${gen} compact=${compact} />`;
  const names = getPlayers(doc, manifest);
  const slots = slotsOf(manifest);
  const team = {};
  const order = [];
  for (const s of slots) {
    team[s] = new Map();
    for (const m of teamOf(doc, s, me, mine)) {
      if (!m.area) continue;
      team[s].set(m.area, m);
      if (!order.includes(m.area)) order.push(m.area);
    }
  }
  const tracked = new Set((live(doc, me)?.party || []).map((m) => m.key));
  const loose = (mine || []).filter((m) => !m.isEgg && m.species && !tracked.has(m.key));
  const pair = slots.length === 2;
  return html`<section class=${`pairs ${compact ? 'compact' : ''} ${pair ? '' : `group n${slots.length}`}`} aria-label=${pair ? t('pairs.title', 'Linked Pokémon') : t('pairs.titleGroup', 'Linked groups')}>
    ${pair
      ? html`<div class="pairs-head"><b class="px who-p1">${names.p1.name}</b><span class="pairs-mid">${t('pairs.link', 'Link')}</span><b class="px who-p2">${names.p2.name}</b></div>`
      : html`<div class="grp-head">${slots.map((s) => html`<b class=${`px who-${s}`} title=${names[s].name}>${names[s].name}</b>`)}</div>`}
    ${order.length === 0 && loose.length === 0 && html`<p class="small muted">${pair ? t('pairs.empty', 'Linked pairs show up here as soon as you catch something.') : t('pairs.emptyGroup', 'Linked groups show up here as soon as you catch something.')}</p>`}
    ${order.map((area) => {
      const st = pairState(doc, area, slots);
      const dead = st.state === 'dead';
      const icon = html`<${Icon} name=${dead ? 'grave' : 'link'} size=${14} />`;
      const linkLabel = dead ? t('routes.dead', 'dead') : t('pairs.link', 'Link');
      if (pair) {
        return html`<div class=${`pair-row ${st.state}`} key=${area} title=${areaName(doc, manifest, area)}>
          <${PairMon} mon=${team.p1.get(area)} enc=${st.encs.p1} dead=${dead} gen=${gen} side="l" />
          <span class=${`pair-link ${st.state}`} role="img" aria-label=${linkLabel}>${icon}</span>
          <${PairMon} mon=${team.p2.get(area)} enc=${st.encs.p2} dead=${dead} gen=${gen} side="r" />
        </div>`;
      }
      return html`<div class=${`grp-row ${st.state}`} key=${area}>
        <div class="grp-area"><span class=${`pair-link ${st.state}`} role="img" aria-label=${linkLabel}>${icon}</span><span class="grp-name" title=${areaName(doc, manifest, area)}>${areaName(doc, manifest, area)}</span></div>
        <div class="grp-cells">${slots.map((s) => html`<${GroupMon} key=${s} slot=${s} name=${names[s].name} mon=${team[s].get(area)} enc=${st.encs[s]} dead=${dead} gen=${gen} />`)}</div>
      </div>`;
    })}
    ${loose.length > 0 && html`<p class="tiny faint pairs-loose">${t('pairs.loose', 'Not linked yet: {names}', { names: loose.map((m) => m.nickname || speciesName(m.species)).join(', ') })}</p>`}
  </section>`;
}

/** One player's mon in a 3–4 player group row: sprite, level and HP – the name is in the tooltip (the column is narrow). */
function GroupMon({ slot, name, mon, enc, dead, gen }) {
  const species = mon?.species || enc?.species;
  const nick = species ? mon?.nick || enc?.nickname || speciesName(species) : '';
  const label = `${name}: ${species ? nick : enc?.outcome === 'missed' ? t('routes.failed', 'missed') : t('pairs.open', 'open')}`;
  if (!species) return html`<div class="gm empty" style=${`--acc:var(--${slot})`} title=${label}><span>${enc?.outcome === 'missed' ? '✕' : '·'}</span></div>`;
  const st = !dead && mon ? statusOf(mon) : '';
  const full = st ? `${label} · ${statusLabel(st)}` : label;
  return html`<div class=${`gm ${dead ? 'dead' : ''} ${!mon ? 'boxed' : ''} ${st === 'fnt' ? 'fainted' : ''}`} style=${`--acc:var(--${slot})`} title=${full} role="img" aria-label=${full}>
    <${Sprite} id=${species} shiny=${mon?.shiny || enc?.shiny} size=${32} gen=${gen} />
    <span class="gm-lv num">${shownLevel(mon?.level) || shownLevel(enc?.level) || ''}</span>
    ${st && st !== 'fnt' && html`<span class=${`pp-st gm-st ${st}`} aria-hidden="true">${statusLabel(st)}</span>`}
    ${mon?.maxHp && !dead ? html`<${HpBar} hp=${mon.hp} max=${mon.maxHp} />` : html`<span class="gm-sub">${dead ? t('routes.dead', 'dead') : t('pairs.boxedShort', 'box')}</span>`}
  </div>`;
}

/** Solo: the team as a list – HP, level against the cap, status – with dead and fainted ones marked. */
function TeamList({ mine, gen, compact }) {
  const { doc, manifest, me } = useApp();
  const slot = me || 'p1';
  const r = getRules(doc, manifest);
  const { cap } = r.levelCaps ? levelCap(doc, manifest, slot) : {};
  const tracked = teamOf(doc, slot, me, mine);
  // straight from RAM while playing (the doc lags a poll behind); the doc's copy carries the areas
  const areaByKey = new Map(tracked.map((m) => [m.key, m.area]));
  const team = (mine?.length ? mine.filter((m) => !m.isEgg && m.species).map((m) => ({ ...m, level: shownLevel(m.level), nick: m.nickname, area: areaByKey.get(m.key) || null })) : tracked.filter((m) => !m.egg));
  return html`<section class=${`team-list ${compact ? 'compact' : ''}`} aria-label=${t('play.yourTeam', 'Your team')}>
    <div class="tl-head"><b class="px who-p1">${t('play.yourTeam', 'Your team')}</b>${cap && html`<span class="tiny faint">${t('session.capShort', 'cap {n}', { n: cap })}</span>`}</div>
    ${team.length === 0 && html`<p class="small muted">${t('team.empty', 'Your team shows up here as soon as you have Pokémon.')}</p>`}
    ${team.map((m) => {
      const dead = !!m.area && pairState(doc, m.area, ['p1']).state === 'dead';
      const st = statusOf(m);
      const over = cap && m.level > cap;
      const name = m.nick || speciesName(m.species);
      return html`<div class=${`tl-row ${dead ? 'dead' : ''} ${st === 'fnt' ? 'fainted' : ''}`} key=${m.key || m.species} title=${m.area ? areaName(doc, manifest, m.area) : t('board.unlinked', 'unassigned')}>
        <${Sprite} id=${m.species} shiny=${m.shiny} size=${32} gen=${gen} />
        <div class="tl-body">
          <div class="tl-top"><span class="tl-name">${name}</span>
            <span class=${`tl-lv num ${over ? 'over' : cap && m.level >= cap ? 'at' : ''}`}>${m.level ? `${t('common.lv', 'Lv')} ${m.level}` : ''}${cap ? html`<span class="tl-cap">/${cap}</span>` : ''}</span></div>
          <div class="tl-bar">${dead ? html`<span class="tl-sub">${t('routes.dead', 'dead')}</span>` : m.maxHp ? html`<${HpBar} hp=${m.hp} max=${m.maxHp} />` : ''}
            ${st && st !== 'fnt' && html`<span class=${`pp-st ${st}`}>${statusLabel(st)}</span>`}
            ${!m.area && !dead && html`<span class="tl-sub" title=${t('team.untrackedHint', 'Not filed to an area yet – see the inbox on the board.')}>?</span>`}</div>
        </div>
      </div>`;
    })}
  </section>`;
}

// The battle helper's place, per player on this computer: next to the game on the left (default) or on the right,
// and folded in to its head line. (A run whose host switched the matchup help off keeps it off either way.)
const PANEL_KEY = 'sl-battle-panel';
const PANEL_DEFAULT = { side: 'left', collapsed: false };
function readPanelPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem(PANEL_KEY) || 'null');
    return { side: v?.side === 'right' ? 'right' : 'left', collapsed: v?.collapsed === true };
  } catch {
    return PANEL_DEFAULT;
  }
}
/** [prefs, update] – { side: 'left'|'right', collapsed } for the battle helper, remembered in this profile. */
export function useBattlePanelPrefs() {
  const [p, setP] = useState(readPanelPrefs);
  const update = (patch) => setP((prev) => {
    const next = { ...prev, ...patch };
    try {
      localStorage.setItem(PANEL_KEY, JSON.stringify(next));
    } catch {
      // private mode: this session only
    }
    return next;
  });
  return [p, update];
}

const fainted = (m) => m.maxHp > 0 && m.hp === 0;
const monName = (m) => (m ? m.nickname || speciesName(m.species) : '');

/**
 * Battle helper: who is out there, how your moves land, what hits you, how the rest of your team would fare, and
 * whether you may catch it. `side` / `collapsed` / `onPrefs`: where the player put it (useBattlePanelPrefs).
 */
export function BattlePanel({ battle, mine, gen, isRun, side = 'left', collapsed = false, onPrefs }) {
  const { doc, manifest, me, runData } = useApp();
  const moves = useMoves();
  const foe = battle?.enemy;
  if (!foe) return null;
  const slot = me || 'p1';
  const typesOf = (id) => (runData ? runData.types(id, slot) : []);
  const fairy = !!runData?.fairy; // a hack that added the type
  // everyone the reader sees out there (a double battle: both), the one it follows first
  const foes = (battle.foes?.length ? battle.foes : [foe]).filter((f) => f?.species);
  const foeTypes = typesOf(foe.species);
  const team = (mine || []).filter(Boolean);
  // the player's Pokémon that are out – the reader's active slots (they follow a switch); unknown → the first one that
  // can fight, as the game sends it out
  const outIdx = [...new Set((battle.actives?.length ? battle.actives : [battle.active]).map((a) => a?.index).filter((i) => Number.isInteger(i) && team[i]))];
  const lead = team.find((m) => !m.isEgg && !fainted(m)) || team[0];
  const outs = outIdx.length ? outIdx.map((i) => team[i]) : lead ? [lead] : [];
  const movesOf = (list, damaging) => (list || []).map((id) => ({ id, info: moveInfo(moves, id, gen) })).filter((m) => m.info && (!damaging || m.info.power > 0));
  const foeData = foes.map((f) => ({ f, types: typesOf(f.species), moves: movesOf(f.moves, true) }));
  const r = isRun && doc ? getRules(doc, manifest) : null;
  const solo = isRun && isNuzlocke(manifest);
  // the host can switch the matchup help off for the whole run: then only who's out there and the catch rules stay
  const help = !isRun || typeHelpOn(doc, manifest);
  // a hack with types of its own (Too Many Types): souldew knows neither them nor their matchups – it says so instead
  const ownTypes = runData ? runData.typesUnknown : !!romOwnTypesNow();
  let rule = null;
  const notes = [];
  if (battle.kind === 'wild' && r) {
    const blocked = blockedTypes(doc, runData, slot, manifest).find((b) => b.type === foeTypes[0]);
    const clash = !blocked && pairTypeClash(doc, manifest, runData, slot, foe.species);
    const dupe = runData && dupeOf(doc, manifest, runData, foe.species, slot);
    const names = getPlayers(doc, manifest);
    // Solo: legendaries count as static encounters – the statics rule says whether they use up the area
    const statics = solo && isLegendary(foe.species) ? r.statics : null;
    if (foe.shiny && r.shinyClause) rule = { ok: true, text: solo ? t('battle.shinySolo', 'Shiny – free catch.') : t('battle.shinyOk', 'Shiny clause: you may always catch this one – it stays unlinked.') };
    else if (statics === 'banned') rule = { ok: false, text: t('battle.staticBanned', 'Legendary/static – banned by your rules, don’t catch it.') };
    else if (blocked) rule = { ok: false, text: t('battle.typeTaken', 'Type rule: {type} is taken by {mon} ({name}) – don’t catch it.', { type: typeLabel(blocked.type), mon: speciesName(blocked.species), name: solo ? t('common.you', 'you') : names[blocked.slot]?.name || '' }) };
    else if (clash) rule = { ok: false, clash: true, text: clash.now
      ? t('battle.typePairNow', 'Type rule: {name} is fighting {mon} here right now – also {type}. Only one of you may catch theirs, or {type} is taken twice.', { name: names[clash.slot]?.name || '', mon: speciesName(clash.species), type: typeLabel(clash.type) })
      : t('battle.typePair', 'Type rule: {name} caught {mon} here – also {type}. You may not catch this one as well, or {type} is taken twice.', { name: names[clash.slot]?.name || '', mon: speciesName(clash.species), type: typeLabel(clash.type) }) };
    else if (dupe && statics !== 'free') rule = { ok: false, text: solo ? t('battle.dupeSolo', 'Dupe – keep looking. It doesn’t count, flee freely ({area}).', { area: areaName(doc, manifest, dupe.area) }) : t('battle.dupe', 'Dupes clause: this evolution line is already caught ({area}).', { area: areaName(doc, manifest, dupe.area) }) };
    else if (statics === 'free') rule = { ok: true, text: t('battle.staticFree', 'Legendary/static – a free catch, it doesn’t use up the area.') };
    else if (statics === 'area') rule = { ok: true, text: t('battle.staticArea', 'Legendary/static – counts as this area’s encounter.') };
    else if (solo) rule = { ok: true, text: t('battle.firstSolo', 'First encounter – catch it. (If this area is already used, it doesn’t count.)') };
    else rule = { ok: true, text: t('battle.catchable', 'Allowed by your rules – if it’s the first encounter in this area.') };
  }
  if (battle.kind === 'trainer' && r) {
    const { cap } = r.levelCaps ? levelCap(doc, manifest, slot) : {};
    const over = cap ? team.filter((m) => !m.isEgg && m.level > cap) : [];
    if (over.length) {
      rule = { ok: false, text: t('battle.overCap', 'Over the level cap ({cap}): {names} – if this is a boss, box them first.', { cap, names: over.map(monName).join(', ') }) };
    }
    if (solo && r.noBattleItems) notes.push(t('battle.noItems', 'No items from the bag'));
    if (solo && r.setMode) notes.push(t('battle.setMode', 'Set mode: no free switch after a knockout'));
  }
  const kind = battle.kind === 'wild' ? t('battle.wild', 'wild') : t('battle.trainer', 'trainer');
  const other = side === 'right' ? 'left' : 'right';
  const moveLabel = other === 'left' ? t('battle.moveLeft', 'Show the battle helper left of the game') : t('battle.moveRight', 'Show the battle helper right of the game');
  const foldLabel = collapsed ? t('battle.expand', 'Show the battle helper in full') : t('battle.collapse', 'Fold the battle helper in');
  const head = html`<div class="bt-head">
    ${collapsed ? html`<span class="bt-head-foes">${foes.map((f) => html`<span class="bt-head-foe" key=${`${f.species}:${f.level}`}><${Sprite} id=${f.species} shiny=${f.shiny} size=${30} gen=${gen} /><b>${speciesName(f.species)}</b><span class="num">${t('common.lv', 'Lv')} ${f.level}</span></span>`)}</span>`
      : html`<span class="bt-title px">${t('battle.title', 'Battle')}</span>`}
    <span class="bt-kind">${kind}</span>
    ${onPrefs && html`<span class="bt-ctls">
      <button class="btn ghost icon bt-ctl" title=${moveLabel} aria-label=${moveLabel} onClick=${() => onPrefs({ side: other })}><${Icon} name=${other === 'left' ? 'panelLeft' : 'panelRight'} size=${14} /></button>
      <button class="btn ghost icon bt-ctl" title=${foldLabel} aria-label=${foldLabel} aria-expanded=${!collapsed} onClick=${() => onPrefs({ collapsed: !collapsed })}><${Icon} name=${collapsed ? 'chevDown' : 'chevUp'} size=${14} /></button>
    </span>`}
  </div>`;
  const ruleLine = rule && html`<p class=${`bt-rule ${rule.ok ? 'ok' : 'no'} ${rule.clash ? 'clash' : ''}`}>${rule.clash && html`<span class="bt-clash"><${Types} types=${foeTypes.slice(0, 1)} /> ${t('battle.typeTwice', 'same type')}</span>`}${rule.text}</p>`;
  const cls = `battle ${foe.shiny ? 'shiny' : ''} ${isLegendary(foe.species) ? 'legend' : ''} ${collapsed ? 'collapsed' : ''}`;
  if (collapsed) {
    // folded in: who's out there, and a catch rule only when it says "don't"
    return html`<section class=${cls} aria-label=${t('battle.title', 'Battle')}>
      <${EncounterFx} battle=${battle} />
      ${head}
      ${rule && !rule.ok && ruleLine}
    </section>`;
  }
  const many = foeData.length > 1;
  return html`<section class=${cls} aria-label=${t('battle.title', 'Battle')}>
    <${EncounterFx} battle=${battle} />
    ${head}
    ${foeData.map(({ f, types }) => html`<div class="bt-foe" key=${`${f.species}:${f.level}`}>
      <${Sprite} id=${f.species} shiny=${f.shiny} size=${many ? 40 : 48} gen=${gen} />
      <div class="bt-foe-body">
        <div class="bt-name"><b>${speciesName(f.species)}</b><span class="num">${t('common.lv', 'Lv')} ${f.level}</span>
          ${f.shiny && html`<span class="bt-tag shiny">✦ ${t('routes.bonusShiny', 'Shiny')}</span>`}${isLegendary(f.species) && html`<span class="bt-tag legend">${t('battle.legendary', 'Legendary')}</span>`}</div>
        <${Types} types=${types} />
        ${f.maxHp > 0 && html`<${HpBar} hp=${f.hp} max=${f.maxHp} />`}
      </div>
    </div>`)}
    ${ruleLine}
    ${notes.length > 0 && html`<div class="bt-notes">${notes.map((x) => html`<span class="rs-chip honour" title=${t('nz.honourHint', 'The app can’t check this – it only reminds you. Keep it yourself.')}>${x}</span>`)}</div>`}
    ${!help && html`<p class="tiny faint bt-nohelp">${t('battle.helpOff', 'Type matchup help is off in this run.')}</p>`}
    ${help && ownTypes && html`<p class="tiny faint bt-nohelp">${t('battle.ownTypes', 'This ROM hack has types of its own that souldew doesn’t know – so it shows no types, matchups or type rule here rather than wrong ones.')}</p>`}
    ${help && !ownTypes && outs.map((m) => html`<${OutHelp} key=${m.key || m.species} mon=${m} foes=${foeData} typesOf=${typesOf} movesOf=${movesOf} gen=${gen} />`)}
    ${help && !ownTypes && html`<${TeamCheck} team=${team} out=${new Set(outs)} foe=${foeData.find(({ f }) => !(f.maxHp > 0 && f.hp === 0)) || foeData[0]} typesOf=${typesOf} movesOf=${movesOf} gen=${gen} />`}
    ${help && !ownTypes && foeData.map(({ f, types }) => types.length > 0 && html`<${TypeChart} key=${`c${f.species}`} title=${t('battle.chart', '{mon} against types', { mon: speciesName(f.species) })} chart=${defenseChart(types, gen, { fairy })} />`)}
    ${help && !ownTypes && outs.map((m) => typesOf(m.species).length > 0 && html`<${TypeChart} key=${`m${m.key || m.species}`} title=${t('battle.myChart', 'Your {mon} against types', { mon: monName(m) })} chart=${defenseChart(typesOf(m.species), gen, { fairy })} mine />`)}
  </section>`;
}

/** One of your Pokémon that is out: how its moves land on every opponent, and what hits it. */
function OutHelp({ mon, foes, typesOf, movesOf, gen }) {
  const monTypes = typesOf(mon.species);
  const myMoves = movesOf(mon.moves, false);
  const many = foes.length > 1;
  // incoming: the opponents' known damaging moves, else what their own types would do (STAB)
  const incoming = foes.flatMap(({ f, types, moves: fm }) => (fm.length
    ? fm.map(({ id, info }) => ({ key: `${f.species}:${id}`, by: f, label: moveName(id), type: info.type, m: effectiveness(info.type, monTypes, gen) }))
    : types.map((ty) => ({ key: `${f.species}:${ty}`, by: f, label: t('battle.stab', '{type} attacks', { type: typeLabel(ty) }), type: ty, m: effectiveness(ty, monTypes, gen) }))));
  return html`${myMoves.length > 0 && html`<div class="bt-block">
      <h4>${t('battle.yourMoves', '{mon}’s moves', { mon: monName(mon) })}${many ? html` <span class="bt-vs">${t('battle.vsBoth', 'against {names}', { names: foes.map(({ f }) => speciesName(f.species)).join(' · ') })}</span>` : ''}</h4>
      <ul class="bt-moves">${myMoves.map(({ id, info }) => html`<li key=${id}><span class=${`type t-${info.type || 'normal'}`}>${moveName(id)}</span>
        <span class="bt-mults">${foes.map(({ f, types }) => {
          const m = info.cls === 'status' || !info.type ? null : effectiveness(info.type, types, gen);
          const vs = many ? t('battle.vsMon', 'against {mon}', { mon: speciesName(f.species) }) : undefined;
          return m === null ? html`<span class="mult x1" title=${vs}>${t('fx.status', 'status')}</span>` : html`<span class=${`mult ${multClass(m)}`} title=${vs}>${multText(m)}${many ? '' : ` ${multLabel(m)}`}</span>`;
        })}</span></li>`)}</ul></div>`}
    <div class="bt-block">
      <h4>${t('battle.danger', 'What hits {mon}', { mon: monName(mon) })}</h4>
      <ul class="bt-moves">
        ${incoming.map((x) => html`<li key=${x.key}><span class=${`type t-${x.type}`}>${many ? `${speciesName(x.by.species)}: ` : ''}${x.label}</span><span class=${`mult ${multClass(x.m)} foe`}>${multText(x.m)} ${multLabel(x.m)}</span></li>`)}
      </ul>
    </div>`;
}

/**
 * Switch-in check: every Pokémon of your team against the opponent – its best hit and the opponent's worst for it –
 * so you see at a glance who to send in. Shown from two Pokémon on.
 */
function TeamCheck({ team, out, foe, typesOf, movesOf, gen }) {
  const list = team.filter((m) => m && !m.isEgg && m.species);
  if (list.length < 2 || !foe?.types?.length) return null;
  const foeSide = { types: foe.types, moves: foe.moves.map(({ id, info }) => ({ id, ...info })) };
  const label = (by) => (by == null ? '' : typeof by === 'number' ? moveName(by) : t('battle.stab', '{type} attacks', { type: typeLabel(by) }));
  return html`<div class="bt-block bt-team">
    <h4>${t('battle.teamCheck', 'Your team against {mon}', { mon: speciesName(foe.f.species) })}</h4>
    <div class="bt-team-head" aria-hidden="true"><span></span><span>${t('battle.deals', 'deals')}</span><span>${t('battle.takes', 'takes')}</span></div>
    <ul>${list.map((m) => {
      const mu = matchup({ types: typesOf(m.species), moves: movesOf(m.moves, false).map(({ id, info }) => ({ id, ...info })) }, foeSide, gen);
      const down = fainted(m);
      const isOut = out.has(m);
      const dealsTip = mu.deals == null ? '' : t('battle.dealsTip', 'Best hit: {move} ({mult})', { move: label(mu.dealsBy), mult: multText(mu.deals) });
      const takesTip = mu.takes == null ? '' : t('battle.takesTip', 'Hits it hardest: {move} ({mult})', { move: label(mu.takesBy), mult: multText(mu.takes) });
      // the one that is out: highlighted like the selected slot of a party menu (named for screen readers)
      return html`<li key=${m.key || m.species} class=${`${isOut ? 'out' : ''} ${down ? 'down' : ''}`} title=${isOut ? t('battle.out', 'in battle') : undefined}>
        <span class="bt-team-mon"><${Sprite} id=${m.species} shiny=${m.shiny} size=${30} gen=${gen} /><span class="bt-team-name">${monName(m)}</span>
          ${isOut ? html`<span class="sr-only">(${t('battle.out', 'in battle')})</span>` : down ? html`<span class="bt-team-tag down">${t('battle.fainted', 'fainted')}</span>` : ''}</span>
        ${mu.deals == null ? html`<span class="mult x1">–</span>` : html`<span class=${`mult ${multClass(mu.deals)}`} title=${dealsTip} aria-label=${dealsTip}>${multText(mu.deals)}</span>`}
        ${mu.takes == null ? html`<span class="mult x1">–</span>` : html`<span class=${`mult ${multClass(mu.takes)} foe`} title=${takesTip} aria-label=${takesTip}>${multText(mu.takes)}</span>`}
      </li>`;
    })}</ul>
  </div>`;
}

/** Weaknesses and resistances of one Pokémon in battle, grouped like a Pokédex chart. */
function TypeChart({ title, chart, mine }) {
  return html`<div class=${`bt-block bt-chart ${mine ? 'mine' : ''}`}>
    <h4>${title}</h4>
    ${[[4, t('fx.weak4', 'very weak (×4)')], [2, t('fx.weak', 'weak (×2)')], [0.5, t('fx.resist', 'resists (×½)')], [0.25, t('fx.resist4', 'resists (×¼)')], [0, t('fx.immune', 'immune')]]
      .filter(([k]) => chart[k].length).map(([k, label]) => html`<div class=${`bt-chart-row ${multClass(k === 0 ? 0 : k)}`}><span class="bt-chart-k">${label}</span><${Types} types=${chart[k]} /></div>`)}
  </div>`;
}

/**
 * A short sparkle burst over the battle box (the current encounter) when a shiny or legendary shows up – not
 * over the game, which stays clear. Fires once per encounter.
 */
export function EncounterFx({ battle }) {
  const [fx, setFx] = useState(null);
  const last = useRef('');
  const foe = battle?.enemy;
  useEffect(() => {
    if (!foe) {
      last.current = '';
      return undefined;
    }
    const sig = `${foe.species}:${foe.level}:${foe.maxHp}`;
    if (sig === last.current) return undefined;
    last.current = sig;
    const kind = foe.shiny ? 'shiny' : isLegendary(foe.species) ? 'legend' : null;
    if (!kind) return undefined;
    setFx({ kind, species: foe.species, at: Date.now() });
    const id = setTimeout(() => setFx(null), 4700);
    return () => clearTimeout(id);
  }, [foe?.species, foe?.level, foe?.maxHp, foe?.shiny]);
  if (!fx) return null;
  const stars = Array.from({ length: 28 }, (_, i) => i);
  return html`<div class=${`enc-fx ${fx.kind}`} key=${fx.at} aria-live="polite">
    ${stars.map((i) => html`<i style=${`--i:${i};--x:${(i * 53 + 7) % 100}%;--y:${(i * 37 + 11) % 100}%`}></i>`)}
    <div class="enc-fx-label">${fx.kind === 'shiny' ? t('fx.shinyLabel', 'Shiny {mon}!', { mon: speciesName(fx.species) }) : t('fx.legendLabel', 'Legendary: {mon}!', { mon: speciesName(fx.species) })}</div>
  </div>`;
}

/** Run rules inside the session – a drawer from the left, so the game stays on screen. */
export function RulesDrawer({ open, onClose, RulesTab }) {
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Esc closes (unless a dialog opened from inside the drawer handles it); Tab stays inside while it is open.
  // Focus goes back to the game on close (the session's onClose), not to the Rules button.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]') && close.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  useFocusTrap(ref, open, { restore: false });
  if (!open) return null;
  return html`<div class="rules-drawer-wrap" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <aside class="rules-drawer" role="dialog" aria-modal="true" aria-label=${t('session.rules', 'Rules')} ref=${ref} tabIndex="-1">
      <div class="row rules-drawer-head"><h2 class="grow">${t('session.rules', 'Rules')}</h2>
        <button class="btn small ghost" onClick=${onClose} aria-label=${t('common.close', 'Close')}><${Icon} name="close" size=${12} /></button></div>
      <div class="rules-drawer-body"><${RulesTab} /></div>
    </aside>
  </div>`;
}

/**
 * Prominent "pair died" alert for both players – shown on top of everything until acknowledged.
 * alert = { area, by } from the run document.
 */
export function DeathAlert({ alert, onClose }) {
  const { doc, manifest, me, runData } = useApp();
  if (!alert || !doc || !manifest) return null;
  const names = getPlayers(doc, manifest);
  const slots = slotsOf(manifest);
  const st = pairState(doc, alert.area, slots);
  const gen = runData?.gen || 4;
  const byMe = alert.by === me;
  const mineEnc = st.encs[me];
  const by = st.encs[alert.by];
  const cause = causeText(doc, manifest, st.pair?.cause);
  const n = slots.length;
  const sp = (e) => speciesName(e?.species);
  let text;
  if (n === 1) text = t('death.alertSolo', 'Your {mon} fell. Rest in peace.', { mon: mineEnc?.nickname || sp(mineEnc) });
  else if (n === 2) {
    const partner = names[othersOf(me, manifest)[0]].name;
    const theirs = st.encs[othersOf(me, manifest)[0]];
    text = byMe
      ? theirs?.species
        ? t('death.alertMine', 'Your {mon} fell – {partner}’s {pmon} goes with it.', { mon: sp(mineEnc), partner, pmon: sp(theirs) })
        : t('death.alertMineAlone', 'Your {mon} fell – this area’s pair is lost for {partner} too.', { mon: sp(mineEnc), partner })
      : mineEnc?.species
        ? t('death.alertPartner', '{name}’s {mon} fell – your {mine} is gone too.', { name: partner, mon: sp(theirs), mine: sp(mineEnc) })
        : t('death.alertPartnerAlone', '{name}’s {mon} fell – this area’s pair is lost for you too.', { name: partner, mon: sp(theirs) });
  } else {
    const name = names[alert.by]?.name || '';
    text = byMe ? t('death.alertMineGroup', 'Your {mon} fell – the whole group goes with it.', { mon: sp(mineEnc) })
      : mineEnc?.species ? t('death.alertOtherGroup', '{name}’s {mon} fell – the whole group goes with it, your {mine} too.', { name, mon: sp(by), mine: sp(mineEnc) })
        : t('death.alertOtherGroupAlone', '{name}’s {mon} fell – this area’s group is lost for you too.', { name, mon: sp(by) });
  }
  return html`<${Modal} open=${true} onClose=${onClose} title=${n === 1 ? t('death.alertTitleSolo', 'A Pokémon died') : n > 2 ? t('death.alertTitleGroup', 'A group died') : t('death.alertTitle', 'A pair died')}
    footer=${html`<button class="btn danger" onClick=${onClose}>${t('death.alertOk', 'Rest in peace')}</button>`}>
    <div class="death-alert">
      <div class=${`death-mons n${slots.length}`}>
        ${slots.map((s) => st.encs[s]?.species && html`<div class="death-mon" style=${`--acc:var(--${s})`}><${Sprite} id=${st.encs[s].species} size=${72} gen=${gen} /><span>${st.encs[s].nickname || sp(st.encs[s])}</span></div>`)}
      </div>
      <p class="death-text">${text}</p>
      <p class="small muted">${areaName(doc, manifest, alert.area)}${cause ? ` · ${cause}` : ''}</p>
    </div>
  </${Modal}>`;
}
