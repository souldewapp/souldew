// App updates: a small card in the sidebar when a new version is out, and the "Updates" block in Settings.
// The desktop app does the work in the main process (electron/updater.mjs); in the browser this shows nothing.
import { html, useState, useEffect } from '/vendor/htm-preact.mjs';
import { t } from '../lib/i18n.mjs';
import { Modal, Led, openExternal, useApp } from '../lib/ui.mjs';
import { Icon } from '../lib/icons.mjs';
import { PLATFORM, shortcut } from '../lib/platform.mjs';

const bridge = () => window.sls?.update || null;

// "Later" hides the card for that version until the next start; Settings › Check for updates brings it back.
let dismissed = null;
let updatedToastShown = false;
const BAD_SIG = 'bad-signature'; // `dismissed` value for the "update refused" card
const dismissListeners = new Set();
const setDismissed = (v) => {
  dismissed = v;
  for (const fn of dismissListeners) fn(v);
};

export function useUpdate() {
  const [s, setS] = useState(null);
  useEffect(() => {
    const b = bridge();
    if (!b) return;
    let live = true;
    b.state().then((x) => live && setS(x)).catch(() => {});
    const off = window.sls.on('update', (x) => setS(x));
    return () => {
      live = false;
      off();
    };
  }, []);
  return s;
}

const mb = (n) => (n / 1024 / 1024).toFixed(n > 100 * 1024 * 1024 ? 0 : 1);

const REASONS = () => ({
  blocked: t('upd.reasonBlocked', 'macOS did not let the app replace itself. You can allow it under System Settings › Privacy & Security › App Management, or replace it by hand.'),
  'read-only': t('upd.reasonReadOnly', 'Your user account can’t write to the folder the app is in.'),
  translocated: t('upd.reasonTranslocated', 'The app was opened straight from the download instead of from Applications.'),
  dmg: t('upd.reasonDmg', 'The app is running from the disk image instead of from Applications.'),
  minVersion: t('upd.reasonMinVersion', 'Your version is too old to update automatically.'),
  'copy-failed': t('upd.reasonCopy', 'Copying the new app failed.'),
  signature: t('upd.reasonSignature', 'The new version’s signature could not be verified, so it was not installed automatically.'),
  portable: t('upd.reasonPortable', 'This copy of souldew wasn’t installed with the installer (it runs from an unpacked folder), so it can’t update itself.'),
  'launch-failed': t('upd.reasonLaunch', 'The installer could not be started automatically.'),
});

const STEPS = () => ({
  verify: t('upd.stepVerify', 'Checking the download'),
  mount: t('upd.stepMount', 'Opening the disk image'),
  copy: t('upd.stepCopy', 'Copying the new app'),
  launch: t('upd.stepLaunch', 'Starting the installer – souldew closes and opens again by itself'),
});

/** The platform the update is for (the main process says it; older states don't have it). */
const isWin = (s) => (s?.platform || PLATFORM) === 'win32';

function NotesModal({ u, open, onClose, footer }) {
  return html`<${Modal} open=${open} onClose=${onClose} title=${t('upd.notesTitle', 'What’s new in {version}', { version: u?.version })} footer=${footer}>
    <div class="update-notes small">${u?.notes?.trim() || t('upd.noNotes', 'No release notes.')}</div>
  <//>`;
}

function ManualModal({ s, open, onClose }) {
  return html`<${Modal} open=${open} onClose=${onClose} title=${t('upd.manualTitle', 'Install version {version}', { version: s.update?.version })}
    footer=${html`<button class="btn ghost" onClick=${() => bridge().showDownload()}><${Icon} name="folder" size=${14} />${t('upd.showDownload', 'Show download')}</button>
      <button class="btn primary" onClick=${onClose}>${t('common.close', 'Close')}</button>`}>
    ${s.reason && REASONS()[s.reason] && html`<p class="small muted">${REASONS()[s.reason]}</p>`}
    ${isWin(s) ? html`<ol class="small">
      <li>${t('upd.manual1Win', 'Quit souldew ({keys}).', { keys: shortcut('Alt+F4') })}</li>
      <li>${t('upd.manual2Win', 'In the Explorer window that opened, double-click {file}. It installs the new version and keeps your data.', { file: s.update?.asset?.name || 'souldew-setup.exe' })}</li>
      <li>${t('upd.manual3', 'Open souldew again.')}</li>
    </ol>
    <p class="small muted">${t('upd.dataSafeWin', 'Your runs, saves and settings are kept: they live in your user folder (AppData), not inside the app.')}</p>
    <p class="small muted">${t('upd.smartscreen', 'If Windows SmartScreen says it protected your PC, click “More info” › “Run anyway”. That is needed because souldew is not signed with a paid certificate.')}</p>`
    : html`<ol class="small">
      <li>${t('upd.manual1', 'Quit souldew (⌘Q).')}</li>
      <li>${t('upd.manual2', 'In the Finder window that opened, drag souldew onto Applications and choose “Replace”.')}</li>
      <li>${t('upd.manual3', 'Open souldew again.')}</li>
    </ol>
    <p class="small muted">${t('upd.dataSafe', 'Your runs, saves and settings are kept: they live in your Library folder, not inside the app.')}</p>
    <p class="small muted">${t('upd.gatekeeper', 'If macOS says it can’t check the app for malicious software, right-click it in Applications › Open › Open. That is needed once because souldew is not notarized by Apple.')}</p>`}
  <//>`;
}

/** Sidebar card. Only in the desktop app, only while there is something to say. */
export function UpdateBanner() {
  const { toast, session } = useApp();
  const s = useUpdate();
  const [hidden, setHidden] = useState(dismissed);
  const [notes, setNotes] = useState(false);
  const [manual, setManual] = useState(false);
  useEffect(() => {
    dismissListeners.add(setHidden);
    return () => dismissListeners.delete(setHidden);
  }, []);
  // First start after an update: say so once. The main process knows it after an in-app update (updatedFrom);
  // localStorage covers updates installed by hand.
  useEffect(() => {
    if (!s?.current) return;
    let last = null;
    try {
      last = localStorage.getItem('sl-app-version');
      localStorage.setItem('sl-app-version', s.current);
    } catch {
      // private mode
    }
    if (updatedToastShown) return;
    if (s.updatedFrom || (last && last !== s.current)) updatedToastShown = true;
    if (updatedToastShown) toast({ kind: 'ok', title: t('upd.updatedTitle', 'Updated'), text: t('upd.updated', 'souldew is now on version {version}.', { version: s.current }) });
  }, [s?.current]);
  useEffect(() => {
    if (s?.phase === 'manual') setManual(true);
  }, [s?.phase]);
  // A feed whose signature is missing or wrong was refused: nothing was downloaded, but say so.
  if (s?.checkError?.code === 'BAD_SIGNATURE' && !(s.update && s.phase !== 'uptodate') && hidden !== BAD_SIG) {
    return html`<div class="update-card" role="alert">
      <div class="row nowrap"><${Led} on color="red" /><b>${t('upd.badSignatureTitle', 'Update refused')}</b></div>
      <div class="tiny muted">${t('upd.badSignature', 'The update could not be verified: its signature is missing or wrong, so it was not downloaded. Your installed version is unchanged.')}</div>
      <div class="update-actions"><button class="btn small ghost" onClick=${() => setDismissed(BAD_SIG)}>${t('common.close', 'Close')}</button></div>
    </div>`;
  }
  if (!s?.update || !['available', 'downloading', 'installing', 'ready', 'manual', 'error'].includes(s.phase)) return null;
  const u = s.update;
  if (hidden === u.version && ['available', 'ready', 'error'].includes(s.phase)) return null;
  const b = bridge();
  const later = () => setDismissed(u.version);
  const auto = s.canInstall && u.action === 'install';
  const installBtn = auto
    ? html`<button class="btn small primary" onClick=${() => { setNotes(false); b.install(); }}>${t('upd.install', 'Download & install')}</button>`
    : html`<button class="btn small primary" onClick=${() => openExternal(u.page)}><${Icon} name="external" size=${13} />${t('upd.page', 'Download page')}</button>`;
  const pct = s.progress?.total ? Math.min(100, Math.round((s.progress.received / s.progress.total) * 100)) : 0;

  let title;
  let text;
  let actions;
  if (s.phase === 'available') {
    title = t('upd.available', 'Version {version} is available', { version: u.version });
    text = t('upd.youHave', 'You have {version}.', { version: s.current });
    actions = html`${installBtn}
      <button class="btn small ghost" onClick=${() => setNotes(true)}>${t('upd.whatsNew', 'What’s new')}</button>
      <button class="btn small ghost" onClick=${later}>${t('upd.later', 'Later')}</button>`;
  } else if (s.phase === 'downloading') {
    title = t('upd.downloading', 'Downloading {version} …', { version: u.version });
    text = s.progress?.total ? `${pct} % · ${mb(s.progress.received)} / ${mb(s.progress.total)} MB` : '';
    actions = html`<button class="btn small ghost" onClick=${() => b.cancel()}>${t('common.cancel', 'Cancel')}</button>`;
  } else if (s.phase === 'installing') {
    title = t('upd.installing', 'Installing {version} …', { version: u.version });
    text = STEPS()[s.step] || '';
  } else if (s.phase === 'ready') {
    title = t('upd.ready', 'Update ready');
    text = `${isWin(s) ? t('upd.readyTextWin', 'Restart to install version {version} – it takes a few seconds, then souldew opens again. Your runs, saves and settings stay as they are.', { version: u.version })
      : t('upd.readyText', 'Restart to use version {version}. Your runs, saves and settings stay as they are.', { version: u.version })}${session ? ` ${t('upd.saveFirst', 'Save in the game first – restarting closes it.')}` : ''}`;
    actions = html`<button class="btn small primary" onClick=${() => b.restart()}>${t('upd.restart', 'Restart now')}</button>
      <button class="btn small ghost" title=${t('upd.laterHint', 'The update is installed when you quit the app.')} onClick=${later}>${t('upd.later', 'Later')}</button>`;
  } else if (s.phase === 'manual') {
    title = t('upd.manual', 'Almost done');
    text = isWin(s) ? t('upd.manualTextWin', 'Version {version} is downloaded and checked. Run the installer to finish.', { version: u.version })
      : t('upd.manualText', 'Version {version} is downloaded and checked. Replace the app by hand to finish.', { version: u.version });
    actions = html`<button class="btn small primary" onClick=${() => setManual(true)}>${t('upd.how', 'How?')}</button>
      <button class="btn small ghost" onClick=${() => b.showDownload()}>${t('upd.showDownload', 'Show download')}</button>`;
  } else {
    title = t('upd.failed', 'Update failed');
    text = s.error || '';
    actions = html`${auto && html`<button class="btn small" onClick=${() => b.install()}>${t('err.retry', 'Try again')}</button>`}
      <button class="btn small ghost" onClick=${() => openExternal(u.page)}>${t('upd.page', 'Download page')}</button>
      <button class="btn small ghost" onClick=${later}>${t('common.close', 'Close')}</button>`;
  }

  return html`<div class="update-card" role="status" aria-live="polite">
    <div class="row nowrap"><${Led} on color=${s.phase === 'error' ? 'red' : s.phase === 'available' ? 'amber' : 'green'} blink=${s.phase === 'downloading' || s.phase === 'installing'} /><b>${title}</b></div>
    ${text && html`<div class="tiny muted">${text}</div>`}
    ${(s.phase === 'downloading' || s.phase === 'installing') && html`<div class="update-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${s.phase === 'installing' ? 100 : pct}>
      <i class=${s.phase === 'installing' ? 'busy' : ''} style=${`width:${s.phase === 'installing' ? 100 : pct}%`}></i></div>`}
    ${actions && html`<div class="update-actions">${actions}</div>`}
    <${NotesModal} u=${u} open=${notes} onClose=${() => setNotes(false)}
      footer=${html`<button class="btn ghost" onClick=${() => setNotes(false)}>${t('common.close', 'Close')}</button>${s.phase === 'available' && installBtn}`} />
    ${s.phase === 'manual' && html`<${ManualModal} s=${s} open=${manual} onClose=${() => setManual(false)} />`}
  </div>`;
}

/** Settings › About: installed version and "Check for updates". */
export function UpdateSection() {
  const s = useUpdate();
  const [busy, setBusy] = useState(false);
  if (!bridge()) return html`<p class="small muted">${t('upd.browser', 'Updates are installed by the desktop app.')}</p>`;
  if (!s) return null;
  const check = async () => {
    setBusy(true);
    const next = await bridge().check().catch(() => null);
    setBusy(false);
    if (next?.update) setDismissed(null);
  };
  let line = null;
  if (!s.configured) line = t('upd.notConfigured', 'Updates are not set up for this build.');
  else if (s.phase === 'checking' || busy) line = t('upd.checking', 'Checking …');
  else if (s.update && s.phase !== 'uptodate') line = t('upd.availableSide', 'Version {version} is available – see the sidebar.', { version: s.update.version });
  else if (s.checkError?.code === 'BAD_SIGNATURE') line = t('upd.badSignature', 'The update could not be verified: its signature is missing or wrong, so it was not downloaded. Your installed version is unchanged.');
  else if (s.checkError) line = s.checkError.code === 'NOT_FOUND' ? t('upd.noRelease', 'No update has been published yet.') : t('upd.checkFailed', 'Could not check for updates: {error}', { error: s.checkError.message });
  else if (s.phase === 'uptodate') line = t('upd.upToDate', 'You have the latest version.');
  return html`<div class="row">
    <span class="small">${t('upd.version', 'Version {version}', { version: s.current })}</span>
    ${s.configured && html`<button class="btn small ghost" disabled=${busy || ['checking', 'downloading', 'installing'].includes(s.phase)} onClick=${check}>${t('upd.check', 'Check for updates')}</button>`}
    ${line && html`<span class="small muted" role="status">${line}</span>`}
  </div>`;
}
