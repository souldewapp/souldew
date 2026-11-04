# Changelog

`npm run release` takes the release notes from the section of the version being released.

## 2.1.0

**Windows support** – souldew now runs on Windows 10 and 11 (x64), and Mac and Windows players can play together.

- Windows installer (`souldew-2.1.0-win-x64-setup.exe`): installs per user without admin rights, with Start menu and
  desktop shortcuts. It isn't signed with a paid certificate, so SmartScreen may ask once (More info › Run anyway).
- The window matches the dark look on Windows too (window buttons in the app's colours); all shortcuts use Ctrl, and
  the app speaks of Explorer and "Search my PC" there.
- "Search my PC" looks in Downloads, Desktop, Documents, OneDrive and the folders of RetroArch, RetroBat and
  LaunchBox.
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
