import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pacer, soundRate, FULL_SHARE, FULL_SLICE } from '../web/lib/pacer.mjs';

/**
 * Drives a pacer with a fake clock: a display at `hz` for `seconds`, the core's step costs `cost` ms and asks for the
 * next one right away (as Emscripten's main loop does). Returns frames per display frame and the totals.
 */
function run({ hz = 60, seconds = 10, speed = 1, cost = 1, corr = 0, pauseAt = -1, pauseFor = 0, full = false, pageWork = 0.3 } = {}) {
  let clock = 0;
  const p = new Pacer({ fps: 60, now: () => clock });
  p.setSpeed(speed);
  p.corr = corr;
  p.full = full;
  let frames = 0;
  const step = () => {
    clock += cost;
    frames++;
    p.request(step);
  };
  // the longest stretch the core ran without the page getting a turn, and the longest a display frame's work took
  const stats = { longest: 0, slices: 0, span: 0 };
  const timed = (f, from = clock) => {
    const n = f();
    stats.longest = Math.max(stats.longest, clock - from);
    return n;
  };
  p.request(step);
  const perTick = [];
  const interval = 1000 / hz;
  const ticks = Math.round(seconds * hz);
  for (let i = 1; i <= ticks; i++) {
    let t = i * interval;
    // still busy when the display refreshed (a frame ran long): the browser runs the next animation frame as soon as
    // the thread is free, stamped with the latest refresh – the ones in between are gone
    if (clock > t) {
      const skip = Math.floor((clock - t) / interval);
      i += skip;
      t = i * interval;
    }
    clock = Math.max(clock, t);
    if (pauseAt >= 0 && t >= pauseAt * 1000 && t < (pauseAt + pauseFor) * 1000) {
      // paused: the core asks for nothing meanwhile
      if (p.step) p.step = null;
      p.tick(t);
      perTick.push(0);
      continue;
    }
    if (!p.step) p.request(step);
    const from = clock;
    let n = timed(() => p.tick(t));
    // full power: player.html runs the rest of the frame's share in slices, the page's work in between
    while (p.pending(clock)) {
      clock += pageWork;
      stats.slices++;
      n += timed(() => p.slice(clock));
    }
    stats.span = Math.max(stats.span, clock - from);
    perTick.push(n);
  }
  return { frames, perTick, p, fps: frames / (Math.max(clock, seconds * 1000) / 1000), stats };
}

test('1× on a 60 Hz display: exactly one frame per refresh', () => {
  const { perTick, fps } = run({ hz: 60 });
  assert.ok(perTick.slice(1).every((n) => n === 1), 'one frame per refresh');
  assert.ok(Math.abs(fps - 60) < 0.2);
});

test('1× on a 59.94 Hz display: still one per refresh – no skipped or doubled frame (the sound adjusts instead)', () => {
  const { perTick } = run({ hz: 59.94, seconds: 60 });
  assert.ok(perTick.slice(1).every((n) => n === 1));
});

test('1× on 75, 120, 144 and 165 Hz displays: 60 frames per second, never two in one refresh', () => {
  for (const hz of [75, 120, 144, 165]) {
    const { perTick, fps, p } = run({ hz, seconds: 20 });
    assert.ok(Math.abs(fps - 60) < 0.3, `${hz} Hz: ${fps.toFixed(2)} fps`);
    assert.ok(perTick.every((n) => n <= 1), `${hz} Hz: at most one frame per refresh`);
    assert.ok(p.maxGap <= 2 * (1000 / 60) + 1, `${hz} Hz: longest gap ${p.maxGap.toFixed(1)} ms`);
  }
});

test('fast-forward reaches the chosen speed exactly, independent of the display (no timers involved)', () => {
  for (const hz of [60, 75, 144, 165]) {
    for (const speed of [2, 3, 4]) {
      const { fps } = run({ hz, speed, cost: 1.5, seconds: 10 });
      assert.ok(Math.abs(fps / 60 - speed) < 0.03, `${hz} Hz, ${speed}×: reached ${(fps / 60).toFixed(2)}×`);
    }
  }
});

test('a computer too slow for the speed: as many frames as fit, no burst to catch up afterwards', () => {
  const { perTick, fps, p } = run({ hz: 60, speed: 4, cost: 6, seconds: 5 });
  assert.ok(perTick.every((n) => n <= 3), 'stays within the display frame');
  assert.ok(fps / 60 > 1.9 && fps / 60 < 4, `reached ${(fps / 60).toFixed(2)}×`);
  assert.ok(p.budgetHits > 0);
  assert.ok(p.acc <= p.period() + 1e-9, 'no debt carried over');
});

test('"Max": as many frames as fit into the display frame', () => {
  const { fps } = run({ hz: 60, speed: Infinity, cost: 1, seconds: 5 });
  assert.ok(fps / 60 > 10, `reached ${(fps / 60).toFixed(1)}×`);
});

test('full-power turbo: a core too heavy for 75 % of the frame gets up to FULL_SHARE of it – faster than before', () => {
  for (const [hz, cost] of [[60, 4.5], [60, 5]]) {
    const before = run({ hz, speed: 4, cost, seconds: 5 });
    const after = run({ hz, speed: 4, cost, seconds: 5, full: true });
    assert.ok(after.fps > before.fps * 1.08, `${hz} Hz, ${cost} ms: ${(before.fps / 60).toFixed(2)}× → ${(after.fps / 60).toFixed(2)}×`);
    assert.ok(after.fps / 60 <= 4.01, 'never above the chosen speed');
    // the frame's share (plus at most the one step under way and the page's turns), with breaks for the page
    const frame = 1000 / hz;
    assert.ok(after.stats.span <= frame * FULL_SHARE + cost + 1, `${hz} Hz: a frame's work took ${after.stats.span.toFixed(1)} ms of ${frame.toFixed(1)}`);
    assert.ok(after.stats.longest <= FULL_SLICE + cost + 1e-9, `longest stretch without a break ${after.stats.longest.toFixed(1)} ms`);
    assert.ok(after.p.acc <= after.p.period() + 1e-9, 'no debt carried over into the next frame');
  }
  // a core that takes the whole frame for a single step: as fast as before (the computer can't do more)
  for (const cost of [8, 12]) {
    const before = run({ hz: 60, speed: 4, cost, seconds: 5 });
    const after = run({ hz: 60, speed: 4, cost, seconds: 5, full: true });
    assert.ok(after.fps > before.fps * 0.97, `${cost} ms: ${(before.fps / 60).toFixed(2)}× → ${(after.fps / 60).toFixed(2)}×`);
  }
});

test('full-power turbo: a speed the computer manages is still exact, in slices', () => {
  for (const hz of [60, 75, 144]) {
    for (const speed of [2, 3, 4]) {
      const { fps, stats } = run({ hz, speed, cost: 1.5, seconds: 10, full: true });
      assert.ok(Math.abs(fps / 60 - speed) < 0.03, `${hz} Hz, ${speed}×: reached ${(fps / 60).toFixed(2)}×`);
      assert.ok(stats.longest <= FULL_SLICE + 1.5 + 1e-9);
    }
  }
});

test('full-power turbo: "Max" fills the frame up to its share, the rest stays with the page', () => {
  const before = run({ hz: 60, speed: Infinity, cost: 1, seconds: 5 });
  const after = run({ hz: 60, speed: Infinity, cost: 1, seconds: 5, full: true });
  assert.ok(after.fps > before.fps * 1.12, `${(before.fps / 60).toFixed(1)}× → ${(after.fps / 60).toFixed(1)}×`);
  assert.ok(after.stats.slices > 0, 'the page got its turns');
  assert.ok(after.stats.span <= (1000 / 60) * FULL_SHARE + 1 + after.stats.slices * 0.3);
});

test('full-power turbo changes nothing at 1×, and nothing is pending without it', () => {
  for (const hz of [60, 75, 144]) {
    const plain = run({ hz, seconds: 10 });
    const full = run({ hz, seconds: 10, full: true });
    assert.deepEqual(full.perTick, plain.perTick, `${hz} Hz`);
    assert.equal(full.stats.slices, 0);
  }
  const off = run({ hz: 60, speed: 4, cost: 6, seconds: 2 });
  assert.equal(off.stats.slices, 0, 'off: no slices, the 75 % budget as before');
  const p = new Pacer({ fps: 60, now: () => 0 });
  assert.equal(p.full, false, 'off unless player.html switches it on');
  assert.equal(p.pending(0), false);
  assert.equal(p.slice(0), 0);
});

test('a pause builds up no debt: the game goes on at its speed afterwards, without a burst', () => {
  const { perTick } = run({ hz: 75, seconds: 6, pauseAt: 2, pauseFor: 2 });
  assert.ok(perTick.every((n) => n <= 1));
});

test('the sound steering speeds 1× up a little while the buffer fills', () => {
  const { fps } = run({ hz: 60, corr: 0.03, seconds: 10 });
  assert.ok(fps > 61.2 && fps < 62.2, `${fps.toFixed(2)} fps`);
});

test('a speed change starts afresh', () => {
  const p = new Pacer({ fps: 60, now: () => 0 });
  p.acc = 50;
  p.setSpeed(4);
  assert.equal(p.acc, 0);
  assert.equal(p.period(), 1000 / 240);
  p.setSpeed('junk');
  assert.equal(p.speed, 1);
  p.setSpeed(Infinity);
  assert.equal(p.period(), 0);
});

test('player.html: RetroArch neither syncs on its sound nor limits fast-forward – the pacer does both', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../web/player.html', import.meta.url), 'utf8');
  for (const line of ['audio_sync = "false"', 'fastforward_ratio = "0.000000"', 'audio_rate_control = "true"']) assert.ok(html.includes(line), line);
  assert.match(html, /audio_latency = "\$\{AUDIO_LATENCY\}"/);
  assert.match(html, /const AUDIO_LATENCY = 128;/);
  // the same keys from EmulatorJS' config are dropped: with a key twice RetroArch keeps the first (measured: 64 ms won)
  assert.match(html, /filter\(\(l\) => !ours\.has\(key\(l\)\)\)/);
  // Emscripten's main-loop step is caught from both of its schedulers
  assert.match(html, /const RUNNER = 'MainLoop_runner'/);
  assert.match(html, /window\.requestAnimationFrame = function/);
  assert.match(html, /window\.setImmediate = function/);
  assert.match(html, /GM\(\)\.setFastForwardRatio\(0\)/);
});

test('the sound runs at the card’s rate up to 48 kHz, above it at 48 (or 44.1) kHz', () => {
  for (const [card, rate] of [[44100, 44100], [48000, 48000], [32000, 32000], [96000, 48000], [192000, 48000], [88200, 44100], [176400, 44100], [384000, 48000], [95999.7, 48000], [0, 0], [null, 0], [8000, 0]]) {
    assert.equal(soundRate(card), rate, `${card} Hz`);
  }
});

test('player.html: fast-forward sound at normal pitch for every core, the sound at soundRate()', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../web/player.html', import.meta.url), 'utf8');
  // sped up and paced from the display, RetroArch's sound came out chopped or at a jumping pitch (2.2.0-beta.2)
  assert.match(html, /const FF_SKIP = true;/);
  assert.match(html, /audio_fastforward_speedup = "\$\{FF_SKIP \? 'false' : 'true'\}"/);
  assert.match(html, /\{ type: 'skip', on: FF_SKIP \}/); // (in every new mixer's initial state)
  // the core's AudioContexts get the capped rate, and RetroArch makes its sound at it
  assert.match(html, /outRate = soundRate\(deviceRate\)/);
  assert.match(html, /new NativeAudioContext\(\{ \.\.\.opts, sampleRate: ctxRate \}\)/);
  assert.match(html, /audio_out_rate = "\$\{outRate\}"/);
});

test('player.html: full-power turbo runs its slices as background tasks and DeSmuME skips more frames with it', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../web/player.html', import.meta.url), 'utf8');
  // the page's own tasks go first (a plain message round trip let them wait ~4× longer, measured)
  assert.match(html, /scheduler\.postTask\(slice, \{ priority: 'background' \}\)/);
  assert.match(html, /pacer\.full = fullTurbo/);
  assert.match(html, /let fullTurbo = q\.get\('fullturbo'\) !== '0'/);
  // the frameskip lives here, so holding Tab gets it too; the page's value for 1× is kept for 1×
  const ffSkip = new Function('fullTurbo', 'speed', `return ${/const ffSkip = \(\) => (.+);\n/.exec(html)[1]}`);
  assert.deepEqual([2, 3, 4, Infinity].map((s) => ffSkip(true, s)), ['1', '2', '3', '3']);
  assert.deepEqual([2, 4, Infinity].map((s) => ffSkip(false, s)), ['1', '1', '1'], 'off: every other frame, as before');
  assert.match(html, /if \(k === 'desmume_frameskip'\) \{\n\s+skip1x = String\(v\);/);
});
