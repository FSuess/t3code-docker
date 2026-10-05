// Sign-in checks for the source control CLIs (catalogue.mjs SOURCE_CONTROL).
//
// T3 Code asks each CLI whether it is signed in before it offers that host's
// pull requests, and says so in its Settings > Source Control. These ask the
// same questions the same way, so the setup page and T3 never disagree about
// a host: `gh auth status --json hosts`, `glab auth status`, tea's logins,
// `az account show`, and fj's key file, which is what T3 reads for fj too.
//
// A verdict is `{ status, account, host, detail }`. `status` is
// "authenticated", "unauthenticated" or "unknown"; unknown is a real answer
// (the CLI said something this cannot read, or did not answer in time) and
// must not be shown as signed out. Nothing here signs anything in or out, and
// no token is ever part of a verdict.
import path from "node:path";

const verdict = (status, { account = null, host = null, detail = null } = {}) =>
  ({ status, account: account || null, host: host || null, detail: detail || null });

/**
 * The first line worth showing, never one that prints a token. Status marks
 * go: glab starts its lines with ✓, ! or a plain x.
 */
export function safeLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^(?:[^A-Za-z0-9]+|x\s+)+/, "").trim())
    .find((line) => line && !/token/i.test(line)) ?? null;
}

function parseJson(text) {
  try {
    return JSON.parse(String(text ?? "").trim());
  } catch {
    return undefined;
  }
}

/** `gh auth status --json hosts`: an account whose state is success, the active one first. */
export function parseGhAuth({ stdout = "", stderr = "", code = 0 } = {}) {
  const parsed = parseJson(stdout);
  const hosts = parsed && typeof parsed.hosts === "object" && parsed.hosts !== null ? parsed.hosts : null;
  if (hosts) {
    const accounts = Object.values(hosts).flatMap((list) => (Array.isArray(list) ? list : []))
      .filter((entry) => entry && typeof entry.login === "string" && entry.login.trim());
    const signed = accounts.find((entry) => entry.state === "success" && entry.active)
      ?? accounts.find((entry) => entry.state === "success");
    if (signed) return verdict("authenticated", { account: signed.login.trim(), host: signed.host });
    const failed = accounts.find((entry) => entry.active) ?? accounts[0];
    return verdict("unauthenticated", { host: failed?.host, detail: failed?.error?.trim() || null });
  }
  // gh learned `--json` for auth status in 2.81; an older one is not signed out.
  if (/unknown flag: --json/.test(`${stdout}\n${stderr}`)) {
    return verdict("unknown", { detail: "This gh is too old to report its sign-in; T3 Code needs 2.81 or newer." });
  }
  return code === 0 ? verdict("unknown", { detail: safeLine(`${stdout}\n${stderr}`) })
    : verdict("unauthenticated", { detail: safeLine(`${stdout}\n${stderr}`) });
}

const HOST_LINE = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:.]+\])(?::\d+)?$/i;
const LOGGED_IN = /Logged in to .+? as\s+([^\s(]+)/i;

/**
 * `glab auth status`: a block per host, its name unindented, and "Logged in
 * to <host> as <user>" inside the one that is signed in.
 */
export function parseGlabAuth({ stdout = "", stderr = "", code = 0 } = {}) {
  const text = `${stdout}\n${stderr}`;
  const hosts = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (raw === raw.trimStart() && HOST_LINE.test(line)) hosts.push({ host: line.toLowerCase(), lines: [] });
    else hosts.at(-1)?.lines.push(line);
  }
  for (const entry of hosts) {
    const account = LOGGED_IN.exec(entry.lines.join("\n"))?.[1];
    if (account) return verdict("authenticated", { account, host: entry.host });
  }
  const account = LOGGED_IN.exec(text)?.[1];
  if (account) return verdict("authenticated", { account, host: hosts[0]?.host });
  const said = hosts.length ? hosts[0].lines.join("\n") : text;
  return verdict(code === 0 ? "unknown" : "unauthenticated", { host: hosts[0]?.host, detail: safeLine(said) });
}

/** `tea login status --output json`: the default login, or the first, and whether tea found it valid. */
export function parseTeaAuth({ stdout = "", stderr = "" } = {}) {
  const logins = parseJson(stdout);
  if (!Array.isArray(logins)) return verdict("unknown", { detail: safeLine(`${stdout}\n${stderr}`) });
  const login = logins.find((entry) => entry?.default === "true" || entry?.default === true) ?? logins[0];
  if (!login) return verdict("unauthenticated");
  return verdict(login.valid === "true" || login.valid === true ? "authenticated" : "unauthenticated",
    { account: login.user, host: hostOf(login.url) });
}

/** `az account show --query user.name -o tsv`: a user name, or az's own complaint. */
export function parseAzAuth({ stdout = "", stderr = "", code = 0 } = {}) {
  if (code !== 0) return verdict("unauthenticated", { detail: safeLine(`${stderr}\n${stdout}`) });
  const account = String(stdout).trim().split(/\r?\n/)[0]?.trim();
  return account ? verdict("authenticated", { account, host: "dev.azure.com" })
    : verdict("unknown", { host: "dev.azure.com" });
}

/**
 * fj's key file: `{ hosts: { "codeberg.org": { type, token } } }`. fj keeps no
 * user name, so a saved key is the whole answer - the host is the account.
 */
export function parseFjKeys(text) {
  const parsed = parseJson(text);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) return verdict("unknown", { detail: "fj's key file is not readable" });
  const hosts = Object.keys(parsed.hosts && typeof parsed.hosts === "object" ? parsed.hosts : {});
  return hosts.length ? verdict("authenticated", { host: hosts[0] }) : verdict("unauthenticated");
}

function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return null;
  }
}

/** Where fj keeps its keys on Linux: the XDG data directory. */
export function fjKeysPath(env, home) {
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, ".local", "share");
  return path.join(data, "forgejo-cli", "keys.json");
}

/** Where az keeps its extensions. */
export function azExtensionDir(env, home) {
  return env.AZURE_EXTENSION_DIR || path.join(env.AZURE_CONFIG_DIR || path.join(home, ".azure"), "cliextensions");
}

const ASK = {
  gh: { args: ["auth", "status", "--json", "hosts"], parse: parseGhAuth },
  glab: { args: ["auth", "status"], parse: parseGlabAuth },
  tea: { args: ["login", "status", "--output", "json"], parse: parseTeaAuth },
  az: { args: ["account", "show", "--query", "user.name", "--output", "tsv"], parse: parseAzAuth },
};

/**
 * Ask one installed CLI whether it is signed in. `executable` is the command
 * to run (a resolved path, or the bare name for the image's gh). Bounded by
 * the manager's probe timeout; a CLI that does not answer is unknown.
 */
export async function detectSourceControlAuth(ctx, entry, executable) {
  if (entry.auth === "fj") {
    const file = fjKeysPath(ctx.env, ctx.home);
    if (!(await ctx.fs.exists(file))) return verdict("unauthenticated");
    try {
      return parseFjKeys(await ctx.fs.readFile(file, "utf8"));
    } catch {
      return verdict("unknown", { detail: "fj's key file is not readable" });
    }
  }
  const ask = ASK[entry.auth];
  if (!ask || !executable) return verdict("unknown");
  const result = await ctx.run([executable, ...ask.args], {
    env: { ...ctx.env, NO_COLOR: "1", GH_PROMPT_DISABLED: "1", GLAB_NO_PROMPT: "1" },
    cwd: ctx.home,
    timeoutMs: ctx.timeouts.probe,
  });
  if (result.error && result.code === null) return verdict("unknown", { detail: String(result.error) });
  return ask.parse({ stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code });
}

/** The az extensions an entry needs that are not installed. Read from disk: asking az costs a second each. */
export async function missingExtensions(ctx, entry) {
  const missing = [];
  for (const name of entry.extensions ?? []) {
    if (!(await ctx.fs.exists(path.join(azExtensionDir(ctx.env, ctx.home), name)))) missing.push(name);
  }
  return missing;
}

// --- signing in and out -------------------------------------------------------
//
// gh, glab, fj and tea sign in with a token for one host, handed over on stdin
// or in the environment - never as an argument, where `ps` would show it. az
// signs in with a device code instead (the setup service runs that flow), so
// it has no token plan. Each plan is fixed argv per CLI; only the host, which
// is checked first, comes from the request.

/** The host most people mean, when they do not name another. */
export const DEFAULT_HOSTS = Object.freeze({ gh: "github.com", glab: "gitlab.com", fj: "codeberg.org", tea: "gitea.com" });

const HOSTNAME = /^(?=.{1,253}(?::|$))[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/i;

/**
 * A host as typed - `gitlab.example.com`, `https://git.example.com:8443/` -
 * reduced to `name[:port]`, or why it is not one. A path is refused: none of
 * these CLIs can sign in to a server mounted under one.
 */
export function parseHost(raw) {
  let text = String(raw ?? "").trim().replace(/^https:\/\//i, "").replace(/\/+$/, "");
  if (!text) return { ok: false, error: "Name the server, for example gitlab.com." };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { ok: false, error: "Only https:// servers can be signed in to." };
  if (text.includes("/")) return { ok: false, error: "Name the server alone, without a path." };
  text = text.toLowerCase();
  if (!HOSTNAME.test(text)) return { ok: false, error: `“${text.slice(0, 80)}” is not a server name.` };
  return { ok: true, host: text };
}

/** A token as pasted: one line, no spaces, of a sane length. */
export function parseToken(raw) {
  const token = String(raw ?? "").trim();
  if (!token) return { ok: false, error: "Paste a token." };
  if (/\s/.test(token) || token.length > 4096) return { ok: false, error: "That does not look like a token: it has spaces or line breaks in it." };
  return { ok: true, token };
}

/**
 * How one CLI signs in to `host` with a token: the steps to run, a check that
 * the host accepted it (where signing in does not already prove that), and
 * how to take it back when it did not. glab and fj store any token they are
 * given, so they are asked afterwards; gh and tea refuse a bad one themselves.
 */
export function tokenSignIn(entry, host, token) {
  const url = `https://${host}`;
  switch (entry.auth) {
    case "gh":
      return {
        steps: [
          { args: ["auth", "login", "--hostname", host, "--with-token", "--git-protocol", "https", "--insecure-storage"], input: `${token}\n` },
          // So git push over HTTPS uses the same token. Signed in without it
          // is still signed in: a failure here is a warning, not a rollback.
          { args: ["auth", "setup-git", "--hostname", host], optional: true },
        ],
        verify: null,
        undo: ["auth", "logout", "--hostname", host],
      };
    case "glab":
      return {
        steps: [{ args: ["auth", "login", "--hostname", host, "--stdin", "--git-protocol", "https", "--insecure-storage"], input: `${token}\n` }],
        verify: ["api", "user", "--hostname", host],
        undo: ["auth", "logout", "--hostname", host],
      };
    case "fj":
      return {
        steps: [{ args: ["--host", url, "auth", "add-token"], input: `${token}\n` }],
        verify: ["--host", url, "whoami"],
        undo: ["auth", "logout", host],
      };
    case "tea":
      return {
        // --git-credentials makes tea git's credential helper for this host.
        steps: [{ args: ["login", "add", "--name", host, "--url", url, "--git-credentials"], env: { GITEA_SERVER_TOKEN: token } }],
        verify: null,
        undo: ["logout", host],
      };
    default:
      return null;
  }
}

/** How one CLI signs out of `host` (az of everything). */
export function signOutArgs(entry, host) {
  switch (entry.auth) {
    case "gh":
    case "glab":
      return ["auth", "logout", "--hostname", host];
    case "fj":
      return ["auth", "logout", host];
    case "tea":
      return ["logout", host];
    case "az":
      return ["logout"];
    default:
      return null;
  }
}

/**
 * The first thing a CLI said about a failed step, with the token it was given
 * cut out. Unlike a status probe's line, this one may mention tokens: "HTTP
 * 401: Bad credentials" is on gh's "Error validating token" line, and the
 * token itself is what is removed, wherever it appears.
 */
export function failureLine(result, token) {
  const said = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  const clean = token ? said.split(token).join("…") : said;
  const line = clean.split(/\r?\n/).map((entry) => entry.replace(/^(?:[^A-Za-z0-9]+|x\s+)+/, "").trim())
    .find((entry) => entry && !/^(Location|Try authenticating with):?/i.test(entry));
  return line ?? (result.error ? String(result.error) : `exited with code ${result.code}`);
}
