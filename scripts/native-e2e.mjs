// End-to-end check of the fast player in the real app UI (Electron from node_modules, a scratch data folder, muted):
// every ROM in a folder is started from the Play view the way a player starts it, then this checks that the native
// player took it (not the browser emulator), the picture runs, live tracking found the game, 1×/2×/4×/Max reach their
// speed, a save state goes there and back, and a screenshot of the app is kept. With --off it checks that Settings ›
// "Fast player" off gives the browser emulator; with --broken (Game Boy core replaced by junk) that a core which can't
// start falls back to the browser emulator by itself.
//
//   node scripts/native-e2e.mjs <rom-dir> [--out <dir>] [--only <text>] [--off] [--broken] [--show]
//
// Never commit ROMs or the screenshots.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const flag = (n) => args.includes(`--${n}`);

if (!process.versions.electron) {
  // started with node: run this file in Electron
  const electron = (await import('electron')).default;
  const p = spawn(electron, [fileURLToPath(import.meta.url), ...args], { stdio: 'inherit' });
  p.on('exit', (c) => process.exit(c ?? 1));
} else {
  const { app, BrowserWindow } = await import('electron');
  const romDir = resolve(args.find((a, i) => !a.startsWith('--') && !['--out', '--only'].includes(args[i - 1])) || '.');
  const out = resolve(opt('out', join(tmpdir(), 'souldew-native-e2e')));
  mkdirSync(out, { recursive: true });
  const data = mkdtempSync(join(tmpdir(), 'souldew-e2e-'));
  writeFileSync(join(data, 'config.json'), JSON.stringify({ onboarded: true, lang: 'de', playerName: 'E2E', libraryFolders: [romDir], bootAnimation: false, sounds: false, nativeCore: !flag('off') }));
  process.env.SLS_DATA_DIR = data;
  process.env.NO_OPEN = '1';
  if (flag('broken')) {
    // a copy of the tools with a Game Boy core that can't be loaded
    const plat = `${process.platform}-${process.arch}`;
    const src = join(root, 'tools', 'native', plat);
    const tools = join(data, 'bundled');
    mkdirSync(join(tools, 'native', plat), { recursive: true });
    for (const f of readdirSync(src)) copyFileSync(join(src, f), join(tools, 'native', plat, f));
    writeFileSync(join(tools, 'native', plat, readdirSync(src).find((f) => f.startsWith('gambatte_libretro'))), 'not a library');
    process.env.SLS_TOOLS_DIR = tools;
  }
  app.commandLine.appendSwitch('mute-audio');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.setPath('userData', join(data, 'electron'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  app.whenReady().then(async () => {
    const { startServer } = await import(join(root, 'server', 'app.mjs'));
    const { url } = await startServer({ port: 0 });
    const lib = await fetch(`${url}/api/library`).then((r) => r.json());
    const roms = (lib.roms || []).filter((r) => ['nds', 'gba', 'gb', 'gbc'].includes(r.system) && (!opt('only') || r.name.toLowerCase().includes(opt('only').toLowerCase())));
    const win = new BrowserWindow({ show: flag('show'), width: 1280, height: 860, webPreferences: { backgroundThrottling: false } });
    win.webContents.setAudioMuted(true);
    const js = (code) => win.webContents.executeJavaScript(code);
    const results = [];
    let failed = 0;
    for (const r of roms) {
      const res = { rom: r.name, system: r.system, ok: false, notes: [] };
      try {
        // a fresh start for every game: no session (or "where you left off") carried over from the one before
        await win.loadURL('about:blank');
        await win.webContents.session.clearStorageData();
        await fetch(`${url}/api/native/stop`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-soullink': '1' }, body: JSON.stringify({ id: (await fetch(`${url}/api/native/status`).then((x) => x.json())).session?.id }) }).catch(() => {});
        await win.loadURL(`${url}/#/play?rom=${encodeURIComponent(r.id)}`);
        const frameJs = (code) => js(`(async () => { const f = document.querySelector('iframe'); const w = f && f.contentWindow; if (!w || !w.__emu) return null; const e = w.__emu; return (${code}); })()`);
        const t0 = Date.now();
        let src = null;
        for (;;) {
          src = await js("document.querySelector('iframe')?.getAttribute('src') || null");
          const ready = await frameJs('!!e.ready');
          if (ready) break;
          if (Date.now() - t0 > 60000) throw new Error(`no game after 60 s (frame ${src})`);
          await sleep(250);
        }
        src = await js("document.querySelector('iframe').getAttribute('src')");
        res.player = /playernative/.test(src) ? 'native' : /player\.html/.test(src) ? 'browser' : src;
        res.core = await frameJs('e.perf?.().core || e.perf?.().pacing?.core || null');
        await sleep(4000); // the live reader finds the game
        const measure = async (speed, ms = 3000) => {
          await frameJs(`(e.setSpeed(${speed === Infinity ? 'Infinity' : speed}), true)`);
          await sleep(1200);
          const a = await frameJs('e.frames()');
          const ta = Date.now();
          await sleep(ms);
          const b = await frameJs('e.frames()');
          const host = await frameJs('e.perf?.().speed ?? null');
          return { page: Math.round(((b - a) / ((Date.now() - ta) / 1000) / 60) * 100) / 100, host: host == null ? null : Math.round(host * 100) / 100 };
        };
        res.speed = { x1: await measure(1), x2: await measure(2), x4: await measure(4) };
        // while fast-forwarding: what the turbo mixer plays (a loop of the music, the DS song from the ROM, …)
        res.turboAudio = await frameJs('e.audioProbe ? e.audioProbe() : null');
        res.speed.max = await measure(Infinity);
        await frameJs('(e.setSpeed(1), true)');
        res.live = await js("document.querySelector('.live-state, [data-live]')?.textContent?.trim().slice(0, 80) || null");
        const st = await frameJs('e.getState().then((s) => s ? s.length : 0)');
        const back = st ? await frameJs('e.getState().then((s) => e.loadState(s))') : false;
        res.state = { bytes: st, loaded: back };
        const shot = await win.capturePage();
        const file = join(out, `${r.name.replace(/[^\w.-]+/g, '_').slice(0, 60)}${flag('off') ? '-off' : flag('broken') ? '-broken' : ''}.png`);
        writeFileSync(file, shot.toPNG());
        res.shot = file;
        const want = flag('off') || (flag('broken') && /^gbc?$/.test(r.system)) ? 'browser' : 'native';
        if (res.player !== want) res.notes.push(`expected the ${want} player, got ${res.player}`);
        if (want === 'native') {
          if (res.speed.x1.page < 0.9) res.notes.push(`1× only reaches ${res.speed.x1.page}`);
          if (res.speed.x4.page < 3.6) res.notes.push(`4× only reaches ${res.speed.x4.page}`);
          if (!(st > 0) || back !== true) res.notes.push('save state round trip failed');
        }
        res.ok = !res.notes.length;
      } catch (e) {
        res.notes.push(String(e?.message || e));
      }
      if (!res.ok) failed++;
      results.push(res);
      console.log(JSON.stringify(res));
    }
    writeFileSync(join(out, `results${flag('off') ? '-off' : flag('broken') ? '-broken' : ''}.json`), JSON.stringify(results, null, 1));
    console.log(`${results.length - failed}/${results.length} ok – ${out}`);
    app.exit(failed || !results.length ? 1 : 0);
  });
}
