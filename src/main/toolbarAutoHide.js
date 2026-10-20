'use strict';

const { TOOLBAR_HEIGHT } = require('./constants');

// Optional "hide the toolbar until the mouse goes to the top" (setting autoHideToolbar).
//
//   hidden   the pages fill the window from the top and cover the toolbar
//   shown    the pages move down by the toolbar height and the toolbar is visible
//
// Unlike the sidebar, nothing floats over the pages: moving the pages is what shows
// the toolbar, so every toolbar button, menu and dialog keeps working unchanged. The
// price is that a page is resized each time the toolbar shows or hides.
//
// "The top" is the window title bar and the top edge of the page area. The mouse is
// read from the screen itself (not from page events), because a page
// covers the top edge while the toolbar is hidden and gets the mouse.
// The toolbar stays while the URL bar or the find bar is in use (setBusy), and while
// a dialog or menu is open. It hides again after the mouse has been away a moment.

const POLL_MS = 100;
const EDGE_PX = 4; // "top edge": this close to the top of the window content
const EDGE_SLACK_PX = 8; // a window border (or a mouse past the edge) still counts as the edge
const LEAVE_MARGIN_PX = 24; // how far below the toolbar the mouse must be to count as away
const HIDE_DELAY_MS = 350;

class ToolbarAutoHide {
  // getCursor() -> { x, y } in screen pixels. isBlocked() is true while something else
  // is on top (the Ctrl+Tab switcher).
  constructor({ store, mainWindow, viewManager, getCursor, isBlocked }) {
    this.store = store;
    this.mainWindow = mainWindow;
    this.viewManager = viewManager;
    this.getCursor = getCursor;
    this.isBlocked = isBlocked || (() => false);
    this.active = false; // the setting is on
    this.busy = false; // the URL bar or find bar is in use
    this.timer = null;
    this.awaySince = 0;
    this.now = () => Date.now(); // replaceable in tests
  }

  enabled() {
    return this.store.getState().settings.autoHideToolbar === true;
  }

  // Call after the setting may have changed (and once at start).
  sync() {
    const on = this.enabled();
    if (on === this.active) return;
    this.active = on;
    this.awaySince = 0;
    if (on) {
      this.viewManager.setToolbarHidden(!this.busy);
      if (!this.timer) this.timer = setInterval(() => this.tick(), POLL_MS);
    } else {
      this.stop();
      this.viewManager.setToolbarHidden(false);
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // The shell says the URL bar or find bar is in use (true) or done (false).
  setBusy(busy) {
    this.busy = !!busy;
    this.awaySince = 0;
    if (this.active && this.busy) this.viewManager.setToolbarHidden(false);
  }

  tick() {
    const win = this.mainWindow;
    if (!this.active || !win || win.isDestroyed()) return;
    // Not in front, a dialog or menu is open, the app is locked, or the switcher is up:
    // leave the toolbar as it is.
    if (!win.isVisible() || win.isMinimized() || !win.isFocused()
      || this.viewManager.modalOpen || this.viewManager.locked || this.isBlocked()) {
      return;
    }
    const cursor = this.getCursor();
    const box = win.getContentBounds();
    // The window's title bar is above the content area (box.y is below it), so a mouse
    // over the title bar has a negative y here. It counts as the top edge.
    const frame = win.getBounds();
    const x = cursor.x - frame.x;
    const y = cursor.y - box.y;
    const titleTop = frame.y - box.y; // negative: the top of the title bar
    const insideWidth = x >= 0 && x < frame.width;

    if (this.viewManager.toolbarHidden) {
      if (insideWidth && y >= Math.min(titleTop, -EDGE_SLACK_PX) && y <= EDGE_PX) this.viewManager.setToolbarHidden(false);
      return;
    }

    const over = this.busy || (insideWidth && y >= Math.min(titleTop, -EDGE_SLACK_PX) && y <= TOOLBAR_HEIGHT + LEAVE_MARGIN_PX);
    if (over) { this.awaySince = 0; return; }
    if (!this.awaySince) { this.awaySince = this.now(); return; }
    if (this.now() - this.awaySince >= HIDE_DELAY_MS) {
      this.awaySince = 0;
      this.viewManager.setToolbarHidden(true);
    }
  }
}

module.exports = { ToolbarAutoHide, EDGE_PX, HIDE_DELAY_MS, LEAVE_MARGIN_PX };
