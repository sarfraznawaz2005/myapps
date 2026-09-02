'use strict';

const { app } = require('electron');

const TICK_MS = 30000;

class HibernationController {
  constructor({ store, viewManager, unreadTracker }) {
    this.store = store;
    this.viewManager = viewManager;
    this.unreadTracker = unreadTracker;
    this.deactivatedAt = new Map(); // linkId -> ts it stopped being the active view
    this.trayHiddenAt = null;

    viewManager.on('active', (id) => {
      for (const otherId of viewManager.views.keys()) {
        if (otherId !== id && !this.deactivatedAt.has(otherId)) this.deactivatedAt.set(otherId, Date.now());
      }
      this.deactivatedAt.delete(id);
    });
    viewManager.on('loaded', (id) => this.unreadTracker.setStale(id, false));
    viewManager.on('hibernated', (id) => {
      this.deactivatedAt.delete(id);
      this.unreadTracker.setStale(id, true);
    });

    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  destroy() {
    if (this.timer) clearInterval(this.timer);
  }

  effectiveKeepAwake(link) {
    return !!(link.hibernate && link.hibernate.keepAwake);
  }

  onWindowHide() {
    this.trayHiddenAt = Date.now();
  }

  onWindowShow() {
    this.trayHiddenAt = null;
  }

  tick() {
    const { links } = this.store.getState();
    const activeId = this.viewManager.getActiveId();
    for (const link of links) {
      if (!this.viewManager.isLoaded(link.id)) continue;
      if (link.id === activeId) continue;
      if (link.hibernate.policy !== 'idle') continue;
      if (this.effectiveKeepAwake(link)) continue;
      const since = this.deactivatedAt.get(link.id);
      if (!since) continue;
      const minutes = link.hibernate.minutes || 30;
      if (Date.now() - since >= minutes * 60000) {
        this.viewManager.hibernate(link.id);
      }
    }
    this._checkTrayHibernate();
  }

  _checkTrayHibernate() {
    const minutes = this.store.getState().settings.hibernateOnTrayMinutes;
    if (!minutes || !this.trayHiddenAt) return;
    if (Date.now() - this.trayHiddenAt < minutes * 60000) return;
    for (const link of this.store.getState().links) {
      if (!this.viewManager.isLoaded(link.id)) continue;
      if (this.effectiveKeepAwake(link)) continue;
      this.viewManager.hibernate(link.id);
    }
  }
}

// app.getAppMetrics() rows augmented with the link they belong to, where
// determinable by matching OS process id. Used by the Settings > Performance panel.
function getMemoryReport(store, viewManager) {
  const metrics = app.getAppMetrics();
  const pidToLink = new Map();
  for (const link of store.getState().links) {
    const view = viewManager.getView(link.id);
    if (view && !view.webContents.isDestroyed()) {
      try { pidToLink.set(view.webContents.getOSProcessId(), link); } catch (_e) { /* ignore */ }
    }
  }
  return metrics.map((m) => {
    const link = pidToLink.get(m.pid);
    return {
      pid: m.pid,
      type: m.type,
      linkId: link ? link.id : null,
      linkName: link ? link.name : (m.type === 'Browser' ? 'Shell (main)' : m.type),
      memoryMB: m.memory && m.memory.workingSetSize ? Math.round(m.memory.workingSetSize / 1024) : null,
      cpuPercent: m.cpu ? Math.round(m.cpu.percentCPUUsage * 10) / 10 : null,
    };
  });
}

module.exports = { HibernationController, getMemoryReport };
