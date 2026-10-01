'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ipcMain, app, safeStorage } = require('electron');
const { CH } = require('./constants');

// Opt-in password manager. Saved logins live in their own file (never in
// store.json, so "Export JSON" can't leak them). Passwords are encrypted with
// Electron's safeStorage (Windows DPAPI: tied to this Windows user account).
// The page never sees a stored password until the user clicks an account in
// the dropdown, and main always derives the site from the sender frame's own
// URL — it never trusts a host string sent by the renderer.

const PENDING_TTL_MS = 2 * 60 * 1000;
const USERNAME_TTL_MS = 5 * 60 * 1000;
const MAX_FIELD = 2048;

// https only (plus plain-http localhost for dev servers). Leading "www." is
// dropped so example.com and www.example.com share logins.
function hostKey(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (u.protocol === 'https:' || (u.protocol === 'http:' && (h === 'localhost' || h === '127.0.0.1'))) {
      return h.replace(/^www\./, '');
    }
  } catch (_e) { /* not a URL */ }
  return null;
}

const MIN_EXPORT_KEY = 6;

// Export file lock: scrypt turns the user's Export Key into a 256-bit key,
// AES-256-GCM encrypts + authenticates. A wrong key fails the auth tag check.
function lock(obj, key) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(key, salt, 32), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return {
    v: 1,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function unlock(blob, key) {
  try {
    if (!blob || blob.v !== 1 || blob.kdf !== 'scrypt') return null;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      crypto.scryptSync(key, Buffer.from(blob.salt, 'base64'), 32),
      Buffer.from(blob.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
    const parsed = JSON.parse(plain.toString('utf8'));
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      never: Array.isArray(parsed.never) ? parsed.never : [],
    };
  } catch (_e) { return null; }
}

class Vault {
  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'passwords.json');
    this.data = { entries: [], never: [], exportKey: null };
    this._load();
  }

  isAvailable() {
    try { return safeStorage.isEncryptionAvailable(); } catch (_e) { return false; }
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.data.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      this.data.never = Array.isArray(parsed.never) ? parsed.never : [];
      this.data.exportKey = typeof parsed.exportKey === 'string' ? parsed.exportKey : null;
    } catch (_e) { /* no file yet, or unreadable: start empty */ }
  }

  // Writes run one after another. Two overlapping writes shared one temp
  // file, so the second rename failed with ENOENT and a save could be lost.
  _write() {
    this._writeChain = (this._writeChain || Promise.resolve()).then(async () => {
      try {
        const tmp = `${this.filePath}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(this.data));
        await fs.promises.rename(tmp, this.filePath);
      } catch (err) {
        console.error('Failed to write passwords.json:', err);
      }
    });
    return this._writeChain;
  }

  _decrypt(entry) {
    try { return safeStorage.decryptString(Buffer.from(entry.pw, 'base64')); } catch (_e) { return null; }
  }

  list(host) {
    return this.data.entries
      .filter((e) => e.host === host)
      .map((e) => ({ id: e.id, username: e.username }));
  }

  listAll() {
    return this.data.entries
      .map((e) => ({ id: e.id, host: e.host, username: e.username }))
      .sort((a, b) => a.host.localeCompare(b.host) || a.username.localeCompare(b.username));
  }

  get(id, host) {
    const e = this.data.entries.find((x) => x.id === id && x.host === host);
    if (!e) return null;
    const password = this._decrypt(e);
    return password === null ? null : { username: e.username, password };
  }

  find(host, username) {
    return this.data.entries.find((e) => e.host === host && e.username === username) || null;
  }

  // Same site + same username updates the row; a new username adds one.
  _upsert(host, username, password) {
    const pw = safeStorage.encryptString(password).toString('base64');
    const existing = this.find(host, username);
    if (existing) {
      existing.pw = pw;
      existing.updatedAt = Date.now();
    } else {
      this.data.entries.push({ id: crypto.randomUUID(), host, username, pw, updatedAt: Date.now() });
    }
  }

  save(host, username, password) {
    if (!this.isAvailable()) return false;
    this._upsert(host, username, password);
    this._write();
    return true;
  }

  // ---- Export Key (stored on this PC, locked with the Windows account) ----

  hasExportKey() { return !!this.data.exportKey; }

  setExportKey(key) {
    if (!this.isAvailable()) return false;
    this.data.exportKey = safeStorage.encryptString(key).toString('base64');
    this._write();
    return true;
  }

  clearExportKey() {
    this.data.exportKey = null;
    this._write();
  }

  getExportKey() {
    if (!this.data.exportKey) return null;
    try { return safeStorage.decryptString(Buffer.from(this.data.exportKey, 'base64')); } catch (_e) { return null; }
  }

  // Locked copy of every login for the Export JSON file, or null when there
  // is no key or nothing to export.
  exportLocked() {
    const key = this.getExportKey();
    if (!key || (!this.data.entries.length && !this.data.never.length)) return null;
    const entries = [];
    for (const e of this.data.entries) {
      const password = this._decrypt(e);
      if (password !== null) entries.push({ host: e.host, username: e.username, password });
    }
    return lock({ entries, never: this.data.never }, key);
  }

  // Adds logins from an unlocked export. Existing logins stay; same site +
  // username is updated.
  mergeImported({ entries, never }) {
    for (const e of entries) {
      if (typeof e.host === 'string' && typeof e.username === 'string' && typeof e.password === 'string') {
        this._upsert(e.host, e.username, e.password);
      }
    }
    for (const h of never) {
      if (typeof h === 'string' && !this.isNever(h)) this.data.never.push(h);
    }
    this._write();
  }

  remove(id) {
    this.data.entries = this.data.entries.filter((e) => e.id !== id);
    this._write();
  }

  clearAll() {
    this.data.entries = [];
    this._write();
  }

  isNever(host) { return this.data.never.includes(host); }

  addNever(host) {
    if (!this.isNever(host)) this.data.never.push(host);
    this._write();
  }

  removeNever(host) {
    this.data.never = this.data.never.filter((h) => h !== host);
    this._write();
  }
}

function init(ctx) {
  const vault = new Vault();
  // webContents id -> { host, username, password, ts, shown } (login just
  // submitted, waiting to see if it worked). Held in main memory only, so the
  // password never re-enters page memory for the "Save?" prompt.
  const pending = new Map();
  // webContents id -> { username, ts } (step one of a two-step login).
  const lastUsername = new Map();
  // Pages that closed (or hibernated) must not leave a captured password in
  // memory until its timeout: drop their entries the moment they go away.
  const watched = new Set();
  const forgetOnClose = (sender) => {
    if (!sender || typeof sender.once !== 'function' || watched.has(sender.id)) return;
    const id = sender.id;
    watched.add(id);
    sender.once('destroyed', () => {
      watched.delete(id);
      pending.delete(id);
      lastUsername.delete(id);
    });
  };

  const enabled = () => !!ctx.store.getState().settings.passwordManager;
  const fromShell = (e) => !!ctx.mainWindow && !ctx.mainWindow.isDestroyed() && e.sender === ctx.mainWindow.webContents;
  const senderHost = (e) => (e.senderFrame ? hostKey(e.senderFrame.url) : null);
  const isStr = (v) => typeof v === 'string' && v.length <= MAX_FIELD;
  const fresh = (p, ttl) => p && Date.now() - p.ts < ttl;

  // ---- page (link preload) -> main ----
  ipcMain.handle(CH.PM_LIST, (event) => {
    if (!enabled() || fromShell(event)) return [];
    const host = senderHost(event);
    return host ? vault.list(host) : [];
  });

  ipcMain.handle(CH.PM_FILL, (event, id) => {
    if (!enabled() || fromShell(event) || !isStr(id)) return null;
    const host = senderHost(event);
    return host ? vault.get(id, host) : null;
  });

  ipcMain.handle(CH.PM_CAPTURE, (event, payload) => {
    if (!enabled() || fromShell(event) || !vault.isAvailable() || !payload) return false;
    const host = senderHost(event);
    if (!host || vault.isNever(host)) return false;
    const { username, password } = payload;
    if (!isStr(username) || !isStr(password)) return false;
    const wcId = event.sender.id;
    forgetOnClose(event.sender);

    if (!password) {
      // Username-only step of a two-step login: remember it for the next step.
      if (username) lastUsername.set(wcId, { username, ts: Date.now() });
      return true;
    }
    let user = username;
    if (!user) {
      const prev = lastUsername.get(wcId);
      if (fresh(prev, USERNAME_TTL_MS)) user = prev.username;
    }
    if (!user) return false;
    pending.set(wcId, { host, username: user, password, ts: Date.now(), shown: false });
    return true;
  });

  // Asks "is there a login waiting to be saved?" Returns only the username
  // and site — never the password.
  ipcMain.handle(CH.PM_PENDING_TAKE, (event) => {
    if (!enabled() || fromShell(event)) return null;
    const wcId = event.sender.id;
    const p = pending.get(wcId);
    if (!fresh(p, PENDING_TTL_MS) || p.shown) { if (!fresh(p, PENDING_TTL_MS)) pending.delete(wcId); return null; }
    const existing = vault.find(p.host, p.username);
    if (existing && vault._decrypt(existing) === p.password) {
      pending.delete(wcId);
      return null;
    }
    p.shown = true;
    return { host: p.host, username: p.username, update: !!existing };
  });

  ipcMain.handle(CH.PM_PENDING_COMMIT, (event) => {
    if (!enabled() || fromShell(event)) return false;
    const wcId = event.sender.id;
    const p = pending.get(wcId);
    pending.delete(wcId);
    if (!fresh(p, PENDING_TTL_MS) || !p.shown) return false;
    return vault.save(p.host, p.username, p.password);
  });

  ipcMain.handle(CH.PM_PENDING_DISCARD, (event, never) => {
    if (fromShell(event)) return false;
    const wcId = event.sender.id;
    const p = pending.get(wcId);
    pending.delete(wcId);
    if (never === true && p && p.shown) vault.addNever(p.host);
    return true;
  });

  // ---- shell (settings dialog) -> main ----
  ipcMain.handle(CH.PM_MANAGE_LIST, (event) => {
    if (!fromShell(event)) return null;
    return {
      available: vault.isAvailable(),
      entries: vault.listAll(),
      never: vault.data.never.slice(),
      hasExportKey: vault.hasExportKey(),
    };
  });

  ipcMain.handle(CH.PM_KEY_SET, (event, key) => {
    if (!fromShell(event) || typeof key !== 'string') return { ok: false, error: 'bad-request' };
    if (key.length < MIN_EXPORT_KEY) return { ok: false, error: `Key must be at least ${MIN_EXPORT_KEY} characters.` };
    if (key.length > MAX_FIELD) return { ok: false, error: 'Key is too long.' };
    if (!vault.setExportKey(key)) return { ok: false, error: 'Windows encryption is not available.' };
    return { ok: true };
  });

  ipcMain.handle(CH.PM_KEY_CLEAR, (event) => {
    if (!fromShell(event)) return false;
    vault.clearExportKey();
    return true;
  });

  ipcMain.handle(CH.PM_DELETE, (event, id) => {
    if (!fromShell(event) || !isStr(id)) return false;
    vault.remove(id);
    return true;
  });

  ipcMain.handle(CH.PM_CLEAR_ALL, (event) => {
    if (!fromShell(event)) return false;
    vault.clearAll();
    return true;
  });

  ipcMain.handle(CH.PM_UNNEVER, (event, host) => {
    if (!fromShell(event) || !isStr(host)) return false;
    vault.removeNever(host);
    return true;
  });

  // Used by the settings export/import handlers in ipc.js.
  return {
    exportLocked: () => vault.exportLocked(),
    // Returns { ok: true } (also when the file holds no logins), or
    // { error: 'need-key' | 'bad-key' | 'unavailable' } without changing anything.
    unlockImport(blob, typedKey) {
      if (!blob) return { ok: true, payload: null };
      if (!vault.isAvailable()) return { error: 'unavailable' };
      const key = typeof typedKey === 'string' && typedKey ? typedKey : vault.getExportKey();
      if (!key) return { error: 'need-key' };
      const payload = unlock(blob, key);
      return payload ? { ok: true, payload } : { error: 'bad-key' };
    },
    mergeImported: (payload) => { if (payload) vault.mergeImported(payload); },
  };
}

// Export JSON text + locked logins (when an Export Key is set).
function buildExport(exportJson, vaultApi) {
  const locked = vaultApi.exportLocked();
  if (!locked) return exportJson;
  return JSON.stringify({ ...JSON.parse(exportJson), passwordVault: locked }, null, 2);
}

// Splits an import file into { json, payload }, or { error } when saved logins
// can't be unlocked. Nothing is changed here, so a wrong key fails before the
// caller replaces anything. passwordVault is always stripped from json so it
// never lands in store.json.
function prepareImport(text, typedKey, vaultApi) {
  const parsed = JSON.parse(text);
  const blob = parsed.passwordVault;
  delete parsed.passwordVault;
  const unlocked = vaultApi.unlockImport(blob, typedKey);
  if (unlocked.error) return { error: unlocked.error };
  return { json: JSON.stringify(parsed), payload: unlocked.payload };
}

module.exports = { init, hostKey, buildExport, prepareImport, Vault, lock, unlock, MIN_EXPORT_KEY };
