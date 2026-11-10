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
| **Red** | ✅ | ✅ | ✅ | ✅ | ⚠️ | Charmander L5 "AAAAAAAAAA", rival's Squirtle L5 (trainer), level-up to 6 read after the fight. Places are the town-map names (Oak's lab = Pallet Town). **Real catch:** a wild Rattata L3 on Route 1 → filed under "Route 1". **Fixed (2.3.0):** Gen 1 stores no catch location – catches went to the inbox; a catch right after a wild battle now goes under the place the sign shows. Randomized: built ✓, place ✓, the plan didn't reach the starter (the randomizer's fast text moves Mom into the path). |
| **Silver** | ✅ | ✅ | ✅ | ✅ | – | Totodile L5, nickname read before and after naming; New Bark Town (bedroom, Elm's lab), Route 29; wild Rattata L4. **Real catch:** Pidgey L3 → "Route 29" through the place sign (Gold/Silver store no catch location), 6 of 6 runs. |
| **Crystal** | ✅ | ✅ | ✅ | ✅ | ✅ | As Silver; met location and level are read. **Real catch:** Sentret L2 (also Pidgey, Rattata), met location Route 29 → "Route 29". Randomized: Poliwag as the starter, wild Rattata L2 – all read. |
| **Ruby / Sapphire** | ✅ | ✅ | ✅ | ✅ | – | Torchic L5 (nickname, HP checked on the party screen), Littleroot Town, Route 101, wild Poochyena L2. The starter's met location is Route 101 – the same id the sign reads there. |
| **Emerald** | ✅ | ✅ | ✅ | ✅ | ✅ | As Ruby, wild Zigzagoon L2. **Real catch:** Poochyena L2 (also Wurmple) on Route 101 → "Route 101". Randomized: Weedle as the starter, all read. |
| **Pearl** | ✅ | ✅ | ✅ | ✅ | ⚠️ | Turtwig L5 21/21 from the briefcase at Lake Verity (met location Lake Verity), Twinleaf Town, Route 201, Verity Lakefront, Lake Verity, Sandgem Town (also inside the Mart); wild Starly L2 at the lake, Bidoof / Starly L3 on Route 201. **Real catch:** Bidoof L3 / Starly L3 → "Route 201", 2 of 2 runs. **Fixed (2.3.0):** the battle flag (checked live: 0x2101 / 0x2000) – battles stayed on the panel after running away. Randomized: built ✓, no live run. |
| **Platinum** | ✅ | ✅ | ✅ | ✅ | – | Turtwig L5 21/21 on Route 201 (met location Route 201), Barry's Chimchar L5 (trainer), Twinleaf Town, Route 201, Verity Lakefront, Lake Verity; wild Starly / Bidoof / Kricketot L3 on Route 201. **Fixed (2.3.0):** the battle flag (checked live: 0x2100 / 0x2800) – a wild battle showed up ~1100 frames late and stayed after running away. **Real catch:** Bidoof L3 (met location Route 201) → "Route 201" (balls thrown on the touch screen). |
| **Black** | ✅ | ✅ | ✅ | ✅ | ⚠️ | Tepig L5, met location Nuvema Town = the sign's place; zones: bedroom, downstairs, Nuvema Town, Route 1. Rival battles Snivy / Oshawott L5, wild Lillipup / Patrat on Route 1. **Real catch:** Lillipup → "Route 1", 2 of 2 runs. **Fixed (2.3.0):** the opponent's HP stayed at full (now 19 → 14 → 4 as on screen) and your Pokémon's HP during the fight; the battle flag (checked live: 0x2100 / 0x2800). Randomized: built ✓, the plan lost its way at the naming screen. |
| **Black 2** | ✅ | ✅ | ✅ | ✅ | – | Tepig L5 from Bianca at the Lookout (met location Aspertia City), Aspertia City, Aspertia Gate, Route 19; Hugh's Oshawott L5 (HP going down as on screen), wild Purrloin / Patrat L2. **Real catch:** Purrloin L2 → "Route 19". **Fixed (2.3.0):** Bianca's catching demo (an NPC's battle) showed as the player's trainer battle and stayed after it ended – the battle flag (checked live: 0x2100 / 0x2800). |
| **White 2** | ✅ | ✅ | ✅ | ✅ | – | As Black 2 (its position sits 0x40 further on); wild Patrat L2. **Real catch:** Patrat L2 → "Route 19". Its battle flag isn't checked yet (0x2100 in battle, but no fixed value outside): the catching demo still shows as a battle for a while. |

### ROM hacks

| Hack (base) | Party | Location | Battle | Notes |
|---|:---:|:---:|:---:|---|
| **Crystal Legacy 1.3.1** (Crystal) | ✅ | ✅ | ✅ | **Fixed:** the hack keeps its RAM 11 bytes further on – before, souldew read no team, no battle and a place stuck on New Bark Town. Now found from the ROM's code (all 7 addresses confirmed in the running game); maps and landmarks are Crystal's (357 maps compared). |
| **Emerald Kaizo** (Emerald) | ✅ | ✅ | ✅ | Torchic L5, Littleroot Town / Route 101, wild Zigzagoon L2; place names from the ROM. |
| **Light Platinum 1.0** (Ruby) | ✅ | ✅ | ✅ | **Fixed:** 141 species slots hold other Pokémon (Gen 4/5) – souldew showed the Ruby Pokémon of that number (Venipede as Weedle) or nothing. Now read from the ROM's species table; types from the ROM too (only Shaymin differs: its Sky Forme's Grass/Flying). Starter Charmander (also Squirtle/Bulbasaur checked), "Yellow Town", "Central City" (the hack's own region), wild Poochyena L2. No catch: the plan found no way out of Yellow Town. |
| **Renegade Platinum 1.3.0** (Platinum) | – | ⚠️ | – | Place names from the ROM (126, the hack's own). **Types (2.3.0):** 49 Pokémon with the hack's types, Fairy in the old "???" slot (Clefairy Fairy, Meganium Grass/Fairy, Altaria Dragon/Fairy …) – the board, the battle panel and the type rule use them, with Fairy's matchups. Not played live: its intro differs and the Platinum plan stops in the bedroom. |
| **Blaze Black 2 Redux 1.4.1** (Black 2) | ✅ | ✅ | ✅ | **Fixed:** no place sign (its place-name file is padded with empty entries). Now Aspertia City live; 153 names incl. the hack's new "Faraway Island". **Types (2.3.0):** 75 Pokémon with the hack's types (Fairy as type 17). Tepig L5 21/21 (the hack changed its stats), Aspertia City / Aspertia Gate / Route 19, Hugh's Oshawott L5 21 → 15, wild Venonat L5 / Patrat L4 with live HP. The hack's key bearer blocks the way to the Lookout until you talk to her. **Real catch:** Venonat / Patrat → "Route 19", 2 of 2 runs. |
| **Run & Bun 1.07** (Emerald) | ✅ | ✅ | ⚠️ | **New (2.3.0):** read live although it runs on an expanded engine: species by name (1233 in National Dex order, forms after them), the team searched for in RAM (0x02023A98), the place through SaveBlock1 and the ROM's own map table. Chimchar L5, Littleroot Town / Route 101, the wild (Galarian) Zigzagoon L2 with its HP. Your own Pokémon's HP during a battle is the pre-battle one (its battle structs moved), and the battle kind is a guess (several opponents = trainer). Before 2.3.0 it said "not supported". |
| **Unbound 2.1.1** (FireRed) | ❌ | ❌ | ❌ | **Not tested: no FireRed ROM was available** (the UPS patch needs FireRed 1.0, CRC32 DD88761C). As a CFRU hack it gets the same treatment as Run & Bun (species by name, the team searched for); if its team can't be found the play view says the hack isn't supported – unverified. |

### Not in the test set

Blue, Yellow, Gold, FireRed, LeafGreen, Diamond, HeartGold, SoulSilver, White and all non-English ROMs weren't part of this
round (HeartGold US, Definitive HeartGold and Silver were checked live before 2.2.1). FireRed/LeafGreen's place-name
table layout is read by a separate path that no ROM here could check.

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
- **Battle flags** checked in the running games (Platinum, Pearl, Black, Black 2) and used: battles start and end on
  time, an NPC's catching demo is no longer the player's battle.
- **Gen 5 battle HP** from the battle's own structs: the opponent's and your Pokémon's HP go down as on screen.
- **Types from hack ROMs** (Gen 3 base stats, Gen 4/5 personal data), Fairy matchups for hacks that add the type.
- **Run & Bun** is read live (expanded engine).

## Known gaps

- White 2's battle flag isn't checked (a demo battle lingers for a while); Gen 5 catching demos may show as a battle
  in White/White 2.
- Run & Bun: your own Pokémon's HP during a battle (its battle structs moved), the battle kind is a guess.
- Moves of hacks that retype them (Fairy moves in Renegade Platinum / Blaze Black 2 Redux) come from souldew's move
  data; the Pokémon's types come from the ROM.
- The input plans are timing-sensitive (inputs land a frame or two apart from run to run); the matrix script retries a
  game whose plan loses its way (`--attempts`). DS plans take 10–25 minutes each.
