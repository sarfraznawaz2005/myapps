import { getState, setState, getLink, getGroup } from '../state.js';
import { icons } from '../icons.js';
import { openLinkDialog } from './dialog-link.js';
import { openGroupDialog } from './dialog-group.js';

const listEl = document.getElementById('sidebar-list');
const shellEl = document.getElementById('shell');
const sidebarEl = document.getElementById('sidebar');
const resizer = document.getElementById('sidebar-resizer');
const collapseToggle = document.getElementById('sidebar-collapse-toggle');
const btnFooterToggle = document.getElementById('btn-footer-toggle');
const footerActions = document.getElementById('sidebar-footer-actions');
const btnAddLink = document.getElementById('btn-add-link');
const btnAddGroup = document.getElementById('btn-add-group');
const btnSettings = document.getElementById('btn-settings');
const btnEmptyAdd = document.getElementById('btn-empty-add');

let dragging = null; // { type: 'link'|'group', id }
let ungroupedCollapsed = false;
const UNGROUPED_ID = '__ungrouped__';

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

  // A link is "asleep" if it has no live WebContentsView right now — whether
  // that is because it was explicitly hibernated, auto-idle-hibernated, or
  // simply never opened yet this session. linkStatus.hibernated tracks live
  // load/hibernate transitions; loadedLinkIds covers links that have never
  // fired either transition (never-opened links have no linkStatus entry).
  const asleep = status.hibernated != null ? status.hibernated : !state.loadedLinkIds.includes(link.id);
  if (asleep) {
    const label = typeof unread.count === 'number'
      ? `last known: ${unread.count}`
      : (state.loadedLinkIds.includes(link.id) ? 'hibernated' : 'not opened yet');
    parts.push(`<span class="pill stale" title="Asleep — ${label}">${iconHtml('moon')}</span>`);
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
    .filter((l) => (l.groupId || null) === group.id && l.enabled)
    .sort((a, b) => a.order - b.order);
  const collapsed = group.collapsed ? ' collapsed' : '';
  const agg = groupAggregate(group.id);
  const countLabel = `${links.length} link${links.length === 1 ? '' : 's'}`;
  const hasColor = group.color ? ' has-color' : '';
  const colorStyle = group.color ? ` style="--grp-color:${escapeAttr(group.color)}"` : '';
  return `<div class="group${hasColor}" data-group-id="${group.id}"${colorStyle}>
    <div class="group-header${collapsed}${hasColor}" data-group-id="${group.id}" title="${escapeAttr(group.name)} — ${escapeAttr(countLabel)}">
      <span class="chevron">${iconHtml('chevron')}</span>
      <span class="name">${group.name}</span>
      <span class="pill${agg ? ' has-count' : ''}">${agg}</span>
    </div>
    <div class="group-body${collapsed}">${links.map(linkRowHtml).join('')}</div>
  </div>`;
}

function ungroupedGroupHtml(links) {
  const collapsed = ungroupedCollapsed ? ' collapsed' : '';
  const countLabel = `${links.length} link${links.length === 1 ? '' : 's'}`;
  return `<div class="group" data-group-id="${UNGROUPED_ID}">
    <div class="group-header${collapsed}" data-group-id="${UNGROUPED_ID}" title="Ungrouped — ${escapeAttr(countLabel)}">
      <span class="chevron">${iconHtml('chevron')}</span>
      <span class="name">Ungrouped</span>
      <span class="pill"></span>
    </div>
    <div class="group-body${collapsed}">${links.map(linkRowHtml).join('')}</div>
  </div>`;
}

export function renderList() {
  const state = getState();
  const groups = state.groups.slice().sort((a, b) => a.order - b.order);
  const ungrouped = state.links
    .filter((l) => !l.groupId && l.enabled)
    .sort((a, b) => a.order - b.order);

  let html = groups.map(groupHtml).join('');
  if (ungrouped.length > 0) html += ungroupedGroupHtml(ungrouped);
  listEl.innerHTML = html;

  const visibleCount = state.links.filter((l) => l.enabled).length;
  document.getElementById('content-empty').style.display = visibleCount === 0 ? 'flex' : 'none';
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
      if (gid === UNGROUPED_ID) {
        ungroupedCollapsed = !ungroupedCollapsed;
        renderList();
        return;
      }
      const group = getGroup(gid);
      window.myApps.invoke('group:update', gid, { collapsed: !group.collapsed });
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (el.dataset.groupId === UNGROUPED_ID) return;
      openGroupDialog(getGroup(el.dataset.groupId));
    });
    el.addEventListener('dragover', (e) => {
      if (dragging && dragging.type === 'link') { e.preventDefault(); el.classList.add('dragover'); }
    });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('dragover');
      if (dragging && dragging.type === 'link') {
        const gid = el.dataset.groupId === UNGROUPED_ID ? null : el.dataset.groupId;
        moveLinkToGroup(dragging.id, gid, 0);
      }
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
    sidebarFooterOpen: getState().ui.sidebarFooterOpen,
  });
}

export function applySidebarWidth() {
  const { sidebarWidth, sidebarCollapsed, sidebarFooterOpen } = getState().ui;
  shellEl.style.setProperty('--sw', `${sidebarWidth}px`);
  shellEl.classList.toggle('collapsed', !!sidebarCollapsed);
  sidebarEl.classList.toggle('collapsed-mode', !!sidebarCollapsed);
  collapseToggle.title = sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
  footerActions.classList.toggle('open', !!sidebarFooterOpen);
  btnFooterToggle.classList.toggle('open', !!sidebarFooterOpen);
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
    const w = Math.max(130, Math.min(420, startW + (e.clientX - startX)));
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

  collapseToggle.innerHTML = iconHtml('chevron');
  btnFooterToggle.innerHTML = `${iconHtml('chevron')}<span>More</span>`;
  btnAddLink.innerHTML = `${iconHtml('plus')}<span>Add Link</span>`;
  btnAddGroup.innerHTML = `${iconHtml('folder')}<span>Add Group</span>`;
  btnSettings.innerHTML = `${iconHtml('gear')}<span>Settings</span>`;

  collapseToggle.addEventListener('click', () => {
    const ui = getState().ui;
    setState({ ui: { ...ui, sidebarCollapsed: !ui.sidebarCollapsed } });
    applySidebarWidth();
    pushLayout();
  });

  btnFooterToggle.addEventListener('click', () => {
    const open = footerActions.classList.toggle('open');
    btnFooterToggle.classList.toggle('open', open);
    setState({ ui: { ...getState().ui, sidebarFooterOpen: open } });
    pushLayout();
  });

  btnAddLink.addEventListener('click', () => openLinkDialog(null));
  btnAddGroup.addEventListener('click', () => openGroupDialog(null));
  btnEmptyAdd.addEventListener('click', () => openLinkDialog(null));
  btnSettings.addEventListener('click', async () => {
    const { openSettingsDialog } = await import('./dialog-settings.js');
    openSettingsDialog();
  });
}
