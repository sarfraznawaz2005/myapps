'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--link-id='));
const linkId = arg ? arg.slice('--link-id='.length) : null;

function userscriptMatchesUrl(url, patterns) {
  if (!patterns || !patterns.length) return false;
  for (const p of patterns) {
    if (!p) continue;
    const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    try {
      if (new RegExp('^' + escaped + '$').test(url)) return true;
    } catch (e) { /* malformed pattern; skip it */ }
  }
  return false;
}

// Opt-in password manager (Settings > Passwords). Runs in the preload's
// isolated world, so page scripts can't call it or read its UI (closed shadow
// root). The site is decided by main from this frame's own URL. Stored
// passwords only reach this frame after a trusted click on an account row.
// Also hosts the independent "reveal password" eye button (Settings > General),
// since both work on the same password fields.
function setupPasswordManager(initiallyOn, initiallyReveal) {
  let on = initiallyOn;
  let revealOn = initiallyReveal;
  ipcRenderer.on('link:config', (_e, cfg) => {
    on = !!(cfg && cfg.passwordManager);
    revealOn = !!(cfg && cfg.revealPassword);
    if (!on) { hideDropdown(); hidePrompt(); }
    if (!revealOn) hideEye();
  });

  // A field the eye button has switched to type=text still counts as a
  // password field for everything below (fill, capture).
  const revealed = new Set();
  const isPasswordField = (el) => el.type === 'password' || revealed.has(el);

  const TEXT_TYPES = ['', 'text', 'email', 'tel'];
  const isTop = window === window.top;
  let dropHost = null;
  let promptHost = null;
  let lastCapture = '';
  let lastCaptureAt = 0;

  // Only CSSOM (el.style.x = ...) — no innerHTML or <style> text — so a strict
  // page CSP / Trusted Types policy can't block the UI.
  function h(tag, styles, text) {
    const el = document.createElement(tag);
    if (styles) Object.assign(el.style, styles);
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function mountUi(styles) {
    const host = h('div', Object.assign({ all: 'initial', position: 'fixed', zIndex: '2147483647' }, styles));
    const root = host.attachShadow({ mode: 'closed' });
    (document.documentElement || document).appendChild(host);
    return { host, root };
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function scopeOf(el) { return el.form || document; }

  function visiblePasswordFields(scope) {
    return Array.from(scope.querySelectorAll('input')).filter((i) => isPasswordField(i) && visible(i));
  }

  function autocompleteHas(el, word) {
    return (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).includes(word);
  }

  // The closest visible text-like input before the password field.
  function findUsernameField(pw) {
    const before = Array.from(scopeOf(pw).querySelectorAll('input')).filter((i) =>
      i !== pw && TEXT_TYPES.includes((i.type || '').toLowerCase()) && !i.readOnly && visible(i) &&
      (i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING));
    return before.length ? before[before.length - 1] : null;
  }

  function isUsernameField(el) {
    if (!TEXT_TYPES.includes((el.type || '').toLowerCase()) || el.readOnly) return false;
    if (autocompleteHas(el, 'username') || autocompleteHas(el, 'email')) return true;
    return visiblePasswordFields(scopeOf(el)).some((pw) => el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value); // native setter, so React/Vue see the change
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---- account dropdown ----
  function hideDropdown() {
    if (dropHost) { dropHost.remove(); dropHost = null; }
  }

  async function fillFrom(entry, field) {
    const res = await ipcRenderer.invoke('pm:fill', entry.id).catch(() => null);
    hideDropdown();
    if (!res) return;
    const isPw = isPasswordField(field);
    const pw = isPw ? field : visiblePasswordFields(scopeOf(field))[0] || null;
    const user = isPw ? (pw ? findUsernameField(pw) : null) : field;
    if (user) setValue(user, res.username);
    if (pw) setValue(pw, res.password);
    (pw || user).focus();
  }

  async function maybeShowDropdown(field) {
    if (!on || field.value) return;
    const isPw = isPasswordField(field);
    if (!isPw && !isUsernameField(field)) return;
    const entries = await ipcRenderer.invoke('pm:list').catch(() => []);
    if (!on || !entries.length || document.activeElement !== field) return;

    hideDropdown();
    const r = field.getBoundingClientRect();
    const ui = mountUi({ left: `${Math.round(r.left)}px`, top: `${Math.round(r.bottom + 2)}px` });
    dropHost = ui.host;
    const box = h('div', {
      minWidth: `${Math.max(220, Math.round(r.width))}px`, background: '#fff', color: '#111',
      border: '1px solid #c8c8c8', borderRadius: '6px', boxShadow: '0 4px 14px rgba(0,0,0,.25)',
      font: '13px system-ui, sans-serif', overflow: 'hidden',
    });
    for (const entry of entries) {
      const row = h('div', { padding: '8px 12px', cursor: 'pointer' }, entry.username || '(no username)');
      row.addEventListener('mouseenter', () => { row.style.background = '#eef3ff'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      // mousedown + preventDefault keeps focus in the field; isTrusted stops
      // a page script from faking the click to pull out a password.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (e.isTrusted) fillFrom(entry, field);
      });
      box.appendChild(row);
    }
    box.appendChild(h('div', { padding: '5px 12px', fontSize: '11px', color: '#666', background: '#f6f6f6', borderTop: '1px solid #e2e2e2' }, 'My Apps saved logins'));
    ui.root.appendChild(box);
  }

  // ---- reveal (eye) button ----
  let eyeHost = null;
  let eyeField = null;

  function eyeIcon(struck) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) {
      svg.setAttribute(k, v);
    }
    const shapes = [['path', { d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' }], ['circle', { cx: '12', cy: '12', r: '3' }]];
    if (struck) shapes.push(['line', { x1: '3', y1: '3', x2: '21', y2: '21' }]);
    for (const [tag, attrs] of shapes) {
      const s = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
      svg.appendChild(s);
    }
    return svg;
  }

  // Back to a hidden password. Runs whenever the eye goes away, so a
  // revealed password never stays on screen after the user leaves the field.
  function hideEye() {
    if (eyeField && revealed.has(eyeField)) {
      eyeField.type = 'password';
      revealed.delete(eyeField);
    }
    if (eyeHost) { eyeHost.remove(); eyeHost = null; }
    eyeField = null;
  }

  function placeEye() {
    if (!eyeHost || !eyeField) return;
    if (!eyeField.isConnected || !visible(eyeField)) { hideEye(); return; }
    const r = eyeField.getBoundingClientRect();
    eyeHost.style.left = `${Math.round(r.right - 30)}px`;
    eyeHost.style.top = `${Math.round(r.top + (r.height - 24) / 2)}px`;
  }

  function drawEye() {
    const ui = mountUi({});
    eyeHost = ui.host;
    const shown = revealed.has(eyeField);
    const btn = h('div', {
      width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', color: '#555', background: 'rgba(255,255,255,.85)', borderRadius: '4px',
    });
    btn.title = shown ? 'Hide password' : 'Show password';
    btn.appendChild(eyeIcon(shown));
    // mousedown + preventDefault keeps focus in the field; isTrusted stops a
    // page script from faking a click to expose the password.
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!e.isTrusted || !eyeField) return;
      if (revealed.has(eyeField)) { eyeField.type = 'password'; revealed.delete(eyeField); }
      else { revealed.add(eyeField); eyeField.type = 'text'; }
      eyeHost.remove();
      drawEye();
      placeEye();
    });
    ui.root.appendChild(btn);
  }

  function maybeShowEye(field) {
    if (!revealOn || !isPasswordField(field) || !visible(field)) return;
    if (eyeField === field && eyeHost) return;
    hideEye();
    eyeField = field;
    drawEye();
    placeEye();
  }

  document.addEventListener('focusin', (e) => {
    if (e.target instanceof HTMLInputElement) { maybeShowEye(e.target); maybeShowDropdown(e.target); }
    else { hideDropdown(); hideEye(); }
  }, true);
  document.addEventListener('focusout', () => { hideDropdown(); hideEye(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideDropdown(); }, true);
  window.addEventListener('scroll', () => { hideDropdown(); placeEye(); }, true);
  window.addEventListener('resize', () => { hideDropdown(); placeEye(); });

  // ---- "Save password?" prompt ----
  function hidePrompt() {
    if (promptHost) { promptHost.remove(); promptHost = null; }
  }

  function showPrompt(info) {
    hidePrompt();
    const ui = mountUi({ top: '16px', right: '16px' });
    promptHost = ui.host;
    const card = h('div', {
      width: '300px', background: '#fff', color: '#111', border: '1px solid #c8c8c8', borderRadius: '8px',
      boxShadow: '0 6px 20px rgba(0,0,0,.3)', font: '13px system-ui, sans-serif', padding: '14px',
    });
    card.appendChild(h('div', { fontWeight: '600', marginBottom: '6px' }, info.update ? 'Update saved password?' : 'Save password?'));
    card.appendChild(h('div', { color: '#444', marginBottom: '12px', wordBreak: 'break-all' }, `${info.username} on ${info.host}`));
    const row = h('div', { display: 'flex', gap: '8px', flexWrap: 'wrap' });
    const btn = (label, primary, fn) => {
      const b = h('button', {
        padding: '6px 12px', borderRadius: '5px', cursor: 'pointer', font: 'inherit',
        border: primary ? '1px solid #2563eb' : '1px solid #bbb',
        background: primary ? '#2563eb' : '#f4f4f4', color: primary ? '#fff' : '#111',
      }, label);
      b.addEventListener('click', (e) => { if (e.isTrusted) { hidePrompt(); fn(); } });
      return b;
    };
    row.appendChild(btn(info.update ? 'Update' : 'Save', true, () => ipcRenderer.invoke('pm:pending-commit').catch(() => {})));
    row.appendChild(btn('Not now', false, () => ipcRenderer.invoke('pm:pending-discard', false).catch(() => {})));
    row.appendChild(btn('Never for this site', false, () => ipcRenderer.invoke('pm:pending-discard', true).catch(() => {})));
    card.appendChild(row);
    ui.root.appendChild(card);
  }

  // Only asks when the login page is gone — if a password box is still there,
  // the login most likely failed, so we don't offer to save it.
  async function checkPending() {
    if (!on || !isTop || visiblePasswordFields(document).length) return;
    const info = await ipcRenderer.invoke('pm:pending-take').catch(() => null);
    if (info) showPrompt(info);
  }

  // ---- capture on submit ----
  function capture(scope) {
    if (!on) return;
    const pws = visiblePasswordFields(scope).filter((p) => p.value);
    let username = '';
    let password = '';
    if (pws.length) {
      // Password-change forms have several boxes; the "new" one wins.
      const pw = pws.find((p) => autocompleteHas(p, 'new-password')) || pws[0];
      const userField = findUsernameField(pw);
      username = userField ? userField.value.trim() : '';
      password = pw.value;
    } else {
      // Step one of a two-step login: username/email only, no password yet.
      const u = Array.from(scope.querySelectorAll('input')).find((i) =>
        visible(i) && i.value && (autocompleteHas(i, 'username') || (i.type || '').toLowerCase() === 'email'));
      if (!u) return;
      username = u.value.trim();
    }
    const key = `${username}\n${password}`;
    if (key === lastCapture && Date.now() - lastCaptureAt < 1000) return;
    lastCapture = key;
    lastCaptureAt = Date.now();
    ipcRenderer.invoke('pm:capture', { username, password }).catch(() => {});
    if (password) {
      setTimeout(checkPending, 1500); // single-page apps: same page, form gone
      setTimeout(checkPending, 4000);
    }
  }

  document.addEventListener('submit', (e) => {
    if (e.isTrusted && e.target instanceof HTMLFormElement) capture(e.target);
  }, true);
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const b = e.target.closest('button, input[type="submit"], input[type="button"], [role="button"]');
    if (b) capture(b.form || document);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.isTrusted && e.target instanceof HTMLInputElement) capture(scopeOf(e.target));
  }, true);

  // A login that navigated away: ask once the new page has settled.
  document.addEventListener('DOMContentLoaded', () => setTimeout(checkPending, 800));
}

// Global keyword highlighter (toolbar highlighter button). Uses the CSS Custom
// Highlight API: matches are painted from Ranges, so the page's DOM is never
// changed (wrapping text in <mark> breaks React/Vue sites that later update
// those text nodes). Top frame only. With no keywords it does nothing at all:
// no observer, no scan.
function setupKeywordHighlighter(initial) {
  if (window !== window.top) return;
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
  const NAME = 'myapps-keywords';
  const MAX_RANGES = 5000;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'IFRAME']);
  let regex = null;
  let observer = null;
  let timer = null;
  let styled = false;

  function scan() {
    timer = null;
    CSS.highlights.delete(NAME);
    if (!regex || !document.body) return;
    const ranges = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName) || parent.isContentEditable) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let node;
    while ((node = walker.nextNode()) && ranges.length < MAX_RANGES) {
      const text = node.nodeValue;
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(text)) && ranges.length < MAX_RANGES) {
        const range = new Range();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        ranges.push(range);
      }
    }
    if (ranges.length) CSS.highlights.set(NAME, new Highlight(...ranges));
  }

  // Throttled, not debounced: a page that mutates constantly still gets scanned.
  function schedule() {
    if (!timer) timer = setTimeout(scan, 400);
  }

  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    if (timer) { clearTimeout(timer); timer = null; }
    CSS.highlights.delete(NAME);
  }

  function start() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', start, { once: true }); return; }
    if (!regex) return;
    if (!styled) {
      styled = true;
      // webFrame.insertCSS is not blocked by a page's CSP, unlike an inline <style>.
      webFrame.insertCSS(`::highlight(${NAME}) { background-color: #ffe14d; color: #000; }`);
    }
    if (!observer) {
      observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    scan();
  }

  function apply(list) {
    const words = (Array.isArray(list) ? list : []).filter((w) => typeof w === 'string' && w);
    if (!words.length) { regex = null; stop(); return; }
    const parts = words.slice().sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    regex = new RegExp(parts.join('|'), 'gi');
    start();
  }

  ipcRenderer.on('link:config', (_e, cfg) => apply(cfg && cfg.highlightKeywords));
  apply(initial);
}

if (linkId) {
  // One synchronous round-trip for this link's current config + the
  // injected-script source text (main reads inject-main-world.js from disk
  // and hands the string back — preload itself has no fs access sandboxed).
  const boot = ipcRenderer.sendSync('link:bootstrap', linkId) || {};

  contextBridge.exposeInMainWorld('__myapps', {
    linkId,
    initialConfig: boot.config || {},
    setBadge: (count) => ipcRenderer.send('link:badge', linkId, count),
    reportExpert: (payload) => ipcRenderer.send('link:expert', linkId, payload),
    notify: (payload) => ipcRenderer.send('link:notification', linkId, payload),
    pickedElement: (payload) => ipcRenderer.send('link:picked-element', linkId, payload),
    getLocation: () => ipcRenderer.invoke('link:get-location', linkId),
    onNotifClick: (cb) => ipcRenderer.on(`link:notif-click:${linkId}`, (_e, notificationId) => cb(notificationId)),
    onConfigUpdate: (cb) => ipcRenderer.on('link:config', (_e, cfg) => cb(cfg)),
    onStartPicker: (cb) => ipcRenderer.on('link:start-picker', () => cb()),
    onStopPicker: (cb) => ipcRenderer.on('link:stop-picker', () => cb()),
    onMediaPause: (cb) => ipcRenderer.on('link:media-pause', () => cb()),
    onMediaResume: (cb) => ipcRenderer.on('link:media-resume', () => cb()),
  });

  setupKeywordHighlighter(boot.config && boot.config.highlightKeywords);
  setupPasswordManager(!!(boot.config && boot.config.passwordManager), !!(boot.config && boot.config.revealPassword));

  // A cross-origin iframe (ad, tracker, embed) is not the site itself: it never
  // raises the site's notifications or badge, and parsing ~20KB of script in
  // each one adds up on ad-heavy pages. Only the expert-rule engine can need
  // it there (a rule may target an embedded frame), so inject only if enabled.
  const topOrigin = window !== window.top && location.ancestorOrigins && location.ancestorOrigins.length
    ? location.ancestorOrigins[location.ancestorOrigins.length - 1]
    : null;
  const thirdPartyFrame = !!topOrigin && /^https?:$/.test(location.protocol) && location.origin !== topOrigin;
  const expertOn = !!(boot.config && boot.config.expert && boot.config.expert.enabled);

  if (boot.source && (!thirdPartyFrame || expertOn)) {
    // Runs in the main world, before any page script — critical so Slack/
    // WhatsApp/etc. don't capture window.Notification first.
    webFrame.executeJavaScript(boot.source).catch(() => {});
  }

  // Userscripts: each matching one gets its own top-level executeJavaScript
  // call rather than being eval()'d from inside boot.source — a strict
  // page CSP (Gmail, ChatGPT) blocks eval/Function called from a script
  // already running in the page, but not this kind of external injection.
  // Top frame only — subframes get this whole preload too (needed so the
  // expert rule engine can reach a site's own iframes), but a userscript
  // should run once per page, not once per ad/embed iframe on it.
  const scripts = (window === window.top && boot.config && boot.config.userscripts) || [];
  const currentUrl = location.href;
  for (const s of scripts) {
    if (!userscriptMatchesUrl(currentUrl, s.matches)) continue;
    const label = JSON.stringify(`[My Apps userscript] "${s.name || 'Untitled'}" failed:`);
    const wrapped = `(function(){
      function __run(){
        try {
${s.code}
        } catch (e) {
          console.error(${label}, e);
        }
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', __run);
      } else {
        __run();
      }
    })();`;
    webFrame.executeJavaScript(wrapped).catch(() => {});
  }
}
