// Starts the app from source with its logs in the terminal: main process, server and – via Chromium's
// --enable-logging – the renderer's console. Help › Toggle DevTools is there as well when running unpackaged.
// Everything is also written to logs/souldew-YYYY-MM-DD_hhmmss.log (local time; ignored by git).
//
// Usage: npm run app:log [-- extra electron/chromium flags]
//
// ELECTRON_RUN_AS_NODE is dropped from the environment: some hosts (VS Code extensions, for one) set it, and then
// electron.exe runs as plain Node and fails on `import { app } from 'electron'`.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const electron = createRequire(import.meta.url)('electron'); // from Node, the package exports the binary's path
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const now = new Date();
const two = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}_${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
const logDir = join(root, 'logs');
mkdirSync(logDir, { recursive: true });
const logPath = join(logDir, `souldew-${stamp}.log`);
const log = createWriteStream(logPath, { flags: 'a' });
console.log(`Log: ${logPath}`);

const child = spawn(electron, ['.', '--enable-logging', ...process.argv.slice(2)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
// both streams to the terminal as they are, and into the one file in the order they arrive
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  log.write(chunk);
});
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  log.write(chunk);
});

const finish = (code) => log.end(() => process.exit(code));
child.on('error', (e) => {
  console.error('electron could not be started:', e.message);
  log.write(`electron could not be started: ${e.message}\n`);
  finish(1);
});
child.on('close', (code, signal) => finish(signal ? 1 : (code ?? 0)));
