// Executed via webFrame.executeJavaScript from link-preload.js, in the main
// world, BEFORE any page script runs. Relies on window.__myapps having
// already been exposed by link-preload.js's contextBridge call.
//
// Provides:
//  - navigator.setAppBadge / clearAppBadge patch (Badging API signal)
//  - window.Notification shim (Path A forwarded notifications)
//  - ServiceWorkerRegistration#showNotification patch (Path A, most PWAs)
//  - the expert-rule engine (MutationObserver-driven DOM watcher)
//  - the element picker used by the "Pick element" button in the edit dialog
(function () {
  if (window.__myappsInjected) return;
  window.__myappsInjected = true;

  var bridge = window.__myapps;
  if (!bridge) return;

  var config = bridge.initialConfig || {};

  // ---------------------------------------------------------------------
  // Badging API patch
  // ---------------------------------------------------------------------
  try {
    navigator.setAppBadge = function (count) {
      bridge.setBadge(typeof count === 'number' ? count : null);
      return Promise.resolve();
    };
    navigator.clearAppBadge = function () {
      bridge.setBadge(0);
      return Promise.resolve();
    };
  } catch (e) { /* some pages freeze navigator; ignore */ }

  // ---------------------------------------------------------------------
  // Notification shim (Path A) — replaces window.Notification entirely so
  // pages that construct `new Notification(...)` directly are forwarded.
  // ---------------------------------------------------------------------
  var notifRegistry = new Map();
  var notifSeq = 0;
  var OriginalNotification = window.Notification;

  function WrapNotification(title, options) {
    var id = 'n' + (++notifSeq) + '-' + Date.now();
    this._id = id;
    this._onclick = null;
    notifRegistry.set(id, this);
    bridge.notify({ notificationId: id, title: String(title || ''), options: options || {} });
  }
  WrapNotification.permission = 'granted';
  WrapNotification.requestPermission = function (cb) {
    if (typeof cb === 'function') cb('granted');
    return Promise.resolve('granted');
  };
  WrapNotification.prototype.close = function () { notifRegistry.delete(this._id); };
  WrapNotification.prototype.addEventListener = function (type, fn) {
    if (type === 'click' && typeof fn === 'function') this._onclick = fn;
  };
  WrapNotification.prototype.removeEventListener = function (type) {
    if (type === 'click') this._onclick = null;
  };
  Object.defineProperty(WrapNotification.prototype, 'onclick', {
    configurable: true,
    set: function (fn) { this._onclick = fn; },
    get: function () { return this._onclick; },
  });
  try {
    Object.setPrototypeOf(WrapNotification.prototype, OriginalNotification ? OriginalNotification.prototype : Object.prototype);
  } catch (e) { /* ignore */ }
  window.Notification = WrapNotification;

  bridge.onNotifClick(function (notificationId) {
    var inst = notifRegistry.get(notificationId);
    if (inst && typeof inst._onclick === 'function') {
      try { inst._onclick(); } catch (e) { /* page's own handler threw; not our problem */ }
    }
  });

  // ---------------------------------------------------------------------
  // Service-worker notification patch (Path A, required) — Gmail,
  // WhatsApp Web, Teams and most PWAs call this instead of window.Notification.
  // ---------------------------------------------------------------------
  if (window.ServiceWorkerRegistration && window.ServiceWorkerRegistration.prototype) {
    window.ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
      options = options || {};
      // Only body/icon/tag are meaningful cross-process; passing everything
      // through has been observed to make some SW notifications silently
      // never fire (mirrors ferdium-app's shim).
      new WrapNotification(title, { body: options.body, icon: options.icon, tag: options.tag });
      return Promise.resolve();
    };
    if (!window.ServiceWorkerRegistration.prototype.getNotifications) {
      window.ServiceWorkerRegistration.prototype.getNotifications = function () { return Promise.resolve([]); };
    }
  }

  // ---------------------------------------------------------------------
  // Expert rule engine
  // ---------------------------------------------------------------------
  var expertObserver = null;
  var expertTimer = null;
  var coalesceTimer = null;
  var expertLastReportKey = null;

  function computeExpert(rule) {
    if (!rule || !rule.enabled || !rule.selector) return { ok: false, error: 'No selector configured' };
    var els;
    try {
      els = document.querySelectorAll(rule.selector);
    } catch (e) {
      return { ok: false, error: 'Invalid selector' };
    }
    if (!els || els.length === 0) return { ok: true, matched: 0, count: null, presence: false };

    var values = [];
    els.forEach(function (el) {
      var raw = null;
      if (rule.source === 'text') raw = el.textContent;
      else if (rule.source === 'attr') raw = el.getAttribute(rule.attr || '');
      else if (rule.source === 'count') raw = String(els.length);
      else if (rule.source === 'value') raw = el.value !== undefined ? el.value : el.textContent;
      if (raw == null) return;

      if (rule.mode === 'presence') {
        values.push(1);
        return;
      }
      var num = null;
      if (rule.regex) {
        try {
          var m = String(raw).match(new RegExp(rule.regex));
          if (m) num = parseInt(m[1] !== undefined ? m[1] : m[0], 10);
        } catch (e) { /* invalid regex — treat as no match */ }
      } else {
        var m2 = String(raw).match(/\d+/);
        if (m2) num = parseInt(m2[0], 10);
      }
      if (num !== null && !isNaN(num)) values.push(num);
    });

    if (rule.mode === 'presence') {
      return { ok: true, matched: els.length, count: null, presence: values.length > 0 };
    }
    if (values.length === 0) return { ok: true, matched: els.length, count: null, presence: false };

    var agg = rule.aggregate || 'first';
    var count;
    if (agg === 'sum') count = values.reduce(function (a, b) { return a + b; }, 0);
    else if (agg === 'max') count = Math.max.apply(null, values);
    else count = values[0];
    return { ok: true, matched: els.length, count: count, presence: count > 0 };
  }

  function reportExpert(force) {
    var rule = config.expert;
    if (!rule || !rule.enabled) return;
    var result = computeExpert(rule);
    if (!result.ok) return;
    var key = result.count + ':' + result.presence;
    if (!force && key === expertLastReportKey) return;
    expertLastReportKey = key;
    bridge.reportExpert({ count: result.count, presence: result.presence, matched: result.matched });
  }

  function scheduleReport() {
    if (coalesceTimer) return;
    coalesceTimer = setTimeout(function () {
      coalesceTimer = null;
      reportExpert(false);
    }, 400);
  }

  function armExpertObserver() {
    if (expertObserver) { expertObserver.disconnect(); expertObserver = null; }
    if (expertTimer) { clearInterval(expertTimer); expertTimer = null; }
    expertLastReportKey = null;

    var rule = config.expert;
    if (!rule || !rule.enabled || !rule.selector) return;

    var attributeFilter = ['class'];
    if (rule.source === 'attr' && rule.attr) attributeFilter.push(rule.attr);

    var target = document.documentElement || document.body;
    if (target) {
      expertObserver = new MutationObserver(scheduleReport);
      expertObserver.observe(target, {
        attributes: true,
        attributeFilter: attributeFilter,
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    reportExpert(true);
    var interval = rule.intervalMs || 15000;
    expertTimer = setInterval(function () { reportExpert(false); }, interval);
  }

  // Live config updates with no page reload — called whenever the user
  // edits the link's rule in the edit dialog.
  bridge.onConfigUpdate(function (newConfig) {
    config = newConfig || {};
    armExpertObserver();
  });

  // Used by the edit dialog's "Test" button — evaluates a candidate rule
  // once, without touching the live observer/config.
  window.__myappsTestExpertRule = function (rule) {
    return computeExpert(rule);
  };

  // ---------------------------------------------------------------------
  // Element picker (the edit dialog's "Pick element" button)
  // ---------------------------------------------------------------------
  var pickerActive = false;
  var pickerOverlay = null;

  function cssPathFor(el) {
    if (!(el instanceof Element)) return '';
    var path = [];
    while (el && el.nodeType === 1 && path.length < 6) {
      var sel = el.nodeName.toLowerCase();
      if (el.id) { sel += '#' + el.id; path.unshift(sel); break; }
      var cls = (el.className && typeof el.className === 'string')
        ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.')
        : '';
      if (cls) sel += '.' + cls;
      path.unshift(sel);
      el = el.parentElement;
    }
    return path.join(' > ');
  }

  function onPickerHover(e) {
    if (!pickerOverlay) {
      pickerOverlay = document.createElement('div');
      pickerOverlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;' +
        'background:rgba(59,130,246,0.35);outline:2px solid #3b82f6;';
      document.body.appendChild(pickerOverlay);
    }
    var r = e.target.getBoundingClientRect();
    pickerOverlay.style.left = r.left + 'px';
    pickerOverlay.style.top = r.top + 'px';
    pickerOverlay.style.width = r.width + 'px';
    pickerOverlay.style.height = r.height + 'px';
  }

  function onPickerClick(e) {
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    var attrs = {};
    for (var i = 0; i < el.attributes.length; i++) attrs[el.attributes[i].name] = el.attributes[i].value;
    bridge.pickedElement({
      selector: cssPathFor(el),
      text: (el.textContent || '').trim().slice(0, 200),
      attrs: attrs,
    });
    stopPicker();
  }

  function stopPicker() {
    pickerActive = false;
    document.removeEventListener('mouseover', onPickerHover, true);
    document.removeEventListener('click', onPickerClick, true);
    if (pickerOverlay && pickerOverlay.parentNode) pickerOverlay.parentNode.removeChild(pickerOverlay);
    pickerOverlay = null;
  }

  bridge.onStartPicker(function () {
    if (pickerActive) return;
    pickerActive = true;
    document.addEventListener('mouseover', onPickerHover, true);
    document.addEventListener('click', onPickerClick, true);
  });
  bridge.onStopPicker(stopPicker);

  armExpertObserver();
})();
