# Streaming with souldew

OBS overlays, Pokélink themes and the overlay API. Back to the [README](../README.md).

## Streamer mode

**Streamer mode** (Stream page): one switch covers invite codes (also in the "copied" toast), folders and file names, the Discord webhook and locks the spoiler tab. A LIVE badge shows next to "souldew".

## OBS overlays

Each widget has a live preview, its own URL and **Drag into OBS** (the browser source gets the right size via `layer-width`/`layer-height`):

- **Team strip** – one column per linked group with level, HP, status, shiny sparkle; dead groups turn grey.
- **Team card** – one player in detail with HP numbers, badges and play time.
- **Counters** – alive, graveyard, caught, badges per player.
- **You are here** – each player's location and current battle.
- **Alerts** – death (with the whole linked group and the opponent), catch, badge, evolution, every 10th level, run over; optional chiptune sound.
- **Stats bar.**

Options per widget (layout, players, nicknames/HP/area names) and for all (glass/solid/minimal look, 75–150 % size, language). Overlays get changes pushed instantly, show "reconnecting …" if the app goes away and keep the last picture. "Test alert" sends a sample to every open overlay, and the page shows which widgets are live in OBS right now. Old links (`/overlay?run=…`) keep working.

## Overlay API

Everything runs on this computer only (`127.0.0.1`), read-only, without room keys, file names, device IDs or spoilers. The app port is normally `47390`; if that's taken the app picks a free one (the Stream page shows the real addresses).

**Snapshot** – `GET /api/runs/<id>/overlay?lang=en` (run ID from the Stream page, language `de|en|fr|es|it`):

```json
{ "v": 1, "id": "aaaa0004", "name": "Robin & Kim", "mode": "soullink", "gen": 4, "slots": ["p1", "p2"],
  "players": { "p1": { "name": "Robin" } },
  "doc": {
    "live:p1":  { "badges": 3, "playTime": { "h": 4, "m": 7 }, "party": [{ "key": "…", "area": "route-29", "species": 155, "nick": "EMBER",
                  "level": 20, "hp": 30, "maxHp": 34, "status": 0, "shiny": false }], "at": 1761000000000 },
    "party:p1": ["starter", "route-29"],
    "enc:route-29:p1": { "outcome": "caught", "species": 161, "level": 3, "nickname": "", "shiny": false },
    "pair:route-29": { "state": "alive" },
    "where:p1": { "gen": 4, "id": 177, "name": "Route 29", "fight": { "kind": "wild", "species": 16, "level": 3 } },
    "feed:…":   { "at": 1761000000000, "type": "catch", "slot": "p1", "area": "route-29", "species": 161 }
  },
  "species": { "155": "Cyndaquil" }, "areas": { "route-29": "Route 29" }, "at": 1761000000000 }
```

`status` is the game's status word (Gen 3/4: bits 0–2 sleep, 3 poison, 4 burn, 5 freeze, 6 paralysis, 7 toxic) or a short code; `hp` 0 means fainted, `pair:<area>.state` `dead` means in the graveyard. Field names and meaning: `shared/overlay.mjs`.

**Live** – `GET /api/runs/<id>/overlay/events?lang=en` is a Server-Sent Events stream: an `event: snapshot` with the same JSON right away, then a new one on every change (about 150 ms after it is saved); `event: test` for "Test alert", `event: gone` when the run was deleted. Pages of other websites get a 403 – an OBS browser source (no `Origin`) or a local script may read.

## Pokélink themes

Switch on the **Pokélink bridge** on the Stream page. souldew then also listens on `127.0.0.1:3000` (port configurable) and speaks the socket.io protocol the themes from [pokelink-web-sources](https://github.com/pokelinkapp/pokelink-web-sources) expect (socket.io-client 2.x, Engine.IO 3). Open a theme with the ending shown on the Stream page instead of its own `?user=…`, e.g. `index.html?user=Robin&server=http://127.0.0.1&port=3000`; `user` is the player's name or `p1`–`p4`. The run selected on the Stream page is used. Events:

- `client:players:list` on connect: `[{ id, username, party: [{ slotId: 1–6, pokemon | null }], trainer: { name, game: { id: "POKEMON HG", friendlyName, generation }, badges: [{ name: "Zephyr", value: 0|1 }] } }]`
- `client:party:updated` `{ id, username, update: { party } }` and `player:trainer:updated` `{ id, username, trainer }` when something changes for that player
- `player:party:death` `{ username, pokemon }` when a Pokémon goes to the graveyard
- `pokemon`: `pid, species, speciesName` (English – themes build the sprite name from it), `nickname, level, hp: { current, max }, isShiny, isEgg, isFemale, isGenderless` (0/1), `heldItem` (the game's item ID), `status: { psn, slp, par, frz, brn }`, `dead, types: [{ label }], move1`–`move4: { name, type }, locationMet` (area name). Values souldew doesn't read (EXP, nature, ability, IVs/EVs, Pokérus) come empty or 0.

Allowed are themes opened from disk (`file://`), from this computer and from Pokélink's own sites (`*.pokelink.xyz`, `pokelink.app`); other websites get no readable answer. If Pokélink itself is running, port 3000 is taken – close it or pick another port in souldew.
