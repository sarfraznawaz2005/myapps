'use strict';

// Every IPC channel name used by the app lives here so main and preload
// scripts never have to guess a string literal.

const APP_ID = 'com.myapps.desktopapp';
const STORE_VERSION = 1;

const TOOLBAR_HEIGHT = 40;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 420;
const SIDEBAR_COLLAPSED_WIDTH = 48;

// Shell (renderer) -> main, invoke (request/response)
const CH = {
  APP_GET_STATE: 'app:get-state',
  APP_QUIT: 'app:quit',

  LINK_CREATE: 'link:create',
  LINK_UPDATE: 'link:update',
  LINK_DELETE: 'link:delete',
  LINK_REORDER: 'link:reorder',
  LINK_ACTIVATE: 'link:activate',
  LINK_HIBERNATE: 'link:hibernate',
  LINK_RELOAD: 'link:reload',
  LINK_CLEAR_DATA: 'link:clear-data',
  LINK_DEVTOOLS: 'link:devtools',
  LINK_TEST_EXPERT_RULE: 'link:test-expert-rule',
  LINK_PICK_ELEMENT: 'link:pick-element',
  LINK_PROBE_URL: 'link:probe-url',

  GROUP_CREATE: 'group:create',
  GROUP_UPDATE: 'group:update',
  GROUP_DELETE: 'group:delete',
  GROUP_REORDER: 'group:reorder',

  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_EXPORT: 'settings:export',
  SETTINGS_IMPORT: 'settings:import',

  DND_SET: 'dnd:set',

  NAV_GO: 'nav:go',
  NAV_NAVIGATE: 'nav:navigate',
  NAV_COPY_URL: 'nav:copy-url',
  NAV_OPEN_EXTERNAL: 'nav:open-external',

  METRICS_GET: 'metrics:get',
  MENU_LINK_CONTEXT: 'menu:link-context',

  // Shell -> main, send (fire and forget)
  UI_LAYOUT: 'ui:layout',
  UI_MODAL_OPEN: 'ui:modal-open',
  UI_READY: 'ui:ready',

  // Main -> shell
  SHELL_STATE: 'shell:state',
  SHELL_UNREAD: 'shell:unread',
  SHELL_AGGREGATE: 'shell:aggregate',
  SHELL_NAV: 'shell:nav',
  SHELL_LINK_STATUS: 'shell:link-status',
  SHELL_FAVICON: 'shell:favicon',
  SHELL_AUDIO: 'shell:audio',
  SHELL_ACTIVE: 'shell:active',
  SHELL_TOAST: 'shell:toast',
  SHELL_OPEN_DIALOG: 'shell:open-dialog',

  // Link preload -> main
  LINK_BOOTSTRAP: 'link:bootstrap',
  LINK_BADGE: 'link:badge',
  LINK_EXPERT: 'link:expert',
  LINK_NOTIFICATION: 'link:notification',
  LINK_PICKED_ELEMENT: 'link:picked-element',

  // Main -> link preload
  LINK_CONFIG: 'link:config',
  LINK_NOTIF_CLICK_PREFIX: 'link:notif-click:',
  LINK_START_PICKER: 'link:start-picker',
  LINK_STOP_PICKER: 'link:stop-picker',
};

function notifClickChannel(linkId) {
  return `${CH.LINK_NOTIF_CLICK_PREFIX}${linkId}`;
}

// Ordered title regexes, first capturing group = unread count.
const TITLE_UNREAD_PATTERNS = [
  /^\((\d+)\)/,
  /\((\d+)\)\s*$/,
  /^(\d+)\s*[·•-]/,
  // Catch-all: a parenthesized number anywhere in the title. Needed for
  // titles like Gmail's "Inbox (3) - user@gmail.com - Gmail", where the
  // count sits mid-string and none of the anchored patterns above match.
  /\((\d+)\)/,
];

const FAVICON_UNREAD_KEYWORDS = /unread|unseen|alert|new/i;
const FAVICON_READ_KEYWORDS = /seen|read|default/i;

module.exports = {
  APP_ID,
  STORE_VERSION,
  TOOLBAR_HEIGHT,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  SIDEBAR_COLLAPSED_WIDTH,
  CH,
  notifClickChannel,
  TITLE_UNREAD_PATTERNS,
  FAVICON_UNREAD_KEYWORDS,
  FAVICON_READ_KEYWORDS,
};
