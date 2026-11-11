// SoulLink domain logic on top of the shared run document. Game-agnostic: HeartGold/SoulSilver
// (incl. Definitive HG) use a curated route list with level caps, every other game builds its
// area list on the fly from the catch locations the players report.
import { PROGRESSION, VANILLA_CAPS, areaForMetLocation, levelCapFor, gymCapsFamily, vanillaCapFor, romCapFor, prettyTrainer } from '/shared/routes.mjs';
import { gen4data, speciesName, pokeapi } from './data.mjs';
import { t, currentLang } from './i18n.mjs';
import { ALL_SLOTS, slotsOf, runMode, isNuzlocke, othersOf } from '/shared/slots.mjs';
import { DEFAULT_RULES, RULE_PRESETS, NUZLOCKE_RULES, rulesWithDefaults } from '/shared/rules.mjs';
import { placeName } from '/shared/live/location.mjs';

export { ALL_SLOTS, slotsOf, runMode, isNuzlocke, othersOf, DEFAULT_RULES, RULE_PRESETS, NUZLOCKE_RULES };
// Runs from before 1–4 players were always a pair – the default where no slots/manifest are passed.
const PAIR = ['p1', 'p2'];

/** A player's live data counts as current this long – older means they stopped playing (or closed the app). */
export const LIVE_FRESH_MS = 10 * 60 * 1000;
export const liveFresh = (doc, slot, now = Date.now()) => {
  const at = doc.get(`live:${slot}`, null)?.at;
  return !!at && Math.abs(now - at) < LIVE_FRESH_MS; // abs: the clocks of two computers differ a little
};

let LOC3 = null;
let LOC2 = null;
export async function loadLocationTables() {
  [LOC3, LOC2] = await Promise.all([
    fetch('/shared/data/locations_gen3.json').then((r) => r.json()).catch(() => null),
    fetch('/shared/data/locations_gen2_crystal.json').then((r) => r.json()).catch(() => null),
  ]);
}

// The running game's own place names (shared/live/romloc.mjs – web/views/location.mjs hands them over when the ROM's
// location data has loaded): a catch is named like the place sign names that place (placeName) – the game's own name
// in a randomized game or a ROM hack, and in Gen 5, which has no table of its own.
let ROM_PLACES = null;
export function setRomPlaces(rom) {
  ROM_PLACES = rom && Array.isArray(rom.names) && rom.gen ? rom : null;
}

/** Localized name of a met location for a generation. */
export function locationName(gen, id) {
  if (id === null || id === undefined) return '';
  const lang = currentLang() === 'de' ? 'de' : 'en';
  let table = '';
  if (gen === 4) {
    const g = gen4data();
    table = id >= 2000 ? g?.locationsSpecial?.[String(id)] : g?.locations?.[id];
  } else if (gen === 3) table = LOC3?.map?.[id]?.[lang] || LOC3?.map?.[id]?.en;
  else if (gen === 2) table = LOC2?.map?.[id]?.[lang] || LOC2?.map?.[id]?.en;
  const own = ROM_PLACES?.gen === gen ? ROM_PLACES.names[id] || '' : '';
  return placeName({ romName: own }, { rom: ROM_PLACES, table: table || '', lang: currentLang() }) || `#${id}`;
}

/** Which route list a run uses. */
export function profileOf(manifest) {
  const code = String(manifest?.game?.code || '').toUpperCase();
  if (['IPKE', 'IPGE', 'IPKD', 'IPGD', 'IPKF', 'IPGF', 'IPKS', 'IPGS', 'IPKI', 'IPGI'].includes(code)) {
    return { id: 'hgss', curated: true, vanillaCaps: !manifest?.patch };
  }
  return { id: 'dynamic', curated: false };
}

export function genOfRun(manifest, runData) {
  return runData?.gen || { gb: 1, gbc: 2, gba: 3, nds: 4 }[manifest?.game?.system] || 4;
}

/** 'classic' | 'hardcore' | 'custom' – which preset a set of rules matches (caps `true` count as 'strict'). */
export function presetOf(r) {
  const same = (k, v) => (k === 'levelCaps' && v === 'strict' ? r[k] === 'strict' || r[k] === true : r[k] === v);
  for (const [name, preset] of Object.entries(RULE_PRESETS)) {
    if (Object.entries(preset).every(([k, v]) => same(k, v))) return name;
  }
  return 'custom';
}

/** The run's rules: its doc `rules` over the defaults of its mode (pass the manifest – without it, SoulLink). */
export function rules(doc, manifest) {
  return rulesWithDefaults(doc.get('rules'), runMode(manifest));
}

export function players(doc, manifest) {
  return Object.fromEntries(slotsOf(manifest).map((s) => [s, { name: s.toUpperCase(), ...(manifest?.players?.[s] || {}), ...(doc.get(`player:${s}`) || {}) }]));
}

export const BOSS_NAMES = () => ({
  'rival-1': t('boss.rival1', 'Rival (Cherrygrove)'), falkner: t('boss.falkner', 'Falkner'), bugsy: t('boss.bugsy', 'Bugsy'),
  'rival-2': t('boss.rival2', 'Rival (Azalea)'), whitney: t('boss.whitney', 'Whitney'), morty: t('boss.morty', 'Morty'),
  chuck: t('boss.chuck', 'Chuck'), jasmine: t('boss.jasmine', 'Jasmine'), pryce: t('boss.pryce', 'Pryce'),
  'rival-3': t('boss.rival3', 'Rival (Radio Tower)'), clair: t('boss.clair', 'Clair'), 'rival-4': t('boss.rival4', 'Rival (Victory Road)'),
  will: t('boss.will', 'Will (Elite Four)'), koga: t('boss.koga', 'Koga (Elite Four)'), bruno: t('boss.bruno', 'Bruno (Elite Four)'),
  karen: t('boss.karen', 'Karen (Elite Four)'), lance: t('boss.lance', 'Lance (Champion)'), 'kanto-leaders': t('boss.kanto', 'Kanto Gym Leaders'),
  blue: t('boss.blue', 'Blue'), red: t('boss.red', 'Red'),
});

/** Ordered list of areas (and bosses for curated games). */
export function progression(doc, manifest) {
  const profile = profileOf(manifest);
  const custom = doc.scan('area:');
  let list;
  if (profile.curated) {
    const bossNames = BOSS_NAMES();
    list = PROGRESSION.map((x) => ({
      ...x,
      name: x.kind === 'boss' ? bossNames[x.key] || x.name : (x.special === 'starter' ? t('area.starter', 'Starter') : locationName(4, x.met[0]) || x.name),
      cap: x.kind === 'boss' && profile.vanillaCaps ? VANILLA_CAPS[x.key] ?? x.cap : x.cap,
    }));
  } else {
    list = [{ kind: 'area', key: 'starter', name: t('area.starter', 'Starter'), met: [], special: 'starter' }];
  }
  const dynamic = Object.entries(custom).map(([key, a]) => ({ kind: 'area', key, name: numberedAreaName(key, a) || a.name, met: a.met || [], custom: !a.auto, order: a.order || 0, after: a.after }));
  for (const item of dynamic.sort((a, b) => a.order - b.order)) {
    if (item.after) {
      const idx = list.findIndex((x) => x.key === item.after);
      if (idx >= 0) {
        list.splice(idx + 1, 0, item);
        continue;
      }
    }
    if (!list.some((x) => x.key === item.key)) list.push(item);
  }
  return list;
}

/**
 * A catch filed under its place number ("#45") because the place's name wasn't known then – Black/White and Black 2/
 * White 2 before 2.3.0 (no names at all), or a catch read before the ROM's own names had loaded: its name now, from the
 * ROM's names or the tables. null when the area has a real name or the place is still unknown.
 */
function numberedAreaName(key, a) {
  const m = /^m(\d)-(\d+)$/.exec(key);
  if (!m || !a?.auto || !(a.name === `#${m[2]}` || !a.name)) return null;
  const name = locationName(Number(m[1]), Number(m[2]));
  return name && name !== `#${m[2]}` ? name : null;
}

/**
 * Gives such numbered areas their place name in the run document, so every player sees it – also the partners whose
 * app doesn't know this game's names (it's read from the player's own ROM). Called with each live snapshot.
 */
export function nameNumberedAreas(doc) {
  for (const [k, a] of Object.entries(doc.scan('area:'))) {
    const name = numberedAreaName(k, a);
    if (name) doc.set(`area:${k}`, { ...a, name });
  }
}

/** Area key for a catch location; creates a dynamic area entry when needed. */
export function areaForCatch(doc, manifest, gen, metLocation, { create = true } = {}) {
  if (metLocation === null || metLocation === undefined) return null;
  const profile = profileOf(manifest);
  if (profile.curated) {
    const k = areaForMetLocation(metLocation);
    if (k) return k;
  }
  const key = `m${gen}-${metLocation}`;
  if (create && !doc.get(`area:${key}`)) doc.set(`area:${key}`, { name: locationName(gen, metLocation), met: [metLocation], auto: true, order: Date.now() });
  return key;
}

/**
 * The run area of a place the player is at (the place sign: { gen, id, name }) – the same as a catch there would get:
 * the curated route, else an area that already has this place (by id, else by name), else `m<gen>-<id>`. With
 * `create` a missing area is added under the sign's name. null when the place isn't of this generation.
 */
export function areaForPlace(doc, manifest, gen, here, { create = false } = {}) {
  if (!doc || !manifest || !here || here.gen !== gen || !Number.isInteger(here.id)) return null;
  if (profileOf(manifest).curated) return areaForMetLocation(here.id);
  const name = String(here.name || '').toLowerCase();
  const list = progression(doc, manifest).filter((x) => x.kind === 'area' && !x.special);
  const hit = list.find((x) => (x.met || []).includes(here.id) && x.key.startsWith(`m${gen}-`)) || (name && list.find((x) => String(x.name || '').toLowerCase() === name));
  if (hit) return hit.key;
  const key = `m${gen}-${here.id}`;
  if (create && !doc.get(`area:${key}`)) doc.set(`area:${key}`, { name: here.name || locationName(gen, here.id), met: [here.id], auto: true, order: Date.now() });
  return key;
}

/**
 * Every place of the game a missed encounter can be filed under – for games without a curated route list, where
 * an area only exists once someone caught there. The location tables cover a whole generation, so they are cut
 * to the region of this game (FireRed/LeafGreen = Kanto sections, Diamond/Pearl/Platinum = Sinnoh). Gen 1 has
 * no table: [] (the prompt then asks for a name).
 */
export function locationChoices(manifest, gen) {
  if (profileOf(manifest).curated) return [];
  const code = String(manifest?.game?.code || '').toUpperCase();
  const lang = currentLang() === 'de' ? 'de' : 'en';
  const rows = (map, keep) => Object.entries(map || {}).map(([id, v]) => ({ id: +id, name: v[lang] || v.en, special: /SPECIAL|DYNAMIC|SECRET_BASE|NONE/.test(v.mapsec || v.landmark || '') }))
    .filter((r) => keep(r.id) && !r.special && r.name && !r.name.startsWith('(')); // "(fateful encounter)" & co. aren't places
  if (gen === 3) {
    const frlg = /^BP[RG]/.test(code);
    return rows(LOC3?.map, (id) => (frlg ? id >= 88 && id < 196 : id < 88 || id > 196));
  }
  if (gen === 2) return rows(LOC2?.map, (id) => id > 0); // Johto + Kanto landmarks, the same in Gold/Silver
  if (gen === 4) return (gen4data()?.locations || []).map((name, id) => ({ id, name })).filter((r) => r.id > 0 && r.id < 126 && r.name);
  return [];
}

export function areaName(doc, manifest, key) {
  return progression(doc, manifest).find((x) => x.key === key)?.name || key;
}

export function encounter(doc, area, slot) {
  return doc.get(`enc:${area}:${slot}`, null);
}

/**
 * State of an area's group – the encounters of every player there, linked together. `slots` are the run's
 * slots (or its manifest); without them it is the old p1+p2 pair. `encs` holds each slot's encounter,
 * `a`/`b` are p1/p2 for older call sites. In a solo Nuzlocke the "group" is the one encounter: caught is
 * `linked` (alive), missed is `failed`, dead stays `dead`.
 */
export function pairState(doc, area, slots = PAIR) {
  const list = Array.isArray(slots) ? slots : slotsOf(slots);
  const encs = Object.fromEntries(list.map((s) => [s, encounter(doc, area, s)]));
  const p = doc.get(`pair:${area}`, null);
  const base = { encs, pair: p, a: encs.p1 ?? null, b: encs.p2 ?? null };
  const all = Object.values(encs);
  if (p?.state === 'dead') return { state: 'dead', ...base };
  if (all.some((e) => e?.outcome === 'missed')) return { state: 'failed', ...base };
  if (all.every((e) => e?.outcome === 'caught')) return { state: 'linked', ...base };
  if (all.some(Boolean)) return { state: 'waiting', ...base };
  return { state: 'empty', ...base };
}

export function feed(doc, entry) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  doc.set(`feed:${id}`, { at: Date.now(), ...entry });
}

// Feed messages travel to the partner, who may use another language. So an entry keeps the message key with
// raw values – {area}, {species} or a nested message – and every player renders it locally. `text` holds the
// sender's rendering as a fallback for older entries.
/** "A, B & C" */
export const joinNames = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} & ${list.at(-1)}` : list[0] || '');
export const msg = (key, def, vars = {}) => ({ key, def, vars });

function renderMsg(doc, manifest, m) {
  const vars = {};
  for (const [k, v] of Object.entries(m.vars || {})) {
    vars[k] = v && typeof v === 'object'
      ? v.area !== undefined ? areaName(doc, manifest, v.area) : v.species !== undefined ? speciesName(v.species) : v.key ? renderMsg(doc, manifest, v) : ''
      : v;
  }
  return t(m.key, m.def, vars);
}

export const causeText = (doc, manifest, cause) => (cause && typeof cause === 'object' ? renderMsg(doc, manifest, cause) : cause || '');

export function feedText(doc, manifest, f) {
  if (!f?.msg) return f?.text || '';
  const cause = causeText(doc, manifest, f.cause);
  return renderMsg(doc, manifest, f.msg) + (cause ? ` – ${cause}` : '') + (f.note ? ` – ${f.note}` : '');
}

function feedMsg(doc, manifest, entry) {
  feed(doc, { ...entry, text: feedText(doc, manifest, entry) });
}

export function feedList(doc, limit = 80) {
  return Object.entries(doc.scan('feed:')).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.at - a.at).slice(0, limit);
}

export function setEncounter(doc, manifest, area, slot, data, { quiet, by } = {}) {
  const prev = encounter(doc, area, slot);
  doc.set(`enc:${area}:${slot}`, data ? { ...prev, ...data, at: prev?.at || Date.now() } : null);
  // Edits by hand leave a trace in the log – otherwise a removed or swapped catch can't be told apart from a
  // tracking error later (both look like "the area holds something else now").
  if (!quiet && prev && (!data || (data.species && prev.species && data.species !== prev.species))) {
    const who = by ? players(doc, manifest)[by]?.name || '' : '';
    feedMsg(doc, manifest, !data
      ? { type: 'edit', slot, editor: by, area, msg: msg('feed.encDeleted', '{area}: {old} removed by hand ({who})', { area: { area }, old: { species: prev.species }, who }) }
      : { type: 'edit', slot, editor: by, area, msg: msg('feed.encReplaced', '{area}: {old} replaced by {new} by hand ({who})', { area: { area }, old: { species: prev.species }, new: { species: data.species }, who }) });
  }
  if (!quiet && data && !prev) {
    feedMsg(doc, manifest, data.outcome === 'missed'
      ? { type: 'missed', slot, area, msg: msg('feed.missed', '{area}: encounter missed', { area: { area } }) }
      : { type: 'catch', slot, area, species: data.species, msg: msg('feed.caught', '{area}: caught {name}', { area: { area }, name: { species: data.species } }) });
  }
}

/**
 * The group of `area` dies (every player's mon there). Optional: `level` at death, `killer` {species, level, kind}
 * (the opponent of the battle it fell in). The boss segment it died in is kept for the stats. In a deathless
 * Nuzlocke the first death ends the run.
 */
export function markDead(doc, manifest, area, { slot, cause = '', level = null, killer = null } = {}) {
  const p = doc.get(`pair:${area}`) || {};
  if (p.state === 'dead') return false;
  const segment = levelCap(doc, manifest, slot || 'p1').boss?.key ?? null;
  doc.set(`pair:${area}`, { ...p, state: 'dead', diedAt: Date.now(), cause, by: slot, level, killer, segment });
  const n = slotsOf(manifest).length;
  const text = n === 1 ? msg('feed.deathSolo', '{area}: the Pokémon died', { area: { area } })
    : n > 2 ? msg('feed.deathGroup', '{area}: the linked group died', { area: { area } })
      : msg('feed.death', '{area}: the pair died', { area: { area } });
  feedMsg(doc, manifest, { type: 'death', slot, area, msg: text, cause: cause || null });
  if (runMode(manifest) === 'nuzlocke' && rules(doc, manifest).deathless) failRun(doc, manifest, slot || 'p1', 'deathless', { area });
  return true;
}

/**
 * `slot` used a cheat (today: `added` Rare Candies). Everyone in the run sees it in the log – that is the deal for
 * allowing cheats at all. Refused (false) while the run's rules don't allow cheats.
 */
export function logCheat(doc, manifest, slot, { added }) {
  if (!rules(doc, manifest).cheats) return false;
  const what = msg('cheat.rareCandies', '{n} Rare Candy|{n} Rare Candies', { n: added, count: added });
  feedMsg(doc, manifest, { type: 'cheat', slot, cheat: 'rareCandy', count: added, msg: slotsOf(manifest).length === 1
    ? msg('feed.cheatSolo', 'Cheat used: {what}', { what })
    : msg('feed.cheat', 'used a cheat: {what}', { what }) });
  return true;
}

/** The run's cheat rule was switched (`by` = slot) – logged like the cheats themselves. */
export function logCheatRule(doc, manifest, by, allowed) {
  const solo = slotsOf(manifest).length === 1;
  feedMsg(doc, manifest, { type: 'cheat', slot: by, msg: allowed
    ? solo ? msg('feed.cheatsOnSolo', 'Cheats allowed for this run') : msg('feed.cheatsOn', 'allowed cheats for this run')
    : solo ? msg('feed.cheatsOffSolo', 'Cheats turned off for this run') : msg('feed.cheatsOff', 'turned cheats off for this run') });
}

/** The run's host: the player who created it (P1 – the one who sends the invite). */
export const HOST_SLOT = 'p1';
export const isHost = (me) => (me || HOST_SLOT) === HOST_SLOT;

/** Is the type matchup help shown in this run? On unless the host switched it off (older runs: on). */
export const typeHelpOn = (doc, manifest) => !doc || rules(doc, manifest).typeHelp !== false;

/**
 * Only the host may switch the type matchup help. Returns the rules patch a player may apply: a non-host's
 * `typeHelp` is dropped (their app doesn't offer the switch either).
 */
export function allowedRulesPatch(patch, me) {
  if (!patch || isHost(me) || !('typeHelp' in patch)) return patch;
  const { typeHelp, ...rest } = patch; // eslint-disable-line no-unused-vars
  return rest;
}

/** Switching the type matchup help is logged for everyone, like the cheats rule. */
export function logTypeHelpRule(doc, manifest, by, on) {
  const solo = slotsOf(manifest).length === 1;
  feedMsg(doc, manifest, { type: 'rule', slot: by, msg: on
    ? solo ? msg('feed.typeHelpOnSolo', 'Type matchup help turned on for this run') : msg('feed.typeHelpOn', 'turned the type matchup help on for everyone')
    : solo ? msg('feed.typeHelpOffSolo', 'Type matchup help turned off for this run') : msg('feed.typeHelpOff', 'turned the type matchup help off for everyone') });
}

/** `slot` let the area's encounter get away (fled, knocked out, ball missed): the area is spent. */
export function markMissed(doc, manifest, area, slot, { species = null, by } = {}) {
  if (encounter(doc, area, slot)) return false;
  setEncounter(doc, manifest, area, slot, { outcome: 'missed', species, ...(by ? { by } : {}) }, { quiet: true });
  feedMsg(doc, manifest, { type: 'missed', slot, area, ...(species ? { species } : {}), msg: species
    ? msg('feed.missedSpecies', '{area}: {name} got away – the area is spent', { area: { area }, name: { species } })
    : msg('feed.missed', '{area}: encounter missed', { area: { area } }) });
  return true;
}

/** Areas (progression entries) where `slot` has no encounter yet. */
export function openAreas(doc, manifest, slot = 'p1') {
  return progression(doc, manifest).filter((a) => a.kind === 'area' && !encounter(doc, a.key, slot));
}

/**
 * Nuzlocke: ask whether the wild battle that just ended spent an area? Not when a new Pokémon turned up since it
 * began (`newMonAt` ≥ `from`), when it was a trainer battle at any point (`wild` false – Gen 4 tells them apart by a
 * heuristic that can flicker), for a shiny (clause) or a dupe, when the run is over, when a curated route list has
 * no open area left, or when a catch could have gone unseen: a full party sends it to the PC, and the PC is only
 * read live in some games (`boxes` false).
 * o: { foe: {species, shiny}, wild, from, newMonAt, boxes, partySize }
 */
export function missedQuestion(doc, manifest, rd, slot, { foe, wild, from = 0, newMonAt = 0, boxes = true, partySize = 0 } = {}) {
  if (runMode(manifest) !== 'nuzlocke' || doc.get('run:status', null) || !wild || !foe?.species) return false;
  if (newMonAt >= from || (!boxes && partySize >= 6)) return false;
  if (foe.shiny && rules(doc, manifest).shinyClause) return false;
  if (dupeOf(doc, manifest, rd, foe.species, slot)) return false;
  return !profileOf(manifest).curated || openAreas(doc, manifest, slot).some((a) => a.key !== 'starter');
}

/**
 * A solo blackout per the `blackout` rule. 'party': every Pokémon in the party (eggs aside) is at 0 HP on a live
 * read – no marked death needed. 'box': nothing caught is alive anymore, in the party or the boxes (after at
 * least one catch). Like wipedSlot, a blackout the player waved off (`run:resumed`) counts again only once it
 * happens anew.
 */
export function blackout(doc, manifest, slot = 'p1') {
  const mode = rules(doc, manifest).blackout;
  const resumed = doc.get('run:resumed', 0) || 0;
  if (mode === 'party') {
    const l = live(doc, slot);
    const mons = (l?.party || []).filter((m) => !m.egg);
    if (l?.source !== 'live' || !mons.length || !mons.every((m) => m.maxHp > 0 && m.hp === 0)) return false;
    return (l.downAt ?? l.at ?? 0) > resumed;
  }
  if (mode === 'box') {
    let caught = 0;
    let alive = 0;
    let last = 0;
    for (const a of progression(doc, manifest)) {
      const e = a.kind === 'area' && encounter(doc, a.key, slot);
      if (e?.outcome !== 'caught') continue;
      caught++;
      const p = doc.get(`pair:${a.key}`, null);
      if (p?.state === 'dead') last = Math.max(last, p.diedAt || 0);
      else alive++;
    }
    alive += Object.values(doc.scan(`extra:${slot}:`)).filter((x) => x && !x.dead).length;
    return caught > 0 && alive === 0 && last > resumed;
  }
  return false;
}

/**
 * A player's team is wiped: every Pokémon in their party is out – its group dead or fainted (eggs don't fight) –
 * and at least one group died. That ends the run, for every mode and any one player. Returns the wiped slot or
 * null. `slots`: whose teams to look at (or the run's manifest); slots without live data are skipped. A wipe the
 * players already waved off ("continue anyway", `run:resumed`) counts again only after a newer death.
 * With the manifest (2nd or 3rd argument) a Nuzlocke follows its blackout rule instead.
 */
export function wipedSlot(doc, slots = ALL_SLOTS, manifest = Array.isArray(slots) ? null : slots) {
  // A Nuzlocke ends by its own blackout rule (applySnapshot fails it right away).
  if (manifest && runMode(manifest) === 'nuzlocke') return blackout(doc, manifest, 'p1') ? 'p1' : null;
  const resumed = doc.get('run:resumed', 0) || 0;
  for (const slot of Array.isArray(slots) ? slots : slotsOf(slots)) {
    const p = live(doc, slot)?.party || [];
    const dead = (m) => m.area && pairState(doc, m.area).state === 'dead';
    if (!p.length || !p.every((m) => m.egg || dead(m) || (m.maxHp > 0 && m.hp === 0))) continue;
    const last = Math.max(0, ...p.filter(dead).map((m) => doc.get(`pair:${m.area}`)?.diedAt || 0));
    if (last && last > resumed) return slot;
  }
  return null;
}

/**
 * End the run as failed (once – an existing status wins). `reason`: 'wipe' (a team was wiped), 'blackout'
 * or 'deathless' (Nuzlocke rules); it is kept in `run:status.reason`. `area`: the death that ended a deathless
 * run; a blackout keeps which rule it went by (`rule`) – revive() reopens a run whose cause it undoes.
 */
export function failRun(doc, manifest, slot, reason = 'wipe', { area = null } = {}) {
  if (doc.get('run:status')) return false;
  const rule = reason === 'blackout' && runMode(manifest) === 'nuzlocke' ? rules(doc, manifest).blackout : null;
  doc.set('run:status', { state: 'failed', at: Date.now(), by: slot, auto: true, note: null, reason, ...(area ? { area } : {}), ...(rule ? { rule } : {}) });
  const name = players(doc, manifest)[slot]?.name || slot.toUpperCase();
  const solo = runMode(manifest) === 'nuzlocke';
  feedMsg(doc, manifest, { type: 'run', slot, msg: reason === 'deathless'
    ? msg('feed.runDeathless', '{name} lost a Pokémon in a deathless run – the Nuzlocke has failed', { name })
    : reason === 'blackout' ? msg('feed.runBlackout', '{name} blacked out – the Nuzlocke has failed', { name })
      : solo ? msg('feed.runWipedSolo', '{name}’s team was wiped – the Nuzlocke has failed', { name })
        : msg('feed.runWiped', '{name}’s team was wiped – the run has failed', { name }) });
  return true;
}

/** Reopen an ended run. */
export function resumeRun(doc, slot) {
  doc.batch({ 'run:status': null, 'run:resumed': Date.now() });
  feed(doc, { type: 'run', slot, msg: msg('feed.runResumed', 'reopened the run'), text: t('feed.runResumed', 'reopened the run') });
}

/**
 * Undo a death. When that death is what ended the run – the first death of a deathless Nuzlocke, or the last one
 * of a "box" blackout (nothing alive was left; now something is) – the run goes on, too. A wipe or a "party"
 * blackout went by the team's HP, not by the death mark: those stay ended ("play on" is still there).
 */
export function revive(doc, area) {
  const p = doc.get(`pair:${area}`) || {};
  doc.set(`pair:${area}`, { ...p, state: 'alive', diedAt: null, cause: '' });
  const st = doc.get('run:status', null);
  if (st?.state === 'failed' && st.auto && ((st.reason === 'deathless' && st.area === area) || (st.reason === 'blackout' && st.rule === 'box'))) {
    doc.set('run:status', null);
    feed(doc, { type: 'run', slot: st.by, msg: msg('feed.runResumed', 'reopened the run'), text: t('feed.runResumed', 'reopened the run') });
  }
}

export const party = (doc, slot) => doc.get(`party:${slot}`, []);
export const live = (doc, slot) => doc.get(`live:${slot}`, null);

export function counts(doc, manifest) {
  const c = { linked: 0, dead: 0, failed: 0, waiting: 0 };
  const slots = slotsOf(manifest);
  for (const a of progression(doc, manifest)) {
    if (a.kind !== 'area') continue;
    const s = pairState(doc, a.key, slots).state;
    if (c[s] !== undefined) c[s]++;
  }
  return c;
}

export function levelCap(doc, manifest, slot) {
  const profile = profileOf(manifest);
  if (!profile.curated) {
    const l = live(doc, slot);
    const bossName = (b) => (b.badge !== undefined ? (b.leader ? t('cap.gymLeader', '{name} (gym {n})', { name: prettyTrainer(b.leader), n: b.badge + 1 }) : t('cap.gym', 'Gym {n}', { n: b.badge + 1 }))
      : { champion: t('cap.champion', 'Champion'), 'elite four': t('cap.eliteFour', 'Elite Four') }[b.key] || b.name);
    // Gen 1/2 and 5: the curated gym aces by live badge count – not for a ROM hack, whose trainers have other levels
    if (!manifest?.game?.hackId && !manifest?.patch) {
      const v = vanillaCapFor(gymCapsFamily(manifest?.game?.id || manifest?.base?.gameId), l?.badges);
      if (v) return { cap: v.cap, boss: { ...v.boss, name: bossName(v.boss) }, vanilla: true };
    }
    // any other game: the caps read from its own trainers (shared/live/romcaps.mjs – the play view files them), with
    // badges read from the game itself; nothing (no cap shown) when either is unknown
    const r = romCapFor(doc.get(`romcaps:${slot}`, null), l?.badgesRead ? l.badges : undefined);
    return r ? { cap: r.cap, boss: { ...r.boss, name: bossName(r.boss) }, rom: true } : { cap: null, boss: null };
  }
  const badges = live(doc, slot)?.badges ?? 0;
  const r = levelCapFor(badges, doc.scan('boss:'), profile.vanillaCaps);
  return { cap: r.cap, boss: r.boss ? { ...r.boss, name: BOSS_NAMES()[r.boss.key] || r.boss.name } : null };
}

// ---------------------------------------------------------------------------
// Rule checks

/**
 * Type rule across the group (typeClause 'global') while fighting a wild Pokémon: a partner's Pokémon of the same place
 * has its primary type – caught there already, or the one they are fighting there right now (the "where:<slot>" every
 * player's game writes). You may not both catch it: the type would be in the team twice.
 * → { slot, species, type, now } (now: their current battle) or null.
 */
export function pairTypeClash(doc, manifest, rd, me, species, at = Date.now()) {
  if (!rd || !species || !me || isNuzlocke(manifest) || rules(doc, manifest).typeClause !== 'global') return null;
  const type = rd.types(species, me)[0];
  const here = doc.get(`where:${me}`, null);
  if (!type || !here) return null;
  const area = areaForCatch(doc, manifest, here.gen, here.id, { create: false });
  for (const s of othersOf(me, manifest)) {
    const e = area ? encounter(doc, area, s) : null;
    if (e?.outcome === 'caught' && e.species && rd.types(e.species, s)[0] === type) return { slot: s, species: e.species, type, now: false };
    const w = doc.get(`where:${s}`, null);
    const f = w?.fight;
    if (f?.kind === 'wild' && f.species && w.gen === here.gen && w.id === here.id && liveFresh(doc, s, at) && rd.types(f.species, s)[0] === type) return { slot: s, species: f.species, type, now: true };
  }
  return null;
}

export function checks(doc, manifest, rd) {
  const r = rules(doc, manifest);
  const out = [];
  const pn = players(doc, manifest);
  const slots = slotsOf(manifest);
  const solo = runMode(manifest) === 'nuzlocke';
  const parties = Object.fromEntries(slots.map((s) => [s, party(doc, s)]));
  const an = (k) => areaName(doc, manifest, k);
  const stateOf = (area) => pairState(doc, area, slots).state;

  // one line per dead area, naming everyone who still carries it – four lines for one group would be noise
  const deadHolders = new Map();
  const failedHolders = new Map();
  for (const slot of slots) {
    for (const area of parties[slot]) {
      const s = stateOf(area);
      if (s === 'dead') deadHolders.set(area, [...(deadHolders.get(area) || []), slot]);
      // "A missed encounter costs the whole pair" switched off: the partner's catch stays usable.
      if (s === 'failed' && r.failKillsPair !== false) failedHolders.set(area, [...(failedHolders.get(area) || []), slot]);
    }
  }
  for (const [area, holders] of failedHolders) {
    out.push({ level: 'error', area, text: solo
      ? t('check.failedInParty', '{area}: missed encounter – this Pokémon may not be used.', { area: an(area) })
      : t('check.failedInPartyNamed', '{area}: missed encounter – the Pokémon from here may not be used (team of {names}).', { area: an(area), names: joinNames(holders.map((x) => pn[x].name)) }) });
  }
  for (const [area, holders] of deadHolders) {
    const names = holders.map((x) => pn[x].name);
    out.push({ level: 'error', area, text: solo
      ? t('check.deadInPartySolo', '{area}: a dead Pokémon is still in the team.', { area: an(area) })
      : slots.length === 2
        ? t('check.deadInParty', '{area}: a dead pair is still in {name}’s team.', { area: an(area), name: names.join(' & ') })
        : t('check.deadInPartyGroup', '{area}: the dead group is still in the team of {names}.', { area: an(area), names: joinNames(names) }) });
  }
  // The whole group belongs in the team. Only players who are playing right now count: an old party of
  // someone who stopped hours ago says nothing about the team they will start with.
  if (!solo) {
    const fresh = slots.filter((s) => liveFresh(doc, s));
    const areas = [...new Set(slots.flatMap((s) => parties[s]))];
    for (const area of areas) {
      if (stateOf(area) !== 'linked') continue;
      const holders = slots.filter((s) => parties[s].includes(area));
      const missing = fresh.filter((s) => !holders.includes(s));
      if (!missing.length) continue;
      out.push({ level: 'warn', area, text: slots.length === 2
        ? t('check.partnerMissing', '{area}: only in {name}’s team – the partner belongs in the team too.', { area: an(area), name: pn[holders[0]].name })
        : t('check.groupMissing', '{area}: not in the team of {names} yet – the whole group belongs in the team.', { area: an(area), names: missing.map((s) => pn[s].name).join(', ') }) });
    }
  }
  if (r.typeClause !== 'off' && rd?.types) { // run data still loading → no type info yet (instead of a crash)
    const groups = r.typeClause === 'global' ? [slots] : slots.map((s) => [s]);
    const pairClash = new Set();
    for (const group of groups) {
      const seen = new Map();
      for (const slot of group) {
        for (const area of parties[slot]) {
          if (!['linked', 'waiting'].includes(stateOf(area))) continue;
          const e = encounter(doc, area, slot);
          if (!e?.species) continue;
          const type = rd.types(e.species, slot)[0];
          if (!type) continue;
          const prev = seen.get(type);
          // the group of one area too: two partners with the same primary type would have it in the team twice
          if (prev && prev.area === area) {
            if (!pairClash.has(area)) out.push({ level: 'warn', area, text: t('check.typePair', '{area}: {a} and {b} share the primary type – only one of you may have it in the team.', { area: an(area), a: speciesName(prev.species), b: speciesName(e.species) }) });
            pairClash.add(area);
          } else if (prev) out.push({ level: 'warn', area, text: t('check.type', 'Type rule: {a} and {b} share the primary type.', { a: speciesName(e.species), b: speciesName(prev.species) }) });
          else seen.set(type, { area, species: e.species });
        }
      }
    }
  }
  // Hardcore: a strict cap is a rule break, not a hint
  const capLevel = r.levelCaps === 'strict' ? 'error' : 'warn';
  if (r.levelCaps) {
    for (const slot of slots) {
      const l = live(doc, slot);
      const { cap } = levelCap(doc, manifest, slot);
      if (!l || !cap) continue;
      for (const m of l.party || []) {
        if (m.level <= cap) continue;
        const name = m.nick || speciesName(m.species);
        out.push({ level: capLevel, area: m.area, slot, text: solo
          ? t('check.cap', 'Level cap {cap} exceeded: {name} is level {lv}.', { cap, name, lv: m.level })
          : t('check.capOf', 'Level cap {cap} exceeded: {player}’s {name} is level {lv}.', { cap, name, lv: m.level, player: pn[slot].name }) });
      }
    }
  }
  if (solo) out.push(...nuzlockeChecks(doc, manifest, r, capLevel));
  return out;
}

/** Is `nick` just the species' own name (in any language the data knows)? null when that can't be told. */
export function isDefaultName(species, nick) {
  const names = pokeapi()?.names;
  if (!names || !nick || !species) return null;
  const norm = (x) => String(x).normalize('NFC').toUpperCase().replace(/\s+/g, '');
  return Object.values(names).some((byId) => byId?.[species] && norm(byId[species]) === norm(nick));
}

/** Nuzlocke-only rule checks for p1: catches on a spent area, badges won over the cap, missing nicknames. */
function nuzlockeChecks(doc, manifest, r, capLevel) {
  const out = [];
  const slot = 'p1';
  const gen = genOfRun(manifest);
  const an = (k) => areaName(doc, manifest, k);
  const extras = doc.scan(`extra:${slot}:`);
  const ignored = doc.scan(`ign:${slot}:`);
  for (const m of live(doc, slot)?.party || []) {
    const name = m.nick || speciesName(m.species);
    // An untracked team member met on an area that already has its encounter: a second catch there. Shinies
    // (clause on), hatched eggs, trades/gifts (special places) and bonus/ignored mons are fine.
    if (!m.area && !m.egg && m.met != null && !extras[m.key] && !ignored[m.key] && !(m.shiny && r.shinyClause)
      && m.metLevel !== 0 && !(gen >= 4 && m.met >= 2000)) {
      const area = areaForCatch(doc, manifest, gen, m.met, { create: false });
      const e = area && encounter(doc, area, slot);
      if (e && e.key !== m.key) out.push({ level: 'warn', area, text: t('check.spentArea', '{area}: {name} is a second catch there – the area was already used.', { area: an(area), name }) });
    }
    if (r.nicknames && m.area && isDefaultName(m.species, m.nick)) {
      out.push({ level: 'info', area: m.area, text: t('check.nickname', '{name} has no nickname yet.', { name }) });
    }
  }
  if (r.levelCaps) {
    for (const b of Object.values(doc.scan(`capbreak:${slot}:`))) {
      if (!b) continue;
      out.push({ level: capLevel, area: b.area || null, text: t('check.badgeOverCap', 'Badge {n} was won with {name} at level {lv} – over the cap of {cap}.', { n: b.badge, name: b.nick || speciesName(b.species), lv: b.level, cap: b.cap }) });
    }
  }
  return out;
}

/** Does `other` (caught by `s`) count as a dupe of `species`? 'species' compares species, else the evolution line. */
function sameDupe(r, rd, species, slot, other, s) {
  if (r.dupes === 'species') return other === species;
  return !!rd?.familyRoot && rd.familyRoot(other, s) === rd.familyRoot(species, slot);
}

export function dupeOf(doc, manifest, rd, species, slot, exceptArea) {
  const r = rules(doc, manifest);
  if (r.dupes === 'off' || !species) return null;
  const slots = r.dupes === 'both' ? slotsOf(manifest) : [slot];
  for (const a of progression(doc, manifest)) {
    if (a.kind !== 'area' || a.key === exceptArea) continue;
    for (const s of slots) {
      const e = encounter(doc, a.key, s);
      if (e?.outcome === 'caught' && e.species && sameDupe(r, rd, species, slot, e.species, s)) return { area: a.key, slot: s };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Snapshots (live RAM or save file) → document

/**
 * doc → Map(slot → { battle, at }): the last battle with a known opponent. The blow that ends a battle (a blackout,
 * Explosion, the last opponent down by recoil) can end it before the next live read sees the 0 HP – a death then
 * still belongs to that battle for a moment.
 */
const lastBattle = new WeakMap();
export const BATTLE_GRACE = 5000;
/** How long after a wild battle a Pokémon joining the team counts as caught in it (catch, nickname, Pokédex screens). */
export const WILD_CATCH_WINDOW = 60000;

/** doc → Map(`${slot}:${key}` → when a tracked mon was first missing from a live snapshot). */
const missingSince = new WeakMap();
const MISSING_GRACE = 15000;

/** dupeOf, plus the catches entered earlier in the same snapshot pass (not in the doc yet). */
function dupeInPass(doc, manifest, rd, species, slot, exceptArea, writes) {
  const r = rules(doc, manifest);
  if (r.dupes === 'off' || !species || (r.dupes !== 'species' && !rd?.familyRoot)) return null;
  const found = dupeOf(doc, manifest, rd, species, slot, exceptArea);
  if (found) return found;
  for (const [k, e] of Object.entries(writes)) {
    const m = /^enc:(.+):(p[1-4])$/.exec(k);
    if (!m || m[1] === exceptArea || (r.dupes !== 'both' && m[2] !== slot)) continue;
    if (e?.outcome === 'caught' && e.species && sameDupe(r, rd, species, slot, e.species, m[2])) return { area: m[1], slot: m[2] };
  }
  return null;
}

function liveMon(m, area) {
  return {
    key: m.key, area, species: m.species, nick: m.nickname, level: m.level, hp: m.hp, maxHp: m.maxHp, item: m.item ?? m.heldItem,
    status: m.status, shiny: m.shiny, gender: m.gender, moves: m.moves, ...(m.isEgg ? { egg: true } : {}),
    // an expanded engine's own item numbers: no retail name for them – the game's own name where the ROM gave it
    ...(m.itemOwn ? { itemOwn: true, ...(m.itemName ? { itemName: String(m.itemName).slice(0, 24) } : {}) } : {}),
    // where an untracked mon was met – the Nuzlocke checks tell a second catch on a spent area by it
    ...(!area && m.metLocation != null ? { met: m.metLocation, metLevel: m.metLevel ?? null } : {}),
  };
}

/** doc → Map(`${slot}:${key}` → a level jump seen once, waiting for the next snapshot to confirm it). */
const levelJumps = new WeakMap();
const LEVEL_JUMP = 5;
/** A live snapshot this recent outranks a save file (live:<slot> is rewritten at least every 30 s while it runs). */
const LIVE_FRESH = 90000;
export const validLevel = (l) => (Number.isInteger(l) && l >= 1 && l <= 100 ? l : null);

/**
 * Levels from live data that can't be right are not stored or synced: outside 1–100 the last known level stays
 * (null if there is none), and a jump of more than LEVEL_JUMP levels at once counts only when the next snapshot
 * says the same (a loaded savestate, many Rare Candies) – a one-off garbage read never reaches the partners.
 */
function trustLevels(doc, slot, party, known, source) {
  if (source === 'save') return party.map((m) => ({ ...m, level: validLevel(m.level) }));
  const prev = new Map((live(doc, slot)?.party || []).map((m) => [m.key, m.level]));
  const jumps = levelJumps.get(doc) || new Map();
  levelJumps.set(doc, jumps);
  return party.map((m) => {
    const before = validLevel(prev.get(m.key)) ?? validLevel(known.get(m.key)?.enc?.level);
    const lv = validLevel(m.level);
    const id = `${slot}:${m.key}`;
    if (lv === null) return { ...m, level: before };
    if (before === null || Math.abs(lv - before) <= LEVEL_JUMP || jumps.get(id) === lv) {
      jumps.delete(id);
      return lv === m.level ? m : { ...m, level: lv };
    }
    jumps.set(id, lv);
    return { ...m, level: before };
  });
}

/** Every Pokémon of a live party (eggs aside) is down. */
const partyDown = (party) => party.some((m) => !m.egg) && party.every((m) => m.egg || (m.maxHp > 0 && m.hp === 0));

/**
 * Apply a snapshot of `slot`'s game: { party: [mon], boxes: [mon]|null, badges, trainer, playTime, source }.
 * Mons are normalized: { key, species, nickname, level, hp, maxHp, status, shiny, gender, metLocation, metLevel, isEgg, inParty }.
 * `battle` (optional, the live battle right now): { kind: 'wild'|'trainer', enemy: { species, level } } – a mon
 * that falls in it gets that opponent as its death cause.
 * Returns { inbox, alerts, newCatches, deaths, failed } for the UI. `failed`: 'blackout' | 'deathless' when this
 * snapshot ended a Nuzlocke (SoulLinks end through wipedSlot/failRun as before).
 */
export function applySnapshot(doc, manifest, gen, slot, snap, { auto = true, rd = null, battle = null } = {}) {
  // The party is never empty once the game has started – an empty live party is the title screen, a reset or a
  // save being loaded. Applying it would wipe the team (the partner sees warnings), drop the badges to 0 and then
  // announce every badge as "newly earned" once the game is loaded again.
  if (snap.source !== 'save' && !(snap.party || []).length && !(snap.boxes || []).length) {
    return { inbox: [], alerts: [], newCatches: [], deaths: [], failed: null };
  }
  // While the game's RAM is read live, the save file is the older picture: it holds the party of the last in-game
  // save (or of the save a loaded savestate brought along). Applying it put old levels, HP and states back for a
  // moment – the team flickered to "Lv 12" and back to 14, and the partners saw it too. Live data has it all.
  const was = live(doc, slot);
  if (snap.source === 'save' && was?.source === 'live' && Date.now() - (was.at || 0) < LIVE_FRESH) {
    return { inbox: [], alerts: [], newCatches: [], deaths: [], failed: null };
  }
  if (snap.source === 'live' && !profileOf(manifest).curated) nameNumberedAreas(doc);
  const r = rules(doc, manifest);
  const solo = runMode(manifest) === 'nuzlocke';
  const statusBefore = doc.get('run:status', null);
  const prog = progression(doc, manifest);
  const known = new Map();
  for (const a of prog) {
    const e = encounter(doc, a.key, slot);
    if (e?.key) known.set(e.key, { area: a.key, enc: e });
  }
  const ignored = doc.scan(`ign:${slot}:`);
  const extras = doc.scan(`extra:${slot}:`);
  const inbox = [];
  const alerts = [];
  const newCatches = [];
  const deaths = [];
  const writes = {};
  const party = trustLevels(doc, slot, (snap.party || []).map((m) => ({ ...m, inParty: true })), known, snap.source);
  const all = [...party, ...(snap.boxes || [])];
  const seen = new Set();
  let starterOffered = false;
  const battles = lastBattle.get(doc) || new Map();
  lastBattle.set(doc, battles);
  if (snap.source === 'live' && battle?.enemy?.species) battles.set(slot, { battle, at: Date.now() });
  const recent = battles.get(slot);
  const fight = battle || (snap.source === 'live' && recent && Date.now() - recent.at < BATTLE_GRACE ? recent.battle : null);

  for (const m of all) {
    if (m.isEgg || !m.species) continue;
    // Live PC data is cached for a moment, so a mon just withdrawn shows up in the party *and* the box: the
    // party copy (first) is the one that counts – the second would land in the inbox a second time.
    if (seen.has(m.key)) continue;
    seen.add(m.key);
    const k = known.get(m.key);
    if (k) {
      const patch = {};
      if (k.enc.species !== m.species) {
        patch.species = m.species;
        feedMsg(doc, manifest, { type: 'evolve', slot, area: k.area, msg: msg('feed.evolved', '{from} evolved into {to}', { from: { species: k.enc.species }, to: { species: m.species } }) });
      }
      if (m.level && m.level !== k.enc.level) patch.level = m.level;
      if (m.nickname && m.nickname !== k.enc.nickname) patch.nickname = m.nickname;
      if (Object.keys(patch).length) writes[`enc:${k.area}:${slot}`] = { ...k.enc, ...patch };
      if (m.inParty && m.hp === 0 && m.maxHp > 0 && pairState(doc, k.area).state !== 'dead') {
        if (auto && r.autoDeath && snap.source === 'live') {
          const name = m.nickname || { species: m.species };
          const foe = fight?.enemy?.species ? fight.enemy : null;
          const kind = fight?.kind === 'trainer' ? msg('cause.trainer', 'trainer battle') : msg('cause.wild', 'wild battle');
          const cause = foe
            ? msg('feed.faintedBy', '{name} fainted against {enemy} (Lv. {lv}, {kind})', { name, enemy: { species: foe.species }, lv: foe.level ?? '?', kind })
            : msg('feed.faintedCause', '{name} fainted', { name });
          const killer = foe ? { species: foe.species, level: foe.level ?? null, kind: fight.kind || null } : null;
          if (markDead(doc, manifest, k.area, { slot, cause, level: m.level ?? null, killer })) deaths.push(k.area);
        } else alerts.push({ type: 'fainted', area: k.area, mon: m });
      }
      continue;
    }
    if (ignored[m.key] || extras[m.key]) continue;
    // Gen 4 writes a caught Pokémon into the party first and its met data (place, level) a moment later –
    // a live read in between saw met location 0 ("Mystery Zone") and filed the catch there, pairing it with
    // the partner's next such read. Every Gen 4 Pokémon has a met location, so wait for the next pass.
    if (gen === 4 && snap.source !== 'save' && !m.metLocation) continue;
    // Count encounters written earlier in this same pass, too.
    const has = (area) => encounter(doc, area, slot) || writes[`enc:${area}:${slot}`];
    let guess = null;
    const anyEnc = prog.some((a) => has(a.key)) || Object.keys(writes).some((k) => k.startsWith('enc:') && k.endsWith(`:${slot}`));
    // Only the first new mon of a pass can be the starter – otherwise, when that one isn't entered (a shiny
    // starter goes to the inbox), the next one (a Route 29 catch) would be filed as the starter.
    if (!starterOffered && !has('starter') && !anyEnc) guess = 'starter';
    starterOffered = true;
    // A hatched egg (met level 0) carries the place it hatched, an in-game trade or event a special location
    // (Gen 4/5: 2000+) – neither is an encounter of that route, and filing it there would pair it with the
    // partner's real catch. Those go to the inbox.
    const hatched = gen >= 3 && m.metLevel === 0;
    const special = gen >= 4 && m.metLocation >= 2000;
    if (!guess && !hatched && !special && m.metLocation !== null && m.metLocation !== undefined) guess = areaForCatch(doc, manifest, gen, m.metLocation);
    // Gen 1 and Gold/Silver keep no catch location: a Pokémon that joins within a minute of a wild battle was caught
    // where the player is – the place the sign shows (snap.here, read live like the battle)
    if (!guess && gen <= 2 && m.metLocation == null && snap.source === 'live' && snap.here && recent?.battle?.kind === 'wild' && Date.now() - recent.at < WILD_CATCH_WINDOW) {
      guess = areaForPlace(doc, manifest, gen, snap.here, { create: true });
    }
    const occupied = guess ? has(guess) : null;
    // Shiny clause off → a shiny is an ordinary encounter.
    const shinyHold = !!m.shiny && r.shinyClause;
    // Dupes clause: a caught dupe isn't the area's encounter – don't let it take the slot.
    const dupe = guess && guess !== 'starter' && !occupied && !shinyHold ? dupeInPass(doc, manifest, rd, m.species, slot, guess, writes) : null;
    if (auto && r.autoAssign && guess && !occupied && !shinyHold && !dupe) {
      const enc = {
        outcome: 'caught', species: m.species, nickname: m.nickname, level: m.level || m.metLevel, gender: m.gender, shiny: m.shiny,
        key: m.key, metLocation: m.metLocation ?? null, metLevel: m.metLevel ?? null, at: Date.now(), auto: true,
      };
      writes[`enc:${guess}:${slot}`] = enc;
      known.set(m.key, { area: guess, enc });
      newCatches.push(guess);
      feedMsg(doc, manifest, { type: 'catch', slot, area: guess, species: m.species, msg: msg('feed.autoCaught', '{area}: {name} (Lv. {lv}) caught', { area: { area: guess }, name: { species: m.species }, lv: m.level || m.metLevel || '?' }) });
      if (m.inParty && m.hp === 0 && m.maxHp > 0) alerts.push({ type: 'fainted', area: guess, mon: m });
    } else {
      inbox.push({ mon: m, guess, occupied: !!occupied, reason: !guess ? (hatched ? 'egg' : special ? 'special' : 'unknown') : occupied ? 'occupied' : shinyHold ? 'shiny' : dupe ? 'dupe' : 'manual',
        ...(dupe ? { dupeArea: dupe.area } : {}),
        where: m.metLocation !== null && m.metLocation !== undefined ? locationName(gen, m.metLocation) : '' });
    }
  }

  // Tracked, alive mons that vanished (released / traded). Only meaningful with full PC data.
  // Live data isn't one consistent picture: the PC is read every few seconds, the party every poll, and a mon
  // carried on the PC cursor is in neither. So a live "gone" must last a while before it is reported.
  if (snap.boxes) {
    const since = missingSince.get(doc) || new Map();
    missingSince.set(doc, since);
    for (const [key, k] of known) {
      const id = `${slot}:${key}`;
      if (seen.has(key) || k.enc.outcome !== 'caught' || pairState(doc, k.area).state === 'dead') {
        since.delete(id);
        continue;
      }
      if (snap.source !== 'save') {
        if (!since.has(id)) since.set(id, Date.now());
        if (Date.now() - since.get(id) < MISSING_GRACE) continue;
      }
      alerts.push({ type: 'missing', area: k.area, enc: k.enc });
    }
  }

  const partyAreas = party.map((m) => known.get(m.key)?.area).filter(Boolean);
  if (JSON.stringify(doc.get(`party:${slot}`, [])) !== JSON.stringify(partyAreas)) writes[`party:${slot}`] = partyAreas;
  const prevLive = live(doc, slot);
  const badges = snap.badges ?? prevLive?.badges ?? 0;
  // Badges never go down in a game – fewer is an older savestate. Winning one back after it is no news (and was
  // judged against the cap the first time), so only a count above the best one seen is a new badge.
  const best = Math.max(prevLive?.badgesBest ?? 0, prevLive?.badges || 0);
  // (the first count a game gives after it had none – Gen 3 and Diamond/Pearl/Platinum didn't read badges before – is
  // where the player stands, not badges won just now)
  const firstRead = snap.badges !== undefined && prevLive && !prevLive.badgesRead && snap.source !== 'save';
  if (prevLive && badges > best && !firstRead) {
    feedMsg(doc, manifest, { type: 'badge', slot, msg: msg('feed.badge', 'Earned badge #{n}!', { n: badges }) });
    // Nuzlocke: was the boss beaten with a mon over the cap that applied before this badge? (The team as last
    // seen before the badge – levels gained in that very fight are allowed.)
    if (solo) {
      const { cap } = levelCap(doc, manifest, slot);
      const top = (prevLive.party || []).filter((x) => !x.egg).sort((a, b) => (b.level || 0) - (a.level || 0))[0];
      if (cap && top?.level > cap) {
        writes[`capbreak:${slot}:${badges}`] = { badge: badges, cap, level: top.level, species: top.species, nick: top.nick || null, area: top.area || null, at: Date.now() };
      }
    }
  }
  const liveParty = party.map((m) => liveMon(m, known.get(m.key)?.area || null));
  const down = snap.source !== 'save' && partyDown(liveParty);
  // the level caps read from this player's game (romcaps.mjs, sent along by the play view): kept with the run, so the
  // board, the partners and the stream API know them too
  if (snap.romCaps !== undefined && JSON.stringify(doc.get(`romcaps:${slot}`, null)) !== JSON.stringify(snap.romCaps)) writes[`romcaps:${slot}`] = snap.romCaps;
  const nextLive = {
    source: snap.source || 'live',
    trainer: snap.trainer || prevLive?.trainer || '',
    badges,
    // (the game said how many badges – a reader without them leaves the count at the last known or 0)
    ...(snap.badges !== undefined || prevLive?.badgesRead ? { badgesRead: true } : {}),
    ...(Math.max(best, badges) > badges ? { badgesBest: best } : {}),
    playTime: snap.playTime || prevLive?.playTime || null,
    party: liveParty,
    boxCount: snap.boxes ? snap.boxes.length : prevLive?.boxCount ?? null,
    game: snap.game || prevLive?.game || null,
    // when the whole party went down (kept while it stays down) – a blackout after "play on" is a new one
    ...(down ? { downAt: prevLive?.downAt || Date.now() } : {}),
  };
  // Only write when something visible changed (live data arrives several times per second).
  const { at, ...prevComparable } = prevLive || {};
  if (JSON.stringify(prevComparable) !== JSON.stringify(nextLive) || !at || Date.now() - at > 30000) {
    writes[`live:${slot}`] = { ...nextLive, at: Date.now() };
  }
  if (Object.keys(writes).length) doc.batch(writes);
  let failed = null;
  if (solo && auto && !statusBefore) {
    if (doc.get('run:status', null)?.reason === 'deathless') failed = 'deathless';
    else if (blackout(doc, manifest, slot) && failRun(doc, manifest, slot, 'blackout')) failed = 'blackout';
  }
  return { inbox, alerts, newCatches, deaths, failed };
}

// ---------------------------------------------------------------------------
// Stats (Nuzlocke summary)

/**
 * Numbers for a player's run, all derived from the doc: encounters, deaths per boss segment, the deadliest
 * opponents, the longest survivor (levels gained since the catch), bosses beaten, attempt and play time.
 * Anything the doc can't tell is null.
 */
export function runStats(doc, manifest, slot = 'p1') {
  const st = { caught: 0, missed: 0, dead: 0, alive: 0, open: 0, catchRate: null, deathsBySegment: [], deadliest: [], longestSurvivor: null, bossesBeaten: null, attempt: null, playTime: null };
  const segments = new Map();
  const kills = new Map();
  for (const a of progression(doc, manifest)) {
    if (a.kind !== 'area') continue;
    const e = encounter(doc, a.key, slot);
    if (!e) {
      st.open++;
      continue;
    }
    if (e.outcome === 'missed') {
      st.missed++;
      continue;
    }
    if (e.outcome !== 'caught') continue;
    st.caught++;
    const p = doc.get(`pair:${a.key}`, null);
    const dead = p?.state === 'dead';
    if (dead) {
      st.dead++;
      const seg = p.segment ?? null;
      segments.set(seg, (segments.get(seg) || 0) + 1);
      if (p.killer?.species) kills.set(p.killer.species, (kills.get(p.killer.species) || 0) + 1);
    } else st.alive++;
    const now = dead ? p.level ?? e.level : e.level;
    if (e.metLevel != null && now != null) {
      const levels = now - e.metLevel;
      if (!st.longestSurvivor || levels > st.longestSurvivor.levels) st.longestSurvivor = { area: a.key, species: e.species, levels };
    }
  }
  if (st.caught + st.missed) st.catchRate = st.caught / (st.caught + st.missed);
  // in route order: bosses as they come, deaths without a known segment last
  const order = progression(doc, manifest).filter((x) => x.kind === 'boss').map((x) => x.key);
  const rank = (k) => (k === null ? Infinity : order.includes(k) ? order.indexOf(k) : order.length);
  const bossName = (k) => (k === null ? null : BOSS_NAMES()[k] || progression(doc, manifest).find((x) => x.key === k)?.name || k);
  st.deathsBySegment = [...segments].sort((a, b) => rank(a[0]) - rank(b[0])).map(([boss, deaths]) => ({ boss, name: bossName(boss), deaths }));
  st.deadliest = [...kills].sort((a, b) => b[1] - a[1]).map(([species, n]) => ({ species, kills: n }));
  const l = live(doc, slot);
  st.bossesBeaten = profileOf(manifest).curated ? Object.values(doc.scan('boss:')).filter(Boolean).length : l?.badges ?? null;
  st.attempt = Number(manifest?.attempt) || Number(/#(\d+)\s*$/.exec(manifest?.name || '')?.[1]) || (manifest ? 1 : null);
  st.playTime = l?.playTime ?? null;
  return st;
}

/** Convert a parsed HGSS save (shared/gen4save.mjs) into a snapshot. */
export function snapshotFromSave(save) {
  const norm = (m) => ({ ...m, item: m.heldItem });
  // A failed PK4 checksum is a Bad Egg / damaged slot: its species and key are garbage, not a catch.
  const ok = (m) => m.checksumOk !== false;
  return {
    source: 'save',
    party: save.party.filter(ok).map(norm),
    boxes: save.boxes.filter(ok).map(norm),
    badges: save.badges.count,
    trainer: save.trainer.name,
    playTime: save.playTime,
  };
}
