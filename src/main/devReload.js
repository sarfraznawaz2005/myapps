'use strict';

// Dev-only. Watches source files on disk and reloads/restarts as needed —
// no bundler, so this is a full reload, not true state-preserving HMR.
// Never runs in a packaged build (app.isPackaged guards that below).

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer');
const MAIN_DIR = path.join(ROOT, 'src', 'main');
const PRELOAD_DIR = path.join(ROOT, 'preload');
const MAIN_ENTRY = path.join(ROOT, 'main.js');

const WATCHED_EXT = /\.(js|css|html)$/;

// Which action a changed file needs: reload just the shell window, reload
// every open link's WebContentsView, or relaunch the whole app.
function categorize(fullPath) {
  if (fullPath === MAIN_ENTRY || fullPath.startsWith(MAIN_DIR + path.sep)) return 'restart';
  if (fullPath.startsWith(PRELOAD_DIR + path.sep)) {
    return path.basename(fullPath) === 'shell-preload.js' ? 'shell' : 'links';
  }
  if (fullPath.startsWith(RENDERER_DIR + path.sep)) return 'shell';
  return null;
}

function startDevReload(ctx) {
  if (app.isPackaged) return;

  const pendingActions = new Set();
  let timer = null;

  function flush() {
    timer = null;
    const actions = pendingActions;
    pendingActions.clear();
    if (actions.has('restart')) {
      app.relaunch();
      app.exit(0);
      return;
    }
    if (actions.has('shell')) {
      const { mainWindow } = ctx;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache();
    }
    if (actions.has('links') && ctx.viewManager) {
      ctx.viewManager.reloadAllLoaded();
    }
  }

  function onChange(fullPath) {
    if (!WATCHED_EXT.test(fullPath)) return;
    const action = categorize(fullPath);
    if (!action) return;
    pendingActions.add(action);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 200);
  }

  const watchers = [];
  for (const dir of [RENDERER_DIR, MAIN_DIR, PRELOAD_DIR]) {
    try {
      watchers.push(fs.watch(dir, { recursive: true }, (_event, filename) => {
        if (filename) onChange(path.join(dir, filename));
      }));
    } catch (_e) { /* recursive watch unsupported on this platform; dev-only, skip */ }
  }
  try {
    watchers.push(fs.watch(MAIN_ENTRY, () => onChange(MAIN_ENTRY)));
  } catch (_e) { /* ignore */ }

  app.on('before-quit', () => { for (const w of watchers) w.close(); });
}

module.exports = { startDevReload };
