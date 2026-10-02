'use strict';

const TICK_MS = 10000;
const MAX_MINUTES = 7 * 24 * 60; // a week; anything larger is a typo

// Pure: a link's reload period in ms, 0 = off. Tolerates junk in store.json.
function periodMs(link) {
  const m = Math.floor(Number(link && link.reloadMinutes));
  if (!Number.isFinite(m) || m <= 0) return 0;
  return Math.min(m, MAX_MINUTES) * 60000;
}

// Reloads a link's page every N minutes (Edit dialog > Periodic reload; 0 = off).
// Only links that are currently loaded: a hibernated link is off, and starts its
// clock again when it wakes. The clock restarts on every page load, so a page the
// user just navigated or reloaded is not reloaded again straight away, and a load
// that fails is retried once per period, not on every tick.
class PeriodicReloadController {
  constructor({ store, viewManager }) {
    this.store = store;
    this.viewManager = viewManager;
    this.lastAt = new Map(); // linkId -> ts of the last page load or auto-reload
    viewManager.on('loaded', (id) => this.lastAt.set(id, Date.now()));
    viewManager.on('page-loaded', (id) => this.lastAt.set(id, Date.now()));
    viewManager.on('hibernated', (id) => this.lastAt.delete(id));
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  tick(now = Date.now()) {
    for (const link of this.store.getState().links) {
      const period = periodMs(link);
      if (!period || !link.enabled || !this.viewManager.isLoaded(link.id)) continue;
      const last = this.lastAt.get(link.id);
      if (last === undefined) { this.lastAt.set(link.id, now); continue; }
      if (now - last >= period) {
        this.lastAt.set(link.id, now);
        this.viewManager.reload(link.id);
      }
    }
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
  }
}

module.exports = { PeriodicReloadController, periodMs };
