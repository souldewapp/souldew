// How the built-in 3DS player draws (native/ctr-host/ctrhost.c --renderer) – Settings › Emulators › "3DS renderer":
//   auto      the default: "vulkan", and when the host crashes in its first seconds on a graphics card, the next safer
//             mode right away (same game, same page) – remembered for that card and driver, so the next start takes it
//   vulkan    Vulkan with the device the standalone Azahar creates (its optional features enabled properly)
//   compat    Vulkan with only the core's own libretro device (the optional features hidden – 2.7.0's way)
//   software  Azahar's software renderer: no GPU, slow (about 25–30 fps on an M1), but any driver runs it
// A driver update changes the card's key (the driver is part of it): "auto" then tries Vulkan again. A step down also
// goes back to 1× resolution (see CTR_SCALES).

export const CTR_RENDERERS = ['auto', 'vulkan', 'compat', 'software'];
/** The fallback order of "auto" – each step needs less from the graphics driver. */
export const RENDERER_CHAIN = ['vulkan', 'compat', 'software'];
/** A host that ends badly within this long after its start counts as "the renderer can't run on this card". */
export const RETRY_WINDOW_MS = 30 * 1000;
/** At most this many cards / drivers are remembered (the oldest go). */
const MEMO_MAX = 16;

export const validRenderer = (v) => (CTR_RENDERERS.includes(v) ? v : 'auto');
// Android: the core has no software renderer there (it falls back to "unknown graphics API" and crashes), so "auto" never
// steps down to it
export const chainFor = (platform = process.platform) => (platform === 'android' ? RENDERER_CHAIN.filter((r) => r !== 'software') : RENDERER_CHAIN);
export const nextRenderer = (mode, platform = process.platform) => { const chain = chainFor(platform); return chain[chain.indexOf(mode) + 1] || null; };

/** A graphics card and its driver as a key: "1002:7550|2.0.416 AMD proprietary driver 26.11.1 (LLPC)". Unknown: "?". */
export function gpuKey(gpu) {
  if (!gpu || !gpu.vendor) return '?';
  return `${gpu.vendor}:${gpu.device || '?'}|${gpu.driver || ''}`.slice(0, 200);
}

/**
 * The renderer for the next start: the chosen one, or (auto) what was learned for the card the last game ran on.
 * { mode, auto } – auto: a crash in the first seconds may step down (see rendererFailure).
 */
export function pickRenderer({ setting, memo, lastGpu, platform = process.platform } = {}) {
  const s = validRenderer(setting);
  if (s !== 'auto') return { mode: s, auto: false };
  const m = memo && typeof memo === 'object' ? memo[lastGpu || '?'] : null;
  return { mode: chainFor(platform).includes(m) ? m : 'vulkan', auto: true };
}

/** `memo` with `key` → `mode` (newest last, at most MEMO_MAX entries). */
export function remember(memo, key, mode) {
  const out = Object.entries(memo && typeof memo === 'object' && !Array.isArray(memo) ? memo : {})
    .filter(([k, v]) => k !== key && typeof k === 'string' && RENDERER_CHAIN.includes(v));
  out.push([key, mode]);
  return Object.fromEntries(out.slice(-MEMO_MAX));
}

// host errors that are about the game file or souldew's own files – a different renderer wouldn't help
const NOT_RENDERER = /couldn.t load the game|core not loadable|missing in the core|usage:/i;
const RENDERER_ERROR = /vulkan|graphics|gpu|VK_ERROR|driver/i;

/**
 * Did a host end the way a graphics-driver problem ends – within RETRY_WINDOW_MS of its start, and crashed (a crash
 * report, a signal, an exception exit code) or with a Vulkan / graphics error? Then the next safer renderer may run.
 */
export function rendererFailure({ exit, events = [], ms = 0, quit = false } = {}) {
  if (quit || !exit || ms > RETRY_WINDOW_MS) return false;
  const error = [...events].reverse().find((e) => e?.event === 'error');
  if (error) {
    if (error.crash) return true;
    const msg = String(error.message || '');
    return !NOT_RENDERER.test(msg) && RENDERER_ERROR.test(msg);
  }
  if (exit.error) return false; // couldn't even start the host (a missing file – nothing a renderer changes)
  if (exit.signal) return true;
  return exit.code !== 0 && exit.code != null;
}

/** The host's arguments with `name value` (replaced or added). */
export function withArg(args, name, value) {
  const out = [...args];
  const i = out.indexOf(name);
  if (i >= 0) out[i + 1] = String(value);
  else out.push(name, String(value));
  return out;
}

/** The host's arguments with `--renderer mode` (replaced or added). */
export const withRenderer = (args, mode) => withArg(args, '--renderer', mode);

// Settings › Emulators › "3DS resolution": the core's internal resolution factor (citra_resolution_factor, ctrhost.c
// --scale). Each step multiplies the picture's pixels – 1× 400×480 (both screens), 2× 800×960, 3× 1200×1440 – and so
// the graphics card's work and what the host reads back and hands to the page every frame (≈7 MB at 3×). The Software
// renderer and every step down of "auto" play at 1×: they are there for graphics cards that already struggle.
export const CTR_SCALES = [1, 2, 3];
export const validScale = (v) => (CTR_SCALES.includes(v) ? v : 1);
/** The resolution factor a host starts with: the chosen one, 1× with the Software renderer. */
export const scaleFor = (scale, renderer) => (renderer === 'software' ? 1 : validScale(scale));
