// Renders build/dmg-background.html into build/background.png (660×420) and build/background@2x.png for the
// DMG window (package.json build.dmg). Needs Google Chrome; run it after changing the HTML.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const build = fileURLToPath(new URL('../build/', import.meta.url));
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const page = `file://${join(build, 'dmg-background.html')}`;
for (const [scale, name] of [[1, 'background.png'], [2, 'background@2x.png']]) {
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--force-device-scale-factor=${scale}`,
    '--window-size=660,420', `--screenshot=${join(build, name)}`, '--virtual-time-budget=2000', page], { stdio: 'ignore' });
  console.log('wrote', name);
}
