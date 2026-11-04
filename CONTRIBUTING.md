# Contributing to souldew

Thanks for helping! This guide covers the setup, the conventions the code follows and what a pull request needs.

## Ground rules

- **Never commit or attach ROMs, saves, save states, patched games or randomizer outputs.** `.gitignore` blocks the
  usual extensions (`*.nds`, `*.gb*`, `*.zip`, `*.sav`, `*.state`, …) – don't force-add them. Test data is generated in
  the tests themselves (fake cartridge headers, synthetic RAM and save fixtures).
- Never commit keys or personal data (the release signing key lives outside the repo, see the README).
- Keep protocol identifiers unchanged (`soullink-studio-v1`, `soullink-studio/invite-code@1`,
  `soullink-studio/run-pack@1`): other installs depend on them.

## Setup

Requirements: **Node.js ≥ 22.15**. The app, the server and the tests run on macOS, Windows and Linux; the DMG is built on
a Mac, the Windows installer on Windows (`npm run dist:win`, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)).

```sh
npm ci
npm run app      # Electron app, development mode
npm start        # server only, UI in the browser – data goes to runs/ and library/ in the project folder
```

To test with several players on one machine, start extra instances with their own data folder:

```sh
PORT=47400 SLS_DATA_DIR=/tmp/souldew-p2 NO_OPEN=1 node server/index.mjs
npm run app -- --user-data-dir=/tmp/souldew-p3
```

(PowerShell: `$env:PORT=47400; $env:SLS_DATA_DIR="$env:TEMP\souldew-p2"; $env:NO_OPEN=1; node server/index.mjs`.)

Use separate folders for testing – never point a test instance at your real data in
`~/Library/Application Support/SoulLink Studio` (Windows: `%APPDATA%\SoulLink Studio`).

## Checks

```sh
npm run lint                     # ESLint, must be clean
npm test                         # node --test "test/*.test.mjs"
node scripts/extract-i18n.mjs    # must end with "0 missing, 0 stale" for every language
```

CI runs the same on Ubuntu and Windows with Node 22 and 24 (macOS runners don't start for this repository right now).
Paths in code and tests go through `node:path` (and `path.win32` where Windows rules are tested) – no hard-coded `/`.
Visible text that differs per platform (⌘ / Ctrl, Finder / Explorer, "Mac" / "PC") uses `web/lib/platform.mjs`. Add a test for every bug you fix and every rule you add –
`test/` has examples for run logic, live-memory parsing (synthetic RAM), sync, invite codes, the server and the
overlay API.

## Code style

- Plain ES modules everywhere, no build step for the UI (Preact + htm in `web/`).
- Match the surrounding code: naming, comment density and idioms. Comments explain *why*, in full sentences.
- Code shared by server and UI belongs in `shared/`.
- The local server only answers this computer; keep new routes behind the existing guard (`server/lib/guard.mjs`)
  and never put room keys, file paths or spoilers into anything the overlay API or Pokélink bridge serves.

## Texts and translations

- Every visible string goes through `t('area.key', 'English default', { vars })` (`web/lib/i18n.mjs`). Plurals:
  `'one area|{count} areas'`.
- Run `node scripts/extract-i18n.mjs` – it adds new keys to `web/i18n/en.json` and lists missing or stale ones per
  language. Add the translations to `de.json`, `fr.json`, `es.json` and `it.json`.
- German UI text uses the informal "du" and no gender stars. "souldew" is always written in lowercase.

## Pull requests

- One topic per PR, with a short description of what changed and how you tested it (game, core, mode).
- Update the README (features, limitations) and `CHANGELOG.md` when users will notice the change.
- Screenshots help for UI changes.

## Releases

Releases are published by pushing a version tag (`v<version>`, matching `package.json`) – see "Releasing updates" in
the README. Only maintainers with the release key (repository secret `SLS_RELEASE_KEY`) can publish updates the
installed apps accept.
