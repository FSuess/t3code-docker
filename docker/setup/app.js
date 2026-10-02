// The setup console's client script.
//
// It lives in its own file, not inside a template literal in server.mjs, and
// that is deliberate: a template literal eats backslashes on the way out, so
// `/\s+/` reached the browser as `/s+/` and split names on the letter s. The
// same trap ate an apostrophe once before. `node --check` cannot catch either,
// because the corrupted result still parses. Kept as a real file, nothing
// rewrites it between here and the browser.
//
// Markup here is the `tc-*` component system from docker/setup/console.css;
// the two are one design and should be changed together.
//
// Where to send API calls.
//
// The server infers its own mount from the path a request arrives on, and
// passes it here. That works while a reverse proxy forwards the prefix intact;
// a proxy that *strips* it - Cloudflare and nginx both do this routinely -
// leaves the server seeing "/" and reporting no mount, and the page then calls
// /status at the origin root, which the proxy does not route back here. The
// browser still knows the real path, so fall back to it: the page's own
// directory is the right base whether the prefix survived the hop or not.
const pageBase = () => {
  const path = location.pathname.replace(/\/+$/, '');
  // A page served at /__setup answers its API at /__setup/status; one served
  // at the root answers at /status.
  return /\.[a-z0-9]{1,5}$/i.test(path) ? path.replace(/\/[^/]*$/, '') : path;
};
const BASE = window.__T3_SETUP_BASE__ || pageBase();

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"]/g,
  (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));

// ---------------------------------------------------------------- unlock --
// The form is server-rendered, so its action carries whatever mount the server
// could work out. Behind a proxy that strips the prefix that is the origin
// root, which the proxy does not route back here - you cannot even sign in.
// Post it ourselves against the base the browser can see, and reload rather
// than follow a redirect the server would aim at the same wrong root.
const loginForm = $('loginform');
if (loginForm) {
  loginForm.action = BASE + '/login';
  loginForm.onsubmit = async (event) => {
    event.preventDefault();
    const body = new URLSearchParams(new FormData(loginForm));
    try {
      await fetch(BASE + '/login', {
        method: 'POST', body,
        headers: {'content-type': 'application/x-www-form-urlencoded'},
        redirect: 'manual',
      });
    } catch { /* fall through to the reload, which will show the form again */ }
    location.reload();
  };
}

// ---------------------------------------------------------------- theme --
// Three modes, not two: "system" is the default and keeps following the OS.
// The inline boot script in the page has already applied the stored mode, so
// this only has to keep the icon honest and cycle on click.
const THEME_KEY = 't3-console-theme';
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
  + ' stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/>'
  + '<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2'
  + 'M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
  + ' stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';

const themeMode = () => {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
};
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const applyTheme = (mode) => {
  const resolved = mode === 'system' ? (systemDark() ? 'dark' : 'light') : mode;
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-mode', mode);
  const button = $('theme-btn');
  if (button) {
    button.innerHTML = resolved === 'dark' ? SUN : MOON;
    button.title = mode === 'system'
      ? 'Following the system theme' : 'Theme: ' + mode;
  }
};
if ($('theme-btn')) {
  $('theme-btn').onclick = () => {
    const next = {system: 'light', light: 'dark', dark: 'system'}[themeMode()];
    try { localStorage.setItem(THEME_KEY, next); } catch { /* session only */ }
    applyTheme(next);
  };
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => { if (themeMode() === 'system') applyTheme('system'); });
  applyTheme(themeMode());
}

// ---------------------------------------------------------------- toasts --
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"'
  + ' stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

const toast = (message, icon) => {
  let stack = document.querySelector('.tc-toasts');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'tc-toasts';
    document.body.appendChild(stack);
  }
  const node = document.createElement('div');
  node.className = 'tc-toast';
  node.setAttribute('role', 'status');
  node.innerHTML = (icon || '') + '<span>' + esc(message) + '</span>';
  stack.appendChild(node);
  setTimeout(() => {
    node.classList.add('tc-toast--out');
    setTimeout(() => node.remove(), 200);
  }, 1900);
};

// execCommand is the fallback because clipboard.writeText needs a secure
// context, and this page is often served over plain http on a LAN.
const copy = (text, message) => {
  const done = () => toast(message || 'Copied to clipboard', CHECK);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
};
const fallbackCopy = (text, done) => {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(area);
  area.select();
  try { document.execCommand('copy'); done(); }
  catch { toast('Press ⌘C to copy'); }
  area.remove();
};

// Any element carrying data-copy copies it, so a new copy button needs no wiring.
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-copy]');
  if (target) copy(target.dataset.copy, target.dataset.copyMsg);
});

// --------------------------------------------------------------- dialogs --
// Revoking cuts a device off. The design makes that a decision rather than a
// twitch, so it goes through a dialog with the name of what is about to break.
const confirmDialog = ({title, body, confirmLabel, onConfirm}) => {
  const backdrop = document.createElement('div');
  backdrop.className = 'tc-backdrop';
  backdrop.innerHTML =
    '<div class="tc-dialog" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">'
    + '<h3>' + esc(title) + '</h3><p>' + body + '</p>'
    + '<div class="tc-dialog-foot">'
    + '<button type="button" class="tc-btn tc-btn--ghost" data-close>Cancel</button>'
    + '<button type="button" class="tc-btn tc-btn--danger-solid" data-go>'
    + esc(confirmLabel) + '</button></div></div>';
  document.body.appendChild(backdrop);

  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-close]').onclick = close;
  backdrop.querySelector('[data-go]').onclick = () => { close(); onConfirm(); };
  backdrop.querySelector('[data-go]').focus();
};

// ---------------------------------------------------------------- format --
const when = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return isNaN(d) ? '—' : d.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
};
// "in 29 days" is what you want to know about a device; the exact stamp stays
// on hover for when you need it.
const ago = (v) => {
  const d = new Date(v);
  if (!v || isNaN(d)) return '—';
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  const past = secs >= 0, n = Math.abs(secs);
  const [amount, unit] = n < 60 ? [n, 'second'] : n < 3600 ? [Math.round(n / 60), 'minute']
    : n < 86400 ? [Math.round(n / 3600), 'hour'] : [Math.round(n / 86400), 'day'];
  return new Intl.RelativeTimeFormat(undefined, {numeric: 'auto'})
    .format(past ? -amount : amount, unit);
};
// Two letters that tell the five apart: word initials where there are words,
// and camel-case counts as words - OpenCode reads OC, not OP.
const initials = (name) => {
  const parts = String(name).trim().split(/\s+/)
    .flatMap((w) => w.split(/(?=[A-Z])/).filter(Boolean));
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : String(name).slice(0, 2)).toUpperCase();
};

const dot = '<span class="tc-dot"></span>';
const chip = (kind, text) =>
  '<span class="tc-chip tc-chip--' + kind + '">'
  + (kind === 'idle' ? '' : dot) + esc(text) + '</span>';

const COPY_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none"'
  + ' stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'
  + '<rect x="9" y="9" width="12" height="12" rx="2.5"/>'
  + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

// Everything below drives the console; the unlock screen has none of it.
if ($('mint')) {
  // Both a sign-in and a key form render into the agent's row, and the periodic
  // refresh rebuilds that list. It has to leave the row alone while either is
  // open, or the URL, the QR, the code field - or the key you are halfway
  // through pasting - vanish under you a few seconds after they appear.
  let panelActive = null;

  // A minted pairing link, tracked until the device it was made for shows up.
  // The sessions that existed at mint time are the baseline; a new one is what
  // proves the scan landed. Held here, not in the DOM, so the periodic refresh
  // can advance the tracker without repainting the QR panel underneath it.
  let minted = null;
  let lastSessions = null;

  // ------------------------------------------------------------ pairing --
  let ttl = '30d';
  for (const button of $('ttl').querySelectorAll('button')) {
    button.onclick = () => {
      ttl = button.dataset.ttl;
      for (const other of $('ttl').querySelectorAll('button')) {
        other.setAttribute('aria-pressed', String(other === button));
      }
    };
  }

  const TICK = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none"'
    + ' stroke="currentColor" stroke-width="3.4" stroke-linecap="round"'
    + ' stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

  const STEPS = (active) => {
    const label = ['Link created', 'Device connects', 'Paired'];
    return '<div class="tc-steps">' + label.map((text, i) => {
      const cls = i < active ? ' tc-step--done' : i === active ? ' tc-step--active' : '';
      return (i ? '<span class="tc-step-line"></span>' : '')
        + '<span class="tc-step' + cls + '"><span class="tc-step-mark">'
        + (i < active ? TICK : String(i + 1)) + '</span>' + text + '</span>';
    }).join('') + '</div>';
  };

  $('mint').onclick = async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    $('out').innerHTML = '<div class="tc-panel"><span class="tc-skel" style="width:70%"></span></div>';
    try {
      const res = await fetch(BASE + '/pair', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({ttl, label: $('label').value}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create a link');
      // Baseline the session list before the panel goes up. lastSessions is
      // null only if no status read has finished yet, in which case the next
      // load captures the baseline instead.
      minted = {
        id: data.id,
        expiresAt: data.expiresAt,
        baseline: lastSessions ? new Set(lastSessions) : null,
        paired: false,
        seen: false,
      };
      $('out').innerHTML =
        // The tracker spans the panel rather than sharing a column with the QR:
        // beside a 168px code it never had the width to stay on one line, and a
        // connector that spans a line break points at nothing.
        '<div class="tc-panel">' + STEPS(1)
        + '<div class="tc-split"><div class="tc-stack">'
        + '<p class="tc-hint">Single use · expires ' + esc(when(data.expiresAt))
        + '. The token lives in the link fragment — treat it as a credential.</p>'
        + '<div class="tc-copyrow">'
        + '<div class="tc-linkbox">' + esc(data.pairUrl) + '</div>'
        + '<button type="button" class="tc-btn tc-btn--outline" data-copy="'
        + esc(data.pairUrl) + '" data-copy-msg="Pairing link copied">Copy</button>'
        + '<a class="tc-btn tc-btn--outline" href="' + esc(data.pairUrl)
        + '" target="_blank" rel="noopener">Open</a>'
        + '</div>'
        // Desktop clients that add a remote environment ask for the server URL
        // and the code as separate fields, so the token is offered on its own
        // rather than only inside the link fragment.
        + (data.credential
          ? '<div class="tc-field"><label class="tc-label">Pair code</label>'
            + '<div class="tc-copyrow">'
            + '<div class="tc-linkbox">' + esc(data.credential) + '</div>'
            + '<button type="button" class="tc-btn tc-btn--outline" data-copy="'
            + esc(data.credential) + '" data-copy-msg="Pair code copied">Copy</button>'
            + '</div>'
            + '<span class="tc-hint">For clients that ask for a server URL and a code '
            + 'separately. The server URL is the public URL above.</span></div>'
          : '')
        + '</div>'
        + (data.qr ? '<div class="tc-qr">' + data.qr + '</div>' : '')
        + '</div></div>';
      $('label').value = '';
      load();
    } catch (error) {
      $('out').innerHTML = '<div class="tc-notice tc-notice--err">' + esc(error.message) + '</div>';
    }
    button.disabled = false;
  };

  // ------------------------------------------------------------- strip --
  const readout = (label, value) =>
    '<div class="tc-readout"><span class="tc-readout-label">' + label
    + '</span><span class="tc-readout-value">' + value + '</span></div>';

  const renderStrip = (s) => {
    const build = s.image && s.image.version
      ? s.image.version + (s.image.variant ? ' · ' + s.image.variant : '')
      : 'unversioned';
    $('strip').innerHTML =
      readout('Server', s.server.ok
        ? '<span class="tc-dot tc-dot--live" style="color:var(--ok-fg)"></span>Running '
          + esc(s.server.version)
        : '<span class="tc-dot" style="background:var(--err-fg)"></span>' + esc(s.server.detail))
      + readout('Image', '<span class="tc-mono">' + esc(build) + '</span>')
      + readout('Public URL', s.publicUrl
        ? '<a class="tc-mono tc-truncate tc-urllink" style="max-width:210px" href="'
          + esc(s.publicUrl) + '" target="_blank" rel="noopener">' + esc(s.publicUrl)
          + '</a><button type="button" class="tc-iconbtn" style="width:22px;height:22px"'
          + ' data-copy="' + esc(s.publicUrl) + '" data-copy-msg="Public URL copied"'
          + ' aria-label="Copy public URL">' + COPY_ICON + '</button>'
        : '<span class="tc-chip tc-chip--warn" style="height:auto;padding:1px 8px">Not set</span>')
      + readout('Devices', '<span class="tc-mono">' + s.sessions.length + '</span> paired');
  };

  const renderDetails = (s) => {
    const item = (label, value) =>
      '<div class="tc-details-item"><span class="tc-details-label">' + label
      + '</span><span class="tc-details-value">' + value + '</span></div>';
    $('details').innerHTML =
      item('State volume', '<span class="tc-mono">' + esc(s.paths?.volume || '—') + '</span>')
      + item('Workspace', '<span class="tc-mono">' + esc(s.paths?.workspace || '—') + '</span>')
      + item('Pair TTL', '<span class="tc-mono">' + esc(s.paths?.pairTtl || '30d')
        + '</span> default')
      + item('Agent credentials', '<span class="tc-mono">'
        + esc(s.paths?.agents || '—') + '</span>')
      + (s.publicUrl ? '' : item('Pairing',
          '<span style="color:var(--warn-fg)">Without T3_PUBLIC_URL, links point at this '
          + "container's own address and no device can reach them</span>"));
  };

  // ------------------------------------------------------------ agents --
  // The Agents and Toolchains cards are thin surfaces over the shared harness
  // manager (via /status): exact versions, runnable state, the operation in
  // flight, and how the last one ended. Lifecycle POSTs answer as soon as the
  // work holds the lock and finish in the background, so a click is tracked
  // here by key ("harness:claude", "toolchain:rust") until /status says how
  // it ended.
  const versionDrafts = new Map();
  const lifecycleBusy = new Set();   // POST in flight
  const pendingOps = new Map();      // accepted (202), waiting on /status
  const notices = new Map();         // last error or warning per key: {text, tone}
  let lastStatus = null;             // the last /status, to redraw a row at once
  const DONE = { install: 'Installed', update: 'Updated', uninstall: 'Uninstalled' };
  const WORKING = { install: 'Installing…', update: 'Updating…', uninstall: 'Removing…' };

  const setupItem = (s, kind, id) =>
    ((s.setup && s.setup.items) || []).find((i) => i.kind === kind && i.id === id) || null;
  const queued = (s, kind, id) => {
    const item = setupItem(s, kind, id);
    return Boolean(s.setup && s.setup.state === 'running' && item && item.state === 'pending');
  };
  const runningOp = (s, key) => {
    const op = (s.operations || {})[key];
    return op && op.state === 'running' ? op.kind : null;
  };
  const isBusy = (s, key, facts) =>
    lifecycleBusy.has(key) || pendingOps.has(key) || Boolean(runningOp(s, key)) || Boolean(facts.inProgress);

  // A click accepted earlier has finished: say how, once.
  const factsFor = (s, key) => {
    const [target, id] = key.split(':');
    const list = target === 'harness' ? s.harnesses : (s.toolchains || []);
    return list.find((x) => x.id === id) || {};
  };
  const settleOperations = (s) => {
    for (const [key, pending] of pendingOps) {
      const op = (s.operations || {})[key];
      if (!op) {
        // The setup service restarted and forgot it. Once nothing is running
        // for this row any more, stop waiting: the row shows where it ended.
        if (Date.now() - pending.at > 10000 && !factsFor(s, key).inProgress) {
          pendingOps.delete(key);
          notices.set(key, { tone: 'warn', text: 'The setup service restarted during this '
            + pending.kind + '; the row shows where it ended up.' });
        }
        continue;
      }
      if (op.state === 'running') continue;
      pendingOps.delete(key);
      if (op.state === 'ok') {
        if (op.warning) notices.set(key, { tone: 'warn', text: op.warning });
        else notices.delete(key);
        toast(DONE[op.kind] + ' ' + pending.name, CHECK);
      } else {
        notices.set(key, { tone: 'err', text: op.error || ('Could not ' + op.kind + ' ' + pending.name) });
      }
    }
  };
  const noticeLine = (key) => {
    const notice = notices.get(key);
    return notice
      ? '<span style="color:var(--' + (notice.tone === 'warn' ? 'warn' : 'err') + '-fg)">'
        + esc(notice.text) + '</span>'
      : '';
  };
  // Show the click as taken straight away, without waiting on /status.
  const redrawRows = () => {
    if (!lastStatus) return;
    renderToolchains(lastStatus);
    if (!panelActive) renderAgents(lastStatus);
  };

  const callLifecycle = async (target, kind, id, name) => {
    const key = target + ':' + id;
    const version = target === 'harness' ? (versionDrafts.get(id) ?? '').trim() : '';
    notices.delete(key);
    lifecycleBusy.add(key);
    redrawRows();
    try {
      const res = await fetch(BASE + '/' + (target === 'harness' ? 'harnesses' : 'toolchains') + '/' + kind, {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify(version ? {id, version} : {id}),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 202) {
        pendingOps.set(key, { kind, name, at: Date.now() });
        versionDrafts.delete(id);
      } else if (!res.ok || data.ok === false) {
        notices.set(key, { tone: 'err', text: data.error || ('Could not ' + kind + ' ' + name) });
      } else {
        versionDrafts.delete(id);
        toast(DONE[kind] + ' ' + name, CHECK);
      }
    } catch (error) {
      notices.set(key, { tone: 'err', text: String(error.message || error) });
    } finally {
      lifecycleBusy.delete(key);
    }
    load();
  };

  const confirmUninstall = (target, id, name) => confirmDialog({
    title: 'Uninstall ' + name + '?',
    body: target === 'harness'
      ? 'The managed executable is removed. Credentials stay, so installing it again signs straight back in.'
      : 'It is removed from the volume. A project that pins its own version still gets it from mise.',
    confirmLabel: 'Uninstall',
    onConfirm: () => callLifecycle(target, 'uninstall', id, name),
  });

  const agentChip = (s, h) => {
    const key = 'harness:' + h.id;
    const op = runningOp(s, key) || (pendingOps.get(key) || {}).kind || (h.inProgress ? h.operation : null);
    if (op || lifecycleBusy.has(key)) return chip('info', WORKING[op] || 'Working…');
    if (queued(s, 'agent', h.id)) return chip('idle', 'Queued');
    if (!h.supported) return chip('idle', 'No build for this arch');
    if (!h.installed) return h.failed ? chip('bad', 'Install failed') : chip('idle', 'Not installed');
    if (h.runnable && h.signedIn === true) return chip('ok', 'Signed in');
    if (h.runnable && h.signedIn === false) return chip('warn', 'Not signed in');
    if (h.runnable) return chip('idle', 'Installed');
    return chip('bad', 'Not runnable');
  };

  const failureLine = (facts) => {
    if (!facts.failed || !facts.failure) return '';
    // A failed update leaves the previous release in place; say which happened.
    const text = facts.installed && facts.operation && facts.operation !== 'install'
      ? 'Last ' + facts.operation + ' failed: ' + facts.failure
      : facts.failure;
    return '<span style="color:var(--err-fg)">' + esc(text.slice(0, 220)) + '</span>';
  };

  const agentMeta = (h) => {
    const lines = [];
    if (h.version) lines.push('<span class="tc-mono">' + esc(h.version) + '</span>');
    const failure = failureLine(h);
    if (failure) lines.push(failure);
    const notice = noticeLine('harness:' + h.id);
    if (notice) lines.push(notice);
    // How each one authenticates, so a button press holds no surprises.
    const how = h.canSignIn && h.canSetKey ? 'Browser sign-in, or a stored API key'
      : h.canSignIn ? 'Browser sign-in'
      : h.canSetKey ? 'API key, per provider' : '';
    if (how && h.runnable) lines.push(esc(how));
    return lines.length
      ? '<div class="tc-row-meta">' + lines.join('<br>') + '</div>' : '';
  };

  const renderAgents = (s) => {
    settleOperations(s);
    const signed = s.harnesses.filter((h) => h.signedIn === true).length;
    $('agent-count').textContent = signed + ' of ' + s.harnesses.length + ' signed in';
    // Preserve version drafts across the periodic re-render: without this the
    // poll wipes an explicit version mid-typing.
    for (const input of document.querySelectorAll('.hv-version')) {
      if (input.dataset.agent) versionDrafts.set(input.dataset.agent, input.value);
    }
    $('agents').innerHTML = s.harnesses.map((h) => {
      const busy = isBusy(s, 'harness:' + h.id, h) || queued(s, 'agent', h.id);
      const draft = versionDrafts.get(h.id) ?? '';
      const versionInput = '<input class="tc-input tc-input--mono tc-input--sm hv-version"'
        + ' data-agent="' + h.id + '" placeholder="latest" aria-label="Version for ' + esc(h.name) + '"'
        + ' value="' + esc(draft) + '" style="width:7.5rem" />';
      let lifecycle = '';
      if (busy) {
        lifecycle = '<button type="button" class="tc-btn tc-btn--ghost tc-btn--sm" disabled'
          + ' aria-label="Working"><span class="tc-spin"></span></button>';
      } else if (!h.installed) {
        lifecycle = versionInput
          + '<button type="button" class="tc-btn tc-btn--primary tc-btn--sm h-install"'
          + ' data-agent="' + h.id + '">' + (h.failed ? 'Retry' : 'Install') + '</button>';
      } else {
        lifecycle = versionInput
          + '<button type="button" class="tc-btn tc-btn--outline tc-btn--sm h-update"'
          + ' data-agent="' + h.id + '">Update</button>'
          + '<button type="button" class="tc-btn tc-btn--ghost tc-btn--sm h-uninstall"'
          + ' data-agent="' + h.id + '">Uninstall</button>';
      }
      const signin = h.runnable && !busy
        ? (h.canSignIn
            ? '<button type="button" class="tc-btn tc-btn--ghost tc-btn--sm signin"'
              + ' data-agent="' + h.id + '">Sign in</button>' : '')
          + (h.canSetKey
            ? '<button type="button" class="tc-btn tc-btn--outline tc-btn--sm setkey"'
              + ' data-agent="' + h.id + '" data-kind="' + esc(h.keyKind) + '">API key</button>' : '')
        : '';
      return '<div class="tc-row">'
        + '<span class="tc-tile' + (h.signedIn === true ? ' tc-tile--signed' : '')
        + '" style="--tile:var(--id-' + h.id + ')" aria-hidden="true">'
        + esc(initials(h.name)) + '</span>'
        + '<div class="tc-row-main"><div class="tc-row-nameline">'
        + '<span class="tc-row-name">' + esc(h.name) + '</span>' + agentChip(s, h) + '</div>'
        + agentMeta(h) + '</div>'
        + '<div class="tc-row-actions tc-row-actions--wrap">' + lifecycle + signin + '</div>'
        + '<div class="tc-row-panel" id="agent-' + h.id + '"></div></div>';
    }).join('');

    const nameOf = (id) => (s.harnesses.find((h) => h.id === id) || {}).name || id;
    for (const input of document.querySelectorAll('.hv-version')) {
      input.oninput = () => versionDrafts.set(input.dataset.agent, input.value);
      input.onkeydown = (e) => { if (e.key === 'Enter') e.preventDefault(); };
    }
    for (const b of document.querySelectorAll('.h-install')) {
      b.onclick = () => callLifecycle('harness', 'install', b.dataset.agent, nameOf(b.dataset.agent));
    }
    for (const b of document.querySelectorAll('.h-update')) {
      b.onclick = () => callLifecycle('harness', 'update', b.dataset.agent, nameOf(b.dataset.agent));
    }
    for (const b of document.querySelectorAll('.h-uninstall')) {
      b.onclick = () => confirmUninstall('harness', b.dataset.agent, nameOf(b.dataset.agent));
    }
  };

  // -------------------------------------------------------- toolchains --
  const renderToolchains = (s) => {
    settleOperations(s);
    const list = s.toolchains || [];
    const installed = list.filter((t) => t.installed).length;
    $('toolchain-count').textContent = list.length ? installed + ' of ' + list.length + ' installed' : '';
    if (!list.length) {
      $('toolchains').innerHTML = '<div class="tc-row"><div class="tc-row-meta">'
        + 'Toolchain state is not readable right now.</div></div>';
      return;
    }
    $('toolchains').innerHTML = list.map((t) => {
      const key = 'toolchain:' + t.id;
      const op = runningOp(s, key) || (pendingOps.get(key) || {}).kind || (t.inProgress ? t.operation : null);
      const waiting = queued(s, 'toolchain', t.id);
      const busy = isBusy(s, key, t) || waiting;
      const state = op || lifecycleBusy.has(key) ? chip('info', WORKING[op] || 'Working…')
        : waiting ? chip('idle', 'Queued')
        : t.installed ? chip('ok', 'Installed')
        : t.failed ? chip('bad', 'Install failed') : chip('idle', 'Not installed');
      const lines = [];
      if (t.version) lines.push('<span class="tc-mono">' + esc(t.version) + '</span>');
      const failure = failureLine(t);
      if (failure) lines.push(failure);
      const notice = noticeLine(key);
      if (notice) lines.push(notice);
      const actions = busy
        ? '<button type="button" class="tc-btn tc-btn--ghost tc-btn--sm" disabled'
          + ' aria-label="Working"><span class="tc-spin"></span></button>'
        : t.installed
          ? '<button type="button" class="tc-btn tc-btn--outline tc-btn--sm t-update" data-tool="'
            + t.id + '">Update</button>'
            + '<button type="button" class="tc-btn tc-btn--ghost tc-btn--sm t-uninstall" data-tool="'
            + t.id + '">Uninstall</button>'
          : '<button type="button" class="tc-btn tc-btn--primary tc-btn--sm t-install" data-tool="'
            + t.id + '">' + (t.failed ? 'Retry' : 'Install') + '</button>';
      return '<div class="tc-row">'
        + '<span class="tc-tile" style="--tile:var(--id-toolchain)" aria-hidden="true">'
        + esc(initials(t.name)) + '</span>'
        + '<div class="tc-row-main"><div class="tc-row-nameline">'
        + '<span class="tc-row-name">' + esc(t.name) + '</span>' + state + '</div>'
        + (lines.length ? '<div class="tc-row-meta">' + lines.join('<br>') + '</div>' : '')
        + '</div><div class="tc-row-actions tc-row-actions--wrap">' + actions + '</div></div>';
    }).join('');

    const nameOf = (id) => (list.find((t) => t.id === id) || {}).name || id;
    for (const b of document.querySelectorAll('.t-install')) {
      b.onclick = () => callLifecycle('toolchain', 'install', b.dataset.tool, nameOf(b.dataset.tool));
    }
    for (const b of document.querySelectorAll('.t-update')) {
      b.onclick = () => callLifecycle('toolchain', 'update', b.dataset.tool, nameOf(b.dataset.tool));
    }
    for (const b of document.querySelectorAll('.t-uninstall')) {
      b.onclick = () => confirmUninstall('toolchain', b.dataset.tool, nameOf(b.dataset.tool));
    }
  };

  // ------------------------------------------------------------- setup --
  // The first start installs everything T3_PREINSTALL names in the
  // background. Say so at the top of the page while it runs, and afterwards
  // only if something failed.
  const renderSetup = (s) => {
    const el = $('setup-progress');
    if (!el) return;
    const setup = s.setup;
    const items = (setup && setup.items) || [];
    if (!items.length) { el.innerHTML = ''; return; }
    const done = items.filter((i) => i.state === 'done').length;
    // After a finished run, anything still pending was not tried: the run
    // stops after three failures in a row, which is nearly always no network.
    const failed = items.filter((i) => i.state === 'failed'
      || (setup.state === 'finished' && i.state === 'pending'));
    if (setup.state === 'running') {
      const current = items.find((i) => i.state === 'installing');
      el.innerHTML = '<div class="tc-notice tc-notice--info"><span class="tc-spin" aria-hidden="true"></span>'
        + '<div><strong>Setting up this container</strong> &mdash; '
        + (current ? 'installing ' + esc(current.name) : 'checking what is already here')
        + ' (' + done + ' of ' + items.length + ' done). Agents and toolchains install once,'
        + ' onto the volume, and each one is ready below as soon as it finishes.</div></div>';
    } else if (failed.length) {
      el.innerHTML = '<div class="tc-notice tc-notice--warn"><div>Could not install '
        + esc(failed.map((i) => i.name).join(', ')) + ' on first start'
        + (failed[0].error ? ' (' + esc(failed[0].error.slice(0, 140)) + ')' : '')
        + '. Press Retry on the row to try again now; the next restart retries as well.</div></div>';
    } else if (setup.state === 'interrupted') {
      el.innerHTML = '<div class="tc-notice tc-notice--quiet">First-start setup stopped part way'
        + ' (' + done + ' of ' + items.length + ' done). It carries on the next time the container starts.</div>';
    } else {
      el.innerHTML = '';
    }
  };

  // ----------------------------------------------------------- sessions --
  const revokeButton = (kind, id, label) =>
    '<button type="button" class="tc-btn tc-btn--danger tc-btn--sm revoke" data-kind="'
    + kind + '" data-id="' + esc(id) + '" data-label="' + esc(label) + '">Revoke</button>';

  const renderSessions = (s) => {
    const links = s.pairings.length;
    // Next to the button that makes another one, how many are already unredeemed.
    $('paircount').textContent = links
      ? links + (links === 1 ? ' link unused' : ' links unused') : '';

    $('sessioncount').textContent =
      s.sessions.length + (s.sessions.length === 1 ? ' device' : ' devices')
      + ' · ' + links + (links === 1 ? ' unused link' : ' unused links');

    $('clients').innerHTML = s.sessions.length
      ? s.sessions.map((c) => {
          const name = c.client?.label || c.subject || c.sessionId;
          return '<div class="tc-row"><div class="tc-row-main"><div class="tc-row-nameline">'
            + '<span class="tc-row-name">' + esc(name) + '</span>'
            + (c.connected ? chip('ok', 'Connected') : '') + '</div>'
            + '<div class="tc-row-meta" title="Expires ' + esc(when(c.expiresAt)) + '">'
            + (c.connected ? 'Expires ' + esc(ago(c.expiresAt))
                : 'Last seen ' + esc(ago(c.lastConnectedAt))
                  + ' · expires ' + esc(ago(c.expiresAt)))
            + '</div></div><div class="tc-row-actions">'
            + revokeButton('session', c.sessionId, name) + '</div></div>';
        }).join('')
      : '<div class="tc-empty tc-empty--compact">No devices paired yet.<br>'
        + 'Create a link above to add one.</div>';

    $('links').innerHTML = links
      ? s.pairings.map((l) => {
          const name = l.label || 'Unlabelled';
          return '<div class="tc-row"><div class="tc-row-main">'
            + '<div class="tc-row-nameline"><span class="tc-row-name">' + esc(name) + '</span></div>'
            + '<div class="tc-row-meta" title="' + esc(when(l.expiresAt)) + '">Expires '
            + esc(ago(l.expiresAt)) + '</div></div><div class="tc-row-actions">'
            + revokeButton('pairing', l.id, name) + '</div></div>';
        }).join('')
      : '<div class="tc-empty tc-empty--compact">None outstanding.<br>'
        + 'Every link created has been redeemed.</div>';
  };

  // ---------------------------------------------------- pairing progress --
  // The tracker painted at mint time used to sit on "Device connects" forever,
  // even after the phone had paired - nothing ever repainted it. Watch the
  // session list instead, and hand the user onward the moment their device
  // lands, or tell them when the link they are looking at can no longer work.
  const renderPairProgress = (s) => {
    if (!minted || minted.paired) return;
    if (minted.baseline === null) {
      minted.baseline = new Set(s.sessions.map((c) => c.sessionId));
      return;
    }

    const fresh = s.sessions.find((c) => !minted.baseline.has(c.sessionId));
    if (fresh) {
      minted.paired = true;
      const name = fresh.client?.label || fresh.subject || 'your device';
      $('out').innerHTML =
        '<div class="tc-panel">' + STEPS(3)
        + '<div class="tc-split"><div class="tc-stack">'
        + '<p class="tc-hint">Paired with <strong>' + esc(name) + '</strong>. '
        + 'You can close this page - the device is already signed in.</p>'
        + '<div class="tc-copyrow">'
        + '<a class="tc-btn tc-btn--primary" href="' + esc(s.publicUrl || '/')
        + '" target="_blank" rel="noopener">Open T3 Code</a></div>'
        + '</div></div></div>';
      toast('Device paired', CHECK);
      return;
    }

    const listed = s.pairings.some((l) => l.id === minted.id);
    if (listed) minted.seen = true;
    const expired = minted.expiresAt && Date.parse(minted.expiresAt) < Date.now();
    if (expired) {
      minted.paired = true;
      $('out').innerHTML =
        '<div class="tc-panel">' + STEPS(1)
        + '<div class="tc-split"><div class="tc-stack">'
        + '<p class="tc-hint">This link expired before a device used it. '
        + 'Create another one to pair.</p>'
        + '</div></div></div>';
      return;
    }
    // Only call it revoked once the list has shown the link at least once: the
    // status read that follows a mint can land before the pairing is listed.
    if (minted.seen && !listed) {
      minted.paired = true;
      $('out').innerHTML =
        '<div class="tc-panel">' + STEPS(1)
        + '<div class="tc-split"><div class="tc-stack">'
        + '<p class="tc-hint">This link was revoked before a device used it. '
        + 'Create another one to pair.</p>'
        + '</div></div></div>';
    }
  };

  // -------------------------------------------------------------- ports --
  // Polled separately from the rest of the page and on a shorter interval: a
  // tunnel takes a few seconds to be handed a hostname, and a port appearing
  // moments after a dev server starts is the whole point. This calls the same
  // /ports API t3-expose calls, so publishing from a terminal shows up here
  // without anything having to tell the page about it.
  const qrOpen = new Set();
  const portsBusy = new Set();

  const loadPorts = async () => {
    let data;
    try { data = await (await fetch(BASE + '/ports')).json(); } catch { return; }

    if (data.available === false) {
      $('portnote').textContent = 'cloudflared is not in this image';
      $('ports').innerHTML = '<div class="tc-empty tc-empty--compact">'
        + 'Publishing is unavailable in this build.</div>';
      $('portfoot').hidden = true;
      return;
    }

    const tunnels = new Map((data.tunnels || []).map((t) => [t.port, t]));
    const ports = [...new Set([...(data.listening || []), ...tunnels.keys()])]
      .sort((a, b) => a - b);
    const open = [...tunnels.values()].filter((t) => t.state === 'open').length;
    $('portnote').textContent = open ? open + ' published' : '';
    $('portfoot').hidden = !open;

    if (!ports.length) {
      $('ports').innerHTML = '<div class="tc-empty tc-empty--compact">Nothing is listening yet.'
        + '<br>Start a dev server and it will appear here.</div>';
      return;
    }

    $('ports').innerHTML = ports.map((port) => {
      const t = tunnels.get(port);
      const state = t ? t.state : 'idle';
      const busy = portsBusy.has(port);

      let chipHtml = '', meta = 'Listening in the container', actions = '', panel = '';
      if (state === 'open') {
        chipHtml = chip('info', 'Published');
        meta = '<span class="tc-mono tc-truncate">' + esc(t.url) + '</span>';
        actions = '<a class="tc-btn tc-btn--outline tc-btn--sm" href="' + esc(t.url)
          + '" target="_blank" rel="noopener">Open</a>'
          + '<button type="button" class="tc-btn tc-btn--ghost tc-btn--sm portqr"'
          + ' data-port="' + port + '">QR code</button>'
          + '<button type="button" class="tc-btn tc-btn--ghost tc-btn--sm unexpose"'
          + ' data-port="' + port + '">Stop</button>';
        if (qrOpen.has(port) && t.qr) {
          panel = '<div class="tc-row-panel"><div class="tc-panel"><div class="tc-split">'
            + '<div class="tc-stack"><p class="tc-hint">Scan to open port ' + port
            + ' on another device.</p><div class="tc-copyrow">'
            + '<div class="tc-linkbox">' + esc(t.url) + '</div>'
            + '<button type="button" class="tc-btn tc-btn--outline" data-copy="' + esc(t.url)
            + '" data-copy-msg="Published URL copied">Copy</button></div></div>'
            + '<div class="tc-qr">' + t.qr + '</div></div></div></div>';
        }
      } else if (state === 'starting' || busy) {
        chipHtml = chip('idle', 'Publishing');
        meta = 'Waiting for a public hostname…';
        actions = '<button type="button" class="tc-btn tc-btn--ghost tc-btn--sm" disabled>'
          + '<span class="tc-spin"></span></button>';
      } else if (state === 'failed') {
        chipHtml = chip('bad', 'Failed');
        meta = '<span style="color:var(--err-fg)">' + esc(t.error || 'the tunnel failed') + '</span>';
        actions = '<button type="button" class="tc-btn tc-btn--outline tc-btn--sm expose"'
          + ' data-port="' + port + '">Retry</button>';
      } else {
        actions = '<button type="button" class="tc-btn tc-btn--outline tc-btn--sm expose"'
          + ' data-port="' + port + '">Publish</button>';
      }

      return '<div class="tc-row">'
        + '<span class="tc-tile tc-tile--port'
        + (String(port).length > 4 ? ' tc-tile--port-wide' : '')
        + '" aria-hidden="true">' + port + '</span>'
        + '<div class="tc-row-main"><div class="tc-row-nameline">'
        + '<span class="tc-row-name">Port ' + port + '</span>' + chipHtml + '</div>'
        + '<div class="tc-row-meta">' + meta + '</div></div>'
        + '<div class="tc-row-actions">' + actions + '</div>' + panel + '</div>';
    }).join('');

    for (const b of $('ports').querySelectorAll('.expose')) {
      b.onclick = async () => {
        const port = Number(b.dataset.port);
        portsBusy.add(port);
        b.disabled = true;
        try {
          await fetch(BASE + '/ports/expose', {
            method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify({port}),
          });
        } finally { portsBusy.delete(port); }
        loadPorts();
      };
    }
    for (const b of $('ports').querySelectorAll('.unexpose')) {
      b.onclick = async () => {
        const port = Number(b.dataset.port);
        b.disabled = true;
        qrOpen.delete(port);
        await fetch(BASE + '/ports/unexpose', {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({port}),
        });
        loadPorts();
      };
    }
    for (const b of $('ports').querySelectorAll('.portqr')) {
      b.onclick = () => {
        const port = Number(b.dataset.port);
        if (qrOpen.has(port)) qrOpen.delete(port); else qrOpen.add(port);
        loadPorts();
      };
    }
  };

  // --------------------------------------------------------------- load --
  let fastPoll = null;
  const load = async () => {
    let s;
    try {
      const res = await fetch(BASE + '/status');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      s = await res.json();
      lastStatus = s;
    } catch (error) {
      // Name the URL and the reason. "Could not read status" sent someone
      // hunting a migration bug when the page was calling the wrong path.
      $('strip').innerHTML = '<div class="tc-notice tc-notice--err">'
        + 'Could not read status from <span class="tc-mono">' + esc(BASE + '/status')
        + '</span> &mdash; ' + esc(error.message) + '.'
        + (BASE ? '' : ' If this page is served under a path prefix, set '
            + '<span class="tc-mono">T3_SETUP_BASE_PATH</span>.')
        + '</div>';
      return;
    }

    // Baselines for the next mint: what the next new session will be measured
    // against.
    lastSessions = s.sessions.map((c) => c.sessionId);

    const build = s.image && s.image.version
      ? s.image.version + (s.image.variant ? ' · ' + s.image.variant : '')
      : 'unversioned build';
    $('build').textContent = build;
    $('health').innerHTML = s.server.ok
      ? '<span class="tc-dot tc-dot--live" style="color:var(--ok-fg)"></span>Running '
        + esc(s.server.version)
      : '<span class="tc-dot" style="background:var(--err-fg)"></span>Server down';

    // A part that could not be read says so, instead of rendering as "none".
    // A stale harness answer says so too: the sign-in state below is the last
    // definite verdict, not a fresh probe (offline the refresh exceeds its
    // budget and warms the next poll instead). Never render it as current.
    const note = $('degraded');
    if (note) {
      const staleHarness = s.harnessCache && s.harnessCache.stale
        && (s.harnessCache.source === 'cache' || s.harnessCache.source === 'cheap');
      note.innerHTML = ((s.degraded || []).length
        ? '<div class="tc-notice tc-notice--warn">Could not read '
          + esc(s.degraded.map((d) => d.what).join(', '))
          + '. Shown below as empty; the container may still be starting.</div>'
        : '')
        + (staleHarness
          ? '<div class="tc-notice tc-notice--quiet">Harness sign-in state is cached'
            + ' while a fresh probe finishes — it refreshes on the next poll.</div>'
          : '');
    }

    renderStrip(s);
    renderSessions(s);
    renderPairProgress(s);
    renderDetails(s);
    renderSetup(s);
    renderToolchains(s);
    if (!panelActive) renderAgents(s);

    // Poll faster while something is installing, so a row flips to Installed
    // within seconds of finishing rather than on the next 15 s tick.
    const active = (s.setup && s.setup.state === 'running') || pendingOps.size > 0
      || s.harnesses.some((h) => h.inProgress) || (s.toolchains || []).some((t) => t.inProgress);
    clearTimeout(fastPoll);
    if (active) fastPoll = setTimeout(load, 3000);

    for (const b of document.querySelectorAll('.revoke')) {
      b.onclick = () => confirmDialog({
        title: b.dataset.kind === 'session' ? 'Revoke this device?' : 'Revoke this link?',
        body: b.dataset.kind === 'session'
          ? '<strong>' + esc(b.dataset.label) + '</strong> loses access immediately and has to '
            + 'be paired again with a new link.'
          : '<strong>' + esc(b.dataset.label) + '</strong> has not been redeemed yet. '
            + 'Revoking it means the link stops working.',
        confirmLabel: 'Revoke',
        onConfirm: async () => {
          b.disabled = true;
          await fetch(BASE + '/revoke', {
            method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify({kind: b.dataset.kind, id: b.dataset.id}),
          });
          toast('Revoked');
          load();
        },
      });
    }

    if (panelActive) return;

    // The provider list is fetched once and reused: it is the same for every
    // agent row and does not change while the page is open.
    let providerList = null;
    const loadProviders = async () => {
      if (providerList) return providerList;
      try { providerList = await (await fetch(BASE + '/providers')).json(); }
      catch { providerList = {providers: [], configured: []}; }
      return providerList;
    };

    for (const b of document.querySelectorAll('.setkey')) {
      b.onclick = async () => {
        const agent = b.dataset.agent;
        const needsProvider = b.dataset.kind === 'opencode';
        let providerField = '';
        if (needsProvider) {
          b.disabled = true;
          const {providers, configured} = await loadProviders();
          b.disabled = false;
          const done = new Set(configured || []);
          const opts = (providers || []).map((p) =>
            '<option value="' + esc(p.id) + '">' + esc(p.name)
            + (done.has(p.id) ? ' ✓' : '') + '</option>').join('');
          providerField =
            '<div class="tc-field"><label class="tc-label">Provider</label>'
            + '<select class="tc-select pv">'
            + '<option value="">Choose a provider' + (opts ? '' : ' (catalog unavailable)')
            + '</option>' + opts + '<option value="__custom">Other — type an id</option></select>'
            + '<input class="tc-input pv-custom" placeholder="Provider id, e.g. deepseek"'
            + ' style="display:none;margin-top:8px" /></div>';
        }
        panelActive = agent;
        $('agent-' + agent).innerHTML =
          '<div class="tc-panel"><div class="tc-stack">' + providerField
          + '<div class="tc-field"><label class="tc-label">API key</label>'
          + '<input class="tc-input tc-input--mono kv-key" type="password"'
          + ' placeholder="Paste the key" />'
          + '<span class="tc-hint">Written to this container\'s state volume, never sent '
          + 'anywhere else.</span></div>'
          + '<div class="tc-cluster">'
          + '<button type="button" class="tc-btn tc-btn--primary tc-btn--sm save">Save</button>'
          + '<button type="button" class="tc-btn tc-btn--ghost tc-btn--sm cancelkey">Cancel</button>'
          + '</div><div class="out"></div></div></div>';
        const box = $('agent-' + agent);
        // Closing is what lets the list start refreshing again, so it needs to
        // be reachable without saving something.
        box.querySelector('.cancelkey').onclick = () => {
          panelActive = null; box.innerHTML = ''; load();
        };
        const sel = box.querySelector('.pv');
        const custom = box.querySelector('.pv-custom');
        if (sel) sel.onchange = () => {
          const isCustom = sel.value === '__custom';
          custom.style.display = isCustom ? '' : 'none';
          if (isCustom) custom.focus();
        };
        box.querySelector('.save').onclick = async (e) => {
          e.target.disabled = true;
          const body = {agent, key: box.querySelector('.kv-key').value};
          if (sel) body.provider = sel.value === '__custom' ? custom.value.trim() : sel.value;
          const res = await fetch(BASE + '/auth/apikey', {
            method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify(body),
          });
          const data = await res.json();
          box.querySelector('.out').innerHTML = res.ok
            ? '<div class="tc-notice tc-notice--ok">Saved.</div>'
            : '<div class="tc-notice tc-notice--err">' + esc(data.error) + '</div>';
          e.target.disabled = false;
          // Leave a failed attempt on screen with the key still in it; only a
          // success closes the form and lets the list resume.
          if (res.ok) { toast('API key saved', CHECK); panelActive = null; setTimeout(load, 600); }
        };
      };
    }

    for (const b of document.querySelectorAll('.signin')) {
      b.onclick = async () => {
        const agent = b.dataset.agent;
        const agentName = b.closest('.tc-row')?.querySelector('.tc-row-name')?.textContent
          || 'the agent';
        b.disabled = true;
        const box = $('agent-' + agent);
        // An empty rounded box for the several seconds a CLI takes to produce
        // a URL reads as a bug. Say what is happening.
        box.innerHTML = '<div class="tc-panel"><div class="tc-cluster">'
          + '<span class="tc-spin"></span>'
          + '<span class="tc-hint">Starting sign-in\u2026 waiting for '
          + esc(agentName) + ' to return a URL.</span></div></div>';
        const res = await fetch(BASE + '/auth/signin', {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({agent}),
        });
        const started = await res.json();
        if (!res.ok) {
          box.innerHTML = '<div class="tc-notice tc-notice--err">' + esc(started.error) + '</div>';
          b.disabled = false;
          return;
        }
        panelActive = agent;
        const finish = (html) => { panelActive = null; box.innerHTML = html; b.disabled = false; };
        let painted = false;
        const poll = async () => {
          const st = await (await fetch(BASE + '/auth/session?id=' + started.id)).json();
          if (st.state === 'done') {
            finish('<div class="tc-notice tc-notice--ok">Signed in.</div>');
            toast('Signed in', CHECK);
            load();
            return;
          }
          if (st.state === 'failed' || st.state === 'cancelled') {
            finish('<div class="tc-notice tc-notice--err">'
              + esc(st.error || 'Sign-in stopped') + '</div>');
            return;
          }
          // Paint once. Re-rendering on every poll would clear the code field
          // under whoever is pasting into it.
          if (st.url && !painted) {
            painted = true;
            // Two columns: the code you scan on the right, everything you read
            // or type on the left, so the QR stops pushing the field you
            // actually need down the page.
            box.innerHTML =
              '<div class="tc-panel"><div class="tc-split"><div class="tc-stack">'
              + '<p class="tc-hint">Open this on any device and approve.</p>'
              + '<div class="tc-copyrow">'
              + '<div class="tc-linkbox">' + esc(st.url) + '</div>'
              + '<button type="button" class="tc-btn tc-btn--outline" data-copy="' + esc(st.url)
              + '" data-copy-msg="Sign-in URL copied">Copy</button>'
              + '<a class="tc-btn tc-btn--outline" href="' + esc(st.url)
              + '" target="_blank" rel="noopener">Open</a></div>'
              + (st.code ? '<div class="tc-cluster">' + chip('idle', 'Confirm code ' + st.code)
                 + '</div>' : '')
              + (st.needsCode
                 ? '<div class="tc-field"><label class="tc-label">Code from your browser</label>'
                   + '<div class="tc-copyrow"><input class="tc-input tc-input--mono codein"'
                   + ' placeholder="Paste the code" />'
                   + '<button type="button" class="tc-btn tc-btn--primary sendcode">Submit</button>'
                   + '<button type="button" class="tc-btn tc-btn--ghost cancel">Cancel</button>'
                   + '</div></div>'
                 : '<div class="tc-cluster">'
                   + '<button type="button" class="tc-btn tc-btn--ghost tc-btn--sm cancel">'
                   + 'Cancel</button></div>')
              + '</div>'
              + (st.qr ? '<div class="tc-qr">' + st.qr + '</div>' : '')
              + '</div></div>';
            const send = box.querySelector('.sendcode');
            if (send) send.onclick = async () => {
              send.disabled = true;
              send.textContent = 'Submitting';
              await fetch(BASE + '/auth/code', {
                method: 'POST', headers: {'content-type': 'application/json'},
                body: JSON.stringify({id: started.id, code: box.querySelector('.codein').value}),
              });
            };
            box.querySelector('.cancel').onclick = async () => {
              await fetch(BASE + '/auth/cancel', {
                method: 'POST', headers: {'content-type': 'application/json'},
                body: JSON.stringify({id: started.id}),
              });
              finish('<div class="tc-notice tc-notice--quiet">Sign-in cancelled.</div>');
            };
          }
          setTimeout(poll, 2000);
        };
        poll();
      };
    }
  };

  load();
  loadPorts();
  setInterval(load, 15000);
  setInterval(loadPorts, 4000);
}
