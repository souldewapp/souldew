// Nintendo 3DS files: what shared/ctr.mjs reads from their headers, the catalog match, the library scan (no file is
// read whole) and a 3DS run (linked, not randomized).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identifyCtrBytes, identifyCtr, gameCodeOf, titleKind, smdhTitle, CTR_EXTENSIONS } from '../shared/ctr.mjs';
import { matchCatalog, isCtrExt, ROM_EXTENSIONS, SYSTEMS } from '../shared/romid.mjs';
import { cci, cia, threedsx, z3ds, ncchHeader } from './fixtures/ctr.mjs';

const DATA = mkdtempSync(join(tmpdir(), 'sls-ctr-'));
process.env.SLS_DATA_DIR = DATA;
const { scanLibrary, ctrInfo, uploadTarget } = await import('../server/lib/library.mjs');
const { buildRun, runPack, checkPack } = await import('../server/lib/build.mjs');
const { preparePatchedRom } = await import('../server/lib/roms.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));
const catalog = JSON.parse(readFileSync(new URL('../shared/data/catalog.json', import.meta.url), 'utf8'));

test('a cartridge image (.3ds / .cci): product code, title ID, version, encryption', () => {
  const r = identifyCtrBytes(cci({ productCode: 'CTR-P-EKJA', titleId: '0004000000055D00', version: 0x20 }), '3ds');
  assert.deepEqual(
    { system: r.system, format: r.format, code: r.code, productCode: r.productCode, titleId: r.titleId, kind: r.kind, version: r.version, encrypted: r.encrypted },
    { system: '3ds', format: 'cci', code: 'EKJA', productCode: 'CTR-P-EKJA', titleId: '0004000000055D00', kind: 'game', version: 0x20, encrypted: false },
  );
  // the NCCH header stays readable in an encrypted cartridge – only its contents are encrypted
  assert.equal(identifyCtrBytes(cci({ encrypted: true }), 'cci').encrypted, true);
  assert.equal(identifyCtrBytes(cci({ encrypted: true }), 'cci').code, 'EKJA');
  // a partition that isn't an NCCH: the cartridge's media ID is still the title ID
  const broken = identifyCtrBytes(cci({ brokenPartition: true, titleId: '00040000001B5100' }), '3ds');
  assert.equal(broken.titleId, '00040000001B5100');
  assert.equal(broken.code, '');
  // the format comes from the header, not the name
  assert.equal(identifyCtrBytes(cci(), 'cxi').format, 'cci');
});

test('a bare NCCH (.cxi), a .cia, a homebrew .3dsx and Azahar\'s compressed files', () => {
  const cxi = identifyCtrBytes(ncchHeader({ productCode: 'CTR-P-BNDA', titleId: '0004000000164800' }), 'cxi');
  assert.equal(cxi.format, 'cxi');
  assert.equal(cxi.code, 'BNDA');
  assert.equal(cxi.titleId, '0004000000164800');

  const c = identifyCtrBytes(cia(), 'cia');
  assert.deepEqual({ format: c.format, titleId: c.titleId, code: c.code, version: c.version, kind: c.kind }, { format: 'cia', titleId: '0004000000055E00', code: 'EK2A', version: 0x1450, kind: 'game' });
  // encrypted content: no product code, the TMD's title ID still names the game
  const enc = identifyCtrBytes(cia({ contentEncrypted: true }), 'cia');
  assert.equal(enc.code, '');
  assert.equal(enc.encrypted, true);
  assert.equal(enc.titleId, '0004000000055E00');
  // an update for X: 0004000E…
  assert.equal(identifyCtrBytes(cia({ titleId: '0004000E00055D00' }), 'cia').kind, 'update');

  const hb = identifyCtrBytes(threedsx('Checkpoint'), '3dsx');
  assert.equal(hb.format, '3dsx');
  assert.equal(hb.title, 'Checkpoint');
  assert.equal(hb.kind, 'homebrew');

  const z = identifyCtrBytes(z3ds(), 'zcci');
  assert.equal(z.compressed, true);
  assert.equal(z.format, 'zcci');
});

test('not a 3DS file, a cut-off file, a reader that fails: null, never an exception', () => {
  assert.equal(identifyCtrBytes(new Uint8Array(0x1000), '3ds'), null);
  assert.equal(identifyCtrBytes(cci().subarray(0, 0x150), '3ds'), null);
  assert.equal(identifyCtrBytes(new Uint8Array(0x2000).fill(7), 'cia'), null);
  assert.equal(identifyCtrBytes(new Uint8Array(16), '3dsx'), null);
  assert.equal(identifyCtrBytes(new Uint8Array(32), 'zcci'), null);
  assert.equal(identifyCtr(() => { throw new Error('io'); }, '3ds'), null);
  assert.equal(identifyCtr(() => null, 'cia'), null);
  // only a few small reads – a 4 GB file is never read whole
  const file = cci();
  const reads = [];
  identifyCtr((o, n) => {
    reads.push(n);
    return file.subarray(o, o + n);
  }, '3ds');
  assert.ok(reads.length <= 3 && reads.every((n) => n <= 0x200), JSON.stringify(reads));
});

test('helpers: game codes, title kinds, SMDH titles, extensions', () => {
  assert.equal(gameCodeOf('CTR-P-ECRP'), 'ECRP');
  assert.equal(gameCodeOf('KTR-P-A2AA'), 'A2AA');
  assert.equal(gameCodeOf('NTR-IRBO'), '');
  assert.equal(titleKind('0004000000055D00'), 'game');
  assert.equal(titleKind('0004008C00055D00'), 'dlc');
  assert.equal(titleKind('0004013000001502'), 'other');
  assert.equal(smdhTitle(new Uint8Array(10)), '');
  assert.ok(CTR_EXTENSIONS.every(isCtrExt));
  assert.ok(!ROM_EXTENSIONS.some(isCtrExt), 'GB…DS files keep their own path (CRC32, inside zips)');
  assert.equal(SYSTEMS['3ds'].name, 'Nintendo 3DS');
});

test('the catalog knows all eight 3DS games – by game code, by title ID', () => {
  const ids = catalog.games.filter((g) => g.system === '3ds').map((g) => g.id);
  assert.deepEqual(ids, ['pokemon-x', 'pokemon-y', 'pokemon-omega-ruby', 'pokemon-alpha-sapphire', 'pokemon-sun', 'pokemon-moon', 'pokemon-ultra-sun', 'pokemon-ultra-moon']);
  const by = (rom) => matchCatalog({ system: '3ds', crc: null, ...rom }, catalog)?.game?.id;
  assert.equal(by({ code: 'EKJA' }), 'pokemon-x');
  assert.equal(by({ code: 'ECRP' }), 'pokemon-omega-ruby'); // the European cartridge's code
  assert.equal(by({ code: 'A2BA' }), 'pokemon-ultra-moon');
  assert.equal(by({ code: '', titleId: '0004000000175E00' }), 'pokemon-moon');
  assert.equal(by({ code: 'XXXX', titleId: '0004000000099999' }), undefined);
  for (const g of catalog.games.filter((x) => x.system === '3ds')) {
    assert.ok([6, 7].includes(g.generation), g.id);
    assert.equal(g.uprSupported, false, `${g.id}: the bundled randomizer doesn't build 3DS games`);
    assert.ok(existsSync(new URL(`../web/${g.coverLocal}`, import.meta.url)), `${g.id} cover`);
  }
});

test('library: 3DS files are found and matched without reading them whole; updates are left out', () => {
  const lib = join(DATA, 'Library');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'Pokemon X.3ds'), cci());
  writeFileSync(join(lib, 'Pokemon Y.cia'), cia());
  writeFileSync(join(lib, 'Update X.cia'), cia({ titleId: '0004000E00055D00' }));
  writeFileSync(join(lib, 'App.3dsx'), threedsx('Some homebrew'));
  writeFileSync(join(lib, 'not-a-game.3ds'), new Uint8Array(0x800));
  const { roms } = scanLibrary({});
  const ctr = roms.filter((r) => r.system === '3ds').sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(ctr.map((r) => [r.name, r.gameId, r.crc]), [['App.3dsx', null, null], ['Pokemon X.3ds', 'pokemon-x', null], ['Pokemon Y.cia', 'pokemon-y', null]]);
  assert.equal(ctr[0].title, 'Some homebrew');
  // the index cache: a second scan gives the same
  assert.equal(scanLibrary({}).roms.filter((r) => r.system === '3ds').length, 3);
  assert.equal(ctrInfo(join(lib, 'Update X.cia'), 'cia'), null);
  assert.ok(uploadTarget('Pokemon Sun.3ds').endsWith('Pokemon Sun.3ds'));
  assert.ok(uploadTarget('game.cia').endsWith('game.cia'));
});

test('a 3DS run: the game file linked into the run folder, no randomizer, no patch, no checksum of 4 GB', async () => {
  const lib = join(DATA, 'Library');
  const rom = join(lib, 'Pokemon X.3ds');
  const prepared = preparePatchedRom(rom, null, () => {}, {});
  assert.equal(prepared.system, '3ds');
  assert.equal(prepared.crc, null);
  assert.equal(prepared.path, rom); // played from the library file, no cached copy
  assert.throws(() => preparePatchedRom(rom, join(lib, 'x.bps'), () => {}, {}), /patch/i);
  const log = [];
  const m = await buildRun({ romId: rom, gameId: 'pokemon-x', gameTitle: 'Pokémon X', randomize: true, mode: 'nuzlocke', players: { p1: { name: 'Ash' } }, config: {} }, (l) => log.push(l));
  assert.equal(m.randomizer.enabled, false, 'never randomized');
  assert.equal(m.game.system, '3ds');
  assert.equal(m.game.code, 'EKJA');
  const out = m.outputs.p1;
  assert.match(out.rom, /\.3ds$/);
  assert.equal(out.sha1, null);
  const built = join(DATA, 'runs', m.id, out.rom);
  assert.equal(statSync(built).size, statSync(rom).size);
  assert.equal(statSync(built).ino, statSync(rom).ino, 'a hard link on the same drive – no copy of the game');
});

test('a 3DS SoulLink: every player gets the game (linked), the run pack travels without checksums', async () => {
  const rom = join(DATA, 'Library', 'Pokemon X.3ds');
  const m = await buildRun({ romId: rom, gameId: 'pokemon-x', gameTitle: 'Pokémon X', mode: 'soullink', players: { p1: { name: 'Ash' }, p2: { name: 'Misty' } }, config: {} });
  assert.deepEqual(Object.keys(m.outputs).sort(), ['p1', 'p2']);
  assert.notEqual(m.outputs.p1.rom, m.outputs.p2.rom);
  const pack = runPack(m);
  assert.equal(pack.game.system, '3ds');
  assert.deepEqual(pack.outputs, { p1: { sha1: null }, p2: { sha1: null } });
  assert.equal(pack.randomizer.enabled, false);
  assert.doesNotThrow(() => checkPack(JSON.parse(JSON.stringify(pack))));
  // the friend builds their own from their own copy: nothing to compare, no "differs from the run pack" warning
  const log = [];
  const again = await buildRun({ romId: rom, gameId: 'pokemon-x', mode: 'soullink', players: m.players, identity: { id: m.id, room: m.room, secret: m.secret }, buildFor: ['p2'], expectedOutputs: pack.outputs, config: {} }, (l) => log.push(l));
  assert.equal(again.outputs.p2.matchesFriend, undefined);
  assert.ok(!log.some((l) => /weicht/.test(l)), log.join('\n'));
});
