'use strict';

const path = require('path');
const { app, nativeImage } = require('electron');

const ASSETS = path.join(__dirname, '..', '..', 'assets');

function overlayImagePath(aggregate) {
  if (aggregate === '•') return path.join(ASSETS, 'overlay', 'dot.png');
  if (typeof aggregate === 'number' && aggregate > 0) {
    const n = aggregate > 9 ? '9plus' : String(aggregate);
    return path.join(ASSETS, 'overlay', `${n}.png`);
  }
  return null;
}

class Indicator {
  constructor({ store, tray, getMainWindow }) {
    this.store = store;
    this.tray = tray; // TrayController, optional (set later)
    this.getMainWindow = getMainWindow;
    this.lastAggregate = 0;
  }

  setTray(tray) {
    this.tray = tray;
  }

  // aggregate: number | '•' | 0
  computeAggregate(unreadTracker) {
    const { links, settings } = this.store.getState();
    if (settings.dnd && settings.dnd.enabled) {
      // DND still tracks pills in the sidebar (per-link), but the global
      // aggregate/tray/overlay is suppressed while DND is on.
      return 0;
    }
    let sum = 0;
    let hasActivity = false;
    for (const link of links) {
      if (!link.enabled || link.muted) continue;
      const state = unreadTracker.get(link.id);
      if (state.stale) continue;
      if (typeof state.count === 'number' && state.count > 0) {
        sum += state.count;
      } else if (state.activity) {
        hasActivity = true;
      }
    }
    if (sum > 0) return sum;
    if (hasActivity) return '•';
    return 0;
  }

  apply(aggregate) {
    const mainWindow = this.getMainWindow();
    const { settings } = this.store.getState();
    const increased = typeof aggregate === 'number' && typeof this.lastAggregate === 'number'
      ? aggregate > this.lastAggregate
      : (aggregate !== 0 && this.lastAggregate === 0);

    if (this.tray) this.tray.setUnread(aggregate !== 0);

    if (mainWindow && !mainWindow.isDestroyed() && process.platform === 'win32') {
      if (settings.showOverlayIcon) {
        const imgPath = overlayImagePath(aggregate);
        if (imgPath) {
          const img = nativeImage.createFromPath(imgPath);
          mainWindow.setOverlayIcon(img, typeof aggregate === 'number' ? `${aggregate} unread` : 'New activity');
        } else {
          mainWindow.setOverlayIcon(null, '');
        }
      } else {
        mainWindow.setOverlayIcon(null, '');
      }
    }

    if (process.platform !== 'win32') {
      try {
        app.badgeCount = typeof aggregate === 'number' ? aggregate : (aggregate === '•' ? 1 : 0);
      } catch (_e) { /* ignore */ }
    }

    if (mainWindow && !mainWindow.isDestroyed() && increased && !mainWindow.isFocused() && settings.flashTaskbar) {
      mainWindow.flashFrame(true);
      mainWindow.once('focus', () => {
        if (!mainWindow.isDestroyed()) mainWindow.flashFrame(false);
      });
    }

    this.lastAggregate = aggregate;
    return aggregate;
  }
}

module.exports = { Indicator, overlayImagePath };
