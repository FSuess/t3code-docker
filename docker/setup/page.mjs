// The setup console's one HTML document.
//
// Everything the browser runs is inlined into this single response: the design
// system's stylesheets, the page composition, and the client scripts. The page
// makes no other request for code or fonts, because it is often opened over a
// tunnel from a phone, and because a reverse proxy routing only a prefix here
// should not have to know about asset paths.
//
// Every asset is read verbatim from its own file once, at startup, never
// embedded in a template literal: a template literal eats backslashes on the
// way out (`/\s+/` once reached the browser as `/s+/`). The smoke test holds
// each inlined script byte-for-byte to its file.
import { readFileSync } from "node:fs";

// Order matters: tokens, then components, then the page's own composition.
export const STYLES = ["design/tokens.css", "design/components.css", "console.css"];

// Classic scripts that share one global scope, run in this order. base.js
// resolves where the API lives; ui.js is the design system's behaviour layer
// (window.T3C); model.js is the console's pure view model (window.T3Model);
// kit.js the DOM layer (overlays, toasts, keyboard); app.js the console itself.
export const CONSOLE_SCRIPTS = [
  "client/base.js",
  "design/ui.js",
  "client/model.js",
  "client/kit.js",
  "app.js",
];
export const UNLOCK_SCRIPTS = ["client/base.js", "design/ui.js", "client/unlock.js"];

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

/**
 * Read every asset once. Throws at startup if one could not be inlined safely,
 * rather than shipping a page whose script ends early.
 */
export function loadAssets() {
  const css = STYLES.map((path) => `/* ${path} */\n${read(path)}`).join("\n");
  if (/<\/style/i.test(css)) throw new Error("a stylesheet contains </style and cannot be inlined");
  const script = (path) => {
    const code = read(path);
    if (/<\/script/i.test(code)) throw new Error(`${path} contains </script and cannot be inlined`);
    return { path, code };
  };
  return {
    css,
    console: CONSOLE_SCRIPTS.map(script),
    unlock: UNLOCK_SCRIPTS.map(script),
  };
}

export const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Resolve the theme before first paint. Left to the client scripts, the page
// flashes light for as long as it takes them to parse, which on a phone over a
// tunnel is long enough to see.
const BOOT = `(function(){var r=document.documentElement;try{var m=localStorage.getItem("t3-console-theme")||"system";`
  + `var d=m==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):m;`
  + `r.setAttribute("data-theme",d);r.setAttribute("data-theme-mode",m);}catch(e){r.setAttribute("data-theme","light");}})();`;
// Touch density lives on .tc-root, which is <body>, so it is set first thing
// inside it rather than from <head>; kit.js keeps it current on resize.
const DENSITY = `try{if(matchMedia("(max-width: 1023.98px)").matches)document.body.setAttribute("data-density","touch");}catch(e){}`;

// The console's app icon, as the favicon: the handoff's t3-mark.svg.
const FAVICON = `data:image/svg+xml,${encodeURIComponent(read("design/favicon.svg").trim())}`;

/**
 * The Content-Security-Policy for one response. Scripts run only with this
 * response's nonce; styles are inline by construction (components set hues
 * through style attributes); images are data: URIs and inline SVG; the only
 * network the page itself uses is its own API.
 */
export const contentSecurityPolicy = (nonce) => [
  "default-src 'none'",
  `script-src 'nonce-${nonce}'`,
  "style-src 'unsafe-inline'",
  "img-src data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const head = ({ nonce, css, mount }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>T3 Code setup</title>
<link rel="icon" href="${FAVICON}">
<script nonce="${nonce}">${BOOT}</script>
<style>${css}</style>
<script nonce="${nonce}">window.__T3_SETUP_BASE__ = ${JSON.stringify(mount)};</script>
</head>`;

const scripts = (list, nonce) =>
  list.map(({ path, code }) => `<script nonce="${nonce}" data-src="${path}">${code}</script>`).join("\n");

const NAV = [
  ["overview", "Overview", "layout-dashboard", "O"],
  ["devices", "Devices", "smartphone", "D"],
  ["agents", "Agents", "bot", "A"],
  ["toolchains", "Toolchains", "wrench", "T"],
  ["ports", "Ports", "ethernet-port", "P"],
  ["environment", "Environment", "settings-2", "E"],
];
const TABS = [
  ["overview", "Overview", "layout-dashboard"],
  ["devices", "Devices", "smartphone"],
  ["agents", "Agents", "bot"],
  ["ports", "Ports", "ethernet-port"],
  ["more", "More", "ellipsis"],
];

const skeleton = (rows) => `<div class="tc-group" aria-hidden="true">${
  Array.from({ length: rows }, (_, i) =>
    `<div class="tc-skel-row"><span class="tc-skel tc-skel--tile"></span><span class="tc-skel" style="width:${[38, 52, 30, 44][i % 4]}%"></span></div>`).join("")
}</div>`;

/** The console once unlocked: the shell, with every page awaiting its first status. */
export function renderConsole({ assets, nonce, mount }) {
  const nav = NAV.map(([route, label, icon, key]) =>
    `<a class="tc-nav-item" href="#${route}" data-nav="${route}" aria-keyshortcuts="G ${key}"><i data-icon="${icon}"></i>${label}<span class="tc-nav-count" id="nav-${route}" aria-live="off"></span></a>`).join("");
  const tabs = TABS.map(([route, label, icon]) =>
    `<a class="tc-tab" href="#${route}" data-nav="${route}"><span class="tc-tab-ico"><i data-icon="${icon}"></i><span class="tc-tab-badge" id="tab-${route}" hidden></span></span>${label}</a>`).join("");
  const pages = [...NAV.map(([route]) => route), "more"].map((route) =>
    `<section class="tc-page" id="page-${route}" data-route="${route}" aria-label="${route[0].toUpperCase()}${route.slice(1)}" hidden>${skeleton(route === "more" ? 2 : 3)}</section>`).join("\n");
  return `${head({ nonce, css: assets.css, mount })}
<body class="tc-root">
<script nonce="${nonce}">${DENSITY}</script>
<div class="tc-app" id="app">
  <nav class="tc-sidebar" aria-label="Console">
    <div class="tc-brand"><span class="tc-wordmark" aria-label="T3 Code"><span>Code</span></span><span class="tc-badge tc-badge--outline tc-badge--sm">Setup</span></div>
    <button class="tc-search" type="button" data-cmd="palette" aria-keyshortcuts="Meta+K Control+K"><i data-icon="search"></i>Search<span class="tc-kbd" data-mod-key>⌘K</span></button>
    <div class="tc-nav">${nav}</div>
    <div class="tc-sidebar-foot">
      <div class="tc-server" id="server-card"><div class="tc-server-row"><span class="tc-skel tc-skel--line"></span></div></div>
      <div class="tc-sidebar-row">
        <a class="tc-nav-item" id="open-t3" href="/" target="_blank" rel="noopener" data-open-t3><i data-icon="external-link"></i>Open T3 Code</a>
        <button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" id="theme-toggle" data-cmd="theme.cycle" aria-label="Switch theme"><i data-icon="monitor"></i></button>
      </div>
    </div>
  </nav>
  <main class="tc-main" id="main" tabindex="-1">
    <header class="tc-topbar">
      <ol class="tc-crumbs"><li>Setup</li><li aria-current="page" id="crumb">Overview</li></ol>
      <span class="tc-small tc-muted tc-truncate tc-topbar-summary" id="summary"></span>
      <span class="tc-spacer"></span>
      <div class="tc-topbar-actions" id="page-actions"></div>
    </header>
    <header class="tc-phonebar">
      <span class="tc-wordmark" aria-label="T3 Code"><span>Code</span></span><span class="tc-badge tc-badge--outline tc-badge--sm">Setup</span>
      <span class="tc-spacer"></span>
      <span class="tc-phone-status" id="phone-status"></span>
      <button class="tc-btn tc-btn--ghost tc-btn--icon" type="button" data-cmd="palette" aria-label="Search"><i data-icon="search"></i></button>
    </header>
    <div class="tc-banner" id="banner" role="status" hidden></div>
${pages}
  </main>
  <nav class="tc-tabbar" aria-label="Console">${tabs}</nav>
</div>
<div id="layers"></div>
<div class="tc-toaster" id="toaster" role="region" aria-label="Notifications" aria-live="polite"></div>
${scripts(assets.console, nonce)}
</body></html>`;
}

/**
 * The standalone unlock page. The form posts `key` to `{mount}/login` and works
 * without JavaScript; unlock.js only keeps the user on the page to show a wrong
 * key in place, and reveals the key on request.
 */
export function renderUnlock({ assets, nonce, mount, host, publicUrl, error }) {
  const t3Url = publicUrl || (mount ? "/" : "");
  const invalid = error ? ' aria-invalid="true" aria-describedby="key-error"' : "";
  return `${head({ nonce, css: assets.css, mount })}
<body class="tc-root">
<script nonce="${nonce}">${DENSITY}</script>
<main class="tc-standalone">
  <div class="tc-standalone-card">
    <div class="tc-masthead"><div class="tc-masthead-in"><span class="tc-eyebrow">T3 Code · Setup</span></div></div>
    <div class="tc-standalone-body">
      ${host ? `<span class="tc-eyebrow">${escapeHtml(host)}</span>` : ""}
      <h1 class="tc-standalone-title">Unlock the console</h1>
      <p class="tc-standalone-desc">Pair devices, sign agents in and publish ports on this server. Enter the setup key you set as <code>T3_SETUP_KEY</code>.</p>
      <form class="tc-unlock-form" method="POST" action="${escapeHtml(mount)}/login" id="loginform" novalidate>
        <div class="tc-field">
          <label class="tc-label" for="key">Setup key</label>
          <div class="tc-inputwrap">
            <input class="tc-input tc-input--mono tc-input--lg" id="key" name="key" type="password" placeholder="Paste the setup key"
              autocomplete="current-password" autocapitalize="off" spellcheck="false" required autofocus${invalid}>
            <button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs tc-reveal" type="button" id="reveal" aria-label="Show the setup key" aria-pressed="false" hidden><i data-icon="eye"></i></button>
          </div>
          <p class="tc-hint tc-hint--err" id="key-error" role="alert"${error ? "" : " hidden"}>That key was not accepted. Keys are case-sensitive; paste it rather than typing it.</p>
        </div>
        <div class="tc-unlock-actions">
          <button class="tc-btn tc-btn--primary tc-btn--lg" type="submit" id="unlock">Unlock</button>
          ${t3Url ? `<a class="tc-btn tc-btn--lg" href="${escapeHtml(t3Url)}" rel="noopener">Open T3 Code</a>` : ""}
        </div>
      </form>
      <div class="tc-note">Left <code>T3_SETUP_KEY</code> empty? One was generated at boot and printed to the log:<br><code>docker compose logs t3code | grep -A1 T3_SETUP_KEY</code></div>
    </div>
  </div>
</main>
${scripts(assets.unlock, nonce)}
</body></html>`;
}
