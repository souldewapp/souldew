// Bad input must produce errors, not hangs or crashes (patchers, library scan, run listing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPatch } from '../shared/patchers.mjs';
import { crc32 } from '../shared/checksum.mjs';

// The server modules read their data directory at import time → point them at a scratch dir first.
const DATA = mkdtempSync(join(tmpdir(), 'sls-test-'));
process.env.SLS_DATA_DIR = DATA;
const { writeFileAtomic } = await import('../server/lib/fsutil.mjs');
const { scanLibrary } = await import('../server/lib/library.mjs');
const { listRuns } = await import('../server/lib/build.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const enc = (v) => { const out = []; for (;;) { const x = v & 0x7f; v >>= 7; if (v === 0) { out.push(0x80 | x); break; } out.push(x); v--; } return out; };

test('truncated BPS patch throws instead of looping forever', () => {
  assert.throws(() => applyPatch(new Uint8Array(4), new Uint8Array([0x42, 0x50, 0x53, 0x31])), /truncated/);
});

test('BPS command past the target size throws', () => {
  const src = new Uint8Array([1, 2, 3, 4]);
  // TargetRead of 1000 bytes into a 4-byte target
  const body = [0x42, 0x50, 0x53, 0x31, ...enc(4), ...enc(4), ...enc(0), ...enc(((1000 - 1) << 2) | 1), ...le(crc32(src)), ...le(0)];
  assert.throws(() => applyPatch(src, new Uint8Array([...body, 0, 0, 0, 0])), /past the target/);
});

test('UPS hunk without terminator throws instead of looping forever', () => {
  const src = new Uint8Array([1, 2, 3, 4]);
  const body = [0x55, 0x50, 0x53, 0x31, ...enc(4), ...enc(4), ...enc(0), 9, ...le(crc32(src)), ...le(0)];
  assert.throws(() => applyPatch(src, new Uint8Array([...body, 0, 0, 0, 0])), /truncated/);
});

test('writeFileAtomic replaces the file and leaves no temp file behind', () => {
  const dir = join(DATA, 'atomic');
  mkdirSync(dir);
  const p = join(dir, 'doc.json');
  writeFileAtomic(p, '{"a":1}');
  writeFileAtomic(p, '{"a":2}');
  assert.equal(readFileSync(p, 'utf8'), '{"a":2}');
  assert.deepEqual(readdirSync(dir), ['doc.json']);
  assert.throws(() => writeFileAtomic(join(dir, 'missing', 'x.json'), '{}'));
  assert.deepEqual(readdirSync(dir), ['doc.json']);
});

/** Minimal zip writer: entries [{ name, data, method }] stored uncompressed (method is only declared). */
function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data, method = 0 } of entries) {
    const n = Buffer.from(name);
    const crc = le(crc32(data));
    const head = Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, method, 0, 0, 0, 0, 0, ...crc, ...le(data.length), ...le(data.length), n.length, 0, 0, 0]);
    local.push(head, n, Buffer.from(data));
    central.push(Buffer.from([0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, method, 0, 0, 0, 0, 0, ...crc, ...le(data.length), ...le(data.length),
      n.length, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...le(offset)]), n);
    offset += head.length + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, entries.length, 0, entries.length, 0, ...le(cd.length), ...le(offset), 0, 0]);
  return Buffer.concat([...local, cd, eocd]);
}

test('library scan skips broken zip entries and does not list nested folders twice', () => {
  const lib = join(DATA, 'Library');
  mkdirSync(join(lib, 'GBA'), { recursive: true });
  const gba = new Uint8Array(0x200);
  gba[0xb2] = 0x96;
  writeFileSync(join(lib, 'GBA', 'game.gba'), gba);
  // Deflate64 (method 9) isn't supported – that entry must be skipped, the other one still listed.
  writeFileSync(join(lib, 'pack.zip'), makeZip([{ name: 'bad.nds', data: new Uint8Array(0x200), method: 9 }, { name: 'good.gba', data: gba }]));
  const res = scanLibrary({ libraryFolders: [join(lib, 'GBA')] });
  const names = res.roms.map((r) => r.name).sort();
  assert.deepEqual(names, ['game.gba', 'good.gba']);
});

test('one damaged run.json does not break the run list', () => {
  mkdirSync(join(DATA, 'runs', 'aaaaaaaa'), { recursive: true });
  mkdirSync(join(DATA, 'runs', 'bbbbbbbb'), { recursive: true });
  writeFileSync(join(DATA, 'runs', 'aaaaaaaa', 'run.json'), '{"id":"aaaa');
  writeFileSync(join(DATA, 'runs', 'bbbbbbbb', 'run.json'), JSON.stringify({ id: 'bbbbbbbb', game: { id: 'x' } }));
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(listRuns().map((m) => m.id), ['bbbbbbbb']);
  } finally {
    console.warn = warn;
  }
});
