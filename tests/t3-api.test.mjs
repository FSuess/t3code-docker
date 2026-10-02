// Unit tests for the console's client of T3 Code's own API and the Antigravity
// row built on it (docker/setup/t3-api.mjs, docker/setup/antigravity.mjs).
//
//   node --test tests/t3-api.test.mjs
//
// A fake T3 speaks the same Effect RPC frames over a fake WebSocket: Request,
// Chunk (acknowledged with Ack), Exit, Interrupt. Its installer and sign-in
// follow the states the real one reports.
import assert from "node:assert/strict";
import test from "node:test";

import { antigravityFacts, createAntigravity } from "../docker/setup/antigravity.mjs";
import { createT3Api, failureOf } from "../docker/setup/t3-api.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (n = 6) => { for (let i = 0; i < n; i += 1) await tick(); };

/** A T3 with one Antigravity provider, an installer and a Google sign-in. */
function fakeT3({ tokens = new Set(["good"]) } = {}) {
  const t3 = {
    tokens,
    sockets: [],
    requests: [],
    acks: 0,
    interrupts: [],
    settings: { enabled: false },
    install: { driver: "antigravity", operationId: null, phase: "idle", downloadedBytes: 0, totalBytes: 1000, version: "agy_acp_server_1.1.1", installedVersion: null, canRemove: false, message: null },
    auth: { instanceId: "antigravity", phase: "idle", flowId: null, authorizationUrl: null, expiresAt: null, message: null },
    authStatus: "unknown",
    streams: { install: new Set(), auth: new Set() },
  };
  const provider = () => ({
    instanceId: "antigravity", driver: "antigravity", enabled: t3.settings.enabled,
    installed: Boolean(t3.install.installedVersion), version: t3.install.installedVersion,
    status: t3.settings.enabled ? "warning" : "disabled", auth: { status: t3.authStatus, type: "oauth-personal", email: t3.authStatus === "authenticated" ? "dev@example.com" : undefined },
    setup: { canInstall: true, canAuthenticate: true }, message: null,
  });
  const push = (kind, state) => {
    for (const { socket, id } of t3.streams[kind]) socket.deliver({ _tag: "Chunk", requestId: id, values: [state] });
  };
  t3.setInstall = (patch) => { t3.install = { ...t3.install, ...patch }; push("install", t3.install); };
  t3.setAuth = (patch) => { t3.auth = { ...t3.auth, ...patch }; push("auth", t3.auth); };
  const fail = (detail, operation) => ({ _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "ProviderSetupError", instanceId: "antigravity", operation, detail } }] });

  t3.handle = (socket, message) => {
    if (message._tag === "Ack") { t3.acks += 1; return; }
    if (message._tag === "Interrupt") {
      t3.interrupts.push(message.requestId);
      for (const set of Object.values(t3.streams)) for (const entry of set) if (entry.socket === socket && entry.id === message.requestId) set.delete(entry);
      return;
    }
    if (message._tag !== "Request") return;
    t3.requests.push(message.tag);
    const answer = (exit) => socket.deliver({ _tag: "Exit", requestId: message.id, exit });
    const ok = (value) => answer({ _tag: "Success", value });
    switch (message.tag) {
      case "server.getConfig": return ok({ providers: [provider()] });
      case "server.updateSettings":
        Object.assign(t3.settings, message.payload.patch.providers.antigravity);
        return ok({});
      case "server.refreshProviders": return ok({});
      case "provider.install.subscribe":
        t3.streams.install.add({ socket, id: message.id });
        return socket.deliver({ _tag: "Chunk", requestId: message.id, values: [t3.install] });
      case "provider.auth.subscribe":
        t3.streams.auth.add({ socket, id: message.id });
        return socket.deliver({ _tag: "Chunk", requestId: message.id, values: [t3.auth] });
      case "provider.install.start":
        if (t3.install.installedVersion === t3.install.version) return ok({ ...t3.install, phase: "idle" });
        t3.install = { ...t3.install, operationId: "op-1", phase: "downloading", downloadedBytes: 0, message: "Downloading" };
        return ok(t3.install);
      case "provider.install.cancel":
        if (message.payload.operationId !== t3.install.operationId) return answer(fail("This installation is no longer current.", "cancel"));
        t3.setInstall({ phase: "cancelled", message: "Installation cancelled." });
        return ok(t3.install);
      case "provider.install.remove":
        if (t3.busy || (t3.settings.enabled && t3.holdsWhileEnabled)) return answer(fail("Stop Antigravity sessions and sign-in flows before removing its managed runtime.", "remove"));
        t3.install = { ...t3.install, installedVersion: null, phase: "idle", operationId: null };
        return ok(t3.install);
      case "provider.auth.start":
        t3.auth = { ...t3.auth, phase: "starting", flowId: "flow-1", expiresAt: "2026-10-02T12:05:00.000Z", message: "Starting Google sign-in." };
        return ok(t3.auth);
      case "provider.auth.complete":
        if (message.payload.flowId !== t3.auth.flowId) return answer(fail("This sign-in is no longer active in this client.", "complete"));
        t3.setAuth({ phase: "verifying" });
        return ok(t3.auth);
      case "provider.auth.cancel":
        t3.setAuth({ phase: "cancelled", flowId: message.payload.flowId, message: "Google sign-in was cancelled." });
        return ok(t3.auth);
      default:
        return answer({ _tag: "Failure", cause: [{ _tag: "Die", defect: `Unknown request tag: ${message.tag}` }] });
    }
  };

  /** The WebSocket the client constructs: opens when the bearer token is one T3 knows. */
  t3.WebSocket = class {
    constructor(url, { headers } = {}) {
      this.url = url;
      this.listeners = {};
      this.closed = false;
      const token = String(headers?.authorization ?? "").replace(/^Bearer /, "");
      t3.sockets.push(this);
      setImmediate(() => {
        if (t3.tokens.has(token)) this.emit("open", {});
        else this.emit("error", {});
      });
    }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    emit(type, event) {
      const fns = this.listeners[type] ?? [];
      this.listeners[type] = fns.filter((fn) => !fn.once);
      for (const fn of fns) fn(event);
    }
    send(text) { setImmediate(() => t3.handle(this, JSON.parse(text))); }
    deliver(message) { if (!this.closed) setImmediate(() => this.emit("message", { data: JSON.stringify(message) })); }
    close() { if (this.closed) return; this.closed = true; setImmediate(() => this.emit("close", {})); }
  };
  // `{ once: true }` listeners, as the DOM does them.
  const add = t3.WebSocket.prototype.addEventListener;
  t3.WebSocket.prototype.addEventListener = function (type, fn, options) {
    if (options?.once) fn.once = true;
    return add.call(this, type, fn);
  };
  return t3;
}

const apiFor = (t3, extra = {}) => {
  const issued = [];
  const revoked = [];
  let next = 0;
  const api = createT3Api({
    url: "ws://127.0.0.1:3773/ws",
    WebSocketImpl: t3.WebSocket,
    issueSession: async () => {
      const token = extra.tokens?.[next] ?? "good";
      next += 1;
      issued.push(token);
      return { token, sessionId: `s${next}`, expiresAt: extra.expiresAt ?? "2099-01-01T00:00:00.000Z" };
    },
    revokeSession: async (id) => { revoked.push(id); },
    idleMs: 50,
    ...extra.options,
  });
  return { api, issued, revoked };
};

test("a call is a Request answered by an Exit; a failure carries T3's own sentence", async () => {
  const t3 = fakeT3();
  const { api, issued } = apiFor(t3);
  const config = await api.call("server.getConfig", {});
  assert.equal(config.providers[0].instanceId, "antigravity");
  await assert.rejects(api.call("provider.install.cancel", { instanceId: "antigravity", operationId: "nope" }), /no longer current/);
  await assert.rejects(api.call("no.such.method", {}), /Unknown request tag/);
  assert.deepEqual(issued, ["good"], "one session for the lot");
  assert.equal(t3.sockets.length, 1, "one connection for the lot");
  api.close();
});

test("a failure reads as its detail, a defect as its text", () => {
  assert.equal(failureOf({ cause: [{ _tag: "Fail", error: { _tag: "ProviderSetupError", operation: "remove", detail: "Stop sessions first." } }] }).message, "Stop sessions first.");
  assert.equal(failureOf({ cause: [{ _tag: "Fail", error: { _tag: "ProviderSetupError", detail: "x" } }] }).tag, "ProviderSetupError");
  assert.equal(failureOf({ cause: [{ _tag: "Die", defect: "boom" }] }).message, "boom");
  assert.equal(failureOf({}).message, "T3 Code refused the request");
});

test("a stream's chunks are acknowledged, and closing it interrupts it", async () => {
  const t3 = fakeT3();
  const { api } = apiFor(t3);
  const seen = [];
  const sub = await api.subscribe("provider.install.subscribe", { instanceId: "antigravity" }, (state) => seen.push(state.phase));
  await settle();
  t3.setInstall({ phase: "downloading", downloadedBytes: 400 });
  await settle();
  assert.deepEqual(seen, ["idle", "downloading"]);
  assert.equal(t3.acks, 2, "each chunk acknowledged");
  sub.close();
  await settle();
  assert.equal(t3.interrupts.length, 1);
  assert.equal((await api.first("provider.install.subscribe", { instanceId: "antigravity" })).phase, "downloading");
  api.close();
});

test("a refused session is replaced and the old one revoked; the connection closes when idle", async () => {
  const t3 = fakeT3();
  const { api, issued, revoked } = apiFor(t3, { tokens: ["stale", "good"] });
  await api.call("server.getConfig", {});
  assert.deepEqual(issued, ["stale", "good"]);
  assert.deepEqual(revoked, ["s1"]);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(t3.sockets.at(-1).closed, true, "nothing in flight: the socket goes");
  await api.call("server.getConfig", {});
  assert.equal(issued.length, 2, "the session outlives the socket");
  api.close();
});

test("a session near its end is renewed on the next connection, not under one in use", async () => {
  const t3 = fakeT3();
  const soon = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { api, issued } = apiFor(t3, { expiresAt: soon });
  await api.call("server.getConfig", {});
  await api.call("server.getConfig", {});
  assert.equal(issued.length, 1, "the open connection keeps its session");
  api.close();
  await api.call("server.getConfig", {});
  assert.equal(issued.length, 2, "a new connection renews one within the hour");
  api.close();
});

test("Antigravity's row reads T3's provider and installer, in the shape of an agent", () => {
  const facts = antigravityFacts({
    provider: { instanceId: "antigravity", enabled: true, installed: true, version: "agy_acp_server_1.1.1", status: "ready", auth: { status: "authenticated", email: "dev@example.com" }, setup: { canInstall: true, canAuthenticate: true } },
    install: { phase: "idle", version: "agy_acp_server_1.2.0", installedVersion: "agy_acp_server_1.1.1", totalBytes: 1000 },
  });
  assert.equal(facts.id, "antigravity");
  assert.equal(facts.managedBy, "t3");
  assert.equal(facts.version, "1.1.1");
  assert.equal(facts.latestVersion, "1.2.0", "T3 pins a newer release: an update");
  assert.equal(facts.signedIn, true);
  assert.equal(facts.account, "dev@example.com");
  assert.equal(facts.inProgress, false);
  const busy = antigravityFacts({ provider: { instanceId: "antigravity", setup: {} }, install: { phase: "downloading", downloadedBytes: 250, totalBytes: 1000, version: "agy_acp_server_1.1.1" } });
  assert.equal(busy.installed, false);
  assert.equal(busy.inProgress, true);
  assert.deepEqual(busy.progress, { phase: "downloading", done: 250, total: 1000 });
  assert.deepEqual(antigravityFacts({ provider: { setup: {} }, install: { phase: "extracting", downloadedBytes: 1000, totalBytes: 1000 } }).progress, { phase: "extracting" }, "no bar stuck at 100% while it unpacks");
  assert.equal(busy.signedIn, null);
  const down = antigravityFacts({ error: "T3 Code did not answer" });
  assert.equal(down.reachable, false);
  assert.equal(down.available, false);
});

test("installing turns Antigravity on, reports T3's download, and finishes with T3", async () => {
  const t3 = fakeT3();
  const { api } = apiFor(t3);
  const ag = createAntigravity({ api });
  const progress = [];
  let started = false;
  const done = ag.install({ onStarted: () => { started = true; }, onProgress: (p) => progress.push(p) });
  await settle(12);
  assert.equal(t3.settings.enabled, true, "on in T3 before the download");
  assert.equal(started, true);
  t3.setInstall({ phase: "downloading", downloadedBytes: 600 });
  await settle();
  t3.setInstall({ phase: "succeeded", downloadedBytes: 1000, installedVersion: "agy_acp_server_1.1.1" });
  const result = await done;
  assert.deepEqual(result, { ok: true, code: "installed", version: "1.1.1" });
  assert.deepEqual(progress.at(-1), { phase: "downloading", done: 600, total: 1000 });
  const row = await ag.status();
  assert.equal(row.installed, true);
  assert.equal(row.enabled, true);
  // Already on the pinned release: T3 answers at once and nothing downloads.
  assert.deepEqual(await ag.install(), { ok: true, code: "installed", version: "1.1.1" });
  api.close();
});

test("cancelling an install goes through T3; removing the runtime turns Antigravity off", async () => {
  const t3 = fakeT3();
  const { api } = apiFor(t3);
  const ag = createAntigravity({ api });
  const controller = new AbortController();
  const done = ag.install({ signal: controller.signal });
  await settle(12);
  controller.abort();
  assert.deepEqual(await done, { ok: false, code: "cancelled", error: "cancelled" });
  assert.ok(t3.requests.includes("provider.install.cancel"));
  t3.install = { ...t3.install, installedVersion: "agy_acp_server_1.1.1", phase: "idle" };
  t3.settings.enabled = true;
  await ag.refresh();
  t3.busy = true;
  const refused = await ag.uninstall();
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Stop Antigravity sessions/);
  assert.equal(t3.settings.enabled, true, "a refused removal leaves it on, as it was");
  t3.busy = false;
  // T3 holds the runtime of an enabled provider: it has to go off first.
  t3.holdsWhileEnabled = true;
  assert.deepEqual(await ag.uninstall(), { ok: true, code: "uninstalled" });
  assert.equal(t3.settings.enabled, false);
  assert.equal((await ag.status()).installed, false);
  api.close();
});

test("sign-in follows T3's flow: a Google link, the pasted address, T3's verdict", async () => {
  const t3 = fakeT3();
  // An earlier sign-in someone cancelled: the stream opens on that.
  t3.auth = { ...t3.auth, phase: "cancelled", flowId: "flow-0", message: "Google sign-in was cancelled." };
  const { api } = apiFor(t3);
  const ag = createAntigravity({ api });
  const states = [];
  const flow = await ag.signIn((state) => states.push(state.phase));
  assert.equal(flow.flowId, "flow-1");
  t3.setAuth({ phase: "waiting", authorizationUrl: "https://accounts.google.com/o/oauth2/auth?x=1" });
  await settle();
  await ag.completeSignIn("flow-1", "http://127.0.0.1:52219/?code=abc&state=def");
  t3.setAuth({ phase: "succeeded" });
  await settle();
  assert.deepEqual(states.filter((p, i) => states.indexOf(p) === i), ["starting", "waiting", "verifying", "succeeded"], "never the state an earlier flow left");
  await assert.rejects(ag.completeSignIn("other", "http://127.0.0.1:1/"), /no longer active/);
  flow.close();
  api.close();
});
