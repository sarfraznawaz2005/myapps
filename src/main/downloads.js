'use strict';

const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { CH } = require('./constants');

// A list of the files links downloaded in this run (kept in memory only).
// It watches downloads; it never changes where a file is saved, so the usual
// "Save as" dialog still shows.

const MAX_ENTRIES = 50;
const PUSH_EVERY_MS = 400;
// Files the app saves to the temp folder for its own use (copy picture).
const INTERNAL_PREFIX = 'myapps-copyimg-';

let getMainWindow = () => null;
let getLinkName = () => '';
let nextId = 1;
const entries = []; // newest first
const items = new Map(); // entry id -> live DownloadItem
let pushTimer = null;

function init(opts) {
  getMainWindow = opts.getMainWindow;
  getLinkName = opts.getLinkName;
}

function snapshot() {
  return entries.map((e) => ({ ...e }));
}

function push(now) {
  if (now) {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  } else {
    if (pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; push(true); }, PUSH_EVERY_MS);
    return;
  }
  const w = getMainWindow();
  if (w && !w.isDestroyed()) w.webContents.send(CH.SHELL_DOWNLOADS, snapshot());
}

function remove(entry) {
  const i = entries.indexOf(entry);
  if (i !== -1) entries.splice(i, 1);
  items.delete(entry.id);
}

function track(item, linkId) {
  const entry = {
    id: nextId++,
    linkId,
    linkName: getLinkName(linkId),
    filename: item.getFilename(),
    state: 'progressing', // progressing | completed | cancelled | interrupted
    received: 0,
    total: item.getTotalBytes(),
    path: '',
    startedAt: Date.now(),
  };
  entries.unshift(entry);
  items.set(entry.id, item);
  while (entries.length > MAX_ENTRIES) {
    const old = entries.pop();
    if (old.state === 'progressing') { entries.push(old); break; }
    items.delete(old.id);
  }

  item.on('updated', (_e, state) => {
    entry.received = item.getReceivedBytes();
    entry.total = item.getTotalBytes();
    entry.path = item.getSavePath() || entry.path;
    entry.filename = item.getFilename() || entry.filename;
    if (state === 'interrupted') entry.state = 'interrupted';
    push(false);
  });
  item.once('done', (_e, state) => {
    entry.path = item.getSavePath() || entry.path;
    entry.received = item.getReceivedBytes();
    entry.total = item.getTotalBytes();
    items.delete(entry.id);
    if (path.basename(entry.path).startsWith(INTERNAL_PREFIX)) { remove(entry); push(true); return; }
    entry.filename = path.basename(entry.path) || entry.filename;
    entry.state = state === 'completed' ? 'completed' : (state === 'cancelled' ? 'cancelled' : 'interrupted');
    push(true);
  });
  push(true);
}

// Called once per link session. Our listener does not set a save path.
function attach(ses, linkId) {
  ses.on('will-download', (_event, item) => {
    // The other will-download listeners run right after this one, in the same
    // turn. Wait one turn so an app-internal download (temp file) is skipped.
    setImmediate(() => {
      const p = item.getSavePath();
      if (p && path.basename(p).startsWith(INTERNAL_PREFIX)) return;
      track(item, linkId);
    });
  });
}

function list() {
  return snapshot();
}

// Only ids we gave out; the file path always comes from our own list.
function act(id, action) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return false;
  if (action === 'cancel') {
    const item = items.get(id);
    if (item) item.cancel();
    return true;
  }
  if (action === 'remove') {
    if (entry.state === 'progressing') return false;
    remove(entry);
    push(true);
    return true;
  }
  if (!entry.path || entry.state !== 'completed' || !fs.existsSync(entry.path)) return false;
  if (action === 'open') { shell.openPath(entry.path); return true; }
  if (action === 'show') { shell.showItemInFolder(entry.path); return true; }
  return false;
}

function clearFinished() {
  for (const entry of entries.slice()) {
    if (entry.state !== 'progressing') remove(entry);
  }
  push(true);
  return true;
}

module.exports = { init, attach, list, act, clearFinished };
