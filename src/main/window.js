'use strict';

const path = require('path');
const { app, BrowserWindow, screen } = require('electron');
const { attachEditContextMenu } = require('./editContextMenu');

function validateBounds(bounds) {
  if (!bounds || typeof bounds.x !== 'number' || typeof bounds.y !== 'number') return null;
  const displays = screen.getAllDisplays();
  const fits = displays.some((d) => {
    const a = d.workArea;
    return bounds.x >= a.x - 50 && bounds.y >= a.y - 50 &&
      bounds.x < a.x + a.width - 50 && bounds.y < a.y + a.height - 50;
  });
  return fits ? bounds : null;
}

function createMainWindow({ store, startHidden }) {
  const { ui } = store.getState();
  const savedBounds = validateBounds(ui.window);
  const width = (savedBounds && savedBounds.width) || ui.window.width || 1280;
  const height = (savedBounds && savedBounds.height) || ui.window.height || 860;

  const winOpts = {
    width,
    height,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: !!store.getState().settings.spellcheck,
    },
  };
  if (savedBounds && typeof savedBounds.x === 'number') {
    winOpts.x = savedBounds.x;
    winOpts.y = savedBounds.y;
  }

  const mainWindow = new BrowserWindow(winOpts);
  mainWindow.setMenuBarVisibility(false);
  attachEditContextMenu(mainWindow.webContents);

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // run.ps1/npm start launches straight from source (unpackaged); the built
  // installer output is packaged. Electron syncs the window title to the
  // page's own <title> tag by default once the page finishes loading, which
  // would silently overwrite a setTitle() called any earlier than this —
  // so this has to run after did-finish-load, not right after loadFile().
  if (!app.isPackaged) {
    mainWindow.webContents.on('did-finish-load', () => mainWindow.setTitle('My Apps - DEV'));
  }

  mainWindow.once('ready-to-show', () => {
    // maximize() forces a hidden window onto the screen on Windows, even
    // without calling show() — so it must only run when we're actually
    // showing the window. showAppWindow() re-applies maximize when the
    // window is later brought back from tray/hidden start.
    if (!startHidden && !store.getState().settings.startMinimized) {
      if (ui.window.maximized) mainWindow.maximize();
      mainWindow.show();
    }
  });

  let boundsSaveTimer = null;
  const saveBoundsDebounced = () => {
    if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      if (mainWindow.isDestroyed()) return;
      const b = mainWindow.getBounds();
      store.updateUi({
        window: {
          x: b.x, y: b.y, width: b.width, height: b.height,
          maximized: mainWindow.isMaximized(),
        },
      });
    }, 300);
  };

  mainWindow.on('resize', saveBoundsDebounced);
  mainWindow.on('move', saveBoundsDebounced);
  mainWindow.on('maximize', saveBoundsDebounced);
  mainWindow.on('unmaximize', saveBoundsDebounced);

  return mainWindow;
}

module.exports = { createMainWindow, validateBounds };
