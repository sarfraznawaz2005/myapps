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
const { buildLinkRuleConfig, cleanKeywords, cleanWhatsapp, whatsappChatUrl } = require('../src/main/ipc');
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

describe('dark mode toggle (ViewManager.setDarkMode)', () => {
  function darkHarness(start) {
    const link = { id: 'd', darkMode: start };
    const inserted = [];
    const removed = [];
    const wc = {
      isDestroyed: () => false,
      insertCSS: async (css) => { inserted.push(css); return `key${inserted.length}`; },
      removeInsertedCSS: async (key) => { removed.push(key); },
    };
    const self = {
      _link: () => link,
      views: new Map([['d', { webContents: wc }]]),
      _darkCssKeys: new Map(),
      store: { updateLink: (_id, patch) => Object.assign(link, patch) },
    };
    self._applyDarkMode = ViewManager.prototype._applyDarkMode.bind(self);
    return { link, inserted, removed, self, set: (on) => ViewManager.prototype.setDarkMode.call(self, 'd', on) };
  }
  const tick = () => new Promise((r) => setImmediate(r));

  test('defaults to off', () => {
    assert.equal(defaultLinkFields().darkMode, false);
  });

  test('turning on saves it on the link and inserts the CSS', async () => {
    const h = darkHarness(false);
    assert.equal(h.set(true), true);
    await tick();
    assert.equal(h.link.darkMode, true);
    assert.equal(h.inserted.length, 1);
    assert.match(h.inserted[0], /invert\(1\)/);
  });

  test('turning off removes the inserted CSS', async () => {
    const h = darkHarness(false);
    h.set(true); await tick();
    h.set(false); await tick();
    assert.equal(h.link.darkMode, false);
    assert.deepEqual(h.removed, ['key1']);
    assert.equal(h.inserted.length, 1);
  });

  test('a new page load re-applies it when the link is saved as dark', async () => {
    const h = darkHarness(true); // as if restored from disk after a restart
    await h.self._applyDarkMode('d');
    assert.equal(h.inserted.length, 1);
  });

  test('setting the same value again does nothing', () => {
    const h = darkHarness(true);
    assert.equal(h.set(true), false);
  });
});

describe('keyword highlighter settings', () => {
  test('default is an empty list, so highlighting is skipped', () => {
    assert.deepEqual(defaultSettings().highlightKeywords, []);
    assert.deepEqual(buildLinkRuleConfig(defaultLinkFields(), defaultSettings(), []).highlightKeywords, []);
  });

  test('cleanKeywords trims, drops blanks and duplicates (any case), caps length', () => {
    assert.deepEqual(cleanKeywords(['  urgent ', '', 'URGENT', 'invoice', 5, null]), ['urgent', 'invoice']);
    assert.deepEqual(cleanKeywords(['ab', 'abc', ' a ']), ['abc']); // minimum 3 characters
    assert.equal(cleanKeywords(['x'.repeat(500)])[0].length, 100);
    assert.deepEqual(cleanKeywords('nope'), []);
  });

  test('keywords reach every link config', () => {
    const settings = { ...defaultSettings(), highlightKeywords: ['alpha', 'beta'] };
    assert.deepEqual(buildLinkRuleConfig(defaultLinkFields(), settings, []).highlightKeywords, ['alpha', 'beta']);
  });
});

describe('WhatsApp extras settings (per link)', () => {
  test('every option is off by default, with no contacts', () => {
    const w = defaultLinkFields().whatsapp;
    assert.equal(Object.entries(w).filter(([k, v]) => k !== 'notifyContacts' && k !== 'sidebarWidth' && v !== false).length, 0);
    assert.deepEqual(w.notifyContacts, []);
    assert.equal(w.sidebarWidth, 0);
  });

  test('cleanWhatsapp keeps a sidebar width only as 0 or 200 to 2000 pixels', () => {
    assert.equal(cleanWhatsapp({ sidebarWidth: 480.4 }).sidebarWidth, 480);
    assert.equal(cleanWhatsapp({ sidebarWidth: 50 }).sidebarWidth, 200);
    assert.equal(cleanWhatsapp({ sidebarWidth: 99999 }).sidebarWidth, 2000);
    assert.equal(cleanWhatsapp({ sidebarWidth: -5 }).sidebarWidth, 0);
    assert.equal(cleanWhatsapp({ sidebarWidth: 'abc' }).sidebarWidth, 0);
    assert.equal(cleanWhatsapp({ resizableSidebar: 1 }).resizableSidebar, true);
    assert.equal('sidebarWidth' in cleanWhatsapp({ blurNames: true }), false);
  });

  test('cleanWhatsapp keeps known keys only and coerces flags to booleans', () => {
    const out = cleanWhatsapp({ blurNames: 1, hideOnline: 'yes', evil: true, __proto__: { x: 1 } });
    assert.deepEqual(out, { blurNames: true, hideOnline: true });
  });

  test('cleanWhatsapp trims, de-duplicates and caps the contact list', () => {
    const out = cleanWhatsapp({ notifyContacts: [' Alice ', 'alice', '', 5, 'x'.repeat(200)] });
    assert.equal(out.notifyContacts.length, 2);
    assert.equal(out.notifyContacts[0], 'Alice');
    assert.equal(out.notifyContacts[1].length, 80);
    assert.equal(cleanWhatsapp({ notifyContacts: Array.from({ length: 80 }, (_, i) => `c${i}`) }).notifyContacts.length, 50);
  });

  test('each link config carries its own choices', () => {
    const a = { ...defaultLinkFields(), whatsapp: { ...defaultLinkFields().whatsapp, hideOnline: true } };
    const b = defaultLinkFields();
    assert.equal(buildLinkRuleConfig(a, defaultSettings(), []).whatsapp.hideOnline, true);
    assert.equal(buildLinkRuleConfig(b, defaultSettings(), []).whatsapp.hideOnline, false);
  });
});

describe('WhatsApp chat with a number', () => {
  test('keeps digits only and builds the web.whatsapp.com send URL', () => {
    assert.equal(whatsappChatUrl('+1 (555) 123-4567'), 'https://web.whatsapp.com/send?phone=15551234567');
  });

  test('rejects numbers that are too short, too long or not numbers', () => {
    assert.equal(whatsappChatUrl('12345'), null);
    assert.equal(whatsappChatUrl('1'.repeat(16)), null);
    assert.equal(whatsappChatUrl('abc'), null);
    assert.equal(whatsappChatUrl(null), null);
  });

  test('cannot be used to inject other URL parts', () => {
    assert.equal(whatsappChatUrl('15551234567&text=hi#x'), 'https://web.whatsapp.com/send?phone=15551234567');
  });
});

describe('ad blocker page scripts (scriptlets)', () => {
  const { guardCosmeticScripts } = require('../src/main/adblock');

  function run() {
    const calls = { js: [], css: [] };
    const sender = {
      setMaxListeners: () => {}, getMaxListeners: () => 10,
      executeJavaScript: (code) => { calls.js.push(code); return Promise.resolve(); },
      insertCSS: (css) => { calls.css.push(css); return Promise.resolve(); },
    };
    // Stand-in for the library handler: it hides ad boxes with CSS and runs scriptlets.
    const blocker = {
      onInjectCosmeticFilters: (event) => {
        event.sender.insertCSS('.ad{display:none}');
        event.sender.executeJavaScript('class JSONPath {}');
        event.sender.executeJavaScript('class JSONPath {}');
        return Promise.resolve();
      },
    };
    guardCosmeticScripts(blocker);
    return blocker.onInjectCosmeticFilters({ sender }, 'https://www.facebook.com/', undefined).then(() => calls);
  }

  test('page scripts are not run in pages, but ad boxes are still hidden with CSS', async () => {
    const calls = await run();
    assert.equal(calls.js.length, 0);
    assert.deepEqual(calls.css, ['.ad{display:none}']);
  });
});

describe('Ctrl+Tab link switcher (LinkSwitcher)', () => {
  const { LinkSwitcher } = require('../src/main/linkSwitcher');

  const DEFAULT_LINKS = [
    { id: 'a', name: 'Alpha Chat', url: 'https://web.whatsapp.com/', enabled: true, order: 0, groupId: null },
    { id: 'b', name: 'Beta Outlook', url: 'https://outlook.office.com/mail/', enabled: true, order: 1, groupId: null },
    { id: 'c', name: 'Gamma Gmail', url: 'https://mail.google.com/', enabled: true, order: 2, groupId: null },
    { id: 'd', name: 'Hidden', url: 'https://hidden.example/', enabled: false, order: 3, groupId: null }, // hidden link
  ];

  function setup({ enabled = true, locked = false, activeId = 'a', links, getStatus } = {}) {
    const overlay = {
      shown: false, calls: [], state: null,
      show(state) { this.shown = true; this.state = state; this.calls.push('show'); },
      update(state) { this.state = state; this.calls.push('update'); },
      hide() { this.shown = false; this.calls.push('hide'); },
    };
    const vm = {
      locked, modal: false, active: activeId, activated: [], focused: 0,
      getActiveId() { return this.active; },
      setModalOpen(v) { this.modal = v; },
      focusShell() {},
      focusActive() { this.focused++; },
      activate(id) { this.activated.push(id); this.active = id; },
    };
    const all = links || DEFAULT_LINKS;
    const store = { getState: () => ({ groups: [], links: all, settings: { linkSwitcher: enabled } }) };
    const sw = new LinkSwitcher({ store, viewManager: vm, overlay, getStatus });
    // While it is open the keys come from the overlay page (it has the focus); before that, from a window.
    const key = (type, k, extra = {}) => sw.handleInput({ type, key: k, control: false, shift: false, alt: false, meta: false, isAutoRepeat: false, ...extra }, sw.isOpen ? 'overlay' : 'window');
    const ids = () => overlay.state.items.map((i) => i.id);
    // Fake timers: nothing waits in real time. fire() runs the pending release fallback.
    const timers = { next: 1, live: new Map() };
    sw.timers = {
      set: (fn, ms) => { const id = timers.next++; timers.live.set(id, { fn, ms }); return id; },
      clear: (id) => { timers.live.delete(id); },
    };
    const fire = () => { const first = [...timers.live][0]; if (first) { timers.live.delete(first[0]); first[1].fn(); } };
    const open = () => key('keyDown', 'Tab', CTRL);
    const release = () => key('keyUp', 'Control', {}); // Ctrl let go (the flags then say no Ctrl)
    return { sw, vm, overlay, key, ids, timers, fire, open, release };
  }
  const CTRL = { control: true };

  test('Ctrl+Tab opens it with the link you are on highlighted', () => {
    const { sw, overlay, key, ids } = setup({ activeId: 'b' });
    assert.equal(key('keyDown', 'Tab', CTRL), true);
    assert.equal(sw.isOpen, true);
    assert.deepEqual(ids(), ['a', 'b', 'c']);
    assert.equal(overlay.state.index, 1); // b is the current link
    assert.equal(overlay.state.items[1].current, true);
  });

  test('Ctrl+Shift+Tab also opens it on the link you are on', () => {
    const { overlay, key } = setup({ activeId: 'c' });
    assert.equal(key('keyDown', 'Tab', { control: true, shift: true }), true);
    assert.equal(overlay.state.index, 2);
  });

  test('the highlight starts on the current link wherever it falls in the list', () => {
    for (const [activeId, expected] of [['a', 0], ['b', 1], ['c', 2]]) {
      const t = setup({ activeId });
      t.open();
      assert.equal(t.overlay.state.index, expected, activeId);
    }
  });

  test('letting go straight after opening keeps the current link (nothing to switch)', () => {
    const { sw, vm, overlay, open, release } = setup({ activeId: 'b' });
    open();
    release();
    assert.deepEqual(vm.activated, []);
    assert.equal(sw.isOpen, false);
    assert.equal(overlay.shown, false);
  });

  test('there is no search: typed keys are used up and change nothing', () => {
    const { sw, key, open } = setup({ activeId: 'a' });
    open();
    assert.equal(key('keyDown', 'g', CTRL), true);
    assert.equal(key('keyDown', 'Backspace', CTRL), true);
    assert.equal(sw.index, 0);
    assert.equal(sw.cards.length, 3);
  });

  test('cards are A to Z by name (ignoring case, numbers as numbers), hidden links left out', () => {
    const { open, ids } = setup({ activeId: '1', links: [
      { id: '1', name: 'zebra', url: '', enabled: true, order: 0, groupId: null },
      { id: '2', name: 'App 10', url: '', enabled: true, order: 1, groupId: null },
      { id: '3', name: 'apple', url: '', enabled: true, order: 2, groupId: null },
      { id: '4', name: 'App 2', url: '', enabled: true, order: 3, groupId: null },
      { id: '5', name: 'Nope', url: '', enabled: false, order: 4, groupId: null },
    ] });
    open();
    assert.deepEqual(ids(), ['4', '2', '3', '1']); // App 2, App 10, apple, zebra
  });

  test('awake links come first, then asleep ones, each group A to Z', () => {
    const asleep = { a: false, b: true, c: false };
    const { open, ids, overlay } = setup({ getStatus: (id) => ({ asleep: asleep[id] }) });
    open();
    assert.deepEqual(ids(), ['a', 'c', 'b']); // awake: Alpha, Gamma; asleep: Beta
    assert.deepEqual(overlay.state.items.map((i) => i.asleep), [false, false, true]);
  });

  test('it never hides the page or moves keyboard focus itself', () => {
    const { vm, open } = setup();
    let shellFocused = false;
    vm.focusShell = () => { shellFocused = true; };
    open();
    assert.equal(vm.modal, false);
    assert.equal(shellFocused, false);
  });

  test('each card carries name, letter or icon file, current flag and the sidebar status', () => {
    const statuses = { a: { asleep: false, count: null, activity: false }, b: { asleep: false, count: 4, activity: false }, c: { asleep: true, count: null, activity: false } };
    const { overlay, open } = setup({
      links: [
        { id: 'a', name: 'Alpha', url: 'https://a.example/', enabled: true, order: 0, groupId: null },
        { id: 'b', name: 'Beta', url: 'https://b.example/', enabled: true, order: 1, groupId: null, icon: { path: 'C:\\icons\\b.png' } },
        { id: 'c', name: 'Gamma', url: 'https://c.example/', enabled: true, order: 2, groupId: null },
      ],
      getStatus: (id) => statuses[id],
    });
    open();
    assert.deepEqual(overlay.state.items.map((i) => [i.name, i.letter, i.icon, i.current, i.asleep, i.count]), [
      ['Alpha', 'A', null, true, false, null],
      ['Beta', 'B', 'file:///C:/icons/b.png', false, false, 4],
      ['Gamma', 'G', null, false, true, null],
    ]);
  });

  test('only Ctrl+Tab opens it: plain Tab, Ctrl alone, and Ctrl combined with Alt or Win do not', () => {
    const { sw, key } = setup();
    assert.equal(key('keyDown', 'Tab'), false);
    assert.equal(key('keyDown', 'Control', CTRL), false);
    assert.equal(key('keyDown', 'Tab', { control: true, alt: true }), false);
    assert.equal(key('keyDown', 'Tab', { control: true, meta: true }), false);
    assert.equal(key('keyUp', 'Tab', CTRL), false);
    assert.equal(sw.isOpen, false);
  });

  test('a held Ctrl+Tab that repeats does not open it', () => {
    const { sw, key } = setup();
    assert.equal(key('keyDown', 'Tab', { control: true, isAutoRepeat: true }), false);
    assert.equal(sw.isOpen, false);
  });

  test('pressing Tab moves to the next card, Shift+Tab to the previous one, both wrapping round', () => {
    const { sw, key, open } = setup({ activeId: 'a' });
    open(); assert.equal(sw.index, 0);
    key('keyDown', 'Tab', CTRL); assert.equal(sw.index, 1);
    key('keyDown', 'Tab', CTRL); assert.equal(sw.index, 2);
    key('keyDown', 'Tab', CTRL); assert.equal(sw.index, 0); // wraps
    key('keyDown', 'Tab', { control: true, shift: true }); assert.equal(sw.index, 2); // back, wraps
    key('keyDown', 'Tab', { control: true, shift: true }); assert.equal(sw.index, 1);
  });

  test('the arrow keys also move the highlight', () => {
    const { sw, key, open } = setup({ activeId: 'a' });
    open(); // index 0
    key('keyDown', 'ArrowRight', CTRL); assert.equal(sw.index, 1);
    key('keyDown', 'ArrowDown', CTRL); assert.equal(sw.index, 2);
    key('keyDown', 'ArrowLeft', CTRL); assert.equal(sw.index, 1);
    key('keyDown', 'ArrowUp', CTRL); assert.equal(sw.index, 0);
  });

  test('holding Tab (it repeats) keeps moving once it is open', () => {
    const { sw, key, open } = setup({ activeId: 'a' });
    open();
    key('keyDown', 'Tab', { control: true, isAutoRepeat: true });
    key('keyDown', 'Tab', { control: true, isAutoRepeat: true });
    assert.equal(sw.index, 2);
  });

  test('letting go of Ctrl switches to the highlighted link at once', () => {
    const { sw, vm, overlay, key, open, release } = setup({ activeId: 'a' });
    open();
    key('keyDown', 'Tab', CTRL); // -> b
    key('keyDown', 'Tab', CTRL); // -> c
    assert.equal(release(), false); // the release is not swallowed
    assert.deepEqual(vm.activated, ['c']);
    assert.equal(sw.isOpen, false);
    assert.equal(overlay.shown, false);
  });

  test('Ctrl+Tab, Tab, release switches to the next card', () => {
    const { vm, key, open, release } = setup({ activeId: 'a' });
    open();
    key('keyDown', 'Tab', CTRL);
    release();
    assert.deepEqual(vm.activated, ['b']);
  });

  test('the release of Ctrl is recognised by which key it is, even if its modifier flags are unreliable', () => {
    const { sw, vm, key, open } = setup({ activeId: 'a' });
    open();
    key('keyDown', 'Tab', CTRL);
    key('keyUp', 'Control', { control: true }); // flags still claim Ctrl is down
    assert.deepEqual(vm.activated, ['b']);
    assert.equal(sw.isOpen, false);
  });

  test('releasing Tab (Ctrl still held) does not switch', () => {
    const { sw, vm, key, open } = setup();
    open();
    key('keyUp', 'Tab', CTRL);
    assert.equal(sw.isOpen, true);
    assert.deepEqual(vm.activated, []);
  });

  test('once open, key events from the windows are only echoes and are ignored', () => {
    const { sw, vm, open } = setup({ activeId: 'a' });
    open();
    // Chromium fakes a key release in the page that just lost the focus: it must not switch.
    assert.equal(sw.handleInput({ type: 'keyUp', key: 'Control', control: false, shift: false, alt: false, meta: false }, 'window'), false);
    assert.equal(sw.handleInput({ type: 'keyDown', key: 'Enter', control: true }, 'window'), false);
    assert.equal(sw.isOpen, true);
    assert.deepEqual(vm.activated, []);
  });

  test('keys reported by the overlay cannot open it, only a window can', () => {
    const { sw } = setup();
    assert.equal(sw.handleInput({ type: 'keyDown', key: 'Tab', control: true, shift: false, alt: false, meta: false, isAutoRepeat: false }, 'overlay'), false);
    assert.equal(sw.isOpen, false);
  });

  test('Enter switches to the highlighted link and closes it', () => {
    const { sw, vm, overlay, key, open } = setup({ activeId: 'a' });
    open();
    key('keyDown', 'Tab', CTRL); // -> b
    assert.equal(key('keyDown', 'Enter', CTRL), true);
    assert.deepEqual(vm.activated, ['b']);
    assert.equal(sw.isOpen, false);
    assert.equal(overlay.calls[overlay.calls.length - 1], 'hide');
  });

  test('Escape closes it without switching', () => {
    const { sw, vm, overlay, key, open } = setup();
    open();
    key('keyDown', 'Tab', CTRL);
    key('keyDown', 'Escape', CTRL);
    assert.equal(sw.isOpen, false);
    assert.deepEqual(vm.activated, []);
    assert.equal(overlay.shown, false);
  });

  test('a click on a card switches to that link', () => {
    const { sw, vm, open } = setup();
    open();
    sw.pick(2);
    assert.deepEqual(vm.activated, ['c']);
    assert.equal(sw.isOpen, false);
  });

  test('a click with a bad number, or when it is closed, does nothing', () => {
    const { sw, vm, open } = setup();
    sw.pick(1); // closed
    open();
    sw.pick(99); sw.pick(-1); sw.pick('1'); sw.pick(1.5);
    assert.equal(sw.isOpen, true);
    assert.deepEqual(vm.activated, []);
  });

  test('cancel (a click outside the cards) and losing focus close it without switching', () => {
    const a = setup();
    a.open();
    a.sw.cancel();
    assert.equal(a.sw.isOpen, false);
    assert.deepEqual(a.vm.activated, []);
    a.sw.cancel(); // harmless when already closed
    const b = setup();
    b.open();
    b.sw.onBlur();
    assert.equal(b.sw.isOpen, false);
    assert.equal(b.overlay.shown, false);
    assert.deepEqual(b.vm.activated, []);
  });

  test('while open every key press is used by the switcher, so none reaches the page', () => {
    const { key, open } = setup();
    open();
    assert.equal(key('keyDown', 'x', CTRL), true);
    assert.equal(key('keyDown', 'Tab', CTRL), true);
    assert.equal(key('keyDown', 'F5', CTRL), true);
  });

  test('safety: if the release of Ctrl never arrives, a quiet moment switches anyway', () => {
    const { sw, vm, timers, fire, key, open } = setup({ activeId: 'a' });
    open();
    key('keyDown', 'Tab', CTRL); // -> b
    assert.equal(timers.live.size, 1);
    assert.ok([...timers.live.values()][0].ms >= 1500);
    fire(); // time passes with no key event
    assert.deepEqual(vm.activated, ['b']);
    assert.equal(sw.isOpen, false);
  });

  test('safety timer is restarted by every key event (held Ctrl keeps repeating) and cleared on close', () => {
    const { sw, timers, key, open } = setup();
    open();
    const first = [...timers.live.keys()][0];
    key('keyDown', 'Control', { control: true, isAutoRepeat: true }); // held Ctrl repeats
    assert.equal(timers.live.size, 1);
    assert.notEqual([...timers.live.keys()][0], first);
    assert.equal(sw.isOpen, true);
    key('keyDown', 'Escape', CTRL);
    assert.equal(timers.live.size, 0);
  });

  test('with fewer than two links there is nothing to switch, so it does not open', () => {
    const { sw, overlay, key } = setup({ links: [{ id: 'a', name: 'A', url: '', enabled: true, order: 0, groupId: null }] });
    assert.equal(key('keyDown', 'Tab', CTRL), false);
    assert.equal(sw.isOpen, false);
    assert.equal(overlay.shown, false);
  });

  test('turned off in settings: Ctrl+Tab does nothing', () => {
    const { sw, key } = setup({ enabled: false });
    assert.equal(key('keyDown', 'Tab', CTRL), false);
    assert.equal(sw.isOpen, false);
  });

  test('on by default (an old settings file without the key still has it on)', () => {
    assert.equal(defaultSettings().linkSwitcher, true);
  });

  test('locked app: never opens, and closes if it was open', () => {
    const { sw, key } = setup({ locked: true });
    assert.equal(key('keyDown', 'Tab', CTRL), false);
    assert.equal(sw.isOpen, false);
    const opened = setup();
    opened.open();
    opened.vm.locked = true;
    assert.equal(opened.key('keyDown', 'Tab', CTRL), false);
    assert.equal(opened.sw.isOpen, false);
    assert.equal(opened.overlay.shown, false);
  });
});

describe('sidebar auto-hide (hide until the mouse goes far left)', () => {
  const { SidebarAutoHide, HIDE_DELAY_MS } = require('../src/main/sidebarAutoHide');

  function setup({ enabled = true, sidebarWidth = 240, collapsed = false } = {}) {
    const settings = { autoHideSidebar: enabled };
    const ui = { sidebarWidth, sidebarCollapsed: collapsed };
    const store = { getState: () => ({ settings, ui, links: [] }) };
    const win = {
      focused: true, visible: true, minimized: false,
      isDestroyed: () => false, isVisible: () => win.visible, isMinimized: () => win.minimized, isFocused: () => win.focused,
      getContentBounds: () => ({ x: 100, y: 50, width: 1200, height: 800 }),
    };
    const vm = new ViewManager({ mainWindow: win, store });
    const views = [];
    vm.views.set('A', { setBounds: (b) => views.push(b), webContents: { isDestroyed: () => true } });
    const overlay = {
      created: false, shownWidth: null, hadFocus: false,
      create() { this.created = true; },
      destroy() { this.created = false; this.shownWidth = null; },
      show(w) { this.shownWidth = w; },
      hide() { const f = this.hadFocus; this.shownWidth = null; return f; },
    };
    const cursor = { x: 600, y: 400 };
    const log = { active: [], hidden: 0 };
    let blocked = false;
    const hide = new SidebarAutoHide({
      store, mainWindow: win, viewManager: vm, overlay, getCursor: () => cursor,
      onActiveChange: (on) => log.active.push(on), onHidden: () => { log.hidden++; }, isBlocked: () => blocked,
    });
    let clock = 1000;
    hide.now = () => clock;
    return { hide, vm, win, cursor, overlay, log, views, settings, advance: (ms) => { clock += ms; }, block: (b) => { blocked = b; } };
  }
  const edge = (t) => { t.cursor.x = 102; t.cursor.y = 300; };
  const away = (t) => { t.cursor.x = 100 + 700; t.cursor.y = 300; };

  test('off by default', () => {
    assert.equal(defaultSettings().autoHideSidebar, false);
    assert.equal(defaultSettings().blurSidebar, false);
  });

  test('turning it on gives the pages the whole width and shows nothing yet', () => {
    const t = setup();
    t.hide.sync();
    assert.equal(t.overlay.created, true);
    assert.equal(t.hide.shown, false);
    assert.deepEqual(t.log.active, [true]);
    const last = t.views[t.views.length - 1];
    assert.equal(last.x, 0);
    assert.equal(last.width, 1200);
    t.hide.stop();
  });

  test('turning it off removes the floating sidebar and restores the normal layout', () => {
    const t = setup();
    t.hide.sync();
    t.settings.autoHideSidebar = false;
    t.hide.sync();
    assert.equal(t.overlay.created, false);
    assert.equal(t.hide.timer, null);
    assert.deepEqual(t.log.active, [true, false]);
    const last = t.views[t.views.length - 1];
    assert.equal(last.x, 240);
    assert.equal(last.width, 960);
  });

  test('syncing twice with the same setting does nothing more', () => {
    const t = setup();
    t.hide.sync(); t.hide.sync();
    assert.deepEqual(t.log.active, [true]);
    t.hide.stop();
  });

  test('the far left edge floats the sidebar over the pages without moving them', () => {
    const t = setup();
    t.hide.sync();
    const before = t.views.length;
    t.cursor.x = 130; t.cursor.y = 300; // 30px in: not the edge
    t.hide.tick();
    assert.equal(t.hide.shown, false);
    edge(t);
    t.hide.tick();
    assert.equal(t.hide.shown, true);
    assert.equal(t.overlay.shownWidth, 240);
    assert.equal(t.views.length, before); // pages were not laid out again
    t.hide.stop();
  });

  test('a mouse above or below the window does not show it', () => {
    const t = setup();
    t.hide.sync();
    t.cursor.x = 101; t.cursor.y = 20;
    t.hide.tick();
    assert.equal(t.hide.shown, false);
    t.hide.stop();
  });

  test('it hides again only after the mouse has been away a moment', () => {
    const t = setup();
    t.hide.sync();
    edge(t); t.hide.tick();
    away(t); t.hide.tick(); // starts the wait
    t.advance(HIDE_DELAY_MS - 50); t.hide.tick();
    assert.equal(t.hide.shown, true);
    t.cursor.x = 200; t.hide.tick(); // back over the sidebar: the wait starts over
    away(t); t.hide.tick();
    t.advance(HIDE_DELAY_MS - 50); t.hide.tick();
    assert.equal(t.hide.shown, true);
    t.advance(100); t.hide.tick();
    assert.equal(t.hide.shown, false);
    assert.equal(t.overlay.shownWidth, null);
    t.hide.stop();
  });

  test('hiding gives the keyboard back to the page when the sidebar had it', () => {
    const t = setup();
    t.hide.sync();
    edge(t); t.hide.tick();
    t.overlay.hadFocus = true;
    t.hide.hideNow();
    assert.equal(t.log.hidden, 1);
    t.hide.stop();
  });

  test('a dialog, the lock screen or the Ctrl+Tab switcher hide it and stop it showing', () => {
    const t = setup();
    t.hide.sync();
    edge(t); t.hide.tick();
    t.vm.modalOpen = true; t.hide.tick();
    assert.equal(t.hide.shown, false);
    edge(t); t.hide.tick();
    assert.equal(t.hide.shown, false);
    t.vm.modalOpen = false;
    t.block(true); edge(t); t.hide.tick();
    assert.equal(t.hide.shown, false);
    t.block(false);
    t.vm.locked = true; edge(t); t.hide.tick();
    assert.equal(t.hide.shown, false);
    t.vm.locked = false; edge(t); t.hide.tick();
    assert.equal(t.hide.shown, true);
    t.hide.stop();
  });

  test('it hides when the window loses focus and stays hidden until it is back', () => {
    const t = setup();
    t.hide.sync();
    edge(t); t.hide.tick();
    t.win.focused = false; t.hide.tick();
    assert.equal(t.hide.shown, false);
    edge(t); t.hide.tick();
    assert.equal(t.hide.shown, false);
    t.hide.stop();
  });

  test('the floating width follows the collapse button', () => {
    const t = setup({ collapsed: true });
    t.hide.sync();
    edge(t); t.hide.tick();
    assert.equal(t.overlay.shownWidth, 76);
    t.hide.stop();
  });
});
