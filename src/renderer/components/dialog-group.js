import { icons } from '../icons.js';

const host = document.getElementById('dialog-host');

const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', null];

function close() {
  host.classList.remove('open');
  host.innerHTML = '';
  window.myApps.send('ui:modal-open', false);
}

export function openGroupDialog(group) {
  const isEdit = !!group;
  window.myApps.send('ui:modal-open', true);
  host.innerHTML = `
    <div class="dialog">
      <div class="dialog-header">
        <h2>${isEdit ? 'Edit group' : 'New group'}</h2>
        <button class="dialog-close">${icons.x}</button>
      </div>
      <div class="dialog-body">
        <div class="field">
          <label>Name</label>
          <input type="text" id="grp-name" value="${isEdit ? group.name : ''}" placeholder="e.g. Work" />
        </div>
        <div class="field">
          <label>Color</label>
          <div class="color-swatches" id="grp-colors"></div>
        </div>
      </div>
      <div class="dialog-footer">
        ${isEdit ? '<button class="btn danger" id="grp-delete">Delete</button>' : ''}
        <div style="flex:1"></div>
        <button class="btn" id="grp-cancel">Cancel</button>
        <button class="btn primary" id="grp-save">${isEdit ? 'Save' : 'Create'}</button>
      </div>
    </div>
  `;
  host.classList.add('open');

  let selectedColor = isEdit ? group.color : null;
  const colorsEl = document.getElementById('grp-colors');
  colorsEl.innerHTML = COLORS.map((c) => `<span class="color-swatch${c === selectedColor ? ' selected' : ''}" data-color="${c || ''}" style="background:${c || 'var(--bg-hover)'}"></span>`).join('');
  colorsEl.querySelectorAll('.color-swatch').forEach((el) => {
    el.addEventListener('click', () => {
      selectedColor = el.dataset.color || null;
      colorsEl.querySelectorAll('.color-swatch').forEach((s) => s.classList.remove('selected'));
      el.classList.add('selected');
    });
  });

  host.querySelector('.dialog-close').addEventListener('click', close);
  document.getElementById('grp-cancel').addEventListener('click', close);
  host.addEventListener('click', (e) => { if (e.target === host) close(); });

  document.getElementById('grp-save').addEventListener('click', async () => {
    const name = document.getElementById('grp-name').value.trim() || 'New group';
    if (isEdit) {
      await window.myApps.invoke('group:update', group.id, { name, color: selectedColor });
    } else {
      await window.myApps.invoke('group:create', { name, color: selectedColor });
    }
    close();
  });

  if (isEdit) {
    document.getElementById('grp-delete').addEventListener('click', async () => {
      if (confirm(`Delete group "${group.name}"? Links inside it will move to Ungrouped.`)) {
        await window.myApps.invoke('group:delete', group.id, { deleteLinks: false });
        close();
      }
    });
  }
}
