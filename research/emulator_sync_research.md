# Emulator, sync and randomizer research (SoulLink HeartGold app)

Researched 2026-10-16. Legend: **[verified]** = checked in source code, binaries or a live test today; **[doc]** = from official docs or release notes; **[uncertain]** = from memory, third-party sites or not tested; check before relying on it.

Scratch copies of the sources read are in the session scratchpad (not part of the project).

---

## 1. Native NDS emulators

### melonDS (recommended for desktop)
- **Latest stable: 1.1** (released 2025-11-18) [verified via GitHub API]. Master is still active (last commit 2026-08-24).
  - Download: https://github.com/melonDS-emu/melonDS/releases/download/1.1/melonDS-1.1-macOS-universal.zip (24 MB)
  - Windows: `melonDS-1.1-windows-x86_64.zip` (an `-aarch64` build also exists) on the same release page.
- **macOS arm64:** the zip contains `melonDS.app` with a universal Mach-O binary (`x86_64 arm64`) [verified with lipo]. It is **ad-hoc signed and not notarized**: `spctl` rejects it [verified]. On first launch, run `xattr -dr com.apple.quarantine /Applications/melonDS.app`, or use System Settings → Privacy & Security → "Open Anyway".
- **JIT:** CMake turns JIT on for ARM64, Apple included (it is off only for x86_64 on Apple) [verified CMakeLists.txt], so Apple Silicon gets the ARM64 JIT.
- **BIOS / FreeBIOS:** config key `Emu.ExternalBIOSEnable` defaults to `false` [verified Config.cpp]. melonDS then uses its built-in FreeBIOS (`src/FreeBIOS.h`) plus generated firmware, so no BIOS dump is needed for DS mode. Commercial DS games generally run on FreeBIOS. **[uncertain]** I found no HGSS-specific FreeBIOS bug report. If something odd happens, dump real `bios7.bin`/`bios9.bin`/`firmware.bin` and enable external BIOS.
- **Known HeartGold issues** (searched in melonDS issues):
  - #2691 (2026-06, v1.1): HeartGold black screen after leaving the bedroom **in DSi mode**. Use DS mode, which is the default.
  - #1866: someone's patched ROM hack showed "no card"/save errors. Maintainers point at DSi mode or a bad patch. Keep DS mode.
  - #458: black lines in Gen 4 games with the **OpenGL renderer + upscaling**. The software renderer is fine.
  - #2653: RTC not working **on the Android app** (a different project).
- **Battery save location:** `EmuInstance::getAssetPath()` uses the config value `SaveFilePath` (per instance, `[Instance0].SaveFilePath` in `melonDS.toml`). When it is empty (the default), the `.sav` goes **next to the ROM** as `<romname>.sav` [verified]. You can change it in the UI under Config → "Path settings" (also covers savestate and cheat paths).
  - Config dir on macOS: `QStandardPaths::ConfigLocation/melonDS` = `~/Library/Preferences/melonDS/melonDS.toml` [verified main.cpp `pathInit`; Qt path mapping is standard].
  - A folder named `portable` next to `melonDS.app` switches it to portable mode [verified].
- **Flush timing after an in-game save** [verified SaveManager.cpp, EmuThread.cpp]:
  - The emulator thread calls `CheckFlush()` after **every frame**. That copies the dirty SRAM into a secondary buffer and stamps `TimeAtLastFlushRequest = time(nullptr)`.
  - A SaveManager thread wakes every **100 ms** and writes the file once **≥ 2 s (whole-second `time()` resolution) have passed since the last write request**.
  - Result: the `.sav` on disk is rewritten roughly **2–3 s after the game stops writing**. The file is written in full, with no `.bak` or rename, so a watcher should debounce (wait for stable mtime/size or about 500 ms) before reading.
- **Save-state hotkeys** [verified Window.cpp]:
  - **Shift+F1…F8** save to slot 1–8; **F1…F8** load slot 1–8.
  - **Shift+F9** saves to a file; **F9** loads from a file; **F12** undoes the last state load.
- **Fast-forward:** hotkeys `HK_FastForward` (hold) and `HK_FrameLimitToggle` (toggle), with config `FastForwardFPS` defaulting to 1000 [verified Config.cpp]. **[uncertain]** I couldn't find a default key binding in the 1.x source; bind it yourself under Config → Input and hotkeys (older versions used Tab).
- No scripting/RAM API for external tools, so a companion app must read the `.sav` (or OCR the screen). melonDS 1.1 also supports usrcheat.dat AR cheats.

### DeSmuME
- Last stable **0.9.13** (2022-05-23): https://github.com/TASEmulators/desmume/releases/tag/release_0_9_13 [verified]. The repo is still active (commits on 2026-09-11), but there's no newer stable release.
- `desmume-0.9.13-macOS.dmg` contains a universal `DeSmuME.app` (`x86_64 i386 ppc7400 x86_64h arm64`) [verified with lipo]. The Cocoa port is old but runs natively.
- Saves are `.dsv` (raw save plus a DeSmuME footer), not `.sav`. **[uncertain]** On macOS they live in `~/Library/Application Support/DeSmuME/Battery/` by default.
- Known HGSS issues:
  - #787: lost progress when running the emulator from inside a zip.
  - #857: Sacred Gold hack crashes.
  - **[uncertain]** Save-type autodetect problems ("save error") are a recurring forum topic; the fix is setting Backup type to "Auto" or "FLASH 4Mbit".
- Slower than melonDS with JIT. Fine as a fallback, not a first choice.

### NooDS
- Rolling build "release" updated **2026-08-09**, with builds for mac, Windows, Linux, Android, iOS, Switch, Vita and Wii U: https://github.com/Hydr8gon/NooDS/releases [verified]. `noods-mac.zip` → `NooDS.dmg` → `NooDS.app`, **arm64-only** [verified].
- Saves `<rom>.sav` **next to the ROM** by default (`Settings::savesFolder = 0`; 1 = "saves" folder) [verified cartridge.cpp/settings.cpp]. The desktop UI **writes changed saves every 3 s** [verified noo_frame.cpp].
- HGSS: #88 (darkness/Flash effect broken) is closed and fixed in 2022. #173 (HGSS doesn't work) is **Wii U port only**.
- Lightweight, but less accurate than melonDS and has no JIT. Good as a second choice, and it has iOS/Android builds.

### Mobile
- **iOS – Delta:** latest GitHub release v1.6 (2024-07). Its DS core is MelonDSDeltaCore, which Delta 1.6 updated to melonDS 0.9.5 [doc: Delta releases page]. 1.7 (DS online multiplayer) shipped via AltStore PAL/App Store [uncertain on details]. Needs bios7/bios9/firmware files in Delta settings [third-party guide].
  - MelonDSDeltaCore is still maintained (commit 2026-10-11, Xcode 27 fix; a 2025-09 commit added `readMemoryAtAddress:size:`).
  - Saves stay inside Delta's sandbox. Export via Files or Delta's Dropbox/Google Drive sync, so there's no automatic link to our app.
- **Android – melonDS Android** (rafaelvcaetano/melonDS-android): **2.0.1** (2026-05-06) [verified]. Issue #2653 reports HeartGold RTC not working there.
- **DraStic:** pulled from Google Play (Feb 2025 per Time Extension); sideload-only APK [third-party, uncertain].
- NooDS also has Android/iOS builds.

### Recommendation
- **Desktop (both players): melonDS 1.1**, DS mode, software renderer (or OpenGL at 1x), FreeBIOS default, `SaveFilePath` left empty or pointed at a folder our Node backend watches.
- Our backend should `fs.watch` the `.sav` and parse the Gen4 save (two 0x40000 halves; pick the newer block by save counter). That works the same for melonDS and NooDS (both raw `.sav`), and also for EmulatorJS/melonds (`.sav`). DeSmuME needs its `.dsv` footer stripped.
- The friend on Windows uses the same melonDS version, so savestates are compatible if ever needed.
- Mobile is a "bring your own .sav" path only.

---

## 2. In-browser emulation

### EmulatorJS
- **Latest stable v4.2.3** (2025-07-05). Pre-release **v4.3.0-pre** came out 2026-05-17 with large rewrites: ES modules, cores not interchangeable, "event for when game save is updated", "fixed save flushing interval" [verified release notes]. Master `data/src/consts.js` says `4.3.0-pre`.
  - **Use 4.2.3 for stability.** Function names below are checked against the v4.2.3 tag; differences in master are noted.
- **NDS cores:** `nds: ["melonds", "desmume", "desmume2015"]`; `EJS_core = "nds"` → melonds [verified consts / docs].
  - The EJS **melonds core is the libretro fork at melonDS 0.9.3** (`EmulatorJS/melonDS` ← libretro/melonDS, last commit 2024-12) [verified CMakeLists].
  - Core files, 4.2.3 builds from 2025-06-14 [verified CDN]: `melonds-wasm.data` (1.2 MB 7z: `melonds_libretro.js` + 5.3 MB wasm), `-thread`, `-legacy` and `-thread-legacy` variants. desmume: 6.1 MB wasm, save ext `dsv`; desmume2015: save ext `dsv`.
  - melonds core.json has `"save":"sav"`.
  - Performance **[uncertain]**: melonds is the usual recommendation. All run as interpreters in wasm (no JIT), so expect full speed on an M-series Mac but not on weak machines; the `-thread` builds need `EJS_threads = true` plus COOP/COEP headers (`SharedArrayBuffer`).
- **BIOS:** docs list bios7/bios9/firmware as "required" for melonds. But the core source says: `"Missing bios/firmware in system directory. Using FreeBIOS."`, and it continues [verified libretro.cpp]. Supply BIOS via `EJS_biosUrl` (zip) if needed.
- **Offline self-hosting:**
  - Option A: the release `https://github.com/EmulatorJS/EmulatorJS/releases/download/v4.2.3/4.2.3.7z` (303 MB, includes all cores + minified `emulator.min.js/css`).
  - Option B (lighter): npm `@emulatorjs/emulatorjs@4.2.3` (data/ with `loader.js`, `src/`, `compression/`, `localization/`, `emulator.css`; the loader falls back to non-minified `src/*.js`) **plus** `@emulatorjs/core-melonds@4.2.3` (contains `melonds-wasm.data`, `-thread`, `-legacy`, `reports/`). Copy its files into `data/cores/` (`.data` files at `data/cores/`, reports at `data/cores/reports/melonds.json`).
  - Core lookup is `<EJS_pathtodata>/cores/<core>[-thread][-legacy]-wasm.data` [verified emulator.js]. If missing, it **falls back to `https://cdn.emulatorjs.org/<version>/data/cores/...`**, so ship the files locally to be truly offline. It also fetches `https://cdn.emulatorjs.org/stable/data/version.json` when on localhost (update check, harmless if it fails).
  - Cores are cached in IndexedDB keyed by `reports/<core>.json` `buildStart`.
- **Config globals** [verified loader.js]: `EJS_player` (selector), `EJS_core`, `EJS_gameUrl` (URL string, or a File/Blob/ArrayBuffer/Uint8Array [verified]), `EJS_pathtodata`, `EJS_biosUrl`, `EJS_gameName`, `EJS_startOnLoaded`, `EJS_threads`, `EJS_loadStateURL`, `EJS_defaultOptions`, `EJS_disableLocalStorage`, `EJS_volume`, `EJS_Buttons`, `EJS_DEBUG_XX`. Master only: `EJS_fixedSaveInterval`.
  - Note: Definitive HG is 127 MB, so browser memory will be about 2–3× that.

```html
<div id="game"></div>
<script>
  EJS_player = "#game"; EJS_core = "melonds"; EJS_pathtodata = "/ejs/data/";
  EJS_gameUrl = "/rom/defhg.nds"; EJS_gameName = "defhg"; EJS_startOnLoaded = true;
  EJS_onGameStart = () => { /* emulator running */ };
  EJS_onSaveSave = ({ save, screenshot, format }) => { /* user pressed Save-file button; replaces the download */ };
</script>
<script src="/ejs/data/loader.js"></script>
```

- **JS API** (`window.EJS_emulator`, `EJS_emulator.gameManager`) [verified v4.2.3 GameManager.js]:
  - (a) **Battery save:** `gameManager.getSaveFile()` → `Uint8Array|null`. It first calls `saveSaveFiles()` (`cmd_savefiles` flushes SRAM to `/data/saves/...`), then reads `FS.readFile(getSaveFilePath())`. `getSaveFile(false)` reads without flushing. Related: `getSaveFilePath()` (wasm `save_file_path`) and `saveSaveFiles()`.
    - Push-style alternative: `EJS_emulator.on("saveSaveFiles", bytes => …)` fires on **every** `saveSaveFiles()` call (periodic interval or manual) with the save bytes.
    - The periodic interval is setting `save-save-interval`: options 0/30/60/300/600/900/1800 s, **default 300 s** (v4.2.3). Set it via `EJS_defaultOptions = {"save-save-interval": "30"}` [uncertain key passthrough], or just poll `getSaveFile()` every few seconds and hash-compare.
    - Master (4.3.0-pre) adds `EJS_onSaveUpdate` + `enableSaveUpdateEvent()`, which fires `{hash, save, screenshot, format}` only when the save's hash changes.
  - (b) **Load a save:** same as the UI button:
    ```js
    const gm = EJS_emulator.gameManager, p = gm.getSaveFilePath();
    // mkdir each parent of p via gm.FS.mkdir if missing
    if (gm.FS.analyzePath(p).exists) gm.FS.unlink(p);
    gm.FS.writeFile(p, bytes);
    gm.loadSaveFiles(); // wasm refresh_save_files
    ```
    Then `gm.restart()` so the game re-reads it. `/data/saves` is an IDBFS mount with `autoPersist`, so saves also persist in the browser.
  - (c) **Save states:** `gm.getState()` → `Uint8Array` (`Module.EmulatorJSGetState()`); `gm.loadState(u8)`; `gm.quickSave(slot)` / `gm.quickLoad(slot)`; `gm.supportsStates()`. UI events: `EJS_onSaveState({screenshot,format,state})` and `EJS_onLoadState`.
  - Also available: `gm.restart()`, `gm.toggleFastForward(1|0)`, `gm.setFastForwardRatio(n)`, `gm.screenshot()`, `gm.simulateInput(player, index, value)`, `gm.setVariable(opt, val)`, `gm.getFrameNum()`, and `EJS_emulator.pause()`/`play()`.
  - (d) **RAM access:** **not exposed.** The core's `retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM)` returns `NDS::MainRAM` (4 MB), but the wasm export list contains only EJS helpers (`_cmd_savefiles`, `_save_file_path`, `_load_state`, `_simulate_input`, …). There's no `_retro_get_memory_data` [verified by grepping the 4.2.3 melonds/desmume core JS]. `Module.HEAPU8` *is* exported, but `MainRAM` is heap-allocated (`new u8[0x1000000]`), so you'd have to scan for it (fragile). Parsing a savestate (melonDS state contains RAM) is possible but also fragile. **Use the battery save.**
  - (e) **Events** [verified loader.js]: `EJS_ready`, `EJS_onGameStart` ("start"), `EJS_onSaveState`, `EJS_onLoadState`, `EJS_onSaveSave` (only when the user clicks "Save save files"; returning a handler suppresses the download), `EJS_onLoadSave` (replaces the file picker), `EJS_onExit` (4.3), `EJS_onSaveUpdate` (4.3). Generic: `EJS_emulator.on(name, fn)` for `saveSaveFiles`, `saveDatabaseLoaded` (4.3), etc.

### desmume-wasm (44670/desmume-wasm)
- Last commit 2023-10-20 and no releases. The repo holds only the C++ (`desmume/wasm-port/main.cpp`), with **no build script and no JS frontend** ("Latest HTML/JS/CSS hosted on https://ds.44670.org"). GPLv2.
- Its exports are attractive: `getSymbol(7)` → `MMU.MAIN_MEM` (direct RAM), `savGetPointer()`, `savGetSize()`, `savUpdateChangeFlag()`, `runFrame(...)`.
- But there are no savestates and it's unmaintained; you'd have to build it with Emscripten and write a frontend. **Not recommended** except as a research reference.

### Verdict
Native melonDS + `.sav` watching is the most reliable path. EmulatorJS 4.2.3/melonds is a workable "no-install" fallback using `getSaveFile()` polling.

---

## 3. P2P sync without hosting a server

### Live checks today [verified]
- `https://0.peerjs.com/peerjs/id` returns an ID (PeerServer cloud is up, location "EU").
- **PeerJS's built-in TURN does not exist anymore.** `peerjs@1.5.5` `lib/util.ts` defaultConfig has `stun:stun.l.google.com:19302` + `turn:eu-0.turn.peerjs.com:3478` / `turn:us-0.turn.peerjs.com:3478` (user `peerjs`/`peerjsp`). Both hostnames return **no A record** (NOERROR/NODATA on 8.8.8.8 and 1.1.1.1). So in practice PeerJS is **STUN-only**.
- **openrelay.metered.ca now resolves to 192.0.2.1 (RFC 5737 TEST-NET sinkhole)**, so the old free `openrelayproject` TURN is dead. `staticauth.openrelay.metered.ca` timed out. `standard.relay.metered.ca` is alive but returns 401 to the open credentials (needs a Metered account/API key).
- Public relays used by Trystero answered WebSocket upgrades in a rough probe (HiveMQ, mosquitto, nos.lol, webtorrent tracker).

### PeerJS
- **v1.5.5** (npm `peerjs`, 2025-06-07). Ships `dist/peerjs.min.js` (UMD → `window.Peer`); `dist/bundler.mjs` has bare imports (`webrtc-adapter`, `peerjs-js-binarypack`, `@msgpack/msgpack`), so it can't be a plain module script without an import map.
- Default host `0.peerjs.com:443`. The free cloud has no SLA [doc: "for production host your own"]. With no TURN, two peers behind **symmetric NAT / CGNAT** (common on mobile hotspots and some ISPs/corporate networks) **cannot connect**.
- Not recommended: single point of failure (one cloud host) and a dead default TURN.

### Trystero (recommended)
- **v0.26.0** (2026-10-04, active; 0.25.x monthly). **Packages changed:** `trystero` = Nostr strategy (it re-exports `@trystero-p2p/nostr`); other strategies are `@trystero-p2p/mqtt`, `/torrent`, `/supabase`, `/firebase`, `/ipfs`, `/ws-relay` [verified npm + README]. The old `trystero/mqtt` subpaths now go through `deprecate.mjs`.
- 0.26.0 changed the wire format, so **both peers must run the same version**. It also adds a default `maxReceiveBytes` of 256 MiB.
- Default ICE is STUN only: `stun.l.google.com`, `stun1/stun2.l.google.com:19302`, `stun.cloudflare.com:3478` [verified core/src/peer.ts]. **No TURN by default**; pass `turnConfig`.
- Default relays:
  - **Nostr**: about 30 public relays.
  - **MQTT**: `broker.emqx.io:8084/mqtt`, `public.cloud.shiftr.io` (public:public), `broker.hivemq.com:8884/mqtt`, `test.mosquitto.org:8081/mqtt`.
  - **Torrent**: `open.ftorrent.com`, `tracker.webtorrent.dev`, `tracker.openwebtorrent.com`, `tracker.btorrent.xyz`, `tracker.files.fm:7073`.
- README ranking: Nostr (most redundant) > MQTT > BitTorrent > IPFS. Supabase/Firebase are middle ground (free accounts). Signaling is encrypted with AES-GCM (`password` option); data goes peer-to-peer over encrypted DTLS.
- **Serving as a plain `<script type=module>`:** npm dist files import bare specifiers (`@trystero-p2p/core`, `@noble/secp256k1`, `mqtt`). Instead, **vendor the self-contained release bundles**: `https://github.com/dmotz/trystero/releases/download/0.26.0/trystero-nostr.min.js` (75 KB, ESM, no imports [verified]) and `trystero-mqtt.min.js` (399 KB, includes mqtt.js). Other bundles: `-torrent`, `-supabase`, `-firebase`, `-ipfs`, `-ws-relay`. Exports: `joinRoom`, `selfId`, `getRelaySockets`, `defaultRelayUrls`.

```js
// public/vendor/trystero-nostr.min.js served by the Node backend
import { joinRoom, selfId } from '/vendor/trystero-nostr.min.js';

const room = joinRoom(
  { appId: 'soullink-studio-v1', password: sharedSecret /*, turnConfig: [...] */ },
  roomCode                          // e.g. 6-word code both players type in
);
const evt = room.makeAction('evt');   // JSON-serialisable payloads
const sav = room.makeAction('sav');   // binary (Uint8Array/Blob) OK, with metadata
room.onPeerJoin  = peerId => evt.send({ type: 'hello', state: localSummary }, { target: peerId });
room.onPeerLeave = peerId => markOffline(peerId);
evt.onMessage = (data, { peerId }) => applyRemoteEvent(data, peerId);
sav.onMessage = (bytes, { peerId, metadata }) => storeRemoteSave(bytes, metadata);
// later: evt.send({ type: 'encounter', route: 'R29', species: 16 });
//        sav.send(savBytes, { metadata: { sha1, savedAt } });  room.leave();
```

(Note: in 0.26 `makeAction` returns an **object** with `.send(data, {target, metadata})` and `.onMessage = (data, {peerId, metadata}) => …` [verified README 0.26]. The old `[send, receive]` array form from <=0.2x tutorials is outdated. Request/response is available via `makeAction(name, {kind: 'request', onRequest})` + `await action.request(x, {target, timeoutMs})`. `onReceive` can accept or decline large payloads.)

### Fallbacks when WebRTC fails (symmetric NAT on both sides)
1. **Cloudflare Realtime TURN** (free tier 1,000 GB/month per Trystero README; needs a Cloudflare account). Each player's local Node backend holds the TURN key and calls `POST https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers` with `Authorization: Bearer $TURN_KEY_API_TOKEN` and body `{"ttl":86400}` [doc]. The returned `iceServers` go into `rtcConfig.iceServers` (filter port-53 URLs). This is the most robust "real" fix.
2. **Relay mode over the signaling medium (zero-config).** SoulLink payloads are small (events + parsed party JSON; avoid shipping the 512 KB `.sav` routinely), so publish them AES-GCM-encrypted directly to a public MQTT broker topic derived from the room secret. Use `mqtt@5.16.1`, browser ESM at `mqtt/dist/mqtt.esm.js` [verified exports], or the Node backend's `mqtt` package. Plain WSS on 443 works through any NAT. Public brokers have no persistence or SLA, so add app-level acks/retries and keep the authoritative log locally on both sides.
3. **cloudflared Quick Tunnel:** one player runs `cloudflared tunnel --url http://localhost:PORT`, with no account [doc]. The other connects to the random `*.trycloudflare.com` URL via WebSocket. Limits [doc]: no uptime guarantee, 200 in-flight requests, **no SSE**, and the hostname changes every run. **[uncertain]** WebSocket support isn't stated on the page (it generally works).
4. **Tailscale** (both install it, free personal plan): direct NAT traversal plus always-working DERP relays; the browser talks to the friend's backend via its tailnet IP. Very reliable, but it needs an install and an account.

**Recommendation:** use Trystero Nostr (vendored bundle, shared `password`) as the primary. Fall back automatically to an MQTT relay mode if no peer connection within about 15 s. Offer optional Cloudflare TURN credentials in settings. Make the sync protocol idempotent (event IDs + Lamport/sequence numbers), since peers will often be offline at different times.

---

## 4. Universal Pokemon Randomizer ZX v4.6.1 CLI

- Release: https://github.com/Ajarmar/universal-pokemon-randomizer-zx/releases/download/v4.6.1/PokeRandoZX-v4_6_1.zip (2024-11-23; `PokeRandoZX.jar` + launchers) [verified].
  - `Version.VERSION = 322`, `VERSION_STRING = "4.6.1"`.
  - Manifest `Main-Class: com.dabomstew.pkrandom.newgui.NewRandomizerGUI`; `main()` dispatches to `CliRandomizer.invoke` when `args[0] == "cli"`.
- **Exact syntax** [verified source + ran `--help` on Java 8 arm64]:
  ```
  java [-Xmx4096M] -jar PokeRandoZX.jar cli -s <settings file> -i <source ROM> -o <output ROM> [-d] [-u <3DS update>] [-l]
  ```
  - `-s` = `.rnqs` settings file (required); `-i` / `-o` = input/output (required); `-l` = write `<output>.log` (UTF-8 BOM); `-d` / `-u` = 3DS only; `--help` = usage.
  - The output extension is auto-fixed to `.nds`, and output must differ from input for DS ROMs. Prints "Randomized successfully!" and exits 0, otherwise exit 1.
  - The launchers use `-Xmx4608M`. Add `-Djava.awt.headless=true` for headless use (worked in the test).
- **Seed:** **not settable from the CLI.** `CliRandomizer` calls `Randomizer.randomize(filename, log)`, which does `seed = RandomSource.pickSeed()` (6 bytes from `SecureRandom`). The seed is printed in the log as `Random Seed: <n>`.
  - But **`public int randomize(String filename, PrintStream log, long seed)`** exists. A tiny wrapper on the classpath can call it: `Settings.read(FileInputStream)`, `Gen4RomHandler.Factory().create(RandomSource.instance())`, `loadRom`, `settings.setCustomNames(FileFunctions.getCustomNames())`, `tweakForRom`, `new Randomizer(settings, rh, bundle, false).randomize(out, log, seed)`.
  - Load the bundle with `ResourceBundle.getBundle("com/dabomstew/pkrandom/newgui/Bundle", locale, <jar classloader>)`.
  - The installed JRE (Oracle Java 8u503 arm64) has **no `javac` but has `jjs` (Nashorn)** at `/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home/bin/jjs`, which can script this without compiling. That's how I tested it. (The project already contains `tools/upr-bridge/SoulLinkBridge.class`.)
  - GUI alternative: "Premade Seed" dialog / `.rndp` files = `writeInt(VERSION)` + `writeLong(seed)` + `writeUTF(configString)` + CustomNamesSet.
- **Settings encoding:**
  - The `.rnqs` file is `int VERSION` (4 bytes BE) + `int length` + UTF-8 settings string.
  - The settings string is Base64 of: option bytes + ROM name (ASCII, length-prefixed) + CRC32 of those bytes + checksum of `customnames.rncn`. The log line "Settings String: 322…" is `VERSION` + that string.
  - **The seed is not in the settings string or the `.rnqs`.** Older-version files are auto-migrated (`SettingsUpdater`), and newer ones are rejected.
- **Determinism** [verified empirically]:
  - Same vanilla HG ROM + same settings (random wild/starters/trainers) + seed `123456789`, run twice → **byte-identical output ROM** (SHA1 `91f47a0f…` both times) and identical logs apart from timing. Seed `987654321` → different ROM.
  - Conditions: same jar version, same input ROM bytes, same custom names file (it affects the settings checksum and trainer names). `java.util.Random` is specified to be deterministic across JVMs.
  - **[uncertain]** Not tested across machines/OS (Windows friend) or on the Definitive HG hack. To be safe, have one side randomize and share the seed + settings, then verify by comparing output SHA-1s.
- **Java requirement:** classes are major version 52 (= **Java 8**) [verified]. Java 8+ runs it; the README points to the wiki "About-Java" page for problems. Java 8u503 is installed locally and works.
