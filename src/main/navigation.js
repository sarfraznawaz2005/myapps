'use strict';

const { BrowserWindow, clipboard, shell } = require('electron');

function normalizeUrl(input) {
  let url = (input || '').trim();
  if (!url) return url;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) url = `https://${url}`;
  return url;
}

// Loads a URL off-screen briefly to read its title/favicon for the
// Add-Link dialog's auto-probe. Times out safely; never shown to the user.
function probeUrl(url) {
  return new Promise((resolve) => {
    const target = normalizeUrl(url);
    let settled = false;
    let win;
    try {
      win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: { offscreen: false, contextIsolation: true, sandbox: true },
      });
    } catch (_e) {
      resolve({ ok: false, title: null, faviconUrl: null });
      return;
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
      if (!win.isDestroyed()) win.destroy();
    };

    const timer = setTimeout(() => finish({ ok: false, title: null, faviconUrl: null }), 8000);

    win.webContents.on('page-favicon-updated', (_e, favicons) => {
      finish({ ok: true, title: win.webContents.getTitle() || null, faviconUrl: (favicons && favicons[0]) || null });
    });
    win.webContents.on('did-finish-load', () => {
      // If no favicon event fires shortly after load, still resolve with the title.
      setTimeout(() => finish({ ok: true, title: win.isDestroyed() ? null : win.webContents.getTitle(), faviconUrl: null }), 1500);
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      if (code === -3) return;
      finish({ ok: false, title: null, faviconUrl: null, error: desc });
    });

    win.loadURL(target).catch(() => finish({ ok: false, title: null, faviconUrl: null }));
  });
}

function copyUrlToClipboard(url) {
  clipboard.writeText(url || '');
}

function openExternal(url) {
  if (url) shell.openExternal(url);
}

module.exports = { normalizeUrl, probeUrl, copyUrlToClipboard, openExternal };
