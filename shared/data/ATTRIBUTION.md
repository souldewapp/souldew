# Data attribution

## pokeapi.json
Built on 2026-10-17 from the CSV files in the PokéAPI repository
(https://github.com/PokeAPI/pokeapi, `data/v2/csv/`); moves (up to Gen 7) and held items (Gen 3–7) – and
moves.json – rebuilt from the same source on 2026-11-12.

- PokéAPI code is licensed under the BSD 3-Clause License,
  © 2013–2023 Paul Hallett and PokéAPI contributors.
- The game data itself (names, stats, types, moves and so on) is © Nintendo, Game Freak
  and The Pokémon Company. PokéAPI provides it under fair use, and this project uses it
  the same way, for a non-commercial fan tool.
  Pokémon and Pokémon character names are trademarks of Nintendo.

## Sprites (sprite_sources.json)
URL patterns point to https://github.com/PokeAPI/sprites. The repository is distributed under
CC0 1.0, but all image contents are © The Pokémon Company. Sprites are fetched at
runtime or cached locally and are not redistributed.

`locations_gen6.json` / `locations_gen7.json` (Gen 6/7 met location names, English and German) come from PKHeX
(https://github.com/kwsch/PKHeX, GPL-3.0), `PKHeX.Core/Resources/text/locations/gen6|gen7`. The 3DS party addresses in
`addresses.json` (platform `3ds`) follow Citra-Tracker v2, Pokémon Stream Tool and PokeReader (see `research/azahar.md`).
The 3DS covers in `web/assets/covers/` come from libretro-thumbnails like the others.
The 3DS games' catch rates in `shared/live/catch3ds.mjs` (the battle helper's catch chance) come from PKHeX's personal
tables (`PKHeX.Core/Resources/byte/personal/personal_xy|ao|sm|uu`, GPL-3.0), built by `scripts/build-catchrates-3ds.mjs`;
the GB/GBA/DS games' are read from the running ROM itself.

The place names in German, Spanish, French and Italian in `locations_gen2_crystal.json`, `locations_gen3.json`, `locations_gen4.json`, `locations_gen5.json`, `locations_gen6.json`, `locations_gen7.json` and `maps.json` (`gen1Locations`)
come from the same PKHeX lists (https://github.com/kwsch/PKHeX, GPL-3.0, `PKHeX.Core/Resources/text/locations/gen2` … `gen7`), merged by
`scripts/build-location-names.mjs`.

This project is not affiliated with or endorsed by Nintendo, Game Freak, The Pokémon Company or PokéAPI.
