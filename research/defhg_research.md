# Pokémon Definitive HeartGold: research notes (SoulLink + Randomizer)

Compiled 2026-10-16. There are three kinds of evidence here, and each claim is tagged with one:
- **[SRC]**: a public source (linked).
- **[ROM]**: my own byte-level comparison of the local files `_extract/rom/Pokemon - HeartGold Version (USA).nds` (vanilla, IPKE) and `_ref/defhg.nds` (patched). It is a direct measurement, not a report from someone else.
- **[UPR-TEST]**: I ran UPR ZX 4.6.1 (`_ref/upr/PokeRandoZX.jar`) headlessly through Nashorn (`jjs`) on a copy of the patched ROM. No emulator boot test was done.
- **[UNSURE]**: not verified.

---

## 0. Identity of the hack [SRC]
- **Name and author.** "Pokémon Definitive HeartGold" by **BigNation** ("Big ッ大ッ", X @Big__Nation, YouTube @BigNation1). The release thread opened on **2025-12-20** and was marked **[COMPLETE]**. Development took about 1.5 years, solo. No version number is stated anywhere I could see.
  - PokéCommunity thread: https://www.pokecommunity.com/threads/pok%C3%A9mon-definitive-heartgold-complete.539556/ (2 pages, last reply Sep 2026)
  - Release video: https://www.youtube.com/watch?v=5lNjCwakAfI
  - X announcement: https://x.com/Big__Nation/status/2002439320377217472
- **Patch folder.** `bit.ly/DefinitiveHeartGold` resolves to Google Drive folder `1bhEud42EJB7T1JsGb-RYFTurIoxy2Htq`. It holds two files:
  - `Pokemon Definitive HeartGold Patch.xdelta`, last modified "Jan 31" (2026). So the patch was **re-uploaded or updated once after release**, but there is no changelog.
  - `ReadMe.txt`, dated 12/19/25. It confirms the base ROM **HeartGold CRC32 C180A0E9** and the patcher (xdelta UI, romhacking.net #598). It also says: "Save Files will still be compatible."
- **Credits.** BigNation (creator), AgentOcelot (playtester), Fantafaust (scripting), Yako and Kalaay (script patches), Kuha (title screen).
- **Discord.** https://discord.com/invite/qbjHWJr. It requires login and phone verification, so I **could not read it**.

## 1. What the hack changes

### Stated in the thread or FAQ [SRC]
- **QoL**
  - Reusable Repels, infinite TMs, forgettable HMs.
  - Faster egg hatching.
  - Nature descriptions in the summary screen; an IV/EV checker in the summary (press R).
  - Free Move Tutors and a free Move Relearner.
  - No overworld poison damage, instant party heals.
  - Gen-5-style Rare Candy use.
  - Kurt makes balls instantly.
  - Unnecessary HM obstacles and Flash requirements removed.
- **Evolutions**
  - Friendship evolutions happen on the next level-up.
  - Trade evolutions become level 36.
  - Held-item trade evolutions become "level up while holding the item".
  - Leafeon and Glaceon use Leaf Stone and Dawn Stone.
  - Magnezone and Probopass use Thunder Stone; Milotic uses Water Stone.
  - **Day/night checks are removed.**
  - The full list is in `defhg_encounters_evolutions.csv`, for example Golbat to Crobat at Lv23, and Espeon/Umbreon via Sun/Moon Stone.
- **Availability.** "All 493 Pokémon can be obtained." There are new legendary and mythical events, mostly post-game quests (Steven, Mew, Mewtwo).
  - An NPC in each Pokémon Center hands out a starter after each badge: Treecko (Violet, after Falkner), Chimchar, Squirtle, Turtwig, Charmander, Mudkip, Bulbasaur, Piplup, Torchic (Indigo, after 8 badges). See `defhg_encounters_gifts_legendaries.csv`.
- **Trainers**
  - "Revamped". They are harder than vanilla, but "not to a Kaizo/Drayano level".
  - Most phone-rematch trainers were removed, and many trainers were removed overall.
  - Coach trainers give TMs.
  - Custom battles give $0. Examples: Frontier Brains, Ethan/Lyra, plus Cynthia/Steven/Lucas/Dawn and others.
  - One player called the first gym "too easy".
- **Unchanged**
  - Base stats, typings, level-up sets and movepools ("does not fit the vision").
  - Shiny rate ("will cause things to break").
- **FAQ: Fairy type or Gen 6+ mechanics? No.** Megas are also out.
- **Not mentioned anywhere:** Physical/Special split (Gen 4 already has it natively), EXP Share changes, or **built-in level caps**.
  - In April 2026 a user asked whether "a level-cap version is planned", which implies there is none.
- **Known issues reported by players**
  - The Pokédex area display is wrong; use the spreadsheet instead.
  - The Goldenrod slot machines freeze the game. This was asked and never answered.
  - One report of 255 EVs in a stat.
  - White screen on DS Lite + R4; it works on a 3DS XL. Recommended emulators are melonDS and DeSmuME.
  - One iOS (Delta) report says the game works.

### Verified in ROM data [ROM]
- **No Fairy type. Type ID 9 is still "???"** No species uses type 9, and only 1 move does: #174 **Curse**, exactly as in vanilla.
  - The species type histogram over IDs 0–17 is identical to vanilla.
  - Clefairy, Togepi, Snubbull and others are still Normal. Marill is still Water. Gardevoir is still Psychic. Mawile is still Steel.
  - **For the tool: use the vanilla Gen 4 type table** (0 Normal … 8 Steel, 9 ???, 10 Fire … 17 Dark).
- **The data structures are unchanged:**

  | NARC | Contents | Patched ROM vs vanilla |
  |---|---|---|
  | `a/0/0/2` | personal | 508 × 44 B, same |
  | `a/0/1/1` | moves | 471 × 16 B, **byte-identical** |
  | `a/0/3/3` | learnsets | **byte-identical** |
  | `a/0/3/4` | evolutions | 508 × 44 B (35 entries edited) |
  | `a/0/3/7` | wild encounters | 142 × 196 B, same format (128 files edited) |
  | `a/0/5/5` / `a/0/5/6` | trainer data / parties | 738 each, standard format |

  Notes on the edited files:
  - **Trainers:** 479 trainer headers and 535 parties are edited. Almost every boss now uses flags = 3 (custom moves + held items), and parties have up to 6 Pokémon.
  - **Personal data:** only three fields changed.
    1. Egg cycles = 0 for all species.
    2. Ability slots 1 and 2 are **swapped** for 24 species, so the better ability comes first (e.g. Rattata/Raticate, Marill, Togepi, Mawile, Makuhita/Hariyama, Aron line, Sudowoodo).
    3. Elekid and Magby now hold an Electirizer and a Magmarizer.
- **Other changed files:**
  - Scripts `a/0/1/2` (215 of 965 files)
  - Text `a/0/2/7` (203 of 829)
  - Events, map headers and others: `a/0/3/2`, `a/0/4/x`, `a/0/6/5`, `a/0/8/1`, `a/1/3/1`, `a/0/2/8`
  - Overlays 8, 12 (battle; enlarged 162 KB → 226 KB) and 15
  - arm9 (stored decompressed and expanded: 1,122,040 B)
- **Encounter time slots:** 103 of 112 grass tables now have identical morning, day and night slots (vanilla: 44). Day/night is mostly gone; 9 tables still differ. Hoenn/Sinnoh radio slots are still present.
- **Evolution methods:** vanilla methods 25 and 26 (Moss Rock and Ice Rock) are gone. Methods 18 and 19 (hold item, day/night) are now used for 16 species each.
- **Boss levels, read from the trainer files.** These are the **natural "level caps"** a Nuzlocke would use. The hack has no built-in cap.

  | Battle | Ace level |
  |---|---|
  | Falkner | 15 |
  | Bugsy | 20 |
  | Whitney | 24 |
  | Morty | 30 |
  | Chuck | 35 |
  | Jasmine | 35 |
  | Pryce | 42 |
  | Clair | 46 |
  | Will | 52 |
  | Koga | 54 |
  | Bruno | 56 |
  | Karen | 58 |
  | **Lance (Champion)** | **60** |
  | Kanto leaders | 62 (Brock, Misty, Surge, Erika, Janine, Sabrina) |
  | Blaine | 64 |
  | Blue | 70 |
  | **Red** | **88** |
  | Rival Silver (progressive) | 18, 26, 40, 50, 60, 65 |
  | Post-game (rematch leaders, Cynthia, Steven, Lucas/Dawn, Sinnoh leaders) | 73–75 |

  The trainer IDs are 20, 21, 30, 31, 34, 33, 32, 35, 245, 247, 418, 246, 244, 253–259, 261 and 260. These are the original teams; I parsed them straight from `a/0/5/6`.

## 2. Universal Pokemon Randomizer ZX 4.6.1 compatibility

### Community reports [SRC]
I found **no** Reddit, PokéCommunity, YouTube or GitHub reports of anyone randomizing Definitive HeartGold. The thread has no mention of randomizers or Nuzlockes at all. UPR itself prints "The ROM you loaded is not a clean, official ROM. Randomizing ROM hacks or bad ROM dumps is not supported and may cause issues."

### My own test [UPR-TEST]
- **Detection.** UPR recognises the patched ROM as "Pokemon HeartGold (U)" (IPKE) and `isRomValid()=false`, because the file CRCs differ.
- **The stock jar fails.** It **fails before any ROM is written**, with any settings (even Static Pokémon = Unchanged):

  ```
  java.lang.ArrayIndexOutOfBoundsException: 32780
    at Gen4RomHandler$StaticPokemon.getPokemon(Gen4RomHandler.java:3331)
    at Gen4RomHandler.getStaticPokemon(Gen4RomHandler.java:3467)
    at Randomizer.randomize(Randomizer.java:531)
  ```

  - **Cause:** UPR's `gen4_offsets.ini` hardcodes byte offsets inside script files for every static or gift encounter. The patched ROM rewrote those scripts. **94 of 174** static species/level offsets no longer point at species IDs. Affected files:
    - Legendaries: Ho-Oh, Suicune, the legendary birds, Mewtwo, the Hoenn weather trio, Dialga/Palkia/Giratina, Latias/Latios
    - Overworld statics: Sudowoodo, Red Gyarados, Snorlax (Route 11)
    - Gifts and eggs: Tyrogue, Dratini, the Kanto and Hoenn starter gifts, Primo's eggs, Secret Tentacool
  - UPR reads all statics unconditionally for its log, so it crashes. In the GUI this shows as a randomization error. **Verdict: stock UPR ZX 4.6.1 cannot randomize the patched ROM (high confidence, reproduced).**
- **Workaround that does produce a ROM.** Copy the jar, then edit `com/dabomstew/pkrandom/config/gen4_offsets.ini` **inside the jar**. UPR ZX ignores an external `gen4_offsets.ini`; I tested both the jar folder and a `config/` subfolder. In the `[HeartGold (U)]` section:
  1. Set `StaticPokemonSupport=0`.
  2. Delete all `StaticPokemon{}`, `StaticPokemonGameCorner{}` and `RoamingPokemon{}` lines.

  With that change UPR finished. Settings used: random starters (2 evolutions), wild Pokémon Random + Similar Strength, trainers Random + similar strength. It wrote:
  - Wild encounters: `a/0/3/7`, plus headbutt `a/2/5/2` and the Bug Contest
  - Trainers: `a/0/5/6`
  - Starters: overlay 61, which the hack left unchanged, so the Elm's lab starters are randomized
  - Pokédex area data, plus 10 scripts and some text

  The scripts and text change because UPR swaps rival/starter references (pattern-based, fine) and Lyra's Marill cries and text.
  - **Remaining risk:** two of the hardcoded `MarillCryScripts` offsets (`225:0x1B8`, `842:0x16C6`) land in scripts the hack edited. UPR overwrote non-species bytes there (0x00A3 and 0x0003 became the new species), which is **possible script corruption**. Remove those two entries too, leaving `MarillCryScripts=[93:0x66, 849:0x1AE]`, or avoid trainer randomization's Marill swap.
  - arm9 grew by 220 bytes (UPR's Arm9 extension, the catching-tutorial and roamer tweaks), sitting on top of the hack's already-expanded arm9. Whether this boots cleanly is **[UNSURE]**. It needs an emulator test.
- **Safe-ish settings, assuming the patched jar:**
  - **Leave unchanged:** Static/Gift Pokémon, items, trades, base stats, types, abilities, evolutions, movesets, TMs and tutors. The hack's QoL and the tutor-timed trainer design depend on them, and none of them are needed for a SoulLink.
  - **Randomize:** starters, wild encounters, and optionally trainers.
  - Don't use "Change impossible evolutions" or "Update moves". The hack already fixed the evolutions, and the moves would desync from the hack's tutor design.
  - Leave the Pokémon Center starter NPCs and the post-game legendary quests unrandomized. UPR can't reach them anyway.
- **Alternative for the local tool.** The formats are vanilla, so the tool can randomize the patched ROM itself:
  - wild encounters: `a/0/3/7`, 196-byte HGSS format
  - trainer parties: `a/0/5/6`, flags in `a/0/5/5` byte 0
  - starters: overlay 61

  It should not touch scripts. That avoids UPR's hardcoded-offset problem entirely.

Overall verdict: **UPR ZX 4.6.1 does not work out of the box (certain, reproduced). A config-patched jar produces a randomized ROM covering wild, trainer and starter randomization (verified offline). In-game stability is unverified: medium confidence it plays fine with the static/roamer/Marill-cry entries removed.**

## 3. Encounter table (bit.ly/DefHGEncounterTable) [SRC + saved]
- **Link.** `bit.ly/DefHGEncounterTable` resolves to the Google Sheet `1-WVx7UuuXzrULLSCq_atkklh7ZmmDM6oxo1G25WZuk8`, titled "Definitive HeartGold Encounter Table". It is public. The `/export?format=csv` endpoint returns an HTML redirect, so I used `/gviz/tq?tqx=out:csv&gid=…`.
- **Saved files:**
  - `research/defhg_encounters_locations.csv`: tab "Encounter Locations", gid 0. 943 data rows.
  - `research/defhg_encounters_evolutions.csv`: tab "New Evolution Methods", gid 1793452818. 38 rows: Pokemon, Method, Target.
  - `research/defhg_encounters_gifts_legendaries.csv`: tab "New Gift Pokemon & Legendary Locations", gid 1019042315. 44 rows: Pokemon, Location, Requirement.
- **Columns (locations tab).** `Location, (empty), Encounters, Method, Percentage Rate, Levels`.
  - **Quirk 1:** gviz merged the header into the first data row, giving values like "Location New Bark Town" and "Encounters TENTACOOL".
  - **Quirk 2:** the rate is blank on 234 rows. These are merged cells, where one percentage covers several rows. Example: Good Rod "60%, 30%" style shared rates.
  - **Other format notes:**
    - Species names are uppercase, with typos such as "KIRCKETOT", "REGIGIAS", "Mahogony" and "Seafom".
    - Levels look like "Lv. 2", "Lv. 2, Lv.4" or "Lv. 20-25".
- **Methods and row counts:** Grass 398, Floor (caves and buildings) 155, Surf 121, Super Rod 108, Good Rod 103, Old Rod 58.
  - There are **no** time-of-day, Headbutt, Rock Smash, Swarm or Radio columns.
- **Location order.** 92 unique locations in sheet order; "Ruins of Alph (Outdoors)" appears twice.

  New Bark Town, Route 29, Cherrygrove City, Route 30, Route 31, Violet City, Sprout Tower, Route 32, Ruins of Alph (Outdoors), Ruins of Alph (Indoors), Union Cave, Union Cave Extended, Route 33, SLOWPOKE Well, SLOWPOKE Well Extended, Ilex Forest, Route 34, Route 35, National Park, Route 36, Route 37, Ecruteak City, Burned Tower, Bell Tower, Route 38, Route 39, Olivine City, Route 40, Route 41, Whirl Islands, Cianwood City, Route 42, Mt. Mortar, Mt. Mortar (Extended), Route 43, Lake of Rage, Route 44, Ice Path, Blackthorn City, Dragon's Den, Route 45, Route 46, Dark Cave, Dark Cave Extended, Route 47, Route 48, Tohjo Falls, Route 27, Route 26, Victory Road, Vermilion City, Route 6, Route 7, Celadon City, Route 16, Route 17, Route 18, Route 8, Route 5, Route 4, Cerulean City, Route 24, Route 25, Route 11, Route 12, Route 13, Route 14, Route 15, Fuchsia City, DIGLETT's Cave, Route 2, Viridian Forest, Viridian City, Route 22, Route 1, Pallet Town, Route 21, Cinnabar Island, Route 20, Route 19, Seafoam Islands, Route 9, Route 10, Rock Tunnel, Route 3, Mt. Moon, Route 28, Mt. Silver, Mt. Silver Cave, Cliff Cave, Cliff Edge Cave, Cerulean Cave.
- **Coverage.** About 312 distinct species appear in the wild. The rest of the 493 come from gifts, eggs, evolutions, quests and Pal Park.
- **UPR log area names.** UPR's own log names each encounter set ("Set #1 - New Bark Town Surfing (rate=15)", 869 sets in the HGSS map-name scheme). This is useful for mapping ROM encounter files to route names.

## 4. SoulLink rules (common rule set) [SRC: Nuzlocke University, Bulbapedia/PokéBase summaries; the variants are community conventions]
- **Base Nuzlocke rules**
  - Only the first encounter per route or area counts.
  - A fainted Pokémon is dead: release it or put it in a permanent "graveyard" box.
  - Nickname everything (optional).
  - A blackout or whiteout ends the run for both players.
- **Link rule.** The two players' first encounters on the same route become a **linked pair**.
  - If one player fails the encounter (it faints, flees, or no catchable Pokémon is left), the partner's catch is also forfeit (boxed or released).
- **Death.** If one Pokémon of a pair dies, its partner dies too, even if healthy.
- **Box link.** Pairs are always together in the party or together in the PC. Party sizes therefore always match (max 6 pairs).
- **Type rule (most popular variant).** No two Pokémon across **both** parties may share a **primary type**. Stricter variant: no shared type at all. Lenient variant: only within each pair.
  - Randomizers make this rule bite. The tool should check it by current type (after evolution).
- **Dupes clause.** If the first encounter is a species already caught, or of an evolution line already caught or failed, re-roll until a new one appears. Variants:
  - per player, or "either player owns it"
  - a limit on re-rolls per area
  - it usually applies only if *both* players' encounters are dupes, or each player re-rolls independently (decide up front)
- **Shiny clause.** A shiny may always be caught, outside the route limit, and is usually unlinked. Some groups allow it to replace a pair member.
- **Starters.** The starter is a free first pair.
  - In randomizers both players get random starters, and those form pair #1.
  - Route 29 is often treated as the first "real" route.
- **Gifts, statics and legendaries.** Variants: count them as that area's encounter (common), allow them as an extra unlinked "free" mon, or ban them.
  - The hack has many gifts: the PC starters each badge, plus post-game legendaries. A clear rule is needed. Common choice: a gift counts as the encounter for its location, and both players must take the same gift for a link.
- **Level caps (common).** Don't over-level the next gym leader's ace. Use the table above: 15 / 20 / 24 / 30 / 35 / 35 / 42 / 46 / E4 52–58 / Lance 60 / Kanto 62–64 / Blue 70 / Red 88.
  - Often the cap counts whole-party levels, and Rare Candies are only allowed up to the cap.
- **Other common rules**
  - Battle style Set (no free switch on KO).
  - No items in battle (optional).
  - No legendaries in the party unless they are linked.
  - Trades between the two players are banned.
  - Pairs must be caught at the same time or before moving on.
  - "Gift = encounter".
  - Fishing, Surf and cave floors count as separate encounters per method (optional; the default is one per area).

## 5. Canonical HGSS progression (route checklist, English in-game names) [knowledge; standard order, the game allows some flexibility]

### Johto
1. New Bark Town
2. Route 29
3. Cherrygrove City
4. Route 30
5. Route 31
6. Violet City
7. Sprout Tower
8. **Falkner**
9. Route 32
10. Ruins of Alph
11. Union Cave
12. Route 33
13. Azalea Town
14. Slowpoke Well
15. **Bugsy**
16. Ilex Forest
17. Route 34
18. Goldenrod City
19. **Whitney**
20. Route 35
21. National Park (Bug-Catching Contest)
22. Route 36
23. Route 37
24. Ecruteak City
25. Burned Tower
26. **Morty**
27. Route 38
28. Route 39
29. Olivine City
30. Olivine Lighthouse
31. Route 40
32. Route 41
33. Whirl Islands
34. Cianwood City
35. **Chuck**
36. Route 47 / Route 48 / Safari Zone (optional)
37. Olivine City **Jasmine**
38. Route 42
39. Mt. Mortar
40. Mahogany Town
41. Route 43
42. Lake of Rage
43. Team Rocket HQ
44. **Pryce**
45. Goldenrod Radio Tower
46. Route 44
47. Ice Path
48. Blackthorn City
49. **Clair**
50. Dragon's Den
51. Route 45
52. Route 46
53. Dark Cave
54. Route 27
55. Tohjo Falls
56. Route 26
57. Victory Road
58. Indigo Plateau (**Will, Koga, Bruno, Karen, Lance**)
59. Optional Johto areas: Bell Tower (Ho-Oh, needs the Clear Bell), Whirl Islands (Lugia, needs the Silver Wing), Embedded Tower, Cliff Edge Gorge / Cliff Cave, Sinjoh Ruins, Battle Frontier (Route 40)

### Kanto (S.S. Aqua from Olivine)
1. Vermilion City
2. **Lt. Surge**
3. Route 6
4. Saffron City
5. **Sabrina**
6. Route 5
7. Cerulean City
8. Route 24
9. Route 25 (Cerulean Cape)
10. Route 9
11. Rock Tunnel
12. Route 10
13. Power Plant
14. Cerulean Gym (Machine Part)
15. **Misty**
16. Lavender Town (Radio Card / Poké Flute)
17. Route 8
18. Route 7
19. Celadon City
20. **Erika**
21. Route 16
22. Route 17 (Cycling Road)
23. Route 18
24. Fuchsia City
25. **Janine**
26. Route 15
27. Route 14
28. Route 13
29. Route 12
30. Route 11 (Snorlax)
31. Diglett's Cave
32. Pewter City
33. **Brock**
34. Route 3
35. Mt. Moon
36. Route 4
37. Route 2
38. Viridian Forest
39. Viridian City
40. Route 22
41. Route 1
42. Pallet Town
43. Route 21
44. Cinnabar Island
45. Route 20
46. Seafoam Islands (**Blaine**; his gym moved here in HGSS)
47. Route 19
48. Viridian City **Blue**
49. Route 28 (after 16 badges)
50. Mt. Silver
51. **Red**
52. Cerulean Cave (after beating Red)

### Order in the hack's own spreadsheet
In practice, use the spreadsheet's location order from section 3. It matches how the hack groups areas, including "Union Cave Extended", "Mt. Mortar (Extended)", "Dark Cave Extended", "Mt. Silver Cave", "Cliff Cave" and "Cliff Edge Cave".

---

## Test artifacts
The ROM-analysis scripts and test builds used for this research were temporary and are not part of the repository.
