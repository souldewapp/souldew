# Pokémon HeartGold / SoulSilver (Gen 4) – save and data format reference

Researched 2026-10-16. Every offset below was read from source code, and each section cites the file it came from:

* **PKHeX** (`kwsch/PKHeX`, branch `master`): `PKHeX.Core/Saves/SAV4.cs`, `Saves/SAV4HGSS.cs`, `Saves/Substructures/Gen4/SAV4BlockDetection.cs`, `Saves/Util/Checksums.cs`, `Saves/Util/SaveUtil.cs`, `PKM/PK4.cs`, `PKM/Shared/G4PKM.cs`, `PKM/Util/PokeCrypto.cs`, `PKM/Util/Experience.cs`, `PKM/Strings/StringConverter4.cs`, `PKM/Strings/StringConverter4Util.cs`, `PersonalInfo/Info/PersonalInfo4.cs`, `Game/Locations/Locations.cs`, `Game/Enums/Ball.cs`, `Game/Enums/GameVersion.cs`, `Legality/Legal.cs`, `Resources/text/...`
* **pokeheartgold decomp** (`pret/pokeheartgold`, branch `master`): `include/save.h`, `src/save.c`, `src/msgdata.c`, `src/pm_string.c`, `include/constants/charcode.h`, `include/player_data.h`, `src/save_local_field_data.c`, `include/field_types_def.h`, `include/struct_defs/personal_narc_structs.h`, `files/poketool/personal/evo.json.txt`, `include/constants/pokemon.h`, `include/constants/battle.h`, `tools/msgenc/charmap.txt`
* **UPR ZX** (`Ajarmar/universal-pokemon-randomizer-zx`, branch `master`): `src/com/dabomstew/pkrandom/config/gen4_offsets.ini`, `romhandlers/Gen4RomHandler.java`, `constants/Gen4Constants.java`, `src/thenewpoketext/PokeTextData.java`, `newnds/NARCArchive.java`

All values are little-endian. "General" means the General (small) block and "Storage" means the Storage (PC box) block.

---

## 1. Save file layout (512 KB = 0x80000)

### 1.1 Partitions and blocks

The file holds two full copies of the save, one per partition. The game writes each new save to the partition that does not hold the current one.

| Item | Value | Source |
|---|---|---|
| Partition size | `0x40000` (partition A at `0x00000`, partition B at `0x40000`) | `SAV4.cs` `PartitionSize` |
| General block | partition + `0x00000`, size **`0xF628`** (includes the 0x10-byte footer) | `SAV4HGSS.cs` `GeneralSize` |
| Gap | `0xD8` bytes. The game pads each block up to a 0x100 boundary (`SaveData_InitSlotSpecs` in `save.c`). | `SAV4HGSS.cs` `GeneralGap` |
| Storage block | partition + **`0xF700`**, size **`0x12310`** (includes the footer) | `SAV4HGSS.cs` `StorageSize`, ctor `GeneralSize + GeneralGap` |
| Extra blocks (Hall of Fame, Battle Hall, Battle Videos) | `0x23000`, `0x26000`, `0x27000`, `0x29000`, `0x2B000`, `0x2D000` | `SAV4HGSS.ExtraBlocks` (you do not need these) |

### 1.2 Footer (HGSS: 0x10 bytes at the end of each block)

This is `struct SaveChunkFooter` in `pokeheartgold/include/save.h`. HGSS has a 0x10-byte footer; Diamond/Pearl/Platinum use 0x14 (`SAV4Sinnoh.cs` `FooterSize => 0x14`).

| Offset (from block end) | Type | Field | General abs. offset | Storage abs. offset |
|---|---|---|---|---|
| -0x10 | u32 | `count`: the global save counter. Both blocks of one save get the same value. | `0xF618` | `0x21A00` |
| -0x0C | u32 | `size`: the block size including the footer (`0xF628` or `0x12310`) | `0xF61C` | `0x21A04` |
| -0x08 | u32 | `magic`: `0x20060623` (JP/INT), `0x20070903` (Korean, per PKHeX `SAV4.MAGIC_KOREAN`) | `0xF620` | `0x21A08` |
| -0x04 | u16 | `slot`: block id, 0 = General, 1 = Storage | `0xF624` | `0x21A0C` |
| -0x02 | u16 | `crc`: CRC16 over the block **excluding the 0x10-byte footer** | `0xF626` | `0x21A0E` |

For partition B, add `0x40000` to the absolute offsets.

**Detection** (`SaveUtil.IsValidGeneralFooter2`): the file length must be `0x80000`. At `0x40000 + 0xF628`, the u32 at `[-0xC]` must equal `0xF628` and the u32 at `[-0x8]` must be one of the two magic values. This checks partition B, because the first save goes to the second half. Emulator `.dsv` files have a 122-byte trailer after the 512 KB. Strip it, or slice to `0x80000`.

### 1.3 Checksum: CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, no final xor)

Source: `Checksums.CRC16_CCITT` (PKHeX) and `GF_CalcCRC16` in `save.c` (`SaveArray_CalcCRC16MinusFooter`: `size - sizeof(footer)`).

```js
// PKHeX's table-less implementation (bit-exact)
function crc16ccitt(u8, start, end) {           // [start, end)
  let top = 0xFF, bot = 0xFF;
  for (let i = start; i < end; i++) {
    let x = u8[i] ^ top;
    x ^= (x >> 4);
    top = (bot ^ (x >> 3) ^ (x << 4)) & 0xFF;
    bot = (x ^ (x << 5)) & 0xFF;
  }
  return (top << 8) | bot;
}
// Equivalent standard form: crc=0xFFFF; for b: crc ^= b<<8; 8x: crc = (crc&0x8000)? (crc<<1)^0x1021 : crc<<1; crc&=0xFFFF
const blockOk = (u8, base, size) =>
  crc16ccitt(u8, base, base + size - 0x10) === readU16(u8, base + size - 2);
```

### 1.4 Choosing the active block

**What PKHeX does** (`SAV4.cs` constructor plus `GetActiveBlock` and `SAV4BlockDetection.CompareFooters`): it picks the General block and the Storage block **independently**.

```
GetActiveBlock(begin, length): ofs = begin + length - 0x14
  CompareFooters(ofs (partition A), ofs + 0x40000 (partition B)):
    major = u32 @ofs      (for HGSS this is the last u32 of block data, not a footer field. It is normally equal or 0 in both halves.)
    minor = u32 @ofs+4    (= footer.count)
    CompareCounters(a, b):
      if a == 0xFFFFFFFF && b != 0xFFFFFFFE -> B
      if b == 0xFFFFFFFF && a != 0xFFFFFFFE -> A
      a > b -> A;  a < b -> B;  equal -> "same"
    major decides if different; otherwise minor; if both are the same -> A
General: begin = 0,      length = 0xF628
Storage: begin = 0xF700, length = 0x12310
```

**What the game does** (`save.c` `Save_GetSaveFilesStatus`): it checks each partition's General ("main") and Storage ("sub") footer for size, magic, slot id and CRC. It picks the partition whose valid main footer has the higher `count`, and then **requires that partition's sub footer to have the same `count`**. If they don't match, it falls back to the older partition. The PC box "modified" flags carry over from the previous save (`Save_CalcPCBoxModifiedFlags`), so each partition always holds a complete, coherent box set.

**Recommended JS logic** (combines both approaches and is robust):

```js
function pickPartition(u8) {
  const parts = [0, 0x40000].map(p => {
    const g = footer(u8, p, 0xF628), s = footer(u8, p + 0xF700, 0x12310);
    return { p, g, s, ok: g.valid && s.valid && g.count === s.count };
  });
  // footer(): valid = size matches && magic in {0x20060623,0x20070903} && crc ok; count = u32 @ end-0x10
  const good = parts.filter(x => x.ok);
  if (!good.length) { /* fall back: choose General and Storage independently by valid+count */ }
  return good.sort((a, b) => (b.g.count >>> 0) - (a.g.count >>> 0))[0].p;  // treat 0xFFFFFFFF as invalid
}
```

### 1.5 General block offsets (relative to the active General block start)

| Data | Offset | Type | Source |
|---|---|---|---|
| Trainer block base (`Trainer1`) | `0x64` | | `SAV4HGSS.GetSAVOffsets` |
| Trainer name | `0x64` | 16 bytes = 8 × u16 Gen4 chars (max 7 + 0xFFFF) | `SAV4.OriginalTrainerTrash` |
| TID | `0x74` | u16 | `Trainer1+0x10` |
| SID | `0x76` | u16 | `Trainer1+0x12` |
| Money | `0x78` | u32 (max 999999) | `Trainer1+0x14` |
| Gender | `0x7C` | u8 (0 = male, 1 = female) | `Trainer1+0x18` |
| Language | `0x7D` | u8 (1 JP, 2 EN, 3 FR, 4 IT, 5 DE, 7 ES, 8 KO) | `Trainer1+0x19` |
| **Johto badges** | `0x7E` | u8 bitfield, one bit per badge (bit order assumed to follow gym order; not verified in source) | `SAV4.Badges` `Trainer1+0x1A`; decomp `PlayerProfile.johtoBadges` |
| Avatar/sprite | `0x7F` | u8 | `Trainer1+0x1B` |
| ROM code / version | `0x80` | u8 (HG = 7, SS = 8) | `SAV4.ROMCode` |
| Progress flags | `0x81` | bit0 = game clear, bit1 = National Dex | `Trainer1+0x1D` |
| **Kanto badges** | `0x83` | u8 bitfield | `SAV4HGSS.Badges16` `Trainer1+0x1F`; decomp `PlayerProfile.kantoBadges` |
| Coins | `0x84` | u16 | `Trainer1+0x20` |
| **Play time** hours / minutes / seconds | `0x86` u16 / `0x88` u8 / `0x89` u8 | | `Trainer1+0x22/0x24/0x25` |
| Party count | `0x94` | u32 `curCount` (PKHeX reads the u8 at `Party-4`). `0x90` = `maxCount` (6). | `SAV4.PartyCount`; decomp `PartyCore {int maxCount; int curCount; mons[6]}` (`pokemon_types_def.h`) |
| **Party** | `0x98` + 236·i, i = 0..5 | 236-byte encrypted PK4 | `SAV4HGSS` `Party = 0x98`; `GetPartyOffset` |
| **Current map (zone / map header ID)** | `0x1234` | u32 (PKHeX reads u16) | `SAV4HGSS.M`; decomp `LocalFieldData.currentPosition.mapId` |
| Warp id / X / Y | `0x1238` / `0x123C` / `0x1240` | u32 each (direction at `0x1244`) | decomp `struct Location {mapId, warpId, x, y, direction}`; PKHeX `X` / `Y` |
| Pokédex | `0x12B8` | | `SAV4HGSS.PokeDex` |
| Daycare | `0x15FC` | 2 × 236-byte slots | `SAV4HGSS.DaycareOffset` |
| Rival name | `0x22D4` | 16 bytes | `SAV4HGSS.RivalSpan` |
| Apricorn counts | `0xE558 + i` | u8 | `SAV4HGSS` |
| Pokéwalker steps / watts | `0xE704` / `0xE708` | u32 | `SAV4HGSS` |
| Seconds at game start / Hall of Fame | `0x34` / `0x3C` | u32 | `SAV4.SecondsToStart/Fame` |

**The current map is a map header (zone) index, not a met-location ID.** To get a name, map it like this, following UPR `Gen4RomHandler` (around line 2468):

1. Take the ARM9 map header table at `MapTableARM9Offset` (HG/SS U = `0xF6BE0` in the **decompressed** arm9; per-region values are in `gen4_offsets.ini`).
2. Each header is 24 bytes. Byte `+0` is the wild-encounter file index (255 = none). Byte `+18` (`MapTableNameIndexSize=1`) is the map-name index.
3. Use that index into text file **279** (US). It is the same "mapsec" list as the met-location names, so `hgss_locations_en.json[index]` works.
4. The number of headers is `size(fielddata/maptable/mapname.bin) / 16`.

### 1.6 Storage block (relative to the active Storage block start; absolute = partition + `0xF700` + offset)

Source: the `#region Storage` comment and constants in `SAV4HGSS.cs`.

| Data | Offset | Notes |
|---|---|---|
| Box *b* (0..17), slot *s* (0..29) | `b*0x1000 + s*136` | 18 boxes × 30 slots. Each box is 30 × 136 = `0xFF0` bytes + `0x10` zero padding, so `0x1000` per box. Slots are 136-byte encrypted PK4s. |
| Current box | `0x12000` | u8 (u32 field) |
| Box-changed flags | `0x12004` | u32 bitfield (18 bits) |
| Box names | `0x12008 + b*40` | 40 bytes = 20 u16 chars, terminated by 0xFFFF. The game allows 8 characters. |
| Box wallpapers | `0x122D8 + b` | u8 |
| Unlocked-wallpaper flags | `0x122EA` | u8 |
| Footer | `0x12300` | see 1.2 |

An empty slot is all zeros. After decryption the species is 0, because the first XOR key generated from seed 0 is 0. Treat `species == 0` as empty. Also check that the PK4 checksum is valid (an invalid one is a "Bad Egg").

---

## 2. PK4 structure (136 bytes stored, 236 bytes party)

Sources: `PK4.cs`, `G4PKM.cs`, `PokeCrypto.cs`.

### 2.1 Encryption

```
0x00 u32 PID
0x04 u16 sanity flags (bit0 partyDecrypted, bit1 boxDecrypted, bit2 checksumFailed = Bad Egg; 0 normally; decomp pokemon_types_def.h)
0x06 u16 checksum  = sum of the 64 u16 words in bytes 0x08..0x87 (decrypted, unshuffled), & 0xFFFF   (G4PKM.CalculateChecksum, Checksums.Add16)
0x08..0x87  four 32-byte blocks A,B,C,D, shuffled and XOR-encrypted, seed = checksum
0x88..0xEB  party-only battle stats (100 bytes), XOR-encrypted, seed = PID
```

PRNG (`PokeCrypto.CryptArray`): `seed = (0x41C64E6D * seed + 0x6073) >>> 0; key = seed >>> 16; word ^= key`. It is applied to each u16 in order, and the seed carries over from word to word.

Shuffle value: `sv = ((PID >> 13) & 31) % 24`. PKHeX's table has 32 rows (rows 24..31 duplicate rows 0..7), which is the same as taking `% 24`. **On decryption, output block `i` = input block `BlockPosition[sv*4 + i]`.**

```js
// PokeCrypto.BlockPosition (24 rows; row = sv). Decrypted block i = encrypted block row[i]
const BLOCK_POSITION = [
 [0,1,2,3],[0,1,3,2],[0,2,1,3],[0,3,1,2],[0,2,3,1],[0,3,2,1],
 [1,0,2,3],[1,0,3,2],[2,0,1,3],[3,0,1,2],[2,0,3,1],[3,0,2,1],
 [1,2,0,3],[1,3,0,2],[2,1,0,3],[3,1,0,2],[2,3,0,1],[3,2,0,1],
 [1,2,3,0],[1,3,2,0],[2,1,3,0],[3,1,2,0],[2,3,1,0],[3,2,1,0],
];
// Inverse (for encrypting): BlockPositionInvert = [0,1,2,4,3,5,6,7,12,18,13,19,8,10,14,20,16,22,9,11,15,21,17,23]

function cryptArray(u8, start, end, seed) {
  for (let i = start; i < end; i += 2) {
    seed = (Math.imul(0x41C64E6D, seed) + 0x6073) >>> 0;
    const v = (u8[i] | (u8[i+1] << 8)) ^ (seed >>> 16);
    u8[i] = v & 0xFF; u8[i+1] = v >> 8;
  }
}
function decryptPK4(src /* Uint8Array 136 or 236 */) {
  const d = src.slice();
  const pid = (d[0] | d[1]<<8 | d[2]<<16 | d[3]<<24) >>> 0;
  const chk = d[6] | d[7] << 8;
  cryptArray(d, 8, 136, chk);
  if (d.length > 136) cryptArray(d, 136, d.length, pid);       // party stats seeded with PID
  const sv = ((pid >>> 13) & 31) % 24, row = BLOCK_POSITION[sv];
  const out = d.slice();
  for (let i = 0; i < 4; i++) out.set(d.subarray(8 + row[i]*32, 8 + row[i]*32 + 32), 8 + i*32);
  let sum = 0; for (let i = 8; i < 136; i += 2) sum = (sum + (out[i] | out[i+1]<<8)) & 0xFFFF;
  return { data: out, checksumOk: sum === chk };
}
```

### 2.2 Field offsets (after decryption and unshuffling)

| Off | Size | Field | Notes |
|---|---|---|---|
| 0x00 | u32 | PID | **Nature = PID % 25.** Ability slot = PID & 1 (only informational, because the ability ID is stored directly). Gender is also stored explicitly. |
| 0x08 | u16 | Species | National Dex number (0 = empty) |
| 0x0A | u16 | Held item | item ID |
| 0x0C | u16 | OT TID | |
| 0x0E | u16 | OT SID | |
| 0x10 | u32 | EXP | |
| 0x14 | u8 | Friendship (egg: steps-to-hatch cycles) | |
| 0x15 | u8 | **Ability ID** (directly, 0..123) | |
| 0x16 | u8 | Markings | |
| 0x17 | u8 | Language | |
| 0x18..0x1D | u8×6 | EVs HP, Atk, Def, **Spe**, SpA, SpD | |
| 0x1E..0x23 | u8×6 | Contest stats (cool, beauty, cute, smart, tough, sheen) | |
| 0x24 | u32 | Ribbons (Sinnoh set 1) | |
| 0x28 | u16×4 | Moves 1–4 | |
| 0x30 | u8×4 | PP | |
| 0x34 | u8×4 | PP Ups | |
| 0x38 | u32 | **IV32**: HP bits 0–4, Atk 5–9, Def 10–14, **Spe 15–19**, SpA 20–24, SpD 25–29, **bit30 = IsEgg**, **bit31 = IsNicknamed** | |
| 0x3C | u32 | Ribbons (Hoenn) | |
| 0x40 | u8 | bit0 = fateful encounter; **bits1–2 = gender (0 M, 1 F, 2 genderless)**; **bits3–7 = alt form** | |
| 0x41 | u8 | Shiny leaves (HGSS) | |
| 0x44 | u16 | **Egg location (Pt/HGSS "extended")** | |
| 0x46 | u16 | **Met location (Pt/HGSS "extended")** | |
| 0x48 | 22 B | **Nickname**: 11 × u16 (10 chars + 0xFFFF) | |
| 0x5F | u8 | Origin game (HG 7, SS 8, D 10, P 11, Pt 12, S 1, R 2, E 3, FR 4, LG 5, CXD 15) | `GameVersion.cs` |
| 0x60 | u32 | Ribbons (Sinnoh set 2) | |
| 0x68 | 16 B | **OT name**: 8 × u16 (7 chars + 0xFFFF) | |
| 0x78–0x7A | u8×3 | Egg date (year − 2000, month, day) | |
| 0x7B–0x7D | u8×3 | **Met date** (year − 2000, month, day) | |
| 0x7E | u16 | Egg location (DP field) | |
| 0x80 | u16 | Met location (DP field) | |
| 0x82 | u8 | Pokérus (low nibble = days, high nibble = strain) | |
| 0x83 | u8 | Ball (DP/Pt field) | |
| 0x84 | u8 | bits0–6 = **met level**; bit7 = OT gender | |
| 0x85 | u8 | Encounter type / ground tile | |
| 0x86 | u8 | Ball (HGSS field) | |
| 0x87 | u8 | Pokéwalker mood | |
| **Party only** | | | |
| 0x88 | u32 | **Status condition**: bits0–2 = sleep turns, bit3 = poison, bit4 = burn, bit5 = freeze, bit6 = paralysis, bit7 = toxic | decomp `constants/battle.h` |
| 0x8C | u8 | **Level** | |
| 0x8D | u8 | Ball capsule (seal) index | |
| 0x8E | u16 | **Current HP** | |
| 0x90 | u16 | **Max HP** | |
| 0x92 / 0x94 / 0x96 / 0x98 / 0x9A | u16 | Atk / Def / **Spe** / SpA / SpD | |
| 0x9C | 0x38 | Held mail | |
| 0xD4 | 0x18 | Seal coordinates | |

* **Shiny**: `((PID>>>16) ^ (PID & 0xFFFF) ^ TID ^ SID) < 8`. `G4PKM` compares PSV = `((PID>>16)^(PID&0xFFFF))>>3` with TSV = `(TID^SID)>>3`.
* **Ball** (`G4PKM.Ball`): `max(data[0x86], data[0x83])`. Ball IDs (`Ball.cs`): 1 Master, 2 Ultra, 3 Great, 4 Poké, 5 Safari, 6 Net, 7 Dive, 8 Nest, 9 Repeat, 10 Timer, 11 Luxury, 12 Premier, 13 Dusk, 14 Heal, 15 Quick, 16 Cherish, 17 Fast, 18 Level, 19 Lure, 20 Heavy, 21 Love, 22 Friend, 23 Moon, 24 Sport. Balls 1–16 have the same numbers as their item IDs. Balls 17–24 correspond to items 492–499.
* **Level for box Pokémon**: the box struct has no level field. Compute it from EXP with `exp_table.json[growthRate]`, where `growthRate = personal_hgss.json[species].growthRate`. The level is the highest L with `table[L-1] <= exp` (`Experience.GetLevel`).
* **Stats for box Pokémon** (standard Gen 3+ formulas, not taken from a file read here): `HP = floor((2B+IV+floor(EV/4))*L/100)+L+10` (Shedinja = 1); other stats `= floor((floor((2B+IV+floor(EV/4))*L/100)+5)*natureMod)`. For nature n, the raised stat is `floor(n/5)` and the lowered stat is `n%5`, in the stat order [Atk, Def, Spe, SpA, SpD]. The multiplier is 1.1 or 0.9, or 1.0 for both when they are the same stat.

### 2.3 Met / egg location logic (DP field vs. Pt/HGSS field, "Faraway place" 3002)

Source: the `G4PKM.MetLocation` / `EggLocation` getters and setters, and `Locations.cs`.

* **Reading**: `metLocation = u16@0x46 !== 0 ? u16@0x46 : u16@0x80`, and the same for eggs with `0x44`/`0x7E`.
* **Writing / why 3002 appears**: Diamond/Pearl only know location IDs 0..111. When an HGSS (or Pt) game records a location that D/P cannot display (`IsPtHGSSLocation`: `111 < id < 2000`, or `IsPtHGSSLocationEgg`: `2010 < id < 3000`), it does two things:
  * It writes the real ID into the extended field (`0x46` / `0x44`).
  * It writes **3002 = "Faraway place"** (`Locations.Faraway4`) into the DP field (`0x80` / `0x7E`).

  D/P therefore shows "Faraway place", while Pt/HGSS and PKHeX show the extended value. For IDs that D/P can display (0..111, 2000..2010, 3000+), the DP field holds the real value. The extended field holds the same value only if the Pokémon was encountered in Pt/HGSS, and 0 otherwise.
* Name lookup: IDs 0..234 → `hgss_locations_en.json[id]`. IDs 2000..2014 and 3000..3076 → `hgss_locations_special_en.json[String(id)]`. Examples: 2000 = Day-Care Couple, 2002 = Link trade, 3001 = Pokémon Ranger, 3002 = Faraway place; 233 = Pokéwalker; 55 = Pal Park (DP list). Event locations are 3000..3076 (`IsEventLocation4`).

### 2.4 Strings (nickname, OT, box names)

`StringConverter4.LoadString`: read u16 values and **stop at 0xFFFF or 0x0000**. Map each value through `gen4_chars.json`. Values not in the table map to nothing (PKHeX returns 0xFFFF). Values 0x400–0xD65 are Korean (PKHeX `TableKOR`, not exported here). PKHeX maps the half-width gender codes 0x1BB/0x1BC to U+246D/U+246E and then normalizes them to ♂/♀. The JSON already contains ♂/♀.

---

## 3. Character table files

* `gen4_chars.json`: **PKHeX `StringConverter4Util.TableINT`**, 0x0001..0x01EC (493 entries minus NUL/EMP), plus `"0xFFFF": ""`. 0x0121–0x012A = '0'–'9', 0x012B–0x0144 = 'A'–'Z', 0x0145–0x015E = 'a'–'z', 0x01DE = ' ' (space), 0x01AB '!', 0x01AC '?', 0x01AD ',', 0x01AE '.', 0x01B3 = `'`. Index 0x0001 is the full-width space U+3000. PKHeX uses **placeholder glyphs** (①…⒇ ranges, e.g. 0x01AF '⑬', 0x0176 '⑧', 0x01C6 '⑯') for in-game glyphs that have no separate Unicode code point in its editor.
* `gen4_chars_ingame_glyphs.json`: the **real in-game glyphs** from the decomp `tools/msgenc/charmap.txt`, for display. Examples: 0x01AF = '…', 0x0176 = '×', 0x0196 = '÷', 0x01B3 = '’', 0x01C6..0x01CF = ♠♣♥♦★◉●■▲◆. It also includes the text control characters 0xE000 = "\n", 0x25BC = "\r" (scroll), 0x25BD = "\f" (new box). 62 codes differ between the two files, all of them symbols. Letters, digits and the common punctuation are the same in both. **Use the ingame-glyph file for UI display.**

---

## 4. Data files written

All files are in `research/`. Each source file has no trailing newline, so line *n* = index *n*.

| File | Content | Source | Index check |
|---|---|---|---|
| `hgss_locations_en.json` | array[235], index = met location ID 0..234 | `Resources/text/locations/gen4/text_hgss_00000_en.txt` | 0 Mystery Zone, 1 Twinleaf Town, 126 New Bark Town, 233 Pokéwalker, 234 Cliff Edge Gate |
| `hgss_locations_special_en.json` | {"2000".."2014", "3000".."3076"} | `text_hgss_02000_en.txt`, `text_hgss_03000_en.txt` | 2000 Day-Care Couple, 3002 Faraway place |
| `species_en.json` | array[494], 0 = "" (PKHeX has "Egg" there) | `Resources/text/other/en/text_Species_en.txt` | 1 Bulbasaur, 493 Arceus |
| `moves_en.json` | array[468], 0 = "———" | `text_Moves_en.txt` | 1 Pound, 467 Shadow Force (`Legal.MaxMoveID_4 = 467`) |
| `abilities_en.json` | array[124], 0 = "—" | `text_Abilities_en.txt` | 1 Stench, 123 Bad Dreams (`MaxAbilityID_4 = 123`) |
| `natures_en.json` | array[25] Hardy..Quirky | `text_Natures_en.txt` | |
| `items_en.json` | array[537], 0 = "None" | `Resources/text/items/text_Items_en.txt` (PKHeX has no Gen4-specific item list, and IDs 0..536 have been stable since Gen 4) | 492 Fast Ball … 500 Park Ball, 504 Rage Candy Bar, 532 Jade Orb, 533 Lock Capsule, 534 Red Orb, 535 Blue Orb, 536 Enigma Stone (`MaxItemID_4_HGSS = 536`). Names use modern spelling ("Rage Candy Bar", not "RageCandyBar"). |
| `exp_table.json` | {growthRate: [exp needed for level 1..100]} | `PKM/Util/Experience.cs` | |
| `personal_hgss.json` | array[508]: 0..493 species, then form entries (Deoxys 496–498, Wormadam 499–500, Giratina-O 501, Shaymin-S 502, Rotom 503–507) | PKHeX `Resources/byte/personal/personal_hgss` (0x2C per entry) | **types use PKHeX/modern IDs** (see `types_en.json`: 9 = Fire … 16 = Dark), **not ROM IDs** |
| `types_en.json` | modern type order 0..16 | `text_Types_en.txt` | |

---

## 5. ROM data: personal, evolution and learnset formats; NARC paths

### 5.1 Personal entry (a/0/0/2, 0x2C = 44 bytes, file index = species; forms at 496+)

Sources: decomp `struct BaseStats` (`personal_narc_structs.h`), `PersonalInfo4.cs`, UPR `Gen4Constants.bs*Offset`.

| Off | Field |
|---|---|
| 0x00–0x05 | base HP, Atk, Def, **Spe**, SpA, SpD |
| 0x06 / 0x07 | type1 / type2 (**ROM IDs**: 0 Normal, 1 Fighting, 2 Flying, 3 Poison, 4 Ground, 5 Rock, 6 Bug, 7 Ghost, 8 Steel, **9 ???**, 10 Fire, 11 Water, 12 Grass, 13 Electric, 14 Psychic, 15 Ice, 16 Dragon, 17 Dark). Single-type species have type1 == type2. |
| 0x08 | catch rate |
| 0x09 | base EXP yield |
| 0x0A | u16 EV yield, 2 bits each: HP, Atk, Def, Spe, SpA, SpD |
| 0x0C / 0x0E | u16 held item 1 / 2 |
| 0x10 | gender ratio (0 = always male, 31, 63, 127, 191, 254 = always female, 255 = genderless) |
| 0x11 | egg cycles |
| 0x12 | base friendship |
| 0x13 | growth rate (0 Medium Fast, 1 Erratic, 2 Fluctuating, 3 Medium Slow, 4 Fast, 5 Slow) |
| 0x14 / 0x15 | egg groups |
| 0x16 / 0x17 | ability 1 / ability 2 |
| 0x18 | Safari flee rate |
| 0x19 | bits0–6 color, bit7 no-flip |
| 0x1A–0x1B | padding |
| 0x1C–0x2B | TM/HM compatibility bits (4 × u32). PKHeX's resource reuses 0x29 for form count and 0x2A for the form-stats index. |

### 5.2 Evolution entry (a/0/3/4, 0x2C = 44 bytes per species)

Source: decomp `evo.json.txt` defines `struct EvolutionDataFile { struct Evolution evos[7]; u16 pad0; }` with `struct Evolution { u16 method, param, target; }`. UPR `Gen4RomHandler` reads it at `evo*6`, `+2`, `+4`.

* 7 × {u16 method, u16 param, u16 targetSpecies} + 2 bytes of padding. method 0 = none.
* Methods (decomp `EvoMethod` enum, 0..26): 0 NONE, 1 FRIENDSHIP, 2 FRIENDSHIP_DAY, 3 FRIENDSHIP_NIGHT, 4 LEVEL, 5 TRADE, 6 TRADE_ITEM, 7 STONE, 8 LEVEL_ATK_GT_DEF, 9 LEVEL_ATK_EQ_DEF, 10 LEVEL_ATK_LT_DEF, 11 LEVEL_PID_LO, 12 LEVEL_PID_HI, 13 LEVEL_NINJASK, 14 LEVEL_SHEDINJA, 15 BEAUTY, 16 STONE_MALE, 17 STONE_FEMALE, 18 ITEM_DAY, 19 ITEM_NIGHT, 20 HAS_MOVE, 21 OTHER_PARTY_MON, 22 LEVEL_MALE, 23 LEVEL_FEMALE, 24 CORONET, 25 ETERNA, 26 ROUTE217.
* The param is the level, item ID, move ID or species, depending on the method.

### 5.3 Learnsets (a/0/3/3)

The file holds u16 values. `move = v & 0x1FF`, `level = v >> 9`. A value of `0xFFFF` ends the list. Source: UPR `Gen4RomHandler.getMovesLearnt`.

### 5.4 NARC paths, HeartGold (U) `IPKE` / SoulSilver (U) `IPGE` (`gen4_offsets.ini`)

| Data | HG (U) | SS (U) |
|---|---|---|
| Personal (base stats) | a/0/0/2 | same (CopyFrom) |
| Move data | a/0/1/1 | same |
| Item data | a/0/1/7 | same |
| **Text (msg)** | **a/0/2/7** | same |
| Learnsets | a/0/3/3 | same |
| Evolutions | a/0/3/4 | same |
| **Wild encounters** | **a/0/3/7** | **a/1/3/6** (SS differs!) |
| Trainer data | a/0/5/5 | same |
| Trainer Pokémon | a/0/5/6 | same |
| Egg moves | a/2/2/9 | same |
| Headbutt | a/2/5/2 | same |
| Map names (internal) | fielddata/maptable/mapname.bin | same |

**Text file indices (US/EU HGSS)**:

* species names **237**
* move names 750
* ability names 720
* item names 222
* map / location names 279
* trainer names 729
* trainer classes 730

JP uses 232 / 739 / 711 / 219 / 272. KR uses 233 / 743 / 715 / 220 / 274. EU (F/G/I/S) copy the U values; only `MapTableARM9Offset` differs.

**NARC container** (UPR `NARCArchive.java`):

* Header: 16 bytes, "NARC", then 3 sections.
* Each section: 4-byte magic, u32 size (including the 8-byte section header).
* `BTAF` (FATB): u32 count, then count × (u32 start, u32 end), relative to the `GMIF` data start (after its 8-byte header).
* `BTNF` (FNTB): names, which can be ignored.

---

## 6. Gen 4 message (text) decryption, a/0/2/7

Sources: decomp `src/msgdata.c` (`Decrypt1`, `Decrypt2`) and `src/pm_string.c` (`String_Cat_HandleTrainerName`), constants from `include/constants/charcode.h`. Cross-checked against UPR `thenewpoketext/PokeTextData.java`.

File layout:

```
0x00 u16 count
0x02 u16 key
0x04 count × { u32 offset; u32 length /*in u16 chars*/ }   // encrypted
...  string data at file-relative offsets, encrypted
```

```js
function readMsgFile(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const count = dv.getUint16(0, true), key = dv.getUint16(2, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    // Decrypt1: k = (key * 765 * (i+1)) & 0xFFFF  (765 = 0x2FD); k32 = k | k<<16
    const k = Math.imul(Math.imul(key, 0x2FD), i + 1) & 0xFFFF, k32 = (k | (k << 16)) >>> 0;
    const offset = (dv.getUint32(4 + i*8, true) ^ k32) >>> 0;
    const length = (dv.getUint32(8 + i*8, true) ^ k32) >>> 0;
    // Decrypt2: per-string key = ((i+1) * 596947) & 0xFFFF (596947 = 0x91BD3), += 18749 (0x493D) after each char
    let ck = Math.imul(i + 1, 0x91BD3) & 0xFFFF;
    const chars = new Array(length);
    for (let j = 0; j < length; j++) {
      chars[j] = dv.getUint16(offset + j*2, true) ^ ck;
      ck = (ck + 0x493D) & 0xFFFF;
    }
    out.push(decodeChars(chars));
  }
  return out;
}

function decodeChars(c) {
  if (c[0] === 0xF100) c = decompress9(c);           // TRNAMECODE: 9-bit packed string
  let s = '';
  for (let i = 0; i < c.length; i++) {
    const v = c[i];
    if (v === 0xFFFF) break;                          // EOS
    if (v === 0xE000) { s += '\n'; continue; }        // CHAR_LF
    if (v === 0x25BC) { s += '\r'; continue; }        // scroll (charmap.txt)
    if (v === 0x25BD) { s += '\f'; continue; }        // new text box
    if (v === 0xFFFE) {                               // control/variable: id, nParams, params...
      const id = c[++i], n = c[++i]; const params = c.slice(i + 1, i + 1 + n); i += n;
      s += `{${id.toString(16)}:${params.join(',')}}`; continue;   // e.g. STRVAR, COLOR (0xFF00), SIZE (0xFF01)
    }
    s += CHARS[v] ?? `\\x${v.toString(16).padStart(4,'0')}`;      // gen4_chars_ingame_glyphs.json
  }
  return s;
}

// pm_string.c String_Cat_HandleTrainerName: 9-bit chars packed into 15 bits of each u16; terminator 0x1FF
function decompress9(c) {
  const out = []; let p = 1, bit = 0;
  for (;;) {
    let ch = (c[p] >> bit) & 0x1FF;
    bit += 9;
    if (bit >= 15) { p++; bit -= 15; if (bit !== 0) ch |= (c[p] << (9 - bit)) & 0x1FF; }
    if (ch === 0x1FF) break;
    out.push(ch);
  }
  out.push(0xFFFF);
  return out;
}
```

Use text file 237 for species names. Its entries are indexed by species, and the list continues past 493 (`HasExtraPokemonNames=Yes`).

---

## 7. End-to-end parse (pseudocode)

```js
const p = pickPartition(sav);                 // 0 or 0x40000
const G = p, S = p + 0xF700;
const trainer = { name: g4str(sav, G+0x64, 8), tid: u16(G+0x74), sid: u16(G+0x76), money: u32(G+0x78),
  johtoBadges: sav[G+0x7E], kantoBadges: sav[G+0x83],
  playTime: { h: u16(G+0x86), m: sav[G+0x88], s: sav[G+0x89] }, mapId: u32(G+0x1234) };
const party = [...Array(sav[G+0x94])].map((_, i) => decryptPK4(sav.slice(G+0x98+i*236, G+0x98+(i+1)*236)));
const boxes = [...Array(18)].map((_, b) => [...Array(30)].map((_, s) => {
  const o = S + b*0x1000 + s*136; return decryptPK4(sav.slice(o, o+136)); }));
const currentBox = sav[S+0x12000];
const boxNames = [...Array(18)].map((_, b) => g4str(sav, S+0x12008+b*40, 20));
```

## 8. Uncertainties / caveats

* PKHeX's "major counter" at block end −0x14 is a leftover from the Sinnoh layout. For HGSS it is not a footer field. The only real HGSS counter is `footer.count` at −0x10, so prefer the game-faithful selection logic in 1.4.
* The Johto/Kanto badge bit order (bit n = n-th gym) is assumed. The sources only show the bytes as bitfields.
* The current map ID at 0x1234 is a zone ID. Resolving it to a name needs ARM9 data from the ROM (1.5). It is not the same as a met-location ID.
* `items_en.json` uses modern English spellings. The in-game HGSS spellings, such as "RageCandyBar" or "Thunderstone", can differ. Text file 222 in the ROM has the exact in-game names.
* The Korean character table (0x400–0xD65) and Korean-specific behaviors are not exported.
* The box stat and level formulas in 2.2 are the standard published formulas. They were not taken from a file read during this research. The EXP tables do come from PKHeX.
