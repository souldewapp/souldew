import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyPatch, detectPatchFormat } from '../shared/patchers.mjs';
import { crc32Hex, adler32 } from '../shared/checksum.mjs';
import { decodeXz } from '../shared/xz.mjs';
import { listZip, readZipEntry } from '../server/lib/zip.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('CRC32 / Adler-32 check values', () => {
  const s = new TextEncoder().encode('123456789');
  assert.equal(crc32Hex(s), 'CBF43926');
  assert.equal(adler32(s), 0x091e01de);
});

test('xz decoder matches the xz CLI (when installed)', (t) => {
  // Run `xz` straight from the PATH (`which` would hand back a POSIX path that Windows can't start, e.g. Git Bash's).
  const xz = 'xz';
  try { execFileSync(xz, ['--version'], { stdio: 'ignore' }); } catch { return t.skip('xz not installed'); }
  const input = new Uint8Array(200000);
  for (let i = 0; i < input.length; i++) input[i] = (i * 7 + (i >> 5)) & 0xff ^ (i % 251 === 0 ? 0x55 : 0);
  const packed = execFileSync(xz, ['-c', '-6'], { input });
  assert.deepEqual(Buffer.from(decodeXz(new Uint8Array(packed))), Buffer.from(input));
});

test('IPS patch', () => {
  const src = new Uint8Array([1, 2, 3, 4, 5]);
  const ips = new Uint8Array([0x50, 0x41, 0x54, 0x43, 0x48, 0, 0, 1, 0, 2, 9, 9, 0, 0, 4, 0, 0, 0, 3, 7, 0x45, 0x4f, 0x46]);
  assert.equal(detectPatchFormat(ips), 'ips');
  assert.deepEqual([...applyPatch(src, ips)], [1, 9, 9, 4, 7, 7, 7]);
});

// Full Definitive HeartGold patch, only if the user's files are present.
const romZip = readdirSync(ROOT).find((f) => /HeartGold.*\.zip$/i.test(f));
const patchZip = readdirSync(ROOT).find((f) => /patch.*\.zip$/i.test(f));
test('Definitive HeartGold xdelta applies to C180A0E9 and yields 6AD2AB08', { skip: !(romZip && patchZip) && 'ROM/patch not present' }, () => {
  const re = listZip(ROOT + romZip).find((e) => e.name.endsWith('.nds'));
  const pe = listZip(ROOT + patchZip).find((e) => /\.xdelta$/i.test(e.name));
  const rom = new Uint8Array(readZipEntry(ROOT + romZip, re));
  assert.equal(crc32Hex(rom), 'C180A0E9');
  const out = applyPatch(rom, new Uint8Array(readZipEntry(ROOT + patchZip, pe)));
  assert.equal(crc32Hex(out), '6AD2AB08');
});

test('UPS patch round-trip', async () => {
  const { crc32 } = await import('../shared/checksum.mjs');
  const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const tgt = new Uint8Array([1, 9, 3, 4, 5, 6, 0, 8, 42]);
  // Build a UPS patch by hand: header, sizes, one hunk at 1 (xor 2^9), one at 6..8 (xor 7^0, 8^8=0? use diff), end CRCs
  const enc = (v) => { const out = []; for (;;) { const x = v & 0x7f; v >>= 7; if (v === 0) { out.push(0x80 | x); break; } out.push(x); v--; } return out; };
  const bytes = [0x55, 0x50, 0x53, 0x31, ...enc(src.length), ...enc(tgt.length)];
  // hunk 1: skip 1, xor byte (2^9), terminator
  bytes.push(...enc(1), 2 ^ 9, 0);
  // after terminator rel = 3; hunk 2: skip 3 → rel 6, xor 7^0 = 7, then position 7 equal (8^8 = 0 terminates) – then pos 8: need 42
  bytes.push(...enc(3), 7 ^ 0, 0);
  // rel now 8; hunk 3: skip 0, xor 0^42, terminator
  bytes.push(...enc(0), 42, 0);
  const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const body = new Uint8Array([...bytes, ...le(crc32(src)), ...le(crc32(tgt))]);
  const patch = new Uint8Array([...body, ...le(crc32(body))]);
  assert.deepEqual([...applyPatch(src, patch)], [...tgt]);
});
