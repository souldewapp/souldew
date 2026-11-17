#!/usr/bin/env node
// Downloads nodejs-mobile (Node 18 as libnode.so for Android) and unpacks what the app needs into
// android/app/libnode/ (bin/<abi>/libnode.so for arm64-v8a and x86_64, include/node/*.h). The zip's SHA-256 is pinned.
//
//   node scripts/fetch-nodejs-mobile.mjs [--force]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listZip, readZipEntry } from '../server/lib/zip.mjs';

export const VERSION = '18.20.4';
export const ZIP_URL = `https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v${VERSION}/nodejs-mobile-v${VERSION}-android.zip`;
export const SHA256 = 'bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af';
const ABIS = ['arm64-v8a', 'x86_64'];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'android', 'app', 'libnode');

if (!process.argv.includes('--force') && ABIS.every((a) => existsSync(join(out, 'bin', a, 'libnode.so'))) && existsSync(join(out, 'include', 'node', 'node.h'))) {
  console.log(`nodejs-mobile ${VERSION} is already in ${out}`);
  process.exit(0);
}

console.log(`downloading ${ZIP_URL}`);
const res = await fetch(ZIP_URL);
if (!res.ok) throw new Error(`download failed (${res.status})`);
const buf = Buffer.from(await res.arrayBuffer());
const sha = createHash('sha256').update(buf).digest('hex');
if (sha !== SHA256) throw new Error(`checksum mismatch: got ${sha}, expected ${SHA256}`);

const tmp = mkdtempSync(join(tmpdir(), 'souldew-nodemobile-'));
try {
  const zip = join(tmp, 'nodejs-mobile.zip');
  writeFileSync(zip, buf);
  rmSync(out, { recursive: true, force: true });
  let files = 0;
  for (const e of listZip(zip)) {
    const name = e.name.replace(/\\/g, '/');
    if (name.endsWith('/')) continue;
    const keep = ABIS.some((a) => name === `bin/${a}/libnode.so`) || name.startsWith('include/node/');
    if (!keep) continue;
    const target = join(out, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readZipEntry(zip, e));
    files++;
  }
  if (!ABIS.every((a) => existsSync(join(out, 'bin', a, 'libnode.so')))) throw new Error('libnode.so missing in the download');
  console.log(`nodejs-mobile ${VERSION}: ${files} files in ${out}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
