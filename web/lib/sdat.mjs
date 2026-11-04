// The DS's own music data: reads the sound archive (SDAT) out of a DS ROM and turns one song into a "pack" the
// synthesizer (sdat-synth.mjs) can play – the sequence, the instruments it may use and their samples, decoded.
// That lets "Musik läuft weiter" play the song at normal speed while the emulator fast-forwards, even when it was
// never heard at 1× (turboaudio.mjs). Everything stays on this computer; nothing here is sent anywhere.
//
// Formats (as the Nitro SDK writes them):
//   NitroFS: FNT at header 0x40, FAT at 0x48 – the ROM's file tree.
//   SDAT:    SYMB / INFO / FAT / FILE blocks; INFO lists SEQ, BANK and WAVEARC records pointing at FAT files.
//   SSEQ:    the sequence: one byte stream of MIDI-like commands, up to 16 tracks.
//   SBNK:    instruments per program number: sample, PSG square, noise, drum set (one per key) or key split.
//   SWAR:    an archive of SWAV samples: PCM8, PCM16 or IMA-ADPCM, with an optional loop.

const u8 = (d, o) => d[o];
const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const s16 = (d, o) => (u16(d, o) << 16) >> 16;
const tag = (d, o) => String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);

/** Every file of a DS ROM's NitroFS: [{ path, start, end }]. Empty for anything that isn't one. */
export function nitroFiles(rom) {
  const d = rom instanceof Uint8Array ? rom : new Uint8Array(rom);
  if (d.length < 0x200) return [];
  const fnt = u32(d, 0x40);
  const fat = u32(d, 0x48);
  const fatSize = u32(d, 0x4c);
  if (!fnt || !fat || fnt >= d.length || fat + fatSize > d.length) return [];
  const out = [];
  const seen = new Set();
  const walk = (id, prefix, depth) => {
    if (depth > 32 || seen.has(id)) return;
    seen.add(id);
    const base = fnt + (id & 0xfff) * 8;
    if (base + 8 > d.length) return;
    let p = fnt + u32(d, base);
    let fid = u16(d, base + 4);
    while (p < d.length) {
      const b = d[p++];
      if (!b) break;
      const len = b & 0x7f;
      let name = '';
      for (let i = 0; i < len; i++) name += String.fromCharCode(d[p + i]);
      p += len;
      if (b & 0x80) {
        const sub = u16(d, p);
        p += 2;
        walk(sub, `${prefix}${name}/`, depth + 1);
      } else {
        if (fat + fid * 8 + 8 <= fat + fatSize) {
          const start = u32(d, fat + fid * 8);
          const end = u32(d, fat + fid * 8 + 4);
          if (end >= start && end <= d.length) out.push({ path: prefix + name, start, end });
        }
        fid++;
      }
    }
  };
  walk(0xf000, '', 0);
  return out;
}

/** Parses an SDAT (Uint8Array starting at 'SDAT'). Throws on anything that isn't one. */
export function parseSdat(d) {
  if (tag(d, 0) !== 'SDAT') throw new Error('not an SDAT');
  const infoOff = u32(d, 0x18);
  const fatOff = u32(d, 0x20);
  if (tag(d, infoOff) !== 'INFO' || tag(d, fatOff) !== 'FAT ') throw new Error('SDAT blocks missing');
  const files = [];
  const nFiles = u32(d, fatOff + 8);
  for (let i = 0; i < nFiles; i++) {
    const o = fatOff + 12 + i * 16;
    files.push({ off: u32(d, o), size: u32(d, o + 4) });
  }
  const records = (k) => {
    const at = infoOff + u32(d, infoOff + 8 + k * 4);
    const n = u32(d, at);
    const list = [];
    for (let i = 0; i < n; i++) {
      const o = u32(d, at + 4 + i * 4);
      list.push(o ? infoOff + o : 0);
    }
    return list;
  };
  const seqs = records(0).map((o) => (o ? { file: u16(d, o), bank: u16(d, o + 4), vol: u8(d, o + 6), cpr: u8(d, o + 7), ppr: u8(d, o + 8), player: u8(d, o + 9) } : null));
  const banks = records(2).map((o) => (o ? { file: u16(d, o), wa: [0, 1, 2, 3].map((i) => u16(d, o + 4 + i * 2)) } : null));
  const waveArcs = records(3).map((o) => (o ? { file: u16(d, o) } : null));
  return { d, files, seqs, banks, waveArcs };
}

/** The ROM's main sound archive (the one with the most sequences), or null. */
export function findSdat(rom) {
  const d = rom instanceof Uint8Array ? rom : new Uint8Array(rom);
  let best = null;
  for (const f of nitroFiles(d)) {
    if (f.end - f.start < 0x40 || tag(d, f.start) !== 'SDAT') continue;
    try {
      const s = parseSdat(d.subarray(f.start, f.end));
      if (!best || s.seqs.length > best.seqs.length) best = { ...s, path: f.path };
    } catch {
      // a broken archive: try the next one
    }
  }
  return best;
}

const fileOf = (sdat, id) => {
  const f = sdat.files[id];
  return f && f.size ? sdat.d.subarray(f.off, f.off + f.size) : null;
};

// IMA-ADPCM as the DS decodes it
const ADPCM_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];
const ADPCM_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];

/** One SWAV (its 12-byte info at `o` in `d`) → { data: Float32Array, rate, loopStart, loop }. */
export function decodeSwav(d, o) {
  const type = u8(d, o);
  const loop = !!u8(d, o + 1);
  const rate = u16(d, o + 2);
  const loopWords = u16(d, o + 6);
  const restWords = u32(d, o + 8);
  const at = o + 12;
  const words = loopWords + restWords;
  if (type === 0) {
    const n = Math.min(words * 4, d.length - at);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = ((d[at + i] << 24) >> 24) / 128;
    return { data: out, rate, loopStart: loopWords * 4, loop };
  }
  if (type === 1) {
    const n = Math.min(words * 2, (d.length - at) >> 1);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = s16(d, at + i * 2) / 32768;
    return { data: out, rate, loopStart: loopWords * 2, loop };
  }
  // IMA-ADPCM: one header word (first sample, step index), then two samples per byte, low nibble first
  let pred = s16(d, at);
  let index = Math.min(88, u8(d, at + 2));
  const bytes = Math.max(0, Math.min((words - 1) * 4, d.length - at - 4));
  const out = new Float32Array(bytes * 2);
  for (let i = 0; i < bytes; i++) {
    const b = d[at + 4 + i];
    for (let h = 0; h < 2; h++) {
      const nib = h ? b >> 4 : b & 15;
      const step = ADPCM_STEP[index];
      let diff = step >> 3;
      if (nib & 1) diff += step >> 2;
      if (nib & 2) diff += step >> 1;
      if (nib & 4) diff += step;
      pred = nib & 8 ? Math.max(-0x7fff, pred - diff) : Math.min(0x7fff, pred + diff);
      index = Math.min(88, Math.max(0, index + ADPCM_INDEX[nib & 7]));
      out[i * 2 + h] = pred / 32768;
    }
  }
  return { data: out, rate, loopStart: Math.max(0, (loopWords - 1) * 8), loop };
}

/** The SWAV at `index` of a SWAR file, or null. */
function swavOf(swar, index) {
  if (!swar || tag(swar, 0) !== 'SWAR') return null;
  const n = u32(swar, 0x38);
  if (index >= n) return null;
  const o = u32(swar, 0x3c + index * 4);
  return o && o + 12 <= swar.length ? decodeSwav(swar, o) : null;
}

const KINDS = { 1: 'pcm', 2: 'psg', 3: 'noise', 4: 'pcm', 5: 'pcm' };

/** One note definition (10 bytes at `o`) of the given record type. */
function noteDef(d, o, type, lo, hi) {
  const kind = KINDS[type];
  if (!kind) return null;
  return { kind, lo, hi, swav: u16(d, o), swar: u16(d, o + 2), base: u8(d, o + 4), a: u8(d, o + 5), dc: u8(d, o + 6), s: u8(d, o + 7), r: u8(d, o + 8), pan: u8(d, o + 9) };
}

/** An SBNK file → per program number the list of key regions (null for an empty program). */
export function parseBank(d) {
  if (!d || tag(d, 0) !== 'SBNK') throw new Error('not an SBNK');
  const n = u32(d, 0x38);
  const progs = [];
  for (let i = 0; i < n; i++) {
    const rec = 0x3c + i * 4;
    const type = u8(d, rec);
    const o = u16(d, rec + 1);
    if (!type || !o || o >= d.length) {
      progs.push(null);
      continue;
    }
    if (type < 16) {
      const r = noteDef(d, o, type, 0, 127);
      progs.push(r ? [r] : null);
    } else if (type === 16) {
      // drum set: one definition per key from lo to hi
      const lo = u8(d, o);
      const hi = u8(d, o + 1);
      const regions = [];
      for (let k = lo, p = o + 2; k <= hi && p + 12 <= d.length; k++, p += 12) {
        const r = noteDef(d, p + 2, u16(d, p), k, k);
        if (r) regions.push(r);
      }
      progs.push(regions.length ? regions : null);
    } else if (type === 17) {
      // key split: up to 8 upper keys, then one definition per used region
      const regions = [];
      let lo = 0;
      let p = o + 8;
      for (let j = 0; j < 8; j++) {
        const hi = u8(d, o + j);
        if (!hi) break;
        if (p + 12 > d.length) break;
        const r = noteDef(d, p + 2, u16(d, p), lo, hi);
        if (r) regions.push(r);
        lo = hi + 1;
        p += 12;
      }
      progs.push(regions.length ? regions : null);
    } else progs.push(null);
  }
  return progs;
}

/** The SSEQ's command bytes (from its data start). */
export function sequenceData(d) {
  if (!d || tag(d, 0) !== 'SSEQ') throw new Error('not an SSEQ');
  const start = u32(d, 0x18);
  return d.subarray(start);
}

/**
 * Everything the synthesizer needs for sequence `id`: { id, vol, seq, programs, waves } – programs index into
 * `waves` (decoded once per sample used). `cache` (a Map) keeps decoded samples between calls. null when the
 * archive has no such sequence or it can't be read.
 */
export function songPack(sdat, id, cache = new Map()) {
  const info = sdat.seqs[id];
  if (!info) return null;
  const seq = sequenceData(fileOf(sdat, info.file));
  const bank = sdat.banks[info.bank];
  if (!bank) return null;
  const progs = parseBank(fileOf(sdat, bank.file));
  const waves = [];
  const waveIndex = new Map();
  const programs = progs.map((regions) => regions && regions.map((r) => {
    const out = { kind: r.kind, lo: r.lo, hi: r.hi, base: r.base, a: r.a, d: r.dc, s: r.s, r: r.r, pan: r.pan };
    if (r.kind === 'psg') out.duty = r.swav & 7;
    if (r.kind !== 'pcm') return out;
    const arcId = bank.wa[r.swar];
    if (arcId == null || arcId === 0xffff || !sdat.waveArcs[arcId]) return null;
    const ck = `${arcId}:${r.swav}`;
    if (!waveIndex.has(ck)) {
      let w = cache.get(ck);
      if (w === undefined) {
        w = swavOf(fileOf(sdat, sdat.waveArcs[arcId].file), r.swav);
        cache.set(ck, w);
      }
      waveIndex.set(ck, w ? waves.push(w) - 1 : -1);
    }
    out.wave = waveIndex.get(ck);
    return out.wave >= 0 ? out : null;
  }).filter(Boolean));
  return { id, vol: info.vol, seq: seq.slice(), programs, waves };
}
