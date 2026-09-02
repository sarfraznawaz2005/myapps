'use strict';

const { CH } = require('./constants');

function getFlattenedLinkOrder(store) {
  const { groups, links } = store.getState();
  const groupOrder = [null, ...groups.slice().sort((a, b) => a.order - b.order).map((g) => g.id)];
  const out = [];
  for (const gid of groupOrder) {
    links
      .filter((l) => (l.groupId || null) === gid && l.enabled)
      .sort((a, b) => a.order - b.order)
      .forEach((l) => out.push(l.id));
  }
  return out;
}

// Wires Ctrl+1..9 / Ctrl+R / Ctrl+L / Ctrl+K / F12 / Alt+Left/Right on a
// given webContents (the shell window or any embedded link view — Electron
// has no menu-bar accelerators since Menu.setApplicationMenu(null), so this
// is the only place these shortcuts are wired).
function attachShortcuts(wc, { store, viewManager, mainWindow }) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;

    if (ctrl && !input.shift && !input.alt && /^[1-9]$/.test(input.key)) {
      const order = getFlattenedLinkOrder(store);
      const idx = parseInt(input.key, 10) - 1;
      if (order[idx]) {
        event.preventDefault();
        viewManager.activate(order[idx]);
      }
      return;
    }

    if (ctrl && !input.shift && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      const id = viewManager.getActiveId();
      if (id) viewManager.reload(id);
      return;
    }

    if (ctrl && !input.shift && input.key.toLowerCase() === 'l') {
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(CH.SHELL_OPEN_DIALOG, { type: 'focus-url' });
      }
      return;
    }

    if (ctrl && !input.shift && input.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(CH.SHELL_OPEN_DIALOG, { type: 'quick-switch' });
      }
      return;
    }

    if (input.key === 'F12') {
      event.preventDefault();
      if (!wc.isDestroyed()) wc.toggleDevTools();
      return;
    }

    if (input.alt && !ctrl && input.key === 'ArrowLeft') {
      event.preventDefault();
      const id = viewManager.getActiveId();
      if (id) viewManager.goBack(id);
      return;
    }

    if (input.alt && !ctrl && input.key === 'ArrowRight') {
      event.preventDefault();
      const id = viewManager.getActiveId();
      if (id) viewManager.goForward(id);
    }
  });
}

module.exports = { attachShortcuts, getFlattenedLinkOrder };
