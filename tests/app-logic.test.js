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
const { ViewManager, userAgentFor, clientHintsFor } = require('../src/main/viewManager');
const { PeriodicReloadController, periodMs } = require('../src/main/periodicReload');
const { HibernationController } = require('../src/main/hibernation');
const { EventEmitter } = require('node:events');

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

describe('desktop / mobile view', () => {
  const SESSION_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

  test('every link starts in desktop view', () => {
    assert.equal(defaultLinkFields().viewMode, 'desktop');
  });

  test('desktop uses the link custom user-agent when set, else the normal session one', () => {
    assert.equal(userAgentFor({ viewMode: 'desktop', userAgent: '  MyCustom/1.0 ' }, SESSION_UA, '152.0.1'), 'MyCustom/1.0');
    assert.equal(userAgentFor({ viewMode: 'desktop', userAgent: null }, SESSION_UA, '152.0.1'), SESSION_UA);
    assert.equal(userAgentFor({ userAgent: '' }, SESSION_UA, '152.0.1'), SESSION_UA);
  });

  test('mobile is an Android Chrome user-agent that matches the engine version, whatever the custom one', () => {
    const ua = userAgentFor({ viewMode: 'mobile', userAgent: 'MyCustom/1.0' }, SESSION_UA, '152.0.7977.130');
    assert.match(ua, /Android/);
    assert.match(ua, /Chrome\/152\.0\.0\.0 Mobile Safari/);
    assert.ok(!ua.includes('Electron'));
  });

  test('mobile client hints say Android + mobile, with brands and the real version', () => {
    const h = clientHintsFor('152.0.7977.130');
    assert.equal(h.mobile, true);
    assert.equal(h.platform, 'Android');
    assert.ok(h.brands.every((b) => !/electron/i.test(b.brand)));
    assert.equal(h.brands.find((b) => b.brand === 'Google Chrome').version, '152');
    assert.equal(h.fullVersionList.find((b) => b.brand === 'Chromium').version, '152.0.7977.130');
  });

  test('setViewMode saves the choice, rejects bad values, and reloads after emulation is applied', async () => {
    const link = { id: 'v', viewMode: 'desktop' };
    const calls = [];
    const view = { webContents: { isDestroyed: () => false, reload: () => calls.push('reload') } };
    const self = {
      _link: () => link,
      store: { updateLink: (_id, patch) => Object.assign(link, patch) },
      views: new Map([['v', view]]),
      layout: () => calls.push('layout'),
      _applyViewMode: async () => { calls.push('apply'); },
    };
    const set = (mode) => ViewManager.prototype.setViewMode.call(self, 'v', mode);
    assert.equal(await set('tablet'), false);
    assert.equal(await set('desktop'), false); // already desktop: nothing to do
    assert.equal(await set('mobile'), true);
    assert.equal(link.viewMode, 'mobile');
    assert.deepEqual(calls, ['layout', 'apply', 'reload']); // reload only after apply finished
  });
});

describe('periodic reload', () => {
  const MIN = 60000;
  function setup(link) {
    const vm = new EventEmitter();
    const loaded = new Set([link.id]);
    const reloads = [];
    vm.isLoaded = (id) => loaded.has(id);
    vm.reload = (id) => reloads.push(id);
    const ctrl = new PeriodicReloadController({ store: { getState: () => ({ links: [link] }) }, viewManager: vm });
    clearInterval(ctrl.timer); // tests drive tick() by hand
    return { ctrl, vm, loaded, reloads };
  }

  test('off by default, and junk values count as off', () => {
    assert.equal(defaultLinkFields().reloadMinutes, 0);
    for (const bad of [0, -5, NaN, 'abc', null, undefined]) assert.equal(periodMs({ reloadMinutes: bad }), 0);
    assert.equal(periodMs({ reloadMinutes: 5 }), 5 * MIN);
    assert.equal(periodMs({ reloadMinutes: 999999 }), 7 * 24 * 60 * MIN); // capped at a week
  });

  test('reloads a loaded link once its period has passed, then waits a full period again', () => {
    const { ctrl, vm, reloads } = setup({ id: 'a', enabled: true, reloadMinutes: 5 });
    const t0 = Date.now();
    vm.emit('loaded', 'a');
    ctrl.lastAt.set('a', t0);
    ctrl.tick(t0 + 4 * MIN);
    assert.deepEqual(reloads, []);
    ctrl.tick(t0 + 5 * MIN);
    assert.deepEqual(reloads, ['a']);
    ctrl.tick(t0 + 6 * MIN); // a failed load must not be retried on every tick
    assert.deepEqual(reloads, ['a']);
    ctrl.tick(t0 + 10 * MIN);
    assert.deepEqual(reloads, ['a', 'a']);
  });

  test('a page load restarts the clock; a hibernated link is never reloaded', () => {
    const { ctrl, vm, loaded, reloads } = setup({ id: 'b', enabled: true, reloadMinutes: 5 });
    const t0 = Date.now();
    ctrl.lastAt.set('b', t0 - 10 * MIN);
    vm.emit('page-loaded', 'b'); // sets lastAt to "now"
    ctrl.tick(t0 + MIN);
    assert.deepEqual(reloads, []);
    loaded.delete('b');
    vm.emit('hibernated', 'b');
    ctrl.tick(t0 + 60 * MIN);
    assert.deepEqual(reloads, []);
  });

  test('periodic-reload links are exempt from automatic hibernation, others are not', () => {
    const h = Object.create(HibernationController.prototype);
    assert.equal(h.effectiveKeepAwake({ reloadMinutes: 10, hibernate: { keepAwake: false } }), true);
    assert.equal(h.effectiveKeepAwake({ reloadMinutes: 0, hibernate: { keepAwake: false } }), false);
    assert.equal(h.effectiveKeepAwake({ reloadMinutes: 0, hibernate: { keepAwake: true } }), true);
  });
});
