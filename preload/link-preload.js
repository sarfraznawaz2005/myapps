'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--link-id='));
const linkId = arg ? arg.slice('--link-id='.length) : null;

if (linkId) {
  // One synchronous round-trip for this link's current config + the
  // injected-script source text (main reads inject-main-world.js from disk
  // and hands the string back — preload itself has no fs access sandboxed).
  const boot = ipcRenderer.sendSync('link:bootstrap', linkId) || {};

  contextBridge.exposeInMainWorld('__myapps', {
    linkId,
    initialConfig: boot.config || {},
    setBadge: (count) => ipcRenderer.send('link:badge', linkId, count),
    reportExpert: (payload) => ipcRenderer.send('link:expert', linkId, payload),
    notify: (payload) => ipcRenderer.send('link:notification', linkId, payload),
    pickedElement: (payload) => ipcRenderer.send('link:picked-element', linkId, payload),
    onNotifClick: (cb) => ipcRenderer.on(`link:notif-click:${linkId}`, (_e, notificationId) => cb(notificationId)),
    onConfigUpdate: (cb) => ipcRenderer.on('link:config', (_e, cfg) => cb(cfg)),
    onStartPicker: (cb) => ipcRenderer.on('link:start-picker', () => cb()),
    onStopPicker: (cb) => ipcRenderer.on('link:stop-picker', () => cb()),
  });

  if (boot.source) {
    // Runs in the main world, before any page script — critical so Slack/
    // WhatsApp/etc. don't capture window.Notification first.
    webFrame.executeJavaScript(boot.source).catch(() => {});
  }
}
