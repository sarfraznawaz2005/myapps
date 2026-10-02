'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Explicit allowlists — window.myApps never exposes ipcRenderer itself, and
// any channel not in one of these three sets is silently rejected.

const INVOKE_CHANNELS = new Set([
  'app:get-state', 'app:quit', 'app:check-update', 'app:open-external-url',
  'link:create', 'link:update', 'link:delete', 'link:reorder', 'link:activate',
  'link:hibernate', 'link:reload', 'link:clear-data', 'link:devtools', 'link:zoom', 'link:view-mode', 'link:dark-mode',
  'link:whatsapp-get', 'link:whatsapp-set', 'link:whatsapp-chat',
  'link:test-expert-rule', 'link:pick-element', 'link:probe-url',
  'link:find', 'link:find-stop',
  'group:create', 'group:update', 'group:delete', 'group:reorder',
  'userscript:create', 'userscript:update', 'userscript:delete',
  'command:create', 'command:update', 'command:delete',
  'note:set',
  'settings:update', 'settings:export', 'settings:import',
  'dnd:set',
  'nav:go', 'nav:navigate', 'nav:copy-url', 'nav:open-external',
  'metrics:get', 'menu:link-context',
  'link:permission-respond',
  'lock:status', 'lock:unlock', 'lock:now', 'lock:set', 'lock:remove',
  'pm:manage-list', 'pm:delete', 'pm:clear-all', 'pm:unnever', 'pm:key-set', 'pm:key-clear',
]);

const SEND_CHANNELS = new Set(['ui:layout', 'ui:modal-open', 'ui:ready']);

const ON_CHANNELS = new Set([
  'shell:state', 'shell:unread', 'shell:aggregate', 'shell:nav',
  'shell:link-status', 'shell:favicon', 'shell:audio', 'shell:active',
  'shell:toast', 'shell:open-dialog', 'shell:permission-prompt', 'shell:find-result',
  'shell:lock',
]);

// When the app starts locked, main passes --app-locked so the shell is
// hidden from the very first paint (no flash of the sidebar before the lock
// screen script runs).
if (process.argv.includes('--app-locked')) {
  const mark = () => { if (document.documentElement) document.documentElement.setAttribute('data-locked', '1'); };
  mark();
  document.addEventListener('DOMContentLoaded', mark);
}

function invoke(channel, ...args) {
  if (!INVOKE_CHANNELS.has(channel)) {
    return Promise.reject(new Error(`Blocked invoke on channel: ${channel}`));
  }
  return ipcRenderer.invoke(channel, ...args);
}

function send(channel, ...args) {
  if (!SEND_CHANNELS.has(channel)) return;
  ipcRenderer.send(channel, ...args);
}

function on(channel, cb) {
  if (!ON_CHANNELS.has(channel)) return () => {};
  const listener = (_event, ...args) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('myApps', { invoke, send, on });
