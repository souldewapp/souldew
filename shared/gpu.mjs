// Graphics backend (Settings › General, Windows and Linux): which API Chromium's ANGLE layer draws the app – and the
// built-in emulator – with. On some Windows PCs the default (Direct3D 11) makes the emulator stutter and its sound
// crackle, while Vulkan runs smoothly. The switches have to be set before Electron is ready, so electron/main.mjs
// reads the choice straight from config.json. Pure functions (no 'electron' import), tested in test/gpu.test.mjs;
// the server validates the setting and the page lists the choices with them.

/** The choices per platform; 'auto' (the first) leaves it to Chromium. macOS has only 'auto' (ANGLE uses Metal). */
export const GPU_BACKENDS = {
  win32: ['auto', 'd3d11', 'vulkan', 'gl'],
  linux: ['auto', 'gl', 'vulkan'],
};

export const gpuBackends = (platform) => GPU_BACKENDS[platform] || ['auto'];

/** `backend` if this platform offers it, else 'auto' – an unknown value in config.json never reaches Chromium. */
export const validBackend = (backend, platform) => (gpuBackends(platform).includes(backend) ? backend : 'auto');

/**
 * The Chromium switches for a backend, as [name, value] pairs. Windows: `--use-angle=d3d11|vulkan|gl`. Linux: ANGLE
 * is only used with `--use-gl=angle` (the default of current Chromium, set explicitly so the choice always applies),
 * then `--use-angle=gl|vulkan`. 'auto' and anything a platform doesn't offer: none.
 */
export function backendSwitches(backend, platform) {
  const b = validBackend(backend, platform);
  if (b === 'auto') return [];
  if (platform === 'linux') return [['use-gl', 'angle'], ['use-angle', b]];
  return [['use-angle', b]];
}

/**
 * SOULDEW_CHROMIUM_FLAGS for power users: space-separated `name` or `name=value`, with or without leading dashes.
 * Underscores in the name become dashes (`use_angle=vulkan` → `use-angle`, as some guides write it). Anything that
 * isn't a plausible switch name is skipped. Returns [name, value | null] pairs, the last one of a name winning.
 */
export function parseChromiumFlags(text) {
  if (typeof text !== 'string') return [];
  const flags = new Map();
  for (const word of text.trim().split(/\s+/)) {
    const eq = word.indexOf('=');
    const name = (eq < 0 ? word : word.slice(0, eq)).replace(/^-+/, '').replace(/_/g, '-').toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) continue;
    flags.delete(name); // keeps the order of the last occurrence
    flags.set(name, eq < 0 ? null : word.slice(eq + 1));
  }
  return [...flags];
}

/**
 * Every switch to append before ready: the environment's flags, then the setting's. A chosen backend (not 'auto')
 * replaces the environment's use-angle / use-gl; with 'auto' the environment's stay as they are.
 */
export function chromiumSwitches({ backend, platform, envFlags = '' }) {
  const own = backendSwitches(backend, platform);
  const mine = new Set(own.map(([name]) => name));
  return [...parseChromiumFlags(envFlags).filter(([name]) => !mine.has(name)), ...own];
}

/** Starts in a row with a chosen backend that never showed the window before souldew goes back to 'auto'. */
export const MAX_FAILED_STARTS = 2;
/** GPU process crashes within one session with a chosen backend before the next start uses 'auto'. */
export const MAX_GPU_CRASHES = 3;

/**
 * What a start does with the backend in `config` (the parsed config.json). config.gpuStart = { backend, pending } is
 * written at every start with a chosen backend and removed once the window shows: if it is still there, the
 * previous starts never got that far. Returns { backend } to use now and `patch` for config.json (or null) – after
 * MAX_FAILED_STARTS failed starts the backend falls back to 'auto' and gpuFallback tells the user once.
 */
export function startDecision(config, platform, maxFailed = MAX_FAILED_STARTS) {
  const backend = validBackend(config?.gpuBackend, platform);
  const marker = config?.gpuStart;
  if (backend === 'auto') return { backend, patch: marker ? { gpuStart: null } : null };
  const pending = marker && marker.backend === backend && Number.isInteger(marker.pending) && marker.pending > 0 ? marker.pending : 0;
  if (pending >= maxFailed) {
    return { backend: 'auto', patch: { gpuBackend: 'auto', gpuStart: null, gpuFallback: { from: backend, reason: 'no-window' } } };
  }
  return { backend, patch: { gpuStart: { backend, pending: pending + 1 } } };
}

/**
 * After a GPU process crash: the config.json patch that makes the next start use 'auto' (or null). Only a chosen
 * backend falls back, and only once the crashes reach `max`.
 */
export function crashDecision(backend, crashes, max = MAX_GPU_CRASHES) {
  if (!backend || backend === 'auto' || !(crashes >= max)) return null;
  return { gpuBackend: 'auto', gpuStart: null, gpuFallback: { from: backend, reason: 'gpu-crash' } };
}

/** The fallback notice as stored in config.json, cleaned for the page – or null. */
export function fallbackNotice(value) {
  if (!value || typeof value !== 'object') return null;
  const from = ['d3d11', 'vulkan', 'gl'].includes(value.from) ? value.from : null;
  const reason = ['no-window', 'gpu-crash'].includes(value.reason) ? value.reason : null;
  return from && reason ? { from, reason } : null;
}

const GPU_DEVICE_KEYS = ['active', 'vendorId', 'deviceId', 'driverVendor', 'driverVersion', 'vendorString', 'deviceString'];
const GPU_AUX_KEYS = ['glRenderer', 'glVendor', 'glVersion', 'glImplementationParts', 'displayType', 'optimus', 'amdSwitchable'];

/** The part of app.getGPUInfo('basic') that goes into "Save diagnostics": the graphics cards and their drivers. */
export function gpuInfoSummary(info) {
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined && o[k] !== '').map((k) => [k, o[k]]));
  const devices = Array.isArray(info?.gpuDevice) ? info.gpuDevice.slice(0, 4).map((d) => pick(d, GPU_DEVICE_KEYS)) : [];
  return { devices, ...pick(info?.auxAttributes, GPU_AUX_KEYS) };
}
