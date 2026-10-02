// Unit tests for the setup console's view model (docker/setup/client/model.js).
//
//   node --test tests/console-model.test.mjs
//
// The model is a classic browser script with no DOM: it is loaded here into a
// bare vm context exactly as the page loads it, and driven with /status and
// /ports payloads shaped like the server's. What each row says and offers,
// what readiness asks for next, and what the palette ranks first are all
// decided here, so this is where those rules are pinned.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../docker/setup/client/model.js", import.meta.url), "utf8");
const context = vm.createContext({ URL });
vm.runInContext(`${source}\nthis.T3Model = T3Model;`, context, { filename: "model.js" });
const M = context.T3Model;
// Objects built inside the vm have their own prototypes; compare as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

const NOW = Date.parse("2026-10-02T12:00:00Z");
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

const harness = (id, overrides = {}) => ({
  id,
  name: M.AGENTS[id].name,
  supported: true,
  installed: true,
  runnable: true,
  signedIn: true,
  installedVersion: "1.0.0",
  version: "1.0.0",
  latestVersion: null,
  failed: false,
  failure: null,
  operation: null,
  inProgress: false,
  canSignIn: id !== "opencode",
  canSetKey: id === "codex" || id === "opencode",
  managedVersions: ["1.0.0"],
  ...overrides,
});
const toolchain = (id, overrides = {}) => ({
  id, name: M.TOOLCHAINS[id].name, installed: true, version: "1.0.0", latestVersion: null,
  failed: false, failure: null, operation: null, inProgress: false, ...overrides,
});
const statusWith = (overrides = {}) => ({
  server: { ok: true, version: "0.0.44" },
  publicUrl: "https://t3.example.com",
  t3: { port: 3773 },
  harnesses: ["claude", "codex", "opencode", "grok", "cursor"].map((id) => harness(id)),
  toolchains: ["go", "rust", "bun", "deno", "uv"].map((id) => toolchain(id)),
  sessions: [{ sessionId: "s1", client: { label: "iPhone", deviceType: "mobile", os: "iOS" }, connected: true, expiresAt: new Date(NOW + 30 * DAY).toISOString() }],
  pairings: [],
  operations: {},
  setup: { state: "finished", items: [] },
  ...overrides,
});
const ui = (overrides = {}) => ({ busy: new Map(), pending: new Map(), notices: new Map(), portsBusy: new Set(), expandedPorts: new Set(), providerNames: [], signingIn: null, ...overrides });
const row = (status, id, extra) => M.agentRows(status, ui(extra), NOW).find((r) => r.id === id);
const tool = (status, id, extra) => M.toolchainRows(status, ui(extra), NOW).find((r) => r.id === id);

// ------------------------------------------------------------------ formats --

test("versions compare by number, not by text", () => {
  assert.equal(M.compareVersions("2.1.290", "2.1.286"), 1);
  assert.equal(M.compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(M.compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(M.compareVersions("1.2", "1.2.1"), -1);
  assert.equal(M.compareVersions("2026.10.02-abc", "2026.10.01-e373342"), 1);
  assert.equal(M.isNewer("2.1.290", "2.1.286"), true);
  assert.equal(M.isNewer("2.1.286", "2.1.286"), false);
  assert.equal(M.isNewer(null, "2.1.286"), false, "unknown is never an update");
  assert.equal(M.isNewer("2.1.290", null), false);
});

test("relative times read the way a person says them", () => {
  assert.equal(M.relTime(NOW - 10 * 1000, NOW), "just now");
  assert.equal(M.relTime(NOW - 6 * MIN, NOW), "6 min ago");
  assert.equal(M.relTime(NOW - 2 * 60 * MIN, NOW), "2 hours ago");
  assert.equal(M.relTime(NOW - DAY, NOW), "yesterday");
  assert.equal(M.relTime(NOW + 12 * DAY, NOW), "in 12 days");
  assert.equal(M.relTime(NOW + DAY, NOW), "tomorrow");
  assert.equal(M.relTime(null, NOW), "—");
  assert.match(M.relTime(NOW - 90 * DAY, NOW), /^\d{1,2} [A-Z][a-z]{2}$/, "far away reads as a date");
});

test("sizes, durations and countdowns", () => {
  assert.equal(M.formatBytes(512), "512 B");
  assert.equal(M.formatBytes(148_000_000), "148 MB");
  assert.equal(M.formatBytes(4_402_341_888), "4.4 GB");
  assert.equal(M.formatBytes(undefined), "—");
  assert.equal(M.duration(45), "45 seconds");
  assert.equal(M.duration(3 * 86400), "3 days");
  assert.equal(M.countdown(14 * MIN + 32 * 1000), "14:32");
  assert.equal(M.countdown(-5), "0:00");
  assert.equal(M.listOf(["Grok Build", "Cursor"]), "Grok Build and Cursor");
  assert.equal(M.listOf(["A", "B", "C"]), "A, B and C");
});

test("progress has a percentage only when the total is known", () => {
  assert.deepEqual(plain(M.progressOf({ phase: "downloading", done: 155_000_000, total: 250_000_000 })),
    { phase: "downloading", pct: 62, done: 155_000_000, total: 250_000_000 });
  assert.equal(M.progressOf({ phase: "verifying" }).pct, null);
  assert.equal(M.progressText(M.progressOf({ phase: "x", done: 148_000_000, total: 238_000_000 })), "62% · 148 of 238 MB");
  assert.equal(M.progressText(M.progressOf({ phase: "x", done: 900_000, total: 1_200_000 })), "75% · 900 kB of 1.2 MB");
  assert.equal(M.progressText(M.progressOf({ phase: "x" })), "");
});

// --------------------------------------------------------------- agent rows --

test("a row shows exactly the one verb its state calls for", () => {
  const s = statusWith({
    harnesses: [
      harness("claude", { latestVersion: "1.1.0" }),
      harness("codex", { authMethod: "apikey" }),
      harness("opencode"),
      harness("grok", { signedIn: false }),
      harness("cursor", { installed: false, runnable: false, signedIn: null, installedVersion: null, version: null }),
    ],
  });
  const claude = row(s, "claude");
  assert.equal(claude.state, "update");
  assert.equal(claude.action.cmd, "harness.update");
  assert.equal(claude.status.text, "Signed in · 1.1.0 is available");
  assert.equal(claude.menu[0].label, "Update to 1.1.0");

  const codex = row(s, "codex");
  assert.equal(codex.action, null, "signed in and current: menu only");
  assert.equal(codex.status.text, "Signed in · stored API key");
  assert.ok(codex.menu.some((m) => m.label === "Use an API key…"));

  const opencode = row(s, "opencode");
  assert.equal(opencode.action.label, "Add key", "OpenCode keeps Add key visible");
  assert.notEqual(opencode.action.variant, "primary");

  const grok = row(s, "grok");
  assert.equal(grok.state, "signin");
  assert.equal(grok.action.cmd, "harness.signin");
  assert.equal(grok.action.variant, "primary");
  assert.deepEqual(plain(grok.status), { dot: "warn", text: "Not signed in · device code" });
  assert.equal(grok.attention, true);

  const cursor = row(s, "cursor");
  assert.equal(cursor.state, "missing");
  assert.equal(cursor.action.cmd, "harness.install");
  assert.deepEqual(plain(cursor.menu.map((m) => m.cmd)), ["harness.version"]);

  for (const r of M.agentRows(s, ui(), NOW)) {
    const last = r.menu[r.menu.length - 1];
    if (r.state !== "missing") assert.equal(last.cmd, "harness.uninstall", `${r.id}: uninstall is last`);
    if (r.state !== "missing") assert.equal(last.danger, true);
  }
});

test("OpenCode names its provider keys when it has them", () => {
  const s = statusWith();
  assert.equal(row(s, "opencode", { providerNames: ["Anthropic", "DeepSeek"] }).status.text, "2 provider keys · Anthropic, DeepSeek");
  assert.equal(row(s, "opencode", { providerNames: ["Anthropic"] }).status.text, "1 provider key · Anthropic");
});

test("work in flight replaces the verb with progress and, for our own work, Cancel", () => {
  const s = statusWith({
    harnesses: [harness("claude", { latestVersion: "1.1.0" }), harness("codex"), harness("opencode"), harness("grok"), harness("cursor")],
    operations: { "harness:claude": { kind: "update", state: "running", progress: { phase: "installing" } } },
  });
  const claude = row(s, "claude");
  assert.equal(claude.state, "running");
  assert.equal(claude.kind, "update");
  assert.equal(claude.badge.text, "Updating");
  assert.equal(claude.versionTo, "1.1.0");
  assert.equal(claude.status.text, "1.0.0 keeps working until this finishes");
  assert.equal(claude.progress.phase, "installing");
  assert.equal(claude.action.cmd, "op.cancel");

  // Started elsewhere (t3-harness, a restart): shown, but not ours to cancel.
  const elsewhere = row(statusWith({ harnesses: [harness("claude", { inProgress: true, operation: "install" })] }), "claude");
  assert.equal(elsewhere.state, "running");
  assert.equal(elsewhere.cancellable, false);
  assert.equal(elsewhere.action, null);

  // A click still in flight shows the kind it asked for.
  const busy = row(statusWith(), "grok", { busy: new Map([["harness:grok", "uninstall"]]) });
  assert.equal(busy.badge.text, "Removing");
});

test("queued work says why it waits, and only our own queue can be cancelled", () => {
  const queued = row(statusWith({ operations: { "harness:grok": { kind: "install", state: "queued" } } }), "grok",
    { pending: new Map([["harness:grok", { kind: "install" }]]) });
  assert.equal(queued.state, "queued", "a pending click that the server queued is not shown as running");
  assert.equal(queued.action.cmd, "op.cancel");

  const firstStart = statusWith({
    harnesses: [harness("grok", { installed: false, runnable: false, signedIn: null })],
    setup: { state: "running", items: [{ kind: "agent", id: "grok", name: "Grok Build", state: "pending" }] },
  });
  const pending = row(firstStart, "grok");
  assert.equal(pending.state, "queued");
  assert.equal(pending.action, null);
  assert.equal(pending.status.text, "First start installs it in the background");
});

test("failures keep the row usable and say what happened", () => {
  const s = statusWith({
    harnesses: [
      harness("claude", { failed: true, failure: "network down", operation: "update" }),
      harness("codex", { runnable: false, failure: "Illegal instruction" }),
      harness("opencode", { installed: false, runnable: false, signedIn: null, failed: true, failure: "404", operation: "install" }),
      harness("grok", { supported: false, installed: false }),
      harness("cursor", { signedIn: null }),
    ],
  });
  const claude = row(s, "claude");
  assert.equal(claude.state, "failed");
  assert.equal(claude.action.label, "Retry");
  assert.equal(claude.action.variant, "warning");
  assert.deepEqual(plain(claude.status), { dot: "danger", text: "Update failed: network down" });
  assert.equal(row(s, "codex").action.label, "Reinstall");
  assert.deepEqual(plain(row(s, "opencode").status), { dot: "danger", text: "Install failed: 404" });
  assert.equal(row(s, "grok").state, "unsupported");
  assert.equal(row(s, "grok").action, null);
  assert.equal(row(s, "cursor").status.text, "Sign-in state not readable");
});

test("the row being signed in says so and offers nothing else", () => {
  const signing = row(statusWith({ harnesses: [harness("grok", { signedIn: false })] }), "grok", { signingIn: "grok" });
  assert.equal(signing.state, "signing");
  assert.equal(signing.badge.text, "Signing in");
  assert.equal(signing.status.text, "Waiting for approval on another device");
  assert.equal(signing.action, null);
  assert.equal(signing.menu.length, 0);
});

test("a row's own error stays on it until the next action", () => {
  const r = row(statusWith(), "codex", { notices: new Map([["harness:codex", { tone: "danger", text: "boom" }]]) });
  assert.deepEqual(plain(r.notice), { tone: "danger", text: "boom" });
});

// ----------------------------------------------------------- toolchain rows --

test("toolchains follow the same rules without sign-in", () => {
  const s = statusWith({
    toolchains: [
      toolchain("go", { latestVersion: "1.0.0" }),
      toolchain("rust", { latestVersion: "1.98.1", inProgress: true, operation: "update" }),
      toolchain("bun", { latestVersion: "1.0.1" }),
      toolchain("deno"),
      toolchain("uv", { installed: false, version: null }),
    ],
    setup: { state: "finished", items: [{ kind: "toolchain", id: "go", state: "done" }] },
  });
  assert.equal(tool(s, "go").status.text, "Installed · up to date");
  const rust = tool(s, "rust");
  assert.equal(rust.state, "running");
  assert.equal(rust.versionTo, "1.98.1");
  assert.equal(rust.status.text, "With clippy and rustfmt · 1.0.0 keeps working until this finishes");
  assert.equal(tool(s, "bun").action.cmd, "toolchain.update");
  assert.equal(tool(s, "deno").status.text, "Installed", "no claim about updates when the latest is unknown");
  const uv = tool(s, "uv");
  assert.equal(uv.state, "missing");
  assert.equal(uv.dim, true);
  assert.deepEqual(plain(uv.status), { dot: null, text: "Not installed · left out of", code: "T3_PREINSTALL" });
  assert.equal(tool(statusWith({ toolchains: [toolchain("uv", { installed: false })], setup: { state: "off", items: [] } }), "uv").status.text, "Not installed");
});

// ---------------------------------------------------------------- readiness --

test("readiness has exactly one next step, and collapses when everything is done", () => {
  const cases = [
    statusWith({ server: { ok: false, detail: "ECONNREFUSED" }, publicUrl: null, sessions: [] }),
    statusWith({ publicUrl: null, sessions: [] }),
    statusWith({ sessions: [] }),
    statusWith({ harnesses: [harness("grok", { signedIn: false }), harness("cursor", { signedIn: false })] }),
    statusWith(),
  ];
  const nexts = cases.map((s) => M.readiness(s, ui()).next);
  assert.deepEqual(nexts, ["server", "url", "pair", "agents", null]);
  for (const s of cases) {
    const r = M.readiness(s, ui());
    assert.ok(r.steps.filter((step) => step.state === "todo").length <= 1, "never two todos");
    const primaries = r.steps.filter((step) => step.action && step.action.variant === "primary");
    assert.equal(primaries.length, r.ready ? 0 : r.steps.find((step) => step.state === "todo").action ? 1 : 0, "one primary at most");
  }
  assert.equal(M.readiness(cases[4], ui()).ready, true);
  assert.equal(M.readiness(cases[4], ui()).title, "Ready");
});

test("a later step that needs the user is a warning, not a second todo", () => {
  const s = statusWith({ sessions: [], harnesses: [harness("grok", { signedIn: false }), harness("cursor", { signedIn: false })] });
  const r = M.readiness(s, ui());
  assert.equal(r.next, "pair");
  const agents = r.steps.find((step) => step.id === "agents");
  assert.equal(agents.state, "warn");
  assert.equal(agents.desc, "Grok Build and Cursor are installed but not signed in.");
  assert.equal(agents.action.label, "Review 2");
  assert.notEqual(agents.action.variant, "primary");
  assert.equal(r.title, "Pair your first device");
  assert.equal(r.done, 2);
});

test("the ready summary counts what is set up and what still wants a look", () => {
  const s = statusWith({ sessions: [{ sessionId: "a" }, { sessionId: "b" }] });
  assert.equal(M.readySummary(s, ui()), "2 devices paired · 5 agents signed in · 5 toolchains · nothing needs you");
  const update = statusWith({ harnesses: [harness("claude", { latestVersion: "2.0.0" })] });
  assert.match(M.readySummary(update, ui()), /1 thing to look at$/);
});

// ------------------------------------------------------ attention and badges --

test("needs-you lists failures before sign-ins before updates", () => {
  const s = statusWith({
    harnesses: [
      harness("claude", { latestVersion: "2.0.0" }),
      harness("codex", { signedIn: false }),
      harness("opencode", { failed: true, failure: "x", operation: "update" }),
      harness("grok"),
      harness("cursor"),
    ],
  });
  assert.deepEqual(plain(M.needsYou(s, null, ui()).map((r) => r.id)), ["opencode", "codex", "claude"]);
});

test("navigation badges warn about what needs the user, and count what is live", () => {
  const s = statusWith({
    harnesses: [harness("grok", { signedIn: false }), harness("cursor", { signedIn: false }), harness("claude")],
    toolchains: [toolchain("rust", { inProgress: true, operation: "update" }), toolchain("go")],
  });
  const ports = { available: true, listening: [3000, 5173], tunnels: [{ port: 3000, state: "open", url: "https://a.trycloudflare.com" }] };
  const b = M.navBadges(s, ports, ui());
  assert.deepEqual(plain(b.agents), { tone: "warn", count: 2 });
  assert.deepEqual(plain(b.toolchains), { tone: "info", count: 1 });
  assert.deepEqual(plain(b.ports), { tone: "info", count: 1 });
  assert.deepEqual(plain(b.devices), { count: 1 });
  const failedPort = { available: true, listening: [8080], tunnels: [{ port: 8080, state: "failed", error: "edge" }] };
  assert.deepEqual(plain(M.navBadges(s, failedPort, ui()).ports), { tone: "warn", count: 1 });
});

// --------------------------------------------------------------------- ports --

test("port rows join what listens with what is published, and spot databases", () => {
  const ports = {
    available: true,
    listening: [5432, 3000, 5173],
    details: [{ port: 3000, process: "next-server", address: "127.0.0.1" }, { port: 5173, process: "vite", address: "0.0.0.0" }],
    tunnels: [{ port: 3000, state: "open", url: "https://q.trycloudflare.com", startedAt: NOW - 6 * MIN }, { port: 8080, state: "failed", error: "edge" }],
  };
  const rows = M.portRows(ports, ui({ expandedPorts: new Set([3000, 5173]) }), NOW);
  assert.deepEqual(plain(rows.map((r) => [r.port, r.state])), [[3000, "open"], [5173, "idle"], [5432, "idle"], [8080, "failed"]]);
  assert.equal(rows[0].expanded, true);
  assert.equal(rows[1].expanded, false, "only a published port expands");
  assert.equal(rows[2].db, true, "5432 asks before publishing");
  assert.equal(rows[1].db, false);
  assert.equal(rows[3].listening, false);
  assert.equal(M.portRows({ listening: [7000], tunnels: [] }, ui({ portsBusy: new Set([7000]) }), NOW)[0].state, "starting");
  assert.equal(M.looksLikeDatabase(6000, "redis-server"), true);
});

// ------------------------------------------------------------------- devices --

test("devices read as what they are and when they were last seen", () => {
  const rows = M.deviceRows([
    { sessionId: "a", client: { label: "iPhone", deviceType: "mobile", os: "iOS", browser: "Safari" }, connected: false, lastConnectedAt: new Date(NOW - 2 * 60 * MIN).toISOString(), expiresAt: new Date(NOW + 12 * DAY).toISOString() },
    { sessionId: "b", client: { label: "work-laptop", deviceType: "desktop", os: "macOS" }, connected: true },
    { sessionId: "c", client: { deviceType: "mobile" } },
  ], NOW);
  assert.equal(rows[0].status, "Safari on iOS · seen 2 hours ago");
  assert.equal(rows[0].ends, "session ends in 12 days");
  assert.equal(rows[0].icon, "smartphone");
  assert.equal(rows[1].status, "macOS desktop app · active now");
  assert.equal(rows[1].icon, "laptop");
  assert.equal(rows[2].name, "Device");
  assert.equal(rows[2].status, "Mobile app · not connected yet");
});

// ------------------------------------------------------------------- palette --

test("the palette puts what needs the user first, then everything by group", () => {
  const s = statusWith({ harnesses: [harness("grok", { signedIn: false }), harness("claude", { latestVersion: "2.0.0" }), harness("codex")] });
  const items = M.paletteItems(s, { available: true, listening: [5173], tunnels: [] }, ui(), NOW);
  const ranked = M.searchPalette(items, "");
  assert.equal(ranked[0].group, "Needs you");
  assert.ok(ranked.slice(0, 3).some((i) => i.label === "Sign in Grok Build"));
  assert.ok(ranked.some((i) => i.group === "Go to" && i.label === "Agents" && i.shortcut === "G A"));
  assert.ok(!ranked.some((i) => i.group === "Devices"), "devices only appear when searched for");
});

test("searching matches anywhere, ranks word starts first, and marks the match", () => {
  const ports = {
    available: true,
    listening: [5173, 5432, 3000],
    details: [{ port: 5173, process: "vite" }, { port: 5432, process: "postgres", looksLikeDatabase: true }],
    tunnels: [{ port: 3000, state: "open", url: "https://q.trycloudflare.com" }],
  };
  const items = M.paletteItems(statusWith(), ports, ui(), NOW);
  const hits = M.searchPalette(items, "pub");
  const labels = hits.map((i) => i.label);
  assert.deepEqual(plain(labels.slice(0, 2)), ["Publish port 5173", "Publish port 5432…"]);
  assert.ok(labels.includes("Copy published URL for port 3000"));
  assert.ok(labels.includes("Copy public URL"));
  assert.deepEqual(plain(hits[0].match), [0, 3]);
  assert.deepEqual(plain(hits.find((i) => i.label === "Copy published URL for port 3000").match), [5, 8]);
  assert.equal(hits.find((i) => i.label === "Publish port 5432…").meta.text, "database");
  assert.equal(M.searchPalette(items, "zzz").length, 0);
});

// --------------------------------------------------------------- diagnostics --

test("diagnostics leave out what identifies a person or a device", () => {
  const s = statusWith({
    sessions: [{ sessionId: "abcdef0123456789", client: { label: "iPhone", ipAddress: "10.0.0.2", userAgent: "UA" } }],
    pairings: [{ id: "0123456789abcdef", label: "x" }],
  });
  const report = M.redactedDiagnostics(s, { tunnels: [{ port: 3000, qr: "<svg/>" }] }, { console: { base: "/" } });
  assert.equal(report.status.sessions[0].client.ipAddress, undefined);
  assert.equal(report.status.sessions[0].client.userAgent, undefined);
  assert.equal(report.status.sessions[0].sessionId, "abcdef01…");
  assert.equal(report.status.pairings[0].id, "01234567…");
  assert.equal(report.ports.tunnels[0].qr, undefined);
  assert.equal(report.console.base, "/");
  assert.equal(s.sessions[0].client.ipAddress, "10.0.0.2", "the live status is not modified");
});

// -------------------------------------------------------------------- banner --

test("the first-start banner names what is still installing", () => {
  const banner = M.setupBanner({
    setup: {
      state: "running",
      items: [
        { name: "Claude Code", state: "done" }, { name: "Rust", state: "installing" }, { name: "uv", state: "pending" },
      ],
    },
  });
  assert.equal(banner.done, 1);
  assert.equal(banner.total, 3);
  assert.equal(banner.pct, 33);
  assert.equal(banner.text, "installing Rust and uv in the background. Everything else is ready.");
  assert.equal(M.setupBanner({ setup: { state: "finished", items: [] } }), null);
});

test("a query finds items by the words people use, in any order", () => {
  const items = M.paletteItems(statusWith({ harnesses: [harness("grok", { signedIn: false })] }), null, ui(), NOW);
  const top = (q) => M.searchPalette(items, q)[0]?.label;
  assert.equal(top("go to env"), "Environment");
  assert.equal(top("log out"), "Lock console");
  assert.equal(top("login grok"), "Sign in Grok Build");
  assert.equal(top("toolch"), "Toolchains", "the group with the best match leads");
});
