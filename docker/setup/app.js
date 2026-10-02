// The setup console.
//
// It lives in its own file, not inside a template literal in server.mjs, and
// that is deliberate: a template literal eats backslashes on the way out, so
// `/\s+/` reached the browser as `/s+/` and split names on the letter s. The
// same trap ate an apostrophe once before. `node --check` cannot catch either,
// because the corrupted result still parses. Kept as a real file, nothing
// rewrites it between here and the browser.
//
// Four scripts share one scope, in this order: client/base.js (BASE, where the
// API lives), design/ui.js (window.T3C: icons and copy), client/model.js
// (T3Model: what every row, badge and step should say, as pure functions) and
// client/kit.js (Kit: markup, patching, overlays, toasts, keys). This file is
// the console on top of them:
//
//   data      /status every 15s (3s while work runs), /ports every 4s, paused
//             while the tab is hidden
//   routes    #overview #devices #agents #toolchains #ports #environment #more
//   pages     one renderer per route, markup in, Kit.patch out
//   commands  every button carries data-cmd; the palette runs the same table
//   flows     pairing, sign-in, API keys, versions, confirmations
//
// The page keeps a few facts the server cannot know: a click still in flight
// (lifecycleBusy), an operation it is waiting to hear the end of
// (pendingOps), the error a row should keep showing (notices), a version typed
// but not yet installed (versionDrafts). Polling never repaints an overlay,
// and patching never undoes typing, focus or an expanded row.
(() => {
  'use strict';
  if (!document.getElementById('app')) return;

  const M = T3Model;
  const { html, raw, icon, cx, patch } = Kit;
  const $ = (id) => document.getElementById(id);
  const now = () => Date.now();

  // ------------------------------------------------------------------ api --
  let locked = false;
  /**
   * One request to the setup API. Never throws: the answer carries `ok`,
   * `status`, the parsed body and a sentence for the user when it failed.
   */
  const api = async (path, { body, method } = {}) => {
    let res;
    try {
      res = await fetch(BASE + path, {
        method: method || (body === undefined ? 'GET' : 'POST'),
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch (error) {
      return { ok: false, status: 0, data: {}, error: 'Could not reach the setup service (' + (error.message || error) + ')' };
    }
    // The key changed (a recreated container generates a new one) or the
    // cookie expired. The page itself asks for the key again.
    if (res.status === 401 && !locked) {
      locked = true;
      location.replace(BASE + '/' + location.hash);
    }
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && data.ok !== false;
    return { ok, status: res.status, data, error: ok ? null : (data.error || 'HTTP ' + res.status) };
  };

  // ---------------------------------------------------------------- state --
  const state = {
    status: null,
    statusError: null,
    ports: null,
    portsAt: 0,
    providers: null,
    route: 'overview',
    agentFilter: 'all',
    toolFilter: '',
  };
  // What the page knows that /status cannot: see the header comment.
  const versionDrafts = new Map();   // agent id -> version typed in the dialog
  const lifecycleBusy = new Map();   // "harness:claude" -> kind, while the POST is in flight
  const pendingOps = new Map();      // accepted (202), waiting on /status for the end
  const notices = new Map();         // the last error or warning per row: {tone, text}
  const portsBusy = new Set();       // ports with a publish request in flight
  const expandedPorts = new Set();   // published ports showing their QR
  const ui = {
    busy: lifecycleBusy,
    pending: pendingOps,
    notices,
    portsBusy,
    expandedPorts,
    providerNames: [],
    signingIn: null,
  };

  const harness = (id) => ((state.status && state.status.harnesses) || []).find((h) => h.id === id) || null;
  const toolchain = (id) => ((state.status && state.status.toolchains) || []).find((t) => t.id === id) || null;
  const addedTool = (id) => ((state.status && state.status.packages) || []).find((p) => p.id === id) || null;
  const nameOf = (target, id) => target === 'harness' ? (M.AGENTS[id] || {}).name || (harness(id) || {}).name || id
    : target === 'package' ? (addedTool(id) || {}).name || M.toolName(id)
      : (M.TOOLCHAINS[id] || {}).name || (toolchain(id) || {}).name || id;
  // Where each kind of row's operations live in the API.
  const LIFECYCLE_PATH = { harness: 'harnesses', toolchain: 'toolchains', package: 'packages' };

  /** Where "Open T3 Code" goes: the public URL, else T3 Code beside this page. */
  const t3Url = () => {
    const s = state.status;
    if (s && s.publicUrl) return s.publicUrl;
    if (BASE) return '/';
    const port = (s && s.t3 && s.t3.port) || 3773;
    return location.protocol + '//' + location.hostname + ':' + port + '/';
  };

  // --------------------------------------------------------------- polling --
  const POLL_MS = 15000;
  const FAST_MS = 3000;
  const PORTS_MS = 4000;
  let statusTimer = null;
  let portsTimer = null;
  let statusLoading = null;
  let portsLoading = null;

  const busyNow = (s) => Boolean(s && (
    (s.setup && s.setup.state === 'running')
    || pendingOps.size > 0
    || Object.values(s.operations || {}).some((op) => op.state === 'running' || op.state === 'queued')
    || (s.harnesses || []).some((h) => h.inProgress)
    || (s.toolchains || []).some((t) => t.inProgress)));

  const loadStatus = () => {
    if (statusLoading) return statusLoading;
    statusLoading = (async () => {
      const res = await api('/status');
      if (res.ok) {
        state.status = res.data;
        state.statusError = null;
        settleOperations(res.data);
        trackPairing(res.data);
        loadProvidersOnce();
      } else if (!locked) {
        // Name the URL and the reason. "Could not read status" sent someone
        // hunting a migration bug when the page was calling the wrong path.
        state.statusError = res.error;
      }
      render();
      clearTimeout(statusTimer);
      if (!document.hidden && !locked) statusTimer = setTimeout(loadStatus, busyNow(state.status) ? FAST_MS : POLL_MS);
    })().finally(() => { statusLoading = null; });
    return statusLoading;
  };

  // Polled separately and more often: a tunnel takes a few seconds to be
  // handed a hostname, and a port appearing moments after a dev server starts
  // is the whole point. This is the same /ports API t3-expose calls, so
  // publishing from a terminal shows up here without anything telling the page.
  const loadPorts = () => {
    if (portsLoading) return portsLoading;
    portsLoading = (async () => {
      const res = await api('/ports');
      if (res.ok) { state.ports = res.data; state.portsAt = now(); }
      render();
      clearTimeout(portsTimer);
      if (!document.hidden && !locked) portsTimer = setTimeout(loadPorts, PORTS_MS);
    })().finally(() => { portsLoading = null; });
    return portsLoading;
  };

  // A hidden tab polls nothing; coming back catches up at once.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(statusTimer); clearTimeout(portsTimer); return; }
    loadStatus();
    loadPorts();
  });

  // OpenCode's row names its provider keys, and the key sheet lists them.
  let providersAsked = false;
  const loadProviders = async () => {
    const res = await api('/providers');
    if (res.ok) {
      state.providers = res.data;
      const names = new Map((res.data.providers || []).map((p) => [p.id, p.name]));
      ui.providerNames = (res.data.configured || []).map((id) => names.get(id) || id);
    }
    return state.providers;
  };
  const loadProvidersOnce = () => {
    if (providersAsked) return;
    const oc = harness('opencode');
    if (!oc || !oc.installed) return;
    providersAsked = true;
    loadProviders().then(render);
  };

  // ------------------------------------------------------------ operations --
  /** A click accepted earlier has finished: say how, once. */
  const settleOperations = (s) => {
    for (const [key, pending] of pendingOps) {
      const op = (s.operations || {})[key];
      const [target, id] = key.split(':');
      if (!op) {
        // The setup service restarted and forgot it. Once nothing is running
        // for this row any more, stop waiting: the row shows where it ended.
        const facts = target === 'harness' ? harness(id) : toolchain(id);
        if (now() - pending.at > 10000 && !(facts && facts.inProgress)) {
          pendingOps.delete(key);
          notices.set(key, { tone: 'warn', text: 'The setup service restarted during this ' + pending.kind + '; the row shows where it ended up.' });
        }
        continue;
      }
      if (op.state === 'running' || op.state === 'queued') continue;
      pendingOps.delete(key);
      if (op.state === 'ok') {
        if (op.warning) notices.set(key, { tone: 'warn', text: op.warning });
        else notices.delete(key);
        Kit.toast(M.DONE[op.kind] + ' ' + pending.name);
      } else if (op.state === 'cancelled') {
        notices.delete(key);
        Kit.toast('Cancelled: ' + pending.kind + ' ' + pending.name, { tone: 'info' });
      } else {
        const text = op.error || 'Could not ' + op.kind + ' ' + pending.name;
        notices.set(key, { tone: 'danger', text });
        const route = target === 'harness' ? 'agents' : 'toolchains';
        Kit.toast(M.FAILED[op.kind] + ': ' + pending.name, {
          tone: 'danger',
          detail: text,
          action: state.route === route ? null : { label: 'View', run: () => go(route) },
        });
      }
    }
  };

  /**
   * Install, update or uninstall. The POST answers 202 as soon as the work
   * holds the lock (or is queued behind other work); /status says how it ends.
   */
  const callLifecycle = async (target, kind, id, version) => {
    const key = target + ':' + id;
    const name = nameOf(target, id);
    notices.delete(key);
    lifecycleBusy.set(key, kind);
    render();
    const res = await api('/' + LIFECYCLE_PATH[target] + '/' + kind, { body: version ? { id, version } : { id } });
    lifecycleBusy.delete(key);
    if (res.status === 202) {
      pendingOps.set(key, { kind, name, at: now() });
      if (target === 'harness') versionDrafts.delete(id);
    } else if (!res.ok) {
      notices.set(key, { tone: 'danger', text: res.error || 'Could not ' + kind + ' ' + name });
    } else {
      if (target === 'harness') versionDrafts.delete(id);
      notices.delete(key);
      Kit.toast(M.DONE[kind] + ' ' + name);
    }
    render();
    await loadStatus();
    return res;
  };

  const cancelOperation = async (target, id) => {
    const res = await api('/' + LIFECYCLE_PATH[target] + '/cancel', { body: { id } });
    if (!res.ok) Kit.toast('Could not cancel', { tone: 'danger', detail: res.error });
    await loadStatus();
  };

  const confirmUninstall = async (target, id) => {
    const name = nameOf(target, id);
    const facts = target === 'harness' ? harness(id) : target === 'package' ? addedTool(id) : toolchain(id);
    const version = facts && (facts.installedVersion || facts.version);
    const ok = await Kit.confirm(target === 'package'
      ? {
        title: 'Uninstall ' + name + '?',
        body: 'Removes ' + name + (version ? ' ' + version : '') + ' from your global mise config and from the volume. A project that pins its own version in mise.toml still gets that one.',
        consequences: [
          { icon: 'trash-2', text: 'Removed: every release this console installed' },
          { icon: 'shield-check', text: 'Kept: project pins in mise.toml and .tool-versions' },
          { icon: 'plus', text: 'Add it again any time from Add a tool' },
        ],
        confirm: 'Uninstall',
      }
      : target === 'harness'
      ? {
        title: 'Uninstall ' + name + '?',
        body: 'Removes ' + (version ? 'the ' + version + ' executable' : 'the executable') + ' and its T3 Code wiring. Your sign-in and user data stay on the volume, so installing again signs you straight back in.',
        consequences: [
          { icon: 'trash-2', text: 'Removed: the CLI and T3 Code’s provider path' },
          { icon: 'shield-check', text: 'Kept: credentials, settings, history' },
          { icon: 'lock', text: 'Stays uninstalled across restarts' },
        ],
        confirm: 'Uninstall',
      }
      : {
        title: 'Uninstall ' + name + '?',
        body: 'Removes ' + name + (version ? ' ' + version : '') + ' from the volume. A project that pins its own version in mise.toml still gets that one from mise.',
        consequences: [
          { icon: 'trash-2', text: 'Removed: every release this console installed' },
          { icon: 'shield-check', text: 'Kept: project pins in mise.toml and .tool-versions' },
          { icon: 'lock', text: 'Stays uninstalled across restarts' },
        ],
        confirm: 'Uninstall',
      });
    if (ok) callLifecycle(target, 'uninstall', id);
  };

  /**
   * "Update all": one request each; the server runs them one after another.
   * `tools` is the Toolchains page's: the toolchains and the added tools.
   */
  const updateAll = async (target) => {
    const rows = target === 'harness' ? M.agentRows(state.status, ui, now())
      : [...M.toolchainRows(state.status, ui, now()), ...M.packageRows(state.status, ui, now())];
    const due = rows.filter((r) => r.updateAvailable && r.state !== 'running' && r.state !== 'queued');
    if (!due.length) { Kit.toast('Everything is up to date', { tone: 'info' }); return; }
    for (const row of due) await callLifecycle(row.target, 'update', row.id);
  };

  // ------------------------------------------------------------- markup --
  const tile = (row, size) => html`<span class="${cx('tc-tile', size && 'tc-tile--' + size, row.dim && 'tc-tile--dim')}" style="--_tile: var(${row.hue})" aria-hidden="true">${row.mono}</span>`;
  const dot = (tone, extra) => html`<span class="${cx('tc-dot', 'tc-dot--' + tone, extra)}"></span>`;
  const badge = (b) => b ? html`<span class="${cx('tc-badge', b.tone && 'tc-badge--' + b.tone)}">${b.spinner ? html`<span class="tc-spinner" aria-hidden="true"></span>` : ''}${b.text}</span>` : '';
  const statusLine = (st, attrs) => html`<span class="tc-status"${attrs || ''}>${st.dot ? dot(st.dot) : ''}<span class="tc-status-text">${st.text}${st.code ? html` <code>${st.code}</code>` : ''}</span></span>`;
  const noticeLine = (n) => n ? html`<span class="tc-status" role="${n.tone === 'danger' ? 'alert' : 'status'}">${dot(n.tone === 'danger' ? 'danger' : 'warn')}<span class="tc-status-text">${n.text}</span></span>` : '';
  const versionLabel = (row) => {
    if (!row.version) return '';
    if (row.versionTo) return html`<span class="tc-version">${row.version} <span class="tc-version-arrow" aria-label="to">→</span> ${row.versionTo}</span>`;
    // While work runs the row shows its progress instead.
    const glyph = row.updateAvailable && row.state !== 'running' && row.state !== 'queued';
    return html`<span class="tc-version">${row.version}${glyph ? html` <span class="tc-version-next" role="img" aria-label="Update available: ${row.latest}">${icon('circle-arrow-up')}</span>` : ''}</span>`;
  };
  const progressBar = (p) => html`<div class="tc-progress"${p && p.pct !== null ? '' : raw(' data-indeterminate')} style="--value: ${p && p.pct !== null ? p.pct : 0}%" role="progressbar" aria-label="Progress"${p && p.pct !== null ? raw(' aria-valuenow="' + p.pct + '" aria-valuemin="0" aria-valuemax="100"') : ''}><span></span></div>`;
  const phaseText = (p, kind) => {
    if (p && p.phase) return p.phase[0].toUpperCase() + p.phase.slice(1);
    return (M.WORKING[kind] || 'Working') + '…';
  };
  const opLine = (row) => html`<div class="tc-op tc-row-op"><span class="tc-op-line tc-muted">${phaseText(row.progress, row.kind)}</span><span class="tc-op-pct">${M.progressText(row.progress)}</span>${progressBar(row.progress)}</div>`;

  const btnClass = (variant, size) => cx('tc-btn', size || 'tc-btn--sm', variant && 'tc-btn--' + variant);
  const actionButton = (row, opts) => {
    const a = row.action;
    if (!a) return '';
    const variant = a.variant === 'primary' && opts.primary === false ? null : a.variant;
    return html`<button class="${btnClass(variant)}" type="button" data-cmd="${a.cmd}" data-target="${row.target}" data-id="${row.id}" data-key="act-${row.key}">${a.icon ? icon(a.icon) : ''}${a.label}</button>`;
  };
  const menuButton = (row) => row.menu.length
    ? html`<button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" aria-label="More for ${row.name}" aria-haspopup="menu" aria-expanded="${String(Kit.menuOpenFor('menu-' + row.key))}" data-cmd="row.menu" data-target="${row.target}" data-id="${row.id}" data-key="menu-${row.key}">${icon('ellipsis')}</button>`
    : '';

  /** An agent or toolchain row: tile, name and version, one status line, one verb, a menu. */
  const resourceRow = (row, opts = {}) => html`
    <div class="${cx('tc-row', (row.state === 'running' || row.state === 'signing') && 'tc-row--expanded')}" data-key="row-${row.key}">
      ${tile(row)}
      <div class="tc-row-main">
        <div class="tc-row-title"><span class="tc-row-name"${row.description ? html` title="${row.description}"` : ''}>${row.name}</span>${versionLabel(row)}${badge(row.badge)}</div>
        ${statusLine(row.status)}
        ${noticeLine(row.notice)}
        ${row.state === 'running' ? opLine(row) : ''}
      </div>
      <div class="tc-row-actions">${actionButton(row, opts)}${opts.menu === false ? '' : menuButton(row)}</div>
    </div>`;

  const section = (id, title, body, { actions, level } = {}) => html`
    <section class="tc-section" aria-labelledby="${id}">
      <div class="tc-section-head"><${raw(level || 'h2')} class="tc-section-title" id="${id}">${title}</${raw(level || 'h2')}>${actions ? html`<div class="tc-section-actions">${actions}</div>` : ''}</div>
      ${body}
    </section>`;
  const muted = (text) => html`<span class="tc-small tc-muted">${text}</span>`;
  const linkButton = (href, label, extra) => html`<a class="tc-btn tc-btn--ghost tc-btn--ghost-muted tc-btn--xs" href="${href}"${extra || ''}>${label}${icon('arrow-right')}</a>`;
  const notice = (tone, iconName, title, desc, action) => html`
    <div class="${cx('tc-notice', tone && 'tc-notice--' + tone)}"${tone === 'danger' ? raw(' role="alert"') : ''}>${icon(iconName)}<div class="tc-notice-body">${title ? html`<span class="tc-notice-title">${title}</span>` : ''}${desc ? html`<span class="tc-notice-desc">${desc}</span>` : ''}</div>${action || ''}</div>`;
  // `size` is a tc-btn size class; '' is the default size, absent is xs.
  const copyButton = (text, label, opts = {}) => {
    const size = opts.size === undefined ? 'tc-btn--xs' : opts.size;
    return opts.iconOnly
      ? html`<button class="${cx('tc-btn tc-btn--icon', opts.ghost !== false && 'tc-btn--ghost', size)}" type="button" data-cmd="copy" data-text="${text}" aria-label="${label}">${icon('copy')}</button>`
      : html`<button class="${cx('tc-btn', opts.ghost !== false && 'tc-btn--ghost', size)}" type="button" data-cmd="copy" data-text="${text}">${icon('copy')}<span data-label>${label || 'Copy'}</span></button>`;
  };
  const copyField = (value, { code, actions, label } = {}) => html`
    <div class="${cx('tc-copyfield', code && 'tc-copyfield--code')}"><span class="tc-copyfield-value">${value}</span><span class="tc-copyfield-actions">${actions || copyButton(value, label)}</span></div>`;
  /**
   * qrencode's SVG, minus its XML prolog and the root's size in centimetres,
   * so the stylesheet sizes it. Only the root tag is touched: every module is
   * a <rect> with a width and height of its own.
   */
  const qrSvg = (svg) => {
    const text = String(svg || '');
    const at = text.indexOf('<svg');
    if (at < 0) return '';
    const tag = text.indexOf('>', at);
    return raw(text.slice(at, tag).replace(/\s(width|height)="[^"]*"/g, '') + text.slice(tag));
  };
  const skeletonGroup = (rows) => html`<div class="tc-group" aria-hidden="true">${Array.from({ length: rows }, (_, i) => html`<div class="tc-skel-row"><span class="tc-skel tc-skel--tile"></span><span class="tc-skel" style="width:${[38, 52, 30, 44][i % 4]}%"></span></div>`)}</div>`;

  // ------------------------------------------------------- page notices --
  /** What could not be read, or is not current, above the page it affects. */
  const pageNotices = (route) => {
    const s = state.status;
    const out = [];
    if (state.statusError) {
      out.push(notice('danger', 'circle-alert', 'Could not read status',
        html`From <code>${BASE + '/status'}</code>: ${state.statusError}.${BASE ? '' : html` If this page is served under a path prefix, set <code>T3_SETUP_BASE_PATH</code>.`}`,
        html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="refresh">${icon('refresh-cw')}Retry</button>`));
    }
    if (!s) return out;
    // A part that could not be read says so, instead of rendering as "none".
    if ((s.degraded || []).length) {
      out.push(notice('warn', 'triangle-alert', 'Some of this is unreadable right now',
        'Could not read ' + M.listOf(s.degraded.map((d) => d.what)) + '. Those parts show as empty; the container may still be starting.'));
    }
    const setup = s.setup;
    if (setup && (route === 'overview' || route === 'agents' || route === 'toolchains')) {
      const items = setup.items || [];
      // After a finished run, anything still pending was not tried: the run
      // stops after three failures in a row, which is nearly always no network.
      const failed = items.filter((i) => i.state === 'failed' || (setup.state === 'finished' && i.state === 'pending'))
        .filter((i) => {
          const facts = i.kind === 'agent' ? harness(i.id) : toolchain(i.id);
          return !(facts && facts.installed);
        });
      if (setup.state !== 'running' && failed.length) {
        out.push(notice('warn', 'triangle-alert', 'First start could not install ' + M.listOf(failed.map((i) => i.name)),
          (failed[0].error ? failed[0].error.slice(0, 160) + '. ' : '') + 'Press Retry on the row to try again now; the next restart retries as well.'));
      } else if (setup.state === 'interrupted') {
        const done = items.filter((i) => i.state === 'done').length;
        out.push(notice(null, 'history', 'First start stopped part way', done + ' of ' + items.length + ' installed. It carries on the next time the container starts.'));
      }
    }
    // The sign-in state below is the last definite answer, not a fresh probe:
    // offline, the refresh exceeds its budget and warms the next poll instead.
    const cache = s.harnessCache;
    if (route === 'agents' && cache && cache.stale && (cache.source === 'cache' || cache.source === 'cheap')) {
      out.push(notice(null, 'history', null, 'Sign-in state is from the last check while a fresh one finishes. It refreshes on the next poll.'));
    }
    return out;
  };

  // ------------------------------------------------------------- overview --
  const stepAction = (a, size) => {
    if (!a) return '';
    const cls = cx('tc-btn', a.variant === 'primary' && 'tc-btn--primary', size || 'tc-btn--sm');
    if (a.cmd === 'goto') return html`<a class="${cls}" href="#${a.route}">${a.icon ? icon(a.icon) : ''}${a.label}</a>`;
    return html`<button class="${cls}" type="button" data-cmd="${a.cmd}"${a.copy ? html` data-text="${a.copy}"` : ''}>${a.icon ? icon(a.icon) : ''}${a.label}</button>`;
  };

  const readinessGroup = (r) => {
    const next = r.steps.find((step) => step.state === 'todo');
    return html`
      <section class="tc-group tc-group--brand" aria-labelledby="ready-title" data-key="readiness">
        <div class="tc-ready">
          <div class="tc-ready-head">
            <div class="tc-ready-heading"><span class="tc-small tc-muted">Setup · ${r.done} of ${r.total} done</span><h1 class="tc-ready-title" id="ready-title">${r.title}</h1></div>
            <span class="tc-spacer"></span>
            <div class="tc-ready-meter" aria-hidden="true">${r.steps.map((step) => html`<span${step.done ? raw(' data-done') : ''}></span>`)}</div>
          </div>
          <p class="tc-page-lede">${r.lede}</p>
          ${next && next.action ? html`<div class="tc-phone-only tc-ready-cta">${stepAction(next.action, 'tc-btn--block')}</div>` : ''}
        </div>
        <ol class="tc-checklist">
          ${r.steps.map((step, i) => html`
            <li class="${cx('tc-check', step.state === 'todo' && step.action && 'tc-desk-only')}" data-state="${step.state}" data-key="step-${step.id}">
              <span class="tc-check-mark">${step.done ? icon('check') : String(i + 1)}</span>
              <span class="tc-check-title">${step.title}</span>
              ${step.done && step.aside ? html`<span class="tc-check-aside tc-mono tc-muted">${step.aside}</span>` : ''}
              ${stepAction(step.action)}
              ${!step.done && step.desc ? html`<span class="tc-check-desc">${step.desc}</span>` : ''}
            </li>`)}
        </ol>
      </section>`;
  };

  const readyLine = (s) => html`
    <section class="tc-group tc-group--brand" aria-labelledby="ready-title" data-key="ready">
      <div class="tc-ready-line">
        <span class="tc-check-mark" aria-hidden="true">${icon('check')}</span>
        <div class="tc-row-main"><h1 class="tc-ready-line-title" id="ready-title">Ready</h1><span class="tc-status">${M.readySummary(s, ui)}</span></div>
        <a class="tc-btn tc-btn--sm" href="${t3Url()}" target="_blank" rel="noopener">Open T3 Code${icon('arrow-right')}</a>
      </div>
    </section>`;

  const attentionRow = (item) => {
    if (item.target === 'port') return portRow(item.port);
    return resourceRow(item, { primary: false, menu: false });
  };

  const activitySection = (act, n) => {
    const lines = [];
    for (const row of act.running) {
      const p = row.progress;
      lines.push(html`<div class="tc-op" data-key="op-${row.key}"><span class="tc-op-line">${tile(row)}<span class="tc-truncate">${row.badge.text} ${row.name}${row.versionTo ? ' ' + row.versionTo : ''}</span></span><span class="tc-op-pct">${p && p.pct !== null ? p.pct + '%' : p && p.phase ? p.phase : ''}</span>${progressBar(p)}</div>`);
    }
    act.queued.forEach((row, i) => {
      lines.push(html`<div class="tc-op" data-key="op-${row.key}"><span class="tc-op-line">${tile(row)}<span class="tc-truncate tc-muted">${row.name} · queued</span></span><span class="tc-op-pct">${i === 0 && !act.running.length ? 'next' : i === 0 ? 'next' : 'queued'}</span></div>`);
    });
    for (const f of act.finished) {
      lines.push(html`<div class="tc-op" data-key="op-done-${f.key}"><span class="tc-op-line">${icon(f.ok ? 'circle-check' : 'circle-alert', f.ok ? 'tc-ok' : 'tc-danger')}<span class="tc-truncate">${f.text}</span></span><span class="tc-op-pct" title="${M.absTime(f.at)}">${M.relTime(f.at, n)}</span></div>`);
    }
    if (!lines.length) return '';
    return section('act-title', 'Activity', html`<div class="tc-group"><div class="tc-card-body tc-op-list">${lines}</div></div>`, { actions: muted('Runs in the background') });
  };

  const glanceSection = (s, ports, n) => {
    const sessions = s.sessions || [];
    const lastSeen = sessions.some((c) => c.connected) ? 'active now'
      : sessions.map((c) => M.toMs(c.lastConnectedAt)).filter(Boolean).sort((a, b) => b - a).map((t) => 'last seen ' + M.relTime(t, n))[0] || 'none connected yet';
    const agents = M.agentRows(s, ui, n);
    const installed = agents.filter((a) => a.version);
    const signed = agents.filter((a) => a.state === 'ok' || a.state === 'update').length;
    const updates = agents.filter((a) => a.updateAvailable).length;
    const published = ports ? M.portRows(ports, ui, n).filter((p) => p.state === 'open') : [];
    const readout = (label, value, sub) => html`<div class="tc-readout"><span class="tc-readout-label">${label}</span><span class="tc-readout-value">${value}</span>${sub ? html`<span class="tc-small tc-muted">${sub}</span>` : ''}</div>`;
    const paths = s.paths || {};
    return section('glance-title', 'At a glance', html`<div class="tc-group"><div class="tc-readouts">
      ${readout('Devices', sessions.length + ' paired', lastSeen)}
      ${readout('Agents', signed + ' of ' + installed.length + ' signed in', updates ? M.plural(updates, 'update') + ' available' : 'all current')}
      ${readout('Ports', published.length ? html`${dot('info')}${published.length} published` : 'None published', published.length ? published.map((p) => p.port + (p.startedAt ? ' · ' + M.duration((n - p.startedAt) / 1000) : '')).join(', ') : ports ? M.plural(M.portRows(ports, ui, n).length, 'port') + ' listening' : '')}
      ${Number.isFinite(paths.volumeBytes) ? readout('Volume', M.formatBytes(paths.volumeBytes), paths.volume) : ''}
    </div></div>`);
  };

  const deviceRow = (d, { revoke, fresh } = {}) => html`
    <div class="tc-row tc-row--compact" data-key="dev-${d.id}">
      <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon(d.icon)}</span>
      <div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">${d.name}</span>${fresh ? html`<span class="tc-badge tc-badge--ok">New</span>` : ''}</div><span class="tc-status" title="${d.seenTitle}">${[d.status, d.ends].filter(Boolean).join(' · ')}</span></div>
      ${revoke ? html`<div class="tc-row-actions"><button class="tc-btn tc-btn--danger tc-btn--sm" type="button" data-cmd="device.revoke" data-id="${d.id}" aria-label="Revoke ${d.name}">Revoke</button></div>`
        : d.connected ? html`<span class="tc-dot tc-dot--ok" role="img" aria-label="Connected"></span>` : html`<span></span>`}
    </div>`;

  const recentSection = (s, n) => {
    const events = s.events || [];
    if (!events.length) return '';
    const ICONS = {
      'device.paired': 'smartphone', 'port.published': 'globe', 'port.stopped': 'circle-stop', 'harness.updated': 'circle-arrow-up',
      'harness.installed': 'download', 'harness.uninstalled': 'trash-2', 'harness.failed': 'circle-alert', 'signin.ok': 'log-in', 'setup.finished': 'download',
      'toolchain.installed': 'download', 'toolchain.updated': 'circle-arrow-up', 'toolchain.uninstalled': 'trash-2', 'toolchain.failed': 'circle-alert',
      'package.installed': 'download', 'package.updated': 'circle-arrow-up', 'package.uninstalled': 'trash-2', 'package.failed': 'circle-alert',
    };
    return section('recent-title', 'Recent', html`<div class="tc-group"><ol class="tc-log">${events.slice(0, 8).map((e) => html`
      <li data-key="ev-${e.at}-${e.kind}">${icon(ICONS[e.kind] || 'activity')}<span class="tc-truncate">${e.text}${e.detail ? html` <span class="tc-mono">${e.detail}</span>` : ''}</span><time datetime="${new Date(e.at).toISOString()}" title="${M.absTime(e.at)}">${M.relTime(e.at, n)}</time></li>`)}</ol></div>`,
    { actions: muted('Since the setup service started') });
  };

  const overviewPage = (s, n) => {
    const r = M.readiness(s, ui);
    const needs = M.needsYou(s, state.ports, ui);
    const devices = M.deviceRows(s.sessions, n);
    return html`
      ${pageNotices('overview')}
      ${r.ready ? readyLine(s) : readinessGroup(r)}
      ${needs.length ? section('needs-title', 'Needs you', html`<div class="tc-group"><div class="tc-list">${needs.map(attentionRow)}</div></div>`,
        { actions: needs.every((x) => x.target === 'port') ? linkButton('#ports', 'All ports') : linkButton('#agents', 'All agents') }) : ''}
      ${activitySection(M.activity(s, ui, n), n)}
      ${r.ready ? html`
        ${glanceSection(s, state.ports, n)}
        ${devices.length ? section('devs-title', 'Paired devices', html`<div class="tc-group"><div class="tc-list">${devices.map((d) => deviceRow(d))}</div></div>`, { actions: linkButton('#devices', 'Manage') }) : ''}
        ${recentSection(s, n)}` : ''}`;
  };

  // -------------------------------------------------------------- devices --
  // A minted pairing link, tracked until the device it was made for shows up.
  // The sessions that existed at mint time are the baseline; a new one is what
  // proves the scan landed. Held here, not in the DOM, so the poll can advance
  // the tracker without repainting the QR underneath it.
  const pair = {
    ttl: '30d',
    showForm: true,
    minting: false,
    error: null,
    minted: null,       // {id, pairUrl, credential, expiresAt, qr, label, baseline, seen, outcome, pairedName, pairedId}
    freshSession: null, // the session that just paired, for its "New" badge
  };
  const TTLS = [['1h', '1 hour'], ['7d', '7 days'], ['30d', '30 days']];

  const trackPairing = (s) => {
    const m = pair.minted;
    if (!m || m.outcome) return;
    const sessions = s.sessions || [];
    if (m.baseline === null) { m.baseline = new Set(sessions.map((c) => c.sessionId)); return; }
    const fresh = sessions.find((c) => !m.baseline.has(c.sessionId));
    if (fresh) {
      m.outcome = 'paired';
      m.pairedName = (fresh.client && fresh.client.label) || fresh.subject || 'your device';
      pair.freshSession = fresh.sessionId;
      Kit.toast('Paired with ' + m.pairedName, { detail: 'It is already signed in.' });
      return;
    }
    const listed = (s.pairings || []).some((l) => l.id === m.id);
    if (listed) m.seen = true;
    if (m.expiresAt && Date.parse(m.expiresAt) < now()) { m.outcome = 'expired'; return; }
    // Only call it revoked once the list has shown the link at least once: the
    // status read that follows a mint can land before the pairing is listed.
    if (m.seen && !listed) m.outcome = 'revoked';
  };

  const mint = async () => {
    const s = state.status;
    if (pair.minting) return;
    if (s && !s.publicUrl) {
      pair.error = 'Set T3_PUBLIC_URL first: a pairing link points at it, and without it a device has nowhere to go.';
      render();
      return;
    }
    const input = $('pair-label');
    const label = input ? input.value.trim() : (pair.minted && pair.minted.label) || '';
    pair.minting = true;
    pair.error = null;
    render();
    const res = await api('/pair', { body: { ttl: pair.ttl, label } });
    pair.minting = false;
    if (!res.ok) {
      pair.error = res.error || 'Could not create a link';
      pair.showForm = true;
      render();
      return;
    }
    // Baseline the session list before the ceremony goes up. Null only if no
    // status read has finished yet; the next one captures it instead.
    pair.minted = {
      id: res.data.id,
      pairUrl: res.data.pairUrl,
      credential: res.data.credential || null,
      expiresAt: res.data.expiresAt,
      qr: res.data.qr,
      label,
      ttl: pair.ttl,
      baseline: s ? new Set((s.sessions || []).map((c) => c.sessionId)) : null,
      seen: false,
      outcome: null,
    };
    pair.showForm = false;
    pair.freshSession = null;
    if (input) input.value = '';
    render();
    Kit.announce('Pairing link created. Waiting for the device.');
    loadStatus();
  };

  const pairSteps = (m) => {
    const failed = m.outcome === 'expired' || m.outcome === 'revoked';
    const paired = m.outcome === 'paired';
    const stepState = [ 'done', failed ? 'failed' : paired ? 'done' : 'active', paired ? 'done' : '' ];
    const labels = [['Link created', 'Created'], [failed ? (m.outcome === 'expired' ? 'Link expired' : 'Link revoked') : 'Waiting for the device', failed ? (m.outcome === 'expired' ? 'Expired' : 'Revoked') : 'Waiting'], ['Paired', 'Paired']];
    const parts = [];
    labels.forEach(([long, short], i) => {
      if (i) parts.push(html`<span class="tc-step-line"${stepState[i - 1] === 'done' && stepState[i] !== '' ? raw(' data-done') : ''} aria-hidden="true"></span>`);
      const mark = stepState[i] === 'done' ? icon('check') : stepState[i] === 'failed' ? icon('x') : String(i + 1);
      parts.push(html`<li class="tc-step"${stepState[i] ? raw(' data-state="' + stepState[i] + '"') : ''}${stepState[i] === 'active' ? raw(' aria-current="step"') : ''}><span class="tc-step-mark">${mark}</span><span class="tc-step-text-long">${long}</span><span class="tc-step-text-short">${short}</span></li>`);
    });
    return html`<ol class="tc-steps" aria-label="Pairing progress">${parts}</ol>`;
  };

  const pairForm = (s) => {
    const noUrl = s && !s.publicUrl;
    return html`
      <div class="tc-group tc-group--brand" data-key="pair-form"><div class="tc-card-body tc-pair-form">
        <div class="tc-pair-form-intro"><span class="tc-row-name">A single-use link for one device</span><span class="tc-small tc-muted">Scan it with the T3 Code app, open it in a browser, or paste the pair code into the desktop app.</span></div>
        <div class="tc-pair-form-fields">
          <div class="tc-field"><label class="tc-label" for="pair-label">Label <span class="tc-label-opt">optional</span></label><input id="pair-label" class="tc-input" placeholder="e.g. iPhone" maxlength="64" autocomplete="off" spellcheck="false"></div>
          <div class="tc-field"><span class="tc-label" id="ttl-label">Expires in</span><div class="tc-seg" role="group" aria-labelledby="ttl-label">${TTLS.map(([value, label]) => html`<button type="button" aria-pressed="${String(pair.ttl === value)}" data-cmd="pair.ttl" data-value="${value}">${label}</button>`)}</div></div>
        </div>
        <button class="tc-btn tc-btn--primary" type="button" data-cmd="pair.start" data-key="pair-create"${pair.minting || noUrl ? raw(' disabled') : ''}>${pair.minting ? html`<span class="tc-spinner" aria-hidden="true"></span>` : icon('link')}Create pairing link<span class="tc-kbd tc-desk-only" aria-hidden="true">P</span></button>
        ${noUrl ? html`<div class="tc-pair-form-note">${notice('warn', 'triangle-alert', 'Set T3_PUBLIC_URL first', 'A pairing link points at the address in T3_PUBLIC_URL. Set it to the URL your devices use, then recreate the container.')}</div>` : ''}
        ${pair.error && !noUrl ? html`<p class="tc-hint tc-hint--err tc-pair-form-note" role="alert">${pair.error}</p>` : ''}
      </div></div>`;
  };

  const pairCeremony = (m, s, n) => {
    if (m.outcome === 'paired') {
      return html`
        <div class="tc-group tc-group--brand" data-key="pair-done"><div class="tc-card-body tc-pair-done">
          ${pairSteps(m)}
          <span class="tc-empty-icon">${icon('smartphone', 'tc-icon--lg')}</span>
          <div class="tc-pair-done-text"><h3 class="tc-pair-done-title">Paired with ${m.pairedName}</h3><p class="tc-page-lede">It is already signed in. You can close this page.</p></div>
          <div class="tc-pair-done-actions"><a class="tc-btn tc-btn--primary" href="${t3Url()}" target="_blank" rel="noopener">${icon('external-link')}Open T3 Code</a><button class="tc-btn tc-btn--ghost" type="button" data-cmd="pair.new">Pair another device</button></div>
        </div></div>`;
    }
    if (m.outcome) {
      return html`
        <div class="tc-group tc-group--brand" data-key="pair-ended"><div class="tc-card-body tc-stack tc-pair-body">
          ${pairSteps(m)}
          <p class="tc-page-lede">${m.outcome === 'expired' ? 'This link expired before a device used it.' : 'This link was revoked before a device used it.'} Create another one to pair.</p>
          <div><button class="tc-btn tc-btn--primary" type="button" data-cmd="pair.again">${icon('link')}Create another link</button></div>
        </div></div>`;
    }
    const code = m.credential;
    return html`
      <div class="tc-group tc-group--brand" data-key="pair-live">
        <div class="tc-card-body tc-stack tc-pair-body">
          ${pairSteps(m)}
          <div class="tc-pair">
            <div class="tc-pair-fields">
              <div class="tc-field tc-desk-only"><span class="tc-label">Pairing link</span>${copyField(m.pairUrl, { actions: html`${copyButton(m.pairUrl)}<a class="tc-btn tc-btn--ghost tc-btn--xs tc-btn--icon" href="${m.pairUrl}" target="_blank" rel="noopener" aria-label="Open pairing link">${icon('external-link')}</a>` })}</div>
              ${code ? html`<div class="tc-field"><span class="tc-label">Pair code</span>${copyField(code, { code: code.length <= 14 })}<p class="tc-hint tc-desk-only">For desktop clients that ask for a server URL and a code separately. The server URL is ${s.publicUrl}.</p></div>` : ''}
              <div class="tc-pair-phone-actions tc-phone-only">${copyButton(m.pairUrl, 'Copy link', { ghost: false, size: '' })}<a class="tc-btn" href="${m.pairUrl}" target="_blank" rel="noopener">${icon('external-link')}Open here</a></div>
              <div class="tc-notice tc-desk-only">${icon('shield-check')}<div class="tc-notice-body"><span class="tc-notice-desc">The token lives in the link fragment. Treat the link like a password.</span></div></div>
            </div>
            ${m.qr ? html`<div class="tc-pair-qr"><div class="tc-qr" role="img" aria-label="QR code for the pairing link" data-keep>${qrSvg(m.qr)}</div><div class="tc-qr-caption">Scan with the T3 Code app</div></div>` : ''}
          </div>
        </div>
        <div class="tc-card-foot" aria-live="polite"><span class="tc-spinner tc-info" aria-hidden="true"></span><span>Listening for the device…<span class="tc-desk-only"> this page updates on its own.</span></span><span class="tc-spacer"></span><button class="tc-btn tc-btn--danger tc-btn--xs" type="button" data-cmd="link.revoke" data-id="${m.id}">Revoke link</button></div>
      </div>`;
  };

  const devicesPage = (s, n) => {
    const devices = M.deviceRows(s.sessions, n);
    const m = pair.minted;
    const waiting = m && !m.outcome ? m.id : null;
    const links = M.linkRows(s.pairings, waiting, n);
    const ceremony = m && !pair.showForm;
    const sub = ceremony && !m.outcome
      ? (m.label ? '“' + m.label + '” · ' : '') + 'single use · expires ' + M.relTime(m.expiresAt, n)
      : null;
    return html`
      ${pageNotices('devices')}
      ${section('pair-title', 'Pair a device', ceremony ? pairCeremony(m, s, n) : pairForm(s), { actions: sub ? muted(sub) : null })}
      ${section('paired-title', 'Paired devices', devices.length
        ? html`<div class="tc-group"><div class="tc-list">${devices.map((d) => deviceRow(d, { revoke: true, fresh: d.id === pair.freshSession }))}</div></div>`
        : html`<div class="tc-group"><div class="tc-empty">
            <span class="tc-empty-icon">${icon('smartphone')}</span>
            <span class="tc-empty-title">No devices paired yet</span>
            <span class="tc-empty-desc">Create a link above, then scan it with the phone you want to drive this server from.</span>
            <span class="tc-mono tc-muted tc-empty-cmd">or run t3-pair in the container</span>
          </div></div>`,
      { actions: ceremony ? html`<button class="tc-btn tc-btn--xs" type="button" data-cmd="pair.new">${icon('plus')}New link<span class="tc-kbd tc-desk-only" aria-hidden="true">P</span></button>` : devices.length ? muted(String(devices.length)) : null })}
      ${links.length ? section('links-title', 'Unused links', html`<div class="tc-group"><div class="tc-list">${links.map((l) => html`
        <div class="tc-row tc-row--compact" data-key="link-${l.id}">
          <span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('link')}</span>
          <div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">${l.name}</span>${l.waiting ? html`<span class="tc-badge tc-badge--info">Waiting</span>` : ''}</div><span class="tc-status" title="${l.expiresTitle}">${l.status}</span></div>
          <div class="tc-row-actions"><button class="tc-btn tc-btn--danger tc-btn--sm" type="button" data-cmd="link.revoke" data-id="${l.id}" aria-label="Revoke link ${l.name}">Revoke</button></div>
        </div>`)}</div></div>`) : ''}
      ${devices.length ? '' : notice(null, 'history', 'Sessions last 30 days', 'After that the device asks to pair again, which takes a few seconds here. Threads, projects and agent sign-ins are kept on the volume.')}`;
  };

  // --------------------------------------------------------------- agents --
  const agentsPage = (s, n) => {
    const rows = M.agentRows(s, ui, n);
    const needs = rows.filter((r) => r.attention || r.updateAvailable);
    const shown = state.agentFilter === 'attention' ? needs : rows;
    const filter = html`<div class="tc-seg" role="group" aria-label="Show">${[['all', 'All'], ['attention', 'Needs you']].map(([value, label]) => html`<button type="button" aria-pressed="${String(state.agentFilter === value)}" data-cmd="agents.filter" data-value="${value}">${label}${value === 'attention' && needs.length ? html` <span class="tc-num">${needs.length}</span>` : ''}</button>`)}</div>`;
    return html`
      ${pageNotices('agents')}
      ${section('ag-title', 'Agents', html`<div class="tc-group">
        ${shown.length ? html`<div class="tc-list">${shown.map((row) => resourceRow(row))}</div>`
          : rows.length ? html`<div class="tc-empty tc-empty--compact"><span class="tc-empty-title">Nothing needs you</span><span class="tc-empty-desc">Every installed agent is signed in and current.</span></div>`
            : html`<div class="tc-empty tc-empty--compact"><span class="tc-empty-desc">Agent state is not readable right now.</span></div>`}
        <div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>Then turn each provider on in T3 Code under Settings → Providers.</span></div>
      </div>`, { actions: filter })}
      ${section('ag-how', 'How sign-in works', html`<div class="tc-group"><dl class="tc-kv">
        <dt>Credentials</dt><dd class="tc-kv-prose">On the state volume at <code>${(s.paths && s.paths.volume) || '/home/t3'}</code>. They survive a recreate.</dd>
        <dt>Signed-in check</dt><dd class="tc-kv-prose">Asks each CLI, so keys in the environment count too.</dd>
        <dt>From a shell</dt><dd><code>t3-login claude</code><span class="tc-subtle">·</span><code>t3-harness list</code></dd>
      </dl></div>`)}`;
  };

  // ----------------------------------------------------------- toolchains --
  const INCLUDED = [
    ['terminal', 'Node and Python', 'with npm, pip'],
    ['terminal', 'git, git-lfs, gh, ssh', 'source control'],
    ['wrench', 'clang, CMake, GDB', 'native builds'],
    ['server', 'psql, redis-cli', 'databases'],
    ['activity', 'ffmpeg, ImageMagick', 'media'],
    ['globe', 'Headless Chromium', 'browser image', 'browser'],
  ];
  const toolchainsPage = (s, n) => {
    const rows = M.toolchainRows(s, ui, n);
    const added = M.packageRows(s, ui, n);
    const paths = s.paths || {};
    const browserImage = (s.image && s.image.variant === 'browser') || Boolean(s.browser);
    const size = Number.isFinite(paths.toolchainsBytes) ? M.formatBytes(paths.toolchainsBytes) + (paths.toolchains ? ' in ' + paths.toolchains : '') : null;
    // A filter once the list is long enough to need one; it matches the name,
    // the commands a tool provides and its description.
    const filterable = added.length > 6;
    const q = filterable ? state.toolFilter.trim().toLowerCase() : '';
    const shown = q ? added.filter((r) => [r.name, r.id, ...(r.bins || []), r.description || ''].join(' ').toLowerCase().includes(q)) : added;
    const addButton = html`<button class="tc-btn tc-btn--xs" type="button" data-cmd="package.add" data-key="tool-add">${icon('plus')}Add a tool<span class="tc-kbd tc-desk-only" aria-hidden="true">N</span></button>`;
    const filter = filterable ? html`<div class="tc-inputwrap tc-tool-filter">${icon('search')}<input class="tc-input tc-input--sm" id="tool-filter" type="search" placeholder="Filter" aria-label="Filter added tools" autocomplete="off" spellcheck="false"></div>` : '';
    return html`
      ${pageNotices('toolchains')}
      ${section('tc-title', 'Toolchains', html`<div class="tc-group">
        ${rows.length ? html`<div class="tc-list">${rows.map((row) => resourceRow(row))}</div>`
          : html`<div class="tc-empty tc-empty--compact"><span class="tc-empty-desc">Toolchain state is not readable right now.</span></div>`}
        <div class="tc-card-foot">${icon('info', 'tc-icon--sm')}<span>Available in every directory. A project that pins a version in <code>mise.toml</code> or <code>.tool-versions</code> gets that one instead.</span></div>
      </div>`, { actions: size ? muted(size) : null })}
      ${section('pk-title', 'Added tools', html`<div class="tc-group">
        ${shown.length ? html`<div class="tc-list">${shown.map((row) => resourceRow(row))}</div>`
          : added.length ? html`<div class="tc-empty tc-empty--compact"><span class="tc-empty-desc">No added tool matches “${state.toolFilter.trim()}”.</span></div>`
            : toolsEmpty()}
        <div class="tc-card-foot">${icon('terminal', 'tc-icon--sm')}<span>Anything in mise’s registry, or a backend spec like <code>npm:prettier</code>. Tools added with <code>mise use -g</code> in a terminal show up here too.</span></div>
      </div>`, { actions: html`${filter}${addButton}` })}
      ${section('img-title', 'In the image', html`<div class="tc-group"><div class="tc-included">${INCLUDED.filter((i) => !i[3] || browserImage).map(([ic, what, note]) => html`<div>${icon(ic)}<span>${what}</span><span class="tc-included-what">${note}</span></div>`)}</div></div>`,
        { actions: muted('Updated by pulling a new image') })}
      ${notice(null, 'shield-check', 'Nothing updates on its own', html`mise records exact versions, for added tools too, and never falls back to another tool on <code>PATH</code>. Update is always a button press, here or with <code>mise use</code>.`)}`;
  };

  // A first look at what can be added: one press opens the sheet on that tool.
  const QUICK_ADD = ['kubectl', 'terraform', 'aws-cli', 'java', 'zig', 'just'];
  const toolsEmpty = () => html`<div class="tc-empty">
    <span class="tc-empty-icon">${icon('plus')}</span>
    <span class="tc-empty-title">Add any tool mise can install</span>
    <span class="tc-empty-desc">Cloud CLIs, other languages, linters: about a thousand tools, each pinned to an exact version like the toolchains above.</span>
    <div class="tc-chips" role="group" aria-label="Suggestions">${QUICK_ADD.map((name) => html`<button class="tc-chip-btn" type="button" data-cmd="package.add" data-id="${name}">${name}</button>`)}</div>
    <button class="tc-btn tc-btn--primary tc-btn--sm tc-empty-cta" type="button" data-cmd="package.add">${icon('plus')}Add a tool</button>
  </div>`;

  // ---------------------------------------------------------------- ports --
  const portRow = (p) => {
    const tileEl = html`<span class="tc-tile tc-tile--port"${p.state === 'open' || p.state === 'starting' ? raw(' data-live') : ''} aria-hidden="true">${p.port}</span>`;
    const proc = p.process ? html`<code>${p.process}</code>` : null;
    const where = p.address && p.address !== '0.0.0.0' && p.address !== '*' && p.address !== '::' ? html`<span class="tc-mono">${p.address}</span>` : null;
    const joinParts = (parts) => parts.filter(Boolean).map((x, i) => i ? html` · ${x}` : x);
    let title = html`<span class="tc-row-name">Port ${p.port}</span>`;
    let status;
    let actions;
    let panel = '';
    if (p.state === 'open') {
      title = html`${title}<span class="tc-badge tc-badge--info">Published</span>`;
      status = html`<span class="tc-status"><a class="tc-mono tc-truncate" href="${p.url}" target="_blank" rel="noopener">${p.url}</a></span>`;
      actions = html`
        <span class="tc-desk-only tc-row-actions-inline">${copyButton(p.url, 'Copy URL for port ' + p.port, { iconOnly: true, ghost: false, size: 'tc-btn--sm' })}<button class="${cx('tc-btn tc-btn--icon tc-btn--sm', p.expanded && 'tc-btn--pressed')}" type="button" data-cmd="port.qr" data-id="${p.port}" aria-label="Show QR code for port ${p.port}" aria-expanded="${String(p.expanded)}" data-key="qr-${p.port}">${icon('qr-code')}</button></span>
        <button class="tc-btn tc-btn--danger tc-btn--sm" type="button" data-cmd="port.stop" data-id="${p.port}" data-key="stop-${p.port}">Stop</button>`;
      // On a phone the QR and the URL are the row; on a desktop, one press away.
      panel = html`<div class="${cx('tc-row-panel tc-port-panel', !p.expanded && 'tc-phone-only')}">
        ${p.qr ? html`<div class="tc-qr" role="img" aria-label="QR code for port ${p.port}" data-keep>${qrSvg(p.qr)}</div>` : ''}
        <div class="tc-stack tc-port-panel-text"><span class="tc-hint tc-desk-only">Scan to open port ${p.port} on another device.</span>${copyField(p.url.replace(/^https:\/\//, ''), { actions: copyButton(p.url, 'Copy URL for port ' + p.port, { iconOnly: true, size: 'tc-btn--sm' }) })}</div>
      </div>`;
    } else if (p.state === 'starting') {
      title = html`${title}<span class="tc-badge tc-badge--info"><span class="tc-spinner" aria-hidden="true"></span>Publishing</span>`;
      status = html`<span class="tc-status"><span class="tc-status-text">${joinParts([proc, 'waiting for a public hostname…'])}</span></span>${progressBar(null)}`;
      actions = html`<button class="tc-btn tc-btn--ghost tc-btn--sm" type="button" data-cmd="port.stop" data-id="${p.port}" data-key="stop-${p.port}">Cancel</button>`;
    } else if (p.state === 'failed') {
      title = html`${title}<span class="tc-badge tc-badge--danger">Failed</span>`;
      status = statusLine({ dot: 'danger', text: p.error || 'The tunnel failed' });
      actions = html`<button class="tc-btn tc-btn--warning tc-btn--sm" type="button" data-cmd="port.publish" data-id="${p.port}" data-key="pub-${p.port}">${icon('refresh-cw')}Retry</button>`;
    } else {
      status = p.db
        ? html`<span class="tc-status">${dot('warn')}<span class="tc-status-text">${joinParts([proc, 'looks like a database, so Publish asks first'])}</span></span>`
        : html`<span class="tc-status"><span class="tc-status-text">${proc || where ? joinParts([proc, where]) : p.listening ? 'Listening in the container' : 'Not listening right now'}</span></span>`;
      actions = html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="port.publish" data-id="${p.port}" data-key="pub-${p.port}">${p.db ? 'Publish…' : 'Publish'}</button>`;
    }
    return html`
      <div class="${cx('tc-row', p.expanded && 'tc-row--expanded')}" data-key="port-${p.port}">
        ${tileEl}
        <div class="tc-row-main"><div class="tc-row-title">${title}</div>${status}</div>
        <div class="tc-row-actions">${actions}</div>
        ${panel}
      </div>`;
  };

  const portsPage = (s, n) => {
    const ports = state.ports;
    if (!ports) return html`${pageNotices('ports')}${skeletonGroup(3)}`;
    if (ports.available === false) {
      return html`${pageNotices('ports')}${section('pl-title', 'Listening in the container', html`<div class="tc-group"><div class="tc-empty tc-empty--compact"><span class="tc-empty-title">Publishing is unavailable in this build</span><span class="tc-empty-desc">cloudflared is not in this image, so ports cannot get a public URL from here.</span></div></div>`)}`;
    }
    const rows = M.portRows(ports, ui, n);
    return html`
      ${pageNotices('ports')}
      ${section('pl-title', 'Listening in the container', html`<div class="tc-group">
        ${rows.length ? html`<div class="tc-list">${rows.map(portRow)}</div>`
          : html`<div class="tc-empty tc-empty--compact"><span class="tc-empty-icon">${icon('ethernet-port')}</span><span class="tc-empty-title">Nothing is listening yet</span><span class="tc-empty-desc">Start a dev server in a T3 Code terminal and it appears here within a few seconds.</span></div>`}
        <div class="tc-card-foot">${icon('terminal', 'tc-icon--sm')}<span>From a terminal: <code>t3-expose 5173</code> publishes, <code>t3-expose stop 3000</code> stops.</span></div>
      </div>`, { actions: muted('Checks every few seconds') })}
      ${section('pl-how', 'How publishing works', html`<div class="tc-group"><dl class="tc-kv">
        <dt>Tunnel</dt><dd class="tc-kv-prose">A Cloudflare quick tunnel. No account, no DNS record, no certificate.</dd>
        <dt>Address</dt><dd class="tc-kv-prose">A random <code>trycloudflare.com</code> hostname with HTTPS, new each time you publish.</dd>
        <dt>Bound to 127.0.0.1</dt><dd class="tc-kv-prose">Included. Most dev servers listen on loopback, and those are the ones that need this most.</dd>
      </dl></div>`)}
      ${notice('warn', 'triangle-alert', 'A published URL is public', 'It is random and stops working the moment you stop it, but anyone holding it can reach that port. Publish a dev server, not your database.')}`;
  };

  const publishPort = async (port) => {
    const row = M.portRows(state.ports, ui, now()).find((p) => p.port === port);
    if (row && row.db) {
      const ok = await Kit.confirm({
        title: 'Publish port ' + port + '?',
        body: (row.process ? row.process : 'Port ' + port) + ' looks like a database. Publishing gives it a public URL that anyone holding it can reach.',
        consequences: [
          { icon: 'globe', text: 'Public: a random trycloudflare.com address' },
          { icon: 'triangle-alert', text: 'Nothing in front of it checks who is connecting' },
          { icon: 'circle-stop', text: 'Stops when you press Stop or the container restarts' },
        ],
        confirm: 'Publish anyway',
      });
      if (!ok) return;
    }
    portsBusy.add(port);
    render();
    const res = await api('/ports/expose', { body: { port } });
    portsBusy.delete(port);
    if (!res.ok) Kit.toast('Could not publish port ' + port, { tone: 'danger', detail: res.error });
    await loadPorts();
  };

  const stopPort = async (port) => {
    expandedPorts.delete(port);
    const res = await api('/ports/unexpose', { body: { port } });
    if (!res.ok && res.status !== 404) Kit.toast('Could not stop port ' + port, { tone: 'danger', detail: res.error });
    else Kit.toast('Stopped publishing port ' + port, { tone: 'info' });
    await loadPorts();
  };

  // ---------------------------------------------------------- environment --
  const kindBadge = (kind) => kind === 'durable' ? html`<span class="tc-badge tc-badge--ok">Durable</span>`
    : kind === 'anonymous' ? html`<span class="tc-badge tc-badge--warn">Anonymous</span>`
      : kind === 'none' ? html`<span class="tc-badge tc-badge--warn">Not mounted</span>` : '';
  const kindText = (kind) => kind === 'durable' ? 'Durable volume' : kind === 'anonymous' ? 'Anonymous volume, lost when the container is removed'
    : kind === 'none' ? 'Inside the container, lost when it is removed' : null;

  const environmentPage = (s, n) => {
    const server = s.server || {};
    const image = s.image || {};
    const paths = s.paths || {};
    const readout = (label, value, mono) => html`<div class="tc-readout"><span class="tc-readout-label">${label}</span><span class="${cx('tc-readout-value', mono && 'tc-mono tc-mono--body')}">${value}</span></div>`;
    const t3 = s.t3 || {};
    const consolePath = BASE || '/';
    const keySource = s.setupKeySource;
    const legacy = s.legacyEnv || [];
    const legacyVars = legacy.filter((name) => name !== 'PATH');
    return html`
      ${pageNotices('environment')}
      ${legacy.length ? notice('warn', 'triangle-alert', 'Settings left over from an older image',
        html`This container’s environment still has ${legacyVars.map((name, i) => html`${i ? (i === legacyVars.length - 1 ? ' and ' : ', ') : ''}<code>${name}</code>`)}${legacy.includes('PATH') ? html`${legacyVars.length ? ' and ' : ''}the old <code>PATH</code>` : ''}, from an image that shipped its own Go, Rust, Bun and Deno. Everything this image starts ignores them. Remove them from the container’s settings so <code>docker exec</code> stops seeing them too; the image sets its own <code>PATH</code>.`) : ''}
      ${section('ev-server', 'Server', html`<div class="tc-group"><div class="tc-readouts">
        ${readout('T3 Code', server.ok ? html`${dot('ok')}Running ${server.version || ''}` : html`${dot('danger')}Not answering`)}
        ${readout('Image', html`<span class="tc-truncate" title="${M.imageLabel(image).full || ''}">${M.imageLabel(image).text || 'unversioned'}</span>`, true)}
        ${s.platform ? readout('Platform', s.platform, true) : ''}
        ${Number.isFinite(server.uptimeSeconds) ? readout('Uptime', M.duration(server.uptimeSeconds)) : ''}
      </div></div>`)}
      ${section('ev-access', 'Access', html`<div class="tc-group"><dl class="tc-kv">
        <dt>Public URL</dt><dd>${s.publicUrl ? html`<span class="tc-mono tc-mono--body tc-truncate">${s.publicUrl}</span><span class="tc-spacer"></span>${copyButton(s.publicUrl, 'Copy public URL', { iconOnly: true })}`
          : html`${dot('warn')}<span>Not set. Pairing links need <code>T3_PUBLIC_URL</code>.</span>`}</dd>
        ${t3.bind ? html`<dt>T3 Code</dt><dd><span class="tc-mono tc-mono--body">${t3.bind}</span><span class="tc-kv-aside">${/^(127\.|localhost|\[?::1)/.test(t3.bind) ? 'loopback, behind your proxy' : 'every interface in the container'}</span></dd>` : ''}
        <dt>Setup console</dt><dd><span class="tc-mono tc-mono--body">${consolePath}</span><span class="tc-kv-aside">${BASE ? 'on the same hostname · ' : ''}port ${s.setupPort || 3774}</span></dd>
        <dt>Pairing links last</dt><dd><span class="tc-mono tc-mono--body">${paths.pairTtl || '30d'}</span><span class="tc-kv-aside">T3_PAIR_TTL · a paired session lasts 30 days</span></dd>
      </dl></div>`)}
      ${section('ev-storage', 'Storage', html`<div class="tc-group"><div class="tc-list">
        <div class="tc-row tc-row--compact"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('server')}</span><div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">State</span><code>${paths.volume || '—'}</code></div><span class="tc-status">${[kindText(paths.volumeKind), 'threads, credentials, agents and toolchains', Number.isFinite(paths.volumeBytes) ? M.formatBytes(paths.volumeBytes) : null].filter(Boolean).join(' · ')}</span></div>${kindBadge(paths.volumeKind)}</div>
        <div class="tc-row tc-row--compact"><span class="tc-tile tc-tile--icon" aria-hidden="true">${icon('terminal')}</span><div class="tc-row-main"><div class="tc-row-title"><span class="tc-row-name">Workspace</span><code>${paths.workspace || '—'}</code></div><span class="tc-status">${[kindText(paths.workspaceKind) || 'Your projects', Number.isFinite(paths.workspaceProjects) ? M.plural(paths.workspaceProjects, 'project') + ' registered on start' : null].filter(Boolean).join(' · ')}</span></div>${kindBadge(paths.workspaceKind)}</div>
      </div></div>`)}
      ${s.browser ? section('ev-browser', 'Agent browser', html`<div class="tc-group"><dl class="tc-kv">
        <dt>Headless Chromium</dt><dd>${s.browser.chromium ? html`${dot('ok')}Ready` : html`${dot('warn')}Missing`}</dd>
        ${s.browser.playwrightMcp ? html`<dt>Playwright MCP</dt><dd><span class="tc-mono tc-mono--body">${s.browser.playwrightMcp}</span></dd>` : ''}
        ${s.browser.devtoolsMcp ? html`<dt>Chrome DevTools MCP</dt><dd><span class="tc-mono tc-mono--body">${s.browser.devtoolsMcp}</span></dd>` : ''}
      </dl></div>`, { actions: muted('Wired into Claude Code, Codex and OpenCode') }) : ''}
      ${section('ev-console', 'This console', html`<div class="tc-group"><div class="tc-list">
        ${keySource ? html`<div class="tc-row tc-row--compact tc-row--plain"><div class="tc-row-main"><span class="tc-row-name">Setup key</span><span class="tc-status tc-status--prose">${keySource === 'generated'
          ? html`Generated at boot, so it changes when the container is recreated. Set <code>T3_SETUP_KEY</code> to keep it.`
          : html`Pinned with <code>T3_SETUP_KEY</code>, so it survives a recreate.`}</span></div>${keySource === 'generated' ? html`<span class="tc-badge tc-badge--warn">Not pinned</span>` : html`<span class="tc-badge tc-badge--ok">Pinned</span>`}</div>` : ''}
        <div class="tc-row tc-row--compact tc-row--plain"><div class="tc-row-main"><span class="tc-row-name">Lock console</span><span class="tc-status">Ends this browser’s session. You will need the setup key to come back.</span></div><button class="tc-btn tc-btn--sm" type="button" data-cmd="lock">${icon('lock')}Lock</button></div>
        <div class="tc-row tc-row--compact tc-row--plain"><div class="tc-row-main"><span class="tc-row-name">Turn the console off</span><span class="tc-status tc-status--prose">Set <code>T3_SETUP_ENABLED=0</code> once you are set up. Pairing then needs <code>t3-pair</code> in a shell.</span></div>${copyButton('T3_SETUP_ENABLED=0', 'Copy T3_SETUP_ENABLED=0', { iconOnly: true, size: 'tc-btn--sm' })}</div>
      </div></div>`)}`;
  };

  // ----------------------------------------------------------------- more --
  const THEMES = [['light', 'Light'], ['system', 'System'], ['dark', 'Dark']];
  const themeSeg = (cls) => html`<div class="${cx('tc-seg', cls)}" role="group" aria-label="Theme">${THEMES.map(([mode, label]) => html`<button type="button" aria-pressed="${String(themeMode() === mode)}" data-cmd="theme" data-mode="${mode}">${label}</button>`)}</div>`;
  const morePage = (s) => {
    const tools = (s.toolchains || []).filter((t) => t.installed).length;
    const image = s.image || {};
    const server = s.server || {};
    const failedTools = M.toolchainRows(s, ui, now()).filter((t) => t.state === 'failed' || t.state === 'running').length;
    return html`
      ${section('pm-title', 'More', html`<div class="tc-group">
        <a class="tc-linkrow" href="#toolchains">${icon('wrench')}Toolchains<span class="tc-linkrow-aside">${failedTools ? M.plural(failedTools, 'needs', 'need') + ' you' : tools + ' installed'}</span>${icon('chevron-right')}</a>
        <a class="tc-linkrow" href="#environment">${icon('settings-2')}Environment<span class="tc-linkrow-aside tc-truncate">${M.imageLabel(image).version || ''}</span>${icon('chevron-right')}</a>
      </div>`, { level: 'h1' })}
      ${section('pm-app', 'Appearance', html`<div class="tc-group"><div class="tc-linkrow">Theme${themeSeg()}</div></div>`)}
      ${section('pm-srv', 'This server', html`<div class="tc-group">
        <div class="tc-readouts tc-readouts--two">
          <div class="tc-readout"><span class="tc-readout-label">T3 Code</span><span class="tc-readout-value">${dot(server.ok ? 'ok' : 'danger')}${server.ok ? server.version || 'Running' : 'Down'}</span></div>
          <div class="tc-readout"><span class="tc-readout-label">Image</span><span class="tc-readout-value tc-mono tc-mono--body"><span class="tc-truncate" title="${M.imageLabel(image).full || ''}">${M.imageLabel(image).text || '—'}</span></span></div>
        </div>
        <a class="tc-linkrow tc-linkrow--top" href="${t3Url()}" target="_blank" rel="noopener">${icon('external-link')}Open T3 Code${icon('chevron-right')}</a>
        <button class="tc-linkrow tc-linkrow--danger" type="button" data-cmd="lock">${icon('lock')}Lock console</button>
      </div>`)}`;
  };

  // ---------------------------------------------------------------- shell --
  const ROUTES = ['overview', 'devices', 'agents', 'toolchains', 'ports', 'environment', 'more'];
  const TITLES = { overview: 'Overview', devices: 'Devices', agents: 'Agents', toolchains: 'Toolchains', ports: 'Ports', environment: 'Environment', more: 'More' };
  const PAGES = { overview: overviewPage, devices: devicesPage, agents: agentsPage, toolchains: toolchainsPage, ports: portsPage, environment: environmentPage, more: morePage };
  // On a phone, Toolchains and Environment live under More.
  const TAB_OF = { toolchains: 'more', environment: 'more' };

  const navBadge = (b) => {
    if (!b) return { cls: 'tc-nav-count', text: '', hidden: true };
    if (b.tone) return { cls: 'tc-badge tc-badge--' + b.tone + ' tc-badge--count', text: String(b.count), hidden: !b.count };
    return { cls: 'tc-nav-count', text: String(b.count ?? ''), hidden: b.count === undefined };
  };

  const renderShell = (s, n) => {
    const badges = M.navBadges(s, state.ports, ui);
    for (const route of ROUTES) {
      const el = $('nav-' + route);
      if (el) {
        const b = navBadge(badges[route]);
        if (el.className !== b.cls) el.className = b.cls;
        if (el.textContent !== b.text) el.textContent = b.text;
        el.hidden = b.hidden;
        const tone = badges[route] && badges[route].tone;
        el.title = tone === 'warn' ? b.text + ' need you' : tone === 'info' ? b.text + ' active' : '';
      }
      const tab = $('tab-' + route);
      if (tab) tab.hidden = !(badges[route] && badges[route].tone === 'warn' && badges[route].count);
    }
    const server = s.server || {};
    const image = s.image || {};
    patch($('server-card'), html`
      <div class="tc-server-row">${dot(server.ok ? 'ok' : 'danger', server.ok && 'tc-dot--live')}<strong>${server.ok ? 'Running' : 'Not answering'}</strong>${server.version ? html`<span class="tc-mono">${server.version}</span>` : ''}</div>
      <div class="tc-server-row"><span class="tc-mono tc-truncate" title="${M.imageLabel(image).full || ''}">${M.imageLabel(image).text || 'unversioned build'}</span></div>`);
    patch($('phone-status'), html`${dot(server.ok ? 'ok' : 'danger', server.ok && 'tc-dot--live')}${server.ok ? 'Running' : 'Down'}`);
    for (const link of document.querySelectorAll('[data-open-t3]')) if (link.getAttribute('href') !== t3Url()) link.setAttribute('href', t3Url());

    // The banner: what the first start is still installing.
    const banner = M.setupBanner(s);
    const bannerEl = $('banner');
    bannerEl.hidden = !banner;
    if (banner) {
      patch(bannerEl, html`<span class="tc-spinner tc-info" aria-hidden="true"></span><span class="tc-banner-text"><strong>First start</strong> · ${banner.text}</span><span class="tc-spacer"></span>${progressBar({ pct: banner.pct })}<span class="tc-op-pct">${banner.done}/${banner.total}</span>`);
    }
  };

  const renderTopbar = (s, n) => {
    const route = state.route;
    const summary = s ? M.summaries(s, state.ports, ui, n, location.host)[route] : null;
    const crumb = $('crumb');
    if (crumb.textContent !== TITLES[route]) crumb.textContent = TITLES[route];
    const sum = $('summary');
    if (summary) {
      if (sum.textContent !== summary.text) sum.textContent = summary.text;
      sum.classList.toggle('tc-mono', Boolean(summary.mono));
    } else if (sum.textContent) sum.textContent = '';
    let actions = '';
    if (s) {
      if (route === 'overview') {
        actions = M.readiness(s, ui).ready
          ? html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="pair.start">${icon('plus')}Pair a device</button>`
          : html`<a class="tc-btn tc-btn--sm" href="${t3Url()}" target="_blank" rel="noopener">${icon('external-link')}Open T3 Code</a>`;
      } else if (route === 'agents' || route === 'toolchains') {
        const rows = route === 'agents' ? M.agentRows(s, ui, n) : [...M.toolchainRows(s, ui, n), ...M.packageRows(s, ui, n)];
        if (rows.some((r) => r.updateAvailable)) actions = html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="${route === 'agents' ? 'harness.updateAll' : 'tools.updateAll'}">${icon('circle-arrow-up')}Update all</button>`;
      } else if (route === 'ports') {
        actions = html`<span class="tc-small tc-muted">Same list as <code>t3-expose</code></span>`;
      } else if (route === 'environment') {
        actions = html`<button class="tc-btn tc-btn--sm" type="button" data-cmd="diagnostics">${icon('copy')}<span data-label>Copy diagnostics</span></button>`;
      }
    }
    patch($('page-actions'), actions);
  };

  const render = () => {
    const s = state.status;
    const n = now();
    if (s) renderShell(s, n);
    renderTopbar(s, n);
    const route = state.route;
    const el = $('page-' + route);
    if (!el) return;
    if (!s) {
      // Still waiting for the first answer: keep the skeleton, unless the
      // answer was an error worth showing.
      if (state.statusError) patch(el, html`${pageNotices(route)}${skeletonGroup(3)}`);
      return;
    }
    patch(el, PAGES[route](s, n));
  };

  // --------------------------------------------------------------- routes --
  const routeFromHash = () => {
    const name = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
    return ROUTES.includes(name) ? name : 'overview';
  };
  const go = (route) => {
    if (location.hash === '#' + route) show(route, true);
    else location.hash = route;
  };
  let first = true;
  const show = (route, focus) => {
    const changed = route !== state.route || first;
    state.route = route;
    Kit.closeAll('route');
    for (const page of document.querySelectorAll('.tc-page[data-route]')) page.hidden = page.getAttribute('data-route') !== route;
    for (const link of document.querySelectorAll('[data-nav]')) {
      const here = link.getAttribute('data-nav') === route
        || (link.closest('.tc-tabbar') && link.getAttribute('data-nav') === TAB_OF[route]);
      if (here) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    render();
    if (changed && !first) {
      window.scrollTo(0, 0);
      Kit.announce(TITLES[route]);
      if (focus) $('main').focus({ preventScroll: true });
    }
    first = false;
    if (route === 'ports' && !state.ports) loadPorts();
  };
  window.addEventListener('hashchange', () => show(routeFromHash(), keyboardNav));
  let keyboardNav = false;

  // ---------------------------------------------------------------- theme --
  const THEME_KEY = 't3-console-theme';
  const themeMode = () => {
    try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
  };
  const SYSTEM_DARK = window.matchMedia('(prefers-color-scheme: dark)');
  const applyTheme = (mode) => {
    const resolved = mode === 'system' ? (SYSTEM_DARK.matches ? 'dark' : 'light') : mode;
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('data-theme-mode', mode);
    const toggle = $('theme-toggle');
    if (toggle) {
      const next = { system: 'light', light: 'dark', dark: 'system' }[mode];
      toggle.innerHTML = String(icon(mode === 'system' ? 'monitor' : mode === 'dark' ? 'moon' : 'sun'));
      toggle.setAttribute('aria-label', 'Theme: ' + (mode === 'system' ? 'following the system' : mode) + '. Switch to ' + (next === 'system' ? 'the system theme' : next));
      toggle.title = toggle.getAttribute('aria-label');
    }
  };
  const setTheme = (mode) => {
    try { localStorage.setItem(THEME_KEY, mode); } catch { /* this session only */ }
    applyTheme(mode);
    render();
  };
  SYSTEM_DARK.addEventListener('change', () => { if (themeMode() === 'system') applyTheme('system'); });

  // -------------------------------------------------------------- sign-in --
  // A sheet that follows each CLI's real flow as numbered steps. The server
  // runs the CLI; this page shows what it printed and polls until the
  // manager's probe says the agent is signed in.
  const signin = { layer: null, agent: null, session: null, phase: 'idle', error: null, cancelled: false, startedAt: 0, poll: null, tick: null };

  const signinSheet = () => {
    const meta = M.AGENTS[signin.agent] || {};
    const st = signin.session || {};
    const host = M.hostOf(st.url);
    const qr = st.qr ? html`<div class="tc-qr tc-qr--sm tc-desk-only" role="img" aria-label="QR code for the sign-in page" data-keep>${qrSvg(st.qr)}</div>` : '';
    const waiting = (text, extra) => html`<div class="tc-op tc-op--quiet"><span class="tc-op-line">${raw('<span class="tc-spinner tc-info" aria-hidden="true"></span>')}<span>${text}</span></span><span class="tc-op-pct">${extra || ''}</span></div>`;
    const step = (n, title, stateName, body) => html`<div class="tc-sheet-step"${stateName ? raw(' data-state="' + stateName + '"') : ''}><span class="tc-step-mark">${stateName === 'done' ? icon('check') : String(n)}</span><div class="tc-sheet-step-body"><span class="${cx('tc-sheet-step-title', !stateName && 'tc-muted')}">${title}</span>${body || ''}</div></div>`;
    const openPage = (label) => html`<div class="tc-signin-open"><a class="tc-btn" href="${st.url}" target="_blank" rel="noopener">${icon('external-link')}${label}</a>${copyButton(st.url, 'Copy the sign-in link', { iconOnly: true, size: '' })}</div>`;
    let body;
    if (signin.phase === 'failed') {
      body = html`${notice('danger', 'circle-alert', 'Sign-in did not finish', signin.error || 'The CLI stopped before it reported a session.')}
        ${st.tail ? html`<pre class="tc-log-tail">${st.tail}</pre>` : ''}`;
    } else if (!st.url) {
      body = step(1, 'Starting ' + (meta.name || 'the CLI'), 'active', waiting('Waiting for ' + (meta.name || 'it') + ' to print a sign-in link…'));
    } else if (meta.flow === 'device') {
      const left = st.expiresAt ? M.countdown(st.expiresAt - now()) : null;
      body = html`
        ${step(1, 'Open the device page', 'done', html`<div class="tc-signin-split"><div class="tc-stack tc-signin-fields">${copyField(st.url, { actions: copyButton(st.url, 'Copy device page link', { iconOnly: true }) })}<a class="tc-btn tc-btn--sm tc-self-start" href="${st.url}" target="_blank" rel="noopener">${icon('external-link')}Open device page</a>${st.qr ? html`<span class="tc-hint tc-desk-only">Or scan to approve on your phone.</span>` : ''}</div>${qr}</div>`)}
        ${step(2, 'Enter this code there', 'active', st.code
          ? html`${copyField(st.code, { code: true })}${waiting('Waiting for you to approve…', left ? 'expires in ' + left : '')}`
          : waiting('Waiting for the code…'))}
        ${step(3, 'Signed in', '', html`<span class="tc-hint">This sheet closes on its own when ${meta.name} reports a session.</span>`)}`;
    } else if (meta.flow === 'code') {
      const submitted = st.state === 'submitted' || signin.phase === 'submitting';
      body = html`
        ${step(1, 'Approve on ' + (host.replace(/^www\./, '') || 'the sign-in page'), 'done', html`<div class="tc-signin-split"><div class="tc-stack tc-signin-fields">${openPage('Open sign-in page')}<span class="tc-hint">Opens in a new tab. Come back here for the code.</span></div>${qr}</div>`)}
        ${step(2, 'Paste the code it shows you', submitted ? 'done' : 'active', html`
          <form class="tc-signin-code" data-sheet-form="code" novalidate>
            <label class="tc-sr" for="signin-code">Code from the sign-in page</label>
            <input id="signin-code" name="code" class="tc-input tc-input--mono" placeholder="Paste the code" autocomplete="one-time-code" autocapitalize="off" spellcheck="false"${submitted ? raw(' disabled') : ''}>
            <button class="tc-btn tc-btn--primary" type="submit"${submitted ? raw(' disabled') : ''}>${submitted ? html`<span class="tc-spinner" aria-hidden="true"></span>Checking` : 'Submit'}</button>
          </form>`)}
        ${submitted ? step(3, 'Signed in', 'active', waiting('Waiting for ' + meta.name + ' to accept the code…')) : step(3, 'Signed in', '', '')}`;
    } else {
      body = html`
        ${step(1, 'Open the sign-in page', 'done', html`<div class="tc-signin-split"><div class="tc-stack tc-signin-fields">${openPage('Open sign-in page')}<span class="tc-hint">Sign in there with the account ${meta.name} should use.</span></div>${qr}</div>`)}
        ${step(2, 'Approve, then come back', 'active', waiting('Waiting for ' + meta.name + ' to report a session…'))}`;
    }
    return html`
      <div class="tc-sheet-head"><span class="tc-tile tc-tile--lg" style="--_tile: var(${meta.hue})" aria-hidden="true">${meta.mono}</span><div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="signin-title">Sign in to ${meta.name}</h2>${meta.command ? html`<span class="tc-small tc-muted">Runs <code>${meta.command}</code> for you</span>` : ''}</div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-sheet="cancel" aria-label="Close and cancel sign-in">${icon('x')}</button></div>
      <div class="tc-sheet-body" aria-live="polite">${body}</div>
      <div class="tc-sheet-foot">${signin.phase === 'failed'
        ? html`<button class="tc-btn tc-btn--ghost" type="button" data-sheet="close">Close</button><button class="tc-btn tc-btn--primary" type="button" data-sheet="retry">${icon('refresh-cw')}Try again</button>`
        : html`<span class="tc-sheet-foot-note tc-desk-only"><span class="tc-kbd">Esc</span> cancels</span><button class="tc-btn tc-btn--ghost" type="button" data-sheet="cancel">Cancel sign-in</button>`}</div>`;
  };

  const endSignin = () => {
    clearTimeout(signin.poll);
    clearInterval(signin.tick);
    signin.poll = null;
    signin.tick = null;
    ui.signingIn = null;
    render();
  };

  const cancelSignin = () => {
    signin.cancelled = true;
    const id = signin.session && signin.session.id;
    if (id && signin.phase !== 'failed') api('/auth/cancel', { body: { id } });
    if (signin.layer) signin.layer.close('cancel');
  };

  const pollSignin = async () => {
    if (!signin.layer || signin.cancelled || !signin.session) return;
    const attempt = signin.attempt;
    const res = await api('/auth/session?id=' + encodeURIComponent(signin.session.id));
    if (!signin.layer || signin.cancelled || signin.attempt !== attempt) return;
    if (!res.ok) {
      signin.phase = 'failed';
      signin.error = res.status === 404 ? 'The setup service no longer knows this sign-in (it may have restarted).' : res.error;
      signin.layer.render();
      return;
    }
    const st = res.data;
    signin.session = Object.assign({}, signin.session, st, { expiresAt: st.expiresAt || signin.session.expiresAt });
    if (st.state === 'done') {
      const name = (M.AGENTS[signin.agent] || {}).name || signin.agent;
      signin.layer.close('done');
      Kit.toast('Signed in to ' + name);
      loadStatus();
      return;
    }
    if (st.state === 'failed' || st.state === 'cancelled') {
      signin.phase = 'failed';
      signin.error = st.error || (st.state === 'cancelled' ? 'Sign-in was cancelled.' : null);
      signin.layer.render();
      return;
    }
    if (signin.phase === 'submitting' && st.state !== 'submitted') signin.phase = 'awaiting';
    signin.layer.render();
    signin.poll = setTimeout(pollSignin, 1500);
  };

  const beginSignin = async () => {
    // Each start is an attempt; an answer for an older one (the sheet closed,
    // or Try again was pressed, while the CLI was starting) only cleans up.
    const attempt = signin.attempt = (signin.attempt || 0) + 1;
    signin.phase = 'starting';
    signin.session = null;
    signin.error = null;
    signin.layer.render();
    const res = await api('/auth/signin', { body: { agent: signin.agent } });
    if (!signin.layer || signin.cancelled || signin.attempt !== attempt) {
      if (res.ok && res.data.id) api('/auth/cancel', { body: { id: res.data.id } });
      return;
    }
    if (!res.ok) {
      signin.phase = 'failed';
      signin.error = res.error;
      signin.layer.render();
      return;
    }
    signin.session = Object.assign({}, res.data, { expiresAt: res.data.expiresAt || now() + 15 * 60 * 1000 });
    signin.phase = 'awaiting';
    signin.layer.render();
    signin.poll = setTimeout(pollSignin, 1200);
  };

  const openSignin = (id, trigger) => {
    if (signin.layer) return;
    Object.assign(signin, { agent: id, session: null, phase: 'starting', error: null, cancelled: false, startedAt: now() });
    ui.signingIn = id;
    render();
    signin.layer = Kit.open({
      kind: 'sheet',
      panel: { tag: 'aside', class: 'tc-sheet ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'signin-title' },
      returnTo: trigger,
      backdrop: 'ignore',
      render: signinSheet,
      onEscape: cancelSignin,
      onClose: (reason) => {
        // Closed by anything but success or an explicit cancel (a route
        // change, the back button): the CLI is still waiting, so stop it.
        const id = signin.session && signin.session.id;
        if (reason !== 'done' && !signin.cancelled && signin.phase !== 'failed' && id) api('/auth/cancel', { body: { id } });
        signin.cancelled = reason !== 'done';
        signin.layer = null;
        endSignin();
      },
    });
    const panel = signin.layer.panel;
    panel.addEventListener('click', (e) => {
      const action = e.target.closest('[data-sheet]');
      if (!action) return;
      const what = action.getAttribute('data-sheet');
      if (what === 'cancel') cancelSignin();
      else if (what === 'close') signin.layer.close('close');
      else if (what === 'retry') { signin.cancelled = false; beginSignin(); }
    });
    panel.addEventListener('submit', async (e) => {
      const form = e.target.closest('[data-sheet-form="code"]');
      if (!form) return;
      e.preventDefault();
      const code = form.querySelector('input').value.trim();
      if (!code || !signin.session) { form.querySelector('input').focus(); return; }
      signin.phase = 'submitting';
      signin.layer.render();
      const res = await api('/auth/code', { body: { id: signin.session.id, code } });
      if (!res.ok) {
        signin.phase = 'failed';
        signin.error = res.error;
      } else {
        signin.session = Object.assign({}, signin.session, res.data);
      }
      if (signin.layer) signin.layer.render();
    });
    // The device code's countdown.
    signin.tick = setInterval(() => { if (signin.layer && signin.session && signin.session.code) signin.layer.render(); }, 1000);
    beginSignin();
  };

  // ------------------------------------------------------------- API keys --
  const keySheet = { layer: null, agent: null, query: '', provider: null, other: false, reveal: false, saving: false, error: null, active: 0 };
  const HUES = ['--id-claude', '--id-codex', '--id-opencode', '--id-grok', '--id-cursor'];
  const hueOf = (id) => HUES[[...String(id)].reduce((a, c) => (a + c.charCodeAt(0)) % HUES.length, 0)];
  const initials = (name) => {
    const words = String(name).replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : String(name).slice(0, 1)).toUpperCase();
  };
  const providerMatches = () => {
    const list = (state.providers && state.providers.providers) || [];
    const q = keySheet.query.trim().toLowerCase();
    if (!q) return list.slice(0, 40).map((p) => ({ p, at: -1 }));
    const scored = [];
    for (const p of list) {
      const name = p.name.toLowerCase();
      const at = name.indexOf(q);
      const idAt = p.id.indexOf(q);
      if (at === -1 && idAt === -1) continue;
      scored.push({ p, at, score: at === 0 || idAt === 0 ? 0 : at > 0 ? 1 : 2 });
    }
    scored.sort((a, b) => a.score - b.score || a.p.name.localeCompare(b.p.name));
    return scored.slice(0, 40);
  };

  const keySheetBody = () => {
    const meta = M.AGENTS[keySheet.agent] || {};
    const isOpenCode = keySheet.agent === 'opencode';
    const providers = state.providers || {};
    const configured = new Set(providers.configured || []);
    const names = new Map((providers.providers || []).map((p) => [p.id, p.name]));
    const chosen = keySheet.provider;
    const keyStep = (n, active) => html`<div class="tc-sheet-step"${active ? raw(' data-state="active"') : ''}><span class="tc-step-mark">${String(n)}</span><div class="tc-sheet-step-body"><label class="tc-sheet-step-title" for="apikey">API key</label>
      <div class="tc-inputwrap"><input id="apikey" name="key" class="tc-input tc-input--mono" type="${keySheet.reveal ? 'text' : 'password'}" placeholder="sk-…" autocomplete="off" spellcheck="false" autocapitalize="off"><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--xs" type="button" data-sheet="reveal" aria-label="${keySheet.reveal ? 'Hide' : 'Show'} API key" aria-pressed="${String(keySheet.reveal)}">${icon(keySheet.reveal ? 'eye-off' : 'eye')}</button></div>
      ${keySheet.error ? html`<p class="tc-hint tc-hint--err" role="alert">${keySheet.error}</p>` : html`<span class="tc-hint">Stored on the state volume, never in the image.</span>`}</div></div>`;
    let steps;
    if (isOpenCode) {
      const matches = providerMatches();
      const cache = providers.cache || {};
      const freshness = cache.source === 'fallback' || !cache.at
        ? 'A built-in list; the full catalog loads once models.dev is reachable'
        : ((providers.providers || []).length + ' providers from models.dev · catalog cached ' + M.relTime(cache.at, now()));
      const options = matches.map(({ p, at }, i) => {
        const label = at >= 0 && keySheet.query.trim() ? raw(Kit.esc(p.name.slice(0, at)) + '<mark>' + Kit.esc(p.name.slice(at, at + keySheet.query.trim().length)) + '</mark>' + Kit.esc(p.name.slice(at + keySheet.query.trim().length))) : p.name;
        return html`<li class="tc-option" role="option" id="prov-opt-${i}" data-provider="${p.id}" data-index="${i}" aria-selected="${String(keySheet.active === i)}"><span class="tc-tile tc-tile--sm" style="--_tile: var(${hueOf(p.id)})" aria-hidden="true">${initials(p.name)}</span><span class="tc-truncate">${label}</span><span class="tc-option-meta tc-mono">${configured.has(p.id) ? html`${icon('check', 'tc-icon--xs')} ` : ''}${p.id}</span></li>`;
      });
      options.push(html`<li class="tc-option" role="option" id="prov-opt-${matches.length}" data-provider="__other" data-index="${matches.length}" aria-selected="${String(keySheet.active === matches.length)}">${icon('plus')}<span>Other — type an id</span></li>`);
      const providerStep = keySheet.other
        ? html`<div class="tc-field"><input id="prov-other" class="tc-input tc-input--mono" placeholder="Provider id, e.g. deepseek" autocomplete="off" spellcheck="false" autocapitalize="off"><button class="tc-btn tc-btn--ghost tc-btn--xs tc-self-start" type="button" data-sheet="list">Back to the list</button></div>`
        : html`<div class="tc-combobox">
            <div class="tc-palette-input">${icon('search', 'tc-muted')}<input id="prov" role="combobox" aria-expanded="true" aria-controls="provl" aria-autocomplete="list" aria-activedescendant="prov-opt-${keySheet.active}" placeholder="Search providers" autocomplete="off" spellcheck="false" autocapitalize="off"></div>
            <ul class="tc-listbox" id="provl" role="listbox" aria-label="Providers">${options}</ul>
          </div><span class="tc-hint">${chosen ? html`Selected: <strong>${names.get(chosen) || chosen}</strong> <span class="tc-mono">${chosen}</span>` : freshness}</span>`;
      steps = html`
        <div class="tc-sheet-step" data-state="${chosen ? 'done' : 'active'}"><span class="tc-step-mark">${chosen ? icon('check') : '1'}</span><div class="tc-sheet-step-body"><label class="tc-sheet-step-title" for="${keySheet.other ? 'prov-other' : 'prov'}">Provider</label>${providerStep}</div></div>
        ${keyStep(2, Boolean(chosen))}
        ${configured.size ? html`<div class="tc-stack tc-saved-keys-wrap"><span class="tc-small tc-muted">Saved keys</span><div class="tc-group"><div class="tc-list">${[...configured].map((id) => html`
          <div class="tc-row tc-row--compact tc-row--key" data-key="saved-${id}"><span class="tc-tile tc-tile--sm" style="--_tile: var(${hueOf(id)})" aria-hidden="true">${initials(names.get(id) || id)}</span><div class="tc-row-main"><span class="tc-row-name">${names.get(id) || id}</span></div><button class="tc-btn tc-btn--ghost tc-btn--ghost-muted tc-btn--xs" type="button" data-sheet="remove" data-provider="${id}" aria-label="Remove the ${names.get(id) || id} key">Remove</button></div>`)}</div></div></div>` : ''}`;
    } else {
      steps = keyStep(1, true);
    }
    return html`
      <div class="tc-sheet-head"><span class="tc-tile tc-tile--lg" style="--_tile: var(${meta.hue})" aria-hidden="true">${meta.mono}</span><div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="key-title">${isOpenCode ? 'Add a provider key' : 'Use an API key'}</h2><span class="tc-small tc-muted">${isOpenCode ? html`Writes to OpenCode’s <code>auth.json</code> on the volume` : html`Runs <code>codex login --with-api-key</code>; the key goes in on stdin`}</span></div><span class="tc-spacer"></span><button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-sheet="close" aria-label="Close">${icon('x')}</button></div>
      <div class="tc-sheet-body">${steps}</div>
      <div class="tc-sheet-foot"><button class="tc-btn tc-btn--ghost" type="button" data-sheet="close">Cancel</button><button class="tc-btn tc-btn--primary" type="submit" data-key="key-save" disabled>${keySheet.saving ? html`<span class="tc-spinner" aria-hidden="true"></span>Saving` : 'Save key'}</button></div>`;
  };

  /** Save stays disabled until every step is filled; this reads the live fields. */
  const syncKeySave = () => {
    const panel = keySheet.layer && keySheet.layer.panel;
    if (!panel) return;
    const key = panel.querySelector('#apikey');
    const other = panel.querySelector('#prov-other');
    const provider = keySheet.agent !== 'opencode' || (keySheet.other ? other && other.value.trim() : keySheet.provider);
    const save = panel.querySelector('[data-key="key-save"]');
    if (save) save.disabled = keySheet.saving || !(key && key.value.trim() && provider);
  };

  const renderKeySheet = () => { if (keySheet.layer) { keySheet.layer.render(); syncKeySave(); } };

  const chooseProvider = (id) => {
    if (id === '__other') {
      keySheet.other = true;
      keySheet.provider = null;
      renderKeySheet();
      const other = keySheet.layer.panel.querySelector('#prov-other');
      if (other) other.focus();
      return;
    }
    keySheet.provider = id;
    const p = ((state.providers && state.providers.providers) || []).find((x) => x.id === id);
    const input = keySheet.layer.panel.querySelector('#prov');
    if (input && p) input.value = p.name;
    keySheet.query = p ? p.name : '';
    keySheet.active = 0;
    renderKeySheet();
    const key = keySheet.layer.panel.querySelector('#apikey');
    if (key) key.focus();
  };

  const openKeySheet = async (id, trigger) => {
    if (keySheet.layer) return;
    Object.assign(keySheet, { agent: id, query: '', provider: null, other: false, reveal: false, saving: false, error: null, active: 0 });
    if (id === 'opencode' && !state.providers) await loadProviders();
    keySheet.layer = Kit.open({
      kind: 'sheet',
      panel: { tag: 'form', class: 'tc-sheet ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'key-title', novalidate: true },
      returnTo: trigger,
      backdrop: 'ignore',
      render: keySheetBody,
      focus: id === 'opencode' ? '#prov' : '#apikey',
      onClose: () => { keySheet.layer = null; },
    });
    syncKeySave();
    const panel = keySheet.layer.panel;
    panel.addEventListener('input', (e) => {
      if (e.target.id === 'prov') {
        keySheet.query = e.target.value;
        keySheet.provider = null;
        keySheet.active = 0;
        renderKeySheet();
        const list = panel.querySelector('#provl');
        if (list) list.scrollTop = 0;
      } else {
        if (keySheet.error && e.target.id === 'apikey') { keySheet.error = null; renderKeySheet(); }
        syncKeySave();
      }
    });
    panel.addEventListener('keydown', (e) => {
      if (e.target.id !== 'prov') return;
      const count = panel.querySelectorAll('#provl .tc-option').length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        keySheet.active = (keySheet.active + (e.key === 'ArrowDown' ? 1 : -1) + count) % count;
        renderKeySheet();
        const opt = panel.querySelector('#prov-opt-' + keySheet.active);
        if (opt) opt.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const opt = panel.querySelector('#prov-opt-' + keySheet.active);
        if (opt) chooseProvider(opt.getAttribute('data-provider'));
      }
    });
    panel.addEventListener('click', async (e) => {
      const option = e.target.closest('.tc-option[data-provider]');
      if (option) { chooseProvider(option.getAttribute('data-provider')); return; }
      const action = e.target.closest('[data-sheet]');
      if (!action) return;
      const what = action.getAttribute('data-sheet');
      if (what === 'close') keySheet.layer.close('cancel');
      else if (what === 'reveal') { keySheet.reveal = !keySheet.reveal; renderKeySheet(); }
      else if (what === 'list') { keySheet.other = false; renderKeySheet(); }
      else if (what === 'remove') {
        const provider = action.getAttribute('data-provider');
        const label = ((state.providers.providers || []).find((p) => p.id === provider) || {}).name || provider;
        const ok = await Kit.confirm({
          title: 'Remove the ' + label + ' key?',
          body: 'OpenCode stops using ' + label + ' until you add a key for it again. Nothing else changes.',
          confirm: 'Remove key',
        });
        if (!ok) return;
        const res = await api('/auth/apikey/remove', { body: { agent: 'opencode', provider } });
        if (!res.ok) Kit.toast('Could not remove the key', { tone: 'danger', detail: res.error });
        else Kit.toast('Removed the ' + label + ' key');
        await loadProviders();
        renderKeySheet();
        loadStatus();
      }
    });
    panel.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = panel.querySelector('#apikey').value.trim();
      const other = panel.querySelector('#prov-other');
      const provider = keySheet.agent === 'opencode' ? (keySheet.other ? other && other.value.trim() : keySheet.provider) : undefined;
      if (!key || (keySheet.agent === 'opencode' && !provider)) return;
      keySheet.saving = true;
      keySheet.error = null;
      renderKeySheet();
      const res = await api('/auth/apikey', { body: { agent: keySheet.agent, key, provider } });
      keySheet.saving = false;
      if (!keySheet.layer) return;
      if (!res.ok) {
        // Leave a failed attempt on screen with the key still in it.
        keySheet.error = res.error;
        renderKeySheet();
        return;
      }
      const label = provider ? (((state.providers || {}).providers || []).find((p) => p.id === provider) || {}).name || provider : null;
      keySheet.layer.close('saved');
      Kit.toast(label ? 'Saved the ' + label + ' key' : 'API key saved');
      if (keySheet.agent === 'opencode') await loadProviders();
      loadStatus();
    });
  };

  // ------------------------------------------------------------ add a tool --
  // Finds any tool in mise's registry (or takes a backend spec such as
  // npm:prettier), says where it comes from, what it provides and how its
  // downloads are verified, and installs it pinned to an exact release: the
  // newest, or one picked from what its backend offers. The same sheet picks a
  // release for a tool already added ("Install a specific version…").
  const registryLoad = { pending: null, error: null };
  const loadRegistry = () => {
    if (ui.registry) return Promise.resolve(ui.registry);
    registryLoad.pending ??= api('/packages/registry').then((res) => {
      registryLoad.pending = null;
      if (res.ok && Array.isArray(res.data.tools)) {
        ui.registry = res.data.tools;
        registryLoad.error = null;
      } else {
        registryLoad.error = res.error || 'mise’s registry could not be read';
      }
      return ui.registry;
    });
    return registryLoad.pending;
  };

  const SECURITY = {
    checksum: 'checksums', github_attestations: 'GitHub attestations', slsa: 'SLSA provenance',
    cosign: 'Cosign signatures', minisign: 'Minisign signatures', gpg: 'GPG signatures',
  };
  const describeSecurity = (types) => (types && types.length
    ? 'Verified with ' + M.listOf(types.map((t) => SECURITY[t] || t.replace(/_/g, ' ')))
    : 'mise checks no checksum or signature for this source');

  const toolSheet = { layer: null };
  const spinnerNote = (text) => html`<div class="tc-combobox-note"><span class="tc-spinner tc-info" aria-hidden="true"></span>${text}</div>`;
  // A backend spec wraps after its colon and slashes, not mid-name.
  const pathBreaks = (text) => raw(Kit.esc(text).replace(/[:/]/g, '$&<wbr>'));
  const marked = (text, match) => match
    ? raw(Kit.esc(text.slice(0, match[0])) + '<mark>' + Kit.esc(text.slice(match[0], match[1])) + '</mark>' + Kit.esc(text.slice(match[1])))
    : text;

  /** The picker's options: registry matches, and the query itself when it is a usable backend spec. */
  const toolOptions = () => {
    const q = toolSheet.query.trim();
    const installed = new Map(((state.status && state.status.packages) || []).map((p) => [p.id, p]));
    const options = M.searchRegistry(ui.registry || [], q, 30).map(({ entry, match }) => ({
      kind: 'entry', entry, match, managed: M.managedOn(entry.name), installed: installed.get(entry.name) || null,
    }));
    const known = (ui.registry || []).some((e) => e.name === q || (e.aliases || []).includes(q));
    if (q && M.isToolSpec(q) && !known && !M.managedOn(q)) {
      // A spec reads as one ("npm:prettier"): offer it first. A bare word may
      // be a typo of a registry name: offer it after the matches.
      options[q.includes(':') ? 'unshift' : 'push']({ kind: 'spec', id: q });
    }
    return options;
  };

  const toolOption = (o, i) => {
    const selected = String(i === toolSheet.active);
    if (o.kind === 'spec') {
      return html`<li class="tc-option tc-option--rich" role="option" id="tool-opt-${i}" data-index="${i}" aria-selected="${selected}">
        <span class="tc-tile tc-tile--sm tc-tile--icon" aria-hidden="true">${icon('plus')}</span>
        <span class="tc-option-text"><span class="tc-option-name">Use <code>${o.id}</code></span><span class="tc-option-desc">As a mise tool spec, installed from its backend</span></span></li>`;
    }
    const e = o.entry;
    const bins = (e.bins || []).filter((b) => b !== e.name);
    const meta = o.managed ? html`<span class="tc-option-meta"><span>On ${o.managed}</span></span>`
      : o.installed ? html`<span class="tc-option-meta">${icon('check', 'tc-icon--xs')}<span>${o.installed.version || 'Added'}</span></span>`
        : bins.length ? html`<span class="tc-option-meta tc-mono">${bins.slice(0, 2).map((b) => html`<span>${b}</span>`)}</span>` : '';
    return html`<li class="tc-option tc-option--rich" role="option" id="tool-opt-${i}" data-index="${i}" aria-selected="${selected}"${o.managed ? raw(' aria-disabled="true"') : ''}>
      <span class="tc-tile tc-tile--sm" style="--_tile: var(--id-toolchain)" aria-hidden="true">${M.monogram(e.name)}</span>
      <span class="tc-option-text"><span class="tc-option-name">${marked(e.name, o.match)}</span>${e.description ? html`<span class="tc-option-desc">${e.description}</span>` : ''}</span>${meta}</li>`;
  };

  const toolPicker = () => {
    const options = toolOptions();
    const q = toolSheet.query.trim();
    const loading = !ui.registry && !registryLoad.error;
    return html`
      <div class="tc-combobox">
        <div class="tc-palette-input">${icon('search', 'tc-muted')}<input id="tool-q" role="combobox" aria-expanded="true" aria-controls="tool-list" aria-autocomplete="list" aria-activedescendant="${options.length ? 'tool-opt-' + toolSheet.active : ''}" placeholder="kubectl, terraform, json, npm:prettier…" autocomplete="off" spellcheck="false" autocapitalize="off"></div>
        ${loading ? spinnerNote('Loading mise’s registry…')
          : options.length ? html`<ul class="tc-listbox tc-listbox--rich" id="tool-list" role="listbox" aria-label="${q ? 'Matching tools' : 'Suggested tools'}">${options.map(toolOption)}</ul>`
            : html`<div class="tc-combobox-note">Nothing in the registry matches. A backend spec works too: <code>npm:prettier</code>, <code>cargo:ripgrep</code>, <code>github:owner/repo</code>.</div>`}
      </div>
      <span class="tc-hint">${registryLoad.error ? registryLoad.error + '. A backend spec still works.'
        : ui.registry ? (q ? '' : 'A few to start with. ') + 'Search ' + ui.registry.length.toLocaleString() + ' tools by name, command or what they do.' : ''}</span>`;
  };

  const toolDetails = (t) => {
    const info = toolSheet.info;
    const bins = (info && info.bins && info.bins.length ? info.bins : t.bins) || [];
    const rows = [
      ['Source', info ? html`<code>${pathBreaks(info.backend || t.id)}</code>` : toolSheet.infoError ? html`<span class="tc-muted">${toolSheet.infoError}</span>` : html`<span class="tc-muted"><span class="tc-spinner tc-info" aria-hidden="true"></span> Asking mise…</span>`],
    ];
    if (info) rows.push(['Downloads', describeSecurity(info.security)]);
    if (bins.length) rows.push(['Provides', html`${bins.slice(0, 6).map((b, i) => html`${i ? ' ' : ''}<code>${b}</code>`)}${bins.length > 6 ? ' and ' + (bins.length - 6) + ' more' : ''}`]);
    const installed = addedTool(t.id);
    const shadows = (info && info.shadows) || [];
    return html`
      <dl class="tc-kv tc-kv--sheet">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
      ${installed && installed.version && toolSheet.mode !== 'version' ? html`<span class="tc-hint">${t.name} ${installed.version} is already added. Installing switches it to the release below.</span>` : ''}
      ${shadows.length ? html`<span class="tc-hint">The image already has ${M.listOf(shadows.map((b) => b))}. Once added, this one comes first in terminals and for agents.</span>` : ''}`;
  };

  const versionPicker = () => {
    const list = toolSheet.versions;
    const q = toolSheet.versionQuery.trim();
    const current = addedTool(toolSheet.tool.id);
    const filtered = M.matchReleases(list, q).slice(0, 80);
    const typed = q && !(list || []).includes(q);
    return html`
      <div class="tc-combobox">
        <div class="tc-palette-input">${icon('history', 'tc-muted')}<input id="ver-q" class="tc-mono" role="combobox" aria-expanded="true" aria-controls="ver-list" aria-autocomplete="list" aria-activedescendant="${filtered.length ? 'ver-opt-' + toolSheet.versionActive : ''}" aria-label="Version" placeholder="1.8.2, or a prefix like 3.12" autocomplete="off" spellcheck="false" autocapitalize="off"></div>
        ${!list && !toolSheet.versionsError ? spinnerNote('Asking mise for releases…')
          : toolSheet.versionsError ? html`<div class="tc-combobox-note">${toolSheet.versionsError}. Type a version instead.</div>`
            : filtered.length ? html`<ul class="tc-listbox" id="ver-list" role="listbox" aria-label="Releases">${filtered.map((v, i) => html`
              <li class="tc-option tc-mono" role="option" id="ver-opt-${i}" data-version="${v}" aria-selected="${String(i === toolSheet.versionActive)}">${v}${v === list[0] ? html`<span class="tc-option-meta">newest</span>` : current && current.version === v ? html`<span class="tc-option-meta">installed</span>` : ''}</li>`)}</ul>`
              : ''}
      </div>
      <span class="${cx('tc-hint', ((q && !M.isVersionSpec(q)) || noSuchRelease(q)) && 'tc-hint--err')}">${q && !M.isVersionSpec(q) ? 'That is not a version mise can install.'
        : noSuchRelease(q) ? (list && list[0] ? 'None of its releases starts with ' + q + '. The newest is ' + list[0] + '.' : 'None of its releases starts with ' + q + '.')
        : typed && M.resolveRelease(list, q) ? 'Installs ' + M.resolveRelease(list, q) + ', the newest ' + q + ' release, recorded exactly.'
          : (list ? list.length.toLocaleString() + ' releases. ' : '') + 'Pick one, or type a prefix to take the newest under it.'}</span>`;
  };

  /** A typed release or prefix that none of the tool's listed releases starts with. */
  const noSuchRelease = (version) => Boolean(toolSheet.versions && version && !M.resolveRelease(toolSheet.versions, version));

  /** The release the sheet would install now: '' for the newest, or what was picked or typed. */
  const chosenVersion = () => (toolSheet.versionMode === 'pick' ? (toolSheet.version || toolSheet.versionQuery).trim() : '');

  const toolSheetBody = () => {
    const t = toolSheet.tool;
    const editing = toolSheet.mode === 'version';
    const mode = toolSheet.versionMode;
    const newest = toolSheet.versions && toolSheet.versions[0];
    const version = chosenVersion();
    const canInstall = Boolean(t) && !toolSheet.saving && (mode === 'latest' || (M.isVersionSpec(version) && !noSuchRelease(version)));
    // The button names the exact release: a typed prefix shows what it resolves to.
    const exact = mode === 'pick' ? M.resolveRelease(toolSheet.versions, version) || version : newest;
    const label = !t ? 'Install' : 'Install ' + t.name + (exact ? ' ' + exact : '');
    return html`
      <div class="tc-sheet-head">
        ${t ? html`<span class="tc-tile tc-tile--lg" style="--_tile: var(--id-toolchain)" aria-hidden="true">${M.monogram(t.name)}</span>`
          : html`<span class="tc-tile tc-tile--lg tc-tile--icon" aria-hidden="true">${icon('plus')}</span>`}
        <div class="tc-sheet-head-text"><h2 class="tc-sheet-title" id="tool-title">${editing && t ? 'Install a specific version of ' + t.name : 'Add a tool'}</h2>
          <span class="tc-small tc-muted">${editing ? 'Pinned to the exact release you pick' : 'From mise’s registry, pinned to an exact release'}</span></div>
        <span class="tc-spacer"></span>
        <button class="tc-btn tc-btn--ghost tc-btn--icon tc-btn--sm" type="button" data-sheet="close" aria-label="Close">${icon('x')}</button>
      </div>
      <div class="tc-sheet-body">
        ${editing ? '' : html`<div class="tc-sheet-step" data-state="${t ? 'done' : 'active'}"><span class="tc-step-mark">${t ? icon('check') : '1'}</span><div class="tc-sheet-step-body">
          ${t ? html`<span class="tc-sheet-step-title">Tool</span>
            <div class="tc-tool-picked"><div class="tc-tool-picked-text"><span class="tc-row-name">${t.name}</span>${t.description ? html`<span class="tc-small tc-muted">${t.description}</span>` : ''}</div>
              <button class="tc-btn tc-btn--ghost tc-btn--xs" type="button" data-sheet="change">Change</button></div>
            ${toolDetails(t)}`
          : html`<label class="tc-sheet-step-title" for="tool-q">Tool</label>${toolPicker()}`}
        </div></div>`}
        ${editing && t ? toolDetails(t) : ''}
        ${t ? html`<div class="tc-sheet-step" data-state="active"><span class="tc-step-mark">${editing ? '1' : '2'}</span><div class="tc-sheet-step-body">
          <span class="tc-sheet-step-title" id="ver-label">Version</span>
          ${editing ? '' : html`<div class="tc-seg tc-seg--fill" role="group" aria-labelledby="ver-label">
            <button type="button" aria-pressed="${String(mode === 'latest')}" data-sheet="ver-latest">Newest${newest ? html` <span class="tc-mono">${newest}</span>` : ''}</button>
            <button type="button" aria-pressed="${String(mode === 'pick')}" data-sheet="ver-pick">Choose a version</button></div>`}
          ${mode === 'pick' ? versionPicker()
            : html`<span class="tc-hint">${newest ? 'mise’s newest release, recorded exactly; Update moves it on later.'
              : toolSheet.versionsError ? 'mise resolves its newest release when it installs.' : 'Looking up the newest release…'}</span>`}
        </div></div>` : ''}
        ${toolSheet.error ? html`<p class="tc-hint tc-hint--err" role="alert">${toolSheet.error}</p>` : ''}
      </div>
      <div class="tc-sheet-foot">
        <button class="tc-btn tc-btn--ghost" type="button" data-sheet="close">Cancel</button>
        <button class="tc-btn tc-btn--primary" type="submit" data-key="tool-install"${canInstall ? '' : raw(' disabled')}>${toolSheet.saving ? html`<span class="tc-spinner" aria-hidden="true"></span>Starting` : html`${icon('download')}${label}`}</button>
      </div>`;
  };

  const renderToolSheet = () => { if (toolSheet.layer) toolSheet.layer.render(); };
  const focusIn = (selector) => {
    const el = toolSheet.layer && toolSheet.layer.panel.querySelector(selector);
    if (el) el.focus({ preventScroll: true });
  };

  /** Take a tool: look up where it comes from and what releases it has, in parallel. */
  const selectTool = (tool) => {
    Object.assign(toolSheet, {
      tool, info: null, infoError: null, versions: null, versionsError: null,
      versionMode: toolSheet.mode === 'version' ? 'pick' : 'latest', versionQuery: '', version: '', versionActive: 0, error: null,
    });
    renderToolSheet();
    const id = tool.id;
    api('/packages/info?id=' + encodeURIComponent(id)).then((res) => {
      if (!toolSheet.tool || toolSheet.tool.id !== id) return;
      if (res.ok) toolSheet.info = res.data;
      else toolSheet.infoError = res.error;
      renderToolSheet();
    });
    api('/packages/versions?id=' + encodeURIComponent(id)).then((res) => {
      if (!toolSheet.tool || toolSheet.tool.id !== id) return;
      if (res.ok) toolSheet.versions = res.data.versions || [];
      else toolSheet.versionsError = res.error || 'mise could not list its releases';
      renderToolSheet();
    });
    focusIn(toolSheet.mode === 'version' ? '#ver-q' : '[data-key="tool-install"]');
  };

  const toolFromEntry = (entry) => ({ id: entry.name, name: entry.name, description: entry.description || '', bins: entry.bins || [] });
  const chooseOption = (index) => {
    const option = toolOptions()[index];
    if (!option || option.managed) return;
    selectTool(option.kind === 'spec'
      ? { id: option.id, name: M.toolName(option.id), description: '', bins: [] }
      : toolFromEntry(option.entry));
  };

  const submitTool = async () => {
    const t = toolSheet.tool;
    if (!t || toolSheet.saving) return;
    const version = chosenVersion();
    if (toolSheet.versionMode === 'pick' && (!M.isVersionSpec(version) || noSuchRelease(version))) {
      toolSheet.error = 'Pick a release, or type one such as 1.8.2 or a prefix such as 3.12.';
      renderToolSheet();
      focusIn('#ver-q');
      return;
    }
    toolSheet.saving = true;
    toolSheet.error = null;
    renderToolSheet();
    const res = await callLifecycle('package', 'install', t.id, version || undefined);
    toolSheet.saving = false;
    if (res.ok || res.status === 202) {
      if (toolSheet.layer) toolSheet.layer.close('saved');
      if (state.route !== 'toolchains') go('toolchains');
      return;
    }
    // Refused before it started (a name managed elsewhere, a version mise
    // does not have): say so here, where it can be fixed.
    notices.delete('package:' + t.id);
    toolSheet.error = res.error || 'Could not install ' + t.name;
    renderToolSheet();
  };

  /**
   * Open the sheet: empty, on a tool (`id`, from a suggestion or the palette),
   * or on an added tool to pick another release (`mode: 'version'`).
   */
  const openToolSheet = ({ id, mode, trigger } = {}) => {
    if (toolSheet.layer) return;
    Object.assign(toolSheet, { mode: mode || 'add', query: '', active: 0, tool: null, saving: false, error: null, versionMode: 'latest' });
    toolSheet.layer = Kit.open({
      kind: 'sheet',
      panel: { tag: 'form', class: 'tc-sheet ' + (Kit.isPhone() ? 'tc-sheet--bottom' : 'tc-sheet--inset'), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tool-title', novalidate: true },
      returnTo: trigger,
      backdrop: 'ignore',
      render: toolSheetBody,
      focus: '#tool-q',
      onClose: () => { toolSheet.layer = null; },
    });
    const panel = toolSheet.layer.panel;
    // A tool already added needs nothing from the registry to be picked; a
    // name from a suggestion or the palette is looked up there first.
    const existing = id ? addedTool(id) : null;
    if (existing) selectTool({ id, name: existing.name, description: existing.description || '', bins: existing.bins || [] });
    loadRegistry().then(() => {
      if (!toolSheet.layer) return;
      if (id && !toolSheet.tool) {
        const entry = (ui.registry || []).find((e) => e.name === id || (e.aliases || []).includes(id));
        selectTool(entry ? toolFromEntry(entry) : { id, name: M.toolName(id), description: '', bins: [] });
      } else {
        renderToolSheet();
      }
    });

    const moveActive = (field, count, delta) => {
      if (!count) return;
      toolSheet[field] = (toolSheet[field] + delta + count) % count;
      renderToolSheet();
      const id = field === 'active' ? '#tool-opt-' + toolSheet.active : '#ver-opt-' + toolSheet.versionActive;
      const el = panel.querySelector(id);
      if (el) el.scrollIntoView({ block: 'nearest' });
    };
    panel.addEventListener('input', (e) => {
      if (e.target.id === 'tool-q') {
        toolSheet.query = e.target.value;
        toolSheet.active = 0;
        renderToolSheet();
        const list = panel.querySelector('#tool-list');
        if (list) list.scrollTop = 0;
      } else if (e.target.id === 'ver-q') {
        toolSheet.versionQuery = e.target.value;
        toolSheet.version = '';
        toolSheet.versionActive = 0;
        toolSheet.error = null;
        renderToolSheet();
      }
    });
    panel.addEventListener('keydown', (e) => {
      if (e.target.id === 'tool-q') {
        const count = panel.querySelectorAll('#tool-list .tc-option').length;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveActive('active', count, e.key === 'ArrowDown' ? 1 : -1); }
        else if (e.key === 'Enter') { e.preventDefault(); chooseOption(toolSheet.active); }
      } else if (e.target.id === 'ver-q') {
        const options = [...panel.querySelectorAll('#ver-list .tc-option')];
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveActive('versionActive', options.length, e.key === 'ArrowDown' ? 1 : -1); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          // Enter takes the highlighted release, then a second Enter installs
          // it; one already typed out in full installs at once.
          const pick = options[toolSheet.versionActive];
          const value = pick ? pick.getAttribute('data-version') : '';
          if (pick && toolSheet.version !== value && toolSheet.versionQuery.trim() !== value) {
            toolSheet.version = value;
            e.target.value = value;
            toolSheet.versionQuery = value;
            renderToolSheet();
          } else {
            submitTool();
          }
        }
      }
    });
    panel.addEventListener('click', (e) => {
      const option = e.target.closest('#tool-list .tc-option');
      if (option) { chooseOption(Number(option.getAttribute('data-index'))); return; }
      const release = e.target.closest('#ver-list .tc-option');
      if (release) {
        const value = release.getAttribute('data-version');
        toolSheet.version = value;
        toolSheet.versionQuery = value;
        const input = panel.querySelector('#ver-q');
        if (input) input.value = value;
        toolSheet.error = null;
        renderToolSheet();
        focusIn('[data-key="tool-install"]');
        return;
      }
      const action = e.target.closest('[data-sheet]');
      if (!action) return;
      const what = action.getAttribute('data-sheet');
      if (what === 'close') toolSheet.layer.close('cancel');
      else if (what === 'change') {
        Object.assign(toolSheet, { tool: null, info: null, versions: null, error: null });
        renderToolSheet();
        const input = panel.querySelector('#tool-q');
        if (input) { input.value = toolSheet.query; input.focus(); }
      } else if (what === 'ver-latest') {
        toolSheet.versionMode = 'latest';
        toolSheet.error = null;
        renderToolSheet();
      } else if (what === 'ver-pick') {
        toolSheet.versionMode = 'pick';
        renderToolSheet();
        focusIn('#ver-q');
      }
    });
    panel.addEventListener('submit', (e) => {
      e.preventDefault();
      submitTool();
    });
  };

  // ------------------------------------------------------------- versions --
  const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
  const openVersionDialog = (id, trigger) => {
    const h = harness(id);
    if (!h) return;
    const name = nameOf('harness', id);
    const current = h.installedVersion || h.version;
    let error = null;
    const layer = Kit.open({
      kind: 'center',
      panel: { tag: 'form', class: 'tc-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'hv-title', novalidate: true },
      returnTo: trigger,
      backdrop: 'close',
      focus: '#hv-version',
      render: () => html`
        <div class="tc-dialog-body">
          <h2 class="tc-dialog-title" id="hv-title">Install a specific version of ${name}</h2>
          <p class="tc-dialog-desc">${current ? name + ' is on ' + current + '. ' : ''}mise installs exactly the version you name and T3 Code switches to it${current ? '; ' + current + ' keeps working until it finishes' : ''}.</p>
          <div class="tc-field tc-dialog-field">
            <label class="tc-label" for="hv-version">Version</label>
            <input id="hv-version" class="tc-input tc-input--mono hv-version" placeholder="${h.latestVersion || 'e.g. 1.2.3'}" autocomplete="off" spellcheck="false" autocapitalize="off"${error ? raw(' aria-invalid="true" aria-describedby="hv-error"') : ''}>
            ${error ? html`<p class="tc-hint tc-hint--err" id="hv-error" role="alert">${error}</p>`
              : html`<span class="tc-hint">${h.latestVersion ? 'The latest is ' + h.latestVersion + '. ' : ''}${(h.managedVersions || []).length ? 'On the volume: ' + h.managedVersions.join(', ') + '.' : ''}</span>`}
          </div>
        </div>
        <div class="tc-dialog-foot"><button class="tc-btn tc-btn--ghost" type="button" data-dialog="cancel">Cancel</button><button class="tc-btn tc-btn--primary" type="submit">${icon('download')}Install</button></div>`,
    });
    const input = layer.panel.querySelector('#hv-version');
    // The draft survives closing the dialog, a poll, and opening it again.
    input.value = versionDrafts.get(id) || '';
    input.addEventListener('input', () => versionDrafts.set(id, input.value));
    layer.panel.addEventListener('click', (e) => { if (e.target.closest('[data-dialog="cancel"]')) layer.close('cancel'); });
    layer.panel.addEventListener('submit', (e) => {
      e.preventDefault();
      const version = input.value.trim();
      if (!VERSION.test(version)) {
        error = version ? 'That is not a version mise can install exactly (for example 2.1.290).' : 'Enter a version.';
        layer.render();
        input.focus();
        return;
      }
      layer.close('submit');
      callLifecycle('harness', h.installed ? 'update' : 'install', id, version);
    });
  };

  // ------------------------------------------------------------- commands --
  const rowFor = (target, id) => (target === 'harness' ? M.agentRows(state.status, ui, now())
    : target === 'package' ? M.packageRows(state.status, ui, now())
      : M.toolchainRows(state.status, ui, now())).find((r) => r.id === id);

  const confirmRevoke = async (kind, id) => {
    const s = state.status || {};
    let label = id;
    if (kind === 'session') {
      const c = (s.sessions || []).find((x) => x.sessionId === id);
      label = (c && ((c.client && c.client.label) || c.subject)) || 'this device';
    } else {
      const l = (s.pairings || []).find((x) => x.id === id);
      label = (l && l.label) || 'Unlabelled';
    }
    const ok = await Kit.confirm(kind === 'session'
      ? { title: 'Revoke ' + label + '?', body: label + ' loses access immediately and has to be paired again with a new link.', confirm: 'Revoke' }
      : { title: 'Revoke this link?', body: '“' + label + '” has not been used yet. Revoking it means the link stops working.', confirm: 'Revoke link' });
    if (!ok) return;
    const res = await api('/revoke', { body: { kind, id } });
    if (!res.ok) { Kit.toast('Could not revoke', { tone: 'danger', detail: res.error }); return; }
    Kit.toast(kind === 'session' ? 'Revoked ' + label : 'Link revoked');
    await loadStatus();
  };

  const COMMANDS = {
    refresh: () => { loadStatus(); loadPorts(); },
    goto: (a) => go(a.route),
    copy: (a, el) => Kit.copy(a.text, el, a.toast),
    theme: (a) => setTheme(a.mode),
    'theme.cycle': () => setTheme({ system: 'light', light: 'dark', dark: 'system' }[themeMode()]),
    palette: () => openPalette(),
    'open.t3': () => window.open(t3Url(), '_blank', 'noopener'),
    lock: async () => {
      await fetch(BASE + '/logout', { method: 'POST', credentials: 'same-origin', redirect: 'manual' }).catch(() => {});
      locked = true;
      location.replace(BASE + '/');
    },
    diagnostics: (a, el) => {
      const report = M.redactedDiagnostics(state.status, state.ports, { console: { base: BASE || '/', route: state.route, viewport: innerWidth + 'x' + innerHeight } });
      Kit.copy(JSON.stringify(report, null, 2), el && el.closest('[data-cmd]'), 'Diagnostics copied');
    },
    'updates.check': async () => {
      const res = await api('/updates/check', { body: {} });
      Kit.toast(res.ok ? 'Checking for updates' : 'Could not check for updates', res.ok ? { tone: 'info', detail: 'Rows show any newer release within a minute.' } : { tone: 'danger', detail: res.error });
      setTimeout(loadStatus, 8000);
    },

    'row.menu': (a, el) => {
      const row = rowFor(a.target, a.id);
      if (!row || !row.menu.length) return;
      const status = row.status.text;
      Kit.menu(el, {
        label: row.name + ' actions',
        head: { title: row.name, sub: [row.version, Kit.isPhone() ? status.toLowerCase() : null].filter(Boolean).join(' · '), tile: tile(row, 'lg') },
        items: row.menu.map((m) => m.sep ? m : Object.assign({}, m, { run: () => run(m.cmd, { target: row.target, id: row.id }, el) })),
      });
    },
    'harness.install': (a) => callLifecycle('harness', 'install', a.id),
    'harness.update': (a) => callLifecycle('harness', 'update', a.id),
    'harness.uninstall': (a) => confirmUninstall('harness', a.id),
    'harness.version': (a, el) => openVersionDialog(a.id, el),
    'harness.signin': (a, el) => openSignin(a.id, el),
    'harness.apikey': (a, el) => openKeySheet(a.id, el),
    'harness.updateAll': () => updateAll('harness'),
    'toolchain.install': (a) => callLifecycle('toolchain', 'install', a.id),
    'toolchain.update': (a) => callLifecycle('toolchain', 'update', a.id),
    'toolchain.uninstall': (a) => confirmUninstall('toolchain', a.id),
    'toolchain.updateAll': () => updateAll('tools'),
    'tools.updateAll': () => updateAll('tools'),
    'package.add': (a, el) => openToolSheet({ id: a.id, trigger: el }),
    'package.install': (a) => callLifecycle('package', 'install', a.id),
    'package.update': (a) => callLifecycle('package', 'update', a.id),
    'package.version': (a, el) => openToolSheet({ id: a.id, mode: 'version', trigger: el }),
    'package.uninstall': (a) => confirmUninstall('package', a.id),
    // A failed first install never reached the config: nothing to confirm.
    'package.dismiss': (a) => callLifecycle('package', 'uninstall', a.id),
    'op.cancel': (a) => cancelOperation(a.target, a.id),

    'pair.start': () => {
      if (state.route !== 'devices') go('devices');
      mint();
    },
    'pair.again': () => {
      // Same label and lifetime as the link that lapsed.
      if (pair.minted) pair.ttl = pair.minted.ttl || pair.ttl;
      mint();
    },
    'pair.new': () => {
      if (state.route !== 'devices') go('devices');
      pair.showForm = true;
      pair.error = null;
      render();
      const input = $('pair-label');
      if (input) input.focus();
    },
    'pair.ttl': (a) => { pair.ttl = a.value; render(); },
    'device.revoke': (a) => confirmRevoke('session', a.id),
    'link.revoke': (a) => confirmRevoke('pairing', a.id),

    'agents.filter': (a) => { state.agentFilter = a.value; render(); },

    'port.publish': (a) => publishPort(Number(a.id)),
    'port.stop': (a) => stopPort(Number(a.id)),
    'port.qr': (a) => {
      const port = Number(a.id);
      if (expandedPorts.has(port)) expandedPorts.delete(port);
      else expandedPorts.add(port);
      if (state.route !== 'ports') go('ports');
      render();
    },
  };

  /** Run one command by name: buttons, menus, shortcuts and the palette all come through here. */
  const run = (name, args, el) => {
    const command = COMMANDS[name];
    if (!command) return;
    try {
      const result = command(args || {}, el || null);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => Kit.toast('Something went wrong', { tone: 'danger', detail: String(error && error.message || error) }));
      }
    } catch (error) {
      Kit.toast('Something went wrong', { tone: 'danger', detail: String(error && error.message || error) });
    }
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cmd]');
    if (!el || el.disabled || el.closest('[inert]')) return;
    e.preventDefault();
    const args = Object.assign({}, el.dataset);
    run(el.getAttribute('data-cmd'), args, el);
  });

  // The added-tools filter: typing narrows the list as it goes.
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'tool-filter') return;
    state.toolFilter = e.target.value;
    render();
  });

  // Navigation links keep their hrefs (middle-click, copy link); keyboard
  // navigation from them moves focus to the page.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest && e.target.closest('[data-nav]')) keyboardNav = true;
  }, true);
  window.addEventListener('hashchange', () => { keyboardNav = false; });

  // -------------------------------------------------------------- palette --
  const openPalette = () => {
    const layer = Kit.palette({
      items: () => M.paletteItems(state.status || {}, state.ports, ui, now()),
      search: M.searchPalette,
      run: (item) => {
        const { cmd, ...args } = item.cmd;
        if (cmd === 'goto') keyboardNav = true;
        run(cmd, args, null);
      },
    });
    // The registry makes "install kubectl" reachable from here; it loads the
    // first time the palette opens and joins the results in place.
    if (layer && !ui.registry) loadRegistry().then(() => layer.refresh && layer.refresh());
  };

  // ------------------------------------------------------------ shortcuts --
  Kit.bind('mod+k', openPalette);
  Kit.bind('/', openPalette);
  for (const [key, route] of [['o', 'overview'], ['d', 'devices'], ['a', 'agents'], ['t', 'toolchains'], ['p', 'ports'], ['e', 'environment']]) {
    Kit.bind('g ' + key, () => { keyboardNav = true; go(route); });
  }
  Kit.bind('p', () => {
    if (pair.showForm || !pair.minted || pair.minted.outcome) run('pair.start');
    else run('pair.new');
  }, () => state.route === 'devices');
  Kit.bind('n', () => run('package.add'), () => state.route === 'toolchains');

  // ------------------------------------------------------------------ boot --
  window.T3C.hydrateIcons(document);
  Kit.syncDensity();
  applyTheme(themeMode());
  // ⌘ on Apple keyboards, Ctrl elsewhere.
  if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')) {
    for (const k of document.querySelectorAll('[data-mod-key]')) k.textContent = 'Ctrl K';
  }
  // Re-render when the layout crosses the phone breakpoint (menus and sheets
  // pick their shape at open time; rows pick theirs on render).
  Kit.PHONE.addEventListener('change', render);
  show(routeFromHash());
  loadStatus();
  loadPorts();
})();
