// "Share to Discord" (Live runs) in the page: the link state (from the local server – never the token), the events
// a player can share (a death, a run's end, a won run), the card model and the post's text, and the share itself:
// the card is painted here (web/lib/livecard.mjs) and handed to the local server, which posts it to the bot.
import { useState, useEffect } from '/vendor/htm-preact.mjs';
import { t } from './i18n.mjs';
import { api } from './api.mjs';
import { speciesName, spriteUrl, gameById, hackById, gameTitle } from './data.mjs';
import {
  players as getPlayers, slotsOf, runMode, pairState, encounter, live, areaName, joinNames, counts, runStats, progression, isDefaultName,
} from './run.mjs';
import { eventIdFor, buildMeta } from '/shared/liveruns.mjs';
import { PLAYER_COLORS, renderCardPng } from './livecard.mjs';

// ---- link state (GET /api/liveruns): { linked, user: { id, name }, shared: { eventId: { at, url } }, limits } ----
let state = { linked: false, user: null, shared: {}, limits: null, loaded: false };
const subs = new Set();
const emit = () => {
  for (const fn of subs) fn(state);
};
let loading = null;

/** Ask the local server again; `check` also asks the bot (name, posts left today, a revoked link). */
export async function refreshLiveRuns(check = false) {
  try {
    const s = await api.get(`/api/liveruns${check ? '?check=1' : ''}`);
    state = { ...state, ...s, loaded: true };
  } catch {
    state = { ...state, loaded: true };
  }
  emit();
  return state;
}

export function setLiveRunsState(patch) {
  state = { ...state, ...patch };
  emit();
}

/** The link state, re-rendering when it changes (loaded once per app start). */
export function useLiveRuns() {
  const [s, set] = useState(state);
  useEffect(() => {
    subs.add(set);
    if (!state.loaded && !loading) loading = refreshLiveRuns().finally(() => { loading = null; });
    set(state);
    return () => subs.delete(set);
  }, []);
  return s;
}

// ---- events ----

/** A death (the group of `area`): its id is the same for every player of the run – a partner's share counts too. */
export function deathEvent(doc, manifest, area) {
  const p = doc.get(`pair:${area}`, null);
  if (p?.state !== 'dead') return null;
  return { kind: 'death', area, at: p.diedAt || 0, id: eventIdFor(manifest.id, 'death', { area, at: p.diedAt || 0 }) };
}

/** A run's end (run:status): failed → 'wipe', won → 'victory'. */
export function endEvent(manifest, status) {
  if (!status || !['failed', 'won'].includes(status.state)) return null;
  const kind = status.state === 'won' ? 'victory' : 'wipe';
  return { kind, status, at: status.at || 0, id: eventIdFor(manifest.id, kind, { at: status.at || 0 }) };
}

// ---- the card model ----

export function gameName(manifest) {
  const h = manifest?.game?.hackId ? hackById(manifest.game.hackId) : null;
  const g = manifest?.game?.id ? gameById(manifest.game.id) : null;
  return h ? h.name : g ? gameTitle(g) : manifest?.game?.title || '';
}

/** A nickname that is more than the species' name in any language ('' when the Pokémon has none). */
function realNick(nick, species) {
  const n = String(nick || '').trim();
  return !n || isDefaultName(species, n) ? '' : n;
}
const monLabel = (nick, species) => realNick(nick, species) || speciesName(species);
const lvText = (lv) => `${t('common.lv', 'Lv')} ${lv}`;

/** "Ember (Lv 18 Cyndaquil)", "Cyndaquil (Lv 18)" */
function monText(nick, species, level) {
  const n = realNick(nick, species);
  const sp = speciesName(species);
  if (n) return level ? `${n} (${lvText(level)} ${sp})` : `${n} (${sp})`;
  return level ? `${sp} (${lvText(level)})` : sp;
}

/** Where it fell: the place sign stored with the death, else the player's place sign if it was read around then. */
function placeOf(doc, pair) {
  if (pair?.place?.name) return String(pair.place.name);
  const w = pair?.by ? doc.get(`where:${pair.by}`, null) : null;
  if (w?.name && pair?.diedAt && Math.abs((w.at || 0) - pair.diedAt) < 10 * 60 * 1000 && (w.at || 0) <= pair.diedAt + 5000) return String(w.name);
  return '';
}

const killerKind = (k) => (k?.kind === 'trainer' ? t('live.kTrainer', 'trainer battle') : k?.kind === 'wild' ? t('live.kWild', 'wild battle') : '');

/** Every player's team as the card shows it: the live party (else the party areas), the event's Pokémon marked. */
function teams(doc, manifest, eventArea) {
  const slots = slotsOf(manifest);
  const names = getPlayers(doc, manifest);
  const pair = eventArea ? doc.get(`pair:${eventArea}`, null) : null;
  return slots.map((slot) => {
    const l = live(doc, slot);
    let list = (l?.party || []).filter((m) => m.species && !m.egg)
      .map((m) => ({ species: m.species, nick: m.nick, level: m.level ?? null, area: m.area || null, shiny: !!m.shiny, down: m.maxHp > 0 && m.hp === 0 }));
    if (!list.length) {
      list = (doc.get(`party:${slot}`, []) || []).map((a) => {
        const e = encounter(doc, a, slot);
        return e?.outcome === 'caught' && e.species ? { species: e.species, nick: e.nickname, level: e.level ?? null, area: a, shiny: !!e.shiny } : null;
      }).filter(Boolean);
    }
    // the fallen one of this player, also when it isn't in the party (a partner's linked Pokémon in the box)
    const e = eventArea ? encounter(doc, eventArea, slot) : null;
    if (e?.outcome === 'caught' && e.species && !list.some((m) => m.area === eventArea)) {
      list = [...list.slice(0, 5), { species: e.species, nick: e.nickname, level: (pair?.by === slot ? pair.level : null) ?? e.level ?? null, area: eventArea, shiny: !!e.shiny }];
    }
    const mons = list.slice(0, 6).map((m) => {
      const st = m.area === eventArea && eventArea ? 'fallen' : m.area && pairState(doc, m.area, slots).state === 'dead' ? 'dead' : m.down ? 'down' : 'alive';
      const nick = realNick(m.nick, m.species);
      return { species: m.species, shiny: m.shiny, name: nick || speciesName(m.species), sub: nick ? speciesName(m.species) : '', level: m.level, state: st };
    });
    const alive = mons.filter((m) => m.state === 'alive').length;
    return { slot, name: names[slot]?.name || slot.toUpperCase(), color: PLAYER_COLORS[slot], count: mons.length ? `${alive}/${mons.length}` : '', mons, empty: t('live.noTeam', 'No team seen yet') };
  });
}

/** The run in three numbers: alive, dead, badges (the best of the players). */
function statsOf(doc, manifest) {
  const solo = runMode(manifest) === 'nuzlocke';
  const slots = slotsOf(manifest);
  const badges = Math.max(0, ...slots.map((s) => live(doc, s)?.badges || 0));
  let alive;
  let dead;
  if (solo) {
    const st = runStats(doc, manifest, 'p1');
    alive = st.alive;
    dead = st.dead;
  } else {
    const c = counts(doc, manifest);
    alive = c.linked;
    dead = c.dead;
  }
  return {
    alive, dead, badges,
    boxes: [
      { value: alive, label: t('live.sAlive', 'alive'), tone: 'alive' },
      { value: dead, label: t('live.sDead', 'dead'), tone: 'dead' },
      { value: badges, label: t('live.sBadges', 'badge|badges', { count: badges }), tone: 'gold' },
    ],
  };
}

/** The death that ended a run (or the last one): its area and pair. */
function lastDeath(doc, manifest, status) {
  if (status?.area) {
    const p = doc.get(`pair:${status.area}`, null);
    if (p?.state === 'dead') return { area: status.area, pair: p };
  }
  let best = null;
  for (const a of progression(doc, manifest)) {
    if (a.kind !== 'area') continue;
    const p = doc.get(`pair:${a.key}`, null);
    if (p?.state !== 'dead') continue;
    const score = (p.diedAt || 0) + (status?.by && p.by === status.by ? 1e13 : 0);
    if (!best || score > best.score) best = { area: a.key, pair: p, score };
  }
  return best;
}

/** The cause panel and the post's sentence for one death. */
function deathCause(doc, manifest, area, pair, label) {
  const slots = slotsOf(manifest);
  const by = pair.by && slots.includes(pair.by) ? pair.by : slots.find((s) => encounter(doc, area, s)?.species) || slots[0];
  const enc = encounter(doc, area, by);
  const k = pair.killer?.species ? pair.killer : null;
  const place = placeOf(doc, pair);
  const typed = typeof pair.cause === 'string' ? pair.cause.trim() : '';
  const n = slots.length;
  const others = slots.filter((s) => s !== by).map((s) => [s, encounter(doc, area, s)]).filter(([, e]) => e?.species);
  const names = getPlayers(doc, manifest);
  const went = others.length ? t('live.dWent', '{list} went with it', {
    list: joinNames(others.map(([s, e]) => t('live.whose', '{name}’s {mon}', { name: names[s]?.name || s.toUpperCase(), mon: monLabel(e.nickname, e.species) }))),
  }) : '';
  const where = areaName(doc, manifest, area);
  const note = typed || (n === 1 ? t('live.caughtAt', 'Caught at {area}', { area: where })
    : n > 2 ? t('live.groupFrom', 'The linked group from {area}', { area: where }) : t('live.pairFrom', 'The linked pair from {area}', { area: where }));
  const cause = {
    label: k ? label.killer : label.none,
    species: k?.species || null,
    title: k ? speciesName(k.species) : t('live.noBattle', 'No battle seen'),
    level: k?.level || null,
    lvLabel: t('common.lv', 'Lv'),
    chip: k?.kind === 'trainer' ? t('live.cTrainer', 'Trainer battle') : k?.kind === 'wild' ? t('live.cWild', 'Wild battle') : '',
    chipTone: k?.kind || null,
    place,
    note,
    icon: 'grave',
  };
  const mon = enc?.species ? monText(enc.nickname, enc.species, pair.level ?? enc.level) : '';
  const foe = k ? `${speciesName(k.species)}${k.level ? ` ${lvText(k.level)}` : ''}` : '';
  const kind = killerKind(k);
  const sentence = mon && foe ? (kind ? t('live.dKilled', '{mon} fell to {foe} in a {kind}', { mon, foe, kind }) : t('live.dKilledNoKind', '{mon} fell to {foe}', { mon, foe }))
    : mon ? t('live.dDied', '{mon} died', { mon }) : '';
  const detail = [sentence, place, went, typed ? `“${typed}”` : ''].filter(Boolean).join(' · ');
  return { cause, detail, by, enc };
}

/**
 * The card model for an event (deathEvent / endEvent) – every word in the app's language – and the post's `meta`
 * input (shared/liveruns.mjs buildMeta cleans and cuts it). `app`: the version on the card's corner.
 */
export function cardModel({ doc, manifest, gen = 4, event, app = '' }) {
  const slots = slotsOf(manifest);
  const n = slots.length;
  const solo = runMode(manifest) === 'nuzlocke';
  const names = getPlayers(doc, manifest);
  const playerNames = slots.map((s) => names[s]?.name || s.toUpperCase());
  const game = gameName(manifest);
  const run = manifest.name || '';
  const stats = statsOf(doc, manifest);
  const kicker = solo ? t('live.kNuzlocke', 'Nuzlocke') : t('live.kSoulLink', 'SoulLink · {n} players', { n });
  let headline = '';
  let detail = '';
  let cause = null;
  let tag = '';
  let highlights = [];
  const eventArea = event.kind === 'death' ? event.area : null;
  const teamList = teams(doc, manifest, eventArea);
  if (event.kind === 'death') {
    const pair = doc.get(`pair:${event.area}`, null) || {};
    const fallenBy = slots.map((s) => [s, encounter(doc, event.area, s)]).filter(([, e]) => e?.species);
    const fallen = fallenBy.map(([, e]) => monLabel(e.nickname, e.species));
    highlights = fallenBy.map(([s, e]) => ({ text: monLabel(e.nickname, e.species), color: PLAYER_COLORS[s] }));
    headline = fallen.length >= 3 ? t('live.hGoneN', '{names} are gone', { names: joinNames(fallen) })
      : fallen.length === 2 ? t('live.hGone2', '{a} and {b} are gone', { a: fallen[0], b: fallen[1] })
        : t('live.hGone1', '{a} is gone', { a: fallen[0] || areaName(doc, manifest, event.area) });
    const d = deathCause(doc, manifest, event.area, pair, { killer: t('live.fellTo', 'Fell to'), none: t('live.cause', 'Cause') });
    cause = d.cause;
    detail = d.detail;
    tag = t('live.tagDeath', 'Death');
  } else if (event.kind === 'wipe') {
    const st = event.status || {};
    const who = names[st.by]?.name || playerNames[0];
    if (solo || st.auto) highlights = [{ text: who, color: PLAYER_COLORS[st.by] || PLAYER_COLORS.p1 }];
    headline = solo ? (st.reason === 'deathless' ? t('live.hDeathless', '{name}’s deathless run is over', { name: who }) : t('live.hWipeSolo', '{name}’s Nuzlocke is over', { name: who }))
      : st.auto ? t('live.hWipe', '{name}’s team was wiped', { name: who }) : t('live.hEnded', 'The SoulLink is over');
    const last = lastDeath(doc, manifest, st);
    if (last) {
      const d = deathCause(doc, manifest, last.area, last.pair, { killer: t('live.lastFellTo', 'The last one fell to'), none: t('live.lastToFall', 'The last to fall') });
      cause = d.cause;
      detail = d.detail;
    } else cause = { label: t('live.runOver', 'Run over'), title: st.auto ? t('live.wiped', 'Team wiped') : t('live.endedByHand', 'Ended by hand'), icon: 'grave' };
    detail = [t('live.dStats', '{alive} alive · {dead} dead', { alive: stats.alive, dead: stats.dead }), detail].filter(Boolean).join(' · ');
    tag = t('live.tagWipe', 'Run over');
  } else {
    headline = solo ? t('live.hWonSolo', '{name} beat the Champion!', { name: playerNames[0] }) : t('live.hWon', '{names} beat the Champion!', { names: joinNames(playerNames) });
    highlights = slots.map((s, i) => ({ text: playerNames[i], color: PLAYER_COLORS[s] }));
    const st = solo ? runStats(doc, manifest, 'p1') : null;
    // the strongest Pokémon still standing gets the window
    const mvp = teamList.flatMap((tm) => tm.mons.filter((m) => m.state === 'alive').map((m) => ({ ...m, owner: tm.name })))
      .sort((a, b) => (b.level || 0) - (a.level || 0))[0];
    cause = mvp
      ? { label: t('live.champion', 'Champion beaten'), species: mvp.species, title: mvp.name, level: mvp.level, lvLabel: t('common.lv', 'Lv'),
        chip: t('live.mvp', 'Strongest of the run'), chipTone: 'gold', icon: 'trophy',
        note: [n > 1 ? t('live.mvpOf', '{name}’s team', { name: mvp.owner }) : '', st?.attempt > 1 ? t('live.attempt', 'Attempt #{n}', { n: st.attempt }) : ''].filter(Boolean).join(' · ') }
      : { label: t('live.champion', 'Champion beaten'), title: t('live.runWon', 'Run won!'), icon: 'trophy',
        note: st?.attempt > 1 ? t('live.attempt', 'Attempt #{n}', { n: st.attempt }) : '' };
    detail = t('live.dWon', 'Run won with {alive} alive and {dead} lost on the way', { alive: stats.alive, dead: stats.dead });
    tag = t('live.tagWon', 'Victory');
  }
  const model = {
    v: 1, kind: event.kind, mode: solo ? 'nuzlocke' : 'soullink', gen,
    kicker, tag, headline, highlights, run, game, cause, stats: stats.boxes,
    teams: teamList,
    ticker: [t('live.ticker', 'Live runs'), game, solo ? t('live.kNuzlocke', 'Nuzlocke') : t('live.tickPlayers', '{n} players', { n })].filter(Boolean),
    labels: { fallen: t('live.lFallen', 'Gone'), dead: t('live.lDead', 'Dead'), lv: t('common.lv', 'Lv') },
    app,
  };
  const metaInput = { eventId: event.id, kind: event.kind, mode: model.mode, game, run, players: playerNames, headline, detail };
  return { model, metaInput };
}

/** Bytes → base64 (in chunks: the card is around half a megabyte). */
function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Share `event`: paint the card, send it with its text through the local server. Returns the server's outcome
 * ({ ok, url } or { ok: false, error, … }) plus `changed` (fields that lost a link or a link word).
 */
export async function shareEvent({ doc, manifest, gen, event, app = '' }) {
  const { model, metaInput } = cardModel({ doc, manifest, gen, event, app });
  const { meta, changed } = buildMeta(metaInput);
  const png = await renderCardPng(model, (id, fallback) => spriteUrl(id, { gen: fallback ? 9 : gen }));
  const r = await api.post('/api/liveruns/post', { meta, image: base64(png) });
  if (r.ok || r.error === 'duplicate') setLiveRunsState({ shared: { ...state.shared, [event.id]: { at: Date.now(), url: r.url || null, duplicate: !r.ok } } });
  if (r.error === 'token') setLiveRunsState({ linked: false, user: null, expired: true });
  return { ...r, changed };
}

/** The outcome as one line for the player. */
export function shareErrorText(r) {
  switch (r?.error) {
    case 'rate': {
      const min = Math.max(1, Math.ceil((r.retryAfter || 60) / 60));
      return t('live.eRate', 'Too many posts – try again in {n} min.', { n: min });
    }
    case 'token': return t('live.eToken', 'The Discord link has ended – connect again in Settings › Discord.');
    case 'blocked': return t('live.eBlocked', 'This Discord account can no longer post live runs.');
    case 'not-member': return t('live.eNotMember', 'Your Discord account is no longer on the souldew server – join it again to post.');
    case 'duplicate': return t('live.already', 'Already shared – by you or a partner.');
    case 'invalid': return r.reason === 'word' ? t('live.eWord', 'The server’s word filter refused a nickname or a text on this card.')
      : t('live.eInvalid', 'The server refused the post ({field}).', { field: r.field || '?' });
    case 'unavailable': return t('live.eUnavailable', 'Discord can’t be reached right now – try again in a moment.');
    case 'offline': return t('live.eOffline', 'No connection to the souldew bot – are you online?');
    default: return t('live.eServer', 'Sharing didn’t work – try again later.');
  }
}
