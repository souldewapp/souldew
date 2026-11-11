// Electron main for scripts/rom-matrix.mjs --live: boots each ROM in souldew's own player page (hidden window, muted,
// scratch data folder), drives it with the game's input plan (plans.mjs) and reads team, location and battle with
// the app's live readers (shared/live/*) – the same code the play view runs. Writes one JSON result per ROM.
// Not started by hand: node scripts/rom-matrix.mjs <rom-dir> --live
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PAGE_HELPER } from './page.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const job = JSON.parse(readFileSync(process.argv[process.argv.length - 1], 'utf8'));
process.env.SLS_DATA_DIR = job.dataDir;
process.env.NO_OPEN = '1';
app.commandLine.appendSwitch('mute-audio');
// Windows: a window that is never shown (or that the OS counts as covered) gets display frames at a trickle – the frame
// pacer of player.html then runs the game at ~1/10 of its speed (measured in a Windows 11 VM: Red 137 instead of 1454
// frames a second, DS games ran into the 15-minute limit). There the window is shown, fully transparent, without focus,
// taskbar entry or mouse input – nothing to see or click, but frames as fast as a visible window.
const invisible = process.platform === 'win32' && !job.show;
if (invisible) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setPath('userData', join(job.dataDir, 'electron'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOne(url, t) {
  const win = new BrowserWindow({
    show: !!job.show,
    width: t.system === 'nds' ? 512 : 640,
    height: t.system === 'nds' ? 768 : 576,
    webPreferences: { backgroundThrottling: false },
    ...(invisible ? { opacity: 0, focusable: false, skipTaskbar: true, frame: false } : {}),
  });
  if (invisible) {
    win.setIgnoreMouseEvents(true);
    win.showInactive();
  }
  win.webContents.setAudioMuted(true);
  const rom = `/api/library/rom?id=${encodeURIComponent(t.file)}`;
  const q = new URLSearchParams({ system: t.system, rom, name: `matrix-${t.key}`, threads: '0', volume: '0' });
  if (t.core) q.set('core', t.core);
  if (t.save) {
    // a plan that starts from a save: served the way the app serves a solo game's save (server/app.mjs /api/saves/solo)
    const id = `matrix-${t.key}`;
    const dir = join(job.dataDir, 'Saves');
    mkdirSync(dir, { recursive: true });
    copyFileSync(t.save, join(dir, `${createHash('sha1').update(id).digest('hex').slice(0, 16)}.sav`));
    q.set('save', `/api/saves/solo?id=${encodeURIComponent(id)}`);
  }
  const res = { key: t.key, file: t.file, steps: [], error: null };
  const shots = [];
  try {
    // (a fresh window right after the previous game's was closed sometimes reports ERR_FAILED once)
    for (let i = 0; ; i++) {
      try {
        await win.loadURL(`${url}/player.html?${q}`);
        break;
      } catch (err) {
        if (i >= 2) throw err;
        await sleep(1500);
      }
    }
    const t0 = Date.now();
    while (!(await win.webContents.executeJavaScript('!!window.__emu?.ready'))) {
      if (Date.now() - t0 > 90000) throw new Error('emulator did not boot in 90 s');
      await sleep(300);
    }
    await win.webContents.executeJavaScript(PAGE_HELPER);
    const out = await win.webContents.executeJavaScript(`window.__rm.run(${JSON.stringify({ plan: t.plan, romSrc: rom, timeoutMs: job.timeoutMs || 600000 })})`);
    Object.assign(res, out);
    for (const s of out.shots || []) {
      const p = join(job.outDir, `${t.key}-${s.name}.png`);
      writeFileSync(p, Buffer.from(s.png, 'base64'));
      shots.push(p);
    }
    if (job.saveStates && out.state) writeFileSync(join(job.outDir, `${t.key}.state`), Buffer.from(out.state, 'base64'));
  } catch (e) {
    res.error = String(e?.message || e);
  }
  delete res.shots;
  delete res.state;
  res.shots = shots;
  win.destroy();
  return res;
}

app.whenReady().then(async () => {
  mkdirSync(job.outDir, { recursive: true });
  const { startServer } = await import(pathToFileURL(join(root, 'server', 'app.mjs')).href);
  const { url } = await startServer({ port: 0 });
  const results = [];
  for (const t of job.targets) {
    const r = await runOne(url, t);
    results.push(r);
    writeFileSync(job.resultFile, JSON.stringify(results, null, 1));
    process.stdout.write(`${JSON.stringify({ done: t.key, error: r.error })}\n`);
  }
  app.exit(0);
});
