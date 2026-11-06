import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pacer } from '../web/lib/pacer.mjs';

/**
 * Drives a pacer with a fake clock: a display at `hz` for `seconds`, the core's step costs `cost` ms and asks for the
 * next one right away (as Emscripten's main loop does). Returns frames per display frame and the totals.
 */
function run({ hz = 60, seconds = 10, speed = 1, cost = 1, corr = 0, pauseAt = -1, pauseFor = 0 } = {}) {
  let clock = 0;
  const p = new Pacer({ fps: 60, now: () => clock });
  p.setSpeed(speed);
  p.corr = corr;
  let frames = 0;
  const step = () => {
    clock += cost;
    frames++;
    p.request(step);
  };
  p.request(step);
  const perTick = [];
  const interval = 1000 / hz;
  const ticks = Math.round(seconds * hz);
  for (let i = 1; i <= ticks; i++) {
    const t = i * interval;
    clock = Math.max(clock, t);
    if (pauseAt >= 0 && t >= pauseAt * 1000 && t < (pauseAt + pauseFor) * 1000) {
      // paused: the core asks for nothing meanwhile
      if (p.step) p.step = null;
      p.tick(t);
      perTick.push(0);
      continue;
    }
    if (!p.step) p.request(step);
    perTick.push(p.tick(t));
  }
  return { frames, perTick, p, fps: frames / seconds };
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
