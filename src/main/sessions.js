'use strict';

const { session, app } = require('electron');
const permissionPrompt = require('./permissionPrompt');

const preparedPartitions = new Set();

// Google (and others) block user agents containing "Electron/". Strip that
// token (and our own app token) from the UA Chromium would otherwise send,
// per session, before the first navigation.
function cleanedUserAgent(ses) {
  const raw = ses.getUserAgent();
  return raw
    .split(' ')
    .filter((tok) => !tok.startsWith('Electron/') && !tok.startsWith('MyApps/'))
    .join(' ')
    .trim();
}

function getLinkSession(link, store) {
  const ses = session.fromPartition(link.partition);
  // The handlers below run for as long as the app is open, across many
  // reloads/hibernate cycles — closing over the `link` argument from this
  // one call would freeze whatever allowMedia/allowLocation were at
  // registration time. Look the link up fresh on every permission check
  // instead, so edits made later (in the Edit dialog, or via the live
  // Allow/Block prompt below) actually take effect without a restart.
  const liveLink = () => store.getState().links.find((l) => l.id === link.id) || link;

  if (!preparedPartitions.has(link.partition)) {
    preparedPartitions.add(link.partition);
    try {
      ses.setUserAgent(link.userAgent && link.userAgent.trim() ? link.userAgent.trim() : cleanedUserAgent(ses));
    } catch (_e) { /* ignore */ }

    ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      if (permission === 'notifications') return callback(true);
      if (permission === 'media') {
        const l = liveLink();
        if (l.navigation.mediaDecided) {
          const allow = !!l.navigation.allowMedia;
          // Already decided (either via the prompt below, or preset by hand
          // in the Edit dialog) — still toast every time a site actually
          // uses it, not just the one-time decision, so it's never silent.
          permissionPrompt.toast(allow ? 'success' : 'warning', `Camera & mic ${allow ? 'allowed' : 'blocked'} for ${l.name}.`);
          return callback(allow);
        }
        // First time this link has asked — show a real Allow/Block prompt
        // (like Chrome does) instead of silently denying, and remember the
        // answer so we never ask again for this link.
        permissionPrompt.ask(l, 'media').then(({ allow, decided }) => {
          if (decided) {
            store.updateLink(l.id, { navigation: { allowMedia: allow, mediaDecided: true } });
            permissionPrompt.toast(
              allow ? 'success' : 'warning',
              `Camera & mic ${allow ? 'allowed' : 'blocked'} for ${l.name}.`
            );
          }
          callback(allow);
        });
        return;
      }
      if (permission === 'geolocation') {
        const l = liveLink();
        const allow = !!l.navigation.allowLocation;
        // Chromium's own geolocation path (e.g. a frame our JS-level shim
        // doesn't reach) never touches ipc.js/geolocation.js, so it needs
        // its own toast — otherwise a grant here is completely silent.
        permissionPrompt.toast(allow ? 'success' : 'warning', `Location ${allow ? 'allowed' : 'blocked'} for ${l.name}.`);
        return callback(allow);
      }
      if (permission === 'midi' || permission === 'midiSysex') return callback(false);
      if (permission === 'pointerLock' || permission === 'fullscreen') return callback(true);
      return callback(false);
    });

    ses.setPermissionCheckHandler((_webContents, permission) => {
      if (permission === 'notifications') return true;
      if (permission === 'media') return !!liveLink().navigation.allowMedia;
      if (permission === 'geolocation') return !!liveLink().navigation.allowLocation;
      return false;
    });
  } else if (link.userAgent && link.userAgent.trim()) {
    try { ses.setUserAgent(link.userAgent.trim()); } catch (_e) { /* ignore */ }
  }
  return ses;
}

module.exports = { getLinkSession, cleanedUserAgent };
