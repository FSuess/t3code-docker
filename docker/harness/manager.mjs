// The persistent harness manager.
//
// One module owns the five supported harnesses: their exact-version install,
// the global mise selection, the concrete executable path, and the facts
// (configured, installed, runnable, authenticated, failed) the
// setup console and T3 integration read. Status and resolve are strictly
// read-only. Install/Update/Uninstall run one at a time under a lock and record
// the exact version they resolved.
import os from "node:os";
import path from "node:path";

import { CATALOGUE, TOOLCHAINS, getHarness, getToolchain, normalizeArch, supportsArch } from "./catalogue.mjs";
import { createFs, createRunner, isExecutable, processAlive, processStartTime } from "./io.mjs";
import * as lock from "./lock.mjs";
import * as mise from "./mise.mjs";
import { credentialSurface, detectAuth, probeVersion } from "./probe.mjs";
import * as state from "./state.mjs";
import { meetsMinimum } from "./version.mjs";

// An exact release: digits, a dot, then version characters. Floating selectors
// mise would also accept (`lts`, `2`, `latest`) are refused rather than
// recorded, because the record has to say which release actually ran.
// `latest` itself is accepted at the API and resolved before it gets here.
const VERSION_SYNTAX = /^\d+\.[0-9A-Za-z._+-]{1,62}$/;

// Steps report through this when nobody is listening and nothing can cancel.
const NO_OP = Object.freeze({ signal: null, phase() {}, report() {} });

const DEFAULT_TIMEOUTS = Object.freeze({
  mise: 120_000,
  latest: 45_000,
  install: 15 * 60 * 1000,
  probe: 20_000,
});

/**
 * Build a manager. Every dependency is injectable so the unit tests can drive
 * exact-version selection, lock contention, and failure recovery without mise,
 * a container, or the host filesystem.
 */
export function createHarnessManager(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  const ctx = {
    env,
    home,
    fs: options.fs ?? createFs(),
    run: options.run ?? createRunner(),
    now: options.now ?? Date.now,
    pid: options.pid ?? process.pid,
    isAlive: options.isAlive ?? processAlive,
    startTimeOf: options.startTimeOf ?? processStartTime,
    arch: normalizeArch(options.arch ?? process.arch),
    miseBin: options.miseBin ?? env.T3_MISE_BIN ?? "mise",
    configDir: options.configDir ?? env.MISE_CONFIG_DIR ?? path.join(home, ".config", "mise"),
    dataDir: options.dataDir ?? env.MISE_DATA_DIR ?? path.join(home, ".local", "share", "mise"),
    stateDir: options.stateDir ?? env.MISE_STATE_DIR ?? path.join(home, ".local", "state", "mise"),
    cacheDir: options.cacheDir ?? env.MISE_CACHE_DIR ?? path.join(home, ".cache", "mise"),
    // Links for harnesses that get no mise shim (Cursor), on the t3 user's
    // PATH through docker/user-env.sh.
    linkDir: options.linkDir ?? env.T3_HARNESS_BIN_DIR ?? path.join(home, ".local", "share", "t3-harness", "bin"),
    // Only a backstop for a holder that is alive but hung: a dead or replaced
    // holder is detected from its pid and start time straight away.
    lockStaleMs: options.lockStaleMs ?? 60 * 60 * 1000,
    authCacheTtlMs: options.authCacheTtlMs ?? 10_000,
    timeouts: { ...DEFAULT_TIMEOUTS, ...(options.timeouts ?? {}) },
  };
  ctx.lockPath = lock.lockPath(ctx.stateDir);
  ctx.statePath = state.statePath(ctx.stateDir);

  const authCache = new Map();

  /** Read the shared snapshot once: mise, our state, and any live lock. */
  async function snapshot() {
    const listing = await mise.listTools(ctx);
    let live = await lock.liveHolder(ctx);
    let saved = await state.readState(ctx);
    // An operation records "in-progress" just after taking the lock and "ok"
    // just before releasing it, so reads that straddle either edge can pair a
    // stale lock with a fresh state. Read both again before calling anything
    // interrupted; a real interruption still reads the same way twice.
    const running = (section) => Object.values(saved[section]).some((record) => record.operation?.state === "in-progress");
    if (!live && (running("harnesses") || running("toolchains"))) {
      live = await lock.liveHolder(ctx);
      saved = await state.readState(ctx);
    }
    const degraded = listing.error ? [{ what: "mise", error: listing.error }] : [];
    return { tools: listing.tools ?? {}, saved, live, degraded };
  }

  /** The version the user's global mise config selects for a tool, or null. */
  async function globalVersion(tool) {
    const listing = await mise.listTools(ctx);
    const global = (listing.tools?.[tool] ?? [])
      .filter((candidate) => String(candidate.source?.path ?? "").startsWith(ctx.configDir));
    return (global.find((candidate) => candidate.active) ?? global[0])?.version ?? null;
  }

  /**
   * `mise use` and then prove the result runs. mise has moved the global
   * selection by the time a probe can fail, so a release that installed but
   * does not run is rolled back to whatever was selected before - otherwise
   * the next sync would hand T3 an executable the manager just rejected.
   */
  async function useVerified(entry, target, verify, op = NO_OP, previous = {}) {
    const before = await globalVersion(entry.miseTool);
    op.phase("installing");
    try {
      await mise.use(ctx, entry.miseTool, target, entry.miseOptions ?? null, { signal: op.signal });
    } catch (error) {
      // Cancelled part way through a download or an unpack: mise may have
      // left a partial install of a release nobody asked to keep. Remove it,
      // unless it is one this manager installed before.
      if (error?.code === "cancelled" && before !== target && !(previous.managedVersions ?? []).includes(target)) {
        try { await mise.uninstall(ctx, entry.miseTool, target); } catch { /* best effort */ }
      }
      throw error;
    }
    // Past the point of no return: mise has moved the selection, so finish
    // (verify, record) rather than stop half way.
    op.report("verifying");
    try {
      return await verify();
    } catch (error) {
      if (before !== target) {
        try {
          if (before) await mise.use(ctx, entry.miseTool, before, entry.miseOptions ?? null);
          else await mise.unuse(ctx, entry.miseTool);
          await mise.uninstall(ctx, entry.miseTool, target);
        } catch { /* the failure being reported is the one that matters */ }
      }
      throw error;
    }
  }

  async function factsFor(entry, snap, { authenticate = true } = {}) {
    const entries = snap.tools[entry.miseTool] ?? [];
    const sourceEntry = entries.find((candidate) => candidate.source) ?? null;
    const selected = entries.find((candidate) => candidate.active) ?? sourceEntry ?? entries[entries.length - 1] ?? null;
    const configured = Boolean(sourceEntry);
    const installed = configured && selected?.installed === true;
    const installPath = installed ? selected.install_path ?? null : null;
    const executable = installPath ? path.join(installPath, entry.executable) : null;
    const executableExists = executable ? await isExecutable(ctx.fs, executable) : false;

    const record = snap.saved.harnesses[entry.id] ?? {};
    const recordedVersion = record.version ?? null;
    const operation = record.operation ?? null;
    const liveForThis = Boolean(snap.live && snap.live.id === entry.id);
    const interrupted = operation?.state === "in-progress" && !liveForThis;

    const installedVersion = installed ? selected.version ?? null : null;
    const belowMinimum = installed && meetsMinimum(installedVersion, entry.minimumVersion) === false;
    // `failure` reports how the last operation ended. It does not decide
    // whether the harness runs: an update that failed on a network blip
    // leaves the previous release installed and selected, and taking that
    // away would turn a failed update into an uninstall.
    let failure = null;
    if (interrupted) failure = "a previous operation was interrupted before it finished";
    else if (operation?.state === "failed") failure = operation.error ?? "the last operation failed";
    else if (belowMinimum) failure = `${installedVersion} is below the required ${entry.minimumVersion}`;
    const failed = Boolean(failure);

    const authExecutable = executableExists ? executable : null;
    const authenticated =
      authenticate && authExecutable
        ? await authFor(entry, authExecutable, installedVersion ?? recordedVersion)
        : null;

    return {
      id: entry.id,
      name: entry.name,
      miseTool: entry.miseTool,
      supported: supportsArch(entry, ctx.arch),
      architecture: ctx.arch,
      minimumVersion: entry.minimumVersion,
      configured,
      configuredVersion: sourceEntry?.requested_version ?? null,
      installed,
      installedVersion,
      recordedVersion,
      recordedExecutable: record.executable ?? null,
      verifiedVersion: record.verifiedVersion ?? null,
      executable: executableExists ? executable : null,
      runnable: installed && executableExists && !belowMinimum && !liveForThis,
      authenticated,
      failed,
      failure,
      minimumSatisfied: installed ? !belowMinimum : null,
      operation: operation?.kind ?? null,
      operationState: operation?.state ?? null,
      inProgress: Boolean(snap.live && snap.live.id === entry.id),
      managedVersions: record.managedVersions ?? [],
      credentials: await credentialSurface(ctx, entry),
    };
  }

  async function authFor(entry, executable, version) {
    const key = `${executable}:${version ?? ""}`;
    const cached = authCache.get(entry.id);
    if (cached && cached.key === key && ctx.now() - cached.at < ctx.authCacheTtlMs) return cached.value;
    const value = await detectAuth(ctx, entry, { executable, runnable: true });
    authCache.set(entry.id, { at: ctx.now(), key, value });
    return value;
  }

  /** Exact-version selection from mise's install: the concrete executable. */
  async function resolveExecutable(entry, version) {
    const resolved = await mise.which(ctx, entry.miseTool);
    if (resolved) return resolved;
    return path.join(mise.installDir(ctx, entry.miseTool, version), entry.executable);
  }

  function assertVersion(version) {
    if (!VERSION_SYNTAX.test(String(version ?? ""))) {
      const error = new Error(`invalid version: ${version}`);
      error.code = "invalid-version";
      throw error;
    }
  }

  /**
   * Run one lifecycle operation under the global lock, recording how it went
   * in `section` of the state file. `onStarted` fires once the lock is held,
   * which is how the setup server answers a POST as soon as the work has
   * really begun instead of holding the request for the length of a download.
   */
  async function runLocked({ section, id, kind, entry, work, onStarted, onProgress, signal, after }) {
    const held = await lock.acquireLock(ctx, { id, operation: kind });
    if (!held.acquired) {
      const detail = held.error
        ? held.error
        : `another operation is in progress (${held.holder?.operation ?? "unknown"}` +
          `${held.holder?.id ? ` ${held.holder.id}` : ""})`;
      return { ok: false, code: held.error ? "lock-error" : "busy", error: detail, ...(await after()) };
    }

    // What an operation's steps report through: the phase it has reached, and
    // whether someone has cancelled it (checked between steps; a running
    // mise is stopped by the same signal).
    const op = {
      signal: signal ?? null,
      phase(name) {
        if (signal?.aborted) throw mise.cancelledError();
        op.report(name);
      },
      report(name) {
        try { onProgress?.({ phase: name }); } catch { /* a listener cannot fail the operation */ }
      },
    };
    let outcome;
    try {
      try { onStarted?.(); } catch { /* a listener cannot fail the operation */ }
      const before = await state.readState(ctx);
      const previous = before[section][id] ?? {};
      await state.updateEntry(ctx, section, id, {
        operation: { kind, state: "in-progress", startedAt: ctx.now(), finishedAt: null, error: null },
      });
      const patch = await work(entry, previous, op) ?? {};
      await state.updateEntry(ctx, section, id, {
        ...patch,
        operation: { kind, state: "ok", startedAt: null, finishedAt: ctx.now(), error: null },
      });
      outcome = { ok: true, code: "ok" };
    } catch (error) {
      // A cancelled operation is not a failed one: the row goes back to how
      // it was, without an error to explain.
      const cancelled = error?.code === "cancelled" || Boolean(signal?.aborted);
      const message = cancelled ? "cancelled" : String(error?.message ?? error);
      await state.updateEntry(ctx, section, id, {
        operation: { kind, state: cancelled ? "cancelled" : "failed", startedAt: null, finishedAt: ctx.now(), error: cancelled ? null : message },
      });
      outcome = { ok: false, code: cancelled ? "cancelled" : error?.code ?? "failed", error: message };
    } finally {
      await held.release();
    }
    // Resolve after releasing the lock: the operation has finished, so the
    // returned facts must not read as "still in progress".
    return { ...outcome, ...(await after()) };
  }

  async function runOperation(id, kind, work, { onStarted, onProgress, signal } = {}) {
    const entry = getHarness(id);
    if (!entry) return { ok: false, code: "unknown-harness", error: `unknown harness: ${id}` };
    if (!supportsArch(entry, ctx.arch)) {
      return { ok: false, code: "unsupported-arch", error: `${entry.name} has no ${ctx.arch} build` };
    }
    return runLocked({
      section: "harnesses",
      id,
      kind,
      entry,
      work,
      onStarted,
      onProgress,
      signal,
      after: async () => {
        authCache.delete(id);
        await refreshLinks();
        return { harness: await resolve(id) };
      },
    });
  }

  /**
   * A typed version that can never be exact is refused before the lock, so a
   * typo answers at once and is not recorded as a failed operation.
   */
  function refuseMalformed(version) {
    const requested = version ? String(version).trim() : "";
    if (!requested || requested === "latest" || VERSION_SYNTAX.test(requested)) return null;
    return { ok: false, code: "invalid-version", error: `invalid version: ${requested}` };
  }

  /** `latest` (or nothing) resolves to mise's newest release, recorded exact. */
  async function targetVersion(entry, version, op = NO_OP) {
    const requested = version ? String(version).trim() : "";
    if (!requested || requested === "latest") op.phase("resolving");
    const target = requested && requested !== "latest"
      ? requested
      : await mise.latest(ctx, entry.miseTool, { signal: op.signal });
    assertVersion(target);
    if (meetsMinimum(target, entry.minimumVersion) === false) {
      throw operationError("version-below-minimum", `${entry.name} ${target} is below the required ${entry.minimumVersion}`);
    }
    return target;
  }

  /** Install and select one exact release, and prove it runs before recording it. */
  async function select(entry, previous, target, op = NO_OP) {
    const { executable, probe } = await useVerified(entry, target, async () => {
      const resolved = await resolveExecutable(entry, target);
      const result = await probeVersion(ctx, entry, resolved);
      if (!result.ok) throw operationError("not-runnable", result.error ?? "the installed executable did not run");
      return { executable: resolved, probe: result };
    }, op, previous);
    return {
      version: target,
      executable,
      verifiedVersion: probe.version,
      installedAt: previous.installedAt ?? ctx.now(),
      updatedAt: ctx.now(),
      managedVersions: union(previous.managedVersions, [target]),
    };
  }

  /**
   * Install a harness. Without an explicit version it resolves mise's latest
   * and records that exact value. Already-installed versions are re-verified.
   */
  async function install(id, options = {}) {
    const refused = refuseMalformed(options.version);
    if (refused) return refused;
    return runOperation(id, "install", async (entry, previous, op) =>
      select(entry, previous, await targetVersion(entry, options.version, op), op), options);
  }

  /** Update an installed harness. Always explicit; never implied by status. */
  async function update(id, options = {}) {
    const refused = refuseMalformed(options.version);
    if (refused) return refused;
    // Nothing to update is an answer, not a failed operation to record.
    const current = getHarness(id) ? await resolve(id, { authenticate: false }) : null;
    if (current && !current.installed && !current.recordedVersion) {
      return { ok: false, code: "not-installed", error: `${current.name} is not installed`, harness: current };
    }
    return runOperation(id, "update", async (entry, previous, op) => {
      if (!previous.version) {
        const current = await resolve(id, { authenticate: false });
        if (!current.installed) throw operationError("not-installed", `${entry.name} is not installed`);
      }
      return select(entry, previous, await targetVersion(entry, options.version, op), op);
    }, options);
  }

  /**
   * Remove the managed selection and every version the manager installed while
   * preserving credentials.
   */
  async function uninstall(id, options = {}) {
    return runOperation(id, "uninstall", async (entry, previous, op) => {
      op.phase("removing");
      // Remove what this manager installed, plus any version the global
      // selection currently points at, so a harness installed before the
      // manager kept state still uninstalls cleanly.
      const before = await mise.listTools(ctx);
      const configured = (before.tools?.[entry.miseTool] ?? [])
        .filter((candidate) => candidate.source && candidate.installed)
        .map((candidate) => candidate.version);
      const versions = union(
        previous.managedVersions,
        previous.version ? [previous.version] : [],
        configured,
      );
      try {
        await mise.unuse(ctx, entry.miseTool);
      } catch (error) {
        // A tool that is not configured is already unselected.
        if (!/not (found|present|installed)/i.test(String(error?.message ?? ""))) throw error;
      }
      for (const version of versions) {
        await mise.uninstall(ctx, entry.miseTool, version);
      }
      return {
        version: undefined,
        executable: undefined,
        verifiedVersion: undefined,
        managedVersions: [],
      };
    }, options);
  }

  // --- toolchains -----------------------------------------------------------
  //
  // Go, Rust, Bun, Deno and uv, selected in the user's global mise config so
  // they work in every directory. Simpler than a harness: no sign-in, and the
  // shim on PATH is the whole interface, so the facts are what mise reports.

  function toolchainFacts(entry, snap) {
    const entries = snap.tools[entry.miseTool] ?? [];
    const configured = entries.filter((candidate) =>
      candidate.source && String(candidate.source.path ?? "").startsWith(ctx.configDir));
    const global = configured.find((candidate) => candidate.active) ?? configured[0] ?? null;
    const record = snap.saved.toolchains[entry.id] ?? {};
    const operation = record.operation ?? null;
    const liveForThis = Boolean(snap.live && snap.live.id === entry.id);
    const interrupted = operation?.state === "in-progress" && !liveForThis;
    let failure = null;
    if (interrupted) failure = "a previous operation was interrupted before it finished";
    else if (operation?.state === "failed") failure = operation.error ?? "the last operation failed";
    return {
      id: entry.id,
      name: entry.name,
      miseTool: entry.miseTool,
      installed: Boolean(global?.installed),
      version: global?.installed ? global.version ?? null : null,
      inProgress: liveForThis,
      operation: operation?.kind ?? null,
      operationState: operation?.state ?? null,
      managedVersions: record.managedVersions ?? [],
      failed: Boolean(failure),
      failure,
    };
  }

  async function toolchainStatus() {
    const snap = await snapshot();
    return { toolchains: TOOLCHAINS.map((entry) => toolchainFacts(entry, snap)), degraded: snap.degraded };
  }

  async function resolveToolchain(id) {
    const entry = getToolchain(id);
    if (!entry) throw new Error(`unknown toolchain: ${id}`);
    return toolchainFacts(entry, await snapshot());
  }

  function runToolchain(id, kind, work, { onStarted, onProgress, signal } = {}) {
    const entry = getToolchain(id);
    if (!entry) return Promise.resolve({ ok: false, code: "unknown-toolchain", error: `unknown toolchain: ${id}` });
    return runLocked({
      section: "toolchains",
      id,
      kind,
      entry,
      work,
      onStarted,
      onProgress,
      signal,
      after: async () => ({ toolchain: await resolveToolchain(id) }),
    });
  }

  /** Install, or move to, mise's latest release, then prove the shim runs. */
  async function selectToolchain(entry, previous, op = NO_OP) {
    op.phase("resolving");
    const target = await mise.latest(ctx, entry.miseTool, { signal: op.signal });
    assertVersion(target);
    await useVerified(entry, target, async () => {
      const [bin, ...args] = entry.probe;
      const executable = await mise.which(ctx, bin);
      if (!executable) throw operationError("not-runnable", `mise installed ${entry.name} ${target} but has no ${bin}`);
      const result = await ctx.run([executable, ...args], {
        env: ctx.env,
        cwd: ctx.home,
        timeoutMs: ctx.timeouts.probe,
      });
      if (result.error || result.code !== 0) {
        throw operationError("not-runnable", result.error || `${bin} exited with code ${result.code}`);
      }
    }, op, previous);
    return { version: target, updatedAt: ctx.now(), managedVersions: union(previous.managedVersions, [target]) };
  }

  function installToolchain(id, options = {}) {
    return runToolchain(id, "install", selectToolchain, options);
  }

  function updateToolchain(id, options = {}) {
    return runToolchain(id, "update", selectToolchain, options);
  }

  /**
   * Drop the global selection and every release this manager installed (an
   * update leaves the previous one behind), plus whatever the global config
   * selected. A version only a project asked for is that project's to keep.
   */
  function uninstallToolchain(id, options = {}) {
    return runToolchain(id, "uninstall", async (entry, previous, op) => {
      op.phase("removing");
      const listing = await mise.listTools(ctx);
      const selected = (listing.tools?.[entry.miseTool] ?? [])
        .filter((candidate) => candidate.installed && String(candidate.source?.path ?? "").startsWith(ctx.configDir))
        .map((candidate) => candidate.version);
      await mise.unuse(ctx, entry.miseTool);
      for (const version of union(previous.managedVersions, selected)) {
        await mise.uninstall(ctx, entry.miseTool, version);
      }
      return { version: undefined, managedVersions: [] };
    }, options);
  }

  /**
   * Point each linkOnPath harness's link at its runnable executable, or remove
   * it. Runs after every operation and on every start (from preinstall), so
   * the link can never outlive the install it names. Best effort: a link that
   * cannot be written costs a shell lookup, nothing else.
   */
  async function refreshLinks() {
    const linked = CATALOGUE.filter((entry) => entry.linkOnPath);
    if (!linked.length) return;
    let snap;
    try {
      snap = await snapshot();
    } catch {
      return;
    }
    if (snap.degraded.length) return; // mise could not answer; change nothing
    for (const entry of linked) {
      const facts = await factsFor(entry, snap, { authenticate: false });
      const link = path.join(ctx.linkDir, entry.miseTool);
      const target = facts.runnable && facts.executable ? facts.executable : null;
      try {
        const current = await ctx.fs.readlink(link).catch(() => null);
        if (current === target) continue;
        if (current !== null) await ctx.fs.unlink(link);
        if (target) {
          await ctx.fs.mkdir(ctx.linkDir, { recursive: true });
          await ctx.fs.symlink(target, link);
        }
      } catch { /* best effort */ }
    }
  }

  /** Read-only facts for every catalogue entry. */
  async function status(options = {}) {
    const snap = await snapshot();
    const harnesses = await Promise.all(
      CATALOGUE.map((entry) => factsFor(entry, snap, options)),
    );
    return { harnesses, degraded: snap.degraded };
  }

  /** Read-only facts for one harness. */
  async function resolve(id, options = {}) {
    const entry = getHarness(id);
    if (!entry) throw new Error(`unknown harness: ${id}`);
    const snap = await snapshot();
    return factsFor(entry, snap, options);
  }

  /**
   * The newest release mise offers, without installing or recording it. Asks
   * the registry, so it belongs in a background job, never on a status read.
   */
  async function latest(id) {
    const entry = getHarness(id);
    if (!entry) throw new Error(`unknown harness: ${id}`);
    return mise.latest(ctx, entry.miseTool);
  }

  async function latestToolchain(id) {
    const entry = getToolchain(id);
    if (!entry) throw new Error(`unknown toolchain: ${id}`);
    return mise.latest(ctx, entry.miseTool);
  }

  /** Drop the cached sign-in verdict after a sign-in changes it. */
  function invalidateAuth(id) {
    if (id === undefined) authCache.clear();
    else authCache.delete(id);
  }

  return {
    status,
    resolve,
    install,
    update,
    uninstall,
    latest,
    invalidateAuth,
    refreshLinks,
    toolchains: {
      status: toolchainStatus,
      resolve: resolveToolchain,
      install: installToolchain,
      update: updateToolchain,
      uninstall: uninstallToolchain,
      latest: latestToolchain,
    },
    paths: {
      home,
      configDir: ctx.configDir,
      dataDir: ctx.dataDir,
      stateDir: ctx.stateDir,
      cacheDir: ctx.cacheDir,
      lock: ctx.lockPath,
      state: ctx.statePath,
      links: ctx.linkDir,
    },
  };
}

function union(...lists) {
  const out = [];
  for (const list of lists) {
    for (const value of list ?? []) {
      if (value && !out.includes(value)) out.push(value);
    }
  }
  return out;
}

function operationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
