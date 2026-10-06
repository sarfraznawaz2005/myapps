import { getState } from '../state.js';
import { icons } from '../icons.js';

const host = document.getElementById('dialog-host');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function close() {
  host.classList.remove('open');
  host.innerHTML = '';
  window.myApps.send('ui:modal-open', false);
}

// The key custom CSS is saved under: the page's host without "www.".
export function cssHostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (_e) { return ''; }
}

// One stylesheet per domain. Saving empty CSS removes it.
export function openCssDialog(url) {
  const domain = cssHostOf(url);
  if (!domain) return;
  const existing = getState().customCss[domain];
  window.myApps.send('ui:modal-open', true);
  host.innerHTML = `
    <div class="dialog">
      <div class="dialog-header">
        <h2>Custom CSS</h2>
        <button class="dialog-close">${icons.x}</button>
      </div>
      <div class="dialog-body">
        <div class="field">
          <label>Domain</label>
          <div class="hint">${escapeHtml(domain)} — applies to every page on this domain.</div>
        </div>
        <div class="field">
          <label>CSS</label>
          <textarea id="css-text" rows="12" spellcheck="false" style="font-family:Consolas,monospace;font-size:12.5px;" placeholder="body { font-size: 18px !important; }">${escapeHtml(existing ? existing.css : '')}</textarea>
        </div>
      </div>
      <div class="dialog-footer">
        ${existing ? '<button class="btn danger" id="css-delete">Remove</button>' : ''}
        <div style="flex:1"></div>
        <button class="btn" id="css-cancel">Cancel</button>
        <button class="btn primary" id="css-save">Save</button>
      </div>
    </div>
  `;
  host.classList.add('open');

  const textEl = document.getElementById('css-text');
  setTimeout(() => textEl.focus(), 0);

  const save = async () => {
    await window.myApps.invoke('css:set', domain, textEl.value);
    close();
  };

  host.querySelector('.dialog-close').addEventListener('click', close);
  document.getElementById('css-cancel').addEventListener('click', close);
  host.addEventListener('click', (e) => { if (e.target === host) close(); });
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  document.getElementById('css-save').addEventListener('click', save);

  if (existing) {
    document.getElementById('css-delete').addEventListener('click', async () => {
      if (confirm(`Remove the custom CSS for ${domain}?`)) {
        await window.myApps.invoke('css:set', domain, '');
        close();
      }
    });
  }
}
