'use strict';

const { TITLE_UNREAD_PATTERNS, FAVICON_UNREAD_KEYWORDS, FAVICON_READ_KEYWORDS } = require('./constants');

// Per-link latched signal state. Precedence, once a higher-trust signal has
// ever fired, it wins outright forever after (mirrors MyOutlook/main.js).
// Rank 1 expert > 2 badge > 3 title > 4 favicon.
class UnreadTracker {
  constructor(store) {
    this.store = store;
    this.map = new Map(); // linkId -> raw signal state
    this._listeners = new Set();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(linkId) {
    const effective = this.get(linkId);
    for (const fn of this._listeners) {
      try { fn(linkId, effective); } catch (_e) { /* ignore */ }
    }
  }

  _linkConfig(linkId) {
    const link = this.store.getState().links.find((l) => l.id === linkId);
    return link || null;
  }

  _ensure(linkId) {
    if (!this.map.has(linkId)) {
      this.map.set(linkId, {
        expert: { seen: false, count: null, activity: false },
        badge: { seen: false, count: null },
        title: { seen: false, count: null },
        favicon: { seen: false, activity: false },
        stale: false,
        lastLoadTs: Date.now(),
      });
    }
    return this.map.get(linkId);
  }

  remove(linkId) {
    this.map.delete(linkId);
  }

  clear() {
    this.map.clear();
  }

  markLoaded(linkId) {
    const s = this._ensure(linkId);
    s.lastLoadTs = Date.now();
  }

  setStale(linkId, stale) {
    const s = this._ensure(linkId);
    s.stale = !!stale;
    this._emit(linkId);
  }

  reportExpert(linkId, { count, presence }) {
    const link = this._linkConfig(linkId);
    if (!link || !link.unread.enabled || !link.unread.expert.enabled) return;
    const s = this._ensure(linkId);
    s.expert.seen = true;
    if (link.unread.expert.mode === 'presence') {
      s.expert.activity = !!presence;
      s.expert.count = null;
    } else {
      s.expert.count = typeof count === 'number' ? count : null;
      s.expert.activity = (s.expert.count || 0) > 0;
    }
    this._emit(linkId);
  }

  reportBadge(linkId, count) {
    const link = this._linkConfig(linkId);
    if (!link || !link.unread.enabled || !link.unread.badge.enabled) return;
    const s = this._ensure(linkId);
    s.badge.seen = true;
    s.badge.count = typeof count === 'number' ? count : null;
    this._emit(linkId);
  }

  reportTitle(linkId, title) {
    const link = this._linkConfig(linkId);
    if (!link || !link.unread.enabled || link.unread.title.mode === 'off') return;
    const s = this._ensure(linkId);
    const patterns = link.unread.title.regex
      ? [new RegExp(link.unread.title.regex)]
      : TITLE_UNREAD_PATTERNS;
    let count = null;
    for (const re of patterns) {
      const m = String(title || '').match(re);
      if (m && m[1] !== undefined) { count = parseInt(m[1], 10); break; }
    }
    if (count !== null) {
      s.title.seen = true;
      s.title.count = count;
      this._emit(linkId);
    }
  }

  reportFavicon(linkId, favicons) {
    const link = this._linkConfig(linkId);
    if (!link || !link.unread.enabled || link.unread.favicon.mode === 'off') return;
    const s = this._ensure(linkId);
    const text = (favicons || []).join(' ').toLowerCase();
    if (FAVICON_UNREAD_KEYWORDS.test(text)) {
      s.favicon.seen = true;
      s.favicon.activity = true;
      this._emit(linkId);
    } else if (FAVICON_READ_KEYWORDS.test(text)) {
      s.favicon.seen = true;
      s.favicon.activity = false;
      this._emit(linkId);
    }
  }

  // Effective, precedence-resolved unread state for a link.
  get(linkId) {
    const link = this._linkConfig(linkId);
    const s = this.map.get(linkId);
    if (!link || !link.unread.enabled || !s) {
      return { count: null, activity: false, source: null, stale: false };
    }
    let result;
    if (s.expert.seen) {
      result = { count: s.expert.count, activity: s.expert.activity, source: 'expert' };
    } else if (s.badge.seen) {
      result = { count: s.badge.count, activity: s.badge.count === null ? true : s.badge.count > 0, source: 'badge' };
    } else if (s.title.seen) {
      result = { count: s.title.count, activity: (s.title.count || 0) > 0, source: 'title' };
    } else if (s.favicon.seen) {
      result = { count: null, activity: s.favicon.activity, source: 'favicon' };
    } else {
      result = { count: null, activity: false, source: null };
    }
    result.stale = s.stale;
    return result;
  }

  getAll() {
    const out = {};
    for (const [linkId] of this.map) out[linkId] = this.get(linkId);
    return out;
  }
}

module.exports = { UnreadTracker };
