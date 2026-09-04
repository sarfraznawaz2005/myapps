import { getState } from '../state.js';
import { icons } from '../icons.js';

const host = document.getElementById('dialog-host');
let activeTab = 'general';
let editingLink = null;
let pickedHandler = null;
let draft = null; // mutable working copy of the link fields, survives tab switches

window.addEventListener('__myapps-picked-element', (e) => {
  if (pickedHandler) pickedHandler(e.detail);
});

function close() {
  host.classList.remove('open');
  host.innerHTML = '';
  pickedHandler = null;
  draft = null;
  window.myApps.send('ui:modal-open', false);
}

function defaultDraft() {
  return {
    name: '',
    url: '',
    groupId: null,
    zoom: 1,
    icon: { mode: 'auto', path: null, url: null, fallbackLetter: null, fallbackColor: '#3b82f6' },
    userAgent: null,
    muted: false,
    openOnStartup: false,
    notifications: { enabled: true, sound: true, synthesize: 'auto' },
    navigation: { openExternal: false, allowMedia: false, mediaDecided: false, allowLocation: false, locationDecided: false, allowedPopupHosts: [] },
    unread: {
      enabled: true,
      title: { mode: 'auto', regex: null },
      badge: { enabled: true },
      favicon: { mode: 'auto' },
      expert: { enabled: false, selector: '', source: 'text', attr: '', regex: '', mode: 'number', aggregate: 'first', intervalMs: 15000 },
    },
    hibernate: { policy: 'idle', minutes: 30, keepAwake: true },
  };
}

function draftFromLink(link) {
  return JSON.parse(JSON.stringify({
    name: link.name,
    url: link.url,
    groupId: link.groupId,
    zoom: link.zoom,
    icon: link.icon,
    userAgent: link.userAgent,
    muted: link.muted,
    openOnStartup: link.openOnStartup,
    notifications: link.notifications,
    navigation: link.navigation,
    unread: link.unread,
    hibernate: link.hibernate,
  }));
}

function groupOptions(selectedId) {
  const groups = getState().groups.slice().sort((a, b) => a.order - b.order);
  let html = `<option value="">Ungrouped</option>`;
  html += groups.map((g) => `<option value="${g.id}" ${g.id === (selectedId || '') ? 'selected' : ''}>${g.name}</option>`).join('');
  return html;
}

function generalTabHtml() {
  const d = draft;
  return `
    <div class="field">
      <label>Name</label>
      <input type="text" id="lk-name" value="${d.name}" placeholder="e.g. Work Gmail" />
    </div>
    <div class="field">
      <label>URL</label>
      <input type="text" id="lk-url" value="${d.url}" placeholder="https://mail.google.com" />
      <div class="hint" id="lk-probe-hint"></div>
    </div>
    <div class="field">
      <label>Group</label>
      <select id="lk-group">${groupOptions(d.groupId)}</select>
    </div>
    <div class="field-row">
      <div class="field">
        <label>Zoom</label>
        <input type="number" id="lk-zoom" min="50" max="300" step="10" value="${Math.round(d.zoom * 100)}" />
      </div>
      <div class="field">
        <label>Fallback letter/color</label>
        <div style="display:flex;gap:6px;">
          <input type="text" id="lk-fallback-letter" maxlength="2" style="width:48px" value="${d.icon.fallbackLetter || ''}" />
          <input type="color" id="lk-fallback-color" value="${d.icon.fallbackColor || '#3b82f6'}" style="width:40px;padding:2px;" />
        </div>
      </div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="lk-muted" ${d.muted ? 'checked' : ''} /><label for="lk-muted">Mute (never notify)</label></div>
    <div class="checkbox-row"><input type="checkbox" id="lk-open-on-startup" ${d.openOnStartup ? 'checked' : ''} /><label for="lk-open-on-startup">Open on startup (loads automatically, no click needed)</label></div>
    <div class="checkbox-row"><input type="checkbox" id="lk-notif-enabled" ${d.notifications.enabled ? 'checked' : ''} /><label for="lk-notif-enabled">Enable notifications</label></div>
    <div class="checkbox-row"><input type="checkbox" id="lk-notif-sound" ${d.notifications.sound ? 'checked' : ''} /><label for="lk-notif-sound">Play sound</label></div>
    <div class="field">
      <label>Synthesize notifications from unread count</label>
      <select id="lk-notif-synth">
        <option value="auto" ${d.notifications.synthesize === 'auto' ? 'selected' : ''}>Auto (only if the page never sends real ones)</option>
        <option value="off" ${d.notifications.synthesize === 'off' ? 'selected' : ''}>Off</option>
      </select>
    </div>
    <details class="disclosure">
      <summary>Advanced</summary>
      <div class="field">
        <label>Custom User-Agent (optional)</label>
        <input type="text" id="lk-ua" value="${d.userAgent || ''}" placeholder="Leave blank to use the cleaned default" />
      </div>
      <div class="checkbox-row"><input type="checkbox" id="lk-open-external" ${d.navigation.openExternal ? 'checked' : ''} /><label for="lk-open-external">Open unrelated links in the default browser</label></div>
      <div class="checkbox-row"><input type="checkbox" id="lk-allow-media" ${d.navigation.allowMedia ? 'checked' : ''} /><label for="lk-allow-media">Allow camera/microphone</label></div>
      <div class="checkbox-row"><input type="checkbox" id="lk-allow-location" ${d.navigation.allowLocation ? 'checked' : ''} /><label for="lk-allow-location">Allow location</label></div>
    </details>
  `;
}

function unreadTabHtml() {
  const u = draft.unread;
  const h = draft.hibernate;
  const state = getState();
  const effective = editingLink ? state.unread[editingLink.id] : null;
  const readout = effective
    ? `currently reading: <strong>${effective.source || 'none'}</strong> &rarr; <strong>${typeof effective.count === 'number' ? effective.count : (effective.activity ? 'activity' : 'nothing')}</strong>${effective.stale ? ' (stale — hibernated)' : ''}`
    : 'Save the link to see live readings here.';

  return `
    <div class="checkbox-row"><input type="checkbox" id="lk-unread-enabled" ${u.enabled ? 'checked' : ''} /><label for="lk-unread-enabled">Track unread activity for this link</label></div>
    <div class="readout" id="lk-readout">${readout}</div>

    <div class="settings-section" style="margin-top:14px;">
      <h3>Automatic signals (highest trust wins)</h3>
      <div class="checkbox-row"><input type="checkbox" id="lk-badge-enabled" ${u.badge.enabled ? 'checked' : ''} /><label for="lk-badge-enabled">Badging API — exact counts most web apps report natively</label></div>
      <div class="field">
        <label>Tab title pattern</label>
        <select id="lk-title-mode">
          <option value="auto" ${u.title.mode === 'auto' ? 'selected' : ''}>Auto — try common patterns like "(3) Inbox"</option>
          <option value="off" ${u.title.mode === 'off' ? 'selected' : ''}>Off</option>
        </select>
        <input type="text" id="lk-title-regex" style="margin-top:6px;" placeholder="Custom regex, group 1 = count (optional)" value="${u.title.regex || ''}" />
      </div>
      <div class="field">
        <label>Favicon (best-effort — boolean only)</label>
        <select id="lk-favicon-mode">
          <option value="auto" ${u.favicon.mode === 'auto' ? 'selected' : ''}>Auto — look for unread/alert keywords in the icon URL</option>
          <option value="off" ${u.favicon.mode === 'off' ? 'selected' : ''}>Off</option>
        </select>
      </div>
    </div>

    <details class="disclosure" id="lk-expert-disclosure" ${u.expert.enabled ? 'open' : ''}>
      <summary>Expert rule (highest priority)</summary>
      <div class="checkbox-row"><input type="checkbox" id="lk-expert-enabled" ${u.expert.enabled ? 'checked' : ''} /><label for="lk-expert-enabled">Enable expert rule</label></div>
      <div class="field">
        <label>CSS selector</label>
        <input type="text" id="lk-expert-selector" value="${u.expert.selector || ''}" placeholder="[role=treeitem][title^='Inbox']" />
      </div>
      <div class="field-row">
        <div class="field">
          <label>Read from</label>
          <select id="lk-expert-source">
            <option value="text" ${u.expert.source === 'text' ? 'selected' : ''}>Element text</option>
            <option value="attr" ${u.expert.source === 'attr' ? 'selected' : ''}>Attribute</option>
            <option value="count" ${u.expert.source === 'count' ? 'selected' : ''}>Match count</option>
            <option value="value" ${u.expert.source === 'value' ? 'selected' : ''}>Input value</option>
          </select>
        </div>
        <div class="field">
          <label>Attribute name</label>
          <input type="text" id="lk-expert-attr" value="${u.expert.attr || ''}" placeholder="title" ${u.expert.source === 'attr' ? '' : 'disabled'} />
        </div>
      </div>
      <div class="field">
        <label>Regex (group 1 = count)</label>
        <input type="text" id="lk-expert-regex" value="${u.expert.regex || ''}" placeholder="\\((\\d+)\\s*unread\\)" />
      </div>
      <div class="field-row">
        <div class="field">
          <label>Mode</label>
          <select id="lk-expert-mode">
            <option value="number" ${u.expert.mode === 'number' ? 'selected' : ''}>Number</option>
            <option value="presence" ${u.expert.mode === 'presence' ? 'selected' : ''}>Presence only</option>
          </select>
        </div>
        <div class="field">
          <label>Aggregate</label>
          <select id="lk-expert-aggregate">
            <option value="first" ${u.expert.aggregate === 'first' ? 'selected' : ''}>First match</option>
            <option value="sum" ${u.expert.aggregate === 'sum' ? 'selected' : ''}>Sum</option>
            <option value="max" ${u.expert.aggregate === 'max' ? 'selected' : ''}>Max</option>
          </select>
        </div>
        <div class="field">
          <label>Poll interval (ms)</label>
          <input type="number" id="lk-expert-interval" value="${u.expert.intervalMs || 15000}" min="2000" step="1000" />
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button class="btn small" id="lk-expert-test" ${editingLink ? '' : 'disabled'}>Test</button>
        <button class="btn small" id="lk-expert-pick" ${editingLink ? '' : 'disabled'}>Pick element</button>
        <button class="btn small" id="lk-expert-devtools" ${editingLink ? '' : 'disabled'}>DevTools</button>
      </div>
      <div class="readout" id="lk-expert-result" style="display:none;"></div>
      ${editingLink ? '' : '<div class="hint">Save the link first to test rules against the live page.</div>'}
    </details>

    <div class="settings-section" style="margin-top:14px;">
      <h3>Hibernation</h3>
      <div class="field">
        <label>Policy</label>
        <select id="lk-hib-policy">
          <option value="never" ${h.policy === 'never' ? 'selected' : ''}>Never hibernate</option>
          <option value="idle" ${h.policy === 'idle' ? 'selected' : ''}>Hibernate after idle</option>
          <option value="manual" ${h.policy === 'manual' ? 'selected' : ''}>Manual only</option>
        </select>
      </div>
      <div class="field" id="lk-hib-minutes-field" style="${h.policy === 'idle' ? '' : 'display:none;'}">
        <label>Idle minutes</label>
        <input type="number" id="lk-hib-minutes" min="1" value="${h.minutes || 30}" />
      </div>
      <div class="checkbox-row"><input type="checkbox" id="lk-hib-keepawake" ${h.keepAwake ? 'checked' : ''} /><label for="lk-hib-keepawake">Keep awake while unread/notifications are enabled</label></div>
      <div class="warning-box" id="lk-hib-warning" style="display:none;">
        ${icons.alertTriangle}
        <span>This link tracks unread/notifications but can hibernate — it will silently stop reporting while asleep. <button class="btn small" id="lk-hib-fix" style="margin-left:6px;">Keep awake instead</button></span>
      </div>
    </div>
  `;
}

function checkHibernateConflict() {
  const warn = document.getElementById('lk-hib-warning');
  if (!warn) return;
  const conflict = draft.hibernate.policy !== 'never' && !draft.hibernate.keepAwake &&
    (draft.unread.enabled || draft.notifications.enabled);
  warn.style.display = conflict ? 'flex' : 'none';
}

function wireTabButtons() {
  host.querySelectorAll('.dialog-tab').forEach((el) => {
    el.addEventListener('click', () => {
      activeTab = el.dataset.tab;
      renderBody();
    });
  });
}

function renderBody() {
  host.querySelectorAll('.dialog-tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === activeTab));
  const body = host.querySelector('.dialog-body');
  body.innerHTML = activeTab === 'general' ? generalTabHtml() : unreadTabHtml();
  if (activeTab === 'general') wireGeneralTab();
  else wireUnreadTab();
}

function bind(id, evt, getValue, apply) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener(evt, () => apply(getValue(el)));
}

function wireGeneralTab() {
  bind('lk-name', 'input', (el) => el.value, (v) => { draft.name = v; });
  bind('lk-url', 'input', (el) => el.value, (v) => { draft.url = v; });
  bind('lk-group', 'change', (el) => el.value || null, (v) => { draft.groupId = v; });
  bind('lk-zoom', 'input', (el) => parseInt(el.value, 10) || 100, (v) => { draft.zoom = v / 100; });
  bind('lk-fallback-letter', 'input', (el) => el.value.trim() || null, (v) => { draft.icon.fallbackLetter = v; });
  bind('lk-fallback-color', 'input', (el) => el.value, (v) => { draft.icon.fallbackColor = v; });
  bind('lk-muted', 'change', (el) => el.checked, (v) => { draft.muted = v; });
  bind('lk-open-on-startup', 'change', (el) => el.checked, (v) => { draft.openOnStartup = v; });
  bind('lk-notif-enabled', 'change', (el) => el.checked, (v) => { draft.notifications.enabled = v; });
  bind('lk-notif-sound', 'change', (el) => el.checked, (v) => { draft.notifications.sound = v; });
  bind('lk-notif-synth', 'change', (el) => el.value, (v) => { draft.notifications.synthesize = v; });
  bind('lk-ua', 'input', (el) => el.value.trim() || null, (v) => { draft.userAgent = v; });
  bind('lk-open-external', 'change', (el) => el.checked, (v) => { draft.navigation.openExternal = v; });
  // Setting this by hand counts as a decision too, same as answering the
  // live Allow/Block prompt — either way we shouldn't ask again later.
  bind('lk-allow-media', 'change', (el) => el.checked, (v) => { draft.navigation.allowMedia = v; draft.navigation.mediaDecided = true; });
  bind('lk-allow-location', 'change', (el) => el.checked, (v) => { draft.navigation.allowLocation = v; draft.navigation.locationDecided = true; });

  const urlInput = document.getElementById('lk-url');
  const nameInput = document.getElementById('lk-name');
  const hint = document.getElementById('lk-probe-hint');
  urlInput.addEventListener('blur', async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    hint.textContent = 'Probing…';
    const result = await window.myApps.invoke('link:probe-url', url);
    if (result && result.ok) {
      hint.textContent = result.title ? `Detected: ${result.title}` : 'Reachable.';
      if (!nameInput.value.trim() && result.title) {
        nameInput.value = result.title;
        draft.name = result.title;
      }
    } else {
      hint.textContent = 'Could not reach that URL — you can still save it.';
    }
  });
}

function wireUnreadTab() {
  bind('lk-unread-enabled', 'change', (el) => el.checked, (v) => { draft.unread.enabled = v; checkHibernateConflict(); });
  bind('lk-badge-enabled', 'change', (el) => el.checked, (v) => { draft.unread.badge.enabled = v; });
  bind('lk-title-mode', 'change', (el) => el.value, (v) => { draft.unread.title.mode = v; });
  bind('lk-title-regex', 'input', (el) => el.value.trim() || null, (v) => { draft.unread.title.regex = v; });
  bind('lk-favicon-mode', 'change', (el) => el.value, (v) => { draft.unread.favicon.mode = v; });

  bind('lk-expert-enabled', 'change', (el) => el.checked, (v) => { draft.unread.expert.enabled = v; });
  bind('lk-expert-selector', 'input', (el) => el.value.trim(), (v) => { draft.unread.expert.selector = v; });
  bind('lk-expert-source', 'change', (el) => el.value, (v) => {
    draft.unread.expert.source = v;
    document.getElementById('lk-expert-attr').disabled = v !== 'attr';
  });
  bind('lk-expert-attr', 'input', (el) => el.value.trim(), (v) => { draft.unread.expert.attr = v; });
  bind('lk-expert-regex', 'input', (el) => el.value.trim(), (v) => { draft.unread.expert.regex = v; });
  bind('lk-expert-mode', 'change', (el) => el.value, (v) => { draft.unread.expert.mode = v; });
  bind('lk-expert-aggregate', 'change', (el) => el.value, (v) => { draft.unread.expert.aggregate = v; });
  bind('lk-expert-interval', 'input', (el) => parseInt(el.value, 10) || 15000, (v) => { draft.unread.expert.intervalMs = v; });

  bind('lk-hib-policy', 'change', (el) => el.value, (v) => {
    draft.hibernate.policy = v;
    document.getElementById('lk-hib-minutes-field').style.display = v === 'idle' ? '' : 'none';
    checkHibernateConflict();
  });
  bind('lk-hib-minutes', 'input', (el) => parseInt(el.value, 10) || 30, (v) => { draft.hibernate.minutes = v; });
  bind('lk-hib-keepawake', 'change', (el) => el.checked, (v) => { draft.hibernate.keepAwake = v; checkHibernateConflict(); });

  const fixBtn = document.getElementById('lk-hib-fix');
  if (fixBtn) {
    fixBtn.addEventListener('click', () => {
      draft.hibernate.keepAwake = true;
      document.getElementById('lk-hib-keepawake').checked = true;
      checkHibernateConflict();
    });
  }

  checkHibernateConflict();
  if (!editingLink) return;

  document.getElementById('lk-expert-test').addEventListener('click', async () => {
    const rule = { ...draft.unread.expert, enabled: true };
    const resultEl = document.getElementById('lk-expert-result');
    resultEl.style.display = 'block';
    resultEl.textContent = 'Testing…';
    const result = await window.myApps.invoke('link:test-expert-rule', editingLink.id, rule);
    if (!result || !result.ok) {
      resultEl.textContent = `✗ ${(result && result.error) || 'No match'}`;
    } else if (result.matched === 0) {
      resultEl.textContent = '✗ Selector matched 0 elements';
    } else {
      const value = rule.mode === 'presence' ? (result.presence ? 'present' : 'not present') : result.count;
      resultEl.textContent = `✓ matched ${result.matched} element(s) → ${value}`;
    }
  });

  document.getElementById('lk-expert-pick').addEventListener('click', () => {
    pickedHandler = (payload) => {
      draft.unread.expert.selector = payload.selector || '';
      const selectorInput = document.getElementById('lk-expert-selector');
      if (selectorInput) selectorInput.value = draft.unread.expert.selector;
      const resultEl = document.getElementById('lk-expert-result');
      if (resultEl) { resultEl.style.display = 'block'; resultEl.textContent = `Picked: ${payload.selector}`; }
    };
    window.myApps.invoke('link:pick-element', editingLink.id);
  });

  document.getElementById('lk-expert-devtools').addEventListener('click', () => {
    window.myApps.invoke('link:devtools', editingLink.id);
  });
}

export function openLinkDialog(link) {
  editingLink = link || null;
  draft = link ? draftFromLink(link) : defaultDraft();
  activeTab = 'general';
  window.myApps.send('ui:modal-open', true);

  host.innerHTML = `
    <div class="dialog wide">
      <div class="dialog-header">
        <h2>${link ? 'Edit link' : 'Add link'}</h2>
        <button class="dialog-close">${icons.x}</button>
      </div>
      <div class="dialog-tabs">
        <div class="dialog-tab active" data-tab="general">General</div>
        <div class="dialog-tab" data-tab="unread">Unread &amp; Hibernation</div>
      </div>
      <div class="dialog-body"></div>
      <div class="dialog-footer">
        ${link ? '<button class="btn danger" id="lk-delete">Delete</button>' : ''}
        <div style="flex:1"></div>
        <button class="btn" id="lk-cancel">Cancel</button>
        <button class="btn primary" id="lk-save">${link ? 'Save' : 'Add link'}</button>
      </div>
    </div>
  `;
  host.classList.add('open');
  wireTabButtons();
  renderBody();

  host.querySelector('.dialog-close').addEventListener('click', close);
  document.getElementById('lk-cancel').addEventListener('click', close);
  host.addEventListener('click', (e) => { if (e.target === host) close(); });

  document.getElementById('lk-save').addEventListener('click', async () => {
    if (!draft.url.trim()) { alert('Please enter a URL.'); return; }
    if (editingLink) {
      await window.myApps.invoke('link:update', editingLink.id, draft);
    } else {
      await window.myApps.invoke('link:create', draft);
    }
    close();
  });

  if (link) {
    document.getElementById('lk-delete').addEventListener('click', async () => {
      if (!confirm(`Delete "${link.name}"?`)) return;
      const deleteData = confirm('Also delete saved login data (sign out)?');
      await window.myApps.invoke('link:delete', link.id, { deleteData });
      close();
    });
  }
}
