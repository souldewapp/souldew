// Java + Universal Pokemon Randomizer ZX detection, download and invocation.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, delimiter, dirname } from 'node:path';
import { listZip, readZipEntry } from './zip.mjs';
import { TOOLS_DIR, BUNDLED_TOOLS } from './paths.mjs';

export const UPR_VERSION = '4.6.1';
export const UPR_URL = 'https://github.com/Ajarmar/universal-pokemon-randomizer-zx/releases/download/v4.6.1/PokeRandoZX-v4_6_1.zip';
export const UPR_ZIP_SHA256 = '26051fe8a6665ea0582dfcd4d1c3e4889da42a2f731f5fc530fff0cb691a43fd';
const BUNDLED_JAR = join(BUNDLED_TOOLS, 'upr', 'PokeRandoZX.jar');
export const UPR_JAR = existsSync(BUNDLED_JAR) ? BUNDLED_JAR : join(TOOLS_DIR, 'upr', 'PokeRandoZX.jar');
export const BRIDGE_DIR = join(BUNDLED_TOOLS, 'upr-bridge');
const BUNDLED_JAVA = join(BUNDLED_TOOLS, 'jre', `${process.platform}-${process.arch}`, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');

let javaCache = null;

function javaCandidates() {
  // The bundled runtime comes first: both players then use the identical Java version,
  // which keeps seeded randomization byte-identical across machines.
  const list = [BUNDLED_JAVA];
  if (process.env.JAVA_HOME) list.push(join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  list.push('java');
  if (process.platform === 'darwin') {
    const r = spawnSync('/usr/libexec/java_home', [], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) list.push(join(r.stdout.trim(), 'bin', 'java'));
    list.push('/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home/bin/java');
    list.push('/opt/homebrew/opt/openjdk/bin/java');
  }
  if (process.platform === 'win32') {
    for (const base of ['C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Microsoft']) {
      list.push(join(base, 'bin', 'java.exe'));
    }
  }
  return list;
}

export function detectJava(force = false) {
  if (javaCache && !force) return javaCache;
  for (const bin of javaCandidates()) {
    try {
      const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 15000 });
      const text = `${r.stderr || ''}${r.stdout || ''}`;
      const m = text.match(/version "([^"]+)"/);
      if (r.status === 0 && m) {
        const raw = m[1];
        const major = raw.startsWith('1.') ? Number(raw.split('.')[1]) : Number(raw.split(/[.+-]/)[0]);
        javaCache = { ok: major >= 8, bin, version: raw, major, bundled: bin === BUNDLED_JAVA, vendor: text.split('\n')[1]?.trim() || '' };
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
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(buf).digest('hex');
  if (sha !== UPR_ZIP_SHA256) throw new Error('Prüfsumme des Randomizer-Downloads stimmt nicht – abgebrochen');
  mkdirSync(join(TOOLS_DIR, 'upr'), { recursive: true });
  const tmp = join(TOOLS_DIR, 'upr', 'download.zip');
  writeFileSync(tmp, buf);
  try {
    const entry = listZip(tmp).find((e) => e.name.endsWith('PokeRandoZX.jar'));
    if (!entry) throw new Error('PokeRandoZX.jar nicht im Download gefunden');
    writeFileSync(UPR_JAR + '.part', readZipEntry(tmp, entry));
    renameSync(UPR_JAR + '.part', UPR_JAR);
  } finally {
    rmSync(tmp, { force: true });
  }
  return uprStatus();
}

/** Run the SoulLinkBridge (see tools/upr-bridge/SoulLinkBridge.java). Resolves with parsed @@ lines. */
export function runBridge(args, { timeoutMs = 180000 } = {}) {
  const java = detectJava();
  if (!java.ok) return Promise.reject(new Error('Java 8+ wurde nicht gefunden. Bitte Java installieren (z. B. Temurin 21 von adoptium.net).'));
  if (!existsSync(UPR_JAR)) return Promise.reject(new Error('Universal Pokemon Randomizer ZX fehlt – bitte im Setup installieren.'));
  return new Promise((resolve, reject) => {
    const cp = [UPR_JAR, BRIDGE_DIR].join(delimiter);
    const child = spawn(java.bin, ['-Xmx1g', '-Djava.awt.headless=true', '-cp', cp, 'SoulLinkBridge', ...args], {
      cwd: dirname(UPR_JAR),
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = { code, json: null, warnings: [], error: null, settingsString: null, done: null, stdout: out, stderr: err };
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^@@(\w+) (.*)$/);
        if (!m) continue;
        let value;
        try {
          value = JSON.parse(m[2]);
        } catch {
          continue; // a garbled line must not throw inside this event handler (= server crash)
        }
        if (m[1] === 'JSON') result.json = value;
        else if (m[1] === 'WARN') result.warnings.push(value);
        else if (m[1] === 'ERROR') result.error = value;
        else if (m[1] === 'SETTINGS') result.settingsString = value;
        else if (m[1] === 'DONE') result.done = value;
      }
      if (code !== 0 || result.error) {
        const detail = timedOut ? `Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)} s` : result.error || err.split('\n').find((l) => l.trim()) || `Exit-Code ${code}`;
        const e = new Error(`Randomizer-Fehler: ${detail}`);
        e.details = result;
        reject(e);
        return;
      }
      resolve(result);
    });
  });
}
