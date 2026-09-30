'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { install, freshUserData, stub } = require('./helpers/electronStub');
install();
const { AppLock, MAX_FAILURES, WAIT_MS } = require('../src/main/appLock');
const { ViewManager } = require('../src/main/viewManager');
const { CH } = require('../src/main/constants');
const { defaultLinkFields } = require('../src/main/store');

function makeLock(opts = {}) {
  const clock = { t: 1_000_000 };
  const lock = new AppLock({ now: () => clock.t, ...opts });
  return { lock, clock };
}

describe('AppLock: password storage', () => {
  beforeEach(() => { freshUserData(); });

  test('no password -> never locked, lock() does nothing', () => {
    const { lock } = makeLock();
    assert.equal(lock.hasPassword(), false);
    assert.equal(lock.isLocked(), false);
    assert.equal(lock.lock(), false);
    assert.equal(lock.isLocked(), false);
  });

  test('password must be at least 4 characters', () => {
    const { lock } = makeLock();
    assert.deepEqual(lock.setPassword('123'), { ok: false, error: 'short', min: 4 });
    assert.equal(lock.hasPassword(), false);
    assert.equal(lock.setPassword('1234').ok, true);
  });

  test('only a salted hash is stored, never the password', async () => {
    const { lock } = makeLock();
    lock.setPassword('correct horse');
    await lock._writeChain;
    const raw = fs.readFileSync(path.join(stub.userData, 'lock.json'), 'utf8');
    assert.ok(!raw.includes('correct horse'));
    freshUserData(); // a second lock with the same password gets a different salt + hash
    const two = makeLock().lock;
    two.setPassword('correct horse');
    assert.notEqual(two.data.hash, lock.data.hash);
    assert.notEqual(two.data.salt, lock.data.salt);
  });

  test('a saved password means the next start is locked', async () => {
    const { lock } = makeLock();
    lock.setPassword('secret');
    await lock._writeChain;
    assert.equal(lock.isLocked(), false); // setting it does not lock you out now
    const next = makeLock().lock;
    assert.equal(next.hasPassword(), true);
    assert.equal(next.isLocked(), true);
  });

  test('changing the password needs the current one', () => {
    const { lock } = makeLock();
    lock.setPassword('first1');
    assert.equal(lock.setPassword('second2', 'nope').ok, false);
    assert.equal(lock.setPassword('second2', 'first1').ok, true);
    assert.equal(lock.verify('second2').ok, true);
    assert.equal(lock.verify('first1').ok, false);
  });

  test('removing the lock needs the current password', async () => {
    const { lock } = makeLock();
    lock.setPassword('secret');
    assert.equal(lock.removePassword('bad').ok, false);
    assert.equal(lock.hasPassword(), true);
    assert.equal(lock.removePassword('secret').ok, true);
    assert.equal(lock.hasPassword(), false);
    await lock._writeChain;
    assert.equal(fs.existsSync(path.join(stub.userData, 'lock.json')), false);
  });

  test('corrupt lock.json means no lock, not a crash', () => {
    fs.writeFileSync(path.join(stub.userData, 'lock.json'), '{bad');
    assert.equal(makeLock().lock.hasPassword(), false);
  });
});

describe('AppLock: lock / unlock', () => {
  beforeEach(() => { freshUserData(); });

  test('lock() then unlock() with the right password, events fire', () => {
    const { lock } = makeLock();
    lock.setPassword('secret');
    const seen = [];
    lock.on('locked', () => seen.push('locked'));
    lock.on('unlocked', () => seen.push('unlocked'));
    assert.equal(lock.lock(), true);
    assert.equal(lock.isLocked(), true);
    assert.equal(lock.unlock('wrong').ok, false);
    assert.equal(lock.isLocked(), true);
    assert.equal(lock.unlock('secret').ok, true);
    assert.equal(lock.isLocked(), false);
    assert.deepEqual(seen, ['locked', 'unlocked']);
  });

  test('locking twice fires one event', () => {
    const { lock } = makeLock();
    lock.setPassword('secret');
    let n = 0;
    lock.on('locked', () => { n += 1; });
    lock.lock();
    lock.lock();
    assert.equal(n, 1);
  });

  test('5 wrong tries -> 30 second wait, even the right password is refused during it', () => {
    const { lock, clock } = makeLock();
    lock.setPassword('secret');
    lock.lock();
    for (let i = 0; i < MAX_FAILURES - 1; i += 1) assert.equal(lock.unlock('bad').error, 'wrong');
    const fifth = lock.unlock('bad');
    assert.equal(fifth.error, 'wrong');
    assert.equal(fifth.waitSeconds, WAIT_MS / 1000);
    const blocked = lock.unlock('secret');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, 'wait');
    assert.equal(lock.isLocked(), true);
    clock.t += WAIT_MS + 1000;
    assert.equal(lock.unlock('secret').ok, true);
  });

  test('the wait survives an app restart', async () => {
    const { lock, clock } = makeLock();
    lock.setPassword('secret');
    for (let i = 0; i < MAX_FAILURES; i += 1) lock.verify('bad');
    await lock._writeChain;
    const restarted = new AppLock({ now: () => clock.t });
    assert.ok(restarted.waitSeconds() > 0);
    assert.equal(restarted.unlock('secret').error, 'wait');
  });

  test('a right password resets the failure count', () => {
    const { lock } = makeLock();
    lock.setPassword('secret');
    lock.lock();
    lock.unlock('bad');
    lock.unlock('bad');
    assert.equal(lock.unlock('secret').ok, true);
    lock.lock();
    for (let i = 0; i < MAX_FAILURES - 1; i += 1) lock.unlock('bad');
    assert.equal(lock.unlock('secret').ok, true); // would be blocked if the count had not reset
  });

  test('junk input is treated as a wrong password', () => {
    const { lock } = makeLock();
    lock.setPassword('secret');
    lock.lock();
    assert.equal(lock.unlock(undefined).ok, false);
    assert.equal(lock.unlock({ a: 1 }).ok, false);
    assert.equal(lock.unlock('x'.repeat(5000)).ok, false);
  });
});

describe('AppLock: auto-lock when idle', () => {
  beforeEach(() => { freshUserData(); });

  test('locks once idle time reaches the setting', () => {
    let idle = 0;
    const { lock } = makeLock({ getIdleMinutes: () => 5, idleSeconds: () => idle });
    lock.setPassword('secret');
    idle = 299;
    assert.equal(lock.checkIdle(), false);
    idle = 300;
    assert.equal(lock.checkIdle(), true);
    assert.equal(lock.isLocked(), true);
  });

  test('0 minutes = never; no password = never', () => {
    const { lock } = makeLock({ getIdleMinutes: () => 0, idleSeconds: () => 99999 });
    lock.setPassword('secret');
    assert.equal(lock.checkIdle(), false);
    freshUserData();
    const noPw = makeLock({ getIdleMinutes: () => 5, idleSeconds: () => 99999 }).lock;
    assert.equal(noPw.checkIdle(), false);
  });

  test('junk minutes values are ignored', () => {
    const { lock } = makeLock({ getIdleMinutes: () => 'abc', idleSeconds: () => 99999 });
    lock.setPassword('secret');
    assert.equal(lock.checkIdle(), false);
  });
});

describe('ViewManager while locked', () => {
  function makeVm() {
    const link = { id: 'L1', ...defaultLinkFields(), name: 'L', url: 'https://l.com', keepPlaying: false };
    const store = { getState: () => ({ links: [link], settings: {}, ui: {} }), updateUi() {}, updateLink() {} };
    const children = [];
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { isDevToolsOpened: () => false, closeDevTools() {} },
      contentView: {
        children,
        addChildView: (v) => { if (!children.includes(v)) children.push(v); },
        removeChildView: (v) => { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); },
      },
      getContentBounds: () => ({ width: 800, height: 600 }),
    };
    const vm = new ViewManager({ mainWindow, store });
    return { vm, link, children };
  }

  function fakeView() {
    const calls = { muted: null, devtoolsClosed: false, visible: null };
    return {
      calls,
      setVisible: (v) => { calls.visible = v; },
      setBounds() {},
      webContents: {
        isDestroyed: () => false,
        isDevToolsOpened: () => true,
        closeDevTools: () => { calls.devtoolsClosed = true; },
        setAudioMuted: (m) => { calls.muted = m; },
      },
    };
  }

  test('ensureView and activate refuse to open anything', () => {
    const { vm } = makeVm();
    vm.setLocked(true);
    assert.equal(vm.ensureView('L1'), null);
    assert.equal(vm.activate('L1'), false);
    assert.equal(vm.isLoaded('L1'), false);
    assert.equal(vm.navigate('L1', 'https://x.com'), false);
    assert.equal(vm.reload('L1'), false);
  });

  test('locking detaches the active view, mutes it, closes DevTools, hides popups', () => {
    const { vm, children } = makeVm();
    const v = fakeView();
    vm.views.set('L1', v);
    vm.activeId = 'L1';
    children.push(v);
    const popup = { isDestroyed: () => false, isVisible: () => true, hidden: false, hide() { this.hidden = true; }, show() { this.hidden = false; } };
    stub.windows = [vm.mainWindow, popup];
    const paused = [];
    vm.on('deactivated', (id) => paused.push(id));

    vm.setLocked(true);
    assert.equal(children.includes(v), false);
    assert.equal(v.calls.muted, true);
    assert.equal(v.calls.devtoolsClosed, true);
    assert.equal(popup.hidden, true);
    assert.deepEqual(paused, ['L1']);

    vm.setLocked(false);
    assert.equal(children.includes(v), true);
    assert.equal(v.calls.visible, true);
    assert.equal(popup.hidden, false);
    stub.windows = [];
  });

  test('a keep-playing link stays unmuted while locked', () => {
    const { vm, link } = makeVm();
    link.keepPlaying = true;
    const v = fakeView();
    vm.views.set('L1', v);
    vm.setLocked(true);
    assert.equal(v.calls.muted, null);
  });

  test('kickActiveView does not re-attach a view while locked', () => {
    const { vm, children } = makeVm();
    const v = fakeView();
    vm.views.set('L1', v);
    vm.activeId = 'L1';
    vm.setLocked(true);
    vm.kickActiveView();
    vm.setModalOpen(false); // the shell closing a dialog must not un-hide it either
    assert.equal(children.includes(v), false);
  });
});

describe('IPC gating while locked', () => {
  let lock;
  let ctx;
  const h = (ch) => stub.handlers.get(ch);

  beforeEach(() => {
    freshUserData();
    const { initIpc } = require('../src/main/ipc');
    lock = new AppLock();
    lock.setPassword('secret');
    const emitter = () => Object.assign(new EventEmitter(), { onChange() {}, on: EventEmitter.prototype.on });
    const calls = [];
    ctx = {
      store: {
        getState: () => ({ links: [], groups: [], settings: {}, ui: {}, userscripts: [], commands: [], notes: {} }),
        onChange() {},
        exportJSON: () => '{"exported":true}',
        updateSettings: (p) => { calls.push(['updateSettings', p]); return {}; },
        takePendingToast: () => null,
      },
      viewManager: Object.assign(emitter(), {
        views: new Map(),
        getActiveId: () => null,
        activate: (id) => { calls.push(['activate', id]); return true; },
        setLocked() {},
      }),
      unreadTracker: Object.assign(emitter(), { getAll: () => ({}), clear() {}, clearNotified() {} }),
      indicator: { lastAggregate: null, computeAggregate: () => ({}), apply() {} },
      notifications: {},
      tray: { refreshMenu() {} },
      appLock: lock,
      mainWindow: { isDestroyed: () => true, webContents: { id: 1 } },
      calls,
    };
    initIpc(ctx);
  });

  test('unlocked: requests work', async () => {
    assert.equal(await h(CH.LINK_ACTIVATE)({}, 'L1'), true);
    assert.equal(await h(CH.SETTINGS_EXPORT)({}), await h(CH.SETTINGS_EXPORT)({}));
    assert.ok(await h(CH.SETTINGS_EXPORT)({}));
  });

  test('locked: opening a link, export, import, settings, devtools are all refused', async () => {
    lock.lock();
    for (const [ch, args] of [
      [CH.LINK_ACTIVATE, ['L1']],
      [CH.LINK_RELOAD, ['L1']],
      [CH.LINK_DEVTOOLS, ['L1']],
      [CH.NAV_NAVIGATE, ['https://x.com']],
      [CH.SETTINGS_EXPORT, []],
      [CH.SETTINGS_IMPORT, ['{}']],
      [CH.SETTINGS_UPDATE, [{ theme: 'light' }]],
      [CH.LINK_CREATE, [{}]],
      [CH.LOCK_NOW, []],
      [CH.LOCK_SET, [{ password: 'hacked', current: 'secret' }]],
      [CH.LOCK_REMOVE, ['secret']],
    ]) {
      assert.equal(await h(ch)({}, ...args), null, ch);
    }
    assert.equal(ctx.calls.length, 0);
    assert.equal(lock.verify('secret').ok, true); // password untouched
  });

  test('locked: state, quit, status and unlock still answer', async () => {
    lock.lock();
    assert.equal((await h(CH.APP_GET_STATE)({})).lock.locked, true);
    assert.deepEqual(await h(CH.LOCK_STATUS)({}), lock.status());
    assert.equal((await h(CH.LOCK_UNLOCK)({}, 'bad')).ok, false);
    assert.equal((await h(CH.LOCK_UNLOCK)({}, 'secret')).ok, true);
    assert.equal(await h(CH.LINK_ACTIVATE)({}, 'L1'), true); // works again
  });

  test('set / change / remove through IPC follow the password rules', async () => {
    assert.equal((await h(CH.LOCK_SET)({}, { password: 'newpass', current: 'wrong' })).ok, false);
    assert.equal((await h(CH.LOCK_SET)({}, { password: 'newpass', current: 'secret' })).ok, true);
    assert.equal((await h(CH.LOCK_REMOVE)({}, 'secret')).ok, false);
    assert.equal((await h(CH.LOCK_REMOVE)({}, 'newpass')).ok, true);
    assert.deepEqual(await h(CH.LOCK_NOW)({}), { ok: false, error: 'no-password' });
  });
});
