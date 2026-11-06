// Graphics backend (Settings › General): flag parsing, backend → Chromium switches per platform, the fallback to
// "Automatic" after failed starts or GPU crashes, and the config round trip through the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gpuBackends, validBackend, backendSwitches, parseChromiumFlags, chromiumSwitches, startDecision, crashDecision,
  fallbackNotice, gpuInfoSummary, MAX_FAILED_STARTS, MAX_GPU_CRASHES } from '../shared/gpu.mjs';

test('choices per platform: Windows has D3D11 / Vulkan / OpenGL, Linux OpenGL / Vulkan, macOS only Automatic', () => {
  assert.deepEqual(gpuBackends('win32'), ['auto', 'd3d11', 'vulkan', 'gl']);
  assert.deepEqual(gpuBackends('linux'), ['auto', 'gl', 'vulkan']);
  assert.deepEqual(gpuBackends('darwin'), ['auto']);
  assert.equal(validBackend('d3d11', 'linux'), 'auto', 'Direct3D only exists on Windows');
  assert.equal(validBackend('vulkan', 'darwin'), 'auto');
  assert.equal(validBackend('"; rm -rf', 'win32'), 'auto');
  assert.equal(validBackend(undefined, 'win32'), 'auto');
});

test('backend → switches: --use-angle on Windows, --use-gl=angle plus --use-angle on Linux, nothing for Automatic', () => {
  assert.deepEqual(backendSwitches('d3d11', 'win32'), [['use-angle', 'd3d11']]);
  assert.deepEqual(backendSwitches('vulkan', 'win32'), [['use-angle', 'vulkan']]);
  assert.deepEqual(backendSwitches('gl', 'win32'), [['use-angle', 'gl']]);
  assert.deepEqual(backendSwitches('vulkan', 'linux'), [['use-gl', 'angle'], ['use-angle', 'vulkan']]);
  assert.deepEqual(backendSwitches('gl', 'linux'), [['use-gl', 'angle'], ['use-angle', 'gl']]);
  assert.deepEqual(backendSwitches('d3d11', 'linux'), []);
  assert.deepEqual(backendSwitches('auto', 'win32'), []);
  assert.deepEqual(backendSwitches('vulkan', 'darwin'), []);
});

test('SOULDEW_CHROMIUM_FLAGS: names with or without dashes and values, underscores normalized, junk skipped', () => {
  assert.deepEqual(parseChromiumFlags('use_angle=vulkan'), [['use-angle', 'vulkan']]);
  assert.deepEqual(parseChromiumFlags('  --use-angle=gl   --ignore-gpu-blocklist\tenable-features=Vulkan,VulkanFromANGLE '),
    [['use-angle', 'gl'], ['ignore-gpu-blocklist', null], ['enable-features', 'Vulkan,VulkanFromANGLE']]);
  assert.deepEqual(parseChromiumFlags('use-angle=d3d11 use_angle=vulkan'), [['use-angle', 'vulkan']], 'the last one wins');
  assert.deepEqual(parseChromiumFlags('=x -- --=y ;evil a/b=1 ok'), [['ok', null]]);
  assert.deepEqual(parseChromiumFlags('flag='), [['flag', '']]);
  assert.deepEqual(parseChromiumFlags(''), []);
  assert.deepEqual(parseChromiumFlags(undefined), []);
});

test('the setting wins over the environment only when it is not Automatic', () => {
  const envFlags = 'use_angle=gl ignore-gpu-blocklist';
  assert.deepEqual(chromiumSwitches({ backend: 'auto', platform: 'win32', envFlags }), [['use-angle', 'gl'], ['ignore-gpu-blocklist', null]]);
  assert.deepEqual(chromiumSwitches({ backend: 'vulkan', platform: 'win32', envFlags }), [['ignore-gpu-blocklist', null], ['use-angle', 'vulkan']]);
  assert.deepEqual(chromiumSwitches({ backend: 'vulkan', platform: 'linux', envFlags: 'use-gl=egl use-angle=gl' }), [['use-gl', 'angle'], ['use-angle', 'vulkan']]);
  assert.deepEqual(chromiumSwitches({ backend: 'vulkan', platform: 'darwin', envFlags }), [['use-angle', 'gl'], ['ignore-gpu-blocklist', null]], 'macOS has no setting – the environment stays');
  assert.deepEqual(chromiumSwitches({ backend: 'auto', platform: 'win32' }), []);
});

test('failed starts: counted while the window never showed, back to Automatic after MAX_FAILED_STARTS', () => {
  assert.equal(MAX_FAILED_STARTS, 2);
  let config = { gpuBackend: 'vulkan' };
  const run = () => {
    const r = startDecision(config, 'win32');
    config = { ...config, ...r.patch };
    return r;
  };
  assert.equal(run().backend, 'vulkan');
  assert.deepEqual(config.gpuStart, { backend: 'vulkan', pending: 1 });
  // the window showed → main.mjs clears the marker → the next start counts from zero again
  config.gpuStart = null;
  assert.equal(run().backend, 'vulkan');
  assert.deepEqual(config.gpuStart, { backend: 'vulkan', pending: 1 });
  // two starts in a row without a window
  assert.equal(run().backend, 'vulkan');
  assert.deepEqual(config.gpuStart, { backend: 'vulkan', pending: 2 });
  const r = run();
  assert.equal(r.backend, 'auto');
  assert.deepEqual(config, { gpuBackend: 'auto', gpuStart: null, gpuFallback: { from: 'vulkan', reason: 'no-window' } });
  // and from then on nothing to do
  assert.deepEqual(startDecision(config, 'win32'), { backend: 'auto', patch: null });
});

test('start decision: a marker of another backend, Automatic and an unknown value', () => {
  assert.deepEqual(startDecision({ gpuBackend: 'gl', gpuStart: { backend: 'vulkan', pending: 5 } }, 'win32').patch, { gpuStart: { backend: 'gl', pending: 1 } },
    'a newly chosen backend gets its own tries');
  assert.deepEqual(startDecision({ gpuBackend: 'auto', gpuStart: { backend: 'vulkan', pending: 1 } }, 'win32'), { backend: 'auto', patch: { gpuStart: null } });
  assert.deepEqual(startDecision({ gpuBackend: 'd3d11' }, 'linux'), { backend: 'auto', patch: null }, 'not offered on Linux');
  assert.deepEqual(startDecision({ gpuBackend: 'vulkan', gpuStart: { backend: 'vulkan', pending: 'x' } }, 'linux').patch, { gpuStart: { backend: 'vulkan', pending: 1 } });
  assert.deepEqual(startDecision({}, 'win32'), { backend: 'auto', patch: null });
  assert.deepEqual(startDecision(null, 'win32'), { backend: 'auto', patch: null });
});

test('GPU crashes: only a chosen backend falls back, once the crashes reach MAX_GPU_CRASHES', () => {
  assert.equal(MAX_GPU_CRASHES, 3);
  assert.equal(crashDecision('vulkan', 2), null);
  assert.deepEqual(crashDecision('vulkan', 3), { gpuBackend: 'auto', gpuStart: null, gpuFallback: { from: 'vulkan', reason: 'gpu-crash' } });
  assert.equal(crashDecision('auto', 10), null, 'Automatic is already the safe choice');
  assert.equal(crashDecision(undefined, 10), null);
});

test('fallback notice and GPU info are cleaned before they reach the page / the diagnostics file', () => {
  assert.deepEqual(fallbackNotice({ from: 'vulkan', reason: 'gpu-crash', extra: 1 }), { from: 'vulkan', reason: 'gpu-crash' });
  assert.equal(fallbackNotice({ from: '<b>', reason: 'gpu-crash' }), null);
  assert.equal(fallbackNotice({ from: 'gl', reason: 'whatever' }), null);
  assert.equal(fallbackNotice('vulkan'), null);
  assert.equal(fallbackNotice(null), null);
  const info = {
    gpuDevice: [{ active: true, vendorId: 4318, deviceId: 7955, driverVendor: 'NVIDIA', driverVersion: '31.0.15.5222', vendorString: '', deviceString: 'GeForce', sub: 'x' }],
    auxAttributes: { glRenderer: 'ANGLE (NVIDIA, Vulkan 1.3)', displayType: 'D3D11', machineModelName: 'secret?' },
    machineModelName: 'x',
  };
  assert.deepEqual(gpuInfoSummary(info), {
    devices: [{ active: true, vendorId: 4318, deviceId: 7955, driverVendor: 'NVIDIA', driverVersion: '31.0.15.5222', deviceString: 'GeForce' }],
    glRenderer: 'ANGLE (NVIDIA, Vulkan 1.3)', displayType: 'D3D11',
  });
  assert.deepEqual(gpuInfoSummary(null), { devices: [] });
});

test('electron/main.mjs reads the graphics backend from the config.json the server writes', () => {
  const main = readFileSync(new URL('../electron/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /process\.env\.SLS_DATA_DIR = app\.getPath\('userData'\)/);
  assert.match(main, /CONFIG_FILE = join\(app\.getPath\('userData'\), 'config\.json'\)/);
  // the switches go in before the app is ready (appendSwitch after ready has no effect on the GPU process)
  assert.ok(main.indexOf('app.commandLine.appendSwitch(name') < main.indexOf('app.whenReady()'));
  assert.ok(main.includes('process.env.SOULDEW_CHROMIUM_FLAGS'));
});

test('server: the backend is stored only when this platform offers it, the notice can only be dismissed', async () => {
  const DATA = mkdtempSync(join(tmpdir(), 'sls-gpu-'));
  process.env.SLS_DATA_DIR = DATA;
  const { startServer, saveConfig } = await import('../server/app.mjs');
  const { server, url } = await startServer({ port: 0, background: false });
  const headers = { 'content-type': 'application/json', 'x-soullink': '1' };
  const post = (body) => fetch(`${url}/api/config`, { method: 'POST', headers, body: JSON.stringify(body) }).then((r) => r.json());
  const status = () => fetch(`${url}/api/status`, { headers }).then((r) => r.json());
  try {
    assert.equal((await status()).config.gpuBackend, 'auto');
    let c = await post({ gpuBackend: 'metal' });
    assert.equal(c.gpuBackend, undefined, 'never offered anywhere');
    const offered = gpuBackends(process.platform).at(-1);
    saveConfig({ gpuStart: { backend: 'vulkan', pending: 1 } });
    c = await post({ gpuBackend: offered });
    assert.equal(c.gpuBackend, offered);
    assert.equal(c.gpuStart, null, 'a new choice resets the failed-start count');
    assert.equal((await status()).config.gpuBackend, offered);

    saveConfig({ gpuFallback: { from: 'vulkan', reason: 'no-window' } });
    assert.deepEqual((await status()).config.gpuFallback, { from: 'vulkan', reason: 'no-window' });
    c = await post({ gpuFallback: { from: 'gl', reason: 'gpu-crash' } });
    assert.deepEqual(c.gpuFallback, { from: 'vulkan', reason: 'no-window' }, 'the page can’t write a notice');
    c = await post({ gpuFallback: null });
    assert.equal(c.gpuFallback, null);
    assert.equal((await status()).config.gpuFallback, null);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(DATA, { recursive: true, force: true });
  }
});
