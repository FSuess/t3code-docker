// The unlock page. The form works without this file: it posts the key to
// {mount}/login, which sets the session cookie and redirects back, or comes back
// with ?error=1 for a wrong key. This keeps the user on the page instead, so a
// wrong key shows in place with the field still selected, and adds the reveal
// toggle. It posts against the base the browser can see, not the form's
// server-rendered action, because a proxy that strips the prefix would send
// that one to the origin root.
(() => {
  const form = document.getElementById('loginform');
  if (!form) return;
  T3C.hydrateIcons(document);

  const input = document.getElementById('key');
  const error = document.getElementById('key-error');
  const reveal = document.getElementById('reveal');
  const submit = document.getElementById('unlock');

  const showError = (message) => {
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', 'key-error');
    error.textContent = message;
    error.hidden = false;
    input.focus();
    input.select();
  };
  const clearError = () => {
    input.removeAttribute('aria-invalid');
    error.hidden = true;
  };
  input.addEventListener('input', clearError);

  reveal.hidden = false;
  reveal.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    reveal.setAttribute('aria-pressed', String(show));
    reveal.setAttribute('aria-label', show ? 'Hide the setup key' : 'Show the setup key');
    reveal.innerHTML = T3C.icon(show ? 'eye-off' : 'eye');
    input.focus();
  });

  // The query without the failed-post flag: what the page was opened with,
  // such as ?embed=t3 inside T3 Code, survives a wrong key and the unlock.
  const kept = () => {
    const params = new URLSearchParams(location.search);
    params.delete('error');
    const query = params.toString();
    return query ? '?' + query : '';
  };

  // Arriving from a failed no-script post: say so, then drop the flag so a
  // reload does not keep repeating it.
  if (new URLSearchParams(location.search).has('error')) {
    history.replaceState(null, '', location.pathname + kept() + location.hash);
  }

  // An embedded address opened in a tab of its own has nothing to close back to.
  if (document.documentElement.hasAttribute('data-embed') && window.parent === window) {
    location.replace(BASE + '/' + location.hash);
    return;
  }

  // Opened inside T3 Code's settings: Close and Escape hand back to T3 Code,
  // which also keeps the theme in step.
  if (document.documentElement.getAttribute('data-embed') === 't3' && window.parent !== window) {
    const close = () => window.parent.postMessage({ source: 't3-setup', type: 'close' }, location.origin);
    for (const button of document.querySelectorAll('[data-cmd="embed.close"]')) button.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.isComposing) close(); });
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (e.source !== window.parent || e.origin !== location.origin || !m || m.source !== 't3-code') return;
      if (m.type === 'theme' && (m.theme === 'light' || m.theme === 'dark')) {
        document.documentElement.setAttribute('data-theme', m.theme);
        document.documentElement.setAttribute('data-theme-mode', m.theme);
      }
    });
    window.parent.postMessage({ source: 't3-setup', type: 'ready' }, location.origin);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!input.value.trim()) {
      showError('Enter the setup key.');
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Unlocking';
    try {
      const res = await fetch(BASE + '/login', {
        method: 'POST',
        body: new URLSearchParams(new FormData(form)),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (res.ok) {
        location.replace(BASE + '/' + kept() + location.hash);
        return;
      }
      showError(res.status === 401
        ? 'That key was not accepted. Keys are case-sensitive; paste it rather than typing it.'
        : 'The console did not answer (HTTP ' + res.status + '). Try again in a moment.');
    } catch {
      showError('Could not reach the console. Check the connection and try again.');
    }
    submit.disabled = false;
    submit.textContent = 'Unlock';
  });
})();
