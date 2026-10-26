'use strict';

const path = require('path');
const { WebContentsView, net } = require('electron');

const PAGE = path.join(__dirname, '..', 'renderer', 'offline.html');
const WIDTH = 190;
const HEIGHT = 34;
const MARGIN = 14;
const POLL_MS = 2000;

// A small red "No internet connection" pill in the bottom-right corner of the
// window, drawn above the pages. It stays while the computer has no network and
// removes itself when the network is back. It never takes clicks away from a
// page for long: it is small and only exists while offline.
class OfflineIndicator {
  constructor({ mainWindow }) {
    this.mainWindow = mainWindow;
    this.view = null;
    this.timer = null;
  }

  start() {
    this.check();
    this.timer = setInterval(() => this.check(), POLL_MS);
    this.mainWindow.on('resize', () => this.reposition());
    this.mainWindow.on('maximize', () => this.reposition());
    this.mainWindow.on('unmaximize', () => this.reposition());
    this.mainWindow.on('closed', () => this.stop());
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._remove();
  }

  check() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return this.stop();
    let online = true;
    try { online = net.isOnline(); } catch (_e) { /* assume online */ }
    if (online) this._remove(); else this._show();
  }

  _show() {
    if (!this.view || this.view.webContents.isDestroyed()) {
      this.view = new WebContentsView({
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      this.view.setBackgroundColor('#00000000');
      this.view.webContents.loadFile(PAGE).catch(() => {});
    }
    this.reposition();
    // Always the top-most view, even after a page view was re-attached.
    const kids = this.mainWindow.contentView.children;
    if (kids[kids.length - 1] !== this.view) {
      try { this.mainWindow.contentView.removeChildView(this.view); } catch (_e) { /* not attached yet */ }
      this.mainWindow.contentView.addChildView(this.view);
    }
  }

  reposition() {
    if (!this.view || this.view.webContents.isDestroyed() || this.mainWindow.isDestroyed()) return;
    const b = this.mainWindow.getContentBounds();
    this.view.setBounds({ x: Math.max(0, b.width - WIDTH - MARGIN), y: Math.max(0, b.height - HEIGHT - MARGIN), width: WIDTH, height: HEIGHT });
  }

  _remove() {
    if (!this.view) return;
    try { this.mainWindow.contentView.removeChildView(this.view); } catch (_e) { /* already gone */ }
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
  }
}

module.exports = { OfflineIndicator };
