// Encounter areas for Definitive HeartGold in progression order, with HGSS met-location IDs
// (research/hgss_locations_en.json) and boss milestones. Ace levels were read from the
// hack's trainer files (research/defhg_research.md) — Definitive HG has no built-in level caps,
// so these are the natural caps a Nuzlocke uses.

const A = (key, name, met = [], extra = {}) => ({ kind: 'area', key, name, met, ...extra });
const B = (key, name, cap, extra = {}) => ({ kind: 'boss', key, name, cap, ...extra });

/** Ace levels of vanilla HeartGold/SoulSilver (the PROGRESSION caps are Definitive HG's). */
export const VANILLA_CAPS = {
  'rival-1': 5, falkner: 9, bugsy: 17, 'rival-2': 20, whitney: 19, morty: 25, chuck: 31, jasmine: 35, pryce: 34, 'rival-3': 32,
  clair: 41, 'rival-4': 38, will: 42, koga: 44, bruno: 46, karen: 47, lance: 50, 'kanto-leaders': 60, blue: 60, red: 88,
};

export const PROGRESSION = [
  A('starter', 'Starter', [], { region: 'Johto', special: 'starter', hint: 'Dein erstes Pokémon von Prof. Lind' }),
  A('new-bark', 'New Bark Town', [126], { region: 'Johto', hint: 'Surfer/Angeln – erst später erreichbar' }),
  A('route-29', 'Route 29', [177], { region: 'Johto' }),
  A('cherrygrove', 'Cherrygrove City', [127], { region: 'Johto' }),
  A('route-30', 'Route 30', [178], { region: 'Johto' }),
  A('route-31', 'Route 31', [179], { region: 'Johto' }),
  A('violet', 'Violet City', [128], { region: 'Johto' }),
  A('sprout-tower', 'Sprout Tower', [204], { region: 'Johto' }),
  B('rival-1', 'Rivale (Cherrygrove)', 18, { optional: true }),
  B('falkner', 'Falk', 15, { badge: 0 }),
  A('route-32', 'Route 32', [180], { region: 'Johto' }),
  A('ruins-of-alph', 'Ruins of Alph', [209], { region: 'Johto' }),
  A('union-cave', 'Union Cave', [210], { region: 'Johto' }),
  A('route-33', 'Route 33', [181], { region: 'Johto' }),
  A('azalea', 'Azalea Town', [129], { region: 'Johto' }),
  A('slowpoke-well', 'Slowpoke Well', [211], { region: 'Johto' }),
  B('bugsy', 'Kai', 20, { badge: 1 }),
  A('ilex-forest', 'Ilex Forest', [214], { region: 'Johto' }),
  B('rival-2', 'Rivale (Azalea)', 26, { optional: true }),
  A('route-34', 'Route 34', [182], { region: 'Johto' }),
  A('goldenrod', 'Goldenrod City', [131, 215], { region: 'Johto' }),
  B('whitney', 'Bianka', 24, { badge: 2 }),
  A('route-35', 'Route 35', [183], { region: 'Johto' }),
  A('national-park', 'National Park', [207], { region: 'Johto' }),
  A('route-36', 'Route 36', [184], { region: 'Johto' }),
  A('route-37', 'Route 37', [185], { region: 'Johto' }),
  A('ecruteak', 'Ecruteak City', [133], { region: 'Johto' }),
  A('burned-tower', 'Burned Tower', [206], { region: 'Johto' }),
  B('morty', 'Jens', 30, { badge: 3 }),
  A('route-38', 'Route 38', [186], { region: 'Johto' }),
  A('route-39', 'Route 39', [187], { region: 'Johto' }),
  A('olivine', 'Olivine City', [132, 212], { region: 'Johto' }),
  A('route-40', 'Route 40', [188], { region: 'Johto' }),
  A('route-41', 'Route 41', [189], { region: 'Johto' }),
  A('whirl-islands', 'Whirl Islands', [218], { region: 'Johto' }),
  A('cianwood', 'Cianwood City', [130], { region: 'Johto' }),
  B('chuck', 'Hartwig', 35, { badge: 4 }),
  A('route-47', 'Route 47', [195], { region: 'Johto' }),
  A('route-48', 'Route 48', [196], { region: 'Johto' }),
  A('cliff-cave', 'Cliff Cave', [228, 234], { region: 'Johto' }),
  A('safari-zone', 'Safari Zone', [202, 227], { region: 'Johto' }),
  B('jasmine', 'Jasmin', 35, { badge: 5 }),
  A('route-42', 'Route 42', [190], { region: 'Johto' }),
  A('mt-mortar', 'Mt. Mortar', [216], { region: 'Johto' }),
  A('mahogany', 'Mahogany Town', [134], { region: 'Johto' }),
  A('route-43', 'Route 43', [191], { region: 'Johto' }),
  A('lake-of-rage', 'Lake of Rage', [135], { region: 'Johto' }),
  A('rocket-hq', 'Team Rocket HQ', [213], { region: 'Johto' }),
  B('pryce', 'Norbert', 42, { badge: 6 }),
  B('rival-3', 'Rivale (Radioturm)', 40, { optional: true }),
  A('route-44', 'Route 44', [192], { region: 'Johto' }),
  A('ice-path', 'Ice Path', [217], { region: 'Johto' }),
  A('blackthorn', 'Blackthorn City', [136], { region: 'Johto' }),
  B('clair', 'Sandra', 46, { badge: 7 }),
  A('dragons-den', "Dragon's Den", [222], { region: 'Johto' }),
  A('route-45', 'Route 45', [193], { region: 'Johto' }),
  A('route-46', 'Route 46', [194], { region: 'Johto' }),
  A('dark-cave', 'Dark Cave', [220], { region: 'Johto' }),
  A('route-27', 'Route 27', [175], { region: 'Johto' }),
  A('tohjo-falls', 'Tohjo Falls', [223], { region: 'Johto' }),
  A('route-26', 'Route 26', [174], { region: 'Johto' }),
  B('rival-4', 'Rivale (Siegesstraße)', 50, { optional: true }),
  A('victory-road', 'Victory Road', [221], { region: 'Johto' }),
  B('will', 'Willi (Top 4)', 52),
  B('koga', 'Koga (Top 4)', 54),
  B('bruno', 'Bruno (Top 4)', 56),
  B('karen', 'Melanie (Top 4)', 58),
  B('lance', 'Siegfried (Champ)', 60),
  A('bell-tower', 'Bell Tower', [205, 230], { region: 'Johto', hint: 'Ho-Oh / Glockenturm' }),
  A('embedded-tower', 'Embedded Tower', [232], { region: 'Johto' }),
  A('ss-aqua', 'S.S. Aqua', [226], { region: 'Kanto' }),
  A('vermilion', 'Vermilion City', [143], { region: 'Kanto' }),
  A('route-6', 'Route 6', [154], { region: 'Kanto' }),
  A('saffron', 'Saffron City', [148], { region: 'Kanto' }),
  A('route-5', 'Route 5', [153], { region: 'Kanto' }),
  A('cerulean', 'Cerulean City', [141], { region: 'Kanto' }),
  A('route-24', 'Route 24', [172], { region: 'Kanto' }),
  A('route-25', 'Route 25', [173], { region: 'Kanto' }),
  A('route-9', 'Route 9', [157], { region: 'Kanto' }),
  A('rock-tunnel', 'Rock Tunnel', [200], { region: 'Kanto' }),
  A('route-10', 'Route 10', [158], { region: 'Kanto' }),
  A('power-plant', 'Power Plant', [201], { region: 'Kanto' }),
  A('lavender', 'Lavender Town', [142], { region: 'Kanto' }),
  A('route-8', 'Route 8', [156], { region: 'Kanto' }),
  A('route-7', 'Route 7', [155], { region: 'Kanto' }),
  A('celadon', 'Celadon City', [144], { region: 'Kanto' }),
  A('route-16', 'Route 16', [164], { region: 'Kanto' }),
  A('route-17', 'Route 17', [165], { region: 'Kanto' }),
  A('route-18', 'Route 18', [166], { region: 'Kanto' }),
  A('route-11', 'Route 11', [159], { region: 'Kanto' }),
  A('digletts-cave', "Diglett's Cave", [197], { region: 'Kanto' }),
  A('route-12', 'Route 12', [160], { region: 'Kanto' }),
  A('route-13', 'Route 13', [161], { region: 'Kanto' }),
  A('route-14', 'Route 14', [162], { region: 'Kanto' }),
  A('route-15', 'Route 15', [163], { region: 'Kanto' }),
  A('fuchsia', 'Fuchsia City', [145], { region: 'Kanto' }),
  A('route-2', 'Route 2', [150], { region: 'Kanto' }),
  A('viridian-forest', 'Viridian Forest', [224], { region: 'Kanto' }),
  A('pewter', 'Pewter City', [140], { region: 'Kanto' }),
  A('route-3', 'Route 3', [151], { region: 'Kanto' }),
  A('mt-moon', 'Mt. Moon', [198], { region: 'Kanto' }),
  A('route-4', 'Route 4', [152], { region: 'Kanto' }),
  A('viridian', 'Viridian City', [139], { region: 'Kanto' }),
  A('route-22', 'Route 22', [170], { region: 'Kanto' }),
  A('route-1', 'Route 1', [149], { region: 'Kanto' }),
  A('pallet', 'Pallet Town', [138], { region: 'Kanto' }),
  A('route-21', 'Route 21', [169], { region: 'Kanto' }),
  A('cinnabar', 'Cinnabar Island', [146], { region: 'Kanto' }),
  A('route-20', 'Route 20', [168], { region: 'Kanto' }),
  A('seafoam', 'Seafoam Islands', [203], { region: 'Kanto' }),
  A('route-19', 'Route 19', [167], { region: 'Kanto' }),
  B('kanto-leaders', 'Kanto-Arenaleiter (Blaine 64)', 62, { badgesFrom: 8 }),
  B('blue', 'Blau', 70),
  A('route-28', 'Route 28', [176], { region: 'Kanto' }),
  A('mt-silver', 'Mt. Silver', [137, 219], { region: 'Kanto' }),
  A('cerulean-cave', 'Cerulean Cave', [199], { region: 'Kanto' }),
  B('red', 'Rot', 88),
];

export const AREAS = PROGRESSION.filter((x) => x.kind === 'area');
export const BOSSES = PROGRESSION.filter((x) => x.kind === 'boss');

const MET_TO_AREA = new Map();
for (const a of AREAS) for (const id of a.met) if (!MET_TO_AREA.has(id)) MET_TO_AREA.set(id, a.key);

/** Map a met-location ID from the save file to an area key (null = unknown / special). */
export function areaForMetLocation(id) {
  return MET_TO_AREA.get(id) || null;
}

/**
 * Level cap = ace level of the next unbeaten mandatory boss. Badge-based: 0..7 Johto
 * gyms, then E4 (until 8 badges + champion), Kanto leaders, Blue, Red.
 */
export function levelCapFor(badgeCount, defeated = {}, vanilla = false) {
  const mandatory = BOSSES.filter((b) => !b.optional).map((b) => (vanilla && VANILLA_CAPS[b.key] ? { ...b, cap: VANILLA_CAPS[b.key] } : b));
  const kanto = mandatory.findIndex((b) => b.badgesFrom !== undefined);
  for (const [i, b] of mandatory.entries()) {
    if (b.badge !== undefined) {
      if (badgeCount <= b.badge) return { boss: b, cap: b.cap };
      continue;
    }
    if (b.badgesFrom !== undefined) {
      // Blue's gym only opens with the other seven Kanto badges: at 15 badges the next boss is Blue.
      if (badgeCount < 15) return { boss: b, cap: b.cap };
      continue;
    }
    // Kanto badges only come after the Elite Four: a 9th badge means everything before Kanto is beaten,
    // and the 16th badge is Blue's.
    if (kanto >= 0 && i < kanto && badgeCount > 8) continue;
    if (b.key === 'blue' && badgeCount >= 16) continue;
    if (!defeated[b.key]) return { boss: b, cap: b.cap };
  }
  return { boss: null, cap: 100 };
}

/**
 * Vanilla level caps for games without a curated route list: ace level of the n-th gym leader, then the
 * champion (Gen 2: Kanto leaders, Blue, Red). Index = badges owned. Trainer levels of randomizer setups with
 * "level boost" are higher – these are the unmodified games.
 */
const GYM_CAPS = {
  rb: { caps: [14, 21, 24, 29, 43, 43, 47, 50], after: [{ name: 'Champion', cap: 65 }] },
  yellow: { caps: [12, 21, 28, 32, 50, 50, 54, 55], after: [{ name: 'Champion', cap: 65 }] },
  // Kanto badges only come after the Elite Four, so a 9th badge means Lance is beaten.
  gs: { caps: [9, 16, 20, 25, 30, 35, 35, 40], after: [{ name: 'Lance', cap: 50, below: 9 }, { name: 'Blue', cap: 58, below: 16 }, { name: 'Red', cap: 81 }] },
  crystal: { caps: [9, 16, 20, 25, 30, 35, 35, 41], after: [{ name: 'Lance', cap: 50, below: 9 }, { name: 'Blue', cap: 58, below: 16 }, { name: 'Red', cap: 81 }] },
};

export function gymCapsFamily(gameId = '') {
  const id = String(gameId).replace(/-(de|jp|fr|es|it)$/, '');
  return { 'pokemon-red': 'rb', 'pokemon-blue': 'rb', 'pokemon-green': 'rb', 'pokemon-yellow': 'yellow', 'pokemon-gold': 'gs', 'pokemon-silver': 'gs', 'pokemon-crystal': 'crystal' }[id] || null;
}

/** { cap, boss: { name, badge? } } for a vanilla game by badge count, or null when unknown. */
export function vanillaCapFor(family, badgeCount) {
  const f = GYM_CAPS[family];
  if (!f || badgeCount === undefined || badgeCount === null) return null;
  if (badgeCount < f.caps.length) return { cap: f.caps[badgeCount], boss: { key: `gym${badgeCount + 1}`, badge: badgeCount } };
  for (const a of f.after) if (!a.below || badgeCount < a.below) return { cap: a.cap, boss: { key: a.name.toLowerCase(), name: a.name } };
  const last = f.after.at(-1);
  return { cap: last.cap, boss: { key: last.name.toLowerCase(), name: last.name } };
}
