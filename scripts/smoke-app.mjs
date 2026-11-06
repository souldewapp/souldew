// Smoke test for a built app (CI: .github/workflows/windows.yml, linux.yml): starts the packaged binary with a fresh
// profile, waits until its embedded server answers, checks the page, the bundled Java runtime and the randomizer,
// optionally takes a screenshot (Windows; Linux with ImageMagick's `import`), then quits it. Exit code 0 = everything
// answered as it should.
//
// Usage: node scripts/smoke-app.mjs <path to souldew.exe / the app's binary / the .AppImage> [--screenshot file.png] [--timeout 120]
//        node scripts/smoke-app.mjs --dev [...]   (`npm run app` from this checkout instead of a build – needs tools/jre/<platform>-<arch>)
//          [--lang de]   (starts past the onboarding, in that language – for a screenshot of the library)
//          [--emulators] (also installs melonDS and mGBA through the app, as the one-click button does – needs internet)
// Linux CI has no screen: run it under xvfb-run.
// The app always tries port 47390 first – this refuses to run while something (e.g. your installed souldew)
// already listens there, so it never talks to an app it didn't start.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 47390;
const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dev = args.includes('--dev');
// --dev: the Electron binary from node_modules (the `electron` package exports its path) with this checkout as the app
const exe = dev ? (await import('electron')).default : args[0] && !args[0].startsWith('--') ? resolve(args[0]) : null;
if (!exe || !existsSync(exe)) {
  console.error('usage: node scripts/smoke-app.mjs <app binary> | --dev [--screenshot file.png] [--timeout 120]');
  process.exit(2);
}
const isAppImage = /\.appimage$/i.test(exe);
const timeoutMs = Number(opt('timeout', 120)) * 1000;
const shot = opt('screenshot');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portTaken = () => new Promise((r) => {
  const s = createConnection({ port: PORT, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); r(true); });
  s.once('error', () => r(false));
});

if (await portTaken()) {
  console.error(`Port ${PORT} is already in use – quit the running souldew (or whatever listens there) first.`);
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'souldew-smoke-'));
if (opt('lang')) writeFileSync(join(profile, 'config.json'), JSON.stringify({ onboarded: true, lang: opt('lang'), playerName: 'Smoke' }));
const log = [];
const child = spawn(exe, [...(dev ? [root] : []), `--user-data-dir=${profile}`], { cwd: dev ? root : undefined, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' } });
child.stdout.on('data', (d) => log.push(String(d)));
child.stderr.on('data', (d) => log.push(String(d)));
let exited = null;
child.on('exit', (code) => (exited = code));

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const base = `http://127.0.0.1:${PORT}`;

try {
  let status = null;
  const started = Date.now();
  while (Date.now() - started < timeoutMs && exited === null) {
    try {
      const res = await fetch(`${base}/api/status`);
      if (res.ok) {
        status = await res.json();
        break;
      }
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  check(!!status, `embedded server answers on ${PORT} (${Math.round((Date.now() - started) / 1000)} s)`);
  if (status) {
    console.log(`     platform ${status.platform}/${status.arch}, java ${status.java?.version} (${status.java?.bin})`);
    check(status.app === true, dev ? 'runs as the desktop app (data in the profile folder)' : 'runs as the packaged app (data in the profile folder)');
    check(status.platform === process.platform, `reports platform ${process.platform}`);
    check(status.java?.ok === true && status.java?.bundled === true, 'bundled Java runtime found and runs');
    check(status.upr?.installed === true && status.upr?.bridge === true, 'randomizer + bridge bundled');
    const page = await (await fetch(`${base}/`)).text();
    check(page.includes('id="app"'), 'main page loads');
    check((await fetch(`${base}/app.mjs`)).ok, 'UI code is served');
    check((await fetch(`${base}/i18n/de.json`)).ok, 'translations are served');
    check((await fetch(`${base}/api/randomizer/presets`)).ok, 'API answers');
    // The randomizer itself, with the app's bundled tools: the bridge lists UPR's settings – that needs the bundled
    // java(.exe), the class path (';' on Windows) and UPR's classes to load, exactly as a real build does.
    // The app's tools folder: next to the binary – inside the AppImage's mount (only there while the app runs; the Java
    // it reports sits in <tools>/jre/<platform>-<arch>/bin), or this checkout's tools/ for --dev.
    process.env.SLS_TOOLS_DIR = dev ? join(root, 'tools')
      : isAppImage ? resolve(dirname(String(status.java?.bin || '')), '..', '..', '..')
        : process.platform === 'darwin' ? join(dirname(exe), '..', 'Resources', 'tools') : join(dirname(exe), 'resources', 'tools');
    process.env.SLS_DATA_DIR = profile;
    const { runBridge, detectJava } = await import('../server/lib/toolchain.mjs');
    check(detectJava().bundled === true, `bridge uses the bundled Java (${detectJava().bin})`);
    try {
      const r = await runBridge(['fields'], { timeoutMs: 60000 });
      check(!!r.json && Object.keys(r.json).length > 10, `randomizer bridge runs (${Object.keys(r.json || {}).length} settings)`);
    } catch (e) {
      check(false, `randomizer bridge runs: ${e.message}`);
    }
    if (args.includes('--emulators')) {
      for (const id of ['melonds', 'mgba']) {
        const t0 = Date.now();
        const install = fetch(`${base}/api/emulators/${id}/install`, { method: 'POST', headers: { 'x-soullink': '1', 'content-type': 'application/json' }, body: '{}' });
        // unpacking runs on a worker thread: the app keeps answering meanwhile
        await sleep(1500);
        const t1 = Date.now();
        const alive = await fetch(`${base}/api/status`).then((r) => r.ok, () => false);
        check(alive && Date.now() - t1 < 3000, `app stays responsive while ${id} installs (${Date.now() - t1} ms)`);
        const res = await install;
        const r = await res.json().catch(() => ({}));
        check(res.ok && r.installed === true && /\.exe$|\.app$|AppImage$/i.test(r.path || ''), `one-click ${id} ${r.version || ''} → ${r.path || r.error} (${Math.round((Date.now() - t0) / 1000)} s)`);
      }
    }
    if (shot && process.platform === 'win32') {
      await sleep(12000); // boot animation + first paint
      const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${resolve(shot).replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`;
      const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
      console.log(r.status === 0 ? `     screenshot: ${shot}` : '     (screenshot failed)');
    } else if (shot && process.platform === 'linux') {
      await sleep(12000);
      const r = spawnSync('import', ['-window', 'root', resolve(shot)], { stdio: 'inherit' }); // ImageMagick, on $DISPLAY (xvfb)
      console.log(r.status === 0 ? `     screenshot: ${shot}` : '     (screenshot failed – is ImageMagick installed?)');
    }
  }
  check(exited === null, 'app still running');
} finally {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
  await sleep(2000);
  if (exited === null && process.platform !== 'win32') {
    child.kill('SIGKILL'); // didn't quit on SIGTERM
    await sleep(1000);
  }
  if (failures.length) writeFileSync(join(process.cwd(), 'smoke-app.log'), log.join(''));
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Windows may still hold a file for a moment
  }
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed – app output in smoke-app.log`);
  process.exit(1);
}
console.log('\nsmoke test passed');
