/* @ds-bundle: {"format":4,"namespace":"T3C","components":[]} */
/* T3 Code Console v2: the behaviour layer. Vanilla, no framework, matching the
   shipped console (docker/setup/app.js). Markup carries the state; this file only
   wires icons and the few interactions every surface shares. */
(function () {
  var ICONS = {"layout-dashboard": "<rect width=\"7\" height=\"9\" x=\"3\" y=\"3\" rx=\"1\" /> <rect width=\"7\" height=\"5\" x=\"14\" y=\"3\" rx=\"1\" /> <rect width=\"7\" height=\"9\" x=\"14\" y=\"12\" rx=\"1\" /> <rect width=\"7\" height=\"5\" x=\"3\" y=\"16\" rx=\"1\" />", "smartphone": "<rect width=\"14\" height=\"20\" x=\"5\" y=\"2\" rx=\"2\" ry=\"2\" /> <path d=\"M12 18h.01\" />", "bot": "<path d=\"M12 8V4H8\" /> <rect width=\"16\" height=\"12\" x=\"4\" y=\"8\" rx=\"2\" /> <path d=\"M2 14h2\" /> <path d=\"M20 14h2\" /> <path d=\"M15 13v2\" /> <path d=\"M9 13v2\" />", "wrench": "<path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z\" />", "ethernet-port": "<path d=\"m15 20 3-3h2a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2l3 3z\" /> <path d=\"M6 8v1\" /> <path d=\"M10 8v1\" /> <path d=\"M14 8v1\" /> <path d=\"M18 8v1\" />", "settings-2": "<path d=\"M20 7h-9\" /> <path d=\"M14 17H5\" /> <circle cx=\"17\" cy=\"17\" r=\"3\" /> <circle cx=\"7\" cy=\"7\" r=\"3\" />", "search": "<circle cx=\"11\" cy=\"11\" r=\"8\" /> <path d=\"m21 21-4.3-4.3\" />", "command": "<path d=\"M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3\" />", "copy": "<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\" /> <path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\" />", "check": "<path d=\"M20 6 9 17l-5-5\" />", "x": "<path d=\"M18 6 6 18\" /> <path d=\"m6 6 12 12\" />", "external-link": "<path d=\"M15 3h6v6\" /> <path d=\"M10 14 21 3\" /> <path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\" />", "qr-code": "<rect width=\"5\" height=\"5\" x=\"3\" y=\"3\" rx=\"1\" /> <rect width=\"5\" height=\"5\" x=\"16\" y=\"3\" rx=\"1\" /> <rect width=\"5\" height=\"5\" x=\"3\" y=\"16\" rx=\"1\" /> <path d=\"M21 16h-3a2 2 0 0 0-2 2v3\" /> <path d=\"M21 21v.01\" /> <path d=\"M12 7v3a2 2 0 0 1-2 2H7\" /> <path d=\"M3 12h.01\" /> <path d=\"M12 3h.01\" /> <path d=\"M12 16v.01\" /> <path d=\"M16 12h1\" /> <path d=\"M21 12v.01\" /> <path d=\"M12 21v-1\" />", "ellipsis": "<circle cx=\"12\" cy=\"12\" r=\"1\" /> <circle cx=\"19\" cy=\"12\" r=\"1\" /> <circle cx=\"5\" cy=\"12\" r=\"1\" />", "circle-arrow-up": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"m16 12-4-4-4 4\" /> <path d=\"M12 16V8\" />", "download": "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\" /> <polyline points=\"7 10 12 15 17 10\" /> <line x1=\"12\" x2=\"12\" y1=\"15\" y2=\"3\" />", "trash-2": "<path d=\"M3 6h18\" /> <path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\" /> <path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\" /> <line x1=\"10\" x2=\"10\" y1=\"11\" y2=\"17\" /> <line x1=\"14\" x2=\"14\" y1=\"11\" y2=\"17\" />", "key-round": "<path d=\"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z\" /> <circle cx=\"16.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\" />", "log-in": "<path d=\"M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4\" /> <polyline points=\"10 17 15 12 10 7\" /> <line x1=\"15\" x2=\"3\" y1=\"12\" y2=\"12\" />", "plus": "<path d=\"M5 12h14\" /> <path d=\"M12 5v14\" />", "refresh-cw": "<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\" /> <path d=\"M21 3v5h-5\" /> <path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\" /> <path d=\"M8 16H3v5\" />", "circle-alert": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <line x1=\"12\" x2=\"12\" y1=\"8\" y2=\"12\" /> <line x1=\"12\" x2=\"12.01\" y1=\"16\" y2=\"16\" />", "triangle-alert": "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\" /> <path d=\"M12 9v4\" /> <path d=\"M12 17h.01\" />", "info": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"M12 16v-4\" /> <path d=\"M12 8h.01\" />", "circle-check": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"m9 12 2 2 4-4\" />", "loader-circle": "<path d=\"M21 12a9 9 0 1 1-6.219-8.56\" />", "sun": "<circle cx=\"12\" cy=\"12\" r=\"4\" /> <path d=\"M12 2v2\" /> <path d=\"M12 20v2\" /> <path d=\"m4.93 4.93 1.41 1.41\" /> <path d=\"m17.66 17.66 1.41 1.41\" /> <path d=\"M2 12h2\" /> <path d=\"M20 12h2\" /> <path d=\"m6.34 17.66-1.41 1.41\" /> <path d=\"m19.07 4.93-1.41 1.41\" />", "moon": "<path d=\"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z\" />", "monitor": "<rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\" /> <line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\" /> <line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\" />", "chevron-right": "<path d=\"m9 18 6-6-6-6\" />", "chevron-down": "<path d=\"m6 9 6 6 6-6\" />", "lock": "<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\" /> <path d=\"M7 11V7a5 5 0 0 1 10 0v4\" />", "link": "<path d=\"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\" /> <path d=\"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\" />", "globe": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\" /> <path d=\"M2 12h20\" />", "circle-stop": "<circle cx=\"12\" cy=\"12\" r=\"10\" /> <rect x=\"9\" y=\"9\" width=\"6\" height=\"6\" rx=\"1\" />", "activity": "<path d=\"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2\" />", "terminal": "<polyline points=\"4 17 10 11 4 5\" /> <line x1=\"12\" x2=\"20\" y1=\"19\" y2=\"19\" />", "server": "<rect width=\"20\" height=\"8\" x=\"2\" y=\"2\" rx=\"2\" ry=\"2\" /> <rect width=\"20\" height=\"8\" x=\"2\" y=\"14\" rx=\"2\" ry=\"2\" /> <line x1=\"6\" x2=\"6.01\" y1=\"6\" y2=\"6\" /> <line x1=\"6\" x2=\"6.01\" y1=\"18\" y2=\"18\" />", "shield-check": "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\" /> <path d=\"m9 12 2 2 4-4\" />", "eye": "<path d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\" /> <circle cx=\"12\" cy=\"12\" r=\"3\" />", "eye-off": "<path d=\"M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49\" /> <path d=\"M14.084 14.158a3 3 0 0 1-4.242-4.242\" /> <path d=\"M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143\" /> <path d=\"m2 2 20 20\" />", "laptop": "<path d=\"M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16\" />", "log-out": "<path d=\"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4\" /> <polyline points=\"16 17 21 12 16 7\" /> <line x1=\"21\" x2=\"9\" y1=\"12\" y2=\"12\" />", "arrow-right": "<path d=\"M5 12h14\" /> <path d=\"m12 5 7 7-7 7\" />", "history": "<path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\" /> <path d=\"M3 3v5h5\" /> <path d=\"M12 7v5l4 2\" />"};
  var SAMPLE = { qrPair: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 33 33\"><path stroke=\"#18181b\" d=\"M0 0.5h7m7 0h1m3 0h3m2 0h1m2 0h7m-33 1h1m5 0h1m2 0h4m2 0h1m1 0h1m2 0h3m1 0h1m1 0h1m5 0h1m-33 1h1m1 0h3m1 0h1m1 0h2m2 0h1m1 0h3m1 0h4m2 0h1m1 0h1m1 0h3m1 0h1m-33 1h1m1 0h3m1 0h1m1 0h5m2 0h1m1 0h1m1 0h2m1 0h3m1 0h1m1 0h3m1 0h1m-33 1h1m1 0h3m1 0h1m1 0h3m1 0h6m1 0h1m1 0h2m3 0h1m1 0h3m1 0h1m-33 1h1m5 0h1m1 0h1m1 0h2m2 0h1m5 0h2m2 0h1m1 0h1m5 0h1m-33 1h7m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h7m-25 1h2m4 0h1m1 0h1m4 0h2m1 0h1m-25 1h1m1 0h5m2 0h1m1 0h1m2 0h1m1 0h4m2 0h2m2 0h5m-31 1h2m3 0h1m1 0h1m3 0h1m1 0h1m2 0h1m1 0h4m1 0h1m2 0h2m1 0h2m-31 1h2m3 0h2m3 0h1m1 0h7m1 0h1m1 0h1m5 0h1m1 0h2m-32 1h4m4 0h1m1 0h4m5 0h1m1 0h2m5 0h4m-31 1h6m1 0h1m1 0h2m2 0h3m1 0h1m1 0h3m2 0h1m2 0h2m-27 1h3m1 0h1m1 0h3m1 0h1m1 0h1m1 0h2m1 0h1m1 0h4m3 0h4m-33 1h1m1 0h1m3 0h3m1 0h1m4 0h3m2 0h3m1 0h4m3 0h1m-32 1h1m1 0h1m1 0h1m3 0h1m1 0h1m1 0h2m1 0h1m3 0h1m1 0h8m1 0h1m-30 1h1m2 0h4m4 0h1m1 0h2m1 0h1m4 0h4m1 0h3m2 0h1m-33 1h6m1 0h2m1 0h2m1 0h1m5 0h5m1 0h3m1 0h3m-31 1h3m1 0h2m3 0h1m1 0h2m1 0h1m2 0h1m5 0h1m2 0h2m1 0h2m-32 1h1m1 0h4m1 0h1m2 0h3m1 0h1m3 0h4m1 0h1m1 0h1m1 0h6m-33 1h2m2 0h3m4 0h1m2 0h2m2 0h2m2 0h3m4 0h1m1 0h1m-32 1h1m6 0h1m2 0h1m2 0h4m1 0h5m2 0h2m3 0h1m1 0h1m-33 1h1m1 0h2m2 0h1m1 0h1m1 0h2m1 0h2m3 0h1m2 0h1m2 0h2m5 0h1m-32 1h1m1 0h1m1 0h1m3 0h1m3 0h2m2 0h1m1 0h4m1 0h1m3 0h4m1 0h1m-33 1h1m1 0h2m1 0h3m2 0h1m3 0h1m1 0h2m1 0h1m2 0h1m1 0h5m1 0h2m-24 1h1m1 0h3m1 0h1m1 0h4m4 0h1m3 0h1m1 0h3m-33 1h7m2 0h1m1 0h7m2 0h1m2 0h2m1 0h1m1 0h1m1 0h1m-31 1h1m5 0h1m1 0h1m5 0h2m1 0h2m1 0h2m2 0h1m3 0h5m-33 1h1m1 0h3m1 0h1m1 0h1m1 0h1m1 0h2m2 0h1m7 0h6m2 0h1m-33 1h1m1 0h3m1 0h1m1 0h2m1 0h1m1 0h3m2 0h1m1 0h1m1 0h2m4 0h2m1 0h2m-33 1h1m1 0h3m1 0h1m1 0h2m1 0h2m2 0h2m1 0h1m1 0h3m1 0h4m1 0h2m-31 1h1m5 0h1m2 0h7m3 0h1m1 0h1m1 0h1m1 0h1m2 0h1m1 0h1m-31 1h7m1 0h3m1 0h2m1 0h1m1 0h1m4 0h3m2 0h1m1 0h1m1 0h1\"/></svg>\n", qrPort: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 29 29\"><path stroke=\"#18181b\" d=\"M0 0.5h7m2 0h4m2 0h1m3 0h2m1 0h7m-29 1h1m5 0h1m2 0h1m2 0h2m1 0h1m6 0h1m5 0h1m-29 1h1m1 0h3m1 0h1m2 0h1m6 0h2m1 0h1m2 0h1m1 0h3m1 0h1m-29 1h1m1 0h3m1 0h1m2 0h2m1 0h1m1 0h2m3 0h2m1 0h1m1 0h3m1 0h1m-29 1h1m1 0h3m1 0h1m4 0h1m1 0h4m3 0h1m1 0h1m1 0h3m1 0h1m-29 1h1m5 0h1m1 0h1m2 0h1m1 0h1m1 0h1m2 0h2m2 0h1m5 0h1m-29 1h7m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h1m1 0h7m-20 1h4m1 0h2m1 0h1m-18 1h1m2 0h1m1 0h2m1 0h2m3 0h1m1 0h2m1 0h1m1 0h2m1 0h1m-24 1h1m1 0h2m3 0h2m1 0h1m5 0h1m5 0h1m2 0h1m2 0h1m-28 1h3m2 0h1m2 0h2m6 0h1m1 0h1m1 0h1m1 0h5m-25 1h3m3 0h6m1 0h1m2 0h1m1 0h1m1 0h1m2 0h2m-27 1h1m1 0h1m1 0h2m1 0h1m1 0h1m2 0h1m2 0h2m1 0h2m1 0h1m2 0h1m1 0h2m-28 1h2m1 0h1m2 0h1m1 0h1m1 0h2m4 0h3m1 0h1m-22 1h1m3 0h3m1 0h1m4 0h1m2 0h2m3 0h1m2 0h5m-29 1h3m5 0h1m4 0h5m5 0h3m1 0h1m-28 1h1m1 0h1m1 0h1m1 0h4m1 0h1m5 0h1m1 0h1m1 0h1m5 0h1m-27 1h1m1 0h3m1 0h3m1 0h2m1 0h1m1 0h1m1 0h1m3 0h2m1 0h1m2 0h1m-29 1h1m1 0h3m1 0h1m1 0h2m1 0h3m3 0h2m3 0h3m2 0h2m-27 1h1m1 0h2m3 0h3m2 0h2m1 0h1m2 0h2m5 0h2m-29 1h1m1 0h2m2 0h1m1 0h1m2 0h4m5 0h5m1 0h1m-19 1h3m1 0h1m3 0h1m1 0h3m3 0h1m1 0h3m-29 1h7m2 0h1m1 0h3m2 0h1m1 0h1m1 0h1m1 0h1m1 0h1m2 0h1m-28 1h1m5 0h1m1 0h4m1 0h1m2 0h1m1 0h1m1 0h1m3 0h5m-29 1h1m1 0h3m1 0h1m3 0h1m1 0h1m1 0h4m2 0h5m-25 1h1m1 0h3m1 0h1m1 0h1m2 0h2m4 0h1m2 0h1m1 0h1m1 0h4m-28 1h1m1 0h3m1 0h1m2 0h2m5 0h1m1 0h2m4 0h3m1 0h1m-29 1h1m5 0h1m3 0h2m1 0h6m1 0h3m4 0h1m-28 1h7m1 0h2m1 0h2m2 0h1m1 0h1m2 0h2m2 0h1m2 0h1\"/></svg>\n" };

  function icon(name, cls) {
    var body = ICONS[name];
    if (!body) return '';
    return '<svg class="tc-icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }

  // <i data-icon="copy"></i>  ->  inline Lucide SVG. Extra classes ride along.
  function hydrateIcons(root) {
    var nodes = (root || document).querySelectorAll('i[data-icon]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var tmp = document.createElement('span');
      tmp.innerHTML = icon(n.getAttribute('data-icon'), n.className);
      if (tmp.firstChild) n.replaceWith(tmp.firstChild);
    }
    var qrs = (root || document).querySelectorAll('[data-sample-qr]');
    for (var j = 0; j < qrs.length; j++) qrs[j].innerHTML = SAMPLE[qrs[j].getAttribute('data-sample-qr')] || '';
  }

  // Local fix: the console is usually opened over plain http://host:3774, which
  // is not a secure context, so navigator.clipboard is absent there. Fall back
  // to a selected textarea and execCommand, which still works in that case,
  // before telling the user to press the keys themselves - and name the keys
  // their platform actually uses.
  var COPY_KEYS = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') ? '\u2318C' : 'Ctrl C';
  function copyText(text) {
    var fallback = function () {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      area.remove();
      return ok;
    };
    try {
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(); });
      }
    } catch (err) { /* fall through */ }
    return Promise.resolve(fallback());
  }

  function on(root, sel, type, fn) {
    root.addEventListener(type, function (e) {
      var t = e.target.closest ? e.target.closest(sel) : null;
      if (t && root.contains(t)) fn(e, t);
    });
  }

  function wire(root) {
    root = root || document;
    // segmented controls: one pressed at a time
    on(root, '.tc-seg button', 'click', function (e, b) {
      var all = b.parentNode.querySelectorAll('button');
      for (var i = 0; i < all.length; i++) all[i].setAttribute('aria-pressed', String(all[i] === b));
    });
    // switches
    on(root, '.tc-switch', 'click', function (e, s) {
      s.setAttribute('aria-checked', String(s.getAttribute('aria-checked') !== 'true'));
    });
    // copy: the label narrates, then settles back
    on(root, '[data-copy]', 'click', function (e, b) {
      var text = b.getAttribute('data-copy');
      var label = b.querySelector('[data-label]') || b;
      var was = label.textContent;
      var done = function (ok) {
        if (label === b && b.querySelector('svg')) { b.setAttribute('data-done', ''); setTimeout(function () { b.removeAttribute('data-done'); }, 1600); return; }
        label.textContent = ok ? 'Copied' : 'Press ' + COPY_KEYS;
        setTimeout(function () { label.textContent = was; }, 1600);
      };
      copyText(text).then(done);
    });
    // menus: [data-menu-trigger="id"] toggles #id; Escape and outside click close
    on(root, '[data-menu-trigger]', 'click', function (e, b) {
      var m = document.getElementById(b.getAttribute('data-menu-trigger'));
      if (!m) return;
      var open = m.hidden;
      m.hidden = !open;
      b.setAttribute('aria-expanded', String(open));
      e.stopPropagation();
    });
    document.addEventListener('click', function (e) {
      var menus = document.querySelectorAll('.tc-menu[data-popup]');
      for (var i = 0; i < menus.length; i++) if (!menus[i].contains(e.target)) menus[i].hidden = true;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var menus = document.querySelectorAll('.tc-menu[data-popup]');
      for (var i = 0; i < menus.length; i++) menus[i].hidden = true;
    });
    // listbox keyboard: arrows move aria-selected within [role=listbox]
    on(root, '[data-listbox-input]', 'keydown', function (e, input) {
      var lb = document.getElementById(input.getAttribute('data-listbox-input'));
      if (!lb) return;
      var opts = [].slice.call(lb.querySelectorAll('.tc-option:not([hidden])'));
      var cur = opts.findIndex(function (o) { return o.getAttribute('aria-selected') === 'true'; });
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var next = e.key === 'ArrowDown' ? Math.min(cur + 1, opts.length - 1) : Math.max(cur - 1, 0);
        opts.forEach(function (o, i) { o.setAttribute('aria-selected', String(i === next)); });
        if (opts[next]) opts[next].scrollIntoView({ block: 'nearest' });
      }
    });
    on(root, '[data-listbox-input]', 'input', function (e, input) {
      var lb = document.getElementById(input.getAttribute('data-listbox-input'));
      var q = input.value.trim().toLowerCase();
      var first = true;
      lb.querySelectorAll('.tc-option').forEach(function (o) {
        var hit = !q || (o.getAttribute('data-search') || o.textContent).toLowerCase().indexOf(q) !== -1;
        o.hidden = !hit;
        o.setAttribute('aria-selected', String(hit && first));
        if (hit) first = false;
      });
    });
  }

  function hydrate(root) { hydrateIcons(root); wire(root); }

  window.T3C = { icon: icon, icons: ICONS, hydrate: hydrate, hydrateIcons: hydrateIcons, sample: SAMPLE, copyText: copyText, copyKeys: COPY_KEYS };
})();
