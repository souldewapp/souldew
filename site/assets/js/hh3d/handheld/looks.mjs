// The souldew+ looks of the 3.0 launch animation – Gold, Clear shell, Holo label, the Rare start and the holo / glitter
// sticker finishes – arrive as DATA in the souldew+ pack (handheld/looks.json, like the banner recipes): material values,
// the board recipe, the foil pattern and a few lines of fragment code. The public scene (scene.mjs, surface.mjs) only knows
// "Your colours" and vinyl; without this data a souldew+ look simply isn't there – switching a flag in a patched client
// draws "Your colours". The data is checked strictly here before the scene sees any of it (it is signed and verified with
// the pack, but it is still data from outside).
//
//   cleanLooks(raw)            → { gold?, clear?, holo?, rare?, finishes: { holo?, glitter? } } or null
//   effectiveLook(look, L)     → 'gold' | 'clear' | 'theme' – what the scene can draw for a wanted shell look
//   effectiveCart(cart, L)     → 'gold' | 'holo' | undefined
//   hasLook(id, L)             → can the launch look id (shared/handheld.mjs LAUNCH_LOOKS) be drawn with this data?
//   finishIndex(finish, L)     → 0 vinyl | 1 holo | 2 glitter, vinyl when its data isn't there

const HEX = /^#[0-9a-f]{6}$/i;
const hex = (v) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : null);
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

// MeshPhysicalMaterial values a pack may set, with the range each may take (anything else is dropped)
const MAT = {
  metalness: [0, 1], roughness: [0, 1], anisotropy: [0, 1], clearcoat: [0, 1], clearcoatRoughness: [0, 1], envMapIntensity: [0, 8],
  transmission: [0, 1], thickness: [0, 50], ior: [1, 2.333], attenuationDistance: [0.01, 1000], specularIntensity: [0, 1],
  iridescence: [0, 1], iridescenceIOR: [1, 2.333], tone: [0, 0.5], whiten: [0, 1], opacity: [0, 1], shade: [0, 2],
};
/** a material: { color?, emissive?, iridescenceThicknessRange?, …MAT } → the checked values only, or null when invalid */
function mat(raw, { color = false } = {}) {
  const m = obj(raw);
  if (!m) return null;
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if (k === 'color' || k === 'emissive') {
      const c = hex(v);
      if (!c) return null;
      out[k] = c;
    } else if (k === 'iridescenceThicknessRange') {
      if (!Array.isArray(v) || v.length !== 2 || num(v[0], 0, 5000) == null || num(v[1], 0, 5000) == null) return null;
      out[k] = [v[0], v[1]];
    } else if (Object.hasOwn(MAT, k)) {
      const n = num(v, ...MAT[k]);
      if (n == null) return null;
      out[k] = n;
    }
  }
  if (color && !out.color) return null;
  return out;
}

// Fragment code from the pack: plain expressions and statements over the variables the public shader offers. No
// preprocessor lines (#extension, #define, #include…), no declarations of its own uniforms / varyings / attributes,
// no texture reads, nothing but the characters GLSL statements are made of, and kept short.
const GLSL_MAX = 4000;
const GLSL_CHARS = /^[A-Za-z0-9_\s.,;:+\-*/()<>=!&|?[\]{}]*$/;
const GLSL_DENY = /\b(uniform|varying|attribute|in|out|inout|layout|precision|texture\w*|discard|while|do|for|return|gl_\w+)\b/;
export function cleanGlsl(v) {
  if (typeof v !== 'string' || v.length > GLSL_MAX || !GLSL_CHARS.test(v) || GLSL_DENY.test(v)) return null;
  let depth = 0;
  for (const ch of v) {
    if (ch === '{' || ch === '(') depth++;
    else if (ch === '}' || ch === ')') depth--;
    if (depth < 0) return null;
  }
  return depth === 0 ? v : null;
}

const frac = (v) => (Array.isArray(v) && v.length === 2 && num(v[0], 0, 1) != null && num(v[1], -200, 200) != null ? [v[0], v[1]] : null);
const unit2 = (v) => (Array.isArray(v) && v.length === 2 && v.every((x) => num(x, 0, 1) != null) ? [v[0], v[1]] : null);
/** every value set (a nested plain object too) – one missing or invalid value refuses the whole recipe */
const complete = (o) => !!o && Object.values(o).every((v) => v !== null && v !== undefined && (typeof v !== 'object' || Array.isArray(v) || complete(v)));
function chipOf(raw) {
  const c = obj(raw);
  if (!c) return null;
  const label = c.label == null ? '' : typeof c.label === 'string' && /^[A-Za-z0-9 -]{1,8}$/.test(c.label) ? c.label : null;
  const out = { x: frac(c.x), y: frac(c.y), w: num(c.w, 1, 60), h: num(c.h, 1, 60), label };
  return complete(out) ? out : null;
}
function board(raw) {
  const b = obj(raw);
  if (!b) return null;
  const tr = obj(b.traces), chip = obj(b.chip), coin = obj(b.coin), con = obj(b.connector);
  const chips = Array.isArray(b.chips) && b.chips.length <= 8 ? b.chips.map(chipOf) : null;
  if (!chips || chips.some((c) => !c)) return null;
  const out = {
    scale: num(b.scale, 2, 12), bg: hex(b.bg), edge: hex(b.edge), seed: num(b.seed, 0, 1e6),
    traces: tr && {
      n: num(tr.n, 0, 64), spread: num(tr.spread, 0, 400), y0: num(tr.y0, 0, 1), x: unit2(tr.x), y: unit2(tr.y),
      color: hex(tr.color), width: num(tr.width, 0.5, 20), maskWidth: num(tr.maskWidth, 0.5, 20), pad: hex(tr.pad), padR: num(tr.padR, 0, 20),
    },
    chips,
    chip: chip && { pins: hex(chip.pins), body: hex(chip.body), top: hex(chip.top), label: hex(chip.label) },
    coin: coin && { x: num(coin.x, 0, 1), y: num(coin.y, 0, 1), r: num(coin.r, 0, 40), r2: num(coin.r2, 0, 40), ring: hex(coin.ring), face: hex(coin.face) },
    connector: con && { color: hex(con.color), w: num(con.w, 0, 200), h: num(con.h, 0, 40), y: num(con.y, 0, 40) },
    material: mat(b.material),
  };
  return complete(out) ? out : null;
}

function foil(raw) {
  const f = obj(raw);
  if (!f || !Array.isArray(f.terms) || f.terms.length < 1 || f.terms.length > 6) return null;
  const terms = f.terms.map((t) => obj(t) && { a: num(t.a, -2, 2), kx: num(t.kx, -4, 4), ky: num(t.ky, -4, 4), wy: num(t.wy ?? 0, -4, 4), wa: num(t.wa ?? 0, -8, 8) });
  const size = num(f.size, 16, 512), base = num(f.base, -2, 2);
  if (size == null || base == null || !terms.every(complete)) return null;
  return { size: Math.round(size), base, terms };
}

const palette4 = (v) => (Array.isArray(v) && v.length === 4 && v.every(hex) ? v.map(hex) : null);

/** The pack's handheld/looks.json → the looks the scene may draw (each one whole or not at all), or null. */
export function cleanLooks(raw) {
  const L = obj(raw);
  if (!L || L.v !== 1) return null;
  const out = { finishes: {} };
  const g = obj(L.gold);
  if (g) {
    const v = { shell: mat(g.shell, { color: true }), dark: mat(g.dark, { color: true }), keys: mat(g.keys, { color: true }), word: mat(g.word, { color: true }), cart: mat(g.cart, { color: true }), pulse: hex(g.pulse) };
    if (Object.values(v).every(Boolean)) out.gold = v;
  }
  const c = obj(L.clear);
  if (c) {
    const v = { shell: mat(c.shell), word: mat(c.word), board: board(c.board) };
    if (Object.values(v).every(Boolean)) out.clear = v;
  }
  const h = obj(L.holo);
  if (h) {
    const v = { label: mat(h.label), foil: foil(h.foil), glsl: cleanGlsl(h.glsl) };
    if (Object.values(v).every(Boolean)) out.holo = v;
  }
  const r = obj(L.rare);
  if (r) {
    const v = { screen: palette4(r.screen), pulse: hex(r.pulse), glow: hex(r.glow) };
    if (Object.values(v).every(Boolean)) out.rare = v;
  }
  const f = obj(L.finishes) || {};
  const fh = obj(f.holo);
  if (fh) {
    const v = { roughness: num(fh.roughness, 0, 1), metalness: num(fh.metalness, 0, 1), glsl: cleanGlsl(fh.glsl) };
    if (Object.values(v).every((x) => x != null)) out.finishes.holo = v;
  }
  const fg = obj(f.glitter);
  if (fg) {
    const glsl = cleanGlsl(fg.glsl);
    if (glsl) out.finishes.glitter = { glsl };
  }
  return out.gold || out.clear || out.holo || out.rare || out.finishes.holo || out.finishes.glitter ? out : null;
}

/** The shell the scene can draw: a souldew+ shell only with its data, else "Your colours". */
export const effectiveLook = (look, L) => (look === 'gold' && L?.gold ? 'gold' : look === 'clear' && L?.clear ? 'clear' : 'theme');
/** The cartridge the scene can draw: the gold one only with Gold's data, the holo label only with its data. */
export const effectiveCart = (cart, L) => (cart === 'gold' && L?.gold ? 'gold' : cart === 'holo' && L?.holo ? 'holo' : undefined);
/** Can this launch look (shared/handheld.mjs LAUNCH_LOOKS id) be drawn? "Your colours" always can. */
export function hasLook(id, L) {
  if (id === 'gold') return !!L?.gold;
  if (id === 'clear-shell') return !!L?.clear;
  if (id === 'holo') return !!L?.holo;
  return true;
}
/** The sticker finish the shader draws: holo / glitter only with their data, else vinyl. */
export const finishIndex = (finish, L) => (finish === 'holo' && L?.finishes?.holo ? 1 : finish === 'glitter' && L?.finishes?.glitter ? 2 : 0);
/** Can a Rare start be drawn? */
export const hasRare = (L) => !!L?.rare;
