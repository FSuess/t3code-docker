// The console's DOM layer: markup, patching, overlays, toasts and keys.
//
// app.js describes what the page should look like as markup strings built
// with `html`; this file owns how that reaches the screen. `patch` morphs the
// live DOM towards the new markup instead of replacing it, so a poll that
// changes one word changes one text node: focus, a half-typed input, a running
// spinner and a progress bar's transition all survive it. Overlays (sheets,
// dialogs, menus, the palette) live in their own layer outside #app, so a poll
// that repaints the page can never touch them.
const Kit = (() => {
  'use strict';

  // --------------------------------------------------------------- markup --
  /** Markup that is already safe. Everything else interpolated is escaped. */
  class Raw {
    constructor(text) { this.text = text; }
    toString() { return this.text; }
  }
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
  const raw = (text) => new Raw(String(text ?? ''));
  const part = (value) => {
    if (value === null || value === undefined || value === false) return '';
    if (value instanceof Raw) return value.text;
    if (Array.isArray(value)) return value.map(part).join('');
    return esc(value);
  };
  /** Tagged template: html`<b>${name}</b>` escapes name; nested html`` and arrays compose. */
  const html = (strings, ...values) => {
    let out = strings[0];
    for (let i = 0; i < values.length; i += 1) out += part(values[i]) + strings[i + 1];
    return new Raw(out);
  };
  const icon = (name, cls) => raw(window.T3C ? T3C.icon(name, cls) : '');
  /** A `class` attribute value from a list where falsy entries drop out. */
  const cx = (...names) => names.filter(Boolean).join(' ');

  // ---------------------------------------------------------------- patch --
  const scratch = document.createElement('template');
  const keyOf = (node) => (node.nodeType === 1 ? node.getAttribute('data-key') : null);

  const syncAttributes = (live, next) => {
    for (const { name } of [...live.attributes]) if (!next.hasAttribute(name)) live.removeAttribute(name);
    for (const { name, value } of [...next.attributes]) if (live.getAttribute(name) !== value) live.setAttribute(name, value);
  };

  const morphNode = (live, next) => {
    if (live.nodeType !== 1) {
      if (live.nodeValue !== next.nodeValue) live.nodeValue = next.nodeValue;
      return;
    }
    // A subtree a widget or the user owns (a QR that never changes, a field
    // mid-edit) opts out of being morphed.
    if (live.hasAttribute('data-keep') && next.hasAttribute('data-keep')) return;
    syncAttributes(live, next);
    // Form controls: the attribute is the default, the property is what the
    // user typed. Only the attribute is synced, so typing is never undone.
    if (live.nodeName === 'TEXTAREA' || live.nodeName === 'INPUT') return;
    morphChildren(live, next);
  };

  function morphChildren(live, next) {
    const keyed = new Map();
    for (let c = live.firstChild; c; c = c.nextSibling) {
      const k = keyOf(c);
      if (k) keyed.set(k, c);
    }
    let cursor = live.firstChild;
    let n = next.firstChild;
    while (n) {
      const following = n.nextSibling;
      const k = keyOf(n);
      let match = null;
      if (k) {
        const candidate = keyed.get(k);
        if (candidate && candidate.nodeName === n.nodeName) { match = candidate; keyed.delete(k); }
      } else if (cursor && !keyOf(cursor) && cursor.nodeType === n.nodeType && cursor.nodeName === n.nodeName) {
        match = cursor;
      }
      if (match) {
        if (match === cursor) cursor = cursor.nextSibling;
        else live.insertBefore(match, cursor);
        morphNode(match, n);
      } else {
        live.insertBefore(n, cursor);
      }
      n = following;
    }
    while (cursor) {
      const after = cursor.nextSibling;
      live.removeChild(cursor);
      cursor = after;
    }
  }

  /**
   * Bring `el`'s children in line with `markup`. Unchanged markup costs one
   * string comparison. Returns whether anything was touched.
   */
  const patch = (el, markup) => {
    if (!el) return false;
    const text = String(markup);
    if (el.__t3 === text) return false;
    el.__t3 = text;
    const active = document.activeElement;
    const focusKey = active && active !== document.body && el.contains(active) ? (active.id || active.getAttribute('data-key')) : null;
    scratch.innerHTML = text;
    morphChildren(el, scratch.content);
    // The focused control was replaced rather than morphed: put focus back on
    // its successor, so a keyboard user does not land on <body>.
    if (focusKey && !el.contains(active)) {
      const again = el.querySelector('#' + CSS.escape(focusKey) + ', [data-key="' + CSS.escape(focusKey) + '"]');
      if (again) again.focus({ preventScroll: true });
    }
    return true;
  };

  // ---------------------------------------------------------- environment --
  const PHONE = window.matchMedia('(max-width: 1023.98px)');
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');
  const isPhone = () => PHONE.matches;
  // Touch density follows the layout. The inline script in <body> set it for
  // the first paint; this keeps it current across a rotation or a resize.
  const syncDensity = () => {
    if (PHONE.matches) document.body.setAttribute('data-density', 'touch');
    else document.body.removeAttribute('data-density');
  };
  PHONE.addEventListener('change', syncDensity);

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
  const isTyping = (el) => Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.nodeName)) && !(el.type === 'checkbox' || el.type === 'radio' || el.type === 'button'));

  // A hidden live region for things that change without moving focus.
  let announcer = null;
  const announce = (text) => {
    if (!announcer) {
      announcer = document.createElement('div');
      announcer.className = 'tc-sr';
      announcer.setAttribute('aria-live', 'polite');
      document.body.appendChild(announcer);
    }
    announcer.textContent = '';
    setTimeout(() => { announcer.textContent = text; }, 30);
  };

  // --------------------------------------------------------------- layers --
  // One stack for every overlay. A modal layer makes the page inert, traps
  // Tab, and gives focus back to whatever opened it when it closes.
  const stack = [];
  const top = () => stack[stack.length - 1] || null;
  const appRoot = () => document.getElementById('app');

  const syncInert = () => {
    const modal = stack.some((l) => l.modal);
    const app = appRoot();
    if (app) app.inert = modal;
    document.documentElement.classList.toggle('tc-locked', modal);
  };

  const restoreFocus = (layer) => {
    const target = layer.returnTo;
    if (target && target.isConnected && !target.closest('[inert]')) { target.focus({ preventScroll: true }); return; }
    // The trigger was repainted away: its successor carries the same key. The
    // same key can exist on a page that is hidden, so take a visible one.
    const key = layer.returnKey;
    const again = key && [...document.querySelectorAll('[data-key="' + CSS.escape(key) + '"], #' + CSS.escape(key))]
      .find((el) => el.offsetParent !== null && !el.closest('[inert]'));
    if (again) { again.focus({ preventScroll: true }); return; }
    const main = document.getElementById('main');
    if (main) main.focus({ preventScroll: true });
  };

  /**
   * Open an overlay.
   *
   *   kind      sheet | center | palette | menu | bottom
   *   panel     the panel's tag and attributes, e.g. {tag:'aside', class:'tc-sheet', role:'dialog'}
   *   render    () => markup for the panel's contents; called again by layer.render()
   *   modal     inert the page and trap focus (default true)
   *   backdrop  'close' | 'ignore' | false: what a click outside does
   *   onEscape  what Escape does (default: close)
   *   onClose   called once with the reason
   *   focus     selector for the first focus; else [data-initial-focus], else the first focusable
   */
  const open = (opts) => {
    const host = document.getElementById('layers') || document.body;
    const layer = {
      kind: opts.kind,
      modal: opts.modal !== false,
      returnTo: opts.returnTo || document.activeElement,
      returnKey: null,
      onClose: opts.onClose || null,
      onEscape: opts.onEscape || null,
      closed: false,
    };
    const trigger = layer.returnTo;
    if (trigger && trigger !== document.body) layer.returnKey = trigger.getAttribute('data-key') || trigger.id || null;

    const el = document.createElement('div');
    el.className = 'tc-layer tc-layer--' + opts.kind;
    if (opts.backdrop !== false && opts.kind !== 'menu') {
      const backdrop = document.createElement('div');
      backdrop.className = 'tc-backdrop';
      backdrop.addEventListener('click', () => {
        if (opts.backdrop === 'ignore') {
          // Nudge focus back into the panel rather than doing nothing silently.
          const first = focusables(panel)[0];
          if (first) first.focus({ preventScroll: true });
          return;
        }
        layer.close('backdrop');
      });
      el.appendChild(backdrop);
    }
    const spec = opts.panel || {};
    const panel = document.createElement(spec.tag || 'div');
    for (const [name, value] of Object.entries(spec)) {
      if (name === 'tag' || value === null || value === undefined || value === false) continue;
      panel.setAttribute(name, value === true ? '' : String(value));
    }
    if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
    el.appendChild(panel);
    layer.el = el;
    layer.panel = panel;
    layer.render = () => { if (!layer.closed) patch(panel, opts.render()); };
    layer.close = (reason) => {
      if (layer.closed) return;
      layer.closed = true;
      const i = stack.indexOf(layer);
      if (i !== -1) stack.splice(i, 1);
      syncInert();
      const finish = () => el.remove();
      if (REDUCED.matches || opts.kind === 'menu') finish();
      else { el.setAttribute('data-closing', ''); setTimeout(finish, 140); }
      if (reason !== 'replaced') restoreFocus(layer);
      if (layer.onClose) layer.onClose(reason || 'close');
    };

    stack.push(layer);
    host.appendChild(el);
    layer.render();
    syncInert();
    const first = (opts.focus && panel.querySelector(opts.focus)) || panel.querySelector('[data-initial-focus]') || focusables(panel)[0] || panel;
    first.focus({ preventScroll: true });
    return layer;
  };

  /** Whether the ⋯ menu opened from the control keyed `key` is showing. */
  const menuOpenFor = (key) => stack.some((l) => (l.kind === 'menu' || l.kind === 'bottom') && l.returnKey === key);

  /** Close every overlay, top first (a route change, a lock). */
  const closeAll = (reason) => { while (stack.length) top().close(reason || 'close'); };

  document.addEventListener('keydown', (e) => {
    const layer = top();
    if (!layer) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (layer.onEscape) layer.onEscape();
      else layer.close('escape');
      return;
    }
    if (e.key === 'Tab' && layer.modal) {
      const items = focusables(layer.panel);
      if (!items.length) { e.preventDefault(); layer.panel.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !layer.panel.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !layer.panel.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
  }, true);

  // A popover menu closes when anything outside it is pressed, or the page moves.
  document.addEventListener('pointerdown', (e) => {
    const layer = top();
    if (layer && layer.kind === 'menu' && !layer.panel.contains(e.target) && !(layer.returnTo && layer.returnTo.contains(e.target))) layer.close('outside');
  }, true);
  const closeMenusOnMove = () => { const layer = top(); if (layer && layer.kind === 'menu') layer.close('moved'); };
  window.addEventListener('resize', closeMenusOnMove);
  window.addEventListener('scroll', closeMenusOnMove, true);

  // ---------------------------------------------------------------- menus --
  const menuItems = (items) => items.map((item, i) => item.sep
    ? html`<hr class="tc-menu-sep">`
    : html`<button class="${cx('tc-menu-item', item.danger && 'tc-menu-item--danger')}" role="menuitem" type="button" data-menu-index="${i}"${item.disabled ? raw(' disabled') : ''}>${icon(item.icon)}<span class="tc-menu-item-text">${item.label}</span>${item.shortcut ? html`<span class="tc-menu-item-shortcut">${item.shortcut}</span>` : ''}</button>`);

  const wireMenu = (layer, items) => {
    const buttons = () => [...layer.panel.querySelectorAll('.tc-menu-item:not([disabled])')];
    layer.panel.addEventListener('click', (e) => {
      const button = e.target.closest('[data-menu-index]');
      if (button) {
        const item = items[Number(button.getAttribute('data-menu-index'))];
        layer.close('select');
        if (item && item.run) item.run();
        return;
      }
      if (e.target.closest('[data-menu-cancel]')) layer.close('cancel');
    });
    layer.panel.addEventListener('keydown', (e) => {
      const list = buttons();
      const at = list.indexOf(document.activeElement);
      let next = null;
      if (e.key === 'ArrowDown') next = list[(at + 1) % list.length];
      else if (e.key === 'ArrowUp') next = list[(at - 1 + list.length) % list.length];
      else if (e.key === 'Home') next = list[0];
      else if (e.key === 'End') next = list[list.length - 1];
      else if (e.key === 'Tab' && layer.kind === 'menu') { layer.close('tab'); return; }
      if (next) { e.preventDefault(); next.focus(); }
    });
  };

  /**
   * A row's ⋯ menu: a popover under the trigger on desktop, a bottom sheet
   * with a title row and a full-width Cancel on a phone.
   *
   *   head   {title, sub, tile: markup}  (the sheet's title row; the popover's label)
   *   items  [{label, icon, danger, run} | {sep: true}]
   */
  const menu = (trigger, { label, head, items }) => {
    const current = top();
    if (current && current.kind === 'menu' && current.returnTo === trigger) { current.close('toggle'); return null; }
    if (isPhone()) {
      const titleId = 'menu-title-' + Math.random().toString(36).slice(2, 8);
      const layer = open({
        kind: 'bottom',
        panel: { tag: 'aside', class: 'tc-sheet tc-sheet--bottom', role: 'menu', 'aria-labelledby': titleId },
        returnTo: trigger,
        render: () => html`
          <div class="tc-sheet-head tc-menu-head">${head && head.tile ? head.tile : ''}<div class="tc-menu-head-text"><h2 class="tc-sheet-title" id="${titleId}">${(head && head.title) || label}</h2>${head && head.sub ? html`<span class="tc-small tc-muted">${head.sub}</span>` : ''}</div></div>
          <div class="tc-sheet-actions">${menuItems(items)}</div>
          <div class="tc-sheet-cancel"><button class="tc-btn tc-btn--block tc-btn--lg" type="button" data-menu-cancel>Cancel</button></div>`,
        backdrop: 'close',
      });
      wireMenu(layer, items);
      const first = layer.panel.querySelector('.tc-menu-item');
      if (first) first.focus({ preventScroll: true });
      return layer;
    }
    if (current && current.kind === 'menu') current.close('replaced');
    trigger.setAttribute('aria-expanded', 'true');
    const layer = open({
      kind: 'menu',
      modal: false,
      backdrop: false,
      returnTo: trigger,
      panel: { class: 'tc-menu', role: 'menu', 'aria-label': label },
      render: () => html`${head && head.title ? html`<div class="tc-menu-label">${head.title}${head.sub ? ' · ' + head.sub : ''}</div>` : ''}${menuItems(items)}`,
      onClose: () => trigger.setAttribute('aria-expanded', 'false'),
    });
    // 4px under the trigger, right edges aligned; above it if there is no room.
    const r = trigger.getBoundingClientRect();
    const m = layer.panel.getBoundingClientRect();
    const margin = 8;
    let left = Math.min(Math.max(margin, r.right - m.width), window.innerWidth - m.width - margin);
    let topPx = r.bottom + 4;
    if (topPx + m.height > window.innerHeight - margin && r.top - 4 - m.height > margin) {
      topPx = r.top - 4 - m.height;
      layer.panel.style.transformOrigin = 'bottom right';
    }
    layer.panel.style.left = left + 'px';
    layer.panel.style.top = topPx + 'px';
    wireMenu(layer, items);
    const first = layer.panel.querySelector('.tc-menu-item');
    if (first) first.focus({ preventScroll: true });
    return layer;
  };

  // -------------------------------------------------------------- dialogs --
  /**
   * Ask before something that cannot be undone. Resolves true only when the
   * confirm button itself is pressed: focus starts on Cancel, Enter never
   * confirms, and Escape or a click outside cancels.
   *
   *   title, body (markup), consequences [{icon, text}], confirm (label), tone ('danger' | 'primary')
   */
  const confirm = ({ title, body, consequences, confirm: confirmLabel, tone }) => new Promise((resolve) => {
    let answered = false;
    const id = 'dlg-' + Math.random().toString(36).slice(2, 8);
    const layer = open({
      kind: 'center',
      panel: { class: 'tc-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': id + '-t', 'aria-describedby': id + '-d' },
      render: () => html`
        <div class="tc-dialog-body">
          <h2 class="tc-dialog-title" id="${id}-t">${title}</h2>
          <p class="tc-dialog-desc" id="${id}-d">${body}</p>
          ${consequences && consequences.length ? html`<ul class="tc-consequences">${consequences.map((c) => html`<li>${icon(c.icon)}<span>${c.text}</span></li>`)}</ul>` : ''}
        </div>
        <div class="tc-dialog-foot">
          <button class="tc-btn tc-btn--ghost" type="button" data-initial-focus data-answer="no">Cancel</button>
          <button class="${cx('tc-btn', tone === 'primary' ? 'tc-btn--primary' : 'tc-btn--danger-solid')}" type="button" data-answer="yes" data-confirm>${confirmLabel}</button>
        </div>`,
      backdrop: 'close',
      onClose: () => { if (!answered) resolve(false); },
    });
    layer.panel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.closest('[data-confirm]')) e.preventDefault();
    });
    layer.panel.addEventListener('click', (e) => {
      const button = e.target.closest('[data-answer]');
      if (!button) return;
      answered = true;
      const yes = button.getAttribute('data-answer') === 'yes';
      layer.close(yes ? 'confirm' : 'cancel');
      resolve(yes);
    });
  });

  // --------------------------------------------------------------- toasts --
  const TOAST_MS = 4000;
  const TOAST_MAX = 3;
  /**
   * Bottom-right on desktop, bottom-centre above the tab bar on a phone. Three
   * at most; the oldest makes room. Danger stays until dismissed.
   *
   *   tone ('ok' | 'info' | 'danger'), detail, action {label, run}
   */
  const toast = (text, opts = {}) => {
    const host = document.getElementById('toaster');
    if (!host) return null;
    const tone = opts.tone || 'ok';
    const sticky = tone === 'danger' || opts.sticky;
    const node = document.createElement('div');
    node.className = 'tc-toast';
    node.setAttribute('data-tone', tone);
    node.setAttribute('role', tone === 'danger' ? 'alert' : 'status');
    node.innerHTML = String(html`${icon(tone === 'danger' ? 'circle-alert' : tone === 'info' ? 'info' : 'circle-check')}<span class="tc-toast-text"><span>${text}</span>${opts.detail ? html`<small>${opts.detail}</small>` : ''}</span>${opts.action ? html`<button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-toast-action>${opts.action.label}</button>` : ''}${sticky ? html`<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-toast-close aria-label="Dismiss">${icon('x')}</button>` : ''}`);
    let timer = null;
    const leave = () => {
      if (!node.isConnected || node.hasAttribute('data-leaving')) return;
      clearTimeout(timer);
      node.setAttribute('data-leaving', '');
      setTimeout(() => node.remove(), REDUCED.matches ? 0 : 200);
    };
    const arm = () => { if (!sticky) { clearTimeout(timer); timer = setTimeout(leave, TOAST_MS); } };
    node.addEventListener('mouseenter', () => clearTimeout(timer));
    node.addEventListener('mouseleave', arm);
    node.addEventListener('focusin', () => clearTimeout(timer));
    node.addEventListener('focusout', arm);
    node.addEventListener('click', (e) => {
      if (e.target.closest('[data-toast-close]')) leave();
      else if (e.target.closest('[data-toast-action]')) { leave(); opts.action.run(); }
    });
    host.appendChild(node);
    const live = [...host.children].filter((n) => !n.hasAttribute('data-leaving'));
    for (const old of live.slice(0, Math.max(0, live.length - TOAST_MAX))) {
      old.setAttribute('data-leaving', '');
      setTimeout(() => old.remove(), REDUCED.matches ? 0 : 200);
    }
    arm();
    return { close: leave };
  };

  // ----------------------------------------------------------------- copy --
  /**
   * Copy and say so on the control that asked: a labelled button reads
   * "Copied" for a moment; an icon button swaps to a check. When the browser
   * refuses, the text is selected and the button says which keys to press.
   */
  const copy = (text, button, message) => window.T3C.copyText(String(text ?? '')).then((ok) => {
    if (!ok) {
      const field = button && button.closest('.tc-copyfield');
      const value = field && field.querySelector('.tc-copyfield-value');
      if (value) {
        const range = document.createRange();
        range.selectNodeContents(value);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    const said = ok ? (message || 'Copied') : 'Press ' + window.T3C.copyKeys + ' to copy';
    if (button && button.isConnected) {
      const label = button.querySelector('[data-label]');
      if (label) {
        const was = label.textContent;
        label.textContent = ok ? 'Copied' : 'Press ' + window.T3C.copyKeys;
        setTimeout(() => { if (label.isConnected) label.textContent = was; }, 1600);
      } else if (ok) {
        const was = button.innerHTML;
        const wasLabel = button.getAttribute('aria-label');
        button.innerHTML = String(icon('check'));
        button.setAttribute('aria-label', 'Copied');
        setTimeout(() => {
          if (!button.isConnected) return;
          button.innerHTML = was;
          if (wasLabel) button.setAttribute('aria-label', wasLabel);
        }, 1600);
      }
      if (!label) (ok ? announce : (t) => toast(t, { tone: 'info' }))(said);
      else announce(said);
    } else {
      toast(said, { tone: ok ? 'ok' : 'info' });
    }
    return ok;
  });

  // ------------------------------------------------------------ shortcuts --
  /**
   * Single keys and two-key sequences ("g a"). Nothing fires while focus is in
   * a field or while a modal overlay is open; Escape belongs to the overlays.
   */
  const bindings = [];
  let pending = null;
  let pendingTimer = null;
  const bind = (keys, run, when) => bindings.push({ keys: keys.toLowerCase().split(' '), run, when: when || null });
  const modalOpen = () => stack.some((l) => l.modal);

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    // ⌘K / Ctrl K reaches the palette from anywhere, a field included: it is
    // not something anyone types.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      const hit = bindings.find((b) => b.keys[0] === 'mod+k');
      if (hit && (!modalOpen() || (top() && top().kind === 'palette'))) { e.preventDefault(); hit.run(e); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    if (isTyping(e.target) || modalOpen()) { pending = null; return; }
    const key = e.key.toLowerCase();
    const seq = pending ? [pending, key] : [key];
    const exact = bindings.find((b) => b.keys.length === seq.length && b.keys.every((k, i) => k === seq[i]) && (!b.when || b.when()));
    if (exact) {
      e.preventDefault();
      pending = null;
      clearTimeout(pendingTimer);
      exact.run(e);
      return;
    }
    if (!pending && bindings.some((b) => b.keys.length === 2 && b.keys[0] === key)) {
      pending = key;
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => { pending = null; }, 1200);
      return;
    }
    pending = null;
  });

  // -------------------------------------------------------------- palette --
  const markMatch = (label, match) => {
    if (!match) return esc(label);
    const [a, b] = match;
    return esc(label.slice(0, a)) + '<mark>' + esc(label.slice(a, b)) + '</mark>' + esc(label.slice(b));
  };

  /**
   * The command palette. `items()` lists what it can reach right now (asked
   * again on every search, so something that loads while it is open - the
   * registry - shows up on the next keystroke) and `search(items, query)` ranks
   * them; choosing one calls `run(item)` after the palette has closed, so
   * whatever it opens takes focus cleanly. The returned layer's `refresh()`
   * re-runs the current search.
   */
  const palette = ({ items, search, run }) => {
    const current = top();
    if (current && current.kind === 'palette') { current.close('toggle'); return; }
    closeAll('replaced');
    let query = '';
    let results = search(items(), '');
    let selected = 0;
    const listId = 'palette-list';
    const optionId = (i) => 'palette-opt-' + i;
    const layer = open({
      kind: 'palette',
      panel: { class: 'tc-palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' },
      backdrop: 'close',
      focus: 'input',
      render: () => {
        let lastGroup = null;
        const rows = [];
        results.forEach((item, i) => {
          if (item.group !== lastGroup) {
            rows.push(html`<li class="tc-listbox-group" role="presentation" data-key="g-${item.group}">${item.group}</li>`);
            lastGroup = item.group;
          }
          const meta = item.meta
            ? html`<span class="${cx('tc-option-meta', item.meta.mono && 'tc-mono')}">${item.meta.dot ? html`<span class="tc-dot tc-dot--${item.meta.dot}"></span>` : ''}${item.meta.text}</span>`
            : item.shortcut ? html`<span class="tc-option-meta"><span class="tc-kbd">${item.shortcut}</span></span>` : '';
          rows.push(html`<li class="tc-option" role="option" id="${optionId(i)}" data-key="o-${item.id}" data-index="${i}" aria-selected="${String(i === selected)}">${icon(item.icon)}<span class="tc-truncate">${raw(markMatch(item.label, item.match))}</span>${meta}</li>`);
        });
        return html`
          <div class="tc-palette-input">${icon('search', 'tc-muted')}<input type="text" role="combobox" aria-expanded="true" aria-controls="${listId}" aria-autocomplete="list" aria-activedescendant="${results.length ? optionId(selected) : ''}" aria-label="Search actions" placeholder="Search actions, agents, ports…" autocomplete="off" spellcheck="false"></div>
          ${results.length
            ? html`<ul class="tc-listbox" role="listbox" id="${listId}" aria-label="Results">${rows}</ul>`
            : html`<div class="tc-palette-empty" role="status">Nothing matches “${query}”.</div>`}
          <div class="tc-palette-foot"><span><span class="tc-kbd">↑</span><span class="tc-kbd">↓</span>Navigate</span><span><span class="tc-kbd">↵</span>Run</span><span style="margin-left:auto"><span class="tc-kbd">Esc</span>Close</span></div>`;
      },
    });
    const input = layer.panel.querySelector('input');
    const scrollToSelected = () => {
      const el = layer.panel.querySelector('#' + optionId(selected));
      if (el) el.scrollIntoView({ block: 'nearest' });
    };
    const choose = (i) => {
      const item = results[i];
      if (!item) return;
      layer.close('select');
      run(item);
    };
    layer.refresh = () => {
      if (layer.closed) return;
      const id = results[selected] && results[selected].id;
      results = search(items(), query);
      const keep = results.findIndex((r) => r.id === id);
      selected = keep === -1 ? 0 : keep;
      layer.render();
    };
    input.addEventListener('input', () => {
      query = input.value;
      results = search(items(), query);
      selected = 0;
      layer.render();
      const list = layer.panel.querySelector('.tc-listbox');
      if (list) list.scrollTop = 0;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!results.length) return;
        selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
        layer.render();
        scrollToSelected();
      } else if (e.key === 'Home' && results.length && !input.value) {
        selected = 0; layer.render(); scrollToSelected();
      } else if (e.key === 'End' && results.length && !input.value) {
        selected = results.length - 1; layer.render(); scrollToSelected();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        choose(selected);
      }
    });
    layer.panel.addEventListener('pointermove', (e) => {
      const option = e.target.closest('.tc-option');
      if (!option) return;
      const i = Number(option.getAttribute('data-index'));
      if (i !== selected) { selected = i; layer.render(); }
    });
    layer.panel.addEventListener('click', (e) => {
      const option = e.target.closest('.tc-option');
      if (option) choose(Number(option.getAttribute('data-index')));
    });
    return layer;
  };

  return {
    Raw, html, raw, esc, icon, cx, patch,
    isPhone, isTyping, PHONE, REDUCED, syncDensity, announce,
    open, closeAll, top: () => top(), menuOpenFor,
    menu, confirm, toast, copy, bind, palette,
  };
})();
