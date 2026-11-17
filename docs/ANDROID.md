# souldew for Android (work in progress)

Goal: one app (APK) that plays Game Boy, Game Boy Color and GBA games with souldew's live tracking and SoulLink sync,
with the game filling the screen, on-screen touch controls and the other controls in an overlay. No Termux, no browser.

The UI already does this on a touch screen (`web/lib/platform.mjs` `IS_TOUCH`, `.touch-play` in `web/styles.css`, the
on-screen pad in `web/player.html`). What is missing is the app around it.

## Shape

```
APK
├─ MainActivity      full-screen WebView (immersive, landscape-friendly), loads http://127.0.0.1:<port>/
├─ NodeService       foreground service that starts the souldew server (server/index.mjs) inside the app
└─ assets/souldew/   server/, shared/, web/, node_modules (engine.io, socket.io, mqtt, htm) – no tools/, no Electron
```

- The emulator is the browser one (EmulatorJS cores, WebAssembly) inside the WebView – no native cores on Android.
- Data lives in the app's private storage (`SLS_DATA_DIR`), ROMs are added through the system file picker
  (copied into the library), like "Add files" in the desktop app.
- RetroArch is not used (tried on the `android-retroarch` branch: separate app, no in-app controls).

## The Node question

souldew's server needs Node ≥ 22.15 (`package.json` engines). The runtime that can live inside an APK is
[nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile): its newest release is **Node 18.20.4**
(`nodejs-mobile-v18.20.4-android.zip`: `libnode.so` per ABI plus headers). So either

1. run the server on Node 18, or
2. build a newer Node for Android ourselves (large, slow, not started).

Option 1 is the plan, and it holds up. Checked on this PC with a real Node 18.20.4 (Windows):

- `server/index.mjs` starts, and the status, library, live, native and 3DS routes, `/`, `/player.html` and the
  page modules all answer.
- The suite (`node --test test/*.test.mjs`, 625 tests): 597 pass. The 21 that don't are not app code:
  - 18 test files don't load: 14 import `registerHooks` from `node:module` and 4 import `crc32` from `node:zlib`
    (Node 22 features in the test code – the app code already falls back when `zlib.crc32` is missing). Those files
    were not run on Node 18 at all.
  - 2 tests use the Node 22 form of `mock.timers`.
  - `discoverRoots` fails on this Windows PC on Node 22 as well.
- nodejs-mobile is built **without ICU**: regexes with `\p{L}` / `\p{N}` throw "Invalid property name" (found on the
  tablet: `shared/routes.mjs` and `shared/trophies.mjs` crashed the server at start; both now fall back to Latin ranges
  when the property regex can't be built). Keep new server/shared code free of `\p{…}` (or guard it the same way);
  `normalize()`, `Intl` and `localeCompare` are also reduced on such builds.
- Two things only look like problems on Node 18 and need a flag in tests, not in the app: there is no global
  `crypto` (`web/lib/sync.mjs` and `invitecode.mjs` are browser modules the tests load in Node; the WebView has it,
  as long as the page is a secure context – `http://127.0.0.1` is) and `fetch` to `localhost` doesn't fall back to
  IPv4 (the app's WebView will use `http://127.0.0.1:<port>` directly).

So the Android build can bundle the server as it is. `engines` (>=22.15) is only a declaration; the bundled Node is 18.

## What the app has (and what it leaves out)

- **Server and web app**: the unchanged souldew server on nodejs-mobile, shown in a full-screen WebView (landscape,
  immersive, ROMs through the system file picker – no storage permission needed).
- **Game Boy, Game Boy Color, Game Boy Advance, DS**: the built-in browser emulator (EmulatorJS) with the on-screen pad.
- **Randomizer** (Gen 1–7): UPR ZX and the bridge converted to DEX (`scripts/android-assets.mjs`) and run by Android's
  own runtime. `server/lib/toolchain.mjs` uses `dalvikvm64`, not `app_process`: `app_process` appends the device's
  `dalvik.vm.heapsize` (512 MB) after any `-Xmx`, `dalvikvm` takes the heap as given. The heap has to fit into the low
  4 GB of address space: `-Xmx1800m` is the most that starts (1900m aborts), and with it Omega Ruby randomizes in about a
  minute (a 1.9 GB game written to the app's folder). Checked on a Snapdragon 8 Gen 3 tablet.
- **3DS** (arm64 only): `ctrhost` (`native/ctr-host`) and Azahar's libretro core with `native/azahar-patch/*.patch`, built by
  `scripts/build-ctr-android.mjs` and packed as `libctrhost.so` / `libazahar_libretro.so`: Android lets an app run and
  `dlopen` files only from its native library folder (`NodeService` hands the path over as `SLS_NATIVE_DIR`,
  `server/lib/ctr.mjs` looks there). Needs Vulkan (the system's `libvulkan.so`). The page gets an on-screen pad
  (`web/lib/ctrpad.mjs`: Circle Pad, D-pad, A/B/X/Y, L/R, Start/Select).
- **Left out**: the native fast player (`tools/native`, DS/GBA/GB through retrohost), the Electron shell and its updater,
  external emulators (Azahar, melonDS, mGBA), OBS overlays (no OBS for Android – the Stream section is hidden). Settings ›
  Controls and the keyboard help are hidden on touch screens too.

### Things that differ on Android and are easy to break

- **No ICU in nodejs-mobile**: regexes with `\p{L}` / `\p{N}` throw "Invalid property name". Keep new server/shared code
  free of them (or guard like `shared/routes.mjs` does); `normalize()`, `Intl` and `localeCompare` are reduced too.
- **Only `lib*.so` files in the native library folder can be run**, and Android refuses code from files the app can write:
  the randomizer jar is made read-only before it is used.
- **The file picker must not filter by type**: the WebView turns the page's `.gba,.nds,…` into MIME types and only `.zip`
  has one, so every ROM would be greyed out. `MainActivity` opens the picker for `*/*`.
- **Memory**: a 3DS game needs about 2 GB free for the randomizer plus the game's 2 GB copy on disk.

## Building

Needs: Node 22, a JDK 21, the Android SDK (platform 36, build-tools 36, NDK 27.2.12479018, CMake 3.22.1), and for the 3DS
part git, CMake ≥ 3.25 and Ninja.

```
node scripts/fetch-nodejs-mobile.mjs      # Node 18 for Android (SHA-256 pinned) → android/app/libnode
node scripts/build-ctr-android.mjs        # 3DS host + Azahar core → android/app/ctr/arm64-v8a (long; --host-only skips the core)
node scripts/android-assets.mjs           # server, web app, randomizer → android/app/src/main/assets
cd android && ./gradlew assembleDebug     # app/build/outputs/apk/debug/app-debug.apk
```

`./gradlew assembleRelease -PsouldewAbis=arm64-v8a` builds the phone-only release APK (the default is arm64 + x86_64, for
emulators). The version comes from `android/version.properties` (`1.0.0` → versionCode 10000). On Windows set
`$env:JAVA_HOME` to the JDK 21 first. `scripts/android-install.ps1` does the build, installs on a connected device and
saves its log (USB debugging on; some phones ask for a confirmation on the screen for each install).

If the Azahar checkout (`_ref/azahar-<tag>`) was patched by an older version of the patches, reset it
(`git checkout -- .` inside it) before building again: the script applies each patch once.

## GitHub Actions and releases

The Android app has its **own version** (`android/version.properties`, e.g. `1.0.0`; versionCode = major·10000 + minor·100 +
patch), separate from the desktop app's `package.json` version and `v*` tags. Release notes live in `android/CHANGELOG.md`.

- `.github/workflows/android.yml` builds the signed APK (`souldew-<version>-android-arm64.apk`) on every push that touches the
  app, the server or the web app, and on demand. The Azahar core (10–40 min) is cached on the patches, the host source and the
  build script.
- **Making a release**: bump `versionName` in `android/version.properties`, add a `## <version>` section to
  `android/CHANGELOG.md`, commit, then
  ```
  git tag android-v1.0.0 && git push origin android-v1.0.0
  ```
  `.github/workflows/android-release.yml` checks that the tag, the version file and the changelog agree and that the signing
  key is set, builds the APK, verifies it is **not** signed with the debug key, and creates a **draft** GitHub release with the
  APK and the notes. Look at it, then press *Publish*. (The desktop `release.yml` no longer builds Android.)
- **Signing**: set the repository secrets `ANDROID_KEYSTORE_B64` (`base64 -w0 souldew.jks`), `ANDROID_KEYSTORE_PASSWORD`,
  `ANDROID_KEY_ALIAS` (and `ANDROID_KEY_PASSWORD` if it differs). Create the key once
  (`keytool -genkeypair -v -keystore souldew.jks -alias souldew -keyalg RSA -keysize 4096 -validity 36500`) and keep it
  safe: an app signed with another key can't be updated. Without the secrets the APK is signed with the debug key – fine for
  testing, refused for a release.
- **Updating a phone**: install the new APK over the old one (same key: runs, games and settings stay). A build signed with a
  different key (for example a debug build from a PC) has to be uninstalled first, which deletes the app's data.
- Licences: Azahar is GPL-2.0-or-later, souldew GPL-3.0; the corresponding source of the 3DS libraries is the Azahar tag
  plus `native/azahar-patch/*.patch` in this repository.

## Not done yet / open

- Play Store or F-Droid packaging (an AAB, a store listing, a privacy policy for the app).
- 3DS: tested with Omega Ruby only; sound, speed and save states on slower chips; a phone without Vulkan can't run it.
- The 18 test files that don't load on Node 18 (`registerHooks`, `zlib.crc32`, `mock.timers` in the tests themselves).
- Fullscreen and the landscape lock inside the WebView on other devices.
