#!/usr/bin/env node
// The ROM test matrix: everything souldew reads from a game, checked against a folder of ROMs and patches – retail
// games, ROM hacks (patches are applied the way the app does it) and randomized games (the bundled randomizer, one
// game per generation). Without --live it checks what can be read from the files themselves: header and catalog match,
// retail or modified (CRC32), the memory table entry, the ROM's place names (shared/live/romloc.mjs) and, for GBA,
// its species table (shared/live/romspecies.mjs – ROM hacks with other Pokémon, expanded engines). With --live it also
// boots every game in souldew's own emulator page (Electron from node_modules, hidden and muted, a throwaway data
// folder), plays it to the first Pokémon with the input plans in scripts/rom-matrix/plans.mjs and checks the team,
// the place sign and a battle with the app's live readers. Plain Node, no platform tools: runs the same on Windows.
//
//   node scripts/rom-matrix.mjs <rom-dir> [more dirs or files] [--live] [--randomize] [--only <text>] [--out <dir>] [--tools <dir>] [--show] [--keep]
//
//   <rom-dir>     ROMs (.gb .gbc .gba .nds, also inside .zip) and patches (.ips .bps .ups .xdelta/.vcdiff), any
//                 subfolders. A patch is paired with its base ROM by the checksum in the patch (BPS/UPS/xdelta) or,
//                 for IPS, by the catalog's hack name in the file name. .rar/.7z archives: unpack them first.
//   --live        also play every game that has a plan (GB ~20–60 s, GBA ~2 min, DS 10–25 min per game)
//   --randomize   also randomize one game per generation (Classic preset, fixed seed) and check the result
//                 (needs Java: tools/jre from `npm run jre`, JAVA_HOME or --tools <folder with jre/, upr/, upr-bridge/>)
//   --only <text> only ROMs whose file name contains the text (case-insensitive)
//   --out <dir>   where results, patched/randomized ROMs and screenshots go (default: <tmp>/souldew-rom-matrix);
//                 patched and randomized ROMs are deleted at the end unless --keep
//   --attempts n  tries per game when a plan loses its way (default 3)
//   --show        show the emulator windows (they stay muted)
// A plan with "save": true starts from a save instead of a new game: <name>.sav next to the patch (or the ROM) of the
// same name. Without one the game is skipped. Never commit saves either.
// Results: <out>/matrix.json, <out>/matrix.md (the table for docs/TESTED_GAMES.md) and <out>/shots/*.png.
// Never commit ROMs, patched ROMs or the screenshots.
import { spawn } from 'node:child_process';
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, basename, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
// ROM folders (or single files) come first, before the options
const sources = [];
for (const a of args) {
  if (a.startsWith('--')) break;
  sources.push(resolve(a));
}
if (!sources.length || !sources.every((p) => existsSync(p))) {
  console.error('usage: node scripts/rom-matrix.mjs <rom-dir|rom-file> [more …] [--live] [--randomize] [--only <text>] [--out <dir>] [--tools <dir>] [--show] [--keep]');
  process.exit(2);
}
const out = resolve(opt('out', join(tmpdir(), 'souldew-rom-matrix')));
const work = join(out, 'roms');
mkdirSync(work, { recursive: true });
mkdirSync(join(out, 'shots'), { recursive: true });
if (opt('tools')) process.env.SLS_TOOLS_DIR = resolve(opt('tools'));
process.env.SLS_DATA_DIR = join(out, 'data'); // server modules read it when they load: never the user's own data folder
const only = (opt('only') || '').toLowerCase();

const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { identifyRom, matchCatalog } = await imp('shared/romid.mjs');
const { crc32Hex } = await imp('shared/checksum.mjs');
const { applyPatch, detectPatchFormat, describePatch } = await imp('shared/patchers.mjs');
const { findEntry } = await imp('shared/live/parse.mjs');
const { romData } = await imp('server/lib/romloc.mjs');
const { listZip, readZipEntry } = await imp('server/lib/zip.mjs');
const { PLANS, planFor } = await imp('scripts/rom-matrix/plans.mjs');
const json = (f) => JSON.parse(readFileSync(join(root, 'shared', 'data', f), 'utf8'));
const catalog = json('catalog.json');
const addresses = json('addresses.json');
const SHARED = join(root, 'shared');

const ROM_EXT = ['.gb', '.gbc', '.gba', '.nds'];
const PATCH_EXT = ['.ips', '.bps', '.ups', '.xdelta', '.vcdiff', '.xdelta3'];
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- collect

function walk(dir, depth = 0, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (depth < 4) walk(p, depth + 1, acc);
    } else acc.push(p);
  }
  return acc;
}

const roms = []; // { file, name, bytes?, kind: 'retail'|'patched'|'randomized'|'other', … }
const patches = [];
const notes = [];
for (const f of sources.flatMap((p) => (statSync(p).isDirectory() ? walk(p) : [p]))) {
  const ext = extname(f).toLowerCase();
  if (ROM_EXT.includes(ext)) roms.push({ file: f, name: basename(f) });
  else if (PATCH_EXT.includes(ext)) patches.push({ file: f, name: basename(f), from: null });
  else if (ext === '.zip') {
    let entries = [];
    try {
      entries = listZip(f);
    } catch (e) {
      notes.push(`${basename(f)}: not readable as zip (${e.message})`);
      continue;
    }
    for (const e of entries) {
      const ee = extname(e.name).toLowerCase();
      if (!ROM_EXT.includes(ee) && !PATCH_EXT.includes(ee)) continue;
      const dest = join(work, 'unzipped', basename(f, '.zip'), basename(e.name));
      if (!existsSync(dest)) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readZipEntry(f, e));
      }
      (ROM_EXT.includes(ee) ? roms : patches).push({ file: dest, name: basename(e.name), from: basename(f) });
    }
  } else if (['.rar', '.7z'].includes(ext)) notes.push(`${basename(f)}: unpack it first (only .zip is read here)`);
}

function identify(r) {
  const bytes = new Uint8Array(readFileSync(r.file));
  const id = identifyRom(bytes.subarray(0, 0x200), extname(r.file).slice(1));
  const crc = crc32Hex(bytes);
  const m = id ? matchCatalog({ ...id, crc }, catalog) : null;
  // a ROM that was patched before (Too Many Types from a download site): a known version of a hack by its CRC32
  const hack = r.hack || catalog.hacks.find((h) => (h.romCrc32 || []).includes(crc))?.id || null;
  return Object.assign(r, { system: id?.system || null, code: id?.code || '', title: id?.title || '', crc, gameId: m?.game?.id || null, exactMatch: !!m?.exact, generation: m?.game?.generation || null, hack });
}
roms.forEach(identify);
const bases = roms.filter((r) => r.exactMatch);
for (const r of roms) r.kind = r.exactMatch ? 'retail' : 'other';

// ---------------------------------------------------------------- patch

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
const hackOf = (name) => catalog.hacks.find((h) => norm(name).includes(norm(h.name.replace(/^Pokémon\s*/i, '')))) || null;
for (const p of patches) {
  const bytes = new Uint8Array(readFileSync(p.file));
  const format = detectPatchFormat(bytes);
  const hack = hackOf(p.name);
  p.format = format;
  p.hack = hack?.id || null;
  if (!format) {
    p.result = 'not a patch';
    continue;
  }
  const d = describePatch(bytes);
  let candidates = bases;
  if (format === 'bps' || format === 'ups') candidates = bases.filter((b) => parseInt(b.crc, 16) === d.sourceCrc);
  else if (format === 'ips') candidates = hack ? bases.filter((b) => b.crc === String(hack.baseCrc32 || '').toUpperCase() || b.gameId === hack.baseGameId) : [];
  else if (hack) candidates = [...bases.filter((b) => b.gameId === hack.baseGameId), ...bases.filter((b) => b.gameId !== hack.baseGameId)];
  if (!candidates.length) {
    p.result = format === 'ips' && !hack ? 'IPS without a known hack name – base unknown' : 'no matching base ROM in the folder';
    continue;
  }
  for (const b of candidates) {
    try {
      const outBytes = applyPatch(new Uint8Array(readFileSync(b.file)), bytes);
      const name = `${basename(p.name, extname(p.name))}${extname(b.file)}`;
      const dest = join(work, 'patched', name);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, outBytes);
      p.result = `applied to ${b.name}`;
      p.base = b.name;
      roms.push(identify({ file: dest, name, kind: 'patched', patch: p.name, hack: p.hack, base: b }));
      roms.at(-1).kind = 'patched';
      break;
    } catch (e) {
      p.result = `failed: ${e.message}`;
    }
  }
}

// ---------------------------------------------------------------- randomize (one game per generation)

if (flag('randomize')) {
  const { runBridge, detectJava } = await imp('server/lib/toolchain.mjs');
  const { PRESETS, buildValues, toProperties } = await imp('shared/randomizer-options.mjs');
  const java = detectJava();
  if (!java.ok) notes.push('randomize: no Java found (npm run jre, JAVA_HOME or --tools)');
  else {
    const picked = new Map();
    for (const b of bases) if (b.generation && !picked.has(b.generation)) picked.set(b.generation, b);
    for (const [gen, b] of picked) {
      const dest = join(work, 'randomized', `${basename(b.name, extname(b.name))} (randomized)${extname(b.name)}`);
      if (only && !basename(dest).toLowerCase().includes(only)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      const props = join(work, 'randomized', `gen${gen}.properties`);
      writeFileSync(props, toProperties(buildValues(PRESETS[0].values, gen)));
      log(`randomizing ${b.name} (Gen ${gen}) …`);
      try {
        const res = await runBridge(['randomize', b.file, dest, props, '20261110', join(work, 'randomized', `gen${gen}-log.txt`), join(work, 'randomized', `gen${gen}-data.json`)], { timeoutMs: 600000 });
        if (res.code !== 0 || !existsSync(dest)) throw new Error(res.error || res.stderr?.slice(-300) || `exit ${res.code}`);
        const r = identify({ file: dest, name: basename(dest), base: b });
        r.kind = 'randomized';
        roms.push(r);
      } catch (e) {
        notes.push(`randomize ${b.name}: ${e.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------- static checks

const targets = roms.filter((r) => !only || r.name.toLowerCase().includes(only) || (r.patch || '').toLowerCase().includes(only));
for (const r of targets) {
  const bytes = new Uint8Array(readFileSync(r.file));
  const header = { platform: r.system === 'gbc' ? 'gbc' : r.system, code: r.code, title: r.title };
  const entry = r.system ? findEntry(addresses, header) : null;
  const d = romData(bytes, SHARED);
  r.header = header;
  r.entry = entry?.id || null;
  r.vanilla = d.vanilla;
  r.places = d.data ? { gen: d.data.gen, family: d.data.family, lang: d.data.lang, count: d.data.names.filter(Boolean).length, sample: d.data.names.filter(Boolean).slice(0, 4) } : null;
  r.species = d.species ? { engine: d.species.engine, count: d.species.count, changed: d.species.changed, unknown: Object.keys(d.species.unknown || {}).length } : null;
  r.gen = { gb: 1, gbc: 2, gba: 3, nds: entry?.gen === 5 || /^IR[ABDE]/.test(r.code) ? 5 : 4 }[r.system] || null;
  if (r.system === 'gbc' && entry?.gen === 1) r.gen = 1;
  if (r.system === 'gb' && entry?.gen === 2) r.gen = 2;
  // what the app does with it, read from the file alone
  r.static = {
    live: !entry ? 'none' : r.species?.engine === 'expanded' ? (d.species?.map ? 'reads (expanded engine)' : 'hack-unsupported') : 'reads',
    // Gen 1/2 read places from the tables (their RAM holds the map, the tables name it); Gen 3–5 from the ROM
    places: r.gen <= 2 ? (entry ? 'tables' : 'none') : d.data ? (r.vanilla === false ? 'rom (own names)' : 'rom') : 'none',
  };
}

// ---------------------------------------------------------------- live

const mark = (v) => (v === true ? '✅' : v === false ? '❌' : v === 'hack' ? '⚠️ not supported (shown as such)' : '–');

async function runLive(list) {
  // (a plan that starts from a save: <name>.sav next to the patch or the ROM)
  const saveFor = (r) => {
    const p = r.patch ? patches.find((x) => x.name === r.patch) : null;
    const near = [p && join(dirname(p.file), `${basename(p.file, extname(p.file))}.sav`), join(dirname(r.file), `${basename(r.file, extname(r.file))}.sav`)];
    return near.find((f) => f && existsSync(f)) || null;
  };
  const jobs = list.map((r) => {
    const plan = planFor(r);
    if (plan?.save && !saveFor(r)) {
      r.liveResult = { skipped: `the plan starts from a save: put one next to the ${r.patch ? 'patch' : 'ROM'} (${basename(r.patch || r.name, extname(r.patch || r.name))}.sav)` };
      return null;
    }
    return plan ? { r, plan } : null;
  }).filter(Boolean);
  for (const r of list) if (!r.liveResult && !jobs.some((j) => j.r === r)) r.liveResult = { skipped: 'no input plan for this game' };
  if (!jobs.length) return;
  const dataDir = join(out, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ onboarded: true, lang: 'en', playerName: 'Matrix', libraryFolders: [...sources.map((p) => (statSync(p).isDirectory() ? p : dirname(p))), work] }));
  const electron = (await import('electron')).default;
  log(`live: ${jobs.length} game(s) in souldew's emulator …`);
  const all = [];
  // one Electron per game: a second emulator page in the same Electron process sometimes takes the process down
  for (const [i, { r, plan }] of jobs.entries()) {
    const key = `${String(i).padStart(2, '0')}-${norm(r.name).slice(0, 24)}`;
    const resultFile = join(out, `live-${key}.json`);
    rmSync(resultFile, { force: true });
    const job = {
      dataDir, outDir: join(out, 'shots'), resultFile, show: flag('show'), timeoutMs: 60 * 60000,
      targets: [{ key, file: r.file, system: r.system, core: plan.core || '', ...(plan.save ? { save: saveFor(r) } : {}), plan: { ...plan, header: r.header } }],
    };
    writeFileSync(join(out, 'job.json'), JSON.stringify(job));
    // Inputs land a frame or two apart from run to run (the page polls the frame counter), so a plan can lose its
    // way – a step onto the stairs twice, a person walking in. Such a run is tried again (--attempts, default 3);
    // a reading that is wrong is a failure no matter how often it is tried.
    const attempts = Math.max(1, Number(opt('attempts', 3)));
    for (let a = 1; a <= attempts; a++) {
      log(`  ${r.name}${a > 1 ? ` (attempt ${a})` : ''} …`);
      rmSync(resultFile, { force: true });
      await new Promise((done) => {
        const p = spawn(electron, [join(root, 'scripts', 'rom-matrix', 'live.mjs'), join(out, 'job.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
        p.stdout.on('data', () => {});
        p.stderr.on('data', () => {});
        p.on('exit', done);
      });
      const x = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8'))[0] : null;
      const v = x ? judge(r, plan, x) : { error: 'no result (the emulator process ended early)', notes: [] };
      v.attempts = a;
      r.liveResult = v;
      if (x) all.push(x);
      const lost = v.error || v.notes.some((n) => n.startsWith('plan stopped'));
      const wrong = [v.party, v.place, v.battle, v.catch].includes(false) && !lost;
      if (!lost || wrong) break;
    }
    log(`    party ${mark(r.liveResult.party)} place ${mark(r.liveResult.place)} battle ${mark(r.liveResult.battle)} catch ${mark(r.liveResult.catch)}${r.liveResult.error ? ` – ${r.liveResult.error}` : ''}`);
  }
  writeFileSync(join(out, 'live.json'), JSON.stringify(all, null, 1));
}

/** Checks the plan's expectations against what the live readers saw. */
function judge(r, plan, x) {
  const checks = (x.log || []).filter((l) => l.do === 'check');
  const failed = (x.log || []).find((l) => l.ok === false && l.required !== false);
  const verdict = { party: null, place: null, battle: null, catch: null, notes: [], error: x.error || null, frames: x.frames, ms: x.ms, shots: x.shots };
  if (failed) verdict.notes.push(`plan stopped: ${failed.do} ${JSON.stringify(failed.until || failed.to || '')}`);
  const randomized = r.kind === 'randomized';
  for (const c of checks) {
    const exp = (plan.expect || {})[c.name] || {};
    const team = c.team?.hack ? null : c.team;
    if (c.team?.hack) for (const k of ['party', 'place', 'battle']) verdict[k] = verdict[k] ?? 'hack'; // shown as "not supported"
    if (exp.party) {
      const mon = team?.party?.[0];
      const want = exp.party;
      const ok = !!mon && [].concat(want.level ?? mon.level).includes(mon.level) && (randomized || !want.species || [].concat(want.species).includes(mon.species)) && mon.species > 0 && mon.hp <= mon.maxHp;
      verdict.party = verdict.party === false ? false : ok;
      verdict.notes.push(`${c.name}: ${mon ? `${mon.name} Lv${mon.level} ${mon.hp}/${mon.maxHp} "${mon.nickname}"${mon.itemName ? ` holding ${mon.itemName}` : ''}` : 'no party'}${team?.party?.length > 1 ? ` (+${team.party.length - 1})` : ''}`);
    }
    if (exp.place !== undefined) {
      const shown = c.place?.shown || null;
      // (place: true – any name of the game's own: a plan that starts from a save doesn't know where it is)
      const ok = exp.place === true ? !!shown : r.kind === 'patched' && exp.placeHack !== undefined ? shown === exp.placeHack : [].concat(exp.place).includes(shown);
      verdict.place = verdict.place === false ? false : ok;
      verdict.notes.push(`${c.name}: place "${shown}"`);
    }
    if (exp.catch) {
      // a real catch: a second Pokémon in the team, filed by the app's run logic under the area the plan names
      const encs = (c.run?.encounters || []).filter((x) => x.area !== 'starter');
      const mon = team?.party?.[1];
      const hit = encs.find((x) => x.name === exp.catch.area && (!mon || x.species === mon.species));
      verdict.catch = verdict.catch === false ? false : !!hit;
      verdict.notes.push(`${c.name}: ${mon ? `caught ${mon.name} Lv${mon.level}` : 'no catch'} → ${hit ? `area "${hit.name}"` : `areas ${JSON.stringify(encs.map((x) => x.name))}, inbox ${(c.run?.inbox || []).length}`}`);
    }
    if (exp.battle === null) {
      // the battle is over: the panel must not keep showing the opponent
      const ok = !team?.battle;
      if (!ok) verdict.battle = false;
      verdict.notes.push(`${c.name}: ${team?.battle ? `still a battle (${team.battle.enemy?.name || '?'})` : 'no battle'}`);
    }
    if (exp.battle) {
      const b = team?.battle;
      const ok = !!b?.enemy && b.kind === (exp.battle.kind ?? b.kind) && [].concat(exp.battle.level ?? b.enemy.level).includes(b.enemy.level) && (randomized || !exp.battle.species || [].concat(exp.battle.species).includes(b.enemy.species));
      verdict.battle = verdict.battle === false ? false : ok;
      verdict.notes.push(`${c.name}: battle ${b?.enemy ? `${b.kind} ${b.enemy.name} Lv${b.enemy.level} ${b.enemy.hp}/${b.enemy.maxHp}` : 'none'}`);
    }
  }
  return verdict;
}

if (flag('live')) await runLive(targets.filter((r) => r.system));

// ---------------------------------------------------------------- report

const rows = targets.map((r) => {
  const L = r.liveResult || {};
  return {
    rom: r.name, kind: r.kind, patch: r.patch || null, game: r.gameId || r.base?.gameId || null, system: r.system, code: r.code, crc: r.crc, vanilla: r.vanilla,
    entry: r.entry, places: r.places, species: r.species, static: r.static, live: L,
  };
});
writeFileSync(join(out, 'matrix.json'), JSON.stringify({ at: new Date().toISOString(), sources, notes, patches: patches.map(({ name, format, hack, result }) => ({ name, format, hack, result })), rows }, null, 1));
const md = [
  '| ROM | Kind | Memory table | Places (from file) | Species table | Party (live) | Location (live) | Battle (live) | Catch (live) | Notes |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((x) => `| ${x.rom} | ${x.kind}${x.vanilla ? ' (retail CRC)' : ''} | ${x.entry || '–'} | ${x.static?.places || '–'}${x.places ? ` (${x.places.count})` : ''} | ${x.species ? `${x.species.engine}${x.species.changed ? `, ${x.species.changed} changed` : ''}` : '–'} | ${mark(x.live.party)} | ${mark(x.live.place)} | ${mark(x.live.battle)} | ${mark(x.live.catch)} | ${[x.live.skipped, x.live.error, ...(x.live.notes || [])].filter(Boolean).join('; ')} |`),
].join('\n');
writeFileSync(join(out, 'matrix.md'), `${md}\n`);
log(`\npatches:`);
for (const p of patches) log(`  ${p.name}: ${p.result}`);
if (notes.length) log(`notes:\n  ${notes.join('\n  ')}`);
log(`\n${md}\n\nresults: ${join(out, 'matrix.json')}, ${join(out, 'matrix.md')}`);
if (!flag('keep')) {
  for (const d of ['patched', 'randomized', 'unzipped']) rmSync(join(work, d), { recursive: true, force: true });
}
void PLANS;
