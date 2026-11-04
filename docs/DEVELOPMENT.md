# Developing souldew

Building from source, releasing updates and how the code is organised. Back to the [README](../README.md).

## Building from source

Requirements: macOS for the app and the DMG (the server and the tests are plain Node), **Node.js ≥ 22.15**, git.

```sh
npm ci                 # install dependencies
npm run app            # Electron app in development mode (data in the Electron profile)
npm start              # server only, UI in the browser (data in the project folder: runs/, library/)
npm test               # all tests (node --test "test/*.test.mjs")
npm run lint           # ESLint (eslint.config.mjs)
node scripts/extract-i18n.mjs   # sync UI strings, list missing/stale translations
npm run dist           # build the DMG (fetches the Java runtime on first run)
```

| Command | Purpose |
|---|---|
| `PORT=… SLS_DATA_DIR=… NO_OPEN=1 node server/index.mjs` | A second instance with its own data folder – e.g. to test several players on one machine |
| `npm run app -- --user-data-dir=/some/folder` | The Electron app with a separate profile and data folder (never point it at your real data while testing) |
| `npm run dist` | Runs `scripts/fetch-jre.mjs` (Temurin JRE 17 for arm64 into `tools/jre/`) and electron-builder. `scripts/dmgbuild-wrapper.mjs` moves the DMG window's hidden files below the visible area; the background image is rendered with `node scripts/render-dmg-background.mjs` from `build/dmg-background.html`. |
| `npm run release` | Sign and package an update (see below) |

New visible text always goes through `t('area.key', 'English default', { vars })`; then translate it for de/fr/es/it – `node scripts/extract-i18n.mjs` must end with "0 missing, 0 stale" for every language. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Releasing updates

The app checks `https://github.com/souldewapp/souldew/releases/latest/download/latest.json` at start and every four hours (also via **Settings › About › Check for updates**). It downloads the DMG, verifies the feed's signature, size and SHA-256, puts the new app next to the old one and swaps them on restart; your data stays untouched.

**One-time setup** (already done for this repository: `updates.repo` and `updates.publicKey` are in `package.json`):

1. The repository must be **public** – release files have to be downloadable without login.
2. The signing key was created with `npm run release -- --init-key`: the private key lives in `~/.config/soullink-studio/release-key.pem`, its public half is `updates.publicKey`. **Back the key up and never commit or share it** – without it you can't publish updates the apps accept.
3. Add the key's contents as the repository secret `SLS_RELEASE_KEY` (Settings › Secrets and variables › Actions) so GitHub Actions can sign releases.

**Publishing a version** – automatically with GitHub Actions ([`.github/workflows/release.yml`](../.github/workflows/release.yml)):

1. Bump `version` in `package.json` and add a `## <version>` section to [CHANGELOG.md](../CHANGELOG.md) – that becomes the release notes.
2. Commit, then tag and push: `git tag v2.1.0 && git push origin main v2.1.0`.
3. The workflow runs lint and tests, builds the DMG on an Apple silicon runner, signs `latest.json` and publishes the release. Installed apps pick it up within a few hours.

**By hand** (same result): `npm run dist`, then `npm run release` (or `npm run release -- --notes "…"`), then run the printed `gh release create …` command. The release must not be a draft or prerelease, otherwise "latest" doesn't point to it.

The app verifies the Ed25519 signature of `latest.json` before using its download URL or checksum; an unsigned or altered feed is rejected. It only accepts HTTPS, refuses downgrades and only installs a DMG with the matching checksum, bundle ID and exact announced version. `"minVersion"` in the feed (`npm run release -- --min-version 2.1.0`) sends older installs to the download page instead. Pushing commits alone doesn't reach the apps – only a published release does.

## Project layout

The Electron shell (`electron/`) starts the local server (`server/`) in the same process. The UI is Preact + htm without a build step (`web/`). Code shared by server and UI – patcher, save parser, live RAM parser, routes, player slots – lives in `shared/`, data from PokeAPI and libretro-thumbnails in `shared/data/`.

| Folder / file | Contents |
|---|---|
| `electron/` | App shell: window, menu, updater, IPC guards |
| `server/` | Local HTTP server: library, runs, saves, builds (patch + randomizer), overlay API, Pokélink bridge |
| `web/` | The UI (`app.mjs`, `views/`, `lib/`), the emulator page `player.html`, `overlay.html`, translations in `i18n/` |
| `web/lib/run.mjs` | Run logic: encounters, pairs/groups, deaths, rules, checks, stats, live reconciliation (`applySnapshot`) |
| `web/lib/sync.mjs`, `web/lib/doc.mjs` | Live sync (WebRTC + relay) and the shared run document (last writer wins per key) |
| `web/lib/invitecode.mjs` | Inviting with a 6-digit code |
| `web/lib/turboaudio.mjs`, `web/lib/sdat*.mjs` | Turbo music: recorded loops and the DS sound-archive player |
| `shared/live/` | Reading team, battle and location from game memory (Gen 1–5) |
| `shared/overlay.mjs` | The overlay snapshot (what stream tools may see) |
| `server/lib/build.mjs` | Building runs (patch, randomizer, one ROM per player) |
| `tools/upr/`, `tools/upr-bridge/` | Universal Pokémon Randomizer ZX and souldew's Java helper for it |
| `research/` | Notes and data gathered while building the trackers |
| `build/` | App icon, DMG background and the README graphics (`build/readme/art.html` → `node scripts/render-readme-art.mjs` → `docs/media/`) |
| `test/` | `node --test` suites |

**Compatibility note:** the app was called "SoulLink Studio" before. Protocol identifiers keep that name on purpose so different versions can still play together: the sync app ID `soullink-studio-v1`, the invite-code salt `soullink-studio/invite-code@1`, the run-pack format `soullink-studio/run-pack@1`, the data folder `~/Library/Application Support/SoulLink Studio` and the release-key path `~/.config/soullink-studio/`. Don't rename them.
