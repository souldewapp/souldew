// Legendary and mythical Pokémon by national dex number, Gen 1–9 – the same split PokeAPI makes (is_legendary /
// is_mythical). Ultra Beasts and Paradox Pokémon are neither. Used by the stream overlays (the coffee pop-up on a
// legendary encounter, shared/coffee.mjs) and the open stream API (shared/streamapi.mjs).

export const LEGENDARY = Object.freeze([
  144, 145, 146, 150, // Articuno, Zapdos, Moltres, Mewtwo
  243, 244, 245, 249, 250, // Raikou, Entei, Suicune, Lugia, Ho-Oh
  377, 378, 379, 380, 381, 382, 383, 384, // Regirock, Regice, Registeel, Latias, Latios, Kyogre, Groudon, Rayquaza
  480, 481, 482, 483, 484, 485, 486, 487, 488, // Uxie, Mesprit, Azelf, Dialga, Palkia, Heatran, Regigigas, Giratina, Cresselia
  638, 639, 640, 641, 642, 643, 644, 645, 646, // Cobalion, Terrakion, Virizion, Tornadus, Thundurus, Reshiram, Zekrom, Landorus, Kyurem
  716, 717, 718, // Xerneas, Yveltal, Zygarde
  772, 773, 785, 786, 787, 788, 789, 790, 791, 792, 800, // Type: Null, Silvally, Tapus, Cosmog line, Necrozma
  888, 889, 890, 891, 892, 894, 895, 896, 897, 898, 905, // Zacian … Calyrex, Enamorus
  1001, 1002, 1003, 1004, 1007, 1008, 1014, 1015, 1016, 1017, 1024, // Ruinous quartet, Koraidon, Miraidon, Loyal Three, Ogerpon, Terapagos
]);

export const MYTHICAL = Object.freeze([
  151, // Mew
  251, // Celebi
  385, 386, // Jirachi, Deoxys
  489, 490, 491, 492, 493, // Phione, Manaphy, Darkrai, Shaymin, Arceus
  494, 647, 648, 649, // Victini, Keldeo, Meloetta, Genesect
  719, 720, 721, // Diancie, Hoopa, Volcanion
  801, 802, 807, 808, 809, // Magearna, Marshadow, Zeraora, Meltan, Melmetal
  893, // Zarude
  1025, // Pecharunt
]);

const KIND = new Map([...LEGENDARY.map((id) => [id, 'legendary']), ...MYTHICAL.map((id) => [id, 'mythical'])]);

/** 'legendary' | 'mythical' | null for a national dex number. */
export const legendaryKind = (id) => KIND.get(Number(id)) || null;

/** Legendary or mythical. */
export const isLegendary = (id) => KIND.has(Number(id));

/** The legendaries and mythicals a game of generation `gen` (1–5) can have – for previews and samples. */
export const LEGENDARY_MAX = [0, 151, 251, 386, 493, 649, 721, 809, 905, 1025];
export const legendariesUpTo = (gen) => [...KIND.keys()].filter((id) => id <= (LEGENDARY_MAX[gen] || 1025)).sort((a, b) => a - b);
