'use strict';

const path = require('path');
const { EventEmitter } = require('events');
const { WebContentsView, BrowserWindow, shell } = require('electron');
const { getLinkSession } = require('./sessions');
const { proxyReady } = require('./proxy');
const { attachEditContextMenu, wirePopupSessions } = require('./editContextMenu');
const { TOOLBAR_HEIGHT, SIDEBAR_COLLAPSED_WIDTH } = require('./constants');

const LINK_PRELOAD = path.join(__dirname, '..', '..', 'preload', 'link-preload.js');

// Owns every WebContentsView instance (one per *loaded* link) and lays them
// out under the shell's toolbar/sidebar chrome. Emits events that ipc.js
// wires up to unread tracking, notifications, and shell broadcasts.
// Chrome's zoom presets, limited to the 50%-300% range the Edit dialog allows.
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

// Mobile view: a phone-sized column in the middle of the content area. Sites see
// an Android Chrome user-agent, a ~412px-wide touch screen and a mobile viewport,
// so both server-side (user-agent) and CSS (width) mobile layouts kick in.
const MOBILE_VIEW_WIDTH = 412;

const DARK_MODE_CSS = `
  html { filter: invert(1) hue-rotate(180deg) !important; background: #fff !important; }
  img, picture, video, canvas { filter: invert(1) hue-rotate(180deg) !important; }
`;

// Pure, so it can be tested. Desktop honours the link's own custom user-agent
// (Edit dialog); with none, it is the session's normal (Electron-free) one.
function userAgentFor(link, sessionUserAgent, chromeVersion) {
  if (link && link.viewMode === 'mobile') {
    const major = String(chromeVersion || '').split('.')[0] || '120';
    return `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
  }
  const custom = link && link.userAgent && link.userAgent.trim();
  return custom || sessionUserAgent;
}

// Pure. What navigator.userAgentData and the Sec-CH-UA-* request headers report
// in mobile view (sites that ignore the user-agent text read these instead).
function clientHintsFor(chromeVersion) {
  const full = String(chromeVersion || '120.0.0.0');
  const major = full.split('.')[0] || '120';
  const list = (v, grease) => [
    { brand: 'Chromium', version: v },
    { brand: 'Google Chrome', version: v },
    { brand: 'Not.A/Brand', version: grease },
  ];
  return {
    brands: list(major, '99'),
    fullVersionList: list(full, '99.0.0.0'),
    platform: 'Android',
    platformVersion: '14.0.0',
    architecture: '',
    model: 'Pixel 8',
    mobile: true,
    bitness: '',
    wow64: false,
  };
}

const normHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
function hostOf(u) {
  try { return normHost(new URL(u).hostname); } catch (_e) { return ''; }
}
function sameSite(a, b) {
  const x = hostOf(a);
  const y = hostOf(b);
  return !!x && !!y && (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`));
}

class ViewManager extends EventEmitter {
  constructor({ mainWindow, store }) {
    super();
    this.mainWindow = mainWindow;
    this.store = store;
    this._darkCssKeys = new Map(); // linkId -> key of the dark-mode CSS in the current page
    this._customCssKeys = new Map(); // linkId -> key of the custom CSS in the current page
    this._modeJobs = new Map(); // linkId -> last queued view-mode job (see _applyViewMode)
    this.views = new Map(); // linkId -> WebContentsView
    this.activeId = null;
    this.modalOpen = false;
    this.sidebarHidden = false; // auto-hide setting: the sidebar is out of sight (see sidebarAutoHide.js)
    // App lock: while true no view is created or shown (see setLocked).
    this.locked = false;
    this._hiddenPopups = [];
  }

  _link(id) {
    return this.store.getState().links.find((l) => l.id === id) || null;
  }

  // Session of the saved link that owns `url`'s site, so a popup to a site
  // you already added (and logged in to) opens logged in. Only when exactly
  // one link matches: with two (e.g. two WhatsApp accounts) it is ambiguous,
  // so return null and the caller keeps the opener's session.
  _sessionForUrl(url) {
    const matches = this.store.getState().links.filter((l) => sameSite(url, l.url));
    if (matches.length !== 1) return null;
    return getLinkSession(matches[0], this.store);
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
    // Locked: nothing new may load, whoever asks (startup, crash retry, IPC).
    if (this.locked) return null;

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
    attachEditContextMenu(wc, { withPageControls: true, mainWindow: this.mainWindow });

    // Ctrl + mouse wheel. Electron doesn't zoom on its own; it just reports the
    // request here (Windows/Linux).
    wc.on('zoom-changed', (_e, direction) => this.stepZoom(id, direction));
    // Inserted CSS belongs to one document, so every new page load needs it again.
    wc.on('dom-ready', () => { this._applyDarkMode(id); this._applyCustomCss(id); });
    wc.on('page-title-updated', (_e, title) => this.emit('title', id, title));
    wc.on('page-favicon-updated', (_e, favicons) => this.emit('favicon', id, favicons));

    const emitStatus = () => {
      if (wc.isDestroyed()) return;
      // error/crashed are set by did-fail-load / render-process-gone below.
      // The renderer merges status patches on top of old ones instead of
      // replacing them, so without clearing these here, a link that once
      // failed stays flagged as errored forever, even after a later
      // successful load — the only past fix was a full app restart, which
      // wipes the renderer's stale merged state.
      this.emit('status', id, {
        loading: wc.isLoading(),
        canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
        canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
        url: wc.getURL(),
        title: wc.getTitle(),
        error: null,
        crashed: false,
      });
    };
    wc.on('did-start-loading', emitStatus);
    wc.on('did-stop-loading', emitStatus);
    wc.on('did-navigate', emitStatus);
    wc.on('did-navigate-in-page', emitStatus);
    // Only the very first load of a view gets one silent retry. Once a page
    // has loaded, a failed navigation usually leaves the working page on
    // screen (e.g. a live Teams meeting), so reloading then would destroy it.
    let hasLoaded = false;
    let firstLoadRetried = false;
    wc.on('did-finish-load', () => {
      hasLoaded = true;
      this.emit('page-loaded', id);
      // Fresh lookup, not the `link` captured when this view was created: that copy
      // is stale once the zoom changes, and every page load would snap back to it.
      try { wc.setZoomFactor((this._link(id) || link).zoom || 1); } catch (_e) { /* ignore */ }
      emitStatus();
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame) return;
      if (code === -3) return; // ERR_ABORTED, usually a redirect/cancel, not a real failure
      if (!hasLoaded && !firstLoadRetried) {
        firstLoadRetried = true;
        setTimeout(() => { if (!wc.isDestroyed() && !hasLoaded) wc.loadURL(link.url); }, 1000);
        return;
      }
      this.emit('status', id, { loading: false, error: desc || `Failed to load (${code})` });
    });
    wc.on('render-process-gone', (_e, details) => {
      this.views.delete(id);
      // The dead view would otherwise stay attached (and alive) forever.
      try { this.mainWindow.contentView.removeChildView(view); } catch (_err) { /* ignore */ }
      try { if (!wc.isDestroyed()) wc.close(); } catch (_err) { /* ignore */ }
      this.emit('crash', id, details);
    });

    // Same stuck-input class as the notification-toast case above: a detached
    // DevTools window returning focus to the main window doesn't always send
    // a real blur/focus cycle either.
    wc.on('devtools-closed', () => this.kickActiveView());

    wc.on('found-in-page', (_e, result) => this.emit('find-result', id, result));

    // OAuth popups: inherit the same partition/session and cleaned UA, never
    // noopener, so cookies set by the popup are visible to the opener — and
    // wirePopupSessions re-applies this same check+session to every window a
    // popup itself opens (a story viewer's "next story" window, etc.), not
    // just the first one, so a login never silently drops a level deep.
    const shouldAllowPopup = (url) => {
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
      if (sameFamily || explicitlyAllowed || allowedHosts.length === 0) return true;
      if (link.navigation && link.navigation.openExternal) shell.openExternal(url);
      return false;
    };
    wirePopupSessions(wc, ses, this.mainWindow, shouldAllowPopup, (url) => {
      // Same-site popups (OAuth etc.) must keep this link's own session.
      if (sameSite(url, link.url)) return null;
      return this._sessionForUrl(url);
    });

    // Same stuck-input class as the notification-toast case above: an OAuth
    // popup closing and returning focus to the main window doesn't always
    // send a real blur/focus cycle either.
    wc.on('did-create-window', (childWindow) => {
      childWindow.on('closed', () => this.kickActiveView());
    });

    this.views.set(id, view);
    this.mainWindow.contentView.addChildView(view);
    view.setVisible(false);
    // Starts muted — a view is only ever created hidden (activate() unmutes
    // it right after if it's the one being switched to), so a site that
    // autoplays audio/video (TikTok, YouTube) never gets heard before the
    // user has actually switched to that tab.
    wc.setAudioMuted(true);
    // Before the first load, so the very first request already says "mobile".
    // A first-time proxy (see proxy.js) must be set before the first request.
    const ready = proxyReady(link.partition);
    if (link.viewMode === 'mobile') {
      this._applyViewMode(id).then(() => ready).then(() => { if (!wc.isDestroyed()) wc.loadURL(link.url); });
    } else if (ready) {
      ready.then(() => { if (!wc.isDestroyed()) wc.loadURL(link.url); });
    } else {
      wc.loadURL(link.url);
    }
    this.layout();
    this.emit('loaded', id);
    return view;
  }

  activate(id) {
    if (this.locked) return false;
    const view = this.ensureView(id);
    if (!view) return false;
    const prevId = this.activeId;
    if (prevId && prevId !== id) {
      const prevView = this.views.get(prevId);
      if (prevView) {
        prevView.setVisible(false);
        const prevLink = this._link(prevId);
        if (!prevLink || !prevLink.keepPlaying) {
          if (!prevView.webContents.isDestroyed()) prevView.webContents.setAudioMuted(true);
          this.emit('deactivated', prevId);
        }
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
    this.focusActive();
    return true;
  }

  // Give the active page real keyboard focus. A click on the sidebar leaves
  // focus in the shell, so the page reports document.hasFocus() === false and
  // sites like WhatsApp Web never mark what you are looking at as read (their
  // badge, and ours, stay lit until you click inside the page).
  focusActive() {
    if (this.locked || this.modalOpen || !this.activeId) return;
    if (!this.mainWindow || this.mainWindow.isDestroyed() || !this.mainWindow.isFocused()) return;
    const view = this.views.get(this.activeId);
    // Focus is cosmetic: it must never break activating a link.
    try { if (view && !view.webContents.isDestroyed()) view.webContents.focus(); } catch (_e) { /* ignore */ }
  }

  // Put focus back in the shell (its inputs: URL bar, quick switch, find, lock).
  focusShell() {
    // Must never throw: this runs inside locking, which has to complete.
    try { if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.webContents.focus(); } catch (_e) { /* ignore */ }
  }

  // Mutes + signals the active view's media to pause without switching which
  // link is active — used when the whole window goes to the tray, so the
  // hidden tab stops making sound/playing video but resumes exactly where it
  // was once the window is shown again.
  suspendActiveMedia() {
    if (!this.activeId) return;
    const link = this._link(this.activeId);
    if (link && link.keepPlaying) return;
    const view = this.views.get(this.activeId);
    if (!view || view.webContents.isDestroyed()) return;
    view.webContents.setAudioMuted(true);
    this.emit('deactivated', this.activeId);
  }

  resumeActiveMedia() {
    if (!this.activeId) return;
    const view = this.views.get(this.activeId);
    if (!view || view.webContents.isDestroyed()) return;
    view.webContents.setAudioMuted(false);
    this.emit('active', this.activeId);
  }

  // App lock. Locking detaches and mutes every view (pages stay alive, so
  // calls and downloads keep going), closes DevTools and hides popup windows
  // (OAuth etc.), so nothing from a link stays visible. Unlocking puts the
  // active view back.
  setLocked(locked) {
    if (this.locked === !!locked) return;
    this.locked = !!locked;
    if (this.locked) {
      this.focusShell(); // the lock screen's password box lives in the shell
      for (const [id, view] of this.views) {
        const wc = view.webContents;
        if (wc.isDestroyed()) continue;
        try { if (wc.isDevToolsOpened()) wc.closeDevTools(); } catch (_e) { /* ignore */ }
        // A link the user marked "keep playing" (music, a call) stays audible.
        const link = this._link(id);
        if (link && link.keepPlaying) continue;
        wc.setAudioMuted(true);
        this.emit('deactivated', id); // pauses the page's media
      }
      try {
        const sw = this.mainWindow.webContents;
        if (sw.isDevToolsOpened()) sw.closeDevTools();
      } catch (_e) { /* ignore */ }
      this._hiddenPopups = BrowserWindow.getAllWindows().filter((w) => w !== this.mainWindow && !w.isDestroyed() && w.isVisible());
      this._hiddenPopups.forEach((w) => w.hide());
      this._syncActiveVisibility();
    } else {
      this._hiddenPopups.forEach((w) => { if (!w.isDestroyed()) w.show(); });
      this._hiddenPopups = [];
      this._syncActiveVisibility();
      this.layout();
      this.resumeActiveMedia();
    }
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
    if (this.modalOpen || this.locked) {
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
    if (this.modalOpen || this.locked) return;
    const view = this.activeId ? this.views.get(this.activeId) : null;
    if (!view) return;
    if (this.mainWindow.contentView.children.includes(view)) {
      this.mainWindow.contentView.removeChildView(view);
    }
    this.mainWindow.contentView.addChildView(view);
    view.setVisible(true);
  }

  // The width the sidebar has when it is showing (narrow when collapsed).
  sidebarWidth() {
    const { ui } = this.store.getState();
    return ui.sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : ui.sidebarWidth;
  }

  setSidebarHidden(hidden) {
    if (this.sidebarHidden === !!hidden) return;
    this.sidebarHidden = !!hidden;
    this.layout();
  }

  layout() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const cb = this.mainWindow.getContentBounds();
    const sidebarWidth = this.sidebarHidden ? 0 : this.sidebarWidth();
    const width = Math.max(0, cb.width - sidebarWidth);
    const height = Math.max(0, cb.height - TOOLBAR_HEIGHT);
    for (const [id, view] of this.views) {
      const link = this._link(id);
      if (link && link.viewMode === 'mobile') {
        const w = Math.min(width, MOBILE_VIEW_WIDTH);
        view.setBounds({ x: sidebarWidth + Math.floor((width - w) / 2), y: TOOLBAR_HEIGHT, width: w, height });
        this._syncMobileSize(id);
      } else {
        view.setBounds({ x: sidebarWidth, y: TOOLBAR_HEIGHT, width, height });
      }
    }
  }

  // Makes a loaded view match its link's viewMode. Mobile uses Chrome's DevTools
  // protocol (the same thing as DevTools device mode): user-agent, client hints
  // (Sec-CH-UA-Mobile, navigator.userAgentData), a touch screen and a mobile
  // viewport, all in one. Calls for one view run one after another. Never rejects.
  _applyViewMode(id) {
    const prev = this._modeJobs.get(id) || Promise.resolve();
    const job = prev.then(() => this._applyViewModeNow(id)).catch(() => {});
    this._modeJobs.set(id, job);
    return job;
  }

  async _applyViewModeNow(id) {
    const link = this._link(id);
    const view = this.views.get(id);
    if (!link || !view || view.webContents.isDestroyed()) return;
    const wc = view.webContents;
    const ua = userAgentFor(link, wc.session.getUserAgent(), process.versions.chrome);
    try { if (wc.getUserAgent() !== ua) wc.setUserAgent(ua); } catch (_e) { /* ignore */ }
    if (link.viewMode !== 'mobile') {
      // Detaching clears every override the protocol session set.
      try { wc.disableDeviceEmulation(); } catch (_e) { /* ignore */ }
      try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch (_e) { /* ignore */ }
      return;
    }
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Emulation.setUserAgentOverride', {
        userAgent: ua,
        platform: 'Linux armv81',
        userAgentMetadata: clientHintsFor(process.versions.chrome),
      });
      await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await this._sendMobileMetrics(view);
    } catch (_e) {
      // Protocol unavailable (e.g. another client holds it): still give the page
      // a phone-sized touch screen the older way. The user-agent text is set above.
      try {
        const size = this._mobileSize(view);
        wc.enableDeviceEmulation({
          screenPosition: 'mobile',
          screenSize: size,
          viewPosition: { x: 0, y: 0 },
          deviceScaleFactor: 0,
          viewSize: size,
          scale: 1,
        });
      } catch (_e2) { /* best-effort; the page still loads */ }
    }
  }

  _mobileSize(view) {
    const { width, height } = view.getBounds();
    return { width: width || MOBILE_VIEW_WIDTH, height: height || 800 };
  }

  _sendMobileMetrics(view) {
    const { width, height } = this._mobileSize(view);
    return view.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 0,
      mobile: true,
      screenWidth: width,
      screenHeight: height,
    });
  }

  // Window resized: keep the emulated screen the same size as the view. If the
  // protocol session is gone, set everything up again.
  _syncMobileSize(id) {
    const view = this.views.get(id);
    if (!view || view.webContents.isDestroyed()) return;
    try {
      if (view.webContents.debugger.isAttached()) {
        this._sendMobileMetrics(view).catch(() => {});
        return;
      }
    } catch (_e) { /* fall through */ }
    this._applyViewMode(id);
  }

  // Dark mode for any site: invert the page, then flip media back so photos and
  // video keep their real colors. Sites with a dark theme of their own look
  // light when this is on; that is what the toggle is for.
  async _applyDarkMode(id) {
    const link = this._link(id);
    const view = this.views.get(id);
    if (!link || !view || view.webContents.isDestroyed()) return;
    const wc = view.webContents;
    const oldKey = this._darkCssKeys.get(id);
    this._darkCssKeys.delete(id);
    try {
      if (oldKey) await wc.removeInsertedCSS(oldKey);
    } catch (_e) { /* the old document is gone, nothing to remove */ }
    if (!link.darkMode || wc.isDestroyed()) return;
    try {
      const key = await wc.insertCSS(DARK_MODE_CSS);
      this._darkCssKeys.set(id, key);
    } catch (_e) { /* page went away mid-insert */ }
  }

  // Custom CSS the user wrote for this page's domain (toolbar button). Stored by
  // domain in the store, so it comes back after restarts and on every link or
  // page of that domain.
  async _applyCustomCss(id) {
    const view = this.views.get(id);
    if (!view || view.webContents.isDestroyed()) return;
    const wc = view.webContents;
    const oldKey = this._customCssKeys.get(id);
    this._customCssKeys.delete(id);
    try {
      if (oldKey) await wc.removeInsertedCSS(oldKey);
    } catch (_e) { /* the old document is gone, nothing to remove */ }
    if (wc.isDestroyed()) return;
    const entry = this.store.getState().customCss[hostOf(wc.getURL())];
    if (!entry || !entry.css) return;
    try {
      const key = await wc.insertCSS(entry.css);
      this._customCssKeys.set(id, key);
    } catch (_e) { /* page went away mid-insert */ }
  }

  // Custom CSS was saved: update every loaded page now, not only on next load.
  refreshCustomCss() {
    for (const id of this.views.keys()) this._applyCustomCss(id);
  }

  // Toolbar toggle. Saved on the link, so it survives hibernation and restarts.
  setDarkMode(id, on) {
    const link = this._link(id);
    if (!link || !!link.darkMode === !!on) return false;
    this.store.updateLink(id, { darkMode: !!on });
    this._applyDarkMode(id);
    return true;
  }

  // Toolbar toggle. Saved on the link, so it survives hibernation and restarts.
  // A user-agent only applies to new requests, so a loaded page is reloaded.
  async setViewMode(id, mode) {
    if (mode !== 'desktop' && mode !== 'mobile') return false;
    const link = this._link(id);
    if (!link || (link.viewMode || 'desktop') === mode) return false;
    this.store.updateLink(id, { viewMode: mode });
    const view = this.views.get(id);
    if (view && !view.webContents.isDestroyed()) {
      this.layout();
      await this._applyViewMode(id);
      if (!view.webContents.isDestroyed()) view.webContents.reload();
    }
    return true;
  }

  hibernate(id) {
    const view = this.views.get(id);
    if (!view) return false;
    this._darkCssKeys.delete(id);
    this._customCssKeys.delete(id);
    try {
      if (this.activeId === id) this.activeId = null;
      this.mainWindow.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    } catch (_e) { /* ignore */ }
    this.views.delete(id);
    this._modeJobs.delete(id);
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

  findInPage(id, text, options) {
    const view = this.views.get(id);
    if (!view || view.webContents.isDestroyed()) return false;
    if (!text) {
      view.webContents.stopFindInPage('clearSelection');
      return false;
    }
    view.webContents.findInPage(text, options);
    return true;
  }

  stopFindInPage(id) {
    const view = this.views.get(id);
    if (view && !view.webContents.isDestroyed()) view.webContents.stopFindInPage('clearSelection');
  }

  openDevTools(id) {
    const view = this.views.get(id) || this.ensureView(id);
    if (!view) return;
    view.webContents.openDevTools({ mode: 'detach' });
  }

  // Chrome/Edge-style zoom: 'in' / 'out' move to the next preset step, 'reset'
  // returns to 100%. Saved on the link (same field the Edit dialog uses), so it
  // survives restarts and hibernation.
  stepZoom(id, direction) {
    const link = this._link(id);
    if (!link) return;
    const current = link.zoom || 1;
    let next = current;
    if (direction === 'reset') next = 1;
    else if (direction === 'in') next = ZOOM_STEPS.find((z) => z > current + 0.001) || ZOOM_STEPS[ZOOM_STEPS.length - 1];
    else if (direction === 'out') next = ZOOM_STEPS.slice().reverse().find((z) => z < current - 0.001) || ZOOM_STEPS[0];
    if (Math.abs(next - current) < 0.001) return;
    this.store.updateLink(id, { zoom: next });
    this.updateLinkRuntimeConfig(id);
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

module.exports = { ViewManager, userAgentFor, clientHintsFor, hostOf };
