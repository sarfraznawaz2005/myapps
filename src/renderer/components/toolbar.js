import { getState, getLink } from '../state.js';
import { icons } from '../icons.js';
import { openLinkDialog } from './dialog-link.js';

const toolbarEl = document.getElementById('toolbar');
let urlEditing = false;

function iconHtml(name) { return icons[name] || ''; }

function render() {
  toolbarEl.innerHTML = `
    <button id="tb-back" title="Back (Alt+Left)">${iconHtml('back')}</button>
    <button id="tb-forward" title="Forward (Alt+Right)">${iconHtml('forward')}</button>
    <button id="tb-reload" title="Reload (Ctrl+R)">${iconHtml('reload')}</button>
    <button id="tb-home" title="Home">${iconHtml('home')}</button>
    <div id="url-bar">
      <span class="lock">${iconHtml('lock')}</span>
      <input id="tb-url" type="text" placeholder="Select a link…" />
    </div>
    <button id="tb-copy" title="Copy URL">${iconHtml('copy')}</button>
    <button id="tb-external" title="Open in browser">${iconHtml('external')}</button>
    <button id="tb-more" title="More">${iconHtml('more')}</button>
  `;

  document.getElementById('tb-back').addEventListener('click', () => window.myApps.invoke('nav:go', 'back'));
  document.getElementById('tb-forward').addEventListener('click', () => window.myApps.invoke('nav:go', 'forward'));
  document.getElementById('tb-reload').addEventListener('click', () => {
    const status = getState().linkStatus[getState().activeLinkId] || {};
    window.myApps.invoke('nav:go', status.loading ? 'stop' : 'reload');
  });
  document.getElementById('tb-home').addEventListener('click', () => window.myApps.invoke('nav:go', 'home'));
  document.getElementById('tb-copy').addEventListener('click', () => window.myApps.invoke('nav:copy-url'));
  document.getElementById('tb-external').addEventListener('click', () => window.myApps.invoke('nav:open-external'));
  document.getElementById('tb-more').addEventListener('click', (e) => openOverflowMenu(e.currentTarget));

  const urlInput = document.getElementById('tb-url');
  urlInput.addEventListener('focus', () => { urlEditing = true; urlInput.select(); });
  urlInput.addEventListener('blur', () => { urlEditing = false; update(); });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      window.myApps.invoke('nav:navigate', urlInput.value.trim());
      urlInput.blur();
    } else if (e.key === 'Escape') {
      update();
      urlInput.blur();
    }
  });

  update();
}

function openOverflowMenu(anchor) {
  const id = getState().activeLinkId;
  if (!id) return;
  const existing = document.getElementById('tb-overflow-menu');
  if (existing) { existing.remove(); return; }
  const link = getLink(id);
  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.id = 'tb-overflow-menu';
  menu.style.cssText = `position:fixed;top:${rect.bottom + 4}px;right:12px;background:var(--bg-elevated);
    border:1px solid var(--border);border-radius:8px;padding:4px;min-width:180px;z-index:120;
    box-shadow:0 12px 32px rgba(0,0,0,.4);`;
  const items = [
    ['Zoom in', () => window.myApps.invoke('link:update', id, { zoom: Math.min(3, (link.zoom || 1) + 0.1) })],
    ['Zoom out', () => window.myApps.invoke('link:update', id, { zoom: Math.max(0.5, (link.zoom || 1) - 0.1) })],
    ['Reset zoom', () => window.myApps.invoke('link:update', id, { zoom: 1 })],
    ['Hibernate now', () => window.myApps.invoke('link:hibernate', id)],
    ['Clear login data…', async () => {
      if (confirm(`Clear login data for "${link.name}"? This signs it out.`)) {
        await window.myApps.invoke('link:clear-data', id);
      }
    }],
    ['Open DevTools (F12)', () => window.myApps.invoke('link:devtools', id)],
    ['Edit…', () => openLinkDialog(link)],
  ];
  menu.innerHTML = items.map(([label], i) => `<div class="menu-item" data-i="${i}" style="padding:7px 10px;border-radius:6px;cursor:pointer;font-size:12.5px;">${label}</div>`).join('');
  menu.querySelectorAll('.menu-item').forEach((el) => {
    el.addEventListener('mouseenter', () => { el.style.background = 'var(--bg-hover)'; });
    el.addEventListener('mouseleave', () => { el.style.background = ''; });
    el.addEventListener('click', () => {
      items[Number(el.dataset.i)][1]();
      menu.remove();
    });
  });
  document.body.appendChild(menu);
  setTimeout(() => {
    document.addEventListener('click', function onDocClick(ev) {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', onDocClick); }
    });
  }, 0);
}

export function update() {
  if (!document.getElementById('tb-back')) return; // not rendered yet
  const state = getState();
  const id = state.activeLinkId;
  const link = id ? getLink(id) : null;
  const status = id ? (state.linkStatus[id] || {}) : {};

  document.getElementById('tb-back').disabled = !status.canGoBack;
  document.getElementById('tb-forward').disabled = !status.canGoForward;
  document.getElementById('tb-home').disabled = !link;
  document.getElementById('tb-copy').disabled = !link;
  document.getElementById('tb-external').disabled = !link;
  document.getElementById('tb-reload').innerHTML = iconHtml(status.loading ? 'stop' : 'reload');

  const urlInput = document.getElementById('tb-url');
  if (!urlEditing) {
    urlInput.value = (status.url || (link && link.url) || '');
    urlInput.placeholder = link ? link.name : 'Select a link…';
  }
  const lock = document.querySelector('#url-bar .lock');
  const isSecure = (status.url || (link && link.url) || '').startsWith('https://');
  lock.style.opacity = link ? (isSecure ? '1' : '.35') : '0';
}

export function initToolbar() {
  render();
}

export function focusUrlBar() {
  const urlInput = document.getElementById('tb-url');
  if (urlInput) { urlInput.focus(); urlInput.select(); }
}
