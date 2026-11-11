# Live RAM reading of the player's party, Gen 1 to Gen 5

Researched 2026-10-17. The goal is to read the party (species, nickname, level, current/max HP, status, item, moves, identity, met data) straight from emulated RAM in JavaScript, the way Pokélink does.

**Confidence labels**
- **[sym]**: the address comes from a pret symbol file (`symbols` branch) or `.xMAP` linker map. The file and line are cited.
- **[src]**: the value comes from decomp source or PKHeX source.
- **[derived]**: computed from [sym]/[src] facts. The computation is shown.
- **[community]**: a third-party tool or script uses the value. It has not been checked against a decomp.
- **[inferred]**: reasoning without a direct primary source.

Machine-readable data is in `shared/data/`:

| File | Content |
|---|---|
| `addresses.json` | 22 game entries: how to match the ROM, party count/party address (or pointer chain), struct size, OT/nickname arrays, in-battle flag, live battle HP |
| `gen1_index_to_dex.json` | Gen 1 internal index (1–190) → National Dex, `null` = MissingNo. Generated from `pokered/data/pokemon/dex_order.asm` |
| `gen3_index_to_dex.json` | Gen 3 species id (1–411) → National Dex, 252–276 = `null`. Generated from `pokeemerald/src/pokemon.c` and checked against PKHeX `SpeciesConverter` for all 411 ids |
| `charset_gen1.json`, `charset_gen2.json`, `charset_gen3.json` | byte (hex string) → character. Includes European overrides where a source exists |
| `locations_gen3.json` | Gen 3 met-location id (MAPSEC) → EN/DE name |
| `locations_gen2_crystal.json` | Crystal caught-location landmark id → EN/DE name |

Generator scripts were run from the session scratchpad and are not part of the project. Re-running them needs the pret/PKHeX clones.

Sources: the pret repos `pokered`, `pokeyellow`, `pokegold`, `pokecrystal`, `pokeruby`, `pokeemerald`, `pokefirered` (branches `master` and `symbols`), `pokediamond`, `pokeplatinum` (`main` and `xmap`), `pokeheartgold` (`master` and `xmap`), and `kwsch/PKHeX` `master`. Raw URL pattern for symbol files: `https://raw.githubusercontent.com/pret/<repo>/symbols/<file>.sym`.

---

## 0. Detecting the game

| Platform | Where | What |
|---|---|---|
| GB/GBC | ROM `0x134..0x143` title; `0x13F..0x142` manufacturer code (GBC); `0x14C` mask ROM version | Red `POKEMON RED`, Blue `POKEMON BLUE`, Yellow `POKEMON YELLOW`, Gold `POKEMON_GLD`+`AAUE`, Silver `POKEMON_SLV`+`AAXE`, Crystal `PM_CRYSTAL`+`BYTE` (AU: `BYTU`), version 0 or 1 (1.1). Source: pret Makefiles (`rgbfix -t/-i/-n`): `pokered/Makefile:154-155`, `pokeyellow/Makefile:141`, `pokegold/Makefile:190-191`, `pokecrystal/Makefile:169-172`. [src] |
| GBA | ROM `0xAC` 4-char game code, `0xBC` software version (revision) | `AXVE` Ruby, `AXPE` Sapphire, `BPEE` Emerald, `BPRE` FireRed, `BPGE` LeafGreen. German: `AXVD`, `AXPD`, `BPED`, `BPRD`, `BPGD`. [src] Makefiles use `gbafix -c$(GAME_CODE) -r$(REVISION)` |
| NDS | Cartridge header copy in main RAM at `0x027FFE00` (main-RAM offset `0x3FFE00`): `+0x00` 12-byte title, `+0x0C` game code | **Verified.** `pokeplatinum/src/boot.c:22`: `(CARDRomHeader *)HW_ROM_HEADER_BUF; // 0x027FFE00`. NDS-Ironmon-Tracker reads the game code at main-RAM offset `0x3FFE00 + 0x0C` (`GameConfigurator.lua:155`). HeartGold ROM header bytes: `POKEMON HG\0\0IPKE` (read from the user's ROM). Titles: D `POKEMON D`, P `POKEMON P` (`pokediamond/config.mk:12,18`), Pt `POKEMON PL` (`pokeplatinum/platinum.us/rom_rev0.ini:3`). Codes: `ADAE`, `APAE`, `CPUE`, `IPKE`, `IPGE`, `IRBO`, `IRAO`, `IREO`, `IRDO` (Gen 5 English uses `O`). German: `…D` |

**Finding main RAM inside an emulator's heap (e.g. a WASM build):** search for the 16 bytes `"POKEMON HG\0\0IPKE"`. The match is at main-RAM offset `0x3FFE00`, so `mainRamBase = matchAddr - 0x3FFE00`. Check it by reading the same title at `mainRamBase + 0x3FFE00`. The 4 MiB main RAM is mirrored up to `0x02FFFFFF`, so `0x027FFE00 & 0x3FFFFF = 0x3FFE00`. For GBA, search the ROM copy for the game code at `0xAC`. The search does not give you EWRAM/IWRAM, though. Use the emulator's memory-domain API for those.

---

## 1. Gen 1: Red/Blue/Yellow (English) [sym]

DMG WRAM `0xC000–0xDFFF`, no banking. All multi-byte values are **big-endian**.

| Symbol | Red/Blue | Yellow | Source line (`pokered.sym` = `pokeblue.sym` / `pokeyellow.sym`) |
|---|---|---|---|
| wPartyCount (u8) | `0xD163` | `0xD162` | 18975 / 22201 |
| wPartySpecies (7 bytes, `0xFF`-terminated, internal index) | `0xD164` | `0xD163` | 18977 / 22203 |
| wPartyMons (6 × 44) | `0xD16B` | `0xD16A` | 18980 / 22206 |
| wPartyMonOT (6 × 11) | `0xD273` | `0xD272` | 19136 / 22362 |
| wPartyMonNicks (6 × 11) | `0xD2B5` | `0xD2B4` | 19143 / 22369 |
| wIsInBattle (0 none, 1 wild, 2 trainer, `0xFF` lost) | `0xD057` | `0xD056` | 18783 / 22006. Meanings from `pokered/ram/wram.asm:1236-1240` |
| wPlayerMonNumber (active party slot) | `0xCC2F` | `0xCC2F` | 18331 / 21544 |
| wBattleMonHP (live, BE u16) | `0xD015` | `0xD014` | 18758 / 21981 |

Red and Blue have identical addresses (asserted by the generator).

**Party struct, 44 bytes (`0x2C`)** (`pokered/macros/ram.asm:7-37`, `box_struct` + `party_struct`):

| Off | Size | Field |
|---|---|---|
| 0x00 | 1 | species (**internal index**, use `gen1_index_to_dex.json`) |
| 0x01 | 2 | current HP (BE) |
| 0x03 | 1 | "box level". Ignore it in the party, because it is only refreshed when the mon is deposited |
| 0x04 | 1 | status: bits 0–2 sleep counter, bit 3 PSN, 4 BRN, 5 FRZ, 6 PAR (`constants/battle_constants.asm`) |
| 0x05 / 0x06 | 1+1 | type 1 / type 2 |
| 0x07 | 1 | catch rate (becomes the held item when traded to Gen 2) |
| 0x08 | 4 | moves 1–4 (move ids) |
| 0x0C | 2 | OT ID (BE) |
| 0x0E | 3 | EXP (BE) |
| 0x11 | 10 | stat exp HP/Atk/Def/Spd/Spc (BE u16 each) |
| 0x1B | 2 | DVs: byte0 = Atk<<4 \| Def, byte1 = Spd<<4 \| Spc; HP DV = (Atk&1)<<3 \| (Def&1)<<2 \| (Spd&1)<<1 \| (Spc&1) |
| 0x1D | 4 | PP (bits 7–6 = PP Ups) |
| **0x21** | 1 | **level (party; use this one)** |
| 0x22 | 2 | max HP (BE) |
| 0x24 / 0x26 / 0x28 / 0x2A | 2 each | Atk / Def / Spd / Special |

Names: 11 bytes, `0x50`-terminated. OT `wPartyMonOT + 11*i`, nickname `wPartyMonNicks + 11*i`. Charset: `charset_gen1.json`.

**Identity:** Gen 1 has no PID. Use `(OT ID, DVs, OT name)`. All three survive evolution and nicknaming. Two wild mons with equal DVs and the same OT are possible but rare.

**Gen 1 internal index → dex:** `gen1_index_to_dex.json` has 190 entries. Example: 1 → 112 Rhydon, 0x15 → 151 Mew, 0x99 → 1 Bulbasaur. 39 entries are `null` (MissingNo.). 0xB6–0xB8 are the fossil/ghost sprites, which the decomp also maps to 0.

**Battle:** `wBattleMon` (`0xD014` R/B) is a separate copy. `MainInBattleLoop` copies HP and status from `wBattleMonHP` back into the party struct of `wPlayerMonNumber` at the start of every turn (`pokered/engine/battle/core.asm:280-281` → `ReadPlayerMonCurHPAndStatus`, `core.asm:1800`). It also copies on faint and switch (`core.asm:733, 1023`, `effects.asm:840, 882`). So the party struct lags by up to one turn. For live HP while `wIsInBattle != 0`, use `wBattleMonHP` for slot `wPlayerMonNumber`.

---

## 2. Gen 2: Gold/Silver/Crystal (English) [sym]

GBC WRAM. The party is in WRAMX **bank 1** (`01:` in the sym files). Gold/Silver never switch away from bank 1. Crystal does, so read the raw WRAM array: `offset = addr - 0xC000` in a 32 KiB CGB WRAM buffer (bank 1 = `0x1000–0x1FFF`). Don't read the CPU bus. All multi-byte values are big-endian.

| Symbol | Gold/Silver | Crystal (1.0 = 1.1 = AU) | Source line (`pokegold.sym` / `pokesilver.sym` / `pokecrystal.sym`) |
|---|---|---|---|
| wPartyCount | `0xDA22` | `0xDCD7` | 42524 / 42523 / 57314 |
| wPartySpecies (6 + `0xFF` end; egg = `0xFD`) | `0xDA23` | `0xDCD8` | 42526 / 42525 / 57316 |
| wPartyMons (6 × 48) | `0xDA2A` | `0xDCDF` | 42530 / 42529 / 57320 |
| wPartyMonOTs (6 × 11) | `0xDB4A` | `0xDDFF` | 42716 / 42715 / 57524 |
| wPartyMonNicknames (6 × 11) | `0xDB8C` | `0xDE41` | 42723 / 42722 / 57531 |
| wBattleMode (0 overworld, 1 wild, 2 trainer) | `0xD116` | `0xD22D` | 41528 / 41527 / 56026. Meanings from `pokecrystal/ram/wram.asm:2720-2724` |
| wCurBattleMon (active slot) | `0xCFC6` | `0xD0D4` | 41255 / 41254 / 55736 |
| wBattleMonHP (live, BE) | `0xCB1C` | `0xC63C` | 40695 / 40694 / 53552 |

`pokecrystal11.sym` and `pokecrystal_au.sym` give the same values. The generator asserts this.

**Party struct, 48 bytes (`0x30`)** (`pokecrystal/macros/ram.asm`; Gold/Silver are identical except caught data, which is unused there):

| Off | Size | Field |
|---|---|---|
| 0x00 | 1 | species = **National Dex number** (no table needed) |
| 0x01 | 1 | held item |
| 0x02 | 4 | moves |
| 0x06 | 2 | OT ID (BE) |
| 0x08 | 3 | EXP (BE) |
| 0x0B | 10 | stat exp |
| 0x15 | 2 | DVs (same packing as Gen 1; shiny = Def=10, Spd=10, Spc=10, Atk ∈ {2,3,6,7,10,11,14,15}) |
| 0x17 | 4 | PP |
| 0x1B | 1 | happiness (egg cycles while an egg) |
| 0x1C | 1 | Pokérus |
| 0x1D | 1 | **Crystal:** bits 7–6 time of day caught (1 morning, 2 day, 3 night), bits 5–0 caught level |
| 0x1E | 1 | **Crystal:** bit 7 OT gender (1 = female), bits 6–0 caught location = landmark id (`locations_gen2_crystal.json`; 0x7E gift, 0x7F event, 0 = not recorded) |
| 0x1F | 1 | level |
| 0x20 | 1 | status (same bits as Gen 1) |
| 0x21 | 1 | unused |
| 0x22 | 2 | current HP (BE) |
| 0x24 | 2 | max HP (BE) |
| 0x26..0x2F | 2 each | Atk, Def, Spd, SpAtk, SpDef |

The caught-data encoding comes from `pokecrystal/engine/pokemon/caught_data.asm:168-198` (`SetBoxmonOrEggmonCaughtData`). Time = `(wTimeOfDay+1)` rotated into bits 7–6. Masks are in `constants/pokemon_data_constants.asm:120-128`. Gold/Silver have `Unused1/Unused2` at 0x1D/0x1E (`pokegold/macros/ram.asm`).

**Identity:** `(OT ID, DVs, OT name)`, as in Gen 1.

**Battle:** `UpdateBattleMonInParty` (`pokecrystal/home/battle.asm:110`) copies level, status and HP from `wBattleMon` to the party. It is called at the start of each turn (`engine/battle/core.asm:176`) and after many move effects (13 `UpdateUserInParty`/`UpdateOpponentInParty` sites in `effect_commands.asm`). Plain damage (`DoPlayerDamage`, `effect_commands.asm:3438`) only writes `wBattleMonHP`. So the party lags until the next sync. For live HP use `wBattleMonHP` for slot `wCurBattleMon` while `wBattleMode != 0`.

### Gen 1/2 character encoding

- `charset_gen1.json` comes from `pokered/constants/charmap.asm` (the font.png section, English): `0x80–0x99` A–Z, `0x9A–0x9F` `():;[]`, `0xA0–0xB9` a–z, `0xBA` é, `0xBB–0xBF` 'd 'l 's 't 'v, `0xE0` ', `0xE1/E2` PK/MN, `0xE3` -, `0xE4/E5` 'r 'm, `0xE6` ?, `0xE7` !, `0xE8` ., `0xEF` ♂, `0xF0` ¥, `0xF1` ×, `0xF2` . (decimal), `0xF3` /, `0xF4` ,, `0xF5` ♀, `0xF6–0xFF` 0–9, `0x7F` space, **`0x50` terminator**.
- `charset_gen2.json` comes from `pokecrystal/constants/charmap.asm`. It is the same family, with these differences in English: `0xC0–0xC5` = Ä Ö Ü ä ö ü; the contractions moved to `0xD0–0xD6` ('d 'l 'm 'r 's 't 'v); é moved from `0xBA` to `0xEA`; `0xE9` = &; `0xDF` ←; `0xEB` →.
- **German:** there is no German pret disassembly for Gen 1/2. The JSON files carry overrides from PKHeX instead:
  - Gen 1 `variants.eu`, from `StringConverter1.TableEN`, one union table PKHeX uses for EN/FR/DE/IT/ES. `0xBA–0xD6` are accented letters and `0xC0–0xC5` are ÄÖÜäöü.
  - Gen 2 `variants.fr_de`, from `StringConverter2.TableFRE` ("Also German"). `0xBE` = ß, `0xBF` = ç, etc.

  PKHeX's `IsG12German` treats any byte `0xC0–0xC6` as proof of German text.

---

## 3. Gen 3: Ruby/Sapphire, Emerald, FireRed/LeafGreen [sym]

Absolute GBA bus addresses. EWRAM `0x02000000` (256 KiB), IWRAM `0x03000000` (32 KiB). Little-endian.

| Game (code) | gPlayerPartyCount (u8) | gPlayerParty (6 × 100) | gEnemyParty | gMain | Source (`.sym` line) |
|---|---|---|---|---|---|
| Ruby/Sapphire US rev 0/1/2 (`AXVE`/`AXPE`) | `0x03004350` **IWRAM** | `0x03004360` **IWRAM** | `0x030045C0` | `0x03001770` | `pokeruby.sym:613,614,616,526` (rev1/rev2 and Sapphire identical) |
| Rubin/Saphir **German** rev 0/1 (`AXVD`/`AXPD`) | `0x03004360` | `0x03004370` | `0x030045D0` | `0x03001770` | `pokeruby_de.sym:615,616,618,526` |
| Emerald (`BPEE`) | `0x020244E9` EWRAM | `0x020244EC` EWRAM | `0x02024744` | `0x030022C0` | `pokeemerald.sym:200,202,203,894` |
| FireRed/LeafGreen rev 0/1 (`BPRE`/`BPGE`) | `0x02024029` | `0x02024284` | `0x0202402C` | `0x030030F0` | `pokefirered.sym:158,161,160,745` (rev1 and LeafGreen identical) |
| FireRed/LeafGreen **German, French, Italian, Spanish** (`BPRD/F/I/S`, `BPGD/F/I/S`) | `0x02024029` | `0x02024284` | `0x0202402C` | `0x03003040` | no pret build – see below |

**Revisions:** Ruby/Sapphire rev 0, 1 and 2 have identical addresses for every symbol used here, and so do FRLG rev 0 and 1. The generator asserts this across all sym files. German R/S are shifted by +0x10. There are **no German Emerald/FRLG symbols**: the pokeemerald `multi-language` branch has only `rom_es/fr/it.sha1`, and pokefirered has no German build. Use the scan fallback below for those.

**Other-language FireRed/LeafGreen** (`firered_eu` / `leafgreen_eu`, souldew 2.3.1): two trackers that run on those ROMs
list the same layout – EWRAM exactly as in the English game, IWRAM from `gMain` on `0xB0` lower:
- pokebot-gen3 `modules/data/symbols/patches/language/pokefirered.yml` / `pokeleafgreen.yml` override, for D/F/I/S, only
  IWRAM symbols: `gMain` `0x03003040`, `gSaveBlock1Ptr` `0x03004F58`, `gSaveBlock2Ptr` `0x03004F5C`,
  `gPokemonStoragePtr` `0x03004F60`, `gBattleMainFunc`, `gTasks`, `gBattleResults`, `gRngValue` (all −0xB0). `gPlayerParty`,
  `gPlayerPartyCount`, `gEnemyParty`, `gBattleTypeFlags`, `gBattleMons`, `gBattlerPartyIndexes`, `gMapHeader` only get a
  Japanese override – the European ROMs use the base `.sym` address.
- Ironmon-Tracker `GameAddresses/Pokemon Feuerrote|Rouge Feu|Rosso Fuoco|Rojo Fuego.json`: `pstats` `0x02024284`,
  `estats` `0x0202402C`, `gPlayerPartyCount` `0x02024029`, `gBattleMons` `0x02023BE4`, `gBattlerPartyIndexes`
  `0x02023BCE`, `gBattleTypeFlags` `0x02022B4C`, `gMapHeader` `0x02036DFC` (= English), `gSaveBlock1ptr` `0x03004F58`
  (−0xB0); `sSaveDialogDelay` `0x03000FA8` unchanged. `GameSettings.lua`: "IWRAM addresses are the same between all
  english versions of a game, and between all non-english versions"; all four have software version 0.

So in battle = `0x03003479 & 0x02`. `sCurrentMapMusic` (`0x03000FC0`) is in neither table; it is kept (it sits
0x18 after the unchanged `sSaveDialogDelay`) – a wrong value would only make the turbo music fall back to the map's
song. **Checked in the running German FireRed and LeafGreen (2.3.1 ROM matrix,
`scripts/rom-matrix/plans/firered-leafgreen-eu.json`):** the party (Charmander L5 from Oak, the Rattata caught on Route 1
with met location Route 1), gBattleMons HP of both sides going down as on screen, `0x03003479 & 0x02` set in the rival
and the wild battle and clear before and after (the English address stays 0), gBattleTypeFlags 0x1C (rival) / 0x04
(wild), gMapHeader sections 88 (Pallet Town) / 101 (Route 1), gSaveBlock1Ptr 0x03004F58 (the player's position and
the bag – the cheat's balls arrived), and `sCurrentMapMusic` 0x03000FC0 = the map header's music (`gMapHeader + 0x10`:
300 Pallet Town, 301 Oak's lab, 291 Route 1; the battle's song in a battle). The ROMs' literal pools agree: gMain
0x03003040 is loaded 581 times, gSaveBlock1Ptr 0x03004F58 452 times, 0x03000FC0 11 times.

The German ROMs need two things beside the addresses (fixed in 2.3.1): the species table read from the ROM has German
names (matched in all five languages now, else 275 Pokémon count as a hack's own), and FireRed/LeafGreen's place-name
pointer table isn't the longest table of short capitals names there – the Fame Checker's is (see `gen3Names`).

**In battle:** `gMain.inBattle` is bit 1 of the byte at `gMain + 0x439` (E/FRLG) or `gMain + 0x43D` (R/S) (`include/main.h` `struct Main`: `/*0x439*/ u8 oamLoadDisabled:1; u8 inBattle:1;`). That gives:
- Emerald `0x030026F9 & 0x02`
- FRLG `0x03003529 & 0x02`
- R/S (US and DE) `0x03001BAD & 0x02`

`gBattleTypeFlags` is not a reliable "in battle" flag, because its value can linger after the battle.

**Live battle HP:** `gBattleMons[4]` (0x58 bytes each, `struct BattlePokemon` in `include/pokemon.h:260-295`): `.hp` at +0x28, `.maxHP` at +0x2C. `gBattlerPartyIndexes` (u16[4]) maps a battler to its party slot; the player is battler 0 (and 2 in doubles). Addresses: E `0x02024084`/`0x0202406E`, FRLG `0x02023BE4`/`0x02023BCE`, R/S `0x02024A80`/`0x02024A6A`. **The party struct HP is updated live as well:** `Cmd_datahpupdate` sends `REQUEST_HP_BATTLE` (`pokeemerald/src/battle_script_commands.c:1974`), and the player controller writes it into `gPlayerParty` (`battle_controller_player.c:2108-2109`). So for Gen 3 you can read only the party.

### 3.1 Party struct (100 bytes) — `pokeemerald/include/pokemon.h:196-232`

| Off | Size | Field |
|---|---|---|
| 0x00 | u32 | personality (PID) |
| 0x04 | u32 | OT ID (low u16 = TID, high u16 = SID) |
| 0x08 | 10 | nickname (Gen 3 charset, `0xFF`-terminated if shorter) |
| 0x12 | u8 | language (1 JP, 2 EN, 3 FR, 4 IT, 5 DE, 7 ES; `include/constants/global.h:20-26`) |
| 0x13 | u8 | bit0 isBadEgg, bit1 hasSpecies, bit2 isEgg, bit3 blockBoxRS |
| 0x14 | 7 | OT name |
| 0x1B | u8 | markings |
| 0x1C | u16 | checksum = sum of the 24 decrypted u16 words of 0x20..0x4F |
| 0x1E | u16 | unknown/padding |
| 0x20 | 48 | 4 × 12-byte substructures, **encrypted** |
| 0x50 | u32 | status (bits 0–2 sleep, 3 PSN, 4 BRN, 5 FRZ, 6 PAR, 7 TOX; `include/constants/battle.h:115-121`) |
| 0x54 | u8 | **level** |
| 0x55 | u8 | mail id |
| 0x56 | u16 | **current HP** |
| 0x58 | u16 | **max HP** |
| 0x5A..0x62 | u16 each | Atk, Def, Spe, SpA, SpD |

The party stats at 0x50+ are **not** encrypted in Gen 3. A slot with `PID == 0 && OTID == 0` is empty, and so is one where flag bit1 (hasSpecies) is clear.

**Decryption** (`pokemon.c:3536-3554`): `key = PID ^ OTID`. XOR each of the 12 u32 words at 0x20..0x4F with `key`. Then validate the checksum.

**Substructure order** = `PID % 24` (`pokemon.c:3603-3633`, `SUBSTRUCT_CASE(n, posG, posA, posE, posM)`). G = Growth, A = Attacks, E = EVs/Condition, M = Misc. The "@" column gives each substruct's byte offset inside the 48-byte block.

| PID%24 | Order | Offsets |
|---|---|---|
| 0 | GAEM | G@0 A@12 E@24 M@36 |
| 1 | GAME | G@0 A@12 E@36 M@24 |
| 2 | GEAM | G@0 A@24 E@12 M@36 |
| 3 | GEMA | G@0 A@36 E@12 M@24 |
| 4 | GMAE | G@0 A@24 E@36 M@12 |
| 5 | GMEA | G@0 A@36 E@24 M@12 |
| 6 | AGEM | G@12 A@0 E@24 M@36 |
| 7 | AGME | G@12 A@0 E@36 M@24 |
| 8 | AEGM | G@24 A@0 E@12 M@36 |
| 9 | AEMG | G@36 A@0 E@12 M@24 |
| 10 | AMGE | G@24 A@0 E@36 M@12 |
| 11 | AMEG | G@36 A@0 E@24 M@12 |
| 12 | EGAM | G@12 A@24 E@0 M@36 |
| 13 | EGMA | G@12 A@36 E@0 M@24 |
| 14 | EAGM | G@24 A@12 E@0 M@36 |
| 15 | EAMG | G@36 A@12 E@0 M@24 |
| 16 | EMGA | G@24 A@36 E@0 M@12 |
| 17 | EMAG | G@36 A@24 E@0 M@12 |
| 18 | MGAE | G@12 A@24 E@36 M@0 |
| 19 | MGEA | G@12 A@36 E@24 M@0 |
| 20 | MAGE | G@24 A@12 E@36 M@0 |
| 21 | MAEG | G@36 A@12 E@24 M@0 |
| 22 | MEGA | G@24 A@36 E@12 M@0 |
| 23 | MEAG | G@36 A@24 E@12 M@0 |

This is the same table as PKHeX `PokeCrypto.BlockPosition` rows 0–23.

**Substructure fields** (`include/pokemon.h:99-176`):
- **G (Growth):** +0 species u16 (**internal id**, use `gen3_index_to_dex.json`; 412 = egg), +2 held item u16, +4 EXP u32, +8 PP bonuses, +9 friendship, +10 u16 filler.
- **A (Attacks):** +0 moves u16[4], +8 PP u8[4].
- **E (EVs):** +0..5 HP/Atk/Def/Spe/SpA/SpD EVs, +6..11 cool/beauty/cute/smart/tough/sheen.
- **M (Misc):** +0 Pokérus, **+1 met location** (MAPSEC id, `locations_gen3.json`; `0xFD` egg, `0xFE` in-game trade, `0xFF` fateful encounter; `src/data/region_map/region_map_sections.constants.json.txt:14-16`), **+2 u16: bits 0–6 met level (0 = hatched), 7–10 origin game (1 S, 2 R, 3 E, 4 FR, 5 LG, 15 GameCube), 11–14 ball, 15 OT gender**, +4 u32: IVs 5 bits each (HP, Atk, Def, Spe, SpA, SpD), bit 30 isEgg, bit 31 ability slot, +8 u32 ribbons, bit 31 = fateful (modern).

**Identity:** `(PID, OTID)` as two u32.

### 3.2 Gen 3 charset

`charset_gen3.json` comes from `pokeemerald/charmap.txt`, the part before the Japanese section. This international table is shared by EN/FR/DE/IT/ES (PKHeX `StringConverter3` uses `G3_EN` for every non-Japanese language):
- `0x00` space
- `0xA1–0xAA` 0–9
- `0xAB` ! `0xAC` ? `0xAD` . `0xAE` -
- `0xB0` … `0xB1`/`0xB2` “ ” `0xB3`/`0xB4` ‘ '
- `0xB5` ♂ `0xB6` ♀ `0xB8` , `0xBA` /
- `0xBB–0xD4` A–Z, `0xD5–0xEE` a–z
- `0xF1–0xF6` ÄÖÜäöü, `0x01–0x29` accented letters
- **`0xFF` terminator**

### 3.3 German Emerald/FRLG and other unknown builds: scan fallback

Scan EWRAM (and IWRAM) for 100-byte-aligned runs of structs that pass these checks:
1. `PID != 0`.
2. After XOR, the checksum matches.
3. `1 <= species <= 411`, or 412 for an egg.
4. `1 <= level <= 100`.
5. `hp <= maxHP`.

During battle `gEnemyParty` also passes. Tell the two apart by OT ID: the player's party has the player's TID/SID (for example, take the OTID shared by most slots). In FRLG the enemy party sits directly before the player party, and in Emerald directly after it.

---

## 4. Gen 4/5: DS. The party lives in the heap-allocated save buffer

On DS the party is the `Party` section of `SaveData`, which is allocated on the heap at boot. A **static pointer** to `SaveData` exists in `.bss`, so a single dereference finds it.

`PartyCore` / `Party` (`pokeplatinum/include/party.h:11-15`, `pokeheartgold/include/pokemon_types_def.h:284`): `{ int capacity /* = 6 */; int currentCount; Pokemon mons[6]; }`. Mons are 236 bytes (PK4) or 220 bytes (PK5) and are **encrypted in RAM**.

### 4.1 Pointer chains (USA)

The chain is `party = read_u32(saveDataPtrAddr) + monsOffset`. `count = read_u32(saveDataPtr) + monsOffset - 4`, `capacity` is at −8.

| Game | saveDataPtrAddr | monsOffset | How it was verified |
|---|---|---|---|
| HeartGold/SoulSilver `IPKE`/`IPGE` | `0x02111880` | `0xA8` | [sym] `heartgoldus.xMAP:57882` and `soulsilverus.xMAP:57882`: `02111868 0000001C .bss _02111868 (src_main.c.o)`. The struct (`src/main.c:30-40`, `include/main.h:7-11`) is `{mainOverlayId; overlayManager; queuedMainOverlayId; queuedMainOverlayTemplate; {unk_00; unk_04; SaveData *saveData}}`, so saveData is at +0x18. `SaveData.dynamic_region` is at +0x10 (`include/save.h:65-70`), and PKHeX `SAV4HGSS.cs:71` puts Party at `0x98`: 0x10 + 0x98 = **0xA8**. ROM check: the arm9 word at `0x02000BA8` in the user's HeartGold ROM is `0x02111860` (NitroSDK module params; `0x02000BBC` holds the magic `0xDEC00621`), and NDS-Ironmon-Tracker uses `*(0x02000BA8)+0x20` = `0x02111880` with `playerBase = 0xA8`. |
| Platinum `CPUE` (rev 0 and 1) | `0x02101D40` | `0xB4` | [sym] `platinumus.xMAP:68182`: `02101D28 0000001C .bss sApplication`. `Application` (`src/main.c:41-47`) has `args.saveData` at +0x18. `SaveData.body` is at +0x14 (`include/savedata.h:49-55`) and PKHeX `SAV4Pt.cs:63` gives Party `0xA0`: 0x14 + 0xA0 = **0xB4**. Ironmon `playerBase = 0xB4` matches. Rev 0/1 differ only in GTS overlay code (`#if POKEPLATINUM_REVISION` appears only in `src/gts_application/screens/search_listing.c`), so the arm9 `.bss` is the same. [inferred] |
| Diamond/Pearl `ADAE`/`APAE` | `0x02106FC0` | `0x2AC` | [inferred] No DP xMAP exists. `pokediamond/include/main.h:74-82` has the same struct layout (`SaveData *save` at +0x18), and `SaveData.dynamic_region` is at +0x214 (`include/save.h:61-68`). With PKHeX `SAV4DP.cs:59` Party `0x98`, that gives 0x214 + 0x98 = **0x2AC**, which equals Ironmon's `playerBase`. The struct address `0x02106FA8` is inferred from MKDasher's pointer `0x02106FAC` (= struct + 4, the same field as Pt/HGSS) and from Ironmon's `*(0x02000B70)+0x20`. |
| Black/White `IRBO`/`IRAO` | static: mons at `0x022349B4` (B) / `0x022349D4` (W), count at −4 | — | [community] NDS-Ironmon-Tracker `MemoryAddresses.lua` (BLACK `playerBase = 0x2349B4`, WHITE +0x20). Action Replay "replace party slot 1" codes also write a PKM at `0x022349B4`. Count at −4 follows the PKHeX `SAV5.cs:75` layout (`Party+4` = count, mons at `Party+8`). |
| Black 2/White 2 `IREO`/`IRDO` | `read_u32(0x02000024) & 0xFFFFFF` + `0x19728` | `0x19728` | [community] NDS-Ironmon-Tracker (`MAIN_POINTER = 0x24`, `playerBase = 0x19728`). The same file has older static values in comments: B2 `0x0221E42C`, W2 `0x0221E4AC`. |

**MKDasher's "legacy" pointers (DP `0x02106FAC`, Pt `0x02101D2C`, HGSS `0x0211186C`)** are the **`overlayManager` / `currApplication`** field of the same struct, not the save pointer. The often-quoted offsets still work in the overworld, because the field app's manager is allocated a fixed distance before SaveData. The offsets are: HGSS party = ptr + `0xD088` (MKDasher, tasvideos.org/Forum/Topics/9485, 2014-01-06: "Party's pokemon PID: pointer + 0xD088 + 0xEC*(slot-1)"), Pt TID = ptr + `0xD06C`, DP TID = ptr + `0xD288` (TASVideos user file 45747701013813013, `pearl_plat_rng` lua). Deriving through the PKHeX Trainer1→Party distance gives Pt party = ptr + `0xD094` and DP party = ptr + `0xD2AC`. In both Pt and HGSS this implies SaveData = overlayManager + `0xCFE0`. **Prefer the saveData pointer.** It is set once at boot and does not depend on which app is running.

**German/other DS releases:** no symbols. Ironmon's `*(moduleParams)+0x20` trick probably carries over, because it relies only on `main.c` being first in `.bss`, but that is untested. Use the scan below.

### 4.2 Robust alternative: scan main RAM for PartyCore

For each 4-byte-aligned offset `o` in the 4 MiB dump:
1. `u32[o] == 6` and `1 <= u32[o+4] <= 6`.
2. For each slot `i < count`, at `p = o + 8 + i*SIZE` (SIZE = 236 for Gen 4, 220 for Gen 5):
   - PID = `u32[p]`; the `u16[p+4]` flags must have bits 0–2 = 0. These are `partyDecrypted`, `boxDecrypted` and `checksumFailed` (`pokeplatinum/include/struct_defs/pokemon.h:122-124`). A set decrypted bit means the game is in the middle of an access; retry on the next frame.
   - Decrypt bytes `0x08..0x87` with the LCRNG seeded by checksum `u16[p+6]`: `seed = seed*0x41C64E6D + 0x6073`, XOR each u16 with `seed>>16`.
   - The sum of the 64 decrypted u16 must equal the checksum. Unshuffle with `sv = ((PID>>13)&31) % 24`.
   - Decrypt the party stats `0x88..SIZE-1` with the same LCRNG seeded by **PID**.
   - Check `1 <= species <= 493` (Gen 4) or `649` (Gen 5), `1 <= level(0x8C) <= 100`, and `hp(0x8E) <= maxHP(0x90)`.

   Sources: PKHeX `PokeCrypto.Decrypt45` (`PKM/Util/PokeCrypto.cs:166-178`, `CryptArray` at 327) and the Gen 4 checksum in `G4PKM.cs:41`. The full JS decrypt is already in `research/gen4_formats.md` §2.1.
3. Slots `>= count` are not validated. `Party_InitWithCapacity` fills them with `Pokemon_Init`, which encrypts an all-zero struct (`pokeplatinum/src/party.c:35-47`, `src/pokemon.c:292-297`).

**Multiple hits are expected.** During battle there are **three** valid copies: the save copy, `dto->parties[0]` (copied at battle start), and `battleSys->parties[0]`, the live battle copy. Freed heap blocks also keep **stale copies** after the battle ends. Rules:
- (a) If a pointer chain from 4.1 lands on a hit, that hit is the canonical party.
- (b) Otherwise, the canonical party is the hit inside the SaveData allocation. On a first scan in the overworld, pick the hit that persists. Cache its offset; it does not move while the game runs.

### 4.3 PK4 vs PK5 (PKHeX `PK4.cs`, `G4PKM.cs`, `PK5.cs`, `PokeCrypto.cs`)

| | PK4 (DPPt/HGSS) | PK5 (BW/B2W2) |
|---|---|---|
| Party size | 236 = 136 + 100 | **220** = 136 + 84 (`SIZE_5PARTY`) |
| Header | 0x00 PID, 0x04 flags, 0x06 checksum | identical |
| Encryption, shuffle, checksum | LCRNG(checksum) over 0x08–0x87, `sv=((PID>>13)&31)%24`, party stats LCRNG(PID) | **identical** (`Decrypt45` handles both) |
| Species / item / OT ID / EXP | 0x08 u16 (National Dex) / 0x0A / 0x0C (TID) 0x0E (SID) / 0x10 | identical (species up to 649) |
| Ability / language | 0x15 / 0x17 | identical |
| Moves / PP | 0x28 u16[4] / 0x30 u8[4] | identical |
| IVs / egg / nicknamed flags | 0x38 u32 (bits 30/31) | identical |
| 0x40 | fateful bit 0, gender bits 1–2, form bits 3–7 | identical |
| **Nature** | **PID % 25** (0x41 = HGSS Shiny Leaf) | **explicit byte 0x41** (`PK5.cs:194`) |
| 0x42 | unused | hidden-ability flag bit 0, N's Sparkle bit 1 |
| 0x44 / 0x46 | Pt/HGSS egg / **met location** (u16, "extended") | unused (cleared in `PK4.ConvertToPK5`, `PK4.cs:348`) |
| Nickname / OT | 0x48 (11 × u16, Gen 4 table, `0xFFFF` end) / 0x68 | 0x48 / 0x68, **UTF-16LE** |
| Met date / egg date | 0x7B–0x7D / 0x78–0x7A | identical |
| **Met location** | 0x80 (DP field). Rule: use 0x46 if it is non-zero, else 0x80 (`G4PKM.cs:229-237`) | **0x80 u16 only**, egg 0x7E |
| Ball | 0x83 (DPPt) + 0x86 (HGSS) | 0x83 |
| Met level / OT gender | 0x84 bits 0–6 / bit 7 | identical |
| Status / level / HP / max HP | 0x88 u32 (bits: sleep turns 0–2, PSN, BRN, FRZ, PAR, TOX) / 0x8C / 0x8E / 0x90 | same offsets, but the status is a **number**: 1 PAR, 2 SLP, 3 FRZ, 4 BRN, 5 PSN (PKHeX `StatusType`; checked in Black 2's party screen 2026-11-11) |
| Stats | 0x92–0x9A | identical |

Gen 4/5 identity: `(PID, OT ID u32)`.

### 4.4 In battle / live HP (DS)

- **The save-buffer party is NOT updated during battle.** It is overwritten once at the end, by `FieldBattleDTO_UpdateFieldSystem` → `Party_Copy(dto->parties[BATTLER_PLAYER_1], party)` (`pokeplatinum/src/field_battle_data_transfer.c:415-424`). Before that, `battle_main.c:703-704` copies `battleSys->parties` into the DTO.
- The battle copy `battleSys->parties[0]` is updated during battle by `BattleMon_CopyToParty` (`pokeplatinum/src/battle/battle_lib.c:1819`, 14 call sites) and by the HP/status write in `battle_io_command.c:594-595`. For live HP, read that copy:
  - Gen 4, mons at `saveDataPtr + 0x4EA98` (HGSS) / `+0x4B8AC` (Pt) / `+0x4C7D8` (DP)
  - BW static `0x0226A794` (B) / `+0x20` (W)
  - B2W2 `ptr + 0x53610`

  All of these are [community] values from NDS-Ironmon-Tracker `playerBattleBase`. Ironmon checks that the first PID equals the save party's first PID before trusting them (`BattleHandlerGen4.lua:93-99`). The PartyCore scan also finds this copy: it is the hit whose PIDs equal the canonical party and whose HP changes.
- **In-battle flag** [community]: Ironmon reads a u16 at a fixed address and treats `0x2100`/`0x2101` as "in battle" and `0x2800` as "not" (`BattleHandlerBase.lua:5-9, 376`). Addresses: HGSS `0x02246F48`, Pt `0x0224A55A`, DP `0x0223BB38`, B `0x021D0798`, W `0x021D07B8`, B2 `0x021B5138`, W2 `0x021B5178`. These lie in heap/overlay space and were not checked against a decomp. As a safer heuristic, check whether a second valid PartyCore with the same PIDs exists **and** changed in the last few seconds.

---

## 5. Summary: is the party HP live during battle?

| Gen | Party struct during battle | Live HP source |
|---|---|---|
| 1 | synced once per turn (start of `MainInBattleLoop`) and on faint/switch | `wBattleMonHP` for slot `wPlayerMonNumber` |
| 2 | synced at turn start and after many effects, not on plain damage | `wBattleMonHP` for slot `wCurBattleMon` |
| 3 | **live** (`datahpupdate` → `REQUEST_HP_BATTLE` → `gPlayerParty`) | `gPlayerParty` itself, or `gBattleMons[0].hp` |
| 4/5 | **frozen** until the battle ends (separate party copies) | `battleSys->parties[0]` (pointer offsets above, or the scan) |

## 6. Uncertainties

1. **DS pointers were not tested at runtime.** The HGSS/Pt `saveDataPtrAddr` values come from the decomp xMAPs, and the HGSS module-param word was checked in the user's ROM. The `monsOffset` values come from PKHeX save offsets plus the decomp `SaveData` header size, and they match NDS-Ironmon-Tracker exactly. The DP address is inferred.
2. **Gen 5 has no decomp or symbols.** BW/B2W2 addresses, the B2W2 `0x02000024` pointer and all Gen 4/5 in-battle u16 flags come only from NDS-Ironmon-Tracker and cheat codes. Prefer the PartyCore scan for Gen 5. Gen 5 PartyCore's first u32 (capacity) is not verified to be 6, so don't require it; require only the count plus valid checksums.
3. **German releases:** symbols exist only for Ruby/Sapphire DE (`+0x10` vs US). Gen 1/2 DE, Emerald/FRLG DE and all DS DE builds need the scan fallbacks. For GB the signature is reliable: `count (1..6)`, `count` species bytes, `0xFF`, then `struct[0].species == species[0]` at `countAddr + 8` (`wPartyMons = wPartyCount + 8` holds in all five US builds; the generator asserts it). For Gen 2 eggs the list holds `0xFD`.
4. **German Gen 1/2 charset:** the override tables come from PKHeX's union tables, not a disassembly. Gen 1 `0xBA–0xBF` (English contractions vs. accented letters) differ by language.
5. **Torn reads:** read RAM between frames (after the emulator's frame callback). Gen 3/4 decrypt the struct in place only inside a single function call, so a between-frame read is consistent. Mid-frame reads can catch a decrypted or half-updated struct, which fails the checksum. Retry on the next frame.
6. **Gen 1 box level (0x03)** is stale in the party. Always use 0x21.

---

## 7. The bag: writing Rare Candies (`shared/live/cheats.mjs`)

Researched 2026-11-06 for the Rare Candy cheat. **Why RAM:** Action Replay / GameShark codes exist per version and
region and differ in what the cores of this EmulatorJS build accept; UPR has no "start with items" option and
plain-patch runs don't go through the randomizer at all. The bag sits at known places in RAM (below), the
randomizer doesn't move it, and the write can be checked first. Every write is refused unless the whole region
looks like a bag (counts, terminators, ids and quantities in range, plus the neighbouring money / key item /
TM / Poké Ball data), and read back afterwards.

**Rare Candy item id:** Gen 1 `0x28` (pokered `constants/item_constants.asm`), Gen 2 `0x20` (pokecrystal/pokegold),
Gen 3 `68` (pokeruby/pokefirered `#define ITEM_RARE_CANDY 68`, pokeemerald enum position 68), Gen 4/5 `50`
(pokeheartgold `include/constants/items.h`, pokeplatinum `generated/items.txt`). PokeAPI
`/item/rare-candy` `game_indices` gives the same five values. [src]

| Game | Where | Layout | Source |
|---|---|---|---|
| Red/Blue | `wNumBagItems` `0xD31D`, money `0xD347` | count, (id, qty) × n, `0xFF`; 20 slots, 99 per slot | [sym] `pokered.sym`; `BAG_ITEM_CAPACITY` (`constants/menu_constants.asm`), 99 in `engine/items/inventory.asm` |
| Yellow | `0xD31C`, money `0xD346` | same | [sym] `pokeyellow.sym` |
| Gold/Silver | `wNumItems` `0xD5B7`, `wNumKeyItems` `0xD5E1` | same; key items: count, ids, `0xFF` (max 25) | [sym] `pokegold.sym`; `MAX_ITEMS`, `MAX_ITEM_STACK`, `MAX_KEY_ITEMS` |
| Crystal | `0xD892`, key items `0xD8BC` | same | [sym] `pokecrystal.sym` |
| Ruby/Sapphire (US, DE) | `gSaveBlock1` `0x02025734` + `0x560` (20 slots), balls `+0x600`, money `+0x490` | { u16 id, u16 qty }, plain | [sym] `pokeruby.sym`, `pokeruby_de.sym`; `include/global.h`, `constants/global.h` |
| Emerald | `*gSaveBlock1Ptr` (`0x03005D8C`) + `0x560` (30), balls `+0x650`, money `+0x490`; key `*gSaveBlock2Ptr` (`0x03005D90`) + `0xAC` | qty XOR low 16 bits of the key, money XOR the key | [sym] `pokeemerald.sym`; `src/item.c` `GetBagItemQuantity` |
| FireRed/LeafGreen | `*0x03005008` + `0x310` (42), balls `+0x430`, money `+0x290`; key `*0x0300500C` + `0xF20` | same | [sym] `pokefirered.sym`; `include/global.h` |
| HeartGold/SoulSilver | SaveData + `0x10` (general) + `0x644`; Medicine pocket `+0x520` (40) | { u16 id, u16 qty }, 999 per slot | PKHeX `PlayerBag4HGSS.cs`; **checked against RAM images of a running HeartGold (DeSmuME states) and written live** |
| Platinum | SaveData + `0x14` + `0x630`; Medicine `+0x51C` | same | PKHeX `PlayerBag4Pt.cs` |
| Diamond/Pearl | SaveData + `0x214` + `0x624`; Medicine `+0x51C` | same | PKHeX `PlayerBag4DP.cs` |
| Black/White, B2/W2 | party block − `0xA00`; Medicine `+0x7D8` (48) | same | [derived] PKHeX `SaveBlockAccessor5*.cs`: inventory `0x18400`, party `0x18E00`; `PlayerBag5*.cs`. Assumes RAM keeps the save blocks in file order, like Gen 4 – **not verified in a running game**; the checks refuse otherwise |

Gen 4/5 find SaveData through the party reader: its `saveBase` (pointer chain) or, after a scan, party address +
8 − `partyMonsOffset`. A bag with nothing in it is refused (zeros pass every other check). Rare Candy is in the
Items pocket in Gen 1–3 and in the Medicine pocket in Gen 4/5.
