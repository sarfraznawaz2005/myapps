'use strict';

const path = require('path');
const { Tray, Menu, nativeImage, app } = require('electron');

const ASSETS = path.join(__dirname, '..', '..', 'assets');

class TrayController {
  constructor({ store, showAppWindow, quitApp, toggleDnd }) {
    this.store = store;
    this.showAppWindow = showAppWindow;
    this.quitApp = quitApp;
    this.toggleDnd = toggleDnd;
    this.tray = null;
    this.hasUnread = false;
  }

  create() {
    if (!this.store.getState().settings.showTrayIcon) return;
    const icon = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
    this.tray = new Tray(icon);
    this.tray.setToolTip('My Apps');
    this._buildMenu();

    this.tray.on('click', () => {
      this.showAppWindow();
    });
  }

  destroy() {
    if (this.tray) { this.tray.destroy(); this.tray = null; }
  }

  setUnread(hasUnread) {
    this.hasUnread = hasUnread;
    if (!this.tray) return;
    const iconFile = hasUnread ? 'tray-unread.png' : 'tray.png';
    this.tray.setImage(path.join(ASSETS, iconFile));
    this.tray.setToolTip(hasUnread ? 'My Apps — new activity' : 'My Apps');
  }

  _buildMenu() {
    if (!this.tray) return;
    const { settings } = this.store.getState();
    const menu = Menu.buildFromTemplate([
      { label: 'Show My Apps', click: () => this.showAppWindow() },
      { type: 'separator' },
      {
        label: 'Do Not Disturb',
        type: 'checkbox',
        checked: !!(settings.dnd && settings.dnd.enabled),
        click: (item) => this.toggleDnd(item.checked),
      },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin,
        click: (item) => {
          this.store.updateSettings({ startWithOS: item.checked });
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => this.quitApp(),
      },
    ]);
    this.tray.setContextMenu(menu);
  }

  refreshMenu() {
    this._buildMenu();
  }

  displayHint() {
    if (!this.tray || !this.tray.displayBalloon || process.platform !== 'win32') return;
    if (this.store.getState().settings.trayHintShown) return;
    this.tray.displayBalloon({
      title: 'My Apps is running in the background',
      content: 'Closing the window keeps My Apps running in the system tray. Use the tray icon to reopen or quit.',
    });
    this.store.updateSettings({ trayHintShown: true });
  }
}

module.exports = { TrayController };
