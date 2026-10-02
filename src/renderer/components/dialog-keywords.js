import { getState } from '../state.js';
import { icons } from '../icons.js';

const host = document.getElementById('dialog-host');
const MIN_LENGTH = 3;

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

// One global list for every link. An empty list turns highlighting off.
export function openKeywordsDialog() {
  const current = getState().settings.highlightKeywords;
  const words = Array.isArray(current) ? current : [];
  window.myApps.send('ui:modal-open', true);
  host.innerHTML = `
    <div class="dialog">
      <div class="dialog-header">
        <h2>Highlight keywords</h2>
        <button class="dialog-close">${icons.x}</button>
      </div>
      <div class="dialog-body">
        <div class="field">
          <label>Keywords (one per line)</label>
          <textarea id="kw-text" rows="8" style="font-family:inherit;font-size:13px;" placeholder="invoice&#10;urgent&#10;your name">${escapeHtml(words.join('\n'))}</textarea>
          <div class="hint">Matches are highlighted on every link, ignoring upper/lower case. Each keyword needs at least 3 characters. Leave empty to turn highlighting off.</div>
          <div class="hint" id="kw-error" style="color:var(--danger, #ef4444);display:none;"></div>
        </div>
      </div>
      <div class="dialog-footer">
        <button class="btn danger" id="kw-clear">Clear all</button>
        <div style="flex:1"></div>
        <button class="btn" id="kw-cancel">Cancel</button>
        <button class="btn primary" id="kw-save">Save</button>
      </div>
    </div>
  `;
  host.classList.add('open');

  const textEl = document.getElementById('kw-text');
  setTimeout(() => textEl.focus(), 0);

  const save = async (list) => {
    const tooShort = list.filter((w) => w.length < MIN_LENGTH);
    if (tooShort.length) {
      const err = document.getElementById('kw-error');
      err.textContent = `Too short (minimum ${MIN_LENGTH} characters): ${tooShort.map((w) => `"${w}"`).join(', ')}`;
      err.style.display = '';
      return;
    }
    await window.myApps.invoke('settings:update', { highlightKeywords: list });
    close();
  };
  const typed = () => textEl.value.split('\n').map((w) => w.trim()).filter(Boolean);

  host.querySelector('.dialog-close').addEventListener('click', close);
  document.getElementById('kw-cancel').addEventListener('click', close);
  host.addEventListener('click', (e) => { if (e.target === host) close(); });
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(typed()); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  document.getElementById('kw-save').addEventListener('click', () => save(typed()));
  document.getElementById('kw-clear').addEventListener('click', () => save([]));
}
