// Where the wild Pokémon are, read from a Gen 3 (GBA) ROM's own encounter tables – for the Pokémon Finder
// (web/views/finder.mjs). Nothing is hard-coded per game: the table is found by its shape, so a ROM hack that kept the
// standard layout (changed encounters, new Pokémon in the same slots) shows what it really holds, and a ROM where the
// table can't be found or doesn't hold together gives null (the Finder then hides that game), like the other live readers.
//
// The layout (pokeemerald src/data/wild_encounters.h, pokefirered, pokeruby – the same in all four games):
//   WildPokemonHeader { u8 mapGroup, mapNum; u16 pad; WildPokemonInfo *land, *water, *rockSmash, *fishing }   20 bytes
//   – the array ends with a header whose group and number are 0xFF –
//   WildPokemonInfo   { u8 encounterRate; (3 bytes pad) WildPokemon *wildPokemon }                          8 bytes
//   WildPokemon       { u8 minLevel, maxLevel; u16 species }                                                4 bytes
// with 12 slots on land, 5 on water and in rock smash, 10 when fishing. The ROM stores no percentages: which slot the
// game takes is decided in code, with the same chances in every retail game (shared/finder.mjs CHANCES). A hack that changed that code
// shows its slots with the retail chances – the Finder says so.
import { gen3MapSections } from './romloc.mjs';
// (the slot chances and the lookups over a result – shared with the page – are in shared/finder.mjs)

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Slots per table: land, water (surf), rock smash, fishing (old rod 0–1, good rod 2–4, super rod 5–9). */
export const SLOTS = { land: 12, surf: 5, rock: 5, fish: 10 };

/**
 * Finds and reads the wild encounter headers of a Gen 3 ROM.
 * `opts`: speciesCount (the ROM's species table size, romSpecies().count – a slot with a higher number can't be a Pokémon),
 * `names` (the ROM's place names by map section, romLocations().names – and `base` of them), `toDex(index)` → National Dex
 * number of an internal species index (0 = none known), `speciesNames(index)` → the ROM's own name.
 * → { offset, areas: [{ group, num, name, sec, rates: { land, surf, rock, fish } (the encounter rate bytes or absent),
 * slots: { land: [[min, max, dex, index]…], surf, rock, fish } }], names: { index: ROM name } } or null.
 * Never throws.
 */
export function gen3Wild(rom, opts = {}) {
  try {
    if (!rom || rom.length < 0x200 || rom[0xb2] !== 0x96 || rom[3] !== 0xea) return null;
    const count = opts.speciesCount;
    if (!(count > 250)) return null; // (no species table found: nothing to tell the slots' numbers from)
    const found = findHeaders(rom, count);
    if (!found) return null;
    const secs = gen3MapSections(rom);
    const toDex = opts.toDex || ((i) => i);
    const used = new Set();
    const areas = [];
    // (a map can have several tables the game picks between – Altering Cave, the Safari Zone: told apart as variants)
    const times = new Map();
    for (const h of found.headers) times.set(`${h.group}.${h.num}`, (times.get(`${h.group}.${h.num}`) || 0) + 1);
    const seen = new Map();
    for (const h of found.headers) {
      const key = `${h.group}.${h.num}`;
      const sec = secs?.get(key);
      const name = sec === undefined ? null : opts.names?.[sec] || null;
      const a = { group: h.group, num: h.num, sec: sec ?? null, name, rates: {}, slots: {} };
      if (times.get(key) > 1) {
        seen.set(key, (seen.get(key) || 0) + 1);
        Object.assign(a, { variant: seen.get(key), variants: times.get(key) });
      }
      for (const [m, info] of [['land', h.land], ['surf', h.water], ['rock', h.rock], ['fish', h.fish]]) {
        if (!info) continue;
        const mons = [];
        for (let k = 0; k < SLOTS[m]; k++) {
          const e = info.slots + k * 4;
          const i = u16(rom, e + 2);
          used.add(i);
          mons.push([rom[e], rom[e + 1], toDex(i) || 0, i]); // (arrays: a ROM's table is some 4,000 slots)
        }
        a.rates[m] = info.rate;
        a.slots[m] = mons;
      }
      areas.push(a);
    }
    const names = {};
    if (opts.speciesNames) for (const i of used) names[i] = opts.speciesNames(i) || '';
    return { offset: found.offset, areas, names };
  } catch {
    return null;
  }
}

/** A WildPokemonInfo pointer's target: { rate, slots (offset of its slot array) } when the slots are plausible, else null. */
function infoAt(rom, ptr, n, count, memo) {
  if (ptr === 0) return false; // (no table of this kind: fine)
  const key = ptr * 16 + n; // (the same struct read as 5 or 12 slots is another answer)
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let r = null;
  const o = ptr - 0x08000000;
  if (ptr >= 0x08000000 && o + 8 <= rom.length && (ptr & 3) === 0) {
    const sp = u32(rom, o + 4);
    const so = sp - 0x08000000;
    if (sp >= 0x08000000 && so + n * 4 <= rom.length && (sp & 1) === 0 && rom[o] > 0) {
      let ok = true;
      for (let k = 0; k < n && ok; k++) {
        const e = so + k * 4;
        const sp2 = u16(rom, e + 2);
        ok = rom[e] >= 1 && rom[e + 1] <= 100 && rom[e] <= rom[e + 1] && sp2 >= 1 && sp2 <= count;
      }
      if (ok) r = { rate: rom[o], slots: so };
    }
  }
  memo.set(key, r);
  return r;
}

/**
 * The longest run of consecutive 20-byte headers (every non-empty pointer leading to plausible slots) that ends in the 0xFF terminator. { offset, headers } or null.
 */
function findHeaders(rom, count) {
  const memo = new Map();
  const len = rom.length;
  const header = (o) => {
    if (o + 20 > len || rom[o + 2] !== 0 || rom[o + 3] !== 0 || rom[o] > 0x7f) return null;
    const ptrs = [u32(rom, o + 4), u32(rom, o + 8), u32(rom, o + 12), u32(rom, o + 16)];
    // (cheap tests first: a pointer is 0 or into the ROM)
    for (const p of ptrs) if (p !== 0 && (p >>> 24 !== 0x08 || (p & 3) !== 0)) return null;
    // (a map can have a header and no table at all – Emerald has two; but not the 0xFF terminator, nor zero padding)
    if (!ptrs.some(Boolean) && ((rom[o] === 0xff && rom[o + 1] === 0xff) || (rom[o] === 0 && rom[o + 1] === 0))) return null;
    const info = [infoAt(rom, ptrs[0], SLOTS.land, count, memo), infoAt(rom, ptrs[1], SLOTS.surf, count, memo), infoAt(rom, ptrs[2], SLOTS.rock, count, memo), infoAt(rom, ptrs[3], SLOTS.fish, count, memo)];
    if (info.some((x) => x === null)) return null;
    return { group: rom[o], num: rom[o + 1], land: info[0] || null, water: info[1] || null, rock: info[2] || null, fish: info[3] || null };
  };
  let best = null;
  for (let r = 0; r < 20; r += 4) {
    let run = [];
    let start = 0;
    for (let o = r; o + 20 <= len; o += 20) {
      const h = header(o);
      if (h) {
        if (!run.length) start = o;
        run.push(h);
        continue;
      }
      // the array's terminator: group and number 0xFF – the run before it is a table
      if (run.filter((x) => x.land || x.water || x.rock || x.fish).length >= 40 && rom[o] === 0xff && rom[o + 1] === 0xff && (!best || run.length > best.headers.length)) best = { offset: start, headers: run };
      run = [];
    }
  }
  if (!best) return null;
  return best;
}
