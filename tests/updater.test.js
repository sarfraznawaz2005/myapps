'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { install } = require('./helpers/electronStub');
install();
const { isNewer, parseChecksums, pickPortableAsset, psQuote } = require('../src/main/updater');

describe('updater helpers', () => {
  test('isNewer compares MAJOR.MINOR.PATCH numerically', () => {
    assert.equal(isNewer('1.3.1', '1.3.0'), true);
    assert.equal(isNewer('v1.10.0', '1.9.9'), true);
    assert.equal(isNewer('1.3.0', '1.3.0'), false);
    assert.equal(isNewer('1.2.9', '1.3.0'), false);
    assert.equal(isNewer('junk', '1.3.0'), false);
  });

  test('parseChecksums reads sha256sum lines', () => {
    const h = 'a'.repeat(64);
    const m = parseChecksums(`${h.toUpperCase()}  MyApps-1.0.0-portable.zip\nnot a line\n`);
    assert.equal(m.get('MyApps-1.0.0-portable.zip'), h);
    assert.equal(m.size, 1);
  });

  test('pickPortableAsset only accepts the exact zip from this repo', () => {
    const ok = { name: 'MyApps-1.0.0-portable.zip', size: 1, browser_download_url: 'https://github.com/sarfraznawaz2005/myapps/releases/download/v1.0.0/MyApps-1.0.0-portable.zip' };
    const evil = { ...ok, browser_download_url: 'https://example.com/MyApps-1.0.0-portable.zip' };
    assert.equal(pickPortableAsset([ok], '1.0.0'), ok);
    assert.equal(pickPortableAsset([evil], '1.0.0'), null);
    assert.equal(pickPortableAsset([ok], '1.0.1'), null);
  });

  test('psQuote doubles single quotes', () => {
    assert.equal(psQuote("it's"), "'it''s'");
  });
});
