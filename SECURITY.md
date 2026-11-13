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
  and `Sec-Fetch-Site` check and the app header in `server/lib/guard.mjs`; GETs that hand out the run pack, a run's
  files, the spoiler log, the Discord webhook, the stream token or folders additionally need the app header or a
  same-origin request – `PRIVATE_GETS`), path traversal in file routes, the
  overlay API or the Pokélink bridge leaking room keys, file paths or spoilers.
- **Invite codes** (`web/lib/invitecode.mjs`): ways to join a run without the host's approval, guessing or reusing a
  code, reading the run pack from the relay, or getting the pack without the host typing in the 4 confirmation digits
  the joining player's app shows. (Known limit: nothing commits either side to its key before it sees the other's, so
  somebody in the middle who can keep the real partner's messages from the host could pick a key until the digits
  match – closing that needs a new wire version.)
- **Sync** (`web/lib/sync.mjs`, `web/lib/doc.mjs`): reading or forging another run's data without its key, or a
  partner's data causing code execution or damage on your machine (e.g. through names or run packs).
- **Updater** (`electron/updater.mjs`): installing an update that isn't signed with the release key or doesn't match
  the announced version and checksum.
- **Electron shell** (`electron/`): navigation, IPC or permission handling that lets web content escape the sandbox.

Out of scope: problems that need an attacker who already controls your computer, and anything inside the emulated games.

## What the stream features show on purpose

The OBS overlays, the open stream API (`/api/v1`) and the Pokélink bridge exist to put the run on stream, so what they
serve is readable by design – to the pages and programs listed in [docs/STREAMING.md](docs/STREAMING.md) and
[docs/STREAM_API.md](docs/STREAM_API.md):

- **Readable (spoiler-class, by design):** player names and colours, teams with nicknames, levels, HP, status, held
  items (and moves for Pokélink themes), badges, play time, location and current battle, encounters, links, the
  graveyard and the log. In a randomized run that tells what everybody got – that's what a stream shows.
- **Never served:** room keys and secrets, invite codes, device IDs, the Discord webhook, the spoiler log, ROMs, saves,
  savestates, file names and folders.
- **Stream API** (`server/lib/streamapi.mjs`): with the token, whoever has it; without, OBS (no Origin, or its
  `http://absolute` local files), scripts and souldew's own pages. Pages opened from disk (Origin `null` – shared with
  sandboxed frames on any website) and other `localhost` pages only after the Stream page's switch, which starts on
  for installs set up before it existed (so their layouts keep working) and off for new ones.
- **Pokélink bridge** (`server/lib/pokelink.mjs`): readable to themes opened from disk (`file://`, Origin `null`),
  Pokélink's own sites and souldew's own pages; pages of other local web servers only after the switch on the Stream
  page. Because a page opened from disk sends Origin `null` – which a sandboxed frame on a website sends too – a
  browser that lets public websites reach `127.0.0.1` could let such a frame read the teams while the bridge is on.
  The bridge is off until you switch it on.

A way to read anything from the "never" list, or to read the stream data from a page or machine that isn't allowed
there, is a vulnerability we want to hear about.
