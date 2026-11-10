// Game Boy ROM hacks built from the pret disassemblies (Crystal Legacy, Polished Crystal, Shin Pokémon …) may add
// variables to WRAM and so move everything after them: Crystal Legacy keeps the whole WRAMX bank 11 bytes further on
// (the party at 0xDCE2 instead of 0xDCD7). Reading such a hack with the retail addresses finds nothing – or the wrong
// bytes. Where a variable lives can be read from the ROM itself: the game's code loads it by its address
// (ld a,[nn] / ld [nn],a / ld hl,nn …), and a hack's code names the moved address as often as the retail game names the
// original one. So the shift is the one that the code's references agree on for the most-used variables (the party
// count, the battle mode, the current map), and each address of the memory table follows it where the code agrees.

// opcodes followed by a 16-bit address: ld a,[nn] · ld [nn],a · ld hl,nn · ld de,nn · ld bc,nn
const OPS = new Set([0xfa, 0xea, 0x21, 0x11, 0x01]);
const hex = (v) => (typeof v === 'string' ? parseInt(v, 16) : Number(v));
const isWram = (a) => a >= 0xc000 && a < 0xe000;

/** How often the code names each WRAM address: Uint16Array(0x2000) indexed by addr − 0xC000. */
export function wramRefs(rom) {
  const n = new Uint16Array(0x2000);
  for (let i = 0; i + 2 < rom.length; i++) {
    if (!OPS.has(rom[i])) continue;
    const a = rom[i + 1] | (rom[i + 2] << 8);
    if (isWram(a) && n[a - 0xc000] < 0xffff) n[a - 0xc000]++;
  }
  return n;
}

/** Every WRAM address field of a memory-table entry (and its maps.json entry): [path, address]. */
function addressFields(obj, path = [], out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (k === 'match' || k === 'memory' || k === 'sources' || k === 'source') continue;
    if (typeof v === 'string' && /^0x[0-9a-f]{4}$/i.test(v) && /addr$/i.test(k) && isWram(hex(v))) out.push([[...path, k], hex(v)]);
    else if (v && typeof v === 'object' && !Array.isArray(v)) addressFields(v, [...path, k], out);
  }
  return out;
}

/**
 * The WRAM shift of a GB/GBC ROM against a memory-table entry: { delta, moved: { '0xDCD7': '0xDCE2', … } } – or null
 * when the code uses the retail addresses (or doesn't say). `entry` = addresses.json entry, `mapEntry` = its maps.json
 * entry (the current map's addresses), both optional parts of one picture. Never throws.
 */
export function gbWramShift(rom, entry, mapEntry = null, { range = 0x80 } = {}) {
  try {
    if (!rom || !entry || entry.gen > 2) return null;
    const refs = wramRefs(rom);
    const count = (a) => (isWram(a) ? refs[a - 0xc000] : 0);
    // the anchors: variables every Pokémon game reads in hundreds of places
    const anchors = [entry.partyCountAddr, entry.inBattle?.addr, mapEntry?.mapGroupAddr, mapEntry?.curMapAddr].filter(Boolean).map(hex);
    if (!anchors.length) return null;
    // a shift counts when it fits every anchor at once (a single busy address nearby proves nothing): the score is the
    // least-named anchor at that shift
    const score = (d) => Math.min(...anchors.map((a) => count(a + d)));
    let best = { delta: 0, score: score(0) };
    for (let d = -range; d <= range; d++) {
      const sc = score(d);
      if (d && sc > best.score && anchors.every((a) => count(a + d) > count(a))) best = { delta: d, score: sc };
    }
    // clear evidence only: every anchor is named often at the new place and far more often than at the retail one
    if (!best.delta || best.score < 8 || best.score < score(0) * 4) return null;
    const d = best.delta;
    const fields = [...addressFields(entry), ...addressFields(mapEntry || {})];
    const moved = {};
    // an anchor's 4 KB bank moved: its other variables are taken along (their neighbours may be busier, so counts
    // alone would mislead) – unless the code never names the new place but often the old one. Elsewhere only clear
    // evidence moves an address.
    const banks = new Set(anchors.map((a) => a >> 12));
    for (const [, a] of fields) {
      const here = count(a);
      const there = count(a + d);
      const move = banks.has(a >> 12) ? !(here >= 5 && there === 0) : there >= 5 && there > 2 * here;
      if (move) moved[`0x${a.toString(16).toUpperCase()}`] = `0x${(a + d).toString(16).toUpperCase()}`;
    }
    return { delta: d, moved };
  } catch {
    return null;
  }
}

/** A copy of a memory-table (or maps.json) entry with the moved addresses of gbWramShift() put in. */
export function shiftEntry(entry, shift) {
  if (!entry || !shift?.moved) return entry;
  const walk = (o) => {
    if (Array.isArray(o)) return o.map(walk);
    if (!o || typeof o !== 'object') return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      const key = typeof v === 'string' ? `0x${v.replace(/^0x/i, '').toUpperCase()}` : null;
      out[k] = key && /addr$/i.test(k) && shift.moved[key] ? shift.moved[key] : walk(v);
    }
    return out;
  };
  return walk(entry);
}
