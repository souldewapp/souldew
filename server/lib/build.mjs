// Run creation: patch once, randomize per player with fixed seeds, write manifest + run pack.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync, rmSync, statSync, renameSync, linkSync, constants as fsConstants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RUNS_DIR } from './paths.mjs';
import { preparePatchedRom, fileSha1 } from './roms.mjs';
import { runBridge } from './toolchain.mjs';
import { toProperties } from '../../shared/randomizer-options.mjs';
import { diffRoms } from '../../shared/nds.mjs';
import { catalog } from './library.mjs';
import { writeFileAtomic, httpError } from './fsutil.mjs';
import { ALL_SLOTS, MODES, slotsOf, defaultRunName } from '../../shared/slots.mjs';

/** Runs from before 1–4 players were always a pair – the default where no slots are passed (shared/slots.mjs). */
const PAIR = ['p1', 'p2'];

// Player names become part of file names ("<name> - <game>.nds"): nothing Windows forbids, no control characters.
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '').trim().slice(0, 40) || 'Spieler';
const defaultName = (slot) => `Spieler ${slot.slice(1)}`;

/**
 * Mode and players of a build request: a Nuzlocke is p1 alone, a SoulLink p1..pN (2–4, contiguous; a missing p2
 * becomes "Spieler 2" as it always did). `existing` (a rebuild) fills in what the request leaves out.
 */
export function runPlayers(opts = {}, existing = null) {
  const mode = opts.mode ?? existing?.mode ?? 'soullink';
  if (!MODES.includes(mode)) throw httpError(400, `Unbekannter Modus: ${String(mode).slice(0, 20)}`, 'badMode', { mode: String(mode).slice(0, 20) });
  const given = opts.players && typeof opts.players === 'object' && !Array.isArray(opts.players) ? opts.players : existing?.players || {};
  const present = ALL_SLOTS.filter((s) => given[s]);
  const count = mode === 'nuzlocke' ? 1 : Math.max(2, present.length);
  const slots = ALL_SLOTS.slice(0, count);
  if (mode !== 'nuzlocke' && present.some((s) => !slots.includes(s))) throw httpError(400, 'Spieler müssen lückenlos p1 bis p4 sein', 'playersGap');
  const players = Object.fromEntries(slots.map((s) => [s, { name: safeName(given[s]?.name || defaultName(s)) }]));
  return { mode, slots, players };
}

/**
 * One seed per slot. With a shared seed every player gets p1's (the same world for everyone is what the flag
 * promises – a request with differing seeds can't break it), else the first one given.
 */
export function seedsFor(slots, seeds, shared) {
  const given = seeds && typeof seeds === 'object' && !Array.isArray(seeds) ? seeds : {};
  const one = shared ? given.p1 ?? slots.map((s) => given[s]).find((x) => x != null) : undefined;
  const out = {};
  for (const s of slots) {
    const seed = shared ? one : given[s];
    if (seed != null) out[s] = seed;
  }
  return out;
}

/**
 * New names for a run's players (POST /meta): only the slots the run has, names cleaned like on a build. The
 * number of players changes with a rebuild only.
 */
export function renamePlayers(manifest, given) {
  const g = given && typeof given === 'object' && !Array.isArray(given) ? given : {};
  return Object.fromEntries(slotsOf(manifest).map((s) => {
    const name = g[s] && typeof g[s] === 'object' && typeof g[s].name === 'string' ? g[s].name : manifest?.players?.[s]?.name;
    return [s, { ...(manifest?.players?.[s] || {}), name: safeName(name || defaultName(s)) }];
  }));
}

/**
 * The name part of each player's ROM / spoiler file. Names that would be one file on a case- and
 * normalization-insensitive disk (APFS, NTFS: "Lou" and "lou") get the slot added, and every label is unique.
 */
export function outputLabels(players) {
  const norm = (x) => String(x).normalize('NFC').toLowerCase();
  const count = new Map();
  for (const p of Object.values(players)) count.set(norm(p.name), (count.get(norm(p.name)) || 0) + 1);
  const used = new Set();
  const out = {};
  for (const [slot, p] of Object.entries(players)) {
    let label = count.get(norm(p.name)) > 1 ? `${p.name} (${slot.toUpperCase()})` : p.name;
    if (used.has(norm(label))) label = `${label} (${slot.toUpperCase()})`;
    used.add(norm(label));
    out[slot] = label;
  }
  return out;
}

export function newRunIdentity() {
  const words = ['glurak', 'evoli', 'ho-oh', 'lugia', 'suicune', 'togepi', 'marill', 'raikou', 'entei', 'mew', 'nebulak', 'dragoran', 'pichu', 'snubbull', 'heiteira', 'larvitar'];
  const pick = () => words[randomBytes(1)[0] % words.length];
  return {
    id: randomBytes(4).toString('hex'),
    room: `${pick()}-${pick()}-${randomBytes(2).toString('hex')}`,
    secret: randomBytes(12).toString('base64url'),
  };
}

export function runDir(id) {
  if (!/^[a-f0-9]{8}$/.test(id)) throw httpError(400, 'Ungültige Run-ID', 'badRunId');
  return join(RUNS_DIR, id);
}

export function readManifest(id) {
  const p = join(runDir(id), 'run.json');
  if (!existsSync(p)) return null;
  const m = JSON.parse(readFileSync(p, 'utf8'));
  // `null`, an array or a number would throw further down (or reach runDir() with a bad id and fail every run list).
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('run.json ist kein Objekt');
  // The folder name is the run id – a copied folder or a hand-edited file must not point at another run.
  if (m.id !== id) m.id = id;
  return migrate(m);
}

/** Runs created by version 1 (HeartGold only) have no `game` block – infer it from the base ROM. */
function migrate(m) {
  if (m.game) return m;
  const crc = String(m.base?.crc || '').toUpperCase();
  const game = (catalog().games || []).find((g) => (g.crc32 || []).map((c) => String(c).toUpperCase()).includes(crc));
  const isDefHg = /definitive heartgold/i.test(m.patch?.name || '');
  m.game = {
    id: game ? game.variantOf || game.id : crc === 'C180A0E9' ? 'pokemon-heartgold' : null,
    system: game?.system || 'nds',
    code: game?.gameCode || game?.serial || (crc === 'C180A0E9' ? 'IPKE' : ''),
    title: game?.headerTitle || (crc === 'C180A0E9' ? 'POKEMON HG' : ''),
    hackId: isDefHg ? 'definitive-heartgold' : null,
  };
  return m;
}

export function writeManifest(m) {
  mkdirSync(runDir(m.id), { recursive: true });
  writeFileAtomic(join(runDir(m.id), 'run.json'), JSON.stringify(m, null, 2));
}

export function listRuns() {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((d) => /^[a-f0-9]{8}$/.test(d))
    .map((d) => {
      // one damaged run.json must not take down the status endpoint (and with it the whole UI)
      try {
        return readManifest(d);
      } catch (e) {
        console.warn(`run ${d}: run.json unlesbar –`, e.message);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
}

/**
 * Cheap per-run numbers for run lists, read from the shared doc ({key:{v,t,by}}). Cached by mtime.
 * status = doc `run:status` ({state:'failed'|'won'|'ended', at, by, note}) or null while the run is active.
 */
const summaries = new Map();
/**
 * `slots`: the run's slots (shared/slots.mjs slotsOf) – a group is alive once every one of them caught there.
 * live/badges list those slots plus any other p1..p4 the doc has data for.
 */
export function summarizeDoc(entries, slots = PAIR) {
  const s = { status: null, alive: 0, dead: 0, failed: 0, caught: 0, badges: {}, live: {}, names: {}, lastPlayed: null };
  for (const slot of slots) {
    s.badges[slot] = 0;
    s.live[slot] = null;
  }
  const enc = {};
  let last = 0;
  for (const [k, e] of Object.entries(entries || {})) {
    if (!e || e.v === null || e.v === undefined) continue;
    if (typeof e.t === 'number' && e.t > last) last = e.t;
    const v = e.v;
    if (k === 'run:status' && v.state) s.status = v;
    else if (k.startsWith('pair:') && v.state === 'dead') s.dead++;
    else if (/^live:p[1-4]$/.test(k)) {
      const slot = k.slice(5);
      s.live[slot] = v.at || null;
      s.badges[slot] = v.badges || 0;
    } else if (/^player:p[1-4]$/.test(k) && v.name) s.names[k.slice(7)] = v.name;
    else {
      const m = k.match(/^enc:(.+):(p[1-4])$/);
      if (m) (enc[m[1]] ||= {})[m[2]] = v.outcome;
    }
  }
  for (const [area, x] of Object.entries(enc)) {
    for (const slot of slots) if (x[slot] === 'caught') s.caught++;
    if (entries[`pair:${area}`]?.v?.state === 'dead') continue;
    if (slots.some((slot) => x[slot] === 'missed')) s.failed++;
    else if (slots.every((slot) => x[slot] === 'caught')) s.alive++;
  }
  s.lastPlayed = Math.max(0, ...Object.values(s.live).map((at) => at || 0)) || last || null;
  return s;
}
/** Summary of a run's doc; pass its manifest when at hand (else run.json is read for the slots). */
export function runSummary(id, manifest) {
  const p = join(runDir(id), 'doc.json');
  let slots = PAIR;
  try {
    slots = slotsOf(manifest || readManifest(id));
  } catch {
    // unreadable run.json – count it as the classic pair
  }
  let st;
  try {
    st = statSync(p);
  } catch {
    return summarizeDoc({}, slots);
  }
  const key = slots.join();
  const c = summaries.get(id);
  if (c && c.mtime === st.mtimeMs && c.size === st.size && c.key === key) return c.summary;
  let summary;
  try {
    summary = summarizeDoc(JSON.parse(readFileSync(p, 'utf8')), slots);
  } catch {
    summary = summarizeDoc({}, slots);
  }
  summaries.set(id, { mtime: st.mtimeMs, size: st.size, key, summary });
  return summary;
}

const UNSAFE_DOC_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Timestamps are clamped to now + 1 day and device ids to 64 characters – the same bounds as RunDoc.merge. */
export const DOC_MAX_SKEW_MS = 86400000;
const DOC_MAX_BY = 64;
/**
 * Merge an uploaded run doc ({ key: { v, t, by } }) into the copy on disk with the same last-writer-wins rule as
 * web/lib/doc.mjs: the larger (t, by) pair wins per key. Two tabs, or an older upload that arrives after a newer one,
 * can then never roll entries back. Like RunDoc.merge, a timestamp far in the future is clamped (one would otherwise
 * win every later edit of that key on disk forever) and entries keep only { v, t, by }. Returns the merged object.
 */
export function mergeDocEntries(stored, incoming) {
  const out = Object.create(null);
  const maxT = Date.now() + DOC_MAX_SKEW_MS;
  const valid = (e) => e && typeof e === 'object' && typeof e.t === 'number' && Number.isFinite(e.t);
  const newer = (a, b) => !b || a.t > b.t || (a.t === b.t && a.by > b.by);
  for (const src of [stored, incoming]) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    for (const [k, raw] of Object.entries(src)) {
      if (UNSAFE_DOC_KEYS.has(k) || !valid(raw)) continue;
      const e = { v: raw.v === undefined ? null : raw.v, t: Math.min(raw.t, maxT), by: typeof raw.by === 'string' ? raw.by.slice(0, DOC_MAX_BY) : '' };
      if (newer(e, out[k])) out[k] = e;
    }
  }
  return { ...out };
}

/** Deleting a run only moves its folder to runs/.trash/<id>-<stamp> (same volume → a cheap rename). */
export function trashRun(id) {
  const dir = runDir(id);
  if (!existsSync(join(dir, 'run.json'))) throw httpError(404, 'Run nicht gefunden', 'runNotFound');
  const trash = join(RUNS_DIR, '.trash');
  mkdirSync(trash, { recursive: true });
  const target = join(trash, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  renameSync(dir, target);
  summaries.delete(id);
  return target;
}

/** Rule keys that belong to this computer only – never shared with the partner or put into invite packs. */
const LOCAL_RULE_KEYS = ['discordWebhook'];
export function stripLocalRules(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return rules ?? null;
  const out = { ...rules };
  for (const k of LOCAL_RULE_KEYS) delete out[k];
  return out;
}

/** A Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>), nothing else. */
export function isDiscordWebhook(url) {
  if (typeof url !== 'string' || url.length > 512) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port
      && ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(u.hostname)
      && /^\/api\/(v\d+\/)?webhooks\/\d+\/[\w-]+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * Type checks for an imported run pack (it comes from the partner – untrusted). Returns the cleaned identity
 * fields { room, secret, name, createdAt, players, mode? }; throws a 400 for anything malformed.
 */
export function checkPack(pack) {
  const bad = (what) => httpError(400, `Run-Paket ist beschädigt (${what})`, 'packBroken', { what });
  const text = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
  if (!text(pack.room, 3, 128)) throw bad('room');
  if (!text(pack.secret, 8, 256)) throw bad('secret');
  if (pack.name != null && typeof pack.name !== 'string') throw bad('name');
  if (pack.createdAt != null && typeof pack.createdAt !== 'string') throw bad('createdAt');
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  for (const k of ['base', 'patch', 'randomizer', 'rules', 'game', 'outputs']) if (pack[k] != null && !isObj(pack[k])) throw bad(k);
  if (pack.players != null && !isObj(pack.players)) throw bad('players');
  // older packs have no mode (a SoulLink of p1+p2)
  if (pack.mode != null && !MODES.includes(pack.mode)) throw bad('mode');
  const players = {};
  let gap = false;
  for (const s of pack.mode === 'nuzlocke' ? ['p1'] : ALL_SLOTS) {
    const p = pack.players?.[s];
    if (p == null) {
      gap = true;
      continue;
    }
    // p1..pN without gaps – a p3 after a missing p2 would be dropped by every slotsOf() reading the run
    if (gap || !isObj(p) || (p.name != null && typeof p.name !== 'string')) throw bad('players');
    players[s] = { name: safeName(p.name || defaultName(s)) };
  }
  return {
    room: pack.room,
    secret: pack.secret,
    name: String(pack.name || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80),
    createdAt: String(pack.createdAt || '').slice(0, 40) || new Date().toISOString(),
    players,
    ...(pack.mode ? { mode: pack.mode } : {}),
  };
}

/** Everything the friend needs to build byte-identical ROMs — no copyrighted data inside. */
export function runPack(m) {
  return {
    format: 'soullink-studio/run-pack@1',
    id: m.id,
    name: m.name,
    room: m.room,
    secret: m.secret,
    createdAt: m.createdAt,
    ...(m.mode ? { mode: m.mode } : {}),
    players: m.players,
    base: m.base ? { crc: m.base.crc, name: m.base.name } : null,
    patch: m.patch ? { name: m.patch.name, sha1: m.patch.sha1, resultCrc: m.patch.resultCrc } : null,
    randomizer: m.randomizer,
    outputs: Object.fromEntries(Object.entries(m.outputs || {}).map(([k, v]) => [k, { sha1: v.sha1 }])),
    rules: stripLocalRules(m.rules || null),
    game: m.game || null,
  };
}

/**
 * opts: { name, romId, patchId, patchSha1, values, randomize, mode?: 'soullink'|'nuzlocke',
 *         seeds: {p1, …, pN}, players: {p1:{name}, …, pN:{name}}, buildFor: ['p1', …], identity?: {id, room, secret}, rules }
 * A Nuzlocke has p1 only, a SoulLink 2–4 players; buildFor defaults to every slot of the run.
 */
/**
 * A 3DS game file into the run folder without reading it: a hard link (same drive – instant, no extra space), else a
 * copy-on-write clone (APFS, Btrfs) or, failing both, a plain copy off the main thread.
 */
async function placeLargeRom(src, dest, onLog) {
  rmSync(dest, { force: true });
  try {
    linkSync(src, dest);
    return;
  } catch {
    // another drive, or a file system without hard links
  }
  onLog('Kopiere das 3DS-Spiel in den Run-Ordner …');
  await copyFile(src, dest, fsConstants.COPYFILE_FICLONE);
}

export async function buildRun(opts, onLog = () => {}) {
  const identity = opts.identity || newRunIdentity();
  const isNew = !existsSync(join(runDir(identity.id), 'run.json'));
  try {
    return await buildInto({ ...opts, identity }, onLog);
  } catch (e) {
    // A new run that failed to build (no Java, bad patch, randomizer error) leaves no half-filled folder behind.
    if (isNew) rmSync(runDir(identity.id), { recursive: true, force: true });
    throw e;
  }
}

async function buildInto(opts, onLog) {
  const identity = opts.identity;
  const existing = readManifest(identity.id);
  const { mode, slots, players } = runPlayers(opts, existing);
  const buildFor = [].concat(opts.buildFor || slots).filter((s) => slots.includes(s));
  if (!buildFor.length) throw httpError(400, 'Kein gültiger Spieler zum Bauen angegeben', 'noBuildPlayer');
  const dir = runDir(identity.id);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();

  const patched = preparePatchedRom(opts.romId, opts.patchId || null, onLog, opts.config || {});
  const ctr = patched.system === '3ds'; // 3DS: no randomizer, the game file linked/copied as it is (1–4 GB)
  const manifest = {
    ...(existing || {}),
    id: identity.id,
    room: identity.room,
    secret: identity.secret,
    name: opts.name || existing?.name || defaultRunName(players, mode),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    mode,
    players,
    base: { crc: patched.baseCrc, name: basename(String(opts.romId).split('::').pop()), gameId: opts.gameId || null },
    patch: opts.patchId ? { name: patched.patchName, sha1: patched.patchSha1 || opts.patchSha1 || null, resultCrc: patched.crc, hackId: opts.hackId || null } : null,
    game: { id: opts.gameId || existing?.game?.id || null, system: patched.system, code: patched.header?.code || '', title: patched.header?.title || '', hackId: opts.hackId || null },
    patchedSha1: patched.sha1,
    randomizer: {
      enabled: opts.randomize !== false && !ctr,
      tool: 'UPR ZX 4.6.1 + SoulLinkBridge',
      values: opts.values || {},
      seeds: seedsFor(slots, opts.seeds || existing?.randomizer?.seeds, !!opts.sharedSeed),
      sharedSeed: !!opts.sharedSeed,
    },
    rules: stripLocalRules(opts.rules || existing?.rules || null), // the Discord webhook lives in the local config
    // outputs of slots the run no longer has (a rebuild with fewer players) would be offered for download
    outputs: Object.fromEntries(Object.entries(existing?.outputs || {}).filter(([s]) => slots.includes(s))),
    warnings: [],
  };

  const gameLabel = (patched.patchName || opts.gameTitle || patched.header?.title || 'Pokemon').replace(/^Pokémon\s*/i, '').replace(/\.(xdelta|vcdiff|xdelta3|bps|ups|ips)$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '').trim() || 'Pokemon'; // becomes part of a file name
  const ext = patched.ext || patched.system || 'nds';
  // Equal player names would make those players share (and overwrite) one ROM file.
  const labels = outputLabels(players);
  for (const slot of buildFor) {
    const player = players[slot];
    const who = labels[slot];
    const fileBase = `${who} - ${gameLabel}${manifest.randomizer.enabled ? ' Randomized' : ''}`;
    const romOut = join(dir, `${fileBase}.${ext}`);
    const logOut = join(dir, `${who} - Spoiler-Log.txt`);
    const dataOut = join(dir, `${slot}.data.json`);
    if (manifest.randomizer.enabled) {
      const seed = String(manifest.randomizer.seeds[slot] || '');
      if (!/^-?\d{1,19}$/.test(seed)) throw new Error(`Ungültiger Seed für ${player.name}`);
      const propsFile = join(dir, `${slot}.settings.properties`);
      writeFileSync(propsFile, toProperties(manifest.randomizer.values));
      onLog(`Randomisiere ROM für ${player.name} (Seed ${seed}) …`);
      const t = Date.now();
      const res = await runBridge(['randomize', patched.path, romOut, propsFile, seed, logOut, dataOut]);
      for (const w of res.warnings) if (!manifest.warnings.includes(w)) manifest.warnings.push(w);
      manifest.randomizer.settingsString = res.settingsString;
      onLog(`Fertig in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    } else if (ctr) {
      await placeLargeRom(patched.path, romOut, onLog);
      rmSync(dataOut, { force: true });
      rmSync(logOut, { force: true });
    } else {
      copyFileSync(patched.path, romOut);
      rmSync(dataOut, { force: true });
      rmSync(logOut, { force: true });
    }
    const sha1 = ctr ? null : fileSha1(romOut);
    manifest.outputs[slot] = {
      rom: basename(romOut),
      log: manifest.randomizer.enabled ? basename(logOut) : null,
      data: manifest.randomizer.enabled ? basename(dataOut) : null,
      sha1,
      builtAt: new Date().toISOString(),
      expectedSha1: opts.expectedOutputs?.[slot]?.sha1 || null,
    };
    if (manifest.outputs[slot].expectedSha1) {
      manifest.outputs[slot].matchesFriend = manifest.outputs[slot].expectedSha1 === sha1;
      // Only randomized or patched runs need byte-identical ROMs – a plain run may use another release of the game.
      const mustMatch = !!(manifest.randomizer?.enabled || manifest.patch);
      onLog(manifest.outputs[slot].matchesFriend
        ? `✔ ROM für ${player.name} ist byte-identisch mit dem deines Freundes`
        : mustMatch ? `⚠ ROM für ${player.name} weicht vom Run-Paket ab (anderes Basis-ROM/Version?)`
          : `ℹ ROM für ${player.name} ist eine andere Fassung des Spiels als beim Host – passt, jeder spielt seine eigene Kopie`);
    }
  }

  // Sanity check: which game files did the randomizer touch? (first built slot)
  const first = buildFor[0];
  if (manifest.randomizer.enabled && first && ext === 'nds') {
    try {
      const a = new Uint8Array(readFileSync(patched.path));
      const b = new Uint8Array(readFileSync(join(dir, manifest.outputs[first].rom)));
      manifest.diff = diffRoms(a, b).map((c) => ({ path: c.path, subfiles: c.subfiles ? c.subfiles.length : undefined }));
    } catch (e) {
      manifest.diff = null;
    }
  }
  writeManifest(manifest);
  writeFileAtomic(join(dir, 'run-pack.soullink.json'), JSON.stringify(runPack(manifest), null, 2));
  return manifest;
}
