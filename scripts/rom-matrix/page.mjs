// Runs inside souldew's player page (web/player.html) for scripts/rom-matrix/live.mjs: presses buttons frame by frame
// following a plan, and reads team, place and battle with the app's own live readers. Exported as source text.
/* global window, MouseEvent, location */

function helper() {
  const BTN = { B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, X: 9, L: 10, R: 11 };
  const e = window.__emu;
  const gm = () => window.EJS_emulator.gameManager;
  // the fast player (playernative.html): the host runs exactly the frames asked for and then waits – a plan's input
  // lands on its frame there, every time
  const NATIVE = !!e.native;
  // The plans were tuned in player.html, where waiting polls the frame counter while the core races at full speed and
  // overshoots by a few frames each time (a Game Boy core more than a DS one). Running exactly n frames, a walk is
  // checked before its step has ended – so the fast player runs the frames the plans had in practice.
  const SLACK = { gb: 8, gbc: 8, gba: 4, nds: 1 }[e.system?.()] ?? 2;
  // ...and the same frames every time: a person walking in the way on the first attempt walks there on every one. From
  // the second attempt on each wait runs 0–3 frames more (a fixed sequence per attempt), as player.html's waits vary.
  let jitter = () => 0;
  function seedJitter(attempt) {
    if (!NATIVE || attempt <= 1) return;
    let x = (attempt * 2654435761) >>> 0;
    jitter = () => {
      x = (x * 1664525 + 1013904223) >>> 0;
      return x >>> 30;
    };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let ctx = null;

  async function setup(romSrc, header) {
    const j = (f) => fetch(`/shared/data/${f}`).then((r) => r.json());
    const [parse, location, romwram, romloc, routes] = await Promise.all([import('/shared/live/parse.mjs'), import('/shared/live/location.mjs'), import('/shared/live/romwram.mjs'), fetch(`/api/rom/locations?src=${encodeURIComponent(romSrc)}`).then((r) => r.json()), import('/shared/routes.mjs')]);
    const [charsetGen1, charsetGen2, charsetGen3, gen1Index, gen3Index, gen4, addresses, maps, loc2, loc3, api] = await Promise.all(
      ['charset_gen1.json', 'charset_gen2.json', 'charset_gen3.json', 'gen1_index_to_dex.json', 'gen3_index_to_dex.json', 'gen4.json', 'addresses.json', 'maps.json', 'locations_gen2_crystal.json', 'locations_gen3.json', 'pokeapi.json'].map(j));
    const T0 = new parse.LiveTables({ charsetGen1, charsetGen2, charsetGen3, gen1Index, gen3Index, gen4 });
    const found = parse.findEntry(addresses, header);
    // a Game Boy hack with moved RAM variables: the shifted addresses, as the play view uses them
    const wram = found?.gen <= 2 ? romloc?.wram || null : null;
    // an expanded GBA engine: the team searched for, the place through SaveBlock1 (as web/views/play.mjs does)
    const expanded = found?.gen === 3 && romloc?.species?.engine === 'expanded';
    const entry = wram ? { ...romwram.shiftEntry(found, wram), wram } : expanded ? parse.expandedEntry(found, romloc?.data?.maps3) : found;
    const species = romloc?.species || null;
    // what the play view does (web/views/play.mjs): a GBA ROM's own species table – for an expanded engine also its own
    // item names and move numbers (server/lib/romloc.mjs ownTables3)
    // (and the ROM's types and badge flags: the battle's current types, Gen 3 badges)
    const T = (entry?.gen === 3 && species ? T0.withSpecies(species, romloc) : T0).withRom(romloc);
    // the app's own run logic (web/lib/run.mjs): every team read goes into a solo Nuzlocke document like the play view's
    // snapshots do – a new catch is filed under its area, named like the place sign names it
    let run = null;
    let names = null;
    try {
      const [R, D, data] = await Promise.all([import('/lib/run.mjs'), import('/lib/doc.mjs'), import('/lib/data.mjs')]);
      names = data;
      await Promise.all([data.loadData().catch(() => {}), R.loadLocationTables()]);
      R.setRomPlaces(romloc?.data || null);
      data.setRomSpecies?.(romloc?.species || null);
      const doc = new D.RunDoc('matrix');
      doc._persistSoon = () => {};
      const gen = header.platform === 'nds' ? (/^IR[ABDE]/.test(header.code) ? 5 : 4) : { gb: 1, gbc: header.code ? 2 : 1, gba: 3 }[header.platform];
      run = { R, doc, gen: found?.gen || gen, manifest: { id: 'matrix', mode: 'nuzlocke', name: 'Matrix', players: { p1: { name: 'Matrix' } }, game: { code: header.code, system: header.platform, title: header.title } } };
    } catch (err) {
      run = { error: String(err?.message || err) };
    }
    ctx = { run, parse, location, routes, romloc, data: names, T, T0, entry, maps, tables: { maps, loc2, loc3, gen4 }, rom: romloc?.data || null, species, hack: entry?.gen === 3 && species?.engine === 'expanded' && !species?.map, names: api.names.en, state: {}, rawState: {}, header };
    return {
      entry: entry?.id || null,
      vanilla: romloc?.vanilla ?? null,
      romloc: ctx.rom ? { gen: ctx.rom.gen, family: ctx.rom.family, lang: ctx.rom.lang, names: ctx.rom.names.length } : null,
      species: species ? { engine: species.engine, count: species.count, changed: species.changed } : null,
      wram: wram ? wram.delta : null,
    };
  }

  const ensureRam = async () => {
    for (let i = 0; i < 40 && e.ramInfo().base < 0; i++) {
      e.locateRam();
      if (e.ramInfo().base >= 0) break;
      await sleep(250);
    }
    return e.ramInfo().base >= 0;
  };

  function place() {
    const { location, maps, entry, rom, state, tables } = ctx;
    if (ctx.hack) return null;
    const r = location.readLocation(maps, entry, e.read, { rom, state });
    if (!r) return null;
    const table = location.locationLabel(r.gen, r.id, tables, 'en');
    const shown = location.placeName ? location.placeName(r, { rom, table, lang: 'en' }) : (rom?.lang === 'en' && r.romName) || table || r.romName;
    return { gen: r.gen, id: r.id, map: r.map, romName: r.romName ?? null, table: table || null, shown: shown || null };
  }

  function team(raw = false) {
    const { parse, entry, state } = ctx;
    if (!entry) return { error: 'no entry' };
    // an expanded-engine hack: the app shows "not supported" – the raw read (vanilla addresses) only for the record
    if (ctx.hack && !raw) return { hack: true, raw: team(true) };
    const T = raw ? ctx.T0 : ctx.T;
    let res = null;
    for (let i = 0; i < 4; i++) {
      res = parse.readLiveParty(entry, e.read, T, raw ? ctx.rawState : state);
      if (!res?.torn) break;
    }
    if (!res) return null;
    if (!res.party) return res;
    const name = (s) => ctx.names[s] || `#${s}`;
    // (the play view reads every 0.7 s and the DS battle search runs in 1 MB steps: a check gives it a few steps)
    let fight = null;
    for (let i = 0; i < (entry.gen >= 4 ? 6 : 1) && !fight?.enemy; i++) fight = parse.readLiveBattle(entry, e.read, T, raw ? ctx.rawState : state, res.party);
    return {
      // the HP the play view shows: in battle the battle copy's (withBattleHp), the party struct lags there
      // (itemLabel: the name the play view would show – '' for an item it can't name)
      party: parse.withBattleHp(res.party, fight).map((m) => ({ species: m.species, name: name(m.species), nickname: m.nickname, level: m.level, hp: m.hp, maxHp: m.maxHp, status: m.status, metLocation: m.metLocation ?? null, metLevel: m.metLevel ?? null, isEgg: !!m.isEgg, key: m.key, item: m.item || 0, ...(m.itemName ? { itemName: m.itemName } : {}), itemLabel: m.item ? (m.itemOwn ? m.itemName || '' : ctx.data?.itemName?.(m.item, entry.gen) || '') : '', moves: m.moves || [] })),
      boxes: Array.isArray(res.boxes) ? res.boxes.length : null,
      badges: res.badges ?? null,
      battle: fight ? { kind: fight.kind, enemy: fight.enemy ? { species: fight.enemy.species, name: name(fight.enemy.species), level: fight.enemy.level, hp: fight.enemy.hp, maxHp: fight.enemy.maxHp, moves: fight.enemy.moves || [], ...(fight.enemy.types ? { types: fight.enemy.types } : {}) } : null, active: fight.active || null } : null,
    };
  }

  /** Feeds the team read into the run document (applySnapshot, as the play view does) → the encounters filed so far. */
  function runNote(tm) {
    const run = ctx.run;
    if (!run || run.error) return run?.error ? { error: run.error } : null;
    const { R, doc, gen, manifest } = run;
    try {
      const res = ctx.parse.withBattleHp ? ctx.parse.readLiveParty(ctx.entry, e.read, ctx.T, ctx.state) : null;
      if (res?.party?.length && !ctx.hack) {
        const fight = ctx.parse.readLiveBattle(ctx.entry, e.read, ctx.T, ctx.state, res.party);
        const p = place();
        const here = p?.shown ? { gen: p.gen, id: p.id, name: p.shown } : null; // (as the play view passes it)
        const out = R.applySnapshot(doc, manifest, gen, 'p1', { source: 'live', party: ctx.parse.withBattleHp(res.party, fight), boxes: res.boxes || null, game: ctx.entry.id, here }, { battle: fight });
        for (const i of out.inbox || []) run.inbox = [...(run.inbox || []).filter((x) => x.key !== i.mon.key), { key: i.mon.key, species: i.mon.species, reason: i.reason, where: i.where }];
      }
      const encs = Object.entries(doc.scan('enc:')).map(([k, v]) => ({ area: k.replace(/:p1$/, ''), name: R.areaName(doc, manifest, k.replace(/:p1$/, '')), species: v.species, metLocation: v.metLocation ?? null, outcome: v.outcome }));
      return { encounters: encs, inbox: run.inbox || [] };
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  }

  async function frames(n) {
    if (NATIVE) {
      if (n > 0 && (await e.step(n + SLACK + jitter())) === null) throw new Error('emulator stopped');
      return;
    }
    const end = e.frames() + n;
    const t0 = performance.now();
    while (e.frames() < end) {
      await sleep(4);
      if (performance.now() - t0 > 120000) throw new Error('emulator stalled');
    }
  }

  async function press(keys, hold = 6, gap = 14) {
    if (NATIVE) {
      e.hold(keys);
      await frames(hold);
      e.hold([]);
      await frames(gap);
      return;
    }
    for (const k of keys) gm().simulateInput(0, BTN[k], 1);
    await frames(hold);
    for (const k of keys) gm().simulateInput(0, BTN[k], 0);
    await frames(gap);
  }

  async function shot(name) {
    if (NATIVE) {
      const b = await e.screenshot();
      if (!b) return null;
      let s = '';
      for (let k = 0; k < b.length; k += 0x8000) s += String.fromCharCode.apply(null, b.subarray(k, k + 0x8000));
      return { name, png: btoa(s) };
    }
    const g = gm();
    try { g.FS.unlink('/screenshot.png'); } catch { /* none yet */ }
    g.functions.screenshot();
    for (let i = 0; i < 60; i++) {
      await sleep(30);
      try {
        const b = g.FS.readFile('/screenshot.png');
        let s = '';
        for (let k = 0; k < b.length; k += 0x8000) s += String.fromCharCode.apply(null, b.subarray(k, k + 0x8000));
        return { name, png: btoa(s) };
      } catch { /* not written yet */ }
    }
    return null;
  }

  // DS touch screen: (x, y) in the bottom screen's own pixels (256 × 192), sent as mouse events to the core's canvas
  async function tap(x, y, hold = 6) {
    if (NATIVE) {
      e.touch((x + 0.5) / 256, (192 + y + 0.5) / 384, true);
      await frames(hold);
      e.touch((x + 0.5) / 256, (192 + y + 0.5) / 384, false);
      await frames(12);
      return;
    }
    const c = e.canvas();
    const r = c.getBoundingClientRect();
    // screens stacked top/bottom, letterboxed into the canvas at 256:384
    const scale = Math.min(r.width / 256, r.height / 384);
    const ox = r.left + (r.width - 256 * scale) / 2;
    const oy = r.top + (r.height - 384 * scale) / 2 + 192 * scale;
    const at = { clientX: ox + (x + 0.5) * scale, clientY: oy + (y + 0.5) * scale, bubbles: true, button: 0 };
    c.dispatchEvent(new MouseEvent('mousemove', at));
    c.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
    await frames(hold);
    c.dispatchEvent(new MouseEvent('mouseup', at));
    await frames(12);
  }

  function cond(c) {
    if (!c) return false;
    if (typeof c === 'object' && c.expr) return !!new Function('read', 'place', 'team', 'ctx', `return (${c.expr});`)(e.read, place, team, ctx);
    // (conditions look at what is really in RAM – for an expanded-engine hack the raw read)
    const tm = () => {
      const x = team();
      return x?.hack ? x.raw : x;
    };
    // (an expanded engine's team is searched for at most every 3 s – real time, and the plans run far faster)
    if (ctx.entry?.scan3 && !ctx.state.party3) ctx.state.lastScan3 = 0;
    if (c === 'overworld') return !!place();
    if (c === 'party') return (tm()?.party?.length || 0) >= 1;
    if (c === 'battle') return !!tm()?.battle;
    if (c === 'nobattle') return !tm()?.battle;
    if (c.startsWith('party>=')) return (tm()?.party?.length || 0) >= Number(c.slice(7));
    return false;
  }

  async function run({ plan, romSrc, timeoutMs, attempt = 1 }) {
    seedJitter(attempt);
    const t0 = performance.now();
    const log = [];
    const shots = [];
    // a plan that starts from a save (plan.save, scripts/rom-matrix.mjs): the player page boots with it, and when the core
    // looked for it elsewhere the save is loaded the way the play view does it (loadSave, a restart)
    const saveUrl = new URLSearchParams(location.search).get('save');
    if (plan.save && saveUrl && e.bootSave?.() !== 'loaded') {
      const r = await fetch(saveUrl);
      if (r.ok) {
        e.loadSave(new Uint8Array(await r.arrayBuffer()));
        await sleep(1500);
      }
    }
    const info = await setup(romSrc, plan.header);
    e.setSpeed(Infinity);
    let state = null;
    for (const s of plan.steps) {
      if (performance.now() - t0 > timeoutMs) {
        log.push({ step: s, error: 'timeout' });
        break;
      }
      const at = e.frames();
      console.log(`[plan] ${Math.round(performance.now() - t0)} ms, frame ${at}: ${JSON.stringify(s).slice(0, 160)}`);
      // s.while: only while the condition holds (a throw after the catch would walk around in the overworld)
      if (s.while && !cond(s.while)) {
        log.push({ do: s.do, skipped: true, note: s.note });
        continue;
      }
      if (s.do === 'wait') await frames(s.frames);
      else if (s.do === 'press') for (let i = 0; i < (s.times || 1); i++) await press([].concat(s.keys), s.hold, s.gap);
      else if (s.do === 'go') {
        // walk to a tile watching the position in RAM (plan.pos: expression → [map, x, y]): the preferred axis first
        // (s.order), the other one when blocked, a side step when both are – people walk around in the games
        const pos = () => new Function('read', `return (${plan.pos});`)(e.read);
        const want = { x: s.x, y: s.y };
        const order = (s.order || 'xy').split('');
        const done = (p) => (s.leave && s.map !== undefined && p[0] !== s.map) || order.every((a) => want[a] === undefined || (a === 'x' ? p[1] : p[2]) === want[a]);
        const dirOf = (a, p) => {
          const cur = a === 'x' ? p[1] : p[2];
          if (want[a] === undefined || cur === want[a]) return null;
          return a === 'x' ? (want[a] > cur ? 'RIGHT' : 'LEFT') : want[a] > cur ? 'DOWN' : 'UP';
        };
        const step = async (dir) => {
          const p = pos();
          await press([dir], s.hold || 8, s.gap ?? 0);
          await frames(8);
          const q = pos();
          return q[0] !== p[0] || q[1] !== p[1] || q[2] !== p[2];
        };
        let ok = false;
        let blocked = 0;
        let side = 0;
        for (let n = 0; n < (s.max || 300); n++) {
          let p = pos();
          if (window.__rmDebug) console.log(`[go] ${n} pos ${JSON.stringify(p)} frame ${e.frames()}`);
          if (done(p)) {
            ok = true;
            break;
          }
          // only the axes still to go, in the plan's order (the first one is kept as long as it moves)
          const dirs = order.map((a) => dirOf(a, p)).filter(Boolean);
          let moved = false;
          for (const d of dirs) {
            if (await step(d)) {
              moved = true;
              break;
            }
          }
          if (moved) {
            blocked = 0;
            continue;
          }
          if (++blocked > (s.patience || 12)) break;
          // both blocked (or one axis left and blocked): one tile to the side, alternating
          const a = dirs[0] && (dirs[0] === 'UP' || dirs[0] === 'DOWN') ? ['LEFT', 'RIGHT'] : ['UP', 'DOWN'];
          await step(a[side++ % 2]);
          p = pos();
        }
        log.push({ do: 'go', to: [s.x, s.y], ok, pos: pos(), note: s.note, required: s.required !== false });
        if (!ok && s.required !== false) {
          shots.push(await shot(`fail-${log.length}`));
          break;
        }
        continue;
      } else if (s.do === 'tap') for (let i = 0; i < (s.times || 1); i++) await tap(s.x, s.y, s.hold);
      else if (s.do === 'walk') for (let i = 0; i < (s.steps || 1); i++) await press([s.dir], s.hold || 16, s.gap ?? 4);
      else if (s.do === 'mash' || s.do === 'until') {
        const seq = s.keys || [['A']];
        let i = 0;
        let ok = false;
        const max = e.frames() + (s.max || 20000);
        await ensureRam();
        while (e.frames() < max) {
          if (s.until && cond(s.until)) {
            ok = true;
            break;
          }
          if (s.do === 'until' && !s.keys) await frames(s.every || 30);
          else await press([].concat(seq[i++ % seq.length]), s.hold, s.every || 20);
        }
        log.push({ do: s.do, until: s.until, ok: s.until ? ok : null, frames: e.frames() - at, note: s.note, required: s.required !== false });
        if (s.until && !ok && s.required !== false) {
          shots.push(await shot(`fail-${log.length}`));
          break;
        }
        continue;
      } else if (s.do === 'shot') {
        const p = await shot(s.name);
        if (p) shots.push(p);
      } else if (s.do === 'check') {
        await ensureRam();
        ctx.state.lastScan3 = ctx.state.lastBmScan3 = 0; // (the app reads every 0.7 s and searches every few seconds; a check reads now)
        const tm = team();
        // plan.probe: an expression recorded at every check (an address being checked, e.g. a battle flag)
        let probe;
        try {
          probe = plan.probe ? new Function('read', 'place', 'team', 'ctx', `return (${plan.probe});`)(e.read, place, team, ctx) : undefined;
        } catch (err) {
          probe = String(err?.message || err);
        }
        // the level cap the app would show now: the curated list of an unmodified game, else the caps read from the ROM
        // (romcaps.mjs) – with the badges read live
        let cap = null;
        if (tm && Number.isInteger(tm.badges)) {
          const R = ctx.routes;
          const fam = ctx.romloc?.vanilla ? R.gymCapsFamily(plan.gameId || '') : null;
          const v = fam ? R.vanillaCapFor(fam, tm.badges) : R.romCapFor(ctx.romloc?.caps, tm.badges);
          cap = { badges: tm.badges, cap: v?.cap ?? null };
        }
        log.push({ do: 'check', name: s.name, frame: e.frames(), place: place(), team: tm, run: runNote(tm), cap, ...(probe !== undefined ? { probe } : {}) });
        continue;
      } else if (s.do === 'poke') {
        // write bytes into RAM (s.addr: a number or an expression → address; s.bytes) – e.g. room in a full team
        const at = typeof s.addr === 'string' ? new Function('read', 'ctx', `return (${s.addr});`)(e.read, ctx) : s.addr;
        const bytes = typeof s.bytes === 'string' ? new Function('read', 'ctx', `return (${s.bytes});`)(e.read, ctx) : s.bytes;
        e.write(at, Uint8Array.from(bytes));
        log.push({ do: 'poke', addr: at, n: bytes.length, note: s.note });
        continue;
      } else if (s.do === 'give' && s.pocketPtr) {
        // an engine with a bag of its own (Complete FireRed Upgrade keeps it outside SaveBlock1): gBagPockets[s.pocket]
        // at s.pocketPtr = { item slots pointer, capacity (u16) }; the item goes onto its own slot or the first free one
        // (quantity XOR the key at SaveBlock2 + s.keyOff when given – 0 in Radical Red)
        await ensureRam();
        const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
        const at = parseInt(s.pocketPtr, 16) + (s.pocket ?? 2) * 8;
        const pk = e.read(at, 8);
        const slots = u32(pk, 0);
        const cap = pk[4] | (pk[5] << 8);
        const item = s.item === 'ball' ? 4 : s.item;
        let key = 0;
        if (s.keyOff) {
          const sb2 = u32(e.read(parseInt(s.sb2Ptr || '0x0300500C', 16), 4), 0);
          key = u32(e.read(sb2 + parseInt(s.keyOff, 16), 4), 0) & 0xffff;
        }
        let r = { error: 'no free slot' };
        if (slots >= 0x02000000 && slots < 0x02040000 && cap > 0 && cap < 1000) {
          const b = e.read(slots, cap * 4);
          for (let i = 0; i < cap; i++) {
            const id = b[i * 4] | (b[i * 4 + 1] << 8);
            if (id && id !== item) continue;
            const q = ((s.count || 5) ^ key) & 0xffff;
            e.write(slots + i * 4, Uint8Array.from([item & 0xff, item >> 8, q & 0xff, q >> 8]));
            r = { slot: i, at: slots + i * 4 };
            break;
          }
        } else r = { error: `no pocket at ${at.toString(16)}` };
        log.push({ do: 'give', item, result: r, required: s.required !== false, ok: !r.error });
        if (r.error && s.required !== false) {
          shots.push(await shot(`fail-${log.length}`));
          break;
        }
        continue;
      } else if (s.do === 'give') {
        // items into the bag (shared/live/cheats.mjs addItem) – Poké Balls for a catch early in the game
        await ensureRam();
        const { addItem, POKE_BALL } = await import('/shared/live/cheats.mjs');
        team(); // (the DS readers find the bag through the party reader's state)
        const item = s.item === 'ball' || !s.item ? POKE_BALL[ctx.entry.gen] : s.item;
        // (s.saveBlockPtrs: where a hack keeps its save block pointers – Run & Bun's aren't the base game's)
        const ent = s.saveBlockPtrs ? { ...ctx.entry, saveBlockPtrs: s.saveBlockPtrs } : ctx.entry;
        const r = addItem(ent, { read: e.read, write: e.write }, ctx.state, item, s.count || 5, { pocket: s.pocket ?? (s.item === 'ball' || !s.item ? 'balls' : null), allowEmpty: true });
        log.push({ do: 'give', item, result: r, required: s.required !== false, ok: !r.error });
        if (r.error && s.required !== false) {
          shots.push(await shot(`fail-${log.length}`));
          break;
        }
        continue;
      } else if (s.do === 'log') {
        log.push({ do: 'log', name: s.name, value: new Function('read', 'place', 'team', 'ctx', `return (${s.expr});`)(e.read, place, team, ctx) });
        continue;
      } else if (s.do === 'saveState') state = await e.getState(); // (the fast player answers with a promise)
      else if (s.do === 'loadState' && state) e.loadState(state);
      log.push({ do: s.do, frames: e.frames() - at, note: s.note });
    }
    e.setSpeed(1);
    let b64 = null;
    try {
      const st = await e.getState();
      let s = '';
      for (let k = 0; k < st.length; k += 0x8000) s += String.fromCharCode.apply(null, st.subarray(k, k + 0x8000));
      b64 = btoa(s);
    } catch { /* no state */ }
    // the battery save as the game left it (--battery: a plan that saved in the game hands it to the next one)
    let sav = null;
    try {
      const b = e.getSave();
      if (b?.length) {
        let s = '';
        for (let k = 0; k < b.length; k += 0x8000) s += String.fromCharCode.apply(null, b.subarray(k, k + 0x8000));
        sav = btoa(s);
      }
    } catch { /* none */ }
    return { info, log, shots: shots.filter(Boolean), state: b64, sav, frames: e.frames(), ms: Math.round(performance.now() - t0) };
  }

  window.__rm = { run, press, tap, frames, shot, team, place, setup, cond };
}

export const PAGE_HELPER = `(${helper.toString()})(); true;`;
