// Builds souldew's fast player part into tools/native/<platform>-<arch>/ (bundled with the app like the 3DS part, see
// package.json and server/lib/native.mjs):
//   retrohost[.exe]              native/retro-host/retrohost.c – the host that runs a libretro core for the player page
//   melondsds_libretro.*         DS: melonDS DS (JesseTG/melonds-ds) – software 3D on its own thread, the JIT on
//   mgba_libretro.*              GBA: mGBA
//   gambatte_libretro.*          Game Boy / Game Boy Color: Gambatte (libretro's port)
//   SOURCES.txt                  which source each file was built from (GPL: the same tags/commits are public)
//
//   node scripts/build-native.mjs [--platform win32-x64] [--only nds,gba,gb] [--host-only] [--jobs n]
//   node scripts/build-native.mjs --check      (npm run dist: fails when the part is missing; SLS_NO_NATIVE=1 builds
//                                               without it – the built-in browser emulator then plays everything)
//
// The sources are cloned at fixed tags/commits into _ref/native/. Needs git, cmake, ninja, make and a C/C++
// compiler; Windows is cross-compiled with MinGW-w64 (macOS: brew install mingw-w64; Ubuntu: apt install mingw-w64) –
// every library is linked in statically, the DLLs need nothing but Windows itself.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);
const plat = opt('platform', `${process.platform}-${process.arch}`);
const [os, arch] = plat.split('-');
const cross = plat !== `${process.platform}-${process.arch}`;
const win = os === 'win32';
const ext = win ? 'dll' : os === 'darwin' ? 'dylib' : 'so';
const out = join(root, 'tools', 'native', plat);
const jobs = String(opt('jobs', Math.max(2, cpus().length)));
const only = new Set(String(opt('only', 'nds,gba,gb')).split(','));

/** The sources, at fixed versions (bump them here; SOURCES.txt in the build says which ones went in). */
export const SOURCES = {
  nds: { name: 'melonDS DS', repo: 'https://github.com/JesseTG/melonds-ds.git', ref: 'v1.4.0', file: `melondsds_libretro.${ext}` },
  gba: { name: 'mGBA', repo: 'https://github.com/mgba-emu/mgba.git', ref: '0.10.5', file: `mgba_libretro.${ext}` },
  gb: { name: 'Gambatte (libretro)', repo: 'https://github.com/libretro/gambatte-libretro.git', ref: '77f2567d718b8973d02caa2daa8dce4953faf811', file: `gambatte_libretro.${ext}` },
};
const HOST = win ? 'retrohost.exe' : 'retrohost';

if (has('check')) {
  const need = [HOST, ...Object.values(SOURCES).map((s) => s.file)];
  const missing = need.filter((f) => !existsSync(join(out, f)));
  if (!missing.length) {
    console.log(`fast player part: ${out} ✓`);
    process.exit(0);
  }
  const msg = `fast player part incomplete in ${out} (missing: ${missing.join(', ')}). Build it with \`npm run native\` (see docs/DEVELOPMENT.md › "Fast player").`;
  if (process.env.SLS_NO_NATIVE) {
    console.warn(`${msg}\nSLS_NO_NATIVE is set: building without it – the browser emulator plays every game.`);
    process.exit(0);
  }
  console.error(`${msg}\nOr set SLS_NO_NATIVE=1 to build without it.`);
  process.exit(1);
}

const run = (cmd, a, o = {}) => {
  console.log(`$ ${cmd} ${a.join(' ')}`);
  const r = spawnSync(cmd, a, { stdio: 'inherit', ...o });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`);
};

const MINGW = 'x86_64-w64-mingw32';
const cc = process.env.CC || (win ? (cross ? `${MINGW}-gcc` : 'gcc') : 'cc');
const cxx = process.env.CXX || (win ? (cross ? `${MINGW}-g++` : 'g++') : 'c++');

/** A checkout of `s` at its ref in _ref/native (cloned once). */
function source(key) {
  const s = SOURCES[key];
  const dir = join(root, '_ref', 'native', `${key}-${s.ref.slice(0, 12)}`);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    run('git', ['init', '-q', dir]);
    run('git', ['-C', dir, 'remote', 'add', 'origin', s.repo]);
    run('git', ['-C', dir, 'fetch', '-q', '--depth', '1', 'origin', s.ref]);
    run('git', ['-C', dir, 'checkout', '-q', 'FETCH_HEAD']);
  }
  return dir;
}

/** CMake arguments for the target platform (the compiler, Windows cross build, a static runtime). */
function cmakeTarget() {
  const a = ['-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POLICY_VERSION_MINIMUM=3.5'];
  if (os === 'darwin') a.push(`-DCMAKE_OSX_ARCHITECTURES=${arch === 'arm64' ? 'arm64' : 'x86_64'}`, '-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0');
  if (win) {
    const st = '-static -static-libgcc -static-libstdc++';
    a.push(`-DCMAKE_C_COMPILER=${cc}`, `-DCMAKE_CXX_COMPILER=${cxx}`, `-DCMAKE_SHARED_LINKER_FLAGS=${st}`, `-DCMAKE_MODULE_LINKER_FLAGS=${st}`);
    if (cross) a.push('-DCMAKE_SYSTEM_NAME=Windows', '-DCMAKE_SYSTEM_PROCESSOR=x86_64', `-DCMAKE_RC_COMPILER=${MINGW}-windres`, `-DCMAKE_FIND_ROOT_PATH=/usr/${MINGW}`,
      '-DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER', '-DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY', '-DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY', '-DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=ONLY');
  } else if (os === 'linux') {
    a.push(`-DCMAKE_C_COMPILER=${cc}`, `-DCMAKE_CXX_COMPILER=${cxx}`, '-DCMAKE_SHARED_LINKER_FLAGS=-static-libgcc -static-libstdc++', '-DCMAKE_MODULE_LINKER_FLAGS=-static-libgcc -static-libstdc++');
  }
  return a;
}

function buildNds() {
  const src = source('nds');
  const build = join(src, `build-${plat}`);
  // no OpenGL (the page draws the picture), no Wi-Fi (souldew never goes online through the core), the JIT on
  run('cmake', [...cmakeTarget(), '-DENABLE_OPENGL=OFF', '-DENABLE_JIT=ON', '-DENABLE_LTO_RELEASE=OFF', '-DBUILD_TESTING=OFF', '-DTRACY_ENABLE=OFF', '-S', src, '-B', build]);
  run('cmake', ['--build', build, '--parallel', jobs]);
  copyFileSync(join(build, 'src', 'libretro', SOURCES.nds.file), join(out, SOURCES.nds.file));
}

function buildGba() {
  const src = source('gba');
  const build = join(src, `build-${plat}`);
  const off = ['QT', 'SDL', 'GL', 'GLES2', 'GLES3', 'EPOXY'].map((x) => `-DBUILD_${x}=OFF`);
  const no = ['FFMPEG', 'ZLIB', 'LIBZIP', 'MINIZIP', 'PNG', 'SQLITE3', 'ELF', 'LUA', 'EDITLINE', 'DISCORD_RPC', 'EPOXY', 'JSON_C', 'DEBUGGERS', 'GDB_STUB'].map((x) => `-DUSE_${x}=OFF`);
  run('cmake', [...cmakeTarget(), '-DBUILD_LIBRETRO=ON', '-DBUILD_SHARED=OFF', '-DBUILD_STATIC=OFF', '-DSKIP_LIBRARY=ON', ...off, ...no, '-S', src, '-B', build]);
  run('cmake', ['--build', build, '--parallel', jobs, '--target', 'mgba_libretro']);
  copyFileSync(join(build, SOURCES.gba.file), join(out, SOURCES.gba.file));
}

function buildGb() {
  const src = source('gb');
  const platform = win ? 'win' : os === 'darwin' ? 'osx' : 'unix';
  const extra = os === 'darwin' ? [`ARCHFLAGS=-arch ${arch === 'arm64' ? 'arm64' : 'x86_64'} -mmacosx-version-min=11.0`] : [];
  run('make', ['-C', src, '-f', 'Makefile.libretro', 'clean'], { stdio: 'ignore' });
  run('make', ['-C', src, '-f', 'Makefile.libretro', `platform=${platform}`, 'HAVE_NETWORK=0', `CC=${cc}`, `CXX=${cxx}`, ...extra, `-j${jobs}`]);
  copyFileSync(join(src, SOURCES.gb.file), join(out, SOURCES.gb.file));
}

function buildHost() {
  const exe = join(out, HOST);
  const libs = os === 'linux' ? ['-ldl', '-lpthread', '-lm'] : win ? ['-static', '-lm'] : [];
  const flags = os === 'darwin' ? [`-arch`, arch === 'arm64' ? 'arm64' : 'x86_64', '-mmacosx-version-min=11.0'] : [];
  run(cc, ['-O2', '-Wall', ...flags, '-I', join(root, 'native', 'ctr-host'), '-o', exe, join(root, 'native', 'retro-host', 'retrohost.c'), ...libs]);
  if (!win) chmodSync(exe, 0o755);
}

mkdirSync(out, { recursive: true });
buildHost();
if (!has('host-only')) {
  if (only.has('nds')) buildNds();
  if (only.has('gba')) buildGba();
  if (only.has('gb')) buildGb();
}
const lines = Object.entries(SOURCES).filter(([, s]) => existsSync(join(out, s.file))).map(([, s]) => `${s.file}: ${s.name} ${s.ref} – ${s.repo.replace(/\.git$/, '')}`);
const prev = existsSync(join(out, 'SOURCES.txt')) ? readFileSync(join(out, 'SOURCES.txt'), 'utf8') : '';
writeFileSync(join(out, 'SOURCES.txt'), `${[`${HOST}: souldew native/retro-host/retrohost.c`, ...lines].join('\n')}\n`);
if (prev && prev !== readFileSync(join(out, 'SOURCES.txt'), 'utf8')) console.log('SOURCES.txt updated');
console.log(`fast player part: ${out}`);
