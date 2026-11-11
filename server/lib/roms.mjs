// Verifying and patching base ROMs (cached on disk by patch hash + base CRC).
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { CACHE_DIR } from './paths.mjs';
import { loadFile, resolveId, ctrInfo } from './library.mjs';
import { crc32Hex } from '../../shared/checksum.mjs';
import { applyPatch, detectPatchFormat } from '../../shared/patchers.mjs';
import { identifyRom, isCtrExt } from '../../shared/romid.mjs';
import { writeFileAtomic, httpError } from './fsutil.mjs';

/** Known patches, keyed by SHA-1 of the patch file (exact expected results). */
export const KNOWN_PATCHES = {
  '80fa3c0b16a72240e55eeeac9a017000275d36ae': {
    name: 'Pokémon Definitive HeartGold',
    author: 'BigNation',
    hackId: 'definitive-heartgold',
    baseCrc: 'C180A0E9',
    resultCrc: '6AD2AB08',
  },
};

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');

/** File name of a library id ("dir/file.bps" or "dir/archive.zip::inner/file.bps"). */
const fileNameOf = (id) => String(id).split('::').pop().split(/[\\/]/).pop();

function extFor(id, rom) {
  const fromName = extname(String(id).split('::').pop()).slice(1).toLowerCase();
  if (['gb', 'gbc', 'gba', 'nds'].includes(fromName)) return fromName;
  return identifyRom(rom.subarray(0, 0x200))?.system || 'bin';
}

/**
 * Produce the (optionally patched) base ROM as a file on disk.
 * Returns { path, crc, sha1, size, baseCrc, header, fromCache, patchName, system }.
 */
export function preparePatchedRom(romId, patchId, onLog = () => {}, config = {}) {
  const idExt = extname(String(romId).split('::').pop()).slice(1).toLowerCase();
  if (isCtrExt(idExt)) return prepareCtr(romId, patchId, onLog, config, idExt);
  const rom = loadFile(romId, config);
  const baseCrc = crc32Hex(rom);
  const ext = extFor(romId, rom);
  const header = identifyRom(rom.subarray(0, 0x200), ext);
  onLog(`Basis-ROM geladen (${(rom.length / 1048576).toFixed(1)} MB, CRC32 ${baseCrc})`);
  mkdirSync(CACHE_DIR, { recursive: true });
  if (!patchId) {
    const path = join(CACHE_DIR, `vanilla-${baseCrc}.${ext}`);
    // atomic: a half-written cache file would otherwise be reused for every later build
    if (!existsSync(path)) writeFileAtomic(path, rom);
    return { path, crc: baseCrc, sha1: sha1(rom), size: rom.length, baseCrc, header, fromCache: false, patchName: null, system: header?.system || ext };
  }
  const patch = loadFile(patchId, config);
  const patchSha = sha1(patch);
  const known = KNOWN_PATCHES[patchSha];
  if (known && known.baseCrc !== baseCrc) {
    throw new Error(`Falsches Basis-ROM: ${known.name} erwartet CRC32 ${known.baseCrc}, gefunden ${baseCrc}.`);
  }
  const path = join(CACHE_DIR, `patched-${patchSha.slice(0, 12)}-${baseCrc}.${ext}`);
  if (existsSync(path)) {
    const buf = readFileSync(path);
    const crc = crc32Hex(buf);
    if (!known || crc === known.resultCrc) {
      onLog(`Gepatchtes ROM aus Cache (CRC32 ${crc})`);
      return { path, crc, sha1: sha1(buf), size: buf.length, baseCrc, header: identifyRom(new Uint8Array(buf.subarray(0, 0x200)), ext), fromCache: true, patchName: known?.name || fileNameOf(patchId), system: header?.system || ext, patchSha1: patchSha };
    }
  }
  onLog(`Wende Patch an (${detectPatchFormat(patch)}, ${(patch.length / 1048576).toFixed(1)} MB) …`);
  const t = Date.now();
  const out = applyPatch(rom, patch);
  const crc = crc32Hex(out);
  onLog(`Patch angewendet in ${((Date.now() - t) / 1000).toFixed(1)} s – Ergebnis CRC32 ${crc}`);
  if (known && crc !== known.resultCrc) throw new Error(`Patch-Ergebnis unerwartet (CRC32 ${crc}, erwartet ${known.resultCrc}).`);
  writeFileAtomic(path, out);
  return { path, crc, sha1: sha1(out), size: out.length, baseCrc, header: identifyRom(out.subarray(0, 0x200), ext), fromCache: false, patchName: known?.name || fileNameOf(patchId), system: header?.system || ext, patchSha1: patchSha };
}

export function fileSha1(path) {
  return sha1(readFileSync(path));
}

/**
 * A 3DS game is played from the library file itself: 1–4 GB, never read whole (no CRC32 / SHA-1, no patch, no
 * randomizer). Returns the same shape as preparePatchedRom with the checksums null and `ext` the file's own extension.
 */
function prepareCtr(romId, patchId, onLog, config, ext) {
  if (patchId) throw httpError(400, '3DS-Spiele lassen sich hier nicht patchen', 'ctrNoPatch');
  const { abs, entry } = resolveId(romId, config);
  if (entry) throw httpError(400, '3DS-Spiele müssen entpackt in der Bibliothek liegen', 'ctrInArchive');
  const header = ctrInfo(abs, ext);
  if (!header) throw httpError(400, 'Kein 3DS-Spiel', 'notCtr');
  const size = statSync(abs).size;
  onLog(`3DS-Spiel ${header.productCode || header.titleId || ''} (${(size / 1048576).toFixed(0)} MB)`);
  return { path: abs, crc: null, sha1: null, size, baseCrc: null, header, fromCache: false, patchName: null, system: '3ds', ext };
}
