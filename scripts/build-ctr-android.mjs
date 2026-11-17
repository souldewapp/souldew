#!/usr/bin/env node
// Builds souldew's Nintendo 3DS part for Android (arm64-v8a) into android/app/ctr/arm64-v8a/:
//   libazahar_libretro.so   Azahar's libretro core with native/azahar-patch/*.patch applied (live data, Rare Candy writes,
//                           and the Android strerror_r fix) – stripped
//   libctrhost.so           native/ctr-host/ctrhost.c as an executable (named lib*.so: an app may only run files from
//                           its native library folder, see docs/ANDROID.md)
// The Gradle build packs both into the APK (android/app/build.gradle.kts › jniLibs "ctr").
//
//   node scripts/build-ctr-android.mjs [--azahar <tag>] [--src <Azahar checkout>] [--ndk <dir>] [--host-only] [--jobs N]
//
// Needs git, cmake ≥ 3.25, ninja and the Android NDK r27 (ANDROID_NDK_HOME, or $ANDROID_HOME/ndk/27.2.12479018). The
// core takes a long time (Azahar from source: 20–40 min on a fast PC); the checkout goes to _ref/azahar-<tag>.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);
const win = process.platform === 'win32';

// the same Azahar release as the desktop builds (scripts/build-ctr.mjs, .github/workflows/ctr.yml)
const TAG = opt('azahar', process.env.AZAHAR_TAG || '2126.2');
const NDK_VERSION = '27.2.12479018';
const API = 26;
const out = join(root, 'android', 'app', 'ctr', 'arm64-v8a');

const run = (cmd, argv, o = {}) => {
  console.log(`$ ${cmd} ${argv.join(' ')}`);
  const r = spawnSync(cmd, argv, { stdio: 'inherit', shell: win && /\.(cmd|bat)$/i.test(cmd), ...o });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status ?? r.signal})`);
};

function findNdk() {
  const candidates = [opt('ndk'), process.env.ANDROID_NDK_HOME, process.env.ANDROID_NDK_ROOT];
  for (const home of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, win ? join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk') : null].filter(Boolean)) {
    candidates.push(join(home, 'ndk', NDK_VERSION));
  }
  const ndk = candidates.find((d) => d && existsSync(join(d, 'build', 'cmake', 'android.toolchain.cmake')));
  if (!ndk) throw new Error(`Android NDK not found (need r27, ${NDK_VERSION}): set ANDROID_NDK_HOME or pass --ndk`);
  return ndk;
}

const ndk = findNdk();
const hostTag = { win32: 'windows-x86_64', darwin: 'darwin-x86_64', linux: 'linux-x86_64' }[process.platform];
const bin = join(ndk, 'toolchains', 'llvm', 'prebuilt', hostTag, 'bin');
mkdirSync(out, { recursive: true });

// ---- the host ----------------------------------------------------------------------------------------------------
const clang = join(bin, `aarch64-linux-android${API}-clang${win ? '.cmd' : ''}`);
run(clang, ['-O2', '-fPIE', '-pie', '-Wall', '-Wno-unused-function', `-I${join(root, 'native', 'ctr-host')}`,
  '-o', join(out, 'libctrhost.so'), join(root, 'native', 'ctr-host', 'ctrhost.c'), '-lm', '-ldl']);
run(join(bin, `llvm-strip${win ? '.exe' : ''}`), ['--strip-unneeded', join(out, 'libctrhost.so')]);

if (!has('host-only')) {
  // ---- the core --------------------------------------------------------------------------------------------------
  const src = resolve(opt('src', join(root, '_ref', `azahar-${TAG}`)));
  if (!existsSync(join(src, 'CMakeLists.txt'))) {
    mkdirSync(dirname(src), { recursive: true });
    run('git', ['clone', '--depth', '1', '--branch', TAG, '--recurse-submodules', '--shallow-submodules', 'https://github.com/azahar-emu/azahar.git', src]);
  }
  for (const p of readdirSync(join(root, 'native', 'azahar-patch')).filter((f) => f.endsWith('.patch')).sort()) {
    const patch = join(root, 'native', 'azahar-patch', p);
    // once: a checkout that has the patch already is left as it is
    if (spawnSync('git', ['apply', '--reverse', '--check', patch], { cwd: src }).status !== 0) run('git', ['apply', patch], { cwd: src });
  }
  const build = join(src, 'build-android');
  run('cmake', ['-G', 'Ninja', '-DENABLE_LIBRETRO=ON', '-DCMAKE_BUILD_TYPE=Release', `-DCMAKE_TOOLCHAIN_FILE=${join(ndk, 'build', 'cmake', 'android.toolchain.cmake')}`,
    `-DANDROID_PLATFORM=android-${API}`, '-DANDROID_STL=c++_static', '-DANDROID_ABI=arm64-v8a', '-S', src, '-B', build]);
  run('cmake', ['--build', build, '--target', 'azahar_libretro', '-j', String(opt('jobs', availableParallelism()))]);
  copyFileSync(join(build, 'bin', 'Release', 'azahar_libretro.so'), join(out, 'libazahar_libretro.so'));
  run(join(bin, `llvm-strip${win ? '.exe' : ''}`), ['--strip-unneeded', join(out, 'libazahar_libretro.so')]);
}

for (const f of ['libctrhost.so', 'libazahar_libretro.so']) {
  if (!existsSync(join(out, f))) console.warn(`note: ${f} is not in ${out}`);
}
console.log(`3DS part for Android: ${out}`);
