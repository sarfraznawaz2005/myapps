'use strict';

// Preload of the Ctrl+Tab switcher overlay. The overlay page has the keyboard focus
// while it is open and can only report what happened: a key press / release, a click
// on a card, or a click outside. The main process checks the sender and every value
// before doing anything.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('switcherBridge', {
  pick: (index) => ipcRenderer.send('switcher:pick', index),
  cancel: () => ipcRenderer.send('switcher:cancel'),
  key: (input) => ipcRenderer.send('switcher:key', input),
});
