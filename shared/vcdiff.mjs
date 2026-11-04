// VCDIFF (RFC 3284) decoder with the xdelta3 extensions used by real-world ROM hack patches:
// secondary compression (LZMA → .xz streams), per-window Adler-32 checksums and app headers.
// Works in Node and in the browser (pure Uint8Array code).

import { XzStreamDecoder } from './xz.mjs';
import { adler32 } from './checksum.mjs';

const VCD_DECOMPRESS = 0x01;
const VCD_CODETABLE = 0x02;
const VCD_APPHEADER = 0x04;
const VCD_SOURCE = 0x01;
const VCD_TARGET = 0x02;
const VCD_ADLER32 = 0x04;
const VCD_DATACOMP = 0x01;
const VCD_INSTCOMP = 0x02;
const VCD_ADDRCOMP = 0x04;

const NOOP = 0;
const ADD = 1;
const RUN = 2;
const COPY = 3;

const SECONDARY_NAMES = { 1: 'DJW', 2: 'LZMA', 16: 'FGK' };

/** RFC 3284 §5.6 default code table: [type1, size1, mode1, type2, size2, mode2] per opcode. */
function buildDefaultCodeTable() {
  const table = [];
  table.push([RUN, 0, 0, NOOP, 0, 0]);
  for (let size = 0; size <= 17; size++) table.push([ADD, size, 0, NOOP, 0, 0]);
  for (let mode = 0; mode <= 8; mode++) {
    table.push([COPY, 0, mode, NOOP, 0, 0]);
    for (let size = 4; size <= 18; size++) table.push([COPY, size, mode, NOOP, 0, 0]);
  }
  for (let mode = 0; mode <= 5; mode++) {
    for (let add = 1; add <= 4; add++) {
      for (let copy = 4; copy <= 6; copy++) table.push([ADD, add, 0, COPY, copy, mode]);
    }
  }
  for (let mode = 6; mode <= 8; mode++) {
    for (let add = 1; add <= 4; add++) table.push([ADD, add, 0, COPY, 4, mode]);
  }
  for (let mode = 0; mode <= 8; mode++) table.push([COPY, 4, mode, ADD, 1, 0]);
  if (table.length !== 256) throw new Error('code table construction bug');
  return table;
}
const CODE_TABLE = buildDefaultCodeTable();

class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }
  byte() {
    if (this.pos >= this.end) throw new Error('vcdiff: unexpected end of data');
    return this.buf[this.pos++];
  }
  varint() {
    let v = 0;
    for (let i = 0; i < 10; i++) {
      const b = this.byte();
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error('vcdiff: varint too long');
  }
  bytes(n) {
    if (this.pos + n > this.end) throw new Error('vcdiff: section exceeds data');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** Parse just the header — handy for showing patch info in the UI. */
export function inspectVcdiff(patch) {
  if (patch[0] !== 0xd6 || patch[1] !== 0xc3 || patch[2] !== 0xc4) throw new Error('Not a VCDIFF/xdelta patch');
  const r = new Reader(patch, 4);
  const hdr = r.byte();
  const info = { secondary: null, appHeader: null, sourceName: null, targetName: null };
  if (hdr & VCD_DECOMPRESS) info.secondary = SECONDARY_NAMES[r.byte()] || 'unknown';
  if (hdr & VCD_CODETABLE) throw new Error('Custom VCDIFF code tables are not supported');
  if (hdr & VCD_APPHEADER) {
    const len = r.varint();
    info.appHeader = new TextDecoder().decode(r.bytes(len));
    // xdelta3 app header: "target//source/" (+ optional compression flags)
    const parts = info.appHeader.split('/');
    const clean = (s) => (s || '').split(/[\\/]/).pop();
    info.targetName = clean(parts[0]);
    info.sourceName = clean(parts[2]);
  }
  info.headerEnd = r.pos;
  return info;
}

/**
 * Apply a VCDIFF patch.
 * @param {Uint8Array} source  the original ROM
 * @param {Uint8Array} patch   the .xdelta / .vcdiff file
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Uint8Array} target
 */
export function applyVcdiff(source, patch, onProgress) {
  const info = inspectVcdiff(patch);
  const hdr = patch[4];
  const secondaryId = hdr & VCD_DECOMPRESS ? patch[5] : 0;
  const r = new Reader(patch, info.headerEnd);

  let targetLength = 0;
  // xdelta3 may reference already-written target data (VCD_TARGET); keep a growable view.
  let target = new Uint8Array(Math.max(source.length, 1 << 20));
  const grow = (need) => {
    if (need <= target.length) return;
    // a corrupt window length must not allocate gigabytes (biggest NDS ROMs are 512 MB)
    if (need > 512 * 1024 * 1024) throw new Error('vcdiff: target is implausibly large (corrupt patch?)');
    let size = target.length * 2;
    while (size < need) size *= 2;
    size = Math.max(need, Math.min(size, 512 * 1024 * 1024));
    const t = new Uint8Array(size);
    t.set(target.subarray(0, targetLength));
    target = t;
  };

  const nearSize = 4;
  const sameSize = 3;
  const near = new Array(nearSize).fill(0);
  const same = new Array(sameSize * 256).fill(0);
  let windowIndex = 0;
  const streams = [new XzStreamDecoder(), new XzStreamDecoder(), new XzStreamDecoder()];

  while (r.pos < patch.length) {
    const winIndicator = r.byte();
    let segLen = 0;
    let segPos = 0;
    let segFromTarget = false;
    if (winIndicator & (VCD_SOURCE | VCD_TARGET)) {
      segLen = r.varint();
      segPos = r.varint();
      segFromTarget = !!(winIndicator & VCD_TARGET);
    }
    const deltaLength = r.varint();
    const deltaEnd = r.pos + deltaLength;
    const windowLength = r.varint();
    const deltaIndicator = r.byte();
    const dataLen = r.varint();
    const instLen = r.varint();
    const addrLen = r.varint();
    let expectedAdler = null;
    if (winIndicator & VCD_ADLER32) {
      const b = r.bytes(4);
      expectedAdler = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    }
    let data = r.bytes(dataLen);
    let inst = r.bytes(instLen);
    let addr = r.bytes(addrLen);
    if (r.pos !== deltaEnd) throw new Error(`vcdiff: window ${windowIndex} length mismatch`);

    if (deltaIndicator & (VCD_DATACOMP | VCD_INSTCOMP | VCD_ADDRCOMP)) {
      if (secondaryId !== 2) {
        throw new Error(`Patch uses ${SECONDARY_NAMES[secondaryId] || 'unknown'} secondary compression, only LZMA is supported`);
      }
      const unpack = (section, stream) => {
        const sr = new Reader(section);
        const size = sr.varint();
        return stream.decode(section.subarray(sr.pos), size);
      };
      if (deltaIndicator & VCD_DATACOMP) data = unpack(data, streams[0]);
      if (deltaIndicator & VCD_INSTCOMP) inst = unpack(inst, streams[1]);
      if (deltaIndicator & VCD_ADDRCOMP) addr = unpack(addr, streams[2]);
    }

    grow(targetLength + windowLength); // before taking a target subarray (grow reallocates)
    let segment;
    if (segFromTarget) {
      segment = target.subarray(segPos, segPos + segLen);
    } else {
      if (segPos + segLen > source.length) throw new Error('Patch expects a larger source ROM — wrong base ROM?');
      segment = source.subarray(segPos, segPos + segLen);
    }

    // Decode the window
    const winStart = targetLength;
    const dr = new Reader(data);
    const ir = new Reader(inst);
    const ar = new Reader(addr);
    near.fill(0);
    same.fill(0);
    let nextNear = 0;
    let t = 0; // position inside the target window

    const decodeAddress = (here, mode) => {
      let a;
      if (mode === 0) a = ar.varint();
      else if (mode === 1) a = here - ar.varint();
      else if (mode - 2 < nearSize) a = near[mode - 2] + ar.varint();
      else {
        const m = mode - (2 + nearSize);
        a = same[m * 256 + ar.byte()];
      }
      near[nextNear] = a;
      nextNear = (nextNear + 1) % nearSize;
      same[a % (sameSize * 256)] = a;
      return a;
    };

    const execute = (type, size, mode) => {
      if (type === NOOP) return;
      if (size === 0) size = ir.varint();
      if (t + size > windowLength) throw new Error('vcdiff: instruction exceeds target window');
      const o = winStart + t;
      if (type === ADD) {
        target.set(dr.bytes(size), o);
      } else if (type === RUN) {
        target.fill(dr.byte(), o, o + size);
      } else {
        const a = decodeAddress(segLen + t, mode);
        if (a < segLen) {
          // May straddle the end of the source segment into the target window.
          const fromSeg = Math.min(size, segLen - a);
          target.set(segment.subarray(a, a + fromSeg), o);
          for (let i = fromSeg; i < size; i++) target[o + i] = target[winStart + (a + i - segLen)];
        } else {
          const from = winStart + (a - segLen);
          // Overlapping copies must be done byte by byte (run-length style).
          if (from + size <= o) target.copyWithin(o, from, from + size);
          else for (let i = 0; i < size; i++) target[o + i] = target[from + i];
        }
      }
      t += size;
    };

    while (ir.pos < ir.end) {
      const op = CODE_TABLE[ir.byte()];
      execute(op[0], op[1], op[2]);
      execute(op[3], op[4], op[5]);
    }
    if (t !== windowLength) throw new Error(`vcdiff: window ${windowIndex} produced ${t} of ${windowLength} bytes`);
    if (expectedAdler !== null) {
      const got = adler32(target, winStart, winStart + windowLength);
      if (got !== expectedAdler) {
        throw new Error(`Checksum mismatch in patch window ${windowIndex} — the base ROM is probably not the expected version`);
      }
    }
    targetLength += windowLength;
    windowIndex++;
    if (onProgress) onProgress(r.pos, patch.length);
  }
  return target.slice(0, targetLength);
}
