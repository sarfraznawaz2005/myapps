'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { WebContentsView, shell } = require('electron');
const { getLinkSession } = require('./sessions');
const { attachEditContextMenu } = require('./editContextMenu');
const { TOOLBAR_HEIGHT, SIDEBAR_COLLAPSED_WIDTH } = require('./constants');

const LINK_PRELOAD = path.join(__dirname, '..', '..', 'preload', 'link-preload.js');

// Owns every WebContentsView instance (one per *loaded* link) and lays them
// out under the shell's toolbar/sidebar chrome. Emits events that ipc.js
// wires up to unread tracking, notifications, and shell broadcasts.
class ViewManager extends EventEmitter {
  constructor({ mainWindow, store }) {
    super();
    this.mainWindow = mainWindow;
    this.store = store;
    this.views = new Map(); // linkId -> WebContentsView
    this.activeId = null;
    this.modalOpen = false;
  }

  _link(id) {
    return this.store.getState().links.find((l) => l.id === id) || null;
  }

  isLoaded(id) {
    return this.views.has(id);
  }

  getActiveId() {
    return this.activeId;
  }

  getView(id) {
    return this.views.get(id) || null;
  }

  ensureView(id) {
    let view = this.views.get(id);
    if (view) return view;
    const link = this._link(id);
    if (!link) return null;
    // A disabled (hidden) link must never spin up a WebContentsView — that
    // is the whole point of hiding it, so memory is actually freed.
    if (!link.enabled) return null;

    const ses = getLinkSession(link, this.store);
    // "Keep awake" already exists in the Edit dialog as the user's one
    // switch for "keep this live while I'm not looking at it" — wiring
    // throttling to it too (instead of unread/notifications, which default
    // true on every link) means turning it off actually lightens the tab
    // immediately, not just after the idle-hibernate timer eventually fires.
    const backgroundThrottling = !(link.hibernate && link.hibernate.keepAwake);

    view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: LINK_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        // Off by default in Electron — without this, our preload (and so
        // the expert-rule engine, element picker, etc.) never runs inside
        // a site's own iframes, only its outer page.
        nodeIntegrationInSubFrames: true,
        backgroundThrottling,
        spellcheck: !!this.store.getState().settings.spellcheck,
        additionalArguments: [`--link-id=${id}`],
      },
    });
    // White, not our shell's dark backdrop color — most sites don't paint an
    // explicit background everywhere, and whatever we set here shows through
    // those gaps. A normal browser's default is white, so this is white too;
    // using our shell's dark color instead made light sites look broken.
    view.setBackgroundColor('#ffffff');

    const wc = view.webContents;
    attachEditContextMenu(wc);

    wc.on('page-title-updated', (_e, title) => this.emit('title', id, title));
    wc.on('page-favicon-updated', (_e, favicons) => this.emit('favicon', id, favicons));

    const emitStatus = () => {
      if (wc.isDestroyed()) return;
      this.emit('status', id, {
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
        canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
        url: wc.getURL(),
        title: wc.getTitle(),
      });
    };
    wc.on('did-start-loading', emitStatus);
    wc.on('did-stop-loading', emitStatus);
    wc.on('did-navigate', emitStatus);
    wc.on('did-navigate-in-page', emitStatus);
    wc.on('did-finish-load', () => {
      try { wc.setZoomFactor(link.zoom || 1); } catch (_e) { /* ignore */ }
      emitStatus();
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame) return;
      if (code === -3) return; // ERR_ABORTED, usually a redirect/cancel, not a real failure
      this.emit('status', id, { loading: false, error: desc || `Failed to load (${code})` });
    });
    wc.on('render-process-gone', (_e, details) => {
      this.views.delete(id);
      this.emit('crash', id, details);
    });

    wc.setWindowOpenHandler(({ url }) => {
      let targetHost = null;
      try { targetHost = new URL(url).hostname; } catch (_e) { /* ignore */ }
      let originHost = null;
      try { originHost = new URL(link.url).hostname; } catch (_e) { /* ignore */ }
      const allowedHosts = (link.navigation && link.navigation.allowedPopupHosts) || [];
      const sameFamily = targetHost && originHost && (
        targetHost === originHost ||
        targetHost.endsWith(`.${originHost}`) ||
        originHost.endsWith(`.${targetHost}`)
      );
      const explicitlyAllowed = targetHost && allowedHosts.some(
        (h) => targetHost === h || targetHost.endsWith(`.${h}`)
      );
      if (sameFamily || explicitlyAllowed || allowedHosts.length === 0) {
        // OAuth popups: inherit the same partition/session and cleaned UA,
        // never noopener, so cookies set by the popup are visible to the opener.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            backgroundColor: '#ffffff',
            webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false },
          },
        };
      }
      if (link.navigation && link.navigation.openExternal) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    this.views.set(id, view);
    this.mainWindow.contentView.addChildView(view);
    view.setVisible(false);
    // Starts muted — a view is only ever created hidden (activate() unmutes
    // it right after if it's the one being switched to), so a site that
    // autoplays audio/video (TikTok, YouTube) never gets heard before the
    // user has actually switched to that tab.
    wc.setAudioMuted(true);
    wc.loadURL(link.url);
    this.layout();
    this.emit('loaded', id);
    return view;
  }

  activate(id) {
    const view = this.ensureView(id);
    if (!view) return false;
    const prevId = this.activeId;
    if (prevId && prevId !== id) {
      const prevView = this.views.get(prevId);
      if (prevView) {
        prevView.setVisible(false);
        if (!prevView.webContents.isDestroyed()) prevView.webContents.setAudioMuted(true);
      }
    }
    this.activeId = id;
    view.webContents.setAudioMuted(false);
    this._syncActiveVisibility();
    this.layout();
    this.store.updateUi({ lastActiveLinkId: id });
    const link = this._link(id);
    if (link) this.store.updateLink(id, { lastActiveAt: Date.now() });
    this.emit('active', id);
    return true;
  }

  setModalOpen(open) {
    this.modalOpen = open;
    this._syncActiveVisibility();
  }

  // Detaching (not just hiding) the active view while a modal/menu is open
  // avoids a white-flash on Windows: WebContentsView.setVisible(false) alone
  // can leave a stale white paint over the shell instead of revealing it.
  _syncActiveVisibility() {
    const view = this.activeId ? this.views.get(this.activeId) : null;
    if (!view) return;
    const attached = this.mainWindow.contentView.children.includes(view);
    if (this.modalOpen) {
      if (attached) this.mainWindow.contentView.removeChildView(view);
    } else {
      if (!attached) this.mainWindow.contentView.addChildView(view);
      view.setVisible(true);
    }
  }

  // Windows can occasionally leave the active WebContentsView unable to
  // receive clicks after a native popup (a notification toast, an OAuth
  // popup) steals and returns focus — the same class of native z-order bug
  // _syncActiveVisibility works around for modals. Detaching and
  // re-attaching forces Windows to redo input hit-testing without needing a
  // full hide/show of the whole app window.
  kickActiveView() {
    if (this.modalOpen) return;
    const view = this.activeId ? this.views.get(this.activeId) : null;
    if (!view) return;
    if (this.mainWindow.contentView.children.includes(view)) {
      this.mainWindow.contentView.removeChildView(view);
    }
    this.mainWindow.contentView.addChildView(view);
    view.setVisible(true);
  }

  layout() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const cb = this.mainWindow.getContentBounds();
    const { ui } = this.store.getState();
    const sidebarWidth = ui.sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : ui.sidebarWidth;
    const width = Math.max(0, cb.width - sidebarWidth);
    const height = Math.max(0, cb.height - TOOLBAR_HEIGHT);
    for (const view of this.views.values()) {
      view.setBounds({ x: sidebarWidth, y: TOOLBAR_HEIGHT, width, height });
    }
  }

  hibernate(id) {
    const view = this.views.get(id);
    if (!view) return false;
    try {
      if (this.activeId === id) this.activeId = null;
      this.mainWindow.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    } catch (_e) { /* ignore */ }
    this.views.delete(id);
    this.emit('hibernated', id);
    return true;
  }

  reload(id) {
    const view = this.views.get(id) || this.ensureView(id);
    if (!view) return false;
    view.webContents.reload();
    return true;
  }

  reloadAllLoaded() {
    for (const view of this.views.values()) {
      if (!view.webContents.isDestroyed()) view.webContents.reload();
    }
  }

  stop(id) {
    const view = this.views.get(id);
    if (view && !view.webContents.isDestroyed()) view.webContents.stop();
  }

  goBack(id) {
    const view = this.views.get(id);
    if (!view) return;
    const wc = view.webContents;
    if (wc.navigationHistory) wc.navigationHistory.goBack(); else wc.goBack();
  }

  goForward(id) {
    const view = this.views.get(id);
    if (!view) return;
    const wc = view.webContents;
    if (wc.navigationHistory) wc.navigationHistory.goForward(); else wc.goForward();
  }

  goHome(id) {
    const link = this._link(id);
    const view = this.views.get(id);
    if (link && view) view.webContents.loadURL(link.url);
  }

  navigate(id, url) {
    const view = this.views.get(id) || this.ensureView(id);
    if (!view) return false;
    let target = url;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target)) target = `https://${target}`;
    view.webContents.loadURL(target);
    return true;
  }

  clearData(id) {
    const link = this._link(id);
    if (!link) return Promise.resolve();
    const wasLoaded = this.views.has(id);
    if (wasLoaded) this.hibernate(id);
    const { session } = require('electron');
    const ses = session.fromPartition(link.partition);
    return ses.clearStorageData().then(() => ses.clearCache());
  }

  openDevTools(id) {
    const view = this.views.get(id) || this.ensureView(id);
    if (!view) return;
    view.webContents.openDevTools({ mode: 'detach' });
  }

  updateLinkRuntimeConfig(id) {
    // Called after a link's config changes. Some options (backgroundThrottling)
    // are construction-time-only; respawn the view to apply them.
    const link = this._link(id);
    const view = this.views.get(id);
    if (!link || !view) return;
    const desiredThrottle = !(link.hibernate && link.hibernate.keepAwake);
    try { view.webContents.setBackgroundThrottling(desiredThrottle); } catch (_e) { /* ignore */ }
    try { view.webContents.setZoomFactor(link.zoom || 1); } catch (_e) { /* ignore */ }
  }

  destroyAll() {
    for (const id of Array.from(this.views.keys())) this.hibernate(id);
  }
}

module.exports = { ViewManager };
