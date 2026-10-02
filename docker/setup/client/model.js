// The console's view model: pure functions from what /status and /ports return
// to what the page shows - each row's state, its status line, its one visible
// verb and its menu; readiness; what needs the user; navigation badges; the
// command palette's items and ranking; and the formatting every one of those
// shares.
//
// Nothing here touches the DOM, fetches, or reads the clock except through a
// `now` argument, so tests/console-model.test.mjs runs it under Node exactly as
// the browser does, and app.js stays a thin layer of markup and wiring.
const T3Model = (() => {
  'use strict';

  // ----------------------------------------------------------- catalogue --
  // How each agent looks and signs in. The server says what is installed and
  // signed in; this says how to present it, so the strings live in one place.
  const AGENTS = {
    claude: { name: 'Claude Code', mark: 'claude', mono: 'CC', hue: '--id-claude', how: 'browser sign-in', flow: 'code', command: 'claude auth login' },
    codex: { name: 'Codex', mark: 'codex', mono: 'CO', hue: '--id-codex', how: 'device code', flow: 'device', command: 'codex login --device-auth' },
    opencode: { name: 'OpenCode', mark: 'opencode', mono: 'OC', hue: '--id-opencode', how: 'API key, per provider', flow: 'key', command: null },
    grok: { name: 'Grok Build', mark: 'grok', mono: 'GB', hue: '--id-grok', how: 'device code', flow: 'device', command: 'grok login --device-auth' },
    cursor: { name: 'Cursor', mark: 'cursor', mono: 'CU', hue: '--id-cursor', how: 'browser sign-in', flow: 'browser', command: 'cursor-agent login' },
  };
  const AGENT_ORDER = ['claude', 'codex', 'opencode', 'grok', 'cursor'];

  const TOOLCHAINS = {
    go: { name: 'Go', mono: 'Go' },
    rust: { name: 'Rust', mono: 'Ru', detail: 'With clippy and rustfmt' },
    bun: { name: 'Bun', mono: 'Bu' },
    deno: { name: 'Deno', mono: 'De' },
    uv: { name: 'uv', mono: 'uv' },
  };

  const DONE = { install: 'Installed', update: 'Updated', uninstall: 'Uninstalled' };
  const WORKING = { install: 'Installing', update: 'Updating', uninstall: 'Removing' };
  const FAILED = { install: 'Install failed', update: 'Update failed', uninstall: 'Uninstall failed' };

  // A port that looks like a database asks before it is published.
  const DATABASE_PORTS = new Set([5432, 3306, 6379, 27017, 9000]);
  const DATABASE_PROCESSES = /^(postgres|mysqld|mariadbd|redis-server|mongod|clickhouse)/;

  // ------------------------------------------------------------ versions --
  const splitVersion = (v) => String(v ?? '').trim().replace(/^v/i, '').split(/[.+-]/).filter(Boolean);
  /** -1, 0 or 1. Numeric parts compare as numbers, the rest as strings. */
  const compareVersions = (a, b) => {
    const left = splitVersion(a);
    const right = splitVersion(b);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const x = left[i];
      const y = right[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
        if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
      } else if (x !== y) {
        return x < y ? -1 : 1;
      }
    }
    return 0;
  };
  /** Whether `latest` is a newer release than `installed`. Unknown is no. */
  const isNewer = (latest, installed) => Boolean(latest && installed && compareVersions(latest, installed) > 0);

  // ------------------------------------------------------------- formats --
  const toMs = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const ms = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** "1 Nov", in the reader's own time zone. */
  const shortDate = (value) => {
    const ms = toMs(value);
    if (ms === null) return '—';
    const d = new Date(ms);
    return d.getDate() + ' ' + MONTHS[d.getMonth()];
  };
  /** "1 Oct 2026, 19:40" for title attributes: the absolute time behind a relative one. */
  const absTime = (value) => {
    const ms = toMs(value);
    if (ms === null) return '';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  /**
   * "just now", "6 min ago", "2 hours ago", "yesterday", "in 12 days". Past and
   * future both; anything beyond two months reads as a date.
   */
  const relTime = (value, now) => {
    const ms = toMs(value);
    if (ms === null) return '—';
    const diff = ms - now;
    const past = diff <= 0;
    const s = Math.abs(diff) / 1000;
    if (s < 45) return past ? 'just now' : 'in a moment';
    const say = (text) => (past ? text + ' ago' : 'in ' + text);
    if (s < 3600) return say(Math.max(1, Math.round(s / 60)) + ' min');
    if (s < 86400) return say(plural(Math.round(s / 3600), 'hour'));
    const days = Math.round(s / 86400);
    if (days === 1) return past ? 'yesterday' : 'tomorrow';
    if (days <= 60) return say(plural(days, 'day'));
    return shortDate(ms);
  };
  /** "3 days", "5 hours", "12 min": how long something has been up. */
  const duration = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 90) return plural(Math.round(seconds), 'second');
    if (seconds < 5400) return Math.round(seconds / 60) + ' min';
    if (seconds < 172800) return plural(Math.round(seconds / 3600), 'hour');
    return plural(Math.round(seconds / 86400), 'day');
  };
  /** "14:32": minutes and seconds left. */
  const countdown = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return '0:00';
    const total = Math.floor(ms / 1000);
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  };
  /** Decimal units, as a download dialog shows them: "148 MB", "4.1 GB". */
  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1000) return bytes + ' B';
    const units = ['kB', 'MB', 'GB', 'TB'];
    let n = bytes / 1000;
    let i = 0;
    while (n >= 1000 && i < units.length - 1) { n /= 1000; i += 1; }
    return (n >= 100 || i < 1 ? Math.round(n) : Math.round(n * 10) / 10) + ' ' + units[i];
  };
  /**
   * The build a container runs, as the page names it: "v0.5.0 · browser". A
   * branch build is stamped ref@sha with the whole commit hash, which no
   * sidebar has room for, so the hash is cut to the seven characters git
   * itself shows; `full` keeps everything for a tooltip.
   */
  const imageLabel = (image) => {
    const i = image || {};
    if (!i.version) return { text: null, full: null };
    const variant = i.variant ? ' · ' + i.variant : '';
    const short = String(i.version).replace(/@([0-9a-f]{12,64})$/i, (_, sha) => '@' + sha.slice(0, 7));
    return { text: short + variant, version: short, full: i.version + variant };
  };

  /** "Grok Build and Cursor", "A, B and C". */
  const listOf = (names) => names.length <= 1 ? (names[0] || '')
    : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  const hostOf = (url) => {
    try { return new URL(url).host; } catch { return ''; }
  };

  // ---------------------------------------------------------- operations --
  // What is happening to one agent or toolchain right now, from every source:
  // an operation this page started (operations), one the first-start install
  // is running (setup), or one t3-harness or a restart left in flight (the
  // manager's inProgress fact).
  const progressOf = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const phase = typeof raw.phase === 'string' && raw.phase ? raw.phase : null;
    const done = Number(raw.done);
    const total = Number(raw.total);
    const pct = Number.isFinite(done) && Number.isFinite(total) && total > 0
      ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : null;
    return { phase, pct, done: Number.isFinite(done) ? done : null, total: Number.isFinite(total) && total > 0 ? total : null };
  };
  const progressText = (p) => {
    if (!p) return '';
    if (p.pct === null) return '';
    const done = formatBytes(p.done);
    const total = formatBytes(p.total);
    // "148 of 238 MB" when both share a unit, "900 kB of 1.2 MB" when not.
    const unit = (text) => text.split(' ')[1];
    return p.pct + '% · ' + (unit(done) === unit(total) ? done.split(' ')[0] : done) + ' of ' + total;
  };

  const activityOf = (status, target, id, ui) => {
    const key = target + ':' + id;
    const op = status.operations && status.operations[key];
    const kind = (op && op.state === 'running' && op.kind) || null;
    const serverQueued = Boolean(op && op.state === 'queued');
    const setup = status.setup || {};
    const item = (setup.items || []).find((i) => i.kind === (target === 'harness' ? 'agent' : 'toolchain') && i.id === id);
    const queued = Boolean(setup.state === 'running' && item && item.state === 'pending');
    const installingFromSetup = Boolean(setup.state === 'running' && item && item.state === 'installing');
    return {
      key,
      ownOp: kind ? op : null,
      pending: ui && ui.pending ? ui.pending.get(key) : null,
      // The kind of a request this page has in flight for the row, if any.
      busy: (ui && ui.busy && ui.busy.get(key)) || null,
      queued,
      serverQueued,
      fromSetup: installingFromSetup,
      progress: progressOf((op && op.state === 'running' && op.progress) || (installingFromSetup && item.progress) || null),
    };
  };

  /**
   * A row's own notice (an error from its last click), unless the status line
   * already says it: a failed install reads the same from /status as from the
   * operation that just ended, and saying it twice reads as two problems.
   */
  const distinctNotice = (notice, status) =>
    notice && !(status && status.text && String(status.text).includes(notice.text)) ? notice : undefined;

  // ---------------------------------------------------------------- agents --
  const methodText = (h) => {
    const meta = AGENTS[h.id] || {};
    switch (h.authMethod) {
      case 'env': return 'key in the environment';
      case 'apikey': return 'stored API key';
      case 'oauth': return meta.how || 'browser sign-in';
      default: return meta.how || 'browser sign-in';
    }
  };

  /**
   * One agent row. `ui` carries the page's own bookkeeping (operations it is
   * waiting on, requests in flight, provider names for OpenCode).
   */
  const agentRow = (h, status, ui, now) => {
    const meta = AGENTS[h.id] || { name: h.name || h.id, mono: String(h.id || '?').slice(0, 2).toUpperCase(), hue: '--id-toolchain', how: '' };
    const act = activityOf(status, 'harness', h.id, ui);
    const version = h.installedVersion || h.version || null;
    const latest = h.latestVersion || null;
    const updateAvailable = Boolean(h.installed && isNewer(latest, version));
    const held = h.installed ? heldRelease(h, version, status, now) : null;
    const runningKind = act.serverQueued ? null : (act.ownOp && act.ownOp.kind) || (act.pending && act.pending.kind)
      || (h.inProgress ? h.operation || 'install' : null) || (act.fromSetup ? 'install' : null) || act.busy;
    const isKey = meta.flow === 'key';

    const row = {
      id: h.id,
      key: act.key,
      target: 'harness',
      name: meta.name,
      mono: meta.mono,
      mark: meta.mark || null,
      hue: meta.hue,
      version,
      latest: updateAvailable ? latest : null,
      updateAvailable,
      state: 'ok',
      status: { dot: null, text: '' },
      badge: null,
      action: null,
      menu: [],
      progress: null,
      cancellable: false,
      attention: false,
    };

    if (h.supported === false) {
      row.state = 'unsupported';
      row.status.text = 'No build for this architecture';
      return row;
    }

    if (runningKind) {
      row.state = 'running';
      row.kind = runningKind;
      row.badge = { tone: 'info', text: WORKING[runningKind] || 'Working', spinner: true };
      row.progress = act.progress || { phase: null, pct: null };
      row.cancellable = Boolean(act.ownOp);
      if (runningKind === 'update' && version && latest && latest !== version) row.versionTo = latest;
      row.status.text = runningKind === 'update' && version
        ? version + ' keeps working until this finishes'
        : runningKind === 'uninstall' ? 'Credentials stay on the volume'
          : act.fromSetup ? 'First start installs it in the background' : 'Runs in the background';
      if (row.cancellable) row.action = { cmd: 'op.cancel', label: 'Cancel', variant: 'ghost' };
      return row;
    }

    if (act.queued || act.serverQueued) {
      row.state = 'queued';
      row.badge = { tone: null, text: 'Queued' };
      row.status.text = act.serverQueued ? 'Starts when the install ahead of it finishes' : 'First start installs it in the background';
      if (act.serverQueued) row.action = { cmd: 'op.cancel', label: 'Cancel', variant: 'ghost' };
      return row;
    }

    if (ui && ui.signingIn === h.id) {
      row.state = 'signing';
      row.badge = { tone: 'info', text: 'Signing in', spinner: true };
      row.status.text = meta.flow === 'device' ? 'Waiting for approval on another device'
        : meta.flow === 'code' ? 'Waiting for the code from the sign-in page' : 'Waiting for the browser sign-in';
      row.menu = [];
      return row;
    }

    const notice = ui && ui.notices ? ui.notices.get(act.key) : null;

    if (!h.installed) {
      if (h.failed && h.failure) {
        // The install itself failed: that needs the user, and the verb is Retry.
        row.state = 'failed';
        row.attention = true;
        row.status = { dot: 'danger', text: (FAILED[h.operation] || 'Failed') + ': ' + h.failure };
        row.action = { cmd: 'harness.install', label: 'Retry', icon: 'refresh-cw', variant: 'warning' };
      } else {
        row.state = 'missing';
        row.status.text = 'Not installed';
        row.action = { cmd: 'harness.install', label: 'Install', icon: 'download' };
      }
      row.menu = [{ cmd: 'harness.version', label: 'Install a specific version…', icon: 'history' }];
      row.notice = distinctNotice(notice, row.status);
      return row;
    }

    // Installed: what the user should do next decides the one visible verb.
    const lastFailed = Boolean(h.failed && h.failure && h.operation && h.operation !== 'install');
    if (!h.runnable) {
      row.state = 'failed';
      row.attention = true;
      row.status = { dot: 'danger', text: h.failure ? 'Not runnable: ' + h.failure : 'Installed but not runnable' };
      row.action = { cmd: 'harness.install', label: 'Reinstall', icon: 'refresh-cw', variant: 'warning' };
    } else if (lastFailed) {
      row.state = 'failed';
      row.attention = true;
      row.status = { dot: 'danger', text: (FAILED[h.operation] || 'Failed') + ': ' + h.failure };
      row.action = { cmd: h.operation === 'uninstall' ? 'harness.uninstall' : 'harness.update', label: 'Retry', icon: 'refresh-cw', variant: 'warning' };
    } else if (h.signedIn === false) {
      row.state = 'signin';
      row.attention = true;
      row.status = { dot: 'warn', text: 'Not signed in · ' + (meta.how || 'sign-in') };
      row.action = isKey
        ? { cmd: 'harness.apikey', label: 'Add key', icon: 'key-round', variant: 'primary' }
        : { cmd: 'harness.signin', label: 'Sign in', icon: 'log-in', variant: 'primary' };
    } else if (h.signedIn !== true) {
      row.state = 'unknown';
      row.status.text = 'Sign-in state not readable';
    } else {
      row.state = updateAvailable ? 'update' : 'ok';
      if (isKey) {
        const names = (ui && ui.providerNames) || [];
        row.status.text = names.length
          ? plural(names.length, 'provider key') + ' · ' + names.join(', ')
          : 'Signed in · ' + methodText(h);
      } else {
        row.status.text = 'Signed in · ' + (updateAvailable ? latest + ' is available' : held ? held.text : methodText(h));
      }
      if (updateAvailable) row.action = { cmd: 'harness.update', label: 'Update' };
      else if (isKey) row.action = { cmd: 'harness.apikey', label: 'Add key', icon: 'key-round' };
    }
    row.notice = distinctNotice(notice, row.status);
    row.held = held;

    // Everything else is one press away in the menu.
    if (updateAvailable) row.menu.push({ cmd: 'harness.update', label: 'Update to ' + latest, icon: 'circle-arrow-up' });
    if (held) row.menu.push({ cmd: 'release.now', label: 'Install ' + held.version + ' now', icon: 'download', args: { version: held.version } });
    row.menu.push({ cmd: 'harness.version', label: 'Install a specific version…', icon: 'history' });
    if (h.canSetKey) row.menu.push({ cmd: 'harness.apikey', label: isKey ? 'Add a provider key…' : 'Use an API key…', icon: 'key-round' });
    if (h.canSignIn && h.runnable && row.state !== 'signin') row.menu.push({ cmd: 'harness.signin', label: 'Sign in again', icon: 'log-in' });
    row.menu.push({ sep: true });
    row.menu.push({ cmd: 'harness.uninstall', label: 'Uninstall…', icon: 'trash-2', danger: true });
    return row;
  };

  const agentRows = (status, ui, now) => {
    const list = (status && status.harnesses) || [];
    const byId = new Map(list.map((h) => [h.id, h]));
    const ids = [...AGENT_ORDER.filter((id) => byId.has(id)), ...list.map((h) => h.id).filter((id) => !AGENT_ORDER.includes(id))];
    return ids.map((id) => agentRow(byId.get(id), status, ui, now));
  };

  // ------------------------------------------------------------ toolchains --
  // The five toolchains the image installs and the tools added on top of them
  // (any other mise tool in the global config) share one row model: the same
  // states, verbs and menu, each under its own commands (toolchain.update,
  // package.update, ...).

  /** Two letters for a tile: "Jq", "Ri", "Ku". */
  const monogram = (name) => {
    const letters = String(name || '?').replace(/[^A-Za-z0-9]/g, '') || '?';
    return letters[0].toUpperCase() + (letters[1] || '').toLowerCase();
  };

  /** "Provides rg", "Provides node, npm and npx": said only when the commands are not just the name. */
  const providesText = (name, bins) => {
    const list = (bins || []).filter(Boolean);
    if (!list.length || (list.length === 1 && list[0] === name)) return null;
    const shown = list.length > 3 ? list.slice(0, 3).concat(plural(list.length - 3, 'more', 'more')) : list;
    return 'Provides ' + listOf(shown);
  };

  const toolRow = (t, target, status, ui, now) => {
    const isPackage = target === 'package';
    const meta = isPackage
      ? { name: t.name || t.id, mono: monogram(t.name || t.id), detail: providesText(t.name || t.id, t.bins) }
      : TOOLCHAINS[t.id] || { name: t.name || t.id, mono: String(t.id || '?').slice(0, 2) };
    const cmd = (verb) => target + '.' + verb;
    const act = activityOf(status, target, t.id, ui);
    const version = t.version || null;
    const latest = t.latestVersion || null;
    const updateAvailable = Boolean(t.installed && isNewer(latest, version));
    const held = t.installed ? heldRelease(t, version, status, now) : null;
    const runningKind = act.serverQueued ? null : (act.ownOp && act.ownOp.kind) || (act.pending && act.pending.kind)
      || (t.inProgress ? t.operation || 'install' : null) || (act.fromSetup ? 'install' : null) || act.busy;
    const planned = ((status.setup && status.setup.items) || []).some((i) => i.kind === 'toolchain' && i.id === t.id);
    // What the global config asks for when it is not an exact version
    // (`latest`, `3`): the row says so instead of implying a pin.
    const follows = isPackage && t.requestedVersion && version && t.requestedVersion !== version ? t.requestedVersion : null;

    const row = {
      id: t.id,
      key: act.key,
      target,
      name: meta.name,
      mono: meta.mono,
      hue: '--id-toolchain',
      version,
      latest: updateAvailable ? latest : null,
      updateAvailable,
      state: 'ok',
      status: { dot: null, text: '' },
      badge: null,
      action: null,
      menu: [],
      progress: null,
      cancellable: false,
      attention: false,
      dim: false,
      description: isPackage ? t.description || null : null,
      bins: isPackage ? t.bins || [] : [],
    };

    if (runningKind) {
      row.state = 'running';
      row.kind = runningKind;
      row.badge = { tone: 'info', text: WORKING[runningKind] || 'Working', spinner: true };
      row.progress = act.progress || { phase: null, pct: null };
      row.cancellable = Boolean(act.ownOp);
      const parts = [];
      if (meta.detail) parts.push(meta.detail);
      if (runningKind === 'update' && version && latest && latest !== version) row.versionTo = latest;
      if (runningKind === 'update' && version) parts.push(version + ' keeps working until this finishes');
      else if (act.fromSetup) parts.push('First start installs it in the background');
      row.status.text = parts.join(' · ');
      if (row.cancellable) row.action = { cmd: 'op.cancel', label: 'Cancel', variant: 'ghost' };
      return row;
    }
    if (act.queued || act.serverQueued) {
      row.state = 'queued';
      row.badge = { tone: null, text: 'Queued' };
      row.status.text = act.serverQueued ? 'Starts when the install ahead of it finishes' : 'First start installs it in the background';
      if (act.serverQueued) row.action = { cmd: 'op.cancel', label: 'Cancel', variant: 'ghost' };
      return row;
    }
    const notice = ui && ui.notices ? ui.notices.get(act.key) : null;

    if (!t.installed) {
      row.dim = true;
      if (t.failed && t.failure) {
        row.state = 'failed';
        row.attention = true;
        row.status = { dot: 'danger', text: (FAILED[t.operation] || 'Failed') + ': ' + t.failure };
        row.action = { cmd: cmd('install'), label: 'Retry', icon: 'refresh-cw', variant: 'warning' };
        // A first install that never reached the config has nothing to
        // uninstall; it can only be retried, or taken off the list.
        if (isPackage && !t.configured) row.menu.push({ cmd: 'package.dismiss', label: 'Remove from this list', icon: 'x' });
      } else {
        row.state = 'missing';
        if (isPackage || planned || !status.setup || status.setup.state === 'off') row.status.text = 'Not installed';
        else row.status = { dot: null, text: 'Not installed · left out of', code: 'T3_PREINSTALL' };
        row.action = { cmd: cmd('install'), label: 'Install', icon: 'download' };
      }
      row.notice = distinctNotice(notice, row.status);
      return row;
    }
    row.notice = distinctNotice(notice, row.status);
    if (t.failed && t.failure && t.operation && t.operation !== 'install') {
      row.state = 'failed';
      row.attention = true;
      row.status = { dot: 'danger', text: (FAILED[t.operation] || 'Failed') + ': ' + t.failure };
      row.action = { cmd: cmd(t.operation === 'uninstall' ? 'uninstall' : 'update'), label: 'Retry', icon: 'refresh-cw', variant: 'warning' };
    } else if (updateAvailable) {
      row.state = 'update';
      row.status.text = (meta.detail ? meta.detail + ' · ' : 'Installed · ') + latest + ' is available';
      row.action = { cmd: cmd('update'), label: 'Update' };
    } else {
      row.status.text = [meta.detail || 'Installed', follows ? 'follows ' + follows : held ? held.text : latest ? 'up to date' : null].filter(Boolean).join(' · ');
    }
    row.held = held;
    if (updateAvailable) row.menu.push({ cmd: cmd('update'), label: 'Update to ' + latest, icon: 'circle-arrow-up' });
    else if (!latest) row.menu.push({ cmd: cmd('update'), label: 'Update to the latest', icon: 'circle-arrow-up' });
    // Toolchains take only mise's newest; an added tool installs any release named.
    if (held && isPackage) row.menu.push({ cmd: 'release.now', label: 'Install ' + held.version + ' now', icon: 'download', args: { version: held.version } });
    if (isPackage) row.menu.push({ cmd: 'package.version', label: 'Install a specific version…', icon: 'history' });
    row.menu.push({ sep: true });
    row.menu.push({ cmd: cmd('uninstall'), label: 'Uninstall…', icon: 'trash-2', danger: true });
    return row;
  };

  const toolchainRow = (t, status, ui, now) => toolRow(t, 'toolchain', status, ui, now);
  const toolchainRows = (status, ui, now) => ((status && status.toolchains) || []).map((t) => toolRow(t, 'toolchain', status, ui, now));
  /** The name a tool's row shows: its registry name, or the last part of a backend spec (npm:@biomejs/biome -> biome). */
  const toolName = (id) => {
    const spec = String(id || '');
    const name = spec.slice(spec.indexOf(':') + 1);
    return name.split('/').filter(Boolean).pop() || name || spec;
  };

  /**
   * Tools added beyond the toolchains: any other mise tool in the global
   * config. A tool still waiting in the queue (or whose request is in flight)
   * is not in /status yet - the manager lists it once its job holds the lock -
   * so it gets a row from the operation, and shows as queued from the click on.
   */
  const packageRows = (status, ui, now) => {
    const s = status || {};
    const list = [...(s.packages || [])];
    const waiting = [
      ...Object.entries(s.operations || {}).filter(([, op]) => op.state === 'queued' || op.state === 'running').map(([key]) => key),
      ...((ui && ui.pending && [...ui.pending.keys()]) || []),
      ...((ui && ui.busy && [...ui.busy.keys()]) || []),
    ];
    for (const key of waiting) {
      if (!key.startsWith('package:')) continue;
      const id = key.slice('package:'.length);
      const busyKind = ui && ui.busy && ui.busy.get(key);
      // An uninstall in flight is for a row that is already listed.
      if (busyKind === 'uninstall' || list.some((p) => p.id === id)) continue;
      list.push({ id, name: toolName(id), configured: false, installed: false, version: null });
    }
    // By the name a row shows (npm:prettier reads as prettier), so a tool that
    // is still waiting to start already sits where it will stay.
    return list.map((p) => toolRow(p, 'package', s, ui, now))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id));
  };

  // ----------------------------------------------------------- added tools --
  // Names an agent or a toolchain is managed under. The server refuses them as
  // added tools; the Add a tool search shows them, but says where they live.
  const MANAGED_ON = {
    claude: 'Agents', 'claude-code': 'Agents', codex: 'Agents', opencode: 'Agents', grok: 'Agents', cursor: 'Agents',
    'cursor-agent': 'Agents', 'cursor-cli': 'Agents',
    go: 'Toolchains', rust: 'Toolchains', bun: 'Toolchains', deno: 'Toolchains', uv: 'Toolchains',
  };
  const managedOn = (name) => MANAGED_ON[String(name || '')] || null;

  // A version as mise spells them; the server checks the same pattern.
  const VERSION_SPEC = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
  const isVersionSpec = (value) => VERSION_SPEC.test(String(value || '').trim());
  // `[backend:]name`, mirroring the server's check (docker/harness/packages.mjs).
  const TOOL_SPEC = /^(?:[a-z][a-z0-9-]{0,31}:)?[A-Za-z0-9@_][A-Za-z0-9@._/+-]{0,127}$/;
  const isToolSpec = (value) => {
    const id = String(value || '').trim();
    return TOOL_SPEC.test(id) && !id.includes('..') && !id.endsWith('/');
  };

  // A release as listed: a version string, or `{ version, waiting, prerelease,
  // releasedAt, supported }` from /harnesses/versions and /packages/versions.
  const versionOf = (release) => String((release && typeof release === 'object' ? release.version : release) || '');
  const under = (version, q) => version.startsWith(q + '.') || version.startsWith(q + '-') || version.startsWith(q + '+');

  /**
   * The release mise installs for a typed version, the way `mise latest
   * tool@1.3` reads it: exactly the one named, even one mise is still holding
   * back (naming it installs it at once); otherwise the newest under it segment
   * by segment (1.3 -> 1.3.10, never 1.37.1) that mise offers - not one still
   * waiting, not a preview. jq@1.7 is 1.7 even though 1.7.1 exists. Null when
   * it names none.
   */
  const resolveRelease = (releases, query) => {
    const q = String(query || '').trim();
    if (!q) return null;
    const list = releases || [];
    const exact = list.find((r) => versionOf(r) === q);
    if (exact) return versionOf(exact);
    const hit = list.find((r) => under(versionOf(r), q) && !(r && (r.waiting || r.prerelease)));
    return hit ? versionOf(hit) : null;
  };

  /**
   * The releases the version picker lists for what is typed, newest first: the
   * ones it names (the exact release and those under it), or, when it names
   * none - rc, part of a date - the ones containing it.
   */
  const matchReleases = (releases, query) => {
    const list = releases || [];
    const q = String(query || '').trim();
    if (!q) return list;
    const named = list.filter((r) => versionOf(r) === q || under(versionOf(r), q));
    return named.length ? named : list.filter((r) => versionOf(r).includes(q));
  };

  /** Which of the listed releases to highlight: the one the typed version installs, else the first. */
  const releaseIndex = (listed, query) => {
    const target = resolveRelease(listed, query);
    const at = target ? (listed || []).findIndex((r) => versionOf(r) === target) : -1;
    return at === -1 ? 0 : at;
  };

  /**
   * A release out but still inside mise's minimum release age: newer than what
   * is installed and than what mise offers as the newest. `when` says when mise
   * will offer it ("in 21 hours"), where the backend dates its releases.
   */
  const heldRelease = (t, version, status, now) => {
    const newest = t && t.newestVersion;
    if (!newest || !version || !isNewer(newest, version)) return null;
    if (t.latestVersion && !isNewer(newest, t.latestVersion)) return null;
    const releasedAt = toMs(t.newestReleasedAt);
    const age = status && Number.isFinite(status.releaseAgeMs) ? status.releaseAgeMs : null;
    const availableAt = releasedAt !== null && age !== null ? releasedAt + age : null;
    return {
      version: newest,
      releasedAt,
      availableAt,
      text: newest + ' is out · ' + (availableAt !== null && availableAt > now ? 'mise offers it ' + relTime(availableAt, now) : 'mise offers it once it has been out a day'),
    };
  };

  // What the search offers before anything is typed: common picks that are
  // not already in the image (which has git, gh, jq, ripgrep, fd, Node and
  // Python), each kept only if this mise's registry has it.
  const SUGGESTED_TOOLS = ['kubectl', 'helm', 'terraform', 'aws-cli', 'java', 'zig', 'pnpm', 'just', 'shellcheck', 'lazygit', 'k9s', 'duckdb'];
  // Well-known tools win a tie between equally good matches, so "kube" finds
  // kubectl before kubecm. Only a tie-break: a better match always comes first.
  const PROMINENT = new Set([...SUGGESTED_TOOLS,
    'node', 'python', 'ruby', 'php', 'dotnet', 'elixir', 'erlang', 'kotlin', 'lua', 'perl', 'gradle', 'maven', 'yarn',
    'gcloud', 'azure-cli', 'flyctl', 'opentofu', 'pulumi', 'packer', 'vault', 'kind', 'minikube', 'kustomize', 'helmfile',
    'argocd', 'stern', 'golangci-lint', 'ruff', 'prettier', 'biome', 'shfmt', 'hadolint', 'trivy', 'yq', 'fzf', 'bat',
    'eza', 'delta', 'lazydocker', 'hyperfine', 'sops', 'age', 'direnv', 'watchexec', 'neovim', 'tmux', 'hugo', 'buf',
    'protoc', 'bazel', 'cmake', 'task', 'mkcert', 'caddy', 'gh', 'glab', 'act', 'postgres', 'redis', 'sqlite']);

  /**
   * Rank registry entries for a query: the name itself, then an alias or a
   * command it provides (rg finds ripgrep), then a name that starts with or
   * contains it, then its description ("json" finds jq). The name's match is
   * returned so the option can bold it.
   */
  const searchRegistry = (entries, query, limit) => {
    const max = limit || 30;
    const list = entries || [];
    const q = String(query || '').trim().toLowerCase();
    if (!q) {
      const byName = new Map(list.map((e) => [e.name, e]));
      return SUGGESTED_TOOLS.map((name) => byName.get(name)).filter(Boolean).slice(0, max).map((entry) => ({ entry, match: null, score: 0 }));
    }
    const words = q.split(/\s+/);
    const scored = [];
    for (const entry of list) {
      const name = entry.name.toLowerCase();
      const others = (entry.aliases || []).concat(entry.bins || []).map((x) => String(x).toLowerCase());
      const at = name.indexOf(q);
      let score = -1;
      if (name === q) score = 0;
      else if (others.includes(q)) score = 1;
      else if (at === 0) score = 2;
      else if (others.some((x) => x.startsWith(q))) score = 3;
      else if (at > 0 && /[^a-z0-9]/.test(name[at - 1])) score = 4;
      else if (at > 0) score = 5;
      else {
        const hay = name + ' ' + others.join(' ') + ' ' + String(entry.description || '').toLowerCase();
        if (words.every((w) => new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(hay))) score = 6;
        else if (words.every((w) => hay.includes(w))) score = 7;
      }
      if (score === -1) continue;
      scored.push({ entry, match: at >= 0 ? [at, at + q.length] : null, score });
    }
    const prominent = (e) => (PROMINENT.has(e.name) ? 0 : 1);
    scored.sort((a, b) => a.score - b.score || prominent(a.entry) - prominent(b.entry)
      || a.entry.name.length - b.entry.name.length || a.entry.name.localeCompare(b.entry.name));
    return scored.slice(0, max);
  };

  // ---------------------------------------------------------------- ports --
  const looksLikeDatabase = (port, process) => DATABASE_PORTS.has(Number(port)) || DATABASE_PROCESSES.test(String(process || ''));

  /** Rows from what is listening and what is published, in port order. */
  const portRows = (ports, ui, now) => {
    if (!ports) return [];
    const tunnels = new Map((ports.tunnels || []).map((t) => [Number(t.port), t]));
    const details = new Map((ports.details || []).map((d) => [Number(d.port), d]));
    const numbers = [...new Set([...(ports.listening || []).map(Number), ...tunnels.keys()])].filter(Number.isFinite).sort((a, b) => a - b);
    return numbers.map((port) => {
      const t = tunnels.get(port) || null;
      const d = details.get(port) || {};
      const busy = Boolean(ui && ui.portsBusy && ui.portsBusy.has(port));
      let state = t ? t.state : 'idle';
      if (busy && state !== 'open') state = 'starting';
      const process = d.process || null;
      const db = d.looksLikeDatabase === true || (d.looksLikeDatabase === undefined && looksLikeDatabase(port, process));
      const listening = (ports.listening || []).map(Number).includes(port);
      return {
        port,
        state,
        live: state === 'open',
        url: t && t.url ? t.url : null,
        error: t && t.error ? t.error : null,
        qr: t && t.qr ? t.qr : null,
        startedAt: t ? t.startedAt : null,
        process,
        address: d.address || null,
        db,
        listening,
        expanded: Boolean(ui && ui.expandedPorts && ui.expandedPorts.has(port) && state === 'open'),
      };
    });
  };

  // -------------------------------------------------------------- devices --
  const deviceKind = (client) => {
    const c = client || {};
    const os = c.os || null;
    if (c.browser) return c.browser + (os ? ' on ' + os : '');
    if (c.deviceType === 'desktop') return os ? os + ' desktop app' : 'Desktop app';
    if (c.deviceType === 'mobile' || c.deviceType === 'tablet') return os ? os + ' app' : 'Mobile app';
    return os || 'Client';
  };
  const deviceIcon = (client) => {
    const type = (client && client.deviceType) || 'unknown';
    if (type === 'mobile' || type === 'tablet') return 'smartphone';
    if (type === 'desktop') return 'laptop';
    return 'monitor';
  };
  const deviceRows = (sessions, now) => (sessions || []).map((c) => {
    const name = (c.client && c.client.label) || c.label || c.subject || 'Device';
    const seen = c.connected ? 'active now' : c.lastConnectedAt ? 'seen ' + relTime(c.lastConnectedAt, now) : 'not connected yet';
    const ends = toMs(c.expiresAt);
    const days = ends === null ? null : Math.round((ends - now) / 86400000);
    return {
      id: c.sessionId,
      name,
      kind: deviceKind(c.client),
      icon: deviceIcon(c.client),
      connected: Boolean(c.connected),
      current: Boolean(c.current),
      status: [deviceKind(c.client), seen].join(' · '),
      ends: ends === null ? null : (days <= 0 ? 'session ends today' : 'session ends ' + relTime(ends, now)),
      seenTitle: c.lastConnectedAt ? 'Seen ' + absTime(c.lastConnectedAt) : '',
    };
  });
  const linkRows = (pairings, waitingId, now) => (pairings || []).map((l) => ({
    id: l.id,
    name: l.label || 'Unlabelled',
    waiting: Boolean(waitingId && l.id === waitingId),
    status: 'Created ' + relTime(l.createdAt, now) + ' · expires ' + relTime(l.expiresAt, now).replace(/^in /, 'in '),
    expiresTitle: 'Expires ' + absTime(l.expiresAt),
  }));

  // ------------------------------------------------------------ readiness --
  /**
   * The four steps from a fresh container to a working phone. Exactly one is
   * `todo` (the first not done) and carries the page's only primary button; a
   * later step that needs the user is `warn`.
   */
  const readiness = (status, ui) => {
    const s = status || {};
    const agents = agentRows(s, ui, 0);
    const installed = agents.filter((a) => !['missing', 'queued', 'unsupported'].includes(a.state) && a.state !== 'running');
    const notSigned = agents.filter((a) => a.state === 'signin');
    const anyAgent = (s.harnesses || []).some((h) => h.installed);
    const setupRunning = Boolean(s.setup && s.setup.state === 'running');
    const server = s.server || {};

    const steps = [
      {
        id: 'server',
        title: 'Server running',
        done: Boolean(server.ok),
        aside: server.ok ? [server.version, s.t3 && s.t3.port ? 'port ' + s.t3.port : null].filter(Boolean).join(' · ') : null,
        desc: server.ok ? null : 'T3 Code is not answering yet' + (server.detail ? ' (' + server.detail + ')' : '') + '. It usually takes a few seconds after a start.',
        action: server.ok ? null : { cmd: 'refresh', label: 'Check again', icon: 'refresh-cw' },
      },
      {
        id: 'url',
        title: 'Public URL set',
        done: Boolean(s.publicUrl),
        aside: 'T3_PUBLIC_URL',
        desc: s.publicUrl ? null : 'Pairing links point at the address in T3_PUBLIC_URL. Set it to the URL your devices use, then recreate the container.',
        action: s.publicUrl ? null : { cmd: 'copy', label: 'Copy the variable', icon: 'copy', copy: 'T3_PUBLIC_URL=https://' },
      },
      {
        id: 'pair',
        title: 'Pair a device',
        done: (s.sessions || []).length > 0,
        desc: 'Scan the QR with the T3 Code app, or open the link in a browser.',
        action: { cmd: 'pair.start', label: 'Create pairing link', icon: 'link' },
      },
      {
        id: 'agents',
        title: 'Sign in your agents',
        done: anyAgent && notSigned.length === 0 && installed.length > 0 && !agents.some((a) => a.state === 'unknown'),
        desc: notSigned.length
          ? listOf(notSigned.map((a) => a.name)) + (notSigned.length === 1 ? ' is' : ' are') + ' installed but not signed in.'
          : setupRunning ? 'They are still installing; each one can sign in as soon as it lands.'
            : !anyAgent ? 'No agent is installed yet.' : 'Every installed agent reports its sign-in.',
        action: notSigned.length
          ? { cmd: 'goto', route: 'agents', label: 'Review ' + notSigned.length }
          : !anyAgent && !setupRunning ? { cmd: 'goto', route: 'agents', label: 'Open agents' } : null,
      },
    ];
    let todo = -1;
    steps.forEach((step, i) => {
      if (step.done) step.state = 'done';
      else if (todo === -1) { todo = i; step.state = 'todo'; }
      else step.state = step.id === 'agents' && notSigned.length ? 'warn' : '';
      // Only the next step's button is primary; a later step keeps an outline.
      if (step.action) step.action.variant = step.state === 'todo' ? 'primary' : undefined;
      if (step.state === 'done') step.action = null;
    });
    const done = steps.filter((x) => x.done).length;
    const headlines = {
      server: ['Waiting for T3 Code to start', 'The server answers on its own port inside the container. This page notices as soon as it does.'],
      url: ['Set the public URL', 'A paired phone reaches this server at T3_PUBLIC_URL, so a pairing link needs it before anything else.'],
      pair: ['Pair your first device', 'A phone is enough to drive this server. Pairing takes one scan and no shell in the container.'],
      agents: ['Sign in your agents', 'Each agent signs in with its own flow, driven from here. Credentials stay on the volume.'],
    };
    const next = todo === -1 ? null : steps[todo];
    return {
      steps,
      done,
      total: steps.length,
      ready: todo === -1,
      next: next ? next.id : null,
      title: next ? headlines[next.id][0] : 'Ready',
      lede: next ? headlines[next.id][1] : '',
    };
  };

  /** "2 devices paired · 5 agents signed in · 5 toolchains · nothing needs you" */
  const readySummary = (status, ui) => {
    const s = status || {};
    const agents = agentRows(s, ui, 0);
    const signed = agents.filter((a) => ['ok', 'update'].includes(a.state)).length;
    const tools = (s.toolchains || []).filter((t) => t.installed).length;
    const attention = needsYou(s, null, ui).length;
    return [
      plural((s.sessions || []).length, 'device') + ' paired',
      plural(signed, 'agent') + ' signed in',
      plural(tools, 'toolchain'),
      attention ? plural(attention, 'thing') + ' to look at' : 'nothing needs you',
    ].join(' · ');
  };

  // -------------------------------------------------------- what needs you --
  /** Rows that want the user: not signed in, failed, and updates available. */
  const needsYou = (status, ports, ui) => {
    const s = status || {};
    const agents = agentRows(s, ui, 0);
    const tools = [...toolchainRows(s, ui, 0), ...packageRows(s, ui, 0)];
    const rank = { failed: 0, signin: 1, update: 2 };
    const items = [
      ...agents.filter((a) => a.state in rank),
      ...tools.filter((t) => t.state === 'failed' || t.state === 'update'),
    ];
    if (ports) {
      for (const p of portRows(ports, ui, 0)) {
        if (p.state === 'failed') items.push({ target: 'port', id: p.port, state: 'failed', port: p });
      }
    }
    return items.sort((a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3));
  };

  // ------------------------------------------------------------- activity --
  /** Work running now, queued behind it, and what finished recently. */
  const activity = (status, ui, now) => {
    const s = status || {};
    const running = [];
    const queued = [];
    for (const row of [...agentRows(s, ui, now), ...toolchainRows(s, ui, now), ...packageRows(s, ui, now)]) {
      if (row.state === 'running') running.push(row);
      else if (row.state === 'queued') queued.push(row);
    }
    const finished = [];
    for (const [key, op] of Object.entries(s.operations || {})) {
      if (op.state === 'running' || !op.finishedAt) continue;
      if (now - op.finishedAt > 30 * 60 * 1000) continue;
      // On the first colon only: an added tool's id can carry its own (npm:prettier).
      const target = key.slice(0, key.indexOf(':'));
      const id = key.slice(key.indexOf(':') + 1);
      const name = target === 'harness' ? (AGENTS[id] || {}).name || id
        : target === 'toolchain' ? (TOOLCHAINS[id] || {}).name || id
          : ((s.packages || []).find((p) => p.id === id) || {}).name || toolName(id);
      finished.push({
        key,
        ok: op.state === 'ok',
        text: op.state === 'ok' ? (DONE[op.kind] || 'Finished') + ' ' + name : (FAILED[op.kind] || 'Failed') + ': ' + name,
        at: op.finishedAt,
      });
    }
    const setup = s.setup || {};
    if (setup.state === 'finished' && setup.finishedAt && now - toMs(setup.finishedAt) < 30 * 60 * 1000) {
      const done = (setup.items || []).filter((i) => i.state === 'done');
      if (done.length) {
        const agents = done.filter((i) => i.kind === 'agent').length;
        const tools = done.filter((i) => i.kind === 'toolchain').length;
        finished.push({
          key: 'setup',
          ok: true,
          text: 'First start finished: ' + [agents ? plural(agents, 'agent') : null, tools ? plural(tools, 'toolchain') : null].filter(Boolean).join(' and '),
          at: toMs(setup.finishedAt),
        });
      }
    }
    finished.sort((a, b) => b.at - a.at);
    return { running, queued, finished: finished.slice(0, 4) };
  };

  /** The banner under the top bar while the first start installs. */
  const setupBanner = (status) => {
    const setup = (status && status.setup) || null;
    if (!setup || setup.state !== 'running') return null;
    const items = setup.items || [];
    const done = items.filter((i) => i.state === 'done').length;
    const left = items.filter((i) => i.state === 'installing' || i.state === 'pending').map((i) => i.name);
    return {
      done,
      total: items.length,
      pct: items.length ? Math.round((done / items.length) * 100) : 0,
      text: left.length ? 'installing ' + listOf(left.slice(0, 3)) + (left.length > 3 ? ' and ' + (left.length - 3) + ' more' : '') + ' in the background. Everything else is ready.'
        : 'finishing up.',
    };
  };

  // ------------------------------------------------------------ navigation --
  /**
   * Counts and badges for the sidebar and the tab bar. A count is mono and
   * quiet; when items need the user it becomes a warn badge, and when some are
   * live, an info badge.
   */
  const navBadges = (status, ports, ui) => {
    const s = status || {};
    const agents = agentRows(s, ui, 0);
    const tools = [...toolchainRows(s, ui, 0), ...packageRows(s, ui, 0)];
    const portList = ports ? portRows(ports, ui, 0) : [];
    const agentAttention = agents.filter((a) => a.attention).length;
    const toolsRunning = tools.filter((t) => t.state === 'running').length;
    const toolsFailed = tools.filter((t) => t.state === 'failed').length;
    const published = portList.filter((p) => p.state === 'open').length;
    const portsFailed = portList.filter((p) => p.state === 'failed').length;
    return {
      overview: null,
      devices: { count: (s.sessions || []).length },
      agents: agentAttention ? { tone: 'warn', count: agentAttention } : { count: agents.filter((a) => a.version && a.state !== 'missing').length },
      toolchains: toolsFailed ? { tone: 'warn', count: toolsFailed }
        : toolsRunning ? { tone: 'info', count: toolsRunning } : { count: tools.filter((t) => t.version).length },
      ports: portsFailed ? { tone: 'warn', count: portsFailed }
        : published ? { tone: 'info', count: published } : ports ? { count: portList.length } : null,
      // Settings an older image left in the container's environment.
      environment: (s.legacyEnv || []).length ? { tone: 'warn', count: 1 } : null,
      more: toolsFailed + ((s.legacyEnv || []).length ? 1 : 0)
        ? { tone: 'warn', count: toolsFailed + ((s.legacyEnv || []).length ? 1 : 0) } : null,
    };
  };

  // -------------------------------------------------------------- summary --
  const summaries = (status, ports, ui, now, host) => {
    const s = status || {};
    const agents = agentRows(s, ui, now);
    const installed = agents.filter((a) => a.version && a.state !== 'missing');
    const signed = agents.filter((a) => ['ok', 'update'].includes(a.state)).length;
    const tools = (s.toolchains || []);
    const added = (s.packages || []).filter((p) => p.configured).length;
    const portList = ports ? portRows(ports, ui, now) : [];
    const sessions = (s.sessions || []).length;
    const links = (s.pairings || []).length;
    return {
      overview: { text: hostOf(s.publicUrl) || host || '', mono: true },
      devices: { text: sessions || links ? [sessions + ' paired', links ? plural(links, 'link') + ' waiting' : null].filter(Boolean).join(' · ') : 'No devices yet' },
      agents: { text: installed.length ? signed + ' of ' + installed.length + ' signed in' : 'None installed yet' },
      toolchains: { text: [tools.filter((t) => t.installed).length + ' of ' + tools.length + ' installed', added ? added + ' added' : null, 'through mise'].filter(Boolean).join(' · ') },
      ports: { text: ports ? (ports.available === false ? 'Publishing unavailable' : [portList.filter((p) => p.listening).length + ' listening', portList.filter((p) => p.state === 'open').length ? portList.filter((p) => p.state === 'open').length + ' published' : null].filter(Boolean).join(' · ')) : '' },
      environment: { text: 'Read from the container at boot' },
      more: { text: '' },
    };
  };

  // --------------------------------------------------------------- palette --
  /**
   * Every action and object the palette can reach. Each item names its verb and
   * object and carries a command the page runs exactly as its button would.
   */
  const paletteItems = (status, ports, ui, now) => {
    const s = status || {};
    const items = [];
    // Words people reach for that the label does not use ("login", "expose",
    // "log out"): a query matching only these still finds the item.
    const KEYWORDS = {
      'harness.signin': 'login log in auth authenticate', 'harness.apikey': 'api key token credential provider',
      'harness.install': 'add download', 'harness.uninstall': 'remove delete', 'harness.update': 'upgrade',
      'toolchain.install': 'add download', 'toolchain.uninstall': 'remove delete', 'toolchain.update': 'upgrade',
      'package.add': 'install new tool package mise registry', 'package.install': 'add download', 'package.uninstall': 'remove delete',
      'package.update': 'upgrade', 'package.version': 'pin downgrade older release', 'tools.updateAll': 'upgrade',
      'port.publish': 'expose share tunnel open', 'port.stop': 'unpublish unexpose close tunnel', 'port.qr': 'scan phone',
      'device.revoke': 'remove delete unpair sign out', 'link.revoke': 'remove delete pairing',
      'pair.start': 'new add phone device qr', lock: 'log out logout sign out', theme: 'appearance mode colour color',
      diagnostics: 'debug support report bug', 'updates.check': 'refresh latest new version', 'open.t3': 'launch app',
      goto: 'go to open page show',
    };
    const add = (group, label, icon, cmd, extra) => items.push(Object.assign(
      { group, label, icon, cmd, id: group + ':' + label, keywords: (KEYWORDS[cmd.cmd] || '') + (cmd.cmd === 'goto' ? ' ' + label : '') },
      extra || {}));

    for (const a of agentRows(s, ui, now)) {
      const hint = a.state === 'signin' ? { text: 'not signed in', dot: 'warn' }
        : a.state === 'failed' ? { text: 'failed', dot: 'danger' }
          : a.updateAvailable ? { text: a.latest, mono: true } : a.version ? { text: a.version, mono: true } : null;
      const attention = a.attention || a.updateAvailable;
      if (a.state === 'missing') add('Agents', 'Install ' + a.name, 'download', { cmd: 'harness.install', id: a.id }, { meta: null });
      if (a.state === 'signin') add('Agents', (a.action && a.action.label === 'Add key' ? 'Add a provider key for ' : 'Sign in ') + a.name, a.action && a.action.icon || 'log-in', { cmd: a.action.cmd, id: a.id }, { meta: hint, attention: true });
      if (a.state === 'failed' && a.action) add('Agents', 'Retry ' + a.name, 'refresh-cw', { cmd: a.action.cmd, id: a.id }, { meta: hint, attention: true });
      if (a.updateAvailable) add('Agents', 'Update ' + a.name + ' to ' + a.latest, 'circle-arrow-up', { cmd: 'harness.update', id: a.id }, { meta: { text: a.version, mono: true }, attention });
      for (const m of a.menu) {
        if (m.sep || m.cmd === 'harness.update') continue;
        const label = m.cmd === 'harness.signin' ? 'Sign in ' + a.name + ' again'
          : m.cmd === 'harness.version' ? 'Install a specific version of ' + a.name + '…'
            : m.cmd === 'harness.apikey' ? (a.id === 'opencode' ? 'Add a provider key for OpenCode…' : 'Use an API key for ' + a.name + '…')
              : m.cmd === 'harness.uninstall' ? 'Uninstall ' + a.name + '…' : m.label + ' ' + a.name;
        if (items.some((i) => i.label === label)) continue;
        add('Agents', label, m.icon, { cmd: m.cmd, id: a.id }, { meta: m.cmd === 'harness.uninstall' ? null : hint });
      }
    }
    for (const t of toolchainRows(s, ui, now)) {
      if (t.state === 'missing') add('Toolchains', 'Install ' + t.name, 'download', { cmd: 'toolchain.install', id: t.id });
      if (t.updateAvailable) add('Toolchains', 'Update ' + t.name + ' to ' + t.latest, 'circle-arrow-up', { cmd: 'toolchain.update', id: t.id }, { meta: { text: t.version, mono: true }, attention: true });
      if (t.state === 'failed') add('Toolchains', 'Retry ' + t.name, 'refresh-cw', { cmd: t.action.cmd, id: t.id }, { meta: { text: 'failed', dot: 'danger' }, attention: true });
      if (t.version && t.state !== 'running') add('Toolchains', 'Uninstall ' + t.name + '…', 'trash-2', { cmd: 'toolchain.uninstall', id: t.id });
    }
    add('Toolchains', 'Add a tool…', 'plus', { cmd: 'package.add' }, { shortcut: 'N' });
    const installed = new Set();
    for (const t of packageRows(s, ui, now)) {
      installed.add(t.id);
      const version = t.version ? { text: t.version, mono: true } : null;
      if (t.updateAvailable) add('Toolchains', 'Update ' + t.name + ' to ' + t.latest, 'circle-arrow-up', { cmd: 'package.update', id: t.id }, { meta: version, attention: true });
      if (t.state === 'failed') add('Toolchains', 'Retry ' + t.name, 'refresh-cw', { cmd: t.action.cmd, id: t.id }, { meta: { text: 'failed', dot: 'danger' }, attention: true });
      if (t.version && t.state !== 'running') {
        add('Toolchains', 'Install a specific version of ' + t.name + '…', 'history', { cmd: 'package.version', id: t.id }, { meta: version });
        add('Toolchains', 'Uninstall ' + t.name + '…', 'trash-2', { cmd: 'package.uninstall', id: t.id });
      }
    }
    // The registry, once loaded: anything mise can install, reachable by name,
    // command or description. Only offered for a query; a thousand tools would
    // bury everything else.
    for (const entry of (ui && ui.registry) || []) {
      if (installed.has(entry.name) || managedOn(entry.name)) continue;
      add('Install from mise', 'Install ' + entry.name + '…', 'download', { cmd: 'package.add', id: entry.name }, {
        meta: entry.bins && entry.bins.length && !(entry.bins.length === 1 && entry.bins[0] === entry.name) ? { text: entry.bins.slice(0, 2).join(' '), mono: true } : null,
        keywords: [entry.description, ...(entry.aliases || []), ...(entry.bins || [])].join(' '),
        searchOnly: true,
      });
    }
    if (ports && ports.available !== false) {
      for (const p of portRows(ports, ui, now)) {
        const meta = p.db ? { text: 'database', dot: 'warn' } : p.process ? { text: p.process, mono: true } : null;
        if (p.state === 'idle') add('Ports', 'Publish port ' + p.port + (p.db ? '…' : ''), 'globe', { cmd: 'port.publish', id: p.port }, { meta });
        if (p.state === 'failed') add('Ports', 'Retry publishing port ' + p.port, 'refresh-cw', { cmd: 'port.publish', id: p.port }, { meta: { text: 'failed', dot: 'danger' }, attention: true });
        if (p.state === 'open') {
          add('Ports', 'Copy published URL for port ' + p.port, 'copy', { cmd: 'copy', text: p.url, toast: 'Published URL copied' });
          add('Ports', 'Show QR code for port ' + p.port, 'qr-code', { cmd: 'port.qr', id: p.port });
          add('Ports', 'Stop publishing port ' + p.port, 'circle-stop', { cmd: 'port.stop', id: p.port });
        }
      }
    }
    for (const d of deviceRows(s.sessions, now)) add('Devices', 'Revoke ' + d.name + '…', 'trash-2', { cmd: 'device.revoke', id: d.id }, { meta: { text: d.kind } });
    for (const l of linkRows(s.pairings, null, now)) add('Devices', 'Revoke link ' + l.name + '…', 'trash-2', { cmd: 'link.revoke', id: l.id });

    add('Actions', 'Create pairing link', 'link', { cmd: 'pair.start' }, { shortcut: 'P' });
    const agentUpdates = agentRows(s, ui, now).filter((a) => a.updateAvailable).length;
    if (agentUpdates) add('Actions', 'Update all agents', 'circle-arrow-up', { cmd: 'harness.updateAll' }, { meta: { text: plural(agentUpdates, 'update') }, attention: true });
    const toolUpdates = toolchainRows(s, ui, now).filter((t) => t.updateAvailable).length;
    const packageUpdates = packageRows(s, ui, now).filter((t) => t.updateAvailable).length;
    if (toolUpdates + packageUpdates) {
      add('Actions', packageUpdates ? 'Update all toolchains and tools' : 'Update all toolchains', 'circle-arrow-up', { cmd: 'tools.updateAll' },
        { meta: { text: plural(toolUpdates + packageUpdates, 'update') } });
    }
    add('Actions', 'Check for updates now', 'refresh-cw', { cmd: 'updates.check' });
    add('Actions', 'Open T3 Code', 'external-link', { cmd: 'open.t3' });
    add('Actions', 'Theme: light', 'sun', { cmd: 'theme', mode: 'light' });
    add('Actions', 'Theme: dark', 'moon', { cmd: 'theme', mode: 'dark' });
    add('Actions', 'Theme: follow the system', 'monitor', { cmd: 'theme', mode: 'system' });
    add('Actions', 'Lock console', 'lock', { cmd: 'lock' });
    if (s.publicUrl) add('Environment', 'Copy public URL', 'copy', { cmd: 'copy', text: s.publicUrl, toast: 'Public URL copied' }, { meta: { text: hostOf(s.publicUrl), mono: true } });
    add('Environment', 'Copy diagnostics', 'copy', { cmd: 'diagnostics' });

    const pages = [['Overview', 'overview', 'layout-dashboard', 'O'], ['Devices', 'devices', 'smartphone', 'D'], ['Agents', 'agents', 'bot', 'A'],
      ['Toolchains', 'toolchains', 'wrench', 'T'], ['Ports', 'ports', 'ethernet-port', 'P'], ['Environment', 'environment', 'settings-2', 'E']];
    for (const [label, route, icon, key] of pages) add('Go to', label, icon, { cmd: 'goto', route }, { shortcut: 'G ' + key });
    return items;
  };

  const GROUP_ORDER = ['Agents', 'Toolchains', 'Ports', 'Devices', 'Actions', 'Environment', 'Go to', 'Install from mise'];
  // Registry results are capped: the best few, after everything the console itself offers.
  const SEARCH_ONLY_LIMIT = 6;

  /**
   * Filter and rank. An empty query lists what needs attention first, then
   * everything by group. A query matches the label anywhere - a prefix above a
   * word start above the middle of a word, and the match is returned so the
   * label can bold it - or, failing that, when every word of it appears in the
   * label or the item's keywords ("go to env", "log out"). Groups stay
   * together, the group holding the best match first.
   */
  const searchPalette = (items, query) => {
    const q = String(query || '').trim().toLowerCase();
    const groupRank = (g) => { const i = GROUP_ORDER.indexOf(g); return i === -1 ? GROUP_ORDER.length : i; };
    if (!q) {
      const attention = items.filter((i) => i.attention).map((i) => Object.assign({}, i, { group: 'Needs you', match: null }));
      const rest = items.filter((i) => !i.attention && !i.searchOnly && i.group !== 'Devices').map((i) => Object.assign({}, i, { match: null }));
      rest.sort((a, b) => groupRank(a.group) - groupRank(b.group));
      return [...attention, ...rest];
    }
    const scored = [];
    for (const item of items) {
      const label = item.label.toLowerCase();
      const at = label.indexOf(q);
      let score = -1;
      let match = null;
      if (at === 0) score = 0;
      else if (at > 0 && /[\s(/-]/.test(label[at - 1])) score = 1;
      else if (at > 0) score = 2;
      if (at >= 0) match = [at, at + q.length];
      else {
        const hay = label + ' ' + String(item.keywords || '').toLowerCase();
        if (q.split(/\s+/).every((word) => hay.includes(word))) score = 3;
      }
      if (score === -1) continue;
      scored.push({ item: Object.assign({}, item, { match }), score });
    }
    const best = new Map();
    for (const s of scored) if (!s.item.searchOnly) best.set(s.item.group, Math.min(best.get(s.item.group) ?? Infinity, s.score));
    // Search-only results (the registry) always come after the console's own.
    for (const s of scored) if (s.item.searchOnly) best.set(s.item.group, 99);
    scored.sort((a, b) => best.get(a.item.group) - best.get(b.item.group)
      || groupRank(a.item.group) - groupRank(b.item.group) || a.score - b.score || a.item.label.length - b.item.label.length);
    let searchOnly = 0;
    return scored.filter((s) => !s.item.searchOnly || ++searchOnly <= SEARCH_ONLY_LIMIT).map((s) => s.item);
  };

  // ----------------------------------------------------------- diagnostics --
  /** /status with anything identifying taken out, for pasting into an issue. */
  const redactedDiagnostics = (status, ports, extra) => {
    const copy = JSON.parse(JSON.stringify(status || {}));
    for (const c of copy.sessions || []) {
      if (c.client) { delete c.client.ipAddress; delete c.client.userAgent; }
      c.sessionId = c.sessionId ? c.sessionId.slice(0, 8) + '…' : c.sessionId;
    }
    for (const l of copy.pairings || []) l.id = l.id ? l.id.slice(0, 8) + '…' : l.id;
    const portCopy = ports ? JSON.parse(JSON.stringify(ports)) : null;
    if (portCopy) for (const t of portCopy.tunnels || []) delete t.qr;
    return Object.assign({ generatedAt: new Date().toISOString() }, extra || {}, { status: copy, ports: portCopy });
  };

  return {
    AGENTS, TOOLCHAINS, DONE, WORKING, FAILED,
    compareVersions, isNewer,
    relTime, absTime, shortDate, duration, countdown, formatBytes, listOf, hostOf, plural, toMs, imageLabel,
    progressOf, progressText,
    agentRow, agentRows, toolRow, toolchainRow, toolchainRows, packageRows, portRows, looksLikeDatabase,
    monogram, managedOn, isVersionSpec, isToolSpec, searchRegistry, resolveRelease, matchReleases, releaseIndex, heldRelease, versionOf, toolName, SUGGESTED_TOOLS,
    deviceRows, linkRows, deviceKind,
    readiness, readySummary, needsYou, activity, setupBanner,
    navBadges, summaries,
    paletteItems, searchPalette,
    redactedDiagnostics,
  };
})();
