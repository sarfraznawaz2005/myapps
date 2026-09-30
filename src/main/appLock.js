'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { app } = require('electron');

// App-wide lock. The password is never stored: only a salted scrypt hash, in
// its own file (lock.json) so Export JSON can neither leak nor replace it.
//
// This keeps people away from the open app. It is NOT disk protection — the
// app data folder is still readable by whoever has this Windows account.

const MIN_PASSWORD = 4;
const MAX_PASSWORD = 256;
const MAX_FAILURES = 5;
const WAIT_MS = 30 * 1000;
const IDLE_POLL_MS = 15 * 1000;
const MAX_IDLE_MINUTES = 24 * 60;

class AppLock extends EventEmitter {
  // idleSeconds: () => seconds since last keyboard/mouse activity (injected so
  // tests don't need Electron's powerMonitor).
  constructor({ getIdleMinutes, idleSeconds, now } = {}) {
    super();
    this.filePath = path.join(app.getPath('userData'), 'lock.json');
    this.getIdleMinutes = getIdleMinutes || (() => 0);
    this.idleSeconds = idleSeconds || (() => 0);
    this.now = now || Date.now;
    this.data = { salt: null, hash: null, failures: 0, waitUntil: 0 };
    this._writeChain = Promise.resolve();
    this._timer = null;
    this._load();
    // A saved password means the app starts locked.
    this.locked = this.hasPassword();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (typeof parsed.salt === 'string' && typeof parsed.hash === 'string') {
        this.data.salt = parsed.salt;
        this.data.hash = parsed.hash;
        this.data.failures = Number.isInteger(parsed.failures) ? parsed.failures : 0;
        this.data.waitUntil = Number.isFinite(parsed.waitUntil) ? parsed.waitUntil : 0;
      }
    } catch (_e) { /* no lock file yet, or unreadable: no lock */ }
  }

  _write() {
    this._writeChain = this._writeChain.then(async () => {
      try {
        if (!this.data.hash) {
          await fs.promises.rm(this.filePath, { force: true });
          return;
        }
        const tmp = `${this.filePath}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(this.data));
        await fs.promises.rename(tmp, this.filePath);
      } catch (err) {
        console.error('Failed to write lock.json:', err);
      }
    });
    return this._writeChain;
  }

  _derive(password, salt) {
    return crypto.scryptSync(password, Buffer.from(salt, 'base64'), 32).toString('base64');
  }

  hasPassword() { return !!this.data.hash; }
  isLocked() { return this.locked; }

  // Seconds the user must wait before another try (0 = may try now).
  waitSeconds() {
    return Math.max(0, Math.ceil((this.data.waitUntil - this.now()) / 1000));
  }

  status() {
    return { hasPassword: this.hasPassword(), locked: this.locked, waitSeconds: this.waitSeconds() };
  }

  // Checks a password. Five wrong tries in a row start a 30 second wait; the
  // counter is saved to disk so restarting the app does not reset it.
  verify(password) {
    if (!this.hasPassword()) return { ok: true };
    const wait = this.waitSeconds();
    if (wait > 0) return { ok: false, error: 'wait', waitSeconds: wait };
    if (typeof password !== 'string' || password.length > MAX_PASSWORD) return this._fail();
    const given = Buffer.from(this._derive(password, this.data.salt));
    const stored = Buffer.from(this.data.hash);
    if (given.length === stored.length && crypto.timingSafeEqual(given, stored)) {
      if (this.data.failures || this.data.waitUntil) {
        this.data.failures = 0;
        this.data.waitUntil = 0;
        this._write();
      }
      return { ok: true };
    }
    return this._fail();
  }

  _fail() {
    this.data.failures += 1;
    if (this.data.failures >= MAX_FAILURES) {
      this.data.failures = 0;
      this.data.waitUntil = this.now() + WAIT_MS;
    }
    this._write();
    return { ok: false, error: 'wrong', waitSeconds: this.waitSeconds() };
  }

  lock() {
    if (!this.hasPassword()) return false;
    if (!this.locked) {
      this.locked = true;
      this.emit('locked');
    }
    return true;
  }

  unlock(password) {
    if (!this.locked) return { ok: true };
    const res = this.verify(password);
    if (!res.ok) return res;
    this.locked = false;
    this.emit('unlocked');
    return { ok: true };
  }

  // First password needs no current one. Changing needs the current one.
  setPassword(newPassword, currentPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD) {
      return { ok: false, error: 'short', min: MIN_PASSWORD };
    }
    if (newPassword.length > MAX_PASSWORD) return { ok: false, error: 'long' };
    if (this.hasPassword()) {
      const res = this.verify(currentPassword);
      if (!res.ok) return res;
    }
    const salt = crypto.randomBytes(16).toString('base64');
    this.data = { salt, hash: this._derive(newPassword, salt), failures: 0, waitUntil: 0 };
    this._write();
    return { ok: true };
  }

  removePassword(currentPassword) {
    if (!this.hasPassword()) return { ok: true };
    const res = this.verify(currentPassword);
    if (!res.ok) return res;
    this.data = { salt: null, hash: null, failures: 0, waitUntil: 0 };
    this.locked = false;
    this._write();
    return { ok: true };
  }

  // Locks after the configured minutes without keyboard/mouse activity
  // anywhere on this PC (0 = off).
  checkIdle() {
    if (this.locked || !this.hasPassword()) return false;
    const minutes = Math.min(MAX_IDLE_MINUTES, Math.max(0, Math.floor(Number(this.getIdleMinutes()) || 0)));
    if (!minutes) return false;
    if (this.idleSeconds() >= minutes * 60) return this.lock();
    return false;
  }

  startIdleWatch() {
    if (this._timer) return;
    this._timer = setInterval(() => this.checkIdle(), IDLE_POLL_MS);
    if (this._timer.unref) this._timer.unref();
  }

  stopIdleWatch() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { AppLock, MIN_PASSWORD, MAX_FAILURES, WAIT_MS };
