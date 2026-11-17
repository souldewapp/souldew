// The randomizer stopping on a game (Discord: "Randomizer-Fehler: java.lang.ArrayIndexOutOfBoundsException: Index
// 1286 out of bounds for length 1268 – every time I try to make a nuzlocke"): the wizard learns before a build that UPR
// ZX can't randomize a game (a trial run with the recommended preset, nothing written), a build that fails anyway
// says so in words the page translates – never Java's own text or the randomizer's output (#43).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'sls-randoerr-'));
process.env.SLS_DATA_DIR = DATA;
const { randomizerError, inspectRom, javaOptsFor, bridgeCommand, JAVA_OPTS } = await import('../server/lib/toolchain.mjs');
const { ctrRandoError } = await import('../server/lib/ctrrando.mjs');
const { buildRun } = await import('../server/lib/build.mjs');
const { errorBody } = await import('../server/app.mjs');
const { serverErrorText } = await import('../web/lib/errors.mjs');
const { PRESETS, buildValues, toProperties } = await import('../shared/randomizer-options.mjs');
test.after(() => rmSync(DATA, { recursive: true, force: true }));

const AIOOBE = 'java.lang.ArrayIndexOutOfBoundsException: Index 1286 out of bounds for length 1268';
/** What runBridge rejects with when UPR throws (server/lib/toolchain.mjs): the @@ERROR text and the stack trace. */
const bridgeFailure = (error = AIOOBE, more = {}) => Object.assign(new Error(`Randomizer-Fehler: ${error}`), {
  details: { error, exitCode: 1, stdout: `@@ERROR "${error}"`, stderr: `${error}\n\tat com.dabomstew.pkrandom.romhandlers.Gen5RomHandler.setStarters(Gen5RomHandler.java:1)\n/Users/someone/Games/White.nds` },
  ...more,
});

test('a randomizer crash becomes a translated answer naming only the exception\'s class', () => {
  const e = randomizerError(bridgeFailure());
  assert.equal(e.status, 422);
  assert.equal(e.code, 'randoFailed');
  assert.equal(e.vars.what, 'ArrayIndexOutOfBoundsException');
  assert.ok(e.details, 'the output stays on the error for the server log');
  // the text the player reads names only the class …
  const body = JSON.stringify(errorBody(e));
  const shown = serverErrorText(errorBody(e), 422);
  for (const raw of ['1286', '1268', 'java.lang', 'Gen5RomHandler', '/Users/someone']) assert.ok(!shown.includes(raw), raw);
  // … while the diagnostics get where it stopped (message and frames), never a path on the player's computer
  assert.deepEqual(e.vars.trace, [AIOOBE, 'Gen5RomHandler.setStarters:1']);
  assert.ok(!body.includes('/Users/someone'));
  const io = randomizerError(bridgeFailure('java.io.FileNotFoundException: /Users/someone/Library/Caches/souldew/a/0/1/6 (No such file)'));
  assert.equal(io.vars.trace[0], 'java.io.FileNotFoundException: … (No such file)');
  // a wrapped one (UPR's RandomizerIOException) and one without an @@ERROR line
  assert.equal(randomizerError(bridgeFailure('com.dabomstew.pkrandom.exceptions.RandomizerIOException: java.io.FileNotFoundException: /x/a002')).vars.what, 'RandomizerIOException');
  const bare = randomizerError(Object.assign(new Error('Randomizer-Fehler: Exit-Code 137'), { details: { error: null, exitCode: 137, stdout: '', stderr: '' } }));
  assert.deepEqual([bare.code, bare.vars.what], ['randoFailed', 'exit 137']);
  assert.equal(randomizerError(bridgeFailure('x', { code: 'timeout' })).code, 'randoTimeout');
  // answers already: Java or the randomizer missing (no bridge output), an HTTP error
  const noJava = new Error('Java 8+ wurde nicht gefunden.');
  assert.equal(randomizerError(noJava), noJava);
  const known = Object.assign(new Error('x'), { status: 400, code: 'badRun' });
  assert.equal(randomizerError(known), known);
  // 3DS: its own codes first, everything else the same way
  assert.equal(ctrRandoError(bridgeFailure()).code, 'randoFailed');
  assert.equal(ctrRandoError(bridgeFailure('x', { code: 'memory' })).code, 'ctrMemory');
});

test('a build the randomizer stops: the readable error, no half-built run left behind', async () => {
  const lib = join(DATA, 'Library');
  mkdirSync(lib, { recursive: true });
  const rom = join(lib, 'White.gba');
  const bytes = Buffer.alloc(0x400);
  bytes[0xb2] = 0x96; // a GBA header
  writeFileSync(rom, bytes);
  const before = existsSync(join(DATA, 'runs')) ? readdirSync(join(DATA, 'runs')) : [];
  const calls = [];
  await assert.rejects(buildRun({ romId: rom, gameId: 'pokemon-emerald', randomize: true, values: buildValues(PRESETS[0].values, 3), seeds: { p1: '1' }, mode: 'nuzlocke',
    players: { p1: { name: 'Ash' } }, config: {} }, () => {}, () => {}, { bridge: async (args) => { calls.push(args); throw bridgeFailure(); } }),
  (e) => e.status === 422 && e.code === 'randoFailed' && !/1286|java\.lang/.test(e.message));
  assert.equal(calls[0][0], 'randomize');
  assert.deepEqual(readdirSync(join(DATA, 'runs')).filter((d) => !d.startsWith('.')), before.filter((d) => !d.startsWith('.')));
});

test('inspect: a trial run with the recommended preset; a game UPR can\'t randomize is known before the build', async () => {
  const calls = [];
  const fake = (json, fail = null) => async (args) => {
    calls.push({ args, props: readFileSync(args[2], 'utf8') });
    if (fail) throw fail;
    return { json };
  };
  const ok = await inspectRom('/g.nds', { gen: 5, run: fake({ generation: 5, pokemonCount: 649, trial: null }) });
  assert.equal(ok.unsupported, undefined);
  assert.equal(ok.pokemonCount, 649);
  assert.deepEqual(calls[0].args.slice(0, 2), ['info', '/g.nds']);
  assert.equal(calls[0].args[3], '1', 'a fixed seed: the same answer every time');
  assert.equal(calls[0].props, toProperties(buildValues(PRESETS[0].values, 5)), 'the wizard\'s default preset, for this generation');
  assert.ok(!existsSync(calls[0].args[2]), 'the settings file is removed');
  const crash = await inspectRom('/g.nds', { gen: 5, run: fake({ generation: 5, pokemonCount: 649, trial: 'ArrayIndexOutOfBoundsException' }) });
  assert.deepEqual([crash.unsupported, crash.reason, crash.what, crash.generation], [true, 'randoCrash', 'ArrayIndexOutOfBoundsException', 5]);
  // the trial's stack trace (the bridge prints it after "@@TRIAL") comes along for the diagnostics
  const traced = await inspectRom('/g.nds', { gen: 5, run: async () => ({
    json: { generation: 5, trial: 'ArrayIndexOutOfBoundsException' },
    stderr: 'noise\n@@TRIAL java.lang.ArrayIndexOutOfBoundsException: Index 707 out of bounds for length 375\njava.lang.ArrayIndexOutOfBoundsException: Index 707 out of bounds for length 375\n\tat com.dabomstew.pkrandom.romhandlers.Gen5RomHandler.setStarters(Gen5RomHandler.java:1234)\n\tat com.dabomstew.pkrandom.Randomizer.randomize(Randomizer.java:88)\n',
  }) });
  assert.deepEqual(traced.trace, ['java.lang.ArrayIndexOutOfBoundsException: Index 707 out of bounds for length 375', 'Gen5RomHandler.setStarters:1234', 'Randomizer.randomize:88']);
  // UPR can't load it at all: unsupported – without the bridge's text in the answer
  const warn = console.warn;
  console.warn = () => {};
  try {
    const bad = await inspectRom('/g.nds', { run: fake(null, bridgeFailure()) });
    assert.equal(bad.unsupported, true);
    assert.ok(!JSON.stringify(bad).includes('1286'));
  } finally {
    console.warn = warn;
  }
});

test('every bridge run gets its own working folder (two runs on one game don\'t share UPR\'s unpacked files)', () => {
  assert.deepEqual(javaOptsFor({ workDir: '/tmp/w' }), [...JAVA_OPTS, '-Dsouldew.upr.root=/tmp/w']);
  const src = readFileSync(new URL('../server/lib/toolchain.mjs', import.meta.url), 'utf8');
  assert.match(src, /const workDir = join\(CACHE_DIR, ctr \? 'upr-3ds' : 'upr-work', randomBytes\(6\)\.toString\('hex'\)\);/);
  assert.equal(bridgeCommand({ java: { bin: 'java' }, workDir: '/tmp/w', platform: 'linux' })[2], '/tmp/w'); // the folder is the bridge's cwd
});

test('the wizard says why the randomizer is off; the new messages are translated', () => {
  const wizard = readFileSync(new URL('../web/views/soullink.mjs', import.meta.url), 'utf8');
  assert.match(wizard, /inspect\.info\?\.reason === 'randoCrash' \? \(solo \? t\('new\.randoCrashSolo'/);
  const app = readFileSync(new URL('../server/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /info = await inspectRom\(patched\.path, \{ gen: /);
  const en = JSON.parse(readFileSync(new URL('../web/i18n/en.json', import.meta.url), 'utf8'));
  for (const lang of ['en', 'de', 'fr', 'es', 'it']) {
    const d = JSON.parse(readFileSync(new URL(`../web/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const k of ['err.randoFailed', 'err.randoTimeout', 'new.randoCrash', 'new.randoCrashSolo']) {
      assert.ok(d[k], `${lang}: ${k}`);
      assert.doesNotMatch(d[k], /faint/i, `${lang}: ${k}`);
      assert.deepEqual((d[k].match(/\{\w+\}/g) || []).sort(), (en[k].match(/\{\w+\}/g) || []).sort(), `${lang}: ${k}`);
    }
  }
});

test('a randomizer message names no folder – not even one with spaces in it (Windows and POSIX)', async () => {
  const { randomizerTrace } = await import('../server/lib/toolchain.mjs');
  const first = (error) => randomizerTrace({ error })[0];
  const cases = [
    ['java.io.FileNotFoundException: C:\\Users\\Max Mustermann\\AppData\\Local\\souldew\\Cache\\upr-work\\ab12\\6 (Das System kann die angegebene Datei nicht finden)', 'java.io.FileNotFoundException: … (Das System kann die angegebene Datei nicht finden)'],
    ['java.io.FileNotFoundException: C:/Users/Max Mustermann/Spiele/White.nds (Access is denied)', 'java.io.FileNotFoundException: … (Access is denied)'],
    ['java.io.IOException: \\\\nas\\Spiele von Max\\White.nds', 'java.io.IOException: …'],
    ['java.io.FileNotFoundException: /Users/anna maria/Library/Application Support/SoulLink Studio/cache/a/0/1/6 (No such file or directory)', 'java.io.FileNotFoundException: … (No such file or directory)'],
    ['java.io.FileNotFoundException: /home/jan de vries/.cache/souldew/a002 (Permission denied)', 'java.io.FileNotFoundException: … (Permission denied)'],
    ['java.io.IOException: file:/Users/anna maria/x.nds', 'java.io.IOException: file:…'],
    // the last part of a path is a user's folder too (it was kept as the file's name: "…/Max")
    ['java.io.IOException: x.nds (in C:\\Users\\Max)', 'java.io.IOException: x.nds (in …)'],
    ['java.io.IOException: C:\\Users\\Max Mustermann', 'java.io.IOException: …'],
    ['java.io.IOException: /home/max', 'java.io.IOException: …'],
    // relative paths (they were left as they were)
    ['java.io.FileNotFoundException: Users\\Max\\rom.gba (x)', 'java.io.FileNotFoundException: … (x)'],
    ['java.io.FileNotFoundException: ..\\Max Mustermann\\x.gba', 'java.io.FileNotFoundException: …'],
    ['java.io.FileNotFoundException: ../Max Mustermann/x.gba (No such file or directory)', 'java.io.FileNotFoundException: … (No such file or directory)'],
    ['java.io.IOException: cannot open Users/Max/x.gba now', 'java.io.IOException: cannot open …'],
    ['java.io.IOException: Spiele\\Max\\x.gba', 'java.io.IOException: …'],
  ];
  for (const [error, want] of cases) {
    const got = first(error);
    assert.equal(got, want);
    for (const name of ['Max', 'Mustermann', 'anna', 'maria', 'jan de vries', 'Users', 'home', 'Spiele']) assert.ok(!got.includes(name), `${name} in ${got}`);
  }
  // what isn't a path stays as it is: a class name's slashes, a message without a path
  assert.equal(first('java.lang.NoClassDefFoundError: com/dabomstew/pkrandom/Foo'), 'java.lang.NoClassDefFoundError: com/dabomstew/pkrandom/Foo');
  for (const keep of ['java.lang.IllegalStateException: com.dabomstew.pkrandom.Foo.bar:123', 'java.lang.NoClassDefFoundError: com/dabomstew/pkrandom/romhandlers/Gen5RomHandler$1 (wrong name: x)',
    'java.lang.IllegalArgumentException: 3 / 4 slots', 'java.lang.RuntimeException: Users of this ROM: 2']) assert.equal(first(keep), keep);
  assert.equal(first(AIOOBE), AIOOBE);
  // the stack trace's first exception line, when no @@ERROR line came, is stripped the same way
  const fromStderr = randomizerTrace({ stderr: 'java.io.FileNotFoundException: C:\\Users\\Max Mustermann\\a\\6 (x)\n\tat com.dabomstew.pkrandom.romhandlers.Gen5RomHandler.loadRom(Gen5RomHandler.java:12)' });
  assert.deepEqual(fromStderr, ['java.io.FileNotFoundException: … (x)', 'Gen5RomHandler.loadRom:12']);
});

test('the randomizer\'s answer never waits for its working folder to go (Windows: a scanner holding a file)', async (t) => {
  const { runBridge, detectJava, UPR_JAR } = await import('../server/lib/toolchain.mjs');
  const { removeQuietly } = await import('../server/lib/fsutil.mjs');
  const { EventEmitter } = await import('node:events');
  const busy = () => Object.assign(new Error('EBUSY: resource busy or locked, rmdir \'C:\\Users\\Max Mustermann\\x\''), { code: 'EBUSY' });
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    // the helper: retried by fs.rm itself, then logged (the code, never the path) and swallowed – also a synchronous throw
    let opts = null;
    assert.equal(await removeQuietly('C:\\Users\\Max Mustermann\\x', { rm: async (p, o) => { opts = o; throw busy(); } }), false);
    assert.equal(await removeQuietly('/x', { rm: () => { throw busy(); } }), false);
    assert.equal(await removeQuietly('/x', { rm: async () => {} }), true);
    assert.ok(opts.maxRetries > 0 && opts.retryDelay > 0 && opts.recursive && opts.force);
    assert.ok(warned.length === 2 && warned.every((w) => w.includes('EBUSY') && !w.includes('Max')), warned.join('\n'));

    if (!detectJava().ok || !existsSync(UPR_JAR)) return t.skip('Java or the randomizer missing');
    const child = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
    let removed = 0;
    const removeDir = async () => {
      removed++;
      throw busy();
    };
    // a run that ends: its answer, although the folder can't be removed
    let c;
    const ok = runBridge(['info', '/g.nds'], { spawnFn: () => (c = child()), removeDir });
    c.stdout.emit('data', '@@JSON {"generation":5}\n');
    c.emit('close', 0);
    const res = await Promise.race([ok, new Promise((r) => setTimeout(() => r('hung'), 2000))]);
    assert.notEqual(res, 'hung');
    assert.equal(res.exitCode, 0);
    // a run that fails, and one Java couldn't start: their errors, the same way
    const failing = runBridge(['info', '/g.nds'], { spawnFn: () => (c = child()), removeDir });
    c.stdout.emit('data', '@@ERROR "java.lang.RuntimeException: x"\n');
    c.emit('close', 1);
    await assert.rejects(failing, /Randomizer error/);
    const broken = runBridge(['info', '/g.nds'], { spawnFn: () => (c = child()), removeDir });
    c.emit('error', Object.assign(new Error('spawn java ENOENT'), { code: 'ENOENT' }));
    c.emit('close', -2); // (Node sends 'close' after 'error' too – the promise is settled already)
    await assert.rejects(broken, /ENOENT/);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(removed >= 3, 'the folder is still removed, afterwards');
  } finally {
    console.warn = warn;
  }
  // nothing in the randomizer's paths removes a folder in a way that can throw into an event handler
  const src = readFileSync(new URL('../server/lib/toolchain.mjs', import.meta.url), 'utf8');
  const bridge = src.slice(src.indexOf('export function runBridge'), src.indexOf('\n}\n', src.indexOf('export function runBridge')));
  assert.doesNotMatch(bridge, /rmSync\(/);
});
