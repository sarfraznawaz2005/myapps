'use strict';

const { Menu, dialog, shell, clipboard } = require('electron');
const { CH } = require('./constants');
const favicon = require('./favicon');

async function confirmDialog(mainWindow, { title, message, detail, checkboxLabel }) {
  const opts = {
    type: 'warning',
    buttons: ['Cancel', 'Delete'],
    defaultId: 1,
    cancelId: 0,
    title,
    message,
    detail,
  };
  if (checkboxLabel) {
    opts.checkboxLabel = checkboxLabel;
    opts.checkboxChecked = false;
  }
  const result = await dialog.showMessageBox(mainWindow, opts);
  return result;
}

function showLinkContextMenu({ linkId, store, viewManager, mainWindow, sendToShell }) {
  const link = store.getState().links.find((l) => l.id === linkId);
  if (!link) return;
  const loaded = viewManager.isLoaded(linkId);

  const template = [
    { label: 'Reload', enabled: loaded, click: () => viewManager.reload(linkId) },
    {
      label: loaded ? 'Hibernate now' : 'Wake',
      click: () => (loaded ? viewManager.hibernate(linkId) : viewManager.activate(linkId)),
    },
    { label: link.muted ? 'Unmute' : 'Mute', click: () => store.updateLink(linkId, { muted: !link.muted }) },
    { type: 'separator' },
    { label: 'Open in browser', click: () => shell.openExternal(link.url) },
    { label: 'Copy URL', click: () => clipboard.writeText(link.url) },
    { type: 'separator' },
    { label: 'Edit…', click: () => sendToShell(CH.SHELL_OPEN_DIALOG, { type: 'edit-link', linkId }) },
    {
      label: 'Clear login data…',
      click: async () => {
        const result = await confirmDialog(mainWindow, {
          title: 'Clear login data',
          message: `Sign "${link.name}" out and clear its cookies/local storage?`,
          detail: 'The next load will start fresh, as if never signed in.',
        });
        if (result.response === 1) {
          await viewManager.clearData(linkId);
          favicon.removeCachedFavicon(linkId);
        }
      },
    },
    {
      label: 'Delete…',
      click: async () => {
        const { settings } = store.getState();
        let deleteData = false;
        if (settings.confirmDelete) {
          const result = await confirmDialog(mainWindow, {
            title: 'Delete link',
            message: `Delete "${link.name}"?`,
            detail: 'This removes it from My Apps.',
            checkboxLabel: 'Also delete saved login data (sign out)',
          });
          if (result.response !== 1) return;
          deleteData = !!result.checkboxChecked;
        }
        if (viewManager.isLoaded(linkId)) viewManager.hibernate(linkId);
        if (deleteData) {
          await viewManager.clearData(linkId);
          favicon.removeCachedFavicon(linkId);
        }
        store.deleteLink(linkId);
      },
    },
  ];

  Menu.buildFromTemplate(template).popup({ window: mainWindow });
}

module.exports = { showLinkContextMenu, confirmDialog };
