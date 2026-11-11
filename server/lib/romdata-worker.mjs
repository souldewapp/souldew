// Worker thread for server/lib/romloc.mjs: reads a ROM and computes what the app needs from it (romData – place names,
// species, types, level caps …). A big ROM takes seconds, and the server shares its thread with the app (Electron's
// main process): here that time doesn't hold up any other request. One job at a time, from romloc.mjs runJob.
// Message in: { id, sharedDir, file } (a file), { id, sharedDir, lib: { id, config } } (a library entry, maybe inside a
// .zip) or { id, sharedDir, bytes } (an ArrayBuffer). Message out: { id, result } or { id, error }.
import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { romData } from './romloc.mjs';
import { loadFile } from './library.mjs';

const u8 = (b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

parentPort.on('message', ({ id, sharedDir, file, lib, bytes }) => {
  try {
    // (tests: a scan that takes a while – the server must answer other requests meanwhile)
    const delay = Number(process.env.SLS_ROMDATA_TEST_DELAY_MS) || 0;
    if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    const rom = bytes ? new Uint8Array(bytes) : lib ? u8(loadFile(lib.id, lib.config)) : u8(readFileSync(file));
    parentPort.postMessage({ id, result: romData(rom, sharedDir) });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e?.message || e) });
  }
});
