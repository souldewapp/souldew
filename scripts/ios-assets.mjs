#!/usr/bin/env node
// Copies what the iOS app runs into ios/souldew-app (a plain folder the Xcode project bundles as a resource):
// server/, shared/, web/, package.json and the production node_modules. No Electron, no tools/ – there is no Java for the
// randomizer on iOS, and no JIT for the 3DS player.
// Usage: node scripts/ios-assets.mjs
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, lstatSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'ios', 'souldew-app');
const win = process.platform === 'win32';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const dir of ['server', 'shared', 'web']) cpSync(join(root, dir), join(out, dir), { recursive: true });
copyFileSync(join(root, 'package.json'), join(out, 'package.json'));

// production dependencies only, installed in a scratch folder so the repo's node_modules stays untouched
const scratch = mkdtempSync(join(tmpdir(), 'souldew-ios-'));
try {
  copyFileSync(join(root, 'package.json'), join(scratch, 'package.json'));
  if (existsSync(join(root, 'package-lock.json'))) copyFileSync(join(root, 'package-lock.json'), join(scratch, 'package-lock.json'));
  execFileSync(win ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: scratch, stdio: 'inherit', shell: win });
  // (.bin holds command-line links to the packages' scripts: not needed in the app, and a copied link points nowhere)
  cpSync(join(scratch, 'node_modules'), join(out, 'node_modules'), { recursive: true, filter: (src) => !/[\\/]node_modules[\\/]\.bin([\\/]|$)/.test(src) });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const size = (p) => readdirSync(p, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(join(p, e.name)) : lstatSync(join(p, e.name)).size), 0);
console.log(`assets ready: ${out} (${(size(out) / 1048576).toFixed(1)} MB)`);
