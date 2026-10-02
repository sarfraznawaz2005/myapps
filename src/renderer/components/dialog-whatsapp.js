import { getLink } from '../state.js';
import { icons } from '../icons.js';

const host = document.getElementById('dialog-host');

const GROUPS = [
  { title: 'Hide from screen spying', items: [
    ['blurNames', 'Blur contact names'],
    ['blurPhotos', 'Blur contact photos'],
    ['blurMessages', 'Blur conversation messages'],
    ['blurRecent', 'Blur recent messages'],
  ] },
  { title: 'Privacy', items: [
    ['hideOnline', 'Hide online status (invisible mode)', 'Contacts will not see you online.'],
    ['hideBlueTicks', 'Hide blue ticks', 'Others will not see that you read their messages.'],
    ['viewStatusPrivately', 'View statuses privately', 'The owner will not see that you viewed a status.'],
    ['restoreDeleted', 'Restore deleted messages', 'Shows the original text of messages deleted while this app was open. Kept in memory only, gone when the app closes.'],
  ] },
  { title: 'Notifications', items: [
    ['notifyOnline', 'Notify when a contact comes online', 'Desktop notification for the contacts listed below.'],
  ] },
];

function close() {
  host.classList.remove('open');
  host.innerHTML = '';
  window.myApps.send('ui:modal-open', false);
}

// Per-link: a standard and a business WhatsApp link each keep their own choices.
export async function openWhatsappDialog(linkId) {
  const link = getLink(linkId);
  if (!link) return;
  const data = await window.myApps.invoke('link:whatsapp-get', linkId);
  if (!data) return;
  let settings = data.settings;
  let status = data.status || {};

  window.myApps.send('ui:modal-open', true);
  const rows = GROUPS.map((group) => `
    <h4 style="margin:14px 0 4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.65;">${group.title}</h4>
    ${group.items.map(([key, label, hint]) => `
      <div class="checkbox-row" style="align-items:flex-start;">
        <input type="checkbox" id="wa-${key}" data-key="${key}" ${settings[key] ? 'checked' : ''} />
        <label for="wa-${key}">${label}${hint ? `<div class="hint">${hint}</div>` : ''}
          <div class="hint" id="wa-warn-${key}" style="color:var(--warning, #f0b429);display:none;">Could not attach to this version of WhatsApp Web (yet). It keeps retrying while WhatsApp is open.</div>
        </label>
      </div>`).join('')}
    ${group.title === 'Notifications' ? `
      <div class="field" style="margin-top:6px;">
        <textarea id="wa-contacts" rows="3" style="font-family:inherit;font-size:13px;" placeholder="One contact name or phone number per line">${escapeHtml(settings.notifyContacts.join('\n'))}</textarea>
      </div>` : ''}
  `).join('');

  host.innerHTML = `
    <div class="dialog">
      <div class="dialog-header">
        <h2>WhatsApp extras — ${escapeHtml(link.name)}</h2>
        <button class="dialog-close">${icons.x}</button>
      </div>
      <div class="dialog-body" style="max-height:70vh;overflow:auto;">
        <div class="hint">These settings belong to this link only and are saved automatically.</div>
        ${rows}
        <h4 style="margin:14px 0 4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.65;">Chat with a number</h4>
        <div class="field">
          <input type="text" id="wa-number" placeholder="Phone number with country code, e.g. 15551234567" />
          <div class="hint" id="wa-number-hint">Works for numbers that are not in your contacts.</div>
        </div>
        <button class="btn primary" id="wa-open-chat">Open chat</button>
      </div>
      <div class="dialog-footer">
        <div style="flex:1"></div>
        <button class="btn" id="wa-close">Close</button>
      </div>
    </div>
  `;
  host.classList.add('open');

  const showWarnings = () => {
    for (const group of GROUPS) {
      for (const [key] of group.items) {
        const warn = document.getElementById(`wa-warn-${key}`);
        if (warn) warn.style.display = settings[key] && status[key] === 'missing' ? 'block' : 'none';
      }
    }
  };
  showWarnings();

  const save = async (patch) => {
    settings = { ...settings, ...patch };
    const saved = await window.myApps.invoke('link:whatsapp-set', linkId, settings);
    if (saved) settings = saved;
    // The page needs a moment to try attaching, then reports back.
    setTimeout(async () => {
      const fresh = await window.myApps.invoke('link:whatsapp-get', linkId);
      if (fresh && document.getElementById('wa-close')) { status = fresh.status || {}; showWarnings(); }
    }, 1200);
    showWarnings();
  };

  host.querySelectorAll('input[type="checkbox"][data-key]').forEach((el) => {
    el.addEventListener('change', () => save({ [el.dataset.key]: el.checked }));
  });
  document.getElementById('wa-contacts').addEventListener('change', (e) => {
    save({ notifyContacts: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean) });
  });

  const openChat = async () => {
    const hint = document.getElementById('wa-number-hint');
    const ok = await window.myApps.invoke('link:whatsapp-chat', linkId, document.getElementById('wa-number').value);
    if (ok) { close(); return; }
    hint.textContent = 'Enter 7 to 15 digits including the country code, and keep this link on WhatsApp Web.';
    hint.style.color = 'var(--warning, #f0b429)';
  };
  document.getElementById('wa-open-chat').addEventListener('click', openChat);
  document.getElementById('wa-number').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); openChat(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  host.querySelector('.dialog-close').addEventListener('click', close);
  document.getElementById('wa-close').addEventListener('click', close);
  host.addEventListener('click', (e) => { if (e.target === host) close(); });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
