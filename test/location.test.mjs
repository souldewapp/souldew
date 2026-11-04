// Current location from live RAM (shared/live/location.mjs + shared/data/maps.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readLocation, readMusicKey, readMusicInfo, MusicKeyTracker, locationLabel, mapEntryFor, sameLocation } from '../shared/live/location.mjs';

const json = (f) => JSON.parse(readFileSync(new URL(`../shared/data/${f}`, import.meta.url), 'utf8'));
const maps = json('maps.json');
const addresses = json('addresses.json');
const loc2 = json('locations_gen2_crystal.json');
const loc3 = json('locations_gen3.json');
const gen4 = json('gen4.json');
const tables = { maps, loc2, loc3, gen4 };

/** A sparse bus: { addr: [bytes] } → read(addr, len) */
function bus(cells) {
  const mem = new Map();
  for (const [a, bytes] of Object.entries(cells)) bytes.forEach((b, i) => mem.set(Number(a) + i, b));
  return (addr, len) => Uint8Array.from({ length: len }, (_, i) => mem.get(addr + i) ?? 0);
}
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const name = (r, lang = 'en') => (r ? locationLabel(r.gen, r.id, tables, lang) : null);

test('every maps.json game is an addresses.json game with the same generation', () => {
  const byId = Object.fromEntries(addresses.games.map((g) => [g.id, g]));
  for (const [id, m] of Object.entries(maps.games)) {
    assert.ok(byId[id], id);
    assert.equal(byId[id].gen, m.gen, id);
    if (m.gen === 4) assert.equal(m.saveDataPtrAddr, byId[id].saveDataPtrAddr, `${id}: same saveData pointer as the party reader`);
  }
  assert.equal(mapEntryFor(maps, 'heartgold_us~IPKD'), null, 'a scanned other-language layout has no known address');
});

test('every table id has a name', () => {
  for (const [repo, t] of Object.entries(maps.tables.gen1)) {
    if (repo.startsWith('_')) continue;
    for (const id of Object.values(t)) assert.ok(maps.gen1Locations[id]?.en && maps.gen1Locations[id]?.de, `gen1 ${repo} ${id}`);
  }
  for (const [repo, t] of Object.entries(maps.tables.gen2)) {
    if (repo.startsWith('_')) continue;
    for (const id of Object.values(t)) assert.ok(loc2.map[id]?.en, `gen2 ${repo} ${id}`);
  }
  for (const k of ['hgss', 'pt', 'dp']) {
    const list = maps.tables.gen4[k];
    assert.ok(list.length > 500, k);
    for (const id of list) assert.ok(id === null || gen4.locations[id] !== undefined, `gen4 ${k} ${id}`);
  }
});

test('Gen 1: wCurMap → town-map name, indoor maps take their town', () => {
  const red = (map) => readLocation(maps, 'red_us', bus({ 0xd35e: [map] }));
  assert.equal(name(red(0x0c)), 'Route 1');
  assert.equal(name(red(0x00)), 'Pallet Town');
  assert.equal(name(red(0x28)), 'Pallet Town', "Oak's Lab");
  assert.equal(name(red(0x00), 'de'), 'Alabastia');
  assert.equal(name(red(0x3b)), 'Mt. Moon');
  assert.equal(red(0xff), null, 'no such map');
  // Yellow sits one byte lower
  assert.equal(name(readLocation(maps, 'yellow_us', bus({ 0xd35d: [0x0c] }))), 'Route 1');
});

test('Gen 2: wMapGroup/wMapNumber → landmark, names like the Crystal met locations', () => {
  const silver = (g, n) => readLocation(maps, 'silver_us', bus({ 0xda00: [g, n] }));
  assert.deepEqual(silver(24, 3), { gen: 2, id: 2, map: '24.3' });
  assert.equal(name(silver(24, 3)), 'Route 29');
  assert.equal(name(silver(24, 4)), 'New Bark Town');
  assert.equal(name(silver(24, 4), 'de'), 'Neuborkia');
  assert.equal(silver(0, 0), null, 'title screen: nothing loaded yet');
  assert.equal(silver(200, 1), null);
  assert.equal(name(readLocation(maps, 'crystal_us', bus({ 0xdcb5: [24, 3] }))), 'Route 29');
  // Gold/Silver have no Battle Tower landmark: ids are Crystal's, matched by name
  const gsIds = new Set(Object.values(maps.tables.gen2.pokegold));
  assert.ok(![...gsIds].some((id) => loc2.map[id].landmark === 'LANDMARK_BATTLE_TOWER'));
});

test('Gen 3: gMapHeader.regionMapSectionId = the met-location MAPSEC', () => {
  const hdr = (sec, layout = 0x08481234) => [...le32(layout), ...le32(0x08500000), ...le32(0x08600000), ...le32(0x08700000), 0, 0, 0, 0, sec];
  const em = (h) => readLocation(maps, 'emerald_us', bus({ 0x02037318: h }));
  assert.deepEqual(em(hdr(16)), { gen: 3, id: 16, map: 16 });
  assert.equal(name(em(hdr(16))), loc3.map[16].en);
  assert.equal(em(hdr(0, 0)), null, 'zeroed header before the overworld loads is not Littleroot Town');
  assert.equal(em(hdr(0xd5)), null, 'MAPSEC_NONE');
  const fr = readLocation(maps, 'firered_us', bus({ 0x02036dfc: hdr(88) }));
  assert.equal(name(fr), 'Pallet Town');
  assert.equal(name(readLocation(maps, 'ruby_de', bus({ 0x0202e828: hdr(0) })), 'de'), 'Wurzelheim');
});

test('Gen 4: save data → current map id → location name', () => {
  const save = 0x0227a000;
  const hg = (mapId, ptr = save) => readLocation(maps, 'heartgold_us', bus({ 0x02111880: le32(ptr), [save + 0x1244]: le32(mapId) }));
  assert.equal(name(hg(33)), 'Route 29');
  assert.equal(hg(33).id, 177, 'the same id as a catch there (routes.mjs route-29)');
  assert.equal(name(hg(60)), 'New Bark Town');
  assert.equal(name(hg(61)), 'New Bark Town', "Elm's Lab");
  assert.equal(hg(0), null, 'Mystery Zone');
  assert.equal(hg(99999), null);
  assert.equal(hg(33, 0), null, 'no save data yet');
  assert.equal(hg(33, 0x08000000), null);
  const pt = readLocation(maps, 'platinum_us', bus({ 0x02101d40: le32(save), [save + 0x1294]: le32(342) }));
  assert.equal(name(pt), 'Route 201');
  const dp = readLocation(maps, 'diamond_us', bus({ 0x02106fc0: le32(save), [save + 0x144c]: le32(342) }));
  assert.equal(name(dp), 'Route 201');
});

test('sameLocation', () => {
  assert.ok(sameLocation(null, null));
  assert.ok(sameLocation({ gen: 2, id: 2 }, { gen: 2, id: 2, name: 'x' }));
  assert.ok(!sameLocation({ gen: 2, id: 2 }, null));
  assert.ok(!sameLocation({ gen: 2, id: 2 }, { gen: 3, id: 2 }));
});

test('fuzz: garbage RAM, short reads and throwing readers never throw', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 0xff;
  const readers = [
    (a, len) => Uint8Array.from({ length: len }, rnd),
    () => null,
    () => undefined,
    () => new Uint8Array(0),
    (a, len) => new Uint8Array(Math.max(0, len - 1)),
    (a, len) => new Uint8Array(len).fill(0xff),
    () => { throw new Error('heap detached'); },
    () => 'nope',
  ];
  const ids = [...Object.keys(maps.games), 'heartgold_us~IPKD', 'nope', null, undefined, { id: 'silver_us' }];
  for (const id of ids) {
    for (const read of readers) {
      for (let i = 0; i < 60; i++) {
        const r = readLocation(maps, id, read);
        if (r) {
          assert.ok(Number.isInteger(r.id) && [1, 2, 3, 4].includes(r.gen), JSON.stringify(r));
          assert.equal(typeof locationLabel(r.gen, r.id, tables, 'de'), 'string');
        }
      }
    }
  }
  assert.equal(readLocation(null, 'silver_us', () => null), null);
  assert.equal(readLocation({}, 'silver_us', () => null), null);
  assert.equal(readLocation(maps, 'silver_us', null), null);
  assert.equal(locationLabel(2, undefined, tables), '');
  assert.equal(locationLabel(9, 1, {}), '');
});

test('readMusicKey: the song id the game keeps (maps that share a song share the key), else the map; nothing → null', () => {
  // HeartGold: SND_WORK.currentSeqNo – SEQ_GS_T_WAKABA (New Bark Town) 1018, SEQ_GS_R_1_29 (Route 29) 1028
  assert.equal(readMusicKey(maps, 'heartgold_us', bus({ 0x021d0554: [1018 & 0xff, 1018 >> 8] })), 'm1018');
  assert.equal(readMusicKey(maps, 'soulsilver_us', bus({ 0x021d0554: [1028 & 0xff, 1028 >> 8] })), 'm1028');
  assert.equal(readMusicKey(maps, 'heartgold_us', bus({})), null, 'no music (0)');
  // Gen 1/2: the map's music (wMapMusicSoundID / wMapMusic) – MUSIC_NEW_BARK_TOWN 0x3C; Gen 3 sCurrentMapMusic
  assert.equal(readMusicKey(maps, 'silver_us', bus({ 0xc1c0: [0x3c] })), 'm60');
  assert.equal(readMusicKey(maps, 'crystal_us', bus({ 0xc2c0: [0x32] })), 'm50');
  assert.equal(readMusicKey(maps, 'red_us', bus({ 0xd35b: [0xba] })), 'm186');
  assert.equal(readMusicInfo(maps, 'red_us', bus({ 0xd35b: [0xff] })).song, null, 'no music: only the map is left');
  assert.equal(readMusicKey(maps, 'emerald_us', bus({ 0x03000f48: [0x6e, 0x01] })), 'm366');
  // Platinum: no song id known – the map the player is on
  const save = 0x02280000;
  const pt = maps.games.platinum_us;
  const key = readMusicKey(maps, 'platinum_us', bus({ [Number(pt.saveDataPtrAddr)]: le32(save), [save + Number(pt.mapIdOffset)]: le32(411) }));
  const here = readLocation(maps, 'platinum_us', bus({ [Number(pt.saveDataPtrAddr)]: le32(save), [save + Number(pt.mapIdOffset)]: le32(411) }));
  assert.equal(key, here ? `p4.${here.map}` : null);
  assert.equal(readMusicKey(maps, 'nonexistent_game', bus({})), null);
  assert.equal(readMusicKey(maps, 'heartgold_us', () => { throw new Error('bus'); }), null, 'never throws');
});

test('readMusicInfo (HGSS): song number, map, the map header’s music; a song number out of the BGM range reads as none', () => {
  const save = 0x02280000;
  const hg = maps.games.heartgold_us;
  const at = (map, seq) => bus({ [Number(hg.saveDataPtrAddr)]: le32(save), [save + Number(hg.mapIdOffset)]: le32(map), 0x021d0554: [seq & 0xff, seq >> 8] });
  assert.deepEqual(readMusicInfo(maps, 'heartgold_us', at(33, 1028)), { song: 'm1028', map: 'p4.33', expected: 'm1028', playing: true, own: false }, 'Route 29');
  assert.deepEqual(readMusicInfo(maps, 'heartgold_us', at(61, 1066)), { song: 'm1066', map: 'p4.61', expected: 'm1066', playing: true, own: false }, 'Elm’s lab');
  assert.equal(readMusicInfo(maps, 'heartgold_us', at(60, 7)).song, null, 'not a BGM number');
  assert.equal(readMusicInfo(maps, 'heartgold_us', at(60, 7)).expected, 'm1018', 'New Bark Town by its map');
});

/** Feeds a tracker `n` readings of the same info and returns the last key. */
const feedKeys = (t, info, n = 12, battle = false) => {
  let k;
  for (let i = 0; i < n; i++) k = t.next(info, battle);
  return k;
};

test('MusicKeyTracker: a song number that follows the game is the key (a HGSS battle too)', () => {
  const t = new MusicKeyTracker();
  assert.equal(feedKeys(t, { song: 'm1018', map: 'p4.60', expected: 'm1018', playing: true }), 'm1018');
  assert.equal(feedKeys(t, { song: 'm1066', map: 'p4.61', expected: 'm1066', playing: true }), 'm1066');
  assert.equal(feedKeys(t, { song: 'm1028', map: 'p4.33', expected: 'm1028', playing: true }), 'm1028');
  assert.equal(feedKeys(t, { song: 'm1031', map: 'p4.33', expected: 'm1028', playing: true }, 12, true), 'm1031', 'the battle’s own song');
  // a hack with other music on a map: the song number still follows the game – kept
  for (const [m, e, s] of [[60, 1018, 1200], [61, 1066, 1201], [33, 1028, 1202], [60, 1018, 1200]]) feedKeys(t, { song: `m${s}`, map: `p4.${m}`, expected: `m${e}`, playing: true });
  assert.equal(t.trusted, true);
});

test('MusicKeyTracker: a song number stuck while the map’s music changes → the map’s music (else the map) for the session; battles get their own key', () => {
  const t = new MusicKeyTracker();
  const stuck = (map, expected) => feedKeys(t, { song: 'm1004', map, expected, playing: true });
  assert.equal(stuck('p4.60', 'm1018'), 'm1004', 'trusted at first');
  stuck('p4.61', 'm1066');
  stuck('p4.60', 'm1018');
  assert.equal(stuck('p4.33', 'm1028'), 'm1028', 'three changes of the map’s music without the song number moving: distrusted');
  assert.equal(t.trusted, false);
  assert.equal(stuck('p4.61', 'm1066'), 'm1066');
  assert.equal(feedKeys(t, { song: 'm1004', map: 'p4.33', expected: 'm1028', playing: true }, 12, true), 'battle');
  // a house in a town shares the town's music: no false alarm on its own
  const u = new MusicKeyTracker();
  for (const m of [60, 63, 64, 63, 60, 65, 60, 66, 60]) feedKeys(u, { song: 'm1018', map: `p4.${m}`, expected: 'm1018', playing: true });
  assert.equal(u.trusted, true);
  // on the bicycle the bicycle song plays across routes: that is the game, not a stuck address
  const v = new MusicKeyTracker();
  for (const [m, e] of [[33, 1028], [60, 1018], [33, 1028], [34, 1029], [33, 1028]]) assert.equal(feedKeys(v, { song: 'm1013', map: `p4.${m}`, expected: `m${e}`, playing: true, own: true }), 'm1013');
  assert.equal(v.trusted, true);
});

test('MusicKeyTracker: no map-music table (Gen 1–3, Pt) – stuck through 8 maps → the map; the map’s music key gets a battle key', () => {
  const t = new MusicKeyTracker();
  for (let m = 1; m <= 7; m++) feedKeys(t, { song: 'm5', map: `p2.${m}`, expected: null, playing: false });
  assert.equal(t.trusted, true);
  assert.equal(feedKeys(t, { song: 'm5', map: 'p2.8', expected: null, playing: false }), 'p2.8');
  const g = new MusicKeyTracker();
  assert.equal(feedKeys(g, { song: 'm60', map: 'p2.2404', expected: null, playing: false }), 'm60');
  assert.equal(feedKeys(g, { song: 'm60', map: 'p2.2404', expected: null, playing: false }, 12, true), 'battle', 'Gen 2’s map music doesn’t change in a battle');
  // nothing reads the song: the map from the start
  assert.equal(feedKeys(new MusicKeyTracker(), { song: null, map: 'p4.411', expected: null, playing: false }), 'p4.411');
  assert.equal(new MusicKeyTracker().next(null), null);
});
