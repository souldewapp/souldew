# Changelog

`npm run release` takes the release notes from the section of the version being released.

## Unreleased

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
