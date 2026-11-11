import { html, useState, useEffect, useRef, useCallback } from '/vendor/htm-preact.mjs';
import { useApp, Led, saveDiagnostics, copy } from '../lib/ui.mjs';
import { bridgeState } from '../lib/livebridge.mjs';
import { IS_MAC, IS_WIN, PLATFORM } from '../lib/platform.mjs';
import { diag } from '../lib/diag.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, ago } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { gameById, gameTitle, speciesName, hackById } from '../lib/data.mjs';
import { players as getPlayers, live, othersOf, runMode, missedQuestion, openAreas, markMissed, locationChoices, areaForCatch, genOfRun, profileOf, rules as getRules, logCheat } from '../lib/run.mjs';
import { findEntry, readLiveParty, readLiveBattle, withBattleHp, inBattleFlag, LiveTables, expandedEntry } from '/shared/live/parse.mjs';
import { addRareCandies, cheatSupported } from '/shared/live/cheats.mjs';
import { MusicKeyTracker } from '/shared/live/location.mjs';
import { PlayHome } from './playhome.mjs';
import { PartyGrid } from './party.mjs';
import { PartnerScreen, useScreenShare } from './partnerscreen.mjs';
import { StatePanel, SaveAge, useSaveGuard, describeState, stateInfo, slotName, SHOT, MANUAL_SLOTS, AUTO_SLOT } from './savestates.mjs';
import { RunStrip, LinkedPairs, BattlePanel, RulesDrawer, useBattlePanelPrefs } from './session-info.mjs';
import { LocationSign, readHere, nextHere, musicInfo, loadRomLocations, romSpeciesNow, romDataReady, romWramNow, romMaps3Now } from './location.mjs';
import { shiftEntry } from '/shared/live/romwram.mjs';
import { RulesTab } from './board.mjs';
import { CartInsert } from './cartinsert.mjs';
import { play as playCue } from '../lib/sound.mjs';
import { addSample, typicalReach, offeredSteps, beyondReach, HELD } from '../lib/reach.mjs';
import { SlowWatch, slowTips } from '../lib/slowdown.mjs';
import { gpuBackends } from '/shared/gpu.mjs';
import { GPU_LABELS } from './settings.mjs';

let TABLES = null;
async function liveTables() {
  if (TABLES) return TABLES;
  const j = (f) => fetch(`/shared/data/${f}`).then((r) => r.json());
  const [charsetGen1, charsetGen2, charsetGen3, gen1Index, gen3Index, gen4, addresses] = await Promise.all([
    j('charset_gen1.json'), j('charset_gen2.json'), j('charset_gen3.json'), j('gen1_index_to_dex.json'), j('gen3_index_to_dex.json'), j('gen4.json'), j('addresses.json'),
  ]);
  TABLES = { T: new LiveTables({ charsetGen1, charsetGen2, charsetGen3, gen1Index, gen3Index, gen4 }), addresses };
  return TABLES;
}

const SPEEDS = [1, 2, 3, 4];
// Settings › "Max" turbo step (config.turboMax): after 4× comes "as fast as this computer can" – no limit at all.
const MAX = Infinity;
const speedText = (s) => (s === MAX ? t('play.speedMax', 'Max') : `${s}×`);
// A wild battle ended and no new Pokémon showed up this long after → it got away (Nuzlocke: ask about the area).
// Long enough for the catch to land in the party / box (the box is read every few seconds).
const MISSED_WAIT = 10000;
// what you hear while fast-forwarding; 'plain' takes the turbo mixer out of the sound path altogether
const TURBO_AUDIO = ['music', 'mute', 'original', 'plain'];

/** What to play: a run (slot = me) or a single library game. */
function useTarget() {
  const { route, manifest, runId, setRunId, library, me } = useApp();
  const p = route.params;
  useEffect(() => {
    if (p.run && p.run !== runId) setRunId(p.run);
  }, [p.run]);
  if (p.run && manifest?.id === p.run) {
    const out = manifest.outputs?.[me];
    if (!out) return { error: 'noRom', runId: manifest.id };
    return {
      kind: 'run', key: `run-${manifest.id}-${me}`, system: manifest.game?.system || 'nds', code: manifest.game?.code, title: manifest.game?.title,
      rom: `/api/runs/${manifest.id}/file?inline=1&name=${encodeURIComponent(out.rom)}`, name: out.rom.replace(/\.\w+$/, ''),
      saveUrl: `/api/runs/${manifest.id}/save/${me}`, stateId: `run-${manifest.id}-${me}`, label: manifest.name, gameId: manifest.game?.id,
      runId: manifest.id, params: { run: manifest.id },
    };
  }
  if (p.rom) {
    const r = library?.roms?.find((x) => x.id === p.rom);
    if (!r) return library ? { error: 'missing' } : null;
    const id = p.patch ? `${p.rom}|${p.patch}` : p.rom;
    return {
      kind: 'solo', key: id, system: r.system, code: r.code, title: r.title, gameId: r.gameId,
      rom: p.patch ? `/api/library/patched?romId=${encodeURIComponent(p.rom)}&patchId=${encodeURIComponent(p.patch)}` : `/api/library/rom?id=${encodeURIComponent(p.rom)}`,
      name: r.name.replace(/\.\w+$/, ''), saveUrl: `/api/saves/solo?id=${encodeURIComponent(id)}`, stateId: id,
      // (a ROM patched before it was added is named after its hack – server/lib/library.mjs describeRom)
      label: p.patch ? library.patches.find((x) => x.id === p.patch)?.name : r.hackId && hackById(r.hackId) ? hackById(r.hackId).name : gameById(r.gameId) ? gameTitle(gameById(r.gameId)) : r.title,
      params: { rom: p.rom, patch: p.patch || undefined },
    };
  }
  return null;
}

export function PlayView() {
  const { status, navigate, session, route } = useApp();
  const target = useTarget();
  const running = session?.target;
  const home = route.params.home !== undefined;
  // The running game is drawn by the app shell (GameSession), so it keeps going in every other section.
  if (running && !home && (!target || target.key === running.key)) return null;
  if (!target || home) return html`<div class="stack-l">${running && html`<${RunningBanner} />`}<${PlayHome} /></div>`;
  if (target.error === 'noRom') {
    return html`<div class="panel empty-state">
      <${Icon} name="link" size=${64} />
      <h2>${t('play.noRom', 'Your game for this run isn’t built yet')}</h2>
      <p class="muted prose">${t('play.noRomText', 'Open the run to build your game – or to finish joining with the invite.')}</p>
      <div class="row"><button class="btn primary big" onClick=${() => navigate('soullink', { run: target.runId })}>${t('play.openRun', 'Open the run')}</button>
        <button class="btn big" onClick=${() => navigate('play')}>${t('play.pickOther', 'Play something else')}</button></div>
    </div>`;
  }
  if (target.error) return html`<${PlayHome} />`;
  const choice = status?.config?.emulatorFor?.[target.system] || 'builtin';
  if (choice !== 'builtin' && status?.emulators?.[choice]?.installed) return html`<${ExternalPlay} target=${target} emu=${choice} />`;
  if (running) return html`<${SwitchGame} next=${target} />`;
  return html`<${StartGame} target=${target} />`;
}

function StartGame({ target }) {
  const { startSession } = useApp();
  useEffect(() => startSession(target), [target.key]);
  return null;
}

/** Shown on the Play overview while a game keeps running in the corner. */
function RunningBanner() {
  const { session, navigate, closeSession } = useApp();
  return html`<div class="panel row running-banner">
    <${Led} on color="green" /><span class="grow">${t('play.runningNow', 'Running now:')} <b>${session.target.label}</b></span>
    <button class="btn small primary" onClick=${() => navigate('play', session.target.params)}><${Icon} name="play" size=${14} />${t('play.backToGame', 'Back to the game')}</button>
    <button class="btn small ghost" onClick=${() => closeSession()}>${t('play.close', 'Close game')}</button>
  </div>`;
}

/** Another game was picked while one is running – never switch silently. */
function SwitchGame({ next }) {
  const { session, navigate, closeSession } = useApp();
  return html`<div class="panel empty-state">
    <${Icon} name="play" size=${56} />
    <h2>${t('play.switchTitle', '{name} is still running', { name: session.target.label })}</h2>
    <p class="muted prose">${t('play.switchText', 'Close it to start {next}. Your in-game save is kept and the game picks up where you left off next time.', { next: next.label })}</p>
    <div class="row"><button class="btn big" onClick=${() => navigate('play', session.target.params)}>${t('play.backToGame', 'Back to the game')}</button>
      <button class="btn primary big" onClick=${() => closeSession()}>${t('play.switchConfirm', 'Close it & start {next}', { next: next.label })}</button></div>
  </div>`;
}

function hash(u8, step = 7) {
  let h = 2166136261;
  for (let i = 0; i < u8.length; i += step) h = Math.imul(h ^ u8[i], 16777619);
  return `${u8.length}:${h >>> 0}`;
}
// Saves: every byte counts – a sampled hash would miss small changes and skip the upload.
const saveHash = (u8) => hash(u8, 1);
const blank = (u8) => u8.every((b) => b === 0xff) || u8.every((b) => b === 0);

const ls = {
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
const GEN = { gb: 1, gbc: 2, gba: 3, nds: 4 };

/**
 * The running game. Mounted by the app shell for as long as the session lasts, so it never stops when
 * you open another section: `mode` "full" fills the Play page, "mini" floats in the corner.
 */
export function GameSession({ session, mode }) {
  const { manifest, doc, me, applySnap, toast, docVersion, onlineSlots, navigate, closeSession, link, status, runData } = useApp();
  const target = session.target;
  // the module slides into the console while the game boots (Settings › animations; never with reduced motion)
  const [inserting, setInserting] = useState(() => mode === 'full' && status?.config?.bootAnimation !== false
    && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  // The emulator stays invisible until the module is home and the core has started: no black canvas or RetroArch
  // menu flashing behind the animation. It loads all the while – only its visibility waits.
  const [screenShown, setScreenShown] = useState(mode !== 'full');
  const animated = useRef(inserting); // the animation plays the click itself
  const game = gameById(target.gameId);
  const frame = useRef(null);
  const [phase, setPhase] = useState('loading'); // loading | running | error
  const [speed, setSpeedState] = useState(1);
  const [realSpeed, setRealSpeed] = useState(null); // measured, when the computer can't keep up with `speed`
  const [paused, setPaused] = useState(false);
  const [volume, setVolumeState] = useState(() => ls.get('sl-volume', 0.6));
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    if (screenShown || inserting) return undefined;
    if (phase === 'running') {
      setScreenShown(true);
      // no animation (reduced motion / turned off): the module still clicks in – when the game appears
      if (!animated.current) playCue('cartInsert', status?.config?.sounds !== false);
      return undefined;
    }
    const late = setTimeout(() => setScreenShown(true), 20000); // the core never started: show what the player says
    return () => clearTimeout(late);
  }, [screenShown, inserting, phase]);
  const [turboAudio, setTurboAudioState] = useState(() => (TURBO_AUDIO.includes(ls.get('sl-turbo-audio')) ? ls.get('sl-turbo-audio') : 'music'));
  const [soundOpen, setSoundOpen] = useState(false);
  const [cheatOpen, setCheatOpen] = useState(false);
  const [confirmCheat, setConfirmCheat] = useState(false);
  const [slow, setSlow] = useState(null); // { reached, tips } – this computer can't hold full speed (lib/slowdown.mjs)
  const [cheatGame, setCheatGame] = useState(false); // this game's bag layout is known (shared/live/cheats.mjs)
  const liveRef = useRef({ entry: null, state: null }); // the live reader's game entry and state – the cheats find the bag with them
  const [layout, setLayoutState] = useState(() => ls.get('sl-ds-layout', 'tb')); // tb | lr
  const [fs, setFs] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [panelPrefs, setPanelPrefs] = useBattlePanelPrefs();
  const [osd, setOsd] = useState(null);
  const [mine, setMineState] = useState(null); // latest live party read from RAM
  // The live loop reads RAM every 700 ms – only re-render the session when something visible changed.
  const setMine = (m) => setMineState((prev) => (JSON.stringify(prev) === JSON.stringify(m) ? prev : m));
  const [battle, setBattleState] = useState(null); // what's on the other side right now (readLiveBattle)
  const [here, setHere] = useState(null); // where the player is right now (location.mjs readHere)
  const setBattle = (b) => setBattleState((prev) => (JSON.stringify(prev) === JSON.stringify(b) ? prev : b));
  const [liveState, setLiveStateRaw] = useState({ status: 'searching' });
  const setLiveState = (x) => setLiveStateRaw((prev) => (prev.status === x.status && prev.entry === x.entry ? prev : x));
  const [pendingLoad, setPendingLoad] = useState(null); // { slot, bytes } – state load waiting for confirmation
  const [statesOpen, setStatesOpen] = useState(false);
  const closeStates = useCallback(() => setStatesOpen(false), []);
  const [statesVer, setStatesVer] = useState(0); // bumped after every save → the open panel reads the list again
  const [sel, setSel] = useState(() => ls.get(`sl-state-sel-${session.target.stateId}`, 1)); // F5 / F8 work on this slot
  const selRef = useRef(sel);
  selRef.current = sel;
  const pickSlot = (n) => {
    if (!MANUAL_SLOTS.includes(n)) return;
    setSel(n);
    ls.set(`sl-state-sel-${session.target.stateId}`, n);
  };
  const shotRef = useRef(null); // recent picture of the game – the state taken on close has no frame left to grab
  const infoRef = useRef(null); // () => team / badges / core for a state's card
  const turboHeld = useRef(false);
  const lastSpeed = useRef(2);
  const speedRef = useRef(1);
  speedRef.current = speed;
  const isDs = target.system === 'nds';
  // Games with an IR cartridge (HeartGold/SoulSilver, Black/White 1+2) answer the main menu with
  // "A communication error has occurred" in the melonDS core once a save exists (any save, DeSmuME's too – still so in
  // the bundled melonDS 0.9.3, checked 11/2026). DeSmuME runs them fine and is the faster core for them anyway: in town
  // ~10 ms per frame on an M1, the same as "DeSmuME 2015" and with any core option (lib/reach.mjs).
  const core = isDs && /^(IPK|IPG|IRB|IRA|IRE|IRD)/.test(target.code || '') ? 'desmume' : '';
  // What fast-forward really reaches in this game on this computer (lib/reach.mjs), remembered per game and core: the
  // turbo steps it can't reach aren't offered – the highest one then plays as fast as the computer manages.
  const reachKey = `sl-reach-${target.system}-${target.code || target.key}-${core || 'default'}`;
  const [reachList, setReachList] = useState(() => ls.get(reachKey, []));
  const reach = typicalReach(reachList);
  const reachRef = useRef(reach);
  reachRef.current = reach;
  const steps = offeredSteps(status?.config?.turboMax === true ? [...SPEEDS, MAX] : SPEEDS, reach);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const rulesRef = useRef(false); // the rules drawer owns the keyboard while it is open
  rulesRef.current = rulesOpen && mode === 'full';
  const volRef = useRef(volume); // quick repeated +/- build on each other
  volRef.current = volume;
  const pendingRef = useRef(null);
  const pendingTimer = useRef(null);
  // Missed encounters (Nuzlocke): every Pokémon key seen this session, when the last new one turned up, and when
  // the current wild battle began – a catch is a new key after the start of the battle.
  const [missed, setMissed] = useState(null); // { species, level } – the prompt on the screen
  const monKeys = useRef(null);
  const newMonAt = useRef(0);
  const wildFrom = useRef(0);
  const wildOnly = useRef(false); // the current battle began wild and never looked like a trainer battle
  const liveRead = useRef({ boxes: false, party: 0 }); // does the live read see the PC; party size (a full one sends a catch there)
  const prevBattle = useRef(null);
  const noteMons = (mons) => {
    const keys = mons.map((m) => m?.key).filter(Boolean);
    if (!monKeys.current) return void (monKeys.current = new Set(keys)); // the team we started with
    for (const k of keys) {
      if (monKeys.current.has(k)) continue;
      monKeys.current.add(k);
      newMonAt.current = Date.now();
    }
  };
  // The long-running loops below must always see the current applySnap (the doc may load later).
  const snapRef = useRef(applySnap);
  snapRef.current = applySnap;
  const emu = () => frame.current?.contentWindow?.__emu;
  const isRun = target.kind === 'run';
  const solo = isRun && runMode(manifest) === 'nuzlocke';
  // Where you are and whom you fight, for the stream overlays (shared/overlay.mjs "where:<slot>"): written only
  // when the place or the battle changes, never per frame – the partners get it with the next sync like the rest.
  const whereKey = here ? `${here.gen}.${here.id}.${battle?.kind || ''}.${battle?.enemy?.species || ''}` : '';
  useEffect(() => {
    if (!isRun || !doc || !me || !here) return;
    const fight = battle?.enemy?.species ? { kind: battle.kind || 'wild', species: battle.enemy.species, level: battle.enemy.level ?? null } : null;
    doc.set(`where:${me}`, { gen: here.gen, id: here.id, name: here.name, at: Date.now(), ...(fight ? { fight } : {}) });
  }, [whereKey, isRun, doc, me]);
  const stateUrl = (slot) => `/api/saves/state?id=${encodeURIComponent(target.stateId)}&slot=${slot}`;

  const armLoad = (p) => {
    pendingRef.current = p;
    setPendingLoad(p);
    clearTimeout(pendingTimer.current);
    if (p) pendingTimer.current = setTimeout(() => armLoad(null), 6000);
  };
  useEffect(() => () => {
    clearTimeout(pendingTimer.current);
    clearTimeout(flash.timer);
  }, []);

  const flash = useCallback((text, ms = 1200) => {
    setOsd(text);
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => setOsd(null), ms);
  }, []);

  // "▶▶ 4×" – and when this computer usually can't get there in this game, what it does get to
  const turboFlash = (s) => (beyondReach(s, reachRef.current)
    ? flash(t('play.speedReach', '▶▶ {set} – this computer usually manages ≈{n}× in this game', { set: speedText(s), n: reachRef.current }), 2500)
    : flash(`▶▶ ${speedText(s)}`));
  const setSpeedRef = useRef(null);
  const setSpeed = useCallback((s) => {
    speedRef.current = s; // quick repeated clicks build on each other
    emu()?.setSpeed(s);
    setSpeedState(s);
    if (s > 1) lastSpeed.current = s;
    if (s > 1) turboFlash(s);
    else flash('▶ 1×');
  }, []);
  setSpeedRef.current = setSpeed;

  const applyVolume = (v, m = muted) => {
    emu()?.setVolume(m ? 0 : v);
  };

  const actions = {
    pause: () => {
      const e = emu();
      if (!e?.ready) return;
      e.togglePause();
      setPaused(e.paused());
      flash(e.paused() ? t('play.paused', 'Paused') : '▶');
    },
    turbo: () => {
      // the next step up, after the highest back to 1× (the current one may no longer be on offer, lib/reach.mjs)
      setSpeed(stepsRef.current.find((s) => s > speedRef.current) ?? 1);
    },
    faster: () => setSpeed(stepsRef.current.find((s) => s > speedRef.current) ?? stepsRef.current.at(-1)),
    slower: () => setSpeed([...stepsRef.current].reverse().find((s) => s < speedRef.current) ?? 1),
    quicksave: async (slot = selRef.current) => {
      if (!emu()?.ready) return;
      let ok = false;
      let shot = null;
      try {
        const st = emu().getState();
        shot = Promise.resolve(emu().snapshot?.(SHOT)).catch(() => null); // the picture for the card, taken with the state
        const res = await fetch(stateUrl(slot), { method: 'PUT', headers: { 'x-soullink': '1' }, body: st });
        ok = res.ok;
      } catch {
        ok = false;
      }
      if (ok) {
        flash(t('play.stateSaved', 'State {n} saved', { n: slot }));
        pickSlot(slot);
        await describeState(target.stateId, slot, shot, infoRef.current?.());
        setStatesVer((v) => v + 1);
      } else toast({ kind: 'death', title: t('play.stateSaveFailed', 'Couldn’t save state {n}', { n: slot }), text: t('play.stateSaveFailedText', 'The state wasn’t written to disk. Try again in a moment.') });
    },
    // Loading a state throws away everything since then → it needs a second press / click to go through.
    quickload: async (slot = selRef.current) => {
      if (!emu()?.ready) return;
      if (pendingRef.current?.slot === slot) return actions.confirmLoad();
      let r = null;
      let bytes = null;
      try {
        r = await fetch(stateUrl(slot));
        if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
      } catch {
        bytes = null;
      }
      if (!bytes) {
        armLoad(null);
        return flash(r?.status === 404 ? t('play.noState', 'Slot {n} is empty', { n: slot }) : t('play.stateReadFailed', 'Couldn’t read slot {n}', { n: slot }));
      }
      armLoad({ slot, bytes });
    },
    confirmLoad: () => {
      const p = pendingRef.current;
      armLoad(null);
      if (!p || !emu()?.ready) return;
      emu().loadState(p.bytes);
      pickSlot(p.slot);
      flash(MANUAL_SLOTS.includes(p.slot) ? t('play.stateLoaded', 'State {n} loaded', { n: p.slot }) : t('states.loaded', '“{name}” loaded', { name: slotName(p.slot) }));
    },
    cancelLoad: () => armLoad(null),
    screenshot: async () => {
      if (!emu()?.ready) return;
      let png;
      try {
        png = await emu().screenshot();
      } catch {
        return flash(t('play.screenshotFailed', 'Couldn’t take a screenshot'));
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
      a.download = `${target.name}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      flash(t('play.screenshot', 'Screenshot saved'));
    },
    mute: () => {
      const next = !muted;
      setMuted(next);
      applyVolume(volume, next);
      flash(next ? t('play.muted', 'Sound off') : t('play.unmuted', 'Sound on'));
    },
    volume: (v) => {
      const nv = Math.max(0, Math.min(1, Math.round(v * 20) / 20));
      volRef.current = nv;
      setVolumeState(nv);
      ls.set('sl-volume', nv);
      if (muted && nv > 0) setMuted(false);
      applyVolume(nv, false);
      flash(`♪ ${Math.round(nv * 100)} %`);
    },
    louder: () => actions.volume(volRef.current + 0.1),
    quieter: () => actions.volume(volRef.current - 0.1),
    // what you hear while fast-forwarding – applied by the effect below
    turboAudio: (m) => {
      if (!TURBO_AUDIO.includes(m)) return;
      setTurboAudioState(m);
      ls.set('sl-turbo-audio', m);
    },
    layout: () => {
      const next = layout === 'tb' ? 'lr' : 'tb';
      setLayoutState(next);
      ls.set('sl-ds-layout', next);
      const e = emu();
      e?.setOption?.('melonds_screen_layout', next === 'lr' ? 'Left/Right' : 'Top/Bottom');
      e?.setOption?.('desmume_screens_layout', next === 'lr' ? 'left/right' : 'top/bottom');
    },
    // Fullscreen covers the whole session (game + your team), not just the game frame.
    // The whole page goes fullscreen (not just the session), so toasts, alerts and the rules drawer stay visible;
    // the session then covers the screen via .is-fs.
    // (only from the big view – the mini player has no fullscreen layout)
    fullscreen: () => {
      if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
      if (modeRef.current === 'full') document.documentElement.requestFullscreen?.()?.catch?.(() => {});
    },
    reset: () => setConfirmReset(true),
    // back to the overview – staying on this game's page would start it again right away
    // (asks first when there is progress since the last in-game save – see closeSession in app.mjs)
    close: () => {
      const full = modeRef.current === 'full';
      // a run's game goes back to its overview (SoulLink / Nuzlocke), free play to the play page
      closeSession(() => full && navigate(isRun ? runMode(manifest) : 'play'));
    },
    expand: () => navigate('play', target.params),
  };

  const act = useRef(actions);
  act.current = actions;

  // the volume and cheat popovers close on Escape and on any click outside them
  useEffect(() => {
    if (!soundOpen && !cheatOpen) return;
    const close = () => {
      setSoundOpen(false);
      setCheatOpen(false);
    };
    const away = (e) => !e.target.closest?.('.sound-wrap, .cheat-wrap') && close();
    const esc = (e) => e.key === 'Escape' && close();
    addEventListener('pointerdown', away);
    addEventListener('keydown', esc);
    window.addEventListener('blur', away); // a click into the game frame
    return () => {
      removeEventListener('pointerdown', away);
      removeEventListener('keydown', esc);
      window.removeEventListener('blur', away);
    };
  }, [soundOpen, cheatOpen]);

  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  // Leaving the big view (another section, the overview): no fullscreen of a page the game no longer covers, and the
  // panels that only exist in the big view don't pop up again on the way back.
  useEffect(() => {
    if (mode === 'full') return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    setStatesOpen(false);
    setRulesOpen(false);
    setSoundOpen(false);
  }, [mode]);

  // Keyboard shortcuts – from inside the emulator frame (fromGame) always, from the page only while
  // the game is shown big (in the mini player the page's keys belong to the page).
  const onKey = useCallback((k, fromGame) => {
    if (k.key === 'Tab') {
      // Releasing Tab always ends a held turbo (focus may have left the game in between).
      if (!k.down) {
        if (turboHeld.current) {
          turboHeld.current = false;
          emu()?.setSpeed(speedRef.current);
        }
        return false;
      }
      // Hold-for-turbo only while playing – on the page Tab keeps moving focus between controls.
      if (!fromGame || k.ctrl || k.alt || k.meta) return false;
      if (!turboHeld.current) {
        turboHeld.current = true;
        emu()?.setSpeed(lastSpeed.current > 1 ? lastSpeed.current : 3);
        turboFlash(lastSpeed.current > 1 ? lastSpeed.current : 3);
      }
      return true;
    }
    // Ctrl/Alt/Cmd combos belong to the browser / the app menu (Ctrl+R, Cmd+1 …), not to the game.
    if (!k.down || k.repeat || k.ctrl || k.alt || k.meta) return false;
    if (!fromGame && modeRef.current !== 'full') return false;
    const a = act.current;
    const key = (k.key || '').toLowerCase();
    if (key === 'p') a.pause();
    else if (key === 't') a.turbo();
    else if (k.key === 'F5') a.quicksave(); // the selected slot (last saved / loaded one)
    else if (k.key === 'F8') a.quickload();
    else if (k.key === 'F12') a.screenshot();
    else if (key === 'm') a.mute();
    else if (k.key === '+' || k.key === '=') a.louder();
    else if (k.key === '-') a.quieter();
    else if (key === 'f') a.fullscreen();
    else if (key === 'r') a.reset();
    else if (k.key === 'Escape' && pendingRef.current) a.cancelLoad();
    else if (/^[1-4]$/.test(k.key) || /^Digit[1-4]$/.test(k.code || '')) {
      const n = Number((k.code || '').slice(-1)) || Number(k.key);
      if (k.shift) a.quicksave(n);
      else a.quickload(n);
    } else return false;
    return true;
  }, []);

  useEffect(() => {
    const onMsg = (e) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === 'emu-started') setPhase('running');
      if (e.data?.type === 'emu-key') onKey(e.data, true);
      if (e.data?.type === 'emu-pad' && ['turbo', 'pause'].includes(e.data.action)) act.current[e.data.action]();
      // EmulatorJS flushed the battery save by itself (periodic save) – write it to disk now.
      if (e.data?.type === 'emu-saved') window.dispatchEvent(new Event('sl-save-now'));
    };
    const down = (e) => {
      // typing in a field, or answering the prompt over the screen (missed encounter) by keyboard: not the game's keys
      if (e.target.closest?.('input,textarea,select,dialog,.rules-drawer,.screen-confirm')) return;
      // a dialog (unsaved-progress, death alert …) or the rules drawer is open: its keys, not the game's
      if (rulesRef.current || document.querySelector('dialog[open]')) return;
      if (onKey({ key: e.key, code: e.code, shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, down: true, repeat: e.repeat }, false)) e.preventDefault();
    };
    const up = (e) => onKey({ key: e.key, code: e.code, down: false }, false);
    // Tab released while the window had no focus (alt-tab, a click into another app): end a held turbo anyway.
    const blur = () => turboHeld.current && onKey({ key: 'Tab', down: false }, false);
    addEventListener('message', onMsg);
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    addEventListener('blur', blur);
    const offMenu = window.sls?.on?.('emu', (a) => act.current[a]?.());
    return () => {
      removeEventListener('message', onMsg);
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
      removeEventListener('blur', blur);
      offMenu?.();
    };
  }, [onKey]);

  // Once running: load the save from disk, resume where you left off, then poll RAM (live) and persist
  // the battery save.
  useEffect(() => {
    if (phase !== 'running') return;
    let stopped = false;
    let lastSave = null; // hash of what is known to be on disk (set only after a successful PUT/GET)
    let loadedOk = false; // the save on disk was read (or there is none) – until then never upload
    let chain = Promise.resolve();
    const state = { onDiag: (d) => diag('battle', d) }; // the battle reader's decisions (parse.mjs note)
    let entry = null;
    applyVolume(volume, muted);
    const put = (bytes, keepalive = false) => fetch(target.saveUrl, { method: 'PUT', headers: { 'x-soullink': '1' }, body: bytes, keepalive });
    const readSave = () => {
      try {
        const e = emu();
        const bytes = e?.ready ? e.getSave() : null;
        // a never-written cartridge (all 0xFF / 0x00) is not a save – don't put it on disk
        return bytes?.length && !blank(bytes) ? bytes : null;
      } catch {
        return null; // emulator busy – next round
      }
    };
    // All uploads run one after another, so an older body can never land after a newer one.
    // `given` = bytes read synchronously by the caller (e.g. while the frame is being torn down).
    const persist = (given) => {
      chain = chain.then(async () => {
        if (!loadedOk) return;
        const bytes = given || readSave();
        if (!bytes) return;
        const h = saveHash(bytes);
        if (h === lastSave) return;
        try {
          const res = await put(bytes);
          if (res.ok) {
            lastSave = h; // otherwise the next round tries again
            guard.saved(h);
            // fresh in-game save: re-take "where you left off" so it matches the save on disk again
            if (!given) saveAuto(grabState());
          }
        } catch {
          // offline / server busy – the periodic loop retries
        }
      });
      return chain;
    };
    // "Where you left off": a state next to the battery save. It is only resumed while the save on disk
    // is still the one it was taken with – after an in-game save elsewhere the save wins.
    const autoKey = `sl-auto-${target.stateId}`;
    const saveAuto = (st) => {
      if (!st) return;
      chain = chain.then(async () => {
        if (!loadedOk) return;
        try {
          const res = await fetch(stateUrl(AUTO_SLOT), { method: 'PUT', headers: { 'x-soullink': '1' }, body: st });
          if (res.ok) {
            ls.set(autoKey, { at: Date.now(), save: lastSave, core });
            // its card picture: a fresh one, or the recent one once the frame is gone (closing)
            const shot = Promise.resolve(stopped ? null : emu()?.snapshot?.(SHOT)).catch(() => null).then((b) => b || shotRef.current);
            await describeState(target.stateId, AUTO_SLOT, shot, infoRef.current?.());
          }
        } catch {
          // best effort
        }
      });
    };
    const grabState = () => {
      try {
        return emu()?.ready ? emu().getState() : null;
      } catch {
        return null;
      }
    };
    const flushNow = () => persist();
    // Page is going away (tab closed, reload, desktop window closed): no time to queue – send now.
    // keepalive bodies are capped at 64 KB, so bigger saves (NDS: 512 KB) are a plain best-effort fetch.
    const onPageHide = () => {
      if (!loadedOk) return;
      const bytes = readSave();
      if (!bytes || saveHash(bytes) === lastSave) return;
      try {
        put(bytes, bytes.length < 60000).catch(() => {});
      } catch {
        // ignore
      }
    };
    const onVisibility = () => document.visibilityState === 'hidden' && persist();
    window.addEventListener('sl-save-now', flushNow);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    let autoTimer = null;
    let songTimer = null;
    let offAudio = null; // the mixer's event feed (diagnostics)
    let inBattle = false; // the live battle reader sees a battle (the turbo mixer's 'battle' song key)
    (async () => {
      // Read the save on disk first. A failed read must never be followed by uploads – the fresh
      // emulator SRAM would overwrite the real save.
      for (let attempt = 0; attempt < 3 && !loadedOk && !stopped; attempt++) {
        if (attempt) await new Promise((res) => setTimeout(res, attempt * 1500));
        try {
          const r = await fetch(target.saveUrl);
          if (r.status === 404) loadedOk = true; // first time – no save yet
          else if (r.ok) {
            const bytes = new Uint8Array(await r.arrayBuffer());
            if (stopped) return;
            if (bytes.length) {
              // normally the player already booted the core with this save; this is the fallback
              if (emu().bootSave?.() !== 'loaded') emu().loadSave(bytes);
              lastSave = saveHash(bytes);
              guard.loaded(lastSave);
            }
            loadedOk = true;
          }
        } catch {
          // server not reachable – try again
        }
      }
      if (stopped) return;
      if (!loadedOk) {
        toast({ kind: 'death', title: t('play.saveLoadFailed', 'Couldn’t load your save'), text: t('play.saveLoadFailedText', 'Saving to disk is paused so your real save isn’t overwritten. Open the game again to retry.') });
      } else {
        const meta = ls.get(autoKey, null);
        if (meta && meta.save === lastSave && (meta.core || '') === core) {
          try {
            const r = await fetch(stateUrl(AUTO_SLOT));
            if (r.ok && !stopped) {
              emu().loadState(new Uint8Array(await r.arrayBuffer()));
              flash(t('play.resumed', 'Picked up where you left off'));
            }
          } catch {
            // start from the save instead
          }
        }
        autoTimer = setInterval(() => document.visibilityState === 'visible' && saveAuto(grabState()), 120000);
      }
      // battery save → disk every 5 s when it changed
      const saveLoop = async () => {
        if (stopped) return;
        await persist();
        if (!stopped) setTimeout(saveLoop, 5000);
      };
      setTimeout(saveLoop, 5000);
      let tables = null;
      try {
        tables = await liveTables();
      } catch {
        // offline / missing data file – no live tracking this session
      }
      if (stopped) return;
      if (!tables) return setLiveState({ status: 'unsupported' });
      const { T, addresses } = tables;
      entry = findEntry(addresses, { platform: target.system === 'gbc' ? 'gbc' : target.system, code: target.code, title: target.title });
      // the ROM's own place names and map → location step (randomized games, other languages, hacks, Gen 5)
      if (entry) loadRomLocations(target.rom);
      setLiveState({ status: entry ? 'searching' : 'unsupported', entry: entry?.name });
      liveRef.current = { entry, state };
      setCheatGame(cheatSupported(entry));
      // the music playing now, for the turbo mixer: a new route's song while fast-forwarding (a few bytes, often);
      // the tracker falls back to the map's music when the song number doesn't follow the game (ROM hacks)
      const songs = new MusicKeyTracker({ settle: 20 }); // (2 s of readings: the map settles before it is judged)
      diag('session', { system: target.system, code: target.code || null, title: target.title || null, game: target.gameId || null, core: core || null, live: entry?.name || null, run: !!isRun });
      let lastKey = null;
      let lastSpeed = 1;
      songTimer = setInterval(() => {
        const e = emu();
        if (!e?.ready) return;
        // diagnostics: every mixer decision (which music plays when), the song keys and the speed steps
        if (!offAudio && e.onAudio) offAudio = e.onAudio(({ t: _t, n: _n, ...ev }) => diag('music', ev));
        const sp = e.speed?.() ?? 1;
        if (sp !== lastSpeed) diag('music', { type: 'speed', ratio: (lastSpeed = sp) });
        if (!e.songKey || e.ramInfo().base < 0) return;
        const info = musicInfo(entry, e.read);
        const key = songs.next(info, inBattle);
        if (key !== lastKey) {
          lastKey = key;
          diag('music', { type: 'key', key, song: info?.song ?? null, map: info?.map ?? null, expected: info?.expected ?? null, trusted: songs.trusted, battle: inBattle });
        }
        e.songKey(key);
      }, 100); // a few bytes: read often, so the turbo music follows a new song within a moment
      // live loop
      let lastLocate = 0;
      let wramEntry = null;
      let x3 = null; // (one entry object for the session: liveRef and the cheats compare it)
      const scan3Entry = (en) => (x3?.from === en ? x3.entry : (x3 = { from: en, entry: expandedEntry(en, romMaps3Now()) }).entry);
      let expandedMisses = 0; // reads in a battle without a team in an expanded engine (after ~15 s: "not supported")
      const tick = () => {
        if (stopped) return;
        const e = emu();
        if (e?.ready && entry) {
          const info = e.ramInfo();
          // Searching the heap is costly – slow down after ~1 min without a hit.
          const every = info.tried < 25 ? 2500 : 15000;
          if (info.base < 0 && Date.now() - lastLocate > every) {
            lastLocate = Date.now();
            e.locateRam();
          }
          // A GBA ROM hack on an expanded engine (romspecies.mjs) keeps neither the species numbers nor the RAM layout
          // of the game it was built from: reading it with that game's addresses would show made-up Pokémon. Say so.
          const sp = entry.gen === 3 ? romSpeciesNow() : null;
          if (entry.gen <= 3 && !romDataReady()) {
            // (GB and GBA games are read once the ROM's own data is known – a moment after the start: a hack may keep
            // its variables elsewhere or other Pokémon in the slots)
          } else if (sp?.engine === 'expanded' && !romSpeciesNow()?.map) {
            // an expanded engine whose species table can't be read: say so
            setLiveState({ status: 'hack', entry: entry.name });
            setHere(null);
            setCheatGame(false); // (the bag isn't where the base game keeps it either)
          } else if (e.ramInfo().base >= 0) {
            // a Game Boy hack built from the disassembly may have moved its RAM variables (Crystal Legacy: 11 bytes)
            const wram = entry.gen <= 2 ? romWramNow() : null;
            if (wram && wramEntry?.from !== entry) wramEntry = { from: entry, entry: { ...shiftEntry(entry, wram), wram } };
            // an expanded GBA engine (Run & Bun): the team is searched for, the place read through SaveBlock1
            const expanded = sp?.engine === 'expanded';
            if (expanded) setCheatGame(false);
            const ent = wram ? wramEntry.entry : expanded ? scan3Entry(entry) : entry;
            if (liveRef.current?.entry !== ent) liveRef.current = { ...liveRef.current, entry: ent }; // (the cheats use it)
            const hereNow = readHere(ent, e.read, state);
            setHere((p) => nextHere(p, hereNow));
            const TT = sp ? T.withSpecies(sp) : T; // a hack's own Pokémon in the slots (Light Platinum)
            const res = readLiveParty(ent, e.read, TT, state);
            // An expanded engine's team is searched for – and there is none before the first Pokémon (Run & Bun's
            // intro takes minutes). Searching never stops: it used to give up after ~30 s without a team, so the
            // starter and every catch after it were never seen. Only a battle without a team proves the search
            // wrong (nobody battles without a Pokémon): then this hack isn't supported – until a team turns up.
            if (expanded && !res?.party?.length && inBattleFlag(ent, e.read) && ++expandedMisses > 20) setLiveState({ status: 'hack', entry: entry.name });
            if (res?.party) {
              expandedMisses = 0;
              const fight = readLiveBattle(ent, e.read, TT, state, res.party);
              const party = withBattleHp(res.party, fight);
              setMine(party);
              setBattle(fight);
              inBattle = !!fight;
              noteMons([...res.party, ...(res.boxes || [])]);
              liveRead.current = { boxes: Array.isArray(res.boxes), party: res.party.length };
              setLiveState({ status: 'live', entry: entry.name });
              // the battle goes along: a Pokémon that falls in it gets the opponent as its cause of death
              if (isRun) snapRef.current?.({ source: 'live', party, boxes: res.boxes || null, game: entry.id, here: hereNow, ...(res.badges !== undefined ? { badges: res.badges } : {}) }, { battle: fight });
            }
          }
        }
        setTimeout(tick, 700);
      };
      tick();
    })();
    return () => {
      stopped = true;
      clearInterval(autoTimer);
      clearInterval(songTimer);
      offAudio?.();
      window.removeEventListener('sl-save-now', flushNow);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      // final flush: read now (the frame is about to go), upload after whatever is still in flight
      const bytes = loadedOk ? readSave() : null;
      if (bytes) persist(bytes);
      saveAuto(loadedOk ? grabState() : null);
    };
  }, [phase, target.key]);

  // Nuzlocke: a wild battle ended without a catch → the area of that encounter is spent. The app can't tell which
  // area the player is in, so it asks (without stopping the game) and offers the areas still open. No question when
  // the Pokémon was caught after all, a shiny (shiny clause) or a dupe (it doesn't count anyway).
  useEffect(() => {
    const prev = prevBattle.current;
    prevBattle.current = battle;
    if (!solo) return undefined;
    if (battle?.enemy) {
      if (!prev?.enemy) {
        wildFrom.current = Date.now();
        wildOnly.current = battle.kind === 'wild';
      }
      if (battle.kind !== 'wild') wildOnly.current = false; // (Gen 4 guesses the kind – one trainer read is enough)
      setMissed(null); // the next battle started: that one gets its own question
      return undefined;
    }
    if (battle || !prev?.enemy?.species) return undefined;
    const foe = prev.enemy;
    const fight = { foe, wild: wildOnly.current && prev.kind === 'wild', from: wildFrom.current };
    const id = setTimeout(() => {
      if (!doc || !manifest) return;
      const seen = liveRead.current;
      if (!missedQuestion(doc, manifest, runData, me, { ...fight, newMonAt: newMonAt.current, boxes: seen.boxes, partySize: seen.party })) return;
      setMissed({ species: foe.species, level: foe.level ?? null });
    }, MISSED_WAIT);
    return () => clearTimeout(id);
  }, [battle, solo]);
  // a catch that took longer (nickname screen, full party → box): no question anymore
  useEffect(() => {
    if (missed && newMonAt.current >= wildFrom.current) setMissed(null);
  });

  // Fast-forward sound: keep the music going at 1× (default), mute it, or play the sped-up original.
  useEffect(() => {
    if (phase !== 'running') return;
    emu()?.setTurboAudio?.(turboAudio);
    diag('music', { type: 'turboAudio', mode: turboAudio });
  }, [phase, turboAudio]);

  // The run just ended (a wipe here or at the partner's): stop the game, so the notice isn't missed mid-battle.
  const runStatus = isRun ? doc?.get('run:status') : null;
  useEffect(() => {
    const e = emu();
    if (!runStatus?.at || phase !== 'running' || Date.now() - runStatus.at > 120000 || !e || e.paused()) return;
    e.pause();
    setPaused(true);
  }, [runStatus?.at, phase]);

  // Settings › "Full-power turbo" (on unless switched off): fast-forward may use nearly every display frame in full
  // and DeSmuME skips drawing more frames while fast-forwarding (player.html, lib/pacer.mjs). The frame gets it with
  // its URL; a change in the settings applies right away.
  const fullTurbo = status?.config?.fullTurbo !== false;
  useEffect(() => {
    if (phase === 'running') emu()?.setFullTurbo?.(fullTurbo);
  }, [phase, fullTurbo]);

  // A slower computer: measured every 2 s at 1×. DeSmuME first skips every other frame's rendering once it can't hold
  // 55 fps for a while (the game itself keeps its speed and timing; stays on for this session). When the game still
  // runs clearly below full speed for ~10 s, the play view says so and what helps (lib/slowdown.mjs, issue #4: Platinum
  // at half speed with crackling sound on a player's PC – the core itself was too slow there, ~30 ms per frame).
  useEffect(() => {
    if (phase !== 'running') return undefined;
    let last = null;
    let skipSlow = 0;
    let skipped = false;
    const watch = new SlowWatch();
    const id = setInterval(() => {
      const e = emu();
      if (!e?.ready || !e.frames || e.paused?.() || speedRef.current !== 1 || document.hidden) {
        last = null;
        watch.reset();
        return;
      }
      const now = { f: e.frames(), t: performance.now() };
      if (last && now.t > last.t) {
        const fps = (now.f - last.f) / ((now.t - last.t) / 1000);
        if (core === 'desmume' && !skipped) {
          skipSlow = fps < 55 ? skipSlow + 1 : 0;
          if (skipSlow >= 3) {
            skipped = true;
            watch.reset(); // give the frame skipping its chance first
            e.setOption?.('desmume_frameskip', '1'); // (for 1× – fast-forward has its own, see player.html applySkip)
            flash(t('play.frameskipOn', 'Smoother play: frame skipping on'));
          }
        }
        if (watch.add(fps)) {
          const reached = watch.reached();
          const tips = slowTips({ system: target.system, backends: window.sls ? gpuBackends(PLATFORM) : [] });
          setSlow({ reached, tips });
          diag('perf', { type: 'slow', reached, core: core || e.system?.() || null, tips });
        }
      }
      last = now;
    }, 2000);
    return () => clearInterval(id);
  }, [phase, core]);

  // Measure the real speed: when a scene can't keep up, the bar shows it in place of the step (the step moves to the
  // small tag above), and every window goes into the game's reach (lib/reach.mjs – which steps are offered). The chosen level is
  // never changed behind the player's back – only with Settings › "Step down when the computer can't keep up" on
  // does a level that isn't reached for ~5 s drop to the highest one that holds (going up again is the player's call).
  // "Full-power turbo" never steps down: the player asked for everything the computer can give.
  const speedGuard = status?.config?.speedGuard === true && !fullTurbo;
  useEffect(() => {
    if (phase !== 'running' || speed <= 1) {
      setRealSpeed(null);
      return undefined;
    }
    let last = null;
    const short = [];
    const id = setInterval(() => {
      const e = emu();
      if (!e?.ready || !e.frames || e.paused?.() || document.hidden) {
        last = null;
        return;
      }
      const now = { f: e.frames(), t: performance.now() };
      if (last && now.t > last.t) {
        const x = (now.f - last.f) / ((now.t - last.t) / 1000) / 60;
        const behind = x > 0 && x < speed * HELD;
        setRealSpeed(behind ? Math.round(x * 10) / 10 : null);
        setReachList((prev) => {
          const next = addSample(prev, speed, x);
          ls.set(reachKey, next);
          return next;
        });
        short.push(behind ? x : null);
        if (short.length > 4) short.shift();
        if (speedGuard && speed !== MAX && short.length === 4 && short.every((v) => v !== null)) {
          const holds = Math.max(1, Math.floor(Math.min(...short) / 0.97));
          const next = Math.min(speed - 1, holds);
          short.length = 0;
          setSpeedRef.current(next);
          flash(t('play.speedStepDown', '{set}× is too much for this computer here – steady {n}× now', { set: speed, n: next }), 4500);
        }
      }
      last = now;
    }, 1300);
    return () => clearInterval(id);
  }, [phase, speed, speedGuard]);

  // Diagnostics: the sound card and the pacing once, then every 10 s what the game really did (speed reached, display
  // rate, drop-outs in the sound, the longest gap between frames) – a report about crackling or slow-down then shows why.
  useEffect(() => {
    if (phase !== 'running') return undefined;
    let first = true;
    const id = setInterval(() => {
      const p = emu()?.perf?.();
      if (!p) return;
      if (first) diag('perf', { type: 'setup', ...p.sound, ...p.pacing });
      first = false;
      if (p.last) diag('perf', { type: 'window', ...p.last });
    }, 10000);
    return () => clearInterval(id);
  }, [phase]);

  // Keep the speed indicator honest if EmulatorJS switches fast-forward by itself.
  useEffect(() => {
    if (phase !== 'running') return;
    const id = setInterval(() => {
      const e = emu();
      if (!e?.ready || !e.fastForward || turboHeld.current) return;
      const ff = e.fastForward();
      if (!ff && speedRef.current > 1) setSpeedState(1);
      else if (ff && speedRef.current === 1) setSpeedState(e.ffRatio?.() || 3);
    }, 1000);
    return () => clearInterval(id);
  }, [phase]);

  // A recent picture of the game for the "where you left off" card (on close there is no frame left).
  useEffect(() => {
    if (phase !== 'running') return;
    const grab = () => document.visibilityState === 'visible' && Promise.resolve(emu()?.snapshot?.(SHOT)).then((b) => b && (shotRef.current = b), () => {});
    const id = setInterval(grab, 20000);
    return () => clearInterval(id);
  }, [phase]);

  // The frame's URL is fixed for the whole session – changing it would reboot the game.
  const [src] = useState(() => {
    // EmulatorJS names the ROM (and its browser-side save) after the URL's last segment → make it unique per game.
    const romKey = `${hash(new TextEncoder().encode(target.key)).replace(/\D/g, '')}`;
    const romUrl = `/rom/g${romKey}.${target.system}?src=${encodeURIComponent(target.rom)}`;
    const lay = layout === 'lr' ? '&layout=Left%2FRight&dlayout=left%2Fright' : '';
    return `/player.html?system=${target.system}${core ? `&core=${core}` : ''}${lay}${fullTurbo ? '' : '&fullturbo=0'}&rom=${encodeURIComponent(romUrl)}&name=${encodeURIComponent(target.name)}&save=${encodeURIComponent(target.saveUrl)}&tap=${encodeURIComponent(t('play.tapToStart', 'Click to start'))}`;
  });
  const arn = isDs ? (layout === 'lr' ? 512 / 192 : 256 / 384) : target.system === 'gba' ? 3 / 2 : 10 / 9;
  const names = isRun && doc && manifest ? getPlayers(doc, manifest) : null;
  const others = isRun && manifest ? othersOf(me, manifest) : [];
  const myLive = isRun && doc ? live(doc, me) : null;
  const myParty = mine || myLive?.party || [];
  infoRef.current = () => stateInfo({ party: myParty, badges: myLive?.badges, core });
  // progress since the last in-game save → "not saved" warning on close / quit, age in the header
  const guard = useSaveGuard({ id: target.stateId, label: target.label, party: mine, badges: myLive?.badges, running: phase === 'running', paused });
  const focusGame = () => frame.current?.contentWindow?.focus();
  useScreenShare(isRun ? link : null, emu, { system: target.system, enabled: isRun && phase === 'running' && status?.config?.shareScreen !== false });
  const btn = (name, title, onClick, extra = {}) => html`<button class="btn icon" title=${title} aria-label=${title} onClick=${onClick} ...${extra}><${Icon} name=${name} size=${14} /></button>`;

  // Cheats (Rare Candies): written straight into the bag in RAM. In a run only while its rules allow them, and every
  // use goes to the run's log – the partners see it as it happens.
  const cheatsAllowed = !isRun || !!(doc && manifest && getRules(doc, manifest).cheats);
  const cheatWhy = !cheatGame ? t('cheat.unsupported', 'Not available for this game.')
    : !cheatsAllowed ? t('cheat.off', 'Cheats are off in this run’s rules.')
      : liveState.status !== 'live' ? t('cheat.waiting', 'Available once live tracking has found your team.')
        : battle?.enemy ? t('cheat.inBattle', 'Not during a battle.') : null;
  const doCheat = () => {
    setConfirmCheat(false);
    const e = emu();
    const { entry, state } = liveRef.current;
    if (cheatWhy || !e?.write || !entry) return void focusGame();
    let res;
    try {
      res = addRareCandies(entry, { read: e.read, write: e.write }, state, 99);
    } catch {
      res = { error: 'write' };
    }
    diag('cheat', { cheat: 'rareCandy', game: entry.id, ...res });
    if (res.ok) {
      if (isRun) logCheat(doc, manifest, me, { added: res.added });
      flash(t('cheat.done', '+{n} Rare Candy in your bag|+{n} Rare Candies in your bag', { n: res.added, count: res.added }), 2500);
    } else {
      toast({ kind: 'death', title: t('cheat.failed', 'No Rare Candies added'), text: {
        notFound: t('cheat.notFound', 'Your bag wasn’t found in the game’s memory just now. Try again outside of menus and battles.'),
        full: t('cheat.full', 'The bag pocket is full – make room and try again.'),
        max: t('cheat.max', 'You already carry as many Rare Candies as the game allows.'),
      }[res.error] || t('cheat.writeFailed', 'The game’s memory couldn’t be changed.') });
    }
    focusGame();
  };

  // the battle helper: left of the game (default) or on the right above the team, folded in or not – the player's choice
  const panelSide = panelPrefs.side === 'right' ? 'right' : 'left';
  const battlePanel = html`<${BattlePanel} battle=${battle} mine=${myParty} gen=${GEN[target.system]} isRun=${isRun}
    side=${panelSide} collapsed=${panelPrefs.collapsed} onPrefs=${setPanelPrefs} />`;
  const hasLeft = !!(isRun || here || (battle?.enemy && panelSide === 'left'));
  return html`<div class=${`session ${mode} ${fs && mode === 'full' ? 'is-fs' : ''} ${isDs ? 'ds' : ''}`} data-v=${docVersion}>
    <div class="mini-head">
      <${Led} on=${phase === 'running' && !paused} color="green" /><span class="grow ellipsis">${target.label}</span>
      ${btn('close', t('play.close', 'Close game'), actions.close)}
    </div>
    <div class="session-top">
      <b class="ellipsis">${target.label}</b>
      ${phase === 'running' && html`<${SaveAge} savedAt=${guard.savedAt} hasSave=${guard.hasSave} dirty=${guard.dirty} />`}
      <span class="spacer"></span>
      ${isRun && html`<button class="btn small ghost" onClick=${() => navigate('soullink', { run: target.runId })}><${Icon} name="link" size=${14} />${t('play.board', 'Board')}</button>`}
      <button class="btn small ghost" onClick=${actions.close}><${Icon} name="close" size=${14} />${t('play.close', 'Close game')}</button>
    </div>
    <div class=${`session-body ${hasLeft ? 'has-left' : ''}`}>
      ${hasLeft && html`<aside class="session-left">
        <${LocationSign} here=${here} live=${liveState.status === 'live'} isRun=${isRun} game=${liveRef.current?.entry} />
        ${isRun && names && html`<${RunStrip} mine=${myParty} onRules=${() => setRulesOpen(true)} />`}
        ${panelSide === 'left' && battlePanel}
      </aside>`}
      <div class="session-stage">
        <div class="session-screen" onClick=${focusGame}>
          <div class="console-screen" style=${`--arn:${arn}`}>
            <iframe ref=${frame} src=${src} title=${t('play.screenTitle', 'Game screen')} allow="autoplay; fullscreen; gamepad"
              class=${screenShown ? 'ci-shown' : 'ci-wait'} onLoad=${focusGame}></iframe>
            ${osd && html`<div class="osd">${osd}</div>`}
            ${pendingLoad && html`<div class="screen-confirm" role="alertdialog" aria-live="assertive">
              <span class="grow">${pendingLoad.slot <= 4 ? t('play.loadConfirm', 'Load state {n}? Progress since then is lost. Press {n} again or click Load.', { n: pendingLoad.slot })
                : t('states.loadConfirm', 'Load “{name}”? Progress since then is lost.', { name: slotName(pendingLoad.slot) })}</span>
              <button class="btn small primary" onClick=${() => { actions.confirmLoad(); focusGame(); }}>${t('play.loadConfirmYes', 'Load')}</button>
              <button class="btn small ghost" onClick=${() => { actions.cancelLoad(); focusGame(); }}>${t('common.cancel', 'Cancel')}</button>
            </div>`}
            ${missed && mode === 'full' && !pendingLoad && !confirmReset && html`<${MissedPrompt} missed=${missed} onDone=${() => { setMissed(null); focusGame(); }} />`}
            ${confirmReset && html`<div class="screen-confirm" role="alertdialog" aria-live="assertive">
              <span class="grow">${t('play.resetConfirm', 'Reset the game? Unsaved progress is lost.')}</span>
              <button class="btn small primary" onClick=${() => { setConfirmReset(false); emu()?.restart(); focusGame(); }}>${t('play.resetYes', 'Reset')}</button>
              <button class="btn small ghost" onClick=${() => { setConfirmReset(false); focusGame(); }}>${t('common.cancel', 'Cancel')}</button>
            </div>`}
            ${confirmCheat && !confirmReset && !pendingLoad && html`<div class="screen-confirm" role="alertdialog" aria-live="assertive">
              <span class="grow">${t('cheat.confirm', 'Add 99 Rare Candies to your bag?')} ${isRun && !solo ? t('cheat.confirmRun', 'Everyone in the run sees it in the log.') : isRun ? t('cheat.confirmSolo', 'It goes into the run’s log.') : ''}</span>
              <button class="btn small primary" onClick=${doCheat}>${t('cheat.add', 'Add')}</button>
              <button class="btn small ghost" onClick=${() => { setConfirmCheat(false); focusGame(); }}>${t('common.cancel', 'Cancel')}</button>
            </div>`}
          </div>
        </div>
        <div class="session-bar" role="toolbar" aria-label=${t('play.controls', 'Game controls')}>
          ${btn(paused ? 'resume' : 'pause', t('keys.pause', 'Pause / resume') + ' (P)', actions.pause)}
          ${btn('reset', t('keys.reset', 'Reset the game (asks first)') + ' (R)', actions.reset)}
          <span class="sep"></span>
          <button class="btn icon" title=${t('play.slower', 'Slower')} aria-label=${t('play.slower', 'Slower')} onClick=${actions.slower}><span aria-hidden="true">–</span></button>
          <span class=${`speed ${realSpeed ? 'behind' : ''}`} aria-live="polite"
            title=${realSpeed ? t('play.realSpeedOf', 'Set to {set} – your computer manages about {n}× in this scene', { set: speedText(speed), n: realSpeed }) : ''}>${realSpeed ? `≈${realSpeed}×` : speedText(speed)}${realSpeed ? html`<small class="speed-real">${t('play.speedSet', 'set: {set}', { set: speedText(speed) })}</small>` : ''}</span>
          ${btn('fast', t('play.faster', 'Faster') + ' (T)', actions.faster)}
          <span class="sep"></span>
          ${btn('save', t('states.quicksave', 'Quick save to slot {n}', { n: sel }) + ' (F5)', () => actions.quicksave())}
          <button class=${`btn small ghost states-btn ${statesOpen ? 'on' : ''}`} aria-expanded=${statesOpen} aria-haspopup="dialog"
            title=${t('states.openHint', 'All save states – load, overwrite, delete')} onClick=${() => setStatesOpen(!statesOpen)}>
            <${Icon} name="load" size=${14} />${t('states.title', 'Save states')}<span class="px slot-no" aria-hidden="true">${sel}</span></button>
          <span class="spacer"></span>
          ${isDs && btn(layout === 'lr' ? 'layoutTb' : 'layoutLr', layout === 'lr' ? t('play.layoutTb', 'Screens on top of each other') : t('play.layoutLr', 'Screens side by side'), actions.layout)}
          ${btn('camera', t('keys.screenshot', 'Screenshot') + ' (F12)', actions.screenshot)}
          <span class="cheat-wrap">
            ${btn('candy', t('cheat.title', 'Cheats'), () => setCheatOpen(!cheatOpen), { 'aria-expanded': cheatOpen, 'aria-haspopup': 'dialog' })}
            ${cheatOpen && html`<div class="cheat-pop" role="dialog" aria-label=${t('cheat.title', 'Cheats')}>
              <b class="small">${t('cheat.title', 'Cheats')}</b>
              <button class="btn small" disabled=${!!cheatWhy} onClick=${() => { setCheatOpen(false); setConfirmCheat(true); }}>
                <${Icon} name="candy" size=${14} />${t('cheat.rareCandy', 'Add 99 Rare Candies')}</button>
              <span class="tiny faint">${cheatWhy || (isRun && !solo ? t('cheat.hintRun', 'Everyone in the run sees it in the log. Save in the game to keep them.')
                : isRun ? t('cheat.hintSolo', 'It goes into the run’s log. Save in the game to keep them.') : t('cheat.hintGame', 'Save in the game to keep them.'))}</span>
              ${isRun && cheatGame && !cheatsAllowed && html`<button class="btn small ghost" onClick=${() => { setCheatOpen(false); setRulesOpen(true); }}>${t('cheat.openRules', 'Open the rules')}</button>`}
            </div>`}
          </span>
          <span class="sound-wrap">
            ${btn(muted || volume === 0 ? 'mute' : 'sound', t('play.volume', 'Volume'), () => setSoundOpen(!soundOpen), { 'aria-expanded': soundOpen })}
            ${soundOpen && html`<div class="sound-pop" role="group" aria-label=${t('play.volume', 'Volume')}>
              <div class="sound-row">
              <button class="btn icon" aria-label=${t('play.quieter', 'Quieter')} title=${t('play.quieter', 'Quieter') + ' (–)'} onClick=${actions.quieter}><span aria-hidden="true">–</span></button>
              <input type="range" min="0" max="100" step="5" value=${muted ? 0 : Math.round(volume * 100)} aria-label=${t('play.volume', 'Volume')}
                onInput=${(e) => actions.volume(Number(e.target.value) / 100)} />
              <button class="btn icon" aria-label=${t('play.louder', 'Louder')} title=${t('play.louder', 'Louder') + ' (+)'} onClick=${actions.louder}><span aria-hidden="true">+</span></button>
              <span class="mono tiny vol">${muted ? t('play.mutedShort', 'off') : `${Math.round(volume * 100)} %`}</span>
              ${btn(muted ? 'sound' : 'mute', muted ? t('play.unmute', 'Sound on') : t('play.mute', 'Mute') + ' (M)', actions.mute)}
              </div>
              <label class="turbo-audio" title=${t('play.turboAudioHint', 'What you hear while fast-forwarding. “Music continues” loops the music recorded at normal speed – sound effects stay silent.')}>
                <span class="tiny">${t('play.turboAudio', 'Turbo audio')}</span>
                <select value=${turboAudio} onChange=${(e) => actions.turboAudio(e.target.value)}>
                  <option value="music">${t('play.turboAudioMusic', 'Music continues')}</option>
                  <option value="mute">${t('play.turboAudioMute', 'Mute')}</option>
                  <option value="original">${t('play.turboAudioOriginal', 'Sped-up original')}</option>
                  <option value="plain" title=${t('play.turboAudioPlainHint', 'The emulator’s sound only – no recording, no mixer. Try it if the sound crackles.')}>${t('play.turboAudioPlain', 'Plain (no extra processing)')}</option>
                </select>
              </label>
              <button class="btn small ghost diag-btn" title=${t('play.diagHint', 'Saves what souldew recorded about the music and live tracking this session – attach the file to a bug report. No ROM, save or invite data.')}
                onClick=${() => saveDiagnostics({ turboAudio, speed: speed === MAX ? 'max' : speed, reach, steps: steps.map((x) => (x === MAX ? 'max' : x)), volume, perf: emu()?.perf?.() ?? null, audioGraph: emu()?.audioGraph?.() ?? null })}><${Icon} name="save" size=${14} />${t('play.diag', 'Save diagnostics')}</button>
            </div>`}
          </span>
          ${btn(fs ? 'shrink' : 'full', (fs ? t('play.exitFullscreen', 'Leave fullscreen') : t('keys.fullscreen', 'Fullscreen game')) + ' (F)', actions.fullscreen)}
        </div>
        ${slow && mode === 'full' && html`<${SlowNotice} slow=${slow} isDs=${isDs} onClose=${() => { setSlow(null); focusGame(); }} />`}
        ${statesOpen && mode === 'full' && html`<${StatePanel} id=${target.stateId} core=${core} gen=${GEN[target.system]} version=${statesVer} selected=${sel}
          onClose=${closeStates} onSave=${(n) => actions.quicksave(n)} onLoad=${(n) => { setStatesOpen(false); actions.quickload(n); }} />`}
      </div>
      <aside class="session-side">
        ${panelSide === 'right' && battlePanel}
        <section class="screen stack" style="gap:8px">
          <div class="row"><${Led} on=${liveState.status === 'live'} color="green" blink=${liveState.status === 'searching' && phase === 'running'} />
            <b class="px">${names ? names[me].name : t('play.liveOn', 'Live tracking')}</b>
            <span class="tiny faint grow">${liveState.status === 'live' ? (names ? t('play.liveOn', 'Live tracking') : t('board.liveNow', 'live')) : liveState.status === 'unsupported' ? t('play.liveUnsupported', 'No live data for this game') : liveState.status === 'hack' ? t('play.liveHack', 'Not supported for this hack yet') : t('play.liveSearching', 'Looking for your team …')}</span>
            ${isRun && names && others.map((s) => {
              const on = !!onlineSlots?.has(s);
              const seen = live(doc, s);
              return html`<${Led} on=${on} color="green" /><b class="px">${names[s]?.name || s.toUpperCase()}</b>${others.length === 1
                && html`<span class="tiny faint">${on ? t('board.liveNow', 'live') : seen ? ago(seen.at) : t('board.offline', 'offline')}</span>`}`;
            })}</div>
          ${liveState.status === 'unsupported' && html`<span class="small muted">${isRun
            ? t('play.liveUnsupportedRun', 'This ROM isn’t in the memory table (other language or a hack with a changed layout). The run still works – enter catches by hand.')
            : t('play.liveNoneSolo', 'Live tracking reads Pokémon games – this one plays without it.')}</span>`}
          ${liveState.status === 'hack' && html`<span class="small muted">${isRun
            ? t('play.liveHackRun', 'This ROM hack runs on an expanded engine (new Pokémon numbers and a different memory layout) that souldew can’t read reliably yet – so it shows nothing rather than wrong Pokémon. The run still works: enter catches by hand.')
            : t('play.liveHackSolo', 'This ROM hack runs on an expanded engine (new Pokémon numbers and a different memory layout) that souldew can’t read reliably yet – so it shows nothing rather than wrong Pokémon.')}</span>`}
          ${isRun && names
            ? html`<${LinkedPairs} mine=${myParty} gen=${GEN[target.system]} compact=${!!battle?.enemy} />`
            : liveState.status !== 'unsupported' && liveState.status !== 'hack' && html`<${PartyGrid} party=${myParty} gen=${GEN[target.system]} compact accent="var(--p1)" label=${t('play.yourTeam', 'Your team')} />`}
        </section>
        ${isRun && names && !solo && mode === 'full' && html`<div class="side-partner"><${PartnerScreen} link=${link} system=${target.system} /></div>`}
      </aside>
    </div>
    ${inserting && html`<${CartInsert} target=${target} color=${game?.color} sound=${status?.config?.sounds !== false}
      onDone=${() => setInserting(false)} />`}
    <${RulesDrawer} open=${rulesOpen && mode === 'full'} onClose=${() => { setRulesOpen(false); focusGame(); }} RulesTab=${RulesTab} />
    ${mode === 'mini' && html`<button class="mini-open" onClick=${(e) => { e.currentTarget.blur(); actions.expand(); }} aria-label=${t('play.backToGameNamed', 'Back to the game: {name}', { name: target.label })}>
      <span class="mini-open-label"><${Icon} name="play" size=${14} />${t('play.backToGame', 'Back to the game')}</span></button>`}
  </div>`;
}

/**
 * The game runs clearly below full speed at 1× on this computer (lib/slowdown.mjs): how fast it really runs, why it
 * stutters and crackles, and what helps – the melonDS app for DS games, another graphics backend, power settings.
 */
function SlowNotice({ slow, isDs, onClose }) {
  const { navigate, status } = useApp();
  const backend = GPU_LABELS()[status?.config?.gpuBackend || 'auto'] || status?.config?.gpuBackend;
  const melon = status?.emulators?.melonds;
  const tip = {
    external: melon?.installed
      ? t('play.slowExternalReady', 'Play with the melonDS app (installed): it runs DS games at full speed on much weaker computers. Pick it under Settings › Emulators – your run syncs on every in-game save.')
      : t('play.slowExternal', 'Play with the melonDS app: it runs DS games at full speed on much weaker computers. Settings › Emulators installs it with one click – your run syncs on every in-game save.'),
    graphics: t('play.slowGraphics', 'Try another graphics backend in Settings › General (now: {backend}) – on some PCs the emulator only runs smoothly with one of them.', { backend }),
    power: t('play.slowPower', 'On a laptop: plug it in and choose the best-performance power mode. Close other programs that keep the computer busy.'),
  };
  const pct = Math.round((slow.reached || 0) * 100);
  return html`<div class="note slow-note" role="status">
    <div class="row nowrap slow-head"><${Icon} name="signal" size=${16} /><b class="grow">${t('play.slowTitle', 'This computer runs the game at only about {pct} % of its speed', { pct })}</b>
      <button class="btn icon ghost" title=${t('common.close', 'Close')} aria-label=${t('common.close', 'Close')} onClick=${onClose}><${Icon} name="close" size=${14} /></button></div>
    <span class="small">${isDs ? t('play.slowWhyDs', 'That’s why it stutters and the sound crackles. The built-in emulator runs the whole DS on one processor core and can’t go faster here – your computer is the limit, not a setting.')
      : t('play.slowWhy', 'That’s why it stutters and the sound crackles. The built-in emulator runs the console on one processor core and can’t go faster here.')}</span>
    <ul class="small slow-tips">${slow.tips.map((k) => html`<li>${tip[k]}</li>`)}</ul>
    <div class="row">${(slow.tips.includes('external') || slow.tips.includes('graphics')) && html`<button class="btn small" onClick=${() => navigate('settings')}><${Icon} name="gear" size=${14} />${t('play.slowSettings', 'Open Settings')}</button>`}
      <button class="btn small ghost" onClick=${onClose}>${t('play.slowOk', 'Got it')}</button></div>
  </div>`;
}

/**
 * "Wild X not caught – mark an area as spent?" – a question over the game that never stops it. Offers the open
 * areas; in games without a curated route list also every other place of the game (an area there only exists
 * once someone caught in it) and, as a last resort, a name of your own.
 */
function MissedPrompt({ missed, onDone }) {
  const { doc, manifest, me, runData } = useApp();
  const gen = genOfRun(manifest, runData);
  const areas = doc && manifest ? openAreas(doc, manifest, me).filter((a) => a.key !== 'starter') : [];
  const known = new Set(doc ? Object.keys(doc.scan('area:')) : []);
  const places = manifest ? locationChoices(manifest, gen).filter((l) => !known.has(`m${gen}-${l.id}`)) : []; // table order = roughly the order you travel
  const own = !profileOf(manifest).curated;
  const [area, setArea] = useState(areas[0]?.key || (places[0] ? `loc:${places[0].id}` : own ? 'new' : ''));
  const [name, setName] = useState('');
  if (!areas.length && !places.length && !own) return null;
  const mark = () => {
    let key = area;
    if (area.startsWith('loc:')) key = areaForCatch(doc, manifest, gen, +area.slice(4));
    else if (area === 'new') {
      key = `custom-${Date.now().toString(36)}`;
      doc.set(`area:${key}`, { name: name.trim(), order: Date.now() });
    }
    markMissed(doc, manifest, key, me, { species: missed.species, by: me });
    onDone();
  };
  return html`<div class="screen-confirm" role="group" aria-live="polite" aria-label=${t('play.missedAria', 'Missed encounter')}>
    <span>${t('play.missedAsk', 'Wild {species} not caught – mark an area as spent?', { species: speciesName(missed.species) })}</span>
    <select value=${area} aria-label=${t('play.missedArea', 'Area')} onChange=${(e) => setArea(e.target.value)}>
      ${areas.length > 0 && html`<optgroup label=${t('play.missedOpen', 'Open areas')}>${areas.map((a) => html`<option value=${a.key}>${a.name}</option>`)}</optgroup>`}
      ${places.length > 0 && html`<optgroup label=${t('play.missedPlaces', 'Other places in the game')}>${places.map((l) => html`<option value=${`loc:${l.id}`}>${l.name}</option>`)}</optgroup>`}
      ${own && html`<option value="new">${t('play.missedNew', 'Another area…')}</option>`}
    </select>
    ${area === 'new' && html`<input type="text" maxLength="40" value=${name} placeholder=${t('play.missedName', 'Name of the area')} aria-label=${t('play.missedName', 'Name of the area')}
      onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && name.trim()) mark(); }} />`}
    <button class="btn small primary" disabled=${!area || (area === 'new' && !name.trim())} onClick=${mark}>${t('play.missedMark', 'Mark as spent')}</button>
    <button class="btn small ghost" onClick=${onDone}>${t('play.missedNo', 'No – doesn’t count')}</button>
  </div>`;
}

/** The mGBA script: where it is, how to load it, and what the bridge sees right now (polled – SSE can be missed). */
function ScriptBridge({ fresh }) {
  const { status, toast, liveInfo } = useApp();
  const [live, setLive] = useState(status.live || null);
  useEffect(() => {
    let stop = false;
    const poll = () => api.get('/api/live').then((s) => !stop && setLive(s)).catch(() => {});
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);
  useEffect(() => {
    if (liveInfo?.status) setLive(liveInfo.status);
  }, [liveInfo?.status]);
  const { key, outdated, game } = bridgeState(live, { fresh });
  const path = live?.script || status.live?.script || '';
  const gameName = game ? [game.title, game.code && `(${game.code})`].filter(Boolean).join(' ') : '';
  const text = {
    live: () => t('ext.liveOn', 'Live data is coming in'),
    noPort: () => t('ext.liveNoPort', 'The live bridge couldn’t start: its network ports on this computer are taken. Restart souldew.'),
    unsupported: () => t('ext.liveUnsupported', 'The script is connected, but souldew has no live data for {game}.', { game: gameName || '?' }),
    connected: () => t('ext.liveConnected', 'Script connected – waiting for game data …'),
    rejected: () => t('ext.liveRejected', 'mGBA tried to connect with an outdated script or one from another souldew installation. In mGBA’s scripting window choose File › Reset, then load the file above again.'),
    waiting: () => t('ext.liveNoConnection', 'No connection yet – load the script in mGBA (see above). It connects as soon as a game runs.'),
  }[key]();
  const color = key === 'live' || key === 'connected' ? 'green' : 'amber';
  return html`<div class="stack-s">
    <p class="small muted">${t('ext.scriptSteps', 'For live data: in mGBA open Tools › Scripting…, then File › Load script… and choose this file. mGBA doesn’t load it by itself – after restarting mGBA, load it again (File › Load recent script).')}</p>
    <div class="row"><span class="code grow" title=${path}>${path}</span>
      <button class="btn small ghost" onClick=${() => { copy(path); toast({ kind: 'ok', title: t('common.copied', 'Copied'), text: t('ext.pathCopied', 'Paste the path into the file name field of mGBA’s “Load script” window.') }); }}>${t('common.copy', 'Copy')}</button>
      ${window.sls && html`<button class="btn small ghost" onClick=${() => api.post('/api/live/reveal', {}).catch((err) => toast({ kind: 'death', title: 'mGBA', text: err.message }))}>
        <${Icon} name="folder" size=${14} />${IS_MAC ? t('ext.revealMac', 'Show in Finder') : IS_WIN ? t('ext.revealPc', 'Show in Explorer') : t('ext.revealLinux', 'Show in the file manager')}</button>`}</div>
    <div class="row nowrap" role="status" aria-live="polite"><${Led} on=${key !== 'waiting'} color=${color} blink=${key === 'connected'} /><span class="small grow">${text}</span></div>
    ${outdated && key !== 'rejected' && html`<p class="tiny faint">${t('ext.liveOutdated', 'mGBA is running an older version of the script. It works, but the new one reconnects on its own and explains problems in mGBA’s scripting window: choose File › Reset there, then load the file again.')}</p>`}
  </div>`;
}

function ExternalPlay({ target, emu }) {
  const { status, toast, liveInfo, applySnap, manifest, me, route } = useApp();
  const e = status.emulators[emu];
  const isRun = target.kind === 'run';
  const fresh = !!(liveInfo?.at && Date.now() - liveInfo.at < 5000);
  // Re-render once the last frame gets stale, so the "live" LED goes off when frames stop.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!fresh) return;
    const id = setTimeout(() => setTick((n) => n + 1), liveInfo.at + 5000 - Date.now() + 50);
    return () => clearTimeout(id);
  }, [liveInfo?.at, fresh]);
  const [launching, setLaunching] = useState(false); // a double click must not start the emulator twice
  const launch = async () => {
    setLaunching(true);
    try {
      // ROM hacks: the server launches the patched copy (patchId), not the vanilla base ROM
      await api.post(`/api/emulators/${emu}/launch`, isRun ? { runId: manifest.id, slot: me } : { romId: route.params.rom, patchId: route.params.patch || undefined });
      toast({ kind: 'ok', title: e.name, text: t('lib.launched', 'Starting …') });
    } catch (err) {
      toast({ kind: 'death', title: e.name, text: err.message });
    } finally {
      setLaunching(false);
    }
  };
  // Feed mGBA bridge frames into the run. The reader state lives across frames like in the built-in loop: Gen 3
  // tells a Bad Egg from a torn read, Gen 1/2 a finished party rewrite from one in progress, only by comparing reads.
  const readState = useRef({});
  useEffect(() => {
    if (!liveInfo?.regions || !isRun) return;
    (async () => {
      const { T, addresses } = await liveTables();
      const { regionReader } = await import('/shared/live/parse.mjs');
      const entry = findEntry(addresses, liveInfo.game);
      if (readState.current.game !== entry?.id) readState.current = { game: entry?.id };
      // GBA: the ROM's own species table – a hack's other Pokémon; an expanded engine isn't read at all (see the loop above)
      let sp = null;
      if (entry?.gen === 3 && target.rom) {
        await loadRomLocations(target.rom);
        sp = romSpeciesNow();
        if (sp?.engine === 'expanded') return;
      }
      const res = entry && readLiveParty(entry, regionReader(liveInfo.regions), sp ? T.withSpecies(sp) : T, readState.current);
      if (res?.party) applySnap({ source: 'live', party: res.party, game: entry.id });
    })().catch((err) => console.warn('live frame', err));
  }, [liveInfo?.at]);
  return html`<div class="stack-l">
    <div class="topbar"><h1>${target.label}</h1></div>
    <section class="panel stack">
      <h2>${t('ext.title', 'Playing with {emu}', { emu: e.name })}</h2>
      <div><button class="btn primary big" disabled=${launching} onClick=${launch}><${Icon} name="play" size=${16} />${t('ext.launch', 'Launch {emu}', { emu: e.name })}</button></div>
      ${e.live === 'script'
        ? html`<${ScriptBridge} fresh=${fresh} />`
        : html`<p class="small muted">${t('ext.saveText', '{emu} can’t share live data. Save in the game regularly – souldew reads the save file next to the ROM after every in-game save.', { emu: e.name })}</p>`}
      <p class="tiny faint">${t('ext.switch', 'You can switch back to the built-in emulator in the settings.')}</p>
    </section>
  </div>`;
}
