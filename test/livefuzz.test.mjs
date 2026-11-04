// Property tests for the live RAM readers: whatever the game's memory holds (title screen noise, a heap that
// isn't the party at all, a struct half rewritten), every reader returns a result instead of throwing, and a
// party it does report is plausible – that is what keeps garbage from turning into catches and deaths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findEntry, readLiveParty, readLiveBattle, withBattleHp, LiveTables, regionsFor, regionReader } from '../shared/live/parse.mjs';
import { encryptPK4 } from '../shared/gen4save.mjs';

const L = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url)));
const T = new LiveTables({
  charsetGen1: L('charset_gen1.json'), charsetGen2: L('charset_gen2.json'), charsetGen3: L('charset_gen3.json'),
  gen1Index: L('gen1_index_to_dex.json'), gen3Index: L('gen3_index_to_dex.json'), gen4: L('gen4.json'),
});
const TABLE = L('addresses.json');

/** Deterministic PRNG (mulberry32), so a failure can be replayed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random memory: every 4 KB page gets its own noise on first touch. `bias` makes some pages mostly zero or
 * mostly 0xFF (cleared WRAM, erased flash) and plants small values where readers look for counts.
 */
function noise(seed) {
  const r = rng(seed);
  const pages = new Map();
  const page = (n) => {
    let p = pages.get(n);
    if (p) return p;
    p = new Uint8Array(4096);
    const kind = r();
    for (let i = 0; i < p.length; i++) {
      const x = r();
      p[i] = kind < 0.2 ? 0 : kind < 0.3 ? 0xff : kind < 0.6 ? (x < 0.7 ? Math.floor(x * 10) : Math.floor(r() * 256)) : Math.floor(x * 256);
    }
    pages.set(n, p);
    return p;
  };
  return (addr, len) => {
    if (r() < 0.02) return null; // out of range / not located yet
    const out = new Uint8Array(len);
    for (let i = 0; i < len;) {
      const a = addr + i;
      const p = page(a >>> 12);
      const o = a & 4095;
      const n = Math.min(4096 - o, len - i);
      out.set(p.subarray(o, o + n), i);
      i += n;
    }
    return out;
  };
}

const plausible = (m, gen) => {
  assert.ok(Number.isInteger(m.species) && m.species >= 1 && m.species <= (gen <= 2 ? 251 : gen === 3 ? 386 : 649), `species ${m.species}`);
  assert.ok(m.level === null || (m.level >= 1 && m.level <= 100) || (gen >= 4 && m.isEgg), `level ${m.level}`);
  if (m.maxHp !== null) assert.ok(m.hp <= m.maxHp, `hp ${m.hp}/${m.maxHp}`);
  assert.equal(typeof m.key, 'string');
};

test('fuzz: every party and battle reader survives random RAM (all games)', () => {
  for (const entry of TABLE.games) {
    const ds = entry.platform === 'nds';
    const rounds = ds ? 6 : 150; // a DS read may scan 4 MB
    const kept = {};
    for (let i = 0; i < rounds; i++) {
      const read = noise(i * 7919 + entry.id.length);
      // a fresh session (first read, DS full scan) and one that carries caches over from earlier garbage
      const state = i % 2 ? kept : {};
      let res;
      assert.doesNotThrow(() => (res = readLiveParty(entry, read, T, state)), `${entry.id} round ${i}`);
      for (const m of res?.party || []) plausible(m, entry.gen);
      let fight;
      assert.doesNotThrow(() => (fight = readLiveBattle(entry, read, T, state, res?.party || null)), `${entry.id} battle ${i}`);
      assert.doesNotThrow(() => withBattleHp(res?.party || null, fight));
      if (fight) assert.ok(['wild', 'trainer'].includes(fight.kind));
    }
  }
});

test('fuzz: the mGBA bridge path (streamed regions) survives garbage and short frames', () => {
  const r = rng(42);
  for (const entry of TABLE.games.filter((g) => g.gen <= 3)) {
    const regions = regionsFor(entry);
    assert.ok(regions.length, entry.id);
    for (let i = 0; i < 100; i++) {
      // a frame may be cut short or missing a region (the script only just connected)
      const frame = regions.map((g) => {
        const len = r() < 0.1 ? Math.floor(r() * g.len) : g.len;
        let hex = '';
        for (let k = 0; k < len; k++) hex += Math.floor(r() < 0.5 ? r() * 8 : r() * 256).toString(16).padStart(2, '0');
        return { addr: g.addr, len: g.len, hex: r() < 0.05 ? '' : hex };
      });
      let res;
      assert.doesNotThrow(() => (res = readLiveParty(entry, regionReader(frame), T, {})), `${entry.id} frame ${i}`);
      for (const m of res?.party || []) plausible(m, entry.gen);
    }
  }
});

test('fuzz: a valid Gen 2 party with single bytes flipped is either rejected or still plausible', () => {
  const e = findEntry(TABLE, { platform: 'gbc', title: 'POKEMON_SLV' });
  const r = rng(7);
  const base = new Map();
  base.set(0xda22, [2, 152, 16, 0xff]); // count, species list, terminator
  const mon = (species, level, hp, maxHp) => {
    const d = new Uint8Array(48);
    d[0] = species;
    d[0x06] = 0x12; d[0x07] = 0x34;
    d[0x15] = 0xab; d[0x16] = 0xcd;
    d[0x1f] = level;
    d[0x22] = 0; d[0x23] = hp;
    d[0x24] = 0; d[0x25] = maxHp;
    return [...d];
  };
  base.set(0xda2a, [...mon(152, 5, 20, 20), ...mon(16, 3, 12, 14)]);
  for (let i = 0; i < 500; i++) {
    const mem = new Uint8Array(0x10000);
    for (const [a, b] of base) mem.set(b, a);
    const at = 0xda22 + Math.floor(r() * (8 + 96));
    mem[at] = Math.floor(r() * 256);
    const res = readLiveParty(e, (a, n) => mem.slice(a, a + n), T);
    for (const m of res?.party || []) plausible(m, 2);
  }
});

test('fuzz: Gen 4 – random battle-stats bytes under a valid checksum never come out as a level outside 1–100', () => {
  // the checksum covers only the 128-byte box block: whatever the 100 bytes after it hold (a read while the game
  // has them decrypted, a struct being written), a reported mon has a sane level and HP <= max HP
  const e = findEntry(TABLE, { platform: 'nds', code: 'IPKE' });
  const r = rng(99);
  const base = 0x0227c218;
  let reported = 0;
  for (let i = 0; i < 3000; i++) {
    const plain = new Uint8Array(236);
    const dv = new DataView(plain.buffer);
    dv.setUint32(0, Math.floor(r() * 2 ** 32), true);
    dv.setUint16(0x08, 1 + Math.floor(r() * 493), true);
    dv.setUint16(0x46, 177, true);
    const enc = encryptPK4(plain);
    for (let k = 136; k < 236; k++) enc[k] = r() < 0.3 ? 0 : Math.floor(r() * 256);
    const mem = new Map([[0x02111880, [0x18, 0xc2, 0x27, 0x02]], [base + 0xa0, [6, 0, 0, 0, 1, 0, 0, 0, ...enc]]]);
    const read = (a, n) => {
      if (n > 0x1000) return null; // no full-RAM scan: the pointer path is what is tested here
      const out = new Uint8Array(n);
      for (const [at, bytes] of mem) for (let j = 0; j < n; j++) if (a + j >= at && a + j < at + bytes.length) out[j] = bytes[a + j - at];
      return out;
    };
    const res = readLiveParty(e, read, T, {});
    for (const m of res?.party || []) {
      reported++;
      plausible(m, 4);
    }
  }
  assert.ok(reported < 30, `garbage passed as a mon ${reported}× in 3000`);
});
