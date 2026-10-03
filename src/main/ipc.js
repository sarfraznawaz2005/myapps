'use strict';

const fs = require('fs');
const path = require('path');
const { ipcMain, app } = require('electron');
const { CH } = require('./constants');
const contextMenus = require('./contextMenus');
const navigation = require('./navigation');
const favicon = require('./favicon');
const autolaunch = require('./autolaunch');
const shortcuts = require('./shortcuts');
const hibernationMod = require('./hibernation');
const geolocation = require('./geolocation');
const permissionPrompt = require('./permissionPrompt');
const updateCheck = require('./updateCheck');
const passwords = require('./passwords');
const { applyDnsSettings } = require('./dns');

const WHATSAPP_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'preload', 'whatsapp-main-world.js'),
  'utf8'
);

const INJECTED_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'preload', 'inject-main-world.js'),
  'utf8'
);

// Keywords are typed by the user: keep unique strings of 3 to 100 characters
// (shorter ones would match inside almost every word).
const MIN_KEYWORD_LENGTH = 3;
function cleanKeywords(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const word = typeof raw === 'string' ? raw.trim().slice(0, 100) : '';
    if (word.length < MIN_KEYWORD_LENGTH || seen.has(word.toLowerCase())) continue;
    seen.add(word.toLowerCase());
    out.push(word);
    if (out.length >= 100) break;
  }
  return out;
}

const WHATSAPP_FLAGS = ['blurNames', 'blurPhotos', 'blurMessages', 'blurRecent', 'hideOnline',
  'hideBlueTicks', 'viewStatusPrivately', 'restoreDeleted', 'notifyOnline'];

// Only known keys, only booleans / a short list of short strings.
function cleanWhatsapp(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const key of WHATSAPP_FLAGS) {
    if (key in src) out[key] = !!src[key];
  }
  if ('notifyContacts' in src) {
    const seen = new Set();
    out.notifyContacts = [];
    for (const raw of Array.isArray(src.notifyContacts) ? src.notifyContacts : []) {
      const entry = typeof raw === 'string' ? raw.trim().slice(0, 80) : '';
      if (!entry || seen.has(entry.toLowerCase())) continue;
      seen.add(entry.toLowerCase());
      out.notifyContacts.push(entry);
      if (out.notifyContacts.length >= 50) break;
    }
  }
  return out;
}

// Which options could attach inside the page: { optionName: 'ok' | 'missing' }.
function cleanWhatsappStatus(input) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const key of WHATSAPP_FLAGS) {
    if (src[key] === 'ok' || src[key] === 'missing') out[key] = src[key];
  }
  return out;
}

// "Chat with a number": digits only, 7 to 15 of them (international format).
function whatsappChatUrl(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return `https://web.whatsapp.com/send?phone=${digits}`;
}

function buildLinkRuleConfig(link, settings, userscripts) {
  return {
    expert: {
      ...link.unread.expert,
      enabled: !!(link.unread.enabled && link.unread.expert.enabled),
    },
    scrollArrows: !!(settings && settings.scrollArrows),
    highlightKeywords: cleanKeywords(settings && settings.highlightKeywords),
    whatsapp: cleanWhatsapp(link.whatsapp),
    passwordManager: !!(settings && settings.passwordManager),
    revealPassword: !!(settings && settings.revealPassword),
    imageZoom: !!(settings && settings.imageZoom),
    // Sent as raw (matches + code), one list for every link — the page
    // itself decides whether any pattern matches its own URL. Userscripts
    // only run once per page load, so editing one only takes effect on the
    // next navigation/reload, not live.
    userscripts: (userscripts || [])
      .filter((u) => u.enabled)
      .map((u) => ({ name: u.name, matches: u.matches, code: u.code })),
  };
}

// Pushes the current config (expert rule + global toggles like scrollArrows)
// to every link that's currently loaded — used after a global settings
// change, since that isn't tied to any single link's update.
function broadcastLinkConfig(ctx) {
  const { store, viewManager } = ctx;
  const { settings, userscripts } = store.getState();
  for (const link of store.getState().links) {
    const view = viewManager.getView(link.id);
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.send(CH.LINK_CONFIG, buildLinkRuleConfig(link, settings, userscripts));
    }
  }
}

function sendToShell(ctx, channel, payload) {
  const w = ctx.mainWindow;
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

// webContents.send() only reaches the main frame — a site that embeds its
// real content in a same-origin iframe (webmail behind a hosting-panel
// wrapper page, for example) never gets these otherwise.
function sendToAllFrames(webContents, channel, ...args) {
  for (const frame of webContents.mainFrame.framesInSubtree) {
    try { webContents.sendToFrame(frame.routingId, channel, ...args); } catch (_e) { /* frame gone mid-loop */ }
  }
}

function pushLinkConfig(ctx, link) {
  const view = ctx.viewManager.getView(link.id);
  if (view && !view.webContents.isDestroyed()) {
    const { settings, userscripts } = ctx.store.getState();
    view.webContents.send(CH.LINK_CONFIG, buildLinkRuleConfig(link, settings, userscripts));
  }
}

function recomputeAggregate(ctx) {
  const aggregate = ctx.indicator.computeAggregate(ctx.unreadTracker);
  ctx.indicator.apply(aggregate);
  sendToShell(ctx, CH.SHELL_AGGREGATE, aggregate);
  return aggregate;
}

// While the app is locked only these requests are answered; everything else
// (open a link, export data, change settings, ...) is refused in main, so a
// tampered or scripted shell cannot get around the lock screen.
const ALLOWED_WHEN_LOCKED = new Set([
  CH.APP_GET_STATE, CH.APP_QUIT, CH.LOCK_STATUS, CH.LOCK_UNLOCK,
]);

function initIpc(ctx) {
  const { store, viewManager, unreadTracker, indicator, notifications, tray, appLock } = ctx;
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    if (appLock.isLocked() && !ALLOWED_WHEN_LOCKED.has(channel)) return null;
    return fn(event, ...args);
  });
  ctx.lastCounts = new Map();
  ctx.crashInfo = new Map();
  permissionPrompt.init(ctx);
  const vaultApi = passwords.init(ctx);

  // ---- store change -> push full state to shell ----
  store.onChange((state) => sendToShell(ctx, CH.SHELL_STATE, state));

  // ---- unread tracker -> shell + aggregate + synthesized notifications ----
  unreadTracker.onChange((linkId, effective) => {
    sendToShell(ctx, CH.SHELL_UNREAD, { linkId, ...effective });
    const prev = ctx.lastCounts.get(linkId) || null;
    // Not every link reports a real number — favicon-only detection (e.g.
    // Outlook) only ever gives a yes/no "activity" flag. Always run this so
    // boolean-only signals can still trigger a notification, not just counts.
    notifications.maybeSynthesize(linkId, {
      prevCount: prev ? prev.count : null,
      newCount: effective.count,
      prevActivity: prev ? prev.activity : false,
      newActivity: effective.activity,
    });
    ctx.lastCounts.set(linkId, { count: effective.count, activity: effective.activity });
    recomputeAggregate(ctx);
  });

  // ---- viewManager events ----
  viewManager.on('title', (id, title) => unreadTracker.reportTitle(id, title));

  viewManager.on('favicon', (id, favicons) => {
    unreadTracker.reportFavicon(id, favicons);
    const link = store.getState().links.find((l) => l.id === id);
    if (favicons && favicons.length && link) {
      favicon.cacheFavicon(id, favicons, link.partition).then((cachedPath) => {
        if (!cachedPath) return;
        // Must be saved to the store, not just pushed over IPC — the store is
        // the source of truth that gets re-broadcast in full (SHELL_STATE) on
        // every unrelated change (switching links, reordering, etc). If we
        // only sent the one-off event, the next full-state broadcast would
        // overwrite it with the persisted (still-null) icon.path and the
        // favicon would appear to vanish on switch.
        store.updateLink(id, { icon: { path: cachedPath } });
        sendToShell(ctx, CH.SHELL_FAVICON, { linkId: id, path: cachedPath });
      });
    }
  });

  viewManager.on('status', (id, patch) => {
    sendToShell(ctx, CH.SHELL_LINK_STATUS, { linkId: id, ...patch });
    if (viewManager.getActiveId() === id) {
      sendToShell(ctx, CH.SHELL_NAV, { linkId: id, ...patch });
    }
  });

  viewManager.on('active', (id) => {
    sendToShell(ctx, CH.SHELL_ACTIVE, { linkId: id });
    const view = viewManager.getView(id);
    if (view && !view.webContents.isDestroyed()) sendToAllFrames(view.webContents, CH.LINK_MEDIA_RESUME);
  });

  viewManager.on('deactivated', (id) => {
    const view = viewManager.getView(id);
    if (view && !view.webContents.isDestroyed()) sendToAllFrames(view.webContents, CH.LINK_MEDIA_PAUSE);
  });

  viewManager.on('hibernated', (id) => {
    sendToShell(ctx, CH.SHELL_LINK_STATUS, { linkId: id, hibernated: true });
    recomputeAggregate(ctx);
  });

  viewManager.on('loaded', (id) => {
    sendToShell(ctx, CH.SHELL_LINK_STATUS, { linkId: id, hibernated: false });
  });

  // Find results only matter for whichever link is on screen right now — a
  // background tab's stale search shouldn't paint over the visible one.
  viewManager.on('find-result', (id, result) => {
    if (viewManager.getActiveId() !== id) return;
    sendToShell(ctx, CH.SHELL_FIND_RESULT, {
      matches: result.matches,
      activeMatchOrdinal: result.activeMatchOrdinal,
    });
  });

  viewManager.on('crash', (id, details) => {
    const wasActive = viewManager.getActiveId() === id;
    const info = ctx.crashInfo.get(id) || { count: 0, first: Date.now() };
    if (Date.now() - info.first > 60000) { info.count = 0; info.first = Date.now(); }
    info.count += 1;
    ctx.crashInfo.set(id, info);

    const link = store.getState().links.find((l) => l.id === id);
    // Only one silent auto-retry, not two — a link that's genuinely broken
    // (bad driver/GPU state, etc.) used to crash, quietly reload, and crash
    // again before the "keeps crashing" error ever surfaced.
    if (info.count <= 1) {
      sendToShell(ctx, CH.SHELL_TOAST, {
        type: 'warning',
        message: `${link ? link.name : 'A link'} crashed (${details && details.reason}) — reloading.`,
      });
      setTimeout(() => {
        viewManager.ensureView(id);
        if (wasActive) viewManager.activate(id);
      }, 500);
    } else {
      sendToShell(ctx, CH.SHELL_LINK_STATUS, { linkId: id, crashed: true, error: 'Crashed repeatedly — reload manually.' });
      sendToShell(ctx, CH.SHELL_TOAST, {
        type: 'error',
        message: `${link ? link.name : 'A link'} keeps crashing. Reload it manually from the sidebar.`,
      });
    }
  });

  // ---- link preload -> main ----
  ipcMain.on(CH.LINK_BOOTSTRAP, (event, linkId) => {
    const link = store.getState().links.find((l) => l.id === linkId);
    const { settings, userscripts } = store.getState();
    event.returnValue = {
      config: link ? buildLinkRuleConfig(link, settings, userscripts) : { expert: { enabled: false }, scrollArrows: false, highlightKeywords: cleanKeywords(settings.highlightKeywords), userscripts: [] },
      source: INJECTED_SOURCE,
      whatsappSource: WHATSAPP_SOURCE,
    };
  });

  // WhatsApp extras. Choices come from the toolbar dialog in the shell; the
  // page only reports back which options could attach.
  const whatsappStatus = new Map(); // linkId -> { option: 'ok' | 'missing' }
  const whatsappSettingsOf = (link) => ({ notifyContacts: [], ...cleanWhatsapp(link.whatsapp) });
  ipcMain.on(CH.LINK_WHATSAPP_STATUS, (_event, linkId, status) => {
    whatsappStatus.set(linkId, cleanWhatsappStatus(status));
  });
  handle(CH.LINK_WHATSAPP_GET, (_event, id) => {
    const link = store.getState().links.find((l) => l.id === id);
    if (!link) return null;
    return { settings: whatsappSettingsOf(link), status: whatsappStatus.get(id) || {} };
  });
  handle(CH.LINK_WHATSAPP_SET, (_event, id, patch) => {
    const link = store.updateLink(id, { whatsapp: cleanWhatsapp(patch) });
    if (!link) return null;
    pushLinkConfig(ctx, link);
    return whatsappSettingsOf(link);
  });
  handle(CH.LINK_WHATSAPP_CHAT, (_event, id, raw) => {
    const url = whatsappChatUrl(raw);
    const view = viewManager.getView(id);
    if (!url || !view || view.webContents.isDestroyed()) return false;
    try {
      if (new URL(view.webContents.getURL()).hostname !== 'web.whatsapp.com') return false;
    } catch (_e) { return false; }
    view.webContents.loadURL(url);
    return true;
  });

  ipcMain.on(CH.LINK_BADGE, (_event, linkId, count) => unreadTracker.reportBadge(linkId, count));
  ipcMain.on(CH.LINK_EXPERT, (_event, linkId, payload) => unreadTracker.reportExpert(linkId, payload || {}));
  ipcMain.on(CH.LINK_NOTIFICATION, (_event, linkId, payload) => {
    // A real notification is proof of new activity on its own — light up the
    // sidebar/tray/taskbar even for services with no count/DOM signal wired up.
    unreadTracker.reportNotified(linkId);
    notifications.handlePageNotification(linkId, payload || {});
  });
  ipcMain.on(CH.LINK_PICKED_ELEMENT, (_event, linkId, payload) => {
    sendToShell(ctx, CH.SHELL_OPEN_DIALOG, { type: 'picked-element', linkId, ...payload });
  });

  handle(CH.LINK_FIND, (_event, text, options) => {
    const id = viewManager.getActiveId();
    if (!id) return false;
    return viewManager.findInPage(id, text, options);
  });

  handle(CH.LINK_FIND_STOP, () => {
    const id = viewManager.getActiveId();
    if (id) viewManager.stopFindInPage(id);
  });

  // Gate stays here rather than in navigator.geolocation itself, so a link
  // with location off gets the same PERMISSION_DENIED (code 1) a real
  // browser would give, without ever shelling out to Windows.
  handle(CH.LINK_GET_LOCATION, async (_event, linkId) => {
    const link = store.getState().links.find((l) => l.id === linkId);
    if (!link) return { ok: false, code: 2, message: 'Link not found.' };

    if (!link.navigation.locationDecided) {
      // First time this link has asked — show a real Allow/Block prompt
      // (same as camera/mic) instead of silently denying, and remember the
      // answer so we never ask again for this link.
      const { allow, decided } = await permissionPrompt.ask(link, 'location');
      if (decided) {
        store.updateLink(link.id, { navigation: { allowLocation: allow, locationDecided: true } });
        permissionPrompt.toast(
          allow ? 'success' : 'warning',
          `Location ${allow ? 'allowed' : 'blocked'} for ${link.name}.`
        );
      }
      if (!allow) return { ok: false, code: 1, message: 'Location is not enabled for this link.' };
    } else {
      // Already decided (prompt earlier, or preset by hand in the Edit
      // dialog) — still toast every time a site actually uses it, cached
      // fix or not, so it's never silent.
      const allow = !!link.navigation.allowLocation;
      permissionPrompt.toast(allow ? 'success' : 'warning', `Location ${allow ? 'allowed' : 'blocked'} for ${link.name}.`);
      if (!allow) return { ok: false, code: 1, message: 'Location is not enabled for this link.' };
    }

    // A user-set manual position (Settings > General > Location) always wins
    // over Windows — skip the PowerShell round-trip entirely when it's set.
    const manual = geolocation.parseManualLocation(store.getState().settings.manualLocation);
    if (manual) return { ok: true, coords: manual };

    // geolocation.js toasts "Asking Windows…" / "Windows found your
    // location." itself around the actual fetch — nothing to add here.
    try {
      const { fromCache, ...coords } = await geolocation.getWindowsLocation();
      return { ok: true, coords };
    } catch (e) {
      return { ok: false, code: e.code || 2, message: e.message || 'Position unavailable.' };
    }
  });

  // The shell's Allow/Block modal calls this once the user clicks a button;
  // permissionPrompt.respond() looks up the matching pending request by id.
  handle(CH.LINK_PERMISSION_RESPOND, (_event, id, allow) => {
    permissionPrompt.respond(id, allow);
  });

  // ---- shell -> main: invoke ----
  handle(CH.APP_GET_STATE, () => ({
    ...store.getState(),
    unread: unreadTracker.getAll(),
    aggregate: indicator.lastAggregate,
    activeLinkId: viewManager.getActiveId(),
    loadedLinkIds: Array.from(viewManager.views.keys()),
    lock: appLock.status(),
  }));

  // ---- app lock ----
  appLock.on('locked', () => {
    viewManager.setLocked(true);
    sendToShell(ctx, CH.SHELL_LOCK, appLock.status());
  });
  appLock.on('unlocked', () => {
    viewManager.setLocked(false);
    sendToShell(ctx, CH.SHELL_LOCK, appLock.status());
    // First unlock after a locked start: the workspace was held back.
    if (!ctx.workspaceStarted) startWorkspace();
    else if (!viewManager.getActiveId()) activateStartupLink();
  });

  handle(CH.LOCK_STATUS, () => appLock.status());
  handle(CH.LOCK_UNLOCK, (_event, password) => appLock.unlock(password));
  handle(CH.LOCK_NOW, () => (appLock.lock() ? { ok: true } : { ok: false, error: 'no-password' }));
  handle(CH.LOCK_SET, (_event, payload) => {
    const p = payload || {};
    return appLock.setPassword(p.password, p.current);
  });
  handle(CH.LOCK_REMOVE, (_event, current) => appLock.removePassword(current));

  handle(CH.APP_QUIT, () => {
    ctx.isQuitting = true;
    app.quit();
  });

  handle(CH.APP_CHECK_UPDATE, () => updateCheck.checkForUpdate());

  handle(CH.APP_OPEN_EXTERNAL_URL, (_event, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) navigation.openExternal(url);
    return true;
  });

  handle(CH.LINK_CREATE, (_event, data) => store.createLink(data));

  handle(CH.LINK_UPDATE, (_event, id, patch) => {
    const wasActive = viewManager.getActiveId() === id;
    const link = store.updateLink(id, patch);
    if (link) {
      if (patch && patch.enabled === false) {
        // Hidden apps behave as though they don't exist — drop the live
        // view so the memory is actually freed, not just kept off-screen.
        if (viewManager.isLoaded(id)) viewManager.hibernate(id);
        if (wasActive) {
          const order = shortcuts.getFlattenedLinkOrder(store);
          if (order[0]) viewManager.activate(order[0]);
        }
      } else {
        viewManager.updateLinkRuntimeConfig(id);
        pushLinkConfig(ctx, link);
      }
    }
    return link;
  });

  handle(CH.LINK_DELETE, async (_event, id, opts) => {
    if (viewManager.isLoaded(id)) viewManager.hibernate(id);
    unreadTracker.remove(id);
    // lastCounts/crashInfo are keyed by linkId and only ever grow — without
    // this, deleting and recreating links over a long session slowly builds
    // up entries for ids that no longer exist.
    ctx.lastCounts.delete(id);
    ctx.crashInfo.delete(id);
    if (opts && opts.deleteData) {
      await viewManager.clearData(id);
      favicon.removeCachedFavicon(id);
    }
    recomputeAggregate(ctx);
    return store.deleteLink(id);
  });

  handle(CH.LINK_REORDER, (_event, orderedIds, groupId) => store.reorderLinks(orderedIds, groupId));

  handle(CH.LINK_ACTIVATE, (_event, id) => {
    unreadTracker.clearNotified(id);
    return viewManager.activate(id);
  });

  handle(CH.LINK_HIBERNATE, (_event, id) => viewManager.hibernate(id));
  // Toolbar desktop/mobile toggle.
  handle(CH.LINK_VIEW_MODE, (_event, id, mode) => viewManager.setViewMode(id, mode));
  // Toolbar dark mode toggle.
  handle(CH.LINK_DARK_MODE, (_event, id, on) => viewManager.setDarkMode(id, !!on));
  // Toolbar / menu zoom buttons: same Chrome-style steps as Ctrl+= / Ctrl+- / Ctrl+0.
  handle(CH.LINK_ZOOM, (_event, id, direction) => {
    if (!['in', 'out', 'reset'].includes(direction)) return false;
    viewManager.stepZoom(id, direction);
    return true;
  });

  handle(CH.LINK_RELOAD, (_event, id) => viewManager.reload(id));

  handle(CH.LINK_CLEAR_DATA, async (_event, id) => {
    await viewManager.clearData(id);
    favicon.removeCachedFavicon(id);
    return true;
  });

  handle(CH.LINK_DEVTOOLS, (_event, id) => {
    viewManager.openDevTools(id);
    return true;
  });

  handle(CH.LINK_TEST_EXPERT_RULE, async (_event, id, rule) => {
    const view = viewManager.getView(id) || viewManager.ensureView(id);
    if (!view) return { ok: false, error: 'Link is not loaded' };
    const script = `(window.__myappsTestExpertRule ? window.__myappsTestExpertRule(${JSON.stringify(rule)}) : { ok: false, error: 'Page not ready yet — try again in a moment.' })`;
    // Try every frame (main page + any same-origin iframes) — a site can
    // embed its real content in an iframe, and the selector only exists
    // there, not on the outer page.
    let lastResult = { ok: false, error: 'Page not ready yet — try again in a moment.' };
    for (const frame of view.webContents.mainFrame.framesInSubtree) {
      try {
        const result = await frame.executeJavaScript(script);
        if (result && result.ok && result.matched > 0) return result;
        lastResult = result;
      } catch (err) {
        lastResult = { ok: false, error: String((err && err.message) || err) };
      }
    }
    return lastResult;
  });

  handle(CH.LINK_PICK_ELEMENT, (_event, id) => {
    const view = viewManager.getView(id) || viewManager.ensureView(id);
    if (!view) return false;
    sendToAllFrames(view.webContents, CH.LINK_START_PICKER);
    return true;
  });

  handle(CH.LINK_PROBE_URL, (_event, url) => navigation.probeUrl(url));

  handle(CH.USERSCRIPT_CREATE, (_event, data) => store.createUserscript(data));
  handle(CH.USERSCRIPT_UPDATE, (_event, id, patch) => store.updateUserscript(id, patch));
  handle(CH.USERSCRIPT_DELETE, (_event, id) => store.deleteUserscript(id));

  handle(CH.COMMAND_CREATE, (_event, data) => store.createCommand(data));
  handle(CH.COMMAND_UPDATE, (_event, id, patch) => store.updateCommand(id, patch));
  handle(CH.COMMAND_DELETE, (_event, id) => store.deleteCommand(id));

  handle(CH.NOTE_SET, (_event, url, text) => store.setNote(url, text));

  handle(CH.GROUP_CREATE, (_event, data) => store.createGroup(data));
  handle(CH.GROUP_UPDATE, (_event, id, patch) => store.updateGroup(id, patch));
  handle(CH.GROUP_DELETE, (_event, id, opts) => store.deleteGroup(id, opts));
  handle(CH.GROUP_REORDER, (_event, orderedIds) => store.reorderGroups(orderedIds));

  handle(CH.SETTINGS_UPDATE, (_event, patch) => {
    if (Object.prototype.hasOwnProperty.call(patch, 'highlightKeywords')) patch = { ...patch, highlightKeywords: cleanKeywords(patch.highlightKeywords) };
    const settings = store.updateSettings(patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'startWithOS')) autolaunch.syncAutoLaunch(store);
    if (Object.prototype.hasOwnProperty.call(patch, 'showTrayIcon')) {
      if (patch.showTrayIcon) tray.create(); else tray.destroy();
    }
    tray.refreshMenu();
    if (Object.prototype.hasOwnProperty.call(patch, 'dnd')) recomputeAggregate(ctx);
    if (Object.prototype.hasOwnProperty.call(patch, 'scrollArrows') || Object.prototype.hasOwnProperty.call(patch, 'highlightKeywords') || Object.prototype.hasOwnProperty.call(patch, 'passwordManager') || Object.prototype.hasOwnProperty.call(patch, 'revealPassword') || Object.prototype.hasOwnProperty.call(patch, 'imageZoom')) broadcastLinkConfig(ctx);
    if (Object.prototype.hasOwnProperty.call(patch, 'dnsProvider') || Object.prototype.hasOwnProperty.call(patch, 'dnsCustomServer')) {
      applyDnsSettings(settings);
    }
    return settings;
  });

  // Saved logins go into the file only when an Export Key is set, and only
  // locked with that key (never plain text).
  handle(CH.SETTINGS_EXPORT, () => passwords.buildExport(store.exportJSON(), vaultApi));

  handle(CH.SETTINGS_IMPORT, (_event, text, typedKey) => {
    // Unlock first: a wrong key must fail before anything is replaced.
    const prepared = passwords.prepareImport(text, typedKey, vaultApi);
    if (prepared.error) return { error: prepared.error };
    viewManager.destroyAll();
    unreadTracker.clear();
    ctx.lastCounts.clear();
    const state = store.importJSON(prepared.json);
    vaultApi.mergeImported(prepared.payload);
    tray.refreshMenu();
    return state;
  });

  handle(CH.DND_SET, (_event, patch) => {
    const settings = store.updateSettings({ dnd: patch });
    tray.refreshMenu();
    recomputeAggregate(ctx);
    return settings.dnd;
  });

  handle(CH.NAV_GO, (_event, direction) => {
    const id = viewManager.getActiveId();
    if (!id) return false;
    if (direction === 'back') viewManager.goBack(id);
    else if (direction === 'forward') viewManager.goForward(id);
    else if (direction === 'reload') viewManager.reload(id);
    else if (direction === 'stop') viewManager.stop(id);
    else if (direction === 'home') viewManager.goHome(id);
    return true;
  });

  handle(CH.NAV_NAVIGATE, (_event, url) => {
    const id = viewManager.getActiveId();
    if (!id) return false;
    return viewManager.navigate(id, url);
  });

  handle(CH.NAV_COPY_URL, () => {
    const id = viewManager.getActiveId();
    const view = id ? viewManager.getView(id) : null;
    const link = store.getState().links.find((l) => l.id === id);
    navigation.copyUrlToClipboard((view && view.webContents.getURL()) || (link && link.url) || '');
    return true;
  });

  handle(CH.NAV_OPEN_EXTERNAL, () => {
    const id = viewManager.getActiveId();
    const view = id ? viewManager.getView(id) : null;
    const link = store.getState().links.find((l) => l.id === id);
    navigation.openExternal((view && view.webContents.getURL()) || (link && link.url) || '');
    return true;
  });

  handle(CH.METRICS_GET, () => hibernationMod.getMemoryReport(store, viewManager));

  handle(CH.MENU_LINK_CONTEXT, (_event, linkId) => {
    contextMenus.showLinkContextMenu({
      linkId,
      store,
      viewManager,
      mainWindow: ctx.mainWindow,
      sendToShell: (channel, payload) => sendToShell(ctx, channel, payload),
    });
    return true;
  });

  // ---- shell -> main: send (fire and forget) ----
  ipcMain.on(CH.UI_LAYOUT, (_event, payload) => {
    if (payload) {
      store.updateUi({
        sidebarWidth: payload.sidebarWidth,
        sidebarCollapsed: payload.sidebarCollapsed,
        showToolbar: payload.showToolbar,
        sidebarFooterOpen: payload.sidebarFooterOpen,
        ungroupedCollapsed: payload.ungroupedCollapsed,
      });
    }
    viewManager.layout();
  });

  ipcMain.on(CH.UI_MODAL_OPEN, (_event, isOpen) => {
    viewManager.setModalOpen(!!isOpen);
    if (!isOpen) {
      for (const link of store.getState().links) {
        const view = viewManager.getView(link.id);
        if (view && !view.webContents.isDestroyed()) sendToAllFrames(view.webContents, CH.LINK_STOP_PICKER);
      }
    }
  });

  function activateStartupLink() {
    const { ui, links } = store.getState();
    if (ui.lastActiveLinkId && links.find((l) => l.id === ui.lastActiveLinkId && l.enabled)) {
      viewManager.activate(ui.lastActiveLinkId);
    } else {
      const order = shortcuts.getFlattenedLinkOrder(store);
      if (order[0]) viewManager.activate(order[0]);
    }
  }

  // Opens the last link and pre-loads the "open on startup" ones. Held back
  // while locked (ensureView refuses anyway) and run once after the first
  // unlock.
  function startWorkspace() {
    ctx.workspaceStarted = true;
    const { links } = store.getState();
    activateStartupLink();
    // Pre-load the rest of "open on startup" links in the background — this
    // only loads their view (so they're instant when clicked), it does not
    // switch the visible tab away from whatever was just activated above.
    // Staggered, not fired all at once: a burst of simultaneous connections
    // right at cold app startup (Windows' network stack is still warming up)
    // can trip transient failures — e.g. one link's own follow-up redirect
    // failing with ERR_ADDRESS_INVALID because several other tabs were still
    // mid-handshake at that exact moment — leaving that tab blank until a
    // manual reload. Spacing the starts out avoids piling every tab's first
    // connection into the same instant.
    let staggerDelay = 0;
    for (const link of links) {
      if (link.openOnStartup && !viewManager.isLoaded(link.id)) {
        const linkId = link.id;
        setTimeout(() => {
          if (!viewManager.isLoaded(linkId)) viewManager.ensureView(linkId);
        }, staggerDelay);
        staggerDelay += 400;
      }
    }
    recomputeAggregate(ctx);
  }

  ipcMain.on(CH.UI_READY, () => {
    const toast = store.takePendingToast();
    if (toast) sendToShell(ctx, CH.SHELL_TOAST, toast);
    if (appLock.isLocked()) {
      viewManager.setLocked(true);
      return;
    }
    if (!ctx.workspaceStarted) startWorkspace();
  });
}

module.exports = { initIpc, buildLinkRuleConfig, cleanKeywords, cleanWhatsapp, whatsappChatUrl, sendToShell, recomputeAggregate };
