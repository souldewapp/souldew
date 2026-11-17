// The randomizer on Android: no Java, the bridge runs through the Android Runtime (dalvikvm) from a DEX jar.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { bridgeCommand, ANDROID_DALVIKVM, ANDROID_HEAP } = await import('../server/lib/toolchain.mjs');

test('Android: dalvikvm with the dex jar as class path, then the bridge', () => {
  const [bin, argv, cwd] = bridgeCommand({ platform: 'android', java: { bin: ANDROID_DALVIKVM[0] }, jar: '/data/app/tools/upr/PokeRandoZX.jar', bridgeDir: '/x', args: ['info', '/r.gba'] });
  assert.equal(bin, ANDROID_DALVIKVM[0]);
  assert.equal(argv[0], '-Xmx1g');
  assert.equal(argv[argv.indexOf('-cp') + 1], '/data/app/tools/upr/PokeRandoZX.jar');
  assert.deepEqual(argv.slice(-3), ['SoulLinkBridge', 'info', '/r.gba']);
  assert.ok(argv.includes('-Dfile.encoding=UTF-8'));
  assert.ok(!argv.some((a) => a.includes('awt')), 'only options ART understands');
  assert.equal(cwd, '/data/app/tools/upr');
});

test('Android, a 3DS game: the biggest heap ART can start (not the desktop 4.5 GB, which it refuses)', () => {
  const [, argv] = bridgeCommand({ platform: 'android', java: { bin: ANDROID_DALVIKVM[0] }, jar: '/j.jar', ctr: true, workDir: '/w', args: ['randomize'] });
  assert.equal(argv[0], ANDROID_HEAP);
  assert.ok(Number(ANDROID_HEAP.match(/\d+/)[0]) <= 1800, 'above ~1.8 GB ART does not start');
  assert.ok(argv.includes('-Dsouldew.upr.root=/w'));
});

test('desktop: java -cp bridge folder first, then the jar', () => {
  const [bin, argv] = bridgeCommand({ platform: 'linux', java: { bin: 'java' }, jar: '/t/upr.jar', bridgeDir: '/t/bridge', args: ['info', '/r.gba'] });
  assert.equal(bin, 'java');
  const cp = argv[argv.indexOf('-cp') + 1];
  assert.ok(cp.startsWith('/t/bridge'), 'the bridge folder (fixed Effectiveness) wins');
  assert.ok(cp.endsWith('/t/upr.jar'));
  assert.deepEqual(argv.slice(-3), ['SoulLinkBridge', 'info', '/r.gba']);
});

test('Android 3DS host: hardware vertex shaders off (the Adreno driver fails to build their pipelines)', async () => {
  const { androidHostEnv } = await import('../server/lib/ctr.mjs');
  assert.equal(androidHostEnv({ platform: 'win32' }), undefined);
  assert.equal(androidHostEnv({ platform: 'linux' }), undefined);
  const env = androidHostEnv({ platform: 'android', env: { PATH: '/x' } });
  assert.equal(env.CTRHOST_OPT_citra_use_hw_shader, 'disabled');
  assert.equal(env.PATH, '/x', 'the rest of the environment stays');
});

test('Android: "auto" never steps down to the software renderer (the core crashes without a GPU renderer there)', async () => {
  const { nextRenderer, pickRenderer, chainFor } = await import('../server/lib/ctrrenderer.mjs');
  assert.deepEqual(chainFor('android'), ['vulkan', 'compat']);
  assert.equal(nextRenderer('compat', 'android'), null);
  assert.equal(nextRenderer('compat', 'win32'), 'software');
  // a remembered "software" (learned before) is not used on Android
  assert.equal(pickRenderer({ setting: 'auto', memo: { k: 'software' }, lastGpu: 'k', platform: 'android' }).mode, 'vulkan');
  assert.equal(pickRenderer({ setting: 'auto', memo: { k: 'software' }, lastGpu: 'k', platform: 'linux' }).mode, 'software');
});

test('Android: the device search looks in the shared storage (Download, ROMs …), not in the private home', async () => {
  const { discoverCandidates } = await import('../server/lib/library.mjs');
  const c = discoverCandidates('/data/user/0/app.souldew/files', { platform: 'android', env: {} });
  assert.ok(c.includes('/storage/emulated/0/Download'));
  assert.ok(c.includes('/storage/emulated/0/ROMs'));
  assert.ok(!c.some((p) => p.includes('app.souldew')), 'the private home is not searched');
  const d = discoverCandidates('/x', { platform: 'android', env: { SLS_SHARED_DIR: '/sdcard' } });
  assert.ok(d.includes('/sdcard/Download'));
});
