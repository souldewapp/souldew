// App updates: version comparison, feed validation, sha256 checks, download and the bundle swap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVersion, compareVersions, isNewer, isAllowedUrl, validateFeed, updateAction, digestsMatch, feedUrlFrom, dmgAssetName } from '../shared/update.mjs';
import { fetchChecked } from '../electron/update-core.mjs';
import { sha256File, verifyFile, fetchFeed, downloadFile, bundleFromExe, isTranslocated, stagingDirFor, canReplace, swapBundle, cleanupStaging } from '../electron/update-core.mjs';
import { changelogSection } from '../scripts/release.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'sls-update-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const SHA = 'a'.repeat(64);
const feed = (over = {}) => ({ version: '2.1.0', notes: 'Fixes', url: 'https://github.com/o/r/releases/download/v2.1.0/souldew-2.1.0-arm64.dmg', sha256: SHA, size: 1234, ...over });

test('parseVersion accepts semver only', () => {
  assert.deepEqual(parseVersion('2.1.0'), { major: 2, minor: 1, patch: 0, pre: [] });
  assert.deepEqual(parseVersion('1.0.0-beta.11+build.5').pre, ['beta', 11]);
  for (const bad of ['v2.1.0', '2.1', '2.1.0.1', '02.1.0', '2.01.0', '1.0.0-', '1.0.0-01', ' 2.1.0', '', null, 2, '99999999999999999999.0.0']) {
    assert.equal(parseVersion(bad), null, String(bad));
  }
});

test('compareVersions follows semver precedence', () => {
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0', '10.0.0'];
  for (let i = 0; i < order.length - 1; i++) {
    assert.equal(compareVersions(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`);
    assert.equal(compareVersions(order[i + 1], order[i]), 1);
  }
  assert.equal(compareVersions('2.0.0', '2.0.0+build.7'), 0);
  assert.ok(isNewer('2.0.1', '2.0.0'));
  assert.ok(!isNewer('2.0.0', '2.0.0'));
  assert.ok(!isNewer('1.9.9', '2.0.0'));
  assert.throws(() => compareVersions('2.0', '2.0.0'), /Invalid version/);
});

test('only https URLs, http only for localhost when allowed', () => {
  assert.ok(isAllowedUrl('https://github.com/x'));
  assert.ok(!isAllowedUrl('http://github.com/x'));
  assert.ok(!isAllowedUrl('http://127.0.0.1:7400/x'));
  assert.ok(isAllowedUrl('http://127.0.0.1:7400/x', { allowLocal: true }));
  assert.ok(!isAllowedUrl('http://evil.example/x', { allowLocal: true }));
  assert.ok(!isAllowedUrl('file:///etc/passwd', { allowLocal: true }));
  assert.ok(!isAllowedUrl('https://user:pw@github.com/x'));
  assert.ok(!isAllowedUrl('not a url'));
});

test('validateFeed returns a clean feed and rejects anything unexpected', () => {
  const ok = validateFeed({ ...feed({ sha256: SHA.toUpperCase(), minVersion: '2.0.0' }), evil: '<script>' });
  assert.equal(ok.sha256, SHA);
  assert.equal(ok.minVersion, '2.0.0');
  assert.equal(ok.page, null);
  assert.equal('evil' in ok, false);
  assert.equal(validateFeed(feed({ notes: undefined })).notes, '');
  const bad = [
    null, [], 'x',
    feed({ version: 'v2.1.0' }), feed({ version: '2.1' }), feed({ version: 210 }),
    feed({ url: 'http://github.com/a.dmg' }), feed({ url: 'https://github.com/a.zip' }), feed({ url: 'ftp://x/a.dmg' }),
    feed({ sha256: 'abc' }), feed({ sha256: 'g'.repeat(64) }), feed({ sha256: undefined }),
    feed({ size: 0 }), feed({ size: -1 }), feed({ size: '1234' }), feed({ size: 3 * 1024 ** 3 }),
    feed({ minVersion: 'soon' }), feed({ page: 'http://x.y' }), feed({ notes: 5 }),
  ];
  for (const f of bad) assert.throws(() => validateFeed(f), (e) => e.code === 'BAD_FEED', JSON.stringify(f));
  assert.throws(() => validateFeed(feed({ url: 'http://localhost:7400/a.dmg' })), /https/);
  assert.equal(validateFeed(feed({ url: 'http://localhost:7400/a.dmg' }), { allowLocal: true }).url, 'http://localhost:7400/a.dmg');
});

test('updateAction never downgrades and respects minVersion', () => {
  assert.equal(updateAction(feed(), '2.0.0'), 'install');
  assert.equal(updateAction(feed(), '2.1.0'), 'none');
  assert.equal(updateAction(feed(), '3.0.0'), 'none');
  assert.equal(updateAction(feed({ version: '2.1.0-beta.1' }), '2.1.0'), 'none');
  assert.equal(updateAction(feed({ minVersion: '2.0.5' }), '2.0.0'), 'manual');
  assert.equal(updateAction(feed({ minVersion: '2.0.0' }), '2.0.0'), 'install');
});

test('digestsMatch and the feed URL helpers', () => {
  assert.ok(digestsMatch(SHA, SHA.toUpperCase()));
  assert.ok(!digestsMatch(SHA, 'b'.repeat(64)));
  assert.ok(!digestsMatch(SHA, SHA.slice(1)));
  assert.ok(!digestsMatch('', ''));
  assert.ok(!digestsMatch(null, SHA));
  assert.equal(feedUrlFrom({ repo: 'lou/soullink' }), 'https://github.com/lou/soullink/releases/latest/download/latest.json');
  assert.equal(feedUrlFrom({ repo: '' }), null);
  assert.equal(feedUrlFrom({ repo: 'not a repo' }), null);
  assert.equal(feedUrlFrom({ feed: 'https://example.org/latest.json' }), 'https://example.org/latest.json');
  assert.equal(dmgAssetName('2.1.0'), 'souldew-2.1.0-arm64.dmg');
});

test('sha256File / verifyFile', async () => {
  const f = join(TMP, 'blob.bin');
  const data = Buffer.from('soullink'.repeat(100000));
  writeFileSync(f, data);
  assert.equal(await sha256File(f), sha(data));
  assert.equal(await verifyFile(f, { sha256: sha(data).toUpperCase(), size: data.length }), sha(data));
  await assert.rejects(verifyFile(f, { sha256: SHA, size: data.length }), (e) => e.code === 'CHECKSUM');
  await assert.rejects(verifyFile(f, { sha256: sha(data), size: data.length + 1 }), (e) => e.code === 'CHECKSUM');
});

// ---- network -------------------------------------------------------------------------
const DMG = Buffer.alloc(300000, 7);
async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
const routes = (base) => (req, res) => {
  if (req.url === '/latest.json') return res.end(JSON.stringify(feed({ url: `${base}/u.dmg`, sha256: sha(DMG), size: DMG.length })));
  if (req.url === '/broken.json') return res.end('{"version":');
  if (req.url === '/u.dmg') {
    res.writeHead(200, { 'content-length': DMG.length });
    res.write(DMG.subarray(0, 100000));
    return setTimeout(() => res.end(DMG.subarray(100000)), 20);
  }
  if (req.url === '/stall.dmg') { res.writeHead(200); res.write(DMG.subarray(0, 1000)); return; } // never finishes
  if (req.url === '/hang') return; // never answers
  res.writeHead(404).end();
};

test('fetchFeed validates, maps 404 and refuses insecure URLs', async () => {
  let base;
  await withServer((req, res) => routes(base)(req, res), async (b) => {
    base = b;
    const f = await fetchFeed(`${b}/latest.json`, { allowLocal: true });
    assert.equal(f.version, '2.1.0');
    await assert.rejects(fetchFeed(`${b}/latest.json`), (e) => e.code === 'INSECURE');
    await assert.rejects(fetchFeed(`${b}/nope.json`, { allowLocal: true }), (e) => e.code === 'NOT_FOUND');
    await assert.rejects(fetchFeed(`${b}/broken.json`, { allowLocal: true }), (e) => e.code === 'BAD_FEED');
    await assert.rejects(fetchFeed(`${b}/hang`, { allowLocal: true, timeoutMs: 150 }), (e) => e.code === 'TIMEOUT');
  });
  // A redirect away from https is refused.
  const fetchImpl = async () => ({ url: 'http://evil.example/latest.json', ok: true, status: 200, text: async () => '{}' });
  await assert.rejects(fetchFeed('https://github.com/o/r/latest.json', { fetchImpl }), (e) => e.code === 'INSECURE');
});

test('downloadFile streams, reports progress and only keeps a verified file', async () => {
  let base;
  await withServer((req, res) => routes(base)(req, res), async (b) => {
    base = b;
    const dest = join(TMP, 'dl', 'u.dmg');
    const seen = [];
    const r = await downloadFile(`${b}/u.dmg`, dest, { size: DMG.length, sha256: sha(DMG), allowLocal: true, onProgress: (p) => seen.push(p) });
    assert.equal(r.sha256, sha(DMG));
    assert.deepEqual(readFileSync(dest), DMG);
    assert.ok(seen.length >= 2 && seen.at(-1).received === DMG.length && seen.at(-1).total === DMG.length);
    assert.ok(!existsSync(`${dest}.part`));

    const bad = join(TMP, 'dl', 'bad.dmg');
    await assert.rejects(downloadFile(`${b}/u.dmg`, bad, { size: DMG.length, sha256: SHA, allowLocal: true }), (e) => e.code === 'CHECKSUM');
    await assert.rejects(downloadFile(`${b}/u.dmg`, bad, { size: DMG.length - 1, sha256: sha(DMG), allowLocal: true }), (e) => e.code === 'CHECKSUM');
    await assert.rejects(downloadFile(`${b}/stall.dmg`, bad, { size: DMG.length, sha256: sha(DMG), allowLocal: true, idleMs: 150 }), (e) => e.code === 'TIMEOUT');
    await assert.rejects(downloadFile(`${b}/u.dmg`, bad, { size: DMG.length, sha256: sha(DMG) }), (e) => e.code === 'INSECURE');
    const ctl = new AbortController();
    const cancel = Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
    setTimeout(() => ctl.abort(cancel), 50);
    await assert.rejects(downloadFile(`${b}/stall.dmg`, bad, { size: DMG.length, sha256: sha(DMG), allowLocal: true, signal: ctl.signal }), (e) => e.code === 'CANCELLED');
    assert.deepEqual(readdirSync(join(TMP, 'dl')), ['u.dmg']); // nothing half-downloaded left behind
  });
});

test('redirects are followed by hand and every hop must be https', async () => {
  const hops = (map) => {
    const seen = [];
    const fetchImpl = async (url, opts) => {
      seen.push(url);
      assert.equal(opts.redirect, 'manual');
      const loc = map[url];
      if (loc) return { status: 302, ok: false, headers: new Headers({ location: loc }), body: null };
      return { status: 200, ok: true, headers: new Headers(), text: async () => JSON.stringify(feed()) };
    };
    return { seen, fetchImpl };
  };
  // GitHub-style: latest/download → objects host (relative and absolute Location)
  const ok = hops({ 'https://github.com/o/r/releases/latest/download/latest.json': '/o/r/releases/download/v2.1.0/latest.json', 'https://github.com/o/r/releases/download/v2.1.0/latest.json': 'https://objects.githubusercontent.com/x' });
  assert.equal((await fetchFeed('https://github.com/o/r/releases/latest/download/latest.json', { fetchImpl: ok.fetchImpl })).version, '2.1.0');
  assert.deepEqual(ok.seen.at(-1), 'https://objects.githubusercontent.com/x');
  // A hop to plain http is refused before it is requested.
  const bad = hops({ 'https://github.com/a.json': 'https://cdn.example/b.json', 'https://cdn.example/b.json': 'http://cdn.example/c.json' });
  await assert.rejects(fetchFeed('https://github.com/a.json', { fetchImpl: bad.fetchImpl }), (e) => e.code === 'INSECURE');
  assert.ok(!bad.seen.some((u) => u.startsWith('http:')));
  for (const loc of ['file:///etc/passwd', 'https://user:pw@github.com/x', 'http://127.0.0.1/x']) {
    await assert.rejects(fetchChecked('https://github.com/a', { fetchImpl: hops({ 'https://github.com/a': loc }).fetchImpl }), (e) => e.code === 'INSECURE', loc);
  }
  // Loops end.
  const loop = hops({ 'https://github.com/a': 'https://github.com/b', 'https://github.com/b': 'https://github.com/a' });
  await assert.rejects(fetchChecked('https://github.com/a', { fetchImpl: loop.fetchImpl }), (e) => e.code === 'HTTP');
  // Real server: a local redirect is followed (development only, allowLocal).
  await withServer((req, res) => {
    if (req.url === '/r') return res.writeHead(302, { location: '/latest.json' }).end();
    res.end(JSON.stringify(feed()));
  }, async (b) => {
    assert.equal((await fetchFeed(`${b}/r`, { allowLocal: true })).version, '2.1.0');
  });
});

// ---- the installed bundle --------------------------------------------------------------
test('bundle paths', () => {
  assert.equal(bundleFromExe('/Applications/souldew.app/Contents/MacOS/souldew'), '/Applications/souldew.app');
  assert.equal(bundleFromExe('/Users/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), '/Users/x/node_modules/electron/dist/Electron.app');
  assert.equal(bundleFromExe('/usr/local/bin/node'), null);
  assert.ok(isTranslocated('/private/var/folders/ab/T/AppTranslocation/1234/d/souldew.app'));
  assert.equal(stagingDirFor('/Applications/souldew.app'), '/Applications/.souldew.update');
  assert.equal(canReplace(null).reason, 'not-bundle');
  assert.equal(canReplace('/private/var/folders/x/AppTranslocation/y/A.app').reason, 'translocated');
  assert.equal(canReplace('/Volumes/souldew/souldew.app').reason, 'dmg');
  assert.equal(canReplace(join(TMP, 'missing.app')).reason, 'read-only');
});

test('swapBundle replaces the app with two renames and rolls back on failure', () => {
  const apps = join(TMP, 'Applications');
  const target = join(apps, 'souldew.app');
  mkdirSync(join(target, 'Contents'), { recursive: true });
  writeFileSync(join(target, 'Contents', 'v'), '2.0.0');
  assert.deepEqual(canReplace(target), { ok: true });
  const staged = join(stagingDirFor(target), 'souldew.app');
  mkdirSync(join(staged, 'Contents'), { recursive: true });
  writeFileSync(join(staged, 'Contents', 'v'), '2.1.0');

  const old = swapBundle(target, staged);
  assert.equal(readFileSync(join(target, 'Contents', 'v'), 'utf8'), '2.1.0');
  assert.equal(readFileSync(join(old, 'Contents', 'v'), 'utf8'), '2.0.0');
  assert.ok(!existsSync(staged));
  // Nothing staged: the installed app stays untouched.
  assert.throws(() => swapBundle(target, staged), (e) => e.code === 'NO_STAGED');
  assert.equal(readFileSync(join(target, 'Contents', 'v'), 'utf8'), '2.1.0');
  // Next start cleans up the old bundle.
  cleanupStaging(target);
  assert.deepEqual(readdirSync(apps), ['souldew.app']);
});

test('release notes come from the matching CHANGELOG section', () => {
  const log = '# Changelog\n\n## 2.1.0 – 2026-10-17\n\n- Updates\n- Fixes\n\n## [2.0.0]\n\n- First\n';
  assert.equal(changelogSection(log, '2.1.0'), '- Updates\n- Fixes');
  assert.equal(changelogSection(log, '2.0.0'), '- First');
  assert.equal(changelogSection(log, '2.0.1'), null);
  assert.equal(changelogSection('## 2.1.0-beta.1\nx\n## 2.1.0\ny', '2.1.0'), 'y');
});

// ---- feed signature (Ed25519) ------------------------------------------------------------
test('signed feed: round trip, canonical form, tampering and missing signatures', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { canonicalFeed } = await import('../shared/update.mjs');
  const { signFeed, verifyFeedSignature, publicKeyBase64, parsePublicKey } = await import('../electron/update-core.mjs');
  const { privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKeyBase64(privateKey);
  // Canonical form: keys sorted, sig left out, whitespace and key order of the file don't matter.
  assert.equal(canonicalFeed({ b: 1, a: { d: 2, c: 'x' }, sig: 'zzz' }), '{"a":{"c":"x","d":2},"b":1}');
  const signed = signFeed(feed({ page: 'https://github.com/o/r/releases/tag/v2.1.0' }), privateKey);
  assert.match(signed.sig, /^[A-Za-z0-9+/]{86}==$/);
  const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(signed).reverse()), null, 2));
  assert.ok(verifyFeedSignature(reordered, pub));
  // Every field is covered – changing any of them (or adding one) breaks the signature.
  for (const over of [{ sha256: 'b'.repeat(64) }, { url: 'https://evil.example/x.dmg' }, { version: '9.9.9' }, { size: 1 }, { notes: 'Fixes!' }, { minVersion: '2.0.0' }]) {
    assert.throws(() => verifyFeedSignature({ ...signed, ...over }, pub), (e) => e.code === 'BAD_SIGNATURE', JSON.stringify(over));
  }
  // Missing, garbage or foreign signatures.
  const { sig, ...unsigned } = signed;
  assert.throws(() => verifyFeedSignature(unsigned, pub), (e) => e.code === 'BAD_SIGNATURE' && /not signed/.test(e.message));
  assert.throws(() => verifyFeedSignature({ ...signed, sig: 'not base64!' }, pub), (e) => e.code === 'BAD_SIGNATURE');
  assert.throws(() => verifyFeedSignature({ ...signed, sig: sig.slice(4) }, pub), (e) => e.code === 'BAD_SIGNATURE');
  const other = signFeed(feed({ page: 'https://github.com/o/r/releases/tag/v2.1.0' }), generateKeyPairSync('ed25519').privateKey);
  assert.throws(() => verifyFeedSignature(other, pub), (e) => e.code === 'BAD_SIGNATURE');
  // Only a valid Ed25519 public key is accepted as the app's key.
  assert.throws(() => parsePublicKey('abc'), (e) => e.code === 'BAD_SIGNATURE');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.throws(() => parsePublicKey(rsa), (e) => e.code === 'BAD_SIGNATURE');
  // Re-signing replaces an old sig instead of signing it.
  assert.ok(verifyFeedSignature(signFeed({ ...signed, notes: 'new' }, privateKey), pub));
});

test('fetchFeed checks the signature before using the feed when a public key is set', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { signFeed, publicKeyBase64 } = await import('../electron/update-core.mjs');
  const { privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKeyBase64(privateKey);
  const good = signFeed(feed(), privateKey);
  const bodies = { '/signed.json': good, '/unsigned.json': feed(), '/tampered.json': { ...good, url: 'https://evil.example/x.dmg' }, '/sha.json': { ...good, sha256: 'b'.repeat(64) } };
  await withServer((req, res) => (bodies[req.url] ? res.end(JSON.stringify(bodies[req.url])) : res.writeHead(404).end()), async (b) => {
    assert.equal((await fetchFeed(`${b}/signed.json`, { allowLocal: true, publicKey: pub })).version, '2.1.0');
    for (const p of ['/unsigned.json', '/tampered.json', '/sha.json']) {
      await assert.rejects(fetchFeed(`${b}${p}`, { allowLocal: true, publicKey: pub }), (e) => e.code === 'BAD_SIGNATURE', p);
    }
    // No key configured: today's behaviour (HTTPS + validation only), sig is simply ignored.
    assert.equal((await fetchFeed(`${b}/unsigned.json`, { allowLocal: true })).version, '2.1.0');
    assert.equal('sig' in (await fetchFeed(`${b}/signed.json`, { allowLocal: true })), false);
  });
});

test('release key: init writes 0600 key + public key and never overwrites', async () => {
  const { initKey, loadReleaseKey, keyPathFrom, DEFAULT_KEY } = await import('../scripts/release.mjs');
  const { statSync } = await import('node:fs');
  const dir = join(TMP, 'keys');
  const repoRoot = join(TMP, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  const pkgPath = join(repoRoot, 'package.json');
  writeFileSync(pkgPath, JSON.stringify({ name: 'x', version: '2.0.0', updates: { repo: 'o/r' } }, null, 2) + '\n');
  const keyPath = join(dir, 'sub', 'release-key.pem');
  const r = initKey({ keyPath, pkgPath, repoRoot });
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.deepEqual(pkg.updates, { repo: 'o/r', publicKey: r.publicKey });
  assert.equal(loadReleaseKey(keyPath, r.publicKey).publicKey, r.publicKey);
  // Second run: refused, key and package.json unchanged.
  const before = readFileSync(keyPath, 'utf8');
  assert.throws(() => initKey({ keyPath, pkgPath, repoRoot }), /already exists/);
  assert.equal(readFileSync(keyPath, 'utf8'), before);
  assert.equal(JSON.parse(readFileSync(pkgPath, 'utf8')).updates.publicKey, r.publicKey);
  // Never inside the project, and a key that doesn't match package.json is refused for signing.
  assert.throws(() => initKey({ keyPath: join(repoRoot, 'key.pem'), pkgPath, repoRoot }), /outside the project/);
  writeFileSync(join(TMP, 'pkg2.json'), '{}');
  assert.throws(() => initKey({ keyPath: join(dir, 'nopkg.pem'), pkgPath: join(TMP, 'missing.json'), repoRoot }), /ENOENT/);
  assert.equal(existsSync(join(dir, 'nopkg.pem')), false); // nothing written when package.json can't be read
  const other = initKey({ keyPath: join(dir, 'other.pem'), pkgPath: join(TMP, 'pkg2.json'), repoRoot }).keyPath;
  assert.throws(() => loadReleaseKey(other, r.publicKey), /does not match/);
  assert.equal(keyPathFrom({ key: keyPath }, {}), keyPath);
  assert.equal(keyPathFrom({}, { SLS_RELEASE_KEY: keyPath }), keyPath);
  assert.equal(keyPathFrom({}, {}), DEFAULT_KEY);
});
