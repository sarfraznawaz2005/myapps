// DISPOSABLE: runs preload/whatsapp-main-world.js against a FAKE WhatsApp
// (fake window.require + fake modules/stores). Delete after use.
// Run: .\node_modules\electron\dist\electron.exe scripts\wa-smoke.js   -> writes scripts/wa-smoke.out.txt
const fs = require('fs'); const path = require('path');
const { app, BrowserWindow } = require('electron');
app.on('window-all-closed', () => {});
const out = [];
const check = (ok, msg) => out.push((ok ? 'PASS ' : 'FAIL ') + msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FAKE = `
  window.calls = { avail: 0, unavail: 0, seen: 0, statusRead: 0, notify: [], saved: [] };
  function Handlers(){ this.h = {}; }
  Handlers.prototype.on = function(e, f){ (this.h[e] = this.h[e] || []).push(f); };
  Handlers.prototype.off = function(e, f){ this.h[e] = (this.h[e]||[]).filter(function(x){ return x !== f; }); };
  Handlers.prototype.emit = function(e, a){ (this.h[e]||[]).forEach(function(f){ f(a); }); };
  var Msg = new Handlers();
  var presModel = { isOnline: false, subscribe: function(){ window.calls.subscribed = true; } };
  var Presence = { get: function(id){ return id === '15551234567@c.us' ? presModel : null; } };
  var Contact = { getModelsArray: function(){ return [{ name: 'Alice Smith', id: { _serialized: '15551234567@c.us' } }]; },
                  get: function(){ return { name: 'Alice Smith' }; } };
  var presenceFns = { sendPresenceAvailable: function(){ window.calls.avail++; return Promise.resolve(); },
                      sendPresenceUnavailable: function(){ window.calls.unavail++; return Promise.resolve(); } };
  var seenFns = { sendConversationSeen: function(){ window.calls.seen++; return Promise.resolve(); } };
  function StatusV3Model(){} StatusV3Model.prototype.sendReadStatus = function(){ window.calls.statusRead++; };
  var mods = {
    'WAWebChatPresenceBridge': presenceFns,
    'WAWebSendSeenBridge': seenFns,
    'WAWebContactStatusBridge': { sendReadStatus: function(){ window.calls.statusBridge = (window.calls.statusBridge||0)+1; } },
    'WAWebStatusV3Model': { default: StatusV3Model },
    'WAWebCollections': { Msg: Msg, Presence: Presence, Contact: Contact },
    'WAWebUnrelated': { nothing: true }
  };
  window.__fake = { Msg: Msg, presModel: presModel, presenceFns: presenceFns, seenFns: seenFns, StatusV3Model: StatusV3Model, mods: mods };
  window.require = function(name){
    if (name === '__debug') return { modulesMap: mods };
    if (mods[name]) return mods[name];
    throw new Error('no module ' + name);
  };
  var cfgCb = null;
  window.__myapps = {
    initialConfig: { whatsapp: {} },
    notify: function(p){ window.calls.notify.push(p); },
    setWhatsappStatus: function(s){ window.calls.status = s; },
    onConfigUpdate: function(cb){ cfgCb = cb; }
  };
  window.__setCfg = function(w){ cfgCb({ whatsapp: w }); }; 0;
`;

process.on('unhandledRejection', (e) => { fs.writeFileSync(path.join(__dirname, 'wa-smoke.out.txt'), out.join('\n') + '\nERROR ' + (e && e.stack || e)); app.exit(1); });
app.whenReady().then(async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'preload', 'whatsapp-main-world.js'), 'utf8');
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<body><div id=main><div data-id="false_1@c.us_AAA">msg</div></div></body>');
  const run = (c) => win.webContents.executeJavaScript(c);
  await run(FAKE);
  await run(src);
  await sleep(300);

  // blur
  await run(`__setCfg({ blurNames: true })`);
  check(await run(`!!document.getElementById('__myapps-wa-blur') && document.getElementById('__myapps-wa-blur').textContent.includes('cell-frame-title')`), 'blurNames adds blur CSS');
  // A chat row shaped like the real one (locked chats list, captured from WhatsApp Web)
  const ROW = '<div role=listitem data-testid=list-item-0><div role=button data-testid=cell-frame-container>' +
    '<div><div id=avatar><div><div><span><svg><path></path></svg></span></div></div></div>' +
    '<div><div><div><span><div><div><span id=name dir=auto title=Bob>Bob</span></div></div></span></div>' +
    '<div><div><span><span id=time>Wednesday</span></span></div></div></div>' +
    '<div><div><div data-testid=chat_cell_secondary_text id=preview><span data-testid=last-msg-status title=x><span><img id=tick></span><span dir=ltr>Hm</span></span></div></div>' +
    '<div><div><span></span><button data-testid=open-chat-context-menu id=menu><span><svg></svg></span></button></div></div></div></div></div></div></div>';
  await win.loadURL('data:text/html,<body>' + ROW + '</body>');
  await run(FAKE + '; 0;');
  await run(src);
  await run(`__setCfg({ blurNames: true, blurPhotos: true, blurRecent: true })`);
  await sleep(200);
  const f = (id) => run(`getComputedStyle(document.getElementById('${id}')).filter`);
  check((await f('name')).includes('blur'), 'chat row: name is blurred');
  check((await f('avatar')).includes('blur'), 'chat row: avatar column is blurred');
  check((await f('preview')).includes('blur'), 'chat row: last message preview is blurred');
  check((await f('time')) === 'none' && (await f('menu')) === 'none', 'chat row: time and the menu button stay clear');
  // real hover on a chat row clears name, avatar and preview together
  const win4 = new BrowserWindow({ show: true, x: 0, y: 0, width: 500, height: 300, focusable: false });
  await win4.loadURL('data:text/html,<body style="margin:0">' + '<div id=pane-side>' + ROW.replace('<div><div id=avatar>', '<div style="height:90px"><div id=avatar>').replace('id=name dir=auto', 'id=name data-testid=cell-frame-title dir=auto') + '</div>' + '</body>');
  const run4 = (c) => win4.webContents.executeJavaScript(c);
  await run4(FAKE + '; 0;');
  await run4(src);
  await run4(`__setCfg({ blurNames: true, blurPhotos: true, blurRecent: true })`);
  await sleep(300);
  const f4 = (id) => run4(`getComputedStyle(document.getElementById('${id}')).filter`);
  const before4 = [await f4('name'), await f4('avatar'), await f4('preview')].every((v) => v.includes('blur'));
  win4.webContents.sendInputEvent({ type: 'mouseMove', x: 450, y: 60 }); // on the row, far from every blurred part
  await sleep(600);
  const after4 = [await f4('name'), await f4('avatar'), await f4('preview')];
  check(before4 && after4.every((v) => v === 'none'), 'hovering a chat row clears name, avatar and preview together: ' + after4.join(' / '));
  win4.destroy();
  await win.loadURL('data:text/html,<body><div id=main><div role="row" data-id="false_1@c.us_AAA">msg</div></div></body>');
  await run(FAKE + '; 0;');
  await run(src);
  await run(`__setCfg({ blurNames: true })`);
  check(await run(`!document.getElementById('__myapps-wa-blur').textContent.includes('img')`), 'only the chosen blur group is added');
  await run(`__setCfg({ blurNames: false })`);
  check(await run(`!document.getElementById('__myapps-wa-blur')`), 'turning blur off removes the CSS');

  // message blur: hovering the row clears message AND time together (real hover in Chromium)
  const win3 = new BrowserWindow({ show: true, x: 0, y: 0, width: 500, height: 300, focusable: false });
  await win3.loadURL('data:text/html,<body style="margin:0"><div id=main><div role="row" data-id="x" style="height:80px"><div class="message-in" style="height:30px;width:100px"><span class="copyable-text">hello</span></div><span id="time" class="copyable-text" style="display:block;height:20px;width:60px">11:21</span></div></div></body>');
  const run3 = (c) => win3.webContents.executeJavaScript(c);
  await run3(FAKE + '; 0;');
  await run3(src);
  await run3(`__setCfg({ blurMessages: true })`);
  await sleep(300);
  const filt = (q) => run3(`getComputedStyle(document.querySelector('${q}')).filter`);
  check((await filt('.message-in')).includes('blur'), 'message is blurred before hover');
  win3.webContents.sendInputEvent({ type: 'mouseMove', x: 300, y: 70 }); // on the row, far from the message and the time
  await sleep(600);
  check((await filt('.message-in')) === 'none' && (await filt('#time')) === 'none', 'hovering the row clears message and time together: ' + await filt('.message-in') + ' / ' + await filt('#time'));
  win3.destroy();

  // hide online
  await run(`__setCfg({ hideOnline: true })`);
  await run(`__fake.presenceFns.sendPresenceAvailable()`);
  check(await run(`window.calls.avail === 0 && window.calls.unavail >= 1`), 'hideOnline stops "available" and sends "unavailable": ' + await run(`JSON.stringify(window.calls)`));
  await run(`__setCfg({ hideOnline: false })`);
  const before = await run(`window.calls.avail`);
  check(await run(`window.calls.avail >= 1`) && before >= 1, 'turning it off restores the original function (and announces again)');

  // blue ticks
  await run(`__setCfg({ hideBlueTicks: true })`);
  await run(`__fake.seenFns.sendConversationSeen()`);
  check(await run(`window.calls.seen === 0`), 'hideBlueTicks blocks sendConversationSeen');
  await run(`__setCfg({ hideBlueTicks: false })`);
  await run(`__fake.seenFns.sendConversationSeen()`);
  check(await run(`window.calls.seen === 1`), 'blue ticks restored when off');

  // status
  await run(`__setCfg({ viewStatusPrivately: true })`);
  await run(`new __fake.StatusV3Model().sendReadStatus(); require('WAWebContactStatusBridge').sendReadStatus()`);
  check(await run(`window.calls.statusRead === 0 && !window.calls.statusBridge`), 'viewStatusPrivately blocks sendReadStatus (bridge module and model)');
  await run(`__setCfg({ viewStatusPrivately: false })`);
  await run(`new __fake.StatusV3Model().sendReadStatus(); require('WAWebContactStatusBridge').sendReadStatus()`);
  check(await run(`window.calls.statusRead === 1 && window.calls.statusBridge === 1`), 'status read restored when off');

  // restore deleted
  await run(`__setCfg({ restoreDeleted: true })`);
  await run(`__fake.Msg.emit('add', { id: { _serialized: 'false_1@c.us_AAA', fromMe: false }, type: 'chat', body: 'my <b>secret</b>' })`);
  await run(`__fake.Msg.emit('change', { id: { _serialized: 'false_1@c.us_AAA', fromMe: false }, type: 'revoked' })`);
  await sleep(700);
  check(await run(`(document.querySelector('.__myapps-restored div:last-child')||{}).textContent === 'my <b>secret</b>'`), 'deleted message text is restored as plain text');
  check(await run(`document.querySelector('.__myapps-restored b') === null`), 'restored text is never treated as HTML');
  await run(`__setCfg({ restoreDeleted: false })`);
  check(await run(`document.querySelector('.__myapps-restored') === null`), 'turning restore off removes the notes');

  // notify online
  await run(`__setCfg({ notifyOnline: true, notifyContacts: ['alice'] })`);
  await sleep(300);
  await run(`__fake.presModel.isOnline = true`);
  await sleep(5600);
  check(await run(`window.calls.notify.length === 1 && window.calls.notify[0].title === 'Alice Smith is online'`), 'notify when a picked contact (by name) goes online: ' + await run(`JSON.stringify(window.calls.notify.map(n=>n.title))`));
  check(await run(`window.calls.subscribed === true`), 'subscribed to that contact\'s presence');
  await sleep(5600);
  check(await run(`window.calls.notify.length === 1`), 'no repeat notification while still online');
  await run(`__setCfg({ notifyOnline: false })`);

  // missing modules: a fresh page where WhatsApp has no presence module at all
  const win2 = new BrowserWindow({ show: false });
  await win2.loadURL('data:text/html,<body></body>');
  const run2 = (c) => win2.webContents.executeJavaScript(c);
  await run2(FAKE + `; delete __fake.mods.WAWebChatPresenceBridge; 0;`);
  await run2(src);
  await run2(`window.__fakeErr = null; try { __setCfg({ hideOnline: true }); } catch (e) { window.__fakeErr = String(e); } 0;`);
  await sleep(300);
  check(await run2(`window.__fakeErr === null`), 'a missing WhatsApp module does not throw');
  check(await run2(`!!window.calls.status && window.calls.status.hideOnline === 'missing'`), 'the app is told which option could not attach: ' + await run2(`JSON.stringify(window.calls.status)`));

  fs.writeFileSync(path.join(__dirname, 'wa-smoke.out.txt'), out.join('\n'));
  app.exit(0);
});
