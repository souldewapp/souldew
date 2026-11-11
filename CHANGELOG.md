# Changelog

`npm run release` takes the release notes from the section of the version being released.

## 2.3.1

- **German, French, Italian and Spanish FireRed/LeafGreen are read live** (Feuerrote/Blattgrüne, Rouge Feu/Vert
  Feuille, Rosso Fuoco/Verde Foglia, Rojo Fuego/Verde Hoja – also randomized): they showed "No live data for this
  game". Their memory layout is now in the table – the team, battles, the place sign and the Rare Candy cheat. The
  addresses come from two trackers that run on these versions and agree; no such ROM was at hand to check them in a
  running game, so please report it if something looks off.
- **Run & Bun: the starter and your catches are filed** (also in other expanded-engine hacks, issue #3):
  about every second Pokémon was read as an egg – Run & Bun stores the IVs one bit further on than the original
  games – and never reached the run, and the search for the team gave up after half a minute without one, long
  before the starter. Checked in the game: Chimchar lands under "Starter", a Zigzagoon caught on Route 101 under
  "Route 101". Pokémon whose names the game shortens (Corviknight, Crabominable, Fletchinder …) are recognised, and the
  title screen no longer claims you are in Petalburg City.
- **Enter every Pokémon the game holds by hand**: the species picker only offered the base game's generation – no
  Sinnoh starters in Run & Bun. It now follows the ROM: up to #905 in Run & Bun, the Gen 4/5 Pokémon of Light
  Platinum, the randomizer's Pokémon, and a hack's own creatures (Mariomon) under the names the game gives them.
- **More ROM hacks in the library**: Too Many Types, Too Many Types 2, Super Mariomon and Mariomon are recognised, and
  a hack's details now say how far live tracking works for it (read live, with limits, not checked yet) and what to
  know – e.g. that Too Many Types' own types aren't known to souldew. A patch named after the longer of two hacks
  ("Too Many Types 2") is linked to that one.
- **Randomizing Gen 5 ROM hacks with the Fairy type works** (Blaze Black 2 Redux, Volt White 2 Redux …): creating a
  randomized run stopped with "Randomizer error: … attackingType is null" (or "pk is null"). The randomizer now keeps
  the hack's Fairy type as it is, uses the Gen 6 type chart for its choices, and leaves static encounters unchanged
  where the hack rewrote their scripts. Checked with every preset.

## 2.3.0

**Turbo music fixed** – the known issue from 2.2.0.

- Turbo music no longer sounds fast after a scene change (GBA and Game Boy): with the new timing the
  emulator's sped-up sound came out chopped or at a jumping pitch, and slowing it back down didn't help. While
  fast-forwarding every game now plays its sound at normal pitch, skipping ahead, as DS games already did: "Music
  continues" plays the music recorded at 1× over it, and "Sped-up original" is that skipping sound.
- "Music continues" now never plays the game's own fast-forward sound – that skipping sound is what sounded like
  sped-up music after a scene change on Windows, and why "Music continues", "Sped-up original" and "Plain" then all
  sounded the same. A song that wasn't heard at normal speed yet keeps the music that played before it; only with
  nothing recorded at all is fast-forward quiet until the music has played for a few seconds at 1×.
- When the emulator rebuilds its sound (on Windows when the graphics driver or Chromium's GPU process restarts), the
  turbo music keeps every song recorded so far instead of starting from nothing.
- The chosen turbo audio mode always wins: "Mute" silences every path to the speakers while fast-forwarding, and a
  turbo mixer that fails on the audio thread is replaced by a fresh one instead of letting the sped-up sound through.
- "Save diagnostics" now shows how the sound is wired: every audio context the emulator made (and when), what feeds
  the speakers, the levels heard per path, graphics-context losses and GPU process restarts with their times, and a
  "leak" entry whenever sound was heard while fast-forwarding where the mode says silence.
- Sound cards set to 96 or 192 kHz: the emulator's sound now runs at 48 kHz (44.1 kHz for 88.2/176.4 kHz) and the
  browser converts it once – the same as on most PCs, with half the work for the turbo mixer or less.

**Turbo without a brake** – players asked for it.

- New in Settings › General: "Full-power turbo" (on by default). While fast-forwarding the game may now use almost
  every display frame in full instead of three quarters of it, in short slices that let the app's own work and your
  clicks and keys go first. DS games on DeSmuME (HeartGold/SoulSilver, Black/White) also skip drawing more of the
  frames nobody sees at that pace. Turbo never steps down with it ("Step down when the computer can't keep up" is off
  then). Normal speed is unchanged. Measured on an M1: GBA "Max" 12.2× → 13.6×, HeartGold's opening 4× 3.2× → 3.6×,
  and the app stays at the display's full rate while fast-forwarding (45 → 75 Hz on a 75 Hz screen), with clicks
  answered about twice as fast.
- Where a game still can't reach the chosen speed, the computer itself is the limit: the built-in DS emulator runs on
  a single CPU core, and HeartGold in town takes ~10 ms per frame on an M1 – about 1.6× is all it can do there, with or
  without the brake. We measured every way around it on an M1 (HeartGold, Azalea Town): frame skipping (none or 9 of
  10 frames – the same), DeSmuME's 3D and timing options, the single- and multi-threaded build and the older
  "DeSmuME 2015" all take 9.7–10.8 ms per frame; melonDS still can't load HeartGold/SoulSilver and Black/White saves
  ("A communication error has occurred") and is slower than DeSmuME in the 2D menus anyway.

**Honest turbo steps**

- When a scene can't keep up, the speed in the bar now shows what the game really runs at ("≈1.6×", in yellow) –
  the step you picked moves to the small tag above it ("set: 4×").
- souldew remembers per game how fast fast-forward gets on your computer. Steps it never reaches there aren't offered
  any more: with HeartGold on an M1, `T` and the +/– buttons go 1× → 4× instead of 2× → 3× → 4× that all play at the
  same ~1.6×. The highest step stays – it runs as fast as your computer manages, up to 4×, so lighter scenes (menus,
  houses, the opening) still get the full speed – and says so when you switch to it ("4× – this computer usually
  manages ≈1.6× in this game"). On a faster computer, or in games that hold the steps, nothing changes.

**"You are here" for Black/White and Black 2/White 2, read from the game itself** – thanks to a player's report (#1).

- The place sign in the play view now works in Black, White, Black 2 and White 2 (randomized ones included): the
  route or town you're in, and in a run whether its first encounter is still open.
- souldew now reads the place names and which map belongs to which place straight from the ROM – the same names the
  game shows when you enter a route – instead of only from its own tables. ROM hacks with their own maps and place
  names show those. The Gen 4 games in other languages than English can now show the sign as well, in the game's
  language (not tested on every language yet).
- A game without location data no longer says "Location appears once you're in the game" forever; it says the
  location isn't available for this game yet.

**Smaller changes**

- The library no longer links to ROM hacks or their download pages. The known hacks are still listed – with
  description, difficulty and base game – so souldew recognises them and applies a patch file you add yourself.
- New run rule "Show type matchup help" (on by default): the host decides when creating a SoulLink or Nuzlocke whether
  the battle helper in the play view shows how your moves land, what hits you and the weakness charts. Off hides it
  for every player. Only the host can change it later (board › Rules), and every change shows up in the log. Runs
  from before keep the help.
- The "Buy me a coffee" button gets a visitor now and then (every few minutes, never while a game is running):
  Pikachu peeks out of the cup, Snorlax naps on it, a Poké Ball wobbles and pops, or Jigglypuff hops by – a few
  seconds of pixel art, no sound, and none at all with "reduce motion" or once you've clicked the button.
- From the fifth start on, souldew may now and then (rarely, at most every few days) thank you in a window that looks
  suspiciously like an old shareware "please buy a license" nag – in full old-Windows glory, on every system. souldew is
  and stays free: the window only jokes, offers the coffee link and closes with Esc. Settings › About turns it off.

**Open stream API – build your own overlay layout**

- Streamers who design their own OBS layout can now read souldew's data without its preset look: the current run as
  JSON (players with their colours, every team with species, nickname, level, HP, status, held item, shiny and
  sprites, linked groups, graveyard, encounters per route, each player's location and battle, badges and level cap,
  the run's rules), plus a live event stream for catches, deaths, level-ups, evolutions, location changes, battles
  and wild encounters, badges and the run's start and end. The same sprites the app shows (front, back, shiny,
  menu icons, artwork, animated) come from the app too.
- Safe by default: on this computer only, read-only, nothing private (no ROMs, saves, file names, invite codes or
  spoilers); other websites need a token you can switch on. Address, copy button and docs are on the Stream page
  under "Open API"; the documentation with copy-paste examples is in [docs/STREAM_API.md](docs/STREAM_API.md).

**A surprise on legendary encounters**

- Meet a legendary or mythical Pokémon while live tracking runs, and there's a 1-in-4 chance that the stream overlay
  shows a small pop-up with a joke about that very Pokémon ("Mewtwo has entered the chat. souldew's developer has
  entered the coffee shortage.") and the "Buy me a coffee" link with a QR code – for about 12 seconds, at most once
  every 20 minutes and once per species per run. Jokes in all five languages.
- It shows in the Alerts overlay – no extra setup, and no spoiler on the Stream page. On by default; Settings › About
  switches it off. Custom layouts get it as an event from the open API.

**Trophies: a Pokédex across all your runs, achievements and medals** – new in the sidebar.

- **Pokédex:** all 1025 species, with what you caught (evolutions count) and saw in every SoulLink and Nuzlocke on
  this computer – first catch with run, date, route and nickname, shinies, how many died, and your whole history with
  each one. Filter by generation, type and caught/seen/missing, or search. Species from Gen 6 on aren't in any game
  souldew plays yet: they're listed, greyed out, and say so.
- **102 achievements** in six categories – from "Gotcha!" and "Eight for Eight" over "Untouchable" (win without a
  death), "Soul Twins" and "Chaos Tamer" to the classics: "Rollout Trauma" (Whitney's Miltank), "Abra Used
  Teleport", "Too Much Water", "Bird Jesus", "It's a Magikarp Moment" and a few secret ones. All of them fit the usual
  Nuzlocke rules (dupes clause, type rule), and "complete" Pokédex goals leave out event-only mythicals like Mew. Five
  rarities, unlock dates, progress bars, and a toast when one unlocks while you play (no sound).
- **Medals** in a medal case – one per category, one per regional Pokédex and the Champion's Medal, from bronze to
  master. Original pixel-art designs.
- Everything is worked out from the runs souldew already records (catches, deaths and their cause, badges, the end
  of a run, the live data while you play) and stays on your computer. Your existing runs count from the first start;
  a deleted run's catches stay in the Pokédex.

**ROM hacks and randomized games: names straight from the game** – checked game by game (see
[docs/TESTED_GAMES.md](docs/TESTED_GAMES.md)).

- A randomized game or a ROM hack now always shows the game's own place names – also when the game's language
  isn't the app's. New catches are named the same way, so catches in Black/White and Black 2/White 2 get their place
  name instead of a number, and a hack's catches get the hack's names.
- GBA ROM hacks that put other Pokémon into the game (Light Platinum: 141 of them, e.g. Venipede where Weedle was, or
  Turtwig) now show the Pokémon the game shows – before, souldew showed the original game's Pokémon of that number, or
  nothing. A Pokémon only the hack has gets the hack's name.
- **Run & Bun** is tracked live: team, battle and the place sign, although it runs on an expanded engine with its own
  Pokémon numbers and memory layout (souldew finds both from the game itself). Other hacks on an expanded engine
  (Unbound, Radical Red …) are tried the same way and say that live tracking doesn't support them when their team
  can't be found – never wrong Pokémon. Catches can still be entered by hand.
- Hacks that add the **Fairy type** or retype Pokémon (Renegade Platinum, Blaze Black 2 Redux) now show the hack's own
  types on the board, in the battle panel and for the type rule – with Fairy's matchups in the battle helper.
- Blaze Black 2 Redux (and Gen 5 hacks like it) now gets the place sign.
- Game Boy hacks that moved the game's memory (Crystal Legacy keeps it 11 bytes further on) are read again: team,
  battle, place sign and the Rare Candy cheat find their data from the hack's own code. Before, Crystal Legacy showed
  no team and a place stuck on New Bark Town.
- Black/White and Black 2/White 2: the battle panel shows the opponent's HP as it goes down (it stayed full) and your
  Pokémon's HP during the fight, and no longer keeps showing the opponent for up to two minutes after a fight.
- Platinum, Pearl, Black and Black 2: battles show up on the panel when they start and leave it when they end (a wild
  battle in Platinum showed up late and stayed after running away), and a catching demo is no longer taken for your
  own battle.
- Red/Blue/Yellow and Gold/Silver don't store where a Pokémon was caught: a catch right after a wild battle is now
  filed under the place the sign shows (before, every catch went to the inbox). Gifts and trades still go to the inbox.


**Known issues**

- **Run & Bun:** during a battle the panel shows your own Pokémon's HP from before the fight, and whether it's a wild
  or a trainer battle is a guess.
- **Unbound, Radical Red and other hacks on an expanded engine** weren't tested in the running game. If souldew can't
  find their team, the play view says live tracking doesn't support the hack – enter catches by hand there.
- **Renegade Platinum** and **Light Platinum:** place names, Pokémon and types come from the game file and were
  checked there; a full play-through with catches is still to come.
- **White 2:** team and places are checked, the battle panel only in Black 2 so far.
- Original games in languages other than English and German count as modified: they show the game's own place
  names (in the game's language) instead of the translated ones.
- **Trophies from earlier runs:** catches, deaths, badges and wins of runs from before 2.3.0 count, but moments
  souldew only notices while you play (a Pokémon at 1 HP, a badge won underleveled, a monotype team) don't. In older
  SoulLinks souldew guesses which player you were until you open the run once.

## 2.2.0

**Smoother built-in emulator, and fast-forward at its full speed** – mainly on Windows.

- Fast-forward reaches the speed you pick: on many Windows PCs 4× got stuck around 2.2× (and 2× around 1.7×), because
  the emulator timed its frames with browser timers that only fire every ~15.6 ms there. souldew now times the game
  itself from the display's frames – the same on every system and at every refresh rate (60, 75, 120, 144, 165 Hz).
- No more stutter and crackling at normal speed when the computer is briefly busy: the game no longer waits on its
  sound, keeps a larger sound buffer (128 ms) and makes its sound at the sound card's own rate.
- New turbo step "Max" (Settings): as fast as the computer can, without any limit.
- New turbo audio option "Plain": the emulator's own sound with no recording or mixing at all – for anyone who
  hears crackling.
- "Save diagnostics" now includes the sound card (sample rate, latency), the display's refresh rate, the speed really
  reached, drop-outs in the sound and the longest gap between frames.
- Turbo audio "Music continues" works every time again (2.2.0-beta.1): when the emulator rebuilt its sound – e.g. after
  the graphics process restarted on Windows – the old music mixer kept playing on its own, and Mute or turning
  fast-forward off no longer reached it. The old one is now shut down. Game Boy square-wave music and short sound
  drop-outs while fast-forwarding are no longer mistaken for broken sound, which made the next fast-forward silent.
  "Save diagnostics" now records the mixer's state after every speed, mode and pause change, and how many mixers run.

**Graphics backend setting (Windows and Linux)** – thanks to a player's report.

- New in Settings › General: "Graphics backend" – Automatic (default), Direct3D 11, Vulkan or OpenGL on Windows,
  Automatic, OpenGL or Vulkan on Linux. If the built-in emulator stutters or its sound crackles, try Vulkan: on one
  player's Windows PC that made both go away. The change applies after a restart ("Restart now").
- If souldew doesn't open with the chosen backend (twice in a row) or its graphics process keeps crashing, the next
  start uses "Automatic" again and says so once.
- "Save diagnostics" now includes the graphics backend, Chromium's GPU status and the graphics card with its driver.
- For experiments: the environment variable `SOULDEW_CHROMIUM_FLAGS` passes extra Chromium switches (see
  docs/DEVELOPMENT.md).

**mGBA live data works again for GBA games** – on every system the panel stayed at "Waiting for the script …".

- mGBA 0.10 reports GBA games as "AGB-BPEE" (Game Boy as "CGB-…"/"DMG-…"); souldew only knew "BPEE", so it never
  asked the script for the party. Scripts loaded from older versions work again once souldew is updated.
- The mGBA panel says what is going on: no connection yet, script connected but no game data yet, no live data for
  this game, an outdated script or one from another installation tried to connect. The script's path has Copy and
  Show in Finder/Explorer buttons (on Windows it lives in a hidden folder).
- The script (version 2) reconnects on its own when souldew restarts or uses another port, tries every port souldew
  may use, finishes partial sends instead of losing data, re-announces the game after a reset and writes what it
  does and why it failed into mGBA's scripting window. It also avoids an mGBA 0.10 bug that closes a reused socket
  number when an old socket is garbage-collected.

**Rare Candy cheat** – for Nuzlockes and SoulLinks with level caps.

- "Add 99 Rare Candies" in the play screen's new cheats menu puts them straight into the bag in game memory – Gen 1–5, randomized games included. A run allows it
  only once its rules say so (off by default), and every use shows up in the log for all players ("Tim used a
  cheat: 99 Rare Candies"), as does switching the rule. The bag is checked before anything is written; games
  whose bag isn't known say "Not available for this game".

**Linux support** – souldew now runs on 64-bit Linux, the Steam Deck included, and plays together with Mac and
Windows players.

- Two packages: an **AppImage** (`souldew-<version>-linux-x86_64.AppImage`) that runs on almost every distribution and
  updates itself, and a **.deb** for Debian, Ubuntu, Mint and friends (updates through the download page).
- Automatic updates for the AppImage: the app downloads the new one next to the old file, checks its signature and
  checksum and swaps it on restart – under the old file name, so desktop and Steam shortcuts keep working. The same
  signed update feed serves all three systems; apps on 2.0 and 2.1 keep updating as before.
- Steam Deck: the window fits the 1280×800 screen; add the AppImage as a non-Steam game to play in Game Mode.
- "Search my PC" on Linux looks in your (localized) Downloads, Desktop and Documents, in EmuDeck's, RetroDECK's and
  RetroArch's folders and on SD cards and USB drives.
- One-click melonDS and mGBA install the official Linux AppImages; emulators from your distribution (`mgba-qt`,
  `melonDS`) and from Flathub are found too. The Java runtime for the randomizer ships with the app.
- The window uses your desktop's own title bar; shortcuts use Ctrl, the menu bar appears with Alt, and the app speaks
  of the file manager. Your data lives in `~/.config/SoulLink Studio`.

**Known issue:** on some Windows PCs, "Music continues" plays the sped-up music during fast-forward, especially
after a scene change. A fix follows in the next update. Until then another turbo audio option helps ("Mute" or
"Plain (no extra processing)").

## 2.1.0

**Windows support** – souldew now runs on Windows 10 and 11 (x64), and Mac and Windows players can play together.

- Windows installer (`souldew-2.1.0-win-x64-setup.exe`): installs per user without admin rights, with Start menu and
  desktop shortcuts. It isn't signed with a paid certificate, so SmartScreen may ask once (More info › Run anyway).
- The window matches the dark look on Windows too (window buttons in the app's colours); all shortcuts use Ctrl, and
  the app speaks of Explorer and "Search my PC" there.
- "Search my PC" looks in Downloads, Desktop, Documents, OneDrive (files already on the PC – online-only files
  aren't downloaded) and the folders of RetroArch, RetroBat and LaunchBox.
- One-click melonDS and mGBA install the official Windows builds; the Java runtime for the randomizer ships with the
  app, set to UTF-8 so the same seed builds the same game on Mac and Windows.
- Automatic updates on Windows: the app downloads the new installer, checks its signature and checksum and installs
  it on restart. One signed update feed serves both systems – apps on 2.0 keep updating as before.
- More robust on every system: file names that Windows forbids are cleaned up, short file locks (antivirus) no
  longer break saving, and library folders on a whole drive work.

## 2.0.0

- New name: **souldew** (formerly SoulLink Studio), with a new boot animation and sound. Data, runs and saves carry
  over.
- SoulLinks for 2–4 players and solo Nuzlockes with their own rule editor.
- Invite with a 6-digit code; the joiner's name is the one everyone sees.
- Live tracking: team, levels, HP and status conditions, battle panel with the real opponent, catch rules (type rule
  including partners at the same place, dupes, shiny clause), "You are here" location sign.
- Turbo music that follows the scene; for DS games the current song is played from the ROM's sound archive.
- Stream page: streamer mode, OBS overlay widgets with live push, a Pokélink-compatible bridge and a documented
  overlay API.
- Collapsible sidebar that hides itself in fullscreen.
- "Save diagnostics" for bug reports.
- Automatic updates from GitHub Releases (signed), a "Buy me a coffee" link in the sidebar and links to the project
  in Settings › About.
