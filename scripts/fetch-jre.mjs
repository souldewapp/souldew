// Builds the minimal Java runtime that ships inside the app (tools/jre/<platform>-<arch>).
// Downloads a Temurin JDK 17, then jlinks only the modules the randomizer needs
// (java.base, java.desktop, java.logging) → ~46 MB instead of ~150 MB.
// Both players use this exact runtime, so seeded randomization stays byte-identical.
// Usage: node scripts/fetch-jre.mjs [arm64|x64]   (run on the platform you build for: macOS → darwin-*, Windows → win32-*, Linux → linux-*)
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arch = process.argv[2] || process.arch;
const os = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
const apiArch = arch === 'arm64' ? 'aarch64' : 'x64';
const target = join(root, 'tools', 'jre', `${process.platform}-${arch}`);
const javaBin = join(target, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
if (existsSync(javaBin)) {
  console.log('Runtime already present:', target);
  process.exit(0);
}
const url = `https://api.adoptium.net/v3/binary/latest/17/ga/${os}/${apiArch}/jdk/hotspot/normal/eclipse`;
console.log('Downloading JDK', url);
const res = await fetch(url);
if (!res.ok) throw new Error(`download failed ${res.status}`);
const tmp = join(root, 'tools', 'jre', 'download');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const archive = join(tmp, os === 'windows' ? 'jdk.zip' : 'jdk.tar.gz');
writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
// Windows: the system's bsdtar reads zip (Git's GNU tar, often first in PATH on CI, doesn't) – PowerShell as fallback.
const winTar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const psQuote = (p) => `'${p.replace(/'/g, "''")}'`;
const x = os !== 'windows'
  ? spawnSync('tar', ['xzf', archive, '-C', tmp], { stdio: 'inherit' })
  : existsSync(winTar)
    ? spawnSync(winTar, ['-xf', archive, '-C', tmp], { stdio: 'inherit' })
    : spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath ${psQuote(archive)} -DestinationPath ${psQuote(tmp)}`], { stdio: 'inherit' });
if (x.status !== 0) throw new Error('extract failed');
const dir = readdirSync(tmp).find((d) => d.startsWith('jdk'));
const home = os === 'mac' ? join(tmp, dir, 'Contents', 'Home') : join(tmp, dir);
rmSync(target, { recursive: true, force: true });
const r = spawnSync(join(home, 'bin', os === 'windows' ? 'jlink.exe' : 'jlink'), ['--add-modules', 'java.base,java.desktop,java.logging', '--strip-debug', '--no-man-pages',
  '--no-header-files', '--compress=2', '--output', target], { stdio: 'inherit' });
if (r.status !== 0) throw new Error('jlink failed');
rmSync(tmp, { recursive: true, force: true });
console.log('Runtime ready:', target);
