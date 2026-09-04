'use strict';

const { app, Menu, nativeTheme } = require('electron');
const { APP_ID } = require('./src/main/constants');
const { Store } = require('./src/main/store');
const { createMainWindow } = require('./src/main/window');
const { ViewManager } = require('./src/main/viewManager');
const { UnreadTracker } = require('./src/main/unread');
const { Indicator } = require('./src/main/indicator');
const { NotificationsController } = require('./src/main/notifications');
const { HibernationController } = require('./src/main/hibernation');
const { TrayController } = require('./src/main/tray');
const autolaunch = require('./src/main/autolaunch');
const { attachShortcuts } = require('./src/main/shortcuts');
const { initIpc, recomputeAggregate } = require('./src/main/ipc');
const { startDevReload } = require('./src/main/devReload');

// Must be called before whenReady(), and must match build.appId in
// package.json, or packaged Windows notifications show as "electron.app.Electron".
app.setAppUserModelId(APP_ID);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  Menu.setApplicationMenu(null);

  const ctx = {
    store: null,
    mainWindow: null,
    viewManager: null,
    unreadTracker: null,
    indicator: null,
    notifications: null,
    hibernationController: null,
    tray: null,
    isQuitting: false,
  };

  function showAppWindow() {
    const w = ctx.mainWindow;
    if (!w || w.isDestroyed()) return;
    // A window that went through a real OS minimize (titlebar button) needs
    // to be restored out of that state first — maximizing while still
    // minimized leaves it slightly short of full size once shown.
    if (w.isMinimized()) w.restore();
    // Maximize before show — maximizing after show can race the OS's
    // restore animation and leave the window slightly short of full size.
    if (ctx.store.getState().ui.window.maximized && !w.isMaximized()) w.maximize();
    if (!w.isVisible()) w.show();
    w.focus();
    if (ctx.hibernationController) ctx.hibernationController.onWindowShow();
  }

  function quitApp() {
    ctx.isQuitting = true;
    app.quit();
  }

  function toggleDnd(enabled) {
    ctx.store.updateSettings({ dnd: { enabled: !!enabled, until: null } });
    recomputeAggregate(ctx);
  }

  // Our own shell UI picks dark/light via a data-theme attribute, never the
  // OS setting, so this only affects embedded links. Without it, a Windows
  // dark-mode OS makes Chromium report "prefers-color-scheme: dark" to every
  // loaded site — and some sites carry a dark CSS variant that reacts to that
  // even though they have no visible dark-mode toggle of their own. Forcing
  // light here makes every link render the way it would in a normal browser
  // with a light OS theme.
  nativeTheme.themeSource = 'light';

  app.whenReady().then(() => {
    const store = new Store();
    store.load();
    ctx.store = store;

    const startHidden = autolaunch.wasLaunchedHidden();
    const mainWindow = createMainWindow({ store, startHidden });
    ctx.mainWindow = mainWindow;

    const viewManager = new ViewManager({ mainWindow, store });
    ctx.viewManager = viewManager;

    const unreadTracker = new UnreadTracker(store);
    ctx.unreadTracker = unreadTracker;

    const indicator = new Indicator({ store, tray: null, getMainWindow: () => ctx.mainWindow });
    ctx.indicator = indicator;

    const notifications = new NotificationsController({
      store,
      viewManager,
      getMainWindow: () => ctx.mainWindow,
    });
    ctx.notifications = notifications;

    const hibernationController = new HibernationController({ store, viewManager, unreadTracker });
    ctx.hibernationController = hibernationController;

    const tray = new TrayController({ store, showAppWindow, quitApp, toggleDnd });
    ctx.tray = tray;
    indicator.setTray(tray);

    initIpc(ctx);

    // layoutViews() runs synchronously off these events — never debounced,
    // or resizing gets the classic BrowserView black-gutter lag.
    mainWindow.on('resize', () => viewManager.layout());
    mainWindow.on('maximize', () => viewManager.layout());
    mainWindow.on('unmaximize', () => viewManager.layout());
    mainWindow.on('restore', () => viewManager.layout());

    mainWindow.on('close', (event) => {
      if (ctx.isQuitting) return;
      const { settings } = store.getState();
      if (settings.closeToTray && settings.showTrayIcon) {
        event.preventDefault();
        mainWindow.hide();
        hibernationController.onWindowHide();
        tray.displayHint();
      }
    });

    // Windows sends the exact same 'minimize' event whether the user clicked
    // our titlebar's minimize button or the OS "Show Desktop" command
    // minimized every window at once. WM_SYSCOMMAND/SC_MINIMIZE only fires
    // for a real titlebar click, so we use that to tell the two apart and
    // only send the window to the tray for a genuine user click.
    let minimizeClickedByUser = false;
    if (process.platform === 'win32') {
      const WM_SYSCOMMAND = 0x0112;
      const SC_MINIMIZE = 0xf020;
      mainWindow.hookWindowMessage(WM_SYSCOMMAND, (wParam) => {
        if ((wParam.readUInt16LE(0) & 0xfff0) === SC_MINIMIZE) minimizeClickedByUser = true;
      });
    }

    mainWindow.on('minimize', (event) => {
      const wasUserClick = process.platform !== 'win32' || minimizeClickedByUser;
      minimizeClickedByUser = false;
      const { settings } = store.getState();
      if (wasUserClick && settings.minimizeToTray && settings.showTrayIcon) {
        event.preventDefault();
        mainWindow.hide();
        hibernationController.onWindowHide();
      }
    });

    mainWindow.on('show', () => hibernationController.onWindowShow());

    // A notification-based dot (see unreadTracker.reportNotified) only ever
    // clears on an explicit tab switch. If the user was already sitting on
    // that tab when the notification landed, switching tabs never happens —
    // so also clear it whenever the window comes back into focus while that
    // link is still the active one.
    mainWindow.on('focus', () => {
      const activeId = viewManager.getActiveId();
      if (activeId) unreadTracker.clearNotified(activeId);
    });

    attachShortcuts(mainWindow.webContents, { store, viewManager, mainWindow });
    viewManager.on('loaded', (id) => {
      const view = viewManager.getView(id);
      if (view) attachShortcuts(view.webContents, { store, viewManager, mainWindow });
    });

    if (store.getState().settings.showTrayIcon) tray.create();

    autolaunch.initAutoLaunchDefaultOnce(store);

    startDevReload(ctx);

    app.on('second-instance', () => showAppWindow());

    app.on('before-quit', () => {
      ctx.isQuitting = true;
      viewManager.destroyAll();
      hibernationController.destroy();
      tray.destroy();
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit();
    });
  });
}
