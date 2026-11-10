# Tested games

What souldew's live tracking was checked against, game by game: the team (species, nickname, level, HP, status), the
place sign ("You are here"), the battle panel and new catches – for retail games, randomized games and ROM hacks.
Back to the [README](../README.md).

**How it was checked (November 2026).** Every ROM was booted in souldew's own emulator page (the same `player.html`,
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
| **Red** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | Charmander L5 "AAAAAAAAAA", rival's Squirtle L5 (trainer), level-up to 6 read after the fight. Places are the town-map names (Oak's lab = Pallet Town). Gen 1 stores no catch location: new catches go to the inbox (as designed). Randomized: built ✓, place ✓, the plan didn't reach the starter (the randomizer's fast text moves Mom into the path). |
| **Silver** | ✅ | ✅ | ✅ | ⚠️ | – | Totodile L5, nickname read before and after naming; New Bark Town (bedroom, Elm's lab), Route 29; wild Rattata L4. Gold/Silver store no catch location (inbox). |
| **Crystal** | ✅ | ✅ | ✅ | ✅ | ✅ | As Silver; the starter's met location (New Bark Town) and met level are read. Randomized: Poliwag as the starter, wild Rattata L2 – all read. |
| **Ruby / Sapphire** | ✅ | ✅ | ✅ | ✅ | – | Torchic L5 (nickname, HP checked on the party screen), Littleroot Town, Route 101, wild Poochyena L2. The starter's met location is Route 101 – the same id the sign reads there, so a catch pairs with the sign's area. |
| **Emerald** | ✅ | ✅ | ✅ | ✅ | ✅ | As Ruby, wild Zigzagoon L2. **Fixed:** the place names read from the ROM started at the wrong table entry ("Pallet Town" for Littleroot). Randomized: Weedle as the starter, all read. |
| **Pearl** | ⚠️ | ✅ | – | – | ⚠️ | Twinleaf Town in the bedroom, downstairs and outside. The plan doesn't reach the starter yet; live, the party structure is exactly where the reader looks (capacity 6, count 0) – the decoding itself is the HeartGold one that was checked live earlier. Randomized: built ✓ (static checks), no live plan. |
| **Platinum** | ⚠️ | ✅ | – | – | – | As Pearl. |
| **Black** | ✅ | ✅ | ⚠️ | ✅ | ⚠️ | Tepig L5, its met location (Nuvema Town) = the sign's place; the zone reader (community address) gave the right zone in every check (bedroom, downstairs, outside). Rival battles: Snivy L5 / Oshawott L5 (trainer) right, **but the opponent's HP stays at full** (Gen 5 reads a copy of the opponent's party). **Fixed:** the opponent stayed on the panel ~2 min after the fight. Randomized: built ✓, the plan lost its way at the naming screen. |
| **Black 2 / White 2** | – | ✅ | – | – | – | Aspertia City (house, outside) in both. The plan doesn't reach the starter at the Lookout yet. |

### ROM hacks

| Hack (base) | Party | Location | Battle | Notes |
|---|:---:|:---:|:---:|---|
| **Crystal Legacy 1.3.1** (Crystal) | ✅ | ✅ | ✅ | **Fixed:** the hack keeps its RAM 11 bytes further on – before, souldew read no team, no battle and a place stuck on New Bark Town. Now found from the ROM's code (all 7 addresses confirmed in the running game); maps and landmarks are Crystal's (357 maps compared). |
| **Emerald Kaizo** (Emerald) | ✅ | ✅ | ✅ | Torchic L5, Littleroot Town / Route 101, wild Zigzagoon L2; place names from the ROM. |
| **Light Platinum 1.0** (Ruby) | ✅ | ✅ | ✅ | **Fixed:** 141 species slots hold other Pokémon (Gen 4/5) – souldew showed the Ruby Pokémon of that number (Venipede as Weedle) or nothing (Turtwig in an unused slot). Now read from the ROM's species table. Starter Charmander (also Squirtle/Bulbasaur checked), "Yellow Town", "Central City" (the hack's own region), wild Poochyena L2. |
| **Renegade Platinum 1.3.0** (Platinum) | – | ⚠️ | – | Place names from the ROM (126, the hack's own); same engine and party layout as Platinum. Not played live. |
| **Blaze Black 2 Redux 1.4.1** (Black 2) | – | ✅ | – | **Fixed:** no place sign (its place-name file is padded with empty entries). Now Aspertia City live; 153 names incl. the hack's new "Faraway Island". |
| **Run & Bun 1.07** (Emerald) | ⚠️ | ⚠️ | ⚠️ | Expanded engine (1233 species in national order, RAM moved – its save block pointer is at 0x03005D9C): the play view says live tracking doesn't support this hack yet instead of a team. Live, the base game's addresses read an empty party (the real starter was Chimchar) – nothing wrong was shown, but nothing right either. |
| **Unbound 2.1.1** (FireRed) | ❌ | ❌ | ❌ | **Not tested: no FireRed ROM was available** (the UPS patch needs FireRed 1.0, CRC32 DD88761C). Unbound is a CFRU hack like Radical Red: its species table should be recognised as an expanded engine and get the "not supported" state – unverified. |

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

## Known gaps

- Gen 5: the opponent's HP on the battle panel stays at full (species, level and kind are right).
- Gen 4/5 live plans stop before the starter (Platinum, Pearl: Twinleaf Town; Black 2/White 2: Aspertia City), so their
  team and battle readers were checked live only on HeartGold (earlier) and Black. A wild catch with a Poké Ball was not
  played in any game; catch filing was checked through the starter's met location against the sign's place id, and by
  the run-logic tests.
- Types of hacks that change them (Fairy type in Renegade Platinum / Blaze Black 2 Redux, Light Platinum's new
  Pokémon) come from souldew's Pokémon data, not from the ROM.
- The input plans are timing-sensitive (inputs land a frame or two apart from run to run); the matrix script retries a
  game whose plan loses its way (`--attempts`).
