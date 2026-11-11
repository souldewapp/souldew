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
| **Feuerrote / Blattgrüne** (German FireRed / LeafGreen, 2.3.1) | ✅ | ✅ | ✅ | ✅ | – | Recognised as `firered_eu` / `leafgreen_eu` (game code BPRD/BPGD, retail CRC). Charmander L5 18/18 "GLUMANDA" from Oak, filed as the starter (met location Pallet Town); the rival's Squirtle L5 as a trainer battle, HP live as on screen (Squirtle 19 → 11, Charmander 18 → 13 / 18 → 7); level-up to 6 read after the fight; wild Rattata L2/L3, Pidgey L4 on Route 1. Place sign: Pallet Town (Alabastia in German – the house, Oak's lab), Route 1. Battle flag (gMain.inBattle at 0x03003479, −0xB0) set in both battles and cleared after them; the English address stays 0. **Real catch:** Rattata → "Route 1", in both games. sCurrentMapMusic 0x03000FC0 holds the map header's music on every map (300 Pallet Town, 301 Oak's lab, 291 Route 1) and the battle music during a battle (297/298) – the turbo music reads the song. Badges aren't read live in any Gen 3 game, and FireRed/LeafGreen have no built-in level caps (as in English). **Fixed:** the Pokémon were read as unknown ones (the German species names) and the German place names came from the Fame Checker ("Arena Marmoria" on Route 1) – see below. |
| **Pearl** | ✅ | ✅ | ✅ | ✅ | ⚠️ | Turtwig L5 21/21 from the briefcase at Lake Verity (met location Lake Verity), Twinleaf Town, Route 201, Verity Lakefront, Lake Verity, Sandgem Town (also inside the Mart); wild Starly L2 at the lake, Bidoof / Starly L3 on Route 201. **Real catch:** Bidoof L3 / Starly L3 → "Route 201", 2 of 2 runs. **Fixed (2.3.0):** the battle flag (checked live: 0x2101 / 0x2000) – battles stayed on the panel after running away. Randomized: built ✓, no live run. |
| **Platinum** | ✅ | ✅ | ✅ | ✅ | – | Turtwig L5 21/21 on Route 201 (met location Route 201), Barry's Chimchar L5 (trainer), Twinleaf Town, Route 201, Verity Lakefront, Lake Verity; wild Starly / Bidoof / Kricketot L3 on Route 201. **Fixed (2.3.0):** the battle flag (checked live: 0x2100 / 0x2800) – a wild battle showed up ~1100 frames late and stayed after running away. **Real catch:** Bidoof L3 (met location Route 201) → "Route 201" (balls thrown on the touch screen). |
| **Black** | ✅ | ✅ | ✅ | ✅ | ⚠️ | Tepig L5, met location Nuvema Town = the sign's place; zones: bedroom, downstairs, Nuvema Town, Route 1. Rival battles Snivy / Oshawott L5, wild Lillipup / Patrat on Route 1. **Real catch:** Lillipup → "Route 1", 2 of 2 runs. **Fixed (2.3.0):** the opponent's HP stayed at full (now 19 → 14 → 4 as on screen) and your Pokémon's HP during the fight; the battle flag (checked live: 0x2100 / 0x2800). Randomized: built ✓, the plan lost its way at the naming screen. |
| **White** | ✅ | ✅ | ✅ | ✅ | – | Tepig L5 21/21 from the gift box, filed as the starter; no status condition and no held item, read as such (none came up to check other values); 0 badges → level cap 14 (the Striaton gym's ace). Place sign: Nuvema Town (also in the house and Juniper's lab), Route 1. Rival battles Snivy L5 19 → 14 → 0 HP and Oshawott L5 20 → 15 → 0 HP, Tepig 16/21 as on screen; wild Patrat L2–L4 / Lillipup L2–L3 on Route 1. **Real catch:** Patrat / Lillipup → "Route 1", 4 of 4 runs. **Fixed (2.3.1):** after Professor Juniper's catching demo (her Minccino L7 against a Patrat L2) its Patrat stayed on the panel as a trainer battle until the next real battle (~100 s in the test) – the battle flag (checked live: 0x2100 in battles and also in the demo, 0xF841 elsewhere) now ends it the moment the demo ends. While the demo runs it still shows as a battle (the game sets the battle value for it). Plan: [white.json](../scripts/rom-matrix/plans/white.json). |
| **Black 2** | ✅ | ✅ | ✅ | ✅ | – | Tepig L5 from Bianca at the Lookout (met location Aspertia City), Aspertia City, Aspertia Gate, Route 19; Hugh's Oshawott L5 (HP going down as on screen), wild Purrloin / Patrat L2. **Real catch:** Purrloin L2 → "Route 19". **Fixed (2.3.0):** Bianca's catching demo (an NPC's battle) showed as the player's trainer battle and stayed after it ended – the battle flag (checked live: 0x2100 / 0x2800). |
| **White 2** | ✅ | ✅ | ✅ | ✅ | – | As Black 2 (its position sits 0x40 further on); wild Patrat L2. **Real catch:** Patrat L2 → "Route 19". **Fixed (2.3.1):** the battle flag (checked live: 0x2100 in battles, 0xFAE3 elsewhere) – Bianca's catching demo showed as a battle against her Lillipup, and the summary screen (0x88C2, also in Black 2) did too. |

### ROM hacks

| Hack (base) | Party | Location | Battle | Notes |
|---|:---:|:---:|:---:|---|
| **Crystal Legacy 1.3.1** (Crystal) | ✅ | ✅ | ✅ | **Fixed:** the hack keeps its RAM 11 bytes further on – before, souldew read no team, no battle and a place stuck on New Bark Town. Now found from the ROM's code (all 7 addresses confirmed in the running game); maps and landmarks are Crystal's (357 maps compared). |
| **Emerald Kaizo** (Emerald) | ✅ | ✅ | ✅ | Torchic L5, Littleroot Town / Route 101, wild Zigzagoon L2; place names from the ROM. |
| **Light Platinum 1.0** (Ruby) | ✅ | ✅ | ✅ | **Fixed:** 141 species slots hold other Pokémon (Gen 4/5) – souldew showed the Ruby Pokémon of that number (Venipede as Weedle) or nothing. Now read from the ROM's species table; types from the ROM too (only Shaymin differs: its Sky Forme's Grass/Flying). Starter Charmander (also Squirtle/Bulbasaur checked), "Yellow Town", "Central City" (the hack's own region), wild Poochyena L2. No catch: the plan found no way out of Yellow Town. |
| **Renegade Platinum 1.3.0** (Platinum) | – | ⚠️ | – | Place names from the ROM (126, the hack's own). **Types (2.3.0):** 49 Pokémon with the hack's types, Fairy in the old "???" slot (Clefairy Fairy, Meganium Grass/Fairy, Altaria Dragon/Fairy …) – the board, the battle panel and the type rule use them, with Fairy's matchups. Not played live: its intro differs and the Platinum plan stops in the bedroom. |
| **Blaze Black 2 Redux 1.4.1** (Black 2) | ✅ | ✅ | ✅ | **Fixed:** no place sign (its place-name file is padded with empty entries). Now Aspertia City live; 153 names incl. the hack's new "Faraway Island". **Types (2.3.0):** 75 Pokémon with the hack's types (Fairy as type 17). Tepig L5 21/21 (the hack changed its stats), Aspertia City / Aspertia Gate / Route 19, Hugh's Oshawott L5 21 → 15, wild Venonat L5 / Patrat L4 with live HP. The hack's key bearer blocks the way to the Lookout until you talk to her. **Real catch:** Venonat / Patrat → "Route 19", 2 of 2 runs. |
| **Run & Bun 1.07** (Emerald) | ✅ | ✅ | ⚠️ | **New (2.3.0):** read live although it runs on an expanded engine: species by name (1233 in National Dex order, forms after them), the team searched for in RAM (0x02023A98), the place through SaveBlock1 and the ROM's own map table. Chimchar L5, Littleroot Town / Route 101, the wild (Galarian) Zigzagoon L2 with its HP. Before 2.3.0 it said "not supported". **Fixed (2.3.1, issue #3):** the starter and catches were never filed – Run & Bun keeps the IVs one bit further on, so bit 30 (the retail egg flag) is the top of the Sp. Def IV and about every second Pokémon read as an egg (the starter in the 2.3.0 round, too: "encounters: []"); the egg flag now comes from the header. The play view also gave up searching after ~30 s without a team – long before the starter. Now: Chimchar → "Starter", **real catch:** Zigzagoon L3 (met location Route 101) → "Route 101" (Poké Balls written into the bag, thrown by the game). 10 Pokémon whose names the game shortens to 10 letters (Corviknight → "Corvknight", Crabominable, Fletchinder …) are matched; the species picker offers everything up to #905 (the Sinnoh starters included). The title screen no longer shows "Petalburg City" (an empty SaveBlock1). **Fixed (2.3.1): battles.** The battle panel didn't know who was out: after a switch it kept the lead – its moves, its matchups and its HP, which didn't move while the other Pokémon took the hits (the team's own HP was live all along: measured, the party struct follows every hit) – a trainer's Pokémon was guessed as the first one standing, and a trainer with a single Pokémon (the rival's Mudkip) read as a wild battle. Now gBattleMons is searched for in RAM by the team's PIDs and OT IDs (pokeemerald-expansion's 0x5C-byte BattlePokemon; Run & Bun 0x020233FC, the address its code uses third most often, like gBattleMons in the base game) and says who is out on both sides; wild or trainer comes from the opponent's OT ID (a wild Pokémon carries the player's). Checked in the game: Birch's Zigzagoon (Chimchar 20 → 19), a wild Skitty with a switch to Poochyena (13 → 4 → 0, the panel follows the switch, also in the battle's party menu, which reorders the team), and the rival's Mudkip on Route 103 → trainer, Chimchar 23 → 11 → 0 as on screen. |
| **Radical Red 4.1** (FireRed) | ✅ | ✅ | ✅ | **Checked (issue #17)** with FireRed USA 1.0 (DD88761C) and the author's 4.1 patch (patch.radicalred.net → 4.1.ups, result FBA55DD8 – the library now recognises the pre-patched ROM by it). **Fixed – the team never showed:** (1) the Complete FireRed Upgrade keeps its own species table (1376 names from "?" on, with "Unown !" / "Unown ?") next to FireRed's 412 – souldew took the first, FireRed's, and read the hack as plain FireRed; now the longest table wins (`romspecies.mjs`); (2) its party structs are unencrypted, always Growth/Attacks/EVs/Misc, checksum 0 – read that way where the team sits at FireRed's own addresses (`parse.mjs`); (3) the team search looked only for a count byte right before the team (pokeemerald's layout) – FireRed's gPlayerPartyCount 0x02024029 / gPlayerParty 0x02024284 / gEnemyParty 0x0202402C are tried too. Now: the default intro ("play without custom options"), Pallet Town on the sign, Oak's lab, Charmander L5 19/19 live, the rival's Squirtle L5 → "Trainer" with its moves and both type charts (Fairy included). |
| **Unbound 2.1.1.1** (FireRed) | ⚠️ | – | ✅ | **Partly checked (issue #17):** FireRed USA 1.0 + the official patch (MediaFire link in the PokeCommunity first post → Pokemon Unbound Official.ups, a UPS – the catalog said BPS; result 4B3D4957, recognised pre-patched). Its species table is found (1294, from "??????" on); the intro runs, and no team or place shows during it (**fixed:** the intro's leftovers read as a fainted Bulbasaur at first – the unencrypted reading is now limited to FireRed's party addresses – and FireRed's place names showed: Unbound is in Borrius, the catalog says so and the sign stays empty while its own names can't be read). The starter wasn't reached (a long intro), so the team itself is unverified: same engine and addresses as Radical Red. |
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
| Zone tables of all four ROMs (X/Y: last file of `a/0/1/2`, ORAS: second-to-last of `a/0/1/3`, Sun/Moon/USUM: `a/0/7/7` file 0, LZ11) | ✅ every zone has a named place |
| **Ultra Sun live:** team | ✅ Rowlet ♂ L5 23/23 the moment Kukui hands it over |
| **Ultra Sun battle panel** | ✅ wild Yungoos ("Mangunior") L3 16/16 → HP as on screen, "wild"; Hau's Popplio L5 → "Trainer", Water vs Rowlet ×½; gone after both. **Fixed:** Gen 7 keeps the opponents after the player's 12 battlers (block 12+, 24 read now – the panel stayed empty), and the Stream Tool's trainer byte reads 1 in wild battles too on 1.0 – the battle type byte 0x33FC1F44 (found by souldew: 1 from the trainer's cutscene on, 0 for wild, also right after a trainer battle) |
| **Ultra Sun place sign** | ✅ "Route 1" (the house 36, outside 1, the grass 5 – all Route 1 in the ROM's table). The zone sits in the player's position { u16, u16 zone, float x, y, z } at 0x33F6D74A, found with a heap scan across house → outside → house; the same after a fresh start |
| Sun | ⚠️ team not seen (the save is before the starter); zone 0x34183CC6 found the same way (the house: zone 27, Route 1). The battle type byte 0x341C8CAC sits in the same structure as Ultra Sun's (compared outside battle byte for byte: the type, a pointer at +4, the same block at +0x28, in-battle at +0x21) – a Sun battle wasn't played |

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
`.github/workflows/ctr.yml` builds that core in libretro's MXE container (as Azahar's CI) and checks the exports; the
Windows workflow starts the host on `windows-latest`. A game on a real Windows PC is still to come. (Wine only hands
console programs Vulkan in a virtual desktop – a Wine detail, not one of Windows.) Without Vulkan (no graphics driver)
souldew opens the Azahar app instead.

Not checked: X/Alpha Sapphire/Moon/Ultra Moon (same code as their pairs).

### Not in the test set

Blue, Yellow, Gold, the English FireRed and LeafGreen, Diamond, HeartGold, SoulSilver and all non-English ROMs except
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

## What the checks found and what changed

- **Emerald place names** read from the ROM were shifted: the region-map table has an empty name in the middle, which
  ended the scan; the Kanto half was then read as sections 0… Empty names now count; team placeholders ("{AQUA}
  HIDEOUT") are filled in per game (Ruby: Magma).
- **Modified ROMs show their own place names**: a ROM whose CRC32 isn't a retail one (randomized, a hack) always shows
  the game's own names, also when its language differs from the app's – before, the app's table won then, which names
  another place in a hack. New catches are named the same way (Gen 5 catches got "#6" before).
- **GBA hacks with other Pokémon** (Light Platinum): species from the ROM's own name table, matched to the National Dex
  by name; a Pokémon only the hack has keeps the hack's name instead of a wrong one.
- **Expanded engines** (Run & Bun, Radical Red, Unbound, pokeemerald-expansion hacks) are recognised from the species
  table – a CFRU hack's own one wins over the FireRed table it keeps – and their team is searched for (FireRed's own
  addresses included, with CFRU's unencrypted structs); where nothing is found they say "not supported yet" – never the
  base game's Pokémon.
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

- White: Juniper's catching demo shows as a battle while it runs (the game sets the battle value for it); in the game's
  other languages (memory unchecked) it may also stay on the panel afterwards, as before 2.3.1.
- White: the address souldew had for "your Pokémon that is out" (battleActive, from NDS-Ironmon-Tracker) holds the wild
  opponent's PID instead (checked live) – it's only used when it is one of yours. Switching in a battle wasn't checked
  in White (one Pokémon in the test team).
- Run & Bun: double battles aren't read as such – the panel follows the left Pokémon of each side, and its partner once the left one is down; both at once aren't shown (no double battle in the test run, checked with a test only).
- Expanded-engine hacks (Run & Bun, Too Many Types …): the Rare Candy cheat is off (other item numbers).
- Hacks with types of their own (Too Many Types: 57 / 80 types, found from the ROM's type-name table) show no types,
  matchups or type rule for their Pokémon – souldew doesn't know them, and the official ones would be wrong (TMT2's
  Chimchar hits Froakie super-effectively with Scratch). The battle panel and the library say so.
- Too Many Types 1/2: only the start of each game was played (to the first catch); double battles weren't met.
- Moves of hacks that retype them (Fairy moves in Renegade Platinum / Blaze Black 2 Redux) come from souldew's move
  data; the Pokémon's types come from the ROM.
- The input plans are timing-sensitive (inputs land a frame or two apart from run to run); the matrix script retries a
  game whose plan loses its way (`--attempts`). DS plans take 10–25 minutes each.
