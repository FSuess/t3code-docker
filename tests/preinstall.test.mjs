// Unit tests for the first-boot preinstall.
//
//   node --test tests/preinstall.test.mjs
//
// The manager is a fake with the same surface as the real one (install and
// resolve for agents, the same under `toolchains`), so plan parsing, ordering,
// the once-per-volume record, retry on the next start and busy handling are
// exercised without mise.
import assert from "node:assert/strict";
import test from "node:test";

import { parsePreinstall, readPreinstall, runPreinstall } from "../docker/harness/preinstall.mjs";

const STATE_DIR = "/home/t3/.local/state/mise";
const FILE = `${STATE_DIR}/t3-preinstall.json`;

function memoryFs() {
  const files = new Map();
  return {
    files,
    async readFile(file) {
      if (!files.has(file)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(file);
    },
    async writeFile(file, data) { files.set(file, String(data)); },
    async mkdir() {},
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
  };
}

/** A fake manager: `installed` holds what is present, `fail` what will fail. */
function fakeManager({ installed = [], fail = {}, busyFor = {}, declined = [] } = {}) {
  const present = new Set(installed);
  const calls = [];
  const side = (kind) => ({
    async resolve(id) {
      return {
        id,
        installed: present.has(id),
        installedVersion: present.has(id) ? "1.0.0" : null,
        version: present.has(id) ? "1.0.0" : null,
        ...(declined.includes(id) ? { operation: "uninstall", operationState: "ok" } : {}),
      };
    },
    async install(id) {
      calls.push(`${kind}:${id}`);
      if ((busyFor[id] ?? 0) > 0) {
        busyFor[id] -= 1;
        return { ok: false, code: "busy", error: "another operation is in progress" };
      }
      if (fail[id]) return { ok: false, code: "failed", error: fail[id] };
      present.add(id);
      const facts = { id, installed: true, installedVersion: "9.9.9", version: "9.9.9" };
      return { ok: true, code: "ok", ...(kind === "agent" ? { harness: facts } : { toolchain: facts }) };
    },
  });
  const manager = side("agent");
  manager.toolchains = side("toolchain");
  manager.calls = calls;
  manager.present = present;
  return manager;
}

const run = (manager, fs, env = {}, extra = {}) => runPreinstall({
  manager,
  fs,
  env,
  stateDir: STATE_DIR,
  sleep: async () => {},
  now: () => 1_700_000_000_000,
  pid: 4242,
  startTimeOf: () => "100",
  ...extra,
});

test("T3_PREINSTALL parses groups, ids, and off switches", () => {
  const ids = (value) => parsePreinstall(value).items.map((item) => `${item.kind}:${item.id}`);
  assert.deepEqual(ids(undefined), [
    "agent:claude", "agent:codex", "agent:opencode", "agent:grok", "agent:cursor",
    "toolchain:go", "toolchain:rust", "toolchain:bun", "toolchain:deno", "toolchain:uv",
  ]);
  assert.deepEqual(ids("all"), ids(""));
  assert.deepEqual(ids("agents"), ids("").slice(0, 5));
  assert.deepEqual(ids("toolchains"), ids("").slice(5));
  for (const off of ["none", "off", "0", "false", " NONE "]) assert.deepEqual(ids(off), [], off);
  // Order follows the catalogue, not the variable, and duplicates collapse.
  assert.deepEqual(ids("go, claude rust claude"), ["agent:claude", "toolchain:go", "toolchain:rust"]);
  assert.deepEqual(parsePreinstall("claude,python,java").unknown, ["python", "java"]);
});

test("a first start installs everything, agents first, and syncs each agent", async () => {
  const fs = memoryFs();
  const manager = fakeManager();
  let syncs = 0;
  const summary = await run(manager, fs, {}, { sync: async () => { syncs += 1; } });
  assert.deepEqual(manager.calls, [
    "agent:claude", "agent:codex", "agent:opencode", "agent:grok", "agent:cursor",
    "toolchain:go", "toolchain:rust", "toolchain:bun", "toolchain:deno", "toolchain:uv",
  ]);
  assert.equal(summary.installed.length, 10);
  assert.equal(syncs, 5, "one sync per agent, none for toolchains");

  const shown = await readPreinstall({ stateDir: STATE_DIR, fs });
  assert.equal(shown.state, "finished");
  assert.equal(shown.items.length, 10);
  assert.equal(shown.items.every((item) => item.state === "done"), true);
  assert.equal(shown.items[0].version, "9.9.9");
});

test("what is already there is adopted, not reinstalled", async () => {
  const fs = memoryFs();
  const manager = fakeManager({ installed: ["claude", "go"] });
  const summary = await run(manager, fs, { T3_PREINSTALL: "claude,codex,go" });
  assert.deepEqual(manager.calls, ["agent:codex"]);
  assert.deepEqual(summary.adopted, ["agent:claude", "toolchain:go"]);
});

test("an item is installed once per volume: uninstalling it sticks", async () => {
  const fs = memoryFs();
  const manager = fakeManager();
  await run(manager, fs, { T3_PREINSTALL: "grok,uv" });
  // The user uninstalls Grok from the page; the next start leaves it alone.
  manager.present.delete("grok");
  manager.calls.length = 0;
  const again = await run(manager, fs, { T3_PREINSTALL: "grok,uv" });
  assert.deepEqual(manager.calls, []);
  assert.deepEqual(again.skipped, ["agent:grok", "toolchain:uv"]);
});

test("a failure is recorded, shown, and retried on the next start", async () => {
  const fs = memoryFs();
  const offline = fakeManager({ fail: { codex: "Remote versions cannot be fetched" } });
  const first = await run(offline, fs, { T3_PREINSTALL: "claude,codex" });
  assert.deepEqual(first.failed, ["agent:codex"]);
  const shown = await readPreinstall({ stateDir: STATE_DIR, fs });
  const codex = shown.items.find((item) => item.id === "codex");
  assert.equal(codex.state, "failed");
  assert.match(codex.error, /Remote versions/);

  const online = fakeManager({ installed: ["claude"] });
  const second = await run(online, fs, { T3_PREINSTALL: "claude,codex" });
  assert.deepEqual(online.calls, ["agent:codex"], "only the failed one is retried");
  assert.deepEqual(second.installed, ["agent:codex"]);
  const record = JSON.parse(fs.files.get(FILE));
  assert.equal(record.items["agent:codex"].state, "done");
});

test("a busy lock is waited out instead of counted as a failure", async () => {
  const fs = memoryFs();
  const manager = fakeManager({ busyFor: { deno: 2 } });
  const summary = await run(manager, fs, { T3_PREINSTALL: "deno" });
  assert.deepEqual(summary.installed, ["toolchain:deno"]);
  assert.equal(manager.calls.length, 3);
});

test("T3_PREINSTALL=none installs nothing and says so", async () => {
  const fs = memoryFs();
  const manager = fakeManager();
  const lines = [];
  await run(manager, fs, { T3_PREINSTALL: "none" }, { log: (line) => lines.push(line) });
  assert.deepEqual(manager.calls, []);
  assert.equal((await readPreinstall({ stateDir: STATE_DIR, fs })).state, "off");
  assert.match(lines.join("\n"), /off/);
});

test("a run whose process is gone reads as interrupted", async () => {
  const fs = memoryFs();
  fs.files.set(FILE, JSON.stringify({
    schema: 1,
    items: { "agent:claude": { state: "done", version: "2.1.285" } },
    run: { state: "running", pid: 4242, startTime: "100", plan: ["agent:claude", "agent:codex"], current: "agent:codex" },
  }));
  const live = await readPreinstall({ stateDir: STATE_DIR, fs, isAlive: () => true, startTimeOf: () => "100" });
  assert.equal(live.state, "running");
  assert.equal(live.current, "agent:codex");
  assert.deepEqual(live.items.map((item) => item.state), ["done", "installing"]);

  // Same pid after a restart, different process.
  const restarted = await readPreinstall({ stateDir: STATE_DIR, fs, isAlive: () => true, startTimeOf: () => "900" });
  assert.equal(restarted.state, "interrupted");
  assert.deepEqual(restarted.items.map((item) => item.state), ["done", "pending"]);
});

test("three failures in a row stop the run; the rest wait for the next start", async () => {
  const fs = memoryFs();
  const offline = fakeManager({ fail: { claude: "x", codex: "x", opencode: "x", grok: "x", cursor: "x" } });
  const summary = await run(offline, fs, { T3_PREINSTALL: "agents" });
  assert.deepEqual(offline.calls, ["agent:claude", "agent:codex", "agent:opencode"]);
  assert.deepEqual(summary.deferred, ["agent:grok", "agent:cursor"]);
  const shown = await readPreinstall({ stateDir: STATE_DIR, fs });
  assert.deepEqual(shown.items.map((item) => item.state), ["failed", "failed", "failed", "pending", "pending"]);

  const online = fakeManager();
  await run(online, fs, { T3_PREINSTALL: "agents" });
  assert.deepEqual(online.calls, ["agent:claude", "agent:codex", "agent:opencode", "agent:grok", "agent:cursor"]);
});

test("an agent the user uninstalled stays uninstalled, even after a failed first try", async () => {
  const fs = memoryFs();
  await run(fakeManager({ fail: { claude: "rate limited" } }), fs, { T3_PREINSTALL: "claude" });
  // Since then: Install from the page, then Uninstall. The manager remembers.
  const manager = fakeManager({ declined: ["claude"] });
  const summary = await run(manager, fs, { T3_PREINSTALL: "claude" });
  assert.deepEqual(manager.calls, []);
  assert.deepEqual(summary.skipped, ["agent:claude"]);
});

test("the item being installed carries the phase it has reached", async () => {
  const fs = memoryFs();
  const manager = fakeManager();
  const seen = [];
  const install = manager.install;
  manager.install = async (id, options) => {
    options?.onProgress?.({ phase: "installing" });
    // The progress write is not awaited by the install; let it land.
    await new Promise((resolve) => setImmediate(resolve));
    const shown = await readPreinstall({ stateDir: STATE_DIR, fs, isAlive: () => true, startTimeOf: () => "100" });
    seen.push(shown.items.find((item) => item.id === id));
    return install(id, options);
  };
  await run(manager, fs, { T3_PREINSTALL: "claude" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].state, "installing");
  assert.deepEqual(seen[0].progress, { phase: "installing" });

  const after = await readPreinstall({ stateDir: STATE_DIR, fs });
  assert.equal(after.items[0].progress, undefined, "a finished run carries no progress");
});
