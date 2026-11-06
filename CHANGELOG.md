# Changelog

`npm run release` takes the release notes from the section of the version being released.

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
