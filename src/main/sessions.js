'use strict';

const { session, app } = require('electron');

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

function getLinkSession(link) {
  const ses = session.fromPartition(link.partition);
  if (!preparedPartitions.has(link.partition)) {
    preparedPartitions.add(link.partition);
    try {
      ses.setUserAgent(link.userAgent && link.userAgent.trim() ? link.userAgent.trim() : cleanedUserAgent(ses));
    } catch (_e) { /* ignore */ }

    ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      if (permission === 'notifications') return callback(true);
      if (permission === 'media') return callback(!!(link.navigation && link.navigation.allowMedia));
      if (permission === 'geolocation') return callback(!!(link.navigation && link.navigation.allowLocation));
      if (permission === 'midi' || permission === 'midiSysex') return callback(false);
      if (permission === 'pointerLock' || permission === 'fullscreen') return callback(true);
      return callback(false);
    });

    ses.setPermissionCheckHandler((_webContents, permission) => {
      if (permission === 'notifications') return true;
      if (permission === 'media') return !!(link.navigation && link.navigation.allowMedia);
      if (permission === 'geolocation') return !!(link.navigation && link.navigation.allowLocation);
      return false;
    });
  } else if (link.userAgent && link.userAgent.trim()) {
    try { ses.setUserAgent(link.userAgent.trim()); } catch (_e) { /* ignore */ }
  }
  return ses;
}

module.exports = { getLinkSession, cleanedUserAgent };
