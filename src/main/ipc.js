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

const INJECTED_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'preload', 'inject-main-world.js'),
  'utf8'
);

function buildLinkRuleConfig(link) {
  return {
    expert: {
      ...link.unread.expert,
      enabled: !!(link.unread.enabled && link.unread.expert.enabled),
    },
  };
}

function sendToShell(ctx, channel, payload) {
  const w = ctx.mainWindow;
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

function pushLinkConfig(ctx, link) {
  const view = ctx.viewManager.getView(link.id);
  if (view && !view.webContents.isDestroyed()) {
    view.webContents.send(CH.LINK_CONFIG, buildLinkRuleConfig(link));
  }
}

function recomputeAggregate(ctx) {
  const aggregate = ctx.indicator.computeAggregate(ctx.unreadTracker);
  ctx.indicator.apply(aggregate);
  sendToShell(ctx, CH.SHELL_AGGREGATE, aggregate);
  return aggregate;
}

function initIpc(ctx) {
  const { store, viewManager, unreadTracker, indicator, notifications, tray } = ctx;
  ctx.lastCounts = new Map();
  ctx.crashInfo = new Map();

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

  viewManager.on('active', (id) => sendToShell(ctx, CH.SHELL_ACTIVE, { linkId: id }));

  viewManager.on('hibernated', (id) => {
    sendToShell(ctx, CH.SHELL_LINK_STATUS, { linkId: id, hibernated: true });
    recomputeAggregate(ctx);
  });

  viewManager.on('loaded', (id) => {
    sendToShell(ctx, CH.SHELL_LINK_STATUS, { linkId: id, hibernated: false });
  });

  viewManager.on('crash', (id, details) => {
    const wasActive = viewManager.getActiveId() === id;
    const info = ctx.crashInfo.get(id) || { count: 0, first: Date.now() };
    if (Date.now() - info.first > 60000) { info.count = 0; info.first = Date.now(); }
    info.count += 1;
    ctx.crashInfo.set(id, info);

    const link = store.getState().links.find((l) => l.id === id);
    if (info.count <= 2) {
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
    event.returnValue = {
      config: link ? buildLinkRuleConfig(link) : { expert: { enabled: false } },
      source: INJECTED_SOURCE,
    };
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

  // ---- shell -> main: invoke ----
  ipcMain.handle(CH.APP_GET_STATE, () => ({
    ...store.getState(),
    unread: unreadTracker.getAll(),
    aggregate: indicator.lastAggregate,
    activeLinkId: viewManager.getActiveId(),
    loadedLinkIds: Array.from(viewManager.views.keys()),
  }));

  ipcMain.handle(CH.APP_QUIT, () => {
    ctx.isQuitting = true;
    app.quit();
  });

  ipcMain.handle(CH.LINK_CREATE, (_event, data) => store.createLink(data));

  ipcMain.handle(CH.LINK_UPDATE, (_event, id, patch) => {
    const link = store.updateLink(id, patch);
    if (link) {
      viewManager.updateLinkRuntimeConfig(id);
      pushLinkConfig(ctx, link);
    }
    return link;
  });

  ipcMain.handle(CH.LINK_DELETE, async (_event, id, opts) => {
    if (viewManager.isLoaded(id)) viewManager.hibernate(id);
    unreadTracker.remove(id);
    if (opts && opts.deleteData) {
      await viewManager.clearData(id);
      favicon.removeCachedFavicon(id);
    }
    recomputeAggregate(ctx);
    return store.deleteLink(id);
  });

  ipcMain.handle(CH.LINK_REORDER, (_event, orderedIds, groupId) => store.reorderLinks(orderedIds, groupId));

  ipcMain.handle(CH.LINK_ACTIVATE, (_event, id) => {
    unreadTracker.clearNotified(id);
    return viewManager.activate(id);
  });

  ipcMain.handle(CH.LINK_HIBERNATE, (_event, id) => viewManager.hibernate(id));

  ipcMain.handle(CH.LINK_RELOAD, (_event, id) => viewManager.reload(id));

  ipcMain.handle(CH.LINK_CLEAR_DATA, async (_event, id) => {
    await viewManager.clearData(id);
    favicon.removeCachedFavicon(id);
    return true;
  });

  ipcMain.handle(CH.LINK_DEVTOOLS, (_event, id) => {
    viewManager.openDevTools(id);
    return true;
  });

  ipcMain.handle(CH.LINK_TEST_EXPERT_RULE, async (_event, id, rule) => {
    const view = viewManager.getView(id) || viewManager.ensureView(id);
    if (!view) return { ok: false, error: 'Link is not loaded' };
    try {
      const result = await view.webContents.executeJavaScript(
        `(window.__myappsTestExpertRule ? window.__myappsTestExpertRule(${JSON.stringify(rule)}) : { ok: false, error: 'Page not ready yet — try again in a moment.' })`
      );
      return result;
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle(CH.LINK_PICK_ELEMENT, (_event, id) => {
    const view = viewManager.getView(id) || viewManager.ensureView(id);
    if (!view) return false;
    view.webContents.send(CH.LINK_START_PICKER);
    return true;
  });

  ipcMain.handle(CH.LINK_PROBE_URL, (_event, url) => navigation.probeUrl(url));

  ipcMain.handle(CH.GROUP_CREATE, (_event, data) => store.createGroup(data));
  ipcMain.handle(CH.GROUP_UPDATE, (_event, id, patch) => store.updateGroup(id, patch));
  ipcMain.handle(CH.GROUP_DELETE, (_event, id, opts) => store.deleteGroup(id, opts));
  ipcMain.handle(CH.GROUP_REORDER, (_event, orderedIds) => store.reorderGroups(orderedIds));

  ipcMain.handle(CH.SETTINGS_UPDATE, (_event, patch) => {
    const settings = store.updateSettings(patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'startWithOS')) autolaunch.syncAutoLaunch(store);
    if (Object.prototype.hasOwnProperty.call(patch, 'showTrayIcon')) {
      if (patch.showTrayIcon) tray.create(); else tray.destroy();
    }
    tray.refreshMenu();
    if (Object.prototype.hasOwnProperty.call(patch, 'dnd')) recomputeAggregate(ctx);
    return settings;
  });

  ipcMain.handle(CH.SETTINGS_EXPORT, () => store.exportJSON());

  ipcMain.handle(CH.SETTINGS_IMPORT, (_event, json) => {
    viewManager.destroyAll();
    unreadTracker.clear();
    ctx.lastCounts.clear();
    const state = store.importJSON(json);
    tray.refreshMenu();
    return state;
  });

  ipcMain.handle(CH.DND_SET, (_event, patch) => {
    const settings = store.updateSettings({ dnd: patch });
    tray.refreshMenu();
    recomputeAggregate(ctx);
    return settings.dnd;
  });

  ipcMain.handle(CH.NAV_GO, (_event, direction) => {
    const id = viewManager.getActiveId();
    if (!id) return false;
    if (direction === 'back') viewManager.goBack(id);
    else if (direction === 'forward') viewManager.goForward(id);
    else if (direction === 'reload') viewManager.reload(id);
    else if (direction === 'stop') viewManager.stop(id);
    else if (direction === 'home') viewManager.goHome(id);
    return true;
  });

  ipcMain.handle(CH.NAV_NAVIGATE, (_event, url) => {
    const id = viewManager.getActiveId();
    if (!id) return false;
    return viewManager.navigate(id, url);
  });

  ipcMain.handle(CH.NAV_COPY_URL, () => {
    const id = viewManager.getActiveId();
    const view = id ? viewManager.getView(id) : null;
    const link = store.getState().links.find((l) => l.id === id);
    navigation.copyUrlToClipboard((view && view.webContents.getURL()) || (link && link.url) || '');
    return true;
  });

  ipcMain.handle(CH.NAV_OPEN_EXTERNAL, () => {
    const id = viewManager.getActiveId();
    const view = id ? viewManager.getView(id) : null;
    const link = store.getState().links.find((l) => l.id === id);
    navigation.openExternal((view && view.webContents.getURL()) || (link && link.url) || '');
    return true;
  });

  ipcMain.handle(CH.METRICS_GET, () => hibernationMod.getMemoryReport(store, viewManager));

  ipcMain.handle(CH.MENU_LINK_CONTEXT, (_event, linkId) => {
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
      });
    }
    viewManager.layout();
  });

  ipcMain.on(CH.UI_MODAL_OPEN, (_event, isOpen) => {
    viewManager.setModalOpen(!!isOpen);
    if (!isOpen) {
      for (const link of store.getState().links) {
        const view = viewManager.getView(link.id);
        if (view && !view.webContents.isDestroyed()) view.webContents.send(CH.LINK_STOP_PICKER);
      }
    }
  });

  ipcMain.on(CH.UI_READY, () => {
    const toast = store.takePendingToast();
    if (toast) sendToShell(ctx, CH.SHELL_TOAST, toast);

    const { ui, links } = store.getState();
    if (ui.lastActiveLinkId && links.find((l) => l.id === ui.lastActiveLinkId)) {
      viewManager.activate(ui.lastActiveLinkId);
    } else {
      const order = shortcuts.getFlattenedLinkOrder(store);
      if (order[0]) viewManager.activate(order[0]);
    }
    // Pre-load the rest of "open on startup" links in the background — this
    // only loads their view (so they're instant when clicked), it does not
    // switch the visible tab away from whatever was just activated above.
    for (const link of links) {
      if (link.openOnStartup && !viewManager.isLoaded(link.id)) viewManager.ensureView(link.id);
    }
    recomputeAggregate(ctx);
  });
}

module.exports = { initIpc, buildLinkRuleConfig, sendToShell, recomputeAggregate };
