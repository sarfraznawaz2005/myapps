'use strict';

const path = require('path');
const { WebContentsView, ipcMain } = require('electron');

const PAGE = path.join(__dirname, '..', 'renderer', 'switcher.html');
const PRELOAD = path.join(__dirname, '..', '..', 'preload', 'switcher-preload.js');

// The picture shown by the Ctrl+Tab link switcher: a transparent view laid over the
// whole window, which takes the keyboard focus while it is open and sends every key
// press and release back to the main process (onKey).
//
// Why it takes the focus: when the app itself swallows a key press (as it must, so the
// page behind never sees Ctrl+Tab, Enter, letters...), Chromium also drops the matching
// key RELEASES, so the release of Ctrl never arrived and switching waited for a timer.
// A page that handles its own keys is not treated that way, so the release arrives at
// once. The page behind is neither hidden nor detached.
//
// A click on a card, or outside the cards, comes back through onPick / onCancel.
class SwitcherOverlay {
  constructor({ mainWindow, store, onPick, onCancel, onKey }) {
    this.mainWindow = mainWindow;
    this.store = store;
    this.view = null;
    this.ready = null;
    this.queue = Promise.resolve();

    // Only the overlay's own page may send these.
    const fromOverlay = (event) => !!this.view && !this.view.webContents.isDestroyed() && event.sender === this.view.webContents;
    ipcMain.on('switcher:pick', (event, index) => { if (fromOverlay(event) && onPick) onPick(index); });
    ipcMain.on('switcher:cancel', (event) => { if (fromOverlay(event) && onCancel) onCancel(); });
    ipcMain.on('switcher:key', (event, input) => {
      if (!fromOverlay(event) || !onKey || !input || typeof input !== 'object') return;
      if (input.type !== 'keyDown' && input.type !== 'keyUp') return;
      onKey({
        type: input.type,
        key: typeof input.key === 'string' ? input.key.slice(0, 32) : '',
        control: !!input.control,
        shift: !!input.shift,
        alt: !!input.alt,
        meta: !!input.meta,
        isAutoRepeat: !!input.isAutoRepeat,
      });
    });

    this._ensure(); // loaded ahead of time, so the first Ctrl+Tab is as quick as the rest
  }

  _ensure() {
    if (this.view && !this.view.webContents.isDestroyed()) return;
    this.view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: PRELOAD },
    });
    this.view.setBackgroundColor('#00000000');
    this.ready = this.view.webContents.loadFile(PAGE).catch(() => {});
    this.queue = Promise.resolve();
  }

  // Calls window.__switcher.<fn>(arg) in the overlay page, in order.
  _call(fn, arg) {
    const wc = this.view && this.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    const code = `window.__switcher.${fn}(${arg === undefined ? '' : JSON.stringify(arg)})`;
    this.queue = this.queue
      .then(() => this.ready)
      .then(() => (wc.isDestroyed() ? undefined : wc.executeJavaScript(code)))
      .catch(() => {});
  }

  // state = { items, index, query, total } (see LinkSwitcher.state)
  show(state) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this._ensure();
    const { settings } = this.store.getState();
    const b = this.mainWindow.getContentBounds();
    this.view.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
    // Remove first so re-adding puts it above every page view.
    try { this.mainWindow.contentView.removeChildView(this.view); } catch (_e) { /* not attached yet */ }
    this.mainWindow.contentView.addChildView(this.view);
    // Keys now go to the overlay page. Focus is cosmetic: it must never break showing the cards.
    try { this.view.webContents.focus(); } catch (_e) { /* ignore */ }
    this._call('show', { ...state, theme: settings.theme, accent: settings.accent });
  }

  update(state) {
    this._call('update', state);
  }

  hide() {
    if (!this.view) return;
    this._call('hide');
    try { this.mainWindow.contentView.removeChildView(this.view); } catch (_e) { /* already gone */ }
  }
}

module.exports = { SwitcherOverlay };
