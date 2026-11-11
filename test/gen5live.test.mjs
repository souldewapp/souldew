// Black/White and Black 2/White 2 live tracking: status conditions (#5), badges and level caps (#13), place names of
// catches filed under a number (#14) and held item names (#15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { findEntry, readLiveParty, readLiveBattle, LiveTables, gen5Status } from '../shared/live/parse.mjs';
import { encryptPK4 } from '../shared/gen4save.mjs';
import { statusKey } from '../shared/overlay.mjs';
import { vanillaCapFor, gymCapsFamily } from '../shared/routes.mjs';
import { levelCapOf } from '../shared/streamapi.mjs';

// web/lib/*.mjs import browser paths (/shared/…): map them onto the project folder.
const ROOT = new URL('../', import.meta.url).href;
registerHooks({
  resolve(spec, ctx, next) {
    return spec.startsWith('/shared/') ? next(ROOT + spec.slice(1), ctx) : next(spec, ctx);
  },
});
const { RunDoc } = await import('../web/lib/doc.mjs');
const R = await import('../web/lib/run.mjs');
const { loadData, itemName } = await import('../web/lib/data.mjs');

const L = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url)));
const T = new LiveTables({
  charsetGen1: L('charset_gen1.json'), charsetGen2: L('charset_gen2.json'), charsetGen3: L('charset_gen3.json'),
  gen1Index: L('gen1_index_to_dex.json'), gen3Index: L('gen3_index_to_dex.json'), gen4: L('gen4.json'),
});
const TABLE = L('addresses.json');

function memory() {
  const blocks = [];
  return {
    write(addr, bytes) { blocks.push({ addr, bytes: Uint8Array.from(bytes) }); },
    read(addr, len) {
      const out = new Uint8Array(len);
      for (const b of blocks) {
        for (let i = 0; i < len; i++) {
          const o = addr + i - b.addr;
          if (o >= 0 && o < b.bytes.length) out[i] = b.bytes[o];
        }
      }
      return out;
    },
  };
}

const TID = 31337;
const SID = 4242;
function pk5({ pid, species = 495, level = 9, hp = 25, maxHp = 30, status = 0, item = 0 }) {
  const mon = new Uint8Array(220);
  const dv = new DataView(mon.buffer);
  dv.setUint32(0, pid, true);
  dv.setUint16(0x08, species, true);
  dv.setUint16(0x0a, item, true);
  dv.setUint16(0x0c, TID, true);
  dv.setUint16(0x0e, SID, true);
  dv.setUint32(0x88, status, true);
  mon[0x8c] = level;
  dv.setUint16(0x8e, hp, true);
  dv.setUint16(0x90, maxHp, true);
  for (let i = 0x92; i < 0x9c; i += 2) dv.setUint16(i, 20 + i, true);
  return encryptPK4(mon);
}

// Black 2: the party behind the pointer at 0x02000024 (+0x19728 to the mons), the save blocks around it as in the .sav
const CORE = 0x02000000 + 0x200000 + 0x19728 - 8;
function black2({ mons, badges = 0, money = 3000, tid = TID, sid = SID }) {
  const m = memory();
  m.write(0x02000024, [0x00, 0x00, 0x20, 0x02]);
  m.write(CORE, [6, 0, 0, 0, mons.length, 0, 0, 0, ...mons.flatMap((x) => [...x])]);
  m.write(CORE + 0x600 + 0x14, [tid & 0xff, tid >> 8, sid & 0xff, sid >> 8]); // trainer data block (0x19400)
  m.write(CORE + 0x8300, [money & 0xff, (money >> 8) & 0xff, (money >> 16) & 0xff, money >>> 24, badges]); // Misc (0x21100)
  return m;
}

test('Gen 5 status conditions are a number, not Gen 4 bits: poison shows as poison, not sleep (#5)', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map((s) => statusKey({ status: gen5Status(s) })), ['', 'par', 'slp', 'frz', 'brn', 'psn', '', '']);
  const e = findEntry(TABLE, { platform: 'nds', code: 'IREO' });
  const mons = [1, 2, 3, 4, 5].map((status, i) => pk5({ pid: 0x10000 + i * 0x777, species: 495 + i, status }));
  const r = readLiveParty(e, black2({ mons }).read, T, {});
  assert.deepEqual(r.party.map((x) => statusKey(x)), ['par', 'slp', 'frz', 'brn', 'psn']);
  // Gen 4 keeps its bits (HeartGold: 8 = poison)
  assert.equal(statusKey({ status: 8 }), 'psn');
});

test('Gen 5 badges come from the save blocks next to the party – only when they belong to this trainer (#13)', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IREO' });
  const mons = [pk5({ pid: 0xabcdef01 })];
  assert.equal(readLiveParty(e, black2({ mons, badges: 0b00000111 }).read, T, {}).badges, 3);
  assert.equal(readLiveParty(e, black2({ mons, badges: 0 }).read, T, {}).badges, 0);
  assert.equal(readLiveParty(e, black2({ mons, badges: 0xff }).read, T, {}).badges, 8);
  // another trainer's data there (not the save blocks), or no money amount: unknown, never a guess
  assert.equal(readLiveParty(e, black2({ mons, badges: 3, tid: 1 }).read, T, {}).badges, undefined);
  assert.equal(readLiveParty(e, black2({ mons, badges: 3, money: 0x7fffffff }).read, T, {}).badges, undefined);
});

test('Black 2: the summary screen (flag 0x88C2) is no battle – the catching demo\'s leftover Patrat stays off the panel (#9)', () => {
  const e = findEntry(TABLE, { platform: 'nds', code: 'IREO' });
  const mons = [pk5({ pid: 0xabcdef01 })];
  const m = black2({ mons });
  // a freed copy of the demo battle's party: none of the player's Pokémon, another trainer
  const demo = pk5({ pid: 0x5eed0001, species: 504, level: 2, hp: 11, maxHp: 11 });
  m.write(0x02300000, [6, 0, 0, 0, 1, 0, 0, 0, ...demo]);
  const poll = (ent, flag, state, n = 6) => {
    m.write(0x021b5138, [flag & 0xff, flag >> 8]);
    let fight = null;
    for (let i = 0; i < n; i++) fight = readLiveBattle(ent, m.read, T, state, readLiveParty(ent, m.read, T, state).party);
    return fight;
  };
  assert.equal(poll(e, 0x2800, {}), null, 'overworld');
  assert.equal(poll(e, 0x88c2, {}), null, 'summary screen: no battle');
  assert.equal(poll(e, 0x2100, {})?.enemy?.species, 504, 'a real battle still shows (here the copy stands in for its opponent)');
  // one odd read in the middle of a battle doesn't end it for good – a few in a row do
  const fight = {};
  assert.equal(poll(e, 0x2100, fight)?.enemy?.species, 504);
  assert.equal(poll(e, 0x88c2, fight, 1)?.enemy?.species, 504, 'a single odd value: still the battle');
  assert.equal(poll(e, 0x2100, fight)?.enemy?.species, 504, 'and the panel keeps its opponent afterwards');
  assert.equal(poll(e, 0x88c2, fight, 4), null, 'several odd values in a row: the battle is over');
  // another language of the game (its memory may lie elsewhere): an unknown value is left to the copies as before …
  const de = findEntry(TABLE, { platform: 'nds', code: 'IRED' });
  assert.equal(de.scanOnly, true);
  const st = {};
  assert.equal(poll(de, 0x88c2, st)?.enemy?.species, 504);
  // … until the address has shown both its battle and its overworld value in this session
  poll(de, 0x2100, st);
  poll(de, 0x2800, st);
  assert.equal(poll(de, 0x88c2, st), null);
});

test('Gen 5 level caps: the gym aces of Black/White and Black 2/White 2, then the Elite Four (#13)', () => {
  assert.equal(gymCapsFamily('pokemon-black'), 'bw');
  assert.equal(gymCapsFamily('pokemon-white-de'), 'bw');
  assert.equal(gymCapsFamily('pokemon-black-2'), 'b2w2');
  assert.equal(gymCapsFamily('pokemon-white-2-de'), 'b2w2');
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((b) => vanillaCapFor('bw', b).cap), [14, 20, 23, 27, 31, 35, 39, 43]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((b) => vanillaCapFor('b2w2', b).cap), [13, 18, 24, 30, 33, 39, 48, 51]);
  assert.deepEqual(vanillaCapFor('bw', 8), { cap: 50, boss: { key: 'elite four', name: 'Elite Four' } });
  assert.equal(vanillaCapFor('b2w2', 8).cap, 58);

  const B2 = { id: 'b2', mode: 'nuzlocke', players: { p1: { name: 'Lou' } }, game: { id: 'pokemon-black-2', code: 'IREO', system: 'nds' } };
  const d = new RunDoc('t');
  d._persistSoon = () => {};
  d.set('live:p1', { badges: 3, at: Date.now() });
  assert.deepEqual(R.levelCap(d, B2, 'p1'), { cap: 30, boss: { key: 'gym4', badge: 3, name: 'Gym 4' }, vanilla: true });
  d.set('live:p1', { badges: 8, at: Date.now() });
  assert.equal(R.levelCap(d, B2, 'p1').boss.name, 'Elite Four');
  assert.deepEqual(R.levelCap(d, { ...B2, game: { ...B2.game, hackId: 'blaze-black-2-redux' } }, 'p1'), { cap: null, boss: null }, 'a ROM hack: no retail cap');
  // the stream API says the same
  assert.equal(levelCapOf(B2, { levelCaps: 'warn' }, {}, 1).cap, 18);
  // a ROM hack (Blaze Black 2 Redux) has trainers of other levels: no retail cap rather than a wrong one
  assert.equal(levelCapOf({ ...B2, game: { ...B2.game, hackId: 'blaze-black-2-redux' } }, { levelCaps: 'warn' }, {}, 1), null);
  assert.equal(levelCapOf({ ...B2, patch: { name: 'x.xdelta' } }, { levelCaps: 'warn' }, {}, 1), null);
});

test('catches filed under a place number get the place name once it is known (#14)', () => {
  const B2 = { id: 'b2', mode: 'nuzlocke', players: { p1: { name: 'Lou' } }, game: { id: 'pokemon-black-2', code: 'IREO', system: 'nds' } };
  const d = new RunDoc('t');
  d._persistSoon = () => {};
  d.set('area:m5-6', { name: '#6', met: [6], auto: true, order: 1 }); // an older run (2.2.0 had no Gen 5 names)
  d.set('area:m5-5', { name: 'Our spot', met: [5], auto: false, order: 2 }); // named by hand: stays
  R.setRomPlaces(null);
  assert.equal(R.areaName(d, B2, 'm5-6'), '#6', 'still unknown without the ROM’s names');
  R.setRomPlaces({ gen: 5, lang: 'en', vanilla: true, names: ['', 'Mystery Zone', 'Faraway place', '', 'Nuvema Town', 'Accumula Town', 'Striaton City'] });
  try {
    assert.equal(R.areaName(d, B2, 'm5-6'), 'Striaton City', 'shown by its name at once');
    const mon = { key: 'k1', species: 495, nickname: 'SNIVY', level: 5, hp: 20, maxHp: 20, metLocation: 6, metLevel: 5 };
    R.applySnapshot(d, B2, 5, 'p1', { source: 'live', party: [mon] });
    assert.equal(d.get('area:m5-6').name, 'Striaton City', 'and written into the run, for the partners too');
    assert.equal(d.get('area:m5-5').name, 'Our spot');
  } finally {
    R.setRomPlaces(null);
  }
});

test('held items by name: the game\'s number in Gen 3, 4 and 5 (#15)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith('/shared/')) throw new Error('offline');
    const body = readFileSync(new URL('..' + url, import.meta.url), 'utf8');
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => JSON.parse(body) };
  };
  try {
    await loadData();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(itemName(155, 5, 'en'), 'Oran Berry');
  assert.equal(itemName(155, 5, 'de'), 'Sinelbeere');
  assert.equal(itemName(234, 5, 'en'), 'Leftovers');
  assert.equal(itemName(155, 4, 'en'), 'Oran Berry');
  assert.equal(itemName(139, 3, 'en'), 'Oran Berry', 'Gen 3 numbers its items differently');
  assert.equal(itemName(155, 2, 'en'), '', 'no table for Gen 1/2');
  assert.equal(itemName(9999, 5, 'en'), '', 'an item only a ROM hack has');
  assert.equal(itemName(0, 5, 'en'), '');
});
