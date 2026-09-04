'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { STORE_VERSION } = require('./constants');

function genId() {
  return crypto.randomUUID();
}

function defaultSettings() {
  return {
    closeToTray: true,
    minimizeToTray: true,
    startWithOS: false,
    startMinimized: false,
    showTrayIcon: true,
    flashTaskbar: true,
    showOverlayIcon: true,
    overlayStyle: 'digit', // digit | dot
    notifyOnlyWhenUnfocused: true,
    dnd: { enabled: false, until: null },
    theme: 'dark', // dark | light
    accent: '#3b82f6',
    scrollArrows: false,
    defaultHibernate: 'idle', // never | idle | manual
    hibernateOnTrayMinutes: 0, // 0 = disabled
    openExternalLinksInBrowser: true,
    spellcheck: true,
    confirmDelete: true,
    trayHintShown: false,
    autoLaunchInitialized: false,
  };
}

function defaultUi() {
  return {
    window: { x: null, y: null, width: 1280, height: 860, maximized: false },
    sidebarWidth: 240,
    sidebarCollapsed: false,
    sidebarFooterOpen: false,
    lastActiveLinkId: null,
    showToolbar: true,
  };
}

function defaultState() {
  return {
    version: STORE_VERSION,
    settings: defaultSettings(),
    ui: defaultUi(),
    groups: [],
    links: [],
    userscripts: [],
    commands: [],
  };
}

function defaultLinkFields() {
  return {
    icon: { mode: 'auto', path: null, url: null, fallbackLetter: null, fallbackColor: '#3b82f6' },
    userAgent: null,
    zoom: 1,
    muted: false,
    enabled: true,
    openOnStartup: false,
    notifications: { enabled: true, synthesize: 'auto', sound: true },
    unread: {
      enabled: true,
      title: { mode: 'auto', regex: null },
      badge: { enabled: true },
      favicon: { mode: 'auto', baselineHash: null },
      expert: {
        enabled: false,
        selector: '',
        source: 'text', // text | attr | count | value
        attr: '',
        regex: '',
        mode: 'number', // number | presence
        aggregate: 'first', // first | sum | max
        intervalMs: 15000,
      },
    },
    hibernate: { policy: 'idle', minutes: 30, keepAwake: true },
    // mediaDecided/locationDecided: false means "never asked yet" — the live
    // Allow/Block prompt shows the first time this link requests that
    // permission, then flips the flag true so it never asks again (same as
    // the Edit dialog's checkboxes, which also set it true when flipped by hand).
    navigation: {
      openExternal: false,
      allowedPopupHosts: [],
      allowMedia: false,
      mediaDecided: false,
      allowLocation: false,
      locationDecided: false,
    },
  };
}

// MIGRATIONS maps "state was version N" -> function that mutates state to version N+1.
// None needed yet; kept so future schema changes have a real place to land.
const MIGRATIONS = {
  // 1: (state) => { ... state.version = 2; return state; },
};

function runMigrations(state) {
  let v = state.version || 1;
  while (MIGRATIONS[v]) {
    state = MIGRATIONS[v](state);
    v = state.version;
  }
  state.version = STORE_VERSION;
  return state;
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    if (patch[key] && typeof patch[key] === 'object' && !Array.isArray(patch[key]) && base && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], patch[key]);
    } else {
      out[key] = patch[key];
    }
  }
  return out;
}

class Store {
  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'store.json');
    this.state = defaultState();
    this._saveTimer = null;
    this._listeners = new Set();
    this.pendingToast = null;
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.state = defaultState();
      return this.state;
    }
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      this.state = defaultState();
      return this.state;
    }
    try {
      let parsed = JSON.parse(raw);
      parsed = runMigrations(parsed);
      // Defensive shape normalization in case of hand-edited/partial files.
      parsed.settings = deepMerge(defaultSettings(), parsed.settings || {});
      parsed.ui = deepMerge(defaultUi(), parsed.ui || {});
      parsed.groups = Array.isArray(parsed.groups) ? parsed.groups : [];
      parsed.links = Array.isArray(parsed.links) ? parsed.links.map((l) => deepMerge(defaultLinkFields(), l)) : [];
      parsed.userscripts = Array.isArray(parsed.userscripts) ? parsed.userscripts : [];
      parsed.commands = Array.isArray(parsed.commands) ? parsed.commands : [];
      this.state = parsed;
    } catch (err) {
      // Corrupt file: preserve it for forensics, fall back to defaults.
      try {
        const corruptPath = path.join(app.getPath('userData'), `store.corrupt-${Date.now()}.json`);
        fs.renameSync(this.filePath, corruptPath);
      } catch (_e) {
        // ignore — best effort
      }
      this.state = defaultState();
      this.pendingToast = { type: 'error', message: 'Your data file was corrupted and has been reset. A backup was saved next to it.' };
    }
    return this.state;
  }

  takePendingToast() {
    const t = this.pendingToast;
    this.pendingToast = null;
    return t;
  }

  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _notify() {
    for (const l of this._listeners) {
      try { l(this.state); } catch (_e) { /* ignore listener errors */ }
    }
  }

  save() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._writeNow(), 300);
    this._notify();
  }

  saveImmediate() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this._writeNow();
    this._notify();
  }

  _writeNow() {
    this._saveTimer = null;
    try {
      // Backup before overwrite so a crash mid-write can't destroy both copies.
      if (fs.existsSync(this.filePath)) {
        try { fs.copyFileSync(this.filePath, `${this.filePath}.bak`); } catch (_e) { /* ignore */ }
      }
      const tmpPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error('Failed to write store.json:', err);
    }
  }

  getState() {
    return this.state;
  }

  // ---- links ----

  createLink(data) {
    const id = genId();
    const merged = deepMerge(defaultLinkFields(), data || {});
    const groupId = merged.groupId || null;
    const order = this.state.links.filter((l) => l.groupId === groupId).length;
    const link = {
      ...merged,
      id,
      name: (merged.name || '').trim() || 'New link',
      url: merged.url || 'https://',
      groupId,
      order,
      partition: `persist:link-${id}`,
      createdAt: Date.now(),
      lastActiveAt: null,
    };
    this.state.links.push(link);
    this.save();
    return link;
  }

  updateLink(id, patch) {
    const idx = this.state.links.findIndex((l) => l.id === id);
    if (idx === -1) return null;
    const existing = this.state.links[idx];
    const merged = deepMerge(existing, patch);
    merged.id = id;
    merged.partition = existing.partition; // never regenerated
    merged.name = (merged.name || '').trim() || existing.name || 'New link';
    this.state.links[idx] = merged;
    this.save();
    return merged;
  }

  deleteLink(id) {
    const idx = this.state.links.findIndex((l) => l.id === id);
    if (idx === -1) return null;
    const [removed] = this.state.links.splice(idx, 1);
    if (this.state.ui.lastActiveLinkId === id) this.state.ui.lastActiveLinkId = null;
    this.save();
    return removed;
  }

  reorderLinks(orderedIds, groupId) {
    orderedIds.forEach((id, i) => {
      const link = this.state.links.find((l) => l.id === id);
      if (link) {
        link.order = i;
        if (groupId !== undefined) link.groupId = groupId;
      }
    });
    this.save();
    return this.state.links;
  }

  // ---- groups ----

  createGroup(data) {
    const id = genId();
    const order = this.state.groups.length;
    const group = {
      id,
      name: data.name || 'New group',
      order,
      collapsed: false,
      color: data.color || null,
    };
    this.state.groups.push(group);
    this.save();
    return group;
  }

  updateGroup(id, patch) {
    const idx = this.state.groups.findIndex((g) => g.id === id);
    if (idx === -1) return null;
    this.state.groups[idx] = { ...this.state.groups[idx], ...patch, id };
    this.save();
    return this.state.groups[idx];
  }

  deleteGroup(id, { deleteLinks = false } = {}) {
    const idx = this.state.groups.findIndex((g) => g.id === id);
    if (idx === -1) return null;
    const [removed] = this.state.groups.splice(idx, 1);
    if (deleteLinks) {
      this.state.links = this.state.links.filter((l) => l.groupId !== id);
    } else {
      this.state.links.forEach((l) => { if (l.groupId === id) l.groupId = null; });
    }
    this.save();
    return removed;
  }

  reorderGroups(orderedIds) {
    orderedIds.forEach((id, i) => {
      const g = this.state.groups.find((x) => x.id === id);
      if (g) g.order = i;
    });
    this.save();
    return this.state.groups;
  }

  // ---- settings / ui ----

  updateSettings(patch) {
    this.state.settings = deepMerge(this.state.settings, patch);
    this.save();
    return this.state.settings;
  }

  updateUi(patch) {
    this.state.ui = deepMerge(this.state.ui, patch);
    this.save();
    return this.state.ui;
  }

  exportJSON() {
    return JSON.stringify(this.state, null, 2);
  }

  importJSON(json) {
    const parsed = runMigrations(JSON.parse(json));
    parsed.settings = deepMerge(defaultSettings(), parsed.settings || {});
    parsed.ui = deepMerge(defaultUi(), parsed.ui || {});
    parsed.groups = Array.isArray(parsed.groups) ? parsed.groups : [];
    parsed.links = Array.isArray(parsed.links) ? parsed.links.map((l) => deepMerge(defaultLinkFields(), l)) : [];
    parsed.userscripts = Array.isArray(parsed.userscripts) ? parsed.userscripts : [];
    parsed.commands = Array.isArray(parsed.commands) ? parsed.commands : [];
    this.state = parsed;
    this.saveImmediate();
    return this.state;
  }

  // ---- userscripts ----

  createUserscript(data) {
    const id = genId();
    const script = {
      id,
      name: ((data && data.name) || '').trim() || 'Untitled',
      matches: Array.isArray(data && data.matches) ? data.matches : [],
      code: (data && data.code) || '',
      enabled: data && data.enabled !== undefined ? !!data.enabled : true,
      createdAt: Date.now(),
    };
    this.state.userscripts.push(script);
    this.save();
    return script;
  }

  updateUserscript(id, patch) {
    const idx = this.state.userscripts.findIndex((u) => u.id === id);
    if (idx === -1) return null;
    const existing = this.state.userscripts[idx];
    const merged = { ...existing, ...patch, id };
    if (patch && patch.name !== undefined) merged.name = (patch.name || '').trim() || existing.name;
    this.state.userscripts[idx] = merged;
    this.save();
    return merged;
  }

  deleteUserscript(id) {
    const idx = this.state.userscripts.findIndex((u) => u.id === id);
    if (idx === -1) return null;
    const [removed] = this.state.userscripts.splice(idx, 1);
    this.save();
    return removed;
  }

  // ---- commands ----

  createCommand(data) {
    const id = genId();
    const cmd = {
      id,
      name: ((data && data.name) || '').trim() || 'Untitled',
      command: (data && data.command) || '',
      enabled: data && data.enabled !== undefined ? !!data.enabled : true,
      createdAt: Date.now(),
    };
    this.state.commands.push(cmd);
    this.save();
    return cmd;
  }

  updateCommand(id, patch) {
    const idx = this.state.commands.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    const existing = this.state.commands[idx];
    const merged = { ...existing, ...patch, id };
    if (patch && patch.name !== undefined) merged.name = (patch.name || '').trim() || existing.name;
    this.state.commands[idx] = merged;
    this.save();
    return merged;
  }

  deleteCommand(id) {
    const idx = this.state.commands.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    const [removed] = this.state.commands.splice(idx, 1);
    this.save();
    return removed;
  }
}

module.exports = { Store, genId, defaultLinkFields, defaultSettings, defaultUi };
