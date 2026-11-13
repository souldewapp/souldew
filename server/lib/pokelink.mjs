// Pokélink bridge: existing Pokélink themes (github.com/pokelinkapp/pokelink-web-sources) show souldew's live
// teams. A theme is a browser source that connects with socket.io-client 2.x to <server>:<port> (its URL params,
// default http://localhost:3000) and listens for client:players:list (everybody, on connect),
// client:party:updated, player:trainer:updated and player:party:death. It never sends anything we need, so this
// server only pushes – read-only, on 127.0.0.1, for the run's players as Pokélink "users" (by name or slot).
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { Server as Engine } from 'engine.io';
import { hostAllowed } from './guard.mjs';
import { runGen, areaLabel, statusKey, validLevel } from '../../shared/overlay.mjs';
import { slotsOf } from '../../shared/slots.mjs';

export const POKELINK_PORT = 3000; // what the themes connect to unless their URL says ?port=

// Pages that may read the teams (players, nicknames, levels, moves, deaths – spoilers of a randomized run, never
// keys, codes or paths; see SECURITY.md):
//  - themes opened from disk: file:// → Origin "null", and OBS's "Local file" sources, which it serves as
//    http://absolute/<path> – how custom and downloaded themes run in OBS;
//  - Pokélink's own hosting (*.pokelink.xyz, pokelink.app, the pokelinkapp GitHub pages);
//  - souldew's own pages and the bridge's own address;
//  - other pages served from this computer (localhost on any port) only when the Stream page's "themes from another
//    local web server" switch is on – a local dev server or another program's web page is not a theme by default.
// Any other website gets no CORS answer and no handshake, so it can't read what the bridge sends. Requests without
// an Origin (OBS's own fetches, scripts) come from programs on this computer, which could read the run anyway.
const POKELINK_HOSTS = [/^https:\/\/([a-z0-9-]+\.)*pokelink\.(xyz|app)$/, /^https:\/\/pokelinkapp\.github\.io$/];
const LOCAL_ORIGIN = /^(https?):\/\/(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/;

/** May a page of origin `o` read the bridge? ports: souldew's own (app, bridge); localPages: any localhost port. */
export function originAllowed(o, { ports = [], localPages = false } = {}) {
  if (o === undefined) return true;
  const s = String(o).toLowerCase();
  if (s === 'null' || s === 'http://absolute' || POKELINK_HOSTS.some((r) => r.test(s))) return true;
  const m = s.match(LOCAL_ORIGIN);
  if (!m) return false;
  return localPages || ports.includes(Number(m[3] || (m[1] === 'https' ? 443 : 80)));
}

// Pokélink's game ids are the cartridge's header titles (its badges.js); souldew's catalog ids → those
const GAME_IDS = [ // the longer names first: "heartgold" contains "gold", "firered" contains "red"
  [/heartgold/, 'POKEMON HG'], [/soulsilver/, 'POKEMON SS'], [/firered/, 'POKEMON FIRE'], [/leafgreen/, 'POKEMON LEAF'],
  [/black-?2/, 'POKEMON B2'], [/white-?2/, 'POKEMON W2'], [/black/, 'POKEMON B'], [/white/, 'POKEMON W'],
  [/red/, 'POKEMON RED'], [/blue/, 'POKEMON BLUE'], [/green/, 'POKEMON GREEN'], [/yellow/, 'POKEMON YELL'],
  [/gold/, 'PM_GOLD'], [/silver/, 'PM_SILVER'], [/crystal/, 'PM_CRYSTAL'],
  [/ruby/, 'POKEMON RUBY'], [/sapphire/, 'POKEMON SAPP'], [/emerald/, 'POKEMON EMER'],
  [/platinum/, 'POKEMON PL'], [/diamond/, 'POKEMON D'], [/pearl/, 'POKEMON P'],
];
const KANTO = ['Boulder', 'Cascade', 'Thunder', 'Rainbow', 'Soul', 'Marsh', 'Volcano', 'Earth'];
const JOHTO = ['Zephyr', 'Hive', 'Plain', 'Fog', 'Storm', 'Mineral', 'Glacier', 'Rising'];
const BADGES = {
  kanto: KANTO, johto: [...JOHTO, ...KANTO], hoenn: ['Stone', 'Knuckle', 'Dynamo', 'Heat', 'Balance', 'Feather', 'Mind', 'Rain'],
  sinnoh: ['Coal', 'Forest', 'Cobble', 'Fen', 'Relic', 'Mine', 'Icicle', 'Beacon'], unova: ['Trio', 'Basic', 'Insect', 'Bolt', 'Quake', 'Jet', 'Freeze', 'Legend'],
};
const badgeSet = (id) => (/(RED|BLUE|GREEN|YELL|FIRE|LEAF)/.test(id) ? BADGES.kanto : /(GOLD|SILVER|CRYSTAL|HG|SS)$/.test(id) ? BADGES.johto
  : /(RUBY|SAPP|EMER)/.test(id) ? BADGES.hoenn : /(B2|W2|POKEMON B|POKEMON W)$/.test(id) ? BADGES.unova : BADGES.sinnoh);

const cap = (s) => String(s || '').replace(/(^|[\s-])\w/g, (c) => c.toUpperCase());
const NO_STATS = () => ({ hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spd: 0 });

/** The game as Pokélink names it: { id, friendlyName, generation }. */
export function pokelinkGame(manifest) {
  const key = String(manifest?.game?.id || '').toLowerCase();
  const id = GAME_IDS.find(([r]) => r.test(key))?.[1] || '';
  const title = String(manifest?.game?.title || '').trim();
  return { id, friendlyName: title ? (/^pok/i.test(title) ? title : `Pokémon ${title}`) : '', generation: runGen(manifest) };
}

/**
 * One party slot as a Pokélink theme reads it (transformPokemon in its client: speciesName for the sprite file,
 * hp.current/max, status.{psn,slp,…}, move1–4.name, heldItem as the game's item id, isShiny/isEgg/isFemale 0|1 …).
 * `data` = { names: English species names, types, typesGen, typeNames, moveNames, moveTypes, tables (areaLabel) }.
 */
export function pokelinkMon(m, { gen = 4, dead = false, area = '', data = {} } = {}) {
  const species = Number.isInteger(m?.species) ? m.species : -1;
  const level = validLevel(m.level) ?? 1;
  const max = Number.isFinite(m.maxHp) && m.maxHp > 0 ? m.maxHp : 0;
  const hp = max && Number.isFinite(m.hp) && m.hp >= 0 && m.hp <= max ? m.hp : max;
  const st = statusKey({ status: m.status });
  const types = (data.typesGen?.[species] && Object.entries(data.typesGen[species]).find(([g]) => gen <= Number(g))?.[1]) || data.types?.[species] || [];
  const move = (i) => {
    const id = Array.isArray(m.moves) ? m.moves[i] : 0;
    return id ? { name: data.moveNames?.[id] || `Move ${id}`, type: cap(data.moveTypes?.[id] || ''), pp: null, max_pp: null } : { name: '--', type: '', pp: 0, max_pp: 0 };
  };
  const speciesName = data.names?.[species] || (species > 0 ? `#${species}` : 'MissingNo.');
  return {
    pid: String(m.key || `${species}-${level}`), species, speciesName, nickname: String(m.nick || m.nickname || '') || speciesName, level,
    hp: { current: hp, max }, exp: 0, nature: '', ability: '', alternateForm: '', heldItem: Number.isInteger(m.item) ? m.item : 0,
    isShiny: m.shiny ? 1 : 0, isEgg: m.egg ? 1 : 0, isFemale: m.gender === 'F' ? 1 : 0, isGenderless: m.gender === 'M' || m.gender === 'F' ? 0 : 1,
    status: { psn: st === 'psn' || st === 'tox' ? 1 : 0, slp: st === 'slp' ? 1 : 0, par: st === 'par' ? 1 : 0, frz: st === 'frz' ? 1 : 0, fzn: st === 'frz' ? 1 : 0, brn: st === 'brn' ? 1 : 0 },
    dead: !!dead, types: types.map((t) => ({ label: data.typeNames?.[t] || cap(t) })),
    move1: move(0), move2: move(1), move3: move(2), move4: move(3), locationMet: area, ivs: NO_STATS(), evs: NO_STATS(), pokerus: 0, is_active_in_battle: false,
  };
}

const value = (doc, k) => (doc?.[k] && typeof doc[k] === 'object' ? doc[k].v ?? null : null);

/**
 * Every player of the run as a Pokélink "user": [{ id, username, party: [{ slotId, pokemon|null } × 6], trainer }].
 * Each player comes twice – under their name and their slot (p1 …) – so ?user=Lou and ?user=p1 both work.
 * `doc` is the stored doc ({ key: { v } }). The live party wins; without one, the board's team.
 */
export function pokelinkPlayers(manifest, doc, data = {}, lang = 'en') {
  const gen = runGen(manifest);
  const game = pokelinkGame(manifest);
  const names = badgeSet(game.id);
  const out = [];
  for (const slot of slotsOf(manifest)) {
    const live = value(doc, `live:${slot}`);
    const dead = (a) => !!a && value(doc, `pair:${a}`)?.state === 'dead';
    let mons = Array.isArray(live?.party) && live.party.length ? live.party : null;
    if (!mons) {
      mons = (value(doc, `party:${slot}`) || []).map((a) => {
        const e = value(doc, `enc:${a}:${slot}`);
        return e?.species ? { key: `${slot}-${a}`, area: a, species: e.species, nick: e.nickname, level: e.level, shiny: e.shiny } : null;
      }).filter(Boolean);
    }
    const party = Array.from({ length: 6 }, (_, i) => {
      const m = mons[i];
      return { slotId: i + 1, pokemon: m?.species ? pokelinkMon(m, { gen, dead: dead(m.area), area: m.area ? areaLabel(m.area, { doc, tables: data.tables, lang }) : '', data }) : null };
    });
    const count = Number.isInteger(live?.badges) ? live.badges : 0;
    const name = String(value(doc, `player:${slot}`)?.name || manifest?.players?.[slot]?.name || slot.toUpperCase()).slice(0, 24);
    const trainer = { name, game, badges: names.map((b, i) => ({ name: b, value: i < count ? 1 : 0 })) };
    for (const username of new Set([name, slot])) out.push({ id: `${manifest?.id || 'run'}-${slot}`, username, party, trainer });
  }
  return out;
}

/** Deaths between two player lists: [{ username, pokemon }] for each mon that turned dead. */
export function newDeaths(before, after) {
  const was = new Map();
  for (const p of before || []) for (const s of p.party) if (s.pokemon) was.set(`${p.username}|${s.pokemon.pid}`, s.pokemon.dead);
  const out = [];
  for (const p of after || []) for (const s of p.party) if (s.pokemon?.dead && was.get(`${p.username}|${s.pokemon.pid}`) === false) out.push({ username: p.username, pokemon: s.pokemon });
  return out;
}

/**
 * Starts the bridge on 127.0.0.1:`port`. `players()` returns the current list (pokelinkPlayers of the chosen run)
 * or null. `access()` → { appPort, localPages } is asked per request (the Stream page's switch takes effect at
 * once). Resolves { port, push(), close() }; push() sends what changed to every theme.
 */
export function startPokelinkBridge({ port = POKELINK_PORT, players, access = () => ({}) }) {
  let own = port; // the bridge's real port once it listens (0 in tests)
  const allowed = (o) => {
    let a = {};
    try {
      a = access() || {};
    } catch {
      // no settings – the strict default
    }
    return originAllowed(o, { ports: [own, a.appPort].filter(Number.isInteger), localPages: !!a.localPages });
  };
  const engine = new Engine({
    allowEIO3: true, // the themes load socket.io-client 2.2.0 (Engine.IO protocol 3)
    cors: { origin: (o, cb) => cb(null, allowed(o)), credentials: true, methods: ['GET', 'POST'] },
    allowRequest: (req, cb) => cb(null, hostAllowed(req.headers.host) && allowed(req.headers.origin)),
    maxHttpBufferSize: 1e4, // the themes send nothing; nothing big comes in either
  });
  const io = new Server({ serveClient: false });
  io.bind(engine);
  // A run that can't be read right now (a damaged run.json, a half-written doc) must not take the app down: these run
  // in socket and timer callbacks, where a throw would be an uncaught exception. null = nothing to say this time.
  const current = () => {
    try {
      return players() || null;
    } catch {
      return null;
    }
  };
  // the themes only listen (no handlers: whatever a client emits is dropped)
  io.on('connection', (socket) => socket.emit('client:players:list', current() || []));

  const http = createServer((req, res) => {
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403).end();
      return;
    }
    // Chrome asks before a public page (a theme hosted by Pokélink) may reach this computer
    if (req.headers['access-control-request-private-network'] && allowed(req.headers.origin)) res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (String(req.url).startsWith('/socket.io/')) return engine.handleRequest(req, res);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('souldew · Pokélink bridge\n');
  });
  http.on('upgrade', (req, socket, head) => {
    if (!String(req.url).startsWith('/socket.io/') || !hostAllowed(req.headers.host)) return socket.destroy();
    engine.handleUpgrade(req, socket, head);
  });

  let last = null;
  const push = () => {
    const list = current();
    if (!list) return;
    const sent = new Map((last || []).map((p) => [p.username, JSON.stringify(p)]));
    for (const p of list) {
      const was = sent.get(p.username);
      if (was === JSON.stringify(p)) continue;
      const old = was ? JSON.parse(was) : null;
      if (!old || JSON.stringify(old.party) !== JSON.stringify(p.party)) io.emit('client:party:updated', { id: p.id, username: p.username, update: { party: p.party } });
      if (!old || JSON.stringify(old.trainer) !== JSON.stringify(p.trainer)) io.emit('player:trainer:updated', { id: p.id, username: p.username, trainer: p.trainer });
    }
    for (const d of newDeaths(last, list)) io.emit('player:party:death', d);
    last = list;
  };

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', () => {
      http.off('error', reject);
      own = http.address().port;
      last = current() || [];
      resolve({
        port: http.address().port,
        push,
        clients: () => engine.clientsCount,
        close: () => new Promise((r) => {
          io.close();
          engine.close();
          http.close(() => r());
          http.closeAllConnections?.();
        }),
      });
    });
  });
}
