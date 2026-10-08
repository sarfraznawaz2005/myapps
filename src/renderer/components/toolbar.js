import { getState, getLink } from '../state.js';
import { icons } from '../icons.js';
import { openNoteDialog } from './dialog-note.js';
import { openKeywordsDialog } from './dialog-keywords.js';
import { openWhatsappDialog } from './dialog-whatsapp.js';
import { openCssDialog, cssHostOf } from './dialog-css.js';

const toolbarEl = document.getElementById('toolbar');
let urlEditing = false;
let findOpen = false;

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
    <button id="tb-viewmode" title="Switch to mobile view">${iconHtml('desktop')}</button>
    <button id="tb-dark" title="Dark mode">${iconHtml('moon')}</button>
    <button id="tb-highlight" title="Highlight keywords">${iconHtml('highlighter')}</button>
    <button id="tb-css" title="Custom CSS for this site">${iconHtml('paintbrush')}</button>
    <button id="tb-note" title="Add note">${iconHtml('note')}</button>
    <button id="tb-whatsapp" title="WhatsApp extras" style="display:none">${iconHtml('eyeOff')}</button>
    <button id="tb-copy" title="Copy URL">${iconHtml('copy')}</button>
    <button id="tb-external" title="Open in browser">${iconHtml('external')}</button>
    <button id="tb-downloads" title="Downloads">${iconHtml('download')}</button>
    <button id="tb-screenshot" title="Screenshot">${iconHtml('camera')}</button>
    <button id="tb-print" title="Print or save as PDF">${iconHtml('printer')}</button>
    <button id="tb-zoom-out" title="Zoom out (Ctrl+-)">${iconHtml('minus')}</button>
    <button id="tb-zoom-reset" title="Reset zoom to 100% (Ctrl+0)">100%</button>
    <button id="tb-zoom-in" title="Zoom in (Ctrl++)">${iconHtml('plus')}</button>
    <button id="tb-more" title="More">${iconHtml('more')}</button>
    <div id="find-bar">
      <input id="find-input" type="text" placeholder="Find on page" />
      <span id="find-count"></span>
      <button id="find-prev" title="Previous match (Shift+Enter)">${iconHtml('chevronDown')}</button>
      <button id="find-next" title="Next match (Enter)">${iconHtml('chevronDown')}</button>
      <button id="find-close" title="Close (Esc)">${iconHtml('x')}</button>
    </div>
  `;

  document.getElementById('tb-back').addEventListener('click', () => window.myApps.invoke('nav:go', 'back'));
  document.getElementById('tb-forward').addEventListener('click', () => window.myApps.invoke('nav:go', 'forward'));
  document.getElementById('tb-reload').addEventListener('click', () => {
    const status = getState().linkStatus[getState().activeLinkId] || {};
    window.myApps.invoke('nav:go', status.loading ? 'stop' : 'reload');
  });
  document.getElementById('tb-home').addEventListener('click', () => window.myApps.invoke('nav:go', 'home'));
  document.getElementById('tb-viewmode').addEventListener('click', () => {
    const id = getState().activeLinkId;
    const link = id ? getLink(id) : null;
    if (link) window.myApps.invoke('link:view-mode', id, link.viewMode === 'mobile' ? 'desktop' : 'mobile');
  });
  document.getElementById('tb-whatsapp').addEventListener('click', () => {
    const id = getState().activeLinkId;
    if (id) openWhatsappDialog(id);
  });
  document.getElementById('tb-dark').addEventListener('click', () => {
    const id = getState().activeLinkId;
    const link = id ? getLink(id) : null;
    if (link) window.myApps.invoke('link:dark-mode', id, !link.darkMode);
  });
  const zoomActive = (direction) => {
    const id = getState().activeLinkId;
    if (id) window.myApps.invoke('link:zoom', id, direction);
  };
  document.getElementById('tb-zoom-out').addEventListener('click', () => zoomActive('out'));
  document.getElementById('tb-zoom-reset').addEventListener('click', () => zoomActive('reset'));
  document.getElementById('tb-zoom-in').addEventListener('click', () => zoomActive('in'));
  document.getElementById('tb-highlight').addEventListener('click', () => openKeywordsDialog());
  document.getElementById('tb-css').addEventListener('click', () => openCssDialog(currentUrl()));
  document.getElementById('tb-note').addEventListener('click', () => openNoteDialog(currentUrl()));
  document.getElementById('tb-copy').addEventListener('click', () => window.myApps.invoke('nav:copy-url'));
  document.getElementById('tb-external').addEventListener('click', () => window.myApps.invoke('nav:open-external'));
  document.getElementById('tb-downloads').addEventListener('click', (e) => openDownloadsPanel(e.currentTarget));
  document.getElementById('tb-screenshot').addEventListener('click', (e) => openActionMenu(e.currentTarget, 'tb-screenshot-menu', [
    ['Visible area', () => window.myApps.invoke('page:screenshot', 'visible')],
    ['Whole page', () => window.myApps.invoke('page:screenshot', 'full')],
  ]));
  document.getElementById('tb-print').addEventListener('click', (e) => openActionMenu(e.currentTarget, 'tb-print-menu', [
    ['Print…', () => window.myApps.invoke('page:print')],
    ['Save as PDF…', () => window.myApps.invoke('page:pdf')],
  ]));
  document.getElementById('tb-more').addEventListener('click', (e) => openOverflowMenu(e.currentTarget));
  wireFindBar();

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

// Sent by the main process's right-click menu ("Paste and Go" on the URL bar).
window.addEventListener('__myapps-paste-and-go', (e) => {
  const text = typeof e.detail === 'string' ? e.detail.trim() : '';
  if (!text) return;
  window.myApps.invoke('nav:navigate', text);
  const urlInput = document.getElementById('tb-url');
  if (urlInput) urlInput.blur();
});

// One dropdown at a time, shown under a toolbar button. While it is open the
// page view is hidden (ui:modal-open), or the page would draw over the menu.
let dropdown = null; // { id, menu, backdrop, onKey, refresh }

function closeDropdown() {
  if (!dropdown) return;
  document.removeEventListener('keydown', dropdown.onKey, true);
  dropdown.menu.remove();
  dropdown.backdrop.remove();
  dropdown = null;
  window.myApps.send('ui:modal-open', false);
}

// fill(menu) puts the content in the menu; it runs again on every refresh.
function showDropdown(anchor, id, minWidth, fill) {
  if (dropdown) {
    const same = dropdown.id === id;
    closeDropdown();
    if (same) return;
  }
  const rect = anchor.getBoundingClientRect();
  const backdrop = document.createElement('div');
  backdrop.id = 'tb-overflow-backdrop';
  backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:119;';
  const menu = document.createElement('div');
  menu.id = 'tb-overflow-menu';
  const right = Math.max(8, window.innerWidth - rect.right);
  menu.style.cssText = `position:fixed;top:${rect.bottom + 4}px;right:${right}px;background:var(--bg-elevated);
    border:1px solid var(--border);border-radius:8px;padding:4px;min-width:${minWidth}px;z-index:120;
    box-shadow:0 12px 32px rgba(0,0,0,.4);`;
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeDropdown(); } };
  dropdown = { id, menu, backdrop, onKey, refresh: () => fill(menu) };
  fill(menu);
  window.myApps.send('ui:modal-open', true);
  backdrop.addEventListener('click', closeDropdown);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(backdrop);
  document.body.appendChild(menu);
}

// A plain list of [label, action]. The action runs after the menu closes and
// the page is back on screen (a screenshot needs the page visible).
function openActionMenu(anchor, id, items) {
  showDropdown(anchor, id, 160, (menu) => {
    menu.innerHTML = items.map(([label], i) => `<div class="menu-item" data-i="${i}" style="padding:7px 10px;border-radius:6px;cursor:pointer;font-size:12.5px;">${label}</div>`).join('');
    menu.querySelectorAll('.menu-item').forEach((el) => {
      el.addEventListener('mouseenter', () => { el.style.background = 'var(--bg-hover)'; });
      el.addEventListener('mouseleave', () => { el.style.background = ''; });
      el.addEventListener('click', () => {
        const action = items[Number(el.dataset.i)][1];
        closeDropdown();
        setTimeout(action, 250);
      });
    });
  });
}

function openOverflowMenu(anchor) {
  const id = getState().activeLinkId;
  if (!id) return;
  const link = getLink(id);
  openActionMenu(anchor, 'tb-more-menu', [
    ['Hibernate now', () => window.myApps.invoke('link:hibernate', id)],
    ['Clear login data…', async () => {
      if (confirm(`Clear login data for "${link.name}"? This signs it out.`)) {
        await window.myApps.invoke('link:clear-data', id);
      }
    }],
    ['Open DevTools (F12)', () => window.myApps.invoke('link:devtools', id)],
  ]);
}

// ---- downloads list ----
let downloadList = [];

function formatBytes(n) {
  if (!n || n < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function downloadStatus(d) {
  if (d.state === 'completed') return formatBytes(d.total || d.received) || 'Done';
  if (d.state === 'cancelled') return 'Cancelled';
  if (d.state === 'interrupted') return 'Failed';
  if (d.total > 0) return `${Math.round((d.received / d.total) * 100)}% — ${formatBytes(d.received)} of ${formatBytes(d.total)}`;
  return formatBytes(d.received) || 'Starting…';
}

function updateDownloadsButton() {
  const btn = document.getElementById('tb-downloads');
  if (!btn) return;
  const active = downloadList.filter((d) => d.state === 'progressing').length;
  btn.style.color = active ? 'var(--accent)' : '';
  btn.title = active ? `Downloads (${active} in progress)` : 'Downloads';
}

function fillDownloads(menu) {
  menu.innerHTML = '';
  menu.classList.add('dl-panel');
  if (!downloadList.length) {
    const empty = document.createElement('div');
    empty.className = 'dl-empty';
    empty.textContent = 'No downloads yet.';
    menu.appendChild(empty);
    return;
  }
  for (const d of downloadList) {
    const row = document.createElement('div');
    row.className = 'dl-row';
    const info = document.createElement('div');
    info.className = 'dl-info';
    const name = document.createElement('div');
    name.className = 'dl-name';
    name.textContent = d.filename || 'Download';
    name.title = d.path || d.filename || '';
    const sub = document.createElement('div');
    sub.className = 'dl-sub';
    sub.textContent = `${downloadStatus(d)}${d.linkName ? ` · ${d.linkName}` : ''}`;
    info.append(name, sub);
    if (d.state === 'progressing' && d.total > 0) {
      const bar = document.createElement('div');
      bar.className = 'dl-bar';
      const fill = document.createElement('div');
      fill.style.width = `${Math.min(100, Math.round((d.received / d.total) * 100))}%`;
      bar.appendChild(fill);
      info.appendChild(bar);
    }
    const buttons = document.createElement('div');
    buttons.className = 'dl-actions';
    const add = (label, title, action) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', () => window.myApps.invoke('downloads:act', d.id, action));
      buttons.appendChild(b);
    };
    if (d.state === 'completed') { add('Open', 'Open the file', 'open'); add('Folder', 'Show in folder', 'show'); }
    if (d.state === 'progressing') add('Cancel', 'Cancel this download', 'cancel');
    else add('✕', 'Remove from list', 'remove');
    row.append(info, buttons);
    menu.appendChild(row);
  }
  if (downloadList.some((d) => d.state !== 'progressing')) {
    const clear = document.createElement('button');
    clear.className = 'dl-clear';
    clear.textContent = 'Clear finished';
    clear.addEventListener('click', () => window.myApps.invoke('downloads:clear'));
    menu.appendChild(clear);
  }
}

async function openDownloadsPanel(anchor) {
  const list = await window.myApps.invoke('downloads:list');
  if (Array.isArray(list)) downloadList = list;
  showDropdown(anchor, 'tb-downloads-menu', 340, fillDownloads);
}

window.myApps.on('shell:downloads', (list) => {
  downloadList = Array.isArray(list) ? list : [];
  updateDownloadsButton();
  if (dropdown && dropdown.id === 'tb-downloads-menu') dropdown.refresh();
});

// The page URL the user sees now (after in-page navigation), else the link's home URL.
function currentUrl() {
  const state = getState();
  const id = state.activeLinkId;
  const link = id ? getLink(id) : null;
  if (!link) return '';
  const status = state.linkStatus[id] || {};
  return status.url || link.url || '';
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
  const viewBtn = document.getElementById('tb-viewmode');
  const mobile = !!link && link.viewMode === 'mobile';
  viewBtn.disabled = !link;
  viewBtn.innerHTML = iconHtml(mobile ? 'mobile' : 'desktop');
  viewBtn.title = mobile ? 'Mobile view (click for desktop view)' : 'Desktop view (click for mobile view)';
  viewBtn.style.color = mobile ? 'var(--accent)' : '';
  // WhatsApp extras: only for a link that is on WhatsApp Web right now.
  const waBtn = document.getElementById('tb-whatsapp');
  let onWhatsapp = false;
  try { onWhatsapp = new URL(status.url || (link && link.url) || '').hostname === 'web.whatsapp.com'; } catch (_e) { /* no URL yet */ }
  waBtn.style.display = link && onWhatsapp ? '' : 'none';
  const waOn = !!link && !!link.whatsapp && Object.entries(link.whatsapp).some(([k, v]) => k !== 'notifyContacts' && v === true);
  waBtn.style.color = waOn ? 'var(--accent)' : '';
  waBtn.title = waOn ? 'WhatsApp extras (some are on)' : 'WhatsApp extras';
  const darkBtn = document.getElementById('tb-dark');
  const dark = !!link && !!link.darkMode;
  darkBtn.disabled = !link;
  darkBtn.innerHTML = iconHtml(dark ? 'sun' : 'moon');
  darkBtn.title = dark ? 'Dark mode on (click to turn off)' : 'Dark mode off (click to turn on)';
  darkBtn.style.color = dark ? 'var(--accent)' : '';
  const zoom = link ? (link.zoom || 1) : 1;
  const zoomPct = Math.round(zoom * 100);
  const zoomReset = document.getElementById('tb-zoom-reset');
  zoomReset.textContent = `${zoomPct}%`;
  zoomReset.disabled = !link || zoomPct === 100;
  document.getElementById('tb-zoom-out').disabled = !link || zoomPct <= 50;
  document.getElementById('tb-zoom-in').disabled = !link || zoomPct >= 300;
  const keywords = Array.isArray(state.settings.highlightKeywords) ? state.settings.highlightKeywords : [];
  const hlBtn = document.getElementById('tb-highlight');
  hlBtn.title = keywords.length ? `Highlighting ${keywords.length} keyword${keywords.length === 1 ? '' : 's'} (click to edit)` : 'Highlight keywords';
  hlBtn.style.color = keywords.length ? 'var(--accent)' : '';
  const url = currentUrl();
  const cssBtn = document.getElementById('tb-css');
  const cssDomain = cssHostOf(url);
  const hasCss = !!cssDomain && !!(state.customCss || {})[cssDomain];
  cssBtn.disabled = !cssDomain;
  cssBtn.title = hasCss ? `Custom CSS is on for ${cssDomain} (click to edit)` : 'Custom CSS for this site';
  cssBtn.style.color = hasCss ? 'var(--accent)' : '';
  const noteBtn = document.getElementById('tb-note');
  const note = url ? state.notes[url] : null;
  noteBtn.disabled = !url;
  noteBtn.innerHTML = iconHtml(note ? 'noteFilled' : 'note');
  noteBtn.title = note ? `Note: ${note.text.length > 200 ? `${note.text.slice(0, 200)}…` : note.text}` : 'Add note';
  noteBtn.style.color = note ? 'var(--accent)' : '';
  document.getElementById('tb-external').disabled = !link;
  document.getElementById('tb-screenshot').disabled = !link;
  document.getElementById('tb-print').disabled = !link;
  updateDownloadsButton();
  document.getElementById('tb-reload').innerHTML = iconHtml(status.loading ? 'stop' : 'reload');
  document.getElementById('load-bar').classList.toggle('active', !!status.loading);

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
  // A reloaded shell picks up downloads that started before it loaded.
  window.myApps.invoke('downloads:list').then((list) => {
    if (Array.isArray(list)) { downloadList = list; updateDownloadsButton(); }
  }).catch(() => {});
}

export function focusUrlBar() {
  const urlInput = document.getElementById('tb-url');
  if (urlInput) { urlInput.focus(); urlInput.select(); }
}

function wireFindBar() {
  const input = document.getElementById('find-input');
  const prevBtn = document.getElementById('find-prev');
  const nextBtn = document.getElementById('find-next');
  const closeBtn = document.getElementById('find-close');
  if (!input) return;

  const doFind = (forward, findNext) => {
    const text = input.value;
    const count = document.getElementById('find-count');
    if (!text) {
      window.myApps.invoke('link:find-stop');
      if (count) count.textContent = '';
      return;
    }
    window.myApps.invoke('link:find', text, { forward, findNext });
  };

  input.addEventListener('input', () => doFind(true, false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doFind(!e.shiftKey, true); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFindBar(); }
  });
  prevBtn.addEventListener('click', () => doFind(false, true));
  nextBtn.addEventListener('click', () => doFind(true, true));
  closeBtn.addEventListener('click', () => closeFindBar());
}

export function openFindBar() {
  const bar = document.getElementById('find-bar');
  const input = document.getElementById('find-input');
  if (!bar || !input) return;
  findOpen = true;
  bar.classList.add('open');
  input.focus();
  input.select();
}

export function closeFindBar() {
  const bar = document.getElementById('find-bar');
  const count = document.getElementById('find-count');
  if (!bar || !findOpen) return;
  findOpen = false;
  bar.classList.remove('open');
  if (count) count.textContent = '';
  window.myApps.invoke('link:find-stop');
}

export function isFindBarOpen() {
  return findOpen;
}

export function onFindResult(payload) {
  if (!findOpen) return;
  const count = document.getElementById('find-count');
  if (count) count.textContent = payload.matches ? `${payload.activeMatchOrdinal}/${payload.matches}` : '0/0';
}
