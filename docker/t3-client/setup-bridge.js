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
//   - In T3's command palette, Setup's commands (Open setup, Pair a device,
//     Agents, Toolchains, Ports) when a search names them, opening the same
//     dialog on that page.
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

  // Setup's commands in T3's command palette. Each answers to its own few
  // words, chosen not to collide with T3's commands ("open", "sign" and "go"
  // would), and every word of a search has to start one of them. The page
  // commands also answer to "setup" with another word ("setup ports"), and
  // "setup" alone finds only Open setup.
  const PALETTE_ITEMS = [
    { id: 'setup', route: null, title: 'Open setup', meta: 'Agents, toolchains, ports and devices on this server', words: ['setup', 'console'] },
    { id: 'agents', route: 'agents', title: 'Agents', meta: 'Setup · sign in, install and update', words: ['agents'] },
    { id: 'pair', route: 'devices', title: 'Pair a device', meta: 'Setup · Devices', words: ['pair', 'pairing', 'devices'] },
    { id: 'toolchains', route: 'toolchains', title: 'Toolchains', meta: 'Setup · Go, Rust, Bun, Deno, uv and any mise tool', words: ['toolchains', 'mise'] },
    { id: 'sourcecontrol', route: 'sourcecontrol', title: 'Source control', meta: 'Setup · the GitLab, Forgejo, Gitea and Azure DevOps CLIs, and their sign-ins', words: ['gitlab', 'forgejo', 'gitea', 'azure', 'glab'] },
    { id: 'ports', route: 'ports', title: 'Ports', meta: 'Setup · publish a dev server', words: ['ports', 'publish'] },
  ];

  /**
   * Setup's commands for a palette search, and whether the search is plainly
   * about them: four letters or more, when they take the highlight (Enter
   * opens them). Shorter, a search like "set" could as well mean Settings,
   * so they are listed without taking Enter from T3's own first result.
   */
  const paletteMatches = (query) => {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const length = words.join(' ').length;
    if (length < 3) return { items: [], strong: false };
    const starts = (list, word) => list.some((w) => w.startsWith(word));
    const items = PALETTE_ITEMS.filter((item) => {
      const own = words.filter((word) => starts(item.words, word));
      const group = words.filter((word) => 'setup'.startsWith(word));
      return words.every((word) => own.includes(word) || group.includes(word))
        && (item.id === 'setup' || own.length > 0);
    });
    return { items, strong: items.length > 0 && length >= 4 };
  };

  /**
   * Where an arrow key takes the highlight in the palette, over Setup's rows
   * (`ours` of them, listed first) and T3's (`theirs`): one list, wrapping at
   * both ends as T3's does. `own` is Setup's highlighted row, or -1 while
   * T3's are in charge; `at` is T3's active row, or -1 before T3 has one (a
   * fresh search: T3's first arrow key then lights its first row or its
   * last). Returns the new `own`, and whether T3 should get the key too, to
   * move its own highlight or light its first row.
   */
  const paletteStep = ({ key, own, ours, theirs, at }) => {
    if (key === 'ArrowDown') {
      if (own >= 0 && own < ours - 1) return { own: own + 1, pass: false };
      // Off Setup's last row onto T3's first: T3 lights it itself if it has
      // no active row yet, or wraps to it from its last.
      if (own >= 0) return theirs ? { own: -1, pass: at === -1 || at === theirs - 1 } : { own: 0, pass: false };
      // From nothing, or round from T3's last row: Setup's first, at the top.
      if (!theirs || at === -1 || at === theirs - 1) return { own: 0, pass: false };
      return { own: -1, pass: true };
    }
    if (key === 'ArrowUp') {
      if (own > 0) return { own: own - 1, pass: false };
      // Off Setup's first row, round to T3's last: T3 goes there itself.
      if (own === 0) return theirs ? { own: -1, pass: true } : { own: ours - 1, pass: false };
      if (!theirs || at === 0) return { own: ours - 1, pass: false };
      return { own: -1, pass: true };
    }
    return { own, pass: true };
  };

  if (typeof document === 'undefined') {
    globalThis.T3SetupBridge = {
      PROBE_PATHS, isSettingsPath, embedUrl, readHello, badgeText, entryLabel, fromConsole,
      PALETTE_ITEMS, paletteMatches, paletteStep,
    };
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
    // Setup's rows in T3's command palette, highlighted as T3 highlights its
    // own; while one of them is, T3's highlighted row is drawn plain.
    '.t3-setup-cmd-text{display:flex;flex-direction:column;min-width:0;flex:1;line-height:1.3;}',
    '.t3-setup-cmd-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.t3-setup-cmd-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--muted-foreground,#71717a);}',
    '.t3-setup-cmd-icon{width:16px;height:16px;flex:none;color:var(--muted-foreground,#71717a);}',
    '.t3-setup-cmd--plain{display:flex;align-items:center;gap:8px;min-height:32px;padding:6px 8px;border-radius:calc(var(--radius,.625rem) - 4px);cursor:pointer;font-size:14px;}',
    '.t3-setup-cmd-label{padding:6px 8px;font-size:12px;font-weight:500;color:var(--muted-foreground,#71717a);}',
    '.t3-setup-cmd-host{padding:8px;}',
    '[data-t3-setup-item][data-highlighted]{background-color:var(--accent,#f4f4f5)!important;color:var(--accent-foreground,inherit)!important;}',
    // T3 paints its active row with Tailwind's bg-accent!, an !important rule
    // in its utilities layer. Among !important rules the earliest layer wins,
    // so the plain-row rule goes in T3's own earlier base layer as well as
    // unlayered (which wins should T3 ever drop layers).
    '[data-t3-setup-owns] [data-slot="command-item"]:not([data-t3-setup-item]){background-color:transparent!important;color:inherit!important;}',
    '@layer base{[data-t3-setup-owns] [data-slot="command-item"]:not([data-t3-setup-item]){background-color:transparent!important;color:inherit!important;}}',
    '[data-t3-setup-empty]>:not([data-t3-setup-host]){display:none!important;}',
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
    schedulePalette();
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

  /** Open the console over T3, on one of its pages (`route`, such as 'agents') or its Overview. */
  const openDialog = (trigger, route) => {
    if (state.dialog || !state.base) return;
    if (closeMobileSidebar(trigger)) {
      // Give the sheet a frame to let go of focus before the dialog takes it.
      requestAnimationFrame(() => requestAnimationFrame(() => openDialog(document.body, route)));
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
    frame.src = embedUrl(state.base, theme(), route || null);
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

  // ------------------------------------------------------ command palette --
  // Setup's commands in T3's command palette (⌘K), as a group of their own
  // among T3's when a search names them. The palette is base-ui's
  // Autocomplete, which knows nothing of rows it did not draw, so Setup's keep
  // their own highlight: while one of them has it, they "own" it, T3's own
  // highlighted row is drawn plain, and Enter is theirs. The arrow keys and
  // the pointer move it between the two as through one list (paletteStep).
  // Only on the palette's first page: T3's pages within it (the theme list,
  // say) say "Backspace Back" in their footer.
  const PALETTE = '[data-command-palette="true"]';
  const OWN_ROW = 'data-t3-setup-item';
  // `chosen`: the person has moved the highlight themselves since the search
  // changed, so where it is is theirs, not a default to keep recomputing.
  const palette = { dialog: null, input: null, items: [], strong: false, own: -1, chosen: false, query: null, watch: null };

  const PALETTE_ICONS = {
    setup: SERVER_COG_ICON,
    agents: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    pair: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
    toolchains: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    ports: '<path d="m15 20 3-3h2a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2l3 3z"/><path d="M6 8v1"/><path d="M10 8v1"/><path d="M14 8v1"/><path d="M18 8v1"/>',
  };

  const theirRows = () => (palette.dialog
    ? [...palette.dialog.querySelectorAll('[data-slot="command-item"]:not([' + OWN_ROW + '])')] : []);
  // T3's active row, as T3 draws it: with a forced background class (bg-accent!).
  // Before its first arrow key after a search it has none, though Enter would
  // still take its first row.
  const theirActive = (rows) => rows.findIndex((row) => /(^|\s)bg-\S+!(\s|$)/.test(row.className));
  const ourGroup = () => palette.dialog && palette.dialog.querySelector('[data-t3-setup-palette]');
  const subPage = () => {
    const footer = palette.dialog.querySelector('[data-slot="command-footer"]');
    return Boolean(footer && /Backspace/.test(footer.textContent));
  };

  // T3's classes for its groups and rows, kept from the last time some were
  // in view: a search T3 has nothing for, or only one-line rows, still draws
  // Setup's like T3's two-line rows (a title over "Settings · Project"). Before
  // any have been seen, Setup's own fallback styles stand in.
  const looks = { group: null, label: null, row: null, icon: null, twoLine: null };
  const learnLooks = () => {
    const group = palette.dialog.querySelector('[data-slot="command-group"]:not([data-t3-setup-palette])');
    const label = group && group.querySelector('[data-slot="command-group-label"]');
    if (group) looks.group = group.className;
    if (label) looks.label = label.className;
    for (const row of theirRows()) {
      // T3 marks its active row with forced background classes, which are
      // T3's to set: they are not copied.
      looks.row = row.className.split(/\s+/).filter((c) => !/!$/.test(c)).join(' ');
      const icon = row.querySelector('svg');
      if (icon) looks.icon = (icon.getAttribute('class') || '').replace(/\blucide-[\w-]+/g, ' ').trim();
      const text = row.querySelector(':scope > span');
      const title = text && text.children[0];
      const meta = text && text.children[1];
      if (title && meta && title.firstElementChild) {
        looks.twoLine = { text: text.className, title: title.className, name: title.firstElementChild.className, meta: meta.className };
      }
    }
  };

  /** Setup's group, drawn with T3's own classes for its groups and rows. */
  const buildGroup = (items) => {
    learnLooks();
    const twoLine = looks.twoLine;
    const group = document.createElement('div');
    group.setAttribute('role', 'group');
    group.setAttribute('data-slot', 'command-group');
    group.setAttribute('data-t3-setup-palette', '');
    group.setAttribute('aria-labelledby', 't3-setup-cmd-label');
    if (looks.group) group.className = looks.group;
    const label = document.createElement('div');
    label.id = 't3-setup-cmd-label';
    label.setAttribute('data-slot', 'command-group-label');
    label.className = looks.label || 't3-setup-cmd-label';
    label.textContent = 'Setup';
    group.appendChild(label);
    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.id = 't3-setup-cmd-' + index;
      row.setAttribute('role', 'option');
      row.setAttribute('data-slot', 'command-item');
      row.setAttribute(OWN_ROW, item.id);
      row.setAttribute('aria-selected', 'false');
      row.className = looks.row ? looks.row + ' t3-setup-cmd' : 't3-setup-cmd t3-setup-cmd--plain';
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [name, value] of [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'],
        ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['aria-hidden', 'true']]) icon.setAttribute(name, value);
      icon.setAttribute('class', looks.icon || 't3-setup-cmd-icon');
      icon.innerHTML = PALETTE_ICONS[item.id] || SERVER_COG_ICON;
      const text = document.createElement('span');
      text.className = twoLine ? twoLine.text : 't3-setup-cmd-text';
      const title = document.createElement('span');
      title.className = twoLine ? twoLine.title : 't3-setup-cmd-title';
      const name = document.createElement('span');
      name.className = twoLine ? twoLine.name : '';
      name.textContent = item.title;
      title.appendChild(name);
      const meta = document.createElement('span');
      meta.className = twoLine ? twoLine.meta : 't3-setup-cmd-meta';
      meta.textContent = item.id === 'setup' && state.attention > 0
        ? (state.attention === 1 ? '1 thing needs you' : state.attention + ' things need you') + ' · agents, toolchains, ports and devices'
        : item.meta;
      text.append(title, meta);
      row.append(icon, text);
      group.appendChild(row);
    });
    return group;
  };

  /** Where Setup's group goes: first in T3's list, or in place of "No matching…" when T3 has nothing. */
  const placeGroup = (group) => {
    const list = palette.dialog.querySelector('[data-slot="command-list"]');
    const footer = palette.dialog.querySelector('[data-slot="command-footer"]');
    for (const region of palette.dialog.querySelectorAll('[data-t3-setup-empty]')) {
      if (list || region !== (footer && footer.previousElementSibling)) region.removeAttribute('data-t3-setup-empty');
    }
    if (list) {
      if (list.firstElementChild !== group) list.prepend(group);
      const host = palette.dialog.querySelector('[data-t3-setup-host]');
      if (host) host.remove();
      return;
    }
    const region = footer && footer.previousElementSibling;
    if (!region) return;
    let host = region.querySelector('[data-t3-setup-host]');
    if (!host) {
      host = document.createElement('div');
      host.setAttribute('data-t3-setup-host', '');
      host.setAttribute('role', 'listbox');
      host.setAttribute('aria-label', 'Setup');
      host.className = 't3-setup-cmd-host';
      region.appendChild(host);
    }
    region.setAttribute('data-t3-setup-empty', '');
    if (group.parentElement !== host) host.appendChild(group);
  };

  const removeGroup = () => {
    if (!palette.dialog) return;
    const group = ourGroup();
    if (group) group.remove();
    for (const node of palette.dialog.querySelectorAll('[data-t3-setup-host]')) node.remove();
    for (const node of palette.dialog.querySelectorAll('[data-t3-setup-empty]')) node.removeAttribute('data-t3-setup-empty');
    palette.dialog.removeAttribute('data-t3-setup-owns');
  };

  /** Draw whose row is highlighted, and tell assistive technology the same. */
  const paintPalette = () => {
    const group = ourGroup();
    if (!group) return;
    const rows = [...group.querySelectorAll('[' + OWN_ROW + ']')];
    rows.forEach((row, index) => {
      const on = index === palette.own;
      if (row.hasAttribute('data-highlighted') !== on) row.toggleAttribute('data-highlighted', on);
      row.setAttribute('aria-selected', String(on));
    });
    palette.dialog.toggleAttribute('data-t3-setup-owns', palette.own >= 0);
    const mine = rows[palette.own];
    const theirs = theirRows().find((row) => row.hasAttribute('data-highlighted'));
    const active = mine ? mine.id : theirs ? theirs.id : '';
    if (active && palette.input.getAttribute('aria-activedescendant') !== active) palette.input.setAttribute('aria-activedescendant', active);
    if (mine) mine.scrollIntoView({ block: 'nearest' });
  };

  const syncPalette = () => {
    if (!palette.dialog) return;
    if (!palette.dialog.isConnected || !palette.input.isConnected) return detachPalette();
    const query = palette.input.value;
    const { items, strong } = state.base && state.paired === true && !subPage()
      ? paletteMatches(query) : { items: [], strong: false };
    if (!items.length) {
      removeGroup();
      palette.items = [];
      palette.own = -1;
      palette.query = query;
      return;
    }
    // T3 redraws its list as results arrive, which can take Setup's group with
    // it: draw it again, but only a new search or new matches move the highlight.
    const same = palette.items.map((i) => i.id).join() === items.map((i) => i.id).join();
    let group = ourGroup();
    if (!group || !same) {
      if (group) group.remove();
      group = buildGroup(items);
    }
    placeGroup(group);
    // A new search starts the highlight where T3 starts its own: at the top,
    // which is Setup's first row when the search is plainly about Setup, or
    // when T3 has nothing to offer. T3's results can arrive a moment after
    // the search (and vanish while it redraws), so the default follows them
    // until the person moves the highlight.
    if (query !== palette.query || !same) palette.chosen = false;
    if (!palette.chosen) palette.own = strong || theirRows().length === 0 ? 0 : -1;
    palette.items = items;
    palette.strong = strong;
    palette.query = query;
    paintPalette();
  };

  let paletteQueued = false;
  const schedulePalette = () => {
    if (paletteQueued) return;
    paletteQueued = true;
    requestAnimationFrame(() => {
      paletteQueued = false;
      syncPalette();
    });
  };

  const attachPalette = (input) => {
    const dialog = input.closest(PALETTE);
    if (palette.dialog === dialog && palette.input === input) return;
    detachPalette();
    Object.assign(palette, { dialog, input, items: [], strong: false, own: -1, chosen: false, query: null });
    // T3 redraws its list as results arrive; put Setup's group back each time.
    palette.watch = new MutationObserver(schedulePalette);
    palette.watch.observe(dialog, { childList: true, subtree: true });
    schedulePalette();
  };

  const detachPalette = () => {
    if (palette.watch) palette.watch.disconnect();
    removeGroup();
    Object.assign(palette, { dialog: null, input: null, items: [], own: -1, query: null, watch: null });
  };

  /**
   * Close T3's palette as its own commands do, then open Setup on the
   * command's page once the palette has gone: two modal layers at once would
   * each pull focus and mark the page inert for themselves. After an arrow
   * key, T3's palette spends the first Escape on its own highlight, so Escape
   * is pressed again (a few times at most) until the palette starts closing.
   */
  const runPaletteItem = (item) => {
    const input = palette.input;
    const dialog = palette.dialog;
    detachPalette();
    const started = Date.now();
    let presses = 0;
    const step = () => {
      if (dialog.isConnected && Date.now() - started < 1500) {
        if (dialog.hasAttribute('data-open') && presses < 3) {
          presses += 1;
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
        }
        requestAnimationFrame(step);
        return;
      }
      openDialog(document.activeElement || document.body, item.route);
    };
    step();
  };

  const inPalette = (node) => Boolean(node && node.closest && node.closest(PALETTE));
  // Attached even before the console has answered: syncPalette waits for
  // that, and start() draws again once it has.
  document.addEventListener('focusin', (event) => {
    if (inPalette(event.target) && event.target.matches('input[role="combobox"]')) attachPalette(event.target);
  }, true);
  document.addEventListener('input', (event) => {
    if (palette.input && event.target === palette.input) schedulePalette();
  }, true);
  // Ahead of base-ui's own handlers (which React runs from the palette's
  // container), so a key that is Setup's never reaches them.
  window.addEventListener('keydown', (event) => {
    if (!palette.input || event.target !== palette.input || !ourGroup() || event.isComposing) return;
    const { key } = event;
    if (key === 'Enter' && palette.own >= 0) {
      event.preventDefault();
      event.stopPropagation();
      runPaletteItem(palette.items[palette.own]);
      return;
    }
    if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
    const rows = theirRows();
    const next = paletteStep({ key, own: palette.own, ours: palette.items.length, theirs: rows.length, at: theirActive(rows) });
    palette.own = next.own;
    palette.chosen = true;
    if (!next.pass) {
      event.preventDefault();
      event.stopPropagation();
    }
    // After T3 has moved its own highlight, if it got the key.
    requestAnimationFrame(paintPalette);
  }, true);
  document.addEventListener('pointermove', (event) => {
    if (!palette.dialog || !inPalette(event.target)) return;
    const mine = event.target.closest('[' + OWN_ROW + ']');
    const theirs = !mine && event.target.closest('[data-slot="command-item"]');
    const index = mine ? [...ourGroup().querySelectorAll('[' + OWN_ROW + ']')].indexOf(mine) : -1;
    if (mine && index !== palette.own) {
      palette.own = index;
      palette.chosen = true;
      paintPalette();
    } else if (theirs && palette.own >= 0) {
      palette.own = -1;
      palette.chosen = true;
      requestAnimationFrame(paintPalette);
    }
  }, true);
  // Keep focus in the search field when a row of Setup's is pressed.
  document.addEventListener('pointerdown', (event) => {
    if (palette.dialog && event.target.closest && event.target.closest('[' + OWN_ROW + ']')) event.preventDefault();
  }, true);
  document.addEventListener('click', (event) => {
    const row = palette.dialog && event.target.closest && event.target.closest('[' + OWN_ROW + ']');
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    const item = palette.items.find((i) => i.id === row.getAttribute(OWN_ROW));
    if (item) runPaletteItem(item);
  }, true);

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
    // Going somewhere else (Back, say) leaves the dialog behind.
    if (state.dialog) closeDialog();
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
    // A palette opened while the console was still being asked.
    schedulePalette();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
