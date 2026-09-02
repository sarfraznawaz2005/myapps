// Tiny state store: get/set/subscribe. No framework, no VDOM — components
// subscribe and do targeted DOM updates themselves.

let state = {
  version: 1,
  settings: {},
  ui: { window: {}, sidebarWidth: 240, sidebarCollapsed: false, lastActiveLinkId: null, showToolbar: true },
  groups: [],
  links: [],
  unread: {}, // linkId -> { count, activity, source, stale }
  aggregate: 0,
  activeLinkId: null,
  linkStatus: {}, // linkId -> { loading, canGoBack, canGoForward, url, error, crashed, hibernated }
  loadedLinkIds: [],
};

const listeners = new Set();

export function getState() {
  return state;
}

export function setState(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) {
    try { fn(state); } catch (e) { console.error(e); }
  }
}

export function mergeMapField(field, key, value) {
  setState({ [field]: { ...state[field], [key]: value } });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getLink(id) {
  return state.links.find((l) => l.id === id) || null;
}

export function getGroup(id) {
  return state.groups.find((g) => g.id === id) || null;
}
