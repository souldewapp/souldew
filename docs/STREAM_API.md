# souldew stream API (v1)

Build your own stream layout: souldew hands out the current run – players, teams, linked groups, graveyard,
encounters, locations, battles – as JSON, pushes every change live, and serves the same sprites the app shows.
Back to [Streaming with souldew](STREAMING.md).

The address is on the **Stream** page under **Open API** (with a copy button). It is normally

```
http://127.0.0.1:47390/api/v1
```

If port 47390 is taken, souldew picks another one – the Stream page always shows the real address.

## Safe by default

- **Only this computer.** The server listens on `127.0.0.1`; nobody else on your network can reach it.
- **Read-only.** Every endpoint is `GET` (plus `HEAD`/`OPTIONS`); anything else gets `405`.
- **Only what a stream may show.** No ROMs, saves, savestates, file names or folders, no invite codes, room keys or
  device IDs, no spoiler log, no Discord webhook, no moves.
- **Who may read:** OBS browser sources (URL or local file), `curl`/scripts, pages opened from disk (`file://`) and
  pages served from `localhost` / `127.0.0.1`. Pages of other websites get `403`.
- **Optional token.** Switch on **Require a token** on the Stream page: then every data request needs it – from
  anywhere, which also lets a layout hosted on a website read the API. Pass it as `?token=…` (the only way for
  `EventSource` and `<img>`), `Authorization: Bearer …` or `X-Souldew-Token: …`. The token is covered in streamer
  mode. Sprites, the QR code and the legendary list are public pictures/data and never need it.
- **CORS** is on: answers carry `Access-Control-Allow-Origin` for the asking page; preflights (and Chrome's
  Private Network Access check) are answered.

## Versioning

Everything lives under `/api/v1`. Within v1 fields are only ever **added** – never renamed, removed or given a new
meaning. A breaking change would get `/api/v2`, with v1 kept alongside. Unknown fields: ignore them.

## Endpoints

| Endpoint | Answer |
|---|---|
| `GET /api/v1` | Index: API version, current run ID, whether a token is required, endpoint and event lists |
| `GET /api/v1/runs` | All runs: `[{ id, name, mode, gen, current, players: [{ slot, name, color }], createdAt }]` |
| `GET /api/v1/runs/current` | The run played last (its data changed last) – the whole state, see below |
| `GET /api/v1/runs/{id}` | One run's state (8-character run ID from `/runs`) |
| `GET /api/v1/runs/{id}/players` · `/players/p1` | `players` of the state – all, or one |
| `GET /api/v1/runs/{id}/links` · `/graveyard` · `/encounters` · `/feed` | That part of the state |
| `GET /api/v1/runs/{id}/events` | **Live**: Server-Sent Events (below) |
| `GET /api/v1/events?run={id}` | The same; `run` defaults to `current` |
| `GET /api/v1/species/{id}?gen=4&shiny=1` | `{ id, name, legendary, sprites }` for any species 1–1025 |
| `GET /api/v1/legendaries` | `{ legendary: [ids], mythical: [ids] }` (Gen 1–9) |
| `GET /api/v1/sprites/{style}/{variant}/{id}.png` | A sprite image (below) |
| `GET /api/v1/coffee` | The "Buy me a coffee" link, its QR code URL and the pop-up settings |
| `GET /api/v1/coffee/qr.svg` | The QR code of the coffee link (SVG) |

Every data endpoint takes `?lang=en|de|fr|es|it` for Pokémon, item and place names (default `en`). Errors are
`{ "error": "…", "code": "…" }` with a fitting status (`401 tokenRequired`, `403 foreignOrigin`, `404 runNotFound` /
`noRun` / `noPlayer` / `notFound`, `405 readOnly`).

## The state

`GET /api/v1/runs/current` (shortened):

```json
{
  "api": 1,
  "run": {
    "id": "c0ffee02", "name": "Ana & Ben", "mode": "soullink", "gen": 4,
    "game": { "id": "pokemon-heartgold", "name": "Pokémon HeartGold", "system": "nds" },
    "createdAt": "2026-10-01T10:00:00Z",
    "status": null,
    "rules": { "typeClause": "global", "dupes": "line", "shinyClause": true, "levelCaps": true, "…": "…" },
    "counts": { "alive": 1, "dead": 1, "caught": 2, "missed": 1, "encounters": 3 }
  },
  "players": [{
    "slot": "p1", "name": "Ana", "color": "#7f9ddb", "live": true, "updatedAt": 1762790000000,
    "badges": 2, "levelCap": { "cap": 19, "boss": { "key": "whitney", "name": "Whitney" } }, "playTime": { "h": 3, "m": 7 },
    "location": { "id": 177, "gen": 4, "name": "Route 29", "at": 1762790000000,
                  "battle": { "kind": "wild", "species": 245, "name": "Suicune", "level": 40, "legendary": "legendary", "sprites": { "…": "…" } } },
    "party": [{
      "slot": "p1", "key": "a", "area": "route-29", "areaName": "Route 29",
      "species": 17, "name": "Pidgeotto", "nickname": "Pip", "level": 18,
      "hp": 20, "maxHp": 30, "status": "", "fainted": false, "item": { "id": 245, "name": "Poison Barb" },
      "shiny": true, "egg": false, "dead": false, "alive": true, "inParty": true, "legendary": null,
      "sprites": {
        "style": "gen4",
        "front": "http://127.0.0.1:47390/api/v1/sprites/gen4/front-shiny/17.png",
        "back": "http://127.0.0.1:47390/api/v1/sprites/gen4/back-shiny/17.png",
        "frontNormal": "…/gen4/front/17.png", "frontShiny": "…/gen4/front-shiny/17.png",
        "backNormal": "…/gen4/back/17.png", "backShiny": "…/gen4/back-shiny/17.png",
        "icon": "…/icon/front/17.png", "artwork": "…/artwork/front-shiny/17.png", "animated": "…/animated/front-shiny/17.gif"
      }
    }]
  }],
  "links": [{ "area": "route-29", "name": "Route 29", "state": "alive", "members": { "p1": { "…": "a party member" }, "p2": { "…": "…" } } }],
  "graveyard": [{ "area": "cherrygrove", "name": "Cherrygrove City", "diedAt": 1762780000000, "level": 9, "by": "p2",
                  "killer": { "species": 241, "name": "Miltank", "level": 19, "kind": "trainer" }, "members": { "p1": { "…": "…" }, "p2": { "…": "…" } } }],
  "encounters": [{ "area": "route-29", "name": "Route 29", "state": "alive", "at": 1762770000000,
                   "results": { "p1": { "outcome": "caught", "species": 16, "name": "Pidgey", "level": 5, "nickname": "Pip", "shiny": false, "at": 1762770000000 }, "p2": null } }],
  "feed": [{ "id": "…", "at": 1762790000000, "type": "catch", "slot": "p1", "area": "route-29", "areaName": "Route 29", "species": 16, "name": "Pidgey" }],
  "lang": "en", "generatedAt": 1762790001000, "updatedAt": 1762790000000
}
```

Field notes:

- `run.mode`: `soullink` (2–4 players) or `nuzlocke` (one player). `run.gen`: 1–5. `run.status`: `null` while the
  run is on, else `{ state: "failed" | "won" | "ended", reason, at, by }`.
- `run.rules`: the run's rules with souldew's defaults filled in (SoulLink: `typeClause`, `dupes`, `shinyClause`,
  `gifts`, `levelCaps`, `failKillsPair`, …; Nuzlocke: `blackout`, `deathless`, `dupes`, `statics`, `nicknames`,
  `levelCaps` (`false` / `"warn"` / `"strict"`), …).
- `players[].color`: the player's colour in souldew (p1 blue, p2 pink, p3 green, p4 violet). `live`: the game sent
  data in the last 10 minutes. `badges`, `playTime`, `levelCap` and `location` are `null` until the game has been
  read. `levelCap`: HeartGold/SoulSilver's curated caps, else the vanilla gym aces of Gen 1/2; `null` when the run
  has no caps or the game has none.
- `location.battle`: the battle the player is in right now (`kind`: `wild` – static encounters like a legendary in
  its cave count as wild – or `trainer`), `null` outside battles.
- `party[]`: the live party when the game runs, else the team from the board. `level` is `null` when unknown;
  `hp`/`maxHp` `null` when unknown; `status`: `slp psn tox brn frz par` or `""`; `fainted`: 0 HP; `dead`: its link is
  in the graveyard; `alive`: neither. `item`: the held item (`name` from the Gen 3–5 tables, `null` in Gen 1/2) or
  `null`. `area` / `areaName`: the encounter area it counts for (`null` = not tracked). `legendary`:
  `"legendary"`, `"mythical"` or `null`. `inParty: false` marks a link member that sits in the box.
- `links[]`: every area where all players caught something (`alive`) or whose group died (`dead`), with each
  player's Pokémon (`null` if none). In a Nuzlocke a link has one member.
- `encounters[]`: every area with any result, in the order they happened. `state`: `alive`, `dead`, `failed`
  (someone missed) or `waiting` (not everyone has a result yet). `results[slot].outcome`: `caught` or `missed`.
- `graveyard[]`: dead links, newest first, with the killer when souldew saw the battle.
- `feed[]`: the 20 newest log entries (`catch`, `death`, `badge`, `evolve`, …).
- Times are milliseconds since 1970 (`Date.now()`).

## Live events (Server-Sent Events)

```
GET /api/v1/runs/current/events?lang=en
```

The stream starts with `event: hello` (`{ api, run, lang, events }`) and `event: state` (the whole state, as above).
After that, whenever the run changes (the app saves several times a second while you play), you get the events that
happened and then one fresh `state`. Browsers reconnect by themselves (`retry: 2000`); a comment line (`: ping`)
comes every 20 s. Every event's data has `type`, `run` and `at`, plus:

| Event | Data |
|---|---|
| `run-start` | `resumed` (`true` after a failed run was resumed, `false` when the first game data arrives) |
| `run-end` | `state` (`failed` / `won` / `ended`), `reason`, `slot` |
| `catch` | `slot, area, areaName, species, name, level, nickname, shiny, complete` (every player caught there) |
| `missed` | `slot, area, areaName, species, name` – an encounter that got away |
| `death` | `area, areaName, slot, members: [{ slot, species, name, nickname, level, shiny, sprites }], killer` |
| `faint` | `slot, key, mon` – a party member dropped to 0 HP |
| `level-up` | `slot, key, from, to, mon` |
| `evolve` | `slot, key, from, fromName, to, toName, mon` |
| `badge` | `slot, badges` |
| `party` | `slot, size, species: [ids]` – the team changed (order, caught, deposited) |
| `location` | `slot, from: { id, name } \| null, to: { id, name }` |
| `battle-start` | `slot, kind (wild / trainer), species, name, level, legendary, location, sprites` |
| `encounter` | Same as `battle-start`, wild battles only – "a wild Pokémon appeared" |
| `battle-end` | `slot, kind, species, name` |
| `legendary` | Same as `encounter`, for a wild legendary or mythical |
| `coffee` | The coffee pop-up (below) |

`mon` is `{ slot, key, species, name, nickname, level, shiny, sprites }`.

## Sprites

```
GET /api/v1/sprites/{style}/{variant}/{id}.png
```

The images come from PokeAPI's sprite collection and are cached by souldew on first use (the app pre-loads the
default and HeartGold/SoulSilver sets), so they work offline afterwards. Long cache headers – the URLs never change.

| `style` | What | Species |
|---|---|---|
| `default` | Modern 96 px sprites | 1–1025 |
| `gen1` … `gen5` | Red/Blue, Crystal, Emerald, HeartGold/SoulSilver, Black/White | up to 151 / 251 / 386 / 493 / 649 |
| `artwork` | Official artwork (475 px), no back | 1–1025 |
| `animated` | Black/White animated, `.gif` | 1–649 |
| `icon` | Menu icons (Gen 7), front only | 1–807 |

`variant`: `front`, `back`, `front-shiny`, `back-shiny` (Gen 1 has no shiny). A combination that doesn't exist answers
`404`. You rarely need to build these yourself: every Pokémon in the state carries `sprites` in the run's own style
(the game's generation where the species exists in it, else `default`) – exactly what the app and souldew's
overlays show.

## The coffee pop-up

When a player meets a **legendary or mythical** Pokémon in a wild battle (static encounters included) while live
tracking runs, souldew rolls once for that species in that run: with a 25 % chance – at most once every 20 minutes –
a pop-up with a joke about that Pokémon and the "Buy me a coffee" link shows on stream, in souldew's Alerts overlay.
Settings › About switches it off.

Custom layouts get the same moment as `event: coffee` (also for previews, with `test: true`):

```json
{ "id": "coffee:c0ffee02:150:1762790000000", "type": "coffee", "run": "c0ffee02", "at": 1762790000000,
  "slot": "p1", "player": "Ana", "species": 150, "name": "Mewtwo", "level": 70, "kind": "legendary",
  "jokeId": "species:150", "joke": "Mewtwo has entered the chat. souldew’s developer has entered the coffee shortage.",
  "kicker": "Legendary encounter", "cta": "Buy the souldew dev a coffee", "scan": "Scan or visit",
  "url": "https://buymeacoffee.com/souldew", "short": "buymeacoffee.com/souldew",
  "qr": "http://127.0.0.1:47390/api/v1/coffee/qr.svg", "corner": "bl", "showMs": 12000, "layer": true,
  "sprites": { "…": "…" } }
```

Every wild legendary also sends `event: legendary`, pop-up or not – handy for your own "a legend appeared!" moment.

## Examples

### A party list (OBS browser source)

Save this as `party.html` and add it to OBS as a **Browser** source with **Local file** ticked (or open it in a
browser). It lists every player's team with sprites and updates the moment something happens. No styling – that part
is yours.

```html
<!doctype html>
<meta charset="utf-8">
<title>My party</title>
<body>
<div id="out">Waiting for souldew …</div>
<script>
  const API = 'http://127.0.0.1:47390/api/v1'; // the address from souldew's Stream page
  const LANG = 'en';                           // en, de, fr, es, it
  const TOKEN = '';                            // only if you switched on "Require a token"
  const q = `?lang=${LANG}${TOKEN ? `&token=${TOKEN}` : ''}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function render(state) {
    document.getElementById('out').innerHTML = state.players.map((p) => `
      <h2 style="color:${p.color}">${esc(p.name)} – ${p.badges ?? 0} badges</h2>
      <ul>${p.party.map((m) => `
        <li>
          <img src="${m.sprites.front}" width="64" height="64" alt="">
          ${esc(m.nickname || m.name)} Lv ${m.level ?? '?'}
          ${m.hp !== null ? `– ${m.hp}/${m.maxHp} HP` : ''} ${m.status} ${m.shiny ? '✨' : ''} ${m.dead ? '(dead)' : ''}
        </li>`).join('')}
      </ul>`).join('');
  }

  // the live stream sends the whole state right away and again after every change
  const events = new EventSource(`${API}/runs/current/events${q}`);
  events.addEventListener('state', (e) => render(JSON.parse(e.data)));
</script>
```

### Reacting to events

```html
<script>
  const events = new EventSource('http://127.0.0.1:47390/api/v1/events?run=current&lang=en');
  const log = (text) => console.log(new Date().toLocaleTimeString(), text);

  events.addEventListener('catch', (e) => { const d = JSON.parse(e.data); log(`${d.name} caught on ${d.areaName}`); });
  events.addEventListener('death', (e) => { const d = JSON.parse(e.data); log(`RIP ${d.members.map((m) => m.nickname || m.name).join(' & ')}`); });
  events.addEventListener('level-up', (e) => { const d = JSON.parse(e.data); log(`${d.mon.name} → Lv ${d.to}`); });
  events.addEventListener('location', (e) => { const d = JSON.parse(e.data); log(`${d.slot} is now in ${d.to.name}`); });
  events.addEventListener('encounter', (e) => { const d = JSON.parse(e.data); log(`A wild ${d.name} (Lv ${d.level}) appeared!`); });
  events.addEventListener('coffee', (e) => { const d = JSON.parse(e.data); log(`${d.joke} – ${d.short}`); });
  events.addEventListener('run-end', (e) => log(`Run over: ${JSON.parse(e.data).state}`));
</script>
```

### From a terminal

```sh
curl -s http://127.0.0.1:47390/api/v1/runs/current | jq '.players[] | {name, party: [.party[] | .name]}'
curl -N http://127.0.0.1:47390/api/v1/runs/current/events      # watch the events scroll by
```

## Tips

- One source per URL is plenty: the `state` event has everything. A browser keeps at most six open connections per
  address – souldew's own overlays share them – so use `127.0.0.1` for your layout if you also run souldew overlays on
  `localhost` (or the other way round).
- Keep souldew open while you stream; when it's closed, `EventSource` keeps retrying every 2 s and picks up where it
  left off.
- Polling instead of a stream is fine too: `GET /runs/current` every second or two.
- Field reference in code: `shared/streamapi.mjs` (state, events, sprites), `server/lib/streamapi.mjs` (endpoints,
  access rules), `shared/coffee.mjs` (pop-up rules and texts).
