'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { install, freshUserData, stub } = require('./helpers/electronStub');
install();
const pw = require('../src/main/passwords');
const { CH } = require('../src/main/constants');

describe('hostKey', () => {
  test('accepts https, strips www, lowercases', () => {
    assert.equal(pw.hostKey('https://WWW.Example.com/login?x=1'), 'example.com');
  });
  test('accepts http only for localhost', () => {
    assert.equal(pw.hostKey('http://localhost:3000/'), 'localhost');
    assert.equal(pw.hostKey('http://127.0.0.1/'), '127.0.0.1');
    assert.equal(pw.hostKey('http://example.com/'), null);
  });
  test('rejects other schemes and garbage', () => {
    assert.equal(pw.hostKey('file:///etc/passwd'), null);
    assert.equal(pw.hostKey('javascript:alert(1)'), null);
    assert.equal(pw.hostKey('not a url'), null);
    assert.equal(pw.hostKey(''), null);
  });
});

describe('lock / unlock (export file encryption)', () => {
  const payload = { entries: [{ host: 'a.com', username: 'u', password: 'p@ss' }], never: ['b.com'] };

  test('round trip with the right key', () => {
    assert.deepEqual(pw.unlock(pw.lock(payload, 'secret1'), 'secret1'), payload);
  });
  test('wrong key returns null', () => {
    assert.equal(pw.unlock(pw.lock(payload, 'secret1'), 'secret2'), null);
  });
  test('tampered data returns null (auth tag check)', () => {
    const blob = pw.lock(payload, 'secret1');
    const raw = Buffer.from(blob.data, 'base64');
    raw[0] ^= 0xff;
    assert.equal(pw.unlock({ ...blob, data: raw.toString('base64') }, 'secret1'), null);
  });
  test('locked blob never contains the plain password or site', () => {
    const text = JSON.stringify(pw.lock(payload, 'secret1'));
    assert.ok(!text.includes('p@ss'));
    assert.ok(!text.includes('a.com'));
  });
  test('same input locks differently each time (random salt/iv)', () => {
    assert.notEqual(pw.lock(payload, 'secret1').data, pw.lock(payload, 'secret1').data);
  });
  test('unknown version or junk returns null, never throws', () => {
    assert.equal(pw.unlock({ v: 99 }, 'secret1'), null);
    assert.equal(pw.unlock(null, 'secret1'), null);
    assert.equal(pw.unlock({ v: 1, kdf: 'scrypt', salt: 'x', iv: 'x', tag: 'x', data: 'x' }, 'secret1'), null);
  });
});

describe('Vault', () => {
  beforeEach(() => { freshUserData(); });

  test('save + list + get for the same site', () => {
    const v = new pw.Vault();
    v.save('a.com', 'alice', 'pw1');
    v.save('a.com', 'bob', 'pw2');
    assert.deepEqual(v.list('a.com').map((e) => e.username).sort(), ['alice', 'bob']);
    const id = v.list('a.com').find((e) => e.username === 'bob').id;
    assert.deepEqual(v.get(id, 'a.com'), { username: 'bob', password: 'pw2' });
  });

  test('same site + username updates instead of duplicating', () => {
    const v = new pw.Vault();
    v.save('a.com', 'alice', 'old');
    v.save('a.com', 'alice', 'new');
    assert.equal(v.list('a.com').length, 1);
    assert.equal(v.get(v.list('a.com')[0].id, 'a.com').password, 'new');
  });

  test('get() refuses another site login', () => {
    const v = new pw.Vault();
    v.save('a.com', 'alice', 'pw1');
    assert.equal(v.get(v.list('a.com')[0].id, 'evil.com'), null);
  });

  test('list() and listAll() never contain passwords', () => {
    const v = new pw.Vault();
    v.save('a.com', 'alice', 'topsecret');
    assert.ok(!JSON.stringify(v.list('a.com')).includes('topsecret'));
    assert.ok(!JSON.stringify(v.listAll()).includes('topsecret'));
  });

  test('file on disk holds no plain password or key', async () => {
    const v = new pw.Vault();
    v.save('a.com', 'alice', 'topsecret');
    v.setExportKey('mykey123');
    await v._write();
    const raw = fs.readFileSync(path.join(stub.userData, 'passwords.json'), 'utf8');
    assert.ok(!raw.includes('topsecret'));
    assert.ok(!raw.includes('mykey123'));
  });

  test('data survives a restart (new Vault reads the file)', async () => {
    const v = new pw.Vault();
    v.save('a.com', 'alice', 'pw1');
    v.addNever('n.com');
    v.setExportKey('mykey123');
    await v._write();
    const v2 = new pw.Vault();
    assert.equal(v2.get(v2.list('a.com')[0].id, 'a.com').password, 'pw1');
    assert.ok(v2.isNever('n.com'));
    assert.equal(v2.getExportKey(), 'mykey123');
  });

  test('save fails cleanly when Windows encryption is unavailable', () => {
    const v = new pw.Vault();
    stub.encryptionAvailable = false;
    assert.equal(v.save('a.com', 'alice', 'pw1'), false);
    assert.equal(v.list('a.com').length, 0);
  });

  test('remove, clearAll, never add/remove', () => {
    const v = new pw.Vault();
    v.save('a.com', 'alice', 'pw1');
    v.save('b.com', 'bob', 'pw2');
    v.remove(v.list('a.com')[0].id);
    assert.equal(v.list('a.com').length, 0);
    v.addNever('x.com');
    v.addNever('x.com');
    assert.equal(v.data.never.length, 1);
    v.removeNever('x.com');
    assert.equal(v.isNever('x.com'), false);
    v.clearAll();
    assert.equal(v.listAll().length, 0);
  });

  test('corrupt passwords.json starts empty instead of crashing', () => {
    fs.writeFileSync(path.join(stub.userData, 'passwords.json'), '{not json');
    const v = new pw.Vault();
    assert.equal(v.listAll().length, 0);
  });
});

describe('export / import flow', () => {
  beforeEach(() => { freshUserData(); });

  const storeJson = JSON.stringify({ version: 1, settings: { theme: 'dark' }, links: [], groups: [] });
  const apiFor = (v) => ({
    exportLocked: () => v.exportLocked(),
    // Same rules as init().unlockImport, over a given vault.
    unlockImport(blob, typed) {
      if (!blob) return { ok: true, payload: null };
      const key = typed || v.getExportKey();
      if (!key) return { error: 'need-key' };
      const payload = pw.unlock(blob, key);
      return payload ? { ok: true, payload } : { error: 'bad-key' };
    },
  });

  test('no Export Key -> export has no passwordVault', () => {
    const v = new pw.Vault();
    v.save('a.com', 'alice', 'pw1');
    assert.equal(JSON.parse(pw.buildExport(storeJson, apiFor(v))).passwordVault, undefined);
  });

  test('Export Key set but no logins -> no passwordVault', () => {
    const v = new pw.Vault();
    v.setExportKey('mykey123');
    assert.equal(JSON.parse(pw.buildExport(storeJson, apiFor(v))).passwordVault, undefined);
  });

  test('Export Key set -> logins in the file, locked; other data kept', () => {
    const v = new pw.Vault();
    v.save('a.com', 'alice', 'topsecret');
    v.setExportKey('mykey123');
    const text = pw.buildExport(storeJson, apiFor(v));
    assert.ok(!text.includes('topsecret'));
    assert.ok(!text.includes('mykey123'));
    const out = JSON.parse(text);
    assert.equal(out.settings.theme, 'dark');
    assert.ok(out.passwordVault);
  });

  test('round trip: export on PC A, import on PC B with typed key', () => {
    freshUserData();
    const a = new pw.Vault();
    a.save('a.com', 'alice', 'pw-alice');
    a.save('a.com', 'bob', 'pw-bob');
    a.addNever('never.com');
    a.setExportKey('mykey123');
    const exported = pw.buildExport(storeJson, apiFor(a));

    freshUserData(); // PC B: empty, no key saved
    const b = new pw.Vault();
    assert.deepEqual(pw.prepareImport(exported, undefined, apiFor(b)), { error: 'need-key' });
    assert.deepEqual(pw.prepareImport(exported, 'wrongkey', apiFor(b)), { error: 'bad-key' });
    const ok = pw.prepareImport(exported, 'mykey123', apiFor(b));
    assert.ok(!ok.error);
    assert.equal(JSON.parse(ok.json).passwordVault, undefined); // never reaches store.json
    b.mergeImported(ok.payload);
    const rows = b.list('a.com');
    assert.deepEqual(rows.map((e) => e.username).sort(), ['alice', 'bob']);
    assert.equal(b.get(rows.find((e) => e.username === 'alice').id, 'a.com').password, 'pw-alice');
    assert.ok(b.isNever('never.com'));
  });

  test('import with the key already saved needs no typing', () => {
    const a = new pw.Vault();
    a.save('a.com', 'alice', 'pw1');
    a.setExportKey('mykey123');
    const exported = pw.buildExport(storeJson, apiFor(a));
    assert.ok(!pw.prepareImport(exported, undefined, apiFor(a)).error);
  });

  test('file without logins imports with no key', () => {
    const v = new pw.Vault();
    const r = pw.prepareImport(storeJson, undefined, apiFor(v));
    assert.equal(r.error, undefined);
    assert.equal(r.payload, null);
  });

  test('mergeImported keeps existing logins, updates same site+username, skips junk rows', () => {
    const v = new pw.Vault();
    v.save('a.com', 'alice', 'old');
    v.save('keep.com', 'kim', 'kimpw');
    v.mergeImported({
      entries: [
        { host: 'a.com', username: 'alice', password: 'new' },
        { host: 'c.com', username: 'cat', password: 'catpw' },
        { host: 5, username: 'x', password: 'y' },
        { host: 'd.com' },
      ],
      never: ['n.com', 42],
    });
    assert.equal(v.get(v.list('a.com')[0].id, 'a.com').password, 'new');
    assert.equal(v.list('keep.com').length, 1);
    assert.equal(v.list('c.com').length, 1);
    assert.equal(v.listAll().length, 3);
    assert.deepEqual(v.data.never, ['n.com']);
  });

  test('init().unlockImport reports "unavailable" when Windows encryption is off', () => {
    const api = pw.init({ store: { getState: () => ({ settings: {} }) }, mainWindow: null });
    stub.encryptionAvailable = false;
    assert.deepEqual(api.unlockImport({ v: 1 }, 'mykey123'), { error: 'unavailable' });
  });

  test('init().unlockImport: need-key, bad-key, good key', () => {
    const api = pw.init({ store: { getState: () => ({ settings: {} }) }, mainWindow: null });
    const blob = pw.lock({ entries: [], never: [] }, 'mykey123');
    assert.deepEqual(api.unlockImport(blob, ''), { error: 'need-key' });
    assert.deepEqual(api.unlockImport(blob, 'nope123'), { error: 'bad-key' });
    assert.ok(api.unlockImport(blob, 'mykey123').ok);
  });
});

describe('IPC handlers (security)', () => {
  let settings;
  let shellWC;
  const h = (ch) => stub.handlers.get(ch);
  const page = (url = 'https://example.com/login', id = 7) => ({ sender: { id }, senderFrame: { url } });
  const shell = () => ({ sender: shellWC });

  beforeEach(() => {
    freshUserData();
    settings = { passwordManager: true };
    shellWC = { id: 1 };
    pw.init({
      store: { getState: () => ({ settings }) },
      mainWindow: { isDestroyed: () => false, webContents: shellWC },
    });
  });

  async function saveLogin(url, user, pass, id = 7) {
    await h(CH.PM_CAPTURE)(page(url, id), { username: user, password: pass });
    await h(CH.PM_PENDING_TAKE)(page(url, id));
    return h(CH.PM_PENDING_COMMIT)(page(url, id));
  }

  test('capture -> take -> commit saves; take never returns the password', async () => {
    await h(CH.PM_CAPTURE)(page(), { username: 'alice', password: 'topsecret' });
    const info = await h(CH.PM_PENDING_TAKE)(page());
    assert.deepEqual(info, { host: 'example.com', username: 'alice', update: false });
    assert.ok(!JSON.stringify(info).includes('topsecret'));
    assert.equal(await h(CH.PM_PENDING_COMMIT)(page()), true);
    const list = await h(CH.PM_LIST)(page());
    assert.deepEqual(list.map((e) => e.username), ['alice']);
    assert.ok(!JSON.stringify(list).includes('topsecret'));
  });

  test('feature OFF: nothing lists, fills or captures', async () => {
    await saveLogin('https://example.com/', 'alice', 'pw1');
    const id = (await h(CH.PM_MANAGE_LIST)(shell())).entries[0].id;
    settings.passwordManager = false;
    assert.deepEqual(await h(CH.PM_LIST)(page()), []);
    assert.equal(await h(CH.PM_FILL)(page(), id), null);
    assert.equal(await h(CH.PM_CAPTURE)(page(), { username: 'x', password: 'y' }), false);
  });

  test('fill only works for the frame own site', async () => {
    await saveLogin('https://example.com/', 'alice', 'pw1');
    const id = (await h(CH.PM_MANAGE_LIST)(shell())).entries[0].id;
    assert.equal(await h(CH.PM_FILL)(page('https://evil.com/'), id), null);
    assert.deepEqual(await h(CH.PM_LIST)(page('https://evil.com/')), []);
    assert.deepEqual(await h(CH.PM_FILL)(page('https://www.example.com/x'), id), { username: 'alice', password: 'pw1' });
  });

  test('http (non-localhost) pages get nothing', async () => {
    assert.deepEqual(await h(CH.PM_LIST)(page('http://example.com/')), []);
    assert.equal(await h(CH.PM_CAPTURE)(page('http://example.com/'), { username: 'a', password: 'b' }), false);
  });

  test('page handlers reject calls from the app shell window', async () => {
    assert.deepEqual(await h(CH.PM_LIST)({ sender: shellWC, senderFrame: { url: 'https://example.com/' } }), []);
  });

  test('shell handlers reject calls from web pages', async () => {
    await saveLogin('https://example.com/', 'alice', 'pw1');
    assert.equal(await h(CH.PM_MANAGE_LIST)(page()), null);
    assert.equal(await h(CH.PM_CLEAR_ALL)(page()), false);
    assert.equal(await h(CH.PM_DELETE)(page(), 'x'), false);
    assert.deepEqual(await h(CH.PM_KEY_SET)(page(), 'mykey123'), { ok: false, error: 'bad-request' });
    assert.equal(await h(CH.PM_KEY_CLEAR)(page()), false);
    assert.equal((await h(CH.PM_MANAGE_LIST)(shell())).entries.length, 1);
  });

  test('Never for this site blocks later captures until allowed again', async () => {
    await h(CH.PM_CAPTURE)(page(), { username: 'alice', password: 'pw1' });
    await h(CH.PM_PENDING_TAKE)(page());
    await h(CH.PM_PENDING_DISCARD)(page(), true);
    assert.equal(await h(CH.PM_CAPTURE)(page(), { username: 'alice', password: 'pw1' }), false);
    assert.deepEqual((await h(CH.PM_MANAGE_LIST)(shell())).never, ['example.com']);
    await h(CH.PM_UNNEVER)(shell(), 'example.com');
    assert.equal(await h(CH.PM_CAPTURE)(page(), { username: 'alice', password: 'pw1' }), true);
  });

  test('same login again is not offered; changed password is offered as update', async () => {
    await saveLogin('https://example.com/', 'alice', 'pw1');
    await h(CH.PM_CAPTURE)(page(), { username: 'alice', password: 'pw1' });
    assert.equal(await h(CH.PM_PENDING_TAKE)(page()), null);
    await h(CH.PM_CAPTURE)(page(), { username: 'alice', password: 'pw2' });
    assert.deepEqual(await h(CH.PM_PENDING_TAKE)(page()), { host: 'example.com', username: 'alice', update: true });
  });

  test('commit before the prompt was shown does nothing', async () => {
    await h(CH.PM_CAPTURE)(page(), { username: 'alice', password: 'pw1' });
    assert.equal(await h(CH.PM_PENDING_COMMIT)(page()), false);
    assert.deepEqual(await h(CH.PM_LIST)(page()), []);
  });

  test('pending logins are per tab', async () => {
    await h(CH.PM_CAPTURE)(page('https://example.com/', 1), { username: 'alice', password: 'pw1' });
    assert.equal(await h(CH.PM_PENDING_TAKE)(page('https://example.com/', 2)), null);
  });

  test('two-step login: username step is remembered for the password step', async () => {
    await h(CH.PM_CAPTURE)(page(), { username: 'alice', password: '' });
    await h(CH.PM_CAPTURE)(page(), { username: '', password: 'pw1' });
    assert.equal((await h(CH.PM_PENDING_TAKE)(page())).username, 'alice');
  });

  test('bad input is rejected', async () => {
    assert.equal(await h(CH.PM_CAPTURE)(page(), null), false);
    assert.equal(await h(CH.PM_CAPTURE)(page(), { username: 5, password: 'x' }), false);
    assert.equal(await h(CH.PM_CAPTURE)(page(), { username: 'a', password: 'x'.repeat(5000) }), false);
    assert.equal(await h(CH.PM_CAPTURE)(page(), { username: '', password: 'pw' }), false); // no username known
    assert.equal(await h(CH.PM_FILL)(page(), { evil: 1 }), null);
  });

  test('Export Key: min 6 chars, saved, status shown, never echoed, removable', async () => {
    assert.match((await h(CH.PM_KEY_SET)(shell(), '12345')).error, /at least 6/);
    assert.deepEqual(await h(CH.PM_KEY_SET)(shell(), '123456'), { ok: true });
    const info = await h(CH.PM_MANAGE_LIST)(shell());
    assert.equal(info.hasExportKey, true);
    assert.ok(!JSON.stringify(info).includes('123456'));
    await h(CH.PM_KEY_CLEAR)(shell());
    assert.equal((await h(CH.PM_MANAGE_LIST)(shell())).hasExportKey, false);
  });

  test('Export Key cannot be saved when Windows encryption is unavailable', async () => {
    stub.encryptionAvailable = false;
    assert.equal((await h(CH.PM_KEY_SET)(shell(), 'mykey123')).ok, false);
  });
});
