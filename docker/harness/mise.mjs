// Thin wrapper around the pinned mise release the image installs.
//
// Every call names the tool and version as separate argv entries and runs with
// `-C <home>` so a project `mise.toml` in the caller's working directory can
// never change what the manager reads or writes. Reads force
// `MISE_AUTO_INSTALL=false` and disable the system fallback: a status call must
// never install anything and must never resolve a tool it did not install.
import path from "node:path";

/** The environment a read-only mise call runs under. */
export function readEnv(env) {
  return {
    ...env,
    MISE_AUTO_INSTALL: "false",
    MISE_NOT_FOUND_SYSTEM_FALLBACK: "false",
  };
}

/** The environment a mutating mise call runs under. */
export function writeEnv(env) {
  return { ...env, MISE_AUTO_INSTALL: "false" };
}

/** `<miseBin> -C <home> <args...>`, the single argv shape all calls use. */
export function miseArgs(ctx, args) {
  return [ctx.miseBin, "-C", ctx.home, ...args];
}

/**
 * Parse `mise ls --json` into `{ [tool]: [entry, ...] }`. A broken or missing
 * mise is reported as `null` so status can degrade instead of throwing.
 */
export async function listTools(ctx) {
  const result = await ctx.run(miseArgs(ctx, ["ls", "--json"]), {
    env: readEnv(ctx.env),
    cwd: ctx.home,
    timeoutMs: ctx.timeouts.mise,
  });
  if (result.error || result.code !== 0) {
    return { tools: null, error: firstError(result) };
  }
  try {
    const parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim() || "{}");
    return { tools: parsed && typeof parsed === "object" ? parsed : {}, error: null };
  } catch (error) {
    return { tools: null, error: `could not parse mise ls output: ${String(error?.message ?? error)}` };
  }
}

/**
 * Resolve the latest version mise offers for a tool. This is the only place a
 * floating selection is turned into an exact one; the result is recorded, not
 * kept as a moving target.
 */
export async function latest(ctx, tool, { signal } = {}) {
  // Normally well under two seconds. A network that drops packets instead of
  // refusing them would otherwise hold the lock for the whole mise timeout.
  const result = await ctx.run(miseArgs(ctx, ["latest", tool]), {
    env: readEnv(ctx.env),
    cwd: ctx.home,
    timeoutMs: ctx.timeouts.latest ?? ctx.timeouts.mise,
    ...(signal ? { signal } : {}),
  });
  if (result.cancelled) throw cancelledError();
  if (result.error || result.code !== 0) {
    throw new Error(firstError(result) || `mise latest ${tool} failed`);
  }
  const line = result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value && !/\s/.test(value) && /^[0-9A-Za-z]/.test(value))
    .pop();
  // Offline with a cold cache, mise warns and exits 0 with nothing on stdout.
  if (!line) throw new Error(`mise latest ${tool} returned no version: ${firstError(result)}`);
  return line;
}

/** `tool[options]@version`, mise's spelling for a tool with tool options. */
export function toolSpec(tool, version, options = null) {
  return `${tool}${options ? `[${options}]` : ""}@${version}`;
}

/** The error a cancelled run throws; the manager records it as cancelled, not failed. */
export function cancelledError() {
  const error = new Error("cancelled");
  error.code = "cancelled";
  return error;
}

/** Install-and-select in one step; `mise use` records the exact requested pin. */
export async function use(ctx, tool, version, options = null, { signal } = {}) {
  const result = await ctx.run(miseArgs(ctx, ["use", "-g", toolSpec(tool, version, options)]), {
    env: writeEnv(ctx.env),
    cwd: ctx.home,
    timeoutMs: ctx.timeouts.install,
    ...(signal ? { signal } : {}),
  });
  if (result.cancelled) throw cancelledError();
  if (result.error || result.code !== 0) {
    throw new Error(firstError(result) || `mise use ${tool}@${version} failed`);
  }
}

/** Remove the global selection for a tool. Idempotent. */
export async function unuse(ctx, tool) {
  const result = await ctx.run(miseArgs(ctx, ["unuse", "-g", tool]), {
    env: writeEnv(ctx.env),
    cwd: ctx.home,
    timeoutMs: ctx.timeouts.mise,
  });
  if (result.error || result.code !== 0) {
    throw new Error(firstError(result) || `mise unuse ${tool} failed`);
  }
}

/** Remove one installed version. Idempotent: a missing version is not an error. */
export async function uninstall(ctx, tool, version) {
  const result = await ctx.run(miseArgs(ctx, ["uninstall", `${tool}@${version}`]), {
    env: writeEnv(ctx.env),
    cwd: ctx.home,
    timeoutMs: ctx.timeouts.install,
  });
  if (result.error || result.code !== 0) {
    throw new Error(firstError(result) || `mise uninstall ${tool}@${version} failed`);
  }
}

/** The concrete executable mise resolves for a tool, or null. */
export async function which(ctx, tool) {
  const result = await ctx.run(miseArgs(ctx, ["which", tool]), {
    env: readEnv(ctx.env),
    cwd: ctx.home,
    timeoutMs: ctx.timeouts.mise,
  });
  if (result.error || result.code !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

/** The install directory for a tool@version, without requiring it to exist. */
export function installDir(ctx, tool, version) {
  return path.join(ctx.dataDir, "installs", tool, version);
}

// Lines mise prints around every failure that say nothing about the cause.
const NOISE = [
  /^mise ERROR Version: /i,
  /Run with --verbose or MISE_VERBOSE/i,
  /^mise WARN\s+mise version \S+ available/i,
  /^mise WARN\s+To update, run/i,
];

// A line a tool printed itself, which mise echoes with the tool's name:
// `mise go@1.27.1 go: cannot find GOROOT directory: /usr/local/go`.
const TOOL_SAID = /^mise [\w.:/-]+@\S+ (.+)$/;
// An ERROR that only says a step failed, not why.
const GENERIC = /\s(failed|exited with non-zero status(: exit code \d+)?)$/;

/**
 * The line that says why a mise run failed. mise reports the cause first
 * (`mise ERROR Failed to install http:grok@9.9.9: ... 404`) and then the same
 * two boilerplate lines every time, so take the first ERROR that is not
 * boilerplate, else the last line left. When that ERROR only says a step
 * failed (`~/.local/share/mise/installs/go/1.27.1/bin/go failed`), what the
 * tool printed just before it is the reason, so report that instead.
 */
export function firstError(result) {
  if (result.error) return result.error;
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !NOISE.some((pattern) => pattern.test(line)));
  const at = lines.findIndex((line) => /\bERROR\b/.test(line));
  if (at !== -1 && GENERIC.test(lines[at])) {
    const said = lines.slice(0, at).map((line) => TOOL_SAID.exec(line)?.[1]).filter(Boolean).pop();
    if (said) return said;
  }
  const pick = at !== -1 ? lines[at] : lines.pop();
  return pick ? pick.replace(/^mise (ERROR|WARN)\s+/, "") : `mise exited with code ${result.code}`;
}
