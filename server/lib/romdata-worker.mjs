// Worker thread for server/lib/romloc.mjs: reads a ROM and computes what the app needs from it (romData – place names,
// species, types, level caps …). A big ROM takes seconds, and the server shares its thread with the app (Electron's
// main process): here that time doesn't hold up any other request. One job at a time, from romloc.mjs runJob.
// Message in: { id, sharedDir, file } (a file), { id, sharedDir, lib: { id, config } } (a library entry, maybe inside a
// .zip), { id, sharedDir, patched: { romId, patchId, config } } or { id, sharedDir, bytes } (an ArrayBuffer). Message out: { id, result } or { id, error }.
import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { romData } from './romloc.mjs';
import { loadFile } from './library.mjs';
import { preparePatchedRom } from './roms.mjs';

const u8 = (b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

parentPort.on('message', ({ id, sharedDir, file, lib, patched, bytes }) => {
  try {
    // (node --test only: a scan that takes a while – the server must answer other requests meanwhile)
    const delay = (process.env.NODE_TEST_CONTEXT && Number(process.env.SLS_ROMDATA_TEST_DELAY_MS)) || 0;
    if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    // (a patched game: the patched-ROM cache file, made here the first time – never on the server's thread)
    const path = patched ? preparePatchedRom(patched.romId, patched.patchId, () => {}, patched.config).path : file;
    const rom = bytes ? new Uint8Array(bytes) : lib ? u8(loadFile(lib.id, lib.config)) : u8(readFileSync(path));
    parentPort.postMessage({ id, result: romData(rom, sharedDir) });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e?.message || e) });
  }
});
