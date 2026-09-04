'use strict';

const { CH } = require('./constants');

// Bridges Electron's setPermissionRequestHandler (which only accepts a
// yes/no callback, no UI of its own) to a real Allow/Block dialog in the
// shell. init() is called once from ipc.js with the same ctx object main.js
// builds, so this always sees the current mainWindow even if it's replaced.
let ctxRef = null;
let seq = 0;
const pending = new Map(); // id -> { resolve, timer }

const TIMEOUT_MS = 30000;

function init(ctx) {
  ctxRef = ctx;
}

// Resolves { allow, decided }. decided is false when nobody actually
// answered (window hidden/closed, or the user ignored it for 30s) — callers
// should treat that as "not asked yet" rather than a real Block, so the
// prompt comes back next time instead of silently blocking forever.
function ask(link, kind) {
  return new Promise((resolve) => {
    const w = ctxRef && ctxRef.mainWindow;
    if (!w || w.isDestroyed()) {
      resolve({ allow: false, decided: false });
      return;
    }
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ allow: false, decided: false });
    }, TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    w.webContents.send(CH.SHELL_PERMISSION_PROMPT, { id, kind, linkId: link.id, linkName: link.name });
  });
}

function respond(id, allow) {
  const entry = pending.get(id);
  if (!entry) return; // already timed out, or a stale/duplicate response
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve({ allow: !!allow, decided: true });
}

function toast(type, message) {
  const w = ctxRef && ctxRef.mainWindow;
  if (!w || w.isDestroyed()) return;
  w.webContents.send(CH.SHELL_TOAST, { type, message });
}

module.exports = { init, ask, respond, toast };
