import { html, useState } from '/vendor/htm-preact.mjs';
import { useApp, copy, download, Led, Modal } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { t, ago } from '../lib/i18n.mjs';
import { players as getPlayers, slotsOf, othersOf, joinNames } from '../lib/run.mjs';
import { PARTNER_TTL } from '../lib/sync.mjs';
import { ConnectionFlow, ConnectionText } from './guide.mjs';
import { HostCode } from './invitecode.mjs';


export function LinkView() {
  const { manifest, doc, me, setMe, linkStatus, onlineSlots, connect, disconnect, toast, navigate } = useApp();
  const [switchTo, setSwitchTo] = useState(null);
  if (!manifest || !doc) {
    return html`<div class="stack-l"><div class="topbar"><h1>${t('nav.link', 'Connection')}</h1></div>
      <div class="panel empty-state"><${Icon} name="signal" size=${56} /><h2>${t('link.noRun', 'No SoulLink open')}</h2>
      <p class="muted">${t('link.noRunText', 'Create or join a SoulLink first – the connection belongs to a run.')}</p>
      <button class="btn primary" onClick=${() => navigate('soullink')}>${t('nav.soullink', 'SoulLink')}</button></div>
      <section class="panel stack"><h2>${t('link.how', 'How it works')}</h2><${ConnectionFlow} /><${ConnectionText} /></section></div>`;
  }
  const names = getPlayers(doc, manifest);
  const s = linkStatus;
  // every other player of the run, each with their own light (status.partners: one entry per live player)
  const others = othersOf(me, manifest);
  // the same rule as the rail (app.mjs onlineSlots): heard from within PARTNER_TTL, or a direct link is up
  const live = (slot) => (onlineSlots ? onlineSlots.has(slot) : !!s?.partners?.[slot] && Date.now() - s.partners[slot].seen < PARTNER_TTL);
  const missing = others.filter((slot) => !live(slot)).map((slot) => names[slot]?.name || slot.toUpperCase());
  const allOn = others.length > 0 && !missing.length;
  const partner = others.length === 1 ? names[others[0]]?.name : joinNames(missing); // "Kim, Alex & Robin", as on the board
  const state = (x) => ({ connected: t('link.connected', 'connected'),
    waiting: others.length === 1 ? t('link.waitingOne', 'waiting for {name}', { name: names[others[0]]?.name || others[0].toUpperCase() }) : t('link.waitingPeer', 'waiting for the others'), connecting: t('link.connecting', 'connecting'),
    reconnecting: t('link.reconnecting', 'reconnecting'), error: t('link.unavailable', 'not available'), off: t('link.off', 'off') }[x || 'off']);
  const packJson = JSON.stringify(manifest.pack, null, 2);
  // Stopped by hand (Disconnect): nothing reconnects by itself until Connect is clicked (app.mjs, sl-autolink-<id>).
  let stoppedByUser = false;
  try {
    stoppedByUser = !s && localStorage.getItem(`sl-autolink-${manifest.id}`) === 'false';
  } catch {
    // storage blocked – the default text fits
  }
  // the overlays for OBS (and the streamer mode) have their own page now
  const overlay = html`<div class="row"><span class="small muted grow">${t('link.overlayMoved', 'Streaming this run? The OBS overlays and the streamer mode are on the Stream page.')}</span>
    <button class="btn small ghost" onClick=${() => navigate('stream')}><${Icon} name="stream" size=${14} />${t('link.toStream', 'Stream & overlays')}</button></div>`;
  // A solo Nuzlocke has nobody to connect to: no connect button, lights or player switch – only the stream overlay.
  if (!others.length) {
    return html`<div class="stack-l">
      <div class="topbar"><h1>${t('nav.link', 'Connection')}</h1></div>
      <section class="panel stack"><div class="row"><${Icon} name="user" size=${20} /><h2>${t('link.solo', 'Solo run – nobody to connect to')}</h2></div>
        <p class="small muted">${t('link.soloText', 'In a solo Nuzlocke nobody else plays this run.')}</p>
        ${overlay}</section>
    </div>`;
  }
  const noWebRtc = typeof RTCPeerConnection === 'undefined'; // relay-only then
  // Someone who was here before (sync heard them, or they left live data in the run) is "offline", not "not connected yet"
  const offline = (slot) => {
    const seen = Math.max(s?.partners?.[slot]?.seen || 0, doc?.get(`live:${slot}`, null)?.at || 0);
    return seen ? t('link.offlineSeen', 'offline · last seen {when}', { when: ago(seen) }) : t('link.notThere', 'not connected yet');
  };
  const p2pState = noWebRtc ? 'error' : s?.p2p;
  return html`<div class="stack-l">
    <div class="topbar"><h1>${t('nav.link', 'Connection')}</h1>
      ${s ? html`<button class="btn ghost small" onClick=${disconnect}>${t('link.disconnect', 'Disconnect')}</button>` : html`<button class="btn primary" onClick=${connect}>${t('link.connect', 'Connect')}</button>`}</div>
    <section class="panel stack">
      <div class="row"><${Led} on=${allOn} blink=${!!s && !allOn} /><h2>${allOn ? (others.length === 1 ? t('link.partnerOn', '{name} is connected', { name: partner }) : t('link.allOn', 'Everyone is connected'))
        : s ? t('link.waitingFor', 'Waiting for {name}', { name: partner }) : t('rail.offline', 'Not connected')}</h2>
        ${s?.lastSync && html`<span class="faint small">${t('link.lastSync', 'last sync {when}', { when: ago(s.lastSync) })}</span>`}</div>
      <p class="small muted">${allOn ? t('link.liveText', 'Catches, deaths, teams and the log are exchanged live.')
        : stoppedByUser ? t('link.stoppedText', 'You disconnected. Click Connect to sync again – your progress is kept and merged later.') : missing.length > 1 ? t('link.waitTextMany', 'As soon as {names} open this SoulLink, the apps connect automatically. Until then just keep playing – everything is merged later.', { names: partner })
        : t('link.waitText', 'As soon as {name} opens this SoulLink, the apps connect automatically. Until then just keep playing – everything is merged later.', { name: partner })}</p>
      ${others.length === 1 && s && !allOn && html`<p class="small faint">${names[others[0]]?.name || others[0].toUpperCase()}: ${offline(others[0])}</p>`}
      ${others.length > 1 && html`<div class="stack-s">${others.map((slot) => {
        const on = live(slot);
        const direct = on && s.partners[slot].p2p;
        return html`<div class="check-item" key=${slot}><${Led} on=${on} blink=${!!s && !on} /><div>${names[slot]?.name || slot.toUpperCase()}</div>
          <span class="small muted">${on ? (direct ? t('link.liveDirect', 'connected · direct') : t('link.liveRelay', 'connected · relay')) : s ? offline(slot) : t('link.off', 'off')}</span></div>`;
      })}</div>`}
      <div class="check-item"><${Led} on=${!noWebRtc && s?.p2p === 'connected'} color="green" /><div>${t('link.p2p', 'Direct connection')} <span class="tiny faint">WebRTC</span></div>
        <span class="small muted" title=${noWebRtc ? t('link.noWebRtc', 'This browser has no WebRTC – the relay carries everything.') : undefined}>${state(p2pState)}</span></div>
      <div class="check-item"><${Led} on=${s?.relay === 'connected'} color="green" /><div>${t('link.relayName', 'Relay')} <span class="tiny faint">${s?.broker || 'MQTT'}</span></div><span class="small muted">${state(s?.relay)}</span></div>
      <p class="tiny faint">${t('link.oneIsEnough', 'One of the two is enough.')}</p>
      ${s?.error && s.p2p !== 'connected' && s.relay !== 'connected' && html`<p class="warning error" role="alert">${t('link.error', 'Connection problem: {msg}', { msg: s.error })}</p>`}
    </section>
    ${others.length > 0 && html`<section class="panel stack"><h2>${t('link.invite', 'Invite')}</h2>
      ${!manifest.imported && html`<${HostCode} manifest=${manifest} />`}
      <p class="small muted">${others.length > 1
        ? manifest.imported ? t('link.inviteFileGroupImported', 'Save the invite file – the other players open it in souldew under SoulLink › “Join with code”.')
          : t('link.inviteFileGroup', 'Or save the invite file – the other players open it in souldew under SoulLink › “Join with code”.')
        : manifest.imported ? t('link.inviteFileOneImported', 'Save the invite file – {name} opens it in souldew under SoulLink › “Join with code”.', { name: names[others[0]]?.name || others[0].toUpperCase() })
          : t('link.inviteFileOne', 'Or save the invite file – {name} opens it in souldew under SoulLink › “Join with code”.', { name: names[others[0]]?.name || others[0].toUpperCase() })}</p>
      <div class="row"><button class="btn" onClick=${() => download(`soullink-invite-${manifest.id}.soullink.json`, packJson)}><${Icon} name="save" size=${16} />${t('new.saveInvite', 'Save invite')}</button>
        <button class="btn ghost" onClick=${() => { copy(packJson); toast({ kind: 'ok', title: t('common.copied', 'Copied'), text: t('new.inviteCopied', 'The invite is on your clipboard.') }); }}>${t('common.copy', 'Copy')}</button></div>
    </section>`}
    <section class="panel stack"><h2>${t('link.whoAmI', 'Who are you on this computer?')}</h2>
      <div class="seg seg-who">${slotsOf(manifest).map((slot) => html`<button class=${me === slot ? 'on' : ''} title=${names[slot]?.name || ''} aria-pressed=${me === slot} onClick=${() => slot !== me && setSwitchTo(slot)}>${names[slot]?.name || slot.toUpperCase()}</button>`)}</div></section>
    <${Modal} open=${!!switchTo} onClose=${() => setSwitchTo(null)} title=${t('link.switchTitle', 'Play as {name}?', { name: switchTo ? names[switchTo].name : '' })}
      footer=${html`<button class="btn ghost" onClick=${() => setSwitchTo(null)}>${t('common.cancel', 'Cancel')}</button>
        <button class="btn primary" onClick=${() => { setMe(switchTo); setSwitchTo(null); }}>${t('link.switchConfirm', 'Switch player')}</button>`}>
      <p class="small muted">${t('link.switchText', 'Catches and deaths from this computer will be recorded for {name}. Only switch if you picked the wrong player – every player needs their own.', { name: switchTo ? names[switchTo].name : '' })}</p>
    <//>
    <section class="panel stack"><h2>${t('link.how', 'How it works')}</h2><${ConnectionFlow} group=${others.length > 1} /><${ConnectionText} group=${others.length > 1} />
      <details class="group"><summary>${t('link.trouble', 'Not working?')}</summary><div style="padding:0 14px 12px"><ol class="small muted">
        <li>${t('link.t1', 'Everyone needs this SoulLink open, each with a different player selected.')}</li>
        <li>${t('link.t2', 'Company or university networks sometimes block both ways – try a phone hotspot.')}</li>
        <li>${t('link.t3', 'Disconnect and connect again.')}</li>
      </ol></div></details>
      ${overlay}
    </section>
  </div>`;
}
