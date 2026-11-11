// Pixel-art medals for the trophy page – souldew's own designs, drawn on a small grid like the icon set.
// Every medal is computed, not painted: a body shape (circle, hexagon, star …) gets an outline, a bevel lit from
// the top left, a sheen and an engraved emblem, in the metal of its tier, on a ribbon in its category colour.
import { html } from '/vendor/htm-preact.mjs';

const W = 24;
const H = 31;
const CX = 11.5;
const CY = 19.5;

/** outline, shadow, base, light, highlight */
export const METALS = {
  bronze: ['#2e170b', '#7d4523', '#b06d3c', '#d39561', '#f1c595'],
  silver: ['#22252d', '#737a88', '#a5acba', '#cbd1dc', '#f5f8fc'],
  gold: ['#33230a', '#a06c12', '#d6a020', '#efc647', '#fff1ad'],
  platinum: ['#16292c', '#5f9598', '#94c9c7', '#c3ebe8', '#f2fffe'],
  master: ['#22132f', '#6a4bc6', '#9a78f5', '#ef8fd8', '#fff0fb'],
  locked: ['#0b0a0e', '#1d1c22', '#25242b', '#2c2b33', '#36353e'],
};

/** Ribbon colours per medal (category accents of the app). */
const RIBBONS = {
  journey: ['#e0a458', '#9c6a2c'], collection: ['#6fb39b', '#3d7563'], skill: ['#dc7268', '#94403a'], soullink: ['#d77fc6', '#8f4a84'],
  randomizer: ['#7f9ddb', '#4b6299'], fun: ['#e1b05a', '#9b7329'], dex: ['#b9cb98', '#6f8a62'], champion: ['#ff8fdc', '#6f9bff'],
};

// body shapes: inside(x, y) for a cell centre, relative to the medal centre
const SHAPES = {
  circle: (x, y) => x * x + y * y <= 10.4 * 10.4,
  hexagon: (x, y) => Math.abs(y) <= 10 && Math.abs(x) * 0.866 + Math.abs(y) * 0.5 <= 9.6,
  star: (x, y) => {
    const r = Math.hypot(x, y);
    const a = Math.atan2(y, x) + Math.PI / 2;
    const k = (Math.cos(5 * a) + 1) / 2; // 1 at the five points
    return r <= 6.6 + 4.6 * k ** 1.4;
  },
  diamond: (x, y) => Math.abs(x) + Math.abs(y) <= 11.2,
  shield: (x, y) => y >= -10 && y <= 11 && Math.abs(x) <= (y <= 0 ? 9.6 - (y < -8.5 ? 1.2 : 0) : 9.6 * Math.sqrt(1 - (y / 11.4) ** 2)),
  octagon: (x, y) => Math.abs(x) <= 10 && Math.abs(y) <= 10 && Math.abs(x) + Math.abs(y) <= 14,
  burst: (x, y) => {
    const r = Math.hypot(x, y);
    const a = Math.atan2(y, x);
    return r <= 9.4 + 1.6 * Math.cos(8 * a);
  },
};

// engraved emblems (9×9, '#' = groove)
const EMBLEMS = {
  journey: ['....##...', '....####.', '....#####', '....####.', '....##...', '....#....', '....#....', '...###...', '..#####..'], // a flag
  collection: ['..#####..', '.#.....#.', '#.......#', '#.......#', '###.#.###', '#..#.#..#', '#.......#', '.#.....#.', '..#####..'], // a ball
  skill: ['.....##..', '....##...', '...##....', '..######.', '....##...', '...##....', '..##.....', '.##......', '.#.......'], // a bolt
  soullink: ['.........', '.##...##.', '#..#.#..#', '#..###..#', '#..#.#..#', '.##...##.', '.........', '.........', '.........'], // linked rings
  randomizer: ['#########', '#.......#', '#.#...#.#', '#.......#', '#...#...#', '#.......#', '#.#...#.#', '#.......#', '#########'], // a die
  fun: ['..#####..', '.#.....#.', '#..#.#..#', '#.......#', '#.#...#.#', '#..###..#', '#.......#', '.#.....#.', '..#####..'], // a grin
  champion: ['.........', '#...#...#', '##.###.##', '#########', '#########', '#.#.#.#.#', '#########', '.........', '.........'], // a crown
};
// Roman numerals for the regional dex medals (Kanto I … Alola VII)
const NUMERALS = {
  1: ['..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  2: ['.#.#.', '.#.#.', '.#.#.', '.#.#.', '.#.#.', '.#.#.', '.#.#.'],
  3: ['#.#.#', '#.#.#', '#.#.#', '#.#.#', '#.#.#', '#.#.#', '#.#.#'],
  4: ['#.#...#', '#.#...#', '#..#.#.', '#..#.#.', '#..#.#.', '#...#..', '#...#..'],
  5: ['#...#', '#...#', '#...#', '.#.#.', '.#.#.', '..#..', '..#..'],
  6: ['#...#.#', '#...#.#', '#...#.#', '.#.#..#', '.#.#..#', '..#...#', '..#...#'],
  7: ['#...#.#.#', '#...#.#.#', '#...#.#.#', '.#.#..#.#', '.#.#..#.#', '..#...#.#', '..#...#.#'],
};

const SHAPE_OF = { journey: 'circle', collection: 'hexagon', skill: 'star', soullink: 'shield', randomizer: 'diamond', fun: 'circle', dex: 'octagon', champion: 'burst' };

const cache = new Map();

/** The pixels of one medal: [[color, path], …] – computed once per look. */
export function medalPixels(kind, tier, gen) {
  const key = `${kind}:${tier}:${gen || ''}`;
  if (cache.has(key)) return cache.get(key);
  const pal = METALS[tier] || METALS.locked;
  const locked = tier === 'locked';
  const shape = SHAPES[SHAPE_OF[kind] || 'circle'];
  const grid = Array.from({ length: H }, () => Array(W).fill(null));
  const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H && shape(x - CX, y - CY);
  // ribbon: two tails behind the medal, V-cut at the top
  const rib = locked ? ['#25242a', '#1c1b20'] : RIBBONS[kind] || RIBBONS.journey;
  // the tails lean outwards towards the top; a V notch is cut into each end
  for (let y = 0; y < 13; y++) {
    const lean = Math.round((12 - y) / 4);
    const tails = [[4 - lean, 10 - lean], [13 + lean, 19 + lean]];
    for (const [a, b] of tails) {
      const mid = (a + b) / 2;
      for (let x = a; x <= b; x++) {
        if (y < 2 && Math.abs(x - mid) < 2 - y) continue;
        const edge = x === a || x === b;
        grid[y][x] = edge ? rib[1] : x === Math.round(mid) ? rib[1] : rib[0];
      }
    }
  }
  // body with outline, bevel and sheen
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inside(x, y)) continue;
      const n = [inside(x - 1, y), inside(x + 1, y), inside(x, y - 1), inside(x, y + 1)];
      const dx = x - CX;
      const dy = y - CY;
      let c;
      if (n.includes(false)) c = pal[0];
      else {
        const inner = [inside(x - 2, y), inside(x + 2, y), inside(x, y - 2), inside(x, y + 2)];
        const rim = inner.includes(false);
        const lit = dx + dy < 0;
        if (rim) c = lit ? pal[4] : pal[1];
        else {
          const d = dx + dy;
          c = d < -9 ? pal[3] : d < 6 ? pal[2] : pal[1];
          // a diagonal sheen across the upper left
          if (!locked && Math.abs(dx - dy + 3) <= 0.6 && d < -5) c = pal[4];
        }
      }
      grid[y][x] = c;
    }
  }
  // the emblem: grooves in the shadow colour with a light edge below-right (engraved look)
  const em = kind === 'dex' ? NUMERALS[gen] || NUMERALS[1] : EMBLEMS[kind] || EMBLEMS.journey;
  const ew = em[0].length;
  const eh = em.length;
  const ox = Math.round(CX - ew / 2 + 0.5);
  const oy = Math.round(CY - eh / 2 + 0.5);
  const groove = locked ? pal[1] : pal[0];
  const lip = locked ? pal[3] : pal[4];
  em.forEach((row, j) => [...row].forEach((ch, i) => {
    if (ch !== '#') return;
    const x = ox + i;
    const y = oy + j;
    if (grid[y + 1]?.[x + 1] && em[j + 1]?.[i + 1] !== '#') grid[y + 1][x + 1] = lip;
  }));
  em.forEach((row, j) => [...row].forEach((ch, i) => {
    if (ch === '#' && grid[oy + j]?.[ox + i]) grid[oy + j][ox + i] = groove;
  }));
  // merge runs of one colour into one path per colour
  const paths = new Map();
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      const c = grid[y][x];
      if (!c) {
        x++;
        continue;
      }
      let w = 1;
      while (grid[y][x + w] === c) w++;
      paths.set(c, (paths.get(c) || '') + `M${x} ${y}h${w}v1h-${w}z`);
      x += w;
    }
  }
  const out = [...paths.entries()];
  cache.set(key, out);
  return out;
}

/**
 * A medal. kind: a category id, 'dex' (with gen) or 'champion'; tier: bronze … master, or null/locked for an
 * empty slot. `shine`: the slow glint for earned medals (off with reduced motion – CSS).
 */
export function Medal({ kind, tier, gen, size = 72, title, shine = true }) {
  const t = tier && METALS[tier] ? tier : 'locked';
  return html`<svg class=${`medal medal-${t} ${shine && t !== 'locked' ? 'medal-shine' : ''}`} viewBox=${`0 0 ${W} ${H}`} width=${size} height=${Math.round((size * H) / W)}
    shape-rendering="crispEdges" role=${title ? 'img' : undefined} aria-hidden=${title ? undefined : 'true'}>
    ${title && html`<title>${title}</title>`}
    ${medalPixels(kind, t, gen).map(([c, d]) => html`<path d=${d} fill=${c} />`)}
  </svg>`;
}
