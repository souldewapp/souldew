// Minimal 7-Zip (.7z) reader – enough to unpack the official Windows builds of mGBA (LZMA + BCJ2, solid, with a
// compressed header) without 7-Zip or a `tar` that knows the format (Windows 10's tar.exe can't read LZMA).
// Supported: Copy, LZMA, LZMA2, Deflate, BCJ (x86) and BCJ2 coders, solid and non-solid archives, encoded headers,
// empty files and folders. Not supported (refused with a clear error): encryption, other filters, multi-volume.
// Every file's CRC32 is checked when the archive has one.
import { inflateRawSync } from 'node:zlib';
import { decodeLzma, decodeLzma2 } from '../../shared/xz.mjs';
import { crc32 } from '../../shared/checksum.mjs';

/** Unpacked size we refuse to go beyond (the emulators are ~100 MB). */
export const MAX_UNPACKED = 1024 * 1024 * 1024;

const SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
const ID = {
  End: 0x00, Header: 0x01, ArchiveProperties: 0x02, AdditionalStreamsInfo: 0x03, MainStreamsInfo: 0x04, FilesInfo: 0x05,
  PackInfo: 0x06, UnpackInfo: 0x07, SubStreamsInfo: 0x08, Size: 0x09, CRC: 0x0a, Folder: 0x0b, CodersUnpackSize: 0x0c,
  NumUnpackStream: 0x0d, EmptyStream: 0x0e, EmptyFile: 0x0f, Name: 0x11, WinAttributes: 0x15, EncodedHeader: 0x17, Dummy: 0x19,
};
const CODERS = { COPY: '00', LZMA2: '21', LZMA: '030101', BCJ: '03030103', BCJ2: '0303011b', DEFLATE: '040108', AES: '06f10701' };

const bad = (msg) => Object.assign(new Error(`7z: ${msg}`), { code: 'BAD_7Z' });

class Reader {
  constructor(buf) {
    this.b = buf;
    this.p = 0;
  }

  byte() {
    if (this.p >= this.b.length) throw bad('truncated header');
    return this.b[this.p++];
  }

  bytes(n) {
    if (!(n >= 0) || this.p + n > this.b.length) throw bad('truncated header');
    const out = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return out;
  }

  u32() {
    const v = this.bytes(4);
    return (v[0] | (v[1] << 8) | (v[2] << 16) | (v[3] << 24)) >>> 0;
  }

  u64() {
    const lo = this.u32();
    const hi = this.u32();
    const v = hi * 2 ** 32 + lo;
    if (!Number.isSafeInteger(v)) throw bad('number out of range');
    return v;
  }

  /** 7-Zip's variable-length NUMBER: the high bits of the first byte say how many bytes follow. */
  num() {
    const first = this.byte();
    let mask = 0x80;
    let value = 0;
    for (let i = 0; i < 8; i++) {
      if ((first & mask) === 0) {
        value += (first & (mask - 1)) * 2 ** (8 * i);
        if (!Number.isSafeInteger(value)) throw bad('number out of range');
        return value;
      }
      value += this.byte() * 2 ** (8 * i);
      mask >>= 1;
    }
    if (!Number.isSafeInteger(value)) throw bad('number out of range');
    return value;
  }

  /** A count that has to fit the remaining header (each item takes ≥ 1 byte) – no giant allocations from junk. */
  count(limit = this.b.length - this.p) {
    const n = this.num();
    if (n > limit + 1) throw bad('implausible count');
    return n;
  }

  bits(n) {
    const out = new Array(n);
    let mask = 0;
    let byte = 0;
    for (let i = 0; i < n; i++) {
      if (mask === 0) {
        byte = this.byte();
        mask = 0x80;
      }
      out[i] = (byte & mask) !== 0;
      mask >>= 1;
    }
    return out;
  }

  definedBits(n) {
    return this.byte() ? new Array(n).fill(true) : this.bits(n);
  }

  digests(n) {
    return this.definedBits(n).map((d) => (d ? this.u32() : null));
  }

  expect(id) {
    const got = this.byte();
    if (got !== id) throw bad(`unexpected header property ${got} (expected ${id})`);
  }
}

function readPackInfo(r) {
  const info = { packPos: r.num(), sizes: [] };
  const n = r.count();
  for (;;) {
    const id = r.byte();
    if (id === ID.End) break;
    if (id === ID.Size) info.sizes = Array.from({ length: n }, () => r.num());
    else if (id === ID.CRC) r.digests(n);
    else throw bad(`unknown pack info property ${id}`);
  }
  if (info.sizes.length !== n) throw bad('pack sizes missing');
  return info;
}

function readFolder(r) {
  const coders = [];
  const numCoders = r.count(64);
  if (!numCoders) throw bad('folder without coders');
  let totalIn = 0;
  let totalOut = 0;
  for (let i = 0; i < numCoders; i++) {
    const flag = r.byte();
    if (flag & 0x80) throw bad('alternative coder methods are not supported');
    const id = Buffer.from(r.bytes(flag & 0x0f)).toString('hex');
    const complex = (flag & 0x10) !== 0;
    const numIn = complex ? r.count(32) : 1;
    const numOut = complex ? r.count(32) : 1;
    const props = flag & 0x20 ? r.bytes(r.count()) : new Uint8Array(0);
    coders.push({ id, numIn, numOut, props, inStart: totalIn, outStart: totalOut });
    totalIn += numIn;
    totalOut += numOut;
  }
  if (!totalOut) throw bad('folder without output');
  const bindPairs = Array.from({ length: totalOut - 1 }, () => ({ inIndex: r.num(), outIndex: r.num() }));
  const numPacked = totalIn - bindPairs.length;
  if (numPacked < 1) throw bad('folder without input');
  let packed;
  if (numPacked === 1) {
    const free = [...Array(totalIn).keys()].find((i) => !bindPairs.some((b) => b.inIndex === i));
    if (free === undefined) throw bad('folder without input');
    packed = [free];
  } else {
    packed = Array.from({ length: numPacked }, () => r.num());
  }
  return { coders, bindPairs, packed, totalOut, unpackSizes: [], crc: null };
}

function readUnpackInfo(r) {
  r.expect(ID.Folder);
  const n = r.count();
  if (r.byte() !== 0) throw bad('external folder data is not supported');
  const folders = Array.from({ length: n }, () => readFolder(r));
  r.expect(ID.CodersUnpackSize);
  for (const f of folders) f.unpackSizes = Array.from({ length: f.totalOut }, () => r.num());
  for (;;) {
    const id = r.byte();
    if (id === ID.End) break;
    if (id === ID.CRC) r.digests(n).forEach((c, i) => (folders[i].crc = c));
    else throw bad(`unknown unpack info property ${id}`);
  }
  return folders;
}

/** The folder's final output: the one coder output that isn't bound to another coder's input. */
const mainOut = (f) => [...Array(f.totalOut).keys()].find((o) => !f.bindPairs.some((b) => b.outIndex === o));
const folderSize = (f) => f.unpackSizes[mainOut(f)];

function readSubStreamsInfo(r, folders) {
  let counts = folders.map(() => 1);
  let id = r.byte();
  if (id === ID.NumUnpackStream) {
    counts = folders.map(() => r.count());
    id = r.byte();
  }
  const streams = [];
  const hasSizes = id === ID.Size;
  folders.forEach((f, i) => {
    if (!counts[i]) return;
    let sum = 0;
    for (let j = 1; j < counts[i]; j++) {
      const size = hasSizes ? r.num() : 0;
      sum += size;
      streams.push({ folder: i, size, crc: null });
    }
    if (sum > folderSize(f)) throw bad('substream sizes exceed the folder');
    streams.push({ folder: i, size: folderSize(f) - sum, crc: counts[i] === 1 ? f.crc : null });
  });
  if (hasSizes) id = r.byte();
  for (;;) {
    if (id === ID.End) break;
    if (id === ID.CRC) {
      const missing = streams.filter((s) => s.crc === null);
      r.digests(missing.length).forEach((c, k) => (missing[k].crc = c));
    } else {
      throw bad(`unknown substream property ${id}`);
    }
    id = r.byte();
  }
  return streams;
}

function readStreamsInfo(r) {
  let pack = null;
  let folders = [];
  let streams = null;
  for (;;) {
    const id = r.byte();
    if (id === ID.End) break;
    if (id === ID.PackInfo) pack = readPackInfo(r);
    else if (id === ID.UnpackInfo) folders = readUnpackInfo(r);
    else if (id === ID.SubStreamsInfo) streams = readSubStreamsInfo(r, folders);
    else throw bad(`unknown streams property ${id}`);
  }
  if (!streams) streams = folders.map((f, i) => ({ folder: i, size: folderSize(f), crc: f.crc }));
  return { pack, folders, streams };
}

function readFilesInfo(r) {
  const n = r.count();
  let emptyStream = new Array(n).fill(false);
  let emptyFile = null;
  let names = null;
  let attrs = new Array(n).fill(null);
  for (;;) {
    const type = r.num();
    if (type === ID.End) break;
    const size = r.num();
    const end = r.p + size;
    if (end > r.b.length) throw bad('truncated file list');
    if (type === ID.EmptyStream) emptyStream = r.bits(n);
    else if (type === ID.EmptyFile) emptyFile = r.bits(emptyStream.filter(Boolean).length);
    else if (type === ID.Name) {
      if (r.byte() !== 0) throw bad('external file names are not supported');
      names = Buffer.from(r.bytes(end - r.p)).toString('utf16le').split('\0').slice(0, n);
    } else if (type === ID.WinAttributes) {
      const defined = r.definedBits(n);
      if (r.byte() !== 0) throw bad('external attributes are not supported');
      attrs = defined.map((d) => (d ? r.u32() : null));
    }
    r.p = end; // times, kDummy padding, anti items … are skipped
  }
  if (!names || names.length !== n) throw bad('file names missing');
  let k = 0;
  return names.map((name, i) => {
    const empty = emptyStream[i];
    const isEmptyFile = empty ? !!emptyFile?.[k++] : false;
    // FILE_ATTRIBUTE_DIRECTORY, or an empty stream that isn't an empty file
    const dir = empty && (!isEmptyFile || ((attrs[i] ?? 0) & 0x10) !== 0);
    return { name, dir, empty, attributes: attrs[i] };
  });
}

// ---- coders ----------------------------------------------------------------------------------

/** x86 branch converter (BCJ), decoding direction – LZMA SDK Bra86.c. */
export function bcjX86Decode(data) {
  const MASK_ALLOWED = [true, true, true, false, true, false, false, false];
  const MASK_BIT = [0, 1, 2, 2, 3, 3, 3, 3];
  const msb = (b) => b === 0 || b === 0xff;
  const size = data.length;
  if (size < 5) return data;
  const ip = 5;
  let pos = 0;
  let prevPos = -1;
  let prevMask = 0;
  for (;;) {
    while (pos < size - 4 && (data[pos] & 0xfe) !== 0xe8) pos++;
    if (pos >= size - 4) break;
    const d = pos - prevPos;
    if (d > 3) prevMask = 0;
    else {
      prevMask = (prevMask << (d - 1)) & 7;
      if (prevMask !== 0) {
        const b = data[pos + 4 - MASK_BIT[prevMask]];
        if (!MASK_ALLOWED[prevMask] || msb(b)) {
          prevPos = pos;
          prevMask = ((prevMask << 1) & 7) | 1;
          pos++;
          continue;
        }
      }
    }
    prevPos = pos;
    if (msb(data[pos + 4])) {
      let src = (data[pos + 1] | (data[pos + 2] << 8) | (data[pos + 3] << 16) | (data[pos + 4] << 24)) >>> 0;
      let dest;
      for (;;) {
        dest = (src - (ip + pos)) >>> 0;
        if (prevMask === 0) break;
        const index = MASK_BIT[prevMask] * 8;
        const b = (dest >>> (24 - index)) & 0xff;
        if (!msb(b)) break;
        src = (dest ^ (2 ** (32 - index) - 1)) >>> 0;
      }
      data[pos + 4] = ((dest >>> 24) & 1) ? 0xff : 0;
      data[pos + 3] = (dest >>> 16) & 0xff;
      data[pos + 2] = (dest >>> 8) & 0xff;
      data[pos + 1] = dest & 0xff;
      pos += 5;
    } else {
      prevMask = ((prevMask << 1) & 7) | 1;
      pos++;
    }
  }
  return data;
}

/**
 * BCJ2 (7-Zip's 4-stream x86 branch converter), decoding direction – LZMA SDK Bcj2Dec (classic format):
 * `main` holds the code with the call / jump targets taken out, `call` and `jump` the absolute targets
 * (big endian), `rc` a range-coded stream of "was this E8 / E9 / Jcc converted?" bits.
 */
export function bcj2Decode(main, call, jump, rc, outSize) {
  const out = new Uint8Array(outSize);
  const probs = new Uint16Array(258).fill(1024);
  let rp = 0;
  const rcByte = () => {
    if (rp >= rc.length) throw bad('BCJ2 range coder stream ended early');
    return rc[rp++];
  };
  let code = 0;
  let range = 0xffffffff;
  for (let i = 0; i < 5; i++) code = ((code * 256) + rcByte()) >>> 0;
  let ip = 0;
  let cp = 0;
  let jp = 0;
  let op = 0;
  let prev = 0;
  const isJ = (b0, b1) => (b1 & 0xfe) === 0xe8 || (b0 === 0x0f && (b1 & 0xf0) === 0x80);
  while (op < outSize) {
    // copy plain bytes up to (and including) the next branch opcode
    let b = 0;
    let branch = false;
    while (op < outSize && ip < main.length) {
      b = main[ip++];
      out[op++] = b;
      if (isJ(prev, b)) {
        branch = true;
        break;
      }
      prev = b;
    }
    if (!branch || op === outSize) break;
    const p = b === 0xe8 ? prev : b === 0xe9 ? 256 : 257;
    const prob = probs[p];
    const bound = (range >>> 11) * prob;
    let converted;
    if (code < bound) {
      range = bound;
      probs[p] = prob + ((2048 - prob) >>> 5);
      converted = false;
    } else {
      range = (range - bound) >>> 0;
      code = (code - bound) >>> 0;
      probs[p] = prob - (prob >>> 5);
      converted = true;
    }
    if (range < 0x1000000) {
      range = (range * 256) >>> 0;
      code = ((code * 256) + rcByte()) >>> 0;
    }
    if (!converted) {
      prev = b;
      continue;
    }
    const src = b === 0xe8 ? call : jump;
    let at = b === 0xe8 ? cp : jp;
    if (at + 4 > src.length) throw bad('BCJ2 branch stream ended early');
    const abs = ((src[at] << 24) | (src[at + 1] << 16) | (src[at + 2] << 8) | src[at + 3]) >>> 0;
    at += 4;
    if (b === 0xe8) cp = at;
    else jp = at;
    const dest = (abs - (op + 4)) >>> 0;
    for (let k = 0; k < 4 && op < outSize; k++) out[op++] = (dest >>> (8 * k)) & 0xff;
    prev = (dest >>> 24) & 0xff;
  }
  if (op !== outSize) throw bad('BCJ2 data ended early');
  return out;
}

function runCoder(coder, inputs, size) {
  if (size > MAX_UNPACKED) throw bad('archive is too large');
  switch (coder.id) {
    case CODERS.COPY:
      return inputs[0].subarray(0, size);
    case CODERS.LZMA:
      return decodeLzma(inputs[0], coder.props, size);
    case CODERS.LZMA2:
      return decodeLzma2(inputs[0], size);
    case CODERS.DEFLATE:
      return new Uint8Array(inflateRawSync(inputs[0], { maxOutputLength: Math.max(1, size) }));
    case CODERS.BCJ:
      return bcjX86Decode(new Uint8Array(inputs[0].subarray(0, size)));
    case CODERS.BCJ2:
      return bcj2Decode(inputs[0], inputs[1], inputs[2], inputs[3], size);
    case CODERS.AES:
      throw bad('the archive is encrypted');
    default:
      throw bad(`unsupported compression method ${coder.id}`);
  }
}

/** Unpacks one folder (a group of coders fed by packed streams) to its main output. */
function decodeFolder(buf, folder, packStreams) {
  const outputs = new Map();
  const outputOf = (outIndex, depth = 0) => {
    if (depth > 32) throw bad('coder graph is cyclic');
    if (outputs.has(outIndex)) return outputs.get(outIndex);
    const coder = folder.coders.find((c) => outIndex >= c.outStart && outIndex < c.outStart + c.numOut);
    if (!coder || coder.numOut !== 1) throw bad('unsupported coder layout');
    const inputs = [];
    for (let j = 0; j < coder.numIn; j++) {
      const inIndex = coder.inStart + j;
      const bound = folder.bindPairs.find((b) => b.inIndex === inIndex);
      if (bound) inputs.push(outputOf(bound.outIndex, depth + 1));
      else {
        const k = folder.packed.indexOf(inIndex);
        if (k < 0 || !packStreams[k]) throw bad('coder input missing');
        inputs.push(packStreams[k]);
      }
    }
    const data = runCoder(coder, inputs, folder.unpackSizes[outIndex]);
    if (data.length !== folder.unpackSizes[outIndex]) throw bad('unpacked size mismatch');
    outputs.set(outIndex, data);
    return data;
  };
  const data = outputOf(mainOut(folder));
  if (folder.crc !== null && crc32(data) !== folder.crc) throw bad('CRC error (damaged archive)');
  return data;
}

/** Packed streams of every folder, as slices of the archive. */
function packSlices(buf, info) {
  const { pack, folders } = info;
  if (!pack) return [];
  let pos = 32 + pack.packPos;
  const all = pack.sizes.map((size) => {
    if (pos + size > buf.length) throw bad('packed data out of range (truncated archive?)');
    const s = buf.subarray(pos, pos + size);
    pos += size;
    return s;
  });
  let k = 0;
  return folders.map((f) => {
    const mine = all.slice(k, k + f.packed.length);
    k += f.packed.length;
    return mine;
  });
}

/**
 * Lists and unpacks a .7z archive held in memory: [{ name, dir, data? }] with '/' as the separator inside names.
 * Throws (code BAD_7Z) for anything it can't read with certainty.
 */
export function read7z(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (buf.length < 32 || !SIGNATURE.every((b, i) => buf[i] === b)) throw bad('not a 7-Zip archive');
  const start = new Reader(buf.subarray(12, 32));
  const nextOffset = start.u64();
  const nextSize = start.u64();
  if (32 + nextOffset + nextSize > buf.length) throw bad('header out of range (truncated archive?)');
  let header = buf.subarray(32 + nextOffset, 32 + nextOffset + nextSize);
  for (let round = 0; ; round++) {
    if (round > 4) throw bad('too many encoded headers');
    const r = new Reader(header);
    const id = r.byte();
    if (id === ID.Header) {
      header = r;
      break;
    }
    if (id !== ID.EncodedHeader) throw bad('unknown header type');
    const info = readStreamsInfo(r);
    if (!info.folders.length) throw bad('empty encoded header');
    header = decodeFolder(buf, info.folders[0], packSlices(buf, info)[0]);
  }
  const r = header;
  let main = { pack: null, folders: [], streams: [] };
  let files = [];
  for (;;) {
    const id = r.byte();
    if (id === ID.End) break;
    if (id === ID.ArchiveProperties) {
      for (let t = r.num(); t !== 0; t = r.num()) r.bytes(r.num());
    } else if (id === ID.AdditionalStreamsInfo) readStreamsInfo(r);
    else if (id === ID.MainStreamsInfo) main = readStreamsInfo(r);
    else if (id === ID.FilesInfo) files = readFilesInfo(r);
    else throw bad(`unknown header property ${id}`);
  }
  const total = main.folders.reduce((n, f) => n + folderSize(f), 0);
  if (total > MAX_UNPACKED) throw bad('archive is too large');
  const slices = packSlices(buf, main);
  const folderData = new Map();
  const offsets = new Map();
  let s = 0;
  return files.map((f) => {
    const name = f.name.replace(/\\/g, '/');
    if (f.dir) return { name, dir: true };
    if (f.empty) return { name, dir: false, data: new Uint8Array(0) };
    const stream = main.streams[s++];
    if (!stream) throw bad('more files than data streams');
    if (!folderData.has(stream.folder)) {
      folderData.set(stream.folder, decodeFolder(buf, main.folders[stream.folder], slices[stream.folder]));
      offsets.set(stream.folder, 0);
    }
    const at = offsets.get(stream.folder);
    const data = folderData.get(stream.folder).subarray(at, at + stream.size);
    offsets.set(stream.folder, at + stream.size);
    if (data.length !== stream.size) throw bad('file data out of range');
    if (stream.crc !== null && crc32(data) !== stream.crc) throw bad(`CRC error in ${name} (damaged archive)`);
    return { name, dir: false, data };
  });
}
