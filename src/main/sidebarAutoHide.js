'use strict';

// Optional "hide the sidebar until the mouse goes far left" (setting autoHideSidebar).
// Separate from collapse/expand: that makes the sidebar narrow, this takes it away
// completely so the page can use the whole window width.
//
//   hidden   the pages fill the whole window width; nothing of the sidebar shows
//   shown    the sidebar is back at its normal width (the pages make room for it)
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
  // getCursor() -> { x, y } in screen pixels. onChange(hidden) tells the window to redraw.
  constructor({ store, mainWindow, viewManager, getCursor, onChange }) {
    this.store = store;
    this.mainWindow = mainWindow;
    this.viewManager = viewManager;
    this.getCursor = getCursor;
    this.onChange = onChange || (() => {});
    this.hidden = false;
    this.timer = null;
    this.awaySince = 0;
    this.now = () => Date.now(); // replaceable in tests
  }

  enabled() {
    return this.store.getState().settings.autoHideSidebar === true;
  }

  // Call after the setting may have changed (and once at start).
  sync() {
    if (this.enabled()) {
      this.setHidden(true);
      if (!this.timer) this.timer = setInterval(() => this.tick(), POLL_MS);
    } else {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      this.setHidden(false);
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  setHidden(hidden) {
    this.awaySince = 0;
    if (this.hidden === hidden && this.viewManager.sidebarHidden === hidden) return;
    this.hidden = hidden;
    this.viewManager.setSidebarHidden(hidden);
    this.onChange(hidden);
  }

  // The width the sidebar has while it is shown.
  shownWidth() {
    return this.viewManager.sidebarWidth();
  }

  tick() {
    const win = this.mainWindow;
    if (!this.enabled() || !win || win.isDestroyed()) return;
    // Not in front: show nothing new. A shown sidebar goes away when the window loses focus.
    if (!win.isVisible() || win.isMinimized() || !win.isFocused()) {
      if (!this.hidden) this.setHidden(true);
      return;
    }
    const cursor = this.getCursor();
    const box = win.getContentBounds();
    const x = cursor.x - box.x;
    const y = cursor.y - box.y;
    const insideHeight = y >= 0 && y < box.height;

    if (this.hidden) {
      if (insideHeight && x >= -EDGE_SLACK_PX && x <= EDGE_PX) this.setHidden(false);
      return;
    }

    // Shown. Stay while a dialog is open or the mouse is over the sidebar.
    const over = insideHeight && x >= -EDGE_SLACK_PX && x <= this.shownWidth() + LEAVE_MARGIN_PX;
    if (over || this.viewManager.modalOpen) { this.awaySince = 0; return; }
    if (!this.awaySince) { this.awaySince = this.now(); return; }
    if (this.now() - this.awaySince >= HIDE_DELAY_MS) this.setHidden(true);
  }
}

module.exports = { SidebarAutoHide, EDGE_PX, HIDE_DELAY_MS, LEAVE_MARGIN_PX };
