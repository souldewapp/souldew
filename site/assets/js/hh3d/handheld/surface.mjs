// "Your handheld": what lies ON the shell – a printed vinyl wrap and die-cut stickers – as a few lines injected into
// three.js' MeshPhysicalMaterial. Both live in one coordinate system: the shell UNFOLDED (geometry.mjs has the same maths
// in JS, for picking and placing). So art and stickers wrap round edges the way vinyl does – no stretching across the
// edge, a little compression round the plan corners, exactly where real skins wrinkle – and the art's pixels stay square
// at one fixed size everywhere.
//
// In that flat space the wrap is a shape: "reaches this far over the edges" minus cut-outs (screen, pad, buttons, LED,
// speaker holes, slot, hinge) as rounded boxes – a signed distance, so its edge is crisp at any zoom and catches the
// light like a 0.1 mm film edge. Stickers are a distance field too (the die-cut line round the pixel art).
//
// Vinyl is the free finish and the only one drawn here. The souldew+ finishes (holo film, glitter) are a few lines of
// fragment code and two numbers that come with the souldew+ pack (handheld/looks.json › finishes, checked by looks.mjs);
// without them a holo or glitter sticker is drawn as vinyl (scene.mjs sets its finish index from the same data).

export const NCUT = 28;
export const NSTK = 9; // 8 stickers per device + the one being dragged

const PARS = /* glsl */ `
#define NCUT ${NCUT}
#define NSTK ${NSTK}
uniform vec4 uSlab; uniform vec2 uRad;
uniform vec4 uRegT; uniform vec4 uRegB;
uniform vec4 uArtT; uniform vec4 uArtB;
uniform vec4 uCut[NCUT]; uniform vec4 uCutP[NCUT]; uniform int uNCut;
uniform sampler2D uArt; uniform vec2 uArtSz; uniform float uPx; uniform float uWrap;
uniform vec4 uFin; uniform vec3 uBorderC; uniform vec3 uKeyV; uniform vec2 uHoloRM;
uniform vec4 uStk[NSTK]; uniform vec4 uStkR[NSTK]; uniform vec4 uStkF[NSTK]; uniform int uNStk;
uniform sampler2D uStkArt; uniform sampler2D uStkSdf; uniform vec2 uStkSz; uniform float uStkRange;
varying vec3 vLP;
float hh_sdRB(vec2 p, vec2 he, float r) { vec2 q = abs(p) - he + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float hh_rad(vec2 p) { return (p.x > 0.0 && p.y > 0.0) ? uRad.y : uRad.x; }
float hh_plan(vec2 p) { float r = max(1.0, hh_rad(p) - uSlab.w); return hh_sdRB(p, uSlab.xy * 0.5 - uSlab.w, r); }
vec2 hh_grad(vec2 p) {
  float r = max(1.0, hh_rad(p) - uSlab.w);
  vec2 q = abs(p) - (uSlab.xy * 0.5 - uSlab.w) + r;
  vec2 g = (q.x > 0.0 && q.y > 0.0) ? normalize(q) : (q.x > q.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  return g * vec2(p.x >= 0.0 ? 1.0 : -1.0, p.y >= 0.0 ? 1.0 : -1.0);
}
vec3 hh_hash3(vec2 p) { vec3 q = vec3(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)), dot(p, vec2(419.2, 371.9))); return fract(sin(q) * 43758.5453); }
// crisp pixels without shimmer: nearest inside a texel, a one-screen-pixel blend at its border (fw = texels per pixel)
vec4 hh_pix(sampler2D t, vec2 ap, vec2 fw, vec2 sz) { vec2 seam = floor(ap + 0.5); vec2 uv = seam + clamp((ap - seam) / max(fw, vec2(1e-4)), -0.5, 0.5); return textureLod(t, uv / sz, 0.0); }
`;

const MAIN = /* glsl */ `
  // ---- the shell unfolded (mm): which face, how far past its flat part, where that lands flat ----
  float hh_top = step(uSlab.z * 0.5, vLP.y);
  float hh_h = uSlab.z, hh_b = uSlab.w;
  float hh_yy = mix(hh_h - vLP.y, vLP.y, hh_top);
  float hh_s = hh_plan(vLP.xz);
  vec2 hh_n = hh_grad(vLP.xz);
  float hh_sp = max(hh_s, 0.0);
  float hh_beyond = hh_yy >= hh_h - 0.02 ? hh_s
    : (hh_yy >= hh_h - hh_b ? hh_b * atan(hh_sp, max(hh_yy - (hh_h - hh_b), 0.0)) : hh_b * 1.5707963 + (hh_h - hh_b - hh_yy));
  vec2 hh_U = vLP.xz + hh_n * (max(hh_beyond, 0.0) - hh_sp);
  vec4 hh_reg = mix(uRegB, uRegT, hh_top);
  vec4 hh_A = mix(uArtB, uArtT, hh_top);
  float hh_face = 1.0 - hh_top;
  vec2 hh_fwU = fwidth(hh_U);
  // ---- the wrap: its reach over the edges minus the cut-outs (≤ 0 = vinyl) ----
  float hh_outer = hh_beyond - hh_reg.y;
  float hh_sv = hh_outer;
  for (int i = 0; i < NCUT; i++) {
    if (i >= uNCut) break;
    vec4 cp = uCutP[i];
    if (abs(cp.y - hh_face) > 0.5) continue;
    vec2 p = hh_U - uCut[i].xy;
    p = vec2(cp.z * p.x + cp.w * p.y, -cp.w * p.x + cp.z * p.y);
    hh_sv = max(hh_sv, -hh_sdRB(p, uCut[i].zw, cp.x));
  }
  float hh_fs = max(fwidth(hh_sv), 1e-4);
  float hh_cov = (1.0 - smoothstep(-hh_fs, hh_fs, hh_sv)) * hh_reg.x * uWrap;
  vec2 hh_ap = vec2(hh_A.x * hh_U.x, hh_A.y * hh_U.y) / uPx + hh_A.zw;
  vec3 hh_art = hh_pix(uArt, hh_ap, hh_fwU / uPx, uArtSz).rgb;
  hh_art *= 0.976 + 0.048 * hh_hash3(floor(hh_U * 10.0)).x; // the print's grain (only a close look shows it)
  float hh_key = hh_reg.w * smoothstep(-0.62 - hh_fs, -0.62 + hh_fs, hh_outer); // a printed keyline along the outer edge
  vec3 hh_vin = mix(hh_art, uBorderC, hh_key);
  float hh_core = smoothstep(-0.07 - hh_fs, -0.07 + hh_fs, hh_sv) * clamp(0.07 / hh_fs, 0.0, 1.0); // the film's white core at the cut
  hh_vin = mix(hh_vin, vec3(0.80, 0.79, 0.77), hh_core * 0.4);
  float hh_wsh = (1.0 - hh_cov) * hh_reg.x * uWrap * exp(-max(hh_sv, 0.0) / 0.16) * 0.38; // a hair of shadow at the cut
  vec3 hh_col = mix(diffuseColor.rgb * (1.0 - hh_wsh), hh_vin, hh_cov);
  float hh_edge = hh_cov * (1.0 - smoothstep(0.0, 0.16, -hh_sv)) * clamp(0.16 / hh_fs, 0.0, 1.0);
  // ---- the stickers, in the order they were stuck on ----
  float hh_ao = hh_wsh, hh_scov = 0.0, hh_holo = 0.0, hh_holoW = 0.0, hh_glit = 0.0, hh_ssd = 9.0, hh_sfs = 1.0;
  vec3 hh_glitC = vec3(1.0);
  for (int i = 0; i < NSTK; i++) {
    if (i >= uNStk) break;
    vec4 F = uStkF[i];
    if (abs(F.x - hh_face) > 0.5) continue;
    vec4 P = uStk[i]; vec4 R = uStkR[i];
    vec2 d = (hh_U - P.xy) * sign(hh_A.xy); // in the face's reading orientation (a back face is seen mirrored)
    vec2 l = vec2(P.z * d.x + P.w * d.y, -P.w * d.x + P.z * d.y) / F.z;
    vec2 sp = l + R.zw * 0.5;
    if (sp.x < 0.0 || sp.y < 0.0 || sp.x > R.z || sp.y > R.w) continue;
    float sd = (textureLod(uStkSdf, (R.xy + sp) / uStkSz, 0.0).r - 0.5) * 2.0 * uStkRange * F.z;
    vec2 fwl = vec2(abs(P.z) * hh_fwU.x + abs(P.w) * hh_fwU.y, abs(P.w) * hh_fwU.x + abs(P.z) * hh_fwU.y) / F.z;
    float fsd = max(length(hh_fwU) * 0.7, 1e-4);
    float cov = 1.0 - smoothstep(-fsd, fsd, sd);
    float ghost = step(0.5, F.w) * step(F.w, 2.5);
    float sh = (exp(-max(sd, 0.0) / 0.32) * 0.5 + exp(-max(sd, 0.0) / 0.07) * 0.25) * (1.0 - cov) * (1.0 - ghost * 0.6); // contact shadow: the film stands 0.1 mm proud
    vec4 a = hh_pix(uStkArt, R.xy + sp, fwl, uStkSz);
    vec3 c = mix(vec3(0.955, 0.948, 0.93), a.rgb, a.a);
    if (F.w > 1.5 && F.w < 2.5) c = mix(c, vec3(0.86, 0.18, 0.16), 0.55); // ghost over a button: refused
    if (F.w > 2.5) { float ring = smoothstep(0.9, 0.55, abs(sd + 0.35)); c = mix(c, vec3(1.0, 0.86, 0.45), ring * 0.0); }
    c *= 1.0 - 0.1 * (1.0 - smoothstep(0.0, 0.14, -sd)); // its rounded cut edge falls away from the light a little
    float k = cov * (ghost > 0.5 ? 0.82 : 1.0);
    hh_col = mix(hh_col * (1.0 - sh), c, k);
    hh_ao = mix(1.0 - (1.0 - hh_ao) * (1.0 - sh), 0.0, k);
    hh_scov = max(hh_scov * (1.0 - k), k);
    float isH = step(0.5, F.y) * step(F.y, 1.5), isG = step(1.5, F.y);
    float foil = mix(1.0, 0.25 + 0.75 * smoothstep(0.25, 0.9, dot(c, vec3(0.299, 0.587, 0.114))), a.a); // the border is bare foil; ink lets less through
    hh_holo = mix(hh_holo, isH, k); hh_holoW = mix(hh_holoW, foil, k);
    hh_glit = mix(hh_glit, isG, k); hh_glitC = mix(hh_glitC, mix(vec3(1.0), c, a.a), k);
    if (cov > 0.02) { hh_ssd = sd; hh_sfs = fsd; }
  }
  float hh_sedge = hh_scov * (1.0 - smoothstep(0.0, 0.38, -hh_ssd)) * clamp(0.3 / hh_sfs, 0.0, 1.0); // a laminated sticker's rounded edge
  diffuseColor.rgb = hh_col;
  vec3 hh_gsv = vec3(0.0), hh_gwv = vec3(0.0);
`;

const ROUGH = /* glsl */ `
  roughnessFactor = mix(roughnessFactor, uFin.x, hh_cov);
  roughnessFactor = mix(roughnessFactor, mix(0.26, uHoloRM.x, hh_holo), hh_scov);
`;
const METAL = /* glsl */ `
  metalnessFactor = mix(metalnessFactor, 0.0, max(hh_cov, hh_scov));
  metalnessFactor = mix(metalnessFactor, uHoloRM.y, hh_holo * hh_holoW * hh_scov);
`;
const NORMAL = /* glsl */ `
  normal = normalize(mix(normal, nonPerturbedNormal, max(hh_cov, hh_scov))); // vinyl is smooth: the moulded grain goes
  {
    vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
    vec3 R1 = cross(dpy, normal), R2 = cross(normal, dpx);
    float det = dot(dpx, R1); det = abs(det) < 1e-12 ? 1e-12 : det;
    vec3 gw = (dFdx(hh_sv) * R1 + dFdy(hh_sv) * R2) / det;
    vec3 gs = (dFdx(hh_ssd) * R1 + dFdy(hh_ssd) * R2) / det;
    if (length(gw) > 1e-6) hh_gwv = normalize(gw);
    if (length(gs) > 1e-6) hh_gsv = normalize(gs);
    if (length(gw) > 1e-6) normal = normalize(normal + normalize(gw) * 0.85 * hh_edge * (1.0 - hh_scov));
    if (length(gs) > 1e-6) normal = normalize(normal + normalize(gs) * 0.9 * hh_sedge);
  }
`;
const LIGHTS = /* glsl */ `
  #ifdef USE_CLEARCOAT
  material.clearcoat = mix(material.clearcoat, uFin.y, hh_cov);
  material.clearcoatRoughness = mix(material.clearcoatRoughness, uFin.z, hh_cov);
  material.clearcoat = mix(material.clearcoat, 1.0, hh_scov);
  material.clearcoatRoughness = mix(material.clearcoatRoughness, 0.035, hh_scov);
  #endif
  #ifdef USE_SHEEN
  material.sheenColor *= 1.0 - max(hh_cov, hh_scov);
  #endif
`;
const OPAQUE_BASE = /* glsl */ `
  outgoingLight *= 1.0 - hh_ao * 0.75; // the contact shadows hold back reflections too, not only the colour
  {
    vec3 V = normalize(vViewPosition);
    float ndv = clamp(dot(normal, V), 0.0, 1.0);
    // the film's thickness: its cut edge catches the light on one side and turns away from it on the other
    vec3 Hk = normalize(uKeyV + V);
    float fs = dot(hh_gsv, Hk), fw = dot(hh_gwv, Hk);
    outgoingLight += vec3(0.42) * hh_sedge * pow(max(fs, 0.0), 1.2) + vec3(0.12) * hh_edge * (1.0 - hh_scov) * pow(max(fw, 0.0), 1.5);
    outgoingLight *= 1.0 - 0.32 * hh_sedge * max(-fs, 0.0) - 0.2 * hh_edge * (1.0 - hh_scov) * max(-fw, 0.0);
    __FINISHES__
  }
`;

/** The finishes' fragment code (from the pack) in its place; nothing without them. */
export function opaqueChunk(finishes = null) {
  const holo = finishes?.holo?.glsl ? `if (hh_holo > 0.001) { // holographic film (souldew+ pack)\n${finishes.holo.glsl}\n    }` : '';
  const glit = finishes?.glitter?.glsl ? `if (hh_glit > 0.001) { // glitter (souldew+ pack)\n${finishes.glitter.glsl}\n    }` : '';
  return OPAQUE_BASE.replace('__FINISHES__', `${holo}\n    ${glit}`);
}

/**
 * Adds the wrap + stickers to a shell material. spec = { slab: {w, d, h, b, r, rBR}, top: region|null, bottom: region|null }
 * region = { L (mm the wrap reaches past the flat face), Ls (stickers), art: [sx, sy, cx, cy], border: 0|1, cuts: [cut] }
 * cut = { c: [x, y], he: [hx, hy], r, a } in the region's unfolded mm. `shared` = uniforms shared by every surface.
 * finishes = the pack's checked sticker finishes (looks.mjs cleanLooks › finishes) or null (vinyl only).
 */
export function withSurface(THREE, mat, spec, shared, finishes = null) {
  const V4 = (a = 0, b = 0, c = 0, d = 0) => new THREE.Vector4(a, b, c, d);
  const reg = (r) => (r ? V4(1, r.L, r.Ls, r.border ? 1 : 0) : V4(0, 0, 0, 0));
  const cuts = [], cutsP = [];
  for (const [face, r] of [[0, spec.top], [1, spec.bottom]]) {
    for (const c of r?.cuts || []) {
      if (cuts.length >= NCUT) break;
      cuts.push(V4(c.c[0], c.c[1], c.he[0], c.he[1]));
      cutsP.push(V4(c.r || 0, face, Math.cos(c.a || 0), Math.sin(c.a || 0)));
    }
  }
  while (cuts.length < NCUT) { cuts.push(V4()); cutsP.push(V4(0, 9, 1, 0)); }
  const { slab } = spec;
  const U = {
    uSlab: { value: V4(slab.w, slab.d, slab.h, slab.b) }, uRad: { value: new THREE.Vector2(slab.r, slab.rBR ?? slab.r) },
    uRegT: { value: reg(spec.top) }, uRegB: { value: reg(spec.bottom) },
    uArtT: { value: V4(...(spec.top?.art || [1, 1, 0, 0])) }, uArtB: { value: V4(...(spec.bottom?.art || [1, 1, 0, 0])) },
    uCut: { value: cuts }, uCutP: { value: cutsP }, uNCut: { value: Math.min(NCUT, (spec.top?.cuts?.length || 0) + (spec.bottom?.cuts?.length || 0)) },
    uStk: { value: Array.from({ length: NSTK }, () => V4()) }, uStkR: { value: Array.from({ length: NSTK }, () => V4()) },
    uStkF: { value: Array.from({ length: NSTK }, () => V4(9)) }, uNStk: { value: 0 },
    uHoloRM: { value: new THREE.Vector2(finishes?.holo?.roughness ?? 0.26, finishes?.holo?.metalness ?? 0) },
    ...shared,
  };
  const opaque = opaqueChunk(finishes);
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    Object.assign(sh.uniforms, U);
    sh.vertexShader = `varying vec3 vLP;\n${sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLP = transformed;')}`;
    sh.fragmentShader = `${PARS}\n${sh.fragmentShader}`
      .replace('#include <map_fragment>', `#include <map_fragment>\n${MAIN}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${ROUGH}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${METAL}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${NORMAL}`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${LIGHTS}`)
      .replace('#include <transmission_fragment>', THREE.ShaderChunk.transmission_fragment.replace('material.transmission = transmission;', 'material.transmission = transmission * (1.0 - hh_scov);'))
      .replace('#include <opaque_fragment>', `${opaque}\n#include <opaque_fragment>`);
  };
  const key = mat.customProgramCacheKey?.() || '';
  const fin = `${finishes?.holo?.glsl?.length || 0}.${finishes?.glitter?.glsl?.length || 0}`;
  mat.customProgramCacheKey = () => `${key}+hh${fin}`;
  mat.userData.hh = { U, spec };
  return mat;
}
