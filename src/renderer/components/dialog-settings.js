import { getState } from '../state.js';
import { icons } from '../icons.js';

const host = document.getElementById('dialog-host');
let activeSection = 'general';
let editingUserscriptId = null; // null = list view, 'new' = add form, id = edit form

function close() {
  host.classList.remove('open');
  host.innerHTML = '';
  window.myApps.send('ui:modal-open', false);
}

function checkboxRow(id, label, checked) {
  return `<div class="checkbox-row"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} /><label for="${id}">${label}</label></div>`;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function generalSection(s) {
  return `
    <div class="settings-section">
      <h3>Startup &amp; window</h3>
      ${checkboxRow('st-start-os', 'Start with Windows', s.startWithOS)}
      ${checkboxRow('st-start-min', 'Start minimized', s.startMinimized)}
      ${checkboxRow('st-close-tray', 'Close button minimizes to tray', s.closeToTray)}
      ${checkboxRow('st-min-tray', 'Minimize button minimizes to tray', s.minimizeToTray)}
      ${checkboxRow('st-show-tray', 'Show tray icon', s.showTrayIcon)}
    </div>
    <div class="settings-section">
      <h3>Browsing</h3>
      ${checkboxRow('st-open-ext', 'Open unrelated links in the default browser by default', s.openExternalLinksInBrowser)}
      ${checkboxRow('st-spellcheck', 'Spellcheck text fields', s.spellcheck)}
      ${checkboxRow('st-confirm-delete', 'Confirm before deleting a link', s.confirmDelete)}
    </div>
  `;
}

function notificationsSection(s) {
  return `
    <div class="settings-section">
      <h3>Notifications</h3>
      ${checkboxRow('st-notify-unfocused', 'Only notify when My Apps is unfocused', s.notifyOnlyWhenUnfocused)}
      ${checkboxRow('st-flash-taskbar', 'Flash taskbar on new activity', s.flashTaskbar)}
      <div class="field">
        <label>Do Not Disturb</label>
        ${checkboxRow('st-dnd', 'Enabled now', s.dnd && s.dnd.enabled)}
      </div>
    </div>
  `;
}

function appearanceSection(s) {
  return `
    <div class="settings-section">
      <h3>Theme</h3>
      <div class="field">
        <label>Theme</label>
        <select id="st-theme">
          <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Dark</option>
          <option value="light" ${s.theme === 'light' ? 'selected' : ''}>Light</option>
        </select>
      </div>
    </div>
    <div class="settings-section">
      <h3>Site page</h3>
      ${checkboxRow('st-scroll-arrows', 'Show scroll up/down arrows on sites', s.scrollArrows)}
    </div>
    <div class="settings-section">
      <h3>Taskbar indicator</h3>
      ${checkboxRow('st-overlay', 'Show unread overlay icon', s.showOverlayIcon)}
      <div class="field">
        <label>Overlay style</label>
        <select id="st-overlay-style">
          <option value="digit" ${s.overlayStyle === 'digit' ? 'selected' : ''}>Digit</option>
          <option value="dot" ${s.overlayStyle === 'dot' ? 'selected' : ''}>Dot</option>
        </select>
      </div>
    </div>
  `;
}

async function performanceSection() {
  const rows = await window.myApps.invoke('metrics:get');
  const totalMB = rows.reduce((sum, r) => sum + (r.memoryMB || 0), 0);
  return `
    <div class="settings-section">
      <h3>Memory (live)</h3>
      <table class="memory-table">
        <thead><tr><th>Process</th><th>Type</th><th>Memory</th><th>CPU</th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr><td>${r.linkName}</td><td>${r.type}</td><td>${r.memoryMB != null ? r.memoryMB + ' MB' : '—'}</td><td>${r.cpuPercent != null ? r.cpuPercent + '%' : '—'}</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="hint" style="margin-top:8px;">Total: ~${totalMB} MB across ${rows.length} process(es).</div>
    </div>
    <div class="settings-section">
      <h3>Hibernation</h3>
      <div class="field">
        <label>Default hibernation policy for new links</label>
        <select id="st-default-hib">
          <option value="never">Never</option>
          <option value="idle">Idle</option>
          <option value="manual">Manual only</option>
        </select>
      </div>
      <div class="field">
        <label>Hibernate everything after being minimized to tray for (minutes, 0 = off)</label>
        <input type="number" id="st-hib-tray-minutes" min="0" />
      </div>
    </div>
  `;
}

function userscriptsSection(userscripts, editingId) {
  const editing = editingId !== null;
  const editTarget = editingId && editingId !== 'new' ? userscripts.find((u) => u.id === editingId) : null;

  const rows = userscripts.length ? userscripts.map((u) => `
    <div class="userscript-row" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
      <input type="checkbox" class="us-enabled" data-id="${u.id}" ${u.enabled ? 'checked' : ''} title="Enabled" />
      <span style="flex:1;font-size:12.5px;">${escapeHtml(u.name || 'Untitled')}</span>
      <span class="hint">${(u.matches || []).length} pattern(s)</span>
      <button class="btn small us-edit" data-id="${u.id}">Edit</button>
      <button class="btn small danger us-delete" data-id="${u.id}">Delete</button>
    </div>
  `).join('') : '<div class="hint">No userscripts yet.</div>';

  const form = editing ? `
    <div class="settings-section">
      <h3>${editTarget ? 'Edit userscript' : 'New userscript'}</h3>
      <div class="field">
        <label>Name</label>
        <input type="text" id="us-name" value="${escapeHtml(editTarget ? editTarget.name : '')}" />
      </div>
      <div class="field">
        <label>Runs on (one URL pattern per line — use * as a wildcard)</label>
        <textarea id="us-matches" rows="3" placeholder="https://mail.google.com/*">${escapeHtml(editTarget ? (editTarget.matches || []).join('\n') : '')}</textarea>
      </div>
      <div class="field">
        <label>Code</label>
        <textarea id="us-code" rows="10" spellcheck="false">${escapeHtml(editTarget ? editTarget.code : '')}</textarea>
      </div>
      ${checkboxRow('us-enabled-field', 'Enabled', editTarget ? editTarget.enabled : true)}
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="btn primary" id="us-save">Save</button>
        <button class="btn" id="us-cancel">Cancel</button>
      </div>
    </div>
  ` : '';

  return `
    <div class="settings-section">
      <h3>Userscripts</h3>
      <div class="hint" style="margin-bottom:8px;">Runs your own JavaScript on matching sites, once per page load. Only add scripts you trust — they run with full access to that page.</div>
      ${rows}
      ${!editing ? '<button class="btn" id="us-add" style="margin-top:10px;">+ Add userscript</button>' : ''}
    </div>
    ${form}
  `;
}

function dataSection() {
  return `
    <div class="settings-section">
      <h3>Backup</h3>
      <div style="display:flex;gap:8px;">
        <button class="btn" id="st-export">${icons.download} Export JSON</button>
        <button class="btn" id="st-import">${icons.upload} Import JSON</button>
      </div>
      <input type="file" id="st-import-file" accept="application/json" style="display:none;" />
    </div>
    <div class="settings-section">
      <h3>Storage</h3>
      <div class="hint">Dev and packaged builds use different data folders (zip target, no installer) — see the README.</div>
    </div>
  `;
}

function aboutSection() {
  return `
    <div class="settings-section">
      <h3>About My Apps</h3>
      <p style="color:var(--text-dim);font-size:12.5px;line-height:1.6;">
        A lightweight multi-service desktop wrapper. Add your own links, organize them into groups,
        and get per-link unread badges, notifications, and true hibernation — without the overhead
        of a full framework-based shell.
      </p>
    </div>
  `;
}

async function renderSection() {
  const s = getState().settings;
  const body = host.querySelector('.dialog-body');
  if (activeSection === 'general') body.innerHTML = generalSection(s);
  else if (activeSection === 'notifications') body.innerHTML = notificationsSection(s);
  else if (activeSection === 'appearance') body.innerHTML = appearanceSection(s);
  else if (activeSection === 'performance') { body.innerHTML = '<div class="hint">Loading…</div>'; body.innerHTML = await performanceSection(); }
  else if (activeSection === 'userscripts') body.innerHTML = userscriptsSection(getState().userscripts || [], editingUserscriptId);
  else if (activeSection === 'data') body.innerHTML = dataSection();
  else body.innerHTML = aboutSection();
  wireSection(s);
}

function wireSection(s) {
  const map = {
    'st-start-os': ['startWithOS', 'checked'],
    'st-start-min': ['startMinimized', 'checked'],
    'st-close-tray': ['closeToTray', 'checked'],
    'st-min-tray': ['minimizeToTray', 'checked'],
    'st-show-tray': ['showTrayIcon', 'checked'],
    'st-open-ext': ['openExternalLinksInBrowser', 'checked'],
    'st-spellcheck': ['spellcheck', 'checked'],
    'st-confirm-delete': ['confirmDelete', 'checked'],
    'st-notify-unfocused': ['notifyOnlyWhenUnfocused', 'checked'],
    'st-flash-taskbar': ['flashTaskbar', 'checked'],
    'st-overlay': ['showOverlayIcon', 'checked'],
    'st-scroll-arrows': ['scrollArrows', 'checked'],
    'st-overlay-style': ['overlayStyle', 'value'],
    'st-theme': ['theme', 'value'],
    'st-default-hib': ['defaultHibernate', 'value'],
  };
  Object.entries(map).forEach(([id, [key, prop]]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener(prop === 'checked' ? 'change' : 'change', async () => {
      const value = el[prop];
      await window.myApps.invoke('settings:update', { [key]: value });
      if (key === 'theme') document.documentElement.dataset.theme = value;
    });
  });

  const dndEl = document.getElementById('st-dnd');
  if (dndEl) {
    dndEl.addEventListener('change', () => window.myApps.invoke('dnd:set', { enabled: dndEl.checked, until: null }));
  }

  const hibMinutes = document.getElementById('st-hib-tray-minutes');
  if (hibMinutes) {
    hibMinutes.value = s.hibernateOnTrayMinutes || 0;
    hibMinutes.addEventListener('change', () => {
      window.myApps.invoke('settings:update', { hibernateOnTrayMinutes: parseInt(hibMinutes.value, 10) || 0 });
    });
    const defHib = document.getElementById('st-default-hib');
    if (defHib) defHib.value = s.defaultHibernate;
  }

  const exportBtn = document.getElementById('st-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      const json = await window.myApps.invoke('settings:export');
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'myapps-export.json';
      a.click();
      URL.revokeObjectURL(url);
    });
  }
  document.querySelectorAll('.us-enabled').forEach((el) => {
    el.addEventListener('change', () => {
      window.myApps.invoke('userscript:update', el.dataset.id, { enabled: el.checked });
    });
  });
  document.querySelectorAll('.us-edit').forEach((el) => {
    el.addEventListener('click', () => { editingUserscriptId = el.dataset.id; renderSection(); });
  });
  document.querySelectorAll('.us-delete').forEach((el) => {
    el.addEventListener('click', async () => {
      if (!confirm('Delete this userscript?')) return;
      await window.myApps.invoke('userscript:delete', el.dataset.id);
      renderSection();
    });
  });
  const usAddBtn = document.getElementById('us-add');
  if (usAddBtn) usAddBtn.addEventListener('click', () => { editingUserscriptId = 'new'; renderSection(); });
  const usCancelBtn = document.getElementById('us-cancel');
  if (usCancelBtn) usCancelBtn.addEventListener('click', () => { editingUserscriptId = null; renderSection(); });
  const usSaveBtn = document.getElementById('us-save');
  if (usSaveBtn) {
    usSaveBtn.addEventListener('click', async () => {
      const name = document.getElementById('us-name').value.trim() || 'Untitled';
      const matches = document.getElementById('us-matches').value.split('\n').map((m) => m.trim()).filter(Boolean);
      const code = document.getElementById('us-code').value;
      const enabled = document.getElementById('us-enabled-field').checked;
      const data = { name, matches, code, enabled };
      if (editingUserscriptId === 'new') await window.myApps.invoke('userscript:create', data);
      else await window.myApps.invoke('userscript:update', editingUserscriptId, data);
      editingUserscriptId = null;
      renderSection();
    });
  }

  const importBtn = document.getElementById('st-import');
  const importFile = document.getElementById('st-import-file');
  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => {
      const file = importFile.files[0];
      if (!file) return;
      const text = await file.text();
      if (!confirm('Importing replaces all current links, groups, and settings. Continue?')) return;
      await window.myApps.invoke('settings:import', text);
      close();
    });
  }
}

export function openSettingsDialog() {
  activeSection = 'general';
  editingUserscriptId = null;
  window.myApps.send('ui:modal-open', true);

  const sections = [
    ['general', 'General'],
    ['notifications', 'Notifications'],
    ['appearance', 'Appearance'],
    ['performance', 'Performance'],
    ['userscripts', 'Userscripts'],
    ['data', 'Data'],
    ['about', 'About'],
  ];

  host.innerHTML = `
    <div class="dialog wide">
      <div class="dialog-header">
        <h2>Settings</h2>
        <button class="dialog-close">${icons.x}</button>
      </div>
      <div class="dialog-tabs">
        ${sections.map(([id, label]) => `<div class="dialog-tab${id === 'general' ? ' active' : ''}" data-section="${id}">${label}</div>`).join('')}
      </div>
      <div class="dialog-body"></div>
      <div class="dialog-footer">
        <button class="btn primary" id="st-done">Done</button>
      </div>
    </div>
  `;
  host.classList.add('open');

  host.querySelectorAll('.dialog-tab').forEach((el) => {
    el.addEventListener('click', () => {
      activeSection = el.dataset.section;
      editingUserscriptId = null;
      host.querySelectorAll('.dialog-tab').forEach((t) => t.classList.toggle('active', t === el));
      renderSection();
    });
  });

  host.querySelector('.dialog-close').addEventListener('click', close);
  document.getElementById('st-done').addEventListener('click', close);
  host.addEventListener('click', (e) => { if (e.target === host) close(); });

  renderSection();
}
