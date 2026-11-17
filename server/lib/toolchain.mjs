// Java + Universal Pokemon Randomizer ZX detection, download and invocation.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync, readdirSync, chmodSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, delimiter, dirname } from 'node:path';
import { listZip, readZipEntry } from './zip.mjs';
import { TOOLS_DIR, BUNDLED_TOOLS, CACHE_DIR } from './paths.mjs';
import { httpError, removeQuietly } from './fsutil.mjs';
import { PRESETS, buildValues, toProperties } from '../../shared/randomizer-options.mjs';

export const UPR_VERSION = '4.6.1';
export const UPR_URL = 'https://github.com/Ajarmar/universal-pokemon-randomizer-zx/releases/download/v4.6.1/PokeRandoZX-v4_6_1.zip';
export const UPR_ZIP_SHA256 = '26051fe8a6665ea0582dfcd4d1c3e4889da42a2f731f5fc530fff0cb691a43fd';
const BUNDLED_JAR = join(BUNDLED_TOOLS, 'upr', 'PokeRandoZX.jar');
export const UPR_JAR = existsSync(BUNDLED_JAR) ? BUNDLED_JAR : join(TOOLS_DIR, 'upr', 'PokeRandoZX.jar');
export const BRIDGE_DIR = join(BUNDLED_TOOLS, 'upr-bridge');
const JAVA_EXE = process.platform === 'win32' ? 'java.exe' : 'java';
const bundledJava = (arch) => join(BUNDLED_TOOLS, 'jre', `${process.platform}-${arch}`, 'bin', JAVA_EXE);
const BUNDLED_JAVA = bundledJava(process.arch);
// An arm64 Windows PC runs the bundled x64 runtime through Windows' x64 emulation.
const BUNDLED_FALLBACK = process.platform === 'win32' && process.arch === 'arm64' ? bundledJava('x64') : null;

/**
 * JVM options for the randomizer. UTF-8 as the default charset: Java 17 on Windows would otherwise read and write
 * text in the ANSI code page (cp1252), unlike macOS – the same seed must give the same game on every computer.
 */
export const JAVA_OPTS = ['-Xmx1g', '-Djava.awt.headless=true', '-Dfile.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8'];

/**
 * A 3DS game (Gen 6/7) needs far more Java heap: UPR ZX's own launcher starts it with -Xmx4608M (Sun runs out of memory
 * below ~2 GB). Only a ceiling – Java takes what it uses.
 */
export const CTR_HEAP = '-Xmx4608m';
/** Rebuilding a 3DS game writes ~3 GB and hashes it: minutes on a slow disk. */
export const CTR_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * JVM options of one bridge call. `ctr`: a 3DS game – the larger heap. `workDir`: UPR's working folder (the patched
 * SysConstants in tools/upr-bridge reads -Dsouldew.upr.root; without it UPR writes next to its jar, inside the app).
 */
export function javaOptsFor({ ctr = false, workDir = null } = {}) {
  const root = workDir ? [`-Dsouldew.upr.root=${workDir}`] : [];
  if (!ctr) return [...JAVA_OPTS, ...root];
  return [CTR_HEAP, ...JAVA_OPTS.filter((o) => !o.startsWith('-Xmx')), ...root];
}

/**
 * The @@ lines of the bridge's output → { json, warnings, error, settingsString, done, code, step, files }.
 * Other lines (UPR's own "NCCH: …" chatter) are ignored.
 */
export function parseBridgeOutput(out) {
  const result = { json: null, warnings: [], error: null, settingsString: null, done: null, code: null, step: null, files: null };
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.match(/^@@(\w+) (.*)$/);
    if (!m) continue;
    let value;
    try {
      value = JSON.parse(m[2]);
    } catch {
      continue; // a garbled line must not throw inside an event handler (= server crash)
    }
    if (m[1] === 'JSON') result.json = value;
    else if (m[1] === 'WARN') result.warnings.push(value);
    else if (m[1] === 'ERROR') result.error = value;
    else if (m[1] === 'SETTINGS') result.settingsString = value;
    else if (m[1] === 'DONE') result.done = value;
    else if (m[1] === 'CODE') result.code = value;
    else if (m[1] === 'STEP') result.step = value;
    else if (m[1] === 'FILES') result.files = value;
  }
  return result;
}

let javaCache = null;

/**
 * Android (nodejs-mobile reports platform "android"): there is no Java, but the randomizer is plain Java code and the
 * Android app packs it as DEX (scripts/android-assets.mjs: PokeRandoZX.jar = classes.dex with the bridge + classes2.dex
 * with UPR + UPR's resource files). Android's own runtime runs it: `dalvikvm64 -Xmx… -cp <jar> SoulLinkBridge …`. The
 * bridge's classes come first in the dex order, like the bridge folder on a desktop class path.
 * Why dalvikvm and not app_process: app_process appends the device's `dalvik.vm.heapsize` (512 MB) after any -Xmx, so a
 * 3DS game (Omega Ruby: ~1.9 GB output) ran out of memory halfway; dalvikvm takes -Xmx as given. The heap must fit into
 * the low 4 GB of address space, so ~1.8 GB is the most (−Xmx1900m and above fail to start) – checked on a Snapdragon 8
 * Gen 3 tablet: Omega Ruby randomizes in about a minute with it.
 */
export const ANDROID_DALVIKVM = ['/apex/com.android.art/bin/dalvikvm64', '/apex/com.android.art/bin/dalvikvm'];
export const ANDROID_HEAP = '-Xmx1800m';
const androidRuntime = (exists = existsSync) => ANDROID_DALVIKVM.find((p) => exists(p)) || null;

/** The command that runs the bridge: [binary, argv, cwd]. `platform`/`java` injectable for tests. */
export function bridgeCommand({ platform = process.platform, java, jar = UPR_JAR, bridgeDir = BRIDGE_DIR, ctr = false, workDir = null, args = [] }) {
  if (platform === 'android') {
    // ART takes the options of a JVM that mean something to it: system properties (no -Xss, awt) and the heap – 1 GB
    // for a Game Boy / DS game, the most ART allows for a 3DS game
    const opts = javaOptsFor({ ctr, workDir }).filter((o) => /^-D(file\.encoding|souldew\.)/.test(o));
    return [java.bin, [ctr ? ANDROID_HEAP : '-Xmx1g', ...opts, '-cp', jar, 'SoulLinkBridge', ...args], workDir || dirname(jar)];
  }
  // the bridge folder first: it carries a fixed copy of UPR's Effectiveness (EnumMap instead of HashMap – the order
  // of a HashMap of enums depends on the JVM, so "sensible items" on Gen 4/5 gave different ROMs per Java version)
  // and of SysConstants (the working folder above)
  return [java.bin, [...javaOptsFor({ ctr, workDir }), '-cp', [bridgeDir, jar].join(delimiter), 'SoulLinkBridge', ...args], workDir || dirname(jar)];
}

/** Installed JDKs / JREs in the usual Windows folders (…\Java\jdk-17\bin\java.exe, Adoptium, Microsoft, Zulu …). */
export function windowsJavaCandidates(env = process.env, list = readdirSync) {
  const found = [];
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean);
  // 'jdk-21.0.4.7-hotspot' → 21, 'jdk1.8.0_202' / 'jre1.8.0' → 8
  const major = (name) => {
    const m = /(\d+)(?:\.(\d+))?/.exec(name);
    return !m ? 0 : m[1] === '1' && m[2] ? Number(m[2]) : Number(m[1]);
  };
  for (const root of [...new Set(roots)]) {
    for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru']) {
      let names = [];
      try {
        names = list(join(root, vendor));
      } catch {
        continue;
      }
      for (const name of names) found.push({ path: join(root, vendor, name, 'bin', 'java.exe'), major: major(name) });
    }
  }
  // newest first, so a current Java wins over an old Java 8 left behind
  return found.sort((a, b) => b.major - a.major).map((f) => f.path);
}

function javaCandidates() {
  // The bundled runtime comes first: both players then use the identical Java version,
  // which keeps seeded randomization byte-identical across machines.
  const list = [BUNDLED_JAVA];
  if (BUNDLED_FALLBACK) list.push(BUNDLED_FALLBACK);
  if (process.env.JAVA_HOME) list.push(join(process.env.JAVA_HOME, 'bin', JAVA_EXE));
  list.push('java');
  if (process.platform === 'darwin') {
    const r = spawnSync('/usr/libexec/java_home', [], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) list.push(join(r.stdout.trim(), 'bin', 'java'));
    list.push('/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home/bin/java');
    list.push('/opt/homebrew/opt/openjdk/bin/java');
  }
  if (process.platform === 'win32') list.push(...windowsJavaCandidates());
  return list;
}

export function detectJava(force = false) {
  if (javaCache && !force) return javaCache;
  if (process.platform === 'android') {
    const bin = androidRuntime();
    javaCache = bin ? { ok: true, bin, version: 'Android Runtime', major: 8, bundled: true, vendor: 'ART' } : { ok: false, bin: null, version: null, major: 0 };
    return javaCache;
  }
  for (const bin of javaCandidates()) {
    try {
      // windowsHide: java.exe is a console program – without it every check would flash a console window
      const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      const text = `${r.stderr || ''}${r.stdout || ''}`;
      const m = text.match(/version "([^"]+)"/);
      if (r.status === 0 && m) {
        const raw = m[1];
        const major = raw.startsWith('1.') ? Number(raw.split('.')[1]) : Number(raw.split(/[.+-]/)[0]);
        javaCache = { ok: major >= 8, bin, version: raw, major, bundled: bin === BUNDLED_JAVA || bin === BUNDLED_FALLBACK, vendor: text.split(/\r?\n/)[1]?.trim() || '' };
        return javaCache;
      }
    } catch {
      // try next candidate
    }
  }
  javaCache = { ok: false, bin: null, version: null, major: 0 };
  return javaCache;
}

export function uprStatus() {
  return {
    version: UPR_VERSION,
    installed: existsSync(UPR_JAR),
    bridge: existsSync(join(BRIDGE_DIR, 'SoulLinkBridge.class')),
    jar: UPR_JAR,
  };
}

export async function installUpr() {
  const res = await fetch(UPR_URL);
  if (!res.ok) throw httpError(502, `Downloading the randomizer failed (HTTP ${res.status})`, 'uprDownload', { detail: `HTTP ${res.status}` });
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== UPR_ZIP_SHA256) throw httpError(502, 'The randomizer download is damaged (its checksum doesn’t match) – nothing was installed', 'uprChecksum');
  mkdirSync(join(TOOLS_DIR, 'upr'), { recursive: true });
  const tmp = join(TOOLS_DIR, 'upr', 'download.zip');
  writeFileSync(tmp, buf);
  try {
    const entry = listZip(tmp).find((e) => e.name.endsWith('PokeRandoZX.jar'));
    if (!entry) throw httpError(502, 'PokeRandoZX.jar is missing from the randomizer download', 'uprChecksum');
    writeFileSync(UPR_JAR + '.part', readZipEntry(tmp, entry));
    renameSync(UPR_JAR + '.part', UPR_JAR);
  } finally {
    rmSync(tmp, { force: true });
  }
  return uprStatus();
}

/**
 * What the new-run wizard needs to know about a Gen 1–5 game (POST /api/rom/inspect): UPR ZX's `info`, with a trial
 * run of the recommended preset (`gen`: the game's generation, for that preset's values) – the whole randomization in
 * memory, nothing written (SoulLinkBridge info). A game UPR can't load → { unsupported: true, reason: 'unreadable' };
 * one it loads but can't randomize (a ROM hack or release whose data isn't where UPR expects it) → reason 'randoCrash'
 * with `what`, the exception's class: the page says so before a run is built, instead of a failed build. Java or the
 * randomizer missing → `missingTool`. Never the bridge's own output (#43). `run`: runBridge (tests pass a stand-in).
 */
export async function inspectRom(path, { gen = null, run = runBridge, dir = CACHE_DIR } = {}) {
  const props = join(dir, `trial-${randomBytes(6).toString('hex')}.properties`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(props, toProperties(buildValues(PRESETS[0].values, gen)));
    const out = await run(['info', path, props, '1']);
    const info = out.json || {};
    if (typeof info.trial === 'string') {
      // the trial's stack trace (the bridge prints it after "@@TRIAL <exception>") – for the diagnostics, not the page's text
      const stderr = String(out.stderr || '');
      const at = stderr.lastIndexOf('@@TRIAL ');
      const trace = at >= 0 ? randomizerTrace({ error: stderr.slice(at + 8).split(/\r?\n/)[0], stderr: stderr.slice(at) }) : undefined;
      return { ...info, unsupported: true, reason: 'randoCrash', what: info.trial, trace };
    }
    return info;
  } catch (e) {
    const missingTool = !detectJava().ok ? 'java' : !uprStatus().installed ? 'upr' : null;
    if (!missingTool) console.warn('[inspect]', e.message);
    return { unsupported: true, reason: missingTool ? null : 'unreadable', missingTool };
  } finally {
    try {
      rmSync(props, { force: true });
    } catch (e) {
      console.warn(`[inspect] the trial's settings file couldn’t be removed (${e.code || 'error'})`); // (never the wizard's answer)
    }
  }
}

/**
 * A randomizer run that failed, as the answer the page shows: in words, with a code it translates – never the
 * randomizer's own output (#43). UPR ZX stopping with a Java exception (data it doesn't expect – a ROM hack, a release
 * it doesn't know) → 422 'randoFailed', naming only the exception's class for a bug report ("Index 1286 out of bounds
 * for length 1268" and the like say nothing to a player); a timeout → 504 'randoTimeout'. Errors that are answers
 * already (Java or the randomizer missing, an invalid seed …) pass through. The bridge's output stays on the error
 * (`details`) for the server's log.
 */
export function randomizerError(e) {
  if (!e || e.status || !e.details) return e;
  if (e.code === 'timeout') return Object.assign(httpError(504, 'The randomizer took too long and was stopped', 'randoTimeout'), { details: e.details });
  const cls = String(e.details.error || e.details.stderr || '').match(/\b(?:[a-z]\w*\.)+([A-Z]\w*(?:Exception|Error))\b/)?.[1] || null;
  return Object.assign(httpError(422, `The randomizer can’t build this game${cls ? ` (${cls})` : ''} – play it without the randomizer`, 'randoFailed', {
    what: cls || `exit ${e.details.exitCode}`,
    trace: randomizerTrace(e.details),
  }), { details: e.details });
}

/**
 * Where in the randomizer it stopped: the exception's message and the first frames of its Java stack trace, shortened to
 * "RomHandler.method:line" (UPR ZX's classes, the bridge's own). The app keeps them in its diagnostics, so a player's
 * report names the game data the randomizer choked on – "Index 707 out of bounds for length 375" alone doesn't (pitcher_14's
 * reports, 2.7.4). Only class names and line numbers: no paths, no ROM data.
 */
/**
 * A path inside a message, the whole of it – its last part too, which can be the user's folder ("x.nds (in C:\Users\Max)"):
 * from a drive (C:\ or C:/), a UNC share or a root with a folder after it (\\server\…, /Users/…, but not the
 * "com/dabomstew" of a class name), a relative path starting at a user folder's parent or a ".." ("Users\Max\…",
 * "..\Max Mustermann\…") or any word with a backslash in it (a class name never has one). Folder names may hold spaces
 * ("C:\Users\Max Mustermann\…", "/Users/anna maria/Library/Application Support/…"), so it runs to the line's last
 * separator and then to the reason Java puts after a file (" (No such file or directory)"), a ")" or the line's end – a
 * message with text after a path loses a little of it rather than show a user name.
 */
export const PATH_IN_TEXT = /(?:(?<![A-Za-z])[A-Za-z]:[\\/]|(?<![\w.$-])(?:\.\.?|[Uu]sers|home)[\\/]|(?<![^\s"'(=,])[^\s"'(=,\\/]*\\|(?<![\w.$-])[\\/](?=[^\r\n]*[\\/]))(?:[^\r\n]*[\\/])?[^\r\n]*?(?=\s\(|\)|[\r\n]|$)/g;

export function randomizerTrace(details = {}) {
  const lines = String(details.stderr || '').split(/\r?\n/);
  const msg = (String(details.error || '').trim() || lines.find((l) => /(?:Exception|Error)\b/.test(l)) || '')
    .replace(PATH_IN_TEXT, '…') // a file the randomizer named: neither where it lies nor its name (a user's folder can be both)
    .trim()
    .slice(0, 200);
  const frames = [];
  for (const l of lines) {
    const m = l.match(/^\s*at\s+(?:[\w$]+\.)*([\w$]+\.[\w$<>]+)\((?:[\w$]+\.java:(\d+)|[^)]*)\)/);
    if (!m) continue;
    frames.push(m[2] ? `${m[1]}:${m[2]}` : m[1]);
    if (frames.length >= 8) break;
  }
  return msg || frames.length ? [msg, ...frames].filter(Boolean) : undefined;
}

/**
 * Run the SoulLinkBridge (see tools/upr-bridge/SoulLinkBridge.java). Resolves with parsed @@ lines.
 * `ctr`: a 3DS game – bigger heap, its own working folder under the cache (removed afterwards), a longer timeout.
 * `onLine`: called with every line the bridge prints while it runs (progress of a 3DS build).
 * A failure carries `code` when the bridge named one ('encrypted', 'memory', 'timeout').
 */
export function runBridge(args, { timeoutMs, ctr = false, onLine = null, spawnFn = spawn, removeDir = undefined } = {}) {
  const java = detectJava();
  if (!java.ok) return Promise.reject(httpError(409, 'Java 8+ wasn’t found. Install Java (e.g. Temurin 21 from adoptium.net).', 'javaMissing'));
  if (!existsSync(UPR_JAR)) return Promise.reject(httpError(409, 'Universal Pokemon Randomizer ZX is missing – reinstall souldew, or play without the randomizer.', 'uprMissing'));
  if (process.platform === 'android') {
    try {
      chmodSync(UPR_JAR, 0o444); // Android refuses to load code from a file the app can still write to
    } catch {
      // read-only already
    }
  }
  const limit = timeoutMs ?? (ctr ? CTR_TIMEOUT_MS : 180000);
  // every run's own folder for the game files UPR unpacks (a 3DS game: hundreds of MB) – never inside the app, never
  // shared: two runs on the same game (the wizard's check while a build runs) took each other's files away
  const workDir = join(CACHE_DIR, ctr ? 'upr-3ds' : 'upr-work', randomBytes(6).toString('hex'));
  mkdirSync(workDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const [bin, argv, cwd] = bridgeCommand({ java, ctr, workDir, args });
    const child = spawnFn(bin, argv, {
      cwd,
      windowsHide: true, // no console window next to the app while the randomizer runs
    });
    let out = '';
    let err = '';
    let partial = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, limit);
    child.stdout.on('data', (d) => {
      out += d;
      if (!onLine) return;
      const lines = (partial + d).split(/\r?\n/);
      partial = lines.pop();
      for (const l of lines) {
        try {
          onLine(l);
        } catch {
          // progress only – never the build's failure
        }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    // the answer first, then the working folder – best effort: on Windows a scanner holding one of UPR's files made
    // rmSync throw inside this handler, the promise never settled and the wizard hung on "Checking the game …"
    const cleanup = () => {
      clearTimeout(timer);
      setImmediate(() => removeQuietly(workDir, { rm: removeDir, label: 'randomizer' }));
    };
    child.on('error', (e) => {
      reject(e);
      cleanup();
    });
    child.on('close', (code) => {
      cleanup();
      // `code`: the code the bridge named (@@CODE), `exitCode`: the process' exit code
      const result = { ...parseBridgeOutput(out), exitCode: code, stdout: out, stderr: err };
      if (code !== 0 || result.error) {
        const detail = timedOut ? `timed out after ${Math.round(limit / 1000)} s` : result.error || err.split(/\r?\n/).find((l) => l.trim())?.trim() || `exit code ${code}`;
        const e = new Error(`Randomizer error: ${detail}`);
        e.details = result;
        e.code = timedOut ? 'timeout' : result.code || (/OutOfMemoryError/.test(err) ? 'memory' : null);
        reject(e);
        return;
      }
      resolve(result);
    });
  });
}
