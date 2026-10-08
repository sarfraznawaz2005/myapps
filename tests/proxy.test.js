'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isValidProxyServer, resolveProxyConfig } = require('../src/main/proxy');

describe('proxy server check', () => {
  test('accepts host:port with or without a scheme', () => {
    for (const ok of ['127.0.0.1:8080', 'http://proxy.example.com:3128', 'https://p.example.com:443', 'socks5://127.0.0.1:1080', 'socks4://[::1]:9050']) {
      assert.equal(isValidProxyServer(ok), true, ok);
    }
  });

  test('rejects missing port, user:password, lists and junk', () => {
    for (const bad of ['', '   ', 'proxy.example.com', 'http://proxy', 'http://user:pw@proxy:8080', 'a:80;b:81', 'ftp://p:21', 'http://p:8080/path', null, undefined, 42]) {
      assert.equal(isValidProxyServer(bad), false, String(bad));
    }
  });
});

describe('proxy per link beats the global proxy', () => {
  const settings = { proxyServer: 'http://global:8080' };

  test('no choice on the link: use the global proxy', () => {
    assert.deepEqual(resolveProxyConfig({ proxy: { mode: 'global', server: '' } }, settings), { mode: 'fixed_servers', proxyRules: 'http://global:8080' });
    assert.deepEqual(resolveProxyConfig({}, settings), { mode: 'fixed_servers', proxyRules: 'http://global:8080' });
  });

  test('no global proxy: use the Windows proxy', () => {
    assert.deepEqual(resolveProxyConfig({ proxy: { mode: 'global' } }, { proxyServer: '' }), { mode: 'system' });
  });

  test('"No proxy" on the link connects directly, even with a global proxy', () => {
    assert.deepEqual(resolveProxyConfig({ proxy: { mode: 'none' } }, settings), { mode: 'direct' });
  });

  test('a custom proxy on the link wins over the global one', () => {
    assert.deepEqual(resolveProxyConfig({ proxy: { mode: 'custom', server: 'socks5://10.0.0.1:1080' } }, settings), { mode: 'fixed_servers', proxyRules: 'socks5://10.0.0.1:1080' });
  });

  test('a custom mode with a bad server falls back to the global choice', () => {
    assert.deepEqual(resolveProxyConfig({ proxy: { mode: 'custom', server: 'nope' } }, settings), { mode: 'fixed_servers', proxyRules: 'http://global:8080' });
  });
});
