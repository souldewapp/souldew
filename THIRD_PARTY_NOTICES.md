# Third-party notices

souldew itself is licensed under the GNU General Public License v3.0 or later ([LICENSE](LICENSE)). It includes, or
bundles into the built app, the following third-party components under their own licenses. License texts that ship in
this repository are linked; the others are available at the linked projects.

## Bundled in this repository

| Component | Version | License | Where | Project |
|---|---|---|---|---|
| EmulatorJS | 4.2.3 | GPL-3.0 ([text](web/vendor/emulatorjs/licenses/EmulatorJS-GPL-3.0.txt)) | `web/vendor/emulatorjs/` | https://github.com/EmulatorJS/EmulatorJS |
| DeSmuME libretro core (`desmume`, `desmume2015`) | as shipped with EmulatorJS 4.2.3 | GPL-2.0-or-later ([text](web/vendor/emulatorjs/licenses/desmume-GPL-2.0.txt)) | `web/vendor/emulatorjs/cores/desmume*` | https://github.com/libretro/desmume, https://github.com/libretro/desmume2015 |
| melonDS libretro core | as shipped with EmulatorJS 4.2.3 | GPL-3.0 ([text](web/vendor/emulatorjs/licenses/melonds-GPL-3.0.txt)) | `web/vendor/emulatorjs/cores/melonds*` | https://github.com/libretro/melonds |
| mGBA libretro core | as shipped with EmulatorJS 4.2.3 | MPL-2.0 ([text](web/vendor/emulatorjs/licenses/mgba-MPL-2.0.txt)) | `web/vendor/emulatorjs/cores/mgba*` | https://github.com/libretro/mgba |
| Gambatte libretro core | as shipped with EmulatorJS 4.2.3 | GPL-2.0 ([text](web/vendor/emulatorjs/licenses/gambatte-GPL-2.0.txt)) | `web/vendor/emulatorjs/cores/gambatte*` | https://github.com/libretro/gambatte-libretro |
| EmulatorJS helpers (archive extraction incl. libunrar, nipplejs, socket.io client) | as shipped with EmulatorJS 4.2.3 | their own licenses (unRAR license for libunrar; MIT for nipplejs and socket.io-client) | `web/vendor/emulatorjs/compression/`, `web/vendor/emulatorjs/src/` | https://github.com/EmulatorJS/EmulatorJS |
| Trystero (Nostr strategy, bundled build incl. noble-secp256k1) | bundled build | MIT | `web/vendor/trystero-nostr.min.js` | https://github.com/dmotz/trystero, https://github.com/paulmillr/noble-secp256k1 |
| Universal Pokémon Randomizer ZX | 4.6.1 | GPL-3.0 | `tools/upr/PokeRandoZX.jar` | https://github.com/Ajarmar/universal-pokemon-randomizer-zx |
| Pixelify Sans (font) | – | SIL OFL 1.1 ([text](web/assets/fonts/OFL-PixelifySans.txt)) | `web/assets/fonts/PixelifySans-*` | https://github.com/eifetx/Pixelify-Sans |
| IBM Plex Sans / Plex Mono (fonts) | – | SIL OFL 1.1 ([text](web/assets/fonts/OFL-IBMPlex.txt)) | `web/assets/fonts/IBMPlex*` | https://github.com/IBM/plex |
| libretro API headers (`libretro.h`, `libretro_vulkan.h`) | from libretro-common | MIT (in the files) | `native/ctr-host/` | https://github.com/libretro/libretro-common |

`web/assets/fonts/PixelDigits-*.ttf` is made by this project (`scripts/build-pixel-digits.mjs`) and is under the
project license.

## npm dependencies (installed by `npm ci`, bundled into the built app)

| Package | Version | License |
|---|---|---|
| htm (its `htm/preact` standalone build includes Preact) | 3.1.1 | Apache-2.0 (Preact: MIT) |
| mqtt (MQTT.js) | 5.16.1 | MIT |
| socket.io | 4.8.3 | MIT |
| engine.io | 6.6.11 | MIT |

Their transitive production dependencies are under MIT, ISC, BSD-3-Clause, Apache-2.0 and 0BSD (see
`package-lock.json`). Build-time only: Electron 43.7.0 (MIT, its runtime ships inside the built app together with
Chromium's and Node.js's own notices), electron-builder (MIT), ESLint (MIT).

## Fetched when building the app

| Component | License | Notes |
|---|---|---|
| Eclipse Temurin JRE 17 (macOS arm64, Windows x64) | GPL-2.0 with Classpath Exception | Downloaded by `scripts/fetch-jre.mjs` from the Adoptium API into `tools/jre/` (not in the repository) and bundled into the DMG / the Windows installer with its `legal/` folder. https://adoptium.net |
| Azahar libretro core (Nintendo 3DS) | GPL-2.0-or-later | Built by `scripts/build-ctr.mjs` from Azahar's source (tag 2126.2) with souldew's patch `native/azahar-patch/souldew-memory.patch` (it lets the core read the game's memory for live data) into `tools/ctr/` and bundled into the DMG. The corresponding source is that Azahar tag plus the patch. https://github.com/azahar-emu/azahar |
| melonDS DS libretro core (fast player, DS) | GPL-3.0 | Built unmodified by `scripts/build-native.mjs` from tag v1.4.0 into `tools/native/` and bundled with the app (its license text alongside as `LICENSE-melonds-ds-GPL-3.0.txt`). The corresponding source is that tag. https://github.com/JesseTG/melonds-ds |
| mGBA libretro core (fast player, GBA) | MPL-2.0 | Built unmodified by `scripts/build-native.mjs` from tag 0.10.5 (`LICENSE-mgba-MPL-2.0.txt` alongside). https://github.com/mgba-emu/mgba |
| Gambatte libretro core (fast player, Game Boy / Color) | GPL-2.0 | Built unmodified by `scripts/build-native.mjs` from commit 77f2567 of libretro's port (`LICENSE-gambatte-GPL-2.0.txt` alongside). https://github.com/libretro/gambatte-libretro |
| MoltenVK (macOS) | Apache-2.0 | Vulkan on Metal for the 3DS core – taken from Azahar's macOS release by `scripts/build-ctr.mjs`. https://github.com/KhronosGroup/MoltenVK |

## Fetched at runtime

| Content | Notes |
|---|---|
| Pokémon sprites | Loaded from the [PokeAPI/sprites](https://github.com/PokeAPI/sprites) repository and cached locally. The sprites are © Nintendo / Game Freak / Creatures. |
| Public relays | Nostr relays (peer discovery) and a public MQTT broker (fallback relay) carry only encrypted tracker data. |

## Data and artwork

- Pokémon data in `shared/data/` and `research/` (names, types, moves, locations, encounter tables) was derived from
  [PokeAPI](https://pokeapi.co) (BSD-3-Clause for the PokeAPI code; the underlying game data belongs to its owners),
  the [pret](https://github.com/pret) disassemblies, [libretro-database](https://github.com/libretro/libretro-database)
  and community documentation of the supported ROM hacks.
- Box art in `web/assets/covers/` comes from [libretro-thumbnails](https://github.com/libretro-thumbnails) and is ©
  its respective owners (Nintendo / The Pokémon Company). It is used only to identify the games in a player's library.
- Pokémon and all related names are trademarks of Nintendo, Game Freak, Creatures Inc. and The Pokémon Company. souldew
  is not affiliated with or endorsed by them.

## Sounds

| File | Origin |
|---|---|
| `web/assets/sounds/boot.wav` | Provided by the project owner – license to be confirmed before publishing. |
| `web/assets/sounds/cart-insert.wav` | Provided by the project owner – license to be confirmed before publishing. |
