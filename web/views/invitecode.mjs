// Invite by code (protocol + threat model: lib/invitecode.mjs). HostCode shows the 6-digit code and the
// "… wants to join" prompt; JoinCode takes the code on the joining player's side and hands the received run pack
// (plus the host's "you are probably p3" hint) to the normal join flow. The invite file stays as the fallback.
// A run has up to 4 players: each code lets one person in, "New code" invites the next one.
import { html, useState, useEffect, useRef } from '/vendor/htm-preact.mjs';
import { useApp, copy, Led } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t } from '../lib/i18n.mjs';
import { api } from '../lib/api.mjs';
import { slotsOf, players as getPlayers } from '../lib/run.mjs';
import { CodeHost, joinWithCode, normalizeCode, formatCode, inviteCodeSupported, suggestSlot } from '../lib/invitecode.mjs';
import { isStreamer } from '../lib/streamer.mjs';

// One code per run, kept outside the component: closing the invite dialog doesn't kill a code somebody may
// be typing in right now. A request that comes in while nobody looks → toast.
const sessions = new Map(); // run id → { host, watchers: Set, toast, taken }
// Slots handed out by earlier codes in this app session: the player may not have built their game (or come
// online) yet, but the next code must not suggest the same slot again.
const handedOut = new Map(); // run id → Set of slots
// Closing or reloading the host's app: a partner waiting for "Allow" is told now instead of after ~15 s of silence.
if (typeof addEventListener === 'function') addEventListener('pagehide', () => { for (const s of sessions.values()) s.host.leave(); });

/**
 * Slots that have somebody, as far as this computer knows: us, whoever is or was online in this session,
 * whoever has data in the run (catches, team, live state), and slots given to earlier codes.
 */
export function takenSlots(manifest, { me, doc, linkStatus } = {}) {
  const slots = slotsOf(manifest);
  const taken = new Set([me, ...(handedOut.get(manifest.id) || [])]);
  for (const s of slots) {
    if (linkStatus?.partners?.[s] || doc?.get?.(`live:${s}`) || doc?.get?.(`party:${s}`)) taken.add(s);
  }
  for (const key of Object.keys(doc?.scan?.('enc:') || {})) taken.add(key.split(':').at(-1));
  return slots.filter((s) => taken.has(s));
}

function startSession(manifest, toast) {
  sessions.get(manifest.id)?.host.cancel();
  const s = { watchers: new Set(), toast, taken: () => [], online: () => null };
  s.host = new CodeHost({
    pack: manifest.pack,
    // asked on "Allow": the component keeps s.taken current while it is shown
    seat: (name) => {
      const taken = s.taken();
      return { slot: suggestSlot(manifest.pack?.players || manifest.players, taken, name, s.online()), taken };
    },
    onState: (st) => {
      if (st.phase === 'sending' && st.seat?.slot) {
        if (!handedOut.has(manifest.id)) handedOut.set(manifest.id, new Set());
        handedOut.get(manifest.id).add(st.seat.slot);
      }
      for (const fn of s.watchers) fn(st);
      if (st.phase === 'request' && !s.watchers.size) {
        s.toast?.({ kind: 'soul', title: t('code.toastTitle', '{name} wants to join', { name: st.request.name || t('code.someone', 'Someone') }),
          text: t('code.toastText', 'Open the invite (Connection page) to allow it.') });
      }
    },
  });
  sessions.set(manifest.id, s);
  s.host.start();
  return s;
}

const mmss = (ms) => {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};

/** Host: "Invite with code" → big code, countdown, live status, Allow / Decline. */
export function HostCode({ manifest }) {
  const { toast, me, doc, linkStatus } = useApp();
  const [session, setSession] = useState(() => sessions.get(manifest.id) || null);
  const [st, setSt] = useState(() => session?.host.state || null);
  const [ok, setOk] = useState(true);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    inviteCodeSupported().then(setOk);
  }, []);
  useEffect(() => {
    if (!session) return;
    session.toast = toast;
    session.watchers.add(setSt);
    setSt(session.host.state);
    setNow(Date.now());
    return () => session.watchers.delete(setSt);
  }, [session]);
  const live = st && ['starting', 'waiting', 'request', 'sending'].includes(st.phase);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);
  // Who the next code is for: the first player nobody has taken yet (the host may be any player – a restarted
  // run keeps the slots). Everybody is there already → somebody re-joins on another computer: "Noa / Robin".
  const taken = takenSlots(manifest, { me, doc, linkStatus });
  // who is live right now (us included): with every seat taken, the newcomer is one of the others – re-joining
  const online = linkStatus ? [me, ...Object.keys(linkStatus.partners || {})] : null;
  if (session) {
    session.taken = () => takenSlots(manifest, { me, doc, linkStatus });
    session.online = () => online;
  }
  const names = doc ? getPlayers(doc, manifest) : manifest.players || {};
  const others = slotsOf(manifest).filter((s) => s !== me);
  const nextSlot = suggestSlot(manifest.players, taken, '', online);
  const partner = nextSlot ? names[nextSlot]?.name || nextSlot.toUpperCase() : others.map((s) => names[s]?.name || s.toUpperCase()).join(' / ');
  const missing = others.filter((s) => !taken.includes(s)).map((s) => names[s]?.name || s.toUpperCase());
  const newCode = () => {
    const s = startSession(manifest, toast);
    s.taken = () => takenSlots(manifest, { me, doc, linkStatus });
    s.online = () => online;
    setSession(s);
  };

  if (!ok) return html`<p class="warning info">${t('code.unsupported', 'This browser can’t create invite codes – use the invite file below.')}</p>`;
  if (!live) {
    const why = st && {
      expired: t('code.expired', 'The code expired after 15 minutes. Create a new one if somebody still needs to join.'),
      locked: t('code.locked', 'Too many wrong attempts – the code was blocked.'),
      conflict: t('code.conflict', 'Two different people used this code – it was cancelled to be safe.'),
      error: t('code.error', 'Could not create a code: {msg}', { msg: st.error }),
    }[st.phase];
    return html`<div class="stack">
      ${st?.phase === 'done' && html`<p class="note">${st.acked ? t('code.done', '{name} has the invite – their app is building the game now.', { name: st.admitted || partner })
        : t('code.sent', 'The invite went out to {name}.', { name: st.admitted || partner })}</p>`}
      ${st?.phase === 'done' && missing.length > 0 && html`<p class="small muted">${t('code.more', 'Still to invite: {names} – every player needs their own code.', { names: missing.join(', ') })}</p>`}
      ${why && html`<p class="warning" role="alert">${why}</p>`}
      <div><button class="btn primary big" onClick=${newCode}><${Icon} name="user" size=${16} />${st && st.phase !== 'cancelled' ? t('code.new', 'New code') : t('code.start', 'Invite with code')}</button></div>
    </div>`;
  }
  const req = st.phase === 'request' ? st.request : null;
  return html`<div class="stack">
    <div class="invite-code-box">
      <div class="invite-code" aria-label=${t('code.aria', 'Invite code {code}', { code: st.code.split('').join(' ') })}>${formatCode(st.code)}</div>
      <div class="row tight">
        <button class="btn small" onClick=${() => { copy(st.code); toast({ kind: 'ok', title: t('common.copied', 'Copied'), text: isStreamer() ? t('code.copiedHidden', 'The code is on your clipboard (hidden while streaming).') : formatCode(st.code) }); }}>${t('common.copy', 'Copy')}</button>
        <span class="small muted" role="timer">${st.phase === 'sending' ? t('code.used', 'used') : t('code.validFor', 'valid for {time}', { time: mmss(st.expiresAt - now) })}</span>
      </div>
    </div>
    ${req ? html`<div class="code-request" role="alert">
        <p><b>${t('code.request', '{name} wants to join – allow?', { name: req.name || t('code.someone', 'Someone') })}</b></p>
        ${req.confirm && html`<p class="confirm-code"><b>${t('code.confirmHint', 'Check that {name} sees the same code: {code}', { code: req.confirm, name: req.name || t('code.someone', 'Someone') })}</b></p>`}
        <p class="small muted">${t('code.requestHint', 'Only allow it if you gave this person the code. They get the key to your run.')}</p>
        <div class="row"><button class="btn primary" onClick=${() => session.host.allow()}><${Icon} name="check" size=${14} />${t('code.allow', 'Allow')}</button>
          <button class="btn ghost" onClick=${() => session.host.decline()}>${t('code.decline', 'Decline')}</button></div>
      </div>`
      : html`<div class="row nowrap"><${Led} on blink /><span class="small">${st.phase === 'sending' ? t('code.sending', 'Sending the invite to {name} …', { name: st.admitted || partner })
        : st.phase === 'starting' ? t('code.starting', 'Creating the code …') : t('code.waiting', 'Waiting for {name} …', { name: partner })}</span></div>`}
    ${st.fails > 0 && html`<p class="small faint">${t('code.attempts', 'Declined or failed attempts: {count} of 3 – after that the code is blocked.', { count: st.fails })}</p>`}
    <ol class="small muted steps">
      <li>${t('code.s1', 'Tell {name} the code – by voice, chat or text.', { name: partner })}</li>
      <li>${t('code.s2', '{name} opens SoulLink › “Join with code” and enters it. Keep this app open meanwhile.', { name: partner })}</li>
      <li>${t('code.s3', 'You allow the request – {name}’s app gets the invite and builds the game from their own copy.', { name: partner })}</li>
    </ol>
    ${st.phase !== 'sending' && html`<div><button class="btn small ghost" onClick=${() => session.host.cancel()}>${t('code.cancel', 'Cancel code')}</button></div>`}
  </div>`;
}

// The joining player doesn't know who invited them until the pack arrives: "the host", not a name.
const joinErrors = () => ({
  format: t('code.errFormat', 'Enter the 6-digit code you were given.'),
  'no-host': t('code.errNoHost', 'Nobody answered this code. Check the digits – whoever invited you must have it open in souldew, and a code is valid for 15 minutes.'),
  offline: t('code.errOffline', 'Can’t reach the relay servers. Check your internet connection.'),
  bad: t('code.errBad', 'The code didn’t match. Check the digits and try again.'),
  expired: t('code.errExpired', 'This code has expired. Ask for a new one.'),
  used: t('code.errUsed', 'This code was already used – every player needs their own. Ask for a new one.'),
  locked: t('code.errLocked', 'This code was blocked after too many attempts. Ask for a new one.'),
  conflict: t('code.errConflict', 'Someone else used this code at the same time, so it was cancelled to be safe. Ask for a new one.'),
  declined: t('code.errDeclined', 'The host declined the request.'),
  timeout: t('code.errTimeout', 'The host didn’t answer in time.'),
  'host-gone': t('code.errHostGone', 'The host’s souldew stopped answering (closed or restarted). Ask for a new code.'),
  unsupported: t('code.errUnsupported', 'This browser can’t use invite codes – use the invite file instead.'),
});

/**
 * Joining player: name + 6-digit code → onPack(run pack, { slot, taken, name }) once the host allowed it. slot: the
 * player the host suggests (first free one, or the one with this name) – null if unknown; taken: slots that
 * have somebody already. Both are hints for the "I am …" choice, which stays the joining player's.
 */
export function JoinCode({ onPack }) {
  const { status } = useApp();
  const [name, setName] = useState(status?.config?.playerName || '');
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState(null); // null | deriving | connecting | searching | waiting
  const [confirm, setConfirm] = useState(null); // 4 digits the host sees next to "… wants to join" too
  const [err, setErr] = useState(null);
  const job = useRef(null);
  useEffect(() => {
    // closing or reloading the app while waiting: say goodbye, so the host doesn't keep a dead request around
    const leave = () => job.current?.cancel();
    addEventListener('pagehide', leave);
    return () => {
      removeEventListener('pagehide', leave);
      const j = job.current;
      job.current = null;
      j?.cancel();
    };
  }, []);
  const go = () => {
    const c = normalizeCode(code);
    if (!c) return setErr('format');
    setErr(null);
    const me = name.trim();
    if (me && me !== status?.config?.playerName) api.post('/api/config', { playerName: me }).catch(() => {});
    let seat = { slot: null, taken: [] };
    const j = joinWithCode(c, { name: me, onState: (p, info) => {
      if (job.current !== j) return;
      if (p === 'received') {
        seat = info || seat;
        return;
      }
      setPhase(p);
      if (info?.confirm) setConfirm(info.confirm);
    } });
    job.current = j;
    setConfirm(null);
    setPhase('deriving');
    j.promise.then((pack) => {
      if (job.current !== j) return;
      job.current = null;
      setPhase(null);
      onPack(pack, { ...seat, name: me }); // the name typed here is what this player is called in the run
    }, (e) => {
      if (job.current !== j) return;
      job.current = null;
      setPhase(null);
      if (e.code !== 'cancelled') setErr(e.code || 'error');
    });
  };
  const busy = !!phase;
  return html`<div class="stack">
    <div class="grid-2">
      <label class="field"><span>${t('code.yourName', 'Your name')}</span>
        <input type="text" value=${name} maxLength="20" disabled=${busy} onInput=${(e) => setName(e.target.value)} /></label>
      <label class="field"><span>${t('code.label', 'Invite code')}</span>
        <input type="text" class="invite-code-input" inputmode="numeric" autocomplete="one-time-code" placeholder="123 456" value=${code} disabled=${busy}
          onInput=${(e) => { const d = e.target.value.replace(/\D/g, '').slice(0, 6); setCode(d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d); }}
          onKeyDown=${(e) => e.key === 'Enter' && !busy && go()} /></label>
    </div>
    ${err && html`<p class="warning error" role="alert">${joinErrors()[err] || t('code.errOther', 'Joining with the code didn’t work.')}</p>`}
    ${busy ? html`<div class="row nowrap"><${Led} on blink /><span class="small grow">${phase === 'waiting' ? t('code.waitAllow', 'Found! Waiting for the host to let you in …')
        : phase === 'searching' ? t('code.searching', 'Looking for the host …') : t('code.connecting', 'Connecting …')}</span>
        <button class="btn small ghost" onClick=${() => job.current?.cancel()}>${t('common.cancel', 'Cancel')}</button></div>
      ${phase === 'waiting' && confirm && html`<p class="confirm-code" role="status"><b>${t('code.confirmHintJoin', 'Check that the host sees the same code: {code}', { code: confirm })}</b></p>`}`
      : html`<div><button class="btn primary big" disabled=${!normalizeCode(code)} onClick=${go}><${Icon} name="link" size=${16} />${t('code.join', 'Join with code')}</button></div>`}
  </div>`;
}
