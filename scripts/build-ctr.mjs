// Builds souldew's 3DS part into tools/ctr/<platform>-<arch>/ (bundled with the app like the JRE, see package.json):
//   ctrhost[.exe]            native/ctr-host/ctrhost.c – the host that runs the core with Vulkan (needs the Vulkan headers)
//   azahar_libretro.*        Azahar's libretro core with native/azahar-patch applied (live data: reading game memory)
//   libMoltenVK.dylib        macOS only – Vulkan on Metal, from Azahar's own macOS release
//   SOULDEW_CORE             marker: the core has the souldew patch
//
//   node scripts/build-ctr.mjs [--azahar <tag>] [--src <dir>] [--core <built core>] [--moltenvk <dylib>] [--host-only]
//   node scripts/build-ctr.mjs --check      (npm run dist: fails when the 3DS part is missing or lacks the souldew patch;
//                                            SLS_NO_3DS=1 builds without it – 3DS games then open in Azahar itself)
//   node scripts/build-ctr.mjs --platform win32-x64 --host-only    (the Windows host from macOS / Linux with MinGW-w64)
//
// Windows: MinGW-w64 or clang; the Vulkan loader (vulkan-1.dll) comes with the graphics driver. Linux: gcc/clang,
// libvulkan1 on the system. The core for both is built like Azahar's own CI (.github/workflows/ctr.yml).
//
// --src reuses an Azahar checkout (with submodules); without it the tag is cloned into _ref/azahar-<tag>. --core
// skips building the core (copies a built one). Needs git, cmake, ninja, a C/C++ compiler, the Vulkan headers and – on
// macOS – spirv-tools (as Azahar's own CI: brew install cmake ninja spirv-tools vulkan-headers).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);
const TAG = opt('azahar', '2126.2');
const plat = opt('platform', `${process.platform}-${process.arch}`);
const [os] = plat.split('-');
const cross = plat !== `${process.platform}-${process.arch}`;
const out = join(root, 'tools', 'ctr', plat);
const ext = os === 'win32' ? 'dll' : os === 'darwin' ? 'dylib' : 'so';
if (has('check')) {
  const need = [os === 'win32' ? 'ctrhost.exe' : 'ctrhost', `azahar_libretro.${ext}`, 'SOULDEW_CORE', ...(os === 'darwin' ? ['libMoltenVK.dylib'] : [])];
  const missing = need.filter((f) => !existsSync(join(out, f)));
  if (!missing.length) {
    console.log(`3DS part: ${out} ✓`);
    process.exit(0);
  }
  const msg = `3DS part incomplete in ${out} (missing: ${missing.join(', ')}). Build it with \`npm run ctr\` (see docs/DEVELOPMENT.md › "Nintendo 3DS").`;
  if (process.env.SLS_NO_3DS) {
    console.warn(`${msg}\nSLS_NO_3DS is set: building without it – 3DS games open in Azahar itself.`);
    process.exit(0);
  }
  console.error(`${msg}\nOr set SLS_NO_3DS=1 to build without it.`);
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const run = (cmd, a, o = {}) => {
  console.log(`$ ${cmd} ${a.join(' ')}`);
  const r = spawnSync(cmd, a, { stdio: 'inherit', ...o });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`);
};

// ---- the host -------------------------------------------------------------------------------------------------------
function buildHost() {
  const src = join(root, 'native', 'ctr-host');
  const exe = join(out, os === 'win32' ? 'ctrhost.exe' : 'ctrhost');
  const inc = ['-I', src];
  // the Vulkan headers (only the types are used – the loader is opened at run time)
  // (CTR_VULKAN_INCLUDE first – e.g. Azahar's externals/vulkan-headers/include; a cross build never takes the
  // system's /usr/include, it would bring the build machine's C headers along)
  const env = process.env;
  const fromAzahar = azahar && join(azahar, 'externals', 'vulkan-headers', 'include'); // the checkout that builds the core
  const dirs = [env.CTR_VULKAN_INCLUDE, env.VULKAN_SDK && join(env.VULKAN_SDK, 'include'), env.VULKAN_SDK && join(env.VULKAN_SDK, 'Include'), ...(cross ? [] : ['/opt/homebrew/include', '/usr/local/include', '/usr/include']), fromAzahar];
  for (const d of dirs.filter(Boolean)) {
    if (existsSync(join(d, 'vulkan', 'vulkan.h'))) {
      inc.push('-I', d);
      break;
    }
  }
  const cc = process.env.CC || (os === 'win32' ? (cross ? 'x86_64-w64-mingw32-gcc' : 'gcc') : 'cc');
  const libs = os === 'linux' ? ['-ldl', '-lpthread', '-lm'] : os === 'win32' ? ['-static', '-lm'] : [];
  run(cc, ['-O2', '-Wall', ...inc, '-o', exe, join(src, 'ctrhost.c'), ...libs]);
  if (os !== 'win32') chmodSync(exe, 0o755);
}

// ---- the core -------------------------------------------------------------------------------------------------------
function buildCore() {
  const given = opt('core');
  const target = join(out, `azahar_libretro.${ext}`);
  if (given) {
    copyFileSync(given, target);
  } else {
    const src = azahar;
    // apply the patch once (a checkout that has it already is left as it is)
    const patch = join(root, 'native', 'azahar-patch', 'souldew-memory.patch');
    const check = spawnSync('git', ['apply', '--reverse', '--check', patch], { cwd: src });
    if (check.status !== 0) run('git', ['apply', patch], { cwd: src });
    const build = join(src, 'build-souldew');
    if (cross) throw new Error('building the core for another platform: use --core with a built one (.github/workflows/ctr.yml builds them)');
    const extra = process.platform === 'darwin' ? [`-DCMAKE_OSX_ARCHITECTURES=${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`] : process.platform === 'linux' ? ['-DENABLE_LTO=OFF'] : [];
    run('cmake', ['-G', 'Ninja', '-DENABLE_LIBRETRO=ON', '-DCMAKE_BUILD_TYPE=Release', ...extra, '-S', src, '-B', build]);
    run('cmake', ['--build', build, '--target', 'citra_libretro', '--config', 'Release']);
    const found = [join(build, 'bin', 'Release', `azahar_libretro.${ext}`), join(build, 'bin', `azahar_libretro.${ext}`)].find(existsSync);
    if (!found) throw new Error('built core not found');
    copyFileSync(found, target);
  }
  writeFileSync(join(out, 'SOULDEW_CORE'), `Azahar ${TAG} libretro core with native/azahar-patch/souldew-memory.patch\n`);
}

// ---- MoltenVK (macOS) -----------------------------------------------------------------------------------------------
function moltenVk() {
  if (os !== 'darwin') return;
  const given = opt('moltenvk');
  const target = join(out, 'libMoltenVK.dylib');
  if (given) return copyFileSync(given, target);
  if (existsSync(target)) return;
  // the one Azahar ships with its macOS build (the same version the core is tested with)
  const tmp = join(tmpdir(), `souldew-mvk-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const zip = join(tmp, 'azahar.zip');
    run('curl', ['-fL', '-o', zip, `https://github.com/azahar-emu/azahar/releases/download/${TAG}/azahar-macos-universal-${TAG}.zip`]);
    run('ditto', ['-x', '-k', zip, tmp]);
    const find = (d) => {
      for (const n of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, n.name);
        if (n.isFile() && n.name === 'libMoltenVK.dylib') return p;
        if (n.isDirectory()) {
          const r = find(p);
          if (r) return r;
        }
      }
      return null;
    };
    const mvk = find(tmp);
    if (!mvk) throw new Error('libMoltenVK.dylib not in the Azahar release');
    copyFileSync(mvk, target);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Azahar's source: the core is built from it, and its Vulkan headers serve the host where the system has none
let azahar = null;
if (!has('host-only') && !opt('core')) {
  azahar = opt('src');
  if (!azahar) {
    azahar = join(root, '_ref', `azahar-${TAG}`);
    if (!existsSync(azahar)) run('git', ['clone', '--depth', '1', '--branch', TAG, '--recurse-submodules', '--shallow-submodules', 'https://github.com/azahar-emu/azahar.git', azahar]);
  }
} else if (opt('src')) azahar = opt('src');
buildHost();
writeFileSync(join(out, 'LICENSES.txt'), `souldew's Nintendo 3DS part
ctrhost – native/ctr-host/ctrhost.c, souldew (GPL-3.0); libretro headers MIT
azahar_libretro – Azahar ${TAG} (GPL-2.0-or-later), https://github.com/azahar-emu/azahar, built with
  native/azahar-patch/souldew-memory.patch from the souldew repository (the corresponding source: that tag + the patch)
libMoltenVK – MoltenVK (Apache-2.0), https://github.com/KhronosGroup/MoltenVK, from Azahar's macOS release
`);
if (!has('host-only')) {
  buildCore();
  moltenVk();
}
if (os === 'darwin' && process.platform === 'darwin') {
  // ad-hoc signatures so the hardened runtime of the packaged app may load them
  for (const f of readdirSync(out)) if (/\.(dylib)$|^ctrhost$/.test(f)) spawnSync('codesign', ['--force', '-s', '-', join(out, f)]);
}
console.log(`3DS part in ${out}:`, readdirSync(out).join(', '));

