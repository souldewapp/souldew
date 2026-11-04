// Minimal, explicit bridge between the UI and the native app (no Node access in the page).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sls', {
  native: true,
  pickFiles: (opts) => ipcRenderer.invoke('pick-files', opts),
  reveal: (path) => ipcRenderer.invoke('reveal', path),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  appInfo: () => ipcRenderer.invoke('app-info'),
  // Progress since the last in-game save: { title, text, keep, quit } (UI language) or null – closing asks first.
  setUnsaved: (info) => ipcRenderer.send('unsaved', info || null),
  // A game is running: the display stays awake (a controller is no input macOS notices).
  setPlaying: (on) => ipcRenderer.send('playing', !!on),
  // Labels of the menu bar in the UI language: { settings, file, addGames, … }.
  setMenuLabels: (labels) => ipcRenderer.send('menu-labels', labels || null),
  update: {
    state: () => ipcRenderer.invoke('update-state'),
    check: () => ipcRenderer.invoke('update-check'),
    install: () => ipcRenderer.invoke('update-install'),
    cancel: () => ipcRenderer.invoke('update-cancel'),
    restart: () => ipcRenderer.invoke('update-restart'),
    showDownload: () => ipcRenderer.invoke('update-show'),
  },
  on: (channel, fn) => {
    if (!['navigate', 'emu', 'menu', 'update', 'fullscreen'].includes(channel)) return () => {};
    const listener = (e, ...args) => fn(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
