'use strict';

const path = require('path');
const { Notification } = require('electron');
const { notifClickChannel } = require('./constants');
const favicon = require('./favicon');

const ICON_FALLBACK = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const SUPPRESS_AFTER_LOAD_MS = 10000;

class NotificationsController {
  constructor({ store, viewManager, getMainWindow }) {
    this.store = store;
    this.viewManager = viewManager;
    this.getMainWindow = getMainWindow;
    this.everSentReal = new Set(); // linkIds that have ever forwarded a real page notification
    this.loadedAt = new Map(); // linkId -> timestamp of last load/wake
    this.viewManager.on('loaded', (id) => this.loadedAt.set(id, Date.now()));
  }

  _link(id) {
    return this.store.getState().links.find((l) => l.id === id) || null;
  }

  _dndActive() {
    const { dnd } = this.store.getState().settings;
    if (!dnd || !dnd.enabled) return false;
    if (dnd.until && Date.now() > dnd.until) {
      this.store.updateSettings({ dnd: { enabled: false, until: null } });
      return false;
    }
    return true;
  }

  _shouldSuppress(link) {
    if (!Notification.isSupported()) return true;
    if (this._dndActive()) return true;
    if (link.muted) return true;
    if (!link.notifications.enabled) return true;
    const { notifyOnlyWhenUnfocused } = this.store.getState().settings;
    const mainWindow = this.getMainWindow();
    if (notifyOnlyWhenUnfocused && mainWindow && !mainWindow.isDestroyed() &&
        mainWindow.isFocused() && this.viewManager.getActiveId() === link.id) {
      return true;
    }
    return false;
  }

  _focusLink(linkId) {
    const mainWindow = this.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
    this.viewManager.activate(linkId);
  }

  // Path A: a real notification forwarded from the page (window.Notification
  // shim or ServiceWorkerRegistration#showNotification patch).
  handlePageNotification(linkId, payload) {
    const link = this._link(linkId);
    if (!link) return;
    this.everSentReal.add(linkId);
    if (this._shouldSuppress(link)) return;

    const iconPath = favicon.getCachedFaviconPath(linkId) || ICON_FALLBACK;
    const notif = new Notification({
      title: `${link.name}: ${payload.title || ''}`,
      body: (payload.options && payload.options.body) || '',
      icon: iconPath,
      silent: !link.notifications.sound,
    });
    notif.on('click', () => {
      this._focusLink(linkId);
      const view = this.viewManager.getView(linkId);
      if (view && !view.webContents.isDestroyed() && payload.notificationId) {
        view.webContents.send(notifClickChannel(linkId), payload.notificationId);
      }
    });
    notif.show();
  }

  // Path B: synthesized from an unread signal changing, generalized from
  // MyOutlook's behavior. Suppressed once this link has ever sent a real
  // page notification, and for a short window after load/wake.
  maybeSynthesize(linkId, { prevCount, newCount, prevActivity, newActivity }) {
    const link = this._link(linkId);
    if (!link) return;
    if (link.notifications.synthesize !== 'auto') return;
    if (this.everSentReal.has(linkId)) return;
    const loadedAt = this.loadedAt.get(linkId) || 0;
    if (Date.now() - loadedAt < SUPPRESS_AFTER_LOAD_MS) return;
    if (this._shouldSuppress(link)) return;

    let title = null;
    let body = null;
    if (typeof newCount === 'number') {
      if (prevCount === null || prevCount === undefined) {
        if (newCount > 0) {
          title = 'Unread activity';
          body = newCount === 1 ? 'You have 1 unread item.' : `You have ${newCount} unread items.`;
        }
      } else if (newCount > prevCount) {
        const diff = newCount - prevCount;
        title = 'New activity';
        body = diff === 1 ? 'You have 1 new item.' : `You have ${diff} new items.`;
      }
    } else if (newActivity && !prevActivity) {
      // Signal is a yes/no flag only (e.g. favicon-based detection) — no
      // count to report, but activity switching on is itself the event.
      title = 'New activity';
      body = 'You have new activity.';
    }
    if (!title) return;

    const iconPath = favicon.getCachedFaviconPath(linkId) || ICON_FALLBACK;
    const notif = new Notification({
      title: `${link.name}: ${title}`,
      body,
      icon: iconPath,
      silent: !link.notifications.sound,
    });
    notif.on('click', () => this._focusLink(linkId));
    notif.show();
  }
}

module.exports = { NotificationsController };
