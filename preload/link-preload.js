'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--link-id='));
const linkId = arg ? arg.slice('--link-id='.length) : null;

function userscriptMatchesUrl(url, patterns) {
  if (!patterns || !patterns.length) return false;
  for (const p of patterns) {
    if (!p) continue;
    const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    try {
      if (new RegExp('^' + escaped + '$').test(url)) return true;
    } catch (e) { /* malformed pattern; skip it */ }
  }
  return false;
}

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
    getLocation: () => ipcRenderer.invoke('link:get-location', linkId),
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

  // Userscripts: each matching one gets its own top-level executeJavaScript
  // call rather than being eval()'d from inside boot.source — a strict
  // page CSP (Gmail, ChatGPT) blocks eval/Function called from a script
  // already running in the page, but not this kind of external injection.
  const scripts = (boot.config && boot.config.userscripts) || [];
  const currentUrl = location.href;
  for (const s of scripts) {
    if (!userscriptMatchesUrl(currentUrl, s.matches)) continue;
    const label = JSON.stringify(`[My Apps userscript] "${s.name || 'Untitled'}" failed:`);
    const wrapped = `(function(){
      function __run(){
        try {
${s.code}
        } catch (e) {
          console.error(${label}, e);
        }
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', __run);
      } else {
        __run();
      }
    })();`;
    webFrame.executeJavaScript(wrapped).catch(() => {});
  }
}
