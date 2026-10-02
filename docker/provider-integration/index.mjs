// Connect T3 Code's provider settings to the persistent harness manager.
//
// The harness manager is the single source of truth for which
// executable a harness should run: an exact version installed under mise, with
// the concrete path resolved from the install tree. T3 Code cannot be told
// about that selection through a CLI, but it does expose the supported
// `binaryPath` seam per provider, and it watches its settings file, so a write
// is picked up live. This module is the one place that turns manager facts into
// that write - no PATH shim, no bundle patch, and nothing that touches a
// provider's own updater.
//
// `sync()` is read-only with respect to the toolchain: it asks the manager for
// status (which never installs or updates) and edits only the settings file.
// The setup console calls it after an explicit Install/Update/Uninstall; the
// entrypoint calls it once at startup.
import os from "node:os";

import { createFs } from "./fsutil.mjs";
import { PROVIDERS } from "./providers.mjs";
import {
  applyManaged,
  baseDirFor,
  binaryPathsFor,
  clearManaged,
  readJson,
  settingsPathFor,
  statePathFor,
  t3ManagesItself,
  writeJsonAtomic,
} from "./settings.mjs";

const SCHEMA = 1;

/**
 * Build the integration around one T3 environment.
 *
 * `options.harness` is the harness manager (`createHarnessManager()`); it is
 * required for `sync()` and injectable for tests. `fs`, `env`, `home`,
 * `baseDir`, `settingsPath` and `statePath` exist for the same reason.
 */
export function createProviderIntegration(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  const fs = options.fs ?? createFs();
  const harness = options.harness ?? null;
  const baseDir = options.baseDir ?? baseDirFor(env, home);
  const settingsPath = options.settingsPath ?? settingsPathFor(baseDir);
  const statePath = options.statePath ?? statePathFor(baseDir);
  const now = options.now ?? Date.now;

  async function readState() {
    const { value } = await readJson(fs, statePath);
    if (value && typeof value === "object" && value.managed && typeof value.managed === "object") {
      return { schema: SCHEMA, managed: value.managed };
    }
    return { schema: SCHEMA, managed: {} };
  }

  function writeState(state) {
    return writeJsonAtomic(fs, statePath, state, 0o600);
  }

  /**
   * Apply every runnable managed executable to T3's provider settings, and
   * retract any this module wrote earlier that is no longer runnable (for
   * example after Uninstall) so T3 falls back to its own default. Returns a
   * report; never throws for a degraded mise, only for an unreadable settings
   * file, which must not be overwritten.
   *
   * A degraded mise changes nothing. When `mise ls` fails, every harness reads
   * as not installed, and retracting on that answer would unpick T3's settings
   * because of a timeout. A harness mid-operation is skipped for the same
   * reason: its facts are about to change, and the operation syncs when done.
   */
  async function sync() {
    if (!harness) throw new Error("provider integration needs a harness manager");

    const { harnesses, degraded } = await harness.status({ authenticate: false });
    if (degraded?.length) {
      return {
        ok: false,
        code: "degraded",
        error: degraded.map((entry) => `${entry.what}: ${entry.error}`).join("; ").slice(0, 300),
        settingsPath,
        applied: [],
        cleared: [],
        kept: [],
        unchanged: [],
        missing: [],
        degraded,
      };
    }
    const facts = new Map(harnesses.map((entry) => [entry.id, entry]));

    const loaded = await readJson(fs, settingsPath);
    if (loaded.error) {
      return {
        ok: false,
        code: "settings-unreadable",
        error: loaded.error,
        settingsPath,
        applied: [],
        cleared: [],
        kept: [],
        unchanged: [],
        missing: [],
        degraded,
      };
    }

    const previous = await readState();
    const managed = { ...previous.managed };
    let settings = loaded.value ?? {};
    let settingsChanged = false;

    const applied = [];
    const cleared = [];
    const kept = [];
    const unchanged = [];
    const missing = [];

    for (const provider of PROVIDERS) {
      const fact = facts.get(provider.id);
      if (!fact) {
        missing.push(provider.id);
        continue;
      }

      const recorded = previous.managed[provider.id]?.executable ?? null;
      if (fact.inProgress || t3ManagesItself(settings, provider.driver)) {
        unchanged.push(provider.id);
        continue;
      }

      const desired = fact.runnable && fact.executable ? fact.executable : null;
      if (desired) {
        const dead = new Set();
        for (const value of binaryPathsFor(settings, provider.driver)) {
          if (value.startsWith("/") && value !== desired && !(await fs.exists(value))) dead.add(value);
        }
        const result = applyManaged(settings, provider.driver, desired, {
          owned: recorded,
          defaultBinary: provider.defaultBinary,
          dead,
        });
        if (result.changed) {
          settings = result.settings;
          settingsChanged = true;
        }
        // Claim the field only where it now holds the managed path. Where
        // someone pointed T3 elsewhere their value wins, and this module stops
        // claiming it so a later Uninstall cannot retract it.
        if (binaryPathsFor(settings, provider.driver).includes(desired)) {
          managed[provider.id] = { driver: provider.driver, executable: desired, at: now() };
          applied.push({ id: provider.id, driver: provider.driver, executable: desired });
        } else {
          delete managed[provider.id];
        }
        if (result.kept) kept.push({ id: provider.id, driver: provider.driver, executable: desired });
      } else if (recorded) {
        const result = clearManaged(settings, provider.driver, recorded);
        if (result.changed) {
          settings = result.settings;
          settingsChanged = true;
        }
        delete managed[provider.id];
        cleared.push({ id: provider.id, driver: provider.driver, executable: recorded });
      } else {
        unchanged.push(provider.id);
      }
    }

    if (settingsChanged) {
      await writeJsonAtomic(fs, settingsPath, settings, 0o600);
    }

    const stateChanged = Object.keys(managed).length !== Object.keys(previous.managed).length
      || Object.entries(managed).some(([id, value]) => previous.managed[id]?.executable !== value.executable);
    if (stateChanged || settingsChanged) {
      await writeState({ schema: SCHEMA, managed });
    }

    return {
      ok: true,
      code: "ok",
      settingsPath,
      statePath,
      settingsChanged,
      applied,
      cleared,
      kept,
      unchanged,
      missing,
      degraded,
    };
  }

  return {
    sync,
    paths: { baseDir, settingsPath, statePath },
  };
}

export { PROVIDERS, driverFor, idFor } from "./providers.mjs";
export { applyManaged, clearManaged, settingsPathFor, statePathFor, baseDirFor } from "./settings.mjs";
