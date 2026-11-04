// Update feed: version comparison and validation of latest.json. Pure functions, no Node or DOM APIs,
// shared by the Electron updater, scripts/release.mjs and the tests.
//
// Feed format (latest.json, published next to the DMG and the Windows installer of each GitHub release):
//   { version: '2.1.0', notes: '…', url: 'https://…/souldew-2.1.0-arm64.dmg',
//     sha256: '<64 hex>', size: 123456789, minVersion?: '2.0.0', page?: 'https://…', pubDate?: '…',
//     assets?: { 'win32-x64': { name: 'souldew-2.1.0-win-x64-setup.exe', url: 'https://…', sha256: '<64 hex>', size: 98765432 } },
//     sig?: '<base64 Ed25519 signature of canonicalFeed(feed)>' }
// The top-level url/sha256/size are the macOS DMG – that is all souldew ≤ 2.0 knows. Other platforms live in
// `assets` (added in 2.1): older apps ignore unknown fields, and the signature covers every field, `assets` included,
// so the same signed latest.json serves both (test/update.test.mjs runs the 2.0.0 code against such a feed).

// semver.org 2.0.0 (no leading "v", no leading zeros in numeric parts).
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** '2.1.0-beta.1+abc' → { major, minor, patch, pre: ['beta', 1] } or null when it isn't valid semver. */
export function parseVersion(v) {
  if (typeof v !== 'string' || v.length > 128) return null;
  const m = SEMVER.exec(v);
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].map(Number);
  if (!nums.every(Number.isSafeInteger)) return null;
  return {
    major: nums[0], minor: nums[1], patch: nums[2],
    pre: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

/** -1 / 0 / 1 like a sort comparator (build metadata is ignored, prereleases sort before the release). Throws on invalid input. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`Invalid version: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = typeof p === 'number';
    const qn = typeof q === 'number';
    if (pn !== qn) return pn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    return p < q ? -1 : 1;
  }
  return 0;
}

export const isNewer = (candidate, current) => compareVersions(candidate, current) > 0;

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Only HTTPS – plain http only for a local test server, and only when the caller allows it (development). */
export function isAllowedUrl(url, { allowLocal = false } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  return allowLocal && u.protocol === 'http:' && LOCAL_HOSTS.includes(u.hostname);
}

export const MAX_UPDATE_SIZE = 2 * 1024 ** 3;

function feedError(message) {
  const e = new Error(message);
  e.code = 'BAD_FEED';
  return e;
}

/**
 * Checks a parsed latest.json and returns a clean copy with only the known fields.
 * Throws (code BAD_FEED) on anything unexpected – a broken or tampered feed is never half-used.
 */
export function validateFeed(feed, { allowLocal = false } = {}) {
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) throw feedError('Update feed is not a JSON object');
  const { version, notes = '', url, sha256, size, minVersion, page, pubDate } = feed;
  if (!parseVersion(version)) throw feedError(`Update feed has an invalid version: ${String(version).slice(0, 40)}`);
  if (typeof url !== 'string' || !isAllowedUrl(url, { allowLocal })) throw feedError('Update download must be an https:// URL');
  if (!/\.dmg$/i.test(new URL(url).pathname)) throw feedError('Update download must be a .dmg file');
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) throw feedError('Update feed has no valid sha256');
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPDATE_SIZE) throw feedError('Update feed has no valid size');
  if (typeof notes !== 'string' || notes.length > 20000) throw feedError('Update notes are invalid');
  if (minVersion !== undefined && minVersion !== null && !parseVersion(minVersion)) throw feedError('Update feed has an invalid minVersion');
  if (page !== undefined && page !== null && (typeof page !== 'string' || !isAllowedUrl(page, { allowLocal }))) throw feedError('Update page must be an https:// URL');
  return {
    version, notes, url, sha256: sha256.toLowerCase(), size,
    minVersion: minVersion || null,
    page: page || null,
    pubDate: typeof pubDate === 'string' ? pubDate.slice(0, 40) : null,
    assets: validateAssets(feed.assets, { allowLocal }),
  };
}

/** Platforms with an `assets` entry: what file type each one installs from. */
export const ASSET_PLATFORMS = { 'win32-x64': 'exe', 'win32-arm64': 'exe' };

/** 'win32-x64' for this platform / architecture (process.platform, process.arch). */
export const platformKey = (platform, arch) => `${platform}-${arch}`;

/**
 * The `assets` block: { 'win32-x64': { name, url, sha256, size } }. Unknown platform keys are dropped (a newer
 * feed may list platforms this version doesn't know); a known one that is malformed makes the whole feed invalid.
 */
function validateAssets(assets, { allowLocal }) {
  if (assets === undefined || assets === null) return {};
  if (typeof assets !== 'object' || Array.isArray(assets)) throw feedError('Update feed has an invalid assets block');
  const out = {};
  for (const [key, ext] of Object.entries(ASSET_PLATFORMS)) {
    const a = assets[key];
    if (a === undefined) continue;
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw feedError(`Update asset ${key} is invalid`);
    const { name, url, sha256, size } = a;
    if (typeof name !== 'string' || name.length > 200 || !/^[\w.+-]+$/.test(name) || !name.toLowerCase().endsWith(`.${ext}`)) throw feedError(`Update asset ${key} has an invalid file name`);
    if (typeof url !== 'string' || !isAllowedUrl(url, { allowLocal })) throw feedError(`Update asset ${key} must be an https:// URL`);
    if (!new URL(url).pathname.endsWith(`/${name}`)) throw feedError(`Update asset ${key}: the URL does not end with its file name`);
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) throw feedError(`Update asset ${key} has no valid sha256`);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPDATE_SIZE) throw feedError(`Update asset ${key} has no valid size`);
    out[key] = { name, url, sha256: sha256.toLowerCase(), size };
  }
  return out;
}

/**
 * The download for this platform: { url, sha256, size, name } – the DMG (top level) on macOS, the `assets` entry
 * elsewhere – or null when the release has nothing for it (e.g. a macOS-only release seen from Windows).
 */
export function assetFor(feed, platform, arch) {
  if (!feed) return null;
  if (platform === 'darwin') {
    let name = null;
    try {
      name = decodeURIComponent(new URL(feed.url).pathname.split('/').pop()) || null;
    } catch {
      // validateFeed already refused anything that isn't a URL
    }
    return { url: feed.url, sha256: feed.sha256, size: feed.size, name };
  }
  return feed.assets?.[platformKey(platform, arch)] || null;
}

/**
 * What to do with a valid feed for the installed version:
 * 'none' (same or older – never downgrade; or nothing to download for `platform`), 'install', or 'manual'
 * (installed version is below minVersion).
 */
export function updateAction(feed, current, { platform, arch } = {}) {
  if (!isNewer(feed.version, current)) return 'none';
  // a release without a download for this platform is no update for it (only checked when the caller says which)
  if (platform && !assetFor(feed, platform, arch)) return 'none';
  if (feed.minVersion && compareVersions(current, feed.minVersion) < 0) return 'manual';
  return 'install';
}

/** Constant-shape comparison of two hex digests (case-insensitive). */
export function digestsMatch(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = actual.toLowerCase();
  const b = expected.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(a) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Feed URL from the package.json "updates" block: { repo: 'owner/name', feed: '…{repo}…' }. null = not set up. */
export function feedUrlFrom(updates = {}) {
  const repo = typeof updates.repo === 'string' ? updates.repo.trim() : '';
  const tpl = typeof updates.feed === 'string' && updates.feed.trim() ? updates.feed.trim() : 'https://github.com/{repo}/releases/latest/download/latest.json';
  if (tpl.includes('{repo}')) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
    return tpl.replaceAll('{repo}', repo);
  }
  return tpl;
}

/** Stable JSON: object keys sorted at every level, no whitespace. */
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableJson(x))).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * The bytes the feed signature covers: every field of latest.json except `sig`, as stable JSON (keys sorted).
 * Signing the parsed object instead of the file text keeps the signature valid across re-formatting.
 */
export function canonicalFeed(feed) {
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) throw feedError('Update feed is not a JSON object');
  const rest = { ...feed };
  delete rest.sig;
  return stableJson(rest);
}

/** Release asset name without spaces (GitHub would turn them into dots and break the URL in the feed). */
export const dmgAssetName = (version, arch = 'arm64') => `souldew-${version}-${arch}.dmg`;

/** The Windows installer of a release (package.json → build.win.artifactName builds exactly this name). */
export const winAssetName = (version, arch = 'x64') => `souldew-${version}-win-${arch}-setup.exe`;
