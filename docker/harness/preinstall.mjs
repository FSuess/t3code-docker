// First-boot preinstall: put back what the image used to bake.
//
// The image ships no agent CLI and no language toolchain; they install into the
// persistent home instead. Left at that, a fresh container - or one upgraded
// from the old `full` image - would come up with nothing to run until someone
// clicked Install a dozen times. So on start, everything T3_PREINSTALL names
// that is not there yet is installed in the background, one at a time, through
// the same manager the setup page and `t3-harness` use. By default that is the
// agents most people start with (the catalogue's `firstStart`) and the
// toolchains; the other agents are one press on the Agents page.
//
// Each item is installed at most once per home volume. An item that succeeded
// (or was already there) is recorded as done and never touched again, so
// uninstalling an agent you do not want keeps it uninstalled. An item that
// failed - no network at first boot, a registry outage - is retried on the next
// start. The record lives beside the tools in the mise state directory: a
// state-only mount that loses the tools on recreate loses the record with them,
// and the next start installs them again.
//
//   T3_PREINSTALL=default        Claude Code, Codex, OpenCode and every toolchain
//   T3_PREINSTALL=all            every agent and every toolchain
//   T3_PREINSTALL=agents         just the five agent CLIs
//   T3_PREINSTALL=source-control glab, fj, tea and az (also: scm)
//   T3_PREINSTALL=claude,go,glab any mix of ids and the groups above
//   T3_PREINSTALL=none           nothing (also: off, 0, false)
//
// The source control CLIs are only ever installed when named: which host a
// server talks to cannot be guessed, so not even `all` includes them.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CATALOGUE, SOURCE_CONTROL, TOOLCHAINS } from "./catalogue.mjs";
import { createFs, processAlive, processStartTime } from "./io.mjs";

const SCHEMA = 1;
const OFF = new Set(["none", "off", "0", "false", "no"]);
const DEFAULT = new Set(["", "default"]);
const ALL = new Set(["all", "1", "true", "yes"]);

const AGENTS = CATALOGUE.map((entry) => ({ kind: "agent", id: entry.id, name: entry.name }));
const TOOLS = TOOLCHAINS.map((entry) => ({ kind: "toolchain", id: entry.id, name: entry.name }));
const SCM = SOURCE_CONTROL.filter((entry) => !entry.inImage)
  .map((entry) => ({ kind: "source-control", id: entry.id, name: entry.name }));
const KNOWN = [...AGENTS, ...TOOLS, ...SCM];
const FIRST_START = new Set(CATALOGUE.filter((entry) => entry.firstStart).map((entry) => entry.id));
const DEFAULT_ITEMS = [...AGENTS.filter((item) => FIRST_START.has(item.id)), ...TOOLS];

export const keyOf = (item) => `${item.kind}:${item.id}`;

/**
 * Turn T3_PREINSTALL into an ordered plan: agents first, because they are what
 * someone opening the app is waiting for, then toolchains, then source control
 * CLIs. Unknown words are reported rather than failing the container.
 */
export function parsePreinstall(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (OFF.has(raw)) return { items: [], unknown: [] };
  if (DEFAULT.has(raw)) return { items: DEFAULT_ITEMS, unknown: [] };
  if (ALL.has(raw)) return { items: [...AGENTS, ...TOOLS], unknown: [] };

  const wanted = new Set();
  const unknown = [];
  for (const token of raw.split(/[\s,]+/).filter(Boolean)) {
    if (token === "all") [...AGENTS, ...TOOLS].forEach((item) => wanted.add(keyOf(item)));
    else if (token === "default") DEFAULT_ITEMS.forEach((item) => wanted.add(keyOf(item)));
    else if (token === "agents") AGENTS.forEach((item) => wanted.add(keyOf(item)));
    else if (token === "toolchains") TOOLS.forEach((item) => wanted.add(keyOf(item)));
    else if (token === "source-control" || token === "scm") SCM.forEach((item) => wanted.add(keyOf(item)));
    else {
      const item = KNOWN.find((candidate) => candidate.id === token);
      if (item) wanted.add(keyOf(item));
      else unknown.push(token);
    }
  }
  return { items: KNOWN.filter((item) => wanted.has(keyOf(item))), unknown };
}

export function preinstallPath(stateDir) {
  return path.join(stateDir, "t3-preinstall.json");
}

async function readRecord(fs, file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (parsed && typeof parsed === "object") {
      return {
        schema: SCHEMA,
        items: parsed.items && typeof parsed.items === "object" ? parsed.items : {},
        run: parsed.run && typeof parsed.run === "object" ? parsed.run : null,
      };
    }
  } catch { /* none yet, or unreadable: start over */ }
  return { schema: SCHEMA, items: {}, run: null };
}

async function writeRecord(fs, file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}

/**
 * What the setup page shows: the plan, where it got to, and what failed. A run
 * recorded as running whose process is gone (the container stopped mid-way)
 * reads as interrupted; the next start picks it up.
 */
export async function readPreinstall({
  stateDir,
  fs = createFs(),
  isAlive = processAlive,
  startTimeOf = processStartTime,
} = {}) {
  const record = await readRecord(fs, preinstallPath(stateDir));
  const run = record.run;
  let state = run?.state ?? "idle";
  if (state === "running") {
    const alive = isAlive(run.pid) && (!run.startTime || startTimeOf(run.pid) === run.startTime);
    if (!alive) state = "interrupted";
  }
  const plan = Array.isArray(run?.plan) ? run.plan : [];
  const items = plan.map((key) => {
    const [kind, id] = key.split(":");
    const entry = record.items[key] ?? {};
    const known = KNOWN.find((item) => keyOf(item) === key);
    return {
      kind,
      id,
      name: known?.name ?? id,
      state: run?.current === key && state === "running" ? "installing" : entry.state ?? "pending",
      version: entry.version ?? null,
      error: entry.error ?? null,
      // The phase the item being installed has reached ("installing", "verifying").
      ...(run?.current === key && state === "running" && run.progress ? { progress: run.progress } : {}),
    };
  });
  return {
    state,
    startedAt: run?.startedAt ?? null,
    finishedAt: run?.finishedAt ?? null,
    current: state === "running" ? run?.current ?? null : null,
    items,
  };
}

/**
 * Install everything the plan names that is not installed or recorded done.
 * `manager` is the harness manager; `sync` pushes a newly installed agent into
 * T3's provider settings straight away, so it shows up while the rest of the
 * list is still downloading.
 */
export async function runPreinstall({
  manager,
  sync = async () => null,
  env = process.env,
  stateDir,
  fs = createFs(),
  log = () => {},
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  busyRetryMs = 5000,
  busyRetries = 120,
  pid = process.pid,
  startTimeOf = processStartTime,
} = {}) {
  const file = preinstallPath(stateDir);
  // Every write of the record goes through one chain: a progress update fired
  // without waiting must never land after a newer write and undo it.
  let writes = Promise.resolve();
  const persist = (record) => {
    writes = writes.then(() => writeRecord(fs, file, record), () => writeRecord(fs, file, record));
    return writes;
  };
  const { items, unknown } = parsePreinstall(env.T3_PREINSTALL);
  if (unknown.length) log(`T3_PREINSTALL: ignoring unknown ${unknown.join(", ")}`);

  // Shell links follow what is installed, whatever this run does next.
  try { await manager.refreshLinks?.(); } catch { /* best effort */ }

  const record = await readRecord(fs, file);
  if (!items.length) {
    record.run = { state: "off", plan: [], startedAt: null, finishedAt: null, current: null };
    await persist(record);
    log("preinstall is off (T3_PREINSTALL=none)");
    return { installed: [], adopted: [], failed: [], skipped: [] };
  }

  const summary = { installed: [], adopted: [], failed: [], skipped: [] };
  const opsFor = (item) => (item.kind === "agent" ? manager : item.kind === "source-control" ? manager.sourceControl : manager.toolchains);
  const unrecorded = items.filter((item) => record.items[keyOf(item)]?.state !== "done");
  summary.skipped = items.filter((item) => !unrecorded.includes(item)).map(keyOf);

  // Whatever is already on the volume - an upgrade from a release that ran
  // this before, or something installed by hand - is adopted up front, so the
  // page never shows a working agent as queued behind a download.
  const pending = [];
  for (const item of unrecorded) {
    const current = await opsFor(item).resolve(item.id, { authenticate: false }).catch(() => null);
    if (current?.installed) {
      const version = current.installedVersion ?? current.version ?? null;
      record.items[keyOf(item)] = { state: "done", version, at: now(), adopted: true };
      summary.adopted.push(keyOf(item));
    } else if (current?.operation === "uninstall" && current?.operationState === "ok") {
      // Someone uninstalled it on purpose - say after a first start that could
      // not install it, and an Install and Uninstall of their own since. The
      // manager remembers that even when this record does not.
      record.items[keyOf(item)] = { state: "done", version: null, at: now(), declined: true };
      summary.skipped.push(keyOf(item));
    } else {
      pending.push(item);
    }
  }

  record.run = {
    state: "running",
    pid,
    startTime: startTimeOf(pid),
    plan: items.map(keyOf),
    startedAt: now(),
    finishedAt: null,
    current: null,
  };
  await persist(record);
  if (pending.length) {
    log(`installing ${pending.map((item) => item.name).join(", ")} in the background;`
      + " progress is on the setup page");
  }

  // Three failures in a row is nearly always no network, or a registry that is
  // down for everything. Stop there rather than holding the install lock for
  // every remaining item; the rest are tried on the next start like failures.
  let failedInARow = 0;
  for (const item of pending) {
    if (failedInARow >= 3) {
      summary.deferred = [...(summary.deferred ?? []), keyOf(item)];
      continue;
    }
    const key = keyOf(item);
    const ops = opsFor(item);
    record.run.current = key;
    record.run.progress = null;
    await persist(record);
    log(`installing ${item.name}`);

    const onProgress = (progress) => {
      record.run.progress = progress;
      void persist(record).catch(() => {});
    };
    let result = await ops.install(item.id, { onProgress });
    for (let attempt = 0; result?.code === "busy" && attempt < busyRetries; attempt += 1) {
      // Someone pressed Install on the page at the same moment. Wait for it.
      await sleep(busyRetryMs);
      const again = await ops.resolve(item.id, { authenticate: false }).catch(() => null);
      if (again?.installed) {
        result = { ok: true, adopted: true, [item.kind === "agent" ? "harness" : "toolchain"]: again };
        break;
      }
      result = await ops.install(item.id, { onProgress });
    }

    const facts = result?.harness ?? result?.toolchain ?? null;
    failedInARow = result?.ok ? 0 : failedInARow + 1;
    if (result?.ok) {
      const version = facts?.installedVersion ?? facts?.version ?? null;
      record.items[key] = { state: "done", version, at: now() };
      summary.installed.push(key);
      log(`installed ${item.name}${version ? ` ${version}` : ""}`);
      if (item.kind === "agent") {
        try { await sync(); } catch (error) { log(`provider sync failed: ${error?.message ?? error}`); }
      }
    } else {
      const error = String(result?.error ?? "install failed").slice(0, 300);
      const attempts = (record.items[key]?.attempts ?? 0) + 1;
      record.items[key] = { state: "failed", error, at: now(), attempts };
      summary.failed.push(key);
      log(`could not install ${item.name}: ${error} (retried on the next start)`);
    }
    await persist(record);
  }

  record.run.state = "finished";
  record.run.current = null;
  record.run.progress = null;
  record.run.finishedAt = now();
  await persist(record);
  if (summary.deferred?.length) {
    log(`stopped after three failures in a row (no network?); ${summary.deferred.length} more`
      + " will be tried on the next start");
  }
  if (pending.length) {
    log(summary.failed.length
      ? `preinstall finished; ${summary.failed.length} failed and will be retried on the next start`
      : "preinstall finished");
  }
  return summary;
}

// `node preinstall.mjs`: the entrypoint runs this in the background on start.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const log = (line) => process.stderr.write(`[t3code] preinstall: ${line}\n`);
  try {
    const { createHarnessManager } = await import("./manager.mjs");
    const manager = createHarnessManager();
    const providerModule = process.env.T3_PROVIDER_MODULE || "/opt/t3-provider/index.mjs";
    const sync = async () => {
      const { createProviderIntegration } = await import(pathToFileURL(providerModule).href);
      return createProviderIntegration({ harness: manager }).sync();
    };
    const summary = await runPreinstall({ manager, sync, stateDir: manager.paths.stateDir, log });
    process.exitCode = summary.failed.length ? 1 : 0;
  } catch (error) {
    log(`failed: ${error?.stack ?? error}`);
    process.exitCode = 1;
  }
}
