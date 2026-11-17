#!/usr/bin/env node
// Copies what the Android app runs into android/app/src/main/assets/souldew:
// server/, shared/, web/, package.json, the production node_modules and the randomizer converted for Android
// (no Electron, no other tools/).
// Needs: node, npm, a JDK (`jar`) and the Android SDK (build-tools: d8, a platform: android.jar).
// Usage: node scripts/android-assets.mjs
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, lstatSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'android', 'app', 'src', 'main', 'assets', 'souldew');
const win = process.platform === 'win32';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const dir of ['server', 'shared', 'web']) cpSync(join(root, dir), join(out, dir), { recursive: true });
copyFileSync(join(root, 'package.json'), join(out, 'package.json'));

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', shell: win && /\.(bat|cmd)$/i.test(cmd), ...opts });
const newest = (dir, test) => readdirSync(dir).filter(test).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

// production dependencies only, installed in a scratch folder so the repo's node_modules stays untouched
const scratch = mkdtempSync(join(tmpdir(), 'souldew-android-'));
try {
  copyFileSync(join(root, 'package.json'), join(scratch, 'package.json'));
  if (existsSync(join(root, 'package-lock.json'))) copyFileSync(join(root, 'package-lock.json'), join(scratch, 'package-lock.json'));
  run(win ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: scratch });
  // (.bin holds command-line links to the packages' scripts: not needed in the app, and a copied link points nowhere)
  cpSync(join(scratch, 'node_modules'), join(out, 'node_modules'), { recursive: true, filter: (src) => !/[\\/]node_modules[\\/]\.bin([\\/]|$)/.test(src) });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// The randomizer (Universal Pokemon Randomizer ZX + souldew's bridge) as DEX for Android's runtime:
//   PokeRandoZX.jar = classes.dex (the bridge folder: SoulLinkBridge + fixed Effectiveness / SysConstants – first, like
//   the bridge folder before the jar on a desktop class path) + classes2.dex (UPR) + UPR's non-class files (its ROM
//   offset tables are read from inside the jar; d8 leaves them out)
function buildAndroidRandomizer() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
  const bt = join(sdk, 'build-tools', newest(join(sdk, 'build-tools'), (n) => /^\d/.test(n)));
  const d8 = join(bt, win ? 'd8.bat' : 'd8');
  const androidJar = join(sdk, 'platforms', newest(join(sdk, 'platforms'), (n) => /^android-\d+$/.test(n)), 'android.jar');
  const jdk = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin') : null;
  const jar = jdk ? join(jdk, win ? 'jar.exe' : 'jar') : 'jar';
  const upr = join(root, 'tools', 'upr', 'PokeRandoZX.jar');
  const bridge = join(root, 'tools', 'upr-bridge');
  if (!existsSync(upr)) throw new Error('tools/upr/PokeRandoZX.jar missing');

  const work = mkdtempSync(join(tmpdir(), 'souldew-rando-'));
  try {
    const stage = join(work, 'stage');
    mkdirSync(stage);
    const dexOf = (name, args) => {
      const d = join(work, name);
      mkdirSync(d);
      run(d8, ['--release', '--min-api', '26', '--lib', androidJar, '--output', d, ...args]);
      return join(d, 'classes.dex');
    };
    copyFileSync(dexOf('bridge', ['--classpath', upr, ...walk(bridge).filter((f) => f.endsWith('.class'))]), join(stage, 'classes.dex'));
    copyFileSync(dexOf('upr', [upr]), join(stage, 'classes2.dex'));
    // UPR's own files (everything that is not a class)
    const res = join(work, 'res');
    mkdirSync(res);
    run(jar, ['xf', upr], { cwd: res });
    for (const f of walk(res)) if (!f.endsWith('.class') && !/META-INF[\\/]/.test(f)) {
      const rel = f.slice(res.length + 1);
      mkdirSync(dirname(join(stage, rel)), { recursive: true });
      copyFileSync(f, join(stage, rel));
    }
    const target = join(out, 'tools', 'upr');
    mkdirSync(target, { recursive: true });
    run(jar, ['cf', join(target, 'PokeRandoZX.jar'), '-C', stage, '.']);
    // (the server checks for this file to know the bridge is there)
    const marker = join(out, 'tools', 'upr-bridge');
    mkdirSync(marker, { recursive: true });
    copyFileSync(join(bridge, 'SoulLinkBridge.class'), join(marker, 'SoulLinkBridge.class'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
buildAndroidRandomizer();

const size = (p) => readdirSync(p, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(join(p, e.name)) : lstatSync(join(p, e.name)).size), 0);
console.log(`assets ready: ${out} (${(size(out) / 1048576).toFixed(1)} MB)`);
