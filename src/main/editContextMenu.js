'use strict';

const { app, BrowserWindow, Menu, clipboard, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CH } = require('./constants');

function toastToShell(mainWindow, type, message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(CH.SHELL_TOAST, { type, message });
}

// Downloads a picture through Electron's own network layer (not a page-JS
// fetch(), so a site's CORS rules never enter into it) and puts the result
// on the clipboard. Used as a fallback for sites (Instagram) that hide the
// real <img> behind an invisible layer, so Chromium's own "right-clicked an
// image" detection misses it.
function copyImageFromUrl(webContents, url) {
  const tmpPath = path.join(os.tmpdir(), `myapps-copyimg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const ses = webContents.session;
  return new Promise((resolve, reject) => {
    const onWillDownload = (_e, item) => {
      ses.removeListener('will-download', onWillDownload);
      item.setSavePath(tmpPath);
      item.once('done', (_e2, state) => {
        state === 'completed' ? resolve() : reject(new Error('download ' + state));
      });
    };
    ses.on('will-download', onWillDownload);
    // Some image CDNs (Instagram's included) refuse the request without a
    // Referer matching the page it's normally loaded from.
    webContents.downloadURL(url, { headers: { Referer: webContents.getURL() } });
  }).then(async () => {
    const bytes = await fs.promises.readFile(tmpPath);
    fs.unlink(tmpPath, () => {});

    let img = nativeImage.createFromBuffer(bytes);
    if (img.isEmpty()) {
      // nativeImage can't decode some formats directly (WebP is common on
      // Instagram) — have the page's own browser engine decode it via a
      // canvas instead, then hand nativeImage a PNG, which it always reads.
      // A data: URL source never taints the canvas, so this works
      // regardless of the original image's cross-origin CORS rules.
      const mime = bytes[0] === 0x89 ? 'image/png' : (bytes[8] === 0x57 ? 'image/webp' : 'image/jpeg');
      const b64 = bytes.toString('base64');
      const pngDataUrl = await webContents.executeJavaScript(`(function () {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0);
            resolve(canvas.toDataURL('image/png'));
          };
          img.onerror = () => reject(new Error('renderer could not decode image'));
          img.src = "data:${mime};base64,${b64}";
        });
      })()`);
      const pngBytes = Buffer.from(pngDataUrl.split(',')[1], 'base64');
      img = nativeImage.createFromBuffer(pngBytes);
    }
    if (img.isEmpty()) throw new Error('could not decode downloaded image');
    clipboard.writeImage(img);
  });
}

// Picks a filename in the Downloads folder that doesn't already exist,
// so a repeat download doesn't silently overwrite an earlier one.
function uniqueDownloadPath(filename) {
  const dir = app.getPath('downloads');
  let candidate = path.join(dir, filename);
  if (!fs.existsSync(candidate)) return candidate;
  const { name, ext } = path.parse(filename);
  let i = 2;
  do {
    candidate = path.join(dir, `${name} (${i})${ext}`);
    i++;
  } while (fs.existsSync(candidate));
  return candidate;
}

// Saves a picture straight to the Downloads folder via Electron's own
// network layer, same as copyImageFromUrl above (so it works on sites that
// hide the real <img>, and isn't subject to page-level CORS rules).
function downloadImageToDisk(webContents, url) {
  const ses = webContents.session;
  return new Promise((resolve, reject) => {
    const onWillDownload = (_e, item) => {
      ses.removeListener('will-download', onWillDownload);
      item.setSavePath(uniqueDownloadPath(item.getFilename() || 'image'));
      item.once('done', (_e2, state) => {
        state === 'completed' ? resolve() : reject(new Error('download ' + state));
      });
    };
    ses.on('will-download', onWillDownload);
    webContents.downloadURL(url, { headers: { Referer: webContents.getURL() } });
  });
}

// Wires window.open()/target=_blank handling on a webContents so every
// window it spawns — and every window THAT spawns, and so on — inherits
// `ses` and gets the same right-click menu. Recursing on 'did-create-window'
// matters: without it, only the FIRST popup gets the shared session: a
// popup opened from *within* a popup (e.g. a story viewer opening the next
// story in its own window) falls back to Electron's default handler, which
// creates a brand-new window with a fresh, empty session — so a logged-in
// site suddenly shows logged out two windows deep.
// `shouldAllow(url)` can veto a popup (return false to deny it); omitted,
// every popup is allowed.
function wirePopupSessions(webContents, ses, mainWindow, shouldAllow = () => true) {
  webContents.setWindowOpenHandler(({ url }) => {
    if (!shouldAllow(url)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false },
      },
    };
  });
  webContents.on('did-create-window', (childWindow) => {
    attachEditContextMenu(childWindow.webContents, { withPageControls: true, mainWindow });
    wirePopupSessions(childWindow.webContents, ses, mainWindow, shouldAllow);
  });
}

// Opens a link in a brand-new window on the same session (cookies/login)
// as the page the link was right-clicked on — so a logged-in site stays
// logged in in the new window, same as a real browser's "Open in new
// window". httpReferrer mirrors what a real click would send.
function openLinkInNewWindow(webContents, url, mainWindow) {
  const ses = webContents.session;
  const child = new BrowserWindow({
    width: 1100,
    height: 800,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachEditContextMenu(child.webContents, { withPageControls: true, mainWindow });
  wirePopupSessions(child.webContents, ses, mainWindow);
  child.loadURL(url, { httpReferrer: webContents.getURL() });
}

// Electron ships no default right-click menu (Copy/Paste/Select All) —
// unlike a real browser, that only exists if the app builds one itself via
// the 'context-menu' event. Attach this to every webContents that should
// behave like a normal text field/page: the shell's own inputs, and every
// loaded link.
//
// withPageControls adds Back/Forward/Reload/Copy page URL as a fallback so
// right-clicking blank space on a loaded link's page (no text field, no
// selection, no link under the cursor) still shows a menu, like a real
// browser — instead of showing nothing at all.
function attachEditContextMenu(webContents, { withPageControls = false, mainWindow = null } = {}) {
  webContents.on('context-menu', async (_event, params) => {
    const template = [];

    // If Chromium didn't recognize an image directly under the cursor,
    // check every layer actually stacked at that point — some sites put an
    // invisible click-catcher on top of the real picture.
    let fallbackImageUrl = null;
    if (params.mediaType !== 'image') {
      try {
        fallbackImageUrl = await webContents.executeJavaScript(`(function () {
          const stack = document.elementsFromPoint(${params.x}, ${params.y});
          for (const el of stack) {
            if (el.tagName === 'IMG' && (el.currentSrc || el.src)) return el.currentSrc || el.src;
          }
          return null;
        })()`);
      } catch (_e) { /* ignore */ }
    }

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        template.push({ label: suggestion, click: () => webContents.replaceMisspelling(suggestion) });
      }
      if (params.dictionarySuggestions.length) template.push({ type: 'separator' });
      template.push({
        label: 'Add to dictionary',
        click: () => webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      template.push({ type: 'separator' });
    }

    if (params.isEditable) {
      template.push(
        { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { label: 'Select All', role: 'selectAll', enabled: params.editFlags.canSelectAll }
      );
    } else if (params.selectionText) {
      template.push({ label: 'Copy', role: 'copy' });
    }

    const imageUrl = params.mediaType === 'image' ? params.srcURL : fallbackImageUrl;
    if (params.mediaType === 'image' || fallbackImageUrl) {
      if (template.length) template.push({ type: 'separator' });
      template.push({
        label: 'Copy Image',
        click: () => (params.mediaType === 'image'
          ? Promise.resolve(webContents.copyImageAt(params.x, params.y))
          : copyImageFromUrl(webContents, imageUrl)
        ).then(
          () => toastToShell(mainWindow, 'success', 'Image copied to clipboard'),
          (err) => toastToShell(mainWindow, 'error', 'Copy Image failed: ' + String((err && err.message) || err))
        ),
      });
      template.push({
        label: 'Download Image',
        click: () => downloadImageToDisk(webContents, imageUrl).then(
          () => toastToShell(mainWindow, 'success', 'Image downloaded'),
          (err) => toastToShell(mainWindow, 'error', 'Download Image failed: ' + String((err && err.message) || err))
        ),
      });
    }

    if (params.linkURL) {
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
      template.push({
        label: 'Open in new window',
        click: () => openLinkInNewWindow(webContents, params.linkURL, mainWindow),
      });
    }

    if (!template.length && withPageControls) {
      template.push(
        { label: 'Back', enabled: webContents.canGoBack(), click: () => webContents.goBack() },
        { label: 'Forward', enabled: webContents.canGoForward(), click: () => webContents.goForward() },
        { label: 'Reload', click: () => webContents.reload() },
        { type: 'separator' },
        { label: 'Copy page URL', click: () => clipboard.writeText(webContents.getURL()) }
      );
    }

    if (!template.length) return;
    Menu.buildFromTemplate(template).popup();
  });
}

module.exports = { attachEditContextMenu, wirePopupSessions };
