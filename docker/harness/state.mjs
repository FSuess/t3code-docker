// The manager's own record: what exact version each harness (and toolchain)
// was installed at, where its executable resolved, and how the last operation
// ended.
//
// mise is the source of truth for what is installed right now; this file adds
// the facts mise cannot express - that an operation was interrupted, and which
// concrete location the manager chose when it last succeeded. It lives in the
// persistent mise state directory so it survives container recreation.
import path from "node:path";

const SCHEMA = 1;

export function statePath(stateDir) {
  return path.join(stateDir, "harness-state.json");
}

export function emptyState() {
  return { schema: SCHEMA, harnesses: {}, toolchains: {} };
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Read the state file. A missing or corrupt file yields a fresh state. */
export async function readState(ctx) {
  try {
    const parsed = JSON.parse(await ctx.fs.readFile(ctx.statePath, "utf8"));
    if (!isObject(parsed)) return emptyState();
    return {
      schema: SCHEMA,
      harnesses: isObject(parsed.harnesses) ? parsed.harnesses : {},
      toolchains: isObject(parsed.toolchains) ? parsed.toolchains : {},
    };
  } catch {
    return emptyState();
  }
}

/** Atomic replace, so a crash never leaves a half-written state file. */
export async function writeState(ctx, state) {
  await ctx.fs.mkdir(path.dirname(ctx.statePath), { recursive: true });
  const tmp = `${ctx.statePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  await ctx.fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await ctx.fs.rename(tmp, ctx.statePath);
}

/** Merge one entry of a section ("harnesses" or "toolchains") and persist it. */
export async function updateEntry(ctx, section, id, patch) {
  const state = await readState(ctx);
  const previous = state[section][id] ?? {};
  const next = { ...previous, ...patch };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  state[section][id] = next;
  await writeState(ctx, state);
  return next;
}
