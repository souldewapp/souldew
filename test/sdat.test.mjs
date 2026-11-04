// The DS's own music: reading the sound archive (SDAT) out of a ROM, the sequence synthesizer and how the turbo
// mixer plays it – on a small archive built here (a sine sample, PSG, a drum set, a key split, ADPCM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nitroFiles, findSdat, songPack, decodeSwav, parseBank } from '../web/lib/sdat.mjs';
import { SseqPlayer, SdatSynth } from '../web/lib/sdat-synth.mjs';
import { TurboMixer } from '../web/lib/turboaudio.mjs';

// ---- building the files -------------------------------------------------------------------------------------
const bytes = (...parts) => {
  const out = [];
  for (const p of parts) for (const b of p) out.push(b & 0xff);
  return out;
};
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const pad4 = (a) => {
  while (a.length % 4) a.push(0);
  return a;
};
/** A Nitro file: magic, BOM/version, size, header size 0x10, 1 block – then the 'DATA' block. */
const nitro = (magic, data) => {
  const block = bytes(ascii('DATA'), le32(8 + data.length), data);
  return bytes(ascii(magic), [0xff, 0xfe, 0x00, 0x01], le32(16 + block.length), le16(16), le16(1), block);
};

const RATE = 44000;
const PERIOD = 100; // samples: 440 Hz at 44 kHz
function swarFile(waves) {
  // waves: [{ type, loop, rate, data: byte array (already in the sample format), loopWords }]
  const head = 0x3c + waves.length * 4;
  const infos = [];
  let at = head;
  const offs = [];
  for (const w of waves) {
    offs.push(at);
    const words = Math.ceil(w.data.length / 4);
    const info = bytes([w.type, w.loop ? 1 : 0], le16(w.rate), le16(Math.round(16756991 / w.rate)), le16(w.loopWords || 0), le32(words - (w.loopWords || 0)), pad4([...w.data]));
    infos.push(info);
    at += info.length;
  }
  // SWAR: 0x18–0x37 reserved, count at 0x38, offsets from the SWAR start
  const data = bytes(new Array(32).fill(0), le32(waves.length), ...offs.map(le32), ...infos);
  return nitro('SWAR', data);
}
const sinePcm16 = (n) => bytes(...Array.from({ length: n }, (_, i) => le16(Math.round(Math.sin((2 * Math.PI * i) / PERIOD) * 20000) & 0xffff)));

const def = (type, swav, swar, base, pan = 64) => bytes(le16(swav), le16(swar), [base, 127, 127, 127, 127, pan]);
function sbnkFile() {
  // program 0: the sine (base 69); 1: PSG square duty 3 (base 60); 2: drum set 36–37; 3: key split (<60 sine, else PSG)
  const recs = [];
  const bodies = [];
  let at = 0x3c + 4 * 4;
  const add = (type, body) => {
    recs.push(bytes([type], le16(at), [0]));
    bodies.push(body);
    at += body.length;
  };
  add(1, def(1, 0, 0, 69));
  add(2, def(2, 3, 0, 60)); // (the driver's PSG timer plays C4 at the base note; HeartGold's PSG programs all use 60)
  add(16, bytes([36, 37], le16(1), def(1, 0, 0, 60), le16(3), def(3, 0, 0, 60)));
  add(17, bytes([59, 127, 0, 0, 0, 0, 0, 0], le16(1), def(1, 0, 0, 69), le16(2), def(2, 1, 0, 69)));
  return nitro('SBNK', bytes(new Array(32).fill(0), le32(4), ...recs, ...bodies));
}
function sseqFile(cmds) {
  // SSEQ's DATA block holds the offset of the commands (from the SSEQ start): 0x1C
  const block = bytes(ascii('DATA'), le32(12 + cmds.length), le32(0x1c), cmds);
  return bytes(ascii('SSEQ'), [0xff, 0xfe, 0x00, 0x01], le32(16 + block.length), le16(16), le16(1), block);
}
// two notes of half a second each (tempo 120: 48 ticks), program 0: A4 (440 Hz), then A5 (880 Hz)
const TWO_NOTES = bytes([0xfe], le16(1), [0xc7, 1], [0xe1], le16(120), [0x81, 0], [69, 127, 48], [81, 127, 48], [0xff]);

function sdatFile(seqs) {
  const files = [...seqs.map(sseqFile), sbnkFile(), swarFile([{ type: 1, loop: true, rate: RATE, data: sinePcm16(PERIOD * 4) }])];
  const nSeq = seqs.length;
  const bankFile = nSeq;
  const swarId = nSeq + 1;
  // INFO: 8 record lists (SEQ, SEQARC, BANK, WAVEARC, PLAYER, GROUP, PLAYER2, STRM)
  const lists = [];
  const entries = [];
  const infoHead = 8 + 8 * 4;
  let at = infoHead;
  const listAt = [];
  const entryBytes = {
    0: seqs.map((_, i) => bytes(le16(i), le16(0), le16(0), [100, 64, 64, 0], le16(0))),
    2: [bytes(le16(bankFile), le16(0), le16(0), le16(0xffff), le16(0xffff), le16(0xffff))],
    3: [bytes(le16(swarId), le16(0))],
  };
  for (let k = 0; k < 8; k++) {
    const es = entryBytes[k] || [];
    listAt.push(at);
    at += 4 + es.length * 4;
    lists.push(es);
  }
  const entryAt = [];
  for (let k = 0; k < 8; k++) {
    entryAt.push(lists[k].map((e) => {
      const o = at;
      at += e.length;
      entries.push(e);
      return o;
    }));
  }
  const info = pad4(bytes(ascii('INFO'), le32(at), ...listAt.map(le32), ...lists.map((es, k) => bytes(le32(es.length), ...entryAt[k].map(le32))), ...entries));
  // layout: header 0x40, INFO, FAT, FILE
  const infoOff = 0x40;
  const fatOff = infoOff + info.length;
  const fatLen = 12 + files.length * 16;
  const fileOff = fatOff + fatLen;
  let fo = fileOff + 16;
  const fat = bytes(ascii('FAT '), le32(fatLen), le32(files.length), ...files.map((f) => {
    const e = bytes(le32(fo), le32(f.length), new Array(8).fill(0));
    fo += pad4([...f]).length;
    return e;
  }));
  const fileBlock = bytes(ascii('FILE'), le32(fo - fileOff), le32(files.length), le32(0), ...files.map((f) => pad4([...f])));
  const header = bytes(ascii('SDAT'), [0xff, 0xfe, 0x00, 0x01], le32(fo), le16(0x40), le16(4), le32(0), le32(0), le32(infoOff), le32(info.length), le32(fatOff), le32(fatLen), le32(fileOff), le32(fo - fileOff), new Array(16).fill(0));
  return new Uint8Array(bytes(header, info, fat, fileBlock));
}

/** A tiny ROM: header (FNT at 0x40, FAT at 0x48), a root dir "data" → "sound" → "test.sdat" and a decoy file. */
function romWith(sdat) {
  const decoy = new Uint8Array(ascii('SDAT-not-really'));
  // FNT: main table (3 dirs × 8 bytes), then sub tables
  const sub0 = bytes([0x84], ascii('data'), le16(0xf001), [0x05], ascii('decoy'), [0]); // root: dir "data", file 0 "decoy"
  const sub1 = bytes([0x85], ascii('sound'), le16(0xf002), [0]);
  const sub2 = bytes([0x09], ascii('test.sdat'), [0]);
  const mainLen = 3 * 8;
  const fnt = bytes(le32(mainLen), le16(0), le16(3), le32(mainLen + sub0.length), le16(1), le16(0xf000), le32(mainLen + sub0.length + sub1.length), le16(1), le16(0xf001), sub0, sub1, sub2);
  const fntOff = 0x200;
  const fatOff = pad4([...new Array(fntOff + fnt.length).fill(0)]).length;
  const dataOff = fatOff + 16;
  const sdatOff = dataOff + pad4([...decoy]).length;
  const rom = new Uint8Array(sdatOff + sdat.length);
  rom.set(le32(fntOff), 0x40);
  rom.set(le32(fnt.length), 0x44);
  rom.set(le32(fatOff), 0x48);
  rom.set(le32(16), 0x4c);
  rom.set(fnt, fntOff);
  rom.set(bytes(le32(dataOff), le32(dataOff + decoy.length), le32(sdatOff), le32(sdatOff + sdat.length)), fatOff);
  rom.set(decoy, dataOff);
  rom.set(sdat, sdatOff);
  return rom;
}

const SR = 48000;
/** Zero crossings per second of a stretch – twice the frequency of a sine. */
function freq(x, from, to) {
  let n = 0;
  for (let i = from + 1; i < to; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++;
  return n / 2 / ((to - from) / SR);
}
function render(pack, seconds, seed) {
  const p = new SseqPlayer(pack, SR, seed ? { seed } : undefined);
  const n = Math.round(seconds * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  p.render(L, R, 0, n, 1);
  return { L, R, p };
}

// ---- tests --------------------------------------------------------------------------------------------------
test('NitroFS: the sound archive is found by its path and magic, decoys and broken data are skipped', () => {
  const rom = romWith(sdatFile([TWO_NOTES]));
  const files = nitroFiles(rom);
  assert.deepEqual(files.map((f) => f.path).sort(), ['data/sound/test.sdat', 'decoy']);
  const sdat = findSdat(rom);
  assert.equal(sdat.path, 'data/sound/test.sdat');
  assert.equal(sdat.seqs.length, 1);
  assert.deepEqual(nitroFiles(new Uint8Array(0x100)), []);
  assert.equal(findSdat(new Uint8Array(0x400)), null);
});

test('songPack: the sequence, every program with its key regions, samples decoded once', () => {
  const sdat = findSdat(romWith(sdatFile([TWO_NOTES])));
  const pack = songPack(sdat, 0);
  assert.equal(pack.vol, 100);
  assert.deepEqual([...pack.seq.subarray(0, 3)], [0xfe, 1, 0]);
  assert.equal(pack.programs.length, 4);
  assert.deepEqual(pack.programs[0].map((r) => [r.kind, r.lo, r.hi, r.base]), [['pcm', 0, 127, 69]]);
  assert.deepEqual(pack.programs[1].map((r) => [r.kind, r.duty]), [['psg', 3]]);
  assert.deepEqual(pack.programs[2].map((r) => [r.kind, r.lo, r.hi]), [['pcm', 36, 36], ['noise', 37, 37]]);
  assert.deepEqual(pack.programs[3].map((r) => [r.kind, r.lo, r.hi]), [['pcm', 0, 59], ['psg', 60, 127]]);
  assert.equal(pack.waves.length, 1, 'the same sample used by three programs is decoded once');
  assert.equal(pack.waves[0].data.length, PERIOD * 4);
  assert.ok(Math.abs(pack.waves[0].data[25] - 20000 / 32768) < 1e-4);
  assert.equal(songPack(sdat, 5), null);
  assert.throws(() => parseBank(new Uint8Array(64)));
});

test('decodeSwav: PCM8, and IMA-ADPCM as the DS decodes it (header word, low nibble first, loop after the header)', () => {
  const pcm8 = new Uint8Array(bytes([0, 0], le16(8000), le16(0), le16(0), le32(1), [0x7f, 0x80, 0x00, 0x40]));
  assert.deepEqual([...decodeSwav(pcm8, 0).data], [127 / 128, -1, 0, 0.5]);
  // ADPCM: first sample 1000, step index 0; nibbles 7, 7, 8 (+, +, −)
  const ad = new Uint8Array(bytes([2, 1], le16(8000), le16(0), le16(1), le32(1), le16(1000), [0, 0], [0x77, 0x08, 0, 0]));
  const w = decodeSwav(ad, 0);
  // step 7: diff = 0 + 1 + 3 + 7 = 11 → 1011; index 0+8 = 8 (step 16): diff = 2+4+8+16 = 30 → 1041; index 16 (step 34),
  // nibble 8: diff = 34 >> 3 = 4, minus → 1037
  assert.deepEqual([...w.data.subarray(0, 3)].map((x) => Math.round(x * 32768)), [1011, 1041, 1037]);
  assert.equal(w.loopStart, 0);
  assert.equal(w.loop, true);
});

test('synth: notes at the right pitch and time (48 ticks per quarter at the tempo), the same every time', () => {
  const pack = songPack(findSdat(romWith(sdatFile([TWO_NOTES]))), 0);
  const a = render(pack, 1.2);
  assert.ok(Math.abs(freq(a.L, 0.05 * SR, 0.45 * SR) - 440) < 6, `first note ${freq(a.L, 0.05 * SR, 0.45 * SR)}`);
  assert.ok(Math.abs(freq(a.L, 0.6 * SR, 0.95 * SR) - 880) < 10, `second note ${freq(a.L, 0.6 * SR, 0.95 * SR)}`);
  // the second note starts at 0.5 s (± one driver update)
  const onset = (x) => {
    for (let i = Math.round(0.45 * SR); i < x.length; i++) if (freq(x, i, i + 960) > 700) return i / SR;
    return null;
  };
  assert.ok(Math.abs(onset(a.L) - 0.5) < 0.03, `onset ${onset(a.L)}`);
  // centre pan: both sides alike; deterministic
  assert.ok(Math.abs(a.L[2000] - a.R[2000]) < 0.01);
  const b = render(pack, 1.2);
  assert.deepEqual(a.L, b.L);
  // after the end the song is over: silence, all channels released
  const c = render(pack, 3);
  assert.ok(Math.max(...c.L.subarray(2.5 * SR).map(Math.abs)) < 1e-3);
  assert.equal(c.p.ended, true);
});

test('synth: loops (jump), calls, random and variable commands, PSG and transpose all play without breaking', () => {
  const body = bytes([0x81, 1], [0xc3, 12], [0xa0, 69], [127], le16(10), le16(20), [0xb0, 0], le16(24), [0xa1, 0x80, 0], [0x95], [0, 0, 0], [0x94], [0, 0, 0]);
  // start: alloc, tempo, jump to the loop body at its offset; the call target (0) is replaced below
  const head = bytes([0xfe], le16(1), [0xe1], le16(150));
  const loopAt = head.length + 4;
  const sub = loopAt + body.length; // a subroutine: one short note, return
  const seq = bytes(head, [0x94], [loopAt & 0xff, loopAt >> 8, 0], body, [57, 100, 6], [0xfd]);
  // patch the call (0x95) to `sub` and the jump (0x94) back to loopAt
  const ci = seq.indexOf(0x95, loopAt);
  seq.splice(ci + 1, 3, sub & 0xff, sub >> 8, 0);
  const ji = seq.lastIndexOf(0x94, sub);
  seq.splice(ji + 1, 3, loopAt & 0xff, loopAt >> 8, 0);
  const pack = songPack(findSdat(romWith(sdatFile([seq]))), 0);
  const { L, p } = render(pack, 6, 7);
  assert.equal(p.ended, false, 'a looping song never ends');
  for (let s = 1; s < 6; s++) assert.ok(Math.max(...L.subarray(s * SR - SR / 2, s * SR).map(Math.abs)) > 0.01, `sound around ${s} s`);
  assert.ok(p.ticks > 6 * 150 * 0.8 * 0.9, `ticks ${p.ticks}`);
  // the PSG plays A5 (69 + 12): an 8-step square
  assert.ok(Math.abs(freq(L, 0.02 * SR, 0.06 * SR) - 880) < 60, `psg ${freq(L, 0.02 * SR, 0.06 * SR)}`);
});

test('SdatSynth: a song arriving late is caught up – it plays where the game is, and a new song crossfades', () => {
  const sdat = findSdat(romWith(sdatFile([TWO_NOTES, bytes([0xfe], le16(1), [0xe1], le16(120), [0x81, 0], [57, 127, 96], [0xff])])));
  const syn = new SdatSynth(SR, { fade: 0.05 });
  const L = new Float32Array(SR);
  const R = new Float32Array(SR);
  syn.song('m0');
  syn.render(L, R, 0.6 * SR, 0); // the key came 0.6 s ago, the pack only now
  syn.add('m0', songPack(sdat, 0));
  assert.equal(syn.has('m0'), true);
  L.fill(0);
  syn.render(L, R, 0.3 * SR, 1);
  assert.ok(Math.abs(freq(L, 0.02 * SR, 0.28 * SR) - 880) < 12, `caught up to the second note: ${freq(L, 0.02 * SR, 0.28 * SR)}`);
  syn.song('m1');
  syn.add('m1', songPack(sdat, 1));
  L.fill(0);
  syn.render(L, R, 0.5 * SR, 1);
  assert.ok(Math.abs(freq(L, 0.2 * SR, 0.45 * SR) - 220) < 6, `new song ${freq(L, 0.2 * SR, 0.45 * SR)}`);
  assert.equal(syn.old, null, 'the old song faded out');
});

test('turbo mixer: "music" plays the synthesized song in fast-forward, game sound at 1×, nothing in "mute", the game for an unknown song', () => {
  const sdat = findSdat(romWith(sdatFile([TWO_NOTES, bytes([0xfe], le16(1), [0xe1], le16(60), [0x81, 0], [57, 127, 0x7f], [0x94, 8, 0, 0])])));
  const B = 128;
  const m = new TurboMixer(SR, { seconds: 10 });
  m.command({ type: 'skip', on: true });
  const game = new Float32Array(B).fill(0.02);
  const oL = new Float32Array(B);
  const oR = new Float32Array(B);
  const run = (sec) => {
    const out = [];
    for (let i = 0; i < Math.round((sec * SR) / B); i++) {
      m.process(game, game, oL, oR, B);
      out.push(...oL);
    }
    return Float32Array.from(out);
  };
  m.command({ type: 'sdat-ready' });
  m.command({ type: 'song', key: 'm1' });
  m.command({ type: 'sdat', key: 'm1', pack: songPack(sdat, 1) });
  const at1x = run(0.5);
  assert.ok(at1x.subarray(-B).every((x) => Math.abs(x - 0.02) < 1e-6), 'at 1×: the game, the song only runs along silently');
  m.command({ type: 'speed', ratio: 4 });
  const ff = run(0.5);
  const tail = ff.subarray(0.3 * SR);
  assert.ok(Math.abs(freq(tail, 0, tail.length) - 220) < 8, `fast-forward: the song (${freq(tail, 0, tail.length)} Hz)`);
  assert.equal(m.playing().src, 'sdat');
  m.command({ type: 'mode', mode: 'mute' });
  const muted = run(0.3);
  assert.ok(Math.max(...muted.subarray(0.15 * SR).map(Math.abs)) < 1e-6, 'mute: silent');
  m.command({ type: 'mode', mode: 'music' });
  m.command({ type: 'song', key: 'm999' }); // no pack for it (yet)
  const other = run(0.4);
  assert.ok(other.subarray(-B).every((x) => Math.abs(x - 0.02) < 0.005), 'unknown song: the game’s own sound');
  assert.equal(m.playing().src, 'game');
});
