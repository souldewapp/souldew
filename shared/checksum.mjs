// CRC32 (IEEE, as used by ROM databases / patch readmes) and Adler-32 (xdelta3 window checksums).

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

export function crc32(data, crc = 0) {
  const t = crcTable();
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function crc32Hex(data) {
  return crc32(data).toString(16).toUpperCase().padStart(8, '0');
}

export function adler32(data, start = 0, end = data.length) {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  let i = start;
  while (i < end) {
    // 5552 is the largest n such that 255n(n+1)/2 + (n+1)(MOD-1) <= 2^32-1
    const stop = Math.min(i + 5552, end);
    for (; i < stop; i++) {
      a += data[i];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}
