// Unified ROM patch application: xdelta/VCDIFF, BPS and IPS.
import { applyVcdiff, inspectVcdiff } from './vcdiff.mjs';
import { crc32 } from './checksum.mjs';

/** Largest ROM a patch may produce (biggest NDS cartridges are 512 MB) – a corrupt size field can't allocate more. */
export const MAX_TARGET_SIZE = 512 * 1024 * 1024;

export function detectPatchFormat(patch) {
  if (patch[0] === 0xd6 && patch[1] === 0xc3 && patch[2] === 0xc4) return 'xdelta';
  if (patch[0] === 0x42 && patch[1] === 0x50 && patch[2] === 0x53 && patch[3] === 0x31) return 'bps';
  if (patch[0] === 0x50 && patch[1] === 0x41 && patch[2] === 0x54 && patch[3] === 0x43 && patch[4] === 0x48) return 'ips';
  if (patch[0] === 0x55 && patch[1] === 0x50 && patch[2] === 0x53 && patch[3] === 0x31) return 'ups';
  return null;
}

export function describePatch(patch) {
  const format = detectPatchFormat(patch);
  if (format === 'xdelta') return { format, ...inspectVcdiff(patch) };
  if (format === 'bps' || format === 'ups') {
    const n = patch.length;
    const u32 = (o) => (patch[o] | (patch[o + 1] << 8) | (patch[o + 2] << 16) | (patch[o + 3] << 24)) >>> 0;
    return { format, sourceCrc: u32(n - 12), targetCrc: u32(n - 8) };
  }
  return { format };
}

export function applyPatch(source, patch, onProgress) {
  const format = detectPatchFormat(patch);
  if (format === 'xdelta') return applyVcdiff(source, patch, onProgress);
  if (format === 'bps') return applyBps(source, patch);
  if (format === 'ips') return applyIps(source, patch);
  if (format === 'ups') return applyUps(source, patch);
  throw new Error('Unknown patch format (supported: .xdelta/.vcdiff, .bps, .ups, .ips)');
}

function applyIps(source, patch) {
  let out = new Uint8Array(source.length);
  out.set(source);
  let p = 5;
  const ensure = (n) => {
    if (n <= out.length) return;
    const b = new Uint8Array(n);
    b.set(out);
    out = b;
  };
  while (p + 3 <= patch.length) {
    if (patch[p] === 0x45 && patch[p + 1] === 0x4f && patch[p + 2] === 0x46) {
      p += 3;
      if (p + 3 <= patch.length) {
        const truncate = (patch[p] << 16) | (patch[p + 1] << 8) | patch[p + 2];
        out = out.slice(0, truncate);
      }
      return out;
    }
    const offset = (patch[p] << 16) | (patch[p + 1] << 8) | patch[p + 2];
    const size = (patch[p + 3] << 8) | patch[p + 4];
    p += 5;
    if (size === 0) {
      const runLen = (patch[p] << 8) | patch[p + 1];
      const value = patch[p + 2];
      p += 3;
      ensure(offset + runLen);
      out.fill(value, offset, offset + runLen);
    } else {
      ensure(offset + size);
      out.set(patch.subarray(p, p + size), offset);
      p += size;
    }
  }
  throw new Error('IPS: missing EOF marker');
}

function applyBps(source, patch) {
  let p = 4;
  const num = () => {
    let data = 0;
    let shift = 1;
    for (;;) {
      if (p >= patch.length) throw new Error('BPS/UPS: patch is truncated');
      const x = patch[p++];
      data += (x & 0x7f) * shift;
      if (x & 0x80) break;
      shift *= 128;
      data += shift;
    }
    return data;
  };
  const sourceSize = num();
  const targetSize = num();
  if (targetSize > MAX_TARGET_SIZE) throw new Error('BPS: target size is implausibly large (corrupt patch?)');
  const metaSize = num();
  p += metaSize;
  const n = patch.length;
  const u32 = (o) => (patch[o] | (patch[o + 1] << 8) | (patch[o + 2] << 16) | (patch[o + 3] << 24)) >>> 0;
  if (source.length !== sourceSize || crc32(source) !== u32(n - 12)) {
    throw new Error('BPS: base ROM does not match the patch (size/CRC32 mismatch)');
  }
  const out = new Uint8Array(targetSize);
  let outPos = 0;
  let srcRel = 0;
  let tgtRel = 0;
  while (p < n - 12) {
    const d = num();
    const cmd = d % 4;
    const len = Math.floor(d / 4) + 1;
    if (outPos + len > targetSize) throw new Error('BPS: patch writes past the target size (corrupt patch?)');
    if (cmd === 0) {
      out.set(source.subarray(outPos, outPos + len), outPos);
      outPos += len;
    } else if (cmd === 1) {
      out.set(patch.subarray(p, p + len), outPos);
      p += len;
      outPos += len;
    } else {
      const raw = num();
      const off = (raw & 1 ? -1 : 1) * Math.floor(raw / 2);
      if (cmd === 2) {
        srcRel += off;
        out.set(source.subarray(srcRel, srcRel + len), outPos);
        srcRel += len;
        outPos += len;
      } else {
        tgtRel += off;
        for (let i = 0; i < len; i++) out[outPos++] = out[tgtRel++];
      }
    }
  }
  if (crc32(out) !== u32(n - 8)) throw new Error('BPS: result checksum mismatch');
  return out;
}

function applyUps(source, patch) {
  let p = 4;
  const num = () => {
    let data = 0;
    let shift = 1;
    for (;;) {
      if (p >= patch.length) throw new Error('BPS/UPS: patch is truncated');
      const x = patch[p++];
      data += (x & 0x7f) * shift;
      if (x & 0x80) break;
      shift *= 128;
      data += shift;
    }
    return data;
  };
  const n = patch.length;
  const u32 = (o) => (patch[o] | (patch[o + 1] << 8) | (patch[o + 2] << 16) | (patch[o + 3] << 24)) >>> 0;
  const sourceSize = num();
  const targetSize = num();
  if (targetSize > MAX_TARGET_SIZE) throw new Error('UPS: target size is implausibly large (corrupt patch?)');
  if (source.length !== sourceSize || crc32(source) !== u32(n - 12)) {
    throw new Error('UPS: base ROM does not match the patch (size/CRC32 mismatch)');
  }
  const out = new Uint8Array(targetSize);
  out.set(source.subarray(0, Math.min(source.length, targetSize)));
  let rel = 0;
  while (p < n - 12) {
    rel += num();
    for (;;) {
      if (p >= n - 12) throw new Error('UPS: patch is truncated');
      const x = patch[p++];
      if (rel < targetSize) out[rel] = (rel < source.length ? source[rel] : 0) ^ x;
      rel++;
      if (x === 0) break;
    }
  }
  if (crc32(out) !== u32(n - 8)) throw new Error('UPS: result checksum mismatch');
  return out;
}
