// Level caps from the game's own trainer data, for games without a curated list (shared/routes.mjs): the gym leaders,
// the Elite Four and the champion, found by their trainer class names (in the languages the games came out in, and
// as the hacks name them), their first fight (rematches are stronger, so a leader's weakest team is the first one) and
// its ace level. "Cap with n badges" = the ace of the leader who gives badge n + 1; after the last badge the champion's
// (the weakest champion team at least as strong as the Elite Four's).
//
// Only a clean result counts – exactly eight leaders, aces that rise with the badges, an Elite Four / champion above the
// last leader – anything else is null (no cap shown rather than a wrong one). Gen 3 also says which flags are the
// badges: the leaders' battle scripts set them (8 consecutive flags), which gives their order and lets the live reader
// count badges (shared/live/parse.mjs).
import { listNdsFiles, ndsFile, parseNarc } from '../nds.mjs';
import { gen4Messages, gen5Messages } from './romloc.mjs';

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// trainer class names: English, German, French, Spanish and Italian retail names, and the hacks' spellings
const LEADER = /^(leader|gym leader|leiter|arenaleiter(in)?|champion d.arene|champ\. arene|arene|lider|lider de gimnasio|capopalestra|capopal\.?)$/;
const ELITE = /^(elite four|elite 4|top vier|top 4|conseil 4|conseil des 4|alto mando|superquattro|super 4)$/;
const CHAMP = /^(champion|champ|maitre|maitresse|campeon|campeona|campione|champion(ne)?)$/;
/** 'leader' | 'elite' | 'champion' | null for a trainer class name. */
export function bossKind(name) {
  const n = plain(name);
  if (!n) return null;
  if (LEADER.test(n)) return 'leader';
  if (ELITE.test(n)) return 'elite';
  if (CHAMP.test(n)) return 'champion';
  return null;
}

/**
 * The caps from a list of boss trainers: [{ id, kind, name, ace, badge? }] (badge: 0-based, where the game says which
 * badge the leader gives). Each leader counts once (its weakest team: the first fight); `expect` leaders.
 * → { caps: [ace for 0 … n-1 badges], leaders: [names], final: { name, cap } | null } or { why } when it isn't clean.
 */
export function capsFrom(bosses, { expect = 8 } = {}) {
  const first = (list) => {
    const by = new Map();
    for (const b of list) {
      const k = plain(b.name);
      if (!k || !(b.ace >= 2 && b.ace <= 100)) continue;
      const cur = by.get(k);
      if (!cur || b.ace < cur.ace) by.set(k, b);
    }
    return [...by.values()];
  };
  const leaders = first(bosses.filter((b) => b.kind === 'leader'));
  if (leaders.length !== expect) return { why: `${leaders.length} gym leaders` };
  // a leader with teams of a few levels apart (Unbound's difficulty settings – a rematch is far stronger): which one
  // the player meets isn't known
  for (const l of leaders) {
    const near = new Set(bosses.filter((b) => b.kind === 'leader' && plain(b.name) === plain(l.name) && b.ace >= l.ace && b.ace <= l.ace + 6).map((b) => b.ace));
    if ([...near].some((a) => a > l.ace + 1)) return { why: `${l.name}: teams of several difficulties` };
  }
  const ordered = leaders.every((l) => Number.isInteger(l.badge)) && new Set(leaders.map((l) => l.badge)).size === expect
    ? [...leaders].sort((a, b) => a.badge - b.badge)
    : [...leaders].sort((a, b) => a.ace - b.ace || a.id - b.id);
  // aces rise with the badges (a leader a few levels below the one before is fine – FireRed's Koga 43, Sabrina 43)
  for (let i = 1; i < ordered.length; i++) if (ordered[i].ace < ordered[i - 1].ace - 3) return { why: `ace of leader ${i + 1} below leader ${i}` };
  const last = ordered.at(-1).ace;
  const elite = first(bosses.filter((b) => b.kind === 'elite'));
  const champs = first(bosses.filter((b) => b.kind === 'champion')).sort((a, b) => a.ace - b.ace);
  const top4 = elite.length ? Math.max(...elite.map((e) => e.ace)) : 0;
  const champ = champs.find((c) => c.ace >= top4 && c.ace >= last);
  const final = champ ? { name: 'Champion', cap: champ.ace } : top4 >= last ? { name: 'Elite Four', cap: top4 } : null;
  return { caps: ordered.map((l) => l.ace), leaders: ordered.map((l) => l.name), final };
}

// ---------------------------------------------------------------- Gen 3

/** Gen 3 text of at most `n` bytes → string, null when a byte isn't a character (or, with `end`, no terminator). */
function text3(rom, o, n, table, end = true) {
  let s = '';
  for (let k = 0; k < n && o + k < rom.length; k++) {
    const c = rom[o + k];
    if (c === 0xff) return s;
    const ch = table[c.toString(16).toUpperCase().padStart(2, '0')];
    if (ch === undefined) return null;
    s += ch.length === 1 ? ch : '';
  }
  return end ? null : s;
}

const inRom = (p, rom) => p >>> 25 === 4 && (p & 0x1ffffff) < rom.length;

/**
 * gTrainers: 40 bytes per trainer (party flags, class, music/gender, picture, name[12], items, double battle, AI flags,
 * party size at +0x20, party pointer at +0x24) – the retail struct, kept by Complete FireRed Upgrade and older
 * expansions. Unused entries (no party) may sit in between. → { offset (trainer 0), list: [{ id, flags, cls, name, n,
 * ptr }] } or null; of the runs found the longest.
 */
export function gen3Trainers(rom, table) {
  const rec = (o) => {
    const n = rom[o + 0x20];
    const p = u32(rom, o + 0x24);
    if (n > 6 || rom[o + 0x21] || (n ? !inRom(p, rom) : p !== 0)) return null;
    if (!n && rom.subarray(o, o + 40).every((b) => !b)) return null; // (zeroes: past the table)
    const name = text3(rom, o + 4, 12, table, false); // (a name of all 12 letters has no terminator)
    return name === null ? null : { flags: rom[o], cls: rom[o + 1], name: name.trim(), n, ptr: p & 0x1ffffff };
  };
  let best = null;
  for (let o = 0; o + 40 * 100 < rom.length; o += 4) {
    // trainer 0 (TRAINER_NONE): no party, an empty name with its terminator
    if (rom[o + 0x20] || rom[o + 0x21] || rom[o + 0x24] || rom[o + 0x27] || text3(rom, o + 4, 12, table) === null || !rec(o)) continue;
    const list = [];
    let full = 0;
    for (let i = 0; i < 4096; i++) {
      const r = rec(o + i * 40);
      if (!r) break;
      list.push({ id: i, ...r });
      if (r.n) full++;
    }
    if (full > 100 && (!best || full > best.full)) best = { offset: o, list, full };
    if (full > 100) o += list.length * 40 - 4;
  }
  return best;
}

/**
 * The size of one party member per party-flags value: parties lie one after the other in the ROM, so the step from a
 * party to the next one's pointer, divided by its size, is it (the most common such step). Retail: 8 / 16 bytes.
 */
export function partySizes(list) {
  const votes = new Map();
  const sorted = list.filter((t) => t.n).sort((a, b) => a.ptr - b.ptr);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const t = sorted[i];
    const d = sorted[i + 1].ptr - t.ptr;
    if (d <= 0 || d % t.n) continue;
    const s = d / t.n;
    if (s < 6 || s > 64) continue;
    const k = `${t.flags}:${s}`;
    votes.set(k, (votes.get(k) || 0) + 1);
  }
  const size = {};
  for (const [k, n] of votes) {
    const [f, s] = k.split(':').map(Number);
    if (n >= 3 && (!size[f] || n > size[f].n)) size[f] = { s, n };
  }
  return Object.fromEntries(Object.entries(size).map(([f, v]) => [f, v.s]));
}

/**
 * The trainer class names (13 bytes each), lined up with the classes the trainers use: of the alignments the boss
 * classes' names suggest, the one that puts most of them at the start of an entry (a hack's half-overwritten entry may
 * hold "Leader" in its middle), then the one with most names.
 */
export function gen3Classes(rom, table, maxClass) {
  const code = {};
  for (const [k, v] of Object.entries(table)) if (v.length === 1 && !(v in code)) code[v] = parseInt(k, 16);
  const words = ['LEADER', 'Leader', 'LEITER', 'Leiter', 'LÍDER', 'Líder', 'CAPOPALESTRA', 'Capopalestra', 'ELITE FOUR', 'Elite Four', 'TOP VIER', 'CONSEIL 4', 'ALTO MANDO', 'SUPERQUATTRO', 'CHAMPION', 'Champion', 'CHAMP', 'CAMPEÓN', 'CAMPIONE']
    .map((w) => [...w].map((c) => code[c])).filter((b) => b.every((x) => x !== undefined));
  const hits = [];
  const lead = new Set(words.map((b) => b[0]));
  for (let o = 0; o + 16 < rom.length; o++) if (lead.has(rom[o]) && words.some((b) => rom[o] === b[0] && b.every((x, k) => rom[o + k] === x) && rom[o + b.length] === 0xff)) hits.push(o);
  const tried = new Set();
  const memo = new Map(); // (the alignments overlap: each entry is read once)
  const name = (q) => {
    if (!memo.has(q)) memo.set(q, text3(rom, q, 13, table));
    return memo.get(q);
  };
  let best = null;
  for (const o of hits) {
    for (let k = 0; k <= maxClass; k++) {
      const start = o - k * 13;
      if (start < 0 || tried.has(start)) continue;
      tried.add(start);
      const end = start + (maxClass + 1) * 13;
      const aligned = hits.filter((h) => h >= start && h < end && (h - start) % 13 === 0).length;
      let good = 0;
      const names = [];
      for (let i = 0; i <= maxClass; i++) {
        const t = name(start + i * 13);
        names.push(t === null ? '' : t.trim());
        if (t) good++;
      }
      // (shifted by a whole entry it reads as well: then the start is where the entry before it isn't a name)
      const score = aligned * 1000 + good * 2 + (name(start - 13) === null ? 1 : 0);
      if (good > (maxClass + 1) * 0.8 && (!best || score > best.score)) best = { offset: start, names, good, score };
    }
  }
  return best;
}

/**
 * The trainerbattle script commands (0x5C, type, trainer id, 0, intro text pointer …): which trainers a script battles,
 * and the flags the script sets after the battle (setflag 0x29 within the continue script or right after the command).
 * → Map(id → [Set of flags per command]).
 */
export function gen3Battles(rom) {
  const out = new Map();
  for (let o = 0; o + 22 < rom.length; o++) {
    if (rom[o] !== 0x5c || rom[o + 1] > 9 || rom[o + 4] || rom[o + 5] || !inRom(u32(rom, o + 6), rom)) continue;
    const t = rom[o + 1];
    const id = u16(rom, o + 2);
    // types 1/2 (and 6/8, doubles) continue with a script of their own; the others go on right after the command
    const sp = t === 1 || t === 2 ? u32(rom, o + 14) : t === 6 || t === 8 ? u32(rom, o + 18) : 0;
    const len = t === 0 || t === 5 ? 14 : t === 3 ? 10 : t === 1 || t === 2 || t === 4 || t === 7 ? 18 : 22;
    const flags = new Set();
    const scan = (from, n) => {
      for (let k = 0; k < n && from + k + 2 < rom.length; k++) if (rom[from + k] === 0x29) flags.add(u16(rom, from + k + 1));
    };
    if (inRom(sp, rom)) scan(sp & 0x1ffffff, 200);
    scan(o + len, 120);
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(flags);
  }
  return out;
}

/**
 * Which flags are the badges: eight consecutive ones that the eight leaders' scripts set, one each. → { from, of:
 * Map(name → badge 0–7) } or null. Of several such runs (FireRed's FLAG_DEFEATED_BROCK … also count up) the highest –
 * the badge flags.
 */
function badgeFlags(leaders, battles) {
  const flagsOf = new Map();
  for (const l of leaders) {
    const k = plain(l.name);
    const set = flagsOf.get(k) || new Set();
    for (const f of (battles.get(l.id) || []).flatMap((s) => [...s])) set.add(f);
    flagsOf.set(k, set);
  }
  if (flagsOf.size !== 8) return null;
  const all = [...new Set([...flagsOf.values()].flatMap((s) => [...s]))].sort((a, b) => b - a);
  for (const top of all) {
    for (let j = 0; j < 8; j++) {
      const from = top - j;
      const of = new Map();
      let ok = true;
      for (const [k, set] of flagsOf) {
        const hit = [...set].filter((f) => f >= from && f < from + 8);
        if (hit.length !== 1) {
          ok = false;
          break;
        }
        of.set(k, hit[0] - from);
      }
      if (ok && new Set(of.values()).size === 8) return { from, of };
    }
  }
  return null;
}

/** Level caps of a GBA game (see the top). `opts` = { gen3Charset }. → { caps, leaders, final, badgeFlags, source } | { why } */
export function gen3Caps(rom, opts = {}) {
  const table = opts.gen3Charset?.table || opts.gen3Charset || {};
  const tr = gen3Trainers(rom, table);
  if (!tr) return { why: 'no trainer table' };
  const sizes = partySizes(tr.list);
  // (the highest class at least two trainers have: a hack's repurposed entry may hold anything there)
  const count = new Map();
  for (const t of tr.list) if (t.n) count.set(t.cls, (count.get(t.cls) || 0) + 1);
  const maxClass = Math.max(...[...count].filter(([, n]) => n >= 2).map(([c]) => c));
  const cls = gen3Classes(rom, table, maxClass);
  if (!cls) return { why: 'no trainer class names' };
  const ace = (t) => {
    const s = sizes[t.flags] || (t.flags & 1 ? 16 : 8);
    let max = 0;
    for (let k = 0; k < t.n; k++) {
      const lv = rom[t.ptr + k * s + 2];
      if (!lv || lv > 100) return 0;
      if (lv > max) max = lv;
    }
    return max;
  };
  const battles = gen3Battles(rom);
  const all = tr.list.filter((t) => t.n && t.name && bossKind(cls.names[t.cls])).map((t) => ({ id: t.id, kind: bossKind(cls.names[t.cls]), name: t.name, ace: ace(t) }));
  // the trainers a script battles (a hack leaves the retail ones and rematch copies unbattled); where a hack starts its
  // battles some other way (Unbound), all of them
  const pools = [all.filter((b) => battles.has(b.id)), all];
  let why = 'no gym leaders';
  for (const pool of pools) {
    const leaders = pool.filter((b) => b.kind === 'leader');
    const bf = badgeFlags(leaders, battles);
    const bosses = pool.map((b) => (b.kind === 'leader' && bf?.of.has(plain(b.name)) ? { ...b, badge: bf.of.get(plain(b.name)) } : b));
    // (with badge flags: only the leaders whose scripts set one)
    const r = capsFrom(bf ? bosses.filter((b) => b.kind !== 'leader' || battles.get(b.id)?.some((s) => [...s].some((f) => f >= bf.from && f < bf.from + 8))) : bosses);
    if (r.caps) return { ...r, badgeFlags: bf ? bf.from : null, source: { trainers: tr.offset, classes: cls.offset } };
    why = r.why;
  }
  return { why };
}

// ---------------------------------------------------------------- Gen 4 / 5 (DS)

/**
 * Level caps of a DS game from its trainer files (one file per trainer: class at +1, party size at +3; its party
 * file holds the members, the level at +2 – a u16 in Gen 4, a byte in Gen 5) and the trainer and class names in
 * the game's text. HeartGold/SoulSilver have a curated list and aren't read here.
 */
export function dsCaps(rom, opts = {}) {
  const code = String.fromCharCode(...rom.subarray(0x0c, 0x10)).slice(0, 3);
  const files = listNdsFiles(rom);
  const has = (p) => files.some((f) => f.path === p);
  let trd;
  let trp;
  let texts;
  let gen;
  if (/^IR[ABDE]$/.test(code)) {
    gen = 5;
    const b2 = /^IR[DE]$/.test(code);
    trd = ndsFile(rom, b2 ? 'a/0/9/1' : 'a/0/9/2', files);
    trp = ndsFile(rom, b2 ? 'a/0/9/2' : 'a/0/9/3', files);
    texts = ndsFile(rom, 'a/0/0/2', files);
  } else {
    gen = 4;
    if (/^IP[KG]$/.test(code) || has('a/0/5/5')) return { why: 'HeartGold/SoulSilver have a curated list' };
    trd = ndsFile(rom, 'poketool/trainer/trdata.narc', files);
    trp = ndsFile(rom, 'poketool/trainer/trpoke.narc', files);
    texts = ndsFile(rom, has('msgdata/pl_msg.narc') ? 'msgdata/pl_msg.narc' : 'msgdata/msg.narc', files);
  }
  if (!trd || !trp || !texts) return { why: 'no trainer files' };
  const data = parseNarc(trd);
  const parties = parseNarc(trp);
  const msgs = parseNarc(texts);
  const read = (b) => {
    try {
      return gen === 5 ? gen5Messages(b) : gen4Messages(b, opts.gen4Chars);
    } catch {
      return [];
    }
  };
  // the class names: a short text with leader and champion classes
  const strings = msgs.map((m) => (m.length <= 600000 ? read(m) : []));
  // (the one with most such classes: Gen 5 has a class per leader)
  const bossCount = (s) => (s.length >= 30 && s.length < 400 && s.some((x) => bossKind(x) === 'leader') && s.some((x) => bossKind(x) === 'champion') ? s.filter(bossKind).length : 0);
  const classes = strings.reduce((a, s) => (bossCount(s) > (a ? bossCount(a) : 0) ? s : a), null);
  if (!classes) return { why: 'no trainer class names' };
  // the trainer names: of the texts with about a string per trainer (a game may have more: Renegade Platinum 1201 for
  // 1066 trainers, Blaze Black 2 Redux 2326 for 891 – or fewer: Black 2 814 for 891), the one that names the bosses –
  // each boss class's trainers (a leader's rematches) all by one name
  const byClass = new Map();
  for (let i = 1; i < data.length; i++) if (data[i] && bossKind(classes[data[i][1]])) byClass.set(data[i][1], [...(byClass.get(data[i][1]) || []), i]);
  const proper = (x) => !!x && x.length <= 16 && /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .'&♂♀-]*$/.test(x);
  let names = null;
  for (const s of strings) {
    if (s.length < data.length * 0.85 || s.length > data.length * 4) continue;
    let score = 0;
    const distinct = new Set();
    for (const ids of byClass.values()) {
      const got = ids.map((i) => s[i]);
      score += got.filter(proper).length;
      if (got.every(proper) && new Set(got).size === 1) score += 5;
      for (const x of got) if (proper(x)) distinct.add(x);
    }
    score += distinct.size * 10; // (a text of placeholders – "dmy" for everyone – names nobody)
    if (score > 0 && (!names || score > names.score)) names = { list: s, score };
  }
  if (!names) return { why: 'no trainer names' };
  const bosses = [];
  for (let i = 1; i < data.length; i++) {
    const d = data[i];
    const p = parties[i];
    const n = d?.[3];
    const kind = d ? bossKind(classes[d[1]]) : null;
    if (!kind || !n || !p) continue;
    // a member: Gen 4 6 bytes (Platinum 8: a ball seal), Gen 5 8 – plus 2 with held items, 8 with moves; the file may be
    // padded to 4 bytes
    const base = (gen === 5 ? 8 : 6) + (d[0] & 2 ? 2 : 0) + (d[0] & 1 ? 8 : 0);
    const size = [base, base + 2].find((sz) => p.length >= n * sz && p.length < n * sz + 4);
    if (!size) continue;
    let ace = 0;
    for (let k = 0; k < n; k++) {
      const lv = gen === 5 ? p[k * size + 2] : u16(p, k * size + 2);
      if (!lv || lv > 100) {
        ace = 0;
        break;
      }
      ace = Math.max(ace, lv);
    }
    if (ace) bosses.push({ id: i, kind, name: names.list[i] || '', ace });
  }
  const r = capsFrom(bosses);
  if (opts.debug) r.bosses = bosses;
  return r.caps ? { ...r, badgeFlags: null, source: { trainers: gen === 5 ? 'a/0/9/x' : 'trdata' } } : r;
}

/**
 * Level caps of a ROM: GBA and DS (Gen 4/5 without a curated list). → { caps, leaders, final, badgeFlags, source } or
 * { why } (nothing clean found – no cap is shown). Never throws.
 */
export function romCaps(rom, opts = {}) {
  try {
    if (!rom || rom.length < 0x200) return { why: 'no ROM' };
    if (rom[0xb2] === 0x96 && rom[3] === 0xea) return gen3Caps(rom, opts);
    if (rom[0x104] === 0xce && rom[0x105] === 0xed) return { why: 'Game Boy: curated lists only' };
    return dsCaps(rom, opts);
  } catch (e) {
    return { why: `error: ${e?.message || e}` };
  }
}
