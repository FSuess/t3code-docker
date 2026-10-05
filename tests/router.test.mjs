// Unit and wire tests for the one-port router (docker/router/router.mjs).
//
//   node --test tests/router.test.mjs
//
// The pure parts (which service a path is for, which headers go on, the
// configuration) are checked directly. The rest runs over real sockets: a
// fake T3 and a fake setup page on loopback, the router in front of them, and
// plain node:http and node:net clients, so what is asserted is what a browser
// or a platform's load balancer would see.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";

import {
  DEFAULT_SETUP_PREFIX,
  createRouterServer,
  forwardHeaders,
  normalizePrefix,
  originForm,
  pathOf,
  plainAddress,
  readConfig,
  responseHeaders,
  serviceFor,
  unavailable,
} from "../docker/router/router.mjs";

// ------------------------------------------------------------------- pure --

test("the setup prefix and everything under it go to the setup page, nothing else does", () => {
  const p = DEFAULT_SETUP_PREFIX;
  assert.equal(serviceFor("/__setup", p), "setup");
  assert.equal(serviceFor("/__setup/", p), "setup");
  assert.equal(serviceFor("/__setup/status?x=1", p), "setup");
  assert.equal(serviceFor("/__setup?embed=t3", p), "setup");
  assert.equal(serviceFor("/__setup#agents", p), "setup");
  assert.equal(serviceFor("http://t3.example.com/__setup/hello", p), "setup", "absolute-form targets too");
  assert.equal(serviceFor("/", p), "t3");
  assert.equal(serviceFor("/__setupx", p), "t3", "a prefix is a whole path segment");
  assert.equal(serviceFor("/api/__setup/", p), "t3");
  assert.equal(serviceFor("/ws", p), "t3");
  assert.equal(serviceFor("/__SETUP/", p), "t3", "paths are case-sensitive");
  assert.equal(serviceFor("*", p), "t3");
  assert.equal(serviceFor("/__setup/", null), "t3", "with the setup page off, everything is T3's");
});

test("request-targets become paths and origin-form targets", () => {
  assert.equal(pathOf("/a/b?c=d#e"), "/a/b");
  assert.equal(pathOf("http://h:1/a/b?c"), "/a/b");
  assert.equal(originForm("/a?b"), "/a?b");
  assert.equal(originForm("http://h:1/a/b?c=d"), "/a/b?c=d");
  assert.equal(originForm("*"), "*");
});

test("setup prefixes are made canonical, and a prefix that is not a path is refused", () => {
  assert.equal(normalizePrefix(""), "/__setup");
  assert.equal(normalizePrefix(undefined), "/__setup");
  assert.equal(normalizePrefix("/"), "/__setup", "/ would hide T3 Code entirely");
  assert.equal(normalizePrefix("/setup/"), "/setup");
  assert.equal(normalizePrefix("setup"), "/setup");
  assert.equal(normalizePrefix("/admin/setup"), "/admin/setup");
  assert.equal(normalizePrefix("/a b"), null);
  assert.equal(normalizePrefix("/a//b"), null);
  assert.equal(normalizePrefix("/a?b"), null);
});

test("IPv4-mapped peers read as plain IPv4", () => {
  assert.equal(plainAddress("::ffff:10.0.0.7"), "10.0.0.7");
  assert.equal(plainAddress("::1"), "::1");
  assert.equal(plainAddress("2001:db8::1"), "2001:db8::1");
  assert.equal(plainAddress(undefined), "");
});

/** Header pairs as [name, value] tuples, for readable assertions. */
const pairs = (raw) => raw.reduce((out, v, i) => (i % 2 ? out : [...out, [raw[i], raw[i + 1]]]), []);
const valuesOf = (raw, name) => pairs(raw).filter(([k]) => k.toLowerCase() === name).map(([, v]) => v);

test("hop-by-hop headers stop here; repeated headers go on, in order and case", () => {
  const out = forwardHeaders([
    "Host", "t3.example.com",
    "Connection", "keep-alive, X-Secret-Hop",
    "Keep-Alive", "timeout=5",
    "X-Secret-Hop", "only for this connection",
    "Proxy-Authorization", "Basic x",
    "TE", "trailers",
    "Transfer-Encoding", "chunked",
    "Upgrade", "h2c",
    "Expect", "100-continue",
    "Accept", "text/html",
    "X-Dup", "1",
    "x-dup", "2",
    "Cookie", "a=1",
  ], { peer: "203.0.113.9" });
  const names = pairs(out).map(([k]) => k.toLowerCase());
  for (const gone of ["connection", "keep-alive", "x-secret-hop", "proxy-authorization", "te", "transfer-encoding", "upgrade", "expect"]) {
    assert.ok(!names.includes(gone), `${gone} is not forwarded`);
  }
  assert.deepEqual(pairs(out).slice(0, 5), [["Host", "t3.example.com"], ["Accept", "text/html"], ["X-Dup", "1"], ["x-dup", "2"], ["Cookie", "a=1"]]);
});

test("X-Forwarded-For gains this hop's peer; Proto and Host are filled only when nobody set them", () => {
  const direct = forwardHeaders(["Host", "box.lan:8080"], { peer: "::ffff:192.168.1.20" });
  assert.deepEqual(valuesOf(direct, "x-forwarded-for"), ["192.168.1.20"]);
  assert.deepEqual(valuesOf(direct, "x-forwarded-proto"), ["http"]);
  assert.deepEqual(valuesOf(direct, "x-forwarded-host"), ["box.lan:8080"]);

  const behindPlatform = forwardHeaders([
    "Host", "app.up.railway.app",
    "X-Forwarded-For", "198.51.100.4",
    "X-Forwarded-For", "10.1.0.2",
    "X-Forwarded-Proto", "https",
    "X-Forwarded-Host", "t3.example.com",
  ], { peer: "10.1.0.3" });
  assert.deepEqual(valuesOf(behindPlatform, "x-forwarded-for"), ["198.51.100.4, 10.1.0.2, 10.1.0.3"], "one header, every hop, this one last");
  assert.deepEqual(valuesOf(behindPlatform, "x-forwarded-proto"), ["https"], "the TLS terminator knows the scheme; this hop does not");
  assert.deepEqual(valuesOf(behindPlatform, "x-forwarded-host"), ["t3.example.com"]);

  const tls = forwardHeaders(["Host", "h"], { peer: "1.2.3.4", encrypted: true });
  assert.deepEqual(valuesOf(tls, "x-forwarded-proto"), ["https"]);
});

test("an upgrade keeps exactly one Connection: Upgrade and the protocol asked for", () => {
  const out = forwardHeaders([
    "Host", "h", "Connection", "keep-alive, Upgrade", "Upgrade", "websocket", "Sec-WebSocket-Key", "k",
  ], { peer: "1.2.3.4", upgrade: "websocket" });
  assert.deepEqual(valuesOf(out, "connection"), ["Upgrade"]);
  assert.deepEqual(valuesOf(out, "upgrade"), ["websocket"]);
  assert.deepEqual(valuesOf(out, "sec-websocket-key"), ["k"]);
});

test("response headers lose what was for this hop and keep every Set-Cookie", () => {
  const out = responseHeaders([
    "Set-Cookie", "a=1", "Set-Cookie", "b=2", "Connection", "keep-alive", "Keep-Alive", "timeout=5",
    "Transfer-Encoding", "chunked", "Content-Type", "text/plain",
  ]);
  assert.deepEqual(pairs(out), [["Set-Cookie", "a=1"], ["Set-Cookie", "b=2"], ["Content-Type", "text/plain"]]);
});

test("configuration: off when unset, and every mistake says what to change", () => {
  assert.equal(readConfig({}), null);
  assert.equal(readConfig({ T3_SINGLE_PORT: "  " }), null);
  assert.deepEqual(readConfig({ T3_SINGLE_PORT: "8080" }), {
    port: 8080,
    t3: { host: "127.0.0.1", port: 3773 },
    setup: { host: "127.0.0.1", port: 3774 },
    setupPrefix: "/__setup",
  });
  assert.deepEqual(readConfig({ T3_SINGLE_PORT: "8080", T3_SETUP_ENABLED: "0" }).setup, null);
  assert.equal(readConfig({ T3_SINGLE_PORT: "8080", T3_SETUP_BASE_PATH: "/setup/" }).setupPrefix, "/setup");
  assert.equal(readConfig({ T3_SINGLE_PORT: "3774", T3_SETUP_ENABLED: "0" }).port, 3774, "the setup page's port is free when it is off");

  assert.throws(() => readConfig({ T3_SINGLE_PORT: "eighty" }), /not a port.*8080/);
  assert.throws(() => readConfig({ T3_SINGLE_PORT: "0" }), /not a port/);
  assert.throws(() => readConfig({ T3_SINGLE_PORT: "70000" }), /not a port/);
  assert.throws(() => readConfig({ T3_SINGLE_PORT: "80.5" }), /not a port/);
  assert.throws(() => readConfig({ T3_SINGLE_PORT: "3773" }), /T3 Code itself listens on.*8080/);
  assert.throws(() => readConfig({ T3_SINGLE_PORT: "9000", T3CODE_PORT: "9000" }), /T3 Code itself/);
  assert.throws(() => readConfig({ T3_SINGLE_PORT: "3774" }), /setup page itself/);
  assert.throws(() => readConfig({ T3_SINGLE_PORT: "8080", T3_SETUP_BASE_PATH: "/a b" }), /T3_SETUP_BASE_PATH/);
});

test("the waiting page is a page for browsers and JSON for everything else", () => {
  const page = unavailable("t3", { notListening: true, prefix: "/__setup", accept: "text/html,*/*" });
  assert.equal(page.status, 503);
  assert.equal(page.headers["retry-after"], "2");
  assert.equal(page.headers["cache-control"], "no-store", "never cached as T3 Code's shell");
  assert.match(page.body, /<title>T3 Code is starting<\/title>/);
  assert.match(page.body, /href="\/__setup\/"/, "it offers the setup page, which shows first-start progress");
  assert.match(page.body, /"\/\.well-known\/t3\/environment"/, "and waits on T3's health endpoint");
  const nonce = page.headers["content-security-policy"].match(/'nonce-([^']+)'/)[1];
  assert.equal(page.body.split(`nonce="${nonce}"`).length - 1, 2, "its only style and script carry this response's nonce");

  const setupDown = unavailable("setup", { notListening: true, prefix: "/__setup", accept: "text/html" });
  assert.match(setupDown.body, /The setup page is restarting/);
  assert.match(setupDown.body, /"\/__setup\/hello"/);
  assert.match(setupDown.body, /href="\/">Open T3 Code/);

  const noSetup = unavailable("t3", { notListening: true, prefix: null, accept: "text/html" });
  assert.doesNotMatch(noSetup.body, /setup page/i, "no link to a setup page that is off");

  const api = unavailable("t3", { notListening: true, accept: "application/json" });
  assert.equal(api.status, 503);
  assert.deepEqual(JSON.parse(api.body), { error: "T3 Code is starting. Try again in a few seconds." });
  assert.equal(unavailable("t3", { notListening: false, accept: "application/json" }).status, 502);
  assert.equal(unavailable("t3", { notListening: true, accept: "text/html", method: "POST" }).headers["content-type"], "application/json; charset=utf-8");
});

// ------------------------------------------------------------------- wire --

const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};

/** A fake service: records what reached it and answers with `handler`. */
const fakeService = async (name, handler) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders });
    if (handler) return handler(req, res);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ service: name, url: req.url }));
  });
  const port = await listen(server);
  return { server, port, seen };
};

/** The router in front of the two fakes, on its own loopback port. */
const routerFor = async ({ t3, setup, setupPrefix = DEFAULT_SETUP_PREFIX }) => {
  const lines = [];
  const server = createRouterServer({
    t3: { host: "127.0.0.1", port: t3.port },
    setup: setup ? { host: "127.0.0.1", port: setup.port } : null,
    setupPrefix,
    log: (line) => lines.push(line),
  });
  const port = await listen(server);
  return { server, port, lines };
};

const closeAll = (...servers) => Promise.all(servers.map((s) => new Promise((r) => {
  s.closeAllConnections?.();
  s.close(() => r());
})));

const request = (port, { method = "GET", path = "/", headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
    res.on("error", reject);
  });
  req.on("error", reject);
  req.end(body);
});

/** A port nothing listens on: bound once, then released. */
const deadPort = async () => {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((r) => server.close(r));
  return port;
};

test("requests reach the service their path belongs to, with path and query intact", async (t) => {
  const t3 = await fakeService("t3");
  const setup = await fakeService("setup");
  const router = await routerFor({ t3, setup });
  t.after(() => closeAll(router.server, t3.server, setup.server));

  for (const [path, service] of [
    ["/", "t3"], ["/settings/general", "t3"], ["/assets/index-abc.js", "t3"], ["/.well-known/t3/environment", "t3"],
    ["/__setup", "setup"], ["/__setup/", "setup"], ["/__setup/status?fast=1", "setup"], ["/__setupx", "t3"],
  ]) {
    const res = await request(router.port, { path });
    assert.equal(res.status, 200, path);
    assert.deepEqual(JSON.parse(res.body), { service, url: path }, path);
  }
});

test("the setup page off: /__setup is T3 Code's like any other path", async (t) => {
  const t3 = await fakeService("t3");
  const router = await routerFor({ t3, setup: null });
  t.after(() => closeAll(router.server, t3.server));
  assert.equal(JSON.parse((await request(router.port, { path: "/__setup/" })).body).service, "t3");
});

test("a custom prefix routes that prefix, and /__setup is T3's", async (t) => {
  const t3 = await fakeService("t3");
  const setup = await fakeService("setup");
  const router = await routerFor({ t3, setup, setupPrefix: "/setup" });
  t.after(() => closeAll(router.server, t3.server, setup.server));
  assert.equal(JSON.parse((await request(router.port, { path: "/setup/hello" })).body).service, "setup");
  assert.equal(JSON.parse((await request(router.port, { path: "/__setup/hello" })).body).service, "t3");
});

test("upstreams see the visitor's Host, the forwarded headers, and none of this hop's", async (t) => {
  const t3 = await fakeService("t3");
  const router = await routerFor({ t3, setup: null });
  t.after(() => closeAll(router.server, t3.server));
  await request(router.port, { path: "/x", headers: { host: "t3.example.com", "x-forwarded-proto": "https", connection: "keep-alive, x-gone", "x-gone": "1", cookie: "t3_session_3773_ab=v" } });
  const seen = t3.seen.at(-1);
  assert.equal(seen.headers.host, "t3.example.com");
  assert.equal(seen.headers["x-forwarded-for"], "127.0.0.1");
  assert.equal(seen.headers["x-forwarded-proto"], "https");
  assert.equal(seen.headers["x-forwarded-host"], "t3.example.com");
  assert.equal(seen.headers.cookie, "t3_session_3773_ab=v");
  assert.equal(seen.headers["x-gone"], undefined);
});

test("every Set-Cookie comes back, and statuses, redirects and HEAD pass through", async (t) => {
  const t3 = await fakeService("t3", (req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(303, { location: "/__setup/" });
      return res.end();
    }
    res.writeHead(201, "Made", ["Set-Cookie", "a=1; Path=/", "Set-Cookie", "b=2; Path=/", "Content-Type", "text/plain", "Content-Length", "5"]);
    res.end(req.method === "HEAD" ? undefined : "hello");
  });
  const router = await routerFor({ t3, setup: null });
  t.after(() => closeAll(router.server, t3.server));

  const res = await request(router.port, { path: "/cookies" });
  assert.equal(res.status, 201);
  assert.deepEqual(res.headers["set-cookie"], ["a=1; Path=/", "b=2; Path=/"]);
  assert.equal(res.body.toString(), "hello");

  const head = await request(router.port, { method: "HEAD", path: "/cookies" });
  assert.equal(head.status, 201);
  assert.equal(head.headers["content-length"], "5");
  assert.equal(head.body.length, 0);

  const redirect = await request(router.port, { path: "/redirect" });
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.location, "/__setup/", "redirects are not followed or rewritten");
});

test("a large upload arrives intact, chunked or with a length", async (t) => {
  const t3 = await fakeService("t3", (req, res) => {
    const hash = createHash("sha256");
    req.on("data", (c) => hash.update(c));
    req.on("end", () => res.end(hash.digest("hex")));
  });
  const router = await routerFor({ t3, setup: null });
  t.after(() => closeAll(router.server, t3.server));
  const payload = randomBytes(8 * 1024 * 1024);
  const expected = createHash("sha256").update(payload).digest("hex");

  const sized = await request(router.port, { method: "POST", path: "/upload", headers: { "content-length": payload.length }, body: payload });
  assert.equal(sized.body.toString(), expected);

  const chunked = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: router.port, method: "POST", path: "/upload", agent: false }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve(text));
    });
    req.on("error", reject);
    for (let i = 0; i < payload.length; i += 65536) req.write(payload.subarray(i, i + 65536));
    req.end();
  });
  assert.equal(chunked, expected);
});

test("Expect: 100-continue is answered here and the body still arrives", async (t) => {
  const t3 = await fakeService("t3", (req, res) => {
    let n = 0;
    req.on("data", (c) => (n += c.length));
    req.on("end", () => res.end(String(n)));
  });
  const router = await routerFor({ t3, setup: null });
  t.after(() => closeAll(router.server, t3.server));
  const answer = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: router.port, method: "POST", path: "/", agent: false, headers: { expect: "100-continue", "content-length": 3 } });
    req.on("continue", () => req.end("abc"));
    req.on("response", (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve(text));
    });
    req.on("error", reject);
  });
  assert.equal(answer, "3");
});

test("a streamed response arrives as it is written, not when it ends", async (t) => {
  let finish;
  const t3 = await fakeService("t3", (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    finish = () => res.end("data: last\n\n");
  });
  const router = await routerFor({ t3, setup: null });
  t.after(() => closeAll(router.server, t3.server));
  const first = await new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: router.port, path: "/events", agent: false }, (res) => {
      res.once("data", (chunk) => {
        resolve(chunk.toString());
        res.resume();
        finish();
      });
    });
    req.on("error", reject);
  });
  assert.equal(first, "data: first\n\n");
});

test("a visitor who leaves mid-response closes the upstream request too", async (t) => {
  let upstreamClosed;
  const closed = new Promise((r) => (upstreamClosed = r));
  const t3 = await fakeService("t3", (req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("partial");
    res.on("close", () => upstreamClosed(res.writableFinished));
  });
  const router = await routerFor({ t3, setup: null });
  t.after(() => closeAll(router.server, t3.server));
  await new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: router.port, path: "/long", agent: false }, (res) => {
      res.once("data", () => {
        req.destroy();
        resolve();
      });
    });
    req.on("error", () => {});
  });
  assert.equal(await closed, false, "the upstream response was cut off, not left running");
});

test("an upstream that is not listening yet gets a page that waits, or JSON, and one log line", async (t) => {
  const t3 = { port: await deadPort() };
  const setup = { port: await deadPort() };
  const router = await routerFor({ t3, setup });
  t.after(() => closeAll(router.server));

  const page = await request(router.port, { path: "/", headers: { accept: "text/html,application/xhtml+xml" } });
  assert.equal(page.status, 503);
  assert.equal(page.headers["retry-after"], "2");
  assert.match(page.headers["content-type"], /^text\/html/);
  assert.match(page.body.toString(), /T3 Code is starting/);

  const api = await request(router.port, { path: "/api/auth/session", headers: { accept: "application/json" } });
  assert.equal(api.status, 503);
  assert.match(JSON.parse(api.body).error, /T3 Code is starting/);

  const upload = await request(router.port, { method: "POST", path: "/api/x", headers: { "content-length": 3 }, body: "abc" });
  assert.equal(upload.status, 503, "a request with a body still gets an answer");

  const head = await request(router.port, { method: "HEAD", path: "/", headers: { accept: "text/html" } });
  assert.equal(head.status, 503);
  assert.equal(head.body.length, 0);

  const setupPage = await request(router.port, { path: "/__setup/", headers: { accept: "text/html" } });
  assert.match(setupPage.body.toString(), /The setup page is restarting/);

  assert.equal(router.lines.filter((l) => l.startsWith("T3 Code is not answering")).length, 1, "said once, not per request");
  assert.equal(router.lines.filter((l) => l.startsWith("The setup page is not answering")).length, 1);
});

test("a service that comes up is reached at once, and saying so is logged once", async (t) => {
  const port = await deadPort();
  const router = await routerFor({ t3: { port }, setup: null });
  assert.equal((await request(router.port, { path: "/" })).status, 503);
  const t3 = http.createServer((req, res) => res.end("up"));
  t3.listen(port, "127.0.0.1");
  await once(t3, "listening");
  t.after(() => closeAll(router.server, t3));
  const res = await request(router.port, { path: "/" });
  assert.equal(res.status, 200);
  assert.equal(res.body.toString(), "up");
  assert.deepEqual(router.lines.map((l) => l.split(" (")[0].split(";")[0]), [
    `T3 Code is not answering on 127.0.0.1:${port}`,
    "T3 Code is answering again",
  ]);
});

test("a visitor who gives up before the answer is not logged as the service failing", async (t) => {
  let arrived;
  const reached = new Promise((r) => (arrived = r));
  const t3 = await fakeService("t3", () => arrived());
  t3.server.on("upgrade", (req, socket) => {
    socket.on("end", () => socket.end());
    arrived();
  });
  const router = await routerFor({ t3, setup: null });
  t.after(() => closeAll(router.server, t3.server));

  const req = http.get({ host: "127.0.0.1", port: router.port, path: "/slow", agent: false });
  req.on("error", () => {});
  await reached;
  req.destroy();

  const upgrade = net.connect(router.port, "127.0.0.1", () => upgrade.write(UPGRADE("/ws")));
  upgrade.on("error", () => {});
  await new Promise((r) => setTimeout(r, 50));
  upgrade.destroy();

  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(router.lines, []);
});

test("requests cut short are logged at most once a minute, and never mark the service down", async (t) => {
  const t3 = await fakeService("t3", (req) => req.socket.destroy());
  const router = await routerFor({ t3, setup: null });
  t.after(() => closeAll(router.server, t3.server));
  for (let i = 0; i < 3; i++) await request(router.port, { path: `/${i}` });
  assert.equal(router.lines.length, 1);
  assert.match(router.lines[0], /^T3 Code on 127\.0\.0\.1:\d+ dropped a request \(ECONNRESET\)$/);
});

test("an upstream that dies before answering is a 502, not a hang", async (t) => {
  const t3 = await fakeService("t3", (req) => req.socket.destroy());
  const router = await routerFor({ t3, setup: null });
  t.after(() => closeAll(router.server, t3.server));
  const res = await request(router.port, { path: "/", headers: { accept: "application/json" } });
  assert.equal(res.status, 502);
  assert.match(JSON.parse(res.body).error, /T3 Code didn't answer/);
});

test("keep-alive connections to the upstream are reused", async (t) => {
  const t3 = await fakeService("t3", (req, res) => res.end(String(req.socket.remotePort)));
  const router = await routerFor({ t3, setup: null });
  t.after(() => closeAll(router.server, t3.server));
  const first = (await request(router.port, { path: "/a" })).body.toString();
  const second = (await request(router.port, { path: "/b" })).body.toString();
  assert.equal(first, second, "the second request rode the first one's connection");
});

test("the server's timeouts suit a load balancer in front and long requests", async (t) => {
  const t3 = await fakeService("t3");
  const router = await routerFor({ t3, setup: null });
  t.after(() => closeAll(router.server, t3.server));
  assert.equal(router.server.requestTimeout, 0, "no five-minute cap on an upload");
  assert.ok(router.server.keepAliveTimeout > 60_000, "outlasts a 60-second balancer idle timeout");
  assert.ok(router.server.headersTimeout > router.server.keepAliveTimeout);
});

// -------------------------------------------------------------- upgrades --

/** A raw HTTP/1.1 client: sends `request`, collects everything until `until` matches. */
const rawExchange = (port, request, until) => new Promise((resolve, reject) => {
  const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
  let text = "";
  socket.on("data", (chunk) => {
    text += chunk.toString("latin1");
    if (until.test(text)) resolve({ text, socket });
  });
  socket.on("error", reject);
  socket.on("end", () => resolve({ text, socket }));
});

/** A fake upstream that switches protocols and echoes every byte back. */
const echoUpgrades = (server) => server.on("upgrade", (req, socket, head) => {
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `X-Seen-Forwarded-For: ${req.headers["x-forwarded-for"]}`,
    `X-Seen-Authorization: ${req.headers.authorization}`,
    "", "",
  ].join("\r\n"));
  if (head.length) socket.write(head);
  socket.pipe(socket);
});

const UPGRADE = (path, extra = "") => `GET ${path} HTTP/1.1\r\nHost: t3.example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n`
  + `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer tok\r\n${extra}\r\n`;

test("a WebSocket upgrade is switched through, with its headers, and bytes flow both ways", async (t) => {
  const t3 = await fakeService("t3");
  echoUpgrades(t3.server);
  const router = await routerFor({ t3, setup: null });
  t.after(() => closeAll(router.server, t3.server));

  const { text, socket } = await rawExchange(router.port, UPGRADE("/ws") + "early", /\r\n\r\n[\s\S]*early/);
  assert.match(text, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(text, /X-Seen-Forwarded-For: 127\.0\.0\.1/);
  assert.match(text, /X-Seen-Authorization: Bearer tok/, "the session the socket opens with gets through");
  assert.match(text, /\r\n\r\nearly$/, "bytes sent with the handshake arrive");

  const echoed = new Promise((resolve) => {
    let got = "";
    socket.on("data", (chunk) => {
      got += chunk.toString();
      if (got.includes("ping-2")) resolve(got);
    });
  });
  socket.write("ping-1 ");
  socket.write("ping-2");
  assert.equal(await echoed, "ping-1 ping-2");
  socket.destroy();
});

test("closing either end of an upgraded connection closes the other", async (t) => {
  let upstreamSocket;
  let noteClosed;
  const upstreamClosed = new Promise((resolve) => (noteClosed = resolve));
  const t3 = await fakeService("t3");
  t3.server.on("upgrade", (req, socket) => {
    upstreamSocket = socket;
    // As a WebSocket server does: the other end hanging up ends this one.
    socket.on("end", () => socket.end());
    socket.on("close", () => noteClosed());
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  const router = await routerFor({ t3, setup: null });
  t.after(() => closeAll(router.server, t3.server));

  const { socket } = await rawExchange(router.port, UPGRADE("/ws"), /\r\n\r\n/);
  assert.ok(upstreamSocket);
  socket.destroy();
  await upstreamClosed;

  const second = await rawExchange(router.port, UPGRADE("/ws"), /\r\n\r\n/);
  const clientClosed = once(second.socket, "close");
  upstreamSocket.destroy();
  await clientClosed;
});

test("an upgrade the upstream refuses comes back as its answer", async (t) => {
  const t3 = await fakeService("t3");
  t3.server.on("upgrade", (req, socket) => {
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nContent-Length: 12\r\n\r\nno session\r\n");
  });
  const router = await routerFor({ t3, setup: null });
  t.after(() => closeAll(router.server, t3.server));
  const { text } = await rawExchange(router.port, UPGRADE("/ws"), /no session/);
  assert.match(text, /^HTTP\/1\.1 401 Unauthorized\r\n/);
  assert.match(text, /no session/);
});

test("an upgrade to a service that is not up gets a 503, not a dropped connection", async (t) => {
  const router = await routerFor({ t3: { port: await deadPort() }, setup: null });
  t.after(() => closeAll(router.server));
  const { text } = await rawExchange(router.port, UPGRADE("/ws"), /\}$/);
  assert.match(text, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
  assert.match(text, /retry-after: 2/i);
  assert.match(text, /T3 Code is starting/);
});

test("upgrades under the setup prefix go to the setup page", async (t) => {
  const t3 = await fakeService("t3");
  const setup = await fakeService("setup");
  echoUpgrades(setup.server);
  const router = await routerFor({ t3, setup });
  t.after(() => closeAll(router.server, t3.server, setup.server));
  const { text, socket } = await rawExchange(router.port, UPGRADE("/__setup/live"), /\r\n\r\n/);
  assert.match(text, /^HTTP\/1\.1 101/);
  socket.destroy();
});
