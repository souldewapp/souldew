// Trophies: the cross-run Pokédex, achievements and medals. Pure functions only – the server feeds them the run
// docs (server/lib/trophies.mjs), the tests feed them synthetic histories, the page only renders the result.
//
// The pipeline:  run doc ({key:{v,t,by}}) + manifest + "my" slot  →  digestRun()  →  a small per-run history
//                every digest + live moments                      →  buildDex() / evaluate() / medals()
// A digest only holds what the run doc really records (catches, deaths with their killer, badges, the run's end,
// evolutions, cheats, the last live party), so every achievement here is one the app can actually detect.

/** National dex ranges by generation – the "regional" dexes of the games souldew plays. */
export const GENERATIONS = [
  { gen: 1, region: 'Kanto', from: 1, to: 151 },
  { gen: 2, region: 'Johto', from: 152, to: 251 },
  { gen: 3, region: 'Hoenn', from: 252, to: 386 },
  { gen: 4, region: 'Sinnoh', from: 387, to: 493 },
  { gen: 5, region: 'Unova', from: 494, to: 649 },
  { gen: 6, region: 'Kalos', from: 650, to: 721 },
  { gen: 7, region: 'Alola', from: 722, to: 809 },
  { gen: 8, region: 'Galar', from: 810, to: 905 },
  { gen: 9, region: 'Paldea', from: 906, to: 1025 },
];
export const MAX_SPECIES = 1025;
/** The newest species a game souldew supports can hold (Gen 1–7: GB, GBC, GBA, DS, 3DS). */
export const SUPPORTED_MAX = 809;
/** The generations souldew's games cover. */
export const PLAYABLE_GENS = GENERATIONS.filter((g) => g.to <= SUPPORTED_MAX).map((g) => g.gen);
export const genOfSpecies = (id) => GENERATIONS.find((g) => id >= g.from && id <= g.to)?.gen || null;
export const obtainable = (id) => id >= 1 && id <= SUPPORTED_MAX;

const LEGENDARY = new Set([144, 145, 146, 150, 151, 243, 244, 245, 249, 250, 251, 377, 378, 379, 380, 381, 382, 383, 384, 385, 386,
  480, 481, 482, 483, 484, 485, 486, 487, 488, 489, 490, 491, 492, 493, 494, 638, 639, 640, 641, 642, 643, 644, 645, 646, 647, 648, 649,
  716, 717, 718, 719, 720, 721, 772, 773, 785, 786, 787, 788, 789, 790, 791, 792, 793, 794, 795, 796, 797, 798, 799, 800, 801, 802, 803,
  804, 805, 806, 807, 808, 809, 888, 889, 890, 891, 892, 893, 894, 895, 896, 897, 898, 905, 1001, 1002, 1003, 1004, 1007, 1008, 1009,
  1010, 1014, 1015, 1016, 1017, 1024, 1025]);
export const isLegendary = (id) => LEGENDARY.has(id);
/**
 * Mythicals the Gen 1–7 games only hand out at events (Mew, Celebi, Jirachi, Deoxys, Phione, Manaphy, Darkrai,
 * Shaymin, Arceus, Victini, Keldeo, Meloetta, Genesect, Diancie, Hoopa, Volcanion, Magearna, Marshadow, Zeraora) and
 * Meltan/Melmetal (Pokémon GO only): a Nuzlocke can't catch them, so the "complete" goals and the dex medals leave
 * them out. Caught anyway (a randomizer drops them on routes), they still fill the Pokédex.
 */
export const EVENT_ONLY = new Set([151, 251, 385, 386, 489, 490, 491, 492, 493, 494, 647, 648, 649, 719, 720, 721, 801, 802, 807, 808, 809]);
/** How many species of from…to a run can really catch. */
export const catchableIn = (from, to) => to - from + 1 - [...EVENT_ONLY].filter((id) => id >= from && id <= to).length;
/** The three starters of each generation (first stage). */
export const STARTERS = [[1, 4, 7], [152, 155, 158], [252, 255, 258], [387, 390, 393], [495, 498, 501], [650, 653, 656], [722, 725, 728]];
const STARTER_LINES = new Set(STARTERS.flat().flatMap((id) => [id, id + 1, id + 2]));
const EEVEELUTIONS = [134, 135, 136, 196, 197, 470, 471, 700];
const FOSSILS = new Set([138, 139, 140, 141, 142, 345, 346, 347, 348, 408, 409, 410, 411, 564, 565, 566, 567, 696, 697, 698, 699]);
const BIDOOF = new Set([399, 400]);
const EXPLODERS = new Set([74, 75, 100, 101]); // Geodude, Graveler, Voltorb, Electrode – Selfdestruct / Explosion
const ROAMERS = new Set([243, 244, 245, 380, 381, 481, 488, 641, 642]); // they flee on turn one
const ROAMERS_XY = new Set([144, 145, 146]); // X/Y's legendary bird roams – in the other games it waits in its cave
const roams = (id, gen) => ROAMERS.has(id) || (gen === 6 && ROAMERS_XY.has(id));
const HOENN = /ruby|sapphire|emerald/i;
const CLASSIC_TYPES = ['normal', 'fire', 'water', 'grass', 'electric', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel'];

/** How close in time two deaths must be to count as one turn (a double battle, Explosion, Earthquake …). */
export const SAME_TURN_MS = 15000;

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const species = (x) => (Number.isInteger(x) && x >= 1 && x <= MAX_SPECIES ? x : null);
const str = (x, n = 80) => (typeof x === 'string' ? x.slice(0, n) : '');
const time = (x) => {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  const v = Date.parse(x || '');
  return Number.isFinite(v) ? v : null;
};

/**
 * Reduce one run to what the trophies need. `entries`: the run doc ({ key: { v, t, by } }), `slot`: the player on
 * this computer, `opts.areaName(key, doc)`: optional name lookup for areas without one in the doc (curated routes).
 */
export function digestRun(manifest, entries, slot, opts = {}) {
  const doc = {};
  for (const [k, e] of Object.entries(entries || {})) if (e && typeof e === 'object' && e.v !== null && e.v !== undefined) doc[k] = e.v;
  const mode = manifest?.mode === 'nuzlocke' ? 'nuzlocke' : 'soullink';
  const slots = mode === 'nuzlocke' ? ['p1'] : ['p1', 'p2', 'p3', 'p4'].filter((s, i) => i < 2 || manifest?.players?.[s]);
  const me = slots.includes(slot) ? slot : 'p1';
  const names = {};
  for (const s of slots) names[s] = str(doc[`player:${s}`]?.name || manifest?.players?.[s]?.name || s.toUpperCase(), 40);
  const areaName = (key) => (key === 'starter' ? '' : str(doc[`area:${key}`]?.name) || str(opts.areaName?.(key)) || key);

  // feed: the original species of each catch (every player's – a SoulLink twin is judged by what both caught),
  // evolutions, badges, cheats
  const firstOf = {}; // slot → area → { species, at }
  const evolved = [];
  const badgeTimes = [];
  let cheats = 0;
  for (const [k, f] of Object.entries(doc)) {
    if (!k.startsWith('feed:') || !f || typeof f !== 'object') continue;
    const at = num(f.at);
    if (f.type === 'catch' && f.area && species(f.species) && slots.includes(f.slot)) {
      const mine = (firstOf[f.slot] ||= {});
      const prev = mine[f.area];
      if (!prev || (at && at < prev.at)) mine[f.area] = { species: f.species, at };
    }
    if (f.slot !== me) continue;
    if (f.type === 'evolve') {
      const from = species(f.msg?.vars?.from?.species);
      const to = species(f.msg?.vars?.to?.species);
      if (to) evolved.push({ area: str(f.area), from, to, at });
    } else if (f.type === 'badge') {
      const n = Number(f.msg?.vars?.n);
      if (Number.isInteger(n) && n >= 1 && n <= 16) badgeTimes.push({ n, at });
    } else if (f.type === 'cheat' && f.cheat === 'rareCandy') cheats += Math.max(0, Number(f.count) || 0);
  }
  const firstSpecies = firstOf[me] || {};
  // one evolution per step of a Pokémon: a reloaded savestate turns it back (Charmeleon → Charmander) and evolves it
  // again – only a species the Pokémon never was before counts, once
  const evolutions = [];
  const wasBefore = {};
  for (const e of evolved.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))) {
    const seen = (wasBefore[e.area] ||= new Set([firstSpecies[e.area]?.species].filter(Boolean)));
    if (e.from) seen.add(e.from);
    if (seen.has(e.to)) continue;
    seen.add(e.to);
    evolutions.push(e);
  }
  // one time per badge number (a reloaded savestate can announce a badge again: the first one counts)
  const badgeAt = {};
  for (const b of badgeTimes) if (!badgeAt[b.n] || (b.at && b.at < badgeAt[b.n])) badgeAt[b.n] = b.at;

  const catches = [];
  const missed = [];
  const partners = [];
  for (const [k, e] of Object.entries(doc)) {
    const m = /^enc:(.+):(p[1-4])$/.exec(k);
    if (!m || !e || typeof e !== 'object') continue;
    const [, area, s] = m;
    const pair = doc[`pair:${area}`];
    const dead = pair?.state === 'dead';
    if (s !== me) {
      if (e.outcome === 'caught' && species(e.species)) partners.push({ slot: s, area, species: e.species, first: firstOf[s]?.[area]?.species || e.species, shiny: !!e.shiny, nickname: str(e.nickname, 20), level: num(e.level), at: num(e.at), dead });
      continue;
    }
    if (e.outcome === 'missed') {
      missed.push({ area, species: species(e.species), at: num(e.at) });
      continue;
    }
    if (e.outcome !== 'caught' || !species(e.species)) continue;
    const first = firstSpecies[area]?.species || e.species;
    catches.push({
      area, areaName: areaName(area), species: e.species, first, nickname: str(e.nickname, 20), level: num(e.level), metLevel: num(e.metLevel),
      shiny: !!e.shiny, at: num(e.at) ?? firstSpecies[area]?.at ?? null, dead,
      // (a SoulLink death on the partner's side: the link is dead, but the killer and level are the partner's Pokémon's)
      ...(dead ? { diedAt: num(pair.diedAt), by: str(pair.by, 4) || null, segment: pair.segment ?? null,
        ...(pair.by && pair.by !== me ? { deathLevel: null, killer: null } : { deathLevel: num(pair.level), killer: pair.killer && species(pair.killer.species) ? { species: pair.killer.species, level: num(pair.killer.level), kind: pair.killer.kind === 'trainer' ? 'trainer' : pair.killer.kind === 'wild' ? 'wild' : null } : null }) } : {}),
    });
  }
  // bonus Pokémon of a solo run (gifts, trades, bonus catches kept outside the route list)
  for (const [k, x] of Object.entries(doc)) {
    if (!k.startsWith(`extra:${me}:`) || !x || !species(x.species)) continue;
    catches.push({ area: null, areaName: '', species: x.species, first: x.species, nickname: str(x.nickname || x.nick, 20), level: num(x.level), metLevel: null,
      shiny: !!x.shiny, at: num(x.at), dead: !!x.dead, extra: true, ...(x.dead ? { diedAt: num(x.diedAt) } : {}) });
  }
  catches.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  // deaths of every link of the run (also the partner's half – it is one death in a SoulLink)
  const deaths = Object.entries(doc).filter(([k, p]) => k.startsWith('pair:') && p?.state === 'dead')
    .map(([k, p]) => ({ area: k.slice(5), at: num(p.diedAt), by: str(p.by, 4) || null }))
    // and the bonus Pokémon of a solo run that died (a gift Eevee lost is a death of the run)
    .concat(catches.filter((x) => x.extra && x.dead).map((x) => ({ area: null, at: x.diedAt ?? null, by: me })))
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));

  const lives = {};
  for (const s of slots) {
    const l = doc[`live:${s}`];
    if (!l || typeof l !== 'object') continue;
    lives[s] = {
      badges: Math.max(Number(l.badges) || 0, Number(l.badgesBest) || 0),
      party: (Array.isArray(l.party) ? l.party : []).filter((x) => x && !x.egg && species(x.species)).slice(0, 6)
        .map((x) => ({ species: x.species, level: num(x.level), hp: num(x.hp), maxHp: num(x.maxHp), area: x.area || null, nick: str(x.nick, 20) })),
    };
  }
  const st = doc['run:status'];
  const rules = doc.rules && typeof doc.rules === 'object' ? doc.rules : {};
  const bosses = Object.entries(doc).filter(([k, v]) => k.startsWith('boss:') && v).map(([k, v]) => ({ key: k.slice(5), at: num(v.at) }));
  const game = manifest?.game || {};
  const badges = Math.max(lives[me]?.badges || 0, ...Object.keys(badgeAt).map(Number), 0);
  return {
    id: str(manifest?.id, 16), name: str(manifest?.name, 80), mode, players: slots.length, me, names,
    gameId: str(game.id || manifest?.base?.gameId, 60) || null, gen: opts.gen || num(game.generation) || { gb: 1, gbc: 2, gba: 3, nds: 4, '3ds': 6 }[game.system] || null,
    randomized: manifest?.randomizer ? manifest.randomizer.enabled !== false : false, hack: !!(manifest?.patch || game.hackId),
    createdAt: time(manifest?.createdAt), attempt: Number(manifest?.attempt) || Number(/#(\d+)\s*$/.exec(manifest?.name || '')?.[1]) || 1,
    status: st?.state ? { state: st.state, reason: str(st.reason, 20) || null, at: num(st.at), by: str(st.by, 4) || null } : null,
    rules: { hardcore: rules.levelCaps === 'strict' && rules.noBattleItems === true && rules.setMode === true, levelCaps: !!rules.levelCaps, deathless: !!rules.deathless,
      // SoulLink's default type clause is 'global', a solo Nuzlocke's 'off' (shared/rules.mjs)
      typeClause: str(rules.typeClause, 10) || (mode === 'soullink' ? 'global' : 'off') },
    capBreaks: Object.keys(doc).filter((k) => k.startsWith(`capbreak:${me}:`)).length,
    badges, badgeAt, bosses, catches, missed, partners, deaths, evolutions, cheats, lives,
  };
}

// ---------------------------------------------------------------------------
// Pokédex

/**
 * The cross-run Pokédex: per species whether it was caught (also through evolving), seen (met in battle, got away,
 * caught by a partner, faced as a killer) and the user's history with it. `seen`: extra { species: firstSeenAt }
 * from the live tracking (wild and trainer battles).
 */
export function buildDex(digests, seen = {}) {
  const dex = {};
  const entry = (id) => (dex[id] ||= { caught: 0, shiny: 0, died: 0, seenAt: null, first: null, history: [] });
  const see = (id, at) => {
    if (!species(id)) return;
    const e = entry(id);
    if (e.seenAt === null || (at && at < e.seenAt)) e.seenAt = at || e.seenAt || 0;
  };
  for (const [id, at] of Object.entries(seen || {})) see(Number(id), num(at) || 0);
  for (const d of digests) {
    const run = { runId: d.id, runName: d.name, mode: d.mode };
    for (const c of d.catches) {
      // the species it was caught as, and every species it evolved into
      const line = [...new Set([c.first, ...d.evolutions.filter((x) => x.area && x.area === c.area).map((x) => x.to), c.species].filter(species))];
      for (const id of line) {
        const e = entry(id);
        const own = id === c.first;
        e.caught++;
        if (c.shiny) e.shiny++;
        if (c.dead && id === c.species) e.died++;
        see(id, c.at);
        const h = { ...run, at: c.at, area: c.area, areaName: c.areaName, nickname: c.nickname, level: c.level, shiny: c.shiny, dead: c.dead, evolved: !own, as: c.first };
        e.history.push(h);
        if (own && (!e.first || (c.at ?? Infinity) < (e.first.at ?? Infinity))) e.first = h;
      }
    }
    for (const m of d.missed) see(m.species, m.at);
    for (const p of d.partners) see(p.species, p.at);
    for (const c of d.catches) if (c.killer) see(c.killer.species, c.diedAt);
  }
  for (const e of Object.values(dex)) {
    e.history.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
    // evolved-only species: the first time it was owned counts as its first catch
    if (!e.first && e.history.length) e.first = e.history[0];
    e.history = e.history.slice(0, 40);
  }
  return dex;
}

export function dexTotals(dex) {
  const caught = Object.entries(dex).filter(([, e]) => e.caught > 0).map(([id]) => Number(id));
  const seen = Object.entries(dex).filter(([, e]) => e.seenAt !== null || e.caught > 0).length;
  const perGen = GENERATIONS.map((g) => ({ gen: g.gen, region: g.region, total: g.to - g.from + 1, caught: caught.filter((id) => id >= g.from && id <= g.to).length, supported: g.to <= SUPPORTED_MAX,
    goal: catchableIn(g.from, g.to), caughtGoal: caught.filter((id) => id >= g.from && id <= g.to && !EVENT_ONLY.has(id)).length }));
  return { caught: caught.length, seen, shiny: Object.values(dex).reduce((a, e) => a + (e.shiny > 0 ? 1 : 0), 0), obtainable: SUPPORTED_MAX, perGen };
}

// ---------------------------------------------------------------------------
// Achievements

export const CATEGORIES = ['journey', 'collection', 'skill', 'soullink', 'randomizer', 'fun'];
export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** The k-th smallest time of a list (when a counted goal was reached) – null when unknown. */
const nth = (times, k) => {
  const t = times.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  return t.length >= k ? t[k - 1] : null;
};
const count = (n, times, target) => ({ n, at: n >= target ? nth(times, target) : null });
const flag = (hit) => (hit ? { n: 1, at: hit.at ?? null } : { n: 0 });
const firstBy = (list, fn) => {
  const hits = list.filter(fn).sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
  return hits[0] || null;
};
const won = (d) => d.status?.state === 'won';
const failed = (d) => d.status?.state === 'failed';
const myDeaths = (d) => d.catches.filter((c) => c.dead);
const topLevel = (party) => Math.max(0, ...(party || []).map((m) => m.level || 0));

/** Shared numbers the rules read – built once per evaluation. */
export function context(digests, moments = [], { dex = buildDex(digests), typesOf = null, isDefaultName = null } = {}) {
  const catches = digests.flatMap((d) => d.catches.map((c) => ({ ...c, run: d })));
  const caughtAt = {};
  for (const [id, e] of Object.entries(dex)) if (e.caught > 0) caughtAt[id] = e.first?.at ?? null;
  return { digests, moments, dex, catches, caughtAt, typesOf, isDefaultName,
    momentsOf: (type) => moments.filter((m) => m?.type === type) };
}

// `catchable`: leave the event-only mythicals out (the "complete" goals); plain species counts take every catch
const dexCount = (ctx, from, to, catchable = false) => {
  const ids = Object.keys(ctx.caughtAt).map(Number).filter((id) => id >= from && id <= to && !(catchable && EVENT_ONLY.has(id)));
  return { n: ids.length, times: ids.map((id) => ctx.caughtAt[id]) };
};
const dexGoal = (from, to) => (ctx) => {
  const { n, times } = dexCount(ctx, from, to, true);
  return count(n, times, catchableIn(from, to));
};
const speciesGoal = (target, max = SUPPORTED_MAX) => (ctx) => {
  const { n, times } = dexCount(ctx, 1, max);
  return count(n, times, target);
};

/** Badge n earned in run d with no death of the run between badge n-1 (or the start) and badge n. */
function cleanBadges(d) {
  const out = [];
  const order = Object.keys(d.badgeAt).map(Number).sort((a, b) => a - b);
  for (const n of order) {
    const end = d.badgeAt[n];
    const start = n === 1 ? d.createdAt ?? 0 : d.badgeAt[n - 1];
    if (!end || start === undefined || start === null) continue;
    if (!d.catches.some((c) => (c.at ?? Infinity) < end)) continue; // a team to keep alive first
    if (!d.deaths.some((x) => x.at && x.at > start && x.at <= end)) out.push({ n, at: end });
  }
  return out;
}

/**
 * Every achievement: id, category, rarity, target (counted ones) and the rule. A rule returns { n, at }: the progress
 * (n ≥ target → unlocked) and, where the data tells, when it was reached. `hidden`: secret until unlocked.
 * Names and descriptions live in the page (web/lib/trophytexts.mjs), in every language.
 */
export const ACHIEVEMENTS = [
  // ---- journey -------------------------------------------------------------
  { id: 'firstRun', cat: 'journey', rarity: 'common', check: (c) => count(c.digests.length, c.digests.map((d) => d.createdAt), 1) },
  { id: 'firstCatch', cat: 'journey', rarity: 'common', check: (c) => count(c.catches.length, c.catches.map((x) => x.at), 1) },
  { id: 'catches50', cat: 'journey', rarity: 'uncommon', target: 50, check: (c) => count(c.catches.length, c.catches.map((x) => x.at), 50) },
  { id: 'catches250', cat: 'journey', rarity: 'epic', target: 250, check: (c) => count(c.catches.length, c.catches.map((x) => x.at), 250) },
  { id: 'firstBadge', cat: 'journey', rarity: 'common', check: (c) => flag(firstBy(c.digests.filter((d) => d.badges >= 1).map((d) => ({ at: d.badgeAt[1] ?? null })), () => true)) },
  { id: 'badges8', cat: 'journey', rarity: 'rare', target: 8, check: (c) => {
    const best = Math.max(0, ...c.digests.map((d) => d.badges));
    return { n: Math.min(best, 8), at: best >= 8 ? nth(c.digests.filter((d) => d.badges >= 8).map((d) => d.badgeAt[8] ?? null), 1) : null };
  } },
  { id: 'badges16', cat: 'journey', rarity: 'epic', target: 16, check: (c) => {
    const best = Math.max(0, ...c.digests.map((d) => d.badges));
    return { n: Math.min(best, 16), at: best >= 16 ? nth(c.digests.map((d) => d.badgeAt[16] ?? null), 1) : null };
  } },
  { id: 'badges50', cat: 'journey', rarity: 'rare', target: 50, check: (c) => count(c.digests.reduce((a, d) => a + d.badges, 0), c.digests.flatMap((d) => Object.values(d.badgeAt)), 50) },
  { id: 'firstWin', cat: 'journey', rarity: 'rare', check: (c) => flag(firstBy(c.digests.filter(won).map((d) => d.status), () => true)) },
  { id: 'winSoulLink', cat: 'journey', rarity: 'rare', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && d.mode === 'soullink').map((d) => d.status), () => true)) },
  { id: 'winNuzlocke', cat: 'journey', rarity: 'rare', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && d.mode === 'nuzlocke').map((d) => d.status), () => true)) },
  { id: 'wins5', cat: 'journey', rarity: 'epic', target: 5, check: (c) => count(c.digests.filter(won).length, c.digests.filter(won).map((d) => d.status.at), 5) },
  { id: 'runs10', cat: 'journey', rarity: 'uncommon', target: 10, check: (c) => count(c.digests.length, c.digests.map((d) => d.createdAt), 10) },
  { id: 'allGens', cat: 'journey', rarity: 'epic', target: PLAYABLE_GENS.length, check: (c) => {
    const gens = PLAYABLE_GENS.map((g) => nth(c.digests.filter((d) => d.gen === g).map((d) => d.createdAt), 1) ?? (c.digests.some((d) => d.gen === g) ? 0 : null));
    return count(gens.filter((x) => x !== null).length, gens.map((x) => x || null), PLAYABLE_GENS.length);
  } },
  { id: 'level100', cat: 'journey', rarity: 'epic', check: (c) => flag(firstBy(c.catches, (x) => (x.level || 0) >= 100) && { at: null }) },
  { id: 'firstEvolution', cat: 'journey', rarity: 'common', check: (c) => { const ev = c.digests.flatMap((d) => d.evolutions); return count(ev.length, ev.map((x) => x.at), 1); } },
  { id: 'evolutions25', cat: 'journey', rarity: 'uncommon', target: 25, check: (c) => { const ev = c.digests.flatMap((d) => d.evolutions); return count(ev.length, ev.map((x) => x.at), 25); } },
  { id: 'hardcoreWin', cat: 'journey', rarity: 'legendary', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && d.mode === 'nuzlocke' && d.rules.hardcore).map((d) => d.status), () => true)) },

  // ---- collection ----------------------------------------------------------
  { id: 'dex10', cat: 'collection', rarity: 'common', target: 10, check: speciesGoal(10) },
  { id: 'dex50', cat: 'collection', rarity: 'uncommon', target: 50, check: speciesGoal(50) },
  { id: 'dex100', cat: 'collection', rarity: 'rare', target: 100, check: speciesGoal(100) },
  { id: 'dex250', cat: 'collection', rarity: 'epic', target: 250, check: speciesGoal(250) },
  { id: 'dex500', cat: 'collection', rarity: 'legendary', target: 500, check: speciesGoal(500) },
  { id: 'dexKanto', cat: 'collection', rarity: 'epic', target: catchableIn(1, 151), check: dexGoal(1, 151) },
  { id: 'dexJohto', cat: 'collection', rarity: 'epic', target: catchableIn(152, 251), check: dexGoal(152, 251) },
  { id: 'dexHoenn', cat: 'collection', rarity: 'epic', target: catchableIn(252, 386), check: dexGoal(252, 386) },
  { id: 'dexSinnoh', cat: 'collection', rarity: 'epic', target: catchableIn(387, 493), check: dexGoal(387, 493) },
  { id: 'dexUnova', cat: 'collection', rarity: 'epic', target: catchableIn(494, 649), check: dexGoal(494, 649) },
  { id: 'dexKalos', cat: 'collection', rarity: 'epic', target: catchableIn(650, 721), check: dexGoal(650, 721) },
  { id: 'dexAlola', cat: 'collection', rarity: 'epic', target: catchableIn(722, 809), check: dexGoal(722, 809) },
  { id: 'dexNational', cat: 'collection', rarity: 'legendary', target: catchableIn(1, SUPPORTED_MAX), check: dexGoal(1, SUPPORTED_MAX) },
  { id: 'seen100', cat: 'collection', rarity: 'uncommon', target: 100, check: (c) => {
    const s = Object.values(c.dex).filter((e) => e.seenAt !== null || e.caught > 0);
    return count(s.length, s.map((e) => e.seenAt || e.first?.at || null), 100);
  } },
  { id: 'firstShiny', cat: 'collection', rarity: 'rare', check: (c) => { const s = c.catches.filter((x) => x.shiny); return count(s.length, s.map((x) => x.at), 1); } },
  { id: 'shiny5', cat: 'collection', rarity: 'legendary', target: 5, check: (c) => { const s = c.catches.filter((x) => x.shiny); return count(s.length, s.map((x) => x.at), 5); } },
  { id: 'legendary', cat: 'collection', rarity: 'rare', check: (c) => { const l = Object.keys(c.caughtAt).map(Number).filter(isLegendary); return count(l.length, l.map((id) => c.caughtAt[id]), 1); } },
  { id: 'legendary5', cat: 'collection', rarity: 'epic', target: 5, check: (c) => { const l = Object.keys(c.caughtAt).map(Number).filter(isLegendary); return count(l.length, l.map((id) => c.caughtAt[id]), 5); } },
  { id: 'starterTrio', cat: 'collection', rarity: 'uncommon', check: (c) => {
    const done = STARTERS.map((trio) => (trio.every((id) => id in c.caughtAt) ? Math.max(...trio.map((id) => c.caughtAt[id] || 0)) || null : undefined)).filter((x) => x !== undefined);
    return done.length ? { n: 1, at: nth(done, 1) } : { n: 0 };
  } },
  { id: 'eevee', cat: 'collection', rarity: 'rare', target: 5, check: (c) => { const e = EEVEELUTIONS.filter((id) => id in c.caughtAt); return count(e.length, e.map((id) => c.caughtAt[id]), 5); } },
  { id: 'fossil', cat: 'collection', rarity: 'uncommon', check: (c) => { const f = Object.keys(c.caughtAt).map(Number).filter((id) => FOSSILS.has(id)); return count(f.length, f.map((id) => c.caughtAt[id]), 1); } },
  { id: 'allTypes', cat: 'collection', rarity: 'rare', target: CLASSIC_TYPES.length, check: (c) => {
    if (!c.typesOf) return { n: 0 };
    const first = {};
    for (const [id, at] of Object.entries(c.caughtAt)) for (const ty of c.typesOf(Number(id)) || []) if (CLASSIC_TYPES.includes(ty) && (!(ty in first) || (at && at < first[ty]))) first[ty] = at;
    return count(Object.keys(first).length, Object.values(first), CLASSIC_TYPES.length);
  } },
  // one Zubat per run at most under the dupes clause – so it counts runs, not catches
  { id: 'zubat', cat: 'collection', rarity: 'uncommon', target: 5, check: (c) => {
    const runs = {};
    for (const x of c.catches) if (x.first === 41 && (!(x.run.id in runs) || (x.at && x.at < runs[x.run.id]))) runs[x.run.id] = x.at ?? null;
    return count(Object.keys(runs).length, Object.values(runs), 5);
  } },

  // ---- skill ---------------------------------------------------------------
  { id: 'cleanBadge', cat: 'skill', rarity: 'uncommon', check: (c) => flag(firstBy(c.digests.flatMap(cleanBadges), () => true)) },
  { id: 'cleanFour', cat: 'skill', rarity: 'rare', check: (c) => flag(firstBy(c.digests.map((d) => {
    const clean = cleanBadges(d).map((b) => b.n);
    return [1, 2, 3, 4].every((n) => clean.includes(n)) ? { at: d.badgeAt[4] } : null;
  }).filter(Boolean), () => true)) },
  { id: 'deathlessWin', cat: 'skill', rarity: 'legendary', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && d.deaths.length === 0 && d.catches.length > 0).map((d) => d.status), () => true)) },
  { id: 'lowDeathWin', cat: 'skill', rarity: 'epic', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && d.deaths.length <= 3 && d.catches.length > 0).map((d) => d.status), () => true)) },
  { id: 'underdog', cat: 'skill', rarity: 'rare', check: (c) => { const u = c.momentsOf('badge').filter((m) => m.cap && m.top && m.top < m.cap); return count(u.length, u.map((m) => m.at), 1); } },
  { id: 'underdog3', cat: 'skill', rarity: 'epic', target: 3, check: (c) => { const u = c.momentsOf('badge').filter((m) => m.cap && m.top && m.top < m.cap); return count(u.length, u.map((m) => m.at), 3); } },
  { id: 'oneHp', cat: 'skill', rarity: 'rare', check: (c) => { const h = c.momentsOf('hp1'); return count(h.length, h.map((m) => m.at), 1); } },
  { id: 'veteran', cat: 'skill', rarity: 'rare', check: (c) => flag(firstBy(c.catches, (x) => x.metLevel !== null && ((x.dead ? x.deathLevel ?? x.level : x.level) || 0) - x.metLevel >= 40) && { at: null }) },
  { id: 'starterSurvives', cat: 'skill', rarity: 'rare', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && d.catches.some((x) => x.area === 'starter' && !x.dead)).map((d) => d.status), () => true)) },
  { id: 'monotype', cat: 'skill', rarity: 'epic', check: (c) => {
    // a type clause forbids two of a type in the team – a monotype team there would break the rules
    const m = c.momentsOf('monotype').filter((x) => (c.digests.find((d) => d.id === x.runId)?.rules.typeClause ?? 'off') === 'off');
    return count(m.length, m.map((x) => x.at), 1);
  } },
  { id: 'byTheBook', cat: 'skill', rarity: 'epic', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && d.mode === 'nuzlocke' && d.rules.levelCaps && d.capBreaks === 0).map((d) => d.status), () => true)) },
  { id: 'fullTeamWin', cat: 'skill', rarity: 'uncommon', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && (d.lives[d.me]?.party || []).length >= 6).map((d) => d.status), () => true)) },
  { id: 'phoenix', cat: 'skill', rarity: 'epic', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && d.deaths.length >= 10).map((d) => d.status), () => true)) },
  { id: 'noCheatWin', cat: 'skill', rarity: 'uncommon', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && d.cheats === 0).map((d) => d.status), () => true)) },

  // ---- SoulLink ------------------------------------------------------------
  { id: 'firstLink', cat: 'soullink', rarity: 'common', check: (c) => { const r = c.digests.filter((d) => d.mode === 'soullink'); return count(r.length, r.map((d) => d.createdAt), 1); } },
  { id: 'soulmates', cat: 'soullink', rarity: 'rare', target: 10, check: (c) => { const r = c.digests.filter((d) => d.mode === 'soullink'); return count(r.length, r.map((d) => d.createdAt), 10); } },
  { id: 'soulTwins', cat: 'soullink', rarity: 'uncommon', check: (c) => { const t = twins(c); return count(t.length, t, 1); } },
  { id: 'telepathy', cat: 'soullink', rarity: 'epic', target: 5, check: (c) => { const t = twins(c); return count(t.length, t, 5); } },
  { id: 'doubleTrouble', cat: 'soullink', rarity: 'rare', check: (c) => flag(firstBy(c.digests.filter((d) => d.mode === 'soullink').flatMap((d) => sameTurn(d.deaths)), () => true)) },
  { id: 'carried', cat: 'soullink', rarity: 'rare', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && d.mode === 'soullink' && levelGap(d) <= -10).map((d) => d.status), () => true)) },
  { id: 'atlas', cat: 'soullink', rarity: 'rare', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && d.mode === 'soullink' && levelGap(d) >= 10).map((d) => d.status), () => true)) },
  { id: 'groupLink', cat: 'soullink', rarity: 'uncommon', check: (c) => { const r = c.digests.filter((d) => d.mode === 'soullink' && d.players >= 3); return count(r.length, r.map((d) => d.createdAt), 1); } },
  { id: 'fellowship', cat: 'soullink', rarity: 'epic', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && d.mode === 'soullink' && d.players >= 3).map((d) => d.status), () => true)) },
  { id: 'jealous', cat: 'soullink', rarity: 'rare', check: (c) => { const s = c.digests.flatMap((d) => d.partners.filter((p) => p.shiny)); return count(s.length, s.map((p) => p.at), 1); } },
  { id: 'unbreakable', cat: 'soullink', rarity: 'epic', check: (c) => flag(firstBy(c.digests.filter((d) => d.mode === 'soullink' && d.badges >= 8 && d.badgeAt[1])
    .flatMap((d) => d.catches.filter((x) => !x.dead && x.at && x.at < d.badgeAt[1] && d.partners.some((p) => p.area === x.area && !p.dead)).map(() => ({ at: d.badgeAt[8] ?? null }))), () => true)) },
  { id: 'notMe', cat: 'soullink', rarity: 'uncommon', check: (c) => flag(firstBy(c.digests.filter((d) => d.mode === 'soullink' && d.deaths[0]?.by && d.deaths[0].by !== d.me).map((d) => d.deaths[0]), () => true)) },
  { id: 'tooSoon', cat: 'soullink', rarity: 'epic', hidden: true, check: (c) => flag(firstBy(c.digests.filter((d) => d.mode === 'soullink').flatMap((d) => {
    const partnerNames = Object.entries(d.names).filter(([s]) => s !== d.me).map(([, n]) => norm(n)).filter((n) => n.length >= 2);
    return d.catches.filter((x) => x.dead && x.nickname && partnerNames.some((n) => norm(x.nickname) === n || (n.length >= 3 && norm(x.nickname).startsWith(n)))).map((x) => ({ at: x.diedAt }));
  }), () => true)) },

  // ---- randomizer ----------------------------------------------------------
  { id: 'randoStart', cat: 'randomizer', rarity: 'common', check: (c) => { const r = c.digests.filter((d) => d.randomized); return count(r.length, r.map((d) => d.createdAt), 1); } },
  { id: 'rando10', cat: 'randomizer', rarity: 'rare', target: 10, check: (c) => { const r = c.digests.filter((d) => d.randomized); return count(r.length, r.map((d) => d.createdAt), 10); } },
  { id: 'randoWin', cat: 'randomizer', rarity: 'epic', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && d.randomized).map((d) => d.status), () => true)) },
  { id: 'randoLegend', cat: 'randomizer', rarity: 'epic', check: (c) => flag(firstBy(c.catches.filter((x) => x.run.randomized && isLegendary(x.first) && (x.metLevel ?? x.level ?? 99) <= 15), () => true)) },
  { id: 'randoDex', cat: 'randomizer', rarity: 'rare', target: 100, check: (c) => {
    const first = {};
    for (const x of c.catches) if (x.run.randomized && (!(x.first in first) || (x.at && x.at < first[x.first]))) first[x.first] = x.at;
    return count(Object.keys(first).length, Object.values(first), 100);
  } },
  { id: 'randoHack', cat: 'randomizer', rarity: 'uncommon', check: (c) => { const r = c.digests.filter((d) => d.randomized && d.hack); return count(r.length, r.map((d) => d.createdAt), 1); } },
  { id: 'vanillaWin', cat: 'randomizer', rarity: 'rare', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && !d.randomized).map((d) => d.status), () => true)) },
  { id: 'bothWorlds', cat: 'randomizer', rarity: 'epic', check: (c) => {
    const r = firstBy(c.digests.filter((d) => won(d) && d.randomized).map((d) => d.status), () => true);
    const v = firstBy(c.digests.filter((d) => won(d) && !d.randomized).map((d) => d.status), () => true);
    return r && v ? { n: 1, at: r.at && v.at ? Math.max(r.at, v.at) : null } : { n: 0 };
  } },

  // ---- fun -----------------------------------------------------------------
  { id: 'magikarp', cat: 'fun', rarity: 'epic', hidden: true, check: (c) => flag(firstBy(c.catches.filter((x) => x.killer?.species === 129).map((x) => ({ at: x.diedAt })), () => true)) },
  { id: 'rattata', cat: 'fun', rarity: 'uncommon', check: (c) => flag(firstBy(c.catches.filter((x) => [19, 20].includes(x.killer?.species)).map((x) => ({ at: x.diedAt })), () => true)) },
  { id: 'rival', cat: 'fun', rarity: 'uncommon', check: (c) => flag(firstBy(c.digests.flatMap((d) => d.catches.filter((x) => x.killer?.kind === 'trainer' && STARTER_LINES.has(x.killer.species) && (x.killer.level ?? 99) <= 12
    && beforeFirstBadge(d, x))).map((x) => ({ at: x.diedAt })), () => true)) },
  { id: 'starterDown', cat: 'fun', rarity: 'uncommon', check: (c) => flag(firstBy(c.digests.flatMap((d) => d.catches.filter((x) => x.area === 'starter' && x.dead && beforeFirstBadge(d, x))).map((x) => ({ at: x.diedAt })), () => true)) },
  { id: 'nuzlose', cat: 'fun', rarity: 'rare', target: 5, check: (c) => { const f = c.digests.filter((d) => d.mode === 'nuzlocke' && failed(d)); return count(f.length, f.map((d) => d.status.at), 5); } },
  { id: 'skillIssue', cat: 'fun', rarity: 'rare', hidden: true, check: (c) => flag(firstBy(c.digests.filter(failed).map((d) => {
    const last = [...myDeaths(d)].sort((a, b) => (b.diedAt ?? 0) - (a.diedAt ?? 0))[0];
    return last?.killer?.kind === 'trainer' && (last.killer.level ?? 99) < 10 ? { at: d.status.at } : null;
  }).filter(Boolean), () => true)) },
  { id: 'bloodbath', cat: 'fun', rarity: 'rare', check: (c) => flag(firstBy(c.digests.flatMap((d) => {
    const seg = {};
    for (const x of myDeaths(d)) (seg[x.segment ?? '?'] ||= []).push(x.diedAt);
    return Object.entries(seg).filter(([k, v]) => k !== '?' && v.length >= 6).map(([, v]) => ({ at: nth(v, 6) }));
  }), () => true)) },
  // one Bidoof in the winning team – six of them would clash with the dupes clause
  { id: 'bidoof', cat: 'fun', rarity: 'rare', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && (d.lives[d.me]?.party || []).some((m) => BIDOOF.has(m.species))).map((d) => d.status), () => true)) },
  { id: 'speedrun', cat: 'fun', rarity: 'rare', hidden: true, check: (c) => flag(firstBy(c.digests.filter((d) => failed(d) && d.createdAt && d.status.at && d.status.at - d.createdAt < 30 * 60000).map((d) => d.status), () => true)) },
  { id: 'cemetery', cat: 'fun', rarity: 'uncommon', target: 50, check: (c) => { const x = c.catches.filter((m) => m.dead); return count(x.length, x.map((m) => m.diedAt), 50); } },
  { id: 'lavender', cat: 'fun', rarity: 'epic', target: 100, check: (c) => { const x = c.catches.filter((m) => m.dead); return count(x.length, x.map((m) => m.diedAt), 100); } },
  { id: 'butterfingers', cat: 'fun', rarity: 'uncommon', target: 10, check: (c) => { const m = c.digests.flatMap((d) => d.missed); return count(m.length, m.map((x) => x.at), 10); } },
  { id: 'tenthTime', cat: 'fun', rarity: 'rare', check: (c) => flag(firstBy(c.digests.filter((d) => d.attempt >= 10).map((d) => ({ at: d.createdAt })), () => true)) },
  { id: 'glowUp', cat: 'fun', rarity: 'rare', hidden: true, check: (c) => flag(firstBy(c.digests.flatMap((d) => d.catches.filter((x) => x.dead && x.diedAt
    && d.evolutions.some((e) => e.area === x.area && e.at && x.diedAt - e.at >= 0 && x.diedAt - e.at < 10 * 60000)).map((x) => ({ at: x.diedAt }))), () => true)) },
  { id: 'nameGame', cat: 'fun', rarity: 'uncommon', target: 25, check: (c) => {
    const n = c.catches.filter((x) => x.nickname && c.isDefaultName && c.isDefaultName(x.species, x.nickname) === false && c.isDefaultName(x.first, x.nickname) === false);
    return count(n.length, n.map((x) => x.at), 25);
  } },
  { id: 'candyCrush', cat: 'fun', rarity: 'uncommon', target: 50, check: (c) => ({ n: c.digests.reduce((a, d) => a + d.cheats, 0), at: null }) },
  // ---- classic Pokémon memes (all from data the run doc records) ----
  { id: 'miltank', cat: 'fun', rarity: 'uncommon', check: (c) => flag(firstBy(killedBy(c, (k) => k.kind === 'trainer' && k.species === 241), () => true)) },
  { id: 'garchomp', cat: 'fun', rarity: 'uncommon', check: (c) => flag(firstBy(killedBy(c, (k) => k.kind === 'trainer' && k.species === 445), () => true)) },
  { id: 'kaboom', cat: 'fun', rarity: 'uncommon', check: (c) => flag(firstBy(killedBy(c, (k) => k.kind === 'wild' && EXPLODERS.has(k.species)), () => true)) },
  { id: 'teleport', cat: 'fun', rarity: 'common', check: (c) => flag(firstBy(c.digests.flatMap((d) => d.missed.filter((x) => x.species === 63)), () => true)) },
  { id: 'roamer', cat: 'fun', rarity: 'uncommon', check: (c) => flag(firstBy(c.digests.flatMap((d) => d.missed.filter((x) => roams(x.species, d.gen))), () => true)) },
  { id: 'shinyDown', cat: 'fun', rarity: 'rare', hidden: true, check: (c) => flag(firstBy(c.catches.filter((x) => x.dead && x.shiny).map((x) => ({ at: x.diedAt })), () => true)) },
  { id: 'gyarados', cat: 'collection', rarity: 'uncommon', check: (c) => flag(firstBy(c.digests.flatMap((d) => d.evolutions.filter((e) => e.from === 129 && e.to === 130)), () => true)) },
  { id: 'feebas', cat: 'collection', rarity: 'rare', check: (c) => flag(firstBy(c.catches.filter((x) => x.first === 349), () => true)) },
  { id: 'helix', cat: 'collection', rarity: 'uncommon', hidden: true, check: (c) => { const h = [138, 139].filter((id) => id in c.caughtAt); return count(h.length, h.map((id) => c.caughtAt[id]), 1); } },
  { id: 'birdJesus', cat: 'fun', rarity: 'rare', check: (c) => flag(firstBy(c.digests.filter((d) => won(d) && (d.lives[d.me]?.party || []).some((m) => m.species === 18)).map((d) => d.status), () => true)) },
  { id: 'tooMuchWater', cat: 'fun', rarity: 'rare', target: 6, check: (c) => {
    if (!c.typesOf) return { n: 0 };
    const runs = c.digests.filter((d) => HOENN.test(d.gameId || '')).map((d) => d.catches.filter((x) => (c.typesOf(x.species) || []).includes('water')));
    const best = runs.reduce((a, r) => (r.length > a.length ? r : a), []);
    return count(best.length, best.map((x) => x.at), 6);
  } },
  { id: 'nightOwl', cat: 'fun', rarity: 'uncommon', hidden: true, check: (c) => flag(firstBy(c.catches, (x) => x.at && [3, 4].includes(new Date(x.at).getHours()))) },
];

/** My Pokémon whose killer matches → [{ at }]. */
function killedBy(c, test) {
  return c.catches.filter((x) => x.dead && x.killer && test(x.killer)).map((x) => ({ at: x.diedAt }));
}
/**
 * A death before the run's first badge. Sun/Moon and Ultra Sun/Ultra Moon have island trials instead of gyms (no badges
 * read): there the first boss beaten is the cut-off – without one the death isn't judged (it may be at the Elite Four).
 */
function beforeFirstBadge(d, x) {
  const cut = d.badgeAt[1] ?? (d.gen >= 7 ? Math.min(...(d.bosses || []).map((b) => b.at ?? Infinity)) : null);
  if (cut === null || cut === undefined) return true;
  if (cut === Infinity) return false;
  return !!(x.diedAt && x.diedAt < cut);
}
function twins(c) {
  return c.digests.filter((d) => d.mode === 'soullink')
    .flatMap((d) => d.catches.filter((x) => x.area && d.partners.some((p) => p.area === x.area && (p.first || p.species) === x.first)).map((x) => x.at ?? 0));
}
/** Deaths of different links within SAME_TURN_MS: the time of the second one. */
function sameTurn(deaths) {
  const out = [];
  const list = deaths.filter((x) => x.at).sort((a, b) => a.at - b.at);
  for (let i = 1; i < list.length; i++) if (list[i].at - list[i - 1].at <= SAME_TURN_MS && list[i].area !== list[i - 1].area) out.push({ at: list[i].at });
  return out;
}
/** My strongest Pokémon minus the strongest of my partners' (last live parties); 0 when unknown. */
function levelGap(d) {
  const mine = topLevel(d.lives[d.me]?.party);
  const theirs = Math.max(0, ...Object.entries(d.lives).filter(([s]) => s !== d.me).map(([, l]) => topLevel(l.party)));
  return mine && theirs ? mine - theirs : 0;
}
const norm = (s) => String(s || '').normalize('NFC').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Evaluate every achievement → [{ id, cat, rarity, hidden, target, n, ok, at }]. */
export function evaluate(ctx) {
  return ACHIEVEMENTS.map((a) => {
    let r;
    try {
      r = a.check(ctx) || { n: 0 };
    } catch {
      r = { n: 0 };
    }
    const target = a.target || 1;
    const n = Math.max(0, Number(r.n) || 0);
    return { id: a.id, cat: a.cat, rarity: a.rarity, hidden: !!a.hidden, target, n: Math.min(n, target), ok: n >= target, at: n >= target ? r.at ?? null : null };
  });
}

// ---------------------------------------------------------------------------
// Medals (the badge case)

export const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'master'];

/**
 * Medals on top of the achievements and the dex: one per category (by the share of its achievements unlocked),
 * one per regional dex of a supported generation (by the share caught) and the champion's medal over everything.
 * Each → { id, kind, tier (-1 = none yet), value, steps: [thresholds of the five tiers], next }.
 */
export function medals(states, totals) {
  const out = [];
  const tierOf = (value, steps) => steps.reduce((tier, s, i) => (value >= s ? i : tier), -1);
  for (const cat of CATEGORIES) {
    const list = states.filter((s) => s.cat === cat);
    const open = list.filter((s) => !s.hidden);
    const got = list.filter((s) => s.ok).length;
    const gotOpen = open.filter((s) => s.ok).length;
    // platinum needs every open one, master the secret ones too: secret ones count towards the lower tiers, but never
    // past "one open one missing" – the value shown is the one the tiers use
    const value = gotOpen < open.length ? Math.min(got, open.length - 1) : got;
    // (a category without secret ones: master is all of them, platinum a step of its own before – else the ladder
    // promised platinum and jumped to master)
    const gold = Math.ceil(open.length * 0.7);
    const platinum = list.length > open.length ? open.length : Math.min(list.length - 1, Math.max(gold + 1, Math.ceil(open.length * 0.9)));
    const steps = [1, Math.ceil(open.length * 0.35), gold, platinum, list.length];
    const tier = tierOf(value, steps);
    out.push({ id: `cat-${cat}`, kind: 'category', cat, tier, value, total: list.length, steps });
  }
  for (const g of totals.perGen.filter((x) => x.supported)) {
    const goal = g.goal ?? g.total;
    const value = g.caughtGoal ?? g.caught;
    const steps = [0.1, 0.35, 0.7, 0.9, 1].map((f) => Math.ceil(goal * f));
    out.push({ id: `dex-${g.gen}`, kind: 'dex', gen: g.gen, region: g.region, tier: tierOf(value, steps), value, total: goal, steps });
  }
  const got = states.filter((s) => s.ok).length;
  const steps = [0.2, 0.4, 0.6, 0.8, 1].map((f) => Math.ceil(states.length * f));
  out.push({ id: 'champion', kind: 'champion', tier: tierOf(got, steps), value: got, total: states.length, steps });
  return out;
}

/** Points per rarity – the score on the trophy page. */
export const POINTS = { common: 10, uncommon: 25, rare: 50, epic: 100, legendary: 250 };

// ---------------------------------------------------------------------------
// The stored state (server/lib/trophies.mjs keeps it in the data folder)

export const SCHEMA = 1;
const MOMENT_TYPES = new Set(['hp1', 'badge', 'monotype']);
export const MAX_MOMENTS = 400;

/** One live moment from the page, cleaned – or null. */
export function cleanMoment(m) {
  if (!m || typeof m !== 'object' || !MOMENT_TYPES.has(m.type)) return null;
  const out = { type: m.type, at: num(m.at) || Date.now(), runId: /^[a-f0-9]{8}$/.test(m.runId || '') ? m.runId : null };
  if (species(m.species)) out.species = m.species;
  if (m.type === 'badge') {
    const n = Number(m.n);
    if (!Number.isInteger(n) || n < 1 || n > 16) return null;
    out.n = n;
    out.top = Number.isInteger(m.top) && m.top >= 1 && m.top <= 100 ? m.top : null;
    out.cap = Number.isInteger(m.cap) && m.cap >= 1 && m.cap <= 100 ? m.cap : null;
  }
  if (m.type === 'monotype' && typeof m.ptype === 'string') out.ptype = m.ptype.slice(0, 12);
  return out;
}

/** Same moment twice (the page sends what it saw since the last sync; a reload can repeat it). */
export const momentKey = (m) => `${m.type}:${m.runId || ''}:${m.type === 'badge' ? m.n : m.species || m.ptype || ''}`;

/**
 * A stored state from disk, upgraded to the current schema – anything unreadable starts afresh. Unknown fields of
 * a newer version are kept, so going back to an older app and forward again loses nothing.
 */
export function migrate(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  return {
    ...s,
    schema: Math.max(SCHEMA, Number(s.schema) || 0),
    slots: obj(s.slots),
    runs: obj(s.runs),
    seen: obj(s.seen),
    moments: Array.isArray(s.moments) ? s.moments.map(cleanMoment).filter(Boolean).slice(-MAX_MOMENTS) : [],
    unlocked: obj(s.unlocked),
    backfilledAt: num(s.backfilledAt),
  };
}
