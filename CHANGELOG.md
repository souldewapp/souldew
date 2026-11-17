# Changelog

`npm run release` takes the release notes from the section of the version being released.

## Unreleased

- **Pokémon Locator** (thanks to a player for the idea). A new “Locator” page in the sidebar: pick one of your Game Boy Advance games, search a
  Pokémon and see where it can be found – area, method (walking, surfing, Rock Smash, the three rods), level range and
  chance – or pick an area and see its Pokémon. It is read from the game file itself, so a ROM hack's changed encounters,
  new Pokémon and own area names show as they are; a game whose encounter tables can't be read with confidence is left
  out instead of guessed at. This first version covers Ruby, Sapphire, FireRed and Emerald (checked in the USA games). The
  slot chances are the retail games' fixed ones; Repels, Flutes, Sweet Scent, chaining, abilities, held items, swarms,
  roamers, gift and static encounters and the other generations come later. It works with touch screens too.

## 2.8.1

- **Fast-forward on a key, like in mGBA** (thanks to a player for the idea). Hold Tab to fast-forward while it is held,
  press Shift+Tab to switch fast-forward on or off – both at the turbo speed you picked last. It works in every player
  (the browser player, the fast player and the 3DS player), and Tab no longer moves the focus away from the game while
  you play. Both keys can be changed under Settings › Controls, and under Settings › Controller you can put them on a
  controller button too (none by default). Help › Controls & shortcuts shows the keys you use.
- **“What hits …” in the battle help folds in** (thanks to a player for the feedback). Seeing the opponent's moves before
  it uses them gave a bit too much away, so that part of the battle help is now folded in to its title line by default.
  Click it (or use the keyboard) to unfold it – souldew remembers your choice. Your own moves, the type charts and the
  team check stay as they were.
- **.sgb files work like .gb files** (thanks to a player for the report). Some cartridge readers save Red, Blue and other
  Game Boy games as .sgb (Super Game Boy) files. souldew now takes them everywhere: adding files, drag & drop, zips,
  “Find ROMs on this computer”, recognising the game, ROM hacks, new runs and playing.
- **Catching demos are no longer your encounter** (thanks to a player on Discord). In Emerald, Wally's catching lesson
  in Petalburg City filed the Zigzagoon he catches his Ralts with as your Petalburg encounter, and your own team seemed
  to vanish while it lasted. souldew now recognizes every game's catching demo – the old man in Viridian City (Red, Blue, Yellow,
  FireRed, LeafGreen), Professor Oak's Pikachu in Yellow, the Dude on Route 29 (Gold, Silver, Crystal), Wally (Ruby,
  Sapphire, Emerald), Dawn and Lucas (Diamond, Pearl, Platinum), Lyra and Ethan (HeartGold, SoulSilver), Professor
  Juniper (Black, White) and Bianca (Black 2, White 2) – and the Poké Dude's battles on FireRed and LeafGreen's Teachy
  TV. They never count as an encounter, a missed encounter or a dupe, show no catch chance and can't cost a Pokémon, and
  your team stays on screen the whole time.
- **Black and White: Rotom's forms in the battle helper** (thanks to a player on Discord). Heat, Wash, Frost, Fan and
  Mow Rotom showed Rotom's normal types, so the matchups were wrong. souldew now reads a Pokémon's form in the DS games
  and uses its types and sprite – Rotom, Wormadam, Shaymin's Sky Forme, Arceus with its plate, Castform and the other
  forms – from your ROM where it has them, so randomized and hacked games show theirs. In Diamond, Pearl, Platinum,
  HeartGold and SoulSilver Rotom's forms keep Electric/Ghost, as in those games.
- **The trainer's next Pokémon is the one actually sent out** (thanks to a player on Discord). In Black, White, Black 2,
  White 2, Diamond, Pearl and Platinum the battle helper jumped to the next Pokémon in the trainer's party as soon as one
  went down – but trainers pick their next Pokémon themselves. souldew now follows the battle itself: the defeated
  Pokémon stays until the trainer sends the next one, and the helper shows the one that really comes out.
- **Black, White, Black 2 and White 2: catches sent to the PC are filed right away** (thanks to a player on Discord).
  With a full team, a new catch only showed up once you took it out of the PC – and a wild Pokémon that got away was
  never asked about, since souldew couldn't tell whether it had been caught. souldew now reads the PC live in these games
  too, so both work like in the other games.
- **HeartGold and SoulSilver: the level caps** (thanks to a player on Discord). Falkner's cap was 9 – his Pidgey – instead
  of 13, his Pidgeotto, and the rival at Azalea Town's 20 instead of 18. Marking a gym leader as defeated on the board
  now also moves the cap on to the next one, even before the badge has been read from the game – for every player of a
  SoulLink.
- **Any shiny rate** (thanks to players on Discord). Besides 1 in 4096, 1024, 512 and 256 there is now “Custom…”:
  enter any rate from 1 in 8192 down to 1 in 2 – 1 in 100, 1 in 50, 1 in 10, whatever your run wants. Where a game
  can't do a rate exactly, the wizard says what it does instead (1 in 100 becomes 1 in 99.9). Everyone in a run with a
  custom rate needs 2.8.1 – 2.8.0 refuses its invite and says to update. As before it's for the original Gen 3–5 games,
  and shinies from a raised rate fill the Pokédex but don't count for the shiny achievements.
- **Fast-forward sound keeps up with the game** (thanks to a player on Discord). With “Music continues”, a song souldew
  hadn't heard at normal speed yet played at its normal pace while the game raced ahead – so the game's own sounds, menu
  sounds too, came later and later the longer fast-forward ran, up to half a minute. Now that music skips ahead in small,
  smooth steps and stays at most a second behind the game, at every speed and however long you fast-forward.

## 2.8.0

- **Catch chance in wild battles** (a community idea). The battle help now shows your chance to catch the wild
  Pokémon with a Poké Ball, Great Ball and Ultra Ball – plus a Net, Nest or Beast Ball where it helps. It is worked out
  live with each generation's own formula, from the Pokémon's catch rate, HP, level and status, and uses the game's own
  catch rates, so ROM hacks and randomized runs show the right numbers. The foe's status now shows in the battle help
  too. Status is read in Gen 1–5; in the 3DS games the chance is shown without it, and the panel says so.
- **New rule: Lives** (a community idea). Give a run a number of lives, for example 20. Every Pokémon that falls costs
  one, and the death that takes the last one ends the run. In a SoulLink the lives are shared or per player; only the
  Pokémon that fell costs a life, not the partners that go with it. Undoing a death gives the life back. Lives left show
  on the board, next to the game and in the death notice, with a quiet warning when only a few are left. Off by default
  – set it when you create a run or under Rules.
- **Shiny rate** (a community idea). New runs of the original Gen 3–5 games can make shinies more common: 1 in 4096,
  1024, 512 or 256 instead of 1 in 8192, and in Gen 3 and 4 trainers' Pokémon can be shiny too. It works with and
  without the randomizer, and every player in a SoulLink gets the same rate – so everyone needs this version to join
  such a run (older versions refuse its invite instead of building a game with the normal rate; the invite says so).
  Shinies from a raised rate fill the Pokédex but don't count for the shiny achievements. Not for ROM hacks, Gen 1/2 or
  the 3DS games.
- **Missed encounters remember the Pokémon** (thanks to a player on Discord). When an encounter gets away, souldew now
  fills in which Pokémon it was if it saw the battle. A new switch under the dupes clause, “Fled or knocked-out
  encounters count as dupes”, makes such a Pokémon block its evolution line (off by default). And SoulLinks now ask
  after a wild battle without a catch whether it got away, like solo Nuzlockes do – where the place sign shows the area
  you're in – marking it as spent fails the pair and tells your partner. No more question when the area you're in
  already has your encounter.
- **Messages always in your language** (thanks to a player for the report). Error messages, the log while a run is
  built, save-file problems, update errors and the menu before the app has loaded showed some German text with English,
  French, Spanish or Italian selected. A partner's ping and “boss defeated” in the log now show in your language too.
- **Black and White: the place sign works in every language** (thanks to a player on Discord). In versions other than
  English it showed Black City in the intro and then no place at all. souldew now reads the game's own copy of the
  zone data, and the title screen no longer shows Black City (Black/White, and Black 2/White 2 when switched on).
- **The place sign in every game: the right place or none, never a wrong one.** In Red/Blue/Yellow, Gold/Silver/
  Crystal, the Gen 3 games and Black 2/White 2, souldew now reads where you are from the game's own copy of the current
  map's data and checks it against your ROM. In Diamond, Pearl, Platinum, HeartGold and SoulSilver it reads the place
  from your save data, and only once it has made sure that data really is your game's. Where the game's memory sits
  elsewhere than in the English versions, souldew finds it instead of guessing. No more Pallet Town on Red's title
  screen or Black City when Black 2/White 2 start.
- **Badges and level caps in every language of Diamond, Pearl, Platinum, HeartGold and SoulSilver** (thanks to a player
  on Discord for the report). In versions other than English, souldew found the team but never the badges: the overlay
  showed none and the level cap stayed at the first gym's, so a team at level 10 after Falkner was flagged as over the
  cap. souldew now finds the save data next to the team, so badges, the level cap and the PC update live in German,
  French, Spanish, Italian and every other language too.
- **Eggs stay a surprise until they hatch.** An egg showed on the board and in the team as the Pokémon it will hatch
  into – a spoiler in a randomized game. Eggs now stay out of the board, the team in the play view, savestates and the
  stream API until they hatch, as they already did in the overlay. Once hatched, the Pokémon lands in the inbox as
  “hatched from an egg” in every game; Crystal and Black/White through Ultra Sun/Ultra Moon used to file it as a catch
  on the route where it hatched.
- **A ROM hack started from its library page is the game you get** (#68 – thanks for the report). “New Nuzlocke” /
  “New SoulLink” on a hack like Volt White could build the plain original game: the wizard only offered a patch when
  your ROM's checksum matched the one the hack's notes name, while “Play” patched the same ROM fine. Hacks that come as
  xdelta patches now work with your copy of their base game in new runs too (xdelta checks what it writes; IPS patches
  can't, so they still need the copy their notes name), and if a hack really doesn't fit your ROM, the wizard says so
  instead of switching to the original game.
- **The randomizer says up front when it can't handle a game** (thanks to a player on Discord for the report). When you
  pick a game for a new run, souldew now tries the randomizer on it first. If the game's data isn't laid out the way
  the randomizer expects (some ROM hacks and releases), the randomizer is switched off with that reason, instead of the
  build failing with an error like “Index 1286 out of bounds”. A build that fails anyway explains what happened in your
  language, and two randomizer runs at the same time no longer get in each other's way. Renegade Platinum and Crystal
  Legacy are now listed as not randomizable; Blaze Black 2 Redux is tested and works. When the randomizer stops on a
  game, “Save diagnostics” now records where it stopped, so a report lets us fix that game.
- **Clean sound in the 3DS player at normal speed.** On PCs where the sound arrives unevenly (seen on Windows), the 3DS
  player cut it with clicks after every hiccup and then caught up by squeezing the sound, which made the highs grainy
  and harsh. It now bridges a gap with a soft fade, keeps a slightly larger buffer on such PCs, and catches up with an
  inaudible speed change of at most 0.5 %. In the fast player (Game Boy, GBA, DS) short drop-outs fade instead of
  clicking, too. Save diagnostics now includes the 3DS player's sound drop-outs, to help with sound reports.
- **“Music continues” in the 3DS player: clear music, and battle music that ends with the battle** (thanks to a player
  on Discord for the report). While fast-forwarding, the music of a place souldew hadn't recorded yet came out
  muffled – at 4× nothing above about 1.8 kHz was left. The 3DS player now hands souldew the game's own sound as well,
  so the music keeps its full sound at its normal pitch (measured in Pokémon Sun: the same highs as at 1×). And in the
  3DS games souldew didn't know which song was playing: once it had picked up a battle's music while fast-forwarding,
  that music kept looping after the battle – and came back with the next fast-forward. souldew now follows the place
  you're in and battles (with live tracking running), switches to the battle music when a battle starts and back to
  the place's music when it ends, and no longer files the first moments of a battle under the place's music.
- **A new controller layout works right away** (thanks to a player on Discord for the report). Changing the buttons in
  Settings › Controller or Settings › Controls while a game was open in the corner didn't reach that game – it kept the
  old layout until it was started again, although the settings already showed the new one. Changes now apply at once,
  in every player.
- **The SoulLink dupes rule explains itself.** The rule's hint on the board now says what “Per player” and “For both”
  mean, and which catches count: one from a failed or dead pair does, an encounter that fled or was knocked out doesn't.

## 2.7.4

- **“Playing now” on the souldew Discord.** The server now shows how many people are playing in souldew right now – as
  the locked channel “🎮 Playing now: N” and in the bot's status. It is counted anonymously: only while a game actually
  runs (fast player, 3DS player or browser player), the app sends one small message a minute with the system (GB, GBA,
  DS, 3DS), solo / Nuzlocke / SoulLink, the app version and a random id that is new for every game – no name, no
  account, no game title, no run data, and the bot doesn't store the IP address. Closing the game or the app ends it;
  offline nothing happens. Don't want to be counted? Settings › General › “Count me in ‘playing now’ (anonymous)”
  switches it off at once. Exactly what is sent and kept: [docs/PRIVACY.md](docs/PRIVACY.md); Help › Questions explains
  it too.

## 2.7.3

- **No more false deaths in Black/White and Black 2/White 2 battles** (thanks to a player on Discord for the report). A
  Pokémon that was switched out and grew a level from the shared EXP could be reported as dead – the SoulLink popup came
  up, yet in the game it was fine. souldew reads the live HP from the battle's own data and found each Pokémon there by
  species, level and max HP; once the level-up changed those, it took the wild Pokémon of the same kind instead, which
  had just been knocked out (reproduced in Black 2 in the fast player). It now recognizes every Pokémon in the battle by
  its own ID, so a look-alike opponent never stands in for it, and a level-up mid-battle keeps its live HP. On top of
  that, in every game a Pokémon has to read 0 HP twice in a row before souldew files a death – a real knock-out still
  shows a moment later, in the battle.
- **Hall of Fame** (idea from the community). Won a run? The run-won notice and the board now offer “Post to the Hall
  of Fame”: your final team – in a SoulLink as its linked pairs or groups, each player's Pokémon in their colour – with
  the game, the rules, the deaths, the play time and the players goes up as its own post in the new #hall-of-fame forum
  on the souldew Discord, where everyone can react and congratulate. A preview shows the card first, and nothing is
  posted until you press the button. It needs Live runs (Settings › Discord); without it the notice says how to connect
  with `/live connect`. Partners of the same run share one post. Won runs now go there instead of #live-runs.
- **Rare Candies in the 3DS games on Windows** (thanks to a player on Discord for the report). "Add 99 Rare Candies"
  found the bag but said "The game's memory couldn't be changed." The 3DS player looked for the bag's place in the
  emulator's memory by its content, and on Windows it only searched part of that memory – the part the bag isn't in.
  souldew's build of the 3DS emulator now writes the bytes itself, at the address the game uses, on every system and
  for every game (X/Y, Omega Ruby/Alpha Sapphire, Sun/Moon, Ultra Sun/Ultra Moon) – still only into the game's heaps
  and only after the same checks as before. The messages are clearer too: when a game's bag isn't where its version
  keeps it, souldew says so, and "the game changed your bag just then" has its own message.
- **Smooth sound while fast-forwarding in the 3DS player** (thanks to a player on Discord for the report). On PCs where
  a 3DS game can't hold the chosen speed steadily – its speed swings from moment to moment, which is normal for 3DS
  games – "Sped-up original" and "Plain" stuttered (around ten little gaps a second) and sounded harsh, and "Music
  continues" could play the music at the wrong pitch and tempo when nothing had been recorded for it yet. The 3DS player
  now resamples the game's sound to exactly real time while fast-forwarding, filters it properly before speeding it up,
  and tells the turbo mixer exactly how much it was sped up, so it can slow the music back down to normal pitch and
  tempo. Measured with Pokémon Sun at 2×, 3×, 4× and Max, with the game slowed down the way a busier PC slows it: the
  gaps went from 3–11 a second to almost none, and "Music continues" stays at normal pitch. At 1× the 3DS player now
  runs at the 3DS's own frame rate (59.83 instead of 60 frames a second), so its sound no longer slowly runs ahead and
  skips about once a minute.
- **Modern Emerald is tracked live – and its trophies count** (thanks to a player on Discord for the report). Nothing
  was read in this hack: no team, no catches, no battles, no badges – and so no achievements either. Modern Emerald is
  rebuilt from the Emerald source with things of its own in memory, so its team, its save data and its battle flag
  aren't where they are in Emerald. souldew now finds them from the game's own code and memory instead of assuming
  Emerald's addresses: the team, catches (also when they go to the PC – its 15 boxes), wild and trainer battles,
  badges and the level caps that follow them, and the cheats menu's Rare Candies. Checked in the game with version 3.6
  (Torchic, the Zigzagoon battle, a real catch on Route 101, a badge → cap 19); older versions (1.5.6 – 3.3.1) are read
  the same way. The same search now covers other hacks rebuilt from the Emerald or FireRed source whose memory moved.
  The level caps of hacks with a block of text right in front of the trainer table are read again (every trainer
  was numbered one too high).

## 2.7.2

- **Fast-forward steps one at a time in the 3DS player** (thanks to a player on Discord for the report). Plus went 2× →
  3× → 4×, but minus at 4× dropped straight to 1×, and after a while plus jumped from 1× to 4×. The 3DS player measured
  fast-forward by the pictures it got – and while fast-forwarding the game only sends some of them – so every step looked
  like 1× to souldew, which then stopped offering 2× and 3×. It now counts the frames the game really ran, like the fast
  player: 1×, 2×, 3×, 4× (and Max, when switched on) up and down – on the toolbar, with T, the menu and the controller.
  What was measured wrongly before is forgotten.
- **Sound while fast-forwarding in the 3DS player** (thanks to a player on Discord for the report). It was always silent;
  now Turbo audio works there as in the other players: "Music continues" keeps the music going at normal speed,
  "Sped-up original" and "Plain" play the game's own sound sped up, "Mute" stays silent.
- **3DS resolution: 1×, 2× or 3×** (#59 – thanks to @Never-lab for the write-up). New setting in Settings › Emulators:
  the built-in 3DS player draws the games at two or three times their own resolution – sharper and less pixelated, but
  more work for the graphics card. 1× stays the default; it applies to the next 3DS game you start. The Software renderer
  always plays at 1×, and when "Automatic" has to step down to a safer renderer after a crash, it goes back to 1× too.
  The screen layout menu also has "Smooth picture" (softer scaling instead of crisp pixels), switchable while playing.
- **Rare Candies for the 3DS games.** The cheats menu's "Add 99 Rare Candies" now works in souldew's own 3DS player
  too – X/Y, Omega Ruby/Alpha Sapphire, Sun/Moon and Ultra Sun/Ultra Moon (asked for by an Ultra Moon player). They go
  into the Medicine pocket, onto the candies you carry or into the first free slot, up to 999. As before: only when the
  run's rules allow cheats, every use shows up in the run's log and counts for the trophies, and souldew checks first
  that it really found the bag – if anything looks off, nothing is written. Checked in Sun; X/Y, ORAS and Ultra Sun/Ultra
  Moon use the bag addresses known from other 3DS tools. Not when a 3DS game opens in the Azahar app.

## 2.7.1

- **Catches sent to the PC are tracked in the Gen 3 games** (#61 – thanks to BigPhitty for the report). With a full
  team a new catch goes straight to the PC, and souldew only saw it once it joined the team. The PC boxes of
  FireRed/LeafGreen (English, German, French, Italian, Spanish), Emerald (English) and Ruby/Sapphire (English, German)
  are now read live like in the Gen 4 games: the catch is filed under its route right away, a Pokémon that leaves the
  boxes and the team is noticed, and the board shows how many Pokémon are in the box. (Not in the expanded-engine ROM
  hacks yet.)
- **The built-in 3DS player runs on AMD Radeon cards that crashed it** (RX 9070 XT with the 26.x driver: "3DS game has
  stopped" in the first second). The crash is in AMD's Vulkan driver with Azahar's libretro core since 2126.1 – the
  standalone Azahar is fine (azahar-emu/azahar#2742). The player now creates the graphics device the way standalone
  Azahar does and passes every image the core creates through the workaround found there; and should a graphics
  driver still stop the game in its first seconds, souldew starts it again right away in a more compatible Vulkan mode,
  then with Azahar's software renderer (slower, but no graphics card needed) – remembered for that graphics card and
  driver. New setting Settings › Emulators › "3DS renderer": Automatic (the default), Vulkan, Vulkan (compatibility)
  or Software. "Play 3DS games in Azahar" stays on the message when nothing helps. Crash reports from Windows now name
  the functions that led to the crash, for the next driver that misbehaves.
- **Safe graphics mode for a blank window (Windows, Linux).** Windows gets a second Start menu entry, "souldew (safe
  graphics)", and `souldew --safe-graphics` (or `SOULDEW_SAFE_GRAPHICS=1`) works everywhere: souldew then draws without
  the graphics card – slower, but the window shows. Settings › General says so and lets you pick another graphics
  backend, then "Restart normally".
- **The fast player starts games whose path has letters like ü or é on Windows.** A run named after the German
  "Blattgrüne Edition", or a Windows user name like "Jürgen", ended in "game not readable" and souldew fell back to the
  slower built-in player. Found in the diagnostics file of #61.
- **Randomizer: "Shop items" says which shops change** (#62 – thanks to BigPhitty for the report). The bundled
  Universal Pokémon Randomizer ZX only changes the special shops – department store floors, herb and vitamin sellers,
  the second counter of a Poké Mart – and never the regular Poké Mart list; in FireRed/LeafGreen that's Celadon
  Department Store 4F and 5F. The option now says so, instead of looking like it didn't work.
- **Security hardening from @Never-lab** (#56, #58 – thank you!): unpacking a zip refuses an oversized central
  directory, too many entries and deflate entries that would blow up far beyond their size (a "zip bomb" can no longer
  fill the memory or the disk), and the mGBA live-bridge script, library ROM and patch downloads, save files and the
  app's event stream are only handed to souldew's own pages – not to a typed URL or another program on the computer.
- The library no longer says Black/White read the PC boxes live – they read the team (with the catch location).

## 2.7.0

- **The 3DS games can be randomized.** X/Y, Omega Ruby/Alpha Sapphire, Sun/Moon and Ultra Sun/Ultra Moon now go through
  the bundled Universal Pokémon Randomizer ZX like the Gen 1–5 games: the presets, plus totem Pokémon (Gen 7) and Mega
  Evolution options, a live progress line while the game is rebuilt, and one `.cxi` per player that the built-in player
  and Azahar start directly. Every computer builds the same bytes from the same seed (checked across Java versions), so a
  SoulLink join compares the games as before; with "Same world for everyone" the game is built once. A decrypted dump is
  needed – souldew decrypts nothing and says so when a file is encrypted. About 3 GB and well under a minute per game on
  an SSD. Playing in the Azahar app? Remove the game's update there for the run, it would replace parts of it.
- **Both editions of a pair can share one SoulLink** (#18). In a run without randomizer or ROM hack one player can
  play HeartGold and the other SoulSilver – likewise Red/Blue, Gold/Silver, Ruby/Sapphire, FireRed/LeafGreen,
  Diamond/Pearl, Black/White, Black 2/White 2, X/Y, Omega Ruby/Alpha Sapphire, Sun/Moon and Ultra Sun/Ultra Moon.
  Joining says so ("You play SoulSilver, the host plays HeartGold – that's fine"), the host's run setup mentions it,
  and each player's live tracking, cover and trophies follow the edition they actually play. Encounters stay linked by
  area, so version exclusives need no special rule. Randomized and patched runs still need the exact same release – and
  a ROM that was patched before it was added to the library now counts as patched, too. Thanks to @Never-lab for the
  first version of this in #54.
- **Use souldew with a controller** (#33 – thanks for the request): library, boards, runs, settings, dialogs and menus
  now work with just a gamepad – on the couch or in Steam Deck game mode. The D-pad or left stick moves between
  buttons (held, it repeats), A presses, B goes back (closes the open dialog or menu first), L and R switch the page's
  tabs or the sections of the sidebar, Start jumps into the sidebar and the right stick scrolls; a select steps
  through its options with A (X goes back one). The buttons follow Settings › Controller. A clear ring shows where you
  are while the controller is in use and goes away when you touch the mouse or keyboard. While a game runs the
  controller stays the game's alone – pause it (ZL/LT/L2 or Home), open a menu over it or leave it in the corner, and
  the controller moves to souldew's menus; resuming hands it back once you let go of the button. Turn it off in
  Settings › Controller › "Navigate the app with a controller".
- **Zipped 3DS games show up in the library.** Adding a zip with a Nintendo 3DS game in it ("Pokemon Sun (USA).zip",
  2.6 GB) said the library was updated, but the game never appeared: souldew only looked for Game Boy, GBA and DS
  ROMs inside zips, and could only unpack up to 600 MB. Now the game is unpacked into your library folder as a normal
  file – whether you add the zip with "Add files", drop it into the library or pick it in "Search my Mac / PC" – and it
  is on the shelf like any 3DS game. The zip itself isn't copied into the library. Unpacking streams the game to disk
  (no matter how big), checks its checksum, checks the free disk space first and leaves nothing half-written behind
  if something goes wrong; a toast shows how far it is ("Unpacking Pokémon Sun … 40 % of 4.0 GB").
- **The built-in 3DS player has screen layouts:** top above bottom, side by side, large top with a small bottom
  screen, bottom above top, and top screen only – from the new button in the game's toolbar, switched right away
  without restarting the game. A click on the bottom screen touches it in every layout.
- **Already-patched ROM hacks can be linked to their hack.** A ROM that was patched before you added it
  ("kaizo-emerald.gba") still says Emerald in its header, so it showed up as plain Emerald and never on the Emerald
  Kaizo page. Its page now has "This is a ROM hack…": pick the hack (the hacks of that game, or "Other / unknown hack"
  with a name of your own), and the ROM appears on the hack's page as "Your ROM" with Play, New SoulLink and New
  Nuzlocke – remembered by its checksum, also after renaming it, and undone with one click. When the file name already
  says which hack it is, souldew asks "Looks like Pokémon Emerald Kaizo – link it?" on the ROM's page and in the message
  after adding it. Runs of such a ROM are hack runs: no vanilla level caps, the randomizer follows the hack's entry, and
  joining a SoulLink needs the very same ROM, like any patched run.
- **Zips with 3DS games in your library folders** are no longer passed over in silence: the library lists them under
  "Zipped 3DS games" with an "Unpack" button that puts the game into your library (the zip stays where it is).
- 3DS games and zips can be dropped into the library up to 8 GB (it was 600 MB, too small for most 3DS games).
- **Installing Azahar on Windows works again.** The one-click install stopped with "Entpacken fehlgeschlagen: ENOTDIR …
  plugins\\generic": Azahar's Windows zip names its folders with backslashes ("…\\plugins\\"), and souldew unpacked
  that folder entry as an empty file, which then blocked every file inside it. Folder entries are now folders, an empty
  "file" in the way of a folder gives way, and the download is unpacked next to the old install and only swapped in once
  Azahar is really in it – a failed or interrupted try changes nothing, and the next try starts clean (also after the
  broken installs of earlier versions). While Azahar runs, souldew says so instead of deleting half of it.
- **Install and start errors of the external emulators are in your language** – no internet, a GitHub error, no build
  for your system, a failed download or unpack, files in use – instead of German text for everyone.
- **When the built-in 3DS player stops, souldew says why and offers Azahar.** The message shows how the game ended
  (e.g. "exit code 0xC0000005 (access violation)"), with one click to play 3DS games in Azahar instead (Settings ›
  Emulators › Nintendo 3DS) and a "Save diagnostics" button. The diagnostics now hold the 3DS player's graphics card,
  driver and Vulkan loader, how its last games ended and what it wrote last (also kept in the data folder's
  logs/players.log across restarts).
- **3DS player on Windows / Linux graphics cards:** Azahar's core turned on optional Vulkan features (timeline
  semaphores, extended dynamic state, 8-bit indices, shader barycentrics/interlock, pipeline cache control) whenever the
  card offers them – although the device it creates for the player never enables them. MoltenVK on the Mac ignores
  that, other drivers may crash on it; the player now shows the core only what its device really has. It also picks the
  dedicated graphics card before an integrated one (CTRHOST_GPU=n picks another), checks every Vulkan step and reports
  a lost device instead of freezing, and no longer leaves a Windows error dialog behind when it crashes.
- **An encrypted 3DS game file is named as such** ("souldew and Azahar only play decrypted games …") instead of "the
  core couldn't load the game" – when you play it and when you randomize it.
- Settings › Emulators no longer says 3DS games only run in Azahar.
- **"Share to Discord" also works where `workers.dev` is blocked.** Some DNS filters (school, work or parental
  filters) block every `*.workers.dev` address, so linking and posting failed with "offline". souldew now talks to the
  bot at `api.souldew.app` and only falls back to the old address when that can't be reached at all.

## 2.6.3

- **A newer version of a ROM hack's patch is the one that's used.** Adding an update next to the old file
  ("Run&Bun 1.08" beside "Run&Bun 1.07") said "Library updated", but the hack's page, Play and new runs kept using the
  old version – on Windows always the older file. The newest version now comes first (by the version in the file
  name, else the file added last), and when a hack has several patch files its page and the new-run wizard let you
  choose between them, each shown with its file name.
- **Patches for hacks souldew doesn't know show up in the library.** They used to be added without appearing anywhere
  but the new-run wizard. Now each gets a card on the ROM hacks shelf, named after the file with its version
  underneath, and a page like the known hacks have: the base game when the patch says which ROM it needs, Play and
  "Save patched game" once that ROM is in your library, new runs, and a version picker when you have several.
- **Adding files says what was actually added** – "Added: Pokémon Run & Bun 1.08 (patch)", "2 games and 1 patch
  added", "Already in your library", or which files held nothing souldew can use – instead of always "New games are
  on the shelf".

## 2.6.2

- **Randomized SoulLinks with "only sensible items" for trainers build the same game everywhere.** On Gen 4/5 games this
  option added weakness berries in an order that depended on the Java version, so two computers with different Java
  could build different ROMs from the same seed and settings. souldew now ships a fixed copy
  of the randomizer's one affected class, so every computer builds byte-identical games. New
  "Nuzlocke hard mode" runs on DS games get different trainer items than before; existing runs keep their files.
- **Undoing a death in a deathless Nuzlocke only reopens the run when no other death stands** (#35). When a second
  Pokémon had died after the run ended and you undid the first death, the run went on with a dead Pokémon on the
  board; now the remaining death becomes the reason the run ended, and the run reopens once no death is left.
- **A bonus Pokémon's death counts like any other** (#37): marking a kept shiny or gift as died on the Routes page
  ends a deathless Nuzlocke, and undoing it reopens the run – also after a "box" blackout.
- **"Box" blackout waits for Pokémon you haven't filed yet** (#36): a living Pokémon in your team that still waits in
  "From your game" (a held shiny, a gift, a catch while auto-assign is off) now keeps the run going.
- With auto-death on, a new catch that is already knocked out when it is first read is marked dead right away (#39),
  like any Pokémon tracked before – instead of only asking.
- With "a missed encounter costs the whole pair/group" off, the partner's catch from that area now counts for the
  type rule like every other Pokémon in the team (#38). The stream API docs explain what `failed` means then.
- The browser copy of a run is written once changes settle instead of on every change – live HP in battles no longer
  writes the whole run each time (#44).

### Security

Hardening found in a code review and reported by @Never-lab – thank you:

- **The stream API answers Chrome's "private network" check only where the request itself may get through** (#41):
  with a token set, for the public sprites and data, and for the pages allowed without a token. A website that would
  be turned away anyway no longer gets that permission ahead of the request.
- **Error answers no longer carry the randomizer's raw output** (#43), which is full of local file paths; it goes to
  the app's log instead.
- The stream API docs recommend sending the token as a header from `fetch` and keeping it out of page addresses
  (#42).

## 2.6.1

- **Joining a SoulLink works with another release of the same game.** A normal run (no randomizer, no ROM hack) used
  to accept only the host's exact release, so e.g. Platinum Rev 1 couldn't join a run hosted with the original
  Platinum, although everyone plays their own copy anyway. Now any release of the game fits – another revision,
  region or language; the host's exact release is still picked first if you have it. Randomized and patched runs
  still need the exact release (everyone builds the same bytes there), and the message now names it – e.g.
  "Pokemon - Platinum Version (USA)" – and lists the releases you have, instead of only a CRC32.

## 2.6.0

- **The fast player: DS, GBA and Game Boy games at full speed, with fast-forward that really reaches 4× and more.**
  The games now run in the real emulators directly on the computer – melonDS (the same engine as the melonDS app,
  with its recompiler), mGBA and Gambatte – instead of inside the app's browser engine. A Mac with Apple silicon
  runs Platinum at about 9× and Black 2 at about 7× of full speed (before: about 1.6× for the heavy DS games), GBA
  and Game Boy games far beyond that – headroom that weaker PCs need for full speed. Live tracking, cheats, save states, the
  in-game save, the touch screen, controllers, screenshots and the partner's mini view work as before. Save states
  made in the old player can't be loaded in the new one (and the other way round); your in-game saves carry over.
  Settings › Emulators › "Fast player" switches back to the old player, and a game the fast player can't start opens
  in the old one by itself.
- Black/White (1 and 2) run in the fast player with their in-game save: saving and starting again from that save was
  checked in Black. HeartGold starts in it and holds 4× in a first short test on a Mac; a full HeartGold/SoulSilver
  run hasn't been checked yet.
- Fast-forward music (Settings › Turbo music) works in the fast player too.
- The 3DS player sends its commands to the emulator in batches, like the fast player – long sessions no longer pile up
  memory in the app's page.
- **Share to Discord (Live runs):** link souldew to your Discord account once (Settings › Discord, with the code from
  `/live connect`) and share big moments to #live-runs on the souldew Discord – from the death notice, a graveyard
  entry and the notice when a run is wiped, over or won. Each post is a card in souldew's look: the headline, what the
  Pokémon fell to (species, level, wild or trainer battle, the place sign where it happened), every player's team side
  by side with the fallen group marked, and the run in numbers. Shared moments stay marked "Shared ✓" – also when a
  partner shared it first. The link only lives on your computer (not in runs, invites, exports or diagnostics), the
  page never sees it, and streamer mode covers your Discord name. Nothing is posted unless you press the button.
- A death read live now keeps the place it happened at (the place sign), not only the battle it fell in.
- **"What's new" after an update is easy to read:** the release notes show as a list with bold headings instead of
  raw text that broke lines in the middle of sentences. The update feed carries them unwrapped too, so older versions
  show the next notes in whole lines.
- The symbols on the trophy medals sit exactly in the middle (they were half a pixel right and low; the rings and the
  crown sat too high).
- Starting a run again when its game is gone: the hint now names the real button, "Adjust settings …".
### Security

All found in a code review and reported by @Never-lab – thank you:

- **Run data saved by the app can't be pinned with a date far in the future** (#19): the app already ignored a change
  that claimed to be made days ahead (it would win over every later change of that entry), but the copy souldew keeps
  on disk accepted it. Both now apply the same limit (one day ahead at most).
- **Files of a run stay in the run's folder** (#20): the ROM, save and spoiler log of a run are looked up by name in
  its `run.json`; a damaged or hand-edited name (`../…`) or a link inside the folder that points elsewhere could make
  souldew start, serve or overwrite a file outside the run. Every such path is now checked, also after following
  links. Along the way: a 3DS run no longer offers its ROM as "Save my save file" (3DS saves live in the player's
  own folder).
- **An installed app never takes an unsigned update** (#24): a build without the release's public key (a fork, or a
  build made without `--init-key`) used to accept an update feed that was only protected by HTTPS. Installed apps now
  refuse to look for updates without the key; only development (`npm run app`) may check an unsigned feed. The
  official releases always carried the key and are not affected.
- **Overlay texts are escaped for every place they can go** (#26): the OBS overlays escaped names for element text
  and double-quoted attributes, not for single quotes or backticks. No overlay used such a place, but now the escape
  covers them too, a player slot reaches the overlay's styles only as p1–p4, and the emulator page's "Click to start"
  label is set as plain text. The example in `docs/STREAM_API.md` escapes the same way.
- **"Allow" for an invite code checks the 4 digits** (#22): both apps show the same 4 digits when the right two
  people are talking to each other, but the host could press Allow without comparing them. Now the host types in the
  digits the joining player's app shows; Allow stays off until they match, and the app sends the invite only with the
  matching digits. Joining between this version and 2.5.0 keeps working (the digits are computed the same way).
- **The Pokélink bridge answers fewer pages** (#25): it used to let any page served from this computer
  (`localhost` on any port – a dev server, another program's web page) read your teams. Now it answers themes opened
  from disk, Pokélink's own sites and souldew's own pages; a theme served by another local web server needs the new
  switch **Also themes from another web server on this computer** on the Stream page. A theme added in OBS with
  **Local file** ticked now connects too (OBS serves those from its own `http://absolute/` address, which the bridge
  didn't know). SECURITY.md lists what the stream features show on purpose (teams and other spoilers) and what they
  never do (keys, codes, paths).
- **Stream API and the app's private data are tighter** (#21):
  - Without a token the stream API (`/api/v1`) now answers OBS (browser sources and **Local file** sources), scripts
    and souldew itself. Layouts opened from disk in a browser and pages of other local web servers need the token or
    the new switch **Pages on this computer without a token, too** on the Stream page – a page from disk can't be told
    apart from a sandboxed frame on a website. Installs from before keep the old rule (the switch starts on), so
    existing layouts keep working; new installs start with it off.
  - The app's own requests for the run pack (room key), a run's files and spoiler log, the Discord webhook, the stream
    token and the folder list now need to come from the app itself (its header or a same-origin request) – a typed
    URL or another program gets nothing. The OBS overlays don't use any of them.
- **The library only copies from places you chose** (#23): adding games took any file path the page sent, and
  "Use a folder" any folder. Now files come only from the places "Search my Mac / PC" looks through, folders already
  in your library, and files or folders you picked in souldew's own file dialog (the app registers those itself – a
  page can't). "Use a folder" takes only a folder picked there. In the browser version (`npm start`) "Search" and
  uploading files work as before; see `docs/DEVELOPMENT.md` for including a folder there.

## 2.5.0

- **Nintendo 3DS games play inside souldew**: X/Y, Omega Ruby/Alpha Sapphire, Sun/Moon and Ultra Sun/Ultra Moon run
  in the play view like every other game – Azahar's core, both screens, sound, touch screen with the mouse,
  controller, savestates, fast-forward, screenshots and the "saved in the game" indicator. Live data comes straight
  from the game's memory: the team, the battle panel (wild or trainer) and the "You are here" sign with the place
  names from the game itself – checked in Omega Ruby, Sun and Ultra Sun. Windows and Linux get the same player (it needs
  the graphics driver's Vulkan; without it 3DS games open in the Azahar app, which also stays available by choice).
- **Trophies and Pokédex up to Alola**: Kalos and Alola count in the Pokédex (#809), with their own medals and the
  new "Kalos Complete" and "Alola Complete" achievements; the Gen 6/7 starters, Sylveon, the Kalos fossils and X/Y's
  roaming bird count for their achievements, and "Time Traveller" now asks for all seven generations (already
  unlocked stays unlocked).
- **Trophies: a hack run counts for its base game's generation** – Blaze Black 2 Redux or Blaze Black were counted as
  Gen 4 ("a DS game"), so "Time Traveller" and the per-generation numbers missed Gen 5; 3DS runs count as Gen 6/7.
- **Trophies count what really happened:** a savestate loaded back over an evolution no longer counts it again
  ("Evolution Master", "Glow-Up", Gyarados); a SoulLink death on your partner's side no longer gives you its killer
  trophies (Magikarp, the rival, Miltank …); a bonus Pokémon lost in a solo run counts as a death ("Deathless" and the
  clean-badge ones); SoulLink twins are judged by what both of you caught, not by what it evolved into; in Sun/Moon and
  Ultra Sun/Ultra Moon (no badges) "before the first badge" means before the first boss. Every run is read again
  once, deleted ones get their generation from their game.
- The category medals no longer show Platinum as reached while an open achievement is missing, and categories without
  secret achievements (Journey, Skill, Randomizer) have a Platinum step of their own before Master.
- **SoulLink "New attempt"** (#6, checked with two apps over the real sync): whoever reloaded the join page of the new
  run – or restarted the app before building – took the host's seat and renamed the host for everyone. The seat now
  comes from the choice stored for that run. A pre-patched hack's game file is named after the hack on the joining
  side too ("Robin - Radical Red", not "Robin - FireRed").
- **Battle helper for Gen 6/7**: the type chart knows Fairy and that Steel no longer resists Ghost and Dark; the
  species picker offers up to #721 / #809 in 3DS runs. The moves of X/Y to Ultra Sun/Ultra Moon (Moonblast, Leafage …)
  and their held items have names and values now – with names missing, the helper would have left out every move.
- **Absorb, Mega Drain, Solar Beam and Sky Attack** had Let's Go's power in Gen 1–5 battles (40 / 75 / 200 / 200) –
  now their own (20 / 40 / 120 / 140). Unbound's Spotlight is that move now, not left out.
- The play view's buttons stay on one row in a 1100 px window.
- A 3DS game that stops (or can't start) says so in the player in the app's language, and a quick save / load in that
  moment no longer waits forever.
- The library's live note for 3DS games no longer says "in Azahar" – they run in souldew's own player.
- The battle helper judges by the running game's generation: 3DS battles used Gen 4's chart and moves (no Fairy
  attacks, Steel resisting Ghost and Dark, Tackle at 35), Black/White's Gen 4 move power; 3DS teams name held items.
- **Checked with real saves** (players' saves from the internet: Ultra Sun before Tapu Koko, a finished Omega Ruby, Y,
  HeartGold, Black, Silver): the team, the place sign, a legendary battle, a catch filed under its place, in-game
  saving and savestates. Fixed along the way:
  - In X/Y to Ultra Sun/Ultra Moon a **paralysed Pokémon showed as asleep** – the 3DS games number their status
    conditions instead of using the older games' flags.
  - A **Bad Egg** in a 3DS team hid the team (in the first slot) or everyone after it.
  - Nuzlocke: the question after a wild battle without a catch **suggests the place you're at** (where the game shows
    a place sign) instead of the first open area.
  - Savestates of Sun/Moon and Ultra Sun/Ultra Moon no longer say "0 badges".
- **SoulLink with a 3DS game:** joining, or building a new attempt, could take whichever 3DS game came first in the
  library (3DS files have no CRC32 to compare) – now the run's own game, or a message to add it.
- **The 3DS player is sturdier:** it no longer stalls when the play view reconnects to a running game, a refused save
  or load no longer waits forever, the error message of a game that can't start reaches the player, Windows user
  names with letters like "ü" work in the 3DS paths, and big pictures (3× resolution) are handled with less copying.
- Omega Ruby/Alpha Sapphire's place sign reads its own table first (another file of the right size could be taken),
  and a damaged 3DS ROM can no longer keep the background ROM reading busy.
- The Roseli Berry has its name (it had none, so held items were left out for a team holding one).
- A fresh library says "Ready to play" instead of "Pick up where you left off".

### Known issues

- Sun/Moon and Ultra Sun/Ultra Moon have island trials instead of gyms: no badges are read there, so badge trophies
  and level caps don't count in those runs.
- DS games (HeartGold, Black …) show their place names in English in the German app.
- 3DS savestates are tied to the system they were made on (a Windows state doesn't load on a Mac); the player says so
  instead of loading it.

## 2.4.0

- **Pokémon Unbound and Radical Red are read live** (a player's report: neither synced anything). Your team with its
  held items, the place sign with the games' own place names, the battle panel and new catches now work in both.
  Checked in the games: Radical Red from a new game (starter, the rival, Route 1, a real catch), Unbound with a save
  (a team of six, the Battle Frontier, the Battle Tower, Icy Hole, wild and trainer battles, a new team member filed).
- **Types come from the game itself**, for every game: each Pokémon's types, the type chart and, where the game has
  them, the moves' types. Hacks that added Fairy (Unbound, Radical Red, Run & Bun, Renegade Platinum, Blaze Black 2
  Redux) or retyped Pokémon show what the game really uses, with its matchups. **Too Many Types** shows its own types
  under the game's names, with their matchups, instead of none. In a GBA battle the helper follows a type change during
  the battle.
- **Level caps for more games**, worked out from the game's own trainers: Ruby, Sapphire, Emerald, FireRed and LeafGreen
  (also German), Diamond, Pearl, Platinum and Renegade Platinum – with badges now read live in those games. Where the
  caps can't be told with confidence (Unbound's difficulty settings, Radical Red's and Light Platinum's second set of
  leaders, Blaze Black 2 Redux's Challenge Mode, Run & Bun, Too Many Types) no cap is shown rather than a wrong one, and
  "Level cap: unknown for this game" is gone – the cap only shows when it's known and the run uses caps.
- **The app stays responsive the first time you open a big game**: reading the ROM (place names, types, caps) runs in
  the background, so nothing else waits for it, and a damaged ROM file can no longer hang souldew.
- **The library says what souldew can read for each game** – team, held items, place, battles, catches, types and
  level caps – worked out from your ROM. In the game, held items and moves that can't be named are left out instead of
  showing wrong ones, and "Save diagnostics" records what was confirmed.
- The battle helper shows the moves Unbound and Radical Red really have (they number newer moves their own way), and a
  pre-patched Radical Red ROM or the official Unbound patch is recognised as that hack in the library, when you play it
  and in a new run.
- Not for Unbound / Radical Red yet: the Rare Candy cheat.

### Known issues

- Unbound's own level cap (its difficulty settings) isn't read yet, so no cap is shown there.
- In GBA games a catch sent straight to the PC is filed once that Pokémon joins your team.
- In DS and Game Boy battles the type helper uses the Pokémon's own types, not type changes made during the battle.
- German Ruby/Sapphire: badges and level caps stay off until their save layout is confirmed.

## 2.3.1

- **OBS overlays keep working from run to run** (#8): the links on
  the Stream page now follow the current run – the one open in souldew – so a new run, a joined SoulLink or another
  game no longer means adding every overlay to OBS again. They switch live, without OBS reloading them. The Stream
  page's Run menu can still pin the links to one run, and links from earlier versions keep showing their run. The
  Pokélink bridge and the stream API's `current` streams follow along too.
- **OBS overlays no longer grow while the team fills up** (#7):
  every widget now fills exactly the size of its browser source – the team strip and the team card keep six places,
  the counters a place for the badges, "You are here" one plate per player, and long names are shortened – so the
  overlay keeps its size and position in your scene from the first catch to a full team. A run with more players
  than the source was made for, or a browser source set smaller, scales the widget down instead of cutting it off.
- **When a game runs too slowly on your computer, the play view now says so and what helps** (#4 – Platinum lagged
  and crackled in the built-in emulator while the melonDS app ran it fine): the built-in emulator runs the whole DS on
  one processor core, without the tricks the melonDS app uses, and Platinum's overworld needs ~12–14 ms per frame
  even on an M1 – of the 16.7 ms a frame may take. A slower PC then plays at half speed, and the sound crackles
  because only half of it gets made. If a game stays clearly below full speed for about ten seconds, a note under the
  game shows how fast it really runs and what helps: the melonDS app for DS games (one click in Settings ›
  Emulators, the run syncs on every in-game save), another graphics backend on Windows and Linux, and power settings.
- **A USB microphone or headset no longer takes the controller's place** (#2): on Windows some of them show up as a
  game controller, and when one was listed first, souldew used it and the real controller (a PS5 controller in the
  report) pressed nothing in the game. souldew now picks the controller itself – a real one, skipping microphones,
  headsets and devices with hardly any buttons – and Settings › Controller has a new "Controller to use" choice
  that lists every connected device; the one you pick is remembered and used whenever it is connected.
- **Battle helper: your choice where it sits** (#10): two small buttons on the panel move it to the left or the right
  of the game and fold it in to one line (the opponent, and a catch rule only when it says "don't"). souldew
  remembers both. If the host switched the type matchup help off for a run, it stays off.
- **Battle helper for your whole team** (#11): a new "Your team against …" list shows every team member's best hit
  on the opponent and the opponent's worst for it – who to send in at a glance. Black 2: the panel
  now follows a switch – it showed your lead's moves, matchups and HP for the whole battle – shows the HP of every
  team member during the fight, and shows a trainer's next Pokémon once the first one is down (it stayed on the
  first one at 0 HP). HeartGold/SoulSilver double battles show both opponents and both of your Pokémon.
- **The battle helper no longer disappears in a long battle** (#12): in 2.2.0 it vanished after about 90 seconds in
  Black 2 (fixed in 2.3.0, which reads the game's battle flag – checked again: two minutes in the battle menu, the
  panel stays); now it also keeps the opponent through a moment where the game rewrites its data, and in
  Black/White and Black 2/White 2 a single odd reading of the battle flag no longer ends the battle on the panel.
- **German, French, Italian and Spanish FireRed/LeafGreen are read live** (Feuerrote/Blattgrüne, Rouge Feu/Vert
  Feuille, Rosso Fuoco/Verde Foglia, Rojo Fuego/Verde Hoja – also randomized, #16): they showed "No live data for this
  game". Their memory layout is now in the table – the team, battles, the place sign and the Rare Candy cheat. The
  addresses come from two trackers that run on these versions and agree, and were checked in the German games
  (Feuerrote and Blattgrüne; French, Italian and Spanish ROMs weren't at hand): Charmander from Oak lands under
  "Starter", the rival's Squirtle shows as a trainer battle with the HP going down as on screen, a Rattata caught on
  Route 1 lands under "Route 1", and the place sign says Pallet Town / Alabastia and Route 1. Two things the check
  found are fixed too: the Pokémon of German, French, Spanish and Italian GBA games were read as unknown ones – their
  names weren't recognised (also German Ruby/Sapphire since 2.3.0) – and German FireRed/LeafGreen named places after
  the Fame Checker's list ("Arena Marmoria" on Route 1).
- **Run & Bun: the starter and your catches are filed** (#3, also in other expanded-engine hacks):
  about every second Pokémon was read as an egg – Run & Bun stores the IVs one bit further on than the original
  games – and never reached the run, and the search for the team gave up after half a minute without one, long
  before the starter. Checked in the game: Chimchar lands under "Starter", a Zigzagoon caught on Route 101 under
  "Route 101". Pokémon whose names the game shortens (Corviknight, Crabominable, Fletchinder …) are recognised, and the
  title screen no longer claims you are in Petalburg City.
- **Run & Bun: the battle panel follows the battle**: it didn't know who was out – after a switch it kept showing your
  lead, with its moves, its matchups and an HP bar that didn't move while the other Pokémon took the hits, a trainer
  who switched kept their first Pokémon on the panel, and a trainer with a single Pokémon (your rival's first battle)
  counted as a wild battle, so the Nuzlocke catch rules showed up there. souldew now finds the hack's own battle data
  in its memory and reads who is out on both sides, and tells wild from trainer battles by the opponent's trainer
  ID. Checked in the game: a switch in a wild battle and the rival's Mudkip on Route 103, HP as on screen. In a double
  battle it follows the left Pokémon of each side, and its partner once the left one is down.
- **Enter every Pokémon the game holds by hand**: the species picker only offered the base game's generation – no
  Sinnoh starters in Run & Bun. It now follows the ROM: up to #905 in Run & Bun, the Gen 4/5 Pokémon of Light
  Platinum, the randomizer's Pokémon, and a hack's own creatures under the names the game gives them.
- **More ROM hacks in the library**: Too Many Types and Too Many Types 2 are recognised, and
  a hack's details now say how far live tracking works for it (read live, with limits, not checked yet) and what to
  know – e.g. that Too Many Types' own types aren't known to souldew. A patch named after the longer of two hacks
  ("Too Many Types 2") is linked to that one.
- **Too Many Types and Too Many Types 2 are read live** (#3): checked in both games – the starter (Fennekin,
  Chimchar) lands under "Starter", a real catch under its route (Poochyena → "Route 101", Sewaddle → "Route 121"), the
  place sign, wild and trainer battles with HP as on screen and switches. Too Many Types 2 showed nothing useful
  before: the game keeps its Pokémon names, its team and its battle flag elsewhere than Run & Bun, so it read as plain
  Emerald. Both hacks have types of their own (57 and 80) that souldew doesn't know: instead of the official – wrong –
  ones, souldew now shows no types, matchups or type rule for their Pokémon, and the battle panel says why.
- **Patches and already patched ROMs are recognised by their checksum**: a patch is linked to its hack by what it
  makes, whatever the file is called (a "1.1.1 mirror.bps" is Too Many Types 2), and a ROM that was patched before you
  added it shows up as the hack – in the library, when you play it and in a new run – instead of as Emerald.
- **Randomizing Gen 5 ROM hacks with the Fairy type works** (Blaze Black 2 Redux, Volt White 2 Redux …): creating a
  randomized run stopped with "Randomizer error: … attackingType is null" (or "pk is null"). The randomizer now keeps
  the hack's Fairy type as it is, uses the Gen 6 type chart for its choices, and leaves static encounters unchanged
  where the hack rewrote their scripts. Checked with every preset.
- **Leaving right after a change no longer leaves you "online"**: a change made a moment before closing a SoulLink
  (a death, a restart) was sent after the goodbye and made the partner see you online for up to 45 seconds. The
  goodbye now follows it.
- **"New attempt" keeps the players together** (#6): when a SoulLink was over and more than one player pressed "New
  attempt", each of them built a new run of their own – with its own connection, so the sync stopped working. Now the
  first one to press it builds the new run, and everybody else sees "… is already building the new attempt" and gets
  the invite to join it; if the new run is already there, "New attempt" opens the invite – or the new run itself, for
  whoever built it – instead of building a second one. "New attempt …" in the run list opens the SoulLink first, so
  the others see it too. Works with 3 and 4 players.
- **Black/White and Black 2/White 2** (thanks to a player's reports, #5, #9, #13, #14):
  - No more battles that aren't there: opening a Pokémon's summary (to look at or swap its moves) in Black 2 and
    White 2, and Bianca's catching demo in White 2, put the catching demo's Pokémon (Lillipup) on the battle panel.
  - White: after Professor Juniper's catching demo on Route 1, its Patrat stayed on the panel as a trainer battle until
    your next real battle. White's battle flag is now checked in the running game, so every battle – the demo too –
    leaves the panel the moment it ends. While the demo runs it still shows: the game flags it like a real battle.
  - Status conditions show what the game shows – poison, burn, paralysis, freeze or sleep. Before, every Pokémon with
    a status condition showed SLP: Gen 5 stores them differently from Gen 4.
  - Level caps: the board, the play view and the stream API now know the badges and show the cap – the ace of the
    next gym leader, after the eighth badge the Elite Four (unmodified game, Normal mode – not for ROM hacks, whose
    trainers have other levels).
  - Catches an older souldew filed under a number ("#6") get their place name once you play the game again, for
    every player of the run.
- Held items are shown by name on the board and in the play view (Gen 3–5), in your app's language (#15) – before it
  only said "Holds an item". Hacks on an expanded engine (Run & Bun) number their items their own way and keep "Holds
  an item".

## 2.3.0

**Turbo music fixed** – the known issue from 2.2.0.

- Turbo music no longer sounds fast after a scene change (GBA and Game Boy): with the new timing the
  emulator's sped-up sound came out chopped or at a jumping pitch, and slowing it back down didn't help. While
  fast-forwarding every game now plays its sound at normal pitch, skipping ahead, as DS games already did: "Music
  continues" plays the music recorded at 1× over it, and "Sped-up original" is that skipping sound.
- "Music continues" now never plays the game's own fast-forward sound – that skipping sound is what sounded like
  sped-up music after a scene change on Windows, and why "Music continues", "Sped-up original" and "Plain" then all
  sounded the same. A song that wasn't heard at normal speed yet keeps the music that played before it; only with
  nothing recorded at all is fast-forward quiet until the music has played for a few seconds at 1×.
- When the emulator rebuilds its sound (on Windows when the graphics driver or Chromium's GPU process restarts), the
  turbo music keeps every song recorded so far instead of starting from nothing.
- The chosen turbo audio mode always wins: "Mute" silences every path to the speakers while fast-forwarding, and a
  turbo mixer that fails on the audio thread is replaced by a fresh one instead of letting the sped-up sound through.
- "Save diagnostics" now shows how the sound is wired: every audio context the emulator made (and when), what feeds
  the speakers, the levels heard per path, graphics-context losses and GPU process restarts with their times, and a
  "leak" entry whenever sound was heard while fast-forwarding where the mode says silence.
- Sound cards set to 96 or 192 kHz: the emulator's sound now runs at 48 kHz (44.1 kHz for 88.2/176.4 kHz) and the
  browser converts it once – the same as on most PCs, with half the work for the turbo mixer or less.

**Turbo without a brake** – players asked for it.

- New in Settings › General: "Full-power turbo" (on by default). While fast-forwarding the game may now use almost
  every display frame in full instead of three quarters of it, in short slices that let the app's own work and your
  clicks and keys go first. DS games on DeSmuME (HeartGold/SoulSilver, Black/White) also skip drawing more of the
  frames nobody sees at that pace. Turbo never steps down with it ("Step down when the computer can't keep up" is off
  then). Normal speed is unchanged. Measured on an M1: GBA "Max" 12.2× → 13.6×, HeartGold's opening 4× 3.2× → 3.6×,
  and the app stays at the display's full rate while fast-forwarding (45 → 75 Hz on a 75 Hz screen), with clicks
  answered about twice as fast.
- Where a game still can't reach the chosen speed, the computer itself is the limit: the built-in DS emulator runs on
  a single CPU core, and HeartGold in town takes ~10 ms per frame on an M1 – about 1.6× is all it can do there, with or
  without the brake. We measured every way around it on an M1 (HeartGold, Azalea Town): frame skipping (none or 9 of
  10 frames – the same), DeSmuME's 3D and timing options, the single- and multi-threaded build and the older
  "DeSmuME 2015" all take 9.7–10.8 ms per frame; melonDS still can't load HeartGold/SoulSilver and Black/White saves
  ("A communication error has occurred") and is slower than DeSmuME in the 2D menus anyway.

**Honest turbo steps**

- When a scene can't keep up, the speed in the bar now shows what the game really runs at ("≈1.6×", in yellow) –
  the step you picked moves to the small tag above it ("set: 4×").
- souldew remembers per game how fast fast-forward gets on your computer. Steps it never reaches there aren't offered
  any more: with HeartGold on an M1, `T` and the +/– buttons go 1× → 4× instead of 2× → 3× → 4× that all play at the
  same ~1.6×. The highest step stays – it runs as fast as your computer manages, up to 4×, so lighter scenes (menus,
  houses, the opening) still get the full speed – and says so when you switch to it ("4× – this computer usually
  manages ≈1.6× in this game"). On a faster computer, or in games that hold the steps, nothing changes.

**"You are here" for Black/White and Black 2/White 2, read from the game itself** – thanks to a player's report (#1).

- The place sign in the play view now works in Black, White, Black 2 and White 2 (randomized ones included): the
  route or town you're in, and in a run whether its first encounter is still open.
- souldew now reads the place names and which map belongs to which place straight from the ROM – the same names the
  game shows when you enter a route – instead of only from its own tables. ROM hacks with their own maps and place
  names show those. The Gen 4 games in other languages than English can now show the sign as well, in the game's
  language (not tested on every language yet).
- A game without location data no longer says "Location appears once you're in the game" forever; it says the
  location isn't available for this game yet.

**Smaller changes**

- The library no longer links to ROM hacks or their download pages. The known hacks are still listed – with
  description, difficulty and base game – so souldew recognises them and applies a patch file you add yourself.
- New run rule "Show type matchup help" (on by default): the host decides when creating a SoulLink or Nuzlocke whether
  the battle helper in the play view shows how your moves land, what hits you and the weakness charts. Off hides it
  for every player. Only the host can change it later (board › Rules), and every change shows up in the log. Runs
  from before keep the help.
- The "Buy me a coffee" button gets a visitor now and then (every few minutes, never while a game is running):
  Pikachu peeks out of the cup, Snorlax naps on it, a Poké Ball wobbles and pops, or Jigglypuff hops by – a few
  seconds of pixel art, no sound, and none at all with "reduce motion" or once you've clicked the button.
- From the fifth start on, souldew may now and then (rarely, at most every few days) thank you in a window that looks
  suspiciously like an old shareware "please buy a license" nag – in full old-Windows glory, on every system. souldew is
  and stays free: the window only jokes, offers the coffee link and closes with Esc. Settings › About turns it off.

**Open stream API – build your own overlay layout**

- Streamers who design their own OBS layout can now read souldew's data without its preset look: the current run as
  JSON (players with their colours, every team with species, nickname, level, HP, status, held item, shiny and
  sprites, linked groups, graveyard, encounters per route, each player's location and battle, badges and level cap,
  the run's rules), plus a live event stream for catches, deaths, level-ups, evolutions, location changes, battles
  and wild encounters, badges and the run's start and end. The same sprites the app shows (front, back, shiny,
  menu icons, artwork, animated) come from the app too.
- Safe by default: on this computer only, read-only, nothing private (no ROMs, saves, file names, invite codes or
  spoilers); other websites need a token you can switch on. Address, copy button and docs are on the Stream page
  under "Open API"; the documentation with copy-paste examples is in [docs/STREAM_API.md](docs/STREAM_API.md).

**A surprise on legendary encounters**

- Meet a legendary or mythical Pokémon while live tracking runs, and there's a 1-in-4 chance that the stream overlay
  shows a small pop-up with a joke about that very Pokémon ("Mewtwo has entered the chat. souldew's developer has
  entered the coffee shortage.") and the "Buy me a coffee" link with a QR code – for about 12 seconds, at most once
  every 20 minutes and once per species per run. Jokes in all five languages.
- It shows in the Alerts overlay – no extra setup, and no spoiler on the Stream page. On by default; Settings › About
  switches it off. Custom layouts get it as an event from the open API.

**Trophies: a Pokédex across all your runs, achievements and medals** – new in the sidebar.

- **Pokédex:** all 1025 species, with what you caught (evolutions count) and saw in every SoulLink and Nuzlocke on
  this computer – first catch with run, date, route and nickname, shinies, how many died, and your whole history with
  each one. Filter by generation, type and caught/seen/missing, or search. Species from Gen 6 on aren't in any game
  souldew plays yet: they're listed, greyed out, and say so.
- **102 achievements** in six categories – from "Gotcha!" and "Eight for Eight" over "Untouchable" (win without a
  death), "Soul Twins" and "Chaos Tamer" to the classics: "Rollout Trauma" (Whitney's Miltank), "Abra Used
  Teleport", "Too Much Water", "Bird Jesus", "It's a Magikarp Moment" and a few secret ones. All of them fit the usual
  Nuzlocke rules (dupes clause, type rule), and "complete" Pokédex goals leave out event-only mythicals like Mew. Five
  rarities, unlock dates, progress bars, and a toast when one unlocks while you play (no sound).
- **Medals** in a medal case – one per category, one per regional Pokédex and the Champion's Medal, from bronze to
  master. Original pixel-art designs.
- Everything is worked out from the runs souldew already records (catches, deaths and their cause, badges, the end
  of a run, the live data while you play) and stays on your computer. Your existing runs count from the first start;
  a deleted run's catches stay in the Pokédex.

**ROM hacks and randomized games: names straight from the game** – checked game by game (see
[docs/TESTED_GAMES.md](docs/TESTED_GAMES.md)).

- A randomized game or a ROM hack now always shows the game's own place names – also when the game's language
  isn't the app's. New catches are named the same way, so catches in Black/White and Black 2/White 2 get their place
  name instead of a number, and a hack's catches get the hack's names.
- GBA ROM hacks that put other Pokémon into the game (Light Platinum: 141 of them, e.g. Venipede where Weedle was, or
  Turtwig) now show the Pokémon the game shows – before, souldew showed the original game's Pokémon of that number, or
  nothing. A Pokémon only the hack has gets the hack's name.
- **Run & Bun** is tracked live: team, battle and the place sign, although it runs on an expanded engine with its own
  Pokémon numbers and memory layout (souldew finds both from the game itself). Other hacks on an expanded engine
  (Unbound, Radical Red …) are tried the same way and say that live tracking doesn't support them when their team
  can't be found – never wrong Pokémon. Catches can still be entered by hand.
- Hacks that add the **Fairy type** or retype Pokémon (Renegade Platinum, Blaze Black 2 Redux) now show the hack's own
  types on the board, in the battle panel and for the type rule – with Fairy's matchups in the battle helper.
- Blaze Black 2 Redux (and Gen 5 hacks like it) now gets the place sign.
- Game Boy hacks that moved the game's memory (Crystal Legacy keeps it 11 bytes further on) are read again: team,
  battle, place sign and the Rare Candy cheat find their data from the hack's own code. Before, Crystal Legacy showed
  no team and a place stuck on New Bark Town.
- Black/White and Black 2/White 2: the battle panel shows the opponent's HP as it goes down (it stayed full) and your
  Pokémon's HP during the fight, and no longer keeps showing the opponent for up to two minutes after a fight.
- Platinum, Pearl, Black and Black 2: battles show up on the panel when they start and leave it when they end (a wild
  battle in Platinum showed up late and stayed after running away), and a catching demo is no longer taken for your
  own battle.
- Red/Blue/Yellow and Gold/Silver don't store where a Pokémon was caught: a catch right after a wild battle is now
  filed under the place the sign shows (before, every catch went to the inbox). Gifts and trades still go to the inbox.


**Known issues**

- **Run & Bun:** during a battle the panel shows your own Pokémon's HP from before the fight, and whether it's a wild
  or a trainer battle is a guess.
- **Unbound, Radical Red and other hacks on an expanded engine** weren't tested in the running game. If souldew can't
  find their team, the play view says live tracking doesn't support the hack – enter catches by hand there.
- **Renegade Platinum** and **Light Platinum:** place names, Pokémon and types come from the game file and were
  checked there; a full play-through with catches is still to come.
- **White 2:** team and places are checked, the battle panel only in Black 2 so far.
- Original games in languages other than English and German count as modified: they show the game's own place
  names (in the game's language) instead of the translated ones.
- **Trophies from earlier runs:** catches, deaths, badges and wins of runs from before 2.3.0 count, but moments
  souldew only notices while you play (a Pokémon at 1 HP, a badge won underleveled, a monotype team) don't. In older
  SoulLinks souldew guesses which player you were until you open the run once.

## 2.2.0

**Smoother built-in emulator, and fast-forward at its full speed** – mainly on Windows.

- Fast-forward reaches the speed you pick: on many Windows PCs 4× got stuck around 2.2× (and 2× around 1.7×), because
  the emulator timed its frames with browser timers that only fire every ~15.6 ms there. souldew now times the game
  itself from the display's frames – the same on every system and at every refresh rate (60, 75, 120, 144, 165 Hz).
- No more stutter and crackling at normal speed when the computer is briefly busy: the game no longer waits on its
  sound, keeps a larger sound buffer (128 ms) and makes its sound at the sound card's own rate.
- New turbo step "Max" (Settings): as fast as the computer can, without any limit.
- New turbo audio option "Plain": the emulator's own sound with no recording or mixing at all – for anyone who
  hears crackling.
- "Save diagnostics" now includes the sound card (sample rate, latency), the display's refresh rate, the speed really
  reached, drop-outs in the sound and the longest gap between frames.
- Turbo audio "Music continues" works every time again (2.2.0-beta.1): when the emulator rebuilt its sound – e.g. after
  the graphics process restarted on Windows – the old music mixer kept playing on its own, and Mute or turning
  fast-forward off no longer reached it. The old one is now shut down. Game Boy square-wave music and short sound
  drop-outs while fast-forwarding are no longer mistaken for broken sound, which made the next fast-forward silent.
  "Save diagnostics" now records the mixer's state after every speed, mode and pause change, and how many mixers run.

**Graphics backend setting (Windows and Linux)** – thanks to a player's report.

- New in Settings › General: "Graphics backend" – Automatic (default), Direct3D 11, Vulkan or OpenGL on Windows,
  Automatic, OpenGL or Vulkan on Linux. If the built-in emulator stutters or its sound crackles, try Vulkan: on one
  player's Windows PC that made both go away. The change applies after a restart ("Restart now").
- If souldew doesn't open with the chosen backend (twice in a row) or its graphics process keeps crashing, the next
  start uses "Automatic" again and says so once.
- "Save diagnostics" now includes the graphics backend, Chromium's GPU status and the graphics card with its driver.
- For experiments: the environment variable `SOULDEW_CHROMIUM_FLAGS` passes extra Chromium switches (see
  docs/DEVELOPMENT.md).

**mGBA live data works again for GBA games** – on every system the panel stayed at "Waiting for the script …".

- mGBA 0.10 reports GBA games as "AGB-BPEE" (Game Boy as "CGB-…"/"DMG-…"); souldew only knew "BPEE", so it never
  asked the script for the party. Scripts loaded from older versions work again once souldew is updated.
- The mGBA panel says what is going on: no connection yet, script connected but no game data yet, no live data for
  this game, an outdated script or one from another installation tried to connect. The script's path has Copy and
  Show in Finder/Explorer buttons (on Windows it lives in a hidden folder).
- The script (version 2) reconnects on its own when souldew restarts or uses another port, tries every port souldew
  may use, finishes partial sends instead of losing data, re-announces the game after a reset and writes what it
  does and why it failed into mGBA's scripting window. It also avoids an mGBA 0.10 bug that closes a reused socket
  number when an old socket is garbage-collected.

**Rare Candy cheat** – for Nuzlockes and SoulLinks with level caps.

- "Add 99 Rare Candies" in the play screen's new cheats menu puts them straight into the bag in game memory – Gen 1–5, randomized games included. A run allows it
  only once its rules say so (off by default), and every use shows up in the log for all players ("Tim used a
  cheat: 99 Rare Candies"), as does switching the rule. The bag is checked before anything is written; games
  whose bag isn't known say "Not available for this game".

**Linux support** – souldew now runs on 64-bit Linux, the Steam Deck included, and plays together with Mac and
Windows players.

- Two packages: an **AppImage** (`souldew-<version>-linux-x86_64.AppImage`) that runs on almost every distribution and
  updates itself, and a **.deb** for Debian, Ubuntu, Mint and friends (updates through the download page).
- Automatic updates for the AppImage: the app downloads the new one next to the old file, checks its signature and
  checksum and swaps it on restart – under the old file name, so desktop and Steam shortcuts keep working. The same
  signed update feed serves all three systems; apps on 2.0 and 2.1 keep updating as before.
- Steam Deck: the window fits the 1280×800 screen; add the AppImage as a non-Steam game to play in Game Mode.
- "Search my PC" on Linux looks in your (localized) Downloads, Desktop and Documents, in EmuDeck's, RetroDECK's and
  RetroArch's folders and on SD cards and USB drives.
- One-click melonDS and mGBA install the official Linux AppImages; emulators from your distribution (`mgba-qt`,
  `melonDS`) and from Flathub are found too. The Java runtime for the randomizer ships with the app.
- The window uses your desktop's own title bar; shortcuts use Ctrl, the menu bar appears with Alt, and the app speaks
  of the file manager. Your data lives in `~/.config/SoulLink Studio`.

**Known issue:** on some Windows PCs, "Music continues" plays the sped-up music during fast-forward, especially
after a scene change. A fix follows in the next update. Until then another turbo audio option helps ("Mute" or
"Plain (no extra processing)").

## 2.1.0

**Windows support** – souldew now runs on Windows 10 and 11 (x64), and Mac and Windows players can play together.

- Windows installer (`souldew-2.1.0-win-x64-setup.exe`): installs per user without admin rights, with Start menu and
  desktop shortcuts. It isn't signed with a paid certificate, so SmartScreen may ask once (More info › Run anyway).
- The window matches the dark look on Windows too (window buttons in the app's colours); all shortcuts use Ctrl, and
  the app speaks of Explorer and "Search my PC" there.
- "Search my PC" looks in Downloads, Desktop, Documents, OneDrive (files already on the PC – online-only files
  aren't downloaded) and the folders of RetroArch, RetroBat and LaunchBox.
- One-click melonDS and mGBA install the official Windows builds; the Java runtime for the randomizer ships with the
  app, set to UTF-8 so the same seed builds the same game on Mac and Windows.
- Automatic updates on Windows: the app downloads the new installer, checks its signature and checksum and installs
  it on restart. One signed update feed serves both systems – apps on 2.0 keep updating as before.
- More robust on every system: file names that Windows forbids are cleaned up, short file locks (antivirus) no
  longer break saving, and library folders on a whole drive work.

## 2.0.0

- New name: **souldew** (formerly SoulLink Studio), with a new boot animation and sound. Data, runs and saves carry
  over.
- SoulLinks for 2–4 players and solo Nuzlockes with their own rule editor.
- Invite with a 6-digit code; the joiner's name is the one everyone sees.
- Live tracking: team, levels, HP and status conditions, battle panel with the real opponent, catch rules (type rule
  including partners at the same place, dupes, shiny clause), "You are here" location sign.
- Turbo music that follows the scene; for DS games the current song is played from the ROM's sound archive.
- Stream page: streamer mode, OBS overlay widgets with live push, a Pokélink-compatible bridge and a documented
  overlay API.
- Collapsible sidebar that hides itself in fullscreen.
- "Save diagnostics" for bug reports.
- Automatic updates from GitHub Releases (signed), a "Buy me a coffee" link in the sidebar and links to the project
  in Settings › About.
