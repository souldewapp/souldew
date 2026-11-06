# Developing souldew

Building from source, releasing updates and how the code is organised. Back to the [README](../README.md).

## Building from source

Requirements: **Node.js ≥ 22.15** and git; macOS (Apple silicon) to build the DMG, Windows 10/11 x64 to build the Windows installer, Linux x64 to build the AppImage and the .deb. The server, the tests and `npm run app` run on macOS, Windows and Linux.

```sh
npm ci                 # install dependencies
npm run app            # Electron app in development mode (data in the Electron profile)
npm start              # server only, UI in the browser (data in the project folder: runs/, library/)
npm test               # all tests (node --test "test/*.test.mjs")
npm run lint           # ESLint (eslint.config.mjs)
node scripts/extract-i18n.mjs   # sync UI strings, list missing/stale translations
npm run dist           # macOS: build the DMG (fetches the Java runtime on first run)
npm run dist:win       # Windows: build the NSIS installer (fetches the Windows Java runtime on first run)
npm run dist:linux     # Linux: build the AppImage and the .deb (fetches the Linux Java runtime on first run)
```

| Command | Purpose |
|---|---|
| `PORT=… SLS_DATA_DIR=… NO_OPEN=1 node server/index.mjs` | A second instance with its own data folder – e.g. to test several players on one machine |
| `npm run app -- --user-data-dir=/some/folder` | The Electron app with a separate profile and data folder (never point it at your real data while testing) |
| `npm run dist` | Runs `scripts/fetch-jre.mjs` (Temurin JRE 17 for arm64 into `tools/jre/`) and electron-builder. `scripts/dmgbuild-wrapper.mjs` moves the DMG window's hidden files below the visible area; the background image is rendered with `node scripts/render-dmg-background.mjs` from `build/dmg-background.html`. |
| `npm run dist:win` | On Windows: `scripts/fetch-jre.mjs x64` (Temurin JRE 17 for x64 into `tools/jre/win32-x64`) and electron-builder → `dist/souldew-<version>-win-x64-setup.exe` (NSIS, one click, per user, no admin rights) plus `dist/win-unpacked/`. Unsigned: there is no code-signing certificate (SmartScreen, see the README). |
| `npm run dist:linux` | On Linux: `scripts/fetch-jre.mjs x64` (Temurin JRE 17 into `tools/jre/linux-x64`) and electron-builder → `dist/souldew-<version>-linux-x86_64.AppImage`, `dist/souldew-<version>-linux-amd64.deb` and `dist/linux-unpacked/`. The [Linux workflow](../.github/workflows/linux.yml) builds both on `ubuntu-latest`. |
| `node scripts/smoke-app.mjs dist/win-unpacked/souldew.exe` | Starts a built app with a throwaway profile, checks that its server answers, the page loads and the bundled Java runs the randomizer, then quits it. Refuses to run while something already listens on port 47390 (your installed souldew). Also takes `dist/linux-unpacked/souldew`, an `.AppImage`, or `--dev` for `npm run app` from the checkout – on a Linux machine without a screen under `xvfb-run -a`. |
| `node scripts/build-icon-ico.mjs` | Rebuilds `build/icon.ico` (16–256 px) from `build/icon.png` – macOS only (uses `sips`); commit the result. |
| `npm run release` | Sign and package an update (see below) |

**Windows from a Mac:** `npx electron-builder --win nsis --x64` also works on macOS (without the Windows Java runtime, which only `fetch-jre.mjs` on Windows can build) – good for checking the packaging, not for shipping. The real installer comes from Windows or from the [Windows workflow](../.github/workflows/windows.yml), which builds it on `windows-latest`, smoke-tests the unpacked and the installed app and keeps the installer as an artifact.

**Linux** is built and tested by the [Linux workflow](../.github/workflows/linux.yml) on `ubuntu-latest` under a virtual display (xvfb): `npm run app` from the checkout, the unpacked app (incl. the one-click emulator AppImages), the AppImage (and that it recognises itself for the updater) and the .deb (install, start, removal). Chromium's sandbox needs unprivileged user namespaces; Ubuntu 24.04 restricts them, so the workflow allows them (`sysctl kernel.apparmor_restrict_unprivileged_userns=0`) – on such a machine `npm run app` needs the same, or `npm run app -- --no-sandbox`. The AppImage adds `--no-sandbox` by itself where namespaces are missing; the .deb sets up `chrome-sandbox`.

**Platform differences in the code:** the window frame and the menu (`electron/main.mjs`: traffic lights vs. Windows' title bar buttons over the page vs. the Linux desktop's own frame; no visible menu bar on Windows and Linux, the shortcuts stay), the updater (`electron/updater.mjs`: swap the .app vs. run the NSIS installer vs. replace the AppImage), "Search my Mac / PC" (`server/lib/library.mjs` → `discoverCandidates`; on Linux also EmuDeck, RetroDECK, RetroArch and SD cards), the emulator downloads (`server/lib/emulator.mjs`; on Windows/Linux unpacked in JavaScript by `server/lib/archive.mjs` / `sevenzip.mjs`), and texts and shortcuts in the UI (`web/lib/platform.mjs`: `IS_MAC` / `IS_WIN` / `IS_LINUX`, `shortcut('Mod+B')` → ⌘B / Ctrl+B; `styles.css` `.platform-win32` / `.platform-linux`). The tests run on Ubuntu and Windows in CI; `test/windows.test.mjs` and `test/linux.test.mjs` check each platform's path rules on any OS.

New visible text always goes through `t('area.key', 'English default', { vars })`; then translate it for de/fr/es/it – `node scripts/extract-i18n.mjs` must end with "0 missing, 0 stale" for every language. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Releasing updates

The app checks `https://github.com/souldewapp/souldew/releases/latest/download/latest.json` at start and every four hours (also via **Settings › About › Check for updates**). One feed serves every platform: the macOS DMG at the top level (all that souldew ≤ 2.0 reads), the Windows installer under `assets["win32-x64"]` and the Linux AppImage under `assets["linux-x64"]` (each `{ name, url, sha256, size }`). Older apps ignore `assets` (2.0) or the keys they don't know (2.1 drops `linux-x64`), and the signature covers every field, so they accept the new feed unchanged (proven in `test/update.test.mjs` and `test/linux.test.mjs` with the released code in `test/fixtures/update-2.0.0/` and `update-2.1.0/`). The .deb is uploaded to the release but isn't in the feed.

- **macOS:** downloads the DMG, verifies the feed's signature, size and SHA-256, puts the new app next to the old one and swaps them on restart.
- **Linux (AppImage):** downloads `souldew-<version>-linux-x86_64.AppImage` into the folder of the running AppImage (`$APPIMAGE`, trusted only while the app runs from inside its mount `$APPDIR`) as a hidden `.<name>.update`, verifies signature, size and SHA-256 (again before "Restart now"), makes it executable and on restart – or when the app quits after "Later" – renames it over the old file and starts it. The file keeps its name and path, even when that name carries the old version number, so desktop entries and Steam shortcuts keep working. `minVersion` doesn't apply. A folder the user can't write to gets the verified AppImage in Downloads instead (shown in the file manager); a .deb install, an unpacked build and `npm run app` get the download page.
- **Windows:** downloads `souldew-<version>-win-x64-setup.exe`, verifies signature, size and SHA-256 (again right before running it) and runs it silently once the app is really quitting (`will-quit` – after the unsaved-progress question can no longer keep the game open): on "Restart now" with `/S --updated --force-run` (it waits for souldew to close, replaces it and starts the new version), after "Later" on the next quit without `--force-run`. `minVersion` doesn't apply on Windows – the installer updates any version. A copy that wasn't installed with the installer (e.g. `win-unpacked`) gets the verified installer shown in Explorer instead.

Your data stays untouched on both.

**One-time setup** (already done for this repository: `updates.repo` and `updates.publicKey` are in `package.json`):

1. The repository must be **public** – release files have to be downloadable without login.
2. The signing key was created with `npm run release -- --init-key`: the private key lives in `~/.config/soullink-studio/release-key.pem`, its public half is `updates.publicKey`. **Back the key up and never commit or share it** – without it you can't publish updates the apps accept.
3. Add the key's contents as the repository secret `SLS_RELEASE_KEY` (Settings › Secrets and variables › Actions) so GitHub Actions can sign releases.

**Publishing a version** – with GitHub Actions ([`.github/workflows/release.yml`](../.github/workflows/release.yml)):

1. Bump `version` in `package.json` and add a `## <version>` section to [CHANGELOG.md](../CHANGELOG.md) – that becomes the release notes.
2. Commit, then tag and push: `git tag v2.1.0 && git push origin main v2.1.0`.
3. The workflow runs lint and tests and builds the Windows installer on `windows-latest` and the AppImage + .deb on `ubuntu-latest` (each smoke-tested).
   - If the repository variable `MACOS_RELEASE` is `true` (macOS runners work again) and the secret `SLS_RELEASE_KEY` is set, it also builds the DMG, signs one `latest.json` for all three and publishes the release. Installed apps pick it up within a few hours.
   - Otherwise (today: macOS runners don't start for this repository) it creates a **draft** release with the Windows installer and the Linux packages – invisible to the apps. Finish it on your Mac:

     ```sh
     npm run dist                                                        # the DMG
     gh release download v2.1.0 --pattern '*-win-x64-setup.exe' --pattern '*-linux-*' --dir dist   # what the workflow built
     npm run release                                                     # signs one latest.json for all three
     gh release upload v2.1.0 dist/release-2.1.0/souldew-2.1.0-arm64.dmg dist/release-2.1.0/latest.json
     gh release edit v2.1.0 --draft=false --latest
     ```

**By hand** (same result, no workflow): build the DMG (`npm run dist`) on the Mac, the installer (`npm run dist:win`) on Windows and the AppImage + .deb (`npm run dist:linux`) on Linux – or download them from a run of the [Windows](../.github/workflows/windows.yml) / [Linux workflow](../.github/workflows/linux.yml) – and put them into `dist/`. Then `npm run release` (or `npm run release -- --notes "…"`; `--dmg path` / `--win-exe path` / `--appimage path` / `--deb path` for other locations) hashes them, writes and signs `latest.json` and prints the `gh release create …` command with all files. Without a Windows installer or an AppImage in `dist/` it warns and leaves that platform out of the feed (those apps then don't see that version; `--no-win` / `--no-linux` silence the warning). The release must not be a draft or prerelease, otherwise "latest" doesn't point to it.

The app verifies the Ed25519 signature of `latest.json` before using its download URL or checksum; an unsigned or altered feed is rejected. It only accepts HTTPS, refuses downgrades and only installs a DMG with the matching checksum, bundle ID and exact announced version, or an installer with the matching checksum and size. `"minVersion"` in the feed (`npm run release -- --min-version 2.1.0`) sends older installs to the download page instead. Pushing commits alone doesn't reach the apps – only a published release does.

## Project layout

The Electron shell (`electron/`) starts the local server (`server/`) in the same process. The UI is Preact + htm without a build step (`web/`). Code shared by server and UI – patcher, save parser, live RAM parser, routes, player slots – lives in `shared/`, data from PokeAPI and libretro-thumbnails in `shared/data/`.

| Folder / file | Contents |
|---|---|
| `electron/` | App shell: window, menu, updater (macOS, Windows, Linux AppImage), IPC guards |
| `server/` | Local HTTP server: library, runs, saves, builds (patch + randomizer), overlay API, Pokélink bridge |
| `web/` | The UI (`app.mjs`, `views/`, `lib/`), the emulator page `player.html`, `overlay.html`, translations in `i18n/` |
| `web/lib/run.mjs` | Run logic: encounters, pairs/groups, deaths, rules, checks, stats, live reconciliation (`applySnapshot`) |
| `web/lib/sync.mjs`, `web/lib/doc.mjs` | Live sync (WebRTC + relay) and the shared run document (last writer wins per key) |
| `web/lib/invitecode.mjs` | Inviting with a 6-digit code |
| `web/lib/turboaudio.mjs`, `web/lib/sdat*.mjs` | Turbo music: recorded loops and the DS sound-archive player |
| `web/lib/pacer.mjs` | Frame pacing for the built-in emulator: runs the core's frames from the display's refresh (RetroArch's own sleeps are off – they depend on the system timer) |
| `shared/live/` | Reading team, battle and location from game memory (Gen 1–5) |
| `shared/overlay.mjs` | The overlay snapshot (what stream tools may see) |
| `server/lib/build.mjs` | Building runs (patch, randomizer, one ROM per player) |
| `tools/upr/`, `tools/upr-bridge/` | Universal Pokémon Randomizer ZX and souldew's Java helper for it |
| `research/` | Notes and data gathered while building the trackers |
| `build/` | App icon (`icon.icns` macOS, `icon.ico` Windows), DMG background and the README graphics (`build/readme/art.html` → `node scripts/render-readme-art.mjs` → `docs/media/`) |
| `test/` | `node --test` suites |

**Compatibility note:** the app was called "SoulLink Studio" before. Protocol identifiers keep that name on purpose so different versions can still play together: the sync app ID `soullink-studio-v1`, the invite-code salt `soullink-studio/invite-code@1`, the run-pack format `soullink-studio/run-pack@1`, the data folder `~/Library/Application Support/SoulLink Studio` (Windows: `%APPDATA%\SoulLink Studio`, Linux: `~/.config/SoulLink Studio`) and the release-key path `~/.config/soullink-studio/` (on Windows the same path under your user folder). Don't rename them.
