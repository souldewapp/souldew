import { html, render, useState, useEffect, useRef, useCallback, useMemo, useErrorBoundary } from '/vendor/htm-preact.mjs';
import { api, events } from './lib/api.mjs';
import { RunDoc } from './lib/doc.mjs';
import { loadData, RunData, speciesName } from './lib/data.mjs';
import { SyncLink, PARTNER_TTL } from './lib/sync.mjs';
import { setLang, guessLang, t, onLangChange } from './lib/i18n.mjs';
import { applyTheme, applyStoredTheme } from './lib/theme.mjs';
import { detectLayout } from './lib/controls.mjs';
import { applySnapshot, snapshotFromSave, players as getPlayers, areaName, feedText, othersOf, slotsOf, runMode, checks, loadLocationTables, genOfRun, wipedSlot, failRun } from './lib/run.mjs';
import { play } from './lib/sound.mjs';
import { Ctx, Toasts, Led, Modal, openExternal } from './lib/ui.mjs';
import { LINKS } from './lib/links.mjs';
import { groupArrowKeys } from './lib/a11y.mjs';
import { AppMark, NavIcon, Icon } from './lib/icons.mjs';
import { BootScreen } from './views/boot.mjs';
import { Onboarding } from './views/onboarding.mjs';
import { LibraryView } from './views/library.mjs';
import { SoulLinkView, NuzlockeView } from './views/soullink.mjs';
import { PlayView, GameSession } from './views/play.mjs';
import { unsavedProgress, unsavedTexts } from './views/savestates.mjs';
import { LinkView } from './views/link.mjs';
import { SettingsView, gpuFallbackText } from './views/settings.mjs';
import { GuideView } from './views/guide.mjs';
import { StreamView } from './views/stream.mjs';
import { useStreamer } from './lib/streamer.mjs';
import { UpdateBanner } from './views/update.mjs';
import { DeathAlert } from './views/session-info.mjs';
import { RestartOffer, RunOverNotice } from './views/restart.mjs';
import { FirstStepsPill } from './views/firststeps.mjs';
import { useCoffeeFx, CoffeeFx } from './views/coffee.mjs';
import { mySlotIn } from './lib/restart.mjs';
import { IS_MAC, IS_WIN, shortcut } from './lib/platform.mjs';

applyStoredTheme(); // before the first render: no flash of the wrong colours

const pref = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // private mode
    }
  },
};

/** The desktop menu bar in the UI language (electron/main.mjs builds it from these). */
function sendMenuLabels() {
  window.sls?.setMenuLabels?.({
    settings: t('menu.settings', 'Settings …'), file: t('menu.file', 'File'), addGames: t('menu.addGames', 'Add games …'),
    revealLibrary: IS_MAC ? t('menu.revealLibrary', 'Show library folder in Finder') : IS_WIN ? t('menu.revealLibraryWin', 'Show library folder in Explorer')
      : t('menu.revealLibraryLinux', 'Show library folder in the file manager'),
    go: t('menu.go', 'Go'), quit: t('menu.quit', 'Quit'),
    library: t('nav.library', 'Library'), soullink: t('nav.soullink', 'SoulLink'), nuzlocke: t('nav.nuzlocke', 'Nuzlocke'), link: t('nav.link', 'Connection'), stream: t('nav.stream', 'Stream'),
    emulator: t('menu.emulator', 'Emulator'), pause: t('keys.pause', 'Pause / resume'), turbo: t('menu.turbo', 'Toggle turbo'),
    faster: t('menu.faster', 'Faster'), slower: t('menu.slower', 'Slower'), quicksave: t('menu.quicksave', 'Quick save'), quickload: t('menu.quickload', 'Quick load'),
    screenshot: t('keys.screenshot', 'Screenshot'), mute: t('keys.mute', 'Sound on/off'), fullscreen: t('menu.fullscreen', 'Fullscreen'),
    shortcuts: t('menu.shortcuts', 'Keyboard shortcuts'), guide: t('menu.guide', 'Guide'),
  });
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [route, query = ''] = raw.split('?');
  return { route: route || 'library', params: Object.fromEntries(new URLSearchParams(query)) };
}

function useRoute() {
  const [r, setR] = useState(parseHash());
  useEffect(() => {
    const on = () => setR(parseHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const navigate = useCallback((route, params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== false)).toString(); // '' is kept: `new=` means "pick a game"
    location.hash = `#/${route}${q ? `?${q}` : ''}`;
  }, []);
  return [r, navigate];
}

function Boundary({ children, route }) {
  const [error, reset] = useErrorBoundary((e) => console.error(e));
  useEffect(() => reset(), [route]);
  if (error) {
    return html`<div class="panel stack"><h2>${t('err.view', 'This screen crashed')}</h2><p class="small code">${String(error.message || error)}</p>
      <div><button class="btn" onClick=${reset}>${t('err.retry', 'Try again')}</button></div></div>`;
  }
  return children;
}

const NO_INBOX = { inbox: [], alerts: [] };

/** Hover light of the rail: the pointer's spot inside the item, for the radial gradient (styles.css .nav a::before). */
function navLight(e) {
  const a = e.target.closest?.('.nav a');
  if (!a) return;
  const r = a.getBoundingClientRect();
  a.style.setProperty('--mx', `${Math.round(e.clientX - r.left)}px`);
  a.style.setProperty('--my', `${Math.round(e.clientY - r.top)}px`);
}

/** "Buy me a coffee" – always at the bottom left: in the rail, or as a small button while the rail is folded. */
function CoffeeLink({ float = false, fx = null, onOpen }) {
  const label = t('rail.coffee', 'Buy me a coffee');
  const hint = t('rail.coffeeHint', 'Support souldew on Buy Me a Coffee');
  return html`<a class=${`coffee no-drag ${float ? 'coffee-float' : ''} ${fx ? `cfx-live cfx-on-${fx.id}` : ''}`} href=${LINKS.coffee} target="_blank" rel="noopener" title=${hint} aria-label=${float ? hint : undefined}
    onClick=${(e) => { e.preventDefault(); onOpen?.(); openExternal(LINKS.coffee); }}><${Icon} name="coffee" size=${float ? 18 : 16} />${!float && html`<span>${label}</span>`}<${CoffeeFx} fx=${fx} /></a>`;
}

/** The open run at the foot of the rail: who of the others is live – or, in a solo Nuzlocke, whether you play.
 * A click opens its game (back to it while it runs) – the way into the game now that the rail has no "Play" item. */
function RailRun({ manifest, names, me, onlineSlots, linkStatus, session, navigate }) {
  const playing = session?.target.runId === manifest.id;
  const built = !!manifest.outputs?.[me];
  // not built yet (joined, game still to build): the run's page has the next step
  const open = () => (built ? navigate('play', { run: manifest.id }) : navigate(runMode(manifest), { run: manifest.id }));
  const action = playing ? t('play.backToGame', 'Back to the game') : built ? t('rail.openGame', 'Click to play') : t('rail.openRun', 'Click to open the run');
  if (runMode(manifest) === 'nuzlocke') {
    return html`<button type="button" class="power" onClick=${open} title=${`${t('rail.soloHint', 'Solo Nuzlocke – nobody to connect with')} · ${action}`}>
      <${Led} on=${playing} />
      <div class="stack-s" style="gap:0"><b>${manifest.name}</b><span class="tiny">${playing ? t('rail.soloPlaying', 'Solo Nuzlocke · playing') : t('rail.solo', 'Solo Nuzlocke')}</span></div>
    </button>`;
  }
  const others = othersOf(me, manifest);
  const live = others.filter((s) => onlineSlots.has(s));
  const list = (slots) => slots.map((s) => names[s]?.name || s.toUpperCase()).join(', ');
  const text = others.length === 1
    ? live.length ? t('rail.partnerLive', '{name} is live', { name: list(others) }) : linkStatus ? t('rail.waiting', 'Waiting for {name}', { name: list(others) }) : t('rail.offline', 'Not connected')
    : live.length === others.length ? t('rail.allLive', 'Everyone is live')
      : live.length ? t('rail.someLive', '{names} live · {n} of {all}', { names: list(live), n: live.length, all: others.length })
        : linkStatus ? t('rail.waitingGroup', 'Waiting for the others') : t('rail.offline', 'Not connected');
  return html`<button type="button" class="power" onClick=${open}
    title=${`${others.length === 1 ? t('rail.liveHintGreen', 'Green light: your partner is connected') : t('rail.liveHintGroup', 'Green light: somebody of your group is connected')} · ${action}`}>
    <${Led} on=${live.length > 0} blink=${!!linkStatus && live.length < others.length} />
    <div class="stack-s" style="gap:0"><b>${manifest.name}</b><span class="tiny">${text}</span></div>
  </button>`;
}

/**
 * Just joined with a name of our own (JoinRun): it replaces the host's placeholder for our seat. Written once as the
 * newest value, so the sync hands it to every computer.
 */
function applyJoinName(doc, manifest) {
  if (!doc || !manifest?.id) return;
  try {
    const joined = JSON.parse(localStorage.getItem(`sl-joinname-${manifest.id}`) || 'null');
    if (!joined) return;
    if (joined.name && slotsOf(manifest).includes(joined.slot)) doc.set(`player:${joined.slot}`, { ...(doc.get(`player:${joined.slot}`) || {}), name: joined.name });
    localStorage.removeItem(`sl-joinname-${manifest.id}`);
  } catch {
    // storage blocked – the host's name stays
  }
}

function App() {
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState(null);
  const [boot, setBoot] = useState(true);
  const [status, setStatus] = useState(null);
  const [library, setLibrary] = useState(null);
  const [runId, setRunIdState] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [missingRun, setMissingRun] = useState(null);
  const [doc, setDoc] = useState(null);
  const [docVersion, setDocVersion] = useState(0);
  const [runData, setRunData] = useState(() => new RunData());
  const [me, setMeState] = useState('p1');
  const [linkStatus, setLinkStatus] = useState(null);
  const [inbox, setInboxState] = useState(NO_INBOX);
  const [liveInfo, setLiveInfo] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [deathAlert, setDeathAlert] = useState(null);
  const [restartOffer, setRestartOffer] = useState(null);
  const [runOver, setRunOver] = useState(null);
  const shownDeaths = useRef(new Set());
  const [session, setSession] = useState(null); // the running game { target } – lives across all sections
  const [pendingRun, setPendingRun] = useState(null); // run switch waiting for "close the game?"
  const sessionRef = useRef(null);
  sessionRef.current = session;
  const [, setLangTick] = useState(0);
  const linkRef = useRef(null);
  const runIdRef = useRef(null);
  runIdRef.current = runId;
  const inboxKey = useRef('');
  const [route, navigate] = useRoute();
  const streamer = useStreamer();
  // the coffee button's little Pokémon moments – never while a game runs (full or in the corner), in the game's
  // fullscreen, during boot or onboarding (fxBusy is set further down, once those are known)
  const fxBusy = useRef(true);
  const coffee = useCoffeeFx(() => fxBusy.current);

  const toast = useCallback((x) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((ts) => [...ts.slice(-4), { id, ...x }]);
    setTimeout(() => setToasts((ts) => ts.filter((y) => y.id !== id)), x.ttl || (x.kind === 'death' ? 12000 : 6000));
  }, []);

  const reloadStatus = useCallback(async () => {
    const s = await api.get('/api/status').catch(() => null);
    if (s) setStatus(s);
    return s;
  }, []);
  const reloadLibrary = useCallback(async () => {
    const l = await api.get('/api/library').catch(() => null);
    if (l) setLibrary(l);
    return l;
  }, []);
  const reloadManifest = useCallback(async (id = runIdRef.current) => {
    if (!id) return null;
    const m = await api.get(`/api/runs/${id}`).catch(() => null);
    if (id === runIdRef.current) { // a late reply for a previous run must not win
      setManifest(m);
      setMissingRun(m ? null : id);
    }
    return m;
  }, []);
  // Only re-renders when the inbox content actually changed (live snapshots arrive every frame).
  const setInbox = useCallback((x) => {
    const next = { inbox: x?.inbox || [], alerts: x?.alerts || [] };
    const key = JSON.stringify(next);
    if (key === inboxKey.current) return;
    inboxKey.current = key;
    setInboxState(next);
  }, []);

  const switchRun = useCallback((id) => {
    runIdRef.current = id;
    setRunIdState(id);
    api.post('/api/config', { lastRun: id }).catch(() => {});
  }, []);
  // The running game is bound to its run: the menu never swaps the run under it – it asks first.
  const setRunId = useCallback((id) => {
    const s = sessionRef.current;
    if (s?.target.runId && id !== s.target.runId) return setPendingRun({ id });
    switchRun(id);
  }, []);
  const startSession = useCallback((target) => setSession({ target, at: Date.now() }), []);
  const endSession = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setSession(null);
  }, []);
  // Closing from the UI: asks first when there is progress since the last in-game save.
  const [pendingClose, setPendingClose] = useState(null); // { after } – close waiting for "not saved in-game"
  const closeSession = useCallback((after) => {
    if (unsavedProgress()) return setPendingClose({ after });
    endSession();
    after?.();
  }, []);
  const setMe = useCallback((slot, id = runIdRef.current) => {
    setMeState(slot);
    if (id) pref.set(`sl-me-${id}`, slot);
  }, []);

  // ---- boot ----------------------------------------------------------------------
  const bootUp = useCallback(async () => {
    setBootError(null);
    try {
      const s = await api.get('/api/status');
      setStatus(s);
      applyTheme(s.config?.theme);
      const lang = await setLang(s.config?.lang || guessLang());
      sendMenuLabels();
      await detectLayout(lang); // key names in Help / Settings › Controls
      await Promise.all([loadData(), loadLocationTables(), reloadLibrary()]);
      const id = s.config?.lastRun && s.runs?.some((r) => r.id === s.config.lastRun) ? s.config.lastRun : s.runs?.[0]?.id || null;
      runIdRef.current = id;
      setRunIdState(id);
      if (s.config?.bootAnimation === false) setBoot(false);
      setReady(true);
    } catch (e) {
      console.error('boot failed', e);
      setBootError(e.message || String(e));
    }
  }, []);
  useEffect(() => {
    bootUp();
    return onLangChange((l) => { detectLayout(l); sendMenuLabels(); setLangTick((x) => x + 1); });
  }, []);

  // ---- active run ----------------------------------------------------------------
  // a name typed when joining can arrive after the run's doc is open (the build finishes later): apply it then too
  useEffect(() => applyJoinName(doc, manifest), [doc, manifest]);
  useEffect(() => {
    // Drop everything of the previous run before loading the next one.
    setDoc(null);
    setManifest(null);
    setMissingRun(null);
    setInbox(NO_INBOX);
    setDeathAlert(null); // it names an area of the previous run
    setRunOver(null);
    linkRef.current?.stop();
    linkRef.current = null;
    setLinkStatus(null);
    if (!runId) return;
    let cancelled = false;
    let unsub = null;
    (async () => {
      const m = await reloadManifest(runId);
      if (!m || cancelled) return;
      const d = await new RunDoc(runId).load();
      const rd = await new RunData().load(m);
      if (cancelled) return;
      // (an invite imported without a stored choice: the first player after the host, as before)
      // (a stored slot the run doesn't have – fewer players after a rebuild – would break every name lookup)
      setMeState(mySlotIn(m));
      for (const s of slotsOf(m)) if (!d.get(`player:${s}`) && m.players?.[s]) d.set(`player:${s}`, m.players[s]);
      applyJoinName(d, m);
      if (!d.get('rules') && m.rules) d.set('rules', m.rules);
      // Older versions kept the Discord webhook in the shared rules: hand it to the server once (it moves it into
      // this computer's config) and drop it from the doc, so it no longer syncs to the partner.
      const legacy = d.get('rules');
      if (legacy && typeof legacy === 'object' && 'discordWebhook' in legacy) {
        const clean = { ...legacy };
        delete clean.discordWebhook;
        api.post(`/api/runs/${runId}/meta`, { rules: legacy }).catch(() => {});
        d.set('rules', clean);
      }
      unsub = d.subscribe(() => setDocVersion((v) => v + 1));
      setDoc(d);
      setRunData(rd);
      setDocVersion((v) => v + 1);
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [runId]);

  // doc and manifest are loaded separately – only use them together once they belong to the same run.
  const runDoc = doc && manifest && doc.runId === manifest.id ? doc : null;
  // Sounds are a per-computer preference (Settings), not a shared run rule.
  const soundOn = useRef(true);
  soundOn.current = status?.config?.sounds !== false;
  const sfx = useCallback((name) => play(name, soundOn.current), []);

  // souldew put the graphics backend back to "Automatic" (electron/main.mjs): say so once, then forget the notice.
  // (Once the app language is loaded and the start-up animation is over.)
  const gpuFallback = ready && !boot ? status?.config?.gpuFallback : null;
  useEffect(() => {
    if (!gpuFallback) return;
    toast({ kind: 'warn', title: t('set.gpuFallbackTitle', 'Graphics backend reset'), text: gpuFallbackText(gpuFallback), ttl: 20000 });
    api.post('/api/config', { gpuFallback: null }).catch(() => {});
  }, [gpuFallback?.from, gpuFallback?.reason]);

  // ---- partner events → toasts & sounds --------------------------------------------
  useEffect(() => {
    if (!runDoc) return;
    const doc = runDoc;
    return doc.subscribe((keys, remote, info) => {
      const names = getPlayers(doc, manifest);
      // The partner's timestamps come from their clock, which may be minutes off: shift them by the measured offset.
      const age = (at) => Date.now() - at - (remote ? info?.offset || 0 : 0);
      for (const k of keys) {
        // The run just ended (a wipe here or at the partner's, or marked failed / won): the notice for both.
        if (k === 'run:status') {
          const st = doc.get(k);
          // (whoever just ended it by hand in the board doesn't need to be told)
          if ((st?.state === 'failed' || st?.state === 'won') && age(st.at) < 120000 && (st.auto || st.by !== me)) {
            setDeathAlert(null); // the last death is part of the notice
            setRunOver(st);
            sfx(st.state === 'won' ? 'badge' : 'death');
          } else if (!st) setRunOver(null);
          continue;
        }
        // A pair died (here or at the partner's): a big alert for both players, once per death.
        if (k.startsWith('pair:')) {
          const p = doc.get(k);
          const id = `${k}:${p?.diedAt}`;
          if (p?.state === 'dead' && p.diedAt && age(p.diedAt) < 120000 && !shownDeaths.current.has(id)) {
            shownDeaths.current.add(id);
            setDeathAlert({ area: k.slice(5), by: p.by || othersOf(me, manifest)[0] || me });
            sfx('death');
          }
        }
        if (!remote) continue;
        if (k.startsWith('feed:')) {
          const f = doc.get(k);
          // (an edit by hand: whoever made it – it may be in my slot)
          if (f && (f.type === 'edit' ? f.editor && f.editor !== me : f.slot !== me) && age(f.at) < 60000 && f.type !== 'death') {
            toast({ kind: 'soul', title: names[f.editor || f.slot]?.name || t('common.partner', 'Partner'), text: feedText(doc, manifest, f) });
            if (f.type === 'catch') sfx('catch');
            if (f.type === 'badge') sfx('badge');
          }
        }
      }
    });
  }, [runDoc, me, manifest]);

  // The partner started this run over: offer to join the new one (now, or whenever this run is opened next).
  useEffect(() => {
    if (!runDoc) return undefined;
    const check = () => {
      const r = runDoc.get('run:restart');
      if (!r?.id || !r.pack || r.by === me) return;
      if ((status?.runs || []).some((x) => x.id === r.id)) return; // already joined
      try {
        if (sessionStorage.getItem(`sl-restart-seen-${r.id}`)) return;
      } catch {
        // storage blocked – ask again next time
      }
      setRestartOffer(r);
    };
    check();
    return runDoc.subscribe((keys) => keys.includes('run:restart') && check());
  }, [runDoc, me, status?.runs?.length]);

  // ---- snapshots (live RAM / save files / external bridge) ---------------------------
  // battle: what the live loop sees on the other side right now – a death in it gets its cause (opponent, level).
  const applySnap = useCallback((snap, { notify = true, battle = null } = {}) => {
    if (!runDoc) return null;
    const doc = runDoc;
    // An ended run stays as it ended: playing on (for fun, or after a wipe) records nothing anymore.
    if (doc.get('run:status')) return null;
    const res = applySnapshot(doc, manifest, genOfRun(manifest, runData), me, snap, { rd: runData, battle });
    setInbox(res);
    // the last of my Pokémon fell → the run is over (every player gets the big notice via the doc). A solo
    // Nuzlocke goes by its blackout rule instead (with the manifest, wipedSlot asks it; applySnapshot already
    // ended the run on a blackout or a deathless death – failRun then does nothing).
    if (wipedSlot(doc, [me], manifest)) failRun(doc, manifest, me, runMode(manifest) === 'nuzlocke' ? 'blackout' : undefined);
    if (notify && res.newCatches.length) sfx('catch');
    // deaths: the doc subscription above shows the big alert (for both players)
    // The server posts to this computer's webhook for the run, if one is set (none → it does nothing).
    if (notify && (res.newCatches.length || res.deaths.length)) {
      const n = getPlayers(doc, manifest)[me].name;
      const lines = [...res.newCatches.map((a) => `🎯 **${n}** – ${areaName(doc, manifest, a)}: ${speciesName(doc.get(`enc:${a}:${me}`)?.species)}`),
        ...res.deaths.map((a) => `💀 **${n}** – ${areaName(doc, manifest, a)}`)];
      api.post('/api/notify/discord', { runId: manifest.id, content: lines.join('\n') }).catch(() => {});
    }
    return res;
  }, [runDoc, manifest, runData, me]);

  // One EventSource per run; handlers read the latest applySnap through a ref.
  const applySnapRef = useRef(applySnap);
  applySnapRef.current = applySnap;
  useEffect(() => events({
    save: (p) => p.runId === runId && applySnapRef.current(snapshotFromSave(p.save)),
    live: (frame) => setLiveInfo({ ...frame, at: Date.now() }),
    'live-status': (s) => setLiveInfo((x) => ({ ...(x || {}), status: s })),
    'save-error': (p) => p.runId === runId && toast({ kind: 'death', title: t('toast.saveError', 'Save file unreadable'), text: p.error }),
  }), [runId]);

  // ---- live link -----------------------------------------------------------------
  const connect = useCallback(async () => {
    if (!runDoc) return;
    const doc = runDoc;
    linkRef.current?.stop();
    const names = getPlayers(doc, manifest);
    const link = new SyncLink({
      room: manifest.room, secret: manifest.secret, slot: me, slots: slotsOf(manifest), name: names[me].name, doc,
      onStatus: (s) => linkRef.current === link && setLinkStatus({ ...s }),
      onMessage: (msg) => {
        if (msg.payload?.type === 'ping') {
          toast({ kind: 'soul', title: t('toast.ping', '{name} pings you', { name: names[msg.from]?.name || t('common.partner', 'Partner') }), text: msg.payload.text || '' });
          sfx('ping');
        }
      },
    });
    linkRef.current = link;
    await link.start();
    if (linkRef.current === link) pref.set(`sl-autolink-${manifest.id}`, true);
  }, [runDoc, manifest, me]);
  const disconnect = useCallback(() => {
    linkRef.current?.stop();
    linkRef.current = null;
    setLinkStatus(null);
    if (manifest) pref.set(`sl-autolink-${manifest.id}`, false);
  }, [manifest]);
  useEffect(() => {
    // A solo Nuzlocke has nobody to sync with – no relay traffic unless connected by hand (Connection page).
    if (runDoc && runMode(manifest) !== 'nuzlocke' && pref.get(`sl-autolink-${manifest.id}`, true)) connect();
    return () => {
      linkRef.current?.stop();
      linkRef.current = null;
      setLinkStatus(null);
    };
  }, [runDoc, manifest?.id, me]);
  // Leaving the page (reload, navigating away, closing the window): stop() says "offline" right away and sends
  // what is queued – otherwise the partner keeps seeing us live from the retained presence until it ages out.
  // A page restored from the back/forward cache connects again.
  const connectRef = useRef(connect);
  connectRef.current = connect;
  useEffect(() => {
    const hide = () => linkRef.current?.stop();
    const show = (e) => {
      const id = runIdRef.current;
      if (e.persisted && id && pref.get(`sl-autolink-${id}`, true)) connectRef.current();
    };
    addEventListener('pagehide', hide);
    addEventListener('pageshow', show);
    return () => {
      removeEventListener('pagehide', hide);
      removeEventListener('pageshow', show);
    };
  }, []);

  // ---- native menu ----------------------------------------------------------------
  useEffect(() => {
    if (!window.sls?.on) return;
    const offs = [
      window.sls.on('navigate', (r) => navigate(r)),
      window.sls.on('menu', async (what) => {
        if (what === 'add-games') {
          const { addGamesFlow } = await import('./views/library.mjs');
          addGamesFlow({ reloadLibrary, toast });
        }
        if (what === 'reveal-library') api.post('/api/library/reveal', {});
        if (what === 'shortcuts') navigate('guide', { tab: 'keys' });
      }),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  // Who of the other players is online right now (heard from within PARTNER_TTL, or a direct link is up);
  // partnerOnline: anybody at all (the two-player call sites).
  const others = manifest ? othersOf(me, manifest) : [];
  const onlineSlots = new Set(Object.entries(linkStatus?.partners || {})
    .filter(([s, p]) => others.includes(s) && (p.p2p || Date.now() - p.seen < PARTNER_TTL)).map(([s]) => s));
  const partnerOnline = onlineSlots.size > 0
    || !!(linkStatus?.partner && linkStatus.partnerSeen && Date.now() - linkStatus.partnerSeen < PARTNER_TTL);
  // checks() walks both teams and the rules – only again when the doc (docVersion) or the run changed, not on every
  // render (toasts, live frames from an external emulator …)
  const checkCount = useMemo(() => (runDoc ? checks(runDoc, manifest, runData).length : 0), [runDoc, docVersion, manifest, runData]);
  const warnCount = runDoc ? checkCount + inbox.inbox.length + inbox.alerts.length : 0;
  const ctx = {
    status, reloadStatus, library, reloadLibrary, runId, setRunId, manifest, missingRun, reloadManifest, doc: runDoc, docVersion, runData, me, setMe,
    navigate, route, link: linkRef.current, linkStatus, partnerOnline, onlineSlots, connect, disconnect, inbox, setInbox, applySnap, toast, liveInfo,
    session, startSession, endSession, closeSession,
  };

  if (!ready) {
    if (bootError) {
      return html`<div class="boot" style="cursor:default"><div class="panel stack" role="alert" style="max-width:420px">
        <h2>${t('boot.failed', 'souldew could not start')}</h2>
        <p class="small muted">${t('boot.failedText', 'The local server did not answer or a data file is missing. Check that the app is still running, then try again.')}</p>
        <p class="small code">${bootError}</p>
        <div><button class="btn primary" onClick=${bootUp}>${t('err.retry', 'Try again')}</button></div>
      </div></div>`;
    }
    return html`<div class="boot"><div class="boot-screen"></div></div>`;
  }
  const showOnboarding = !!status && !status.config?.onboarded;
  const View = { library: LibraryView, soullink: SoulLinkView, nuzlocke: NuzlockeView, play: PlayView, link: LinkView, stream: StreamView, settings: SettingsView, guide: GuideView }[route.route] || LibraryView;
  const names = runDoc ? getPlayers(runDoc, manifest) : null;
  // Fullscreen – the window's (macOS: green button, Windows: F11) or the game's (F): the side rail folds away, the game gets the room
  const [winFs, setWinFs] = useState(false);
  const [docFs, setDocFs] = useState(false);
  useEffect(() => {
    const off = window.sls?.on?.('fullscreen', (v) => setWinFs(!!v));
    const doc = () => setDocFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', doc);
    return () => { off?.(); document.removeEventListener('fullscreenchange', doc); };
  }, []);
  // The side rail: open, or folded away by hand (remembered) – and always folded in fullscreen. Folded, it slides in
  // over the page while the pointer is at the window's left edge (or a key moves the focus into it).
  // (onfocusin / onfocusout in lowercase: Preact would listen for a `FocusOut` event otherwise)
  const [railHidden, setRailHidden] = useState(() => { try { return localStorage.getItem('sl-rail-hidden') === '1'; } catch { return false; } });
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef(0);
  const fs = winFs || docFs;
  const folded = railHidden || fs;
  const setHidden = useCallback((h) => {
    setRailHidden(h);
    setPeek(false);
    try { localStorage.setItem('sl-rail-hidden', h ? '1' : '0'); } catch {}
  }, []);
  const peekIn = () => { clearTimeout(peekTimer.current); setPeek(true); };
  const peekOut = () => { clearTimeout(peekTimer.current); peekTimer.current = setTimeout(() => setPeek(false), 300); };
  useEffect(() => { if (!folded) setPeek(false); }, [folded]);
  useEffect(() => {
    // ⌘B / Ctrl+B: fold or unfold (in fullscreen: show or hide it for a moment)
    const key = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'b') return;
      e.preventDefault();
      if (fs) setPeek((p) => !p);
      else setHidden(!railHidden);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [fs, railHidden, setHidden]);
  const playing = !!session;
  useEffect(() => { window.sls?.setPlaying?.(playing); }, [playing]);
  fxBusy.current = playing || fs || boot || showOnboarding;
  const native = !!window.sls?.native;
  // The game fills the Play page when that page shows it, otherwise it keeps running in the corner.
  const sp = session?.target.params || {};
  const rp = route.params;
  const showsSession = route.route === 'play' && rp.home === undefined
    && (rp.run ? rp.run === sp.run : rp.rom ? rp.rom === sp.rom && (rp.patch || '') === (sp.patch || '') : true);
  // The rail has no "Play" item: the game belongs to the section of what it plays – a run to SoulLink or Nuzlocke,
  // a game of the library (free play) to the library. That item carries the green "playing" light, and while the
  // game fills the page, it is the one marked as here.
  const sectionOf = (id) => {
    const r = id === manifest?.id ? manifest : status?.runs?.find((x) => x.id === id);
    return r ? runMode(r) : 'soullink';
  };
  const playingIn = session ? (session.target.runId ? sectionOf(session.target.runId) : 'library') : null;
  const here = route.route !== 'play' ? route.route
    : showsSession && session ? playingIn : rp.run ? sectionOf(rp.run) : 'library';
  const NAV = [
    { id: 'library', label: t('nav.library', 'Library'), icon: 'library', accent: '#e0a458' },
    // the board's to-do count shows at the section of the open run
    { id: 'soullink', label: t('nav.soullink', 'SoulLink'), icon: 'link', count: manifest && runMode(manifest) === 'soullink' ? warnCount : 0, accent: '#d77fc6' },
    { id: 'nuzlocke', label: t('nav.nuzlocke', 'Nuzlocke'), icon: 'nuzlocke', count: manifest && runMode(manifest) === 'nuzlocke' ? warnCount : 0, accent: '#e8735f' },
    { id: 'link', label: t('nav.link', 'Connection'), icon: 'signal', accent: '#6f9bff' },
    { id: 'stream', label: t('nav.stream', 'Stream'), icon: 'stream', accent: '#ff5b6e', onAir: streamer },
    { id: 'settings', label: t('nav.settings', 'Settings'), icon: 'gear', accent: '#9a8ee6' },
    { id: 'guide', label: t('nav.guide', 'Help'), icon: 'help', accent: '#4fb8c4' },
  ];

  return html`<${Ctx.Provider} value=${ctx}>
    <div class=${`frame ${native ? 'app-native' : ''} ${folded ? 'rail-folded' : ''} ${folded && peek ? 'rail-peek' : ''}`}>
      ${native && html`<div class="titlebar-drag"></div>`}
      ${folded && html`<div class="rail-edge" aria-hidden="true" onPointerEnter=${peekIn} onPointerLeave=${peekOut}></div>`}
      ${folded && !fs && !peek && html`<${CoffeeLink} float fx=${coffee.fx} onOpen=${coffee.clicked} />`}
      ${railHidden && !fs && !peek && html`<button class="rail-open no-drag" onClick=${() => setHidden(false)} title=${`${t('rail.show', 'Show the sidebar')} (${shortcut('Mod+B')})`} aria-label=${t('rail.show', 'Show the sidebar')}><${Icon} name="sidebar" size=${18} /></button>`}
      <aside class=${`rail ${native ? '' : 'web'} ${native ? 'drag' : ''}`} onPointerEnter=${folded ? peekIn : undefined} onPointerLeave=${folded ? peekOut : undefined}
        onfocusin=${folded ? peekIn : undefined} onfocusout=${folded ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) peekOut(); } : undefined}>
        <div class="brand no-drag"><${AppMark} size=${34} /><div class="name">souldew</div>
          ${streamer && html`<a href="#/stream" class="onair on brand-onair" title=${t('stream.onAirHint', 'Streamer mode is on – codes, keys, paths and spoilers are covered')}>${t('stream.live', 'LIVE')}</a>`}</div>
        ${!fs && html`<button class="rail-toggle no-drag" onClick=${() => setHidden(!railHidden)} title=${`${railHidden ? t('rail.pin', 'Keep the sidebar open') : t('rail.hide', 'Hide the sidebar')} (${shortcut('Mod+B')})`}
            aria-label=${railHidden ? t('rail.pin', 'Keep the sidebar open') : t('rail.hide', 'Hide the sidebar')} aria-pressed=${!railHidden}><${Icon} name="sidebar" size=${16} /></button>`}
        <nav class="nav no-drag" aria-label=${t('nav.aria', 'Sections')} onPointerOver=${navLight} onPointerMove=${navLight}>
          ${NAV.map((n) => html`<a href=${`#/${n.id}`} class=${here === n.id ? 'active' : ''} aria-current=${here === n.id ? 'page' : undefined} style=${`--na:${n.accent}`}>
            <${NavIcon} name=${n.icon} /><span class="nav-label">${n.label}</span>
            <span class="nav-end">${n.onAir && html`<span class="nav-onair" title=${t('stream.onAirHint', 'Streamer mode is on – codes, keys, paths and spoilers are covered')}><span class="sr-only">${t('stream.mode', 'Streamer mode')}</span></span>`}${playingIn === n.id && html`<span class="nav-live" title=${t('nav.playing', 'Running now: {game}', { game: session.target.label || session.target.name || '' })}><${Led} on color="green" />
                <span class="sr-only">${t('nav.playing', 'Running now: {game}', { game: session.target.label || session.target.name || '' })}</span></span>`}
              ${n.count > 0 && html`<span class="nav-badge" title=${t('nav.countHint', 'Things to check on the board')}>${n.count > 99 ? '99+' : n.count}<span class="sr-only"> ${t('nav.countSr', 'to check')}</span></span>`}</span>
          </a>`)}
        </nav>
        <div class="rail-foot no-drag">
          <${FirstStepsPill} />
          ${native && html`<${UpdateBanner} />`}
          ${manifest && names && html`<${RailRun} manifest=${manifest} names=${names} me=${me} onlineSlots=${onlineSlots} linkStatus=${linkStatus} session=${session} navigate=${navigate} />`}
          <${CoffeeLink} fx=${!folded || peek ? coffee.fx : null} onOpen=${coffee.clicked} />
        </div>
      </aside>
      <main class="main">
        <div class=${`main-inner ${session && showsSession ? 'under-session' : ''}`}><${Boundary} route=${route.route}><${View} /><//></div>
        ${session && html`<${Boundary} route="session"><${GameSession} key=${session.target.key + session.at} session=${session} mode=${showsSession ? 'full' : 'mini'} /><//>`}
      </main>
    </div>
    ${showOnboarding && !boot && html`<${Onboarding} onDone=${() => navigate('library')} />`}
    ${showOnboarding && !boot && native && html`<div class="titlebar-drag onb-drag"></div>`}
    ${boot && html`<${BootScreen} sound=${soundOn.current} onDone=${() => setBoot(false)} />`}
    <${Modal} open=${!!pendingRun} onClose=${() => setPendingRun(null)} title=${t('play.lockTitle', 'Your game is still running')}
      footer=${html`<button class="btn ghost" onClick=${() => {
        setPendingRun(null);
        if (route.route === 'play') navigate('play', session?.target.params);
        // a board of the other run was asked for: back to the overview instead of waiting for a run that won't open
        else if (rp.run && rp.run !== runId) navigate(route.route);
      }}>${t('play.lockKeep', 'Keep playing')}</button>
        <button class="btn primary" onClick=${() => { const id = pendingRun.id; setPendingRun(null); endSession(); switchRun(id); }}>${t('play.lockSwitch', 'Close game & switch')}</button>`}>
      <p class="muted">${t('play.lockTextRun', '{game} belongs to the run that is open now. To open another run, close the game first – your progress is saved and it continues where you left off.', { game: session?.target.label || '' })}</p>
      ${pendingRun && unsavedProgress() && html`<p class="warning">${unsavedTexts(unsavedProgress()).text}</p>`}
    <//>
    <${Modal} open=${!!pendingClose} onClose=${() => setPendingClose(null)} title=${unsavedTexts(unsavedProgress()).title}
      footer=${html`<button class="btn ghost" onClick=${() => { const p = pendingClose; setPendingClose(null); endSession(); p?.after?.(); }}>${unsavedTexts().close}</button>
        <button class="btn primary" onClick=${() => { setPendingClose(null); if (session) navigate('play', session.target.params); }}>${t('unsaved.back', 'Back to the game')}</button>`}>
      <p class="muted">${unsavedTexts(unsavedProgress()).text}</p>
    <//>
    <${Toasts} toasts=${toasts} dismiss=${(id) => setToasts((ts) => ts.filter((x) => x.id !== id))} />
    <${DeathAlert} alert=${runOver ? null : deathAlert} onClose=${() => setDeathAlert(null)} />
    <${RunOverNotice} status=${restartOffer ? null : runOver} onClose=${() => setRunOver(null)} />
    <${RestartOffer} offer=${restartOffer} onClose=${() => { try { sessionStorage.setItem(`sl-restart-seen-${restartOffer?.id}`, '1'); } catch {} setRestartOffer(null); }} />
  <//>`;
}

document.addEventListener('keydown', groupArrowKeys);
render(html`<${App} />`, document.getElementById('app'));
