import { html, useState, useMemo, useEffect } from '/vendor/htm-preact.mjs';
import { useApp, Modal } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, currentLang } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { serverErrorText } from '../lib/errors.mjs';
import { catalog, gameTitle } from '../lib/data.mjs';
import { FirstSteps } from './firststeps.mjs';
import { IS_MAC, IS_WIN, shortPath } from '../lib/platform.mjs';

const SYS = { gb: 'GB', gbc: 'GBC', gba: 'GBA', nds: 'DS', '3ds': '3DS' };

/** "Search my Mac" / "Search my PC" – the button's label on this computer (PC: Windows and Linux). */
export const discoverLabel = () => (IS_MAC ? t('disc.button', 'Search my Mac') : t('disc.buttonPc', 'Search my PC'));

/** Ask for files (native dialog in the app, file input in a browser) and import them. */

/**
 * "Search my Mac / PC": the server looks through Downloads, Desktop, Documents, iCloud Drive / OneDrive, game folders
 * and emulator libraries for ROMs (headers only) – the player ticks what to copy into the library.
 */
export function DiscoverModal({ onClose }) {
  const { reloadLibrary, toast } = useApp();
  const [res, setRes] = useState(null);
  const [error, setError] = useState(null);
  const [pick, setPick] = useState({});
  const [busy, setBusy] = useState(false);
  const cat = catalog();
  useEffect(() => {
    let off = false;
    api.post('/api/library/discover', {}).then((r) => {
      if (off) return;
      setRes(r);
      setPick(Object.fromEntries(r.found.filter((f) => !f.inLibrary).map((f) => [key(f), true])));
    }).catch((e) => !off && setError(e.message));
    return () => { off = true; };
  }, []);
  const key = (f) => `${f.path}|${f.entry || ''}`;
  const home = shortPath;
  const chosen = (res?.found || []).filter((f) => pick[key(f)]);
  const add = async () => {
    setBusy(true);
    try {
      const paths = [...new Set(chosen.map((f) => f.path))]; // a zip is copied whole
      const r = await api.post('/api/library/import', { paths });
      await reloadLibrary();
      toast({ kind: 'ok', title: t('disc.added', 'Added to your library'), text: t('disc.addedText', '{n} file|{n} files', { n: r.added.length, count: r.added.length }) });
      onClose();
    } catch (e) {
      toast({ kind: 'death', title: t('disc.failed', 'Could not add the games'), text: e.message });
      setBusy(false);
    }
  };
  return html`<${Modal} open=${true} wide onClose=${() => !busy && onClose()} title=${IS_MAC ? t('disc.title', 'Search this Mac for games') : t('disc.titlePc', 'Search this PC for games')}
    footer=${html`<button class="btn ghost" disabled=${busy} onClick=${onClose}>${t('common.cancel', 'Cancel')}</button>
      ${res && html`<button class="btn primary" disabled=${busy || !chosen.length} onClick=${add}><${Icon} name="plus" size=${14} />${t('disc.add', 'Add {n}|Add {n}', { n: chosen.length, count: chosen.length })}</button>`}`}>
    ${!res && !error && html`<div class="disc-search" role="status"><span class="disc-spin" aria-hidden="true"></span>
      <div><b>${IS_MAC ? t('disc.searching', 'Looking in Downloads, Desktop, Documents, iCloud Drive and game folders …') : IS_WIN ? t('disc.searchingPc', 'Looking in Downloads, Desktop, Documents, OneDrive and game folders …')
        : t('disc.searchingLinux', 'Looking in Downloads, Desktop, Documents, game folders (EmuDeck, RetroDECK, RetroArch) and on SD cards …')}</b>
      <p class="small muted">${IS_MAC ? t('disc.privacy', 'Only file names and the first bytes of game files are read – nothing leaves your Mac. macOS may ask once whether souldew may look into these folders.')
        : t('disc.privacyPc', 'Only file names and the first bytes of game files are read – nothing leaves your PC.')}</p></div></div>`}
    ${error && html`<div class="warning error" role="alert">${error}</div>`}
    ${res && !res.found.length && html`<div class="note">${t('disc.none', 'No games found in the usual places. Add them by hand – or drop the files into the library.')}</div>`}
    ${res && res.found.length > 0 && html`<ul class="disc-list">
      ${res.found.map((f) => {
        const g = f.gameId ? cat.games.find((x) => x.id === f.gameId) : null;
        return html`<li class=${`disc-item ${f.inLibrary ? 'have' : ''}`}><label>
          <input type="checkbox" checked=${!!pick[key(f)]} disabled=${f.inLibrary || busy} onChange=${(e) => setPick({ ...pick, [key(f)]: e.target.checked })} />
          ${g ? html`<img class="disc-cover pixel" src=${`/covers/${g.id}.png`} alt="" loading="lazy" />` : html`<span class="disc-cover none">${SYS[f.system] || '?'}</span>`}
          <span class="disc-body"><b>${g ? gameTitle(g) : f.name}</b>
            <span class="tiny muted">${[SYS[f.system], g ? f.name : t('disc.unknown', 'not in the catalog (ROM hack or other version)'), home(f.entry ? `${f.path} › ${f.entry}` : f.path)].filter(Boolean).join(' · ')}</span></span>
          ${f.inLibrary ? html`<span class="chip">${t('disc.have', 'already in the library')}</span>` : g ? html`<span class="chip ok">${t('disc.known', 'recognised')}</span>` : ''}
        </label></li>`;
      })}
    </ul>`}
    ${res?.truncated && html`<p class="tiny faint">${t('disc.truncated', 'Very large folders were only searched in part. Games deeper inside: add them by hand.')}</p>`}
  <//>`;
}

export async function addGamesFlow({ reloadLibrary, folder = false, toast } = {}) {
  let failures = [];
  try {
    if (window.sls?.pickFiles) {
      const paths = await window.sls.pickFiles({ folder, title: t('lib.addTitle', 'Add games to souldew') });
      if (!paths?.length) return;
      if (folder) await api.post('/api/library/folders', { add: paths[0] });
      else await api.post('/api/library/import', { paths });
    } else {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.gb,.gbc,.gba,.nds,.3ds,.cci,.cxi,.cia,.3dsx,.zcci,.zcxi,.z3dsx,.zip,.xdelta,.vcdiff,.bps,.ups,.ips';
      const files = await new Promise((resolve) => {
        input.onchange = () => resolve([...input.files]);
        input.addEventListener('cancel', () => resolve([]));
        input.click();
      });
      if (!files.length) return;
      failures = await uploadFiles(files);
    }
  } catch (err) {
    toast?.({ kind: 'death', title: t('lib.addFailed', 'Could not add files'), text: err.message });
    await reloadLibrary?.();
    return;
  }
  await reloadLibrary?.();
  if (failures.length) toastFailures(toast, failures);
  else toast?.({ kind: 'ok', title: t('lib.added', 'Library updated'), text: t('lib.addedText', 'New games are on the shelf.') });
}

async function uploadFile(file) {
  const res = await fetch(`/api/library/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'x-soullink': '1' }, body: file });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = body;
    try {
      msg = JSON.parse(body).error || body;
    } catch {}
    throw new Error(msg || `HTTP ${res.status}`);
  }
}

/** Upload every file; one bad file doesn't stop the rest. Returns [{ name, error }] for the ones that failed. */
async function uploadFiles(files) {
  const failures = [];
  for (const f of files) {
    try {
      await uploadFile(f);
    } catch (err) {
      failures.push({ name: f.name, error: err.message });
    }
  }
  return failures;
}

function toastFailures(toast, failures) {
  toast?.({
    kind: 'death',
    title: t('lib.uploadFailed', '{count} file could not be added|{count} files could not be added', { count: failures.length }),
    text: failures.map((f) => `${f.name}: ${f.error}`).join('\n'),
  });
}

export function DropZone({ onAdded }) {
  const { toast } = useApp();
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  return html`<div class=${`dropzone ${over ? 'over' : ''}`}
    onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)}
    onDrop=${async (e) => {
      e.preventDefault();
      setOver(false);
      setBusy(true);
      try {
        const failures = await uploadFiles([...e.dataTransfer.files]);
        await onAdded?.();
        if (failures.length) toastFailures(toast, failures);
      } catch (err) {
        toast?.({ kind: 'death', title: t('lib.addFailed', 'Could not add files'), text: err.message });
      } finally {
        setBusy(false);
      }
    }}>
    <${Icon} name="library" size=${36} />
    <p class="px" style="font-size:16px;margin-top:6px">${busy ? t('lib.importing', 'Importing …') : t('lib.drop', 'Drop ROMs, zips or patches here')}</p>
    <p class="small faint">.gb · .gbc · .gba · .nds · .3ds · .cci · .cxi · .cia · .3dsx · .zip · .xdelta · .bps · .ups · .ips</p>
  </div>`;
}

const CART_KIND = { gb: 'gb', gbc: 'gb', gba: 'gba', nds: 'nds', '3ds': 'nds' }; // a 3DS card has the DS card's shape

// ---- covers: the catalog's, or the player's own picture (server/lib/covers.mjs) ---------------------------------
// Own pictures are keyed game:<catalog id> · hack:<catalog id> · rom:<CRC32> (a ROM the catalog doesn't know).
export const COVER_ACCEPT = 'image/png,image/jpeg,image/webp';
const COVER_MAX = 4 * 1024 * 1024; // server/lib/covers.mjs COVER_LIMIT

/** The key an entry's own picture is stored under. */
export function coverIdOf({ gameId, hackId, rom } = {}) {
  if (hackId) return `hack:${hackId}`;
  if (gameId) return `game:${gameId}`;
  return rom?.coverId || (rom?.crc ? `rom:${rom.crc}` : null);
}

/**
 * The picture to show for a game, ROM hack or library ROM: the player's own first (hack, then the game and the game
 * its regional variant belongs to), else the catalog cover (a hack shows its base game). null = no picture.
 * Used for the cart in the library, the run list, the Play page and the insert animation.
 */
export function coverOf(library, { gameId, hackId, rom } = {}) {
  const own = library?.customCovers || {};
  const cat = catalog();
  const hack = hackId ? (cat.hacks || []).find((h) => h.id === hackId) : null;
  const gid = gameId || rom?.gameId || hack?.baseGameId || null;
  const g = gid ? (cat.games || []).find((x) => x.id === gid) : null;
  const mine = [hackId && `hack:${hackId}`, g && `game:${g.id}`, g?.variantOf && `game:${g.variantOf}`].filter(Boolean).map((k) => own[k]).find(Boolean)
    || (!g && rom ? rom.customCover || own[coverIdOf({ rom })] : null);
  if (mine) return mine;
  return g ? `/covers/${g.id}.png` : null;
}

/** Let the player pick an image file and store it as the entry's cover. Resolves true when one was saved. */
export async function pickCover(coverId, { reloadLibrary, toast } = {}) {
  if (!coverId) return false;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = COVER_ACCEPT;
  const file = await new Promise((resolve) => {
    input.onchange = () => resolve(input.files[0] || null);
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
  if (!file) return false;
  const fail = (text) => toast?.({ kind: 'death', title: t('lib.coverFailed', 'Couldn’t use this picture'), text });
  if (file.size > COVER_MAX) {
    fail(serverErrorText({ code: 'coverTooLarge' }));
    return false;
  }
  try {
    const res = await fetch(`/api/library/cover?id=${encodeURIComponent(coverId)}`, {
      method: 'PUT', headers: { 'x-soullink': '1', 'content-type': file.type || 'application/octet-stream' }, body: file,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(serverErrorText(data, res.status));
    }
  } catch (e) {
    fail(e.message);
    return false;
  }
  await reloadLibrary?.();
  toast?.({ kind: 'ok', title: t('lib.coverSaved', 'Picture saved'), text: t('lib.coverSavedText', 'Your cartridge now wears it.') });
  return true;
}

async function removeCover(coverId, { reloadLibrary, toast } = {}) {
  try {
    await api.del(`/api/library/cover?id=${encodeURIComponent(coverId)}`);
  } catch (e) {
    toast?.({ kind: 'death', title: t('lib.coverRemoveFailed', 'Couldn’t remove the picture'), text: e.message });
  }
  await reloadLibrary?.();
}

/**
 * The body is shaped like the real module of the system (Game Boy cartridge, GBA cartridge, DS card). The label has
 * a fixed shape per system (square, DS card a little wider) and the cover fills it – so the cartridge looks the same
 * whatever picture is on it. `onPickCover`: a cart without a (working) cover offers to choose one of your own.
 */
export function Cart({ title, sub, cover, color, missing, hack, system, owned, onClick, big, onPickCover, onCoverError }) {
  const [brokenSrc, setBrokenSrc] = useState(null);
  const broken = !!cover && brokenSrc === cover; // a new picture (own cover picked) gets a fresh try
  const kind = CART_KIND[system] || 'gb';
  const cart = html`<button class=${`cart cart-${kind} ${missing ? 'missing' : ''} ${hack ? 'hack' : ''} ${big ? 'big' : ''}`} onClick=${onClick}>
    <div class="cart-slot"><div class="cart-body" style=${`--cc:${color || '#4a4954'}`}>
      <span class="cart-grip" aria-hidden="true"></span>
      ${owned && html`<span class="owned-dot"><span class="led green on"></span></span>`}
      <div class="cart-label">
        ${cover && !broken ? html`<img class="pixel" src=${cover} alt="" loading="lazy" onError=${() => { setBrokenSrc(cover); onCoverError?.(cover); }} />` : html`<span class="fallback">${title}</span>`}
      </div>
      <div class="cart-foot"><div class="badge-row">${system && html`<span class="sys">${SYS[system] || system}</span>`}${hack && html`<span class="sys">${t('lib.hackBadge', 'HACK')}</span>`}</div>
        ${kind === 'gb' && html`<span class="cart-arrow" aria-hidden="true"></span>`}</div>
    </div></div>
    ${!big && html`<div><div class="cart-title">${title}</div>${sub && html`<div class="cart-sub">${sub}</div>`}</div>`}
  </button>`;
  if (!onPickCover || big || (cover && !broken)) return cart;
  // a second button next to the cart (a button can't hold another one)
  return html`<div class="cart-cell">${cart}
    <button class="btn small ghost cart-pick" onClick=${onPickCover} title=${t('lib.coverPickHint', 'PNG, JPEG or WebP, up to 4 MB')}>
      <${Icon} name="camera" size=${14} />${t('lib.coverPick', 'Choose your own picture')}</button>
  </div>`;
}

/** Under the big cart in a detail view: choose, replace or remove the entry's own picture. */
function CoverActions({ coverId, own, offer }) {
  const app = useApp();
  if (!coverId || (!own && !offer)) return null;
  return html`<div class="cover-actions">
    <button class="btn small" onClick=${() => pickCover(coverId, app)} title=${t('lib.coverPickHint', 'PNG, JPEG or WebP, up to 4 MB')}>
      <${Icon} name="camera" size=${14} />${own ? t('lib.coverReplace', 'Replace picture') : t('lib.coverPick', 'Choose your own picture')}</button>
    ${own && html`<button class="btn small ghost" onClick=${() => removeCover(coverId, app)}><${Icon} name="close" size=${14} />${t('lib.coverRemove', 'Remove picture')}</button>`}
  </div>`;
}

/** "New SoulLink" and its solo sibling "New Nuzlocke" for a game or ROM hack. */
function NewRunButtons({ gameId, hackId, close }) {
  const { navigate } = useApp();
  const go = (view) => {
    close?.();
    navigate(view, hackId ? { new: gameId, hack: hackId } : { new: gameId });
  };
  return html`<div class="row lib-new">
    <button class="btn go" onClick=${() => go('soullink')}><${Icon} name="link" size=${16} />${t('lib.newSoulLink', 'New SoulLink')}</button>
    <button class="btn nuz" onClick=${() => go('nuzlocke')}><${Icon} name="ball" size=${16} />${t('lib.newNuzlocke', 'New Nuzlocke')}</button>
  </div>`;
}

export function LibraryView() {
  const { library, reloadLibrary, toast, navigate, status } = useApp();
  const [filter, setFilter] = useState('all');
  const [discover, setDiscover] = useState(false);
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null); // { kind: 'game'|'hack'|'rom', id }
  const cat = catalog();
  const roms = library?.roms || [];
  const patches = library?.patches || [];
  // Regional variants (German, European) count as owning the main entry.
  const rootOf = (id) => cat.games.find((g) => g.id === id)?.variantOf || id;
  const ownedBy = useMemo(() => {
    const m = new Map();
    // a pre-patched ROM hack (recognised by its checksum, r.hackId) belongs to its hack, not to the base game: it must
    // not make the base game "owned", nor become the "continue playing" game under the base game's name
    for (const r of roms) if (r.gameId && !r.hackId && !m.has(rootOf(r.gameId))) m.set(rootOf(r.gameId), r);
    return m;
  }, [library]);
  const unknownRoms = roms.filter((r) => !r.gameId);

  const games = (cat.games || []).filter((g) => {
    if (g.variantOf) return false;
    if (filter === 'hacks') return false;
    if (filter !== 'all' && g.system !== filter) return false;
    if (mine && !ownedBy.has(g.id)) return false;
    if (q && !gameTitle(g).toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }).sort((a, b) => (ownedBy.has(b.id) - ownedBy.has(a.id)) || (a.generation - b.generation) || (a.releaseYear || 0) - (b.releaseYear || 0));
  const hacks = (cat.hacks || []).filter((h) => (filter === 'all' || filter === 'hacks' || h.system === filter)
    && (!q || h.name.toLowerCase().includes(q.toLowerCase()))
    && (!mine || patches.some((p) => p.hackId === h.id) || roms.some((r) => r.hackId === h.id)));

  // ROMs the catalog doesn't know (hacks, other regions) – shown with the matching system filter or search.
  const shownUnknown = filter === 'hacks' ? [] : unknownRoms.filter((r) => (filter === 'all' || r.system === filter)
    && (!q || `${r.title || ''} ${r.name}`.toLowerCase().includes(q.toLowerCase())));

  const lastGame = status?.config?.lastGame && ownedBy.has(status.config.lastGame) ? status.config.lastGame : [...ownedBy.keys()][0];
  const featured = lastGame ? cat.games.find((g) => g.id === lastGame) : null;

  return html`<div>
    <div class="topbar"><h1>${t('lib.title', 'Library')}</h1>
      <button class="btn go" onClick=${() => setDiscover(true)}><${Icon} name="search" size=${16} />${discoverLabel()}</button>
      <button class="btn" onClick=${() => addGamesFlow({ reloadLibrary, toast })}><${Icon} name="plus" size=${16} />${t('lib.addFiles', 'Add files')}</button>
      ${window.sls && html`<button class="btn ghost" onClick=${() => api.post('/api/library/reveal', {})}><${Icon} name="folder" size=${16} />${t('lib.reveal', 'Show folder')}</button>`}
    </div>
    ${discover && html`<${DiscoverModal} onClose=${() => setDiscover(false)} />`}
    <${FirstSteps} />

    ${featured && html`<section class="hero" style=${`--cc:${featured.color || '#3a3946'}`}>
      <${Cart} big title=${gameTitle(featured)} cover=${coverOf(library, { gameId: featured.id })} color=${featured.color} system=${featured.system} owned />
      <div class="stack">
        <span class="small muted">${t('lib.continue', 'Pick up where you left off')}</span>
        <h1>${gameTitle(featured)}</h1>
        <div class="row">
          <button class="btn primary big" onClick=${() => navigate('play', { rom: ownedBy.get(featured.id).id })}><${Icon} name="play" size=${16} />${t('lib.play', 'Play')}</button>
          <button class="btn big" onClick=${() => navigate('soullink', { new: featured.id })}><${Icon} name="link" size=${16} />${t('lib.newSoulLink', 'New SoulLink')}</button>
          <button class="btn big" onClick=${() => navigate('nuzlocke', { new: featured.id })}><${Icon} name="ball" size=${16} />${t('lib.newNuzlocke', 'New Nuzlocke')}</button>
          <button class="btn ghost" onClick=${() => setOpen({ kind: 'game', id: featured.id })}>${t('lib.details', 'Details')}</button>
        </div>
      </div>
    </section>`}

    ${roms.length === 0 && html`<div class="stack" style="margin-bottom:26px"><${DropZone} onAdded=${reloadLibrary} /></div>`}

    <div class="lib-head">
      <div class="seg" role="tablist" aria-label=${t('lib.filterSystem', 'Filter by system')}>
        ${[['all', t('lib.all', 'All')], ['gb', 'Game Boy'], ['gbc', 'Game Boy Color'], ['gba', 'GBA'], ['nds', 'DS'], ['3ds', '3DS'], ['hacks', t('lib.hacks', 'ROM hacks')]]
          .map(([k, l]) => html`<button role="tab" aria-selected=${filter === k} class=${filter === k ? 'on' : ''} onClick=${() => setFilter(k)}>${l}</button>`)}
      </div>
      <label class="check"><input type="checkbox" checked=${mine} onChange=${(e) => setMine(e.target.checked)} /><span>${t('lib.onlyMine', 'Only my games')}</span></label>
      <span class="spacer"></span>
      <input type="search" placeholder=${t('lib.search', 'Search')} aria-label=${t('lib.searchLabel', 'Search games and ROM hacks')} value=${q} onInput=${(e) => setQ(e.target.value)} />
    </div>

    ${games.length + shownUnknown.length > 0 && html`<div class="shelf">
      ${games.map((g) => html`<${Cart} key=${g.id} title=${gameTitle(g)} sub=${`${g.releaseYear || ''} · ${t('lib.gen', 'Gen {n}', { n: g.generation })}`}
        cover=${coverOf(library, { gameId: g.id })} color=${g.color} system=${g.system} owned=${ownedBy.has(g.id)} missing=${!ownedBy.has(g.id)}
        onClick=${() => setOpen({ kind: 'game', id: g.id })} onPickCover=${() => pickCover(coverIdOf({ gameId: g.id }), { reloadLibrary, toast })} />`)}
      ${shownUnknown.map((r) => html`<${Cart} key=${r.id} title=${r.title || r.name} sub=${r.name} system=${r.system} owned cover=${coverOf(library, { rom: r })}
        onClick=${() => setOpen({ kind: 'rom', id: r.id })} onPickCover=${() => pickCover(coverIdOf({ rom: r }), { reloadLibrary, toast })} />`)}
    </div>`}

    ${games.length + shownUnknown.length + hacks.length === 0 && html`<div class="panel empty-state lib-empty">
      <h2>${t('lib.noMatch', 'No games match')}</h2>
      <p class="muted">${mine && !q && filter === 'all' ? t('lib.noMatchMine', 'Your library is empty so far.') : t('lib.noMatchText', 'Try another system or search term.')}</p>
      <button class="btn" onClick=${() => { setFilter('all'); setMine(false); setQ(''); }}>${t('lib.clearFilter', 'Clear filters')}</button>
    </div>`}

    ${hacks.length > 0 && html`<div class="stack" style="margin-top:34px">
      <h2>${t('lib.popularHacks', 'Popular ROM hacks')}</h2>
      <p class="small muted">${t('lib.hacksHint2', 'Fan-made versions. If you have a patch file for one, add it here and souldew applies it to your own ROM.')}</p>
      <div class="shelf">
        ${hacks.map((h) => {
          const base = cat.games.find((g) => g.id === h.baseGameId);
          const hasPatch = patches.some((p) => p.hackId === h.id) || roms.some((r) => r.hackId === h.id); // (or the patched ROM)
          return html`<${Cart} key=${h.id} hack title=${h.name} sub=${base ? t('lib.basedOn', 'based on {game}', { game: gameTitle(base) }) : h.author}
            cover=${coverOf(library, { hackId: h.id })} color=${h.color || base?.color} system=${h.system} owned=${hasPatch} missing=${!hasPatch}
            onClick=${() => setOpen({ kind: 'hack', id: h.id })} onPickCover=${() => pickCover(coverIdOf({ hackId: h.id }), { reloadLibrary, toast })} />`;
        })}
      </div>
    </div>`}

    ${open?.kind === 'game' && html`<${GameDetail} id=${open.id} onClose=${() => setOpen(null)} openHack=${(id) => setOpen({ kind: 'hack', id })} />`}
    ${open?.kind === 'hack' && html`<${HackDetail} id=${open.id} onClose=${() => setOpen(null)} openGame=${(id) => setOpen({ kind: 'game', id })} />`}
    ${open?.kind === 'rom' && html`<${RomDetail} id=${open.id} onClose=${() => setOpen(null)} />`}
  </div>`;
}

function PlayButtons({ romId, patchId, system, close }) {
  const { navigate, status, toast } = useApp();
  const ext = Object.entries(status?.emulators || {}).filter(([, e]) => e.systems.includes(system));
  return html`<div class="row">
    <button class="btn primary big" onClick=${() => { close(); navigate('play', { rom: romId, patch: patchId }); }}><${Icon} name="play" size=${16} />${t('lib.play', 'Play')}</button>
    ${ext.map(([id, e]) => html`<button class="btn" disabled=${!e.installed} title=${e.installed ? '' : t('lib.notInstalled', 'Install it in the settings first')}
      onClick=${async () => {
        try {
          await api.post(`/api/emulators/${id}/launch`, patchId ? { romId, patchId } : { romId });
          toast({ kind: 'ok', title: e.name, text: t('lib.launched', 'Starting …') });
        } catch (err) {
          toast({ kind: 'death', title: e.name, text: err.message });
        }
      }}><${Icon} name="external" size=${16} />${e.name}</button>`)}
  </div>`;
}

// ---- export ("save as file") ---------------------------------------------------------
// Copies of files the user already has – their own dumps, patches, the ROM patched from them and
// save files. Plain download links: Electron shows a save dialog, a browser saves to Downloads.
const libDownload = (params) => `/api/library/download?${new URLSearchParams(params)}`;
const soloSaveUrl = (id) => `/api/saves/solo/download?id=${encodeURIComponent(id)}`;

/** Does the integrated emulator have a save file for this solo game? Returns { modified } or null. */
function useSoloSave(id) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let alive = true;
    setInfo(null);
    if (id) {
      fetch(soloSaveUrl(id), { method: 'HEAD' })
        .then((r) => alive && setInfo(r.ok ? { modified: r.headers.get('last-modified') } : null))
        .catch(() => {});
    }
    return () => { alive = false; };
  }, [id]);
  return info;
}

function ExportFiles({ links }) {
  const shown = links.filter(Boolean);
  if (!shown.length) return null;
  return html`<div class="export-box">
    <div class="export-head"><${Icon} name="download" size=${16} /><b>${t('lib.exportTitle', 'Save as file')}</b></div>
    <div class="row">
      ${shown.map((l) => html`<a class="btn small" href=${l.href} download="" title=${l.title || ''} onClick=${l.onClick}>
        <${Icon} name=${l.icon || 'download'} size=${16} />${l.label}</a>`)}
    </div>
    <p class="small faint">${t('lib.exportHint', 'Saves a copy of your own files – the originals stay in your library.')}</p>
  </div>`;
}

function saveLink(id, info) {
  if (!info) return null;
  const when = info.modified ? new Date(info.modified) : null;
  return {
    href: soloSaveUrl(id), icon: 'save', label: t('lib.exportSave', 'Save game file'),
    title: when && !isNaN(when) ? t('lib.exportSaveFrom', 'Last saved {date}', { date: when.toLocaleString() }) : '',
  };
}

function GameDetail({ id, onClose, openHack }) {
  const { library, reloadLibrary, toast } = useApp();
  const cat = catalog();
  const g = cat.games.find((x) => x.id === id);
  const rom = library?.roms?.find((r) => !r.hackId && (r.gameId === id || cat.games.find((x) => x.id === r.gameId)?.variantOf === id));
  const save = useSoloSave(rom?.id);
  const [noCover, setNoCover] = useState(false); // the catalog picture didn't load → offer an own one
  if (!g) return null;
  const coverId = coverIdOf({ gameId: g.id });
  const hacks = (cat.hacks || []).filter((h) => h.baseGameId === id);
  return html`<${Modal} open=${true} wide onClose=${onClose} title=${gameTitle(g)}>
    <div class="detail">
      <div class="cover-col">
        <${Cart} big title=${gameTitle(g)} cover=${coverOf(library, { gameId: g.id })} color=${g.color} system=${g.system} owned=${!!rom} missing=${!rom} onCoverError=${() => setNoCover(true)} />
        <${CoverActions} coverId=${coverId} own=${!!library?.customCovers?.[coverId]} offer=${noCover} />
      </div>
      <div class="stack">
        <dl class="facts">
          <dt>${t('lib.system', 'System')}</dt><dd>${SYS[g.system] ? { gb: 'Game Boy', gbc: 'Game Boy Color', gba: 'Game Boy Advance', nds: 'Nintendo DS', '3ds': 'Nintendo 3DS' }[g.system] : g.system}</dd>
          <dt>${t('lib.generation', 'Generation')}</dt><dd>${g.generation}</dd>
          ${g.releaseYear && html`<dt>${t('lib.year', 'Released')}</dt><dd>${g.releaseYear}</dd>`}
          <dt>${t('lib.randomizer', 'Randomizer')}</dt><dd>${g.uprSupported ? t('lib.yes', 'Supported') : t('lib.no', 'Not supported')}</dd>
          <dt>${t('lib.liveTracking', 'Live tracking')}</dt><dd>${liveSupportText(g)}</dd>
          <dt>${t('lib.yourRom', 'Your ROM')}</dt><dd>${rom ? html`<span class="mono small">${rom.name}</span> ${rom.exact ? html`<span class="chip ok">${t('lib.verified', 'verified dump')}</span>` : ''}` : html`<span class="muted">${t('lib.notOwned', 'Not in your library')}</span>`}</dd>
        </dl>
        ${rom
          ? html`<${PlayButtons} romId=${rom.id} system=${g.system} close=${onClose} />
            <${NewRunButtons} gameId=${g.id} close=${onClose} />
            <${ExportFiles} links=${[
              { href: libDownload({ id: rom.id }), label: t('lib.exportRom', 'Save ROM'), title: rom.name },
              saveLink(rom.id, save),
            ]} />`
          : html`<div class="note">${t('lib.addOwn', 'Add your own dump of this game to play it.')}</div>
            <div><button class="btn" onClick=${() => addGamesFlow({ reloadLibrary, toast })}><${Icon} name="plus" size=${16} />${t('lib.addFiles', 'Add files')}</button></div>`}
      </div>
    </div>
    ${hacks.length > 0 && html`<div class="stack">
      <h3>${t('lib.hacksFor', 'ROM hacks for this game')}</h3>
      ${hacks.map((h) => {
        const has = (library?.patches || []).some((p) => p.hackId === h.id) || (library?.roms || []).some((r) => r.hackId === h.id);
        return html`<button type="button" class=${`hack-card ${has ? '' : 'missing'}`} onClick=${() => openHack(h.id)}>
        <div><b>${h.name}</b> <span class="faint small">${h.author}</span><div class="small muted">${currentLang() === 'de' ? h.descriptionDe : h.descriptionEn}</div></div>
        <div class="hack-chips"><span class=${`chip ${has ? 'ok' : ''}`}>${has ? t('lib.hackInstalled', 'installed') : t('lib.hackMissing', 'not installed')}</span><span class="chip">${difficultyLabel(h.difficulty)}</span></div>
      </button>`;
      })}
    </div>`}
  <//>`;
}

// How far souldew reads a ROM hack live (catalog `live`, docs/TESTED_GAMES.md) and what to know about it (`liveNote`).
const liveLabel = (v) => ({
  yes: t('lib.liveYes', 'Read live'),
  partial: t('lib.livePartial', 'Read live, with limits'),
  untested: t('lib.liveUntested', 'Not checked yet'),
  no: t('lib.liveNo', 'Not supported – enter catches by hand'),
}[v] || '–');
const liveNote = (k) => ({
  rnb: t('lib.liveNote.rnb', 'Team, place, battles and catches are read live. The Rare Candy cheat is off and held items aren’t named – the hack numbers its items its own way.'),
  types: t('lib.liveNote.types', 'Team, place, battles and catches are read live. souldew doesn’t know the hack’s own types: it shows no types, matchups or type rule for its Pokémon rather than the official ones. The Rare Candy cheat is off.'),
}[k] || '');

function HackDetail({ id, onClose, openGame }) {
  const { library, reloadLibrary, toast } = useApp();
  const cat = catalog();
  const h = cat.hacks.find((x) => x.id === id);
  const patch = library?.patches?.find((p) => p.hackId === id);
  // a ROM that was patched before it was added (its CRC32 is a known version of the hack): played as it is
  const ready = !patch ? library?.roms?.find((r) => r.hackId === id) : null;
  const baseRom = patch?.baseRomId ? library.roms.find((r) => r.id === patch.baseRomId) : library?.roms?.find((r) => !r.hackId && r.gameId === h?.baseGameId);
  // Only offer the patched game when the base ROM is the one the patch expects (otherwise patching fails).
  const canPatch = !!(patch && baseRom && (!patch.expectedCrc || baseRom.crc === patch.expectedCrc));
  const save = useSoloSave(canPatch ? `${baseRom.id}|${patch.id}` : null);
  if (!h) return null;
  const base = cat.games.find((g) => g.id === h.baseGameId);
  return html`<${Modal} open=${true} wide onClose=${onClose} title=${h.name}>
    <div class="detail">
      <div class="cover-col">
        <${Cart} big hack title=${h.name} cover=${coverOf(library, { hackId: h.id })} color=${h.color || base?.color} system=${h.system} owned=${!!(patch || ready)} missing=${!(patch || ready)} />
        <${CoverActions} coverId=${coverIdOf({ hackId: h.id })} own=${!!library?.customCovers?.[coverIdOf({ hackId: h.id })]} offer />
      </div>
      <div class="stack">
        <p>${currentLang() === 'de' ? h.descriptionDe : h.descriptionEn}</p>
        <div class="row">${(h.features || []).map((f) => html`<span class="chip">${f}</span>`)}</div>
        <dl class="facts">
          <dt>${t('lib.author', 'Author')}</dt><dd>${h.author}</dd>
          <dt>${t('lib.baseGame', 'Base game')}</dt><dd>${base ? html`<a href="#" onClick=${(e) => { e.preventDefault(); openGame(base.id); }}>${gameTitle(base)}</a>` : '–'}${h.baseCrc32 ? html` <span class="faint mono small">CRC32 ${h.baseCrc32}</span>` : ''}</dd>
          <dt>${t('lib.difficulty', 'Difficulty')}</dt><dd>${difficultyLabel(h.difficulty)}${h.nuzlockeFriendly ? ` · ${t('lib.nuzlocke', 'Nuzlocke-friendly')}` : ''}</dd>
          <dt>${t('lib.randomizer', 'Randomizer')}</dt><dd>${{ yes: t('lib.yes', 'Supported'), no: t('lib.no', 'Not supported'), unknown: t('lib.unknown', 'Unknown') }[h.uprCompatible] || '–'}</dd>
          ${h.live && html`<dt>${t('lib.live', 'Live tracking')}</dt><dd>${liveLabel(h.live)}${h.liveNote && html`<div class="small muted">${liveNote(h.liveNote)}</div>`}</dd>`}
          ${ready ? html`<dt>${t('lib.patchedRom', 'Your ROM')}</dt><dd><span class="mono small">${ready.name}</span><div class="small muted">${t('lib.patchedRomHint', 'Already patched – recognised by its checksum.')}</div></dd>` : html`
          <dt>${t('lib.patch', 'Patch')}</dt><dd>${patch ? html`<span class="mono small">${patch.name}</span>` : html`<span class="muted">${t('lib.noPatch', 'Not added yet')}</span>`}</dd>
          <dt>${t('lib.baseRom', 'Your base ROM')}</dt><dd>${baseRom ? html`<span class="mono small">${baseRom.name}</span>` : html`<span class="muted">${t('lib.notOwned', 'Not in your library')}</span>`}</dd>`}
        </dl>
        ${ready && html`<div class="row">
          <${PlayButtons} romId=${ready.id} system=${h.system} close=${onClose} />
        </div>
        <${NewRunButtons} gameId=${h.baseGameId} hackId=${h.id} close=${onClose} />`}
        ${!patch && !ready && html`<div class="row">
          <button class="btn ghost" onClick=${() => addGamesFlow({ reloadLibrary, toast })}><${Icon} name="plus" size=${16} />${t('lib.addPatch', 'Add patch file')}</button>
        </div>`}
        ${patch && baseRom && html`<div class="row">
          <${PlayButtons} romId=${baseRom.id} patchId=${patch.id} system=${h.system} close=${onClose} />
        </div>
        <${NewRunButtons} gameId=${h.baseGameId} hackId=${h.id} close=${onClose} />`}
        ${patch && html`<${ExportFiles} links=${[
          canPatch && {
            href: libDownload({ romId: baseRom.id, patchId: patch.id }), label: t('lib.exportPatched', 'Save patched game'),
            title: t('lib.exportPatchedHint', '{hack}, built from your {rom}', { hack: h.name, rom: baseRom.name }),
            onClick: () => toast({ kind: 'ok', title: h.name, text: t('lib.exportPreparing', 'Preparing the file – this can take a few seconds.') }),
          },
          { href: libDownload({ patchId: patch.id }), label: t('lib.exportPatch', 'Save patch'), title: patch.name },
          canPatch && saveLink(`${baseRom.id}|${patch.id}`, save),
        ]} />`}
      </div>
    </div>
  <//>`;
}

function RomDetail({ id, onClose }) {
  const { library } = useApp();
  const r = library?.roms?.find((x) => x.id === id);
  const save = useSoloSave(r?.id);
  if (!r) return null;
  return html`<${Modal} open=${true} wide onClose=${onClose} title=${r.title || r.name}>
    <div class="detail">
      <div class="cover-col">
        <${Cart} big title=${r.title || r.name} cover=${coverOf(library, { rom: r })} system=${r.system} owned />
        <${CoverActions} coverId=${coverIdOf({ rom: r })} own=${!!r.customCover} offer />
      </div>
      <div class="stack">
        <dl class="facts">
          <dt>${t('lib.file', 'File')}</dt><dd class="mono small">${r.name}</dd>
          <dt>${t('lib.system', 'System')}</dt><dd>${SYS[r.system] || r.system}</dd>
          <dt>${t('lib.code', 'Game code')}</dt><dd class="mono">${r.code || '–'}</dd>
          ${r.system === '3ds'
            ? html`<dt>${t('lib.titleId', 'Title ID')}</dt><dd class="mono">${r.titleId || '–'}</dd>`
            : html`<dt>CRC32</dt><dd class="mono">${r.crc}</dd>`}
        </dl>
        <p class="small muted">${t('lib.unknownRom', 'This ROM is not in the catalog (maybe a hack or another region). You can still play it.')}</p>
        <${PlayButtons} romId=${r.id} system=${r.system} close=${onClose} />
        <${ExportFiles} links=${[
          { href: libDownload({ id: r.id }), label: t('lib.exportRom', 'Save ROM'), title: r.name },
          saveLink(r.id, save),
        ]} />
      </div>
    </div>
  <//>`;
}

export function liveSupportText(g) {
  const map = {
    1: t('lib.liveGen12', 'Party, levels and HP live'),
    2: t('lib.liveGen12', 'Party, levels and HP live'),
    3: t('lib.liveGen3', 'Party live incl. catch location'),
    4: t('lib.liveGen45', 'Party + PC boxes live incl. catch location'),
    5: t('lib.liveGen45', 'Party + PC boxes live incl. catch location'),
    // 3DS: through Azahar's RPC server – the party (no PC boxes, no place sign or battle panel yet)
    6: t('lib.liveGen67', 'Party live incl. catch location (in Azahar)'),
    7: t('lib.liveGen67', 'Party live incl. catch location (in Azahar)'),
  };
  return map[g.generation] || '–';
}

function difficultyLabel(d) {
  return { casual: t('lib.casual', 'Casual'), hard: t('lib.hard', 'Hard'), kaizo: t('lib.kaizo', 'Kaizo') }[d] || d || '–';
}
