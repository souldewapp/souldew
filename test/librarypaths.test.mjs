// Library paths from the page (#23): "Add files" / "Search my Mac / PC" import and "Use a folder" only take paths
// from approved places – the usual ROM folders discovery looks through, folders already in the library, and what
// was picked in the native dialog this session (server/lib/grants.mjs, registered by electron/main.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'sls-libpaths-'));
const HOME = mkdtempSync(join(tmpdir(), 'sls-libhome-'));
const ELSEWHERE = mkdtempSync(join(tmpdir(), 'sls-libelse-'));
process.env.SLS_DATA_DIR = DATA;
process.env.HOME = HOME; // discovery looks through ~/Downloads, ~/Desktop … of this fake home
process.env.USERPROFILE = HOME;
const { approvedImportPath, approvedFolder, importFiles, discoverRoots } = await import('../server/lib/library.mjs');
const { grantPicked, clearPicked, wasPicked } = await import('../server/lib/grants.mjs');
const { startServer } = await import('../server/app.mjs');
test.after(() => {
  for (const d of [DATA, HOME, ELSEWHERE]) rmSync(d, { recursive: true, force: true });
});

const tryLink = (target, path) => {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
};

mkdirSync(join(HOME, 'Downloads'), { recursive: true });
writeFileSync(join(HOME, 'Downloads', 'found.gba'), 'GBA');
mkdirSync(join(ELSEWHERE, 'picked'), { recursive: true });
mkdirSync(join(ELSEWHERE, 'secret'), { recursive: true });
writeFileSync(join(ELSEWHERE, 'secret', 'id_rsa.gba'), 'KEY');
writeFileSync(join(ELSEWHERE, 'picked', 'mine.nds'), 'NDS');
mkdirSync(join(ELSEWHERE, 'picked', 'sub'), { recursive: true });
writeFileSync(join(ELSEWHERE, 'picked', 'sub', 'deep.gb'), 'GB');
writeFileSync(join(ELSEWHERE, 'single.gbc'), 'GBC');

test('import: discovery folders, library folders and picks only (#23)', () => {
  clearPicked();
  const roots = discoverRoots();
  assert.ok(roots.some((r) => r.endsWith('Downloads')), 'the fake home has a Downloads folder');
  assert.equal(approvedImportPath(join(HOME, 'Downloads', 'found.gba'), {}), join(HOME, 'Downloads', 'found.gba'));
  assert.throws(() => approvedImportPath(join(ELSEWHERE, 'secret', 'id_rsa.gba'), {}), (e) => e.status === 403 && e.code === 'pathNotApproved');
  assert.throws(() => approvedImportPath('relative/x.gba', {}), (e) => e.status === 400);
  assert.throws(() => approvedImportPath(42, {}), (e) => e.status === 400);
  // a folder already in the library
  assert.ok(approvedImportPath(join(ELSEWHERE, 'secret', 'id_rsa.gba'), { libraryFolders: [join(ELSEWHERE, 'secret')] }));
  // picked in the dialog: that file, or anything in a picked folder
  grantPicked([join(ELSEWHERE, 'single.gbc')]);
  assert.ok(approvedImportPath(join(ELSEWHERE, 'single.gbc'), {}));
  assert.throws(() => approvedImportPath(join(ELSEWHERE, 'secret', 'id_rsa.gba'), {}), (e) => e.status === 403, 'a picked file is no picked folder');
  grantPicked([join(ELSEWHERE, 'picked')], { folder: true });
  assert.ok(approvedImportPath(join(ELSEWHERE, 'picked', 'sub', 'deep.gb'), {}));
  // junk handed to grantPicked is ignored
  grantPicked(['relative', null, 7, `${ELSEWHERE}\0x`], { folder: true });
  grantPicked('not a list');
  assert.ok(!wasPicked(join(ELSEWHERE, 'secret', 'id_rsa.gba')));
  clearPicked();
  assert.throws(() => approvedImportPath(join(ELSEWHERE, 'single.gbc'), {}), (e) => e.status === 403, 'picks last one session');
});

test('import: a link inside an approved folder that points elsewhere is refused (#23)', (t) => {
  clearPicked();
  const link = join(HOME, 'Downloads', 'link.gba');
  if (!tryLink(join(ELSEWHERE, 'secret', 'id_rsa.gba'), link)) return t.skip('no symbolic links here');
  assert.throws(() => approvedImportPath(link, {}), (e) => e.status === 403);
});

test('import refuses the whole batch before copying anything (#23)', () => {
  clearPicked();
  const before = existsSync(join(DATA, 'Library')) ? readdirSync(join(DATA, 'Library')) : [];
  assert.throws(() => importFiles([join(HOME, 'Downloads', 'found.gba'), join(ELSEWHERE, 'secret', 'id_rsa.gba')], {}), (e) => e.status === 403);
  const after = existsSync(join(DATA, 'Library')) ? readdirSync(join(DATA, 'Library')) : [];
  assert.deepEqual(after, before);
  assert.throws(() => importFiles('x', {}), (e) => e.status === 400);
});

test('folders: only one picked in the dialog (or one included already) (#23)', () => {
  clearPicked();
  assert.throws(() => approvedFolder(join(ELSEWHERE, 'secret'), {}), (e) => e.status === 403 && e.code === 'folderNotApproved');
  assert.throws(() => approvedFolder(HOME, {}), (e) => e.status === 403, 'not even the home folder');
  assert.equal(approvedFolder(join(ELSEWHERE, 'secret'), { libraryFolders: [join(ELSEWHERE, 'secret')] }), join(ELSEWHERE, 'secret'));
  grantPicked([join(ELSEWHERE, 'picked')], { folder: true });
  assert.equal(approvedFolder(join(ELSEWHERE, 'picked'), {}), join(ELSEWHERE, 'picked'));
  assert.equal(approvedFolder(join(ELSEWHERE, 'picked', 'sub'), {}), join(ELSEWHERE, 'picked', 'sub'));
  clearPicked();
});

test('server: import and "use a folder" with raw paths from the page (#23)', async () => {
  clearPicked();
  const { server, url } = await startServer({ port: 0, background: false });
  const post = (path, body) => fetch(`${url}${path}`, { method: 'POST', headers: { 'x-soullink': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    // "Search my Mac / PC" finds it in Downloads → importing it works (also in the browser, without the native app)
    const ok = await post('/api/library/import', { paths: [join(HOME, 'Downloads', 'found.gba')] });
    assert.equal(ok.status, 200);
    assert.ok(existsSync(join(DATA, 'Library', 'found.gba')));
    // a raw path somewhere else: refused, nothing copied
    const bad = await post('/api/library/import', { paths: [join(ELSEWHERE, 'secret', 'id_rsa.gba')] });
    assert.equal(bad.status, 403);
    assert.equal((await bad.json()).code, 'pathNotApproved');
    assert.ok(!existsSync(join(DATA, 'Library', 'id_rsa.gba')));
    const folder = await post('/api/library/folders', { add: join(ELSEWHERE, 'secret') });
    assert.equal(folder.status, 403);
    // what the native dialog registered (electron/main.mjs → grantPicked) works
    grantPicked([join(ELSEWHERE, 'single.gbc')]);
    assert.equal((await post('/api/library/import', { paths: [join(ELSEWHERE, 'single.gbc')] })).status, 200);
    grantPicked([join(ELSEWHERE, 'picked')], { folder: true });
    const added = await post('/api/library/folders', { add: join(ELSEWHERE, 'picked') });
    assert.equal(added.status, 200);
    assert.deepEqual((await added.json()).libraryFolders, [join(ELSEWHERE, 'picked')]);
    clearPicked();
    // removing never needs a pick; an included folder stays readable after a restart (config), no pick needed
    assert.equal((await post('/api/library/import', { paths: [join(ELSEWHERE, 'picked', 'mine.nds')] })).status, 200);
    assert.deepEqual((await (await post('/api/library/folders', { remove: join(ELSEWHERE, 'picked') })).json()).libraryFolders, []);
  } finally {
    server.close();
    clearPicked();
  }
});
