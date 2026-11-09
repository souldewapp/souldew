# Changelog

`npm run release` takes the release notes from the section of the version being released.

## 2.2.1

**Turbo music fixed** – the known issue from 2.2.0.

- Turbo music no longer sounds fast after a scene change (GBA and Game Boy): with the new timing the
  emulator's sped-up sound came out chopped or at a jumping pitch, and slowing it back down didn't help. While
  fast-forwarding every game now plays its sound at normal pitch, skipping ahead, as DS games already did: "Music
  continues" plays the music recorded at 1× over it, a song not heard at 1× yet plays from the game itself at its
  normal pitch, and "Sped-up original" is that skipping sound.
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
