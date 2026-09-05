import { getState, setState, mergeMapField, getLink } from './state.js';
import * as sidebar from './components/sidebar.js';
import * as toolbar from './components/toolbar.js';
import { showToast } from './components/toast.js';
import { openLinkDialog } from './components/dialog-link.js';
import { openPermissionPrompt } from './components/dialog-permission.js';

const contentEmpty = document.getElementById('content-empty');
const quickSwitch = document.getElementById('quick-switch');
const quickSwitchInput = document.getElementById('quick-switch-input');
const quickSwitchResults = document.getElementById('quick-switch-results');
let quickSwitchIndex = 0;

function applyTheme() {
  document.documentElement.dataset.theme = getState().settings.theme || 'dark';
}

// Tracks the links/groups actually last drawn into the sidebar, so a state
// push that only changed something unrelated (window position, settings)
// doesn't force a full sidebar HTML rebuild + row re-wiring.
let lastRenderedListSignature = null;

function onShellState(payload) {
  setState({
    version: payload.version,
    settings: payload.settings,
    ui: payload.ui,
    groups: payload.groups,
    links: payload.links,
    userscripts: payload.userscripts || [],
    commands: payload.commands || [],
    unread: payload.unread || getState().unread,
    aggregate: payload.aggregate != null ? payload.aggregate : getState().aggregate,
    activeLinkId: payload.activeLinkId !== undefined ? payload.activeLinkId : getState().activeLinkId,
    loadedLinkIds: payload.loadedLinkIds || getState().loadedLinkIds,
  });
  applyTheme();
  sidebar.applySidebarWidth();
  const listSignature = JSON.stringify({ links: payload.links, groups: payload.groups });
  if (listSignature !== lastRenderedListSignature) {
    lastRenderedListSignature = listSignature;
    sidebar.renderList();
  }
  toolbar.update();
  contentEmpty.style.display = getState().links.length === 0 ? 'flex' : 'none';
}

function onUnread(payload) {
  mergeMapField('unread', payload.linkId, payload);
  sidebar.updateRowStatus(payload.linkId);
}

function onAggregate(aggregate) {
  setState({ aggregate });
}

function onNav(payload) {
  mergeMapField('linkStatus', payload.linkId, { ...(getState().linkStatus[payload.linkId] || {}), ...payload });
  if (getState().activeLinkId === payload.linkId) toolbar.update();
}

function onLinkStatus(payload) {
  mergeMapField('linkStatus', payload.linkId, { ...(getState().linkStatus[payload.linkId] || {}), ...payload });
  sidebar.updateRowStatus(payload.linkId);
  if (getState().activeLinkId === payload.linkId) toolbar.update();
}

function onFavicon(payload) {
  const link = getLink(payload.linkId);
  if (link) link.icon.path = payload.path;
  sidebar.updateRowStatus(payload.linkId);
}

function onActive(payload) {
  setState({ activeLinkId: payload.linkId });
  sidebar.updateActiveRow();
  toolbar.update();
  contentEmpty.style.display = getState().links.length === 0 ? 'flex' : 'none';
}

function onToast(payload) {
  showToast(payload);
}

function onPermissionPrompt(payload) {
  openPermissionPrompt(payload);
}

function onOpenDialog(payload) {
  if (!payload) return;
  if (payload.type === 'focus-url') toolbar.focusUrlBar();
  else if (payload.type === 'quick-switch') openQuickSwitch();
  else if (payload.type === 'edit-link') { const link = getLink(payload.linkId); if (link) openLinkDialog(link); }
  else if (payload.type === 'picked-element') {
    window.dispatchEvent(new CustomEvent('__myapps-picked-element', { detail: payload }));
  }
}

function quickSwitchList() {
  const filter = quickSwitchInput.value.trim().toLowerCase();
  const state = getState();
  return state.links
    .filter((l) => !filter || l.name.toLowerCase().includes(filter) || l.url.toLowerCase().includes(filter))
    .sort((a, b) => a.order - b.order);
}

function renderQuickSwitch() {
  const results = quickSwitchList();
  quickSwitchIndex = Math.min(quickSwitchIndex, Math.max(0, results.length - 1));
  quickSwitchResults.innerHTML = results.map((l, i) => `
    <div class="result${i === quickSwitchIndex ? ' selected' : ''}" data-id="${l.id}">
      <span>${l.name}</span>
    </div>`).join('') || '<div class="hint" style="padding:10px;">No matches</div>';
  quickSwitchResults.querySelectorAll('.result').forEach((el) => {
    el.addEventListener('click', () => {
      window.myApps.invoke('link:activate', el.dataset.id);
      closeQuickSwitch();
    });
  });
}

function openQuickSwitch() {
  quickSwitch.classList.add('open');
  quickSwitchInput.value = '';
  quickSwitchIndex = 0;
  renderQuickSwitch();
  setTimeout(() => quickSwitchInput.focus(), 0);
}

function closeQuickSwitch() {
  quickSwitch.classList.remove('open');
}

quickSwitchInput.addEventListener('input', () => { quickSwitchIndex = 0; renderQuickSwitch(); });
quickSwitchInput.addEventListener('keydown', (e) => {
  const results = quickSwitchList();
  if (e.key === 'ArrowDown') { e.preventDefault(); quickSwitchIndex = Math.min(quickSwitchIndex + 1, results.length - 1); renderQuickSwitch(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); quickSwitchIndex = Math.max(quickSwitchIndex - 1, 0); renderQuickSwitch(); }
  else if (e.key === 'Enter') {
    const chosen = results[quickSwitchIndex];
    if (chosen) { window.myApps.invoke('link:activate', chosen.id); closeQuickSwitch(); }
  } else if (e.key === 'Escape') closeQuickSwitch();
});
quickSwitch.addEventListener('click', (e) => { if (e.target === quickSwitch) closeQuickSwitch(); });

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openQuickSwitch(); }
});

async function init() {
  window.myApps.on('shell:state', onShellState);
  window.myApps.on('shell:unread', onUnread);
  window.myApps.on('shell:aggregate', onAggregate);
  window.myApps.on('shell:nav', onNav);
  window.myApps.on('shell:link-status', onLinkStatus);
  window.myApps.on('shell:favicon', onFavicon);
  window.myApps.on('shell:active', onActive);
  window.myApps.on('shell:toast', onToast);
  window.myApps.on('shell:open-dialog', onOpenDialog);
  window.myApps.on('shell:permission-prompt', onPermissionPrompt);

  sidebar.initSidebar();
  toolbar.initToolbar();

  const initial = await window.myApps.invoke('app:get-state');
  onShellState(initial);

  window.myApps.send('ui:ready');
}

init();
