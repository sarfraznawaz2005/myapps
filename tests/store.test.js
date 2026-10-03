'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { install, freshUserData, stub } = require('./helpers/electronStub');
install();
const { Store, defaultSettings } = require('../src/main/store');
const { STORE_VERSION } = require('../src/main/constants');

describe('Store settings + defaults', () => {
  beforeEach(() => { freshUserData(); });

  test('password manager is OFF by default', () => {
    assert.equal(defaultSettings().passwordManager, false);
    const s = new Store();
    s.load();
    assert.equal(s.getState().settings.passwordManager, false);
  });

  test('an old store.json without new settings gets defaults filled in', () => {
    fs.writeFileSync(path.join(stub.userData, 'store.json'), JSON.stringify({ version: 1, settings: { theme: 'light' }, links: [] }));
    const s = new Store();
    s.load();
    assert.equal(s.getState().settings.theme, 'light');
    assert.equal(s.getState().settings.passwordManager, false);
    assert.equal(s.getState().settings.spellcheck, false);
  });

  test('new links never hibernate on their own (manual policy, keepAwake on)', () => {
    const s = new Store();
    s.load();
    const link = s.createLink({ name: 'A', url: 'https://example.com' });
    assert.equal(link.hibernate.policy, 'manual');
    assert.equal(link.hibernate.keepAwake, true);
    assert.equal(defaultSettings().defaultHibernate, 'manual');
  });

  test('the default hibernation setting applies to new links, unless the caller sets one', () => {
    const s = new Store();
    s.load();
    s.updateSettings({ defaultHibernate: 'idle' });
    assert.equal(s.createLink({ name: 'A', url: 'https://a.com' }).hibernate.policy, 'idle');
    assert.equal(s.createLink({ name: 'B', url: 'https://b.com', hibernate: { policy: 'never' } }).hibernate.policy, 'never');
  });

  test('migration 1 -> 2 makes old idle+keepAwake links manual, leaves deliberate choices alone', () => {
    const base = { url: 'https://x.com', partition: 'persist:link-x' };
    fs.writeFileSync(path.join(stub.userData, 'store.json'), JSON.stringify({
      version: 1,
      links: [
        { ...base, id: 'a', name: 'A', hibernate: { policy: 'idle', minutes: 30, keepAwake: true } },
        { ...base, id: 'b', name: 'B', hibernate: { policy: 'idle', minutes: 10, keepAwake: false } },
        { ...base, id: 'c', name: 'C', hibernate: { policy: 'never', minutes: 30, keepAwake: true } },
      ],
    }));
    const s = new Store();
    s.load();
    const [a, b2, c] = s.getState().links;
    assert.equal(a.hibernate.policy, 'manual');
    assert.equal(a.hibernate.keepAwake, true);
    assert.equal(b2.hibernate.policy, 'idle'); // user turned keepAwake off on purpose
    assert.equal(c.hibernate.policy, 'never');
    assert.equal(s.getState().version, STORE_VERSION); // runs on through every later migration too
  });

  test('migration 2 -> 3 drops the removed hideBlueTicks value and keeps other WhatsApp choices', () => {
    const base = { url: 'https://web.whatsapp.com', partition: 'persist:link-w' };
    fs.writeFileSync(path.join(stub.userData, 'store.json'), JSON.stringify({
      version: 2,
      links: [
        { ...base, id: 'w', name: 'W', whatsapp: { hideBlueTicks: true, blurNames: true, notifyContacts: ['Amy'] } },
        { ...base, id: 'x', name: 'X' },
      ],
    }));
    const s = new Store();
    s.load();
    const [w, x] = s.getState().links;
    assert.equal('hideBlueTicks' in w.whatsapp, false);
    assert.equal(w.whatsapp.blurNames, true);
    assert.deepEqual(w.whatsapp.notifyContacts, ['Amy']);
    assert.equal('hideBlueTicks' in x.whatsapp, false);
    assert.equal(s.getState().version, STORE_VERSION);
  });

  test('updateSettings merges, nested dnd too', () => {
    const s = new Store();
    s.load();
    s.updateSettings({ passwordManager: true, dnd: { enabled: true } });
    assert.equal(s.getState().settings.passwordManager, true);
    assert.equal(s.getState().settings.dnd.enabled, true);
    assert.equal(s.getState().settings.dnd.until, null);
  });
});

describe('Store links, groups, persistence', () => {
  beforeEach(() => { freshUserData(); });

  test('createLink gives each link its own persistent partition', () => {
    const s = new Store();
    s.load();
    const a = s.createLink({ name: 'A', url: 'https://a.com' });
    const b = s.createLink({ name: 'B', url: 'https://b.com' });
    assert.notEqual(a.partition, b.partition);
    assert.match(a.partition, /^persist:link-/);
  });

  test('updateLink can never change id or partition', () => {
    const s = new Store();
    s.load();
    const a = s.createLink({ name: 'A', url: 'https://a.com' });
    const u = s.updateLink(a.id, { id: 'hacked', partition: 'persist:other', name: 'A2' });
    assert.equal(u.id, a.id);
    assert.equal(u.partition, a.partition);
    assert.equal(u.name, 'A2');
  });

  test('deleteGroup keeps its links (moved to ungrouped) unless told to delete them', () => {
    const s = new Store();
    s.load();
    const g = s.createGroup({ name: 'G' });
    const l = s.createLink({ name: 'A', url: 'https://a.com', groupId: g.id });
    s.deleteGroup(g.id);
    assert.equal(s.getState().links.find((x) => x.id === l.id).groupId, null);
  });

  test('saveImmediate writes a file a new Store can read back', async () => {
    const s = new Store();
    s.load();
    s.createLink({ name: 'A', url: 'https://a.com' });
    s.saveImmediate();
    await new Promise((r) => setTimeout(r, 200));
    const s2 = new Store();
    s2.load();
    assert.equal(s2.getState().links.length, 1);
  });

  test('corrupt store.json is set aside and defaults load, with a toast', () => {
    fs.writeFileSync(path.join(stub.userData, 'store.json'), '{oops');
    const s = new Store();
    s.load();
    assert.equal(s.getState().links.length, 0);
    assert.ok(s.takePendingToast());
    assert.ok(fs.readdirSync(stub.userData).some((f) => f.startsWith('store.corrupt-')));
  });
});

describe('Store export / import JSON', () => {
  beforeEach(() => { freshUserData(); });

  test('export -> import round trip keeps links, groups, settings, userscripts, commands, notes', () => {
    const a = new Store();
    a.load();
    const g = a.createGroup({ name: 'G' });
    a.createLink({ name: 'A', url: 'https://a.com', groupId: g.id });
    a.updateSettings({ theme: 'light', passwordManager: true });
    a.createUserscript({ name: 'U', matches: ['https://a.com/*'], code: 'x' });
    a.createCommand({ name: 'C', command: 'echo hi' });
    a.setNote('https://a.com/x', 'hello');
    const json = a.exportJSON();

    freshUserData();
    const b = new Store();
    b.load();
    b.importJSON(json);
    const st = b.getState();
    assert.equal(st.groups.length, 1);
    assert.equal(st.links[0].name, 'A');
    assert.equal(st.links[0].groupId, st.groups[0].id);
    assert.equal(st.settings.theme, 'light');
    assert.equal(st.settings.passwordManager, true);
    assert.equal(st.userscripts.length, 1);
    assert.equal(st.commands.length, 1);
    assert.equal(st.notes['https://a.com/x'].text, 'hello');
  });

  test('import fills in defaults missing from an older export', () => {
    const b = new Store();
    b.load();
    b.importJSON(JSON.stringify({ version: 1, settings: {}, links: [{ id: 'x', name: 'X', url: 'https://x.com', partition: 'persist:link-x' }] }));
    const link = b.getState().links[0];
    assert.equal(link.enabled, true);
    assert.equal(link.navigation.allowLocation, false);
    assert.equal(b.getState().settings.passwordManager, false);
  });

  test('import of invalid JSON throws and leaves current data alone', () => {
    const b = new Store();
    b.load();
    b.createLink({ name: 'Keep', url: 'https://k.com' });
    assert.throws(() => b.importJSON('{bad'));
    assert.equal(b.getState().links.length, 1);
  });

  test('exportJSON never contains saved-login data', () => {
    const b = new Store();
    b.load();
    assert.ok(!('passwordVault' in JSON.parse(b.exportJSON())));
    assert.ok(!('entries' in JSON.parse(b.exportJSON())));
  });
});
