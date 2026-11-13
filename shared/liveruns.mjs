// "Share to Discord" (Live runs): the rules of the bot's contract that the page and the local server both apply –
// event ids, the `meta` text with its limits and filters, the link code and the card's PNG. Pure functions, no I/O.
// The bot itself (its address, the player's token, the requests) lives only in server/lib/liveruns.mjs: the page
// never sees the token and never talks to the bot.

export const CARD_W = 1200;
export const CARD_H = 675;
export const MAX_PNG = 1.5 * 1024 * 1024;
export const KINDS = ['death', 'wipe', 'victory', 'badge'];
export const LIMITS = { eventId: 64, game: 60, run: 60, player: 32, players: 4, headline: 120, detail: 240 };
// the code `/live connect` shows: 6 characters from this alphabet (no 0/O, 1/I), shown as XXX-XXX
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Control characters (C0, DEL, C1), bidi overrides and isolates, zero-width characters and the BOM: the server drops
// them, and a bidi override could turn a name around in the post.
const CONTROL_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]];
const CONTROL_CLASS = `[${CONTROL_RANGES.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('')}]`;
const CONTROL = new RegExp(CONTROL_CLASS, 'gu');
// What the server refuses as a link: `http`, `discord.gg`, `www.` anywhere in the text (any case).
const LINKISH = /https?:\/\/\S*|www\.\S*|discord(?:app)?\.(?:gg|com\/invite)\/?\S*/gi;
const LINK_WORDS = /https?|www\.|discord\.gg/gi;

const hasControl = (s) => new RegExp(CONTROL_CLASS, 'u').test(s);
// line breaks and other C0/C1 characters become a space, invisible ones (zero-width, bidi, BOM) go away
const uncontrol = (s) => String(s).replace(CONTROL, (c) => (c.charCodeAt(0) < 0xa0 ? ' ' : ''));

/** Does the server refuse this text as a link? */
export const hasLink = (s) => /https?|www\.|discord\.gg/i.test(String(s ?? ''));

/** Cut to `max` UTF-16 units (the server's count) without splitting a surrogate pair; "…" marks the cut. */
export function clip(s, max) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  let out = '';
  for (const ch of str) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** Control characters out, white space collapsed – the text as the player sees it. */
const plainText = (s) => uncontrol(s).replace(/\s+/g, ' ').trim();
/** …and without links or link words (the server refuses those). */
const linkFree = (s) => plainText(uncontrol(s).replace(LINKISH, ' ').replace(LINK_WORDS, ' '));

/**
 * One text field as the server takes it: control characters out, links and link words out, white space collapsed,
 * cut to `max`. Returns '' for anything that isn't text.
 */
export function cleanText(s, max) {
  if (typeof s !== 'string' && typeof s !== 'number') return '';
  return clip(linkFree(s), max);
}

/** File names don't belong on a post (streamer mode, and a run name is sometimes the ROM's name): drop the extension. */
export function stripFileNames(s) {
  return String(s ?? '').replace(/\.(?:nds|gba|gbc|gb|3ds|cia|cxi|zip|7z|sav|dsv|srm|state|ips|bps|ups|xdelta|vcdiff)\b/gi, '');
}

const safeKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

/** FNV-1a, base 36 – a short stable stand-in for an area key too long for the id. */
function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * The event's id: the same for every player of the run and for every time it is shared – the bot answers a second
 * post of it with 409, and the app shows "Shared" for it. Built from the run's id (the same on every player's
 * computer), the kind and what makes the event unique: the area and death time of a death, the time of a run's end.
 * `at` is the doc's timestamp (pair.diedAt, run:status.at), which syncs to every player unchanged.
 */
export function eventIdFor(runId, kind, { area = '', at = 0 } = {}) {
  const run = safeKey(runId).slice(0, 16) || 'run';
  const when = Number.isFinite(at) && at > 0 ? Math.floor(at).toString(36) : '0';
  let id;
  if (kind === 'death') {
    let a = safeKey(area) || 'area';
    if (a.length > 24) a = `h${shortHash(String(area))}`;
    id = `run-${run}:death:${a}:${when}`;
  } else id = `run-${run}:${KINDS.includes(kind) ? kind : 'death'}:${when}`;
  return id.slice(0, LIMITS.eventId);
}

/**
 * `meta` for POST /live/post, every field cleaned and cut to the contract's limits. `changed` names the fields
 * whose text had to be altered beyond a cut (links or control characters taken out) – the page warns about those.
 * `app` is set by the local server (the running version), not by the page.
 */
export function buildMeta(input = {}) {
  const changed = [];
  const field = (name, value, max, { files = false } = {}) => {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    const src = files ? stripFileNames(value) : String(value);
    const clean = linkFree(src);
    if (clean !== plainText(src) && !changed.includes(name)) changed.push(name);
    return clip(clean, max);
  };
  const players = (Array.isArray(input.players) ? input.players : []).slice(0, LIMITS.players)
    .map((p) => field('players', p, LIMITS.player)).filter(Boolean);
  const meta = {
    v: 1,
    eventId: uncontrol(input.eventId ?? '').replace(/\s+/g, '').slice(0, LIMITS.eventId),
    kind: KINDS.includes(input.kind) ? input.kind : 'death',
    mode: input.mode === 'nuzlocke' ? 'nuzlocke' : 'soullink',
    game: field('game', input.game, LIMITS.game, { files: true }),
    run: field('run', input.run, LIMITS.run, { files: true }),
    players,
    headline: field('headline', input.headline, LIMITS.headline),
    detail: field('detail', input.detail, LIMITS.detail),
    ...(typeof input.app === 'string' && /^\d+\.\d+\.\d+/.test(input.app) ? { app: input.app.slice(0, 20) } : {}),
  };
  return { meta, changed };
}

/** Is `meta` what the server accepts? Returns the first field that isn't, or null. */
export function metaProblem(meta) {
  if (!meta || typeof meta !== 'object') return 'meta';
  if (meta.v !== 1) return 'v';
  if (typeof meta.eventId !== 'string' || !meta.eventId || meta.eventId.length > LIMITS.eventId) return 'eventId';
  if (!KINDS.includes(meta.kind)) return 'kind';
  if (!['soullink', 'nuzlocke'].includes(meta.mode)) return 'mode';
  for (const k of ['game', 'run', 'headline', 'detail']) {
    if (typeof meta[k] !== 'string' || meta[k].length > LIMITS[k] || hasLink(meta[k]) || hasControl(meta[k])) return k;
  }
  if (!meta.headline) return 'headline';
  if (!Array.isArray(meta.players) || meta.players.length > LIMITS.players
    || meta.players.some((p) => typeof p !== 'string' || p.length > LIMITS.player || hasLink(p))) return 'players';
  return null;
}

/** The link code as the bot shows it ("K7Q-4M2"): any case, with or without the dash or spaces. null when it can't be one. */
export function normalizeCode(s) {
  const raw = String(s ?? '').toUpperCase().replace(/[\s-]+/g, '');
  if (raw.length !== 6 || [...raw].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return `${raw.slice(0, 3)}-${raw.slice(3)}`;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Is `buf` (Uint8Array / Buffer) a PNG the server takes: signature, IHDR 1200×675, at most 1.5 MB? null or the problem. */
export function pngProblem(buf) {
  if (!buf || typeof buf.length !== 'number' || buf.length < 33) return 'empty';
  if (buf.length > MAX_PNG) return 'size';
  if (PNG_SIG.some((b, i) => buf[i] !== b)) return 'signature';
  // the first chunk must be IHDR: length 13, then the type, then width and height (big endian)
  const u32 = (o) => ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
  if (u32(8) !== 13 || String.fromCharCode(buf[12], buf[13], buf[14], buf[15]) !== 'IHDR') return 'ihdr';
  if (u32(16) !== CARD_W || u32(20) !== CARD_H) return 'dimensions';
  return null;
}
