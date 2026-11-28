# Tested games

What souldew's live tracking was checked against, game by game: the team (species, nickname, level, HP, status), the
place sign ("You are here"), the battle panel and new catches – for retail games, randomized games and ROM hacks.
Back to the [README](../README.md).

**How it was checked (November 2026, round 2 for 2.3.0).** Every ROM was booted in souldew's own emulator page (the same `player.html`,
cores and live readers the app uses – hidden and muted) and played from power-on to the first Pokémon and a first
battle by input plans; at each checkpoint the values souldew read were compared with what the game showed on screen
(screenshots). Hacks were patched with souldew's own patcher, randomized games built with its bundled randomizer
(Classic preset, seed 20261110). On top of that, the data read from the ROM files themselves (place names, species
tables, moved RAM) was compared with the app's tables for every ROM. Re-run everything on any computer (Windows
included) with

```sh
node scripts/rom-matrix.mjs <folder with ROMs and patches> --live --randomize
```

(see the header of [scripts/rom-matrix.mjs](../scripts/rom-matrix.mjs); `SOULDEW_TEST_ROMS=<folder> npm test` runs the
ROM checks of the test suite).

✅ checked in the running game · ⚠️ works with a limitation (see notes) · ❌ doesn't work · – not checked / not applicable

## The matrix

US/EU ROMs unless noted. "Party" = species, nickname, level, HP/max HP and status of the team; "Location" = the place
sign; "Battle" = the opponent (species, level, kind) on the battle panel; "Catch" = a new Pokémon is filed under the
right area; "Randomizer" = the same game built with souldew's randomizer and played again.

| Game | Party | Location | Battle | Catch | Randomizer | Notes |
|---|:---:|:---:|:---:|:---:|:---:|---|
| **Red** | ✅ | ✅ | ✅ | ✅ | ⚠️ | Charmander L5 "AAAAAAAAAA", rival's Squirtle L5 (trainer), level-up to 6 read after the fight. Places are the town-map names (Oak's lab = Pallet Town). **Real catch:** a wild Rattata L3 on Route 1 → filed under "Route 1". **Fixed (2.3.0):** Gen 1 stores no catch location – catches went to the inbox; a catch right after a wild battle now goes under the place the sign shows. Randomized: built ✓, place ✓, the plan didn't reach the starter (the randomizer's fast text moves Mom into the path). **Fixed (3.0.1, #83):** with six in the team the catch goes to the PC box, which souldew didn't read – now the box chosen in the PC (WRAM 0xDA80) is read too: a wild Rattata L3 caught with a full team (five stand-ins poked into it) → in the box and filed under "Route 1". |
| **Silver** | ✅ | ✅ | ✅ | ✅ | – | Totodile L5, nickname read before and after naming; New Bark Town (bedroom, Elm's lab), Route 29; wild Rattata L4. **Real catch:** Pidgey L3 → "Route 29" through the place sign (Gold/Silver store no catch location), 6 of 6 runs. |
| **Crystal** | ✅ | ✅ | ✅ | ✅ | ✅ | As Silver; met location and level are read. **Real catch:** Sentret L2 (also Pidgey, Rattata), met location Route 29 → "Route 29". Randomized: Poliwag as the starter, wild Rattata L2 – all read. |
| **Ruby / Sapphire** | ✅ | ✅ | ✅ | ✅ | – | Torchic L5 (nickname, HP checked on the party screen), Littleroot Town, Route 101, wild Poochyena L2. The starter's met location is Route 101 – the same id the sign reads there. |
| **Emerald** | ✅ | ✅ | ✅ | ✅ | ✅ | As Ruby, wild Zigzagoon L2. **Real catch:** Poochyena L2 (also Wurmple) on Route 101 → "Route 101". Randomized: Weedle as the starter, all read. |
| **Versione Rubino** (Italian Ruby, rev 1) | ✅ | ✅ | ✅ | – | – | Recognised as a retail game (catalog `pokemon-ruby-it`, game code AXVI, retail CRC 9305E793) with the memory entry `ruby_eu` – the German game's layout (the team 0x10 further on than in English), read from the ROM's own literal pools. Played with the English Ruby/Sapphire plan: Torchic L5 20/20 "TORCHIC", Littleroot Town, Route 101, a wild Poochyena L2 (7/13 after a hit, Torchic 16/20 as on screen); types and chart as in the app's data. The plan has no catch; badges aren't read (as in the German games), so no level cap shows. **Fixed:** "This ROM isn't in the memory table" in a run. Sapphire and the French and Spanish games share the layout (`sapphire_eu`) but weren't at hand. |
| **Versione Smeraldo** (Italian Emerald) | ✅ | ✅ | ✅ | ✅ | – | Recognised as a retail game (catalog `pokemon-emerald-it`, game code BPEI, retail CRC A0AEC80A) with the memory entry `emerald_eu` – the English game's RAM, address for address (the ROM's own literal pools, pokebot-gen3's language patch). Played with the English Emerald plan: Torchic L5 19/19 "TORCHIC" from Birch's bag, Littleroot Town, Route 101, a wild Zigzagoon L2 (7/14 after a hit, Torchic 16/19 as on screen); 0 badges → level cap 15 (caps read from the ROM: 15, 19, 24, 29, 31, 33, 42, 46 → 58); types and chart as in the app's data. **Real catch:** Zigzagoon L2 → "Route 101". **Fixed:** the library called it a ROM that isn't in the catalog ("maybe a hack or another region") and read nothing live. The French and Spanish Emerald share the entry but weren't at hand (the German one has its own, `emerald_de`). |
| **Feuerrote / Blattgrüne** (German FireRed / LeafGreen, 2.3.1) | ✅ | ✅ | ✅ | ✅ | – | Recognised as `firered_eu` / `leafgreen_eu` (game code BPRD/BPGD, retail CRC). Charmander L5 18/18 "GLUMANDA" from Oak, filed as the starter (met location Pallet Town); the rival's Squirtle L5 as a trainer battle, HP live as on screen (Squirtle 19 → 11, Charmander 18 → 13 / 18 → 7); level-up to 6 read after the fight; wild Rattata L2/L3, Pidgey L4 on Route 1. Place sign: Pallet Town (Alabastia in German – the house, Oak's lab), Route 1. Battle flag (gMain.inBattle at 0x03003479, −0xB0) set in both battles and cleared after them; the English address stays 0. **Real catch:** Rattata → "Route 1", in both games. sCurrentMapMusic 0x03000FC0 holds the map header's music on every map (300 Pallet Town, 301 Oak's lab, 291 Route 1) and the battle music during a battle (297/298) – the turbo music reads the song. Badges weren't read live in any Gen 3 game then (they are now – see below), and FireRed/LeafGreen have no built-in level caps (as in English). **Fixed:** the Pokémon were read as unknown ones (the German species names) and the German place names came from the Fame Checker ("Arena Marmoria" on Route 1) – see below. |
| **FireRed** (English, 1.0) | ✅ | ✅ | ✅ | ✅ | – | Checked while adding Unbound and Radical Red (their base game): the German plan's steps with the English addresses (gSaveBlock1Ptr 0x03005008, gMain.inBattle 0x03003529). Charmander L5 → "Starter", the rival's Squirtle L5 as a trainer battle (19 → 7 as on screen), Pallet Town, Route 1, a wild Rattata / Pidgey L2. **Real catch:** Rattata, Pidgey → "Route 1" (two runs). Plan: [firered-leafgreen-us.json](../scripts/rom-matrix/plans/firered-leafgreen-us.json). |
| **Pearl** | ✅ | ✅ | ✅ | ✅ | ⚠️ | Turtwig L5 21/21 from the briefcase at Lake Verity (met location Lake Verity), Twinleaf Town, Route 201, Verity Lakefront, Lake Verity, Sandgem Town (also inside the Mart); wild Starly L2 at the lake, Bidoof / Starly L3 on Route 201. **Real catch:** Bidoof L3 / Starly L3 → "Route 201", 2 of 2 runs. **Fixed (2.3.0):** the battle flag (checked live: 0x2101 / 0x2000) – battles stayed on the panel after running away. Randomized: built ✓, no live run. |
| **Platinum** | ✅ | ✅ | ✅ | ✅ | – | Turtwig L5 21/21 on Route 201 (met location Route 201), Barry's Chimchar L5 (trainer), Twinleaf Town, Route 201, Verity Lakefront, Lake Verity; wild Starly / Bidoof / Kricketot L3 on Route 201. **Fixed (2.3.0):** the battle flag (checked live: 0x2100 / 0x2800) – a wild battle showed up ~1100 frames late and stayed after running away. **Real catch:** Bidoof L3 (met location Route 201) → "Route 201" (balls thrown on the touch screen). |
| **Black** | ✅ | ✅ | ✅ | ✅ | ⚠️ | Tepig L5, met location Nuvema Town = the sign's place; zones: bedroom, downstairs, Nuvema Town, Route 1. Rival battles Snivy / Oshawott L5, wild Lillipup / Patrat on Route 1. **Real catch:** Lillipup → "Route 1", 2 of 2 runs. **Fixed (2.3.0):** the opponent's HP stayed at full (now 19 → 14 → 4 as on screen) and your Pokémon's HP during the fight; the battle flag (checked live: 0x2100 / 0x2800). Randomized: built ✓, the plan lost its way at the naming screen. **Fixed (2.8.0):** the place sign of Black/White in other languages (a player's report: Black City in the intro, then no place) – it is read from the game's copy of the current zone's header, found by the ROM's own zone headers wherever it sits; checked in the fast and the browser player (room, downstairs, Nuvema Town, lab, Route 1, in battles too; with the RAM shifted to stand in for another language, the copy is found there), no place on the title screen any more (was Black City). |
| **White** | ✅ | ✅ | ✅ | ✅ | – | Tepig L5 21/21 from the gift box, filed as the starter; no status condition and no held item, read as such (none came up to check other values); 0 badges → level cap 14 (the Striaton gym's ace). Place sign: Nuvema Town (also in the house and Juniper's lab), Route 1. Rival battles Snivy L5 19 → 14 → 0 HP and Oshawott L5 20 → 15 → 0 HP, Tepig 16/21 as on screen; wild Patrat L2–L4 / Lillipup L2–L3 on Route 1. **Real catch:** Patrat / Lillipup → "Route 1", 4 of 4 runs. **Fixed (2.3.1):** after Professor Juniper's catching demo (her Minccino L7 against a Patrat L2) its Patrat stayed on the panel as a trainer battle until the next real battle (~100 s in the test) – the battle flag (checked live: 0x2100 in battles and also in the demo, 0xF841 elsewhere) now ends it the moment the demo ends. While the demo runs it still shows as a battle (the game sets the battle value for it). Plan: [white.json](../scripts/rom-matrix/plans/white.json). The place sign reads White's copy of the zone header like Black's (2.8.0, fast player). |
| **Black 2** | ✅ | ✅ | ✅ | ✅ | – | Tepig L5 from Bianca at the Lookout (met location Aspertia City), Aspertia City, Aspertia Gate, Route 19; Hugh's Oshawott L5 (HP going down as on screen), wild Purrloin / Patrat L2. **Real catch:** Purrloin L2 → "Route 19". **Fixed (2.3.0):** Bianca's catching demo (an NPC's battle) showed as the player's trainer battle and stayed after it ended – the battle flag (checked live: 0x2100 / 0x2800). |
| **White 2** | ✅ | ✅ | ✅ | ✅ | – | As Black 2 (its position sits 0x40 further on); wild Patrat L2. **Real catch:** Patrat L2 → "Route 19". **Fixed (2.3.1):** the battle flag (checked live: 0x2100 in battles, 0xFAE3 elsewhere) – Bianca's catching demo showed as a battle against her Lillipup, and the summary screen (0x88C2, also in Black 2) did too. |

### The matrix after reading types and caps from the ROM (2.4.0)

Every game of the test set played again with `npm run matrix` (the same plans, three games at a time), twice – the
second time after the ROM's data moved into a worker thread and the audit fixes. Columns: team,
held items (all named – "hidden" where souldew can't name them: Gen 1/2, Too Many Types), place sign, battle, catch,
types (a retail ROM's types and chart equal souldew's data; a hack's from its ROM) and level cap (shown with the badges
read live – "hidden": no cap for that game). "–": the plan doesn't get there (no held item came up, no catch in it).

| Game | Party | Items | Place | Battle | Catch | Types | Cap |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Red | ✅ | hidden | ✅ | ✅ | ✅ | ✅ | ✅ 14 |
| Silver | ✅ | hidden | ✅ | ✅ | ✅ | ✅ | ✅ 9 |
| Crystal | ✅ | hidden | ✅ | ✅ | ✅ | ✅ | ✅ 9 |
| Crystal Legacy 1.3.1 | ✅ | hidden | ✅ | ✅ | – | ✅ | hidden |
| Ruby | ✅ | – | ✅ | ✅ | – | ✅ | ✅ 15 |
| Sapphire | ✅ | – | ✅ | ✅ | – | ✅ | ✅ 15 |
| Emerald | ✅ | – | ✅ | ✅ | ✅ | ✅ | ✅ 15 |
| FireRed | ✅ | – | ✅ | ✅ | ✅ | ✅ | ✅ 14 |
| Feuerrote / Blattgrüne | ✅ | – | ✅ | ✅ | ✅ | ✅ | ✅ 14 |
| Light Platinum 1.0 | ✅ | ✅ | ✅ | ✅ | – | ✅ | hidden |
| Run & Bun 1.07 | ✅ | – | ✅ | ✅ | ✅ | ✅ | hidden |
| Unbound (from a save) | ✅ | ✅ | ✅ | – | ✅ | ✅ | hidden |
| Radical Red 4.1 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | hidden |
| Too Many Types 1.6 (BPS and pre-patched) | ✅ | hidden | ✅ | ✅ | ✅ | ✅ | hidden |
| Too Many Types 2 1.5.2 / 1.1.1 patch | ✅ | hidden | ✅ | ✅ | ✅ | ✅ | hidden |
| Quetzal Alpha 9v1 (by hand, not a matrix plan) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | hidden |
| Pearl | ✅ | – | ✅ | ✅ | ✅ | ✅ | ✅ 14 |
| Platinum | ✅ | – | ✅ | ✅ | ✅ | ✅ | ✅ 14 |
| Renegade Platinum 1.3.0 | – | – | – | – | – | ✅ | – |
| Black / White | ✅ | – | ✅ | ✅ | ✅ | ✅ | ✅ 14 |
| Black 2 / White 2 | ✅ | – | ✅ | ✅ | ✅ | ✅ | ✅ 13 |
| Blaze Black 2 Redux 1.4.1 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | hidden |

Notes: the cap shown is the one with the badges read at the start (0). Radical Red: a real catch (Master Balls in its
own bag) – Hoothoot / Poochyena → "Route 1"; the rival's Squirtle read as Water from gBattleMons. Unbound: the save
stands in the Battle Tower, so no wild battle; the catch is a Pokémon joining its full team (room made in RAM) → "Battle
Tower". Renegade Platinum: the Platinum plan still stops in the bedroom (its intro differs) – its types (Fairy, 49
retyped Pokémon) and caps are from the ROM. Some plans needed a second or third attempt in one of the two
rounds (Light Platinum, Feuerrote, Crystal, the pre-patched Too Many Types 1 – its BPS-patched twin, the same file,
passed at once –, White's catch): the plans are timing-sensitive while three games run at once. Ruby's plan works only at some times of day: Ruby
seeds its random numbers from the clock, and at other minutes a person stands in the way at Littleroot's north exit –
run side by side, the previous version's code and this one passed and failed together. Run & Bun, Too Many Types and Blaze Black 2 Redux held
items: as before.

### ROM hacks

| Hack (base) | Party | Location | Battle | Notes |
|---|:---:|:---:|:---:|---|
| **Crystal Legacy 1.3.1** (Crystal) | ✅ | ✅ | ✅ | **Fixed:** the hack keeps its RAM 11 bytes further on – before, souldew read no team, no battle and a place stuck on New Bark Town. Now found from the ROM's code (all 7 addresses confirmed in the running game); maps and landmarks are Crystal's (357 maps compared). |
| **Emerald Kaizo** (Emerald) | ✅ | ✅ | ✅ | Torchic L5, Littleroot Town / Route 101, wild Zigzagoon L2; place names from the ROM. |
| **Modern Emerald 3.6** (Emerald) | ✅ | ✅ | ✅ | **Fixed (after 2.7.2):** rebuilt from the pret source with 50 more species (an expanded species table, 461), a game-mode menu after the intro and RAM of its own (PokemonModernEmerald3.6.sym: gPlayerParty 0x0201D9CC, gPlayerPartyBackup between it and gEnemyParty 0x0201DE7C, gMain 0x03001574, gSaveBlock1Ptr 0x030036F0, SaveBlock1's flags at +0x1364, SaveBlock2's bag key past +0xAC, 15 PC boxes). The team and the place were found, but battles read the backup as the opponent's party (no opponent), badges and the PC weren't read (the trainer table was found one entry early – a string in front of it – so every leader had the next one's script and no badge flags came out) and Rare Candies weren't offered. Now: gEnemyParty from the code (the pair two arrays apart) or searched in battle, the flags' offset and gSaveBlock1Ptr from GetFlagPointer's literal pool, the bag key from an empty slot, the box count from the box names. Checked in the game: Torchic L5 → "Starter", the wild Zigzagoon L2 (HP as on screen), Poké Balls written into the bag, a **real catch** on Route 101, badges 0 → 1 (Roxanne's flag 0x867 set) → cap 15 → 19, 15 boxes read. The ROM data of 1.5.6, 2.4, 3.0 and 3.3.1 gives the same picture (other addresses, found the same way). Plan: [modern-emerald.json](../scripts/rom-matrix/plans/modern-emerald.json) (it saves the game-mode menu's defaults). |
| **Light Platinum 1.0** (Ruby) | ✅ | ✅ | ✅ | **Fixed:** 141 species slots hold other Pokémon (Gen 4/5) – souldew showed the Ruby Pokémon of that number (Venipede as Weedle) or nothing. Now read from the ROM's species table; types from the ROM too (only Shaymin differs: its Sky Forme's Grass/Flying). Starter Charmander (also Squirtle/Bulbasaur checked), "Yellow Town", "Central City" (the hack's own region), wild Poochyena L2. No catch: the plan found no way out of Yellow Town. |
| **Renegade Platinum 1.3.0** (Platinum) | – | ⚠️ | – | Place names from the ROM (126, the hack's own). **Types (2.3.0):** 49 Pokémon with the hack's types, Fairy in the old "???" slot (Clefairy Fairy, Meganium Grass/Fairy, Altaria Dragon/Fairy …) – the board, the battle panel and the type rule use them, with Fairy's matchups. Not played live: its intro differs and the Platinum plan stops in the bedroom. |
| **Blaze Black 2 Redux 1.4.1** (Black 2) | ✅ | ✅ | ✅ | **Fixed:** no place sign (its place-name file is padded with empty entries). Now Aspertia City live; 153 names incl. the hack's new "Faraway Island". **Types (2.3.0):** 75 Pokémon with the hack's types (Fairy as type 17). Tepig L5 21/21 (the hack changed its stats), Aspertia City / Aspertia Gate / Route 19, Hugh's Oshawott L5 21 → 15, wild Venonat L5 / Patrat L4 with live HP. The hack's key bearer blocks the way to the Lookout until you talk to her. **Real catch:** Venonat / Patrat → "Route 19", 2 of 2 runs. |
| **Run & Bun 1.07** (Emerald) | ✅ | ✅ | ⚠️ | **New (2.3.0):** read live although it runs on an expanded engine: species by name (1233 in National Dex order, forms after them), the team searched for in RAM (0x02023A98), the place through SaveBlock1 and the ROM's own map table. Chimchar L5, Littleroot Town / Route 101, the wild (Galarian) Zigzagoon L2 with its HP. Before 2.3.0 it said "not supported". **Fixed (2.3.1, issue #3):** the starter and catches were never filed – Run & Bun keeps the IVs one bit further on, so bit 30 (the retail egg flag) is the top of the Sp. Def IV and about every second Pokémon read as an egg (the starter in the 2.3.0 round, too: "encounters: []"); the egg flag now comes from the header. The play view also gave up searching after ~30 s without a team – long before the starter. Now: Chimchar → "Starter", **real catch:** Zigzagoon L3 (met location Route 101) → "Route 101" (Poké Balls written into the bag, thrown by the game). 10 Pokémon whose names the game shortens to 10 letters (Corviknight → "Corvknight", Crabominable, Fletchinder …) are matched; the species picker offers everything up to #905 (the Sinnoh starters included). The title screen no longer shows "Petalburg City" (an empty SaveBlock1). **Fixed (2.3.1): battles.** The battle panel didn't know who was out: after a switch it kept the lead – its moves, its matchups and its HP, which didn't move while the other Pokémon took the hits (the team's own HP was live all along: measured, the party struct follows every hit) – a trainer's Pokémon was guessed as the first one standing, and a trainer with a single Pokémon (the rival's Mudkip) read as a wild battle. Now gBattleMons is searched for in RAM by the team's PIDs and OT IDs (pokeemerald-expansion's 0x5C-byte BattlePokemon; Run & Bun 0x020233FC, the address its code uses third most often, like gBattleMons in the base game) and says who is out on both sides; wild or trainer comes from the opponent's OT ID (a wild Pokémon carries the player's). Checked in the game: Birch's Zigzagoon (Chimchar 20 → 19), a wild Skitty with a switch to Poochyena (13 → 4 → 0, the panel follows the switch, also in the battle's party menu, which reorders the team), and the rival's Mudkip on Route 103 → trainer, Chimchar 23 → 11 → 0 as on screen. |
| **Unbound** (FireRed, official UPS patch, result CRC32 4B3D4957) | ✅ | ✅ | ✅ | **Fixed – nothing was read (a player's report: nothing synced; its team was never found).** Complete FireRed Upgrade (CFRU) like Radical Red: its species table starts with "??????" instead of the retail "??????????", so no table was found; its place names are written in mixed case (the retail scan wanted capitals); and it keeps the Pokémon data unencrypted (checksum 0, the four blocks always in the order Growth, Attacks, EVs, Misc), which read as a checksum error – every Pokémon a Bad Egg. FireRed's RAM layout is kept: the team at 0x02024284 (count 0x02024029), gEnemyParty 0x0202402C, gBattleMons 0x02023BE4 with FireRed's 0x58-byte battlers, gMapHeader and gSaveBlock1Ptr where FireRed has them. Now: species by the game's names (1293, its forms under their species, "Unown B" … as Unown), held items by the game's item table (729 entries, some named through a pointer – "Wishing Piece"), moves in the app's numbering (CFRU sorts the moves after #354 its own way). Checked with a save (a Lv 100 team of six): the team with its items (Life Orb, Assault Vest, Leftovers …) and moves as on the summary screen, already-caught Pokémon filed by their met location under the game's place names; the place sign in the Battle Frontier, the Battle Tower and Icy Hole (as the game's own pop-up); a wild Golbat L47 in Icy Hole (137 → 0 as on screen, Life Orb's recoil on Infernape 293 → 264 read after the battle); a Battle Tower trainer (Black Belt) – trainer from the opponents' ID, Alolan Rattata as Rattata, 201 → 0, Infernape 293 → 202 → 173, a U-turn switch to Tyranitar (index 1, the panel follows) and the next opponent (Snubbull 290/290). The matrix plan starts from a save next to the patch (any save standing where wild Pokémon appear): ✅ party, place (Icy Hole) and a wild battle (Jynx L49, Hariyama L48). Its optional level cap isn't read (see below). Plan: [unbound.json](../scripts/rom-matrix/plans/unbound.json). Also from a new game (3DS branch, with this code): the warehouse crate's starter – Gible L10 33/33 live the moment it is chosen – and the grunt's double battle → "Trainer", Inkay L7. |
| **Radical Red 4.1** (FireRed, pre-patched ROM CRC32 FBA55DD8) | ✅ | ✅ | ✅ | **Fixed – as Unbound** (CFRU, the same RAM and data layout). Its species table starts with a single "?" (1375 species up to Gen 9), and it keeps a copy of FireRed's table with the names in mixed case – that one was taken, so it read as plain FireRed's 411. The longest table wins now. A pre-patched ROM is recognised as Radical Red (library, play view, new run) – it stood in for FireRed before. Checked from a new game (the matrix plan): "play without custom options", Mom's question about starters from another region (No), Charmander L5 holding an Oran Berry → "Starter", the rival's Squirtle L5 → trainer (20 → 10 as on screen, Charmander's HP live), Pallet Town, Route 1, a wild Pokémon (Seedot, Zigzagoon or Pidgey, L2–4; Galarian Zigzagoon L3 15 → 9 as on screen, Charmander 20 → 17), then run. The game gives no Poké Balls this early and its bag isn't FireRed's, so there's no catch in the plan. Plan: [radical-red.json](../scripts/rom-matrix/plans/radical-red.json). |
| **Too Many Types 1.6** (Emerald) | ✅ | ✅ | ✅ | **Checked (2.3.1, issue #3)** with the v1.6 BPS (source Emerald 1F1C08FB, result E91FEF2D – byte for byte the pre-patched ROM from the hack's site, which the library now recognises by that CRC32). pokeemerald-expansion like Run & Bun: species by name (1235, National Dex order), the team searched for in RAM (0x02023644), the place through SaveBlock1 (pointer 0x03005D9C). Starts in the bedroom: Fennekin from Birch's bag → "Starter", Littleroot Town / Route 101 / Route 103, the wild Poochyena L2 13 → 6 → 0 as on screen. **Fixed:** its battlers are 0x60 bytes, not Run & Bun's 0x5C – gBattleMons (0x020230F8) wasn't found, so the panel didn't know who was out; the size is now found with it. Checked: a switch to Poochyena (index 1, 16/16), May's Popplio L5 on Route 103 → trainer (20 → 11 as on screen, Fennekin 10/19). **Real catch:** Poochyena L3 → "Route 101" (Poké Balls written into the bag; TMT1 keeps the bag's key at the base game's 0xAC). **Types:** its own (57 besides "???", e.g. Fennekin is Fire + type 36) – shown as none, see below. The matrix plan plays the same route on its own (starter, the wild Poochyena, Route 101 and the catch, all ✅ with the BPS-patched ROM; the pre-patched one is the same file). It answers the battle menu with A only: in these hacks B (and START) jump to RUN, a second B flees, and an A while a text prints starts the text again. Plan: [too-many-types.json](../scripts/rom-matrix/plans/too-many-types.json). |
| **Too Many Types 2 1.5.2** (Emerald) | ✅ | ✅ | ✅ | **Checked (2.3.1, issue #3)** with a pre-patched v1.5.2 ROM (D25FBCCC) and an older BPS patch ("1.1.1 mirror", result 69ECC373 – identified from its checksums, the library links it to the hack). **Fixed – it read as plain Emerald before:** a newer pokeemerald-expansion keeps the species names inside gSpeciesInfo (0x104 bytes per species, 1543 of them incl. its own Ligmiblin, Regisus …), so no species table was found; its team has no count byte in front and gEnemyParty sits before gPlayerParty (0x02032A3C / 0x02032C94, now named by the code: the pair 600 bytes apart it uses most); gMain moved to 0x03004084 (the battle flag at +0x439, found next to that literal in the code); the species field carries the Tera type in its top bits (Chimchar reads 0x5986). Now: Lilycove City (where the story starts), Chimchar L5 from Mom's package → "Starter", the rival's Froakie L5 at the west exit → trainer (19 → 11, Chimchar 17/20 as on screen), Route 121, a wild Sewaddle → wild, a switch (index 1). **Real catch:** Sewaddle L2 → "Route 121". The matrix plan plays this on its own – ✅ for party, place, battle and catch with v1.5.2 and with the 1.1.1 patch applied by souldew's patcher (Chimchar, the rival's Froakie, a catch on Route 121). The species picker offers everything up to #1024 plus the hack's own Pokémon (TMT1: up to #905). Plan: [too-many-types-2.json](../scripts/rom-matrix/plans/too-many-types-2.json). |

### Nintendo 3DS

**souldew's own player (macOS, Apple Silicon)** – Azahar 2126.2's libretro core with souldew's patch, Vulkan through
MoltenVK, New 3DS mode, checked with the real US cartridge images (decrypted `.cci`) of **Omega Ruby (Rev 2), Y, Sun
and Ultra Sun**, in the development app and in the packaged app (`electron-builder --mac dir`):

| What | Result |
|---|---|
| Start from the library, in the play view like every other game | ✅ all four, 60 fps (turbo 130–240 fps), title ID reported by the core |
| Picture (both screens), sound, keyboard and controller, touch screen with the mouse (the name entry's keyboard) | ✅ |
| Circle Pad: the direction keys move it too (Gen 7 walks only with the Circle Pad) | ✅ Sun and Ultra Sun walk |
| Savestates (15–23 MB), quick save/load, restart, fast-forward, screenshots | ✅; a state from another core mode is refused with a message instead of crashing the core |
| "Saved in the game" indicator (follows the game's save files on the virtual SD card) | ✅ Omega Ruby: "before this session" → "12 seconds ago" after saving in the game |
| **Omega Ruby live:** team, nickname, HP | ✅ Torchic L5 20/20 with its nickname, from boot (the game loads its save at start) |
| **Omega Ruby battle panel** | ✅ wild Poochyena L3 with HP as on screen; gone after the battle |
| **Omega Ruby place sign** (the zone in memory → the ROM's zone table → the place) | ✅ Littleroot Town ("Wurzelheim") → Route 101 |
| **Omega Ruby 1.0: the party object** (3.0.1, tickets #37/#82 – a team not found or a catch not shown) | ✅ a new game to Torchic: the team lives in one object – six slots, then `06 00 00 00` and the count – at 0x08CF727C; a second Pokémon written there shows in the game's party menu. Over the heap exactly one such object, with a cold start + Continue and after a loaded state alike (reads follow the game after a state load). souldew's search for it (gen67.mjs locateCtrParty) in the real player page: found in 6.3 s over 237 windows in the game; at the title screen none (the save's team is loaded, the object not set up yet) |
| Zone tables of all four ROMs (X/Y: last file of `a/0/1/2`, ORAS: second-to-last of `a/0/1/3`, Sun/Moon/USUM: `a/0/7/7` file 0, LZ11) | ✅ every zone has a named place |
| **Ultra Sun live:** team | ✅ Rowlet ♂ L5 23/23 the moment Kukui hands it over |
| **Ultra Sun battle panel** | ✅ wild Yungoos ("Mangunior") L3 16/16 → HP as on screen, "wild"; Hau's Popplio L5 → "Trainer", Water vs Rowlet ×½; gone after both. **Fixed:** Gen 7 keeps the opponents after the player's 12 battlers (block 12+, 24 read now – the panel stayed empty), and the Stream Tool's trainer byte reads 1 in wild battles too on 1.0 – the battle type byte 0x33FC1F44 (found by souldew: 1 from the trainer's cutscene on, 0 for wild, also right after a trainer battle) |
| **Ultra Sun place sign** | ✅ "Route 1" (the house 36, outside 1, the grass 5 – all Route 1 in the ROM's table). The zone sits in the player's position { u16, u16 zone, float x, y, z } at 0x33F6D74A, found with a heap scan across house → outside → house; the same after a fresh start |
| **Sun live** | ✅ played from the house on (bag and hat from the moving boxes, Kukui, Mahalo Trail, the bridge): Rowlet ♂ L5 22/22 the moment Hala hands it over, "Lili'i" (Iki Town) on the sign, later "Route 1"; L6 24/24 after the first battle. Battle panel: Hau's Popplio ("Robball") L5 → "Trainer", Rowlet's Tackle, Leafage (×2) and Growl (Gen 6/7 moves named since the merge with 2.4.0) (type byte 0x341C8CAC = 1), a wild Pikipek ("Peppeck") L3 in Route 1's grass → "wild" (type byte 0, in-battle 0x341C8CCD = 1). Kukui's demo battle (his Rockruff vs a Pikipek, your team not in it) shows no panel – the game doesn't set the in-battle flag there |
| **Sun: Rare Candy cheat** (Sun 1.0) | ✅ in the play view (free play, scratch data folder): "Available once live tracking has found your team" until Rowlet is read, then "Add 99 Rare Candies" → "+99 Rare Candies in your bag"; the bag in the game: Medicine › Rare Candy ×99 (NEW), a second use stacks to 198, the Sparkling Stone in Key Items untouched and nothing else in the bag changed (4 bytes written, the block compared before/after). The host writes in 3–40 ms. X/Y, ORAS and Ultra Sun/Ultra Moon use addresses from Multi-PokemonFramework and the update shifts – not checked in a game |

**Randomized Sun** (macOS, Apple Silicon, the No-Intro US cartridge image – decrypted `.3ds`, 4 GiB, NCCH 3.0 GB):

| What | Result |
|---|---|
| New-run wizard | ✅ "802 Pokémon · randomizer supported", Gen 7 options (totem Pokémon), only the 4 tweaks UPR offers for Sun, live progress (reading, randomizing, writing x %, checksum) |
| Build ("Nuzlocke hard mode", "Classic") | ✅ one `.cxi` of 3,218,046,976 bytes in ~35 s incl. SHA-1; UPR's working files in the cache, gone afterwards |
| Same seed + settings twice / on Temurin 17, OpenJDK 21, OpenJDK 27 | ✅ byte-identical `.cxi` and `p1.data.json` (hard mode: e63e995f…, chaos: ec155e97…) |
| SoulLink join (second profile imports the pack, builds p2) | ✅ "byte-identisch mit dem deines Freundes" (`matchesFriend: true`); shared seed: p2 hard-linked to p1 on the host |
| Built-in player (play view of the run) | ✅ boots to the language selection at 60 fps; `ctrhost --bench` the same |
| Encrypted dump | ✅ (made-up file with Sun's IDs, unit test) "encrypted – needs a decrypted copy", never "not supported" |
| Gen 1–5 unchanged | ✅ Platinum and Emerald, "hard mode" seed 4242: the old bridge + 2.6.3 settings and the new bridge + new settings give the same ROM and data |
| Azahar app with the `.cxi` | not checked (a `.cxi` starts in Azahar like any other – see below) |

**Azahar app** (the external route, Windows/Linux or by choice): checked on macOS with **Azahar 2126.2**, installed
through souldew's one-click install, in its own portable profile, with free homebrew and stand-ins:

| What | Result |
|---|---|
| Library: Checkpoint `.3dsx`, ftpd `.3dsx`, FBI `.cxi`, Anemone3DS `.cia`, 3DShell `.cia` | ✅ recognised (title from the SMDH, title ID from the NCCH / the CIA's TMD), no file read whole |
| Launch from souldew (`.3dsx`, `.cxi`), `.cia` opens Azahar empty with the install hint | ✅ (screenshots through Azahar's RPC server) |
| RPC server switched on from the play view, connection, running title from the process list | ✅ – homebrew reported as "no live data for …" |
| A second start while Azahar is open | ✅ refused with a message (macOS `open -a` would not hand over the game) |
| **Stand-in Pokémon X** (FBI with X's title ID), an encrypted Gen 6 party written to X/Y 1.0's party address over RPC | ✅ Nuzlocke built (game hard-linked, no randomizer), starter, a catch filed under "Route 2", level-ups, a faint (death notice, graveyard), the first badge, trophies – with the board open instead of the play view |
| Stand-in Omega Ruby, party at the 1.4 update's address | ✅ version found by itself, party read |
| Stand-ins Sun / Ultra Moon | ⚠️ title → entry ✅; the party addresses lie outside the small homebrew process, so only the unit tests (real PK7 files) cover the Gen 7 party |

**Linux** (Ubuntu 24.04 arm64 in a VM on the Mac, Mesa's software Vulkan "llvmpipe"): `node scripts/build-ctr.mjs`
clones Azahar 2126.2, applies the patch and builds core and host (gcc 13) without help; the host runs Ultra Sun through
the system's `libvulkan.so.1`, loads a savestate made on the Mac, reads the team (Rowlet L5 23/23) and the zone over the
same protocol and sends the picture (60 fps in the core; the software renderer hands over ~35 pictures a second).
**x86-64 Linux** (the same VM, x86-64 programs through Rosetta, Mesa's x86-64 llvmpipe): the host cross-built with
`x86_64-linux-gnu-gcc` and the patched core cross-built for x86-64 run Ultra Sun the same way – state, team (Rowlet L5
23/23), zone, title, picture; Azahar's own unpatched x86-64 core runs it too (no live data, as expected). The release
builds come from `.github/workflows/ctr.yml` (gcc 12 on Ubuntu 22.04, as Azahar's CI).

**Windows** (Wine 9 x86-64 in the same VM, through Rosetta; Vulkan through Wine onto Mesa): `ctrhost.exe` (MinGW-w64,
cross-compiled here without a warning, only Windows' own DLLs) with Azahar's official Windows core runs Ultra Sun over
souldew's protocol – stdin/stdout pipes, the command thread, ~60 fps, pictures, the title, a clean answer to a savestate
the core rejects (one made on the Mac – Windows builds of the core write their states differently, and souldew keeps
states on the machine that made them; the play view now says so instead of "loaded") and QUIT. **With the patched
Windows core** (cross-built in the VM with Ubuntu's MinGW-w64; it exports `souldew_read_memory` / `souldew_title_id`
and needs only Windows' own DLLs) live memory works: the title ID from the core, the watched regions every 6 frames.
**GitHub Actions** (the branch pushed for it, no release): `.github/workflows/ctr.yml` built the 3DS part for Windows
(the core in libretro's MXE container, as Azahar's CI; its two souldew exports checked) and for Linux (gcc 12 on Ubuntu
22.04); the Windows workflow ran `ctrhost.exe` on `windows-latest` and built and smoke-tested the installer with the 3DS
part inside (unpacked and installed app), the Linux workflow the AppImage and the .deb. A game on a real Windows PC is
still to come – `windows-latest` has no GPU for Vulkan. (Wine only hands
console programs Vulkan in a virtual desktop – a Wine detail, not one of Windows.) Without Vulkan (no graphics driver)
souldew opens the Azahar app instead.

Not checked: X/Alpha Sapphire/Moon/Ultra Moon (same code as their pairs).

### The cheats menu (3.0)

`node scripts/rom-matrix.mjs <roms> --live --cheats` (macOS, Apple Silicon, the browser player – HeartGold/SoulSilver
and Black/White on DeSmuME –, hidden and muted, a scratch data folder): each game's plan up to its first team (or a
check out of battle), then every cheat the play screen's way (`applyCheat`) with the amounts 1, 10, 99, 999 and 1
again, each checked through a read of its own – exactly that many more, in its pocket, nothing else in the bag
changed, the stack's cap answered with "max", still there five seconds later – and the money +₽1,000 / +₽10,000 /
+₽100,000 / max / +₽1,000. Then the game's own bag and trainer card where the plan could open them.

| Game (ROM) | Items (8) | Money | In the game | Notes |
|---|---|---|---|---|
| Red, Blue (US/EU) | ✅ one bag | ✅ BCD | Blue: bag ×99 each, card ¥999999 | |
| Yellow (US/EU) | ✅ | ✅ | – | plan: walk to the ball on Oak's table |
| Gold, Silver (US/EU) | ✅ balls in the Ball pocket | ✅ | Gold: Items and Balls pockets, card ¥999999 | Ball pocket: 12 slots, never past them |
| Crystal (US) | ✅ | ✅ | Items pocket | |
| Ruby (US, German), Sapphire (German) | ✅ | ✅ | bag, Poké Ball pocket, card ₽999999 | |
| Emerald (US) | ✅ | ✅ | bag, Poké Ball pocket, card ₽999999 | |
| Emerald (German, from the acceptance save) | ✅ | ✅ | in a Pokémon Center: bag, Poké Ball pocket, card ₽999999 | the plan's new game doesn't get past a townsperson |
| FireRed (US, German) | ✅ | ✅ | – | |
| Diamond (US) | ✅ from an empty bag | ✅ | – (lakefront scene) | empty bag taken: save pointer + party + trainer block |
| Platinum (US) | ✅ from an empty bag | ✅ | – | |
| HeartGold, SoulSilver (US, from a save) | ✅ | ✅ | overworld: Items › Max Repel ×999 | SoulSilver loads the HeartGold save |
| Black, White, Black 2, White 2 (US/EU) | ✅ from an empty bag; balls with the items | ✅ | – | empty bag taken: the party at its own address, trainer name, money |
| Sun 1.0 (the app, free play, an Iki Town save) | ✅ through the menu's buttons, amounts ×1/×10/×99 | not offered | Medicine: Rare Candy ×10, Full Restore, Revive, Max Revive (NEW) after Continue | written on the title screen, kept when the game continues |
| Ultra Moon 1.0 (a new game, player3ds.html) | ✅ after the intro had set the bag up | not offered | – | two writes during the intro's own set-up: refused ("changed") or undone by the game |
| Y, Omega Ruby Rev 2 (a new game) | written and read back, but 2 of 40 undone by the game during the intro | not offered | – | **not offered** – no save to try them past the intro |

The menu in the app (Sun): before the team is read "Available once live tracking has found your team." on every row;
then the confirm bar ("Add 10 × Rare Candy to your bag?"), the flash ("+10 × Rare Candy in your bag"), the menu in the
four colour schemes; Tab reaches ×1/×10/×99 and every item.

### With players' saves (2.5.0)

Saves other players shared (Project Pokémon's user-contributed saves; the 3DS ones as the `main` file on the
emulator's SD card, the others as the game's battery save) in the development app with its own data folder – the
games from the middle or the end of a playthrough instead of a new game:

| Game (save) | Checked | Result |
|---|---|---|
| **Ultra Sun** (in front of Tapu Koko, Ruins of Conflict) | Solo Nuzlocke from the save: place sign, team, the legendary battle, False Swipe to 1 HP, a Master Ball, in-game save, savestate save / load, resume | ✅ "Ruinen des Krieges"; shiny Smeargle L100 314/314 with False Swipe, Spore, Skill Swap, Soak as in the move menu; Tapu Koko L60 → "wild", "Legendary", Electric/Fairy and its matchups, 172 → 88 → 1 HP as on screen; the catch filed under the Ruins of Conflict, Tapu Koko in the team; "saved in the game: just now"; slot 1 loaded back to the party screen it was taken on. **Fixed:** the paralysed Smeargle showed "asleep" (Gen 6/7 number their status: 1 paralysis, 2 sleep, 3 freeze, 4 burn, 5 poison) and the Nuzlocke question after the battle offered "Route 1" instead of the place on the sign |
| **Omega Ruby** (a finished Italian save) | Team, place sign | ✅ six Pokémon L100 (four Linoone, Altaria, "Hunter") with HP, gender and held items as on the party screen; Sootopolis City ("Xeneroville") |
| **Y** (a Vivillon-pattern save) | Team, place sign | ✅ Fletchinder ♀ L20 21/61, Route 7 |
| **HeartGold** | Team, place sign | ✅ six nicknamed Pokémon L100 with HP from the title screen on (the game loads its save at start), Goldenrod City |
| **Black** | Team, place sign | ✅ six Pokémon L100, Lacunosa Town as the game's own banner |
| **Silver** | Team, place sign | ✅ six nicknamed Pokémon L100 (incl. Lugia and Ho-Oh), Ecruteak City ("Teak City") |

The game's own save on the virtual SD card was checked too: after saving in the game, Ultra Sun started cold (no
savestate) from the title screen into the Ruins of Conflict with Tapu Koko in the team and Smeargle still paralysed.
The packaged 2.5.0 app (`npm run dist`) ran the same run with its bundled 3DS part (60 fps, live team).
**Windows 3DS part from GitHub Actions** (the 2.5.0 build's `ctrhost.exe` and patched core) under Wine in the VM
described above: Ultra Sun from the same downloaded save in a save folder named "Jürgen-save" (the host now hands
the core UTF-8 paths), 60 fps, the title ID, Smeargle L100 314/314 read from the game's memory, and the whole catch
by buttons: the Tapu Koko battle, False Swipe three times, a Master Ball, no nickname – then Tapu Koko L60 1/172 in
the second slot read from memory (Smeargle 76/314). A savestate (18 MB) taken in the Tapu Koko cutscene loaded
back from the battle menu to the same text ("stateLoaded ok"). Omega Ruby from the finished Italian save in a
"Jürgen-or" folder: the team of six read live, the game's menu → Save → Yes wrote the `main` file on the SD card, and a
cold start went back into the Pokémon Center with the same team read. A real Windows PC with a graphics driver is still
to come.

### Not in the test set

Blue, Yellow, Gold, the English LeafGreen, Diamond, HeartGold, SoulSilver and all non-English ROMs except
German FireRed/LeafGreen weren't part of this round (HeartGold US, Definitive HeartGold and Silver were checked live
before 2.2.1). FireRed/LeafGreen's place-name table is now checked with the German ROMs only (108 of 109 names as in
souldew's German table).

**German, French, Italian and Spanish FireRed/LeafGreen (2.3.1)** have their own memory-table entries now
(`firered_eu` / `leafgreen_eu`, issue #16): the English game's EWRAM, IWRAM from `gMain` on 0xB0 lower. Taken from two
trackers that run on these ROMs (pokebot-gen3's per-language symbol patches, Ironmon-Tracker's address files), which
agree address for address – see [research/live_ram.md](../research/live_ram.md). **Checked in the running German games**
(Feuerrote, Blattgrüne – the matrix above, plan `scripts/rom-matrix/plans/firered-leafgreen-eu.json`): team, battles,
battle flag, place sign, catch, the bag (the test's Poké/Master Balls went in through the cheat's SaveBlock1 pointer
0x03004F58) and the map music. French, Italian and Spanish ROMs share the table but weren't at hand.

### The place sign in every language (2.8.0)

The place sign used to read the current map from addresses that are only known to be right for the games they come
from – mostly the English ones (pret's symbols, NDS-Ironmon-Tracker, souldew's own checks). In a game whose RAM is laid
out differently (another language, a revision, a game still booting) it then showed whatever was there: Black City in
Black/White in other languages (fixed in 2.7.5), and – found in this round – Pallet Town on Red's title screen and in
Oak's intro, Black City at power-on in Black 2/White 2. Since 2.8.0 every reader takes the place only from RAM it can
check against the ROM, and shows no place rather than a guessed one:

| Games | Where the place comes from | Checked against | Not at the English address (another language) |
|---|---|---|---|
| Red/Blue/Yellow | the copy of the current map's header in WRAM (wCurMapHeader, 10 bytes) | the ROM's map headers (MapHeaderPointers/MapHeaderBanks, found by their structure) | searched for in WRAM (8 KB, at most every 2 s, one copy only) and remembered |
| Gold/Silver/Crystal | the copy of the map's header and attributes (wMapPartial + wMapAttributes, 17 bytes) | the ROM's maps (MapGroupPointers, found by their structure; must be exactly the maps souldew's table has) | as Gen 1 |
| Ruby/Sapphire/Emerald, FireRed/LeafGreen | gMapHeader (a copy of the ROM's MapHeader) | its events pointer and section must be one of the ROM's maps | no place (the trackers that run on the other languages agree on gMapHeader for D/F/I/S) |
| Diamond/Pearl/Platinum, HeartGold/SoulSilver | the map id in the save data | the save data the party reader confirmed (English: pret's pointer; other languages: the trainer owns the team), or a pointer whose save data holds a trainer | no place until then – never the scanned party's address (it may be a battle's copy) |
| Black/White | the copy of the zone header (2.7.5) | the ROM's zone headers | searched for (4 MB, at most every 3 s, one copy only) |
| Black 2/White 2 | the copy of the zone header behind the main pointer (+0x41B2C) – found in this round | the ROM's zone headers, the zone id after the copy | as Black/White |
| X/Y, ORAS, Sun/Moon, USUM | the zone id (unchanged) | read only once the team was found at one of the game's update addresses | – (one RAM layout for all languages of a cartridge) |

**Checked in the running games** (US/EU ROMs, browser player and fast player, 2026-11-16 – the matrix plans with a
check at power-on and the raw bytes recorded at every check): Red (power-on: no place – was Pallet Town; the bedroom
via the new-game warp, Oak's lab, Route 1, battles, the catch), Silver and Crystal (power-on: no place; bedroom, New
Bark Town, Elm's lab, Route 29, battles, the catch – the map the header copy names was the one wMapGroup/wMapNumber
name at every check), Sapphire (Littleroot Town, Route 101 – gMapHeader checked against the ROM's 394 maps), Pearl and
Platinum (Twinleaf/Route 201, Verity Lakefront, Lake Verity, Sandgem Town and its Mart; the trainer block of the save
data read as a trainer at every check), Black 2 and White 2 (power-on: the old reader showed Black City, now no
place; the copy of the zone header at main pointer + 0x41B2C byte for byte the ROM's header of the zone after it in
the room, Aspertia City, the Pokémon Center, Aspertia Gate, Route 19, in battles too). Red, Silver, Crystal, Sapphire,
Emerald, Black 2 and White 2 in both players, Pearl, Platinum in the browser player, Black (unchanged reader) in the
fast player; Crystal Legacy 1.3.1 (its WRAM 11 bytes further on – the header copy moves with it) and Blaze Black 2 Redux
1.4.1 (its own zone table) too. All plans passed, with one exception that isn't one: in a White 2 run the walk to Route
19 hadn't left Aspertia Gate at that check – the sign said Aspertia Gate, as did the game's own copy.

**Other languages, simulated:** the WRAM recorded at every check of Red (8 checks) and Crystal (17) was shifted the way
another language could keep its variables (bank 1 moved by −0x40 … +0x55 bytes, 9 shifts each): the new readers found
the same place in all 225 shifted images; reading the English addresses there would have shown a wrong place in 77 of
them. The tests do the same with made-up ROM tables for every reader (test/location-languages.test.mjs).

**Not checked in a running game (no ROMs at hand):** the German, French, Italian, Spanish and Japanese Game Boy games
(their map tables are found by structure – in the English ROMs exactly where pret's symbols put them; German Yellow
"POKEMON YELAPSD" and Japanese Green have no memory-table entry at all), German Ruby/Sapphire/Emerald/FireRed/LeafGreen
in this round (the check against the ROM's maps is new), every non-English DS game (German HeartGold, Platinum,
Black/White, Black 2/White 2 …: whether their main pointer and the module params pointer lead where the English ones
do – if not, the copy is searched for, and Gen 4 waits for the party reader), Yellow, Gold, Blue, Diamond, HeartGold,
SoulSilver, the 3DS games after an update other than the ones in the memory table.

## What the checks found and what changed

- **Emerald place names** read from the ROM were shifted: the region-map table has an empty name in the middle, which
  ended the scan; the Kanto half was then read as sections 0… Empty names now count; team placeholders ("{AQUA}
  HIDEOUT") are filled in per game (Ruby: Magma).
- **Modified ROMs show their own place names**: a ROM whose CRC32 isn't a retail one (randomized, a hack) always shows
  the game's own names, also when its language differs from the app's – before, the app's table won then, which names
  another place in a hack. New catches are named the same way (Gen 5 catches got "#6" before).
- **GBA hacks with other Pokémon** (Light Platinum): species from the ROM's own name table, matched to the National Dex
  by name; a Pokémon only the hack has keeps the hack's name instead of a wrong one.
- **Expanded engines** (Run & Bun, Unbound, Radical Red, pokeemerald-expansion hacks) are recognised from the species
  table and shown as "not supported yet" – never as the base game's Pokémon.
- **Game Boy hacks with moved RAM** (Crystal Legacy): the shift is read from the ROM's code (which addresses it loads),
  for the team, the battle, the place and the cheats' bag.
- **Gen 5 place names** of hacks that pad their text file (Blaze Black 2 Redux).
- **Gen 5 battles** end when the game copies the battle's HP back, instead of ~90 s later.

Round 2 (2.3.0) – every game played to a real wild catch where the plan gets there (Poké Balls are written into the
bag by the test, the game itself throws and catches):

- **Catch filing:** every real catch landed in the right area – by the game's met location (Crystal, Gen 3–5) or, for
  Gen 1 and Gold/Silver, by the place the sign showed when the catch joined right after a wild battle (new).
- **Battle flags** checked in the running games (Platinum, Pearl, Black, Black 2; White 2 and White in 2.3.1) and used: battles start and end on
  time, an NPC's catching demo is no longer the player's battle.
- **Gen 5 battle HP** from the battle's own structs: the opponent's and your Pokémon's HP go down as on screen.
- **Types from hack ROMs** (Gen 3 base stats, Gen 4/5 personal data), Fairy matchups for hacks that add the type.
- **Run & Bun** is read live (expanded engine).

Unbound and Radical Red (Complete FireRed Upgrade) – read live now:

- **Species tables behind a shorter row of '?'** ("??????", "?"), of all the tables found the longest (Radical Red
  keeps FireRed's, renamed); Unown's forms ("Unown !", "UNOWNB") are Unown, and a shortened name is matched once per
  Pokémon, whichever language fits.
- **Place names in mixed case**: FireRed's pointer table rewritten by the hack ("Frozen Heights", "Route 1") – taken
  when no capitals table is there, at most as many names as a section byte can number from 0x58 on.
- **Unencrypted Pokémon data** (checksum 0, fixed block order) – only in an expanded engine and only where the block
  reads as one.
- **FireRed's own addresses first**: an expanded engine's team is looked for at its base game's address before the
  search (which in FireRed's layout would take gEnemyParty – three bytes behind the player's count – for the team),
  and gBattleMons in FireRed's 0x58-byte layout too.
- **Item names and moves from the ROM**: the item table (44 bytes per item, some names through a pointer) and the move
  names, mapped to the app's move numbers by name in the ROM's language (CFRU sorts the moves after #354 its own way;
  pokeemerald-expansion keeps the National order and is left as it was).

Read from the ROM instead of per-game data (2.4.0) – the matrix gained columns for held items, types and level
caps, and every game in the test set was played again (see "The matrix after reading types and caps from the ROM"):

- **Types from the ROM, for every game** (`shared/live/romtypes.mjs`): the type names, each species' types and the type
  chart, validated against the retail chart (at most 2 cells off; Gen 6's Steel change allowed). Every retail ROM in
  the set reads exactly as souldew's own data – 0 Pokémon and 0 chart cells different (Red, Silver, Crystal, Ruby,
  Sapphire, Emerald, FireRed, Feuerrote, Blattgrüne, Pearl, Platinum, Black 2 …). Charts found: retail triples (GBA,
  Gen 4 in overlay 16 of Platinum / 11 of Pearl, Game Boy with its Foresight marker), Unbound's CFRU triples with Fairy
  as type 23, Radical Red's 24 × 24 byte matrix (0 = ×1, 1 = ×0 – the leftover FireRed chart next to it is passed
  over), Run & Bun's 19 × 19 4.12 halfwords, Too Many Types 1's 63 × 63 halfwords (×3 / ×4 matchups too), Too Many Types
  2's 81 × 81 4.12 words with TYPE_NONE first, Blaze Black 2 Redux's 18 × 18 Gen 5 matrix in overlay 167. Renegade
  Platinum keeps the retail chart: its Fairy (the old '???' slot) gets Gen 6's matchups. Too Many Types now shows its
  own types under the game's names (44 / 59 used by Pokémon: "Monke", "Anime" …) with their matchups. Moves' types come
  from gBattleMoves where it is found (retail GBA, Light Platinum, Unbound 557, Radical Red 553); pokeemerald-expansion
  packs them differently – its moves keep souldew's types (Gen 6's for a Fairy hack), and a hack with types of its own
  shows matchups by type only.
- **The battle's current types** (Gen 3): from gBattleMons (type1/type2 at +0x21 in the retail and CFRU layout, three at
  +0x22 in pokeemerald-expansion), trusted once the player's battler read as its species' types – Radical Red's
  rival Squirtle read as Water in the matrix run.
- **Level caps from the game's trainers** (`shared/live/romcaps.mjs`): leaders, Elite Four and champion by class name
  (five languages and the hacks' spellings), each leader's weakest team, ordered by the badge flags the leaders'
  scripts set (Gen 3, with the leader's name) or by ace (DS – shown as "Gym n": Pearl's Maylene and Wake share an ace
  of 30, so a name could be the wrong one). Derived (cap with 0 … 7 badges, then the champion's):
  Ruby / Sapphire 15, 18, 23, 28, 31, 33, 42, 43 → 58 · Emerald 15, 19, 24, 29, 31, 33, 42, 46 → 58 · FireRed / LeafGreen
  (English, German) 14, 21, 24, 29, 43, 43, 47, 50 → 63 · Pearl 14, 22, 30, 30, 36, 39, 42, 49 → 66 · Platinum 14, 22, 26,
  32, 37, 41, 44, 50 → 62 · Renegade Platinum 16, 26, 33, 39, 44, 53, 56, 62 → 78 (as in the hack's own trainer list) ·
  Black 2 13, 18, 24, 30, 33, 39, 48, 51 → 59 (the curated list, which wins, has the same aces). Not derived, no cap
  shown: Unbound (a leader's teams a few levels apart – its difficulty settings), Radical Red and Light Platinum (a
  second set of leaders: Johto's / another region's), Blaze Black 2 Redux (Challenge Mode leaders two levels above the
  normal ones), Run & Bun and Too Many Types (their trainer struct isn't the retail one), Crystal Legacy (Game Boy:
  curated lists only). No game's own hard cap was found (none of the hacks keeps a badge-flag → level table).
- **Badges** are read in GBA games (SaveBlock1's badge flags – FireRed 0x820…, Emerald 0x867…, Ruby/Sapphire 0x807… –
  trusted while "has a Pokémon" is set and SaveBlock2's trainer ID is the team's; German Ruby/Sapphire keep their RAM
  elsewhere and weren't checked – no badges there) and in Diamond / Pearl / Platinum (the trainer data in RAM, trusted
  while its trainer ID is the team's).
- **Catches in CFRU hacks**: Radical Red – Master Balls written into its own bag (gBagPockets 0x0203988C points outside
  SaveBlock1; the balls are pocket 2 of 450 / 75 / 50 / 128 / 75 slots, quantity key 0) and a real catch on Route 1
  (Poochyena L4 → "Route 1"). Unbound – the save at hand stands in the Battle Tower (no wild Pokémon there): room made
  in its full team in RAM and a sixth Pokémon joining, filed under "Battle Tower".

German FireRed/LeafGreen (2.3.1, issue #16) – the memory table was right, two readers of the ROM file weren't:

- **Species names in the game's language:** the species table read from a GBA ROM was matched by English names only,
  so in German (also French, Spanish, Italian) Gen 3 ROMs 275 Pokémon looked like a hack's own ("GLUMANDA" instead of
  Charmander #4) – the starter was filed as an unknown Pokémon. This also hit German Ruby/Sapphire since 2.3.0. Names
  now match in all five languages: the German retail ROMs read as the retail table.
- **FireRed/LeafGreen place names from the ROM:** the scan took the longest table of short capitals names – in the
  German games that is the Fame Checker's ("ALABASTIA", "POKéMON-LABOR", … then people), so Route 1 was "Arena
  Marmoria" for a German app. It now takes the table with the most different names, a name may have a lower-case
  letter ("DIGDAs HÖHLE"), and "POKéMON-HAUS" is shown as "Pokémon-Haus".

## Known gaps

- Catching demos (2.8.1): told by the battle type in Gen 1–3 (pret decomps) and, in the DS games, by the demo's two
  one-Pokémon parties (Dawn/Lucas's starter and Bidoof, Lyra/Ethan's Marill and Rattata, Juniper's Minccino and a
  Patrat, Bianca's Lillipup and a Purrloin) – checked against the decomps and synthetic RAM, not yet in a running game.
  While only one of the demo's parties has been found (the first second or so) it can still flash up as a battle.
  Wally's Zigzagoon and the Poké Dude's Teachy TV team are replaced by the team saved before them (SaveBlock1); German
  Ruby/Sapphire (their RAM unchecked) don't get that. Gen 6/7 demos (Omega Ruby/Alpha Sapphire's Wally) aren't told
  apart yet.
- White: in the game's other languages (memory unchecked) a battle may stay on the panel after it ended, as before 2.3.1.
- White: the address souldew had for "your Pokémon that is out" (battleActive, from NDS-Ironmon-Tracker) holds the wild
  opponent's PID instead (checked live) – it's only used when it is one of yours. Switching in a battle wasn't checked
  in White (one Pokémon in the test team).
- Run & Bun: double battles aren't read as such – the panel follows the left Pokémon of each side, and its partner once the left one is down; both at once aren't shown (no double battle in the test run, checked with a test only).
- Expanded-engine hacks (Run & Bun, Too Many Types, Unbound, Radical Red …): the Rare Candy cheat is off (other item numbers).
- **Pokémon Quetzal Alpha 9v1** (Emerald header BPEE, title "PKM QUETZAL", SHA-1 c108cec7…, 3.0): recognised by its header
  title (it used to be read as Emerald: no team, "Pokémon Emerald Version", the randomizer's check failing with
  "unreadable"). Checked by hand in a new game (Kanto start): Sprigatito (species 1214 → #906) from Oak, the rival's
  Squirtle (trainer, 13 → 7 → 0, a forced faint of the starter read as 0 HP), a wild Pidgey on Route 1 caught → "Route 1";
  Pallet Town / Route 1 / Oak's lab from the ROM's place names (one pointer per language per section); held items by the
  game's names (Gengarite, Rare Candy – as its summary screen shows them). Its party struct is 104 bytes (HP and status
  packed in front of an unencrypted data block – shared/live/quetzal.mjs), SaveBlock1's position 0x470 bytes behind
  gSaveBlock1Ptr 0x030055BC. Not read: the PC boxes (another box struct, unchecked), badges and level caps (the hack has
  its own), shininess (it has "radiant" Pokémon of its own – unchecked), sprites of its own Pokémon (Browt, Pombon,
  Gecqua: named, no picture). Off: cheats and gifts (its bag packs item and quantity into one encrypted word), souldew's
  randomizer (UPR ZX refuses the 32 MB ROM – the hack has its own), link trades and battles, Shared World, raids. Only
  the Kanto start and its first route were played; Johto/Hoenn starts and double wild battles (a new-game option) weren't.
- Too Many Types 1/2: only the start of each game was played (to the first catch); double battles weren't met. Their
  moves' types aren't read (pokeemerald-expansion packs gBattleMoves differently): the battle helper shows matchups by
  the Pokémon's types only, not per move.
- Unbound / Radical Red / Light Platinum / Blaze Black 2 Redux / Run & Bun / Too Many Types: no level cap (see above).
  Unbound's optional hard cap isn't read. The Rare Candy cheat is off in the CFRU hacks (the bag isn't FireRed's).
  Unbound: no wild battle and no real catch in this round – the save at hand stands in the Battle Tower; the catch was
  checked by a Pokémon joining the team in RAM.
- Moves of DS hacks that retype them (Fairy moves in Renegade Platinum / Blaze Black 2 Redux) come from souldew's move
  data (Gen 6's types for a Fairy hack); the Pokémon's types and the chart come from the ROM.
- The battle's current types are read in GBA games only; DS and Game Boy battles use the species' types from the ROM.
- Gen 5 PC boxes (2.8.1): read from the save blocks in RAM, 0x18A00 before the party block (Black: 0x0221BFAC, as the
  community's RAM maps give it) – checked with synthetic RAM, not yet in a running game; Black 2/White 2 by the same
  layout. A PC that reads as completely empty counts as unknown. Gen 1/2's PC isn't read (Gold/Silver/Crystal keep the
  boxes in the cartridge RAM, Red/Blue/Yellow only the current box in WRAM).
- Gen 3 PC boxes are read live in the retail games (FireRed/LeafGreen in English, German, French, Italian and
  Spanish, English Emerald, English and German Ruby/Sapphire): a catch sent to the PC is filed right away. Expanded-engine
  hacks (2.8.3, #77): read behind the pointer after the save block pointers wherever the PC checks out there (box names
  behind 14–24 boxes, every slot a valid Pokémon) – Modern Emerald and Run & Bun 1.07 (gPokemonStoragePtr 0x03005DA4,
  14 boxes, measured in the game; it renumbers its items, which kept its PC unread before). Complete FireRed Upgrade
  (Unbound, Radical Red) packs its PC: there a catch sent to the PC (a full team) is filed once it joins the team.
- German Ruby/Sapphire: no badges are read (their RAM sits elsewhere than in the English games and no German ROM was at
  hand to check), so no level cap either.
- The ROM's data is worked out in a background thread the first time a game is opened (a few seconds for a big ROM);
  a damaged file or a scan over 3 minutes counts as "not known" until the file changes.
- Level caps: Game Boy hacks (Crystal Legacy) get none (the Game Boy trainer data isn't read yet). A ROM's caps need its
  badges read live – an expanded GBA engine only through badge flags its own scripts name.
- The input plans are timing-sensitive (inputs land a frame or two apart from run to run); the matrix script retries a
  game whose plan loses its way (`--attempts`). DS plans take 10–25 minutes each.
