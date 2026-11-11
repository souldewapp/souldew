# Azahar (Nintendo 3DS) – how souldew talks to it

Researched 2026-11-11 against github.com/azahar-emu/azahar (release 2126.2 and master). Code: `server/lib/azahar.mjs`,
`shared/ctr.mjs`, `shared/live/gen67.mjs`.

- **RPC server** (`src/core/rpc/`): UDP port 45987, off by default (`[Debugging] enable_rpc_server` in qt-config.ini,
  Settings › Debug). Packets: 16-byte header { u32 version = 2, id, type, size } + ≤ 32 KiB, little-endian. 2126.2 has
  ReadMemory 1, WriteMemory 2, ProcessList 3, SetGetProcess 4, TakeScreenshot 5, ReadScreenshot 6, GetPerfStats 7;
  master (2127) adds SetFreeCam 8, SaveState 9, LoadState 10, SetInput 11. Version-1 clients (old Citra scripts) get
  no answer.
- **It binds 0.0.0.0** (`udp::endpoint(udp::v4(), 45987)`): reachable from the LAN while Azahar runs, read and write.
  souldew switches it on only after saying so (play view), never silently.
- **Reads are not synchronised with emulation** unless built with ENABLE_SCRIPTING_SYNC – the PK6/PK7 checksum and the
  "shrink only after two reads" rule in gen67.mjs cover torn reads. Without a selected process reads go to the
  current one; souldew selects the game's (process list → title ID 00040000…, or 0 for `.3dsx` homebrew).
- **The RPC server only runs while a game runs** (System::Load) – Azahar open without a game doesn't answer.
- **macOS UDP**: datagrams > 9216 bytes need bigger socket buffers; Azahar 2126.2 raises its own (EnsureBufferSize),
  souldew's client raises its receive buffer.
- **Settings folder**: portable `user/` next to azahar.exe (Windows) or next to Azahar.app (macOS – LaunchQtFrontend
  makes the .app's folder the working directory, then SetUserPath looks for ./user); otherwise
  %APPDATA%\Azahar, ~/Library/Application Support/Azahar (or the XDG folders if an older setup made them),
  $XDG_CONFIG_HOME/azahar-emu (Flathub: ~/.var/app/org.azahar_emu.Azahar). No command-line option for it.
- **macOS `open -a`** with Azahar already running only activates it – the game isn't passed on. souldew refuses a
  second start with a message instead.
- **Files**: Azahar starts .3ds/.cci/.cxi/.3dsx/.app/.elf/.axf and its compressed .zcci/.zcxi/.z3dsx ("Z3DS" header,
  Zstandard); a .cia is installed (File › Install CIA, or `-i` which shows a dialog and exits).
- **Party addresses** (game process): X/Y 0x08CE1CE8 (1.0) / 0x08CE1CF8 (1.5), ORAS 0x08CF727C (1.0) / 0x08CFB26C (1.4),
  Sun/Moon 0x34195E10, Ultra Sun/Moon 0x33F7FA44; six slots 0x1E4 apart, encrypted PK6/PK7 (232 bytes) and the
  encrypted party stats at +0x158. Sources: Citra-Tracker v2 (kcblack42), Pokémon Stream Tool (Readek, Citra memory
  locations), PokeReader (zaksabeast, latest updates). Badges (Gen 6): X/Y 0x08C6A6A0 / 0x08C6A6B0, ORAS 0x08C6DDD4 /
  0x08C71DC4 – each update moves party and badges by the same distance.
- **Wild opponent** (not used yet): X/Y 0x081FF744, ORAS 0x081FFA6C, SM 0x3002F7B8, USUM 0x3002F9A0 (PokeReader) – a
  start for a 3DS battle panel.
