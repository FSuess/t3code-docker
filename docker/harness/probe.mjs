// Executable and credential probes.
//
// These are the only subprocesses the manager runs that are not mise itself.
// They are bounded, read-only, and never install anything; their whole job is
// to turn "a path exists" into the facts the console and T3 need - an exact
// running version and an authenticated/not/unknown verdict.
import path from "node:path";

/** Run the harness's version flag and extract a concrete version. */
export async function probeVersion(ctx, entry, executable) {
  if (!executable) return { ok: false, version: null, error: "no executable" };
  const result = await ctx.run([executable, ...entry.versionArgs], {
    env: ctx.env,
    cwd: ctx.home,
    timeoutMs: ctx.timeouts.probe,
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const match = new RegExp(entry.versionPattern).exec(output);
  const version = match?.[1] ?? null;
  if (result.error || result.code !== 0 || !version) {
    return {
      ok: false,
      version,
      error: result.error || firstLine(output) || `exited with code ${result.code}`,
    };
  }
  return { ok: true, version, error: null };
}

/** Which credential sources exist for a harness: environment keys and files. */
export async function credentialSurface(ctx, entry) {
  const env = entry.credentials.env.filter((key) => Boolean(ctx.env[key]?.trim?.()));
  const paths = [];
  for (const relative of entry.credentials.paths) {
    const absolute = path.join(ctx.home, relative);
    if (await ctx.fs.exists(absolute)) paths.push(absolute);
  }
  return { present: env.length > 0 || paths.length > 0, env, paths };
}

/**
 * Sign-in verdict. `null` is a real answer: it means the question could not be
 * answered from a file or a bounded probe, and must not be read as "signed in".
 */
export async function detectAuth(ctx, entry, { executable, runnable }) {
  switch (entry.auth) {
    case "claude": {
      if (hasEnv(ctx, "ANTHROPIC_API_KEY") || hasEnv(ctx, "CLAUDE_CODE_OAUTH_TOKEN")) return true;
      if (!runnable) return false;
      const result = await probeCommand(ctx, executable, ["auth", "status", "--json"]);
      const parsed = parseJson(result.combined);
      if (parsed && typeof parsed.loggedIn === "boolean") return parsed.loggedIn;
      return null;
    }
    case "codex": {
      if (!runnable) return false;
      const result = await probeCommand(ctx, executable, ["login", "status"]);
      const text = result.combined;
      if (/not logged in/i.test(text)) return false;
      if (/logged in/i.test(text)) return true;
      return null;
    }
    case "opencode": {
      const file = path.join(ctx.home, entry.credentials.paths[0]);
      if (!(await ctx.fs.exists(file))) return false;
      try {
        const parsed = JSON.parse(await ctx.fs.readFile(file, "utf8"));
        return parsed && typeof parsed === "object" && Object.keys(parsed).length > 0;
      } catch {
        return null;
      }
    }
    case "grok": {
      if (hasEnv(ctx, "XAI_API_KEY")) return true;
      if (!runnable) return false;
      const result = await probeCommand(ctx, executable, ["models"]);
      const text = result.combined;
      if (/you are logged in|using XAI_API_KEY/i.test(text)) return true;
      if (/not authenticated|not logged in/i.test(text)) return false;
      return null;
    }
    case "cursor": {
      if (!runnable) return false;
      const result = await probeCommand(ctx, executable, ["status", "--format", "json"]);
      const parsed = parseJson(result.combined);
      if (parsed && typeof parsed.isAuthenticated === "boolean") return parsed.isAuthenticated;
      return null;
    }
    default:
      return null;
  }
}

function hasEnv(ctx, key) {
  return Boolean(ctx.env[key]?.trim?.());
}

async function probeCommand(ctx, executable, args) {
  const result = await ctx.run([executable, ...args], {
    env: ctx.env,
    cwd: ctx.home,
    timeoutMs: ctx.timeouts.probe,
  });
  return { ...result, combined: `${result.stdout}\n${result.stderr}` };
}

function parseJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function firstLine(text) {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}
