'use strict';

const { app } = require('electron');

function syncAutoLaunch(store) {
  const { settings } = store.getState();
  if (!app.isPackaged) return; // login items only make sense for installed builds
  try {
    app.setLoginItemSettings({
      openAtLogin: !!settings.startWithOS,
      openAsHidden: true,
      args: ['--hidden'],
    });
  } catch (_e) { /* ignore — not fatal */ }
}

function initAutoLaunchDefaultOnce(store) {
  const { settings } = store.getState();
  if (!app.isPackaged) return;
  if (settings.autoLaunchInitialized) return;
  store.updateSettings({ autoLaunchInitialized: true });
  syncAutoLaunch(store);
}

function wasLaunchedHidden() {
  return process.argv.includes('--hidden');
}

module.exports = { syncAutoLaunch, initAutoLaunchDefaultOnce, wasLaunchedHidden };
