'use strict';

const { getFlattenedLinkOrder } = require('./shortcuts');

// Ctrl+Tab link switcher (like switching browser tabs, with a picture of every link).
//
//   Ctrl+Tab (or Ctrl+Shift+Tab)   opens it with the link you are on highlighted
//   Tab / Shift+Tab again          move to the next / previous card (the arrow keys move too)
//   let go of Ctrl                 switch to the highlighted link   (Enter does the same)
//   Esc, or a click outside the cards   close without switching
//
// Cards: links that are awake (loaded) first, then asleep ones, each A to Z by name.
// The card of the link you are on is tagged "Current".
//
// Ctrl+Tab itself is caught on the window like the other shortcuts. Once it is open the
// overlay page takes the keyboard focus and sends every key press / release here
// (source 'overlay'). It has to be that way: when the window swallows a key press,
// Chromium also drops the matching key release, so the release of Ctrl would never
// arrive. It only works while a My Apps window has keyboard focus.

// Safety only: if the release of Ctrl is never delivered, this long with no key event at
// all ends the gesture. While Ctrl is held Windows keeps repeating its key press, which
// restarts this, so holding never reaches it. Normally the release itself switches at once.
const RELEASE_FALLBACK_MS = 2000;

class LinkSwitcher {
  // getStatus(id) -> { asleep, count, activity } for the little status icon on each card.
  constructor({ store, viewManager, overlay, getStatus }) {
    this.store = store;
    this.viewManager = viewManager;
    this.overlay = overlay; // draws the cards: show(state) / update(state) / hide()
    this.getStatus = getStatus || (() => ({}));
    this.isOpen = false;
    this.cards = []; // every card, in display order
    this.index = 0; // the highlighted card
    this.ctrlHeld = false;
    this.timers = { set: setTimeout, clear: clearTimeout }; // replaceable in tests
    this.fallbackTimer = null;
  }

  enabled() {
    return this.store.getState().settings.linkSwitcher !== false;
  }

  // Awake links first (they are the ones you are using), then asleep ones; each group
  // A to Z by name, ignoring case and treating numbers as numbers ("App 2" before "App 10").
  order() {
    const byId = new Map(this.store.getState().links.map((l) => [l.id, l]));
    const sidebar = getFlattenedLinkOrder(this.store);
    const rank = new Map(sidebar.map((id, i) => [id, i]));
    const asleep = (id) => !!(this.getStatus(id) || {}).asleep;
    const name = (id) => (byId.get(id) && byId.get(id).name) || '';
    return sidebar.slice().sort((x, y) => (
      (asleep(x) ? 1 : 0) - (asleep(y) ? 1 : 0)
      || name(x).localeCompare(name(y), undefined, { sensitivity: 'base', numeric: true })
      || rank.get(x) - rank.get(y)
    ));
  }

  // What each card shows: name, icon (a picture file, or the first letter) and status.
  buildCards(ids) {
    const byId = new Map(this.store.getState().links.map((l) => [l.id, l]));
    const active = this.viewManager.getActiveId();
    return ids.map((id) => {
      const link = byId.get(id) || {};
      const iconPath = link.icon && link.icon.path;
      const name = link.name || '';
      const status = this.getStatus(id) || {};
      return {
        id,
        name,
        icon: iconPath ? `file:///${iconPath.replace(/\\/g, '/')}` : null,
        letter: ((link.icon && link.icon.fallbackLetter) || name.trim()[0] || '?').toUpperCase(),
        current: id === active,
        asleep: !!status.asleep,
        count: typeof status.count === 'number' ? status.count : null,
        activity: !!status.activity,
      };
    });
  }

  // What the overlay draws.
  state() {
    return { items: this.cards, index: this.index };
  }

  open() {
    const ids = this.order();
    if (ids.length < 2) return false; // nothing to switch between
    this.cards = this.buildCards(ids);
    this.index = Math.max(0, this.cards.findIndex((card) => card.current)); // start on the link you are on
    this.isOpen = true;
    this.ctrlHeld = true; // opened with Ctrl down
    // Drawn on top of the page without hiding it or moving keyboard focus away from the
    // app's own windows until the overlay takes it (see the note at the top).
    this.overlay.show(this.state());
    this.armFallback();
    return true;
  }

  step(direction) {
    if (!this.isOpen || !this.cards.length) return;
    const n = this.cards.length;
    this.index = (this.index + direction + n) % n;
    this.overlay.update(this.state());
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.disarmFallback();
    this.overlay.hide();
  }

  // Switch to the highlighted card and close.
  commit() {
    if (!this.isOpen) return;
    const card = this.cards[this.index];
    this.close();
    if (card && card.id !== this.viewManager.getActiveId()) this.viewManager.activate(card.id);
    else this.viewManager.focusActive();
  }

  cancel() {
    if (!this.isOpen) return;
    this.close();
    this.viewManager.focusActive();
  }

  // The window lost focus: close without switching.
  onBlur() {
    this.cancel();
  }

  // A click on a card in the overlay.
  pick(index) {
    if (!this.isOpen || !Number.isInteger(index) || index < 0 || index >= this.cards.length) return;
    this.index = index;
    this.commit();
  }

  armFallback() {
    this.disarmFallback();
    this.fallbackTimer = this.timers.set(() => { this.fallbackTimer = null; this.commit(); }, RELEASE_FALLBACK_MS);
  }

  disarmFallback() {
    if (this.fallbackTimer) { this.timers.clear(this.fallbackTimer); this.fallbackTimer = null; }
  }

  // Is Ctrl down? From which key went down or up; the modifier flags of any other
  // key are a free correction. The flags of the Ctrl release itself are not trusted.
  trackHeld(input) {
    if (input.key === 'Control') this.ctrlHeld = input.type === 'keyDown';
    else this.ctrlHeld = !!input.control;
  }

  // Feed every key event here. source is 'window' for the app's windows (they can open it)
  // or 'overlay' for the keys the overlay page reports while it is open. Returns true when
  // the key was used by the switcher (a window must then stop it reaching the page).
  handleInput(input, source = 'window') {
    // MYAPPS_KEYDBG=1 prints only Ctrl / Tab / arrow / Enter / Esc events, to find out
    // which key events Windows really delivers.
    if (process.env.MYAPPS_KEYDBG && ['Control', 'Tab', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(input.key)) {
      console.log('[switcher-keys]', source, input.type, input.key, `ctrl=${!!input.control} shift=${!!input.shift} repeat=${!!input.isAutoRepeat} open=${this.isOpen}`);
    }
    if (!this.enabled() || this.viewManager.locked) {
      if (this.isOpen) this.cancel();
      return false;
    }

    // While it is open the keys come from the overlay page, which has the focus. Anything the
    // windows still report is only an echo (Chromium fakes key releases when focus moves).
    if (this.isOpen && source !== 'overlay') return false;
    if (!this.isOpen && source === 'overlay') return false;

    const isTab = input.type === 'keyDown' && input.key === 'Tab';

    if (!this.isOpen) {
      // Ctrl+Tab / Ctrl+Shift+Tab; a held key repeats, only a fresh press opens it.
      return isTab && !!input.control && !input.alt && !input.meta && !input.isAutoRepeat && this.open();
    }

    this.trackHeld(input);

    // Letting go of Ctrl switches. The key itself is not swallowed, so the page never
    // sees a release without its press.
    if (input.type === 'keyUp') {
      if (!this.ctrlHeld) this.commit();
      else this.armFallback();
      return false;
    }
    if (input.type !== 'keyDown') return false;

    switch (input.key) {
      case 'Tab': this.step(input.shift ? -1 : 1); break; // held Tab repeats and keeps moving
      case 'ArrowRight': case 'ArrowDown': this.step(1); break;
      case 'ArrowLeft': case 'ArrowUp': this.step(-1); break;
      case 'Enter': this.commit(); break;
      case 'Escape': this.cancel(); break;
      default: break; // every other key is used up, so it never reaches the page behind
    }
    if (this.isOpen) this.armFallback();
    return true;
  }
}

module.exports = { LinkSwitcher };
