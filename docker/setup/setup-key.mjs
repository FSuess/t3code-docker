// The setup key: the password the setup page asks for.
//
// It is the first of:
//
//   1. T3_SETUP_KEY, set in the container's configuration;
//   2. the key kept on the state volume ($T3CODE_HOME/setup-key), which the
//      first start generates when T3_SETUP_KEY is empty, and the setup page
//      can replace;
//   3. a key generated for this start alone, when the volume cannot keep one.
//
// A generated key used to change on every start, which on a hosting platform
// meant digging the new one out of the log after every redeploy. Kept on the
// volume, it is generated once and stays until someone replaces it.
//
// The file always holds the key in effect (T3_SETUP_KEY included), so the
// CLIs that read it (t3-expose) agree with the page whatever set it.
//
//   node setup-key.mjs --resolve   decide this start's key, keep it, and print
//                                  "<source> <key>" for the entrypoint
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const KEY_FILE = "setup-key";

/** A new key: 128 random bits, as hex. */
export const newKey = () => randomBytes(16).toString("hex");

/**
 * Whether a key can be used as one: printable ASCII without spaces, as a
 * cookie value and a header carry it, and not absurdly long. A hand-edited
 * file holding anything else is treated as no key at all.
 */
export const validKey = (key) => typeof key === "string" && /^[\x21-\x7e]{1,256}$/.test(key);

export const keyPath = (stateDir) => path.join(stateDir, KEY_FILE);

/** The key kept on the volume, or null when there is none or it is unusable. */
export function readKeyFile(stateDir) {
  try {
    const key = readFileSync(keyPath(stateDir), "utf8").trim();
    return validKey(key) ? key : null;
  } catch {
    return null;
  }
}

/**
 * Keep a key on the volume, readable by its owner only. Written whole and
 * renamed into place, so a reader never sees half a key. Throws when the
 * volume cannot take it.
 */
export function writeKeyFile(stateDir, key) {
  const target = keyPath(stateDir);
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${key}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * This start's key, and where it came from:
 *
 *   "env"     T3_SETUP_KEY (also written to the file, for the CLIs)
 *   "volume"  kept from an earlier start, or replaced from the setup page
 *   "new"     generated now, and kept from now on
 *   "boot"    generated now, and the volume could not keep it
 */
export function resolveSetupKey({ env = process.env, stateDir } = {}) {
  const configured = String(env.T3_SETUP_KEY ?? "").trim();
  if (configured) {
    try {
      writeKeyFile(stateDir, configured);
    } catch {
      // The CLIs fall back to T3_SETUP_KEY in their own environment.
    }
    return { key: configured, source: "env" };
  }
  const kept = readKeyFile(stateDir);
  if (kept) return { key: kept, source: "volume" };
  const key = newKey();
  try {
    writeKeyFile(stateDir, key);
    return { key, source: "new" };
  } catch {
    return { key, source: "boot" };
  }
}

// ---------------------------------------------------------------------- cli --

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv.includes("--resolve")) {
  const stateDir = process.env.T3CODE_HOME || `${process.env.HOME || "/home/t3"}/.t3`;
  const { key, source } = resolveSetupKey({ env: process.env, stateDir });
  process.stdout.write(`${source} ${key}\n`);
}
