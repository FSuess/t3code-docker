// Sign-in checks for the source control CLIs (catalogue.mjs SOURCE_CONTROL).
//
// T3 Code asks each CLI whether it is signed in before it offers that host's
// pull requests, and says so in its Settings > Source Control. These ask the
// same questions: `gh auth status --json hosts`, `glab auth status`, tea's
// logins, `az account show`, and fj's key file, which is what T3 reads for fj
// too. Where an answer is ambiguous they read it more strictly than T3 does:
// only gh's active account counts, and a server that could not be reached
// (or a tea login that might only be offline) is unknown, not signed out.
//
// A verdict is `{ status, account, host, detail }`. `status` is
// "authenticated", "unauthenticated" or "unknown"; unknown is a real answer
// (the CLI said something this cannot read, or did not answer in time) and
// must not be shown as signed out. Nothing here signs anything in or out, and
// no token is ever part of a verdict.
import path from "node:path";

const verdict = (status, { account = null, host = null, detail = null } = {}) =>
  ({ status, account: account || null, host: host || null, detail: detail || null });

/** A CLI's lines without their status marks: glab starts them with ✓, ! or a plain x. */
const unmarked = (text) => String(text ?? "").split(/\r?\n/)
  .map((line) => line.replace(/^(?:[^A-Za-z0-9]+|x\s+)+/, "").trim());

/** The first line worth showing, never one that prints a token. */
export function safeLine(text) {
  return unmarked(text).find((line) => line && !/token/i.test(line)) ?? null;
}

/**
 * What a CLI says when it never reached the server - no DNS, no route, a
 * timeout, a TLS failure - as opposed to the server refusing the token. Gone
 * offline is not signed out: such a check is unknown.
 */
const UNREACHABLE = /\b(?:timeout|timed out|deadline exceeded|no such host|name resolution|dial tcp|connection refused|connection reset|network is unreachable|no route to host|certificate|EOF|error sending request|request failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b|\b(?:tls|x509):/i;
export const unreachable = (text) => UNREACHABLE.test(String(text ?? ""));

/** What every sign-in check and sign-in runs with: no colour, and never a prompt. */
export const NO_PROMPT = Object.freeze({ NO_COLOR: "1", GH_PROMPT_DISABLED: "1", GLAB_NO_PROMPT: "1" });

function parseJson(text) {
  try {
    return JSON.parse(String(text ?? "").trim());
  } catch {
    return undefined;
  }
}

/**
 * `gh auth status --json hosts`: the active account of a host. Only the active
 * one counts - every gh call, and T3's, runs as it - so a second account that
 * works does not make up for an active one whose token was revoked. A host gh
 * could not reach (state "timeout", or an error that never got an answer) is
 * unknown, not signed out.
 */
export function parseGhAuth({ stdout = "", stderr = "", code = 0 } = {}) {
  const parsed = parseJson(stdout);
  const hosts = parsed && typeof parsed.hosts === "object" && parsed.hosts !== null ? parsed.hosts : null;
  if (hosts) {
    const active = Object.values(hosts).flatMap((list) => (Array.isArray(list) ? list : []))
      .filter((entry) => entry && entry.active && typeof entry.login === "string" && entry.login.trim());
    const signed = active.find((entry) => entry.state === "success");
    if (signed) return verdict("authenticated", { account: signed.login.trim(), host: signed.host });
    const failed = active[0];
    const detail = failed?.error?.trim() || null;
    if (failed && (failed.state === "timeout" || unreachable(detail))) {
      return verdict("unknown", { host: failed.host, detail: detail ?? `${failed.host} did not answer in time` });
    }
    return verdict("unauthenticated", { host: failed?.host, detail });
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
  const offline = hosts.length ? unreachable(said) : unreachable(text);
  return verdict(code === 0 || offline ? "unknown" : "unauthenticated", { host: hosts[0]?.host, detail: safeLine(said) });
}

/**
 * `tea login status --output json`: the default login, or the first, and
 * whether tea found it valid. tea says "false" alike for a token the server
 * refused and a server it never reached, so an invalid login carries its
 * `name` for a second question (`teaReachable`).
 */
export function parseTeaAuth({ stdout = "", stderr = "" } = {}) {
  const logins = parseJson(stdout);
  if (!Array.isArray(logins)) return verdict("unknown", { detail: safeLine(`${stdout}\n${stderr}`) });
  const login = logins.find((entry) => entry?.default === "true" || entry?.default === true) ?? logins[0];
  if (!login) return verdict("unauthenticated");
  if (login.valid === "true" || login.valid === true) return verdict("authenticated", { account: login.user, host: hostOf(login.url) });
  return { ...verdict("unauthenticated", { host: hostOf(login.url) }), login: String(login.name ?? "") || null };
}

/**
 * `tea api --login <name> /user` for a login tea found invalid: a server that
 * answered (with its refusal, exit 0) means signed out; one that was never
 * reached ("request failed", exit 1) means unknown.
 */
export function teaReachable(signedOut, { stdout = "", stderr = "", code = 0 } = {}) {
  const { login, ...answer } = signedOut;
  const said = `${stderr}\n${stdout}`;
  if (code !== 0 && unreachable(said)) return verdict("unknown", { host: answer.host, detail: safeLine(said) });
  // The server's own message names no token, only that it refused one.
  const message = parseJson(stdout)?.message;
  return { ...answer, detail: typeof message === "string" && message.trim() ? message.trim().slice(0, 200) : safeLine(said) };
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

/**
 * The files each CLI keeps its sign-ins in, where it would write them in this
 * environment. Their modification times key the sign-in cache, so a sign-in
 * made in a terminal shows at once; a token sign-in copies them first and puts
 * them back when it fails.
 */
export function credentialFiles(entry, env, home) {
  const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
  switch (entry.auth) {
    case "gh":
      return [path.join(env.GH_CONFIG_DIR || path.join(config, "gh"), "hosts.yml")];
    case "glab":
      return [path.join(env.GLAB_CONFIG_DIR || path.join(config, "glab-cli"), "config.yml")];
    case "tea":
      return [path.join(config, "tea", "config.yml")];
    case "fj":
      return [fjKeysPath(env, home)];
    case "az": {
      const dir = env.AZURE_CONFIG_DIR || path.join(home, ".azure");
      return [path.join(dir, "azureProfile.json"), path.join(dir, "msal_token_cache.json")];
    }
    default:
      return [];
  }
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
  const run = (args) => ctx.run([executable, ...args], { env: { ...ctx.env, ...NO_PROMPT }, cwd: ctx.home, timeoutMs: ctx.timeouts.probe });
  const result = await run(ask.args);
  if (result.error && result.code === null) return verdict("unknown", { detail: String(result.error) });
  const answer = ask.parse({ stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code });
  if (!("login" in answer)) return answer;
  if (!answer.login) return teaReachable(answer, {});
  const asked = await run(["api", "--login", answer.login, "/user"]);
  if (asked.error && asked.code === null) return verdict("unknown", { host: answer.host, detail: String(asked.error) });
  return teaReachable(answer, { stdout: asked.stdout ?? "", stderr: asked.stderr ?? "", code: asked.code });
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
 * How one CLI signs in to `host` with a token: the steps to run, and a check
 * that the host accepted it where signing in does not already prove that.
 * glab and fj store any token they are given, so they are asked afterwards;
 * gh and tea refuse a bad one themselves. Neither fj nor tea replaces a
 * sign-in it already has for the host (fj keeps the old key and says so with
 * exit 0, tea refuses the name), so each first signs out of it: a step marked
 * `optional` may fail without failing the sign-in. Taking a failed attempt
 * back is not the plan's business: the manager restores the CLI's
 * `credentialFiles`, so a working sign-in from before survives a bad token.
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
          { args: ["auth", "setup-git", "--hostname", host], optional: true, warn: true },
        ],
        verify: null,
      };
    case "glab":
      return {
        steps: [{ args: ["auth", "login", "--hostname", host, "--stdin", "--git-protocol", "https", "--insecure-storage"], input: `${token}\n` }],
        verify: ["api", "user", "--hostname", host],
      };
    case "fj":
      return {
        steps: [
          { args: ["auth", "logout", host], optional: true },
          { args: ["--host", url, "auth", "add-token"], input: `${token}\n` },
        ],
        verify: ["--host", url, "whoami"],
      };
    case "tea":
      return {
        // --git-credentials makes tea git's credential helper for this host.
        steps: [
          // Fails when there is no login of that name, which is fine.
          { args: ["logout", host], optional: true },
          { args: ["login", "add", "--name", host, "--url", url, "--git-credentials"], env: { GITEA_SERVER_TOKEN: token } },
        ],
        verify: null,
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
  const line = unmarked(clean).find((entry) => entry && !/^(Location|Try authenticating with):?/i.test(entry));
  return line ?? (result.error ? String(result.error) : `exited with code ${result.code}`);
}
