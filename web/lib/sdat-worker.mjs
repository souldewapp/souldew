// Reads the DS ROM's sound archive off the page's thread and hands out one song at a time (sdat.mjs songPack) for
// the turbo mixer's synthesizer. Messages in: { type: 'rom', url } once, { type: 'pack', key, id } per song,
// { type: 'reset' } when the mixer was rebuilt. Out: { type: 'ready', seqs } / { type: 'none', why },
// { type: 'pack', key, pack } – samples the mixer already got are sent as { id } only.
import { findSdat, songPack } from './sdat.mjs';

let sdat = null;
const cache = new Map(); // decoded samples, per wave archive and index
let sent = new WeakSet(); // samples the current mixer has

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'rom') {
      const res = await fetch(m.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rom = new Uint8Array(await res.arrayBuffer());
      const found = findSdat(rom);
      if (!found) return self.postMessage({ type: 'none', why: 'no SDAT' });
      // keep only the archive: the rest of the ROM can go
      const d = found.d.slice();
      sdat = { ...found, d };
      self.postMessage({ type: 'ready', seqs: sdat.seqs.length, path: found.path });
    } else if (m.type === 'reset') {
      sent = new WeakSet();
    } else if (m.type === 'pack' && sdat) {
      const pack = songPack(sdat, m.id, cache);
      if (!pack) return self.postMessage({ type: 'pack', key: m.key, pack: null });
      pack.waves = pack.waves.map((w) => {
        if (!w.uid) w.uid = `${m.id}:${Math.random().toString(36).slice(2)}`;
        if (sent.has(w)) return { uid: w.uid };
        sent.add(w);
        return { uid: w.uid, data: w.data, rate: w.rate, loopStart: w.loopStart, loop: w.loop };
      });
      self.postMessage({ type: 'pack', key: m.key, pack });
    }
  } catch (err) {
    self.postMessage({ type: 'none', why: String(err?.message || err) });
  }
};
