'use strict';

const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');

// Screenshot, print and save-as-PDF of the active link's page.

// Chromium cannot draw a texture bigger than 16384 pixels in either direction.
const MAX_TEXTURE = 16000;

function pad(n) { return String(n).padStart(2, '0'); }

function defaultName(webContents, ext) {
  let host = 'page';
  try { host = new URL(webContents.getURL()).hostname.replace(/^www\./, '') || 'page'; } catch (_e) { /* no URL */ }
  host = host.replace(/[^A-Za-z0-9._-]/g, '_');
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${host}-${stamp}.${ext}`;
}

// Asks where to save, then writes. Returns the saved path, or null if cancelled.
async function saveBuffer(mainWindow, webContents, buffer, ext, title) {
  const result = await dialog.showSaveDialog(mainWindow, {
    title,
    defaultPath: path.join(app.getPath('downloads'), defaultName(webContents, ext)),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (result.canceled || !result.filePath) return null;
  await fs.promises.writeFile(result.filePath, buffer);
  return result.filePath;
}

// mode: 'visible' (what the window shows now) | 'full' (the whole page, top to bottom)
async function captureScreenshot(webContents, mode) {
  if (mode === 'visible') {
    const image = await webContents.capturePage();
    if (image.isEmpty()) throw new Error('The page is empty.');
    return image.toPNG();
  }
  // Whole page: ask Chromium to draw past the window edge. Uses the page's own
  // debugger channel; if something else (the mobile view) already attached it,
  // reuse that and leave it attached.
  const dbg = webContents.debugger;
  const wasAttached = dbg.isAttached();
  if (!wasAttached) dbg.attach('1.3');
  try {
    const metrics = await dbg.sendCommand('Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    const width = Math.ceil(size.width);
    const height = Math.ceil(size.height);
    // The picture is drawn in real screen pixels (page size x display scale, 2.5
    // on a 250% screen). Past MAX_TEXTURE the drawing wraps and repeats the
    // bottom of the page, so shrink the whole page to fit instead of cutting it.
    let dpr = 1;
    try { dpr = Number(await webContents.executeJavaScript('window.devicePixelRatio')) || 1; } catch (_e) { /* use 1 */ }
    const scale = Math.min(1, MAX_TEXTURE / (height * dpr), MAX_TEXTURE / (width * dpr));
    const shot = await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale },
    });
    return Buffer.from(shot.data, 'base64');
  } finally {
    if (!wasAttached) { try { dbg.detach(); } catch (_e) { /* already gone */ } }
  }
}

function printPage(webContents) {
  return new Promise((resolve, reject) => {
    webContents.print({ silent: false, printBackground: true }, (success, reason) => {
      // The user closing the print dialog is not an error.
      if (success || reason === 'cancelled' || reason === 'Print job canceled') resolve(success);
      else reject(new Error(reason || 'Printing failed.'));
    });
  });
}

async function pagePdf(webContents) {
  return webContents.printToPDF({ printBackground: true });
}

module.exports = { captureScreenshot, saveBuffer, printPage, pagePdf };
