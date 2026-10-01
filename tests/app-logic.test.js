'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { install } = require('./helpers/electronStub');
install();
const { UnreadTracker } = require('../src/main/unread');
const { normalizeUrl } = require('../src/main/navigation');
const { parseManualLocation } = require('../src/main/geolocation');
const { getFlattenedLinkOrder } = require('../src/main/shortcuts');
const { defaultLinkFields, defaultSettings } = require('../src/main/store');
const { buildLinkRuleConfig } = require('../src/main/ipc');
const { ViewManager } = require('../src/main/viewManager');

function makeTracker(unreadPatch = {}) {
  const link = { id: 'L1', ...defaultLinkFields(), name: 'L', url: 'https://l.com' };
  link.unread = { ...link.unread, ...unreadPatch };
  const store = { getState: () => ({ links: [link] }) };
  return { tracker: new UnreadTracker(store), link };
}

describe('UnreadTracker: signal precedence (expert > badge > title > favicon > notified)', () => {
  test('title with (3) gives count 3', () => {
    const { tracker } = makeTracker();
    tracker.reportTitle('L1', '(3) Inbox');
    assert.deepEqual(tracker.get('L1'), { count: 3, activity: true, source: 'title', stale: false });
  });

  test('Gmail style title with count mid-string', () => {
    const { tracker } = makeTracker();
    tracker.reportTitle('L1', 'Inbox (12) - me@gmail.com - Gmail');
    assert.equal(tracker.get('L1').count, 12);
  });

  test('count going back to zero title clears activity', () => {
    const { tracker } = makeTracker();
    tracker.reportTitle('L1', '(3) Inbox');
    tracker.reportTitle('L1', 'Inbox');
    assert.equal(tracker.get('L1').activity, false);
  });

  test('badge beats title', () => {
    const { tracker } = makeTracker();
    tracker.reportTitle('L1', '(3) Inbox');
    tracker.reportBadge('L1', 7);
    assert.equal(tracker.get('L1').source, 'badge');
    assert.equal(tracker.get('L1').count, 7);
  });

  test('title that never matches does not block favicon', () => {
    const { tracker } = makeTracker();
    tracker.reportTitle('L1', 'Just a page');
    tracker.reportFavicon('L1', ['https://x.com/unread.ico']);
    assert.equal(tracker.get('L1').source, 'favicon');
    assert.equal(tracker.get('L1').activity, true);
  });

  test('favicon word inside another word (unreadcountfavicon) is ignored', () => {
    const { tracker } = makeTracker();
    tracker.reportFavicon('L1', ['https://x.com/unreadcountfavicon.ico']);
    assert.equal(tracker.get('L1').source, null);
  });

  test('notification lights the link, and clearNotified turns it off', () => {
    const { tracker } = makeTracker();
    tracker.reportNotified('L1');
    assert.equal(tracker.get('L1').activity, true);
    tracker.clearNotified('L1');
    assert.equal(tracker.get('L1').activity, false);
  });

  test('a link with unread turned off always reports nothing', () => {
    const { tracker } = makeTracker({ enabled: false });
    tracker.reportTitle('L1', '(9) x');
    assert.deepEqual(tracker.get('L1'), { count: null, activity: false, source: null, stale: false });
  });

  test('onChange fires with the resolved state', () => {
    const { tracker } = makeTracker();
    const seen = [];
    tracker.onChange((id, eff) => seen.push([id, eff.count]));
    tracker.reportTitle('L1', '(2) x');
    assert.deepEqual(seen, [['L1', 2]]);
  });
});

describe('normalizeUrl', () => {
  test('adds https when there is no scheme', () => {
    assert.equal(normalizeUrl('example.com'), 'https://example.com');
    assert.equal(normalizeUrl('  example.com/a  '), 'https://example.com/a');
  });
  test('keeps an existing scheme', () => {
    assert.equal(normalizeUrl('http://localhost:3000'), 'http://localhost:3000');
  });
  test('empty stays empty', () => {
    assert.equal(normalizeUrl('  '), '');
    assert.equal(normalizeUrl(null), '');
  });
});

describe('parseManualLocation', () => {
  test('valid lat,lon', () => {
    assert.deepEqual(parseManualLocation('40.7128, -74.0060'), { latitude: 40.7128, longitude: -74.006, accuracy: 10 });
  });
  test('rejects out of range, wrong shape, non-numbers, blanks', () => {
    for (const bad of ['91,0', '0,181', '1', '1,2,3', 'a,b', '', null, undefined]) {
      assert.equal(parseManualLocation(bad), null, String(bad));
    }
  });
});

describe('getFlattenedLinkOrder (Ctrl+1..9 order)', () => {
  test('ungrouped first, then groups by order, links by order, disabled skipped', () => {
    const store = {
      getState: () => ({
        groups: [{ id: 'g2', order: 1 }, { id: 'g1', order: 0 }],
        links: [
          { id: 'a', groupId: 'g1', order: 1, enabled: true },
          { id: 'b', groupId: 'g1', order: 0, enabled: true },
          { id: 'c', groupId: 'g2', order: 0, enabled: true },
          { id: 'd', groupId: null, order: 0, enabled: true },
          { id: 'e', groupId: null, order: 1, enabled: false },
        ],
      }),
    };
    assert.deepEqual(getFlattenedLinkOrder(store), ['d', 'b', 'a', 'c']);
  });
});

describe('buildLinkRuleConfig (what each page is told)', () => {
  const link = { ...defaultLinkFields() };
  test('passes the password manager switch through, off by default', () => {
    assert.equal(buildLinkRuleConfig(link, {}, []).passwordManager, false);
    assert.equal(buildLinkRuleConfig(link, { passwordManager: true }, []).passwordManager, true);
  });
  test('reveal-password (eye) switch is on by default and passes through', () => {
    assert.equal(defaultSettings().revealPassword, true);
    assert.equal(buildLinkRuleConfig(link, defaultSettings(), []).revealPassword, true);
    assert.equal(buildLinkRuleConfig(link, { revealPassword: false }, []).revealPassword, false);
  });
  test('notification contents are shown by default', () => {
    assert.equal(defaultSettings().showNotificationContents, true);
  });
  test('only enabled userscripts are sent', () => {
    const cfg = buildLinkRuleConfig(link, {}, [
      { name: 'on', matches: ['*'], code: '1', enabled: true },
      { name: 'off', matches: ['*'], code: '2', enabled: false },
    ]);
    assert.deepEqual(cfg.userscripts.map((u) => u.name), ['on']);
  });
});

describe('zoom shortcuts (ViewManager.stepZoom)', () => {
  // stepZoom only needs _link/store/updateLinkRuntimeConfig, so call it on a stand-in.
  function zoomer(start) {
    const link = { id: 'z', zoom: start };
    const self = {
      _link: () => link,
      store: { updateLink: (_id, patch) => Object.assign(link, patch) },
      updateLinkRuntimeConfig: () => {},
    };
    return { link, step: (dir) => ViewManager.prototype.stepZoom.call(self, 'z', dir) };
  }

  test('in/out walk Chrome-style presets and stop at 50% and 300%', () => {
    const z = zoomer(1);
    z.step('in'); assert.equal(z.link.zoom, 1.1);
    z.step('in'); assert.equal(z.link.zoom, 1.25);
    z.step('out'); z.step('out'); assert.equal(z.link.zoom, 1);
    for (let i = 0; i < 20; i++) z.step('in');
    assert.equal(z.link.zoom, 3);
    for (let i = 0; i < 20; i++) z.step('out');
    assert.equal(z.link.zoom, 0.5);
  });

  test('reset returns to 100% and an in-between value snaps to the next step', () => {
    const z = zoomer(1.7);
    z.step('in'); assert.equal(z.link.zoom, 1.75);
    z.step('reset'); assert.equal(z.link.zoom, 1);
    const odd = zoomer(1.2);
    odd.step('out'); assert.equal(odd.link.zoom, 1.1);
  });
});
