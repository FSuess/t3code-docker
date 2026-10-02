// Where this page's API lives. Shared by the console and the unlock page.
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
