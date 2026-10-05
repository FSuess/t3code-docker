// One port for T3 Code and the setup page.
//
// T3 Code listens on 3773 and the setup page on 3774. Hosting platforms
// (Railway, Render, Koyeb, Fly) route one HTTP port per service, and a tunnel
// or proxy is simplest with one upstream, so T3_SINGLE_PORT puts this in front
// of both: the setup prefix (/__setup, or T3_SETUP_BASE_PATH) and everything
// under it goes to the setup page, and everything else, WebSockets included,
// goes to T3 Code. Neither needs to know it is here. The setup page reads its
// prefix from the path, and T3 Code's Settings look for it at /__setup on
// their own origin.
//
// Bytes pass through untouched: no buffering, no compression, no rewriting.
// What a proxy has to do on the way is done here: hop-by-hop headers stop at
// this hop, X-Forwarded-* say who connected and how, and a service that is not
// answering yet gets a page that says so and reloads itself, rather than a
// bare connection error.
//
// Dependency-free, like the setup service: node:http and node:stream only.
import http from "node:http";
import { pipeline } from "node:stream";
import { randomBytes } from "node:crypto";

export const DEFAULT_SETUP_PREFIX = "/__setup";

// RFC 9110 §7.6.1: headers meant for one connection, not for whoever is behind
// it, plus Proxy-* (addressed to a proxy) and Expect, which this hop answers
// itself (Node sends the 100 Continue).
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "expect",
]);

// Not answering because nothing listens yet (starting, or restarting), as
// opposed to having failed mid-request.
const NOT_LISTENING = new Set(["ECONNREFUSED", "ENOENT", "EADDRNOTAVAIL"]);

/** A peer address as a person would write it: no IPv4-mapped IPv6 prefix. */
export const plainAddress = (address) => String(address ?? "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");

/** The path of a request-target, whatever form it arrived in. */
export const pathOf = (target) => {
  const raw = String(target ?? "");
  if (raw.startsWith("/")) return raw.split(/[?#]/, 1)[0];
  try {
    return new URL(raw).pathname;
  } catch {
    return raw;
  }
};

/** The request-target to send upstream: origin-form, as RFC 9112 asks of a hop to an origin. */
export const originForm = (target) => {
  const raw = String(target ?? "/");
  if (raw.startsWith("/") || raw === "*") return raw;
  try {
    const url = new URL(raw);
    return `${url.pathname}${url.search}`;
  } catch {
    return raw;
  }
};

/**
 * A setup prefix as configured, made canonical: one leading slash, no
 * trailing one. Empty (or "/", which would hide T3 Code entirely) means the
 * default. Returns null for something that is not a path.
 */
export const normalizePrefix = (value) => {
  const trimmed = String(value ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_SETUP_PREFIX;
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return /^(\/[\w\-.~]+)+$/.test(prefixed) ? prefixed : null;
};

/** Which service a request is for: "setup" for the prefix and below, else "t3". */
export const serviceFor = (target, prefix) => {
  if (!prefix) return "t3";
  const path = pathOf(target);
  return path === prefix || path.startsWith(`${prefix}/`) ? "setup" : "t3";
};

const connectionTokens = (raw) => {
  const tokens = new Set();
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() !== "connection") continue;
    for (const token of String(raw[i + 1]).split(",")) {
      const name = token.trim().toLowerCase();
      if (name) tokens.add(name);
    }
  }
  return tokens;
};

/**
 * Request headers for the next hop, from the client's raw headers (so repeated
 * headers stay repeated, in order, with their original case).
 *
 * Hop-by-hop headers stay here, as does anything Connection names. For an
 * upgrade, Connection and Upgrade are what the request is for, so they go on.
 * X-Forwarded-For gains the address this hop saw. X-Forwarded-Proto and
 * X-Forwarded-Host are kept when a proxy in front set them (a platform's TLS
 * terminator knows the scheme; this hop does not) and filled in otherwise.
 */
export const forwardHeaders = (raw, { peer, encrypted = false, upgrade = null } = {}) => {
  const listed = connectionTokens(raw);
  const out = [];
  const forwardedFor = [];
  let host = null;
  let proto = false;
  let forwardedHost = false;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];
    const lower = name.toLowerCase();
    if (lower === "x-forwarded-for") {
      forwardedFor.push(value);
      continue;
    }
    if (HOP_BY_HOP.has(lower) || listed.has(lower)) continue;
    if (lower === "host") host = value;
    else if (lower === "x-forwarded-proto") proto = true;
    else if (lower === "x-forwarded-host") forwardedHost = true;
    out.push(name, value);
  }
  const address = plainAddress(peer);
  if (address) forwardedFor.push(address);
  if (forwardedFor.length) out.push("X-Forwarded-For", forwardedFor.join(", "));
  if (!proto) out.push("X-Forwarded-Proto", encrypted ? "https" : "http");
  if (!forwardedHost && host) out.push("X-Forwarded-Host", host);
  if (upgrade) out.push("Connection", "Upgrade", "Upgrade", upgrade);
  return out;
};

/** Response headers for the client: the upstream's, minus what was only for this hop. */
export const responseHeaders = (raw) => {
  const listed = connectionTokens(raw);
  const out = [];
  for (let i = 0; i < raw.length; i += 2) {
    const lower = raw[i].toLowerCase();
    if (HOP_BY_HOP.has(lower) || listed.has(lower)) continue;
    out.push(raw[i], raw[i + 1]);
  }
  return out;
};

const headerBlock = (raw) => {
  let block = "";
  for (let i = 0; i < raw.length; i += 2) block += `${raw[i]}: ${raw[i + 1]}\r\n`;
  return block;
};

// A request with no body can be sent again safely if a kept-alive connection
// turns out to have been closed by the other end just as it was reused.
const hasBody = (req) => {
  const length = req.headers["content-length"];
  return Boolean(req.headers["transfer-encoding"]) || (length !== undefined && length !== "0");
};
const REPLAYABLE = new Set(["GET", "HEAD", "OPTIONS"]);

// ------------------------------------------------------------- unavailable --

const NAMES = { t3: "T3 Code", setup: "The setup page" };

/**
 * What a visitor sees while a service is not answering. A browser gets a page
 * that waits and opens the service by itself once it answers; anything else
 * gets a short JSON error. Both say when to try again.
 */
export const unavailable = (service, { notListening, prefix, accept = "", method = "GET" } = {}) => {
  const name = NAMES[service] ?? service;
  const title = notListening
    ? service === "setup" ? "The setup page is restarting" : "T3 Code is starting"
    : `${name} didn't answer`;
  const wantsPage = (method === "GET" || method === "HEAD") && /text\/html/i.test(accept);
  if (!wantsPage) {
    const body = JSON.stringify({ error: `${title}. Try again in a few seconds.` });
    return {
      status: notListening ? 503 : 502,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "retry-after": "2" },
      body,
    };
  }
  const nonce = randomBytes(16).toString("base64");
  const probe = service === "setup" ? `${prefix}/hello` : "/.well-known/t3/environment";
  const elsewhere = service === "setup"
    ? `<a href="/">Open T3 Code</a>`
    : prefix ? `<a href="${prefix}/">Open the setup page</a>` : "";
  const lede = service === "setup"
    ? "It usually takes a few seconds. This page opens it again once it’s back."
    : notListening
      ? "This page opens it as soon as it’s ready."
      : "Trying again. This page opens it as soon as it answers.";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="icon" href="data:,">
<noscript><meta http-equiv="refresh" content="5"></noscript>
<style nonce="${nonce}">
:root{--bg:oklch(0.992 0 0);--fg:oklch(0.274 0.006 286.033);--muted:oklch(0.552 0.016 285.938);--accent:oklch(0.488 0.217 264);--track:oklch(0.92 0.004 286.32);color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:oklch(0.145 0 0);--fg:oklch(0.97 0 0);--muted:#818181;--accent:oklch(0.707 0.165 254.624);--track:oklch(1 0 0 / 0.1)}}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;text-align:center}
main{max-width:22rem}
.spin{width:28px;height:28px;margin:0 auto 20px;border-radius:50%;border:2.5px solid var(--track);border-top-color:var(--accent);animation:spin .9s linear infinite}
@media (prefers-reduced-motion:reduce){.spin{animation-duration:2.4s}}
@keyframes spin{to{transform:rotate(360deg)}}
h1{margin:0 0 6px;font-size:17px;font-weight:600;letter-spacing:-.01em}
p{margin:0;color:var(--muted)}
.more{margin-top:20px;font-size:14px}
a{color:var(--accent);font-weight:500;text-decoration:none;border-radius:4px}
a:hover{text-decoration:underline}
a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
</style>
</head>
<body>
<main>
<div class="spin" aria-hidden="true"></div>
<h1 role="status">${title}</h1>
<p>${lede}</p>
${elsewhere ? `<p class="more">${elsewhere}</p>` : ""}
</main>
<script nonce="${nonce}">
(function () {
  var wait = 1000;
  function again() { wait = Math.min(wait * 1.5, 5000); setTimeout(check, wait); }
  function check() {
    fetch(${JSON.stringify(probe)}, { cache: "no-store", credentials: "same-origin" })
      .then(function (r) { if (r.ok) location.reload(); else again(); }, again);
  }
  setTimeout(check, wait);
})();
</script>
</body>
</html>
`;
  return {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "2",
      "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
    body: html,
  };
};

const rawResponse = (status, reason, headers, body) => {
  const length = Buffer.byteLength(body);
  const lines = Object.entries({ ...headers, "content-length": String(length), connection: "close" })
    .map(([k, v]) => `${k}: ${v}\r\n`).join("");
  return `HTTP/1.1 ${status} ${reason}\r\n${lines}\r\n${body}`;
};

// ------------------------------------------------------------------ router --

/**
 *   t3           { host, port }            T3 Code
 *   setup        { host, port } | null     the setup page; null sends everything to T3
 *   setupPrefix  "/__setup"                the path the setup page answers under
 *   log          (line) => void            state changes only, never per request
 *
 * Returns { handleRequest, handleUpgrade, close }, for an http.Server's
 * "request" and "upgrade" events. createRouterServer wires them up.
 */
export function createRouter({ t3, setup = null, setupPrefix = DEFAULT_SETUP_PREFIX, log = () => {} }) {
  const prefix = setup ? setupPrefix : null;
  const upstreams = { t3, setup };
  // Kept alive: a browser loading T3 Code fetches dozens of assets, and a new
  // loopback connection for each would leave as many sockets in TIME_WAIT.
  const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxFreeSockets: 32, scheduling: "lifo" });

  // What is logged is state, not traffic. "Is not answering" once when
  // nothing listens, "answering again" once when something does, however many
  // requests fall in between. A request cut short some other way (a reset, a
  // crash mid-answer) is said at most once a minute, so a flapping service
  // cannot fill the log. A visitor who leaves is not the service failing, and
  // is not said at all.
  const down = new Set();
  const lastDropped = new Map();
  const noteFailure = (service, error) => {
    const { host, port } = upstreams[service];
    const reason = error.code ?? error.message;
    if (NOT_LISTENING.has(error.code)) {
      if (down.has(service)) return;
      down.add(service);
      log(`${NAMES[service]} is not answering on ${host}:${port} (${reason}); visitors see a page that waits for it`);
      return;
    }
    const now = Date.now();
    if (now - (lastDropped.get(service) ?? -Infinity) < 60_000) return;
    lastDropped.set(service, now);
    log(`${NAMES[service]} on ${host}:${port} dropped a request (${reason})`);
  };
  const noteUp = (service) => {
    if (!down.delete(service)) return;
    log(`${NAMES[service]} is answering again`);
  };

  const serviceOf = (target) => (serviceFor(target, prefix) === "setup" ? "setup" : "t3");

  const handleRequest = (req, res) => {
    const service = serviceOf(req.url);
    const { host, port } = upstreams[service];
    const headers = forwardHeaders(req.rawHeaders, { peer: req.socket.remoteAddress, encrypted: Boolean(req.socket.encrypted) });
    if (!req.headers.host) headers.push("Host", `${host}:${port}`);
    const body = hasBody(req);
    let current = null;
    let retried = false;
    let abandoned = false;

    const fail = (error) => {
      noteFailure(service, error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (res.destroyed) return;
      const answer = unavailable(service, {
        notListening: NOT_LISTENING.has(error.code),
        prefix,
        accept: req.headers.accept,
        method: req.method,
      });
      res.writeHead(answer.status, { ...answer.headers, "content-length": Buffer.byteLength(answer.body) });
      res.end(req.method === "HEAD" ? undefined : answer.body);
    };

    const send = () => {
      const proxied = http.request({
        host, port, agent, setHost: false,
        method: req.method,
        path: originForm(req.url),
        headers,
      });
      current = proxied;
      proxied.on("response", (answer) => {
        noteUp(service);
        try {
          res.writeHead(answer.statusCode, answer.statusMessage, responseHeaders(answer.rawHeaders));
        } catch (error) {
          answer.destroy();
          fail(error);
          return;
        }
        pipeline(answer, res, () => {});
      });
      proxied.on("error", (error) => {
        // Cancelled below because the visitor went away: nothing failed.
        if (abandoned) return;
        // Node's documented pattern: a kept-alive socket the other end closed
        // as it was reused fails with ECONNRESET, and only a request that can
        // be replayed is sent once more.
        if (!retried && !body && proxied.reusedSocket && error.code === "ECONNRESET"
            && REPLAYABLE.has(req.method) && !res.headersSent && !res.destroyed) {
          retried = true;
          send();
          return;
        }
        fail(error);
      });
      // Piped rather than pipelined: an upstream that refuses must not take
      // the visitor's connection down with it, or the answer below is lost.
      if (body) req.pipe(proxied);
      else proxied.end();
    };

    // The visitor left, or stopped sending: stop asking for what nobody will read.
    const abandon = () => {
      abandoned = true;
      current?.destroy();
    };
    res.on("close", () => {
      if (!res.writableFinished) abandon();
    });
    req.on("error", abandon);
    send();
  };

  const handleUpgrade = (req, socket, head) => {
    const service = serviceOf(req.url);
    const { host, port } = upstreams[service];
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    let answered = false;
    let abandoned = false;

    const refuse = (error) => {
      if (abandoned) return;
      noteFailure(service, error);
      if (answered || socket.destroyed) {
        socket.destroy();
        return;
      }
      answered = true;
      const notListening = NOT_LISTENING.has(error.code);
      const answer = unavailable(service, { notListening, prefix, accept: "", method: req.method });
      socket.end(rawResponse(answer.status, notListening ? "Service Unavailable" : "Bad Gateway", answer.headers, answer.body));
    };

    const proxied = http.request({
      host, port, agent: false, setHost: false,
      method: req.method,
      path: originForm(req.url),
      headers: forwardHeaders(req.rawHeaders, {
        peer: req.socket.remoteAddress,
        encrypted: Boolean(req.socket.encrypted),
        upgrade: req.headers.upgrade,
      }),
    });

    proxied.on("upgrade", (answer, upstream, upstreamHead) => {
      noteUp(service);
      answered = true;
      upstream.setNoDelay(true);
      upstream.setKeepAlive(true, 30_000);
      socket.write(`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n${headerBlock(answer.rawHeaders)}\r\n`);
      if (upstreamHead?.length) socket.write(upstreamHead);
      if (head?.length) upstream.write(head);
      // Either side finishing ends both. Node's HTTP server keeps sockets
      // half-open, so without this a visitor who leaves would leave the
      // connection to T3 open behind them; a half-open WebSocket helps nobody.
      const teardown = () => {
        upstream.destroy();
        socket.destroy();
      };
      pipeline(upstream, socket, teardown);
      pipeline(socket, upstream, teardown);
    });

    // The upstream answered without switching protocols, e.g. 401 for a
    // socket without a session. Pass that answer on as it is, and close.
    proxied.on("response", (answer) => {
      noteUp(service);
      answered = true;
      socket.write(`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n${headerBlock(responseHeaders(answer.rawHeaders))}connection: close\r\n\r\n`);
      pipeline(answer, socket, () => {});
    });

    proxied.on("error", refuse);
    // A visitor who hangs up before the answer gave up on it. The socket only
    // half-closes (Node's HTTP server allows that), so watch for the end of
    // their side, not just a close, or the request upstream lingers.
    const giveUp = () => {
      if (answered) return;
      abandoned = true;
      proxied.destroy();
      socket.destroy();
    };
    socket.on("error", giveUp);
    socket.on("end", giveUp);
    socket.on("close", giveUp);
    proxied.end();
  };

  return {
    handleRequest,
    handleUpgrade,
    close: () => agent.destroy(),
  };
}

/**
 * An http.Server for the router, with timeouts suited to sitting behind a
 * platform's load balancer and in front of long requests:
 *
 *  - no limit on how long a request takes to arrive (Node's default of five
 *    minutes would cut off a large upload over a slow link);
 *  - idle keep-alive connections held for longer than load balancers hold
 *    theirs (60 seconds is common), so the balancer is always the side that
 *    closes, never this one in the moment it sends the next request. That
 *    race is what turns into sporadic 502s on every platform.
 */
export function createRouterServer(options) {
  const router = createRouter(options);
  const server = http.createServer({
    requestTimeout: 0,
    keepAliveTimeout: 75_000,
    headersTimeout: 80_000,
  }, router.handleRequest);
  server.on("upgrade", router.handleUpgrade);
  server.on("close", router.close);
  return server;
}

// ------------------------------------------------------------------ config --

const PORT_RE = /^\d{1,5}$/;
const portOf = (value) => (PORT_RE.test(String(value ?? "").trim()) ? Number(String(value).trim()) : NaN);
const validPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535;
// Exactly as the entrypoint decides whether to start the setup page at all:
// "1" or nothing. Anything else routing /__setup to a page that never started
// would show "restarting" forever.
const setupStarts = (value) => String(value ?? "1").trim() === "1";

/**
 * The router's configuration from the environment, or an Error whose message
 * says what to change. Null when T3_SINGLE_PORT is unset: nothing to run.
 */
export function readConfig(env = process.env) {
  const raw = String(env.T3_SINGLE_PORT ?? "").trim();
  if (!raw) return null;
  const port = portOf(raw);
  if (!validPort(port)) {
    throw new Error(`T3_SINGLE_PORT=${raw} is not a port. Use a number from 1 to 65535, such as 8080.`);
  }
  const t3Port = portOf(env.T3CODE_PORT ?? 3773);
  if (!validPort(t3Port)) throw new Error(`T3CODE_PORT=${env.T3CODE_PORT} is not a port.`);
  const setupOn = setupStarts(env.T3_SETUP_ENABLED);
  const setupPort = portOf(env.T3_SETUP_PORT ?? 3774);
  if (setupOn && !validPort(setupPort)) throw new Error(`T3_SETUP_PORT=${env.T3_SETUP_PORT} is not a port.`);
  if (port === t3Port) {
    throw new Error(`T3_SINGLE_PORT=${port} is the port T3 Code itself listens on. Pick another, such as 8080, and publish that one.`);
  }
  if (setupOn && port === setupPort) {
    throw new Error(`T3_SINGLE_PORT=${port} is the port the setup page itself listens on. Pick another, such as 8080, and publish that one.`);
  }
  const prefix = normalizePrefix(env.T3_SETUP_BASE_PATH);
  if (prefix === null) {
    throw new Error(`T3_SETUP_BASE_PATH=${env.T3_SETUP_BASE_PATH} is not a path the router can serve the setup page under. Use something like /__setup.`);
  }
  return {
    port,
    t3: { host: "127.0.0.1", port: t3Port },
    setup: setupOn ? { host: "127.0.0.1", port: setupPort } : null,
    setupPrefix: prefix,
  };
}

