'use strict';

const { app } = require('electron');

// DNS-over-HTTPS templates for the built-in provider choices. See
// https://github.com/curl/curl/wiki/DNS-over-HTTPS#publicly-available-servers
const PROVIDER_SERVERS = {
  google: ['https://dns.google/dns-query'],
  cloudflare: ['https://cloudflare-dns.com/dns-query'],
};

// Applied at startup and again whenever the user changes the setting —
// Electron allows calling this any time after 'ready', not just once.
function applyDnsSettings(settings) {
  const provider = settings.dnsProvider || 'system';
  if (provider === 'system') {
    app.configureHostResolver({ secureDnsMode: 'automatic' });
    return;
  }
  if (provider === 'custom') {
    const url = (settings.dnsCustomServer || '').trim();
    if (!url) {
      app.configureHostResolver({ secureDnsMode: 'automatic' });
      return;
    }
    // 'automatic' (not 'secure') — falls back to normal DNS if this server is
    // ever unreachable, instead of breaking every site's name resolution.
    app.configureHostResolver({ secureDnsMode: 'automatic', secureDnsServers: [url] });
    return;
  }
  const servers = PROVIDER_SERVERS[provider];
  if (!servers) return;
  app.configureHostResolver({ secureDnsMode: 'automatic', secureDnsServers: servers });
}

module.exports = { applyDnsSettings };
