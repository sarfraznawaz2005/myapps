import { getState, setState, getLink, getGroup } from '../state.js';
import { icons } from '../icons.js';
import { openLinkDialog } from './dialog-link.js';
import { openGroupDialog } from './dialog-group.js';

const listEl = document.getElementById('sidebar-list');
const shellEl = document.getElementById('shell');
const sidebarEl = document.getElementById('sidebar');
const searchBox = document.getElementById('sidebar-search');
const searchInput = document.getElementById('sidebar-search-input');
const resizer = document.getElementById('sidebar-resizer');
const btnCollapse = document.getElementById('btn-collapse');
const btnSearch = document.getElementById('btn-search');
const btnAddLink = document.getElementById('btn-add-link');
const btnAddGroup = document.getElementById('btn-add-group');
const btnSettings = document.getElementById('btn-settings');
const btnDnd = document.getElementById('btn-dnd');
const btnEmptyAdd = document.getElementById('btn-empty-add');

let filterText = '';
let dragging = null; // { type: 'link'|'group', id }

function iconHtml(name) { return icons[name] || ''; }

function faviconMarkup(link, loading) {
  if (loading) return `<span class="favicon-loading">${iconHtml('reload')}</span>`;
  if (link.icon && link.icon.path) {
    return `<img src="file:///${link.icon.path.replace(/\\/g, '/')}" alt="" />`;
  }
  const letter = (link.icon && link.icon.fallbackLetter) || (link.name || '?').trim()[0] || '?';
  return letter.toUpperCase();
}

function statusMarkup(link) {
  const state = getState();
  const unread = state.unread[link.id] || {};
  const status = state.linkStatus[link.id] || {};
  const parts = [];

  if (link.muted) parts.push(`<span class="status-icon muted-icon" title="Muted">${iconHtml('bellOff')}</span>`);
  if (status.crashed || status.error) {
    parts.push(`<span class="status-icon error" title="${(status.error || 'Crashed').replace(/"/g, '')}">${iconHtml('alertTriangle')}</span>`);
  }

  if (unread.stale) {
    const label = typeof unread.count === 'number' ? `last known: ${unread.count}` : 'hibernated';
    parts.push(`<span class="pill stale" title="Hibernated — ${label}">${iconHtml('zzz')}</span>`);
  } else if (typeof unread.count === 'number' && unread.count > 0) {
    parts.push(`<span class="pill" title="${unread.count} unread (source: ${unread.source || 'unknown'})">${unread.count > 9 ? '9+' : unread.count}</span>`);
  } else if (unread.activity) {
    parts.push(`<span class="pill dot" title="Activity (source: ${unread.source || 'unknown'})"></span>`);
  }

  return parts.join('');
}

function groupAggregate(groupId) {
  const state = getState();
  let sum = 0;
  let hasActivity = false;
  state.links.filter((l) => (l.groupId || null) === groupId && l.enabled && !l.muted).forEach((l) => {
    const u = state.unread[l.id];
    if (!u || u.stale) return;
    if (typeof u.count === 'number' && u.count > 0) sum += u.count;
    else if (u.activity) hasActivity = true;
  });
  if (sum > 0) return String(sum > 99 ? '99+' : sum);
  if (hasActivity) return '•';
  return '';
}

function matchesFilter(link) {
  if (!filterText) return true;
  return link.name.toLowerCase().includes(filterText) || link.url.toLowerCase().includes(filterText);
}

function escapeAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function linkRowHtml(link) {
  const state = getState();
  const active = state.activeLinkId === link.id ? ' active' : '';
  const loading = !!(state.linkStatus[link.id] && state.linkStatus[link.id].loading);
  return `<div class="link-row${active}" draggable="true" data-link-id="${link.id}" title="${escapeAttr(link.name)}">
    <span class="link-favicon${loading ? ' loading' : ''}">${faviconMarkup(link, loading)}</span>
    <span class="link-name">${link.name}</span>
    <span class="link-status">${statusMarkup(link)}</span>
  </div>`;
}

function groupHtml(group) {
  const state = getState();
  const links = state.links
    .filter((l) => (l.groupId || null) === group.id && matchesFilter(l))
    .sort((a, b) => a.order - b.order);
  if (filterText && links.length === 0) return '';
  const collapsed = group.collapsed ? ' collapsed' : '';
  const agg = groupAggregate(group.id);
  const countLabel = `${links.length} link${links.length === 1 ? '' : 's'}`;
  return `<div class="group" data-group-id="${group.id}">
    <div class="group-header${collapsed}" data-group-id="${group.id}" title="${escapeAttr(group.name)} — ${escapeAttr(countLabel)}">
      <span class="chevron">${iconHtml('chevron')}</span>
      <span class="name">${group.name}</span>
      <span class="pill${agg ? ' has-count' : ''}">${agg}</span>
    </div>
    <div class="group-body${collapsed}">${links.map(linkRowHtml).join('')}</div>
  </div>`;
}

export function renderList() {
  const state = getState();
  const groups = state.groups.slice().sort((a, b) => a.order - b.order);
  const ungrouped = state.links
    .filter((l) => !l.groupId && matchesFilter(l))
    .sort((a, b) => a.order - b.order);

  let html = groups.map(groupHtml).join('');
  html += ungrouped.map(linkRowHtml).join('');
  listEl.innerHTML = html;

  document.getElementById('content-empty').style.display = state.links.length === 0 ? 'flex' : 'none';
  wireRowEvents();
}

export function updateRowStatus(linkId) {
  const row = listEl.querySelector(`.link-row[data-link-id="${linkId}"]`);
  const link = getLink(linkId);
  if (!row || !link) return;
  row.querySelector('.link-status').innerHTML = statusMarkup(link);
  const loading = !!(getState().linkStatus[linkId] && getState().linkStatus[linkId].loading);
  const favEl = row.querySelector('.link-favicon');
  if (favEl) {
    favEl.classList.toggle('loading', loading);
    favEl.innerHTML = faviconMarkup(link, loading);
  }
  if (link.groupId) {
    const header = listEl.querySelector(`.group-header[data-group-id="${link.groupId}"]`);
    if (header) {
      const agg = groupAggregate(link.groupId);
      const pill = header.querySelector('.pill');
      pill.textContent = agg;
      pill.classList.toggle('has-count', !!agg);
    }
  }
}

export function updateActiveRow() {
  const state = getState();
  listEl.querySelectorAll('.link-row.active').forEach((el) => el.classList.remove('active'));
  if (state.activeLinkId) {
    const row = listEl.querySelector(`.link-row[data-link-id="${state.activeLinkId}"]`);
    if (row) row.classList.add('active');
  }
}

function wireRowEvents() {
  listEl.querySelectorAll('.group-header').forEach((el) => {
    el.addEventListener('click', () => {
      const gid = el.dataset.groupId;
      const group = getGroup(gid);
      window.myApps.invoke('group:update', gid, { collapsed: !group.collapsed });
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openGroupDialog(getGroup(el.dataset.groupId));
    });
    el.addEventListener('dragover', (e) => {
      if (dragging && dragging.type === 'link') { e.preventDefault(); el.classList.add('dragover'); }
    });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('dragover');
      if (dragging && dragging.type === 'link') moveLinkToGroup(dragging.id, el.dataset.groupId, 0);
    });
  });

  listEl.querySelectorAll('.link-row').forEach((el) => {
    const id = el.dataset.linkId;
    el.addEventListener('click', () => window.myApps.invoke('link:activate', id));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      window.myApps.invoke('menu:link-context', id);
    });
    el.addEventListener('dragstart', (e) => {
      dragging = { type: 'link', id };
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragover', (e) => {
      if (!dragging || dragging.type !== 'link' || dragging.id === id) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      el.classList.toggle('dragover-top', before);
      el.classList.toggle('dragover-bottom', !before);
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('dragover-top', 'dragover-bottom');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('dragover-top', 'dragover-bottom');
      if (!dragging || dragging.type !== 'link' || dragging.id === id) return;
      const rect = el.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      const targetLink = getLink(id);
      reorderNear(dragging.id, targetLink, before);
    });
    el.addEventListener('dragend', () => { dragging = null; });
  });
}

function moveLinkToGroup(linkId, groupId, index) {
  const state = getState();
  const gid = groupId || null;
  const siblings = state.links.filter((l) => (l.groupId || null) === gid && l.id !== linkId).sort((a, b) => a.order - b.order);
  siblings.splice(index, 0, { id: linkId });
  window.myApps.invoke('link:reorder', siblings.map((s) => s.id), gid);
}

function reorderNear(linkId, targetLink, before) {
  const state = getState();
  const gid = targetLink.groupId || null;
  const siblings = state.links.filter((l) => (l.groupId || null) === gid && l.id !== linkId).sort((a, b) => a.order - b.order);
  const idx = siblings.findIndex((s) => s.id === targetLink.id);
  const insertAt = before ? idx : idx + 1;
  siblings.splice(insertAt, 0, { id: linkId });
  window.myApps.invoke('link:reorder', siblings.map((s) => s.id), gid);
}

function pushLayout() {
  window.myApps.send('ui:layout', {
    sidebarWidth: getState().ui.sidebarWidth,
    sidebarCollapsed: getState().ui.sidebarCollapsed,
    showToolbar: getState().ui.showToolbar,
  });
}

export function applySidebarWidth() {
  const { sidebarWidth, sidebarCollapsed } = getState().ui;
  shellEl.style.setProperty('--sw', `${sidebarWidth}px`);
  shellEl.classList.toggle('collapsed', !!sidebarCollapsed);
  sidebarEl.classList.toggle('collapsed-mode', !!sidebarCollapsed);
}

function initResizer() {
  let startX = 0;
  let startW = 240;
  let resizing = false;
  resizer.addEventListener('mousedown', (e) => {
    if (getState().ui.sidebarCollapsed) return;
    resizing = true;
    startX = e.clientX;
    startW = getState().ui.sidebarWidth;
    document.body.style.cursor = 'col-resize';
  });
  window.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const w = Math.max(180, Math.min(420, startW + (e.clientX - startX)));
    setState({ ui: { ...getState().ui, sidebarWidth: w } });
    applySidebarWidth();
  });
  window.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    document.body.style.cursor = '';
    pushLayout();
  });
}

export function initSidebar() {
  initResizer();

  btnCollapse.innerHTML = iconHtml('chevron');
  btnSearch.innerHTML = iconHtml('search');
  btnAddLink.innerHTML = `${iconHtml('plus')}<span>Add</span>`;
  btnAddGroup.innerHTML = `${iconHtml('folder')}<span>New group</span>`;
  btnSettings.innerHTML = `${iconHtml('gear')}<span>Settings</span>`;
  btnDnd.innerHTML = `${iconHtml('moon')}<span>Do Not Disturb</span>`;

  btnCollapse.addEventListener('click', () => {
    const ui = getState().ui;
    setState({ ui: { ...ui, sidebarCollapsed: !ui.sidebarCollapsed } });
    applySidebarWidth();
    pushLayout();
  });

  btnSearch.addEventListener('click', () => toggleSearch());
  btnAddLink.addEventListener('click', () => openLinkDialog(null));
  btnAddGroup.addEventListener('click', () => openGroupDialog(null));
  btnEmptyAdd.addEventListener('click', () => openLinkDialog(null));
  btnSettings.addEventListener('click', async () => {
    const { openSettingsDialog } = await import('./dialog-settings.js');
    openSettingsDialog();
  });
  btnDnd.addEventListener('click', async () => {
    const dnd = getState().settings.dnd || { enabled: false };
    await window.myApps.invoke('dnd:set', { enabled: !dnd.enabled, until: null });
  });

  searchInput.addEventListener('input', () => {
    filterText = searchInput.value.trim().toLowerCase();
    renderList();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleSearch(false);
  });
}

function toggleSearch(force) {
  const open = force !== undefined ? force : !searchBox.classList.contains('open');
  searchBox.classList.toggle('open', open);
  if (open) { searchInput.focus(); } else { searchInput.value = ''; filterText = ''; renderList(); }
}

export function updateDndButton() {
  const dnd = getState().settings.dnd || { enabled: false };
  btnDnd.classList.toggle('dnd-on', !!dnd.enabled);
}
