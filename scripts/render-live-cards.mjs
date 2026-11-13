// Paints the "Share to Discord" cards of test/fixtures/livecards.mjs into PNG files – the same code path as the
// share button (web/lib/liveshare.mjs cardModel → web/lib/livecard.mjs), in a hidden, muted Electron window against
// the local server with a throwaway data folder (never your own). Nothing is posted anywhere.
//
//   npx electron scripts/render-live-cards.mjs <out folder> [--lang de] [--data <scratch folder>]
//
// Writes <name>.png per fixture and meta.json (the post's text per card, as buildMeta cleans it).
import { app, BrowserWindow } from 'electron';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LIVE_FIXTURES } from '../test/fixtures/livecards.mjs';
import { pngProblem, buildMeta } from '../shared/liveruns.mjs';

const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('render-live-cards.mjs')) + 1);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const out = resolve(args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) || join(tmpdir(), 'souldew-live-cards'));
const data = resolve(opt('data') || mkdtempSync(join(tmpdir(), 'souldew-live-cards-data-')));
const lang = opt('lang') || 'en';
mkdirSync(out, { recursive: true });
mkdirSync(data, { recursive: true });
process.env.SLS_DATA_DIR = data; // before the server's paths are read: the scratch folder, not the real data
process.env.SOULDEW_LIVE_URL = 'http://127.0.0.1:9'; // and never the real bot (nothing posts here anyway)
app.setPath('userData', join(data, 'electron'));
app.commandLine.appendSwitch('mute-audio');

// a stuck page (a sprite that never answers) must not keep the script alive
setTimeout(() => {
  console.error('timed out');
  app.exit(2);
}, 180000).unref();
process.on('unhandledRejection', (e) => {
  console.error(e?.stack || e);
  app.exit(1);
});

// (no top-level await before 'ready': Electron emits it only once the main module has finished loading)
app.whenReady().then(async () => {
  const { startServer } = await import('../server/app.mjs');
  const { server, url } = await startServer({ port: 0, background: false });
  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (e) => console.log('[page]', e.message));
  await win.loadURL(`${url}/__live-cards`); // any page of the app's origin: the modules load from it
  const results = await win.webContents.executeJavaScript(`(async () => {
    const { RunDoc } = await import('/lib/doc.mjs');
    const { loadData, spriteUrl } = await import('/lib/data.mjs');
    const { setLang } = await import('/lib/i18n.mjs');
    const { cardModel, deathEvent, endEvent } = await import('/lib/liveshare.mjs');
    const { renderCardPng } = await import('/lib/livecard.mjs');
    await setLang(${JSON.stringify(lang)});
    await loadData();
    const fixtures = ${JSON.stringify(LIVE_FIXTURES)};
    const out = [];
    for (const f of fixtures) {
      const doc = new RunDoc(f.manifest.id);
      doc._persistSoon = () => {};
      doc.batch(f.entries);
      const event = f.event.kind === 'death' ? deathEvent(doc, f.manifest, f.event.area) : endEvent(f.manifest, doc.get('run:status'));
      const { model, metaInput } = cardModel({ doc, manifest: f.manifest, gen: f.gen, event, app: '2.6.0' });
      const png = await renderCardPng(model, (id, fallback) => spriteUrl(id, { gen: fallback ? 9 : f.gen }));
      let s = '';
      for (let i = 0; i < png.length; i += 0x8000) s += String.fromCharCode.apply(null, png.subarray(i, i + 0x8000));
      out.push({ name: f.name, png: btoa(s), metaInput });
    }
    return out;
  })()`);
  const metas = {};
  for (const r of results) {
    const buf = Buffer.from(r.png, 'base64');
    const bad = pngProblem(buf);
    if (bad) console.error(`${r.name}: ${bad}`);
    writeFileSync(join(out, `${r.name}${lang === 'en' ? '' : `.${lang}`}.png`), buf);
    metas[r.name] = buildMeta(r.metaInput).meta;
    console.log(`${r.name}: ${(buf.length / 1024).toFixed(0)} KB`);
  }
  writeFileSync(join(out, `meta${lang === 'en' ? '' : `.${lang}`}.json`), `${JSON.stringify(metas, null, 2)}\n`);
  console.log('wrote', results.length, 'cards to', out);
  server.close();
  app.exit(0);
});
