# EmulatorJS 4.2.3: embedding API and RAM access (GB / GBC / GBA / NDS)

Researched 2026-10-17. Legend: **[verified]** = read in the vendored source or tested live today in headless Chrome
(puppeteer-core + system Chrome, macOS arm64) with the vendored files; **[doc]** = official docs or issues;
**[uncertain]** = not tested.

Source references are to the vendored, unminified files:
`web/vendor/emulatorjs/loader.js`, `web/vendor/emulatorjs/src/emulator.js` (= `E:`), `web/vendor/emulatorjs/src/GameManager.js` (= `GM:`).
The test page is `web/emu-test.html` (`?rom=<url>&core=<core>`, exposes `window.__emu`).

---

## 0. TL;DR

- Vendored in `web/vendor/emulatorjs/` (about 23 MB; see `VERSION.txt`). It works fully offline: no CDN request happens as long as the core file exists locally (E:614-632 would otherwise fall back to `cdn.emulatorjs.org`).
- **No COOP/COEP needed.** None of our 5 cores requires threads. Threads only work if you set `EJS_threads = true` *and* the page is `crossOriginIsolated`. Tested: COOP `same-origin` + COEP `require-corp` → `melonds-thread-wasm.data` loaded, and `HEAPU8` is backed by a `SharedArrayBuffer` **[verified]**.
- **No `retro_get_memory_data` export** in any core **[verified]**. RAM is still reachable via `EJS_emulator.Module.HEAPU8` (= `gameManager.Module`). We locate the RAM block once per session:
  - **NDS:** look for the ROM header that the game copies to `0x027FFA80` / `0x027FFE00`.
  - **GBA/GB:** match the RAM copy inside a savestate against the heap.

  All 5 cores were verified byte-for-byte against the savestate RAM block.
- **Recommended cores:** `melonds` for HeartGold, with `desmume2015` as the fallback for weak PCs. `mgba` for GBA. `gambatte` for GB/GBC (mGBA works for GB/GBC too).

---

## 1. Vendored files

| Path (under `web/vendor/emulatorjs/`) | What it is |
|---|---|
| `loader.js` | Entry point. Reads `window.EJS_*` and creates `window.EJS_emulator`. |
| `emulator.min.js` (420 KB), `emulator.min.css` | **Not in the npm package.** I rebuilt them with terser/clean-css from `src/`, in loader.js order (same as upstream `npm run minify`). |
| `src/*.js`, `emulator.css` | Unminified sources. Loaded instead of the `.min` files when `EJS_DEBUG_XX = true`, and used as an automatic fallback if `emulator.min.js` 404s (loader.js:56-70). |
| `compression/extract7z.js`, `extractzip.js`, `libunrar.js/.wasm` | Archive workers. **7z is required**: every core `.data` file is a 7z archive. zip handles `.zip` ROMs. |
| `localization/*.json` | UI strings (`en-US`, `de-GER`, …). |
| `cores/<core>[-thread][-legacy]-wasm.data` | 5 cores × 4 variants, about 1.0–1.25 MB each, 21 MB total. |
| `cores/reports/<core>.json` | `buildStart` (IndexedDB core cache key) and `options.defaultWebGL2`. **Needed**: without it, core caching is off and WebGL2 defaults to false. |
| `licenses/`, `VERSION.txt` | Package versions and licenses (EmulatorJS/RetroArch/melonDS GPL-3.0, DeSmuME GPL-2.0+, gambatte GPL-2.0, mGBA MPL-2.0). |

**Variant selection** (E:590-604) **[verified]**:
`filename = core + (threads ? "-thread" : "") + (supportsWebgl2 && webgl2Enabled ? "" : "-legacy") + "-wasm.data"`
- `-legacy` is the WebGL1 build. `webgl2Enabled` comes from the setting `webgl2Enabled`, or else from `reports/<core>.json → options.defaultWebGL2`.
  - melonds, desmume and desmume2015 set `defaultWebGL2: true`, so they load `-wasm.data`.
  - **mgba and gambatte have no such flag, so they always load `-legacy-wasm.data`** [verified via request log]. Keep the legacy files.
- `-thread` is the pthreads build. It is used only when `typeof SharedArrayBuffer === "function"` and the `ejs_threads` setting or `EJS_threads` is true. `requiresThreads()` lists only `ppsspp` and `dosbox_pure` (E:46-49).

Each `.data` unpacks to `<core>_libretro.js`, `<core>_libretro.wasm`, `core.json` (extensions, save ext), `build.json` (`minimumEJSVersion` 4.2.2, core build 2.0.2, built 2025-06-14) and sometimes `license.txt`.

---

## 2. Configuration globals (read once by loader.js:81-125)

```js
window.EJS_player       = '#game';                 // CSS selector of the container (E:418 setElements)
window.EJS_pathtodata   = 'vendor/emulatorjs/';    // data folder; trailing "/" is added if missing (loader.js:14-15)
window.EJS_core         = 'melonds';               // core OR system alias: nds→melonds, gba→mgba, gb→gambatte (E:2-44, getCore E:54)
window.EJS_gameUrl      = url | File | Blob | ArrayBuffer | Uint8Array; // non-string types go through toData() (E:162)
window.EJS_gameName     = 'HG-run1';               // base name for saves/states + localStorage settings key (E:254, E:4144)
window.EJS_startOnLoaded= true;                    // auto-clicks the start button (E:452-454)
window.EJS_threads      = false;                   // see §6
window.EJS_DEBUG_XX     = false;                   // true: load src/*.js, verbose core log, skip IndexedDB caches
window.EJS_language     = 'en-US';                 // file name in localization/ (German is 'de-GER')
window.EJS_disableAutoLang = false;                // quirk: browser-locale detection is skipped ONLY if this is exactly false (loader.js:131)
window.EJS_volume       = 0.5;                     // 0..1 (E:220)
window.EJS_color        = '#4a7cff';               // theme colour (setColor E:328)
window.EJS_backgroundColor = '#111';
window.EJS_Buttons      = { /* see below */ };     // → buildButtonOptions (E:1330)
window.EJS_defaultControls = {0:{8:{value:'z',value2:'BUTTON_1'}, …}}; // REPLACES the whole default map (E:221)
window.EJS_defaultOptions  = { melonds_screen_layout:'Top/Bottom', 'save-save-interval':'30', rewindEnabled:'enabled' };
window.EJS_biosUrl, EJS_gamePatchUrl, EJS_gameParentUrl, EJS_loadStateURL (url/bytes; loaded on 'start'), EJS_cheats ([[desc, code],…]),
window.EJS_CacheLimit   = 0;     // ROMs smaller than this are cached in IndexedDB "EmulatorJS-roms" (default 1 GB) → 0 disables
window.EJS_disableDatabases = true; // dummy storage for rom/bios/core caches (states DB still exists) (E:282-293)
window.EJS_disableLocalStorage = true; // don't persist/restore settings, controls, volume (see §2.2)
window.EJS_hideSettings = ['ejs_threads', …];     // ids skipped in the settings menu (E:4670)
window.EJS_noAutoFocus, EJS_fullscreenOnLoaded, EJS_softLoad (s), EJS_paths ({file: url} overrides), EJS_shaders,
window.EJS_forceLegacyCores (force WebGL1 builds), EJS_videoRotation (0-3), EJS_externalFiles ({fsPath: url})
// callbacks (loader.js:150-169)
window.EJS_ready        = () => {};    // event "ready"  (20 ms after the start button is created, E:455-457)
window.EJS_onGameStart  = () => {};    // event "start"  (end of startGame, E:1036) → EJS_emulator.gameManager exists now
window.EJS_onSaveState  = ({screenshot, format, state}) => {};  // "saveState": ONLY from the menu "Save State" button; return value ignored, but registering suppresses the default download (E:1903-1909)
window.EJS_onLoadState  = () => {};    // "loadState": menu button; registering suppresses the default file picker
window.EJS_onSaveSave   = ({screenshot, format, save}) => {};   // "saveSave": ONLY the "Export Save File" button (E:1954)
window.EJS_onLoadSave   = () => {};    // "loadSave": "Import Save File" button
// then load the script (it reads document.currentScript, so append it after setting the globals):
<script src="vendor/emulatorjs/loader.js"></script>
```

`loader.js` then runs `window.EJS_emulator = new EmulatorJS(EJS_player, config)` (loader.js:150). Only **one emulator per page** is supported, because globals such as `EJS_Runtime` and `EJS_emulator` are shared, so use one iframe per emulator if needed. To switch games, reload the iframe or page. The `exit` event calls `Module.abort()` (GM:44-59).

### 2.1 Hiding the default UI
`EJS_Buttons` keys (E:1205-1328, verified): `playPause, play, pause, restart, mute, unmute, settings, fullscreen, enterFullscreen, exitFullscreen, saveState, loadState, screenRecord, gamepad, cheat, volumeSlider` (alias `volume`)`, saveSavFiles, loadSavFiles, quickSave, quickLoad, screenshot, cacheManager, exitEmulation, netplay, diskButton, contextMenu`.
- Set a key to `false` to hide it, or pass `{displayName, icon, callback}` to add a custom button.
- `contextMenu` **cannot** be overridden (E:1345). Hide it with CSS: `.ejs_context_menu{display:none!important}`.
- The bar element `.ejs_menu_bar` stays in the DOM; `web/emu-test.html` hides `.ejs_menu_bar` with CSS too.
- The methods still work with hidden buttons, because the buttons are always created and only made invisible.

### 2.2 Settings persistence (gotcha) [verified]
Settings, controls and cheats are saved to `localStorage["ejs-<gameId||1>-<system>-<gameName|gameUrl>-settings"]`, and volume to `localStorage["ejs-settings"]` (E:4129-4156).
- `EJS_defaultOptions` is applied on the first run (tested: `gambatte_gb_colorization` and `save-save-interval` both took effect).
- **Values stored by a previous session win**: after a user change, the localStorage value overrides `EJS_defaultOptions` on the next load.
- To force our values, set `EJS_disableLocalStorage = true`, or call `EJS_emulator.changeSettingOption(k, v)` after start.
- `EJS_gameID` (number) should be set, otherwise E:4153 warns.

---

## 3. Runtime API (after `EJS_onGameStart`)

```js
const emu = window.EJS_emulator;           // class EmulatorJS
const gm  = emu.gameManager;               // class EJS_GameManager (GM:1)
const Module = gm.Module;                  // === emu.Module (Emscripten module) [verified]
```

### 3.1 Events
`emu.on(name, fn)` (E:407) / `emu.callEvent(name, data)` (E:412) returns the listener count. Events emitted [verified by grep]:

| Event | When | Source |
|---|---|---|
| `ready` | Start button created | E:456 |
| `start-clicked` | Start clicked or auto-started | E:460 |
| `saveDatabaseLoaded` (FS) | IDBFS `/data/saves` mounted | E:921 |
| `start` | Game running | E:1036 |
| `exit` | `beforeunload`, or failed start | E:1033, E:1092 |
| `saveState` / `loadState` / `saveSave` / `loadSave` | Menu buttons only | E:1903 / 1923 / 1954 / 1968 |
| **`saveSaveFiles` (Uint8Array\|null)** | Every `gm.saveSaveFiles()`: the save interval, `getSaveFile()`, exit | GM:411 |

For live save syncing, listen to `saveSaveFiles`. `saveSave` is only the export button.

### 3.2 Methods (exact names) [verified in source; the ones marked ✓ were exercised live on gambatte/melonds]

| Purpose | Call | Notes / source |
|---|---|---|
| Pause / resume | `emu.pause()`, `emu.play()`, `emu.togglePlaying()` ✓ | E:1864-1891. These keep `emu.paused` and the button state in sync and call `gm.toggleMainLoop(0\|1)` (wasm `toggleMainLoop`). Pass `true` to skip the button update. The frame counter stops while paused ✓. |
| Restart | `gm.restart()` ✓ | wasm `system_restart` (GM:183). |
| Fast forward | `gm.setFastForwardRatio(r)` (0 = unlimited), `gm.toggleFastForward(1\|0)` ✓ | Also set `emu.isFastForward` so hotkeys stay consistent. Default ratio 3.0 (GM:148). Menu setting ids: `fastForward`, `ff-ratio`. |
| Slow motion | `gm.setSlowMotionRatio(r)`, `gm.toggleSlowMotion(1\|0)` ✓ | Ratio 3 gives about 20 fps. Ids `slowMotion`, `sm-ratio`. |
| Rewind | `gm.toggleRewind(1\|0)`, `gm.setRewindGranularity(n)` | Needs setting `rewindEnabled = 'enabled'` **before boot** (read in the constructor E:216, written to retroarch.cfg GM:150). Use `EJS_defaultOptions:{rewindEnabled:'enabled'}`. Costs memory/CPU. [uncertain on NDS performance] |
| Quick save/load slots | `gm.quickSave(slot=1)` → bool ✓, `gm.quickLoad(slot=1)` ✓ | Writes `/<slot>-quick.state` in MEMFS. **Not persisted**, lost on reload. |
| Full state | `gm.getState()` → `Uint8Array` ✓, `gm.loadState(u8)` ✓ | wasm `save_state_info` → `"size\|ptr\|ok"` (GM:187-210). The format is RetroArch `RASTATE\x01` + chunk `"MEM "` + u32 length + core data. NDS state ≈ 7 MB (melonDS) / 12 MB (DeSmuME) and takes 6–8 ms. `gm.supportsStates()`. |
| Screenshot | `await gm.screenshot()` → PNG `Uint8Array` (core framebuffer) ✓; `await emu.takeScreenshot(source, format, upscale)` → `{blob, format}` (canvas) | GM:211, E:6023. |
| Battery save | `gm.getSaveFile()` → `Uint8Array\|null` (flushes first), `gm.getSaveFile(false)` (no flush), `gm.getSaveFilePath()` ✓, `gm.saveSaveFiles()` ✓, `gm.loadSaveFiles()` | Path is `/data/saves/<CoreDir>/<base>.<ext>` (IDBFS, autoPersist), e.g. `/data/saves/melonDS/Pokemon - HeartGold Version (USA).sav`, `/data/saves/DeSmuME 2015/….dsv`, `/data/saves/mGBA/x.srm`, `/data/saves/Gambatte/x.srm`. **Import:** `gm.FS.writeFile(path, bytes); gm.loadSaveFiles()` (as E:1968-1983 does). RetroArch also autosaves SRAM every 60 s (`autosave_interval = 60`, GM:140), and EmulatorJS calls `saveSaveFiles()` every `save-save-interval` seconds (default 300, E:4311). |
| Volume / mute | `emu.volume = v; emu.setVolume(v)` ✓ | `setVolume` alone does **not** update `emu.volume` [verified]. Mute = `setVolume(0)` (`emu.muted` becomes true). E:2032. |
| Fullscreen | `emu.toggleFullscreen(true\|false)` | Requests fullscreen on the `EJS_player` element (E:2143). Needs a user gesture in a browser. |
| Cheats | `gm.setCheat(index, enabled(0/1), code)`, `gm.resetCheat()`; UI list `emu.cheats=[{desc,checked,code,is_permanent}]` + `emu.updateCheatUI()` | Passes straight to the core's `retro_cheat_set` (GM:388). **[uncertain]** A GameShark test `017720C0` on gambatte did not visibly write `C020`. Verify the code format per core before relying on it. |
| Core options | `gm.getCoreOptions()` → `"key\|current; v1\|v2…"` lines ✓, `gm.setVariable(key, value)` ✓ (wasm `ejs_set_variable`), or `emu.changeSettingOption(key, value)`, which also updates the menu and localStorage | E:4659, E:4334. Core options apply live; "(Requires restart)" items do not. |
| Input | `gm.simulateInput(player, index, value)` ✓ | value 1/0 for buttons, 0..0x7fff for analog. Indices (RetroPad): `0 B, 1 Y, 2 SELECT, 3 START, 4 UP, 5 DOWN, 6 LEFT, 7 RIGHT, 8 A, 9 X, 10 L, 11 R, 12 L2, 13 R2, 14 L3 (NDS: mic), 15 R3, 16-23 analog axes`. Special: `24` quick save, `25` quick load, `26` next slot, `27` fast forward, `28` rewind, `29` slow motion (GM:248-292). |
| Misc | `gm.getFrameNum()` ✓, `gm.getVideoDimensions('width'\|'height'\|'aspect')` ✓, `gm.setVSync(bool)`, `gm.setVideoRotation(0-3)`, `gm.setKeyboardEnabled(bool)`, `emu.displayMessage(text, ms)`, `emu.menu.open()/close()`, `emu.getCore()` / `emu.getCore(true)` (system; **mgba always reports `gba`**, even for GB ROMs) | |

Keyboard input comes from `keydown/keyup` on the `EJS_player` element (E:1072), so that element must have focus. Defaults are in `emu.defaultControllers` (E:3081); the live map is `emu.controls`.

Touch on NDS: the mouse is mapped to the stylus. `melonds_touch_mode` is `Mouse` (relative cursor) by default. `Touch` gives absolute pointer input (tested: synthetic `mousedown`/`mouseup` on `emu.canvas` with clientX/Y works). For desmume use `desmume_pointer_type = touch`.

### 3.3 Core option keys (from `getCoreOptions()`, live) [verified]
- **melonds**: `melonds_console_mode` (DS|DSi), `melonds_boot_directly` (enabled), `melonds_use_fw_settings`, `melonds_language` (Japanese|English|French|German|Italian|Spanish), `melonds_randomize_mac_address`, `melonds_dsi_sdcard`, `melonds_mic_input` (Blow Noise|White Noise), `melonds_audio_bitrate`, `melonds_audio_interpolation`, `melonds_touch_mode` (Mouse|Touch|Joystick|disabled), `melonds_swapscreen_mode` (Toggle|Hold), **`melonds_screen_layout` (Top/Bottom|Bottom/Top|Left/Right|Right/Left|Top Only|Bottom Only|Hybrid Top|Hybrid Bottom)**, `melonds_screen_gap` (0…), `melonds_hybrid_small_screen` (Bottom|Top|Duplicate).
  - No JIT, OpenGL or threaded-renderer options exist in this wasm build (software renderer).
- **desmume2015**: `desmume_screens_layout` (top/bottom|bottom/top|left/right|right/left|top only|bottom only|quick switch|hybrid/top|hybrid/bottom), `desmume_screens_gap`, `desmume_internal_resolution`, `desmume_num_cores`, `desmume_cpu_mode` (interpreter only), `desmume_frameskip`, `desmume_firmware_language`, `desmume_pointer_type` (mouse|touch), `desmume_load_to_memory`, `desmume_advanced_timing`, `desmume_gfx_edgemark/linehack/txthack`, `desmume_mic_mode`, …
- **desmume** (newer): same naming, plus `desmume_hybrid_layout_ratio`, `desmume_gfx_texture_scaling`, `desmume_use_external_bios`, …
- **mgba**: `mgba_gb_model`, `mgba_use_bios`, `mgba_skip_bios`, `mgba_gb_colors`, `mgba_color_correction`, `mgba_interframe_blending`, `mgba_idle_optimization`, `mgba_frameskip`, …
- **gambatte**: `gambatte_gb_colorization`, `gambatte_gb_internal_palette`, `gambatte_gb_hwmode` (Auto|GB|GBC|GBA), `gambatte_gb_bootloader`, `gambatte_mix_frames`, …
- EmulatorJS-level setting ids (also usable in `EJS_defaultOptions` / `changeSettingOption`): `fastForward`, `ff-ratio`, `slowMotion`, `sm-ratio`, `rewindEnabled`, `rewind-granularity`, `save-state-slot`, `save-state-location` (download|browser), `save-save-interval` (0|30|60|300|…), `webgl2Enabled`, `ejs_threads`, `retroarch_core`, `vsync`, `videoRotation`, `shader`, `keyboardInput`, `menubarBehavior`, `virtual-gamepad`, `lockMouse`.

---

## 4. Emulated RAM access

### 4.1 Exports
- **The cores' wasm exports and JS glue only bind the EmulatorJS helper functions** [verified for all 4 variants of all 5 cores, by grepping `Module["_…"]` in the glue and listing `WebAssembly.Module.exports`]:
  - `_cmd_save_state, _cmd_savefiles, _cmd_take_screenshot, _ejs_set_keyboard_enabled, _ejs_set_variable, _free, _get_core_options, _get_current_disk, _get_current_frame_count, _get_disk_count, _get_video_dimensions, _load_state, _main, _malloc, _refresh_save_files, _reset_cheat, _save_file_path, _save_state_info, _set_cheat, _set_current_disk, _set_ff_ratio, _set_rewind_granularity, _set_sm_ratio, _set_video_rotation, _set_vsync, _shader_enable, _simulate_input, _supports_states, _system_restart, _toggle_fastforward, _toggle_rewind, _toggle_slow_motion, _toggleMainLoop`.
  - **`_retro_get_memory_data` / `_retro_get_memory_size` are not exported.** The wasm export names are minified (`Hh`, `Ih`, …), so the function can't be reached via `cwrap`/`ccall` either.
- Exported runtime helpers: `Module.HEAPU8`, `Module.FS`, `Module.cwrap`, `Module.getValue`, `Module._malloc/_free`.
- Plain heap: the non-thread builds start at 128 MB and grow; melonDS + a 128 MB ROM reached about 380 MB. **Always re-read `Module.HEAPU8`**: growth swaps the buffer, but byte offsets stay valid. In thread builds `HEAPU8.buffer` is a `SharedArrayBuffer`.

So the fallback is a **heap-offset locator**. It runs once after boot, takes 40–150 ms, and then gives zero-copy reads every frame.

### 4.2 Verified locators (implemented in `web/emu-test.html` → `__emu.locateRam()`)
Every result was confirmed by comparing the whole located block with the RAM block inside `gm.getState()` while paused: **0 differing bytes**. The address was identical across reloads for the same core and ROM.

| Core / system | RAM block found | How | Size |
|---|---|---|---|
| **melonds / desmume / desmume2015 (NDS)** | Main RAM `0x02000000` (4 MB) | The game's ROM header (first 0x20 bytes of `FS.readFile('/'+emu.fileName)`) appears in RAM at **0x027FFA80 and 0x027FFE00**. Find a heap hit `p` with another hit at `p-0x380`; then `base = p - 0x3FFE00`. A lone header hit is the ROM buffer or cart struct, so ignore it. | 0x400000 |
| **mgba (GBA)** | EWRAM `0x02000000` (256 KB) immediately followed by IWRAM `0x03000000` (32 KB), one allocation. This matches libretro `RETRO_MEMORY_SYSTEM_RAM`. | savestate: 16-byte RASTATE header + `GBASerializedState`; EWRAM at state `+16+0x21000`, IWRAM at `+16+0x19000`, CPU gprs at `+16+0x20`. Search the heap for a chunk of EWRAM and confirm the full 256 KB. | 0x48000 |
| **mgba (GB/GBC)** | WRAM `0xC000` (32 KB allocation) | savestate WRAM at `+16+0x4400` | 0x8000 |
| **gambatte (GB/GBC)** | WRAM `0xC000` (8 KB on DMG, 32 KB on CGB; banks 2-7 at +0x1000·n) | gambatte's tagged state: label `"wram\0"` + 3-byte big-endian length + data | 0x2000 / 0x8000 |

Test ROMs used: a self-made GB/GBC ROM that writes `"EJSWRAM!"` at C000 and a counter at C010, and a self-made GBA ROM that writes `~"EWRM"` at 0x02000000, `~"IWRM"` at 0x03000000 and a counter at 0x03000004. The counters were seen incrementing live through the view. For NDS I used the user's own HeartGold (USA) zip, read locally and not copied into `web/`. The HG RAM at 0x02000000 starts `ff de ff e7…`, the direct-boot secure-area marker.

Code (as in `emu-test.html`):
```js
const heap = () => EJS_emulator.gameManager.Module.HEAPU8;
// NDS
const hdr = gm.FS.readFile('/' + EJS_emulator.fileName).subarray(0, 0x20);
const hits = findAll(heap(), hdr);                         // naive byte search via indexOf on first byte
const p = hits.find(h => h >= 0x3FFE00 && hits.includes(h - 0x380));
const base = p - 0x3FFE00;                                 // keep this number for the session
const mainRam = () => heap().subarray(base, base + 0x400000);
const read32 = a => { const o = (a - 0x02000000) & 0x3FFFFF, v = mainRam(); return (v[o] | v[o+1]<<8 | v[o+2]<<16 | v[o+3]<<24) >>> 0; };
```
Practical rules:
- Run the locator **after the game has booted** (NDS: a few hundred frames). If it fails, retry later.
- Pause while locating: `emu.pause(true)` … `emu.play(true)`.
- After `loadState()` or `restart()` the block stays at the same address (it's a static/heap allocation inside the core). Re-run the locator if a read looks wrong.
- Reads are not frame-atomic. Read during the same JS task, or sanity-check checksums (Gen 4 structures carry their own checksums).
- **Alternative without heap scanning:** `gm.getState()` already contains the RAM: melonDS main RAM at state offset **48** (`RASTATE`16 + `MELN` header16 + `NDSG` section header16). For desmume2015 it's at 50928 and for desmume at 50896 (heuristic: the header pair again). This costs about 7 ms and 7–12 MB per call, which is fine at about 1 Hz.

### 4.3 What libretro would return (for reference; not reachable here)
melonDS `RETRO_MEMORY_SYSTEM_RAM` = 4 MB main RAM; `SAVE_RAM` = cartridge save. mGBA (GBA) = EWRAM + IWRAM (0x48000). gambatte = WRAM (0x2000/0x8000). The locators above reproduce exactly these blocks.

---

## 5. NDS core choice for Pokémon HeartGold

Measured in headless Chrome on this Mac (arm64) with the HG (USA) ROM, non-thread builds, same scenes (intro → touch tutorial, 2D). Unlimited fast-forward speed:

| Core | Intro (frames/s) | Tutorial screens (frames/s) | Normal speed | Savestate | Battery save |
|---|---|---|---|---|---|
| melonds | 333 | 511 (280-515 depending on scene) | 60 fps | 7.0 MB | **raw `.sav`** (`/data/saves/melonDS/…sav`) |
| desmume2015 | 548 | 728 | 60 fps | 12.6 MB | `.dsv` (raw + DeSmuME footer) |
| desmume | 485 | 716 | 60 fps | 12.6 MB | `.dsv` |

- All three boot HG **without BIOS/firmware files** [verified]: direct boot, `melonds_boot_directly = enabled`. The EmulatorJS docs claim melonDS requires `bios7/bios9/firmware` [doc], but it wasn't needed here.
- I couldn't benchmark the 3D overworld because I couldn't automate past the tutorial. Expect lower numbers there [uncertain].
- **Recommendation: `melonds`.**
  - It is EmulatorJS's default for `nds`, the more accurate emulator, and holds 60 fps with roughly 5× headroom on Apple Silicon.
  - Its `.sav` is the plain 512 KB SRAM image, which our gen4 save parser and PKHeX read directly, and it swaps 1:1 with desktop melonDS.
  - Use `desmume2015` as a setting for weak machines. EmulatorJS issue #905 reports Pokémon Platinum at 1/3 speed on a low-end Chromebook with melonDS, while a DeSmuME site ran at a solid 60.
  - Its `.dsv` needs the footer stripped or added when swapping with melonDS. **[uncertain]**: verify the exact footer length on a real save.
  - Avoid `desmume` (new): issue #1121 reports it "significantly slower" on nightly; in 4.2.3 it is fine but has no advantage.
- Known EmulatorJS NDS issues:
  - #1262: touch broken in **4.3.0** but works in 4.2.3, which is another reason to stay on 4.2.3.
  - #1024: firmware language not applied, fixed later.
  - #615: on Mac, mouse/stylus only moves while the button is held. That is mouse mode; use `melonds_touch_mode = Touch`.
- Screen layout: set `melonds_screen_layout` (values above). `Hybrid Top` and `Left/Right` work for wide windows.

**GB/GBC:** `gambatte` (EmulatorJS default for `gb`; accurate; small 26 KB states; `.srm` = raw SRAM). **GBA:** `mgba` (the only GBA core in EJS; also runs GB/GBC). Both run at thousands of fps unlimited, so speed is not a concern.

---

## 6. HTTP headers, CSP, Electron notes

- **COOP/COEP: not required** for our cores or for RAM access. `HEAPU8` is a normal `ArrayBuffer` and is fully readable.
  - Only if you want thread builds (`EJS_threads = true`), serve the page with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`).
  - All subresources must then be same-origin or CORP-enabled.
  - In Electron you can add the headers via `session.webRequest.onHeadersReceived`.
  - Threads didn't make the NDS cores faster in a meaningful way [uncertain, not benchmarked].
- MIME types are irrelevant: everything is fetched via XHR/fetch as an arraybuffer or text. The app server serves `web/vendor/emulatorjs/**` as-is (unknown extensions → `application/octet-stream`). HEAD requests on `EJS_gameUrl` must not error (it is used for the ROM cache check, E:902).
- CSP (none today): a future CSP must allow
  - `script-src 'self' blob: 'wasm-unsafe-eval'`, because the core JS is injected as a blob script (E:639-646) and wasm is compiled;
  - `worker-src blob:` for the extraction workers (compression.js);
  - `connect-src 'self' blob:`.
- Offline gotchas:
  - On `localhost`/`127.0.0.1`, or with `EJS_DEBUG_XX`, EmulatorJS fetches `https://cdn.emulatorjs.org/stable/data/version.json` (update check, E:176-207). Offline it's just a failed fetch; to avoid it, use another host name or block it.
  - A missing core file triggers a CDN fallback (E:614-632).
- Storage:
  - ROMs smaller than 1 GB are cached in IndexedDB `EmulatorJS-roms` (a 128 MB copy for HG!). Set `EJS_CacheLimit = 0`, or `EJS_disableDatabases = true`.
  - Cores are cached in `EmulatorJS-core`.
  - Battery saves are persisted by IDBFS (`/data/saves`).
- Audio: Chrome's autoplay policy may start the AudioContext suspended. In Electron, `app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required')`.
- Licensing: GPL-3.0 (EmulatorJS, RetroArch, melonDS) and GPL-2.0+ cores are bundled. Shipping the app means offering their source (see `VERSION.txt`).

## 7. Open risks
1. The RAM locators rely on observed core internals. They are verified for exactly these builds (core build 2.0.2, 2025-06-14). Re-verify after any EmulatorJS or core update; `emu-test.html` makes that a one-minute check.
2. The NDS header-pair heuristic needs the game to have booted (direct boot). With `melonds_boot_directly = disabled` (firmware boot) the header copies appear later.
3. Non-atomic reads while the frame runs: read between frames (JS task) and validate with Gen 4 checksums.
4. 3D overworld performance on weaker PCs was not measured. Keep `desmume2015` selectable.
5. `setCheat` code formats are unverified.
6. `emulator.min.js` is a local rebuild (functionally identical to the sources). If in doubt, `EJS_DEBUG_XX = true` uses `src/` directly.
