'use strict';

const { Menu, clipboard } = require('electron');

// Electron ships no default right-click menu (Copy/Paste/Select All) —
// unlike a real browser, that only exists if the app builds one itself via
// the 'context-menu' event. Attach this to every webContents that should
// behave like a normal text field/page: the shell's own inputs, and every
// loaded link.
//
// withPageControls adds Back/Forward/Reload/Copy page URL as a fallback so
// right-clicking blank space on a loaded link's page (no text field, no
// selection, no link under the cursor) still shows a menu, like a real
// browser — instead of showing nothing at all.
function attachEditContextMenu(webContents, { withPageControls = false } = {}) {
  webContents.on('context-menu', (_event, params) => {
    const template = [];

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        template.push({ label: suggestion, click: () => webContents.replaceMisspelling(suggestion) });
      }
      if (params.dictionarySuggestions.length) template.push({ type: 'separator' });
      template.push({
        label: 'Add to dictionary',
        click: () => webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      template.push({ type: 'separator' });
    }

    if (params.isEditable) {
      template.push(
        { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { label: 'Select All', role: 'selectAll', enabled: params.editFlags.canSelectAll }
      );
    } else if (params.selectionText) {
      template.push({ label: 'Copy', role: 'copy' });
    }

    if (params.linkURL) {
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) });
    }

    if (!template.length && withPageControls) {
      template.push(
        { label: 'Back', enabled: webContents.canGoBack(), click: () => webContents.goBack() },
        { label: 'Forward', enabled: webContents.canGoForward(), click: () => webContents.goForward() },
        { label: 'Reload', click: () => webContents.reload() },
        { type: 'separator' },
        { label: 'Copy page URL', click: () => clipboard.writeText(webContents.getURL()) }
      );
    }

    if (!template.length) return;
    Menu.buildFromTemplate(template).popup();
  });
}

module.exports = { attachEditContextMenu };
