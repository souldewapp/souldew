// Stream page: the streamer-mode switch and the overlay builder. Every widget is its own OBS browser source
// (web/overlay.html): pick the options, watch the live preview, then drag the tile into OBS (the source gets the
// right size from layer-width/-height) or copy its URL. "Test alert" reaches every open overlay, OBS included.
import { html, useEffect, useRef, useState } from '/vendor/htm-preact.mjs';
import { useApp, copy, Led, openExternal } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, currentLang } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { players as getPlayers, slotsOf, runMode } from '../lib/run.mjs';
import { overlayUrl } from '/shared/overlay.mjs';
import { useStreamer, setStreamer } from '../lib/streamer.mjs';
import { LINKS } from '../lib/links.mjs';

const ls = {
  get(k, d) {
    try {
      const v = JSON.parse(localStorage.getItem(k));
      return v && typeof v === 'object' ? v : d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // private mode – the choice holds for this visit
    }
  },
};

// [w, h] of the browser source for n players – what the widget needs at scale 1 with the biggest (DS) sprites and
// long names; the team strip grows a row's height for HP bars (9 px) and nicknames (19 px) when they are on
const SIZES = {
  team: (n, v, { nick, hp }) => (v ? [110 + n * 112, 690 + (hp ? 50 : 0) + (nick ? 110 : 0)]
    : [210 + 6 * 108, (n > 1 ? 280 + (n - 2) * 96 : 160) + n * ((hp ? 9 : 0) + (nick ? 19 : 0))]),
  card: (n, v) => (v ? [560, 470] : [900, 310]),
  counters: (n, v) => (v ? [300, 340] : [760 + n * 70, 120]),
  where: (n, v) => (v ? [400, 30 + n * 140] : [40 + n * 340, 180]),
  alerts: () => [960, 440],
  stats: (n, v) => (v ? [340, 340] : [880 + n * 130, 90]),
};

// Every overlay holds one open connection, and a browser (OBS's too, shared by all its sources) keeps at most six
// per server address – so half of the widgets use 127.0.0.1 instead of localhost (the same app, twice the room).
const ALT_HOST = ['card', 'where', 'stats'];
const obsOrigin = (id) => (ALT_HOST.includes(id) && location.hostname === 'localhost' ? `${location.protocol}//127.0.0.1:${location.port}` : location.origin);

const widgets = () => [
  { id: 'team', icon: 'link', title: t('stream.wTeam', 'Team strip'), text: t('stream.wTeamText', 'Every team side by side – one column per linked group, with level, HP and status. Dead groups turn grey.'), layout: true, players: 'many', toggles: ['nick', 'hp', 'area'] },
  { id: 'card', icon: 'user', title: t('stream.wCard', 'Team card'), text: t('stream.wCardText', 'One player’s team in detail: nicknames, levels, HP, status, badges and play time.'), layout: true, players: 'one', toggles: ['hp'] },
  { id: 'counters', icon: 'heart', title: t('stream.wCounters', 'Counters'), text: t('stream.wCountersText', 'Alive, in the graveyard, caught and badges – the numbers pop when they change.'), layout: true, players: 'many' },
  { id: 'where', icon: 'map', title: t('stream.wWhere', 'You are here'), text: t('stream.wWhereText', 'The route or town each player is in right now, and the battle they are fighting.'), layout: true, players: 'many' },
  { id: 'alerts', icon: 'bell', title: t('stream.wAlerts', 'Alerts'), text: t('stream.wAlertsText', 'Deaths, catches, badges, evolutions and every 10th level pop up for a few seconds – with sound if you like.'), alerts: true },
  { id: 'stats', icon: 'clock', title: t('stream.wStats', 'Stats bar'), text: t('stream.wStatsText', 'Run name, play time, badges and the counts in one slim line – for the bottom of the screen.'), layout: true, players: 'many' },
];

/** The stream settings the server keeps (GET/POST /api/stream): API address and token. */
function useStreamSettings() {
  const [st, setSt] = useState(null);
  useEffect(() => {
    let stop = false;
    const tick = () => api.get('/api/stream').then((r) => !stop && setSt(r)).catch(() => {});
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);
  const save = async (patch) => {
    setSt((cur) => (cur ? { ...cur, ...(patch.token === undefined ? patch : {}) } : cur));
    try {
      setSt(await api.post('/api/stream', patch));
    } catch {
      // the next poll shows the real state
    }
  };
  return [st, save];
}

const TOGGLES = () => ({
  nick: t('stream.optNick', 'Nicknames'),
  hp: t('stream.optHp', 'HP bars'),
  area: t('stream.optArea', 'Area names'),
});

/** A segmented control (the app's .seg). */
function Seg({ value, options, onChange, label }) {
  return html`<div class="seg" role="radiogroup" aria-label=${label}>${options.map(([v, l]) => html`<button type="button" role="radio" aria-checked=${value === v} class=${value === v ? 'on' : ''} onClick=${() => onChange(v)}>${l}</button>`)}</div>`;
}

/**
 * How tall each widget's preview stage is – fixed per widget, whatever its layout, players or data: the card
 * never jumps when an option changes, and the overlay is scaled to fit inside it (both ways), centred.
 */
const STAGE = { team: 300, card: 240, counters: 170, where: 170, alerts: 240, stats: 170 };

/** The overlay itself in a scaled-down frame – the same page OBS shows, live. */
function Preview({ src, size, bg, frameRef, stage }) {
  const box = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    // whole pixels only, so sub-pixel layout noise can't feed back into a new scale
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = width ? Math.min(1, width / size[0], stage / size[1]) : 0;
  const left = Math.max(0, Math.round((width - size[0] * scale) / 2));
  const top = Math.max(0, Math.round((stage - size[1] * scale) / 2));
  return html`<div class=${`ov-preview bg-${bg}`} ref=${box} style=${`height:${stage}px`}>
    <iframe ref=${frameRef} src=${src} title=${t('stream.preview', 'Preview')} tabindex="-1" loading="lazy"
      style=${`width:${size[0]}px;height:${size[1]}px;transform:translate(${left}px,${top}px) scale(${scale.toFixed(4)});${scale ? '' : 'visibility:hidden'}`}></iframe>
  </div>`;
}

function WidgetCard({ w, run, slots, names, global, live, onTest }) {
  const key = `sl-stream-${w.id}`;
  const [o, setO] = useState(() => ls.get(key, {}));
  const set = (patch) => {
    const next = { ...o, ...patch };
    setO(next);
    ls.set(key, next);
  };
  const frame = useRef(null);
  const v = o.layout === 'v';
  const chosen = w.players === 'one' ? [slots.includes(o.p) ? o.p : slots[0]] : (o.p || []).filter((s) => slots.includes(s));
  const n = (w.players === 'one' ? 1 : chosen.length || slots.length);
  const showNick = o.nick ?? n <= 2; // the overlay's own default: nicknames for one or two players
  const size = (SIZES[w.id] || SIZES.team)(n, v, { nick: w.toggles?.includes('nick') && showNick, hp: o.hp !== false });
  const opts = {
    w: w.id, layout: v ? 'v' : null, p: chosen.length && (w.players === 'one' || chosen.length < slots.length) ? chosen.join(',') : null,
    theme: global.theme !== 'glass' ? global.theme : null, scale: global.scale !== 1 ? global.scale : null, lang: global.lang || null,
    nick: w.toggles?.includes('nick') && o.nick !== undefined ? (o.nick ? 1 : 0) : null,
    hp: w.toggles?.includes('hp') && o.hp === false ? 0 : null,
    area: w.toggles?.includes('area') && o.area === false ? 0 : null,
    sound: w.alerts && o.sound ? 1 : null, pos: w.alerts && o.pos === 'bottom' ? 'bottom' : null,
  };
  const scaled = [size[0] * global.scale, size[1] * global.scale];
  const url = overlayUrl(obsOrigin(w.id), run.id, opts, scaled, `souldew · ${w.title}`);
  const preview = overlayUrl(location.origin, run.id, { ...opts, preview: 1, scale: null });
  const toggles = TOGGLES();
  const onDrag = (e) => {
    // OBS takes a dropped link as a new browser source; layer-width/-height in the URL give it its size
    e.dataTransfer.setData('text/uri-list', url);
    e.dataTransfer.setData('text/plain', url);
    e.dataTransfer.effectAllowed = 'copy';
  };
  return html`<section class="panel ov-card">
    <div class="ov-head">
      <span class="ov-ic"><${Icon} name=${w.icon} size=${18} /></span>
      <div class="stack-s" style="gap:2px;min-width:0"><h3>${w.title}</h3><p class="small muted">${w.text}</p></div>
      ${live > 0 && html`<span class="chip ok ov-live" title=${t('stream.inObsHint', 'An overlay with this widget is open outside the app – in OBS or a browser.')}><${Led} on color="green" />${t('stream.inObs', 'live in OBS')}${live > 1 ? ` ×${live}` : ''}</span>`}
    </div>
    <${Preview} src=${preview} size=${size} bg=${global.bg} frameRef=${frame} stage=${STAGE[w.id] || 240} />
    <div class="ov-opts">
      ${w.layout && html`<${Seg} label=${t('stream.layout', 'Layout')} value=${v ? 'v' : 'h'} onChange=${(x) => set({ layout: x })}
        options=${[['h', t('stream.horizontal', 'Horizontal')], ['v', t('stream.vertical', 'Vertical')]]} />`}
      ${w.players === 'one' && slots.length > 1 && html`<${Seg} label=${t('stream.player', 'Player')} value=${chosen[0]} onChange=${(x) => set({ p: x })}
        options=${slots.map((s) => [s, names[s]?.name || s.toUpperCase()])} />`}
      ${w.players === 'many' && slots.length > 1 && html`<div class="ov-who" role="group" aria-label=${t('stream.players', 'Players')}>
        ${slots.map((s) => {
          const onNow = !chosen.length || chosen.includes(s);
          return html`<button type="button" class=${`ov-pl ${onNow ? 'on' : ''}`} style=${`--acc:var(--${s})`} aria-pressed=${onNow}
            onClick=${() => {
              const cur = chosen.length ? chosen : slots;
              const next = onNow ? cur.filter((x) => x !== s) : [...cur, s];
              set({ p: next.length && next.length < slots.length ? slots.filter((x) => next.includes(x)) : [] });
            }}>${names[s]?.name || s.toUpperCase()}</button>`;
        })}</div>`}
      ${(w.toggles || []).map((k) => {
        const val = k === 'nick' ? showNick : o[k] !== false;
        return html`<label class="check ov-tg"><input type="checkbox" checked=${val} onChange=${(e) => set({ [k]: e.target.checked })} /><span>${toggles[k]}</span></label>`;
      })}
      ${w.alerts && html`<${Seg} label=${t('stream.position', 'Position')} value=${o.pos === 'bottom' ? 'bottom' : 'top'} onChange=${(x) => set({ pos: x })}
          options=${[['top', t('stream.top', 'Top')], ['bottom', t('stream.bottom', 'Bottom')]]} />
        <label class="check ov-tg"><input type="checkbox" checked=${!!o.sound} onChange=${(e) => set({ sound: e.target.checked })} /><span>${t('stream.sound', 'Sound')}</span></label>`}
    </div>
    ${w.alerts && html`<div class="ov-tests"><span class="small muted">${t('stream.test', 'Test alert:')}</span>
      ${[['death', t('stream.tDeath', 'Death')], ['catch', t('stream.tCatch', 'Catch')], ['badge', t('stream.tBadge', 'Badge')], ['level', t('stream.tLevel', 'Level')], ['evolve', t('stream.tEvolve', 'Evolution')], ['run', t('stream.tRun', 'Run over')]]
        .map(([type, l]) => html`<button type="button" class="btn small ghost" onClick=${() => onTest(type, frame.current)}>${l}</button>`)}</div>`}
    <div class="ov-url">
      <a class="ov-drag" href=${url} draggable="true" onDragStart=${onDrag} onClick=${(e) => e.preventDefault()}
        title=${t('stream.dragHint', 'Drag into OBS: it becomes a browser source of the right size')}><${Icon} name="move" size=${16} />${t('stream.drag', 'Drag into OBS')}</a>
      <span class="code sm-ok ellipsis grow" title=${url}>${url}</span>
      <button type="button" class="btn small" onClick=${() => copy(url)}>${t('common.copy', 'Copy')}</button>
    </div>
    <p class="tiny faint">${t('stream.size', 'Browser source size: {w} × {h}', { w: Math.round(scaled[0]), h: Math.round(scaled[1]) })}</p>
  </section>`;
}

/**
 * Pokélink themes: the bridge (server/lib/pokelink.mjs) speaks the socket.io protocol Pokélink's browser sources
 * use, so an existing theme shows souldew's teams – one "user" per player, by name or slot.
 */
function PokelinkCard({ run, slots, names }) {
  const [st, setSt] = useState(null);
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stop = false;
    const tick = () => api.get('/api/pokelink').then((r) => {
      if (stop) return;
      setSt(r);
      setPort((p) => p || String(r.port));
    }).catch(() => {});
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);
  // the bridge follows the run picked on this page
  useEffect(() => {
    if (st?.running && st.run !== run.id) api.post('/api/pokelink', { run: run.id }).then(setSt).catch(() => {});
  }, [run.id, st?.running, st?.run]);
  const save = async (patch) => {
    setBusy(true);
    try {
      setSt(await api.post('/api/pokelink', { run: run.id, port: Number(port) || undefined, ...patch }));
    } catch {
      // the next poll shows the real state
    } finally {
      setBusy(false);
    }
  };
  const on = !!st?.enabled;
  const p = st?.running ? st.port : Number(port) || st?.port || 3000;
  const param = (user) => `?user=${encodeURIComponent(user)}&server=http://127.0.0.1&port=${p}`;
  return html`<section class="panel stack pl-card">
    <div class="ov-head">
      <span class="ov-ic"><${Icon} name="link" size=${18} /></span>
      <div class="stack-s grow" style="gap:2px;min-width:0"><h3>${t('stream.pl', 'Pokélink themes')}</h3>
        <p class="small muted">${t('stream.plText', 'Already have a Pokélink theme you like? souldew can feed it: switch the bridge on, then open the theme with one of the endings below instead of its own ?user=… – in OBS just like before.')}</p></div>
      ${st?.running && st.clients > 0 && html`<span class="chip ok ov-live"><${Led} on color="green" />${t('stream.plClients', 'one theme connected|{count} themes connected', { count: st.clients })}</span>`}
    </div>
    <div class="row wrap" style="gap:8px 14px">
      <label class="check ov-tg"><input type="checkbox" checked=${on} disabled=${busy || !st} onChange=${(e) => save({ enabled: e.target.checked })} />
        <span>${t('stream.plOn', 'Pokélink bridge')}</span></label>
      <label class="row tight small">${t('stream.plPort', 'Port')}
        <input class="num-in" type="number" min="1024" max="65535" value=${port} disabled=${busy} style="width:86px"
          onInput=${(e) => setPort(e.target.value)} onChange=${() => on && save({})} /></label>
      <span class=${`small ${st?.error ? 'warn-text' : 'muted'}`}>${st?.error === 'portInUse' ? t('stream.plBusy', 'Port {port} is taken – is Pokélink itself open? Close it or pick another port.', { port: p })
        : st?.error ? t('stream.plFail', 'The bridge didn’t start.') : st?.running ? t('stream.plRunning', 'Running on 127.0.0.1:{port}', { port: st.port }) : on ? '' : t('stream.plOffHint', 'Off – nothing listens until you switch it on.')}</span>
    </div>
    ${on && html`<div class="stack-s">${slots.map((s) => {
      const user = names[s]?.name || s;
      return html`<div class="ov-url"><span class="pl-who" style=${`--acc:var(--${s})`}>${user}</span>
        <span class="code sm-ok ellipsis grow" title=${param(user)}>${param(user)}</span>
        <button type="button" class="btn small" onClick=${() => copy(param(user))}>${t('common.copy', 'Copy')}</button></div>`;
    })}</div>
      <p class="tiny faint">${t('stream.plNote', 'Instead of the name, user=p1 … p4 works too. Themes show what Pokélink’s data has: team, levels, HP, status, items, moves and badges.')}</p>`}
  </section>`;
}

/**
 * The open stream API (server/lib/streamapi.mjs, docs/STREAM_API.md): souldew's data and sprites for streamers who
 * build their own layout – the address, a copy button, the docs and the optional token.
 */
function ApiCard({ run, stream, saveStream }) {
  const base = stream?.base || `http://127.0.0.1:${location.port}/api/v1`;
  const tok = stream?.token ? `?token=${stream.token}` : '';
  const rows = [
    [t('stream.apiState', 'Everything about the run'), `${base}/runs/current${tok}`],
    [t('stream.apiEvents', 'Live events (SSE)'), `${base}/runs/current/events${tok}`],
    [t('stream.apiSprite', 'A sprite'), `${base}/sprites/gen4/front/150.png`],
  ];
  return html`<section class="panel stack api-card">
    <div class="ov-head">
      <span class="ov-ic"><${Icon} name="signal" size=${18} /></span>
      <div class="stack-s grow" style="gap:2px;min-width:0"><h3>${t('stream.api', 'Open API – build your own layout')}</h3>
        <p class="small muted">${t('stream.apiText', 'Want your own design instead of souldew’s? Your browser sources can read the run as JSON – teams, links, graveyard, encounters, locations – get every catch, death and level-up live, and load the same sprites the app shows.')}</p></div>
      ${stream?.clients > 0 && html`<span class="chip ok ov-live"><${Led} on color="green" />${t('stream.apiClients', 'one layout connected|{count} layouts connected', { count: stream.clients })}</span>`}
    </div>
    <div class="ov-url api-base">
      <span class="api-k">${t('stream.apiBase', 'Address')}</span>
      <span class="code sm-ok ellipsis grow" title=${base}>${base}</span>
      <button type="button" class="btn small" onClick=${() => copy(base)}>${t('common.copy', 'Copy')}</button>
      <button type="button" class="btn small ghost" onClick=${() => openExternal(stream?.docs || LINKS.streamApiDocs)}><${Icon} name="external" size=${14} />${t('stream.apiDocs', 'Docs & examples')}</button>
    </div>
    <div class="api-rows">${rows.map(([label, u]) => html`<div class="ov-url"><span class="api-k small muted">${label}</span>
      <span class=${`code ellipsis grow ${tok ? '' : 'sm-ok'}`} title=${u}>${u.replace(base, '…')}</span>
      <button type="button" class="btn small ghost" onClick=${() => copy(u)}>${t('common.copy', 'Copy')}</button></div>`)}</div>
    <div class="row wrap api-token" style="gap:8px 14px">
      <label class="check ov-tg"><input type="checkbox" checked=${!!stream?.token} disabled=${!stream} onChange=${(e) => saveStream({ token: e.target.checked ? 'new' : '' })} />
        <span>${t('stream.apiToken', 'Require a token')}</span></label>
      ${stream?.token ? html`<span class="code ellipsis api-tok" title=${t('stream.apiTokenHint', 'Hidden in streamer mode')}>${stream.token}</span>
        <button type="button" class="btn small" onClick=${() => copy(stream.token)}>${t('common.copy', 'Copy')}</button>
        <button type="button" class="btn small ghost" onClick=${() => saveStream({ token: 'new' })}>${t('stream.apiNewToken', 'New token')}</button>`
        : html`<span class="small muted">${t('stream.apiOpen', 'Without a token, pages from this computer may read (OBS, files, localhost) – other websites can’t.')}</span>`}
    </div>
    <p class="tiny faint">${t('stream.apiSafe', 'Read-only and on this computer only (127.0.0.1): no ROMs, saves, file names, invite codes or spoilers. Run: {name}', { name: run.name })}</p>
  </section>`;
}

export function StreamView() {
  const { status, manifest, doc, toast, navigate } = useApp();
  const streamer = useStreamer();
  const runs = status?.runs || [];
  const [runId, setRunId] = useState(() => manifest?.id || ls.get('sl-stream-run', {}).id || runs[0]?.id || null);
  const run = (manifest?.id === runId ? manifest : null) || runs.find((r) => r.id === runId) || manifest || runs[0] || null;
  const [global, setGlobalState] = useState(() => ({ theme: 'glass', scale: 1, lang: '', bg: 'game', ...ls.get('sl-stream-global', {}) }));
  const setGlobal = (patch) => {
    const next = { ...global, ...patch };
    setGlobalState(next);
    ls.set('sl-stream-global', next);
  };
  const [live, setLive] = useState({});
  const [stream, saveStream] = useStreamSettings();
  useEffect(() => {
    if (!run?.id) return undefined;
    let stop = false;
    const tick = () => api.get(`/api/runs/${run.id}/overlay/clients`).then((r) => !stop && setLive(r?.widgets || {})).catch(() => {});
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [run?.id]);

  const onTest = async (type, frame) => {
    // the preview shows it right away; the server passes it on to every overlay open in OBS
    frame?.contentWindow?.postMessage({ souldewTest: type }, location.origin);
    try {
      const r = await api.post(`/api/runs/${run.id}/overlay/test`, { type });
      toast({ kind: 'ok', title: t('stream.testSent', 'Test alert sent'),
        text: r.overlays ? t('stream.testObs', 'It shows in the preview and in one overlay outside the app.|It shows in the preview and in {count} overlays outside the app.', { count: r.overlays }) : t('stream.testNoObs', 'It shows in the preview. No alert overlay is open in OBS yet – add the Alerts widget there.') });
    } catch {
      // the preview has it anyway
    }
  };

  const switchCard = html`<section class=${`panel stream-switch ${streamer ? 'on' : ''}`}>
    <button type="button" class="sm-toggle" role="switch" aria-checked=${streamer} onClick=${() => setStreamer(!streamer)}>
      <span class="sm-knob"></span></button>
    <div class="stack-s" style="gap:4px;min-width:0">
      <h2>${t('stream.mode', 'Streamer mode')} <span class=${`onair ${streamer ? 'on' : ''}`}>${streamer ? t('stream.live', 'LIVE') : t('stream.off', 'off')}</span></h2>
      <p class="small muted">${streamer ? t('stream.modeOn', 'souldew is safe to show: everything below is covered on every page until you switch it off.')
        : t('stream.modeOff', 'Switch it on before you go live – souldew then covers what your viewers mustn’t see.')}</p>
      <ul class="sm-list">
        <li><${Icon} name="lock" size=${14} />${t('stream.hideCodes', 'Invite codes and invite files')}</li>
        <li><${Icon} name="eye" size=${14} />${t('stream.hideSpoiler', 'The randomizer’s spoilers')}</li>
        <li><${Icon} name="folder" size=${14} />${t('stream.hidePaths', 'Folders and file names')}</li>
        <li><${Icon} name="link" size=${14} />${t('stream.hideHook', 'Discord webhook')}</li>
      </ul>
    </div>
  </section>`;

  if (!run) {
    return html`<div class="stack-l"><div class="topbar"><h1>${t('nav.stream', 'Stream')}</h1></div>
      ${switchCard}
      <div class="panel empty-state"><${Icon} name="play" size=${56} /><h2>${t('stream.noRun', 'No run yet')}</h2>
        <p class="muted">${t('stream.noRunText', 'The overlays show a run live. Start a SoulLink or a Nuzlocke first.')}</p>
        <button class="btn primary" onClick=${() => navigate('soullink')}>${t('nav.soullink', 'SoulLink')}</button></div></div>`;
  }
  const slots = slotsOf(run);
  const names = manifest?.id === run.id && doc ? getPlayers(doc, manifest) : run.players || {};
  const shown = widgets().filter((w) => !(runMode(run) === 'nuzlocke' && w.id === 'card'));
  const anyLive = Object.values(live).reduce((a, b) => a + b, 0);
  return html`<div class="stack-l stream-page">
    <div class="topbar"><h1>${t('nav.stream', 'Stream')}</h1>
      ${anyLive > 0 && html`<span class="chip ok"><${Led} on color="green" />${t('stream.obsCount', 'one overlay live in OBS|{count} overlays live in OBS', { count: anyLive })}</span>`}</div>
    ${switchCard}
    <section class="panel stack">
      <div class="row wrap" style="gap:10px 16px">
        <h2 class="grow">${t('stream.overlays', 'Overlays for OBS')}</h2>
        ${runs.length > 1 && html`<label class="row tight small">${t('stream.run', 'Run')}
          <select value=${run.id} onChange=${(e) => { setRunId(e.target.value); ls.set('sl-stream-run', { id: e.target.value }); }}>
            ${runs.map((r) => html`<option value=${r.id}>${r.name}</option>`)}</select></label>`}
      </div>
      <ol class="small muted steps">
        <li>${t('stream.s1', 'Pick a widget and set it up – the preview is exactly what OBS shows, live.')}</li>
        <li>${t('stream.s2', 'Drag “Drag into OBS” onto your scene – OBS makes a browser source of the right size. Or copy the URL into a new browser source.')}</li>
        <li>${t('stream.s3', 'Keep souldew open while you stream: the overlays update the moment something happens.')}</li>
      </ol>
      <div class="row wrap ov-global">
        <${Seg} label=${t('stream.theme', 'Look')} value=${global.theme} onChange=${(x) => setGlobal({ theme: x })}
          options=${[['glass', t('stream.glass', 'Glass')], ['solid', t('stream.solid', 'Solid')], ['minimal', t('stream.minimal', 'Minimal')]]} />
        <${Seg} label=${t('stream.scale', 'Size')} value=${global.scale} onChange=${(x) => setGlobal({ scale: x })}
          options=${[[0.75, '75 %'], [1, '100 %'], [1.25, '125 %'], [1.5, '150 %']]} />
        <label class="row tight small">${t('stream.lang', 'Language')}
          <select value=${global.lang} onChange=${(e) => setGlobal({ lang: e.target.value })}>
            <option value="">${t('stream.langApp', 'Like the app ({lang})', { lang: currentLang().toUpperCase() })}</option>
            ${[['de', 'Deutsch'], ['en', 'English'], ['fr', 'Français'], ['es', 'Español'], ['it', 'Italiano']].map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select></label>
        <span class="spacer"></span>
        <${Seg} label=${t('stream.previewBg', 'Preview background')} value=${global.bg} onChange=${(x) => setGlobal({ bg: x })}
          options=${[['game', t('stream.bgGame', 'Bright game')], ['dark', t('stream.bgDark', 'Dark')]]} />
      </div>
    </section>
    <div class="ov-grid">
      ${shown.map((w) => html`<${WidgetCard} key=${`${run.id}-${w.id}`} w=${w} run=${run} slots=${slots} names=${names} global=${global} live=${live[w.id] || 0} onTest=${onTest} />`)}
    </div>
    <${PokelinkCard} run=${run} slots=${slots} names=${names} />
    <${ApiCard} run=${run} stream=${stream} saveStream=${saveStream} />
  </div>`;
}
