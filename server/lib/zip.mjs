// Tiny ZIP reader (stored + deflate entries, ZIP64 sizes) — enough for ROM / patch archives.
import { inflateRawSync, constants as zlibConstants } from 'node:zlib';

/** Largest entry we ever decompress (biggest NDS ROMs are 512 MB). Protects against zip bombs. */
export const MAX_ENTRY_SIZE = 600 * 1024 * 1024;
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = readSync(fd, buf, off, len - off, pos + off);
    if (n === 0) break;
    off += n;
  }
  return buf.subarray(0, off);
}

/** List entries of a zip file without reading the payloads. */
export function listZip(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 0x10000 + 22);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a zip file (no end of central directory)');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) {
      // ZIP64 end of central directory locator sits right before the EOCD record
      const loc = eocd - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
        const z64pos = Number(tail.readBigUInt64LE(loc + 8));
        const z64 = readAt(fd, z64pos, 56);
        count = Number(z64.readBigUInt64LE(32));
        cdSize = Number(z64.readBigUInt64LE(40));
        cdOffset = Number(z64.readBigUInt64LE(48));
      }
    }
    if (!(cdOffset >= 0 && cdSize >= 0 && cdOffset + cdSize <= size)) throw new Error('Corrupt zip (central directory out of range)');
    const cd = readAt(fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compSize = cd.readUInt32LE(p + 20);
      let uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      // ZIP64 extra field
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompSize === 0xffffffff) { uncompSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + len;
      }
      if (!name.endsWith('/')) entries.push({ name, method, crc, compSize, uncompSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

/**
 * Read and decompress one entry. Never produces more than the declared uncompressed size (capped at
 * MAX_ENTRY_SIZE). With `{ prefix: n }` only the first n bytes are decompressed (e.g. a ROM header) – that
 * reads at most 64 KB of compressed data instead of inflating a whole ROM.
 */
export function readZipEntry(path, entry, { prefix = 0 } = {}) {
  const fd = openSync(path, 'r');
  try {
    const fileSize = fstatSync(fd).size;
    const lh = readAt(fd, entry.localOffset, 30);
    if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) throw new Error('Corrupt zip (bad local header)');
    const dataStart = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    if (!(entry.compSize >= 0 && dataStart + entry.compSize <= fileSize)) throw new Error('Corrupt zip (entry out of range)');
    if (!(entry.uncompSize >= 0 && entry.uncompSize <= MAX_ENTRY_SIZE)) throw new Error(`Zip entry too large: ${entry.name}`);
    if (prefix > 0) {
      const raw = readAt(fd, dataStart, Math.min(entry.compSize, entry.method === 0 ? prefix : 64 * 1024));
      if (entry.method === 0) return raw;
      if (entry.method === 8) {
        // SYNC_FLUSH accepts the truncated stream and returns what it decodes so far (≤ ~64 MB from 64 KB).
        return inflateRawSync(raw, { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: 64 * 1024 * 1024 }).subarray(0, prefix);
      }
      throw new Error(`Unsupported zip compression method ${entry.method} in ${entry.name}`);
    }
    if (entry.compSize > MAX_ENTRY_SIZE) throw new Error(`Zip entry too large: ${entry.name}`);
    const raw = readAt(fd, dataStart, entry.compSize);
    if (entry.method === 0) return raw;
    // maxOutputLength makes inflate throw instead of allocating past the declared size (zip bomb).
    if (entry.method === 8) return inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(entry.uncompSize, MAX_ENTRY_SIZE)) });
    throw new Error(`Unsupported zip compression method ${entry.method} in ${entry.name}`);
  } finally {
    closeSync(fd);
  }
}
