// Pure edits to T3 Code's provider settings, plus the atomic file IO around them.
//
// T3 stores per-provider configuration in `<T3CODE_HOME>/userdata/settings.json`
// (`ServerConfig.deriveServerPaths`). The supported integration seam is that
// file's per-provider `binaryPath`, which the driver spawns verbatim on Linux.
// Two representations exist:
//
//   * `providers.<driverKind>` - the legacy one-instance-per-driver map. T3
//     hydrates an instance from it when no explicit instance exists, which is
//     the compatibility shape T3 still reads.
//   * `providerInstances.<driverKind>.config.binaryPath` - the newer
//     driver-agnostic map. It wins over the legacy mirror, so an explicit
//     default instance must be updated too or it would shadow the selection.
//
// These helpers never create a `providerInstances` entry: synthesising one
// would shadow the legacy `enabled` flag and silently change enablement. They
// edit the legacy map, and any explicit default instance that already exists,
// preserving every unrelated key.
import { randomBytes } from "node:crypto";
import path from "node:path";

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The directory T3 treats as its base (`--base-dir` / `T3CODE_HOME`). */
export function baseDirFor(env = {}, home) {
  const explicit = typeof env.T3CODE_HOME === "string" ? env.T3CODE_HOME.trim() : "";
  if (explicit) return explicit;
  return path.join(home, ".t3");
}

/** The T3 settings file the provider seam lives in. */
export function settingsPathFor(baseDir) {
  return path.join(baseDir, "userdata", "settings.json");
}

/** This module's record of what it wrote, so it can retract only its own edits. */
export function statePathFor(baseDir) {
  return path.join(baseDir, "provider-integration.json");
}

/**
 * Whether the managed path may be written over `current`. Only values nobody
 * chose are ours to replace: absent, empty, T3's own default name, the exact
 * path this module wrote last time, or an absolute path that no longer exists
 * (`dead`) - an old image's /opt/npm-global/bin/claude, say, which T3 could
 * never launch again. A wrapper script or a different install someone pointed
 * T3 at in its settings stays theirs.
 */
export function replaceable(current, { owned = null, defaultBinary = null, dead = null } = {}) {
  if (current === undefined || current === null) return true;
  const value = String(current).trim();
  if (value === "") return true;
  if (defaultBinary && value === defaultBinary) return true;
  if (dead?.has(value)) return true;
  return owned !== null && value === owned;
}

/** Both places T3 may hold a provider's binaryPath, for the dead-path check. */
export function binaryPathsFor(settings, driver) {
  return [
    settings.providers?.[driver]?.binaryPath,
    settings.providerInstances?.[driver]?.config?.binaryPath,
  ].filter((value) => typeof value === "string" && value.trim() !== "").map((value) => value.trim());
}

/**
 * Point one provider's legacy mirror, and its explicit default instance when
 * one exists, at `executable`. Unrelated keys on both blobs are preserved, and
 * a `binaryPath` someone set themselves is left alone (`kept`).
 */
export function applyManaged(settings, driver, executable, ownership = {}) {
  let next = settings;
  let changed = false;
  let kept = false;

  const providers = isObject(settings.providers) ? { ...settings.providers } : {};
  const legacy = isObject(providers[driver]) ? { ...providers[driver] } : {};
  if (legacy.binaryPath !== executable) {
    if (replaceable(legacy.binaryPath, ownership)) {
      legacy.binaryPath = executable;
      providers[driver] = legacy;
      next = { ...next, providers };
      changed = true;
    } else {
      kept = true;
    }
  }

  const instances = settings.providerInstances;
  if (isObject(instances) && isObject(instances[driver])) {
    const instance = instances[driver];
    const config = isObject(instance.config) ? { ...instance.config } : {};
    if (config.binaryPath !== executable) {
      if (replaceable(config.binaryPath, ownership)) {
        config.binaryPath = executable;
        next = {
          ...next,
          providerInstances: { ...instances, [driver]: { ...instance, config } },
        };
        changed = true;
      } else {
        kept = true;
      }
    }
  }

  return { settings: next, changed, kept };
}

/**
 * T3 0.0.44 can install Codex itself ("managed setup"). When someone chose
 * that, the executable is T3's to pick, and this module stays out of it.
 */
export function t3ManagesItself(settings, driver) {
  if (isObject(settings.providers?.[driver]) && settings.providers[driver].setupMode === "managed") return true;
  const instance = settings.providerInstances?.[driver];
  return isObject(instance) && isObject(instance.config) && instance.config.setupMode === "managed";
}

/**
 * Retract a previously written `binaryPath`, but only where it is still exactly
 * the value this module recorded. A user who edited the field themselves keeps
 * their edit; the module stops tracking it.
 */
export function clearManaged(settings, driver, recordedExecutable) {
  let next = settings;
  let changed = false;

  const providers = isObject(settings.providers) ? { ...settings.providers } : {};
  const legacy = providers[driver];
  if (isObject(legacy) && legacy.binaryPath === recordedExecutable) {
    const copy = { ...legacy };
    delete copy.binaryPath;
    providers[driver] = copy;
    next = { ...next, providers };
    changed = true;
  }

  const instances = settings.providerInstances;
  if (isObject(instances) && isObject(instances[driver])) {
    const instance = instances[driver];
    if (isObject(instance.config) && instance.config.binaryPath === recordedExecutable) {
      const config = { ...instance.config };
      delete config.binaryPath;
      next = {
        ...next,
        providerInstances: { ...instances, [driver]: { ...instance, config } },
      };
      changed = true;
    }
  }

  return { settings: next, changed };
}

/**
 * Read a JSON file. A missing file is `null`; malformed JSON is an error the
 * caller must not paper over by overwriting whatever is there.
 */
export async function readJson(fs, file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { value: null, error: null };
    return { value: null, error: String(error?.message ?? error) };
  }
  try {
    return { value: JSON.parse(text), error: null };
  } catch (error) {
    return { value: null, error: `${file} is not valid JSON: ${String(error?.message ?? error)}` };
  }
}

/** Replace a file atomically, so a crash never leaves it half-written. */
export async function writeJsonAtomic(fs, file, value, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  await fs.rename(tmp, file);
}
