// Unit tests for the persistent harness manager.
//
//   node --test tests/harness-manager.test.mjs
//
// Everything runs against an in-memory filesystem and a fake mise/CLI runner,
// so exact-version resolution, locking, interrupted-operation recovery, and
// credential preservation are exercised deterministically, with no container
// and no network.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  CATALOGUE,
  TOOLCHAINS,
  createHarnessManager,
  getHarness,
  normalizeArch,
} from "../docker/harness/index.mjs";
import { firstError } from "../docker/harness/mise.mjs";
import * as lock from "../docker/harness/lock.mjs";

const HOME = "/home/t3";
const DATA_DIR = path.join(HOME, ".local/share/mise");
const STATE_DIR = path.join(HOME, ".local/state/mise");
/** Minimal async filesystem with the semantics the manager relies on. */
class MemoryFs {
  constructor() {
    this.files = new Map();
    this.links = new Map();
    this.dirs = new Set(["/"]);
  }

  seedFile(filePath, content, mode = 0o644) {
    this.files.set(filePath, { content: String(content), mode });
    const parent = path.dirname(filePath);
    if (parent && parent !== "/") this.dirs.add(parent);
  }

  async writeFile(filePath, data, options = {}) {
    const flag = typeof options === "object" ? options.flag : undefined;
    const mode = typeof options === "object" ? options.mode ?? 0o644 : 0o644;
    if (flag === "wx" && this.files.has(filePath)) {
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    }
    this.seedFile(filePath, data, mode);
  }

  async readFile(filePath) {
    const entry = this.files.get(filePath);
    if (!entry) throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
    return entry.content;
  }

  async mkdir(dirPath) {
    this.dirs.add(dirPath);
  }

  async rename(from, to) {
    const entry = this.files.get(from);
    if (!entry) throw Object.assign(new Error(`ENOENT: ${from}`), { code: "ENOENT" });
    this.files.set(to, entry);
    this.files.delete(from);
  }

  async symlink(target, linkPath) {
    if (this.files.has(linkPath) || this.links.has(linkPath)) {
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    }
    this.links.set(linkPath, target);
  }

  async readlink(linkPath) {
    if (!this.links.has(linkPath)) throw Object.assign(new Error("EINVAL"), { code: "EINVAL" });
    return this.links.get(linkPath);
  }

  async link(from, to) {
    const entry = this.files.get(from);
    if (!entry) throw Object.assign(new Error(`ENOENT: ${from}`), { code: "ENOENT" });
    if (this.files.has(to)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    this.files.set(to, { ...entry });
  }

  async unlink(filePath) {
    if (this.links.delete(filePath)) return;
    if (!this.files.delete(filePath)) {
      throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
    }
  }

  async rm(target) {
    this.files.delete(target);
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(`${target}/`)) this.files.delete(key);
    }
  }

  async stat(target) {
    const entry = this.files.get(target);
    if (entry) return { isFile: () => true, isDirectory: () => false, mode: entry.mode };
    if (this.dirs.has(target)) return { isFile: () => false, isDirectory: () => true, mode: 0o755 };
    throw Object.assign(new Error(`ENOENT: ${target}`), { code: "ENOENT" });
  }

  async exists(target) {
    return this.files.has(target) || this.dirs.has(target);
  }

  snapshot() {
    return JSON.stringify([...this.files.entries()].sort());
  }
}

/** A fake mise plus fake harness CLIs, sharing one filesystem. */
function createWorld(fs, { arch = "x64" } = {}) {
  const world = {
    fs,
    arch,
    latest: {
      claude: "2.1.273", codex: "0.154.1", opencode: "1.18.31", grok: "1.0.34", "cursor-agent": "2026.09.15-d2fe57e",
      go: "1.27.1", rust: "1.98.1", bun: "1.4.2", deno: "2.9.7", uv: "0.12.21",
    },
    tools: {},
    selected: {},
    binVersions: new Map(),
    calls: [],
    failUse: null,
    runVersionOverride: {},
    useSpecs: [],
    failProbe: [],
  };

  world.versionsOf = (tool) => (world.tools[tool] ?? []).map((entry) => entry.version);
  world.execPath = (tool, version) =>
    path.join(DATA_DIR, "installs", tool, version, entryForTool(tool).executable);

  world.run = async (argv) => {
    world.calls.push(argv.join(" "));
    const [bin] = argv;

    if (bin !== "mise") {
      if (world.failProbe.some((fragment) => bin.includes(fragment))) return fail("Illegal instruction");
      const version = world.binVersions.get(bin) ?? "0.0.0";
      if (argv[1] === "--version" || argv[1] === "version") return ok(`${version}\n`);
      if (bin.endsWith("claude") && argv[1] === "auth") return ok('{"loggedIn":true}\n');
      if (bin.endsWith("codex") && argv[1] === "login") return ok("Logged in\n");
      if (bin.endsWith("grok") && argv[1] === "models") return ok("You are logged in\n");
      if (bin.endsWith("cursor-agent") && argv[1] === "status") return ok('{"isAuthenticated":true}\n');
      return fail("unexpected executable call");
    }

    const command = argv[3];
    // mise args put flags before the tool (`use -g tool@version`), so the tool
    // is always the final argv entry.
    const tool = argv[argv.length - 1];
    if (command === "ls") {
      const ordered = {};
      for (const [name, entries] of Object.entries(world.tools)) {
        if (entries.length) ordered[name] = entries;
      }
      return ok(`${JSON.stringify(ordered)}\n`);
    }
    if (command === "latest") return ok(`${world.latest[tool]}\n`);
    if (command === "which") {
      // Rust's binaries are cargo/rustc, not "rust".
      const selected = world.selected[tool === "cargo" ? "rust" : tool];
      return selected ? ok(`${selected}\n`) : fail("not a mise bin");
    }
    if (command === "use") {
      // `tool[options]@version`: options are mise's business, not the fake's.
      const [spec, version] = String(tool).split("@");
      const name = spec.replace(/\[.*\]$/, "");
      world.useSpecs.push(String(tool));
      if (world.failUse) return fail(world.failUse);
      const install = path.join(DATA_DIR, "installs", name, version);
      const executable = path.join(install, entryForTool(name)?.executable ?? `bin/${name}`);
      fs.seedFile(executable, "", 0o755);
      world.binVersions.set(executable, version);
      world.selected[name] = executable;
      world.tools[name] = [
        ...world.tools[name]?.filter((entry) => entry.source).map((entry) => ({ ...entry, active: false })) ?? [],
        {
          version,
          requested_version: version,
          install_path: install,
          source: { type: "mise.toml", path: path.join(HOME, ".config/mise/config.toml") },
          installed: true,
          active: true,
        },
      ];
      return ok("");
    }
    if (command === "unuse") {
      for (const entry of world.tools[tool] ?? []) delete entry.source;
      return ok("");
    }
    if (command === "uninstall") {
      const [name, version] = String(tool).split("@");
      world.tools[name] = (world.tools[name] ?? []).filter((entry) => entry.version !== version);
      if (world.selected[name]?.includes(`/${version}/`)) delete world.selected[name];
      return ok("");
    }
    return fail(`unexpected mise command ${command}`);
  };

  const ok = (stdout) => ({ code: 0, signal: null, stdout, stderr: "", error: null });
  const fail = (stderr) => ({ code: 1, signal: null, stdout: "", stderr, error: null });
  world.ok = ok;
  world.fail = fail;
  return world;
}

function entryForTool(miseTool) {
  return CATALOGUE.find((entry) => entry.miseTool === miseTool) ?? null;
}

function managerFor(world, overrides = {}) {
  return createHarnessManager({
    env: { HOME, MISE_DATA_DIR: DATA_DIR, MISE_STATE_DIR: STATE_DIR, MISE_CONFIG_DIR: path.join(HOME, ".config/mise") },
    fs: world.fs,
    run: world.run,
    home: HOME,
    dataDir: DATA_DIR,
    stateDir: STATE_DIR,
    arch: world.arch,
    now: overrides.now ?? (() => 1_700_000_000_000),
    pid: overrides.pid ?? 4242,
    // Deterministic liveness: only the test's own pid is considered running,
    // and it has been running since tick 100.
    isAlive: overrides.isAlive ?? ((pid) => pid === (overrides.pid ?? 4242)),
    startTimeOf: overrides.startTimeOf ?? ((pid) => (pid === (overrides.pid ?? 4242) ? "100" : null)),
    lockStaleMs: overrides.lockStaleMs ?? 60_000,
    authCacheTtlMs: 1_000,
  });
}

function byId(harnesses, id) {
  return harnesses.find((harness) => harness.id === id);
}

// ---------------------------------------------------------------------------

test("catalogue exposes exactly the five audited harnesses", () => {
  assert.deepEqual(
    CATALOGUE.map((entry) => entry.id),
    ["claude", "codex", "opencode", "grok", "cursor"],
  );
  for (const entry of CATALOGUE) {
    assert.ok(entry.miseTool, `${entry.id} has a mise tool`);
    assert.deepEqual(entry.architectures, ["x64", "arm64"], `${entry.id} supports both arches`);
    assert.ok(entry.executable, `${entry.id} declares an executable`);
    assert.ok(entry.versionPattern, `${entry.id} declares a version pattern`);
  }
  assert.equal(getHarness("cursor").miseTool, "cursor-agent");
  assert.equal(getHarness("cursor").executable, "dist-package/cursor-agent");
  assert.equal(getHarness("opencode").minimumVersion, "1.14.19");
  // The native-installer `agent` alias must never become the managed name.
  assert.equal(CATALOGUE.some((entry) => entry.miseTool === "agent"), false);
});

test("architecture normalization maps dpkg and node spellings", () => {
  assert.equal(normalizeArch("amd64"), "x64");
  assert.equal(normalizeArch("x86_64"), "x64");
  assert.equal(normalizeArch("aarch64"), "arm64");
  assert.equal(normalizeArch("arm64"), "arm64");
});

test("status on a fresh home reports nothing managed and no side effects", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  fs.seedFile(path.join(HOME, ".local/share/opencode/auth.json"), "{}");

  const before = fs.snapshot();
  const { harnesses, degraded } = await manager.status();
  assert.deepEqual(degraded, []);
  assert.equal(harnesses.length, 5);
  for (const harness of harnesses) {
    assert.equal(harness.configured, false, `${harness.id} not configured`);
    assert.equal(harness.installed, false, `${harness.id} not installed`);
    assert.equal(harness.runnable, false, `${harness.id} not runnable`);
    assert.equal(harness.failed, false, `${harness.id} not failed`);
  }
  assert.equal(byId(harnesses, "opencode").credentials.present, true);
  assert.equal(fs.snapshot(), before, "status did not write anything");
  assert.equal(world.calls.some((call) => /use|uninstall|unuse/.test(call)), false, "status ran no mutation");
});

test("install resolves latest to an exact version and records it", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);

  const result = await manager.install("claude");
  assert.equal(result.ok, true);
  assert.equal(result.harness.installed, true);
  assert.equal(result.harness.configured, true);
  assert.equal(result.harness.runnable, true);
  assert.equal(result.harness.installedVersion, "2.1.273");
  assert.equal(result.harness.verifiedVersion, "2.1.273");
  assert.equal(result.harness.executable, world.execPath("claude", "2.1.273"));
  assert.equal(result.harness.authenticated, true);
  assert.deepEqual(result.harness.managedVersions, ["2.1.273"]);

  const saved = JSON.parse(await fs.readFile(path.join(STATE_DIR, "harness-state.json"), "utf8"));
  assert.equal(saved.harnesses.claude.version, "2.1.273");
  assert.equal(saved.harnesses.claude.operation.kind, "install");
  assert.equal(saved.harnesses.claude.operation.state, "ok");
});

test("install accepts a valid explicit version and records verified behaviour", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);

  const result = await manager.install("opencode", { version: "1.14.19" });
  assert.equal(result.ok, true);
  assert.equal(result.harness.installedVersion, "1.14.19");
  assert.equal(result.harness.minimumSatisfied, true);
});

test("install rejects a version below the OpenCode minimum without touching mise", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);

  const result = await manager.install("opencode", { version: "1.14.18" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "version-below-minimum");
  assert.equal(world.calls.some((call) => call.includes(" use ")), false);
  assert.equal((await manager.resolve("opencode")).installed, false);
});

test("install rejects malformed versions", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  const result = await manager.install("claude", { version: "2.1.270; rm -rf /" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid-version");
});

test("floating selectors are refused, and an explicit latest resolves exact", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  for (const version of ["lts", "2", "stable"]) {
    const result = await manager.install("claude", { version });
    assert.equal(result.code, "invalid-version", `${version} refused`);
  }
  assert.equal(world.calls.some((call) => call.includes(" use ")), false);

  const result = await manager.install("claude", { version: "latest" });
  assert.equal(result.ok, true);
  assert.equal(result.harness.recordedVersion, world.latest.claude);
});

test("a failed update keeps the previous release installed and runnable", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);

  await manager.install("claude", { version: "2.1.270" });
  world.failUse = "network unreachable";
  const failed = await manager.update("claude");
  assert.equal(failed.ok, false);
  assert.equal(failed.harness.failed, true);
  assert.match(failed.harness.failure, /network unreachable/);
  assert.equal(failed.harness.installedVersion, "2.1.270");
  assert.equal(failed.harness.runnable, true, "the old release still runs");
  assert.ok(failed.harness.executable);

  // A typo is refused before mise is touched, and also leaves it running.
  world.failUse = null;
  const typo = await manager.update("claude", { version: "v2.1.271" });
  assert.equal(typo.code, "invalid-version");
  assert.equal((await manager.resolve("claude")).runnable, true);
});

test("onStarted fires once the lock is held, and not when busy", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  let started = 0;
  const ok = await manager.install("grok", { onStarted: () => { started += 1; } });
  assert.equal(ok.ok, true);
  assert.equal(started, 1);

  fs.seedFile(
    path.join(STATE_DIR, "harness.lock"),
    JSON.stringify({ pid: 4242, startTime: "100", token: "other", id: "codex", operation: "install", startedAt: 1_700_000_000_000 }),
  );
  const busy = await manager.install("claude", { onStarted: () => { started += 1; } });
  assert.equal(busy.code, "busy");
  assert.equal(started, 1);
});

test("update moves the selection and keeps the recorded version set", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);

  await manager.install("opencode", { version: "1.18.30" });
  const updated = await manager.update("opencode", { version: "1.18.31" });
  assert.equal(updated.ok, true);
  assert.equal(updated.harness.installedVersion, "1.18.31");
  assert.equal(updated.harness.verifiedVersion, "1.18.31");
  assert.deepEqual(updated.harness.managedVersions, ["1.18.30", "1.18.31"]);

  const saved = JSON.parse(await fs.readFile(path.join(STATE_DIR, "harness-state.json"), "utf8"));
  assert.equal(saved.harnesses.opencode.operation.kind, "update");
});

test("update on a harness that was never installed is refused", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  const result = await manager.update("grok");
  assert.equal(result.ok, false);
  assert.equal(result.code, "not-installed");
});

test("status and resolve are read-only even after an install", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  await manager.install("codex", { version: "0.154.0" });

  const toolsBefore = JSON.stringify(world.tools);
  const saves = world.calls.length;
  await manager.status();
  await manager.resolve("codex");
  await manager.resolve("claude");
  assert.equal(JSON.stringify(world.tools), toolsBefore);
  assert.equal(world.calls.slice(saves).some((call) => / use | uninstall | unuse /.test(call)), false);
});

test("a live lock makes concurrent operations busy and never runnable", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);

  fs.seedFile(
    path.join(STATE_DIR, "harness.lock"),
    JSON.stringify({ pid: 4242, host: "test-host", token: "other", id: "claude", operation: "install", startedAt: 1_700_000_000_000 }),
  );

  const result = await manager.install("claude");
  assert.equal(result.ok, false);
  assert.equal(result.code, "busy");
  assert.equal(result.harness.runnable, false);
  assert.equal(result.harness.inProgress, true);
});

test("a lock left by the same pid in an earlier container run is stale", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  // The setup server came back with pid 4242 after a restart, but it is a
  // different process: its start time moved on.
  const manager = managerFor(world, { startTimeOf: (pid) => (pid === 4242 ? "900" : null) });
  fs.seedFile(
    path.join(STATE_DIR, "harness.lock"),
    JSON.stringify({ pid: 4242, startTime: "100", token: "before-restart", id: "claude", operation: "install", startedAt: 1_700_000_000_000 }),
  );

  assert.equal((await manager.resolve("claude")).inProgress, false);
  const result = await manager.install("claude");
  assert.equal(result.ok, true);
  assert.equal(result.harness.runnable, true);
  assert.equal(await fs.exists(path.join(STATE_DIR, "harness.lock")), false, "released");
});

test("the lock is created whole, never observable half-written", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  const lockFile = path.join(STATE_DIR, "harness.lock");
  const seen = [];
  const link = fs.link.bind(fs);
  fs.link = async (from, to) => {
    await link(from, to);
    if (to === lockFile) seen.push(JSON.parse(await fs.readFile(lockFile)));
  };
  await manager.install("codex");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].pid, 4242);
  assert.equal(seen[0].startTime, "100");
  assert.equal(seen[0].id, "codex");
  assert.equal([...fs.files.keys()].some((key) => key.startsWith(`${lockFile}.`)), false, "no temp left");
});

test("an interrupted install is reported failed and heals on the next attempt", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);

  // A dead pid and matching in-progress state: exactly what a SIGKILL leaves.
  fs.seedFile(
    path.join(STATE_DIR, "harness-state.json"),
    JSON.stringify({
      schema: 1,
      harnesses: {
        claude: { version: "2.1.270", operation: { kind: "install", state: "in-progress", startedAt: 1, finishedAt: null, error: null } },
      },
    }),
  );
  fs.seedFile(
    path.join(STATE_DIR, "harness.lock"),
    JSON.stringify({ pid: -1, host: "test-host", token: "dead", id: "claude", operation: "install", startedAt: 1 }),
  );

  const interrupted = await manager.resolve("claude");
  assert.equal(interrupted.failed, true);
  assert.equal(interrupted.runnable, false);
  assert.match(interrupted.failure, /interrupted/i);

  const healed = await manager.install("claude", { version: "2.1.273" });
  assert.equal(healed.ok, true);
  assert.equal(healed.harness.failed, false);
  assert.equal(healed.harness.runnable, true);
});

test("a failed install leaves the harness not runnable, and a retry recovers", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);

  world.failUse = "registry unavailable";
  const failed = await manager.install("grok");
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "failed");
  assert.equal(failed.harness.failed, true);
  assert.equal(failed.harness.runnable, false);
  assert.match(failed.harness.failure, /registry unavailable/);

  world.failUse = null;
  const retried = await manager.install("grok");
  assert.equal(retried.ok, true);
  assert.equal(retried.harness.failed, false);
  assert.equal(retried.harness.runnable, true);
});

test("status never reports runnable while a previous install is still in progress", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  // A partially extracted install: the directory and binary exist, but the
  // operation that created them has not completed.
  fs.seedFile(world.execPath("claude", "2.1.273"), "", 0o755);
  world.tools.claude = [
    {
      version: "2.1.273",
      requested_version: "2.1.273",
      install_path: path.join(DATA_DIR, "installs", "claude", "2.1.273"),
      source: { type: "mise.toml", path: path.join(HOME, ".config/mise/config.toml") },
      installed: true,
      active: true,
    },
  ];
  fs.seedFile(
    path.join(STATE_DIR, "harness-state.json"),
    JSON.stringify({
      schema: 1,
      harnesses: {
        claude: { version: "2.1.273", operation: { kind: "install", state: "in-progress", startedAt: 1, finishedAt: null, error: null } },
      },
    }),
  );
  fs.seedFile(
    path.join(STATE_DIR, "harness.lock"),
    JSON.stringify({ pid: 4242, host: "test-host", token: "live", id: "claude", operation: "install", startedAt: 1_700_000_000_000 }),
  );

  const harness = await manager.resolve("claude");
  assert.equal(harness.installed, true);
  assert.equal(harness.runnable, false);
  assert.equal(harness.inProgress, true);
});

test("uninstall preserves credentials and clears managed state", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  const authFile = path.join(HOME, ".local/share/opencode/auth.json");
  fs.seedFile(authFile, '{"anthropic":{"type":"api","key":"secret"}}');

  await manager.install("opencode", { version: "1.18.31" });
  const result = await manager.uninstall("opencode");

  assert.equal(result.ok, true);
  assert.equal(result.harness.installed, false);
  assert.equal(result.harness.configured, false);
  assert.equal(result.harness.executable, null);
  assert.equal(result.harness.credentials.present, true);
  assert.equal(await fs.exists(authFile), true, "credentials were not touched");
  assert.deepEqual(result.harness.managedVersions, []);
  assert.deepEqual(world.versionsOf("opencode"), []);
});

test("uninstall removes a configured install the manager did not record", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  // A harness installed before the manager kept state: configured and present,
  // but absent from harness-state.json.
  const install = path.join(DATA_DIR, "installs", "codex", "0.154.0");
  fs.seedFile(path.join(install, "bin/codex"), "", 0o755);
  world.tools.codex = [
    {
      version: "0.154.0",
      requested_version: "0.154.0",
      install_path: install,
      source: { type: "mise.toml", path: path.join(HOME, ".config/mise/config.toml") },
      installed: true,
      active: true,
    },
  ];
  world.selected.codex = path.join(install, "bin/codex");

  const result = await manager.uninstall("codex");
  assert.equal(result.ok, true);
  assert.equal(result.harness.configured, false);
  assert.deepEqual(world.versionsOf("codex"), []);
});

test("managed installs survive a recreate with the same persistent home", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const first = managerFor(world);
  await first.install("cursor", { version: "2026.09.15-d2fe57e" });

  // A new process/container over the same home: new manager, same fs and state.
  const second = managerFor(world);
  const harness = await second.resolve("cursor");
  assert.equal(harness.configured, true);
  assert.equal(harness.installed, true);
  assert.equal(harness.runnable, true);
  assert.equal(harness.installedVersion, "2026.09.15-d2fe57e");
  assert.equal(harness.executable, world.execPath("cursor-agent", "2026.09.15-d2fe57e"));
});

test("a missing install directory keeps a configured harness not runnable", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  await manager.install("claude", { version: "2.1.270" });

  // Simulate a state-only mount: configuration and the manager's record
  // survive, but the installed files do not.
  for (const key of [...fs.files.keys()]) {
    if (key.startsWith(path.join(DATA_DIR, "installs"))) fs.files.delete(key);
  }
  const harness = await manager.resolve("claude");
  assert.equal(harness.configured, true);
  assert.equal(harness.installed, true);
  assert.equal(harness.runnable, false);
  assert.equal(harness.executable, null);
});

test("unsupported architectures are refused before any mise work", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs, { arch: "riscv64" });
  const manager = managerFor(world);
  const result = await manager.install("claude");
  assert.equal(result.ok, false);
  assert.equal(result.code, "unsupported-arch");
  assert.deepEqual(world.calls, []);
});

test("sign-in verdicts are cached and can be invalidated", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  await manager.install("claude", { version: "2.1.270" });

  await manager.resolve("claude");
  const probes = () => world.calls.filter((call) => call.includes("auth status")).length;
  assert.equal(probes(), 1);
  await manager.resolve("claude");
  assert.equal(probes(), 1, "second read used the cache");
  manager.invalidateAuth("claude");
  await manager.resolve("claude");
  assert.equal(probes(), 2, "invalidation forced a fresh probe");
});

test("resolve rejects an unknown harness", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  await assert.rejects(() => manager.resolve("not-a-harness"), /unknown harness/);
});

test("status degrades instead of throwing when mise is unavailable", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = createHarnessManager({
    env: { HOME, MISE_STATE_DIR: STATE_DIR },
    fs,
    run: async () => ({ code: 127, signal: null, stdout: "", stderr: "mise: not found", error: null }),
    home: HOME,
    dataDir: DATA_DIR,
    stateDir: STATE_DIR,
    arch: "x64",
    now: () => 1_700_000_000_000,
    pid: 4242,
    host: "test-host",
  });
  const { harnesses, degraded } = await manager.status();
  assert.equal(harnesses.length, 5);
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0].what, "mise");
  for (const harness of harnesses) assert.equal(harness.runnable, false);
});

test("cursor installs with no shims, so its bundled node and rg stay private", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  const result = await manager.install("cursor");
  assert.equal(result.ok, true);
  assert.deepEqual(world.useSpecs, ["cursor-agent[bin_path=dist-package/.t3-no-shims]@2026.09.15-d2fe57e"]);
  // An update passes the option again, so it cannot be lost.
  world.latest["cursor-agent"] = "2026.09.28-64d2043";
  await manager.update("cursor");
  assert.equal(world.useSpecs[1], "cursor-agent[bin_path=dist-package/.t3-no-shims]@2026.09.28-64d2043");
  assert.equal((await manager.resolve("cursor")).runnable, true);
});

test("toolchains install at an exact latest, globally, and uninstall cleanly", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);

  assert.deepEqual(TOOLCHAINS.map((entry) => entry.id), ["go", "rust", "bun", "deno", "uv"]);
  const before = await manager.toolchains.status();
  assert.equal(before.toolchains.every((entry) => !entry.installed), true);

  const rust = await manager.toolchains.install("rust");
  assert.equal(rust.ok, true);
  assert.equal(rust.toolchain.installed, true);
  assert.equal(rust.toolchain.version, "1.98.1");
  assert.ok(world.useSpecs.includes("rust[components=clippy,rustfmt,profile=minimal]@1.98.1"));

  const go = await manager.toolchains.install("go");
  assert.equal(go.ok, true);
  assert.ok(world.calls.some((call) => call.endsWith("bin/go version")), "probed with `go version`");

  const removed = await manager.toolchains.uninstall("go");
  assert.equal(removed.ok, true);
  assert.equal(removed.toolchain.installed, false);
  assert.ok(world.calls.some((call) => call.includes("uninstall go@1.27.1")));
  assert.equal((await manager.toolchains.resolve("rust")).installed, true, "others untouched");
});

test("a failed toolchain install is reported and leaves nothing selected", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  world.failUse = "error sending request: Connection refused";
  const result = await manager.toolchains.install("deno");
  assert.equal(result.ok, false);
  assert.equal(result.toolchain.installed, false);
  assert.equal(result.toolchain.failed, true);
  assert.match(result.toolchain.failure, /Connection refused/);
  const unknown = await manager.toolchains.install("python");
  assert.equal(unknown.code, "unknown-toolchain");
});

test("a release that installs but does not run is rolled back, not left selected", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  await manager.install("opencode", { version: "1.18.31" });

  world.failProbe = ["/opencode/1.18.33/"];
  const failed = await manager.update("opencode", { version: "1.18.33" });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "not-runnable");
  assert.equal(failed.harness.installedVersion, "1.18.31", "the previous release is selected again");
  assert.equal(failed.harness.runnable, true);
  assert.ok(world.calls.some((call) => call.includes("uninstall opencode@1.18.33")), "the bad release is removed");

  // A first install that does not run leaves nothing selected at all.
  world.failProbe = ["/grok/"];
  const fresh = await manager.install("grok");
  assert.equal(fresh.ok, false);
  assert.equal(fresh.harness.installed, false);
  assert.equal(fresh.harness.configured, false);
});

test("uninstalling a toolchain removes every release the manager installed", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  world.latest.uv = "0.12.20";
  await manager.toolchains.install("uv");
  world.latest.uv = "0.12.21";
  const updated = await manager.toolchains.update("uv");
  assert.equal(updated.toolchain.version, "0.12.21");
  assert.deepEqual(updated.toolchain.managedVersions, ["0.12.20", "0.12.21"]);

  const removed = await manager.toolchains.uninstall("uv");
  assert.equal(removed.ok, true);
  assert.ok(world.calls.some((call) => call.includes("uninstall uv@0.12.20")));
  assert.ok(world.calls.some((call) => call.includes("uninstall uv@0.12.21")));
});

test("update on something never installed answers without recording a failure", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  const result = await manager.update("codex");
  assert.equal(result.code, "not-installed");
  assert.equal(result.harness.failed, false);
  assert.equal(await fs.exists(path.join(STATE_DIR, "harness-state.json")), false, "nothing recorded");
});

test("mise failures report their cause, not the boilerplate around it", () => {
  const failure = {
    code: 1, error: null, stdout: "",
    stderr: [
      "mise WARN  mise version 2026.9.18 available",
      "mise ERROR Failed to install http:grok@9.9.9: 404 Not Found for url (https://example.test/linux-x64/grok)",
      "mise ERROR Version: 2026.9.10 linux-arm64 (2026-09-16)",
      "mise ERROR Run with --verbose or MISE_VERBOSE=1 for more information",
    ].join("\n"),
  };
  assert.equal(firstError(failure), "Failed to install http:grok@9.9.9: 404 Not Found for url (https://example.test/linux-x64/grok)");
  const offline = { code: 0, error: null, stdout: "", stderr: "mise WARN  Remote versions cannot be fetched for anthropics/claude-code: error sending request" };
  assert.match(firstError(offline), /^Remote versions cannot be fetched/);
});

test("Cursor gets a link on the t3 PATH exactly while it is installed", async () => {
  const fs = new MemoryFs();
  const world = createWorld(fs);
  const manager = managerFor(world);
  const link = path.join(HOME, ".local/share/t3-harness/bin/cursor-agent");

  await manager.install("cursor");
  assert.equal(fs.links.get(link), world.execPath("cursor-agent", "2026.09.15-d2fe57e"));
  world.latest["cursor-agent"] = "2026.09.28-64d2043";
  await manager.update("cursor");
  assert.equal(fs.links.get(link), world.execPath("cursor-agent", "2026.09.28-64d2043"), "follows an update");
  await manager.install("claude");
  assert.equal(fs.links.has(path.join(HOME, ".local/share/t3-harness/bin/claude")), false, "shimmed agents get none");

  await manager.uninstall("cursor");
  assert.equal(fs.links.has(link), false, "gone with the install");
});

test("breaking a stale lock never deletes one another process just took", async () => {
  const fs = new MemoryFs();
  const lockPath = path.join(STATE_DIR, "harness.lock");
  const ctxFor = (pid, overrideFs) => ({
    fs: overrideFs,
    lockPath,
    pid,
    now: () => 1_700_000_000_000,
    lockStaleMs: 60_000,
    isAlive: (candidate) => candidate === 1 || candidate === 2,
    startTimeOf: (candidate) => (candidate === 1 || candidate === 2 ? "100" : null),
  });
  // A stale lock left by a process that is gone.
  fs.seedFile(lockPath, JSON.stringify({ pid: 99, token: "stale", id: "claude", operation: "install", startedAt: 1_700_000_000_000 }));

  // B decides the lock is stale, but before it moves it, A breaks it too and
  // takes the lock. B's move then catches A's live lock.
  let interleaved = false;
  const fsB = Object.create(fs);
  fsB.rename = async (from, to) => {
    if (!interleaved && from === lockPath) {
      interleaved = true;
      const a = await lock.acquireLock(ctxFor(1, fs), { id: "codex", operation: "install" });
      assert.equal(a.acquired, true, "A takes the lock");
    }
    return fs.rename(from, to);
  };
  const b = await lock.acquireLock(ctxFor(2, fsB), { id: "grok", operation: "install" });
  assert.equal(b.acquired, false, "B does not get it");
  assert.equal(b.holder.pid, 1, "A still holds it");
  const holder = JSON.parse(await fs.readFile(lockPath));
  assert.equal(holder.pid, 1);
  assert.equal([...fs.files.keys()].some((key) => key.includes(".stale.")), false, "nothing left aside");
});
