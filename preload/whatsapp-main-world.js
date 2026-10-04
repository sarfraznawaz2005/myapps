// Executed in the main world of web.whatsapp.com only (top frame), right after
// inject-main-world.js. Relies on window.__myapps from link-preload.js.
//
// Per-link WhatsApp extras. They are switched on from the toolbar button of
// the My Apps window (dialog-whatsapp.js), not from inside the page. Settings
// live on the link (link.whatsapp), so a standard and a business WhatsApp link
// each keep their own; they reach this script as config.whatsapp and as
// config updates. This script reports back which features could attach.
//
// Two kinds of feature:
//  - CSS only: the four "blur" options.
//  - Hooks into WhatsApp's own modules (found through window.require, the
//    loader WhatsApp Web itself uses): hide online status,
//    view statuses privately, restore deleted messages, online notifications.
//    WhatsApp renames its internals now and then, so each hook is looked up
//    by shape, can fail on its own, and the panel says so when it does.
(function () {
  if (window.__myappsWhatsapp) return;
  window.__myappsWhatsapp = true;

  var bridge = window.__myapps;
  if (!bridge) return;

  var BOOL_KEYS = ['blurNames', 'blurPhotos', 'blurMessages', 'blurRecent', 'hideOnline',
    'viewStatusPrivately', 'restoreDeleted', 'notifyOnline', 'resizableSidebar'];

  var settings = normalize((bridge.initialConfig || {}).whatsapp);
  var status = {}; // feature key -> 'ok' | 'missing'
  var lastStatusSignature = null;

  function normalize(s) {
    s = s || {};
    var out = { notifyContacts: Array.isArray(s.notifyContacts) ? s.notifyContacts.slice() : [] };
    BOOL_KEYS.forEach(function (k) { out[k] = !!s[k]; });
    out.sidebarWidth = typeof s.sidebarWidth === 'number' && s.sidebarWidth > 0 ? Math.round(s.sidebarWidth) : 0; // 0 = WhatsApp's own width
    return out;
  }

  // ---------------------------------------------------------------------
  // Blur (CSS only). Selectors are the least-stable part: WhatsApp changes
  // its markup. They are kept together here so they are easy to adjust.
  // Blurred text/photos clear while the pointer is over them.
  // ---------------------------------------------------------------------
  // A chat-list row. Hovering the row clears everything blurred inside it
  // (name, photo, last message) together, like a message row below.
  // Every chat-list selector below must start with CHAT_ROW (and none may use
  // an #id): an id outranks the row-hover rule, so that part would stay blurred.
  var CHAT_ROW = '[data-testid="cell-frame-container"]';

  var BLUR_SELECTORS = {
    blurNames: [
      // Chat list rows (normal list and Locked chats use the same row markup).
      CHAT_ROW + ' span[dir="auto"][title]',
      CHAT_ROW + ' [data-testid="cell-frame-title"]',
      '#main header [data-testid="conversation-info-header-chat-title"]',
      '#main header span[dir="auto"][title]',
      '#main [data-testid="author"]'
    ],
    blurPhotos: [
      // The avatar is the first column of a chat row (an <img>, or a default-user svg).
      CHAT_ROW + ' > div > div:first-child',
      '#main header img',
      '[data-testid="chatlist-header"] img',
      '[data-icon="default-user"]',
      '[data-icon="default-group"]'
    ],
    // A message and its time are separate elements. Hovering anywhere on the
    // message ROW clears all of them together (not each piece on its own).
    blurMessages: {
      rows: ['#main [role="row"]', '#main [data-id]'],
      targets: [
        '[data-testid="msg-container"]',
        '.message-in',
        '.message-out',
        '.copyable-text'
      ]
    },
    blurRecent: [
      CHAT_ROW + ' [data-testid="chat_cell_secondary_text"]',
      CHAT_ROW + ' [data-testid="cell-frame-secondary"]'
    ]
  };

  var blurStyle = null;
  function applyBlur() {
    var css = '';
    Object.keys(BLUR_SELECTORS).forEach(function (key) {
      if (!settings[key]) return;
      var group = BLUR_SELECTORS[key];
      if (Array.isArray(group)) {
        group.forEach(function (sel) {
          css += sel + '{filter:blur(5px)!important;transition:filter .15s;}' +
            sel + ':hover{filter:none!important;}';
          if (sel.indexOf(CHAT_ROW) === 0) {
            css += CHAT_ROW + ':hover' + sel.slice(CHAT_ROW.length) + '{filter:none!important;}';
          }
        });
        return;
      }
      group.rows.forEach(function (row) {
        group.targets.forEach(function (target) {
          css += row + ' ' + target + '{filter:blur(5px)!important;transition:filter .15s;}' +
            row + ':hover ' + target + '{filter:none!important;}';
        });
      });
    });
    if (!css) {
      if (blurStyle && blurStyle.parentNode) blurStyle.parentNode.removeChild(blurStyle);
      blurStyle = null;
      return;
    }
    if (!blurStyle) {
      blurStyle = document.createElement('style');
      blurStyle.id = '__myapps-wa-blur';
    }
    blurStyle.textContent = css;
    var parent = document.head || document.documentElement;
    if (blurStyle.parentNode !== parent) parent.appendChild(blurStyle);
  }

  // ---------------------------------------------------------------------
  // Resizable sidebar (CSS + a drag handle). The chat list sits in a box that
  // WhatsApp sizes itself (a share of the window). That box is the parent of
  // #side; the panels that open over it are [data-testid="drawer-left"]. Once the user drags, the chosen width is applied by a style rule
  // and saved on the link. Double-click the handle to go back to WhatsApp's width.
  // ---------------------------------------------------------------------
  var SIDEBAR_MIN = 240;
  var CHAT_MIN = 360; // room always left for the open chat
  var sidebarStyle = null;
  var sidebarHandle = null;
  var sidebarTimer = null;
  var sidebarDragging = false;

  function sidebarBox() {
    var side = document.getElementById('side');
    return side && side.parentElement;
  }
  function sidebarMax(box) {
    var parent = box.parentElement;
    var left = box.getBoundingClientRect().left - (parent ? parent.getBoundingClientRect().left : 0);
    return Math.max(SIDEBAR_MIN, (parent ? parent.getBoundingClientRect().width : window.innerWidth) - left - CHAT_MIN);
  }
  function clampSidebar(box, w) {
    return Math.round(Math.min(Math.max(w, SIDEBAR_MIN), sidebarMax(box)));
  }
  function setSidebarRule(width) {
    if (!width) {
      if (sidebarStyle && sidebarStyle.parentNode) sidebarStyle.parentNode.removeChild(sidebarStyle);
      sidebarStyle = null;
      return;
    }
    if (!sidebarStyle) {
      sidebarStyle = document.createElement('style');
      sidebarStyle.id = '__myapps-wa-sidebar';
    }
    // min() keeps the chat usable when the window is made smaller later.
    // The chat list box, and the panel that slides over it (Locked chats, Archived, Settings...)
    // so both have the same width. That panel also draws the thin line next to the chat.
    sidebarStyle.textContent = 'div:has(> #side),[data-testid="drawer-left"]{flex:0 0 min(' + width + 'px,calc(100vw - 424px))!important;' +
      'width:min(' + width + 'px,calc(100vw - 424px))!important;max-width:none!important;min-width:0!important;}';
    var parent = document.head || document.documentElement;
    if (sidebarStyle.parentNode !== parent) parent.appendChild(sidebarStyle);
  }
  function placeSidebarHandle() {
    var box = sidebarBox();
    if (!sidebarHandle) return;
    var r = box ? box.getBoundingClientRect() : null;
    if (!r || !r.width) { sidebarHandle.style.display = 'none'; return; }
    sidebarHandle.style.display = 'block';
    sidebarHandle.style.left = Math.round(r.right - 3) + 'px';
    sidebarHandle.style.top = Math.round(r.top) + 'px';
    sidebarHandle.style.height = Math.round(r.height) + 'px';
  }
  function makeSidebarHandle() {
    var h = document.createElement('div');
    h.id = '__myapps-wa-sidebar-handle';
    h.title = 'Drag to resize. Double-click to reset.';
    h.style.cssText = 'position:fixed;width:6px;cursor:col-resize;z-index:2147483000;background:transparent;transition:background .15s;';
    h.addEventListener('mouseenter', function () { h.style.background = 'rgba(128,128,128,.45)'; });
    h.addEventListener('mouseleave', function () { if (!sidebarDragging) h.style.background = 'transparent'; });
    h.addEventListener('dblclick', function () {
      settings.sidebarWidth = 0;
      setSidebarRule(0);
      setTimeout(placeSidebarHandle, 0);
      try { bridge.setWhatsappWidth(0); } catch (e) { /* bridge unavailable */ }
    });
    h.addEventListener('mousedown', function (down) {
      var box = sidebarBox();
      if (!box || down.button !== 0) return;
      down.preventDefault();
      sidebarDragging = true;
      h.style.background = 'rgba(128,128,128,.45)';
      var left = box.getBoundingClientRect().left;
      var width = settings.sidebarWidth;
      // Text must not get selected, and the page below must not eat the moves.
      var shield = document.createElement('div');
      shield.style.cssText = 'position:fixed;inset:0;z-index:2147483001;cursor:col-resize;';
      document.documentElement.appendChild(shield);
      function move(e) {
        width = clampSidebar(box, e.clientX - left);
        setSidebarRule(width);
        placeSidebarHandle();
      }
      function up() {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        if (shield.parentNode) shield.parentNode.removeChild(shield);
        sidebarDragging = false;
        h.style.background = 'transparent';
        if (width && width !== settings.sidebarWidth) {
          settings.sidebarWidth = width;
          try { bridge.setWhatsappWidth(width); } catch (e) { /* bridge unavailable */ }
        }
      }
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
    });
    return h;
  }
  function applySidebar() {
    if (!settings.resizableSidebar) {
      setSidebarRule(0);
      if (sidebarTimer) { clearInterval(sidebarTimer); sidebarTimer = null; }
      if (sidebarHandle && sidebarHandle.parentNode) sidebarHandle.parentNode.removeChild(sidebarHandle);
      sidebarHandle = null;
      delete status.resizableSidebar;
      return;
    }
    if (!sidebarBox()) { status.resizableSidebar = 'missing'; return; } // chat list not on screen yet
    status.resizableSidebar = 'ok';
    if (!sidebarDragging) setSidebarRule(settings.sidebarWidth);
    if (!sidebarHandle) sidebarHandle = makeSidebarHandle();
    if (!sidebarHandle.parentNode) document.documentElement.appendChild(sidebarHandle);
    placeSidebarHandle();
    // WhatsApp moves things around on its own (window resize, panels): keep the handle on the edge.
    if (!sidebarTimer) sidebarTimer = setInterval(function () { if (!sidebarDragging) placeSidebarHandle(); }, 500);
  }

  // ---------------------------------------------------------------------
  // Finding WhatsApp's internal modules
  // ---------------------------------------------------------------------
  function req(name) {
    try { return window.require(name); } catch (e) { return null; }
  }

  function moduleNames() {
    try {
      var dbg = req('__debug');
      return dbg && dbg.modulesMap ? Object.keys(dbg.modulesMap) : [];
    } catch (e) { return []; }
  }

  var found = {};
  // Looks only at modules whose NAME matches `hint`, then keeps the first whose
  // exports pass `test`. Requiring every module would be slow and could start
  // parts of the app that were never loaded.
  function findModule(key, hint, test) {
    if (found[key]) return found[key];
    var names = moduleNames();
    for (var i = 0; i < names.length; i++) {
      if (!hint.test(names[i])) continue;
      var mod = req(names[i]);
      var ok = false;
      try { ok = !!(mod && test(mod)); } catch (e) { ok = false; }
      if (ok) { found[key] = mod; return mod; }
    }
    return null;
  }

  var findPresenceFns = function () {
    return findModule('presenceFns', /Presence/i, function (m) {
      return typeof m.sendPresenceAvailable === 'function' && typeof m.sendPresenceUnavailable === 'function';
    }) || (function () {
      var m = findModule('presenceFns2', /Presence/i, function (x) {
        return x.ChatPresence && typeof x.ChatPresence.sendPresenceAvailable === 'function';
      });
      return m ? m.ChatPresence : null;
    })();
  };
  // Where WhatsApp keeps "mark this status as read": a module that exports
  // sendReadStatus itself (current versions), or a status model class with
  // it on its prototype (older versions). Try the exact name first so no
  // unrelated "Status" modules get loaded just to look at them.
  var findStatusFns = function () {
    return findModule('statusFns', /^WAWebContactStatusBridge$/, function (m) {
      return typeof m.sendReadStatus === 'function';
    }) || findModule('statusFns2', /Status.*Bridge/i, function (m) {
      return typeof m.sendReadStatus === 'function';
    });
  };
  var findStatusModel = function () {
    var m = findModule('statusModel', /StatusV3/i, function (x) {
      return x.default && x.default.prototype && typeof x.default.prototype.sendReadStatus === 'function';
    });
    return m ? m.default : null;
  };
  var findCollections = function () {
    return findModule('collections', /Collection|Store/i, function (m) {
      return m.Msg && typeof m.Msg.on === 'function';
    });
  };

  // ---------------------------------------------------------------------
  // Patching with restore
  // ---------------------------------------------------------------------
  var originals = []; // { obj, key, fn }
  function patch(obj, key, replacement) {
    for (var i = 0; i < originals.length; i++) {
      if (originals[i].obj === obj && originals[i].key === key) return true;
    }
    var fn = obj[key];
    try { obj[key] = replacement; } catch (e) { return false; }
    if (obj[key] !== replacement) return false;
    originals.push({ obj: obj, key: key, fn: fn });
    return true;
  }
  // Returns true only if something was actually put back.
  function unpatch(obj, key) {
    for (var i = 0; i < originals.length; i++) {
      if (originals[i].obj === obj && originals[i].key === key) {
        try { obj[key] = originals[i].fn; } catch (e) { /* ignore */ }
        originals.splice(i, 1);
        return true;
      }
    }
    return false;
  }
  function resolved() { return Promise.resolve(); }

  // ---------------------------------------------------------------------
  // Hide online status
  // ---------------------------------------------------------------------
  var onlineTimer = null;
  function applyHideOnline() {
    var fns = findPresenceFns();
    if (settings.hideOnline) {
      if (!fns) { status.hideOnline = 'missing'; return; }
      status.hideOnline = patch(fns, 'sendPresenceAvailable', resolved) ? 'ok' : 'missing';
      // Say "offline" now, and again now and then in case WhatsApp announced
      // itself some other way (e.g. after the window regained focus).
      try { fns.sendPresenceUnavailable(); } catch (e) { /* ignore */ }
      if (!onlineTimer) {
        onlineTimer = setInterval(function () {
          try { fns.sendPresenceUnavailable(); } catch (e) { /* ignore */ }
        }, 5000);
      }
    } else {
      if (onlineTimer) { clearInterval(onlineTimer); onlineTimer = null; }
      // Announce "available" again only if we had been hiding it; otherwise
      // every unrelated settings change would flip the user to online.
      if (fns && unpatch(fns, 'sendPresenceAvailable')) {
        try { fns.sendPresenceAvailable(); } catch (e) { /* ignore */ }
      }
      delete status.hideOnline;
    }
  }

  // ---------------------------------------------------------------------
  // View statuses privately
  // ---------------------------------------------------------------------
  function applyViewStatusPrivately() {
    var fns = findStatusFns();
    var model = findStatusModel();
    if (settings.viewStatusPrivately) {
      var patched = false;
      if (fns) patched = patch(fns, 'sendReadStatus', resolved) || patched;
      if (model) patched = patch(model.prototype, 'sendReadStatus', resolved) || patched;
      status.viewStatusPrivately = patched ? 'ok' : 'missing';
    } else {
      if (fns) unpatch(fns, 'sendReadStatus');
      if (model) unpatch(model.prototype, 'sendReadStatus');
      delete status.viewStatusPrivately;
    }
  }

  // ---------------------------------------------------------------------
  // Restore deleted messages. Copies of incoming text messages are kept in
  // MEMORY ONLY (never written to disk) and are gone when the app closes.
  // When someone deletes a message, the original text is shown under it.
  // ---------------------------------------------------------------------
  var MAX_CACHED = 3000;
  var textCache = new Map(); // message id -> text
  var deletedText = new Map(); // message id -> text of a message that was deleted
  var msgListeners = null;
  var restoreObserver = null;
  var restoreTimer = null;

  function msgId(msg) {
    return msg && msg.id && msg.id._serialized ? msg.id._serialized : null;
  }

  function onMsgAdd(msg) {
    var id = msgId(msg);
    if (!id || (msg.id && msg.id.fromMe)) return;
    if (msg.type === 'chat' && typeof msg.body === 'string' && msg.body) {
      textCache.set(id, msg.body);
    } else if (typeof msg.caption === 'string' && msg.caption) {
      textCache.set(id, msg.caption);
    } else {
      return;
    }
    if (textCache.size > MAX_CACHED) textCache.delete(textCache.keys().next().value);
  }

  function onMsgChange(msg) {
    var id = msgId(msg);
    if (!id || (msg.id && msg.id.fromMe)) return;
    var type = msg.type != null ? msg.type : msg.__x_type;
    if (type !== 'revoked') return;
    var text = textCache.get(id);
    if (!text && typeof msg.backupContent === 'string') text = msg.backupContent;
    if (!text) return;
    deletedText.set(id, text);
    scheduleRestoreScan();
  }

  function scheduleRestoreScan() {
    if (restoreTimer) return;
    restoreTimer = setTimeout(function () { restoreTimer = null; scanRestored(); }, 300);
  }

  function scanRestored() {
    if (!settings.restoreDeleted) return;
    deletedText.forEach(function (text, id) {
      var row = null;
      try { row = document.querySelector('[data-id="' + id.replace(/"/g, '') + '"]'); } catch (e) { /* bad id */ }
      if (!row || row.querySelector('.__myapps-restored')) return;
      var note = document.createElement('div');
      note.className = '__myapps-restored';
      note.style.cssText = 'margin:2px 12px 6px;padding:4px 8px;border-left:3px solid #e0a800;' +
        'background:rgba(224,168,0,.12);font-size:12.5px;line-height:1.35;white-space:pre-wrap;' +
        'word-break:break-word;color:inherit;';
      var label = document.createElement('div');
      label.textContent = 'Deleted message (restored by My Apps):';
      label.style.cssText = 'font-size:11px;opacity:.7;margin-bottom:2px;';
      var body = document.createElement('div');
      body.textContent = text; // text only: never HTML
      note.appendChild(label);
      note.appendChild(body);
      row.appendChild(note);
    });
  }

  function removeRestoredNotes() {
    var nodes = document.querySelectorAll('.__myapps-restored');
    for (var i = 0; i < nodes.length; i++) nodes[i].parentNode.removeChild(nodes[i]);
  }

  function applyRestoreDeleted() {
    var cols = findCollections();
    if (settings.restoreDeleted) {
      if (!cols) { status.restoreDeleted = 'missing'; return; }
      status.restoreDeleted = 'ok';
      if (!msgListeners) {
        msgListeners = { add: onMsgAdd, change: onMsgChange };
        try {
          cols.Msg.on('add', msgListeners.add);
          cols.Msg.on('change', msgListeners.change);
        } catch (e) { status.restoreDeleted = 'missing'; msgListeners = null; return; }
      }
      if (!restoreObserver && document.body) {
        restoreObserver = new MutationObserver(scheduleRestoreScan);
        restoreObserver.observe(document.body, { childList: true, subtree: true });
      }
      scheduleRestoreScan();
    } else {
      if (msgListeners && cols) {
        try {
          cols.Msg.off('add', msgListeners.add);
          cols.Msg.off('change', msgListeners.change);
        } catch (e) { /* ignore */ }
      }
      msgListeners = null;
      if (restoreObserver) { restoreObserver.disconnect(); restoreObserver = null; }
      removeRestoredNotes();
      textCache.clear();
      deletedText.clear();
      delete status.restoreDeleted;
    }
  }

  // ---------------------------------------------------------------------
  // Online notifications for contacts the user picked
  // ---------------------------------------------------------------------
  var POLL_MS = 5000;
  var onlinePoll = null;
  var wasOnline = new Map(); // contact id -> last seen online state
  var subscribed = new Set();
  var notifySeq = 0;

  function contactLabel(c) {
    return c && (c.formattedName || c.name || c.pushname || c.shortName) || '';
  }

  // A typed entry is either a phone number or (part of) a contact name.
  function resolveContacts(cols, entries) {
    var ids = [];
    var contacts = [];
    try { contacts = cols.Contact && cols.Contact.getModelsArray ? cols.Contact.getModelsArray() : []; } catch (e) { contacts = []; }
    entries.forEach(function (entry) {
      var text = String(entry).trim();
      if (!text) return;
      if (/^[+\d\s()-]{7,}$/.test(text)) {
        ids.push(text.replace(/\D/g, '') + '@c.us');
        return;
      }
      var lower = text.toLowerCase();
      var exact = null;
      var partial = null;
      contacts.forEach(function (c) {
        var names = [c.name, c.pushname, c.formattedName, c.shortName].filter(Boolean).map(function (n) { return String(n).toLowerCase(); });
        if (names.indexOf(lower) !== -1) exact = exact || c;
        else if (names.some(function (n) { return n.indexOf(lower) !== -1; })) partial = partial || c;
      });
      var hit = exact || partial;
      if (hit && hit.id && hit.id._serialized) ids.push(hit.id._serialized);
    });
    return ids;
  }

  function presenceFor(cols, id) {
    var store = cols.Presence;
    if (!store) return null;
    try {
      return (store.get && store.get(id)) || (store.find && store.find(id)) || null;
    } catch (e) { return null; }
  }

  function pollOnline() {
    var cols = findCollections();
    if (!cols || !cols.Presence) { status.notifyOnline = 'missing'; return; }
    status.notifyOnline = 'ok';
    var ids = resolveContacts(cols, settings.notifyContacts);
    ids.forEach(function (id) {
      var p = presenceFor(cols, id);
      if (!p) return;
      if (!subscribed.has(id)) {
        subscribed.add(id);
        // WhatsApp only reports a contact's presence while it is subscribed to it.
        try { if (typeof p.subscribe === 'function') p.subscribe(); } catch (e) { /* ignore */ }
      }
      var online = !!p.isOnline;
      var before = wasOnline.get(id);
      wasOnline.set(id, online);
      if (before === false && online) {
        var contact = null;
        try { contact = cols.Contact && cols.Contact.get ? cols.Contact.get(id) : null; } catch (e) { contact = null; }
        var name = contactLabel(contact) || id.split('@')[0];
        try {
          bridge.notify({
            notificationId: 'wa-online-' + (++notifySeq) + '-' + Date.now(),
            title: name + ' is online',
            options: { body: 'Seen online on WhatsApp', tag: 'wa-online-' + id }
          });
        } catch (e) { /* bridge unavailable */ }
      }
    });
  }

  function applyNotifyOnline() {
    if (settings.notifyOnline && settings.notifyContacts.length) {
      if (!onlinePoll) {
        wasOnline.clear();
        subscribed.clear();
        onlinePoll = setInterval(pollOnline, POLL_MS);
      }
      pollOnline();
    } else {
      if (onlinePoll) { clearInterval(onlinePoll); onlinePoll = null; }
      wasOnline.clear();
      subscribed.clear();
      if (settings.notifyOnline) status.notifyOnline = 'ok'; // on, but nobody picked yet
      else delete status.notifyOnline;
    }
  }

  // ---------------------------------------------------------------------
  // Apply everything. Hooks retry for a while because WhatsApp loads its
  // modules lazily, after our script has started.
  // ---------------------------------------------------------------------
  var retryTimer = null;
  var retryUntil = 0;

  // Tells the app which options could not attach (it shows a warning in the dialog).
  function reportStatus() {
    var signature = JSON.stringify(status);
    if (signature === lastStatusSignature) return;
    lastStatusSignature = signature;
    try { bridge.setWhatsappStatus(JSON.parse(signature)); } catch (e) { /* bridge unavailable */ }
  }

  function applyAll() {
    applyBlur();
    applySidebar();
    if (typeof window.require === 'function') {
      applyHideOnline();
      applyViewStatusPrivately();
      applyRestoreDeleted();
      applyNotifyOnline();
    } else {
      ['hideOnline', 'viewStatusPrivately', 'restoreDeleted', 'notifyOnline'].forEach(function (k) {
        if (settings[k]) status[k] = 'missing';
      });
    }
    reportStatus();
    var missing = Object.keys(status).some(function (k) { return status[k] === 'missing'; });
    if (missing && !retryTimer) {
      retryUntil = Date.now() + 120000;
      retryTimer = setInterval(function () {
        if (Date.now() > retryUntil) { clearInterval(retryTimer); retryTimer = null; return; }
        applyAll();
      }, 4000);
    } else if (!missing && retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  }

  bridge.onConfigUpdate(function (cfg) {
    if (!cfg || !cfg.whatsapp) return;
    var next = normalize(cfg.whatsapp);
    var changed = JSON.stringify(next) !== JSON.stringify(settings);
    settings = next;
    if (changed) applyAll();
  });

  function start() {
    applyAll();
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
