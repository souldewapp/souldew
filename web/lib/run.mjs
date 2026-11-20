// SoulLink domain logic on top of the shared run document. Game-agnostic: HeartGold/SoulSilver
// (incl. Definitive HG) use a curated route list with level caps, every other game builds its
// area list on the fly from the catch locations the players report.
import { PROGRESSION, VANILLA_CAPS, areaForMetLocation, levelCapFor, gymCapsFamily, vanillaCapFor, romCapFor, prettyTrainer } from '/shared/routes.mjs';
import { gen4data, speciesName, pokeapi, giftItemName, itemNameByKey, gameById as catalogGame } from './data.mjs';
import { t, currentLang } from './i18n.mjs';
import { ALL_SLOTS, slotsOf, runMode, isNuzlocke, isTogether, othersOf, runSection } from '/shared/slots.mjs';
import { gameInfo, cleanGameInfo } from '/shared/playtogether.mjs';
import { DEFAULT_RULES, RULE_PRESETS, NUZLOCKE_RULES, rulesWithDefaults, cheatGroups } from '/shared/rules.mjs';
import { CHEATS, cheatAllowed } from '/shared/live/cheats.mjs';
import { placeName, locationLabel, nameIn } from '/shared/live/location.mjs';
import { moneyText } from '/shared/linkbattle.mjs';
import { livesLeft, livesOf, deathsIn, poolOf } from '/shared/lives.mjs';
import { hostSlotOf, canEditRules, SOULLINK_RULE_KEYS } from '/shared/hostrules.mjs';
import { cleanSummary } from '/shared/monstats.mjs';

export { ALL_SLOTS, slotsOf, runMode, isNuzlocke, isTogether, othersOf, runSection, DEFAULT_RULES, RULE_PRESETS, NUZLOCKE_RULES, hostSlotOf, canEditRules };
// Runs from before 1–4 players were always a pair – the default where no slots/manifest are passed.
const PAIR = ['p1', 'p2'];

/** A player's live data counts as current this long – older means they stopped playing (or closed the app). */
export const LIVE_FRESH_MS = 10 * 60 * 1000;
export const liveFresh = (doc, slot, now = Date.now()) => {
  const at = doc.get(`live:${slot}`, null)?.at;
  return !!at && Math.abs(now - at) < LIVE_FRESH_MS; // abs: the clocks of two computers differ a little
};

// The met-location tables in every language of the app (shared/data/locations_gen<N>.json): { loc2 … loc7 }
let LOC = {};
export async function loadLocationTables() {
  const j = (f) => fetch(`/shared/data/${f}`).then((r) => r.json()).catch(() => null);
  const gens = [2, 3, 4, 5, 6, 7];
  const all = await Promise.all(gens.map((g) => j(g === 2 ? 'locations_gen2_crystal.json' : `locations_gen${g}.json`)));
  LOC = Object.fromEntries(gens.map((g, i) => [`loc${g}`, all[i]]));
}
/** The loaded location tables ({ loc2 … loc7 }, for locationLabel) – empty before loadLocationTables. */
export const locationTables = () => LOC;

// The running game's own place names (shared/live/romloc.mjs – web/views/location.mjs hands them over when the ROM's
// location data has loaded): a catch is named like the place sign names that place (placeName) – the game's own name
// in a randomized game or a ROM hack.
let ROM_PLACES = null;
export function setRomPlaces(rom) {
  ROM_PLACES = rom && Array.isArray(rom.names) && rom.gen ? rom : null;
}

/** Localized name of a met location for a generation. */
export function locationName(gen, id) {
  if (id === null || id === undefined) return '';
  const table = locationLabel(gen, Number(id), { ...LOC, gen4: gen4data() }, currentLang());
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
  return runData?.gen || { gb: 1, gbc: 2, gba: 3, nds: 4, '3ds': 6 }[manifest?.game?.system] || 4;
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
  const lang = currentLang();
  const rows = (map, keep) => Object.entries(map || {}).map(([id, v]) => ({ id: +id, name: nameIn(v, lang), special: /SPECIAL|DYNAMIC|SECRET_BASE|NONE/.test(v.mapsec || v.landmark || '') }))
    .filter((r) => keep(r.id) && !r.special && r.name && !r.name.startsWith('(')); // "(fateful encounter)" & co. aren't places
  if (gen === 3) {
    const frlg = /^BP[RG]/.test(code);
    return rows(LOC.loc3?.map, (id) => (frlg ? id >= 88 && id < 196 : id < 88 || id > 196));
  }
  if (gen === 2) return rows(LOC.loc2?.map, (id) => id > 0); // Johto + Kanto landmarks, the same in Gold/Silver
  if (gen === 4) return (gen4data()?.locations || []).map((en, id) => ({ id, name: nameIn(LOC.loc4?.map?.[id], lang) || en })).filter((r) => r.id > 0 && r.id < 126 && r.name);
  // Gen 6: X/Y's Kalos is 2–168, Omega Ruby/Alpha Sapphire's Hoenn 170 on; Gen 7: Alola (Sun/Moon and Ultra Sun/Moon).
  // Places only: the 30000s+ are link trades, events and eggs; id 2/4 Mystery Zone / Faraway Place.
  if (gen === 6) {
    const oras = /^EC[RL]/.test(code);
    return rows(LOC.loc6?.map, (id) => id > 4 && id < 30000 && (oras ? id >= 170 : id < 170));
  }
  if (gen === 7) return rows(LOC.loc7?.map, (id) => id > 4 && id < 30000);
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

export function feed(doc, entry, id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`) {
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
      ? v.area !== undefined ? areaName(doc, manifest, v.area) : v.species !== undefined ? speciesName(v.species) : v.money !== undefined ? moneyText(v.money, currentLang())
        : v.item !== undefined ? itemCount(v)
        : v.key ? renderMsg(doc, manifest, v) : ''
      : v;
  }
  return t(m.key, m.def, vars);
}

/**
 * An item in a log line ({ item, gen, n } – a gift between players; a cheat's adds `itemKey`, its PokeAPI identifier:
 * Gen 1/2 items the gifts don't name, the Master Ball): "Potion", "3 × Potion".
 */
const itemCount = (v) => {
  const name = (v.itemKey && itemNameByKey(String(v.itemKey))) || giftItemName(v.item, v.gen) || `#${v.item}`;
  return v.n > 1 ? t('feed.itemCount', '{n} × {item}', { n: v.n, item: name }) : name;
};

export const causeText = (doc, manifest, cause) => (cause && typeof cause === 'object' ? renderMsg(doc, manifest, cause) : cause || '');

export function feedText(doc, manifest, f) {
  if (!f?.msg) return f?.text || '';
  const cause = causeText(doc, manifest, f.cause);
  return renderMsg(doc, manifest, f.msg) + (cause ? ` – ${cause}` : '') + (f.note ? ` – ${f.note}` : '');
}

function feedMsg(doc, manifest, entry, id) {
  feed(doc, { ...entry, text: feedText(doc, manifest, entry) }, id);
}

export function feedList(doc, limit = 80) {
  return Object.entries(doc.scan('feed:')).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.at - a.at).slice(0, limit);
}

export function setEncounter(doc, manifest, area, slot, data, { quiet, by } = {}) {
  const prev = encounter(doc, area, slot);
  const next = data ? { ...prev, ...data, at: prev?.at || Date.now() } : null;
  // (another Pokémon entered by hand doesn't keep the form of the one before it)
  if (next && prev?.form && !('form' in data) && data.species !== prev.species) delete next.form;
  doc.set(`enc:${area}:${slot}`, next);
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
      ? { type: 'missed', slot, area, ...(data.species ? { species: data.species } : {}), msg: missedMsg(doc, manifest, area, data.species) }
      : { type: 'catch', slot, area, species: data.species, msg: msg('feed.caught', '{area}: caught {name}', { area: { area }, name: { species: data.species } }) });
  }
}

/**
 * The log line of a missed encounter – with the Pokémon when it is known. In a SoulLink whose rules let a miss cost
 * the whole pair (group), the line says so: it is what the partners read in their toast.
 */
function missedMsg(doc, manifest, area, species) {
  if (!species) return msg('feed.missed', '{area}: encounter missed', { area: { area } });
  const vars = { area: { area }, name: { species } };
  const n = slotsOf(manifest).length;
  if (n === 1 || rules(doc, manifest).failKillsPair === false) return msg('feed.missedSpecies', '{area}: {name} got away – the area is spent', vars);
  return n > 2 ? msg('feed.missedGroup', '{area}: {name} got away – the group is lost', vars) : msg('feed.missedPair', '{area}: {name} got away – the pair is lost', vars);
}

/**
 * The group of `area` dies (every player's mon there). Optional: `level` at death, `killer` {species, level, kind}
 * (the opponent of the battle it fell in), `place` {gen, id, name} (the place sign where it fell – the share card
 * shows it). The boss segment it died in is kept for the stats. In a deathless Nuzlocke the first death ends the run.
 */
export function markDead(doc, manifest, area, { slot, cause = '', level = null, killer = null, place = null, feedId = undefined } = {}) {
  if (isTogether(manifest)) return false; // (Play together: nothing ever dies)
  const p = doc.get(`pair:${area}`) || {};
  if (p.state === 'dead') return false;
  const segment = levelCap(doc, manifest, slot || 'p1').boss?.key ?? null;
  const where = place?.name ? { gen: place.gen ?? null, id: place.id ?? null, name: String(place.name).slice(0, 40) } : null;
  doc.set(`pair:${area}`, { ...p, state: 'dead', diedAt: Date.now(), cause, by: slot, level, killer, segment, ...(where ? { place: where } : {}) });
  const n = slotsOf(manifest).length;
  const text = n === 1 ? msg('feed.deathSolo', '{area}: the Pokémon died', { area: { area } })
    : n > 2 ? msg('feed.deathGroup', '{area}: the linked group died', { area: { area } })
      : msg('feed.death', '{area}: the pair died', { area: { area } });
  feedMsg(doc, manifest, { type: 'death', slot, area, msg: text, cause: cause || null }, feedId);
  if (runMode(manifest) === 'nuzlocke' && rules(doc, manifest).deathless) failRun(doc, manifest, slot || 'p1', 'deathless', { area });
  spendLife(doc, manifest, slot, { area });
  return true;
}

/**
 * The lives rule's count (shared/lives.mjs), derived from the deaths that stand – so undoing a death gives its life
 * back. null while the rule is off, else { total, pool, pools: { all | p1…: { slots, used, left, out, lastAt } } }.
 */
export function lives(doc, manifest) {
  return livesLeft(rules(doc, manifest), slotsOf(manifest), standingDeathsOf(doc, manifest));
}

/** The deaths that stand, as shared/lives.mjs counts them (a death without a known player: see deathsIn). */
const standingDeathsOf = (doc, manifest) => deathsIn(doc.scan('pair:'), doc.scan('extra:'), { slots: slotsOf(manifest), encs: doc.scan('enc:') });

/** The lives of the pool `slot` spends from (the shared one, or the player's own) – null while the rule is off. */
export const livesFor = (doc, manifest, slot) => livesOf(lives(doc, manifest), slot, slotsOf(manifest));

/** `slot`'s Pokémon just died here (`cause` { area } | { extra }): when that took the last life of its pool, the run is over. */
function spendLife(doc, manifest, slot, cause) {
  const l = lives(doc, manifest);
  if (!l) return;
  const slots = slotsOf(manifest);
  if (!slots.includes(slot)) {
    settleLives(doc, manifest); // (who fell isn't known: as the count tells it – shared/lives.mjs deathsIn)
    return;
  }
  const pool = poolOf(l, slot, slots);
  if (l.pools[pool]?.out) endByLives(doc, manifest, l, pool, slot, cause);
}

/** The doc's own time of an entry: its logical clock, later than every change its writer had seen (0: unknown). */
const stampOf = (doc, key) => doc.entries?.[key]?.t || 0;
const deathKey = (d) => (d.area !== undefined ? `pair:${d.area}` : `extra:${d.extra}`);

/**
 * From when a pool that is out ends the run: the last change of the lives rule (`rules.livesAt`, written by the board
 * with the doc's clock) and the last "play on" (`run:resumed`, by its entry's clock). The deaths from before still
 * count – they used up the lives –, but they don't end the run on their own: the next death does. That is what
 * spendLife always did (switching the rule on, or lowering it, below the deaths that stand never ends a run by
 * itself), and settleLives below keeps to it.
 */
function livesSince(doc, manifest) {
  return Math.max(Number(rules(doc, manifest).livesAt) || 0, doc.get('run:resumed') ? stampOf(doc, 'run:resumed') : 0);
}

/**
 * The run ran out of lives in `pool`: end it ('lives'), with the death `cause` ({ area } | { extra }) as what took the
 * last life. The log line has a fixed id – the pool, the "since" above and the death that took its last life –, so
 * two computers ending the run at the same time (each answering a death that came in by sync) write one line, not two.
 */
function endByLives(doc, manifest, l, pool, slot, cause) {
  const slots = slotsOf(manifest);
  const since = livesSince(doc, manifest);
  const inPool = standingDeathsOf(doc, manifest).filter((d) => poolOf(l, d.slot, slots) === pool)
    .sort((a, b) => a.at - b.at || (deathKey(a) < deathKey(b) ? -1 : 1));
  const last = inPool[l.total - 1] || inPool.at(-1);
  const id = `lives-${pool}-${since.toString(36)}-${last ? deathKey(last).replace(/[^\w:-]/g, '_') : 'x'}`;
  return failRun(doc, manifest, slot, 'lives', cause, id);
}

/**
 * The lives rule, checked from what stands in the run document (idempotent – call it as often as you like). A death
 * that came in by sync never went through spendLife here: a 2.7.4 partner doesn't know the rule, and two deaths made
 * offline on two computers only use up the pool once they meet. When a pool is out and its newest death came after
 * livesSince, and the run has no end yet, the run ends like spendLife ends it (failRun – once; the same log line on
 * every computer). A pool used up only by deaths from before the rule changed or before "play on" doesn't end the run
 * (the board's lives panel says so). true when it ended the run now.
 */
export function settleLives(doc, manifest) {
  if (doc.get('run:status')) return false;
  const l = lives(doc, manifest);
  if (!l) return false;
  const slots = slotsOf(manifest);
  const since = livesSince(doc, manifest);
  const deaths = standingDeathsOf(doc, manifest);
  const stamp = (d) => stampOf(doc, deathKey(d)) || d.at || 0;
  for (const [pool, p] of Object.entries(l.pools)) {
    if (!p.out) continue;
    const newest = deaths.filter((d) => poolOf(l, d.slot, slots) === pool)
      .reduce((a, d) => (!a || stamp(d) > stamp(a) || (stamp(d) === stamp(a) && deathKey(d) > deathKey(a)) ? d : a), null);
    if (!newest || stamp(newest) <= since) continue;
    const slot = pool !== 'all' ? pool : slots.includes(newest.slot) ? newest.slot : slots[0];
    return endByLives(doc, manifest, l, pool, slot, newest.area !== undefined ? { area: newest.area } : { extra: newest.extra });
  }
  return false;
}

/**
 * A value of a log line that a 3.0 app renders in each player's language (renderMsg: `v.item`, `v.money`) and an older
 * one as the plain English `def` (it only knows nested messages: { key, def }).
 */
const withFallback = (v, def) => ({ ...v, key: 'cheat.legacy', def: String(def), vars: {} });

/**
 * `slot` used a cheat (`cheat`: an id of shared/live/cheats.mjs CHEATS): `added` of its item went into the bag (`gen`:
 * the game's generation – the item's number in it), or – the money – `added` ₽ more, `after` now. Everyone in the run
 * sees it in the log, naming what was added – that is the deal for allowing cheats at all. Refused (false) while the
 * run's rules don't allow this cheat (shared/rules.mjs cheats, cheatSet), and for a cheat it doesn't know. Rare Candies
 * and Max Repels keep the lines older apps know.
 */
export function logCheat(doc, manifest, slot, { added, cheat = 'rareCandy', gen = null, after = null }) {
  const c = CHEATS[cheat];
  if (!c || !cheatAllowed(rules(doc, manifest), cheat) || !(added > 0)) return false;
  const money = (v) => withFallback({ money: v }, moneyText(v, 'en'));
  const what = cheat === 'rareCandy' ? msg('cheat.rareCandies', '{n} Rare Candy|{n} Rare Candies', { n: added, count: added })
    : cheat === 'maxRepel' ? msg('cheat.maxRepels', '{n} Max Repel|{n} Max Repels', { n: added, count: added })
      : c.money ? (after !== null ? msg('cheat.moneyNow', '+{money} money (now {total})', { money: money(added), total: money(after) }) : msg('cheat.money', '+{money} money', { money: money(added) }))
        : withFallback({ item: c.items[gen] || 0, gen, n: added, itemKey: c.key }, added > 1 ? `${added} × ${c.en}` : c.en);
  feedMsg(doc, manifest, { type: 'cheat', slot, cheat, count: added, msg: slotsOf(manifest).length === 1
    ? msg('feed.cheatSolo', 'Cheat used: {what}', { what })
    : msg('feed.cheat', 'used a cheat: {what}', { what }) });
  return true;
}

/**
 * Which cheats the run allows changed (`groups`: shared/rules.mjs cheatGroups, cheats on both before and after) – logged
 * like the cheats themselves, naming them (each a message of its own: every player reads them in their language).
 */
export function logCheatSet(doc, manifest, by, groups) {
  const solo = slotsOf(manifest).length === 1;
  const names = groups.map((g) => cheatGroupMsg(g));
  const list = { key: 'cheat.list', def: names.map((_, i) => `{g${i}}`).join(', '), vars: Object.fromEntries(names.map((m, i) => [`g${i}`, m])) };
  feedMsg(doc, manifest, { type: 'cheat', slot: by, msg: solo ? msg('feed.cheatSetSolo', 'Cheats allowed for this run: {list}', { list })
    : msg('feed.cheatSet', 'set the cheats allowed for this run: {list}', { list }) });
}

/** A cheat group's name for the log and the rule editors (shared/rules.mjs CHEAT_GROUPS). */
export function cheatGroupMsg(g) {
  return {
    rareCandy: msg('cheat.gRareCandy', 'Rare Candies'),
    maxRepel: msg('cheat.gMaxRepel', 'Max Repels'),
    masterBall: msg('cheat.gMasterBall', 'Master Balls'),
    balls: msg('cheat.gBalls', 'Poké Balls and Ultra Balls'),
    healing: msg('cheat.gHealing', 'Full Restores and Revives'),
    money: msg('cheat.gMoney', 'Money'),
  }[g] || msg('cheat.gOther', '{g}', { g });
}

/** The run's cheat rule was switched (`by` = slot) – logged like the cheats themselves. */
export function logCheatRule(doc, manifest, by, allowed) {
  const solo = slotsOf(manifest).length === 1;
  feedMsg(doc, manifest, { type: 'cheat', slot: by, msg: allowed
    ? solo ? msg('feed.cheatsOnSolo', 'Cheats allowed for this run') : msg('feed.cheatsOn', 'allowed cheats for this run')
    : solo ? msg('feed.cheatsOffSolo', 'Cheats turned off for this run') : msg('feed.cheatsOff', 'turned cheats off for this run') });
}

/**
 * A trade in a link session (docs/MULTIPLAYER.md): what left `slot`'s team and what came in, by the party before and
 * after (live data; a Pokémon is its `key` – personality value and trainer ID). Logged only when both sides changed.
 */
export function logLinkTrade(doc, manifest, slot, partner, before, after) {
  // (a Pokémon is its key AND its species, counted: Gen 1/2 keys are only trainer ID + DVs – two of a player's own
  // Pokémon may share them, as in the recorded Crystal ↔ Silver trade, where a key-only comparison saw nothing leave)
  const id = (m) => `${m.key}|${m.species}`;
  const minus = (a, b) => {
    const left = new Map();
    for (const m of b || []) if (m?.key) left.set(id(m), (left.get(id(m)) || 0) + 1);
    return (a || []).filter((m) => {
      if (!m?.key) return false;
      const n = left.get(id(m)) || 0;
      if (n) left.set(id(m), n - 1);
      return !n;
    });
  };
  const gave = minus(before, after);
  const got = minus(after, before);
  if (!gave.length || !got.length) return false;
  const name = players(doc, manifest)[partner]?.name || partner;
  feedMsg(doc, manifest, { type: 'trade', slot, partner, gave: gave.map((m) => m.species), got: got.map((m) => m.species),
    msg: msg('feed.linkTrade', 'traded {gave} for {got} with {partner}', { gave: { species: gave[0].species }, got: { species: got[0].species }, partner: name }) });
  return true;
}

/**
 * A link battle every player of the session agreed on (web/lib/wager.mjs outcomeOf) into the log: "Sam won a link
 * battle against Tim", "… won 2 : 1 in link battles against Tim", "… drew a link battle with Tim", "Sam & Lena beat
 * Tim & Robin in a multi battle". Keyed by the session, so every player's computer writes the same entry once.
 */
export function logLinkBattle(doc, manifest, sid, o) {
  const key = `feed:lb-${sid}`;
  if (!o || o.state !== 'agreed' || !o.summary?.battles || doc.get(key)) return false;
  const names = players(doc, manifest);
  const name = (s) => names[s]?.name || s;
  const s = o.summary;
  const base = { at: o.at || Date.now(), type: 'linkBattle', sid, winners: s.winners, losers: s.losers, draw: !!s.draw, battles: s.battles, wager: o.wager || 0 };
  let entry;
  if (s.multi) {
    entry = { ...base, slot: null, msg: msg('feed.linkMulti', '{winners} beat {losers} in a multi battle', { winners: joinNames(s.winners.map(name)), losers: joinNames(s.losers.map(name)) }) };
  } else if (s.draw) {
    const [a, b] = o.seats;
    entry = { ...base, slot: a, msg: s.battles > 1 ? msg('feed.linkDrawMany', 'drew {score} with {name} in link battles', { score: `${s.score[0]} : ${s.score[1]}`, name: name(b) })
      : msg('feed.linkDraw', 'drew a link battle with {name}', { name: name(b) }) };
  } else {
    const [w] = s.winners;
    const [l] = s.losers;
    entry = { ...base, slot: w, msg: s.battles > 1 ? msg('feed.linkWonMany', 'won {score} in link battles against {name}', { score: `${s.score[0]} : ${s.score[1]}`, name: name(l) })
      : msg('feed.linkWon', 'won a link battle against {name}', { name: name(l) }) };
  }
  doc.set(key, { ...entry, text: feedText(doc, manifest, entry) });
  return true;
}

/**
 * A raid that is over (web/lib/raid.mjs): "Sam, Tim & Kim won a raid (1:23 · most damage: Tim)" / "… lost a raid".
 * Every computer that was in it writes the same entry, keyed by the raid (shared/raid.mjs raidFeedEntry).
 */
export function logRaid(doc, manifest, entry) {
  const key = `feed:raid-${entry.raid}`;
  if (doc.get(key)) return false;
  const names = players(doc, manifest);
  const name = (s) => names[s]?.name || s;
  const who = joinNames(entry.players.map(name));
  const time = Number.isFinite(entry.ms) ? `${Math.floor(entry.ms / 60000)}:${String(Math.floor((entry.ms % 60000) / 1000)).padStart(2, '0')}` : '';
  const m = entry.won
    ? entry.mvp ? msg('feed.raidWonMvp', '{names} won a raid together ({time} · most damage: {mvp})', { names: who, time, mvp: name(entry.mvp) })
      : msg('feed.raidWon', '{names} won a raid together ({time})', { names: who, time })
    : msg('feed.raidLost', '{names} lost a raid ({time})', { names: who, time });
  const e = { ...entry, slot: null, msg: m };
  doc.set(key, { ...e, text: feedText(doc, manifest, e) });
  return true;
}

/** `slot`'s game paid a lost wager: "Tim paid Sam ₽2,000 (link battle)" – once per session and payer. */
export function logWagerPaid(doc, manifest, sid, slot, to, amount) {
  const key = `feed:lbp-${sid}-${slot}`;
  if (doc.get(key)) return false;
  const entry = { at: Date.now(), type: 'wager', slot, to, amount, sid,
    msg: msg('feed.wagerPaid', 'paid {name} {amount} (link battle)', { name: players(doc, manifest)[to]?.name || to, amount: { money: amount } }) };
  doc.set(key, { ...entry, text: feedText(doc, manifest, entry) });
  return true;
}

/**
 * The run's host: the player who created it (shared/hostrules.mjs) – the run names them (`host`); older runs and a
 * run without a manifest at hand: P1, the one who sent the invite.
 */
export const HOST_SLOT = 'p1';
export const isHost = (me, manifest) => (me || hostSlotOf(manifest)) === hostSlotOf(manifest);

/** Is the type matchup help shown in this run? On unless the host switched it off (older runs: on). */
export const typeHelpOn = (doc, manifest) => !doc || rules(doc, manifest).typeHelp !== false;

/** A run's shiny setting in a few words – "shiny 1 in 512", "trainer shinies" – or '' with the games' own odds. */
export function shinyNote(manifest) {
  const s = manifest?.shiny;
  if (!s) return '';
  const parts = [];
  if (s.rate && s.rate !== 8192) parts.push(t('board.shinyRate', 'shiny 1 in {n}', { n: s.rate }));
  if (s.trainers) parts.push(t('board.shinyTrainers', 'trainer shinies'));
  return parts.join(' · ');
}

/**
 * Only the host sets a SoulLink's rules (shared/hostrules.mjs) – on the computer that created the run. Returns the
 * rules patch this computer may apply: all of it there (and in a solo run), else null (the board shows the rules
 * read-only; every other app drops a change that isn't signed by the host anyway).
 */
export function allowedRulesPatch(patch, manifest) {
  return patch && canEditRules(manifest) ? patch : null;
}

/** Switching the type matchup help is logged for everyone, like the cheats rule. */
export function logTypeHelpRule(doc, manifest, by, on) {
  const solo = slotsOf(manifest).length === 1;
  feedMsg(doc, manifest, { type: 'rule', slot: by, msg: on
    ? solo ? msg('feed.typeHelpOnSolo', 'Type matchup help turned on for this run') : msg('feed.typeHelpOn', 'turned the type matchup help on for everyone')
    : solo ? msg('feed.typeHelpOffSolo', 'Type matchup help turned off for this run') : msg('feed.typeHelpOff', 'turned the type matchup help off for everyone') });
}

/**
 * The stored rules `next` after a change on the board: when the lives (how many, or whose) change, `livesAt` – the
 * doc's clock – marks when (settleLives: deaths from before still count, but don't end the run by themselves).
 */
export function stampLivesChange(doc, prev, next) {
  const was = rulesWithDefaults(prev);
  const now = rulesWithDefaults(next);
  const changed = (now.lives || 0) !== (was.lives || 0) || (now.lives > 0 && now.livesPool !== was.livesPool);
  return changed ? { ...next, livesAt: Math.max(Date.now(), (doc.clock || 0) + 1) } : next;
}

/** The lives rule was switched or changed (`by` = slot; `r`: the rules now) – logged for everyone, like the cheats rule. */
export function logLivesRule(doc, manifest, by, r) {
  const solo = slotsOf(manifest).length === 1;
  const n = r.lives > 0 ? r.lives : 0;
  feedMsg(doc, manifest, { type: 'rule', slot: by, msg: !n
    ? solo ? msg('feed.livesOffSolo', 'Lives turned off for this run') : msg('feed.livesOff', 'turned the lives off')
    : solo ? msg('feed.livesSolo', '{n} life for this run|{n} lives for this run', { n, count: n })
      : r.livesPool === 'player' ? msg('feed.livesPlayer', 'set the lives to {n} per player', { n })
        : msg('feed.livesShared', 'set {n} shared life for the run|set {n} shared lives for the run', { n, count: n }) });
}

/** The labels of a SoulLink's switches (n players), for the log: the board's texts. */
const switchLabels = (n) => ({
  missedDupes: msg('rules.missedDupes', 'Fled or knocked-out encounters count as dupes'),
  failKillsPair: n > 2 ? msg('rules.failGroup', 'A missed encounter costs the whole group') : msg('rules.fail', 'A missed encounter costs the whole pair'),
  shinyClause: msg('rules.shiny', 'Shiny clause: shinies may always be caught and stay unlinked'),
  levelCaps: msg('rules.caps', 'Check level caps'),
  autoAssign: msg('rules.autoAssign', 'Enter new catches automatically'),
  autoDeath: n > 2 ? msg('rules.autoDeathGroup', 'A linked Pokémon that faints (live) kills its whole group automatically')
    : msg('rules.autoDeath', 'A linked Pokémon that faints (live) kills the pair automatically'),
  startAtBalls: msg('rules.balls', 'Nothing counts before your first Poké Balls'),
  linkTrades: msg('rules.linkTrades', 'Trades between us (link)'),
  linkBattles: msg('rules.linkBattles', 'Battles between us (link)'),
  linkBattleDeaths: msg('rules.linkBattleDeaths', 'Losing a link battle counts as deaths'),
  itemGifts: msg('rules.itemGifts', 'Gifts between us'),
  saveImports: msg('rules.saveImports', 'Allow importing a save file'),
});
// (the link rules say 'on' / 'off')
const switchOn = (v) => !!v && v !== 'off';

/** A SoulLink's choices (n players): their label and the label of each value, for the log – the board's texts. */
const choiceLabels = (n) => ({
  typeClause: [msg('rules.type', 'Type rule'), { off: msg('rules.off', 'Off'), party: msg('rules.perPlayer', 'Per player'),
    global: n > 2 ? msg('rules.acrossAll', 'Across all teams') : msg('rules.acrossBoth', 'Across both teams') }],
  dupes: [msg('rules.dupes', 'Dupes clause'), { off: msg('rules.off', 'Off'), player: msg('rules.perPlayer', 'Per player'),
    both: n > 2 ? msg('rules.forAll', 'For everyone') : msg('rules.forBoth', 'For both') }],
  gifts: [msg('nzr.gifts', 'Gifts & eggs'), { area: msg('nzr.optArea', 'Count as the area'), free: msg('nzr.optFree', 'Free extra'), banned: msg('nzr.optBanned', 'Not allowed') }],
});

/**
 * The rules went from `before` to `after` (both with the defaults filled in – rules()): every change goes to the log
 * for everyone (`by` = the slot that changed them – in a SoulLink the host). The cheats, the type matchup help and the
 * lives keep their own lines (also in a solo run); a SoulLink logs every other rule too.
 */
export function logRulesChange(doc, manifest, by, before, after) {
  if (!!after.cheats !== !!before.cheats) logCheatRule(doc, manifest, by, !!after.cheats);
  // which cheats: switched on with only some of them, or changed while on – the list
  const groups = cheatGroups(after);
  const some = typeof after.cheatSet === 'string' && after.cheatSet !== 'all';
  if (after.cheats && (before.cheats ? groups.join() !== cheatGroups(before).join() : some)) logCheatSet(doc, manifest, by, groups);
  if ((after.typeHelp !== false) !== (before.typeHelp !== false)) logTypeHelpRule(doc, manifest, by, after.typeHelp !== false);
  if ((after.lives || 0) !== (before.lives || 0) || (after.lives > 0 && after.livesPool !== before.livesPool)) logLivesRule(doc, manifest, by, after);
  if (isNuzlocke(manifest)) return;
  const n = slotsOf(manifest).length;
  const switches = switchLabels(n);
  const choices = choiceLabels(n);
  for (const key of SOULLINK_RULE_KEYS) {
    if (switches[key] && switchOn(after[key]) !== switchOn(before[key])) {
      feedMsg(doc, manifest, { type: 'rule', slot: by, msg: switchOn(after[key])
        ? msg('feed.ruleOn', 'turned on “{rule}” for everyone', { rule: switches[key] })
        : msg('feed.ruleOff', 'turned off “{rule}” for everyone', { rule: switches[key] }) });
    } else if (choices[key] && after[key] !== before[key]) {
      const [rule, values] = choices[key];
      feedMsg(doc, manifest, { type: 'rule', slot: by, msg: msg('feed.ruleSet', 'set “{rule}” to {value} for everyone', { rule, value: values[after[key]] || String(after[key]) }) });
    }
  }
}

/** `slot` let the area's encounter get away (fled, knocked out, ball missed): the area is spent. */
export function markMissed(doc, manifest, area, slot, { species = null, by } = {}) {
  if (encounter(doc, area, slot)) return false;
  setEncounter(doc, manifest, area, slot, { outcome: 'missed', species, ...(by ? { by } : {}) }, { quiet: true });
  feedMsg(doc, manifest, { type: 'missed', slot, area, ...(species ? { species } : {}), msg: missedMsg(doc, manifest, area, species) });
  return true;
}

/**
 * "Nothing counts before your first Poké Balls" (rules.startAtBalls) – does it still hold for `slot`? Each player goes
 * by their own bag: `balls:<slot>` ({ at, how: 'bag' | 'catch', down?: [key] }) marks when their rules started. While it
 * holds, that player's Pokémon don't die, a whiteout doesn't end the run (or cost a life) and no encounter is spent.
 * In a SoulLink the link still works the other way: a partner whose rules have started loses a Pokémon – its whole
 * group dies, this player's linked one too (that death counts: it is the partner's).
 */
export const beforeBalls = (doc, manifest, slot) => !!doc && !!rules(doc, manifest).startAtBalls && !doc.get(`balls:${slot}`, null);

/**
 * `slot`'s rules start now: souldew saw Poké Balls in their bag (`how` 'bag'), or – where it can't read the bag – they
 * caught a Pokémon ('catch'). Logged once per player (a fixed log id – two computers write one line). `down`: the keys
 * of their Pokémon at 0 HP right now – knocked out before the rules started, they only die once they were healed and
 * go down again. false when the rule doesn't hold (any more) for `slot`.
 */
export function startRules(doc, manifest, slot, how = 'bag', down = []) {
  if (!beforeBalls(doc, manifest, slot)) return false;
  doc.set(`balls:${slot}`, { at: Date.now(), how: how === 'catch' ? 'catch' : 'bag', ...(down.length ? { down: down.slice(0, 6) } : {}) });
  feedMsg(doc, manifest, { type: 'rule', slot, msg: msg('feed.ballsStart', 'Rules start now – first Poké Balls') }, `balls-${slot}`);
  return true;
}

/** Areas (progression entries) where `slot` has no encounter yet. */
export function openAreas(doc, manifest, slot = 'p1') {
  return progression(doc, manifest).filter((a) => a.kind === 'area' && !encounter(doc, a.key, slot));
}

/**
 * Ask `slot` whether the wild battle that just ended spent an area (solo Nuzlocke and every player of a SoulLink – a
 * miss there fails the pair)? Not when a new Pokémon turned up since it began (`newMonAt` ≥ `from`), when it was a
 * trainer battle at any point (`wild` false – Gen 4 tells them apart by a heuristic that can flicker), for a shiny
 * (clause) or a dupe, when the run is over, when the place sign's area (`here`, where the battle was) already has
 * this player's encounter – no first encounter then –, when a curated route list has no open area left, or when a
 * catch could have gone unseen: a full party sends it to the PC, and the PC is only read live in some games (`boxes`
 * false). In a SoulLink only where the place sign resolves to an area (one without this player's encounter, or a
 * known place nobody caught at yet): a "yes" there fails the pair for everyone, so no question after every wild battle
 * in a place the app can't tell – a solo Nuzlocke still asks there and offers the open areas.
 * o: { foe: {species, shiny}, wild, from, newMonAt, boxes, partySize, here: {gen, id, name} }
 */
export function missedQuestion(doc, manifest, rd, slot, { foe, wild, from = 0, newMonAt = 0, boxes = true, partySize = 0, here = null } = {}) {
  if (!manifest || doc.get('run:status', null) || !wild || !foe?.species) return false;
  if (beforeBalls(doc, manifest, slot)) return false; // (no first encounter is spent before the first Poké Balls)
  if (newMonAt >= from || (!boxes && partySize >= 6)) return false;
  if (foe.shiny && rules(doc, manifest).shinyClause) return false;
  if (dupeOf(doc, manifest, rd, foe.species, slot)) return false;
  const at = here ? areaForPlace(doc, manifest, genOfRun(manifest, rd), here) : null;
  if (at && encounter(doc, at, slot)) return false;
  if (!at && slotsOf(manifest).length > 1) return false; // (SoulLink: the place is unknown)
  return !profileOf(manifest).curated || openAreas(doc, manifest, slot).some((a) => a.key !== 'starter');
}

/**
 * The wild Pokémon `slot` last fought at the place of `area` ({ species, level, at } or null) – the play view keeps it
 * with the place sign ("where:<slot>".wild, until the player moves on). The board's "Missed" fills it in.
 */
export function lastWildAt(doc, manifest, gen, area, slot) {
  const w = doc.get(`where:${slot}`, null);
  if (!w?.wild?.species || !area) return null;
  return areaForPlace(doc, manifest, gen, w) === area ? w.wild : null;
}

/**
 * A solo blackout per the `blackout` rule. 'party': every Pokémon in the party (eggs aside) is at 0 HP on a live
 * read – no marked death needed. 'box': nothing caught is alive anymore, in the party or the boxes (after at
 * least one catch). Like wipedSlot, a blackout the player waved off (`run:resumed`) counts again only once it
 * happens anew.
 */
export function blackout(doc, manifest, slot = 'p1') {
  const mode = rules(doc, manifest).blackout;
  // (a whiteout before the first Poké Balls doesn't count – nor does one that began before them)
  if (beforeBalls(doc, manifest, slot)) return false;
  const resumed = Math.max(doc.get('run:resumed', 0) || 0, doc.get(`balls:${slot}`, null)?.at || 0);
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
    const extras = doc.scan(`extra:${slot}:`);
    alive += Object.values(extras).filter((x) => x && !x.dead).length;
    // A living team member that isn't filed yet (still in "From your game": a held shiny, a gift, a catch while
    // auto-assign is off) is the player's to decide about – it keeps the run going until it's filed or falls.
    const ignored = doc.scan(`ign:${slot}:`);
    alive += (live(doc, slot)?.party || []).filter((m) => !m.area && !m.egg && !extras[m.key] && !ignored[m.key] && m.maxHp > 0 && m.hp > 0).length;
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
 * 0 HP alone is no death: with auto-death off the player confirms each one ("From your game" asks), and the wipe
 * counts from that confirmation on.
 */
export function wipedSlot(doc, slots = ALL_SLOTS, manifest = Array.isArray(slots) ? null : slots) {
  // A Nuzlocke ends by its own blackout rule (applySnapshot fails it right away).
  if (manifest && runMode(manifest) === 'nuzlocke') return blackout(doc, manifest, 'p1') ? 'p1' : null;
  const resumed = doc.get('run:resumed', 0) || 0;
  for (const slot of Array.isArray(slots) ? slots : slotsOf(slots)) {
    // (before the first Poké Balls a wiped team doesn't end the run – deaths of linked Pokémon still stand)
    if (beforeBalls(doc, manifest, slot)) continue;
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
 * or 'deathless' (Nuzlocke rules), 'lives' (the lives rule: `slot`'s pool is empty); it is kept in
 * `run:status.reason`. `area` (or `extra`, a bonus Pokémon's `slot:key`): the death that ended a deathless run or
 * took the last life; a blackout keeps which rule it went by (`rule`) – revive()
 * and markExtraDead() reopen a run whose cause they undo. `feedId`: a fixed id for the log line (endByLives).
 */
export function failRun(doc, manifest, slot, reason = 'wipe', { area = null, extra = null } = {}, feedId = undefined) {
  if (doc.get('run:status') || isTogether(manifest)) return false; // (Play together can't fail)
  const rule = reason === 'blackout' && runMode(manifest) === 'nuzlocke' ? rules(doc, manifest).blackout : null;
  doc.set('run:status', { state: 'failed', at: Date.now(), by: slot, auto: true, note: null, reason, ...(area ? { area } : extra ? { extra } : {}), ...(rule ? { rule } : {}) });
  const name = players(doc, manifest)[slot]?.name || slot.toUpperCase();
  const solo = runMode(manifest) === 'nuzlocke';
  feedMsg(doc, manifest, { type: 'run', slot, msg: reason === 'deathless'
    ? msg('feed.runDeathless', '{name} lost a Pokémon in a deathless run – the Nuzlocke has failed', { name })
    : reason === 'blackout' ? msg('feed.runBlackout', '{name} blacked out – the Nuzlocke has failed', { name })
      : reason === 'lives' ? livesOutMsg(doc, manifest, name)
        : solo ? msg('feed.runWipedSolo', '{name}’s team was wiped – the Nuzlocke has failed', { name })
          : msg('feed.runWiped', '{name}’s team was wiped – the run has failed', { name }) }, feedId);
  return true;
}

/** The log line of a run that ran out of lives: the last shared life, or `name`'s own last one. */
function livesOutMsg(doc, manifest, name) {
  if (runMode(manifest) === 'nuzlocke') return msg('feed.runLivesSolo', '{name} has no lives left – the Nuzlocke has failed', { name });
  return lives(doc, manifest)?.pool === 'player'
    ? msg('feed.runLivesPlayer', '{name} has no lives left – the run has failed', { name })
    : msg('feed.runLivesShared', 'The last life is gone – the run has failed');
}

/** Reopen an ended run. */
export function resumeRun(doc, slot) {
  doc.batch({ 'run:status': null, 'run:resumed': Date.now() });
  feed(doc, { type: 'run', slot, msg: msg('feed.runResumed', 'reopened the run'), text: t('feed.runResumed', 'reopened the run') });
}

/** The deaths that still stand – dead areas and dead bonus Pokémon – oldest first: [{ area } | { extra: 'slot:key' }]. */
function standingDeaths(doc) {
  const out = [];
  for (const [area, p] of Object.entries(doc.scan('pair:'))) if (p?.state === 'dead') out.push({ area, at: p.diedAt || 0 });
  for (const [extra, x] of Object.entries(doc.scan('extra:'))) if (x?.dead) out.push({ extra, at: x.diedAt || 0 });
  return out.sort((a, b) => a.at - b.at);
}

/**
 * A death was undone (`cause`: { area } or { extra }). When it is what ended the run – the death of a deathless
 * Nuzlocke, the last one of a "box" blackout (nothing alive was left; now something is), or the one that took the
 * last life (its pool has a life again) – the run goes on, too. A deathless run with another death still standing
 * stays failed: that death is its cause now; so does a run whose pool is still out of lives.
 */
function undoneDeath(doc, cause, manifest) {
  const st = doc.get('run:status', null);
  if (st?.state !== 'failed' || !st.auto) return;
  if (st.reason === 'lives') {
    if (livesFor(doc, manifest, st.by)?.out) return;
  } else if (st.reason === 'deathless') {
    if (cause.area ? st.area !== cause.area : st.extra !== cause.extra) return;
    const next = standingDeaths(doc)[0];
    if (next) {
      const { area, extra, ...rest } = st; // eslint-disable-line no-unused-vars
      doc.set('run:status', { ...rest, ...(next.area ? { area: next.area } : { extra: next.extra }) });
      return;
    }
  } else if (!(st.reason === 'blackout' && st.rule === 'box')) return;
  doc.set('run:status', null);
  feed(doc, { type: 'run', slot: st.by, msg: msg('feed.runResumed', 'reopened the run'), text: t('feed.runResumed', 'reopened the run') });
}

/**
 * Undo a death (pass the run's manifest – the lives rule counts per player). When that death is what ended the run
 * the run goes on, too (see undoneDeath). A wipe or a "party" blackout went by the team's HP, not by the death mark:
 * those stay ended ("play on" is still there).
 */
export function revive(doc, area, manifest) {
  const p = doc.get(`pair:${area}`) || {};
  doc.set(`pair:${area}`, { ...p, state: 'alive', diedAt: null, cause: '' });
  undoneDeath(doc, { area }, manifest);
}

/**
 * A bonus Pokémon (`extra:<slot>:<key>` – a kept shiny or gift) died, or that death is undone (`dead` false). It
 * counts like any other death: in a deathless Nuzlocke it ends the run, it costs a life (lives rule), and undoing
 * it reopens the run it ended.
 * false when there is no such bonus Pokémon or nothing changes.
 */
export function markExtraDead(doc, manifest, slot, key, dead = true) {
  const x = doc.get(`extra:${slot}:${key}`, null);
  if (!x || !!x.dead === !!dead) return false;
  doc.set(`extra:${slot}:${key}`, { ...x, dead: !!dead, diedAt: dead ? Date.now() : null });
  if (!dead) undoneDeath(doc, { extra: `${slot}:${key}` }, manifest);
  else {
    if (runMode(manifest) === 'nuzlocke' && rules(doc, manifest).deathless) failRun(doc, manifest, slot, 'deathless', { extra: `${slot}:${key}` });
    spendLife(doc, manifest, slot, { extra: `${slot}:${key}` });
  }
  return true;
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
    if (!manifest?.game?.hackId && !manifest?.game?.hackName && !manifest?.patch) {
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
  if (isTogether(manifest)) return []; // (no rules to break in Play together)
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
          // (a partner's miss with "a missed encounter costs the whole pair" off: this catch stays usable – and counts)
          const st = stateOf(area);
          if (!(st === 'linked' || st === 'waiting' || (st === 'failed' && r.failKillsPair === false))) continue;
          const e = encounter(doc, area, slot);
          if (e?.outcome !== 'caught' || !e.species) continue;
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
        if (m.egg || m.level <= cap) continue;
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
      && !hatchedMon(gen, m) && !(gen >= 4 && m.met >= 2000)) {
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

/**
 * Is `species` a dupe for `slot`: { area, slot } of the encounter that has its line (species) already, or null.
 * Every catch counts – also one of a failed or dead pair; whose catches is the rule's choice ('player' / 'both').
 * A missed encounter (fled, knocked out) counts only with `missedDupes` on and its species known: then
 * `missed: true` – a catch of the line wins over it.
 */
export function dupeOf(doc, manifest, rd, species, slot, exceptArea) {
  const r = rules(doc, manifest);
  if (r.dupes === 'off' || !species) return null;
  const slots = r.dupes === 'both' ? slotsOf(manifest) : [slot];
  let missed = null;
  for (const a of progression(doc, manifest)) {
    if (a.kind !== 'area' || a.key === exceptArea) continue;
    for (const s of slots) {
      const e = encounter(doc, a.key, s);
      if (!e?.species || !sameDupe(r, rd, species, slot, e.species, s)) continue;
      if (e.outcome === 'caught') return { area: a.key, slot: s };
      if (e.outcome === 'missed' && r.missedDupes && !missed) missed = { area: a.key, slot: s, missed: true };
    }
  }
  return missed;
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
  if (found && !found.missed) return found;
  for (const [k, e] of Object.entries(writes)) {
    const m = /^enc:(.+):(p[1-4])$/.exec(k);
    if (!m || m[1] === exceptArea || (r.dupes !== 'both' && m[2] !== slot)) continue;
    if (e?.outcome === 'caught' && e.species && sameDupe(r, rd, species, slot, e.species, m[2])) return { area: m[1], slot: m[2] };
  }
  return found;
}

/**
 * Hatched from an egg – not a catch at the place it hatched. Gen 4 on keep where the egg came from; the level a hatched
 * Pokémon was "met" at is 0 in Gen 3/4 and 1 in Crystal (Gold/Silver keep no met data) and from Gen 5 on (PKHeX
 * EggStateLegality, pokecrystal CAUGHT_EGG_LEVEL). Level 0 is no wild level; level 1 is none in the original Crystal –
 * but a randomizer's level modifier or a ROM hack can put level-1 Pokémon in the grass, and Crystal marks a hatched
 * Pokémon by nothing else (SetEggMonCaughtData: level 1, the time of day and the place it hatched, as any catch). So
 * there (`levelOneWild`) Crystal's level 1 counts as hatched only when the app saw that Pokémon as an egg (`wasEgg`: the
 * keys of the eggs in the last live team – a Gen 2 key is its trainer id and DVs, the egg's own); else it is filed as a
 * catch where it was met rather than kept out as an egg.
 */
export function hatchedMon(gen, m, { wasEgg = null, levelOneWild = false } = {}) {
  if (m?.eggLocation > 0) return true;
  if (gen === 2) return m?.metLevel === 1 && (!levelOneWild || !!wasEgg?.has(m.key));
  return gen >= 3 && gen <= 4 && m?.metLevel === 0;
}

/** Can a wild Pokémon be level 1 in this run's game? A randomized run or a ROM hack (Crystal: see hatchedMon). */
export const levelOneWild = (manifest) => !!(manifest?.randomizer?.enabled || manifest?.patch || manifest?.game?.hackId || manifest?.game?.hackName);

/** doc → Map(slot → Set(key)): the Pokémon the app saw as eggs this session (see applySnapshot's `wasEgg`). */
const hatchedKeys = new WeakMap();

/** `wasEgg`: the app saw this Pokémon as an egg – an untracked one keeps that mark in the live team (hatchedMon). */
function liveMon(m, area, wasEgg = false) {
  // nature, ability, IVs, EVs as the reader got them (shared/monstats.mjs) – the board's Pokémon details; an egg's stay out
  const summary = m.isEgg ? null : cleanSummary(m.summary);
  return {
    key: m.key, area, species: m.species, nick: m.nickname, level: m.level, hp: m.hp, maxHp: m.maxHp, item: m.item ?? m.heldItem,
    status: m.status, shiny: m.shiny, gender: m.gender, moves: m.moves, ...(m.form ? { form: m.form } : {}), ...(m.isEgg ? { egg: true } : !area && wasEgg ? { hatched: true } : {}),
    // an expanded engine's own item numbers: no retail name for them – the game's own name where the ROM gave it
    ...(m.itemOwn ? { itemOwn: true, ...(m.itemName ? { itemName: String(m.itemName).slice(0, 24) } : {}) } : {}),
    // where an untracked mon was met – the Nuzlocke checks tell a second catch on a spent area by it
    ...(!area && m.metLocation != null ? { met: m.metLocation, metLevel: m.metLevel ?? null, ...(m.eggLocation > 0 ? { eggLocation: m.eggLocation } : {}) } : {}),
    ...(summary ? { summary } : {}),
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
 * Deaths the game hasn't shown yet. A live read sees a Pokémon's HP at 0 while the game still drains its HP bar and
 * says that it fainted – so the play view (web/lib/reveal.mjs) holds such a Pokémon until the player has seen it, and
 * applySnapshot gets its key in `held`. Its death is recorded at once, under `held:<slot>:<area>` – with the cause, the
 * opponent and the place of that moment (the battle may be over when it is revealed): nothing is lost when the game is
 * closed, reset or a state is loaded meanwhile, and a death recorded is never taken back. Nothing reads these records but
 * revealHeld: the death itself (`pair:<area>` – the notice, the sound, the log, the partners' apps, older ones too, the
 * stream overlay and API, Discord) is written only when it is revealed.
 */
export const HELD_PREFIX = 'held:';
/** The held record of a whiteout without a death (a Nuzlocke with "fainted means dead" off). */
const DOWN_ONLY = '~down';

/**
 * Reveal the held deaths of `slot` (all of them, or those whose Pokémon `keep` doesn't hold any more; `olderThan`: only
 * records at least that many ms old – an app that doesn't play `slot` reveals what its player's app left behind):
 * each is marked dead as it was recorded, with a fixed log id, so two apps revealing it write one line. A death that
 * came with the whole team down (`down`) ends the run like that whiteout would have – also when the player reset the
 * game meanwhile. → { deaths: [area], failed: 'blackout'|'deathless'|'lives'|'wipe'|null }
 */
export function revealHeld(doc, manifest, slot, { keep = null, olderThan = 0, now = Date.now() } = {}) {
  const out = { deaths: [], failed: null };
  const statusBefore = doc.get('run:status', null);
  for (const [area, h] of Object.entries(doc.scan(`${HELD_PREFIX}${slot}:`))) {
    if (!h || (keep && h.key && keep.has(h.key)) || now - (h.at || 0) < olderThan) continue;
    doc.set(`${HELD_PREFIX}${slot}:${area}`, null);
    if (area !== DOWN_ONLY && markDead(doc, manifest, area, { slot, cause: h.cause || '', level: h.level ?? null, killer: h.killer || null, place: h.place || null,
      feedId: `death-${slot}-${String(area).replace(/[^\w-]/g, '_')}-${(h.at || 0).toString(36)}` })) out.deaths.push(area);
    if (h.down && !doc.get('run:status', null)) {
      if (runMode(manifest) !== 'nuzlocke') failRun(doc, manifest, slot, 'wipe');
      else if (rules(doc, manifest).blackout === 'party') failRun(doc, manifest, slot, 'blackout');
    }
  }
  const st = doc.get('run:status', null);
  if (!statusBefore && st?.state === 'failed') out.failed = st.reason || 'wipe';
  return out;
}

/** How long after the first look at an imported save its Pokémon are still taken as brought along (the PC is read later). */
export const IMPORT_WINDOW = 60 * 1000;

/**
 * A battery save imported into `slot`'s game (the board's Files menu, web/views/saveimport.mjs – `simport:<slot>` in the
 * doc, written before the save is): the first look at the game afterwards takes what it holds as where the player
 * stands – its Pokémon are set aside (ignored, reason 'imported': no catch, no encounter, no death), its badges are no
 * news, tracked Pokémon in it are brought up to date quietly. That lasts until the PC was read too (a snapshot with
 * boxes) or IMPORT_WINDOW has passed since the first look. → null (nothing to do) or { writes } for this snapshot.
 */
export function importBaseline(doc, slot, snap, now = Date.now()) {
  const imp = doc.get(`simport:${slot}`, null);
  if (!imp || typeof imp !== 'object' || imp.done || !imp.at) return null;
  // (an empty look – a title screen, a reset – isn't the save yet: applySnapshot returns before this for those)
  const since = Number.isFinite(imp.since) ? imp.since : now;
  const done = Array.isArray(snap?.boxes) || now - since >= IMPORT_WINDOW;
  return { writes: { [`simport:${slot}`]: { ...imp, since, ...(done ? { done: true } : {}) } } };
}

/** Can this player import a save into the run? A Nuzlocke: yes. A SoulLink: only where the host allows it (rule `saveImports`). */
export function canImportSave(doc, manifest) {
  if (!manifest) return { ok: true };
  if (runMode(manifest) === 'nuzlocke') return { ok: true };
  return rules(doc, manifest).saveImports ? { ok: true } : { ok: false, reason: 'host' };
}

/**
 * The marker importBaseline reads – written before the save goes to the server, so no look at the game can come first.
 * `clear`: the import failed – the marker goes.
 */
export function markSaveImport(doc, slot, { clear = false } = {}) {
  doc.set(`simport:${slot}`, clear ? null : { at: Date.now() });
}

/** The import in the run's log, for everyone (also older partners – the English text goes along). `undo`: it was undone. */
export function logSaveImport(doc, manifest, slot, { undo = false } = {}) {
  const solo = slotsOf(manifest).length === 1;
  feedMsg(doc, manifest, { type: 'saveImport', slot, ...(undo ? { undo: true } : {}), msg: undo
    ? solo ? msg('feed.saveImportUndoSolo', 'Imported save undone – the save from before is back') : msg('feed.saveImportUndo', 'undid the save import – the save from before is back')
    : solo ? msg('feed.saveImportSolo', 'Save file imported – its Pokémon and badges don’t count for the run') : msg('feed.saveImport', 'imported a save file – its Pokémon and badges don’t count for the run') });
}

/**
 * Apply a snapshot of `slot`'s game: { party: [mon], boxes: [mon]|null, badges, trainer, playTime, source }.
 * Mons are normalized: { key, species, nickname, level, hp, maxHp, status, shiny, gender, metLocation, metLevel, isEgg, inParty }.
 * `battle` (optional, the live battle right now): { kind: 'wild'|'trainer', enemy: { species, level } } – a mon
 * that falls in it gets that opponent as its death cause.
 * Returns { inbox, alerts, newCatches, deaths, failed } for the UI. `failed`: 'blackout' | 'deathless' when this
 * snapshot ended a Nuzlocke, 'lives' when one of its deaths took the last life (any mode; SoulLinks otherwise end
 * through wipedSlot/failRun as before).
 */
/**
 * Play together: every player's game as the partners announced it (`game:<slot>`, shared/playtogether.mjs gameInfo) –
 * this computer's own from its run (always current) – { slot: info | null }.
 */
export function togetherGames(doc, manifest, me = null) {
  const own = me && manifest?.outputs?.[me] ? gameInfo(manifest.game, catalogGame(manifest.game?.id)) : null;
  return Object.fromEntries(slotsOf(manifest).map((s) => [s, s === me && own ? own : cleanGameInfo(doc?.get?.(`game:${s}`, null))]));
}

/**
 * The id a run player's save states and "where you left off" go by in the play view: the run's own – or, in Play
 * together, the library game's (its free play's), so the states are one set with the game's save (shared/playtogether.mjs).
 */
export function runStateId(manifest, me) {
  const lib = isTogether(manifest) ? manifest?.outputs?.[me]?.library : null;
  return typeof lib === 'string' && lib ? lib : `run-${manifest?.id}-${me}`;
}

/** This computer's player tells the others which game they play (Play together): once, and again when it changes. */
export function announceGame(doc, manifest, me) {
  if (!doc || !isTogether(manifest) || !manifest.outputs?.[me]) return false;
  const info = gameInfo(manifest.game, catalogGame(manifest.game?.id));
  if (JSON.stringify(doc.get(`game:${me}`, null)) === JSON.stringify(info)) return false;
  doc.set(`game:${me}`, info);
  return true;
}

const NOTHING = () => ({ inbox: [], alerts: [], newCatches: [], deaths: [], failed: null });

/**
 * Play together (shared/playtogether.mjs): what the tracker writes of a player's game – their live team, badges and
 * play time for the board, the partners (Shared World followers, gifts, raids, watching) and the stream overlay. No
 * encounter, no death, no level cap, nothing that can end the run; a new badge goes to the log (the one line a
 * friend's game adds there besides trades, battles, raids and gifts). The same "no flicker" guards as applySnapshot:
 * an empty party (title screen, reset) and an older save file under fresh live data change nothing.
 */
export function applyTogether(doc, manifest, slot, snap) {
  if (snap.source !== 'save' && !(snap.party || []).length && !(snap.boxes || []).length) return NOTHING();
  const prev = live(doc, slot);
  if (snap.source === 'save' && prev?.source === 'live' && Date.now() - (prev.at || 0) < LIVE_FRESH) return NOTHING();
  const party = (snap.party || []).map((m) => liveMon(m, null, false));
  const badges = snap.badges ?? prev?.badges ?? 0;
  const best = Math.max(prev?.badgesBest ?? 0, prev?.badges || 0);
  const firstRead = snap.badges !== undefined && prev && !prev.badgesRead && snap.source !== 'save';
  if (prev && badges > best && !firstRead) feedMsg(doc, manifest, { type: 'badge', slot, msg: msg('feed.badge', 'Earned badge #{n}!', { n: badges }) });
  const next = {
    source: snap.source || 'live', trainer: snap.trainer || prev?.trainer || '', badges,
    ...(snap.badges !== undefined || prev?.badgesRead ? { badgesRead: true } : {}),
    ...(Math.max(best, badges) > badges ? { badgesBest: best } : {}),
    playTime: snap.playTime || prev?.playTime || null, party,
    boxCount: snap.boxes ? snap.boxes.length : prev?.boxCount ?? null, game: snap.game || prev?.game || null,
  };
  const { at, ...was } = prev || {};
  if (JSON.stringify(was) !== JSON.stringify(next) || !at || Date.now() - at > 30000) doc.set(`live:${slot}`, { ...next, at: Date.now() });
  return NOTHING();
}

export function applySnapshot(doc, manifest, gen, slot, snap, { auto = true, rd = null, battle = null, held = null } = {}) {
  if (isTogether(manifest)) return applyTogether(doc, manifest, slot, snap);
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
  // the Pokémon of the intro save this player's game started from (server/lib/introsave.mjs – normally none, it's a
  // save from before the starter): no encounter, no catch, no death – they are set aside like ignored ones
  const fromIntro = new Set(Array.isArray(manifest?.intro?.[slot]?.keys) ? manifest.intro[slot].keys : []);
  // a battery save this player just imported (importBaseline): what it brought along is where the player stands
  const imp = importBaseline(doc, slot, snap);
  const inbox = [];
  const alerts = [];
  const newCatches = [];
  const deaths = [];
  const writes = {};
  const party = trustLevels(doc, slot, (snap.party || []).map((m) => ({ ...m, inParty: true })), known, snap.source);
  const all = [...party, ...(snap.boxes || [])];
  const seen = new Set();
  // the Pokémon the app saw as eggs (a hatched Pokémon keeps the egg's key – Crystal: hatchedMon): the eggs of the last
  // live team, the hatched ones it still carries untracked (liveMon `hatched` – the egg is gone from the team after the
  // first poll, and without the mark the next poll filed the Pokémon waiting in the inbox as a catch where it hatched)
  // and those seen this session (a hatched one put in the PC leaves the live team)
  const eggsSeen = hatchedKeys.get(doc) || new Map();
  hatchedKeys.set(doc, eggsSeen);
  const wasEgg = eggsSeen.get(slot) || new Set();
  eggsSeen.set(slot, wasEgg);
  for (const x of was?.party || []) if ((x?.egg || x?.hatched) && x.key) wasEgg.add(x.key);
  const oneWild = levelOneWild(manifest);
  let starterOffered = false;
  const battles = lastBattle.get(doc) || new Map();
  lastBattle.set(doc, battles);
  // (with the place sign read during the battle: a death seen just after it is told where the battle was)
  if (snap.source === 'live' && battle?.enemy?.species) battles.set(slot, { battle, at: Date.now(), here: snap.here || null });
  const recent = battles.get(slot);
  const fight = battle || (snap.source === 'live' && recent && Date.now() - recent.at < BATTLE_GRACE ? recent.battle : null);
  // auto-death: `m` (filed under `area`) fell – with the opponent of the battle as its cause
  const deathOf = (area, m) => {
    const name = m.nickname || { species: m.species };
    const foe = fight?.enemy?.species ? fight.enemy : null;
    const kind = fight?.kind === 'trainer' ? msg('cause.trainer', 'trainer battle') : msg('cause.wild', 'wild battle');
    // where it fell: the place sign read with this snapshot (play view → snap.here) – or, when it is seen only once the
    // battle is over (its party tells), where that battle was: the player may have walked on (#79)
    const where = (!battle && fight ? recent.here : snap.here) || null;
    // The log line names the area of the Pokémon's encounter ("Ruins of Alph: the Pokémon died") – where it fell goes
    // with the cause, unless that is the same area (#79: read as the place of death)
    const at = where?.name && areaForPlace(doc, manifest, gen, where) !== area ? String(where.name).slice(0, 40) : null;
    const cause = foe
      ? at ? msg('feed.faintedByAt', '{name} fainted against {enemy} (Lv. {lv}, {kind}, {place})', { name, enemy: { species: foe.species }, lv: foe.level ?? '?', kind, place: at })
        : msg('feed.faintedBy', '{name} fainted against {enemy} (Lv. {lv}, {kind})', { name, enemy: { species: foe.species }, lv: foe.level ?? '?', kind })
      : at ? msg('feed.faintedAt', '{name} fainted ({place})', { name, place: at }) : msg('feed.faintedCause', '{name} fainted', { name });
    const killer = foe ? { species: foe.species, level: foe.level ?? null, kind: fight.kind || null } : null;
    return { cause, level: m.level ?? null, killer, place: where };
  };
  // the play view hasn't shown this death yet (`held`): recorded now, revealed later (revealHeld); else marked dead now
  const realDown = snap.source !== 'save' && partyDown(party.map((m) => ({ egg: m.isEgg, hp: m.hp, maxHp: m.maxHp })));
  const autoDead = (area, m) => {
    const hk = `${HELD_PREFIX}${slot}:${area}`;
    if (held?.has(m.key)) {
      if (!doc.get(hk, null) && !writes[hk]) {
        const d = deathOf(area, m);
        writes[hk] = { key: m.key, at: Date.now(), ...d, place: d.place ? { gen: d.place.gen ?? null, id: d.place.id ?? null, name: String(d.place.name || '').slice(0, 40) } : null, ...(realDown ? { down: true } : {}) };
      }
      return;
    }
    if (doc.get(hk, null)) return; // (recorded while held: revealed below as it was recorded)
    if (markDead(doc, manifest, area, { slot, ...deathOf(area, m) })) deaths.push(area);
  };
  // "Nothing counts before your first Poké Balls": no deaths of this player's own yet; the Pokémon that were down when
  // the rules started (`balls:<slot>`.down) die only once they were healed and go down again
  const grace = beforeBalls(doc, manifest, slot);
  const ballsAt = doc.get(`balls:${slot}`, null);
  const forgiven = new Set(Array.isArray(ballsAt?.down) ? ballsAt.down : []);
  for (const m of party) if (forgiven.has(m.key) && m.hp > 0) forgiven.delete(m.key);
  if (ballsAt && forgiven.size !== (ballsAt.down?.length || 0)) {
    const { down, ...rest } = ballsAt; // eslint-disable-line no-unused-vars
    writes[`balls:${slot}`] = forgiven.size ? { ...rest, down: [...forgiven] } : rest;
  }
  const counts = (m) => !grace && !forgiven.has(m.key);
  let caughtNew = false; // a new Pokémon that is no starter, egg or gift – it took a Poké Ball (the bag can't always be read)
  const autoDeath = auto && r.autoDeath && snap.source === 'live';
  const fellOnCatch = []; // new catches already at 0 HP: they die once their encounter is written

  for (const m of all) {
    if (m.isEgg || !m.species) continue;
    // Live PC data is cached for a moment, so a mon just withdrawn shows up in the party *and* the box: the
    // party copy (first) is the one that counts – the second would land in the inbox a second time.
    if (seen.has(m.key)) continue;
    seen.add(m.key);
    const k = known.get(m.key);
    if (k && imp) {
      // (a tracked Pokémon in the imported save: brought up to date quietly – no evolution in the log, no death; the
      // trophies don't take a level or a species it may have reached elsewhere – shared/trophies.mjs)
      const patch = {};
      if (k.enc.species !== m.species) patch.species = m.species;
      if (m.level && m.level !== k.enc.level) patch.level = m.level;
      if (m.nickname && m.nickname !== k.enc.nickname) patch.nickname = m.nickname;
      if (Object.keys(patch).length) writes[`enc:${k.area}:${slot}`] = { ...k.enc, ...patch };
      continue;
    }
    if (k) {
      const patch = {};
      if (k.enc.species !== m.species) {
        patch.species = m.species;
        feedMsg(doc, manifest, { type: 'evolve', slot, area: k.area, msg: msg('feed.evolved', '{from} evolved into {to}', { from: { species: k.enc.species }, to: { species: m.species } }) });
      }
      if (m.level && m.level !== k.enc.level) patch.level = m.level;
      if (m.nickname && m.nickname !== k.enc.nickname) patch.nickname = m.nickname;
      // the form it has outside of battle (an Alolan form, a Mega that kept its form after the catch – or lost it on a
      // reset): only shown. A form a battle gives it (Mega Evolution, Zen Mode, Blade Forme, a School …) is the same
      // Pokémon – the species and the key stay, so it is no new catch, no evolution and no missing one; while a battle
      // runs the encounter keeps the form it had before
      const formChanged = !battle && snap.source !== 'save' && (m.form || 0) !== (k.enc.form || 0);
      if (Object.keys(patch).length || formChanged) {
        const { form: _old, ...rest } = k.enc; // eslint-disable-line no-unused-vars
        writes[`enc:${k.area}:${slot}`] = { ...(formChanged ? rest : k.enc), ...patch, ...(formChanged && m.form ? { form: m.form } : {}) };
      }
      if (m.inParty && m.hp === 0 && m.maxHp > 0 && pairState(doc, k.area).state !== 'dead' && counts(m)) {
        if (autoDeath) autoDead(k.area, m);
        else if (!held?.has(m.key)) alerts.push({ type: 'fainted', area: k.area, mon: m });
      }
      continue;
    }
    if (ignored[m.key] || extras[m.key]) continue;
    if (fromIntro.has(m.key) || imp) {
      writes[`ign:${slot}:${m.key}`] = { species: m.species, nickname: m.nickname || null, level: m.level || null, shiny: !!m.shiny, reason: imp ? 'imported' : 'intro', at: Date.now() };
      continue;
    }
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
    // A hatched egg carries the place it hatched, an in-game trade or event a special location (Gen 4/5: 2000+) –
    // neither is an encounter of that route, and filing it there would pair it with the partner's real catch. Those
    // go to the inbox.
    const hatched = hatchedMon(gen, m, { wasEgg, levelOneWild: oneWild });
    const special = gen >= 4 && m.metLocation >= 2000;
    if (snap.source === 'live' && guess !== 'starter' && !hatched && !special && m.metLocation != null && (m.metLevel ?? 1) > 0) caughtNew = true;
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
        // (the species is the rules' – route, dupes, evolution line, pairs; the form is only shown: "Charizard (Mega Y)")
        ...(m.form ? { form: m.form } : {}),
      };
      writes[`enc:${guess}:${slot}`] = enc;
      known.set(m.key, { area: guess, enc });
      newCatches.push(guess);
      feedMsg(doc, manifest, { type: 'catch', slot, area: guess, species: m.species, msg: msg('feed.autoCaught', '{area}: {name} (Lv. {lv}) caught', { area: { area: guess }, name: { species: m.species }, lv: m.level || m.metLevel || '?' }) });
      if (m.inParty && m.hp === 0 && m.maxHp > 0 && counts(m)) {
        if (autoDeath) fellOnCatch.push([guess, m]);
        else if (!held?.has(m.key)) alerts.push({ type: 'fainted', area: guess, mon: m });
      }
    } else {
      inbox.push({ mon: m, guess, occupied: !!occupied, reason: !guess ? (hatched ? 'egg' : special ? 'special' : 'unknown') : occupied ? 'occupied' : shinyHold ? 'shiny' : dupe ? 'dupe' : 'manual',
        ...(dupe ? { dupeArea: dupe.area, ...(dupe.missed ? { dupeMissed: true } : {}) } : {}),
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
  if (imp) Object.assign(writes, imp.writes);
  if (prevLive && badges > best && !firstRead && !imp) {
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
  // a Pokémon whose death the game hasn't shown yet keeps the HP the play view shows for it (`held` as a Map: key → HP)
  // – the partners and the stream overlay see it go down when the player does
  const prevHp = new Map((prevLive?.party || []).map((x) => [x.key, x.hp]));
  const shownHp = (m) => {
    const v = typeof held?.get === 'function' ? held.get(m.key) : undefined;
    return Number.isFinite(v) && v > 0 ? v : prevHp.get(m.key) > 0 ? prevHp.get(m.key) : 1;
  };
  const liveParty = party.map((m) => liveMon(held?.has(m.key) && m.hp === 0 ? { ...m, hp: shownHp(m) } : m, known.get(m.key)?.area || null, wasEgg.has(m.key)));
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
  // a whiteout the game is still showing, in a Nuzlocke whose blackout ends it without a death (fainted isn't dead
  // there): recorded like a held death – the run ends when it is shown, even when the game was reset meanwhile
  if (solo && !autoDeath && realDown && r.blackout === 'party' && !grace && snap.source === 'live' && !doc.get(`${HELD_PREFIX}${slot}:${DOWN_ONLY}`, null)) {
    const k = party.find((m) => held?.has(m.key) && m.hp === 0)?.key;
    if (k) writes[`${HELD_PREFIX}${slot}:${DOWN_ONLY}`] = { key: k, at: Date.now(), down: true };
  }
  const late = {};
  for (const [area, m] of fellOnCatch) if (pairState(doc, area).state !== 'dead') autoDead(area, m);
  // (a new catch already down while held: its record goes in now that its encounter is written)
  for (const [k, v] of Object.entries(writes)) if (k.startsWith(HELD_PREFIX) && !doc.get(k, null)) late[k] = v;
  if (Object.keys(late).length) doc.batch(late);
  // the held deaths the play view has shown by now – all of them where nothing holds any (a save file, an emulator
  // outside souldew, an older caller)
  if (snap.source === 'live' || !held) deaths.push(...revealHeld(doc, manifest, slot, { keep: held }).deaths);
  // the first catch starts the rules where the bag couldn't tell (play view: startRules with the bag)
  if (caughtNew && beforeBalls(doc, manifest, slot)) startRules(doc, manifest, slot, 'catch');
  let failed = null;
  // (a death of this pass took the last life – any mode; markDead ended the run already)
  const reason = doc.get('run:status', null)?.reason;
  if (auto && !statusBefore && reason === 'lives') failed = 'lives';
  else if (solo && auto && !statusBefore) {
    if (reason === 'deathless' || reason === 'blackout') failed = reason; // (a held death revealed with its whiteout)
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

/** Convert a parsed DS save (shared/gen4save.mjs, shared/live/parse.mjs readSaveFile) into a snapshot. */
export function snapshotFromSave(save) {
  const norm = (m) => ({ ...m, item: m.heldItem });
  // A failed PK4 checksum is a Bad Egg / damaged slot: its species and key are garbage, not a catch.
  const ok = (m) => m.checksumOk !== false;
  return {
    source: 'save',
    party: save.party.filter(ok).map(norm),
    boxes: save.boxes ? save.boxes.filter(ok).map(norm) : null, // (null: its PC couldn't be read)
    badges: save.badges.count,
    trainer: save.trainer.name,
    playTime: save.playTime,
  };
}
