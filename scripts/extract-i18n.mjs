// Collects every t('key', 'Default') call from web/ and writes web/i18n/en.json.
// Translators then produce de/fr/es/it with the same keys. Reports keys missing per language.
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'web');
const out = {};
const re = /\b(?:t|msg)\(\s*'([a-zA-Z0-9_.-]+)'\s*,\s*('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")/g;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'vendor' || name === 'assets' || name === 'i18n') continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(mjs|js)$/.test(name)) {
      // Drop comment lines (`// …`, `/* …`, ` * …`) so usage examples in docs aren't extracted as keys.
      const src = readFileSync(p, 'utf8').replace(/^\s*(?:\/\/|\/\*|\*).*$/gm, '');
      for (const m of src.matchAll(re)) {
        // eslint-disable-next-line no-eval
        const value = (0, eval)(m[2]);
        if (out[m[1]] && out[m[1]] !== value) console.warn(`key ${m[1]} has two defaults:\n  ${out[m[1]]}\n  ${value}`);
        out[m[1]] = value;
      }
    }
  }
}
walk(web);
// Randomizer labels live in shared/ and are looked up with dynamic keys (rnd.*).
const { randomizerStrings } = await import('../shared/randomizer-options.mjs');
Object.assign(out, randomizerStrings());
const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
writeFileSync(join(web, 'i18n', 'en.json'), JSON.stringify(sorted, null, 2) + '\n');
console.log(`${Object.keys(sorted).length} keys → web/i18n/en.json`);
for (const lang of ['de', 'fr', 'es', 'it']) {
  const f = join(web, 'i18n', `${lang}.json`);
  if (!existsSync(f)) {
    console.log(`${lang}: missing file`);
    continue;
  }
  const d = JSON.parse(readFileSync(f, 'utf8'));
  const missing = Object.keys(sorted).filter((k) => !(k in d));
  const stale = Object.keys(d).filter((k) => !(k in sorted));
  const list = (a) => (a.length ? ` (${a.slice(0, 8).join(', ')}${a.length > 8 ? ', …' : ''})` : '');
  console.log(`${lang}: ${missing.length} missing${list(missing)}, ${stale.length} stale${list(stale)}`);
}
