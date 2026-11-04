// Minimal XZ / LZMA2 decoder (single-call, whole buffer in → whole buffer out).
// xdelta3 compresses VCDIFF sections with liblzma's "easy" encoder, which produces a
// plain .xz stream with one LZMA2 filter — that is all this decoder supports.

const LZMA2_FILTER_ID = 0x21;

export function decodeXz(input, expectedSize) {
  return new XzStreamDecoder().decode(input, expectedSize);
}

/** A raw LZMA2 stream (no .xz container) of known size – how 7-Zip archives store LZMA2 data. */
export function decodeLzma2(input, size) {
  const d = new XzStreamDecoder();
  d.started = true;
  return d.decode(input, size);
}

/**
 * A raw LZMA ("LZMA1") stream of known size, as in 7-Zip archives: `props` are the coder's 5 property bytes
 * (lc/lp/pb, dictionary size – the latter doesn't matter, the whole output is the history).
 */
export function decodeLzma(input, props, size) {
  if (!props || props.length < 1) throw new Error('lzma: missing properties');
  if (!(size >= 0) || size > 1024 * 1024 * 1024) throw new Error('lzma: stream is implausibly large');
  const lz = new LzmaState();
  lz.setProps(props[0], { lzma1: true });
  lz.resetState();
  const out = new Uint8Array(size);
  if (size > 0) lz.decodeChunk(input, 0, out, 0, size, 0);
  return out;
}

/**
 * Incremental decoder. xdelta3 keeps ONE liblzma stream per section type (data / inst / addr)
 * alive for the whole patch: the .xz stream + block header appear only in the first window's
 * section, later windows just continue with more LZMA2 chunks (sync-flushed), and matches may
 * reference bytes produced for earlier windows. So the dictionary and coder state persist here.
 */
export class XzStreamDecoder {
  constructor() {
    this.started = false;
    this.checkSize = 0;
    this.dict = new Uint8Array(1 << 16);
    this.dictLen = 0;
    this.dictStart = 0;
    this.lz = new LzmaState();
    this.finished = false;
  }

  _ensure(n) {
    if (this.dictLen + n <= this.dict.length) return;
    // a corrupt size field must not allocate gigabytes
    if (!(n >= 0) || this.dictLen + n > 1024 * 1024 * 1024) throw new Error('xz: stream is implausibly large (corrupt patch?)');
    let size = this.dict.length * 2;
    while (size < this.dictLen + n) size *= 2;
    const bigger = new Uint8Array(size);
    bigger.set(this.dict.subarray(0, this.dictLen));
    this.dict = bigger;
  }

  _readHeaders(r) {
    const magic = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
    for (let i = 0; i < 6; i++) {
      if (r.buf[r.pos + i] !== magic[i]) throw new Error('xz: bad stream magic');
    }
    const checkType = r.buf[r.pos + 7] & 0x0f;
    this.checkSize = checkType === 0 ? 0 : checkType <= 3 ? 4 : checkType <= 6 ? 8 : checkType <= 9 ? 16 : checkType <= 12 ? 32 : 64;
    r.pos += 12;
    this._readBlockHeader(r);
  }

  _readBlockHeader(r) {
    const headerSize = (r.buf[r.pos] + 1) * 4;
    const headerEnd = r.pos + headerSize;
    r.pos++;
    const flags = r.buf[r.pos++];
    const filterCount = (flags & 0x03) + 1;
    if (flags & 0x40) readMultibyte(r); // compressed size
    if (flags & 0x80) readMultibyte(r); // uncompressed size
    let found = false;
    for (let f = 0; f < filterCount; f++) {
      const id = readMultibyte(r);
      const propSize = readMultibyte(r);
      if (id !== LZMA2_FILTER_ID || f !== filterCount - 1) throw new Error(`xz: unsupported filter 0x${id.toString(16)}`);
      r.pos += propSize; // dictionary size — irrelevant, we keep the whole history
      found = true;
    }
    if (!found) throw new Error('xz: no LZMA2 filter');
    r.pos = headerEnd; // skip padding + header CRC32
  }

  /** Decode the next piece of the stream. Returns exactly `expectedSize` bytes when given. */
  decode(input, expectedSize) {
    const r = { buf: input, pos: 0 };
    if (!this.started) {
      this._readHeaders(r);
      this.started = true;
    }
    const begin = this.dictLen;
    const lz = this.lz;
    while (r.pos < input.length) {
      // xdelta3 sync-flushes after each window: no end marker, index or footer follows, so stop
      // as soon as the expected number of bytes has been produced.
      if (expectedSize !== undefined && this.dictLen - begin >= expectedSize) break;
      const control = input[r.pos++];
      if (control === 0x00) {
        // End of LZMA2 data → block padding, check, then either a new block or the index.
        while (r.pos & 3) r.pos++;
        r.pos += this.checkSize;
        if (r.pos < input.length && input[r.pos] !== 0x00) {
          this._readBlockHeader(r);
          continue;
        }
        this.finished = true;
        break;
      }
      if (control === 0x01 || control === 0x02) {
        const size = ((input[r.pos] << 8) | input[r.pos + 1]) + 1;
        r.pos += 2;
        if (control === 0x01) this.dictStart = this.dictLen;
        this._ensure(size);
        this.dict.set(input.subarray(r.pos, r.pos + size), this.dictLen);
        this.dictLen += size;
        r.pos += size;
        continue;
      }
      if (control < 0x80) throw new Error(`xz: bad LZMA2 control byte 0x${control.toString(16)}`);
      const unpacked = ((control & 0x1f) << 16) + ((input[r.pos] << 8) | input[r.pos + 1]) + 1;
      const packed = ((input[r.pos + 2] << 8) | input[r.pos + 3]) + 1;
      r.pos += 4;
      const reset = (control >> 5) & 0x03;
      if (reset === 3) this.dictStart = this.dictLen;
      if (reset >= 2) lz.setProps(input[r.pos++]);
      if (reset >= 1) lz.resetState();
      this._ensure(unpacked);
      const chunkEnd = r.pos + packed;
      lz.decodeChunk(input, r.pos, this.dict, this.dictLen, unpacked, this.dictStart);
      this.dictLen += unpacked;
      r.pos = chunkEnd;
    }
    const produced = this.dictLen - begin;
    if (expectedSize !== undefined && produced !== expectedSize) {
      throw new Error(`xz: expected ${expectedSize} bytes, decoded ${produced}`);
    }
    return this.dict.slice(begin, this.dictLen);
  }
}

function readMultibyte(r) {
  let value = 0;
  let shift = 1;
  for (let i = 0; i < 9; i++) {
    const b = r.buf[r.pos++];
    value += (b & 0x7f) * shift;
    if (!(b & 0x80)) return value;
    shift *= 128;
  }
  throw new Error('xz: bad multibyte integer');
}

// ---------------------------------------------------------------------------
// LZMA core

const NUM_STATES = 12;
const POS_STATES_MAX = 16;
const LEN_LOW = 0;
const LEN_MID = LEN_LOW + POS_STATES_MAX * 8;
const LEN_HIGH = LEN_MID + POS_STATES_MAX * 8;
const LEN_CHOICE = LEN_HIGH + 256;
const LEN_CHOICE2 = LEN_CHOICE + 1;
const LEN_SIZE = LEN_CHOICE2 + 1;

class LzmaState {
  constructor() {
    this.lc = 3;
    this.lp = 0;
    this.pb = 2;
    this.isMatch = new Uint16Array(NUM_STATES * POS_STATES_MAX);
    this.isRep = new Uint16Array(NUM_STATES);
    this.isRepG0 = new Uint16Array(NUM_STATES);
    this.isRepG1 = new Uint16Array(NUM_STATES);
    this.isRepG2 = new Uint16Array(NUM_STATES);
    this.isRep0Long = new Uint16Array(NUM_STATES * POS_STATES_MAX);
    this.posSlot = new Uint16Array(4 * 64);
    this.posSpecial = new Uint16Array(115);
    this.align = new Uint16Array(16);
    this.lenProbs = new Uint16Array(LEN_SIZE);
    this.repLenProbs = new Uint16Array(LEN_SIZE);
    this.literal = new Uint16Array(0x300 << 4);
    this.resetState();
  }

  setProps(byte, { lzma1 = false } = {}) {
    if (byte > 224) throw new Error('xz: bad LZMA properties');
    this.lc = byte % 9;
    byte = (byte / 9) | 0;
    this.lp = byte % 5;
    this.pb = (byte / 5) | 0;
    // LZMA2 limits lc + lp to 4; plain LZMA allows more (up to 12 → a 12 MB literal table, fine)
    if (!lzma1 && this.lc + this.lp > 4) throw new Error('xz: lc + lp > 4 is invalid in LZMA2');
    this.literal = new Uint16Array(0x300 << (this.lc + this.lp));
    this.literal.fill(1024);
  }

  resetState() {
    for (const p of [this.isMatch, this.isRep, this.isRepG0, this.isRepG1, this.isRepG2, this.isRep0Long,
      this.posSlot, this.posSpecial, this.align, this.lenProbs, this.repLenProbs, this.literal]) {
      p.fill(1024);
    }
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }

  decodeChunk(inBuf, inPos, out, outPos, size, dictStart) {
    // Range decoder (inlined into locals for speed).
    let pos = inPos;
    if (inBuf[pos] !== 0) throw new Error('xz: bad range coder init');
    let range = 0xffffffff;
    let code = ((inBuf[pos + 1] << 24) | (inBuf[pos + 2] << 16) | (inBuf[pos + 3] << 8) | inBuf[pos + 4]) >>> 0;
    pos += 5;

    const bit = (probs, i) => {
      const p = probs[i];
      const bound = (range >>> 11) * p;
      let b;
      if (code < bound) {
        range = bound;
        probs[i] = p + ((2048 - p) >>> 5);
        b = 0;
      } else {
        range = (range - bound) >>> 0;
        code = (code - bound) >>> 0;
        probs[i] = p - (p >>> 5);
        b = 1;
      }
      if (range < 0x1000000) {
        range = (range * 256) >>> 0;
        code = ((code * 256) + inBuf[pos++]) >>> 0;
      }
      return b;
    };
    const bitTree = (probs, base, numBits) => {
      let m = 1;
      for (let i = 0; i < numBits; i++) m = (m << 1) | bit(probs, base + m);
      return m - (1 << numBits);
    };
    const reverseBitTree = (probs, base, numBits) => {
      let m = 1;
      let sym = 0;
      for (let i = 0; i < numBits; i++) {
        const b = bit(probs, base + m);
        m = (m << 1) | b;
        sym |= b << i;
      }
      return sym;
    };
    const directBits = (numBits) => {
      let result = 0;
      for (let i = 0; i < numBits; i++) {
        range >>>= 1;
        let b = 0;
        if (code >= range) {
          code = (code - range) >>> 0;
          b = 1;
        }
        result = result * 2 + b;
        if (range < 0x1000000) {
          range = (range * 256) >>> 0;
          code = ((code * 256) + inBuf[pos++]) >>> 0;
        }
      }
      return result;
    };
    const decodeLen = (probs, posState) => {
      if (!bit(probs, LEN_CHOICE)) return bitTree(probs, LEN_LOW + posState * 8, 3);
      if (!bit(probs, LEN_CHOICE2)) return 8 + bitTree(probs, LEN_MID + posState * 8, 3);
      return 16 + bitTree(probs, LEN_HIGH, 8);
    };

    const { lc, lp, pb, literal, isMatch, isRep, isRepG0, isRepG1, isRepG2, isRep0Long } = this;
    const pbMask = (1 << pb) - 1;
    const lpMask = (1 << lp) - 1;
    let { state, rep0, rep1, rep2, rep3 } = this;
    const end = outPos + size;
    let o = outPos;

    while (o < end) {
      const rel = o - dictStart;
      const posState = rel & pbMask;
      if (!bit(isMatch, (state << 4) + posState)) {
        const prev = o > dictStart ? out[o - 1] : 0;
        const base = 0x300 * (((rel & lpMask) << lc) + (prev >> (8 - lc)));
        let sym = 1;
        if (state < 7) {
          while (sym < 0x100) sym = (sym << 1) | bit(literal, base + sym);
        } else {
          let matchByte = out[o - rep0 - 1];
          while (sym < 0x100) {
            const matchBit = (matchByte >> 7) & 1;
            matchByte <<= 1;
            const b = bit(literal, base + ((1 + matchBit) << 8) + sym);
            sym = (sym << 1) | b;
            if (matchBit !== b) {
              while (sym < 0x100) sym = (sym << 1) | bit(literal, base + sym);
              break;
            }
          }
        }
        out[o++] = sym & 0xff;
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }

      let len;
      if (!bit(isRep, state)) {
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        len = decodeLen(this.lenProbs, posState);
        state = state < 7 ? 7 : 10;
        const lenState = len < 3 ? len : 3;
        const slot = bitTree(this.posSlot, lenState * 64, 6);
        if (slot < 4) {
          rep0 = slot;
        } else {
          const numDirect = (slot >> 1) - 1;
          let dist = (2 | (slot & 1)) * 2 ** numDirect;
          if (slot < 14) {
            dist += reverseBitTree(this.posSpecial, dist - slot - 1, numDirect);
          } else {
            dist += directBits(numDirect - 4) * 16;
            dist += reverseBitTree(this.align, 0, 4);
          }
          rep0 = dist;
        }
        if (rep0 === 0xffffffff) break; // end marker (not used inside LZMA2, but harmless)
      } else {
        if (!bit(isRepG0, state)) {
          if (!bit(isRep0Long, (state << 4) + posState)) {
            state = state < 7 ? 9 : 11;
            out[o] = out[o - rep0 - 1];
            o++;
            continue;
          }
        } else {
          let dist;
          if (!bit(isRepG1, state)) {
            dist = rep1;
          } else {
            if (!bit(isRepG2, state)) {
              dist = rep2;
            } else {
              dist = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = dist;
        }
        len = decodeLen(this.repLenProbs, posState);
        state = state < 7 ? 8 : 11;
      }

      const n = len + 2;
      const from = o - rep0 - 1;
      if (from < dictStart) throw new Error('xz: match distance out of range');
      if (o + n > end) throw new Error('xz: match exceeds chunk');
      for (let i = 0; i < n; i++) out[o + i] = out[from + i];
      o += n;
    }

    this.state = state;
    this.rep0 = rep0;
    this.rep1 = rep1;
    this.rep2 = rep2;
    this.rep3 = rep3;
  }
}
