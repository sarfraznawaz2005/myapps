'use strict';

const { Menu, clipboard, nativeImage, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
function attachEditContextMenu(webContents, { withPageControls = false } = {}) {
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

    if (params.mediaType === 'image') {
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: 'Copy Image', click: () => webContents.copyImageAt(params.x, params.y) });
    } else if (fallbackImageUrl) {
      if (template.length) template.push({ type: 'separator' });
      template.push({
        label: 'Copy Image',
        click: () => copyImageFromUrl(webContents, fallbackImageUrl).catch((err) => {
          dialog.showErrorBox('Copy Image failed', String((err && err.message) || err));
        }),
      });
    }

    if (params.linkURL) {
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
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

module.exports = { attachEditContextMenu };
