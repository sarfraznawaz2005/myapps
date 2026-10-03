import { getState, setState } from '../state.js';
import { icons } from '../icons.js';
import { showToast } from './toast.js';

const host = document.getElementById('dialog-host');
let activeSection = 'links';
let editingUserscriptId = null; // null = list view, 'new' = add form, id = edit form
let editingCommandId = null;
let editSnapshot = null; // form values as they were when the edit box was opened

function getCurrentEditValues() {
  if (editingUserscriptId !== null) {
    const nameEl = document.getElementById('us-name');
    const matchesEl = document.getElementById('us-matches');
    const codeEl = document.getElementById('us-code');
    const enabledEl = document.getElementById('us-enabled-field');
    if (!nameEl || !matchesEl || !codeEl || !enabledEl) return null;
    return { name: nameEl.value, matches: matchesEl.value, code: codeEl.value, enabled: enabledEl.checked };
  }
  if (editingCommandId !== null) {
    const nameEl = document.getElementById('cmd-name');
    const commandEl = document.getElementById('cmd-command');
    const enabledEl = document.getElementById('cmd-enabled-field');
    if (!nameEl || !commandEl || !enabledEl) return null;
    return { name: nameEl.value, command: commandEl.value, enabled: enabledEl.checked };
  }
  return null;
}

function close() {
  const current = getCurrentEditValues();
  const dirty = current && editSnapshot && JSON.stringify(current) !== JSON.stringify(editSnapshot);
  if (dirty && !confirm('You have an unsaved edit open. Close without saving?')) {
    return;
  }
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

// Mirrors geolocation.js's parseManualLocation — kept in sync by hand since
// the renderer can't require() the main-process file directly.
function isValidLatLon(value) {
  const parts = value.split(',').map((p) => p.trim());
  if (parts.length !== 2) return false;
  const [lat, lon] = parts.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function linkRowMarkup(l) {
  return `
    <div class="settings-link-row" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
      <input type="checkbox" class="link-enabled" data-id="${l.id}" ${l.enabled ? 'checked' : ''} title="Enabled" />
      <span style="flex:1;font-size:12.5px;${l.enabled ? '' : 'color:var(--text-dim);'}">${escapeHtml(l.name)}</span>
    </div>
  `;
}

function linksSection(links, groups) {
  const sortedGroups = groups.slice().sort((a, b) => a.order - b.order);
  const inGroupOrder = (gid) => links
    .filter((l) => (l.groupId || null) === gid && l.enabled)
    .sort((a, b) => a.order - b.order);

  const groupBlocks = sortedGroups.map((g) => {
    const glinks = inGroupOrder(g.id);
    if (!glinks.length) return '';
    return `
      <div class="settings-group-block" style="margin-bottom:10px;">
        <div class="hint" style="font-weight:600;margin:8px 0 4px;">${escapeHtml(g.name)}</div>
        ${glinks.map(linkRowMarkup).join('')}
      </div>
    `;
  }).join('');

  const ungrouped = inGroupOrder(null);
  const ungroupedBlock = ungrouped.length ? `
    <div class="settings-group-block" style="margin-bottom:10px;">
      <div class="hint" style="font-weight:600;margin:8px 0 4px;">Ungrouped</div>
      ${ungrouped.map(linkRowMarkup).join('')}
    </div>
  ` : '';

  // Unloaded links show last, out of their original group, so they're all
  // in one place instead of scattered wherever they used to live.
  const unloaded = links.filter((l) => !l.enabled).sort((a, b) => a.name.localeCompare(b.name));
  const unloadedBlock = unloaded.length ? `
    <div class="settings-group-block" style="margin-top:14px;">
      <div class="hint" style="font-weight:600;margin:8px 0 4px;">Unloaded</div>
      ${unloaded.map(linkRowMarkup).join('')}
    </div>
  ` : '';

  const empty = links.length ? '' : '<div class="hint">No links added yet.</div>';

  return `
    <div class="settings-section">
      <h3>Links</h3>
      <div class="hint" style="margin-bottom:8px;">Uncheck a link to unload it. An unloaded link disappears from the sidebar and never loads, so it uses no memory. Re-check it any time to bring it back.</div>
      ${empty}${groupBlocks}${ungroupedBlock}${unloadedBlock}
    </div>
  `;
}

function generalSection(s) {
  return `
    <div class="settings-section">
      <h3>Startup &amp; window</h3>
      ${checkboxRow('st-start-os', 'Start with Windows', s.startWithOS)}
      ${checkboxRow('st-start-min', 'Start minimized', s.startMinimized)}
      ${checkboxRow('st-close-tray', 'Close button minimizes to tray', s.closeToTray)}
      ${checkboxRow('st-show-tray', 'Show tray icon', s.showTrayIcon)}
    </div>
    <div class="settings-section">
      <h3>Browsing</h3>
      ${checkboxRow('st-open-ext', 'Open unrelated links in the default browser by default', s.openExternalLinksInBrowser)}
      ${checkboxRow('st-confirm-delete', 'Confirm before deleting a link', s.confirmDelete)}
    </div>
    <div class="settings-section">
      <h3>Network</h3>
      <div class="field">
        <label>DNS resolver</label>
        <select id="st-dns-provider">
          <option value="system" ${s.dnsProvider === 'system' ? 'selected' : ''}>System default</option>
          <option value="google" ${s.dnsProvider === 'google' ? 'selected' : ''}>Google (8.8.8.8)</option>
          <option value="cloudflare" ${s.dnsProvider === 'cloudflare' ? 'selected' : ''}>Cloudflare (1.1.1.1)</option>
          <option value="custom" ${s.dnsProvider === 'custom' ? 'selected' : ''}>Custom</option>
        </select>
      </div>
      <div class="field" id="st-dns-custom-field" style="${s.dnsProvider === 'custom' ? '' : 'display:none;'}">
        <label>Custom DNS-over-HTTPS URL</label>
        <input type="text" id="st-dns-custom-server" value="${escapeHtml(s.dnsCustomServer || '')}" placeholder="https://dns.example.com/dns-query" />
      </div>
      <div class="hint">Applies to every link opened in this app. Uses DNS-over-HTTPS, so lookups are encrypted.</div>
    </div>
    <div class="settings-section">
      <h3>Location</h3>
      <div class="field">
        <label>Manual location (latitude,longitude)</label>
        <input type="text" id="st-manual-location" value="${escapeHtml(s.manualLocation || '')}" placeholder="e.g. 40.7128,-74.0060" />
      </div>
      <div class="hint" id="st-manual-location-hint">Leave blank to ask Windows for your real location. If set, this exact position is sent to every site that asks — Windows is never asked.</div>
    </div>
  `;
}

function featuresSection(s) {
  return `
    <div class="settings-section">
      <h3>Pictures</h3>
      ${checkboxRow('st-image-zoom', 'Zoom pictures on hover', s.imageZoom)}
      <div class="hint">Move the mouse over a picture on any site to see it enlarged next to the mouse. Small icons and pictures that are already full size are skipped. Click anywhere to hide it.</div>
    </div>
    <div class="settings-section">
      <h3>Page tools</h3>
      ${checkboxRow('st-scroll-arrows', 'Show scroll up/down arrows on sites', s.scrollArrows)}
    </div>
    <div class="settings-section">
      <h3>Text &amp; passwords</h3>
      ${checkboxRow('st-spellcheck', 'Spellcheck text fields', s.spellcheck)}
      ${checkboxRow('st-reveal-pw', 'Show an eye button on password fields to reveal what you typed', s.revealPassword)}
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

async function passwordsSection(s) {
  const info = await window.myApps.invoke('pm:manage-list');
  const entries = (info && info.entries) || [];
  const never = (info && info.never) || [];
  const warn = info && !info.available
    ? '<div class="hint" style="color:var(--danger);margin-bottom:8px;">Windows encryption is not available, so passwords cannot be saved.</div>'
    : '';

  const rows = entries.length ? entries.map((e) => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
      <span style="flex:1;font-size:12.5px;">${escapeHtml(e.host)} <span class="hint">— ${escapeHtml(e.username || '(no username)')}</span></span>
      <button class="btn small danger pm-delete" data-id="${escapeHtml(e.id)}">Delete</button>
    </div>
  `).join('') : '<div class="hint">No saved passwords.</div>';

  const neverRows = never.length ? `
    <div class="hint" style="font-weight:600;margin:14px 0 4px;">Never save for these sites</div>
    ${never.map((host) => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
        <span style="flex:1;font-size:12.5px;">${escapeHtml(host)}</span>
        <button class="btn small pm-unnever" data-host="${escapeHtml(host)}">Allow again</button>
      </div>
    `).join('')}
  ` : '';

  return `
    <div class="settings-section">
      <h3>Password manager</h3>
      ${warn}
      ${checkboxRow('st-pm-enabled', 'Save and fill passwords on sites', s.passwordManager)}
      <div class="hint" style="margin-top:6px;">Off by default. When on, My Apps asks to save a login after you sign in, and shows your saved accounts when you click a login field. Passwords are encrypted with your Windows account and stored in <code>passwords.json</code> in the app data folder. They are not included in Export JSON. Only https sites are supported. Turning this off stops saving and filling but keeps what is saved.</div>
    </div>
    <div class="settings-section">
      <h3>Export Key</h3>
      <div class="hint" style="margin-bottom:8px;">Locks saved logins inside the file made by Export JSON (Data tab). With no key, logins are left out of the export. Import uses the saved key on its own; if this PC has no key, import asks for it. Keep the key somewhere safe. If you lose it, logins in old export files cannot be opened.</div>
      <div class="hint" id="pm-key-status" style="margin-bottom:8px;">${info && info.hasExportKey ? 'A key is saved on this PC.' : 'No key saved.'}</div>
      <div class="field">
        <label>Export Key (at least 6 characters)</label>
        <input type="password" id="pm-key-input" autocomplete="off" placeholder="${info && info.hasExportKey ? 'Type a new key to replace the saved one' : 'Type a key'}" />
      </div>
      <div class="hint" id="pm-key-error" style="color:var(--danger);display:none;"></div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="btn primary" id="pm-key-save">Save key</button>
        ${info && info.hasExportKey ? '<button class="btn danger" id="pm-key-clear">Remove key</button>' : ''}
      </div>
    </div>
    <div class="settings-section">
      <h3>Saved logins</h3>
      ${rows}
      ${neverRows}
      ${entries.length ? '<button class="btn danger" id="pm-clear-all" style="margin-top:12px;">Delete all saved passwords</button>' : ''}
    </div>
  `;
}

async function securitySection(s) {
  const status = await window.myApps.invoke('lock:status');
  const has = !!(status && status.hasPassword);
  const pwField = (id, label) => `
    <div class="field">
      <label>${label}</label>
      <input type="password" id="${id}" autocomplete="off" />
    </div>`;

  const form = has ? `
    <div class="settings-section">
      <h3>Change lock password</h3>
      ${pwField('lk-current', 'Current password')}
      ${pwField('lk-new', 'New password (at least 4 characters)')}
      ${pwField('lk-confirm', 'Repeat new password')}
      <div class="hint" id="lk-error" style="color:var(--danger);display:none;margin-bottom:8px;"></div>
      <button class="btn primary" id="lk-save">Change password</button>
    </div>
    <div class="settings-section">
      <h3>Auto-lock</h3>
      <div class="field">
        <label>Lock after this many idle minutes (0 = never)</label>
        <input type="number" id="lk-idle" min="0" max="1440" value="${Number(s.lockIdleMinutes) || 0}" />
        <div class="hint">Idle means no keyboard or mouse use anywhere on this PC.</div>
      </div>
    </div>
    <div class="settings-section">
      <h3>Remove lock</h3>
      ${pwField('lk-remove-current', 'Current password')}
      <div class="hint" id="lk-remove-error" style="color:var(--danger);display:none;margin-bottom:8px;"></div>
      <button class="btn danger" id="lk-remove">Remove lock password</button>
    </div>
  ` : `
    <div class="settings-section">
      <h3>Set a lock password</h3>
      ${pwField('lk-new', 'Password (at least 4 characters)')}
      ${pwField('lk-confirm', 'Repeat password')}
      <div class="hint" id="lk-error" style="color:var(--danger);display:none;margin-bottom:8px;"></div>
      <button class="btn primary" id="lk-save">Set lock password</button>
    </div>
  `;

  return `
    <div class="settings-section">
      <h3>App lock</h3>
      <div class="hint">${has ? 'A lock password is set. The app locks when it starts, when you click Lock in the sidebar More menu, or press Ctrl+Shift+L.' : 'No lock password is set. When you set one, the app asks for it every time it starts, and no link opens until you unlock.'}</div>
      <div class="hint" style="margin-top:8px;">This keeps people away from the open app. It does not protect the files on your disk. Use a Windows password and BitLocker for that. There is no "forgot password": if you lose it, the lock cannot be reset from inside the app.</div>
    </div>
    <div class="settings-section">
      <h3>Notification contents</h3>
      ${checkboxRow('st-notif-contents', 'Show sender and message text in notifications', s.showNotificationContents !== false)}
      <div class="hint">When off, notifications only say "New notification" and hide who sent it and what it says. This may not work for all sites: some sites only report an unread count, and those notifications never include message text anyway.</div>
    </div>
    ${form}
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
      <div class="hint" style="margin-bottom:8px;">Runs your own JavaScript on matching sites, once per page load.</div>
      ${rows}
      ${!editing ? '<button class="btn" id="us-add" style="margin-top:10px;">+ Add userscript</button>' : ''}
    </div>
    ${form}
  `;
}

function commandsSection(commands, editingId) {
  const editing = editingId !== null;
  const editTarget = editingId && editingId !== 'new' ? commands.find((c) => c.id === editingId) : null;

  const rows = commands.length ? commands.map((c) => `
    <div class="command-row" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
      <input type="checkbox" class="cmd-enabled" data-id="${c.id}" ${c.enabled ? 'checked' : ''} title="Enabled" />
      <span style="flex:1;font-size:12.5px;">${escapeHtml(c.name || 'Untitled')}</span>
      <button class="btn small cmd-edit" data-id="${c.id}">Edit</button>
      <button class="btn small danger cmd-delete" data-id="${c.id}">Delete</button>
    </div>
  `).join('') : '<div class="hint">No commands yet.</div>';

  const form = editing ? `
    <div class="settings-section">
      <h3>${editTarget ? 'Edit command' : 'New command'}</h3>
      <div class="field">
        <label>Name</label>
        <input type="text" id="cmd-name" value="${escapeHtml(editTarget ? editTarget.name : '')}" />
      </div>
      <div class="field">
        <label>Command</label>
        <input type="text" id="cmd-command" value="${escapeHtml(editTarget ? editTarget.command : '')}" placeholder="mailpile --http --port 33411" />
      </div>
      ${checkboxRow('cmd-enabled-field', 'Enabled', editTarget ? editTarget.enabled : true)}
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="btn primary" id="cmd-save">Save</button>
        <button class="btn" id="cmd-cancel">Cancel</button>
      </div>
    </div>
  ` : '';

  return `
    <div class="settings-section">
      <h3>Commands</h3>
      <div class="hint" style="margin-bottom:8px;">Runs in the background, non-blocking, every time the app starts.</div>
      ${rows}
      ${!editing ? '<button class="btn" id="cmd-add" style="margin-top:10px;">+ Add command</button>' : ''}
    </div>
    ${form}
  `;
}

// Small in-dialog form (window.prompt isn't available in Electron). Resolves
// to the typed key, or null if cancelled.
function askImportKey(message) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'settings-section';
    box.innerHTML = `
      <h3>Export Key needed</h3>
      <div class="hint" style="margin-bottom:8px;">This file has saved logins. Type the Export Key that was used when it was made.</div>
      <div class="hint" style="color:var(--danger);margin-bottom:8px;${message ? '' : 'display:none;'}">${escapeHtml(message)}</div>
      <div class="field"><input type="password" id="imp-key-input" autocomplete="off" /></div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <button class="btn primary" id="imp-key-ok">Unlock and import</button>
        <button class="btn" id="imp-key-cancel">Cancel</button>
      </div>
    `;
    host.querySelector('.dialog-body').prepend(box);
    const input = box.querySelector('#imp-key-input');
    input.focus();
    const done = (value) => { box.remove(); resolve(value); };
    box.querySelector('#imp-key-ok').addEventListener('click', () => done(input.value));
    box.querySelector('#imp-key-cancel').addEventListener('click', () => done(null));
  });
}

function dataSection() {
  return `
    <div class="settings-section">
      <h3>Backup</h3>
      <div class="hint" style="margin-bottom:8px;">Saved logins are included only if an Export Key is set in the Passwords tab. They are locked with that key.</div>
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

async function aboutSection() {
  const result = await window.myApps.invoke('app:check-update');
  const current = escapeHtml(result.currentVersion || '?');

  let updateHtml;
  if (result.ok && result.hasUpdate) {
    updateHtml = `
      <div class="readout" style="margin-top:10px;">
        <strong>Update available: v${escapeHtml(result.latestVersion)}</strong>
        <div style="margin-top:6px;">
          <button class="btn primary small" id="about-update-btn" data-url="${escapeHtml(result.url)}">Download</button>
        </div>
      </div>
    `;
  } else if (result.ok) {
    updateHtml = `<div class="hint" style="margin-top:10px;">You're on the latest version.</div>`;
  } else {
    updateHtml = `<div class="hint" style="margin-top:10px;">Couldn't check for updates.</div>`;
  }

  return `
    <div class="settings-section">
      <h3>About My Apps</h3>
      <p style="color:var(--text-dim);font-size:12.5px;line-height:1.6;">
        A lightweight multi-service desktop wrapper. Add your own links, organize them into groups,
        and get per-link unread badges, notifications, and true hibernation — without the overhead
        of a full framework-based shell.
      </p>
      <div class="hint">Version <strong>${current}</strong></div>
      ${updateHtml}
    </div>
  `;
}

async function renderSection() {
  const s = getState().settings;
  const body = host.querySelector('.dialog-body');
  if (activeSection === 'links') body.innerHTML = linksSection(getState().links || [], getState().groups || []);
  else if (activeSection === 'general') body.innerHTML = generalSection(s);
  else if (activeSection === 'features') body.innerHTML = featuresSection(s);
  else if (activeSection === 'notifications') body.innerHTML = notificationsSection(s);
  else if (activeSection === 'appearance') body.innerHTML = appearanceSection(s);
  else if (activeSection === 'performance') { body.innerHTML = '<div class="hint">Loading…</div>'; body.innerHTML = await performanceSection(); }
  else if (activeSection === 'passwords') { body.innerHTML = '<div class="hint">Loading…</div>'; body.innerHTML = await passwordsSection(s); }
  else if (activeSection === 'security') { body.innerHTML = '<div class="hint">Loading…</div>'; body.innerHTML = await securitySection(s); }
  else if (activeSection === 'userscripts') body.innerHTML = userscriptsSection(getState().userscripts || [], editingUserscriptId);
  else if (activeSection === 'commands') body.innerHTML = commandsSection(getState().commands || [], editingCommandId);
  else if (activeSection === 'data') body.innerHTML = dataSection();
  else { body.innerHTML = '<div class="hint">Loading…</div>'; body.innerHTML = await aboutSection(); }
  wireSection(s);
  editSnapshot = getCurrentEditValues();
}

function wireSection(s) {
  const map = {
    'st-start-os': ['startWithOS', 'checked'],
    'st-start-min': ['startMinimized', 'checked'],
    'st-close-tray': ['closeToTray', 'checked'],
    'st-show-tray': ['showTrayIcon', 'checked'],
    'st-open-ext': ['openExternalLinksInBrowser', 'checked'],
    'st-spellcheck': ['spellcheck', 'checked'],
    'st-pm-enabled': ['passwordManager', 'checked'],
    'st-reveal-pw': ['revealPassword', 'checked'],
    'st-confirm-delete': ['confirmDelete', 'checked'],
    'st-notify-unfocused': ['notifyOnlyWhenUnfocused', 'checked'],
    'st-notif-contents': ['showNotificationContents', 'checked'],
    'st-flash-taskbar': ['flashTaskbar', 'checked'],
    'st-overlay': ['showOverlayIcon', 'checked'],
    'st-scroll-arrows': ['scrollArrows', 'checked'],
    'st-image-zoom': ['imageZoom', 'checked'],
    'st-overlay-style': ['overlayStyle', 'value'],
    'st-theme': ['theme', 'value'],
    'st-default-hib': ['defaultHibernate', 'value'],
    'st-dns-provider': ['dnsProvider', 'value'],
  };
  Object.entries(map).forEach(([id, [key, prop]]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener(prop === 'checked' ? 'change' : 'change', async () => {
      const value = el[prop];
      await window.myApps.invoke('settings:update', { [key]: value });
      if (key === 'theme') document.documentElement.dataset.theme = value;
      if (key === 'dnsProvider') {
        const customField = document.getElementById('st-dns-custom-field');
        if (customField) customField.style.display = value === 'custom' ? '' : 'none';
      }
    });
  });

  const dnsCustomEl = document.getElementById('st-dns-custom-server');
  if (dnsCustomEl) {
    dnsCustomEl.addEventListener('change', () => {
      window.myApps.invoke('settings:update', { dnsCustomServer: dnsCustomEl.value.trim() });
    });
  }

  const manualLocEl = document.getElementById('st-manual-location');
  const manualLocHint = document.getElementById('st-manual-location-hint');
  const manualLocDefaultHint = 'Leave blank to ask Windows for your real location. If set, this exact position is sent to every site that asks — Windows is never asked.';
  if (manualLocEl) {
    manualLocEl.addEventListener('change', () => {
      const value = manualLocEl.value.trim();
      if (value && !isValidLatLon(value)) {
        manualLocHint.textContent = 'Enter as latitude,longitude — e.g. 40.7128,-74.0060 (latitude -90 to 90, longitude -180 to 180).';
        manualLocHint.style.color = 'var(--danger)';
        return;
      }
      manualLocHint.textContent = manualLocDefaultHint;
      manualLocHint.style.color = '';
      window.myApps.invoke('settings:update', { manualLocation: value });
    });
  }

  document.querySelectorAll('.pm-delete').forEach((el) => {
    el.addEventListener('click', async () => {
      if (!confirm('Delete this saved password?')) return;
      await window.myApps.invoke('pm:delete', el.dataset.id);
      renderSection();
    });
  });
  document.querySelectorAll('.pm-unnever').forEach((el) => {
    el.addEventListener('click', async () => {
      await window.myApps.invoke('pm:unnever', el.dataset.host);
      renderSection();
    });
  });
  const lkSave = document.getElementById('lk-save');
  if (lkSave) {
    const showErr = (id, text) => {
      const el = document.getElementById(id);
      el.textContent = text;
      el.style.display = text ? '' : 'none';
    };
    const lockError = (res) => {
      if (res.error === 'wrong') return 'Wrong current password.';
      if (res.error === 'wait') return `Too many wrong tries. Wait ${res.waitSeconds}s.`;
      if (res.error === 'short') return `Password must be at least ${res.min} characters.`;
      return 'Could not save the password.';
    };
    lkSave.addEventListener('click', async () => {
      const next = document.getElementById('lk-new').value;
      if (next !== document.getElementById('lk-confirm').value) { showErr('lk-error', 'The two passwords do not match.'); return; }
      const currentEl = document.getElementById('lk-current');
      const res = await window.myApps.invoke('lock:set', { password: next, current: currentEl ? currentEl.value : undefined });
      if (!res || !res.ok) { showErr('lk-error', lockError(res || {})); return; }
      showToast({ type: 'success', message: 'Lock password saved.' });
      renderSection();
    });
    const lkRemove = document.getElementById('lk-remove');
    if (lkRemove) {
      lkRemove.addEventListener('click', async () => {
        if (!confirm('Remove the lock password? The app will no longer ask for it.')) return;
        const res = await window.myApps.invoke('lock:remove', document.getElementById('lk-remove-current').value);
        if (!res || !res.ok) { showErr('lk-remove-error', lockError(res || {})); return; }
        showToast({ type: 'success', message: 'Lock password removed.' });
        renderSection();
      });
    }
    const lkIdle = document.getElementById('lk-idle');
    if (lkIdle) {
      lkIdle.addEventListener('change', () => {
        const minutes = Math.min(1440, Math.max(0, parseInt(lkIdle.value, 10) || 0));
        lkIdle.value = minutes;
        window.myApps.invoke('settings:update', { lockIdleMinutes: minutes });
      });
    }
  }

  const pmKeySave = document.getElementById('pm-key-save');
  if (pmKeySave) {
    pmKeySave.addEventListener('click', async () => {
      const input = document.getElementById('pm-key-input');
      const err = document.getElementById('pm-key-error');
      const res = await window.myApps.invoke('pm:key-set', input.value);
      if (!res.ok) {
        err.textContent = res.error;
        err.style.display = '';
        return;
      }
      renderSection();
    });
  }
  const pmKeyClear = document.getElementById('pm-key-clear');
  if (pmKeyClear) {
    pmKeyClear.addEventListener('click', async () => {
      if (!confirm('Remove the saved Export Key? Later exports will leave out saved logins.')) return;
      await window.myApps.invoke('pm:key-clear');
      renderSection();
    });
  }
  const pmClearAll = document.getElementById('pm-clear-all');
  if (pmClearAll) {
    pmClearAll.addEventListener('click', async () => {
      if (!confirm('Delete ALL saved passwords? This cannot be undone.')) return;
      await window.myApps.invoke('pm:clear-all');
      renderSection();
    });
  }

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
  document.querySelectorAll('.link-enabled').forEach((el) => {
    el.addEventListener('change', async () => {
      await window.myApps.invoke('link:update', el.dataset.id, { enabled: el.checked });
      if (activeSection === 'links') renderSection();
    });
  });
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
      const wasEditingId = editingUserscriptId;
      let saved;
      if (wasEditingId === 'new') {
        saved = await window.myApps.invoke('userscript:create', data);
      } else {
        // Updating an existing entry in place has proven unreliable here,
        // so replicate the delete-then-recreate flow that always works.
        await window.myApps.invoke('userscript:delete', wasEditingId);
        saved = await window.myApps.invoke('userscript:create', data);
      }
      if (saved) {
        const list = getState().userscripts.filter((u) => u.id !== wasEditingId && u.id !== saved.id);
        list.push(saved);
        setState({ userscripts: list });
      }
      editingUserscriptId = null;
      renderSection();
    });
  }

  document.querySelectorAll('.cmd-enabled').forEach((el) => {
    el.addEventListener('change', () => {
      window.myApps.invoke('command:update', el.dataset.id, { enabled: el.checked });
    });
  });
  document.querySelectorAll('.cmd-edit').forEach((el) => {
    el.addEventListener('click', () => { editingCommandId = el.dataset.id; renderSection(); });
  });
  document.querySelectorAll('.cmd-delete').forEach((el) => {
    el.addEventListener('click', async () => {
      if (!confirm('Delete this command?')) return;
      await window.myApps.invoke('command:delete', el.dataset.id);
      renderSection();
    });
  });
  const cmdAddBtn = document.getElementById('cmd-add');
  if (cmdAddBtn) cmdAddBtn.addEventListener('click', () => { editingCommandId = 'new'; renderSection(); });
  const cmdCancelBtn = document.getElementById('cmd-cancel');
  if (cmdCancelBtn) cmdCancelBtn.addEventListener('click', () => { editingCommandId = null; renderSection(); });
  const cmdSaveBtn = document.getElementById('cmd-save');
  if (cmdSaveBtn) {
    cmdSaveBtn.addEventListener('click', async () => {
      const name = document.getElementById('cmd-name').value.trim() || 'Untitled';
      const command = document.getElementById('cmd-command').value;
      const enabled = document.getElementById('cmd-enabled-field').checked;
      const data = { name, command, enabled };
      if (editingCommandId === 'new') await window.myApps.invoke('command:create', data);
      else await window.myApps.invoke('command:update', editingCommandId, data);
      editingCommandId = null;
      renderSection();
    });
  }

  const updateBtn = document.getElementById('about-update-btn');
  if (updateBtn) {
    updateBtn.addEventListener('click', () => window.myApps.invoke('app:open-external-url', updateBtn.dataset.url));
  }

  const importBtn = document.getElementById('st-import');
  const importFile = document.getElementById('st-import-file');
  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => {
      const file = importFile.files[0];
      if (!file) return;
      const text = await file.text();
      importFile.value = '';
      if (!confirm('Importing replaces all current links, groups, and settings. Saved logins in the file are added to the ones you have. Continue?')) return;
      let res = await window.myApps.invoke('settings:import', text);
      // The file holds logins and this PC has no (or the wrong) Export Key.
      let firstAsk = true;
      while (res && res.error) {
        if (res.error === 'unavailable') {
          alert('Windows encryption is not available, so saved logins cannot be imported. Nothing was changed.');
          return;
        }
        const key = await askImportKey(firstAsk && res.error === 'need-key' ? '' : 'That key did not work. Try again.');
        if (key === null) return; // cancelled: nothing was changed
        firstAsk = false;
        res = await window.myApps.invoke('settings:import', text, key);
      }
      close();
    });
  }
}

export function openSettingsDialog() {
  activeSection = 'links';
  editingUserscriptId = null;
  editingCommandId = null;
  window.myApps.send('ui:modal-open', true);

  const sections = [
    ['links', 'Links'],
    ['general', 'General'],
    ['features', 'Features'],
    ['notifications', 'Notifications'],
    ['appearance', 'Appearance'],
    ['performance', 'Performance'],
    ['passwords', 'Passwords'],
    ['security', 'Security'],
    ['userscripts', 'Userscripts'],
    ['commands', 'Commands'],
    ['data', 'Data'],
    ['about', 'About'],
  ];

  host.innerHTML = `
    <div class="dialog wide settings">
      <div class="dialog-header">
        <h2>Settings</h2>
        <button class="dialog-close">${icons.x}</button>
      </div>
      <div class="dialog-split">
        <div class="dialog-tabs vertical">
          ${sections.map(([id, label]) => `<div class="dialog-tab${id === 'links' ? ' active' : ''}" data-section="${id}">${label}</div>`).join('')}
        </div>
        <div class="dialog-body"></div>
      </div>
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
      editingCommandId = null;
      host.querySelectorAll('.dialog-tab').forEach((t) => t.classList.toggle('active', t === el));
      renderSection();
    });
  });

  host.querySelector('.dialog-close').addEventListener('click', close);
  document.getElementById('st-done').addEventListener('click', close);
  host.addEventListener('click', (e) => { if (e.target === host) close(); });

  renderSection();
}
