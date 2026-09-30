'use strict';

// Lets main-process modules be loaded under plain `node --test` (no Electron).
// Call install() BEFORE requiring any src/main module. Every piece can be
// tweaked per test through the returned `stub` object.

const Module = require('module');
const os = require('os');
const fs = require('fs');
const path = require('path');

const stub = {
  userData: null,
  encryptionAvailable: true,
  handlers: new Map(), // channel -> ipcMain.handle callback
  windows: [], // what BrowserWindow.getAllWindows() returns
};

// Reversible fake "encryption" — enough to prove code never stores or
// exports the plain value, without needing real Windows DPAPI.
const safeStorage = {
  isEncryptionAvailable: () => stub.encryptionAvailable,
  encryptString: (s) => {
    if (!stub.encryptionAvailable) throw new Error('encryption unavailable');
    return Buffer.from(`enc:${Buffer.from(s, 'utf8').reverse().toString('hex')}`);
  },
  decryptString: (buf) => {
    const t = buf.toString();
    if (!t.startsWith('enc:')) throw new Error('bad blob');
    return Buffer.from(t.slice(4), 'hex').reverse().toString('utf8');
  },
};

const electron = {
  app: { getPath: () => stub.userData },
  safeStorage,
  ipcMain: {
    handle: (ch, fn) => stub.handlers.set(ch, fn),
    on: () => {},
  },
  BrowserWindow: class { static getAllWindows() { return stub.windows; } },
  WebContentsView: class {},
  powerMonitor: { getSystemIdleTime: () => 0 },
  clipboard: {},
  shell: {},
  session: {},
};

let installed = false;
function install() {
  if (installed) return stub;
  installed = true;
  const origLoad = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electron;
    return origLoad.call(this, request, ...rest);
  };
  return stub;
}

// Fresh empty userData folder for one test.
function freshUserData() {
  stub.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'myapps-test-'));
  stub.handlers.clear();
  stub.encryptionAvailable = true;
  return stub.userData;
}

module.exports = { install, freshUserData, stub };
