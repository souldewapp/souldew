// Renders the README graphics into docs/media/ from build/readme/art.html (and the pixel icons from web/lib/icons.mjs):
// banner.webp, social-preview.png (1280×640, upload it under Settings › Social preview), how-it-works.webp,
// streaming.webp, poster-<name>.webp and icons/<name>.svg (and, asked for by name, release-2.5.0-3ds.webp).
// Needs Google Chrome and cwebp (brew install webp); run it after changing art.html, the screenshots or the overlays.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const art = join(root, 'build', 'readme', 'art.html');
const out = join(root, 'docs', 'media');
const tmp = mkdtempSync(join(tmpdir(), 'souldew-art-'));
mkdirSync(join(out, 'icons'), { recursive: true });

function shoot(query, [w, h], scale, file) {
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${join(tmp, 'chrome')}`,
    '--allow-file-access-from-files', `--force-device-scale-factor=${scale}`, '--default-background-color=00000000',
    `--window-size=${w},${h}`, `--screenshot=${file}`, '--virtual-time-budget=5000', `file://${art}?${query}`], { stdio: 'ignore' });
}

function webp(query, size, name, quality = 86) {
  const png = join(tmp, `${name}.png`);
  shoot(query, size, 2, png);
  execFileSync('cwebp', ['-quiet', '-q', String(quality), '-alpha_q', '100', png, '-o', join(out, `${name}.webp`)]);
  console.log('wrote', `docs/media/${name}.webp`);
}

const only = process.argv[2]; // e.g. `node scripts/render-readme-art.mjs poster` renders just the posters
const want = (k) => !only || k.startsWith(only);
if (want('banner')) {
  webp('art=banner', [1280, 640], 'banner');
  shoot('art=banner&square', [1280, 640], 1, join(out, 'social-preview.png'));
  console.log('wrote docs/media/social-preview.png');
}
if (want('how')) webp('art=how', [1280, 610], 'how-it-works');
if (want('stream')) webp('art=stream', [1280, 720], 'streaming');
if (want('poster')) for (const name of ['board', 'teams', 'routes', 'nuzlocke', 'stream']) webp(`art=poster&src=${name}`, [1280, 720], `poster-${name}`);
// Only on request: the image for the 2.5.0 release notes (`node scripts/render-readme-art.mjs release`).
if (only === 'release') webp('art=release', [1280, 720], 'release-2.5.0-3ds');

// Pixel icons for the feature list, on a tinted tile that reads on GitHub's light and dark theme.
const ICONS = { play: '#6f8fe0', signal: '#3f9a7c', ball: '#d45f55', link: '#e06bbd', scroll: '#c8902e', grave: '#8f78d6', sound: '#8a9c3e', globe: '#3a9aa6', stream: '#d45f55', lock: '#3f9a7c', eye: '#6f8fe0', save: '#c8902e' };
const src = readFileSync(join(root, 'web', 'lib', 'icons.mjs'), 'utf8');
for (const [name, color] of Object.entries(ICONS)) {
  const block = src.match(new RegExp(`\\n  ${name}: \\[([^\\]]*)\\]`));
  if (!block) throw new Error(`icon ${name} not found in web/lib/icons.mjs`);
  const rows = [...block[1].matchAll(/'([.#]{16})'/g)].map((m) => m[1]);
  let d = '';
  rows.forEach((row, y) => { for (const m of row.matchAll(/#+/g)) d += `M${m.index} ${y}h${m[0].length}v1h-${m[0].length}z`; });
  writeFileSync(join(out, 'icons', `${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="48" height="48">` +
    `<rect x=".5" y=".5" width="23" height="23" rx="6" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-opacity=".55"/>` +
    `<path transform="translate(4 4)" fill="${color}" shape-rendering="crispEdges" d="${d}"/></svg>\n`);
}
console.log('wrote', Object.keys(ICONS).length, 'icons to docs/media/icons/');
rmSync(tmp, { recursive: true, force: true });
