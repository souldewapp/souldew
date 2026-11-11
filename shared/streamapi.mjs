// The open stream API (/api/v1, docs/STREAM_API.md): the run as plain JSON for streamers who build their own
// layout, the changes between two states as events, and the sprite URLs. Pure functions – the server
// (server/lib/streamapi.mjs) feeds them the stored doc and the name lookups; test/streamapi.test.mjs checks the
// payload shape.
//
// Like the overlay snapshot (shared/overlay.mjs) it carries only what a stream may show: no room keys or secrets,
// no file names or folders, no device ids, no spoiler log, no Discord webhook, no moves.

import { slotsOf, runMode } from './slots.mjs';
import { runGen, areaLabel, statusKey, validLevel } from './overlay.mjs';
import { legendaryKind } from './legendaries.mjs';
import { rulesWithDefaults } from './rules.mjs';
import { levelCapFor, gymCapsFamily, vanillaCapFor } from './routes.mjs';

export const API_VERSION = 1;
export const API_PREFIX = '/api/v1';
/** The players' colours – the same as the app's and the overlays' (p1 blue, p2 pink, p3 green, p4 violet). */
export const PLAYER_COLORS = { p1: '#7f9ddb', p2: '#c98bbf', p3: '#b3c770', p4: '#a993e6' };
export const API_LANGS = ['en', 'de', 'fr', 'es', 'it'];
export const apiLang = (v) => (API_LANGS.includes(String(v || '').slice(0, 2)) ? String(v).slice(0, 2) : 'en');
const LIVE_FRESH = 10 * 60 * 1000;
const FEED = 20;

// ---- sprites ---------------------------------------------------------------------------------------------------

export const SPRITE_STYLES = ['default', 'gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'artwork', 'animated', 'icon'];
export const SPRITE_VARIANTS = ['front', 'back', 'front-shiny', 'back-shiny'];
const GEN_MAX = [0, 151, 251, 386, 493, 649];
const VERSION_DIR = {
  gen1: 'versions/generation-i/red-blue/transparent/', gen2: 'versions/generation-ii/crystal/transparent/',
  gen3: 'versions/generation-iii/emerald/', gen4: 'versions/generation-iv/heartgold-soulsilver/', gen5: 'versions/generation-v/black-white/',
};
const CACHE_SUFFIX = { front: '', back: 'back', 'front-shiny': 'shiny', 'back-shiny': 'backshiny' };
const DIR_SUFFIX = { front: '', back: 'back/', 'front-shiny': 'shiny/', 'back-shiny': 'back/shiny/' };

/**
 * Where a v1 sprite comes from: `{ set, path, ext }` – `set` is the folder in the app's sprite cache (the same one the
 * app and the overlays fill: `default`, `gen4`, `gen4shiny` …), `path` is below PokeAPI's sprites/pokemon/. null when
 * that sprite doesn't exist (Gen 1 has no shiny, artwork and icons have no back, a style older than the species).
 */
export function spriteSource(style, variant, id) {
  id = Number(id);
  if (!Number.isInteger(id) || id < 1 || id > 1025 || !SPRITE_STYLES.includes(style) || !SPRITE_VARIANTS.includes(variant)) return null;
  const sfx = CACHE_SUFFIX[variant];
  if (style === 'default') return { set: sfx || 'default', path: `${DIR_SUFFIX[variant]}${id}.png`, ext: 'png' };
  if (style === 'artwork') return variant.startsWith('back') ? null : { set: `artwork${sfx}`, path: `other/official-artwork/${DIR_SUFFIX[variant]}${id}.png`, ext: 'png' };
  if (style === 'icon') return variant === 'front' && id <= 807 ? { set: 'icon', path: `versions/generation-vii/icons/${id}.png`, ext: 'png' } : null;
  if (style === 'animated') return id <= 649 ? { set: `gen5anim${sfx}`, path: `versions/generation-v/black-white/animated/${DIR_SUFFIX[variant]}${id}.gif`, ext: 'gif' } : null;
  const g = Number(style.slice(3));
  if (id > GEN_MAX[g] || (g === 1 && variant.endsWith('shiny'))) return null;
  return { set: `${style}${sfx}`, path: `${VERSION_DIR[style]}${DIR_SUFFIX[variant]}${id}.png`, ext: 'png' };
}

/**
 * The sprite URLs of one Pokémon in a run of generation `gen`: the game's own style where the species exists in it
 * (what the app and the overlays show), else the modern default. `front`/`back` follow `shiny`.
 */
export function spriteUrls(id, { gen = 4, shiny = false, base = '', token = '' } = {}) {
  if (!Number.isInteger(id) || id < 1 || id > 1025) return null;
  const style = gen >= 1 && gen <= 5 && id <= GEN_MAX[gen] ? `gen${gen}` : 'default';
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  const url = (st, v) => {
    const s = spriteSource(st, v, id);
    return s ? `${base}${API_PREFIX}/sprites/${st}/${v}/${id}.${s.ext}${q}` : null;
  };
  const shinyOk = shiny && style !== 'gen1';
  return {
    style,
    front: url(style, shinyOk ? 'front-shiny' : 'front'),
    back: url(style, shinyOk ? 'back-shiny' : 'back'),
    frontNormal: url(style, 'front'), frontShiny: url(style, 'front-shiny'),
    backNormal: url(style, 'back'), backShiny: url(style, 'back-shiny'),
    icon: url('icon', 'front'),
    artwork: url('artwork', shiny ? 'front-shiny' : 'front'),
    animated: url('animated', shiny ? 'front-shiny' : 'front'),
  };
}

// ---- the state -------------------------------------------------------------------------------------------------

const int = (v) => (Number.isInteger(v) ? v : null);
const num = (v) => (Number.isFinite(v) ? v : null);
const str = (v, n = 40) => (typeof v === 'string' ? v.slice(0, n) : '');
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

function playTime(pt) {
  if (typeof pt === 'number' && Number.isFinite(pt)) return { h: Math.floor(pt / 3600), m: Math.floor((pt % 3600) / 60) };
  if (obj(pt) && Number.isInteger(pt.h)) return { h: pt.h, m: int(pt.m) ?? 0 };
  return null;
}

/** HeartGold/SoulSilver (and Definitive HG) have curated level caps – the same test as web/lib/run.mjs profileOf. */
// HeartGold/SoulSilver's bosses in English (the app shows them translated: web/lib/run.mjs BOSS_NAMES)
const BOSS_NAMES = {
  'rival-1': 'Rival (Cherrygrove)', falkner: 'Falkner', bugsy: 'Bugsy', 'rival-2': 'Rival (Azalea)', whitney: 'Whitney', morty: 'Morty',
  chuck: 'Chuck', jasmine: 'Jasmine', pryce: 'Pryce', 'rival-3': 'Rival (Radio Tower)', clair: 'Clair', 'rival-4': 'Rival (Victory Road)',
  will: 'Will (Elite Four)', koga: 'Koga (Elite Four)', bruno: 'Bruno (Elite Four)', karen: 'Karen (Elite Four)', lance: 'Lance (Champion)',
  'kanto-leaders': 'Kanto Gym Leaders', blue: 'Blue', red: 'Red',
};
const HGSS = ['IPKE', 'IPGE', 'IPKD', 'IPGD', 'IPKF', 'IPGF', 'IPKS', 'IPGS', 'IPKI', 'IPGI'];

/** The level cap of a player with `badges`, when the run uses caps and the game has them: { cap, boss } or null. */
export function levelCapOf(manifest, rules, raw, badges) {
  if (!rules?.levelCaps || !Number.isInteger(badges)) return null;
  if (HGSS.includes(String(manifest?.game?.code || '').toUpperCase())) {
    const defeated = {};
    for (const [k, e] of Object.entries(raw)) if (k.startsWith('boss:') && e?.v) defeated[k.slice(5)] = e.v;
    const r = levelCapFor(badges, defeated, !manifest?.patch);
    return { cap: r.cap, boss: r.boss ? { key: r.boss.key, name: BOSS_NAMES[r.boss.key] || r.boss.key } : null };
  }
  if (manifest?.game?.hackId || manifest?.patch) return null; // a ROM hack's trainers have other levels
  const v = vanillaCapFor(gymCapsFamily(manifest?.game?.id || manifest?.base?.gameId || ''), badges);
  return v ? { cap: v.cap, boss: { key: v.boss.key, name: v.boss.name || (v.boss.badge !== undefined ? `Gym ${v.boss.badge + 1}` : v.boss.key) } } : null;
}

/**
 * The whole run as the API hands it out. `doc` is the stored doc ({ key: { v, t, by } }). Options: `lang`,
 * `speciesName(id)`, `itemName(id, gen)` (null when unknown), `tables` (location tables, see areaLabel),
 * `gameName(id)`, `base` (the server's origin for absolute sprite URLs), `token` (appended to sprite URLs), `now`.
 */
export function buildState(manifest, doc, opts = {}) {
  const { lang = 'en', speciesName = (id) => `#${id}`, itemName = () => null, tables = {}, gameName = () => null, base = '', token = '', now = Date.now() } = opts;
  const raw = obj(doc) || {};
  const val = (k) => {
    const e = raw[k];
    return e && typeof e === 'object' && e.v !== undefined ? e.v : null;
  };
  const mode = runMode(manifest);
  const gen = runGen(manifest);
  const slots = slotsOf(manifest);
  const label = (a) => (a ? areaLabel(a, { doc: raw, tables, lang }) : null);
  const sp = (id) => (Number.isInteger(id) && id > 0 ? speciesName(id) : null);
  let updatedAt = 0;
  for (const e of Object.values(raw)) if (Number.isFinite(e?.t) && e.t > updatedAt) updatedAt = e.t;

  // encounters per area, in the order they happened
  const areas = new Map();
  for (const k of Object.keys(raw)) {
    if (!k.startsWith('enc:')) continue;
    const v = obj(val(k));
    if (!v) continue;
    const area = k.slice(4, k.lastIndexOf(':'));
    const slot = k.slice(k.lastIndexOf(':') + 1);
    if (!slots.includes(slot) || !area) continue;
    if (!areas.has(area)) areas.set(area, {});
    areas.get(area)[slot] = v;
  }
  const pairOf = (a) => obj(val(`pair:${a}`));
  const deadArea = (a) => !!a && pairOf(a)?.state === 'dead';

  const mon = (m, slot, extra = {}) => {
    const species = int(m.species);
    const lv = validLevel(m.level);
    const hpOk = Number.isFinite(m.hp) && Number.isFinite(m.maxHp) && m.maxHp > 0 && m.hp >= 0 && m.hp <= m.maxHp;
    const hp = hpOk ? m.hp : null;
    const status = statusKey(hpOk ? m : { status: m.status });
    const fainted = hp === 0;
    const dead = deadArea(m.area);
    const item = Number.isInteger(m.item) && m.item > 0 ? { id: m.item, name: (!m.itemOwn && itemName(m.item, gen)) || null } : null;
    return {
      slot, key: str(m.key) || null, area: m.area ? str(m.area, 60) : null, areaName: label(m.area),
      species, name: sp(species), nickname: str(m.nick ?? m.nickname, 24), level: lv,
      hp, maxHp: hp === null ? null : m.maxHp, status: status === 'fnt' ? '' : status, fainted, item,
      shiny: !!m.shiny, egg: !!m.egg, dead, alive: !dead && !fainted, inParty: true,
      legendary: legendaryKind(species),
      sprites: spriteUrls(species, { gen, shiny: !!m.shiny, base, token }), ...extra,
    };
  };
  const fromEncounter = (area, slot, e) => mon({ key: null, area, species: e.species, nick: e.nickname, level: e.level, shiny: e.shiny }, slot, { inParty: false });

  const rules = rulesWithDefaults(val('rules'), mode);
  delete rules.discordWebhook; // stays on the streamer's computer (and older runs kept it here)
  const cleanRules = Object.fromEntries(Object.entries(rules).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)));

  const players = slots.map((slot) => {
    const live = obj(val(`live:${slot}`));
    const where = obj(val(`where:${slot}`));
    const meta = obj(val(`player:${slot}`)) || {};
    let party;
    if (Array.isArray(live?.party) && live.party.length) party = live.party.slice(0, 6).filter((m) => obj(m) && Number.isInteger(m.species)).map((m) => mon(m, slot));
    else {
      const list = Array.isArray(val(`party:${slot}`)) ? val(`party:${slot}`).slice(0, 6) : [];
      party = list.map((a) => {
        const e = obj(areas.get(a)?.[slot]);
        return e?.species ? { ...fromEncounter(a, slot, e), inParty: true } : null;
      }).filter(Boolean);
    }
    const fight = obj(where?.fight);
    return {
      slot, name: str(meta.name, 24) || str(manifest?.players?.[slot]?.name, 24) || slot.toUpperCase(), color: PLAYER_COLORS[slot],
      live: Number.isFinite(live?.at) && Math.abs(now - live.at) < LIVE_FRESH, updatedAt: num(live?.at),
      badges: int(live?.badges), levelCap: live ? levelCapOf(manifest, rules, raw, int(live.badges) ?? 0) : null, playTime: playTime(live?.playTime),
      location: where ? {
        id: int(where.id), gen: int(where.gen), name: str(where.name, 60) || null, at: num(where.at),
        battle: fight && Number.isInteger(fight.species) ? { kind: fight.kind === 'trainer' ? 'trainer' : 'wild', species: fight.species, name: sp(fight.species),
          level: validLevel(fight.level), legendary: legendaryKind(fight.species), sprites: spriteUrls(fight.species, { gen, base, token }) } : null,
      } : null,
      party,
    };
  });

  const encounters = [...areas.entries()].map(([area, bySlot]) => {
    const encs = slots.map((s) => obj(bySlot[s]));
    const state = deadArea(area) ? 'dead' : encs.some((e) => e?.outcome === 'missed') ? 'failed' : encs.every((e) => e?.outcome === 'caught') ? 'alive' : 'waiting';
    const results = Object.fromEntries(slots.map((s, i) => {
      const e = encs[i];
      return [s, e ? { outcome: str(e.outcome, 12) || null, species: int(e.species), name: sp(int(e.species)), level: validLevel(e.level), nickname: str(e.nickname, 24), shiny: !!e.shiny, at: num(e.at) } : null];
    }));
    const at = Math.min(...encs.map((e) => (Number.isFinite(e?.at) ? e.at : Infinity)));
    return { area, name: label(area), state, at: Number.isFinite(at) ? at : null, results };
  }).sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));

  const memberOf = (area, slot) => {
    const p = players.find((x) => x.slot === slot);
    const inParty = p?.party.find((m) => m.area === area);
    if (inParty) return inParty;
    const e = obj(areas.get(area)?.[slot]);
    return e?.outcome === 'caught' && e.species ? fromEncounter(area, slot, e) : null;
  };
  const links = encounters.filter((e) => e.state === 'alive' || e.state === 'dead')
    .map((e) => ({ area: e.area, name: e.name, state: e.state, members: Object.fromEntries(slots.map((s) => [s, memberOf(e.area, s)])) }));
  const graveyard = links.filter((l) => l.state === 'dead').map((l) => {
    const p = pairOf(l.area) || {};
    const k = obj(p.killer);
    return { area: l.area, name: l.name, diedAt: num(p.diedAt), level: validLevel(p.level), by: slots.includes(p.by) ? p.by : null,
      killer: k && Number.isInteger(k.species) ? { species: k.species, name: sp(k.species), level: validLevel(k.level), kind: k.kind === 'trainer' ? 'trainer' : k.kind === 'wild' ? 'wild' : null } : null,
      members: l.members };
  }).sort((a, b) => (b.diedAt || 0) - (a.diedAt || 0));

  const feed = Object.entries(raw).filter(([k]) => k.startsWith('feed:')).map(([k, e]) => [k, obj(e?.v)]).filter(([, v]) => v)
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, FEED)
    .map(([k, v]) => ({ id: k.slice(5), at: num(v.at), type: str(v.type, 12), slot: slots.includes(v.slot) ? v.slot : null, area: v.area ? str(v.area, 60) : null,
      areaName: label(v.area), species: int(v.species), name: sp(int(v.species)) }));

  const status = obj(val('run:status'));
  const counts = { alive: 0, dead: 0, caught: 0, missed: 0, encounters: encounters.length };
  for (const e of encounters) {
    if (e.state === 'alive') counts.alive++;
    if (e.state === 'dead') counts.dead++;
    if (Object.values(e.results).every((r) => r?.outcome === 'caught')) counts.caught++;
    if (Object.values(e.results).some((r) => r?.outcome === 'missed')) counts.missed++;
  }
  const gameId = typeof manifest?.game?.id === 'string' ? manifest.game.id : null;
  return {
    api: API_VERSION,
    run: {
      id: manifest?.id || null, name: str(manifest?.name, 80), mode, gen,
      game: { id: gameId, name: (gameId && gameName(gameId)) || null, system: str(manifest?.game?.system, 8) || null },
      createdAt: manifest?.createdAt || null,
      status: status?.state ? { state: str(status.state, 12), reason: str(status.reason, 16) || null, at: num(status.at), by: slots.includes(status.by) ? status.by : null } : null,
      rules: cleanRules, counts,
    },
    players, links, graveyard, encounters, feed,
    lang, generatedAt: now, updatedAt: updatedAt || null,
  };
}

// ---- events ----------------------------------------------------------------------------------------------------

export const EVENT_TYPES = ['run-start', 'run-end', 'catch', 'missed', 'death', 'faint', 'level-up', 'evolve', 'badge', 'party', 'location',
  'battle-start', 'battle-end', 'encounter', 'legendary', 'coffee'];

const brief = (m) => (m ? { slot: m.slot, key: m.key, species: m.species, name: m.name, nickname: m.nickname, level: m.level, shiny: m.shiny, sprites: m.sprites } : null);

/**
 * What happened between two states of the same run (and language): a list of { type, run, at, … } (EVENT_TYPES;
 * `legendary` and `coffee` come from the server). Nothing on the first state (prev null) – a fresh connection
 * isn't news.
 */
export function eventsBetween(prev, next) {
  if (!prev || !next || prev.run?.id !== next.run?.id) return [];
  const out = [];
  const ev = (type, data = {}) => out.push({ type, run: next.run.id, at: next.generatedAt, ...data });

  const ps = prev.run.status?.state || null;
  const ns = next.run.status?.state || null;
  if (ps !== ns) {
    if (ns) ev('run-end', { state: ns, reason: next.run.status.reason, slot: next.run.status.by });
    else ev('run-start', { resumed: true });
  } else if (!prev.players.some((p) => p.updatedAt) && next.players.some((p) => p.updatedAt)) ev('run-start', { resumed: false });

  const prevEnc = new Map(prev.encounters.map((e) => [e.area, e]));
  for (const e of next.encounters) {
    const before = prevEnc.get(e.area);
    for (const [slot, r] of Object.entries(e.results)) {
      if (!r) continue;
      const was = before?.results?.[slot];
      const base = { slot, area: e.area, areaName: e.name, species: r.species, name: r.name, level: r.level, nickname: r.nickname, shiny: r.shiny };
      if (r.outcome === 'caught' && was?.outcome !== 'caught') {
        ev('catch', { ...base, complete: next.players.length > 1 && Object.values(e.results).every((x) => x?.outcome === 'caught') });
      } else if (r.outcome === 'missed' && was?.outcome !== 'missed') ev('missed', base);
    }
    if (e.state === 'dead' && before?.state !== 'dead') {
      const g = next.graveyard.find((x) => x.area === e.area);
      ev('death', { area: e.area, areaName: e.name, slot: g?.by || null, members: Object.values(g?.members || {}).filter(Boolean).map(brief), killer: g?.killer || null });
    }
  }

  for (const p of next.players) {
    const q = prev.players.find((x) => x.slot === p.slot);
    if (!q) continue;
    const slot = p.slot;
    if (Number.isInteger(p.badges) && Number.isInteger(q.badges) && p.badges > q.badges) ev('badge', { slot, badges: p.badges });
    const pl = p.location;
    const ql = q.location;
    if (pl && (pl.id !== ql?.id || pl.gen !== ql?.gen) && (pl.id !== null || pl.name)) {
      ev('location', { slot, from: ql ? { id: ql.id, name: ql.name } : null, to: { id: pl.id, name: pl.name } });
    }
    const nb = pl?.battle;
    const pb = ql?.battle;
    if (nb && (!pb || pb.kind !== nb.kind || pb.species !== nb.species)) {
      const data = { slot, kind: nb.kind, species: nb.species, name: nb.name, level: nb.level, legendary: nb.legendary, location: pl.name, sprites: nb.sprites };
      ev('battle-start', data);
      if (nb.kind === 'wild') ev('encounter', data);
    } else if (pb && !nb) ev('battle-end', { slot, kind: pb.kind, species: pb.species, name: pb.name });

    const before = new Map(q.party.filter((m) => m.key).map((m) => [m.key, m]));
    for (const m of p.party) {
      const b = m.key && before.get(m.key);
      if (!b) continue;
      if (m.species && b.species && m.species !== b.species) ev('evolve', { slot, key: m.key, from: b.species, fromName: b.name, to: m.species, toName: m.name, mon: brief(m) });
      if (m.level && b.level && m.level > b.level && m.level - b.level <= 10) ev('level-up', { slot, key: m.key, from: b.level, to: m.level, mon: brief(m) });
      if (m.fainted && !b.fainted) ev('faint', { slot, key: m.key, mon: brief(m) });
    }
    const keys = (list) => list.map((m) => m.key || `${m.area}:${m.species}`).join(',');
    if (keys(p.party) !== keys(q.party)) ev('party', { slot, size: p.party.length, species: p.party.map((m) => m.species) });
  }
  return out;
}

/** The battle-start events that are wild legendary or mythical encounters – the coffee pop-up's candidates. */
export const legendaryEncounters = (events) => events.filter((e) => e.type === 'battle-start' && e.kind === 'wild' && e.legendary);
