'use strict';

const path = require('path');
const { Notification } = require('electron');
const { notifClickChannel } = require('./constants');
const favicon = require('./favicon');

const ICON_FALLBACK = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const SUPPRESS_AFTER_LOAD_MS = 10000;
const SYNTH_DELAY_MS = 3000;
const MAX_LIVE_TOASTS = 100;

class NotificationsController {
  constructor({ store, viewManager, getMainWindow }) {
    this.store = store;
    this.viewManager = viewManager;
    this.getMainWindow = getMainWindow;
    this.everSentReal = new Set(); // linkIds that have ever forwarded a real page notification
    this.loadedAt = new Map(); // linkId -> timestamp of last load/wake
    // Toasts we have shown. Electron holds its Notification objects weakly: once
    // our reference is gone the object can be garbage collected, and a later
    // click (on the toast, or on it in the Action Center) fires no handler at all.
    // So keep them. Only the newest MAX_LIVE_TOASTS are kept.
    this.liveToasts = new Set();
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

  _retain(notif) {
    this.liveToasts.add(notif);
    while (this.liveToasts.size > MAX_LIVE_TOASTS) {
      this.liveToasts.delete(this.liveToasts.values().next().value);
    }
    return notif;
  }

  _focusLink(linkId) {
    const mainWindow = this.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      // A minimized window still reports isVisible(), so show() alone left it
      // minimized and the click looked like it did nothing.
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
    this.viewManager.activate(linkId);
    // mainWindow.focus() above already triggers the self-heal (see
    // ViewManager.kickActiveView), but at that point activate() hasn't run
    // yet, so it kicks whatever link was active *before* this click — not
    // the one we just switched to. Kick again now that the right view is
    // actually active, or a notification click leaves that view unclickable
    // until a manual minimize/restore.
    this.viewManager.kickActiveView();
  }

  // Path A: a real notification forwarded from the page (window.Notification
  // shim or ServiceWorkerRegistration#showNotification patch).
  // `frame` is the page frame that raised it (WebFrameMain). The click has to go
  // back to that same frame: the notification object lives in its JS world, and
  // many sites raise theirs from an iframe, not the top page.
  handlePageNotification(linkId, payload, frame) {
    const link = this._link(linkId);
    if (!link) return;
    this.everSentReal.add(linkId);
    if (this._shouldSuppress(link)) return;

    // Locked, or the user turned contents off: a toast must not show message text.
    const { showNotificationContents } = this.store.getState().settings;
    const locked = !!this.viewManager.locked || showNotificationContents === false;
    const iconPath = favicon.getCachedFaviconPath(linkId) || ICON_FALLBACK;
    const notif = new Notification({
      title: locked ? `${link.name}: New notification` : `${link.name}: ${payload.title || ''}`,
      body: locked ? '' : (payload.options && payload.options.body) || '',
      icon: iconPath,
      silent: !link.notifications.sound,
    });
    notif.on('click', () => {
      this._focusLink(linkId);
      this._deliverClick(linkId, payload.notificationId, frame);
    });
    // A Windows toast can steal input hit-testing from the active view without
    // ever sending our window a real blur/focus cycle, leaving clicks dead
    // until minimize/restore. Closing the toast (dismissed or timed out) is
    // the reliable signal to self-heal — see viewManager.kickActiveView.
    notif.on('close', () => this.viewManager.kickActiveView());
    this._retain(notif).show();
  }

  // Tell the page its notification was clicked, so the site's own onclick runs
  // (that is what opens the right chat/thread). Frame first, top page as fallback.
  _deliverClick(linkId, notificationId, frame) {
    if (!notificationId) return;
    const channel = notifClickChannel(linkId);
    try {
      if (frame && !frame.detached) { frame.send(channel, notificationId); return; }
    } catch (_e) { /* frame is gone: fall back to the top page */ }
    const view = this.viewManager.getView(linkId);
    if (view && !view.webContents.isDestroyed()) view.webContents.send(channel, notificationId);
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

    // The unread signal (title/favicon/badge) often lands a moment BEFORE the
    // page's real notification (WhatsApp does this). Wait briefly and drop the
    // guess if the real one shows up, or the user gets two toasts.
    setTimeout(() => {
      if (this.everSentReal.has(linkId)) return;
      const current = this._link(linkId);
      if (!current || this._shouldSuppress(current)) return;
      this._showSynthesized(current, title, body);
    }, SYNTH_DELAY_MS);
  }

  _showSynthesized(link, title, body) {
    const linkId = link.id;
    const iconPath = favicon.getCachedFaviconPath(linkId) || ICON_FALLBACK;
    const notif = new Notification({
      title: `${link.name}: ${title}`,
      body,
      icon: iconPath,
      silent: !link.notifications.sound,
    });
    notif.on('click', () => this._focusLink(linkId));
    notif.on('close', () => this.viewManager.kickActiveView());
    this._retain(notif).show();
  }
}

module.exports = { NotificationsController };
