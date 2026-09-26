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

// One note per exact page URL. Saving an empty note removes it.
export function openNoteDialog(url) {
  if (!url) return;
  const existing = getState().notes[url];
  window.myApps.send('ui:modal-open', true);
  host.innerHTML = `
    <div class="dialog">
      <div class="dialog-header">
        <h2>${existing ? 'Edit note' : 'Add note'}</h2>
        <button class="dialog-close">${icons.x}</button>
      </div>
      <div class="dialog-body">
        <div class="field">
          <label>Page</label>
          <div class="hint" style="word-break:break-all;">${escapeHtml(url)}</div>
        </div>
        <div class="field">
          <label>Note</label>
          <textarea id="note-text" rows="8" style="font-family:inherit;font-size:13px;" placeholder="Write a note about this page…">${escapeHtml(existing ? existing.text : '')}</textarea>
        </div>
      </div>
      <div class="dialog-footer">
        ${existing ? '<button class="btn danger" id="note-delete">Delete</button>' : ''}
        <div style="flex:1"></div>
        <button class="btn" id="note-cancel">Cancel</button>
        <button class="btn primary" id="note-save">Save</button>
      </div>
    </div>
  `;
  host.classList.add('open');

  const textEl = document.getElementById('note-text');
  setTimeout(() => textEl.focus(), 0);

  const save = async () => {
    await window.myApps.invoke('note:set', url, textEl.value);
    close();
  };

  host.querySelector('.dialog-close').addEventListener('click', close);
  document.getElementById('note-cancel').addEventListener('click', close);
  host.addEventListener('click', (e) => { if (e.target === host) close(); });
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  document.getElementById('note-save').addEventListener('click', save);

  if (existing) {
    document.getElementById('note-delete').addEventListener('click', async () => {
      if (confirm('Delete the note for this page?')) {
        await window.myApps.invoke('note:set', url, '');
        close();
      }
    });
  }
}
