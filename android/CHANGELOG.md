# Changelog – souldew for Android

`android-release.yml` takes the release notes from the section of the version being released (`android/version.properties`).

## 1.0.0

**The first release of souldew for Android** – the SoulLink / Nuzlocke tracker and its built-in emulator as an app for phones
and tablets, no PC and no Termux needed. The server and the web app are the same souldew as on the desktop (this release
carries souldew 2.7.4), so a SoulLink works across Android, Windows, macOS and Linux players.

- **Play on the touch screen.** Game Boy, Game Boy Color, Game Boy Advance and Nintendo DS games run in the built-in
  emulator, filling the screen, with the on-screen pad on top. Speed, cheats, save states and the rest sit in a menu that
  slides in from the edges – tap the round button in the corner. Fullscreen and landscape work out of the box.
- **Nintendo 3DS.** The built-in 3DS player (Azahar) runs inside the app with an on-screen Circle Pad, D-pad, A/B/X/Y, L/R
  and Start/Select, and the touch screen works by tapping the bottom screen. It needs a 64-bit ARM phone with Vulkan and a
  fast chip. It was tested on one Snapdragon 8 Gen 3 tablet (Omega Ruby); on that GPU the hardware vertex shaders are turned
  off because the Adreno driver cannot build their pipelines – a little slower, but it does not crash. Other chips may or may
  not work.
- **Randomizer.** The Universal Pokémon Randomizer runs on Android's own runtime – Game Boy Advance, DS and 3DS games. A 3DS
  game needs about 2 GB of free space and a minute or two of memory-heavy work.
- **Adding games.** *Add files* opens the system file picker (any file type, several at once). *Search my device* looks
  through Download, Documents, ROMs and similar folders after you allow “All files access” once – it reads only file names
  and the first bytes of game files, and nothing leaves your device.
- **Live tracking and sync**, the board, the graveyard, level caps, the Discord posts and the rest work as on the desktop.
- **Made for touch.** No keyboard-only sections (controls, shortcuts, OBS overlays); the save-state board sits on top of
  the side panels; the support window fits the screen.

**What is not in the Android app:** the native fast player, external emulators (Azahar, melonDS, mGBA as separate apps), OBS
overlays, and an in-app updater – install a newer APK over the old one (same signing key, your runs and games stay). Saving
diagnostics to a file does not work yet.

**Install:** download `souldew-1.0.0-android-arm64.apk`, open it on the phone and allow installing from your browser or file
manager when Android asks. Android 7.0 or newer, 64-bit ARM.

**Support:** souldew itself – https://buymeacoffee.com/souldew · the Android app – https://buymeacoffee.com/enderain

**Source and licences:** souldew is GPL-3.0; the 3DS player bundles Azahar (GPL-2.0-or-later), built from the Azahar 2126.2
source plus the patches in `native/azahar-patch/` of this repository.
