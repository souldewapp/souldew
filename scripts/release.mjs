// Prepares an app update for publishing on GitHub Releases (run after `npm run dist`, with the Windows installer from
// `npm run dist:win` / the Windows workflow and the Linux AppImage + .deb from `npm run dist:linux` / the Linux workflow
// in dist/): hashes the DMG, the Windows installer and the AppImage, writes the update feed latest.json (one feed for
// all platforms) and prints the `gh release create` command. It does not upload anything itself.
//
// Usage: npm run release -- [--notes "text" | --notes-file file] [--repo owner/name] [--dmg path] [--win-exe path | --no-win]
//                           [--appimage path | --no-linux] [--deb path] [--min-version x.y.z] [--out dir] [--key file]
// Without --notes/--notes-file the notes come from the "## <version>" section of CHANGELOG.md.
// Without --win-exe the installer is picked up from dist/souldew-<version>-win-x64-setup.exe when it is there; likewise
// dist/souldew-<version>-linux-x86_64.AppImage and dist/souldew-<version>-linux-amd64.deb. The .deb is only uploaded –
// it isn't in the feed, because a package installed as root can't replace itself (those apps link to the release page).
// latest.json is signed (Ed25519) with the private key from --key, $SLS_RELEASE_KEY or ~/.config/soullink-studio/release-key.pem.
//
// One-time setup: npm run release -- --init-key [--key file]
// creates that key (never overwrites one) and puts its public half into package.json → updates.publicKey.
import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync, statSync, constants } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, createPrivateKey } from 'node:crypto';
import { parseVersion, validateFeed, feedUrlFrom, dmgAssetName, winAssetName, linuxAssetName, debAssetName } from '../shared/update.mjs';
import { sha256File, signFeed, publicKeyBase64, verifyFeedSignature } from '../electron/update-core.mjs';
import { unwrapNotes } from '../shared/notes.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_KEY = join(homedir(), '.config', 'soullink-studio', 'release-key.pem');

/** --key, then $SLS_RELEASE_KEY, then ~/.config/soullink-studio/release-key.pem. */
export const keyPathFrom = (a = {}, env = process.env) => resolve(a.key || env.SLS_RELEASE_KEY || DEFAULT_KEY);

/**
 * Creates the Ed25519 release key: private key (PKCS#8 PEM, mode 0600) at `keyPath`, public key (base64 SPKI DER)
 * into `pkgPath` → updates.publicKey. Refuses to overwrite an existing key file and to put the key inside `repoRoot`.
 */
export function initKey({ keyPath, pkgPath, repoRoot = root }) {
  const target = resolve(keyPath);
  const repo = resolve(repoRoot);
  if (target === repo || target.startsWith(repo + sep)) throw new Error(`The release key must live outside the project (it must never be committed): ${target}`);
  if (existsSync(target)) throw new Error(`A release key already exists at ${target} – not overwriting it. Delete it yourself only if you really want a new key (installed apps will then refuse updates signed with it).`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); // before anything is written
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  // 'wx' fails if the file appeared in the meantime – an existing key is never replaced.
  writeFileSync(target, privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 });
  pkg.updates = { ...(pkg.updates || {}), publicKey: pub };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  return { keyPath: target, publicKey: pub };
}

/** Reads the private key; checks it matches the public key the apps carry (when one is configured). */
export function loadReleaseKey(keyPath, expectedPublicKey) {
  const key = createPrivateKey(readFileSync(keyPath));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${keyPath} is not an Ed25519 key`);
  const pub = publicKeyBase64(key);
  if (expectedPublicKey && pub !== expectedPublicKey.trim()) {
    throw new Error(`The key at ${keyPath} does not match package.json → updates.publicKey. Installed apps would refuse this update.`);
  }
  return { key, publicKey: pub };
}

/**
 * The unsigned feed: the DMG at the top level (all that souldew ≤ 2.0 reads), every other platform under `assets`.
 * dmg / win / linux: { sha256, size } of the files as they will be uploaded (named dmgAssetName / winAssetName /
 * linuxAssetName – the AppImage).
 */
export function buildFeed({ version, notes, repo, dmg, win = null, linux = null, minVersion = null, pubDate = new Date().toISOString() }) {
  const base = `https://github.com/${repo}/releases/download/v${version}`;
  const feed = validateFeed({
    version,
    notes,
    url: `${base}/${dmgAssetName(version)}`,
    sha256: dmg.sha256,
    size: dmg.size,
    ...(minVersion ? { minVersion } : {}),
    page: `https://github.com/${repo}/releases/tag/v${version}`,
    pubDate,
    assets: {
      ...(win ? { 'win32-x64': { name: winAssetName(version), url: `${base}/${winAssetName(version)}`, sha256: win.sha256, size: win.size } } : {}),
      ...(linux ? { 'linux-x64': { name: linuxAssetName(version), url: `${base}/${linuxAssetName(version)}`, sha256: linux.sha256, size: linux.size } } : {}),
    },
  });
  if (!Object.keys(feed.assets).length) delete feed.assets;
  return Object.fromEntries(Object.entries(feed).filter(([, v]) => v !== null));
}

const FLAGS = new Set(['init-key', 'no-win', 'no-linux']);

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new Error(`Unknown argument: ${argv[i]}`);
    if (FLAGS.has(m[1]) && m[2] === undefined) {
      out[m[1]] = true;
      continue;
    }
    out[m[1]] = m[2] ?? argv[++i];
    if (out[m[1]] === undefined) throw new Error(`--${m[1]} needs a value`);
  }
  return out;
}

/** The "## 2.1.0" (or "## [2.1.0] – date") section of a changelog, without its heading. */
export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const esc = version.replace(/[.+]/g, '\\$&');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+\\[?v?${esc}\\]?(\\s|$)`).test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
// Paths inside the project are printed relative to it (the gh command is meant to be run from there).
const show = (p) => (p.startsWith(root + sep) ? relative(root, p).split(sep).join('/') : p);

/** Copies a build into the release folder under its asset name and hashes it. */
async function stage(src, out, name) {
  const asset = join(out, name);
  rmSync(asset, { force: true });
  console.log(`Copying ${show(src)} → ${show(asset)} …`);
  copyFileSync(src, asset, constants.COPYFILE_FICLONE); // APFS clone: instant, no extra space
  console.log('Hashing …');
  return { path: asset, name, sha256: await sha256File(asset), size: statSync(asset).size };
}

async function main() {
  const a = args(process.argv.slice(2));
  const keyPath = keyPathFrom(a);
  if (a['init-key']) {
    const r = initKey({ keyPath, pkgPath: join(root, 'package.json') });
    console.log(`Release key created: ${r.keyPath} (only you can read it)
Public key written to package.json → updates.publicKey:
  ${r.publicKey}

Keep the key file safe and back it up (e.g. in your password manager) – never commit or share it.
Without it you can't publish updates the installed apps accept; whoever has it can.
Apps built from now on only install updates signed with this key.`);
    return;
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const expectedPub = typeof pkg.updates?.publicKey === 'string' && pkg.updates.publicKey.trim() ? pkg.updates.publicKey.trim() : null;
  let signing = null;
  if (existsSync(keyPath)) {
    signing = loadReleaseKey(keyPath, expectedPub);
    // (Windows has no POSIX file modes – the key's protection there is the user profile's ACL.)
    if (process.platform !== 'win32' && (statSync(keyPath).mode & 0o077) !== 0) console.warn(`Warning: ${keyPath} is readable by other users – run: chmod 600 ${q(keyPath)}`);
    if (!expectedPub) console.warn('Warning: package.json has no updates.publicKey – the feed is signed, but the apps can\'t check it.');
  } else if (expectedPub) {
    throw new Error(`Release key not found: ${keyPath}\nThe apps only accept a signed feed. Pass --key file or set SLS_RELEASE_KEY (restore it from your backup).`);
  } else {
    console.warn('Warning: no release key – latest.json will NOT be signed. Set one up once with `npm run release -- --init-key`.');
  }
  const version = pkg.version;
  if (!parseVersion(version)) throw new Error(`package.json version is not valid semver: ${version}`);
  const repo = (a.repo || pkg.updates?.repo || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('No GitHub repository set. Put it into package.json → "updates": { "repo": "owner/name" } or pass --repo owner/name.');
  }
  const product = pkg.build?.productName || pkg.name;
  const dmg = resolve(a.dmg || join(root, 'dist', `${product}-${version}-arm64.dmg`));
  if (!existsSync(dmg)) throw new Error(`DMG not found: ${dmg}\nRun \`npm run dist\` first (after raising "version" in package.json).`);
  const winDefault = join(root, 'dist', winAssetName(version));
  const winExe = a['no-win'] ? null : a['win-exe'] ? resolve(a['win-exe']) : existsSync(winDefault) ? winDefault : null;
  if (winExe && !existsSync(winExe)) throw new Error(`Windows installer not found: ${winExe}`);
  if (!winExe && !a['no-win']) {
    console.warn(`Warning: no Windows installer (${show(winDefault)}) – the Windows app won't offer this update.
  Build it with \`npm run dist:win\` on Windows or download it from the Windows workflow, or pass --win-exe path (--no-win silences this).`);
  }
  const appImageDefault = join(root, 'dist', linuxAssetName(version));
  const debDefault = join(root, 'dist', debAssetName(version));
  const appImage = a['no-linux'] ? null : a.appimage ? resolve(a.appimage) : existsSync(appImageDefault) ? appImageDefault : null;
  const deb = a['no-linux'] ? null : a.deb ? resolve(a.deb) : existsSync(debDefault) ? debDefault : null;
  for (const [what, file] of [['AppImage', appImage], ['.deb', deb]]) if (file && !existsSync(file)) throw new Error(`Linux ${what} not found: ${file}`);
  if (!appImage && !a['no-linux']) {
    console.warn(`Warning: no Linux AppImage (${show(appImageDefault)}) – the Linux app won't offer this update.
  Build it with \`npm run dist:linux\` on Linux or download it from the Linux workflow, or pass --appimage path (--no-linux silences this).`);
  }

  let notes = a.notes ?? (a['notes-file'] ? readFileSync(resolve(a['notes-file']), 'utf8').trim() : null);
  if (notes == null) {
    const log = join(root, 'CHANGELOG.md');
    notes = existsSync(log) ? changelogSection(readFileSync(log, 'utf8'), version) : null;
    if (notes == null) throw new Error(`No release notes: add a "## ${version}" section to CHANGELOG.md or pass --notes "…" / --notes-file file.`);
  }

  const out = resolve(a.out || join(root, 'dist', `release-${version}`));
  mkdirSync(out, { recursive: true });
  const mac = await stage(dmg, out, dmgAssetName(version));
  const win = winExe ? await stage(winExe, out, winAssetName(version)) : null;
  const linux = appImage ? await stage(appImage, out, linuxAssetName(version)) : null;
  const debPkg = deb ? await stage(deb, out, debAssetName(version)) : null;
  let clean = buildFeed({ version, notes: unwrapNotes(notes), repo, dmg: mac, win, linux, minVersion: a['min-version'] || null });
  if (signing) {
    clean = signFeed(clean, signing.key);
    verifyFeedSignature(JSON.parse(JSON.stringify(clean)), signing.publicKey); // exactly what the apps will do
  }
  writeFileSync(join(out, 'latest.json'), JSON.stringify(clean, null, 2) + '\n');
  writeFileSync(join(out, 'notes.md'), notes + '\n');

  const feedUrl = feedUrlFrom({ ...pkg.updates, repo });
  const assets = [mac, win, linux, debPkg].filter(Boolean);
  const platforms = ['macOS', win && 'Windows', linux && 'Linux'].filter(Boolean).join(' + ');
  console.log(`
Update ${version} is ready in ${show(out)}:
${assets.map((x) => `  ${x.name}  ${(x.size / 1024 / 1024).toFixed(1)} MB\n  sha256 ${x.sha256}`).join('\n')}
  latest.json (${signing ? `signed with ${show(keyPath)}` : 'NOT signed'}, ${platforms}${debPkg ? '; the .deb is uploaded but not in the feed' : ''}), notes.md

Publish it from the project folder (the installed apps read ${feedUrl}):

  gh release create v${version} ${[...assets.map((x) => x.path), join(out, 'latest.json')].map((p) => q(show(p))).join(' ')} --repo ${repo} --title ${q(`${product} ${version}`)} --notes-file ${q(show(join(out, 'notes.md')))}

Don't mark it as a pre-release or draft – "latest" only points to normal releases.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`release: ${e.message}`);
    process.exit(1);
  });
}
