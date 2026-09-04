'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Explicit allowlists — window.myApps never exposes ipcRenderer itself, and
// any channel not in one of these three sets is silently rejected.

const INVOKE_CHANNELS = new Set([
  'app:get-state', 'app:quit',
  'link:create', 'link:update', 'link:delete', 'link:reorder', 'link:activate',
  'link:hibernate', 'link:reload', 'link:clear-data', 'link:devtools',
  'link:test-expert-rule', 'link:pick-element', 'link:probe-url',
  'group:create', 'group:update', 'group:delete', 'group:reorder',
  'settings:update', 'settings:export', 'settings:import',
  'dnd:set',
  'nav:go', 'nav:navigate', 'nav:copy-url', 'nav:open-external',
  'metrics:get', 'menu:link-context',
  'link:permission-respond',
]);

const SEND_CHANNELS = new Set(['ui:layout', 'ui:modal-open', 'ui:ready']);

const ON_CHANNELS = new Set([
  'shell:state', 'shell:unread', 'shell:aggregate', 'shell:nav',
  'shell:link-status', 'shell:favicon', 'shell:audio', 'shell:active',
  'shell:toast', 'shell:open-dialog', 'shell:permission-prompt',
]);

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
