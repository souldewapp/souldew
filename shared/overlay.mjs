// Stream overlays (OBS browser sources, web/overlay.html): the data the server hands out for them and the pure
// helpers that turn it into teams, linked groups, counters and alerts. Shared by the server (server/app.mjs,
// /api/runs/:id/overlay and its event stream), the overlay page and test/overlay.test.mjs.
//
// A snapshot holds what an overlay may show – and nothing else: no room key or secret, no file names, no device
// ids, no spoiler data. The server pushes a fresh one whenever the run's doc changes.

import { PROGRESSION } from './routes.mjs';
import { slotsOf, runMode } from './slots.mjs';

export const OVERLAY_FEED = 30; // newest log entries in a snapshot (alerts only need the latest ones)
export const WIDGETS = ['team', 'card', 'counters', 'where', 'alerts', 'stats', 'popup'];
/** The Pokémon a test alert may show beyond the run's own (Pikachu, Eevee → Umbreon, the killer Miltank). */
export const TEST_SPECIES = [25, 133, 197, 241];
const GEN = { gb: 1, gbc: 2, gba: 3, nds: 4 };
const KEEP = ['player:', 'live:', 'party:', 'enc:', 'pair:', 'where:'];

/** The run's generation: its game's system, else the base ROM's file extension (older manifests), else 4. */
export function runGen(manifest) {
  if (GEN[manifest?.game?.system]) return GEN[manifest.game.system];
  const ext = String(manifest?.base?.name || '').toLowerCase().match(/\.(gbc|gba|gb|nds)$/)?.[1];
  return GEN[ext] || 4;
}

const num = (v) => (Number.isFinite(v) ? v : null);
const int = (v) => (Number.isInteger(v) ? v : null);
const str = (v, n = 24) => (typeof v === 'string' ? v.slice(0, n) : '');

function liteMon(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    key: str(m.key, 40), area: m.area ? str(m.area, 60) : null, species: int(m.species), nick: str(m.nick), level: int(m.level),
    hp: num(m.hp), maxHp: num(m.maxHp), status: typeof m.status === 'string' || Number.isInteger(m.status) ? m.status : 0, shiny: !!m.shiny,
    ...(m.egg ? { egg: true } : {}),
  };
}

const LITE = {
  'player:': (v) => ({ name: str(v.name) }),
  'live:': (v) => ({
    badges: int(v.badges),
    playTime: typeof v.playTime === 'number' ? v.playTime : v.playTime && typeof v.playTime === 'object' ? { h: int(v.playTime.h), m: int(v.playTime.m) } : null,
    party: (Array.isArray(v.party) ? v.party : []).slice(0, 6).map(liteMon).filter(Boolean),
    at: num(v.at), ...(v.downAt ? { downAt: num(v.downAt) } : {}),
  }),
  'party:': (v) => (Array.isArray(v) ? v.slice(0, 6).map((a) => str(a, 60)) : []),
  'enc:': (v) => ({ outcome: str(v.outcome, 12), species: int(v.species), level: int(v.level), nickname: str(v.nickname), shiny: !!v.shiny }),
  'pair:': (v) => ({ state: str(v.state, 12), diedAt: num(v.diedAt), level: int(v.level), ...(v.killer?.species ? { killer: { species: int(v.killer.species), level: int(v.killer.level), kind: str(v.killer.kind, 10) } } : {}) }),
  'where:': (v) => ({
    gen: int(v.gen), id: int(v.id), name: str(v.name, 40), at: num(v.at),
    ...(v.fight && typeof v.fight === 'object' ? { fight: { kind: str(v.fight.kind, 10), species: int(v.fight.species), level: int(v.fight.level) } } : {}),
  }),
};

function liteFeed(v) {
  const n = v?.msg?.vars?.n;
  return {
    at: num(v.at), type: str(v.type, 12), slot: str(v.slot, 2), area: v.area ? str(v.area, 60) : null, species: int(v.species),
    ...(Number.isInteger(n) ? { n } : {}), ...(v.type === 'evolve' ? { from: int(v.msg?.vars?.from?.species), to: int(v.msg?.vars?.to?.species) } : {}),
  };
}

/**
 * Display name of an area key: the doc's own area entry, the curated route list, a met-location key
 * (`m<gen>-<id>`) through the location tables { gen4, loc2, loc3 }, else the key itself.
 */
export function areaLabel(key, { doc = {}, tables = {}, lang = 'en' } = {}) {
  if (!key) return '';
  const own = doc[`area:${key}`];
  const ownName = own && typeof own === 'object' ? (own.v ?? own).name : null;
  if (ownName) return String(ownName);
  if (key === 'starter') return 'Starter';
  const curated = PROGRESSION.find((x) => x.key === key);
  if (curated) return curated.name;
  const m = /^m(\d)-(\d+)$/.exec(key);
  if (m) {
    const [g, id] = [Number(m[1]), Number(m[2])];
    const pick = (e) => (e ? (lang === 'de' && e.de) || e.en || '' : '');
    const name = g === 4 ? (id >= 2000 ? tables.gen4?.locationsSpecial?.[String(id)] : tables.gen4?.locations?.[id])
      : g === 3 ? pick(tables.loc3?.map?.[String(id)]) : g === 2 ? pick(tables.loc2?.map?.[String(id)]) : '';
    if (name) return name;
  }
  return key;
}

/**
 * What /api/runs/:id/overlay answers. `doc` is the stored doc ({ key: { v, t, by } }); `speciesName(id)` and
 * `tables` (see areaLabel) fill in the names the overlay needs, in its language.
 */
export function overlaySnapshot(manifest, doc, { lang = 'en', speciesName = null, tables = {} } = {}) {
  const raw = doc && typeof doc === 'object' ? doc : {};
  const d = {};
  const feed = [];
  for (const [k, e] of Object.entries(raw)) {
    const v = e && typeof e === 'object' ? e.v : null;
    if (v === null || v === undefined) continue;
    if (k.startsWith('feed:')) {
      if (typeof v === 'object') feed.push([k, v]);
      continue;
    }
    if (k === 'run:status' && typeof v === 'object') {
      d[k] = { state: str(v.state, 12), reason: str(v.reason, 12), at: num(v.at), by: str(v.by, 2) };
      continue;
    }
    const p = KEEP.find((x) => k.startsWith(x));
    if (p && (typeof v === 'object')) d[k] = LITE[p](v);
  }
  feed.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  for (const [k, v] of feed.slice(0, OVERLAY_FEED)) d[k] = liteFeed(v);

  const slots = slotsOf(manifest);
  const players = Object.fromEntries(slots.map((s) => [s, { name: d[`player:${s}`]?.name || str(manifest?.players?.[s]?.name) || s.toUpperCase() }]));
  const ids = new Set(TEST_SPECIES); // the app's preview gets its test alerts without the event stream
  const areas = new Set();
  for (const [k, v] of Object.entries(d)) {
    if (k.startsWith('live:')) for (const m of v.party) { if (m.species) ids.add(m.species); if (m.area) areas.add(m.area); }
    else if (k.startsWith('enc:')) { if (v.species) ids.add(v.species); areas.add(k.slice(4, k.lastIndexOf(':'))); }
    else if (k.startsWith('pair:')) { areas.add(k.slice(5)); if (v.killer?.species) ids.add(v.killer.species); }
    else if (k.startsWith('party:')) v.forEach((a) => areas.add(a));
    else if (k.startsWith('feed:')) { for (const x of [v.species, v.from, v.to]) if (x) ids.add(x); if (v.area) areas.add(v.area); }
    else if (k.startsWith('where:') && v.fight?.species) ids.add(v.fight.species);
  }
  return {
    v: 1, id: manifest?.id || null, name: str(manifest?.name, 80), mode: runMode(manifest), gen: runGen(manifest), slots, players,
    createdAt: manifest?.createdAt || null, doc: d,
    species: speciesName ? Object.fromEntries([...ids].map((i) => [i, speciesName(i)])) : {},
    areas: Object.fromEntries([...areas].map((a) => [a, areaLabel(a, { doc: raw, tables, lang })])),
    at: Date.now(),
  };
}

// ---- reading a snapshot (the overlay page) -----------------------------------------------------------------

/** A level worth showing: 1–100 (same rule as web/views/party.mjs shownLevel). */
export const validLevel = (l) => (Number.isInteger(l) && l >= 1 && l <= 100 ? l : null);

/** slp/psn/tox/brn/frz/par/fnt or '' – the same rule as web/views/party.mjs statusOf. */
export function statusKey(m) {
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

const pairDead = (S, area) => !!area && S.doc[`pair:${area}`]?.state === 'dead';

function shown(S, m, extra = {}) {
  const hp = Number.isFinite(m.hp) && Number.isFinite(m.maxHp) && m.maxHp > 0 && m.hp <= m.maxHp ? m.hp : null;
  return {
    key: m.key || m.area || '', area: m.area || null, species: m.species, nick: m.nick || '', level: validLevel(m.level), shiny: !!m.shiny,
    hp, maxHp: hp === null ? null : m.maxHp, status: statusKey(hp === null ? { status: m.status } : m), dead: pairDead(S, m.area), ...extra,
  };
}

/** A player's team as the overlay shows it: the live party when there is one, else the board's team. */
export function teamOf(S, slot) {
  const live = S?.doc?.[`live:${slot}`];
  if (live?.party?.length) return live.party.filter((m) => m.species && !m.egg).map((m) => shown(S, m));
  return (S?.doc?.[`party:${slot}`] || []).map((a) => {
    const e = S.doc[`enc:${a}:${slot}`];
    return e?.species ? shown(S, { area: a, species: e.species, nick: e.nickname, level: e.level, shiny: e.shiny }) : null;
  }).filter(Boolean);
}

/** The overlay's players: `want` (from ?p=) where they belong to the run, else every player of the run. */
export function pickSlots(S, want = []) {
  const all = S?.slots || [];
  const list = all.filter((s) => want.includes(s));
  return list.length ? list : all;
}

/**
 * The linked groups across the teams of `slots`: one per area, in the order of the first player's team, then
 * areas only the others carry. A member that isn't in its player's team (in the box) comes from the encounter,
 * marked `box`. Team members without a tracked area stand alone.
 */
export function groupsOf(S, slots) {
  const teams = Object.fromEntries(slots.map((s) => [s, teamOf(S, s)]));
  const order = [];
  for (const s of slots) for (const m of teams[s]) if (m.area && !order.includes(m.area)) order.push(m.area);
  const groups = order.map((area) => ({
    area, label: S.areas?.[area] || area, dead: pairDead(S, area),
    members: Object.fromEntries(slots.map((s) => {
      const m = teams[s].find((x) => x.area === area);
      if (m) return [s, m];
      const e = S.doc[`enc:${area}:${s}`];
      return [s, e?.outcome === 'caught' && e.species ? shown(S, { area, species: e.species, nick: e.nickname, level: e.level, shiny: e.shiny }, { box: true }) : null];
    })),
  }));
  for (const s of slots) {
    for (const m of teams[s]) {
      if (!m.area) groups.push({ area: null, label: '', dead: false, members: Object.fromEntries(slots.map((x) => [x, x === s ? m : null])) });
    }
  }
  return groups;
}

/**
 * Run numbers: `alive` / `dead` linked groups (a solo run: Pokémon), `caught` (every player caught there),
 * `missed` areas, `badges` per slot (the highest a player has had), `encounters` = areas with any result.
 */
export function countersOf(S) {
  const slots = S?.slots || [];
  const areas = new Set();
  for (const k of Object.keys(S?.doc || {})) if (k.startsWith('enc:')) areas.add(k.slice(4, k.lastIndexOf(':')));
  let alive = 0, dead = 0, caught = 0, missed = 0;
  for (const a of areas) {
    const encs = slots.map((s) => S.doc[`enc:${a}:${s}`]);
    if (encs.some((e) => e?.outcome === 'missed')) missed++;
    const all = encs.every((e) => e?.outcome === 'caught');
    if (all) caught++;
    if (pairDead(S, a)) dead++;
    else if (all) alive++;
  }
  const badges = Object.fromEntries(slots.map((s) => [s, S.doc[`live:${s}`]?.badges ?? null]));
  return { alive, dead, caught, missed, encounters: areas.size, badges };
}

/** Feed entries the overlay announces, oldest first. */
const ALERT_TYPES = ['death', 'catch', 'badge', 'evolve']; // the end of a run comes from run:status (also set by hand)
const FRESH = 3 * 60 * 1000; // older entries arriving late (a sync catching up) are not announced

/**
 * Alerts for what changed from `prev` to `S`: new log entries (death, catch, badge, evolution), the run's end and
 * level milestones (every 10th level, reached one step at a time – a bad read or a loaded state isn't one).
 * `seen` (a Set of feed keys) is updated; on the first snapshot (prev null) everything counts as seen.
 */
export function alertsBetween(prev, S, seen, now = Date.now()) {
  const out = [];
  const feed = Object.entries(S?.doc || {}).filter(([k]) => k.startsWith('feed:')).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
  for (const [k, f] of feed) {
    if (seen.has(k)) continue;
    seen.add(k);
    if (!prev || !ALERT_TYPES.includes(f.type) || now - (f.at || 0) > FRESH) continue;
    const a = { id: k, type: f.type, slot: f.slot || null, area: f.area || null, label: f.area ? S.areas?.[f.area] || f.area : '' };
    if (f.type === 'death') {
      a.members = (S.slots || []).map((s) => {
        const e = S.doc[`enc:${f.area}:${s}`];
        return e?.species ? { slot: s, species: e.species, nick: e.nickname || '' } : null;
      }).filter(Boolean);
      a.killer = S.doc[`pair:${f.area}`]?.killer || null;
    } else if (f.type === 'catch') {
      const e = S.doc[`enc:${f.area}:${f.slot}`];
      a.species = f.species || e?.species || null;
      a.nick = e?.nickname || '';
      a.complete = (S.slots || []).length > 1 && S.slots.every((s) => S.doc[`enc:${f.area}:${s}`]?.outcome === 'caught');
    } else if (f.type === 'badge') a.n = f.n ?? S.doc[`live:${f.slot}`]?.badges ?? null;
    else if (f.type === 'evolve') Object.assign(a, { from: f.from, to: f.to });
    out.push(a);
  }
  const st = S?.doc?.['run:status'];
  if (prev && st?.state && prev.doc?.['run:status']?.state !== st.state) out.push({ id: `run:${st.state}:${st.at}`, type: 'run', state: st.state, reason: st.reason || '', slot: st.by || null });
  if (prev) {
    for (const s of S.slots || []) {
      const before = new Map((prev.doc?.[`live:${s}`]?.party || []).map((m) => [m.key, validLevel(m.level)]));
      for (const m of S.doc?.[`live:${s}`]?.party || []) {
        const was = before.get(m.key);
        const lv = validLevel(m.level);
        if (!was || !lv || lv <= was || lv - was > 5) continue;
        if (Math.floor(lv / 10) > Math.floor(was / 10)) out.push({ id: `lv:${s}:${m.key}:${lv}`, type: 'level', slot: s, species: m.species, nick: m.nick || '', level: Math.floor(lv / 10) * 10 });
      }
    }
  }
  return out;
}

/** "4:07" from { h, m } or seconds; '' when unknown. */
export function playTimeText(pt) {
  if (pt === null || pt === undefined) return '';
  if (typeof pt === 'number') pt = { h: Math.floor(pt / 3600), m: Math.floor((pt % 3600) / 60) };
  if (typeof pt !== 'object' || pt.h === null || pt.h === undefined) return '';
  return `${pt.h}:${String(pt.m ?? 0).padStart(2, '0')}`;
}

// ---- which run an overlay shows ----------------------------------------------------------------------------

/** The run an overlay URL asks for: a run ID (a link pinned to that run), 'current' (follows the run being played – also
 *  when `run` is missing), or null for something that is neither. */
export function overlayRun(param) {
  const v = String(param ?? '').trim().toLowerCase();
  if (!v || v === 'current') return 'current';
  return /^[a-f0-9]{8}$/.test(v) ? v : null;
}

/**
 * The run "current" means – for the overlays that follow it and the stream API: the run open in the app
 * (`lastRun`, as long as it still exists), else the one played last (`runs`: [{ id, playedAt }], playedAt = when its doc
 * last changed), else null.
 */
export function currentRunId({ lastRun = null, runs = [] } = {}) {
  if (lastRun && runs.some((r) => r.id === lastRun)) return lastRun;
  let best = null;
  for (const r of runs) if (r?.id && (!best || (r.playedAt || 0) > (best.playedAt || 0))) best = r;
  return best?.id || null;
}

// ---- how big a widget is -------------------------------------------------------------------------------------

/** Team members every widget makes room for – a team of one and a full team take the same space. */
export const TEAM_SLOTS = 6;

/**
 * [w, h] of a widget at scale 1 for `n` players (1–4): a fixed box that holds a full team, the longest names and the
 * biggest (DS) sprites – the size of its OBS browser source. The overlay lays its widget out inside exactly this box
 * whatever the data, so the source never grows or moves while the team fills up. `nick`/`hp` add the team strip's
 * nickname and HP-bar lines.
 */
export function overlaySize(w, n = 1, { layout = 'h', nick = false, hp = true } = {}) {
  const v = layout === 'v';
  const p = Math.min(4, Math.max(1, Math.round(n) || 1));
  const cell = 80 + (hp ? 9 : 0) + (nick ? 19 : 0); // one Pokémon of the team strip: sprite, HP bar, nickname
  switch (w) {
    // measured with six Pokémon, long names and nicknames, plus a few pixels of air (test/overlay.test.mjs checks the
    // formulas, the screenshots in the pull request the look)
    case 'team': return v ? [20 + p * 110 + (p > 1 ? 18 : 0), 213 + TEAM_SLOTS * cell + (nick ? 13 : 0)]
      : [838, p * cell + (p === 1 ? 46 : 96 + 24 * (p - 2))];
    case 'card': return v ? [560, 420] : [900, 250];
    case 'counters': return v ? [300, 352] : [740 + p * 70, 74];
    case 'where': return v ? [380, 24 + p * 128 + (p - 1) * 10] : [24 + p * 340 + (p - 1) * 10, 152];
    case 'alerts': return [960, 440];
    case 'stats': return v ? [340, 230 + (p > 2 ? 16 : 0)] : [640 + p * 110, 64];
    default: return [960, 540];
  }
}

/**
 * The box an overlay page lays its widget out in, at scale 1: the size its browser source was made with (OBS's
 * `layer-width`/`-height` in the URL, which already include `scale`), else `overlaySize` for the players shown now.
 */
export function overlayBox(params, w, n, opts = {}) {
  const scale = Math.min(3, Math.max(0.4, Number(params?.get?.('scale')) || 1));
  const lw = Number(params?.get?.('layer-width'));
  const lh = Number(params?.get?.('layer-height'));
  if (lw >= 40 && lh >= 20 && lw <= 8000 && lh <= 8000) return [lw / scale, lh / scale];
  return overlaySize(w, n, opts);
}

/**
 * The OBS browser-source URL of a widget. `runId` is a run's ID (the link stays on that run) or 'current'/null (it
 * follows the run being played). `opts` are the overlay's query options (w, p, layout, theme, scale, bg, lang, sound,
 * hp …); `size` [w, h] adds OBS's layer-width/-height so a link dropped into OBS gets that size.
 */
export function overlayUrl(origin, runId, opts = {}, size = null, name = '') {
  const q = new URLSearchParams({ run: overlayRun(runId) || 'current' });
  for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== null && v !== '' && v !== false) q.set(k, v === true ? '1' : String(v));
  if (size) {
    q.set('layer-width', String(Math.round(size[0])));
    q.set('layer-height', String(Math.round(size[1])));
    if (name) q.set('layer-name', name);
  }
  return `${origin}/overlay?${q}`;
}
