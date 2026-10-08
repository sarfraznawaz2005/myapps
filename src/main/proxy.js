'use strict';

// Proxy per link. A link's own choice beats the global proxy setting:
//   link.proxy.mode 'none'   -> this link connects directly (no proxy)
//   link.proxy.mode 'custom' -> this link uses link.proxy.server
//   link.proxy.mode 'global' -> use settings.proxyServer, else the Windows proxy
// (This file never requires 'electron', so the tests can load it.)

// scheme://host:port or host:port. The port is required. No user:password part.
const SERVER_RE = /^(?:(?:https?|socks4|socks5):\/\/)?(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\]):\d{1,5}$/;

function isValidProxyServer(value) {
  return typeof value === 'string' && value.length <= 300 && SERVER_RE.test(value.trim());
}

// Returns an Electron ProxyConfig for one link.
function resolveProxyConfig(link, settings) {
  const own = (link && link.proxy) || {};
  if (own.mode === 'none') return { mode: 'direct' };
  if (own.mode === 'custom' && isValidProxyServer(own.server)) {
    return { mode: 'fixed_servers', proxyRules: own.server.trim() };
  }
  const global = settings && settings.proxyServer;
  if (isValidProxyServer(global)) return { mode: 'fixed_servers', proxyRules: global.trim() };
  return { mode: 'system' };
}

// partition -> JSON of the config we last set on it.
const applied = new Map();
// partition -> promise that settles when the first setProxy() is done.
const pending = new Map();

// Sets the link session's proxy. Does nothing when the config did not change.
// A later change also closes open connections, so it takes effect at once.
function applyToSession(ses, partition, config) {
  const signature = JSON.stringify(config);
  if (applied.get(partition) === signature) return false;
  const first = !applied.has(partition);
  applied.set(partition, signature);
  const done = (async () => {
    try {
      await ses.setProxy(config);
      if (!first) await ses.closeAllConnections();
    } catch (err) {
      console.error('Failed to set proxy:', err);
    }
  })();
  if (first && config.mode !== 'system') {
    pending.set(partition, done);
    done.then(() => { if (pending.get(partition) === done) pending.delete(partition); });
  }
  return !first;
}

// A promise to wait for before the first page load, or null when nothing to wait for.
function proxyReady(partition) {
  return pending.get(partition) || null;
}

// Re-applies the proxy to every link session that is already set up.
// Returns the ids of the links whose proxy really changed.
function reapplyAll(store, getSession) {
  const { links, settings } = store.getState();
  const changed = [];
  for (const link of links) {
    if (!applied.has(link.partition)) continue;
    if (applyToSession(getSession(link.partition), link.partition, resolveProxyConfig(link, settings))) changed.push(link.id);
  }
  return changed;
}

module.exports = { isValidProxyServer, resolveProxyConfig, applyToSession, proxyReady, reapplyAll };
