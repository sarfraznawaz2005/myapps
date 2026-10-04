'use strict';

// Optional "hide the sidebar until the mouse goes far left" (setting autoHideSidebar).
// Separate from collapse/expand: that makes the sidebar narrow, this takes it away
// completely so the page can use the whole window width.
//
//   hidden   the pages fill the whole window width; nothing of the sidebar shows
//   shown    a copy of the sidebar floats over the left edge of the pages
//            (sidebarOverlay.js); the pages keep their size and are not redrawn
//
// The mouse is read from the screen itself (not from page events), because a page
// covers the left edge of the window while the sidebar is hidden and gets the mouse.
// Moving the mouse to the far left edge of the window shows the sidebar. Moving it
// away from the sidebar hides it again after a short wait, so a slip of the mouse
// does not make it flicker.

const POLL_MS = 100;
const EDGE_PX = 4; // "far left": this close to the left edge of the window
const EDGE_SLACK_PX = 8; // a window border (or a mouse past the edge) still counts as the edge
const LEAVE_MARGIN_PX = 24; // how far right of the sidebar the mouse must be to count as away
const HIDE_DELAY_MS = 350;

class SidebarAutoHide {
  // getCursor() -> { x, y } in screen pixels. overlay draws the floating sidebar:
  // create() / show(width) / hide() / destroy(). onActiveChange(on) tells the main
  // window the setting is on or off. isBlocked() is true while something else is on
  // top (the Ctrl+Tab switcher).
  constructor({ store, mainWindow, viewManager, overlay, getCursor, onActiveChange, onHidden, isBlocked }) {
    this.store = store;
    this.mainWindow = mainWindow;
    this.viewManager = viewManager;
    this.overlay = overlay;
    this.getCursor = getCursor;
    this.onActiveChange = onActiveChange || (() => {});
    this.onHidden = onHidden || (() => {}); // the floating sidebar went away: give the page the keyboard
    this.isBlocked = isBlocked || (() => false);
    this.active = false; // the setting is on
    this.shown = false; // the floating sidebar is on screen
    this.timer = null;
    this.awaySince = 0;
    this.now = () => Date.now(); // replaceable in tests
  }

  enabled() {
    return this.store.getState().settings.autoHideSidebar === true;
  }

  // Call after the setting may have changed (and once at start).
  sync() {
    const on = this.enabled();
    if (on === this.active) return;
    this.active = on;
    if (on) {
      this.overlay.create();
      this.viewManager.setSidebarHidden(true); // pages use the whole width
      if (!this.timer) this.timer = setInterval(() => this.tick(), POLL_MS);
    } else {
      this.stop();
      this.hide();
      this.overlay.destroy();
      this.viewManager.setSidebarHidden(false);
    }
    this.onActiveChange(on);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  show() {
    this.awaySince = 0;
    this.shown = true;
    this.overlay.show(this.viewManager.sidebarWidth());
  }

  hide() {
    this.awaySince = 0;
    if (!this.shown) return;
    this.shown = false;
    if (this.overlay.hide()) this.onHidden();
  }

  // Used when a click in the floating sidebar needs a dialog of the main window.
  hideNow() {
    this.hide();
  }

  tick() {
    const win = this.mainWindow;
    if (!this.active || !win || win.isDestroyed()) return;
    // Not in front, a dialog is open, the app is locked, or the switcher is up: show nothing.
    if (!win.isVisible() || win.isMinimized() || !win.isFocused()
      || this.viewManager.modalOpen || this.viewManager.locked || this.isBlocked()) {
      this.hide();
      return;
    }
    const cursor = this.getCursor();
    const box = win.getContentBounds();
    const x = cursor.x - box.x;
    const y = cursor.y - box.y;
    const insideHeight = y >= 0 && y < box.height;

    if (!this.shown) {
      if (insideHeight && x >= -EDGE_SLACK_PX && x <= EDGE_PX) this.show();
      return;
    }

    const width = this.viewManager.sidebarWidth();
    const over = insideHeight && x >= -EDGE_SLACK_PX && x <= width + LEAVE_MARGIN_PX;
    if (over) {
      this.awaySince = 0;
      this.overlay.show(width); // follows a collapse / expand and a window resize; stays on top
      return;
    }
    if (!this.awaySince) { this.awaySince = this.now(); return; }
    if (this.now() - this.awaySince >= HIDE_DELAY_MS) this.hide();
  }
}

module.exports = { SidebarAutoHide, EDGE_PX, HIDE_DELAY_MS, LEAVE_MARGIN_PX };
