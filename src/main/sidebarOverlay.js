'use strict';

const path = require('path');
const { WebContentsView } = require('electron');

const PAGE = path.join(__dirname, '..', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, '..', '..', 'preload', 'shell-preload.js');

// Only the messages the sidebar draws from. Dialogs, toasts, the lock screen and the
// find bar belong to the main window.
const FORWARD = new Set(['shell:state', 'shell:unread', 'shell:aggregate', 'shell:link-status', 'shell:favicon', 'shell:active']);

// A second copy of the sidebar, floating on top of the pages (the pages keep their
// size, so nothing in them is redrawn). It is the same page as the main window
// (index.html) started with ?sidebar=1, which shows only the sidebar. It gets the same
// state messages as the main window. Anything that needs a dialog is handed to the
// main window instead (see 'ui:sidebar-action' in ipc.js).
//
// Used by the "hide the sidebar until the mouse goes far left" setting
// (sidebarAutoHide.js). Created when that setting is on, removed when it is off.
class SidebarOverlay {
  constructor({ mainWindow }) {
    this.mainWindow = mainWindow;
    this.view = null;
    this.attached = false;
    this.bounds = null;

    // Every message the main window gets also goes to the overlay (when it is there).
    const wc = mainWindow.webContents;
    const send = wc.send.bind(wc);
    wc.send = (channel, ...args) => {
      send(channel, ...args);
      const own = this.view && this.view.webContents;
      if (own && !own.isDestroyed() && FORWARD.has(channel)) own.send(channel, ...args);
    };
  }

  isReady() {
    return !!this.view && !this.view.webContents.isDestroyed();
  }

  create() {
    if (this.isReady()) return;
    this.view = new WebContentsView({
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    this.view.webContents.loadFile(PAGE, { query: { sidebar: '1' } }).catch(() => {});
  }

  // Show it over the left edge of the window, `width` wide and as tall as the window.
  show(width) {
    if (!this.isReady() || !this.mainWindow || this.mainWindow.isDestroyed()) return;
    const box = this.mainWindow.getContentBounds();
    const next = { x: 0, y: 0, width: Math.max(0, Math.round(width)), height: box.height };
    const changed = !this.bounds || this.bounds.width !== next.width || this.bounds.height !== next.height;
    if (changed) { this.view.setBounds(next); this.bounds = next; }
    // Always the top-most view, even after a page view was re-attached.
    const kids = this.mainWindow.contentView.children;
    if (!this.attached || kids[kids.length - 1] !== this.view) {
      try { this.mainWindow.contentView.removeChildView(this.view); } catch (_e) { /* not attached yet */ }
      this.mainWindow.contentView.addChildView(this.view);
      this.attached = true;
    }
  }

  hide() {
    if (!this.attached || !this.view) return;
    this.attached = false;
    const hadFocus = !this.view.webContents.isDestroyed() && this.view.webContents.isFocused();
    try { this.mainWindow.contentView.removeChildView(this.view); } catch (_e) { /* already gone */ }
    return hadFocus; // the caller gives the keyboard back to the page
  }

  destroy() {
    this.hide();
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
    this.bounds = null;
  }
}

module.exports = { SidebarOverlay };
