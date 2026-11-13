# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private vulnerability reporting
([report a vulnerability](https://github.com/souldewapp/souldew/security/advisories/new)), or contact the maintainers privately. Include the
souldew version, what an attacker could do, and steps to reproduce. You'll get an answer as soon as possible; please
give us time to ship a fix before disclosing details.

## Scope

souldew runs a local HTTP server and talks to other players over public relays. Things we especially want to hear
about:

- **Local server** (`server/`): requests from other websites or other machines reaching the API (host check, origin
  and `Sec-Fetch-Site` check and the app header in `server/lib/guard.mjs`; sensitive GETs for pack/room, spoilers,
  Discord webhook and stream settings also need same-origin/`none` or the app header), path traversal in file routes,
  the overlay API or the Pokélink bridge leaking room keys, file paths or spoilers.
- **Invite codes** (`web/lib/invitecode.mjs`): ways to join a run without the host's approval, guessing or reusing a
  code, or reading the run pack from the relay.
- **Sync** (`web/lib/sync.mjs`, `web/lib/doc.mjs`): reading or forging another run's data without its key, or a
  partner's data causing code execution or damage on your machine (e.g. through names or run packs).
- **Updater** (`electron/updater.mjs`): installing an update that isn't signed with the release key or doesn't match
  the announced version and checksum.
- **Electron shell** (`electron/`): navigation, IPC or permission handling that lets web content escape the sandbox.

Out of scope: problems that need an attacker who already controls your computer, and anything inside the emulated games.
