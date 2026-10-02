'use strict';

const fs = require('fs');
const path = require('path');
const { app, ipcMain } = require('electron');

// Ghostery's blocker is loaded once and shared by every link session. Its
// filter lists (ads + trackers) are cached on disk, so later launches start
// from the cache instead of waiting on the network.
let blocker = null;
let loading = null;
// Sessions whose link wants blocking, waiting for the lists to finish loading.
const pending = new Map();

// The blocker also ships "scriptlets": small scripts it runs INSIDE pages to
// rewrite their data and code (uBlock-style json-prune, set-constant, ...).
// They are off. On facebook.com the lists inject 48 of them and 8 declare the
// same top-level `JSONPath`, so seven fail with "Identifier 'JSONPath' has
// already been declared"; the rest rewrite Facebook's own data, which fits
// the feed's intermittent "Something went wrong". Network blocking and hiding
// of ad boxes (CSS) still work without them. Set to true to run them again.
const RUN_PAGE_SCRIPTLETS = false;

// The library runs page-cleaning scripts with `sender.executeJavaScript()` and
// never handles the returned promise. When a script throws on some page, Node
// prints an UnhandledPromiseRejectionWarning each time. Wrap the call so a
// failing script is ignored (the page just keeps that one ad). The same
// scripts also queue many `did-stop-loading` listeners while a page loads, so
// allow more of them on that webContents.
function guardCosmeticScripts(b) {
  const original = b.onInjectCosmeticFilters;
  b.onInjectCosmeticFilters = (event, url, msg) => {
    const sender = event.sender;
    sender.setMaxListeners(Math.max(sender.getMaxListeners(), 50));
    const safeSender = new Proxy(sender, {
      get(target, key) {
        if (key === 'executeJavaScript') {
          if (!RUN_PAGE_SCRIPTLETS) return () => Promise.resolve();
          return (...args) => Promise.resolve(target.executeJavaScript(...args)).catch(() => {});
        }
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const safeEvent = new Proxy(event, {
      get(target, key) {
        if (key === 'sender') return safeSender;
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return original(safeEvent, url, msg);
  };
}

// Filters the blocker must never apply: add one when a blocked request breaks
// a site (for example Facebook's "Something went wrong"). Use Adblock Plus
// syntax; "@@" marks an exception, e.g. '@@||example.com/api/important^'.
// To find the filter, start the app with MYAPPS_ADBLOCK_LOG=1 (see below).
const EXCEPTIONS = [];

function addExceptions(list) {
  if (!blocker || !list.length) return;
  try {
    blocker.updateFromDiff({ added: list });
  } catch (e) {
    console.warn('[adblock] could not add exceptions:', e && e.message);
  }
}

// MYAPPS_ADBLOCK_LOG=1 prints every blocked request with the filter that
// matched it, so a broken page can be traced to one rule.
function logBlocked(b) {
  const clip = (text) => (String(text).length > 220 ? `${String(text).slice(0, 220)}...` : String(text));
  b.on('request-blocked', (request, result) => {
    const filter = result && result.filter ? result.filter.toString() : '(no filter text)';
    console.log(`[adblock] BLOCKED ${request.type} ${clip(request.url)}
          filter: ${filter}
          page: ${clip(request.sourceUrl || '')}`);
  });
  b.on('request-redirected', (request) => {
    console.log(`[adblock] REDIRECTED ${request.type} ${clip(request.url)}`);
  });
}

function load() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const { ElectronBlocker } = require('@ghostery/adblocker-electron');
      const cache = path.join(app.getPath('userData'), 'adblock-engine.bin');
      blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
        path: cache,
        read: fs.promises.readFile,
        write: fs.promises.writeFile,
      });
      guardCosmeticScripts(blocker);
      addExceptions(EXCEPTIONS);
      if (process.env.MYAPPS_ADBLOCK_LOG) logBlocked(blocker);
      for (const [ses, enabled] of pending) apply(ses, enabled);
      pending.clear();
    } catch (e) {
      // Missing package or no network: links keep working, just unblocked.
      console.warn('[adblock] unavailable:', e && e.message);
    }
  })();
  return loading;
}

// The library registers its cosmetic-filter IPC handlers on the global
// ipcMain each time it enables a session. Those handlers do not depend on the
// session, but Electron allows only one per channel, so a second link session
// threw before its network blocking was set up. Handle that here:
// - before enabling, drop the old handlers so the library can add them again;
// - after disabling, put them back if another session still has blocking on.
const IPC_CHANNELS = ['@ghostery/adblocker/inject-cosmetic-filters', '@ghostery/adblocker/is-mutation-observer-enabled'];
const enabledSessions = new Set();

function removeIpcHandlers() {
  for (const channel of IPC_CHANNELS) ipcMain.removeHandler(channel);
}

function restoreIpcHandlers() {
  removeIpcHandlers();
  ipcMain.handle(IPC_CHANNELS[0], blocker.onInjectCosmeticFilters);
  ipcMain.handle(IPC_CHANNELS[1], blocker.onIsMutationObserverEnabled);
}

function apply(ses, enabled) {
  try {
    if (enabled && !enabledSessions.has(ses)) {
      removeIpcHandlers();
      blocker.enableBlockingInSession(ses);
      enabledSessions.add(ses);
    } else if (!enabled && enabledSessions.has(ses)) {
      blocker.disableBlockingInSession(ses);
      enabledSessions.delete(ses);
      if (enabledSessions.size > 0) restoreIpcHandlers();
    }
  } catch (e) {
    console.warn('[adblock] could not update session:', e && e.message);
  }
}

// Turn blocking on/off for one session. Safe to call on every view creation.
function setEnabled(ses, enabled) {
  if (blocker) return apply(ses, enabled);
  pending.set(ses, enabled);
  load();
}

// Resolves once the filter lists are loaded (or loading failed).
function whenReady() {
  return load();
}

module.exports = { setEnabled, whenReady, addExceptions, guardCosmeticScripts };
