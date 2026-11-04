// Self-update for the unsigned macOS app – the parts that need Node but not Electron (testable with node --test).
// Squirrel.Mac only updates properly signed apps, so this does it by hand:
// download the DMG → verify sha256 + size → mount it → copy the new .app next to the installed one →
// on restart swap the two bundles with two renames. User data lives in ~/Library/Application Support
// and is never touched.
import { createWriteStream, createReadStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, readdirSync, accessSync, constants, statSync } from 'node:fs';
import { createHash, createPublicKey, createPrivateKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { validateFeed, isAllowedUrl, digestsMatch, canonicalFeed, MAX_UPDATE_SIZE } from '../shared/update.mjs';

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ---- feed signature (Ed25519) ------------------------------------------------------------
// The release script signs canonicalFeed(latest.json) with the private key that stays on the publisher's
// machine; the app carries the public key (package.json → updates.publicKey, base64 SPKI DER) and checks
// the signature before it trusts the feed's url or sha256. A feed served by anyone else can't be forged.

/** base64 SPKI DER → KeyObject (Ed25519 only). Throws (code BAD_SIGNATURE) on anything else. */
export function parsePublicKey(b64) {
  let key;
  try {
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64.trim())) throw new Error('not base64');
    key = createPublicKey({ key: Buffer.from(b64.trim(), 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw fail('BAD_SIGNATURE', 'The update key built into this app is invalid');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw fail('BAD_SIGNATURE', 'The update key built into this app is not an Ed25519 key');
  return key;
}

/** Public key of a private key (PEM or KeyObject) as base64 SPKI DER – the form package.json stores. */
export const publicKeyBase64 = (privateKey) => createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');

/** A copy of the feed with `sig` set to the base64 Ed25519 signature over canonicalFeed(feed). */
export function signFeed(feed, privateKeyPem) {
  const key = typeof privateKeyPem === 'string' || Buffer.isBuffer(privateKeyPem) ? createPrivateKey(privateKeyPem) : privateKeyPem;
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The release key is not an Ed25519 key');
  const rest = { ...feed };
  delete rest.sig;
  return { ...rest, sig: cryptoSign(null, Buffer.from(canonicalFeed(rest), 'utf8'), key).toString('base64') };
}

/** Throws (code BAD_SIGNATURE) unless `feed.sig` is a valid signature of the feed by `publicKeyB64`. */
export function verifyFeedSignature(feed, publicKeyB64) {
  const key = parsePublicKey(publicKeyB64);
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) throw fail('BAD_FEED', 'Update feed is not a JSON object');
  const { sig } = feed;
  if (typeof sig !== 'string' || !sig) throw fail('BAD_SIGNATURE', 'The update feed is not signed');
  const raw = /^[A-Za-z0-9+/]+={0,2}$/.test(sig) ? Buffer.from(sig, 'base64') : null;
  let ok = false;
  try {
    ok = !!raw && raw.length === 64 && cryptoVerify(null, Buffer.from(canonicalFeed(feed), 'utf8'), key, raw);
  } catch {
    ok = false;
  }
  if (!ok) throw fail('BAD_SIGNATURE', 'The update feed’s signature is wrong – it was changed or not signed by the publisher');
  return true;
}

/** sha256 of a file as lowercase hex (streamed, fine for large DMGs). */
export function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolvePromise(h.digest('hex')));
  });
}

/** Throws (code CHECKSUM) unless the file has exactly the expected size and sha256. */
export async function verifyFile(path, { sha256, size }) {
  const actualSize = statSync(path).size;
  if (size != null && actualSize !== size) throw fail('CHECKSUM', `Download has the wrong size (${actualSize} instead of ${size} bytes)`);
  const actual = await sha256File(path);
  if (!digestsMatch(actual, sha256)) throw fail('CHECKSUM', 'Download is damaged or was changed (sha256 does not match)');
  return actual;
}

export const MAX_REDIRECTS = 5;

/**
 * fetch() that follows redirects itself (redirect: 'manual') and checks every hop: each Location must be an
 * allowed (https) URL, so a redirect can never pass through plain http – not even briefly.
 */
export async function fetchChecked(url, { allowLocal = false, signal, fetchImpl = fetch, maxRedirects = MAX_REDIRECTS } = {}) {
  let current = url;
  for (let hop = 0; ; hop++) {
    if (!isAllowedUrl(current, { allowLocal })) throw fail('INSECURE', hop ? 'The update server redirected to a non-HTTPS URL' : `Refusing non-HTTPS URL: ${current}`);
    const res = await fetchImpl(current, { signal, redirect: 'manual', cache: 'no-store', headers: { 'User-Agent': 'souldew-updater' } });
    if (res.url && !isAllowedUrl(res.url, { allowLocal })) throw fail('INSECURE', 'The update server redirected to a non-HTTPS URL');
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    await res.body?.cancel?.().catch(() => {});
    if (hop >= maxRedirects) throw fail('HTTP', 'The update server redirected too often');
    const location = res.headers?.get?.('location');
    if (!location) throw fail('HTTP', `Update server answered HTTP ${res.status} without a location`);
    try {
      current = new URL(location, current).href;
    } catch {
      throw fail('INSECURE', 'The update server redirected to an invalid URL');
    }
  }
}

/** GET with a timeout until the headers arrive; refuses non-HTTPS URLs before and after every redirect hop. */
async function get(url, { timeoutMs, allowLocal, signal, fetchImpl = fetch }) {
  if (!isAllowedUrl(url, { allowLocal })) throw fail('INSECURE', `Refusing non-HTTPS URL: ${url}`);
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal.reason);
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const cleanup = () => signal?.removeEventListener('abort', onAbort);
  const timer = setTimeout(() => ctl.abort(fail('TIMEOUT', 'The update server did not answer in time')), timeoutMs);
  try {
    const res = await fetchChecked(url, { allowLocal, signal: ctl.signal, fetchImpl });
    if (res.status === 404) throw fail('NOT_FOUND', 'No update has been published yet');
    if (!res.ok) throw fail('HTTP', `Update server answered HTTP ${res.status}`);
    return { res, ctl, cleanup };
  } catch (e) {
    cleanup();
    throw abortReason(ctl, e);
  } finally {
    clearTimeout(timer);
  }
}

/** After an abort, report why (timeout, cancel) instead of a generic AbortError. */
const abortReason = (ctl, e) => (ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : e);

/**
 * Downloads and validates latest.json. With `publicKey` (base64 SPKI) the feed must carry a valid `sig`
 * (code BAD_SIGNATURE otherwise) – checked before any of its fields are used.
 */
export async function fetchFeed(url, { timeoutMs = 15000, allowLocal = false, fetchImpl, publicKey = null } = {}) {
  const { res, ctl, cleanup } = await get(url, { timeoutMs, allowLocal, fetchImpl });
  const timer = setTimeout(() => ctl.abort(fail('TIMEOUT', 'The update server did not answer in time')), timeoutMs);
  try {
    const text = await res.text();
    if (text.length > 256 * 1024) throw fail('BAD_FEED', 'Update feed is too large');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw fail('BAD_FEED', 'Update feed is not valid JSON');
    }
    if (publicKey) verifyFeedSignature(json, publicKey);
    return validateFeed(json, { allowLocal });
  } catch (e) {
    throw abortReason(ctl, e);
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

/**
 * Streams the DMG to `dest` while hashing it, with progress callbacks, a timeout for the first byte and
 * an idle timeout between chunks. The file only appears at `dest` after size and sha256 matched.
 */
export async function downloadFile(url, dest, { size, sha256, allowLocal = false, timeoutMs = 30000, idleMs = 60000, onProgress, signal, fetchImpl } = {}) {
  const part = `${dest}.part`;
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(part, { force: true });
  const { res, ctl, cleanup } = await get(url, { timeoutMs, allowLocal, signal, fetchImpl });
  const limit = Math.min(size || MAX_UPDATE_SIZE, MAX_UPDATE_SIZE);
  const total = size || Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  let received = 0;
  let idle = null;
  const kick = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctl.abort(fail('TIMEOUT', 'The download stalled')), idleMs);
  };
  const out = createWriteStream(part);
  try {
    kick();
    for await (const chunk of Readable.fromWeb(res.body)) {
      received += chunk.length;
      if (received > limit) throw fail('CHECKSUM', 'Download is larger than announced');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress?.({ received, total });
      kick();
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
    if (size != null && received !== size) throw fail('CHECKSUM', `Download has the wrong size (${received} instead of ${size} bytes)`);
    const actual = hash.digest('hex');
    if (!digestsMatch(actual, sha256)) throw fail('CHECKSUM', 'Download is damaged or was changed (sha256 does not match)');
    renameSync(part, dest);
    return { size: received, sha256: actual };
  } catch (e) {
    out.destroy();
    rmSync(part, { force: true });
    throw abortReason(ctl, e);
  } finally {
    clearTimeout(idle);
    cleanup();
  }
}

// ---- the installed bundle ------------------------------------------------------------

/** '/Applications/X.app/Contents/MacOS/X' → '/Applications/X.app' (null when not inside an .app). */
export function bundleFromExe(exePath) {
  const m = /^(.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(exePath || '');
  return m ? m[1] : null;
}

/** Apps opened straight from a quarantined download run from a read-only random path (App Translocation). */
export const isTranslocated = (path) => /\/AppTranslocation\//.test(path || '');

/** Hidden folder next to the app for the staged new version and the replaced old one (same volume → atomic rename). */
export const stagingDirFor = (bundle) => join(dirname(bundle), `.${basename(bundle, '.app')}.update`);

/** Can this app replace itself? { ok } or { ok: false, reason } – callers fall back to the manual DMG. */
export function canReplace(bundle) {
  if (!bundle) return { ok: false, reason: 'not-bundle' };
  if (isTranslocated(bundle)) return { ok: false, reason: 'translocated' };
  if (/^\/Volumes\//.test(bundle)) return { ok: false, reason: 'dmg' }; // still running from the disk image
  try {
    accessSync(dirname(bundle), constants.W_OK);
    accessSync(bundle, constants.W_OK);
  } catch {
    return { ok: false, reason: 'read-only' };
  }
  return { ok: true };
}

/** Removes leftovers of an earlier update (old bundle after a successful swap, or an unused staged one). */
export function cleanupStaging(bundle) {
  if (!bundle) return;
  const dir = stagingDirFor(bundle);
  if (bundle.startsWith(dir + '/')) return;
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Puts the staged bundle in place of the installed one: two renames on the same volume, rolled back if the
 * second fails. The old bundle goes into the staging folder and is deleted on the next start.
 */
export function swapBundle(target, staged) {
  if (!existsSync(staged)) throw fail('NO_STAGED', 'The downloaded update is missing');
  const old = join(stagingDirFor(target), `old-${Date.now()}.app`);
  renameSync(target, old);
  try {
    renameSync(staged, target);
  } catch (e) {
    renameSync(old, target);
    throw e;
  }
  return old;
}

// ---- macOS tools (hdiutil, ditto, codesign, xattr, plutil) ------------------------------

export function run(cmd, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${basename(cmd)} failed: ${String(stderr || err.message).trim().slice(0, 500)}`;
        return reject(err);
      }
      resolvePromise(String(stdout));
    });
  });
}

export async function readBundleInfo(bundle) {
  const plist = join(bundle, 'Contents', 'Info.plist');
  const key = async (k) => (await run('/usr/bin/plutil', ['-extract', k, 'raw', '-o', '-', plist])).trim();
  return { version: await key('CFBundleShortVersionString'), id: await key('CFBundleIdentifier') };
}

/**
 * Mounts the verified DMG, copies its app into the staging folder next to `bundle`, checks it and unmounts.
 * Returns the staged path. The app must be the same product (bundle id) with exactly the announced version.
 */
export async function stageFromDmg({ dmg, bundle, version, log = () => {} }) {
  const current = await readBundleInfo(bundle);
  const dir = stagingDirFor(bundle);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const mount = mkdtempSync(join(tmpdir(), 'sls-update-mnt-'));
  let attached = false;
  try {
    log('mount');
    await run('/usr/bin/hdiutil', ['attach', dmg, '-nobrowse', '-noautoopen', '-readonly', '-noverify', '-mountpoint', mount]);
    attached = true;
    const apps = readdirSync(mount).filter((n) => n.endsWith('.app'));
    const name = apps.includes(basename(bundle)) ? basename(bundle) : apps[0];
    if (!name) throw fail('BAD_DMG', 'The disk image contains no app');
    const staged = join(dir, basename(bundle));
    log('copy');
    // ditto keeps symlinks, permissions, extended attributes and the code signature intact.
    await run('/usr/bin/ditto', [join(mount, name), staged]);
    const info = await readBundleInfo(staged);
    if (info.id !== current.id) throw fail('BAD_DMG', `The disk image contains a different app (${info.id})`);
    if (info.version !== version) throw fail('BAD_DMG', `The disk image contains version ${info.version}, expected ${version}`);
    // Downloaded by the app itself, so normally there is no quarantine flag – but never let one through:
    // a quarantined, ad-hoc signed app would be stopped by Gatekeeper on the next start.
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => {});
    log('verify');
    // Never re-sign: signing whatever was copied would turn a tampered or damaged bundle into a "valid" one.
    // A bundle that doesn't verify as shipped is not installed in place (code SIGNATURE → the caller falls back
    // to handing the user the verified DMG).
    try {
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
    } catch (e) {
      throw fail('SIGNATURE', `The new version's code signature does not verify: ${e.message}`);
    }
    return staged;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  } finally {
    const detached = !attached || (await run('/usr/bin/hdiutil', ['detach', mount, '-force']).then(() => true, () => false));
    if (detached) rmSync(mount, { recursive: true, force: true }); // never recurse into a still-mounted image
  }
}
