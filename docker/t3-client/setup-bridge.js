// T3 Code's way to the setup console, injected into T3 Code's client shell at
// image build time by docker/t3-client/patch.mjs.
//
// The console and T3 Code are separate services, and nothing in T3 Code knows
// the console exists. This adds it where a person would look for it:
//
//   - Before pairing, a Setup pill in the pairing screen's empty corner. It
//     opens the console in a tab of its own, which asks for the setup key.
//   - Once paired, a Setup entry at the end of the Settings sidebar. It opens
//     the console over T3 Code in a dialog, already signed in, because the
//     console accepts T3 Code's own session (docker/setup/t3-session.mjs).
//     Beside it, how many things need the person, counted as the console's
//     own badges count them.
//
// Both appear only when the console answers on this origin (the documented
// route puts it at /__setup), so a deployment that does not route it keeps
// exactly the upstream UI. Neither reaches into T3's React tree: the entry is
// a list of its own placed after T3's settings list, built by copying T3's own
// row so it matches whatever T3's styles are, and put back if T3 redraws the
// sidebar without it. Whether this browser is paired is T3's answer
// (/api/auth/session), not a guess from the path: T3 serves its app and its
// pairing screen at the same "/".
//
// Keep this file self-contained: it is inlined into an HTML script tag, so it
// must never contain a closing script tag sequence. The pure helpers at the
// top are what tests/t3-client.test.mjs loads, where there is no document.
(() => {
  'use strict';

  // ----------------------------------------------------------------- pure --
  // Where the console may answer: the documented route, then a shorter one.
  const PROBE_PATHS = ['/__setup/', '/setup/'];

  /** Whether a path is one of T3 Code's settings pages. */
  const isSettingsPath = (pathname) => /^\/settings(?:\/|$)/.test(String(pathname));

  /** The console's address in the dialog: embedded, in T3's theme, on a page. */
  const embedUrl = (base, theme, route) =>
    base + '?embed=t3&theme=' + (theme === 'dark' ? 'dark' : 'light') + (route ? '#' + route : '');

  /** The console's /hello answer, if it was the console that answered. */
  const readHello = (body) => (body && body.service === 't3-setup'
    ? {
      signedIn: body.signedIn === true,
      attention: Number.isInteger(body.attention) && body.attention > 0 ? body.attention : 0,
    }
    : null);

  /** The count beside Setup: nothing at zero, and never more than two digits. */
  const badgeText = (count) => (count > 99 ? '99+' : count > 0 ? String(count) : '');

  /** How the entry reads to a screen reader, count included. */
  const entryLabel = (count) => (count > 0
    ? 'Setup, ' + count + (count === 1 ? ' thing needs' : ' things need') + ' you'
    : 'Setup');

  /** A message from the console in our dialog, not from another frame or origin. */
  const fromConsole = (event, frame, origin) => Boolean(frame
    && event.source === frame.contentWindow
    && event.origin === origin
    && event.data && event.data.source === 't3-setup' && typeof event.data.type === 'string');

  if (typeof document === 'undefined') {
    globalThis.T3SetupBridge = { PROBE_PATHS, isSettingsPath, embedUrl, readHello, badgeText, entryLabel, fromConsole };
    return;
  }

  // ---------------------------------------------------------------- state --
  const state = {
    base: null,        // where the console answered, such as '/__setup/'
    paired: null,      // whether T3 Code has a session for this browser (null: not known)
    attention: 0,      // what needs the person, from the console
    checkedAt: 0,      // when the console was last asked for that count
    path: location.pathname,
    dialog: null,      // the open dialog: see openDialog
  };
  const ENTRY = 'data-t3-setup-entry';
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');

  // --------------------------------------------------------------- styles --
  // T3's own custom properties first, so the entry and the dialog follow its
  // theme, including a custom one; the fallbacks are its default palette.
  const CSS = [
    // The pill: first contact, before pairing.
    '.t3-setup-pill{position:fixed;left:calc(14px + env(safe-area-inset-left,0px));bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:2147483646;',
    'display:inline-flex;align-items:center;gap:7px;padding:7px 12px 7px 10px;border-radius:999px;',
    'border:1px solid rgba(0,0,0,.14);background:rgba(255,255,255,.92);color:#262626;',
    'font:500 12px/1.1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;text-decoration:none;',
    'box-shadow:0 2px 10px rgba(0,0,0,.14);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);}',
    '.t3-setup-pill:hover{border-color:rgba(0,0,0,.3);color:#000;}',
    'html.dark .t3-setup-pill{background:rgba(23,23,23,.9);color:#f5f5f5;border-color:rgba(255,255,255,.16);}',
    'html.dark .t3-setup-pill:hover{border-color:rgba(255,255,255,.36);color:#fff;}',
    '.t3-setup-pill svg{width:13px;height:13px;flex:none;}',
    // The entry: its own list after T3's, set apart by a rule.
    '.t3-setup-list{margin-top:2px;padding-top:var(--sidebar-content-inset,.5rem);',
    'border-top:1px solid var(--sidebar-border,var(--border,rgba(0,0,0,.08)));}',
    '.t3-setup-badge{margin-left:auto;flex:none;min-width:18px;height:18px;padding:0 5px;border-radius:999px;',
    'display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;line-height:1;',
    'font-variant-numeric:tabular-nums;color:var(--warning-foreground,#b45309);',
    'background:var(--warning-surface,rgba(245,158,11,.12));}',
    '.t3-setup-badge[hidden]{display:none;}',
    // The dialog: T3's own (a frosted backdrop over its background colour, a
    // large rounded panel, scale and fade), full screen on a phone.
    '.t3-setup-layer{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:24px;}',
    '.t3-setup-backdrop{position:absolute;inset:0;background:color-mix(in srgb,var(--background,#fff) 60%,transparent);',
    '-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);transition:opacity .2s ease-in-out;}',
    'html.dark .t3-setup-backdrop{background:color-mix(in srgb,var(--background,#0a0a0a) 64%,transparent);}',
    '.t3-setup-panel{position:relative;display:flex;width:min(1200px,100%);height:min(880px,100%);overflow:hidden;',
    'border-radius:var(--radius-2xl,18px);background:var(--background,#fff);outline:none;',
    'border:1px solid color-mix(in srgb,var(--foreground,#000) 10%,transparent);box-shadow:0 24px 64px -24px #000000a6;',
    'transition:scale .2s ease-in-out,opacity .2s ease-in-out,translate .2s ease-in-out;}',
    'html.dark .t3-setup-panel{border-color:color-mix(in srgb,#fff 8%,transparent);',
    'box-shadow:inset 0 1px #ffffff0a,0 24px 72px -20px #000000e6;}',
    '.t3-setup-frame{display:block;flex:1;min-width:0;height:100%;border:0;background:transparent;color-scheme:normal;',
    'opacity:0;transition:opacity .15s ease-out;}',
    '.t3-setup-layer[data-ready] .t3-setup-frame{opacity:1;}',
    // A spinner, only if loading takes long enough to notice.
    '.t3-setup-loading{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;',
    'opacity:0;animation:t3-setup-show .2s .3s forwards;}',
    '.t3-setup-loading::after{content:"";width:18px;height:18px;border-radius:50%;',
    'border:2px solid color-mix(in srgb,var(--foreground,#262626) 14%,transparent);',
    'border-top-color:var(--muted-foreground,#71717a);animation:t3-setup-spin .8s linear infinite;}',
    '.t3-setup-layer[data-ready] .t3-setup-loading{display:none;}',
    '.t3-setup-layer:not([data-state=open]) .t3-setup-backdrop{opacity:0;}',
    '.t3-setup-layer:not([data-state=open]) .t3-setup-panel{opacity:0;scale:.98;}',
    '@keyframes t3-setup-spin{to{rotate:360deg}}',
    '@keyframes t3-setup-show{to{opacity:1}}',
    '@media (max-width:639.98px){.t3-setup-layer{padding:0;}',
    '.t3-setup-panel{width:100%;height:100%;border:0;border-radius:0;box-shadow:none;',
    'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);}',
    '.t3-setup-layer:not([data-state=open]) .t3-setup-panel{scale:1;translate:0 16px;}}',
    '@media (prefers-reduced-motion:reduce){.t3-setup-backdrop,.t3-setup-panel,.t3-setup-frame{transition:none;}',
    '.t3-setup-loading::after{animation-duration:2.4s;}}',
  ].join('');

  const addStyles = () => {
    if (document.getElementById('t3-setup-style')) return;
    const style = document.createElement('style');
    style.id = 't3-setup-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  };

  // Lucide's icons, as T3 draws its own: settings for the pill, server-cog for the entry.
  const SETTINGS_ICON = '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0'
    + 'l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51'
    + 'a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08'
    + 'a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18'
    + 'a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39'
    + 'a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09'
    + 'a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25'
    + 'a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>';
  const SERVER_COG_ICON = '<path d="m10.852 14.772-.383.923"/><path d="M13.148 14.772a3 3 0 1 0-2.296-5.544l-.383-.923"/>'
    + '<path d="m13.148 9.228.383-.923"/><path d="m13.53 15.696-.382-.924a3 3 0 1 1-2.296-5.544"/>'
    + '<path d="m14.772 10.852.923-.383"/><path d="m14.772 13.148.923.383"/>'
    + '<path d="M4.5 10H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-.5"/>'
    + '<path d="M4.5 14H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-.5"/>'
    + '<path d="M6 18h.01"/><path d="M6 6h.01"/><path d="m9.228 10.852-.923-.383"/><path d="m9.228 13.148-.923.383"/>';

  // ------------------------------------------------------------- questions --
  const getJson = async (path) => {
    const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('application/json')) return null;
    return res.json();
  };

  /**
   * Ask the console where it is and how much needs the person. T3 answers an
   * unknown path with its HTML shell, which is not the console.
   */
  const hello = async () => {
    for (const path of state.base ? [state.base] : PROBE_PATHS) {
      try {
        const answer = readHello(await getJson(path + 'hello'));
        if (answer) {
          state.base = path;
          return answer;
        }
      } catch {
        // Not here.
      }
    }
    return null;
  };

  /** Whether T3 Code has a session for this browser, as T3 says (null: it did not say). */
  const pairedWithT3 = async () => {
    try {
      const body = await getJson('/api/auth/session');
      return body && typeof body.authenticated === 'boolean' ? body.authenticated : null;
    } catch {
      return null;
    }
  };

  const refreshPaired = async () => {
    const paired = await pairedWithT3();
    if (paired !== null) state.paired = paired;
    schedule();
  };

  /** The count beside Setup, asked again at most every half minute unless forced. */
  const refreshAttention = async (force) => {
    if (!state.base || (!force && Date.now() - state.checkedAt < 30000)) return;
    state.checkedAt = Date.now();
    const answer = await hello();
    if (!answer) return;
    state.attention = answer.signedIn ? answer.attention : 0;
    syncBadges();
  };

  // ----------------------------------------------------------------- pill --
  const pill = () => document.querySelector('.t3-setup-pill');

  const showPill = () => {
    if (pill()) return;
    const link = document.createElement('a');
    link.className = 't3-setup-pill';
    link.href = state.base;
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = 'Pair a device or manage this server';
    link.setAttribute('aria-label', 'Open the T3 Code setup console');
    link.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + SETTINGS_ICON + '</svg><span>Setup</span>';
    document.body.appendChild(link);
  };

  // ---------------------------------------------------------------- entry --
  /** T3's settings list in each sidebar drawn now (a phone draws it in a sheet). */
  const settingsMenus = () => [...document.querySelectorAll('[data-sidebar="content"]')]
    .map((content) => content.querySelector('[data-sidebar="menu"]'))
    .filter((menu) => menu && !menu.hasAttribute(ENTRY) && menu.querySelector('[data-sidebar="menu-button"]'));

  /** A Setup row made from T3's own last row, so it is styled exactly as T3's are. */
  const buildEntry = (menu) => {
    const rows = menu.querySelectorAll(':scope > [data-sidebar="menu-item"]');
    const model = rows[rows.length - 1];
    const sourceButton = model && model.querySelector('[data-sidebar="menu-button"]');
    if (!sourceButton) return null;

    const list = document.createElement('ul');
    list.className = menu.className + ' t3-setup-list';
    list.setAttribute('data-sidebar', 'menu');
    list.setAttribute(ENTRY, '');
    const item = model.cloneNode(false);
    const button = document.createElement('button');
    for (const { name, value } of sourceButton.attributes) {
      if (/^(class|data-sidebar|data-slot|data-size)$/.test(name)) button.setAttribute(name, value);
    }
    button.type = 'button';
    button.setAttribute('data-active', 'false');
    button.setAttribute('aria-haspopup', 'dialog');

    // T3's icon and label classes carry over by attribute, never through
    // markup: a utility class may hold quotes or brackets.
    const sourceIcon = sourceButton.querySelector('svg');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [name, value] of [['width', '24'], ['height', '24'], ['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) icon.setAttribute(name, value);
    const iconClass = sourceIcon ? (sourceIcon.getAttribute('class') || '').replace(/\blucide-[\w-]+/g, ' ').trim() : 'lucide';
    icon.setAttribute('class', (iconClass + ' lucide-server-cog').trim());
    icon.innerHTML = SERVER_COG_ICON;
    const sourceLabel = sourceButton.querySelector('span');
    const label = document.createElement('span');
    if (sourceLabel && sourceLabel.className) label.className = sourceLabel.className;
    label.textContent = 'Setup';
    const badge = document.createElement('span');
    badge.className = 't3-setup-badge';
    badge.hidden = true;
    button.append(icon, label, badge);
    button.addEventListener('click', (event) => {
      // T3's router listens at its root; this row is not one of its routes.
      event.preventDefault();
      event.stopPropagation();
      openDialog(button);
    });
    item.appendChild(button);
    list.appendChild(item);
    return list;
  };

  const removeEntries = () => {
    for (const list of document.querySelectorAll('[' + ENTRY + ']')) list.remove();
  };

  /** One entry right after each settings list; strays from an earlier drawing go. */
  const ensureEntries = () => {
    const menus = settingsMenus();
    for (const list of document.querySelectorAll('[' + ENTRY + ']')) {
      if (!menus.includes(list.previousElementSibling)) list.remove();
    }
    for (const menu of menus) {
      const next = menu.nextElementSibling;
      if (next && next.hasAttribute(ENTRY)) continue;
      const entry = buildEntry(menu);
      if (entry) menu.after(entry);
    }
    syncBadges();
  };

  const syncBadges = () => {
    const text = badgeText(state.attention);
    for (const badge of document.querySelectorAll('[' + ENTRY + '] .t3-setup-badge')) {
      if (badge.textContent !== text) badge.textContent = text;
      if (badge.hidden !== !text) badge.hidden = !text;
    }
    const label = entryLabel(state.attention);
    const active = String(Boolean(state.dialog));
    for (const button of document.querySelectorAll('[' + ENTRY + '] button')) {
      if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
      if (button.getAttribute('data-active') !== active) button.setAttribute('data-active', active);
    }
  };

  // ----------------------------------------------------------- the dialog --
  const theme = () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  const toConsole = (frame, message) => {
    if (frame.contentWindow) frame.contentWindow.postMessage(Object.assign({ source: 't3-code' }, message), location.origin);
  };

  /** Close T3's own phone sidebar first, as its rows do when chosen. */
  const closeMobileSidebar = (trigger) => {
    const sheet = trigger.closest('[data-mobile="true"]');
    if (!sheet) return false;
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    return true;
  };

  const openDialog = (trigger) => {
    if (state.dialog || !state.base) return;
    if (closeMobileSidebar(trigger)) {
      // Give the sheet a frame to let go of focus before the dialog takes it.
      requestAnimationFrame(() => requestAnimationFrame(() => openDialog(document.body)));
      return;
    }

    const layer = document.createElement('div');
    layer.className = 't3-setup-layer';
    layer.setAttribute('data-state', 'opening');
    const backdrop = document.createElement('div');
    backdrop.className = 't3-setup-backdrop';
    const panel = document.createElement('div');
    panel.className = 't3-setup-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Setup');
    panel.tabIndex = -1;
    const loading = document.createElement('div');
    loading.className = 't3-setup-loading';
    loading.setAttribute('aria-hidden', 'true');
    const frame = document.createElement('iframe');
    frame.className = 't3-setup-frame';
    frame.title = 'T3 Code setup';
    frame.setAttribute('allow', 'clipboard-read; clipboard-write');
    frame.src = embedUrl(state.base, theme(), null);
    panel.append(loading, frame);
    layer.append(backdrop, panel);

    // Everything else on the page is out of reach while the dialog is open,
    // which also keeps Tab inside it; so is any layer T3 or a library it uses
    // adds to the page meanwhile (a portal, a sign-in widget's container).
    const reachable = (node) => node.nodeType === 1 && node !== layer && !node.inert && !/^(SCRIPT|STYLE|LINK)$/.test(node.tagName);
    const inerted = [...document.body.children].filter(reachable);
    document.body.appendChild(layer);
    for (const node of inerted) node.inert = true;
    const bodyWatch = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!reachable(node)) continue;
          node.inert = true;
          inerted.push(node);
        }
      }
    });
    bodyWatch.observe(document.body, { childList: true });

    const onKey = (event) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      closeDialog();
    };
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('click', () => closeDialog());
    // The console keeps T3's theme as T3 switches it.
    const themeWatch = new MutationObserver(() => toConsole(frame, { type: 'theme', theme: theme() }));
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    state.dialog = { layer, frame, trigger, inerted, onKey, themeWatch, bodyWatch };
    syncBadges();
    panel.focus({ preventScroll: true });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (state.dialog && state.dialog.layer === layer) layer.setAttribute('data-state', 'open');
    }));
  };

  const closeDialog = () => {
    const dialog = state.dialog;
    if (!dialog) return;
    state.dialog = null;
    document.removeEventListener('keydown', dialog.onKey, true);
    dialog.themeWatch.disconnect();
    dialog.bodyWatch.disconnect();
    for (const node of dialog.inerted) node.inert = false;
    dialog.layer.setAttribute('data-state', 'closing');
    setTimeout(() => dialog.layer.remove(), REDUCED.matches ? 0 : 200);
    syncBadges();
    // Back where the person was: the entry, or the one T3 has drawn since,
    // or, on a phone, the button that opens T3's sidebar.
    const back = [dialog.trigger, ...document.querySelectorAll('[' + ENTRY + '] button'), document.querySelector('[data-sidebar="trigger"]')]
      .find((node) => node && node !== document.body && node.isConnected && node.getClientRects().length);
    if (back) back.focus({ preventScroll: true });
  };

  window.addEventListener('message', (event) => {
    const dialog = state.dialog;
    if (!dialog || !fromConsole(event, dialog.frame, location.origin)) return;
    const { type } = event.data;
    if (type === 'ready') {
      dialog.layer.setAttribute('data-ready', '');
      // Keys go to the console from here on, Escape included.
      dialog.frame.focus();
      toConsole(dialog.frame, { type: 'theme', theme: theme() });
    } else if (type === 'close') {
      closeDialog();
    } else if (type === 'attention' && Number.isInteger(event.data.count) && event.data.count >= 0) {
      state.attention = event.data.count;
      state.checkedAt = Date.now();
      syncBadges();
    }
  });

  // ------------------------------------------------------------ keeping up --
  /** Draw what this screen should have: the pill before pairing, the entry in settings. */
  const sync = () => {
    if (!state.base) return;
    // T3 not answering is not the same as T3 saying "not paired": fall back to
    // the pairing screen's own path then.
    const unpaired = state.paired === false || (state.paired === null && /^\/pair\/?$/.test(location.pathname));
    if (unpaired) showPill();
    else if (pill()) pill().remove();

    const inSettings = state.paired === true && isSettingsPath(location.pathname);
    watch(inSettings);
    if (inSettings) ensureEntries();
    else removeEntries();
  };

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      sync();
    });
  };

  // T3 draws its settings sidebar after the route changes, and on a phone
  // only when the sheet opens; watch the page for it only while in settings.
  let observer = null;
  const watch = (on) => {
    if (on && !observer) {
      observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
    } else if (!on && observer) {
      observer.disconnect();
      observer = null;
    }
  };

  const onNavigate = () => {
    if (location.pathname === state.path) return;
    const wasSettings = isSettingsPath(state.path);
    state.path = location.pathname;
    if (state.dialog && !isSettingsPath(state.path)) closeDialog();
    if (!state.base) return;
    // Pairing finishes without a reload, and a revoked session lands back on
    // the pairing screen, so ask T3 again until it says paired.
    if (state.paired !== true) refreshPaired();
    if (isSettingsPath(state.path) && !wasSettings) refreshAttention(false);
    schedule();
  };

  // T3's router moves with pushState and replaceState. Wrapped now, while
  // this script runs and before T3's own module does, so the router's calls
  // come through here too.
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function () {
      const result = original.apply(this, arguments);
      queueMicrotask(onNavigate);
      return result;
    };
  }
  window.addEventListener('popstate', onNavigate);

  const start = async () => {
    const [answer, paired] = await Promise.all([hello(), pairedWithT3()]);
    // The console is not routed on this origin: leave T3 Code exactly as it is.
    if (!answer) return;
    state.paired = paired;
    state.attention = answer.signedIn ? answer.attention : 0;
    state.checkedAt = Date.now();
    addStyles();
    sync();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
