// Where devices reach this server: the address a pairing link points at.
//
// Three places can say, and the first that does wins:
//
//   1. T3_PUBLIC_URL, pinned in the container's configuration;
//   2. an address saved from the setup page, kept on the state volume
//      ($T3CODE_HOME/public-url), so it applies at once and survives a
//      recreate, with nobody editing the container;
//   3. the address a hosting platform gives the service, from the variable it
//      sets (Railway, Render, Koyeb, Zeabur, Coolify, Fly).
//
// The setup service, t3-pair, t3-doctor and the entrypoint all ask this module
// (the shell ones by running it), so none of them can disagree about where a
// link points.
//
//   node public-url.mjs              the address, or nothing
//   node public-url.mjs --json       {"url", "source", "platform"}
//   node public-url.mjs --describe   the address and where it came from
import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SAVED_FILE = "public-url";

const withScheme = (domain) => {
  const value = String(domain ?? "").trim();
  return value ? `https://${value}` : "";
};

// Coolify has shipped COOLIFY_URL and COOLIFY_FQDN swapped, and either may
// hold several comma-separated values. Take the first value that is a URL,
// whichever variable it came in.
const coolify = (env) => {
  const values = [env.COOLIFY_URL, env.COOLIFY_FQDN]
    .flatMap((v) => String(v ?? "").split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  return values.find((v) => /^https?:\/\//i.test(v)) ?? withScheme(values[0]);
};

/**
 * What each platform sets, most specific first. Fly comes last: every Fly
 * Machine has FLY_APP_NAME, but only an app with a public service answers on
 * <name>.fly.dev.
 */
export const PLATFORMS = [
  { id: "railway", name: "Railway", read: (env) => withScheme(env.RAILWAY_PUBLIC_DOMAIN) },
  { id: "render", name: "Render", read: (env) => env.RENDER_EXTERNAL_URL },
  { id: "koyeb", name: "Koyeb", read: (env) => withScheme(env.KOYEB_PUBLIC_DOMAIN) },
  { id: "zeabur", name: "Zeabur", read: (env) => env.ZEABUR_WEB_URL || withScheme(env.ZEABUR_WEB_DOMAIN) },
  { id: "coolify", name: "Coolify", read: coolify },
  { id: "fly", name: "Fly.io", read: (env) => (env.FLY_APP_NAME ? `https://${String(env.FLY_APP_NAME).trim()}.fly.dev` : "") },
];

/**
 * An address as someone would type it, made into the origin a pairing link
 * starts with: "t3.example.com" becomes "https://t3.example.com". Returns
 * { url } or { error } saying what to change. T3 Code is served at the root,
 * so a path is a mistake rather than something to keep.
 */
export function parsePublicUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return { error: "Enter the address your devices use, such as https://t3.example.com." };
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { error: "That is not an address. Use something like https://t3.example.com." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: "Use an https:// or http:// address." };
  }
  if (!url.hostname) return { error: "That address has no host name." };
  if (url.username || url.password) return { error: "Leave the user name and password out of the address." };
  if (url.pathname !== "/" || url.search || url.hash) {
    return { error: `Leave the path out: T3 Code is at the root, so use ${url.origin}.` };
  }
  return { url: url.origin };
}

/** The address each platform gives this service, if this is running on one. */
export function platformUrl(env = process.env) {
  for (const platform of PLATFORMS) {
    const { url } = parsePublicUrl(platform.read(env));
    if (url) return { url, platform: platform.name };
  }
  return null;
}

/**
 * Where pairing links point, and why. `saved` is the setup page's address
 * (readSaved). T3_PUBLIC_URL is taken as written, less a trailing slash, as it
 * always has been: it is the container's own configuration.
 *
 *   { url, source: "env" | "saved" | "platform" | null, platform }
 */
export function resolvePublicUrl({ env = process.env, saved = null } = {}) {
  const pinned = String(env.T3_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (pinned) return { url: pinned, source: "env", platform: null };
  const fromPage = saved ? parsePublicUrl(saved).url : null;
  if (fromPage) return { url: fromPage, source: "saved", platform: null };
  const offered = platformUrl(env);
  if (offered) return { url: offered.url, source: "platform", platform: offered.platform };
  return { url: null, source: null, platform: null };
}

/** Where a resolved address came from, in words, for logs and t3-doctor. */
export const describeSource = ({ source, platform }) =>
  source === "env" ? "T3_PUBLIC_URL"
    : source === "saved" ? "set on the setup page"
      : source === "platform" ? `from ${platform}` : "unset";

// ------------------------------------------------------------------ storage --

export const savedPath = (stateDir) => path.join(stateDir, SAVED_FILE);

/** The address saved from the setup page, or null. */
export function readSaved(stateDir) {
  try {
    return readFileSync(savedPath(stateDir), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Save an address (already parsed). Written whole, then renamed into place. */
export function writeSaved(stateDir, url) {
  const target = savedPath(stateDir);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${url}\n`, { mode: 0o644 });
  renameSync(temp, target);
}

export function clearSaved(stateDir) {
  rmSync(savedPath(stateDir), { force: true });
}

// -------------------------------------------------------------------- check --

/**
 * Does `url` reach this server? Asks it for T3 Code's environment and compares
 * the id with the one T3 Code reports locally.
 *
 *   { reaches: "this" }      it is this server
 *   { reaches: "other" }     a different T3 Code server answered
 *   { reaches: "unknown", why }  no answer that settles it, from inside the
 *                            container. Normal for LAN and tailnet names, a
 *                            router that does not loop back, or a login page
 *                            in front of the server, so it is not an error.
 */
export async function checkReaches(url, { localId, fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  let res;
  try {
    res = await fetchImpl(`${url}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
  } catch (error) {
    const cause = error?.cause?.code ?? error?.name ?? "";
    const why = cause === "TimeoutError" || cause === "UND_ERR_CONNECT_TIMEOUT" ? "it did not answer in time"
      : cause === "ENOTFOUND" || cause === "EAI_AGAIN" ? "its name does not resolve there"
        : /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(cause) ? "its certificate is not one the container trusts"
          : "nothing answered";
    return { reaches: "unknown", why };
  }
  if (!res.ok) return { reaches: "unknown", why: `it answered HTTP ${res.status}` };
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const id = body && typeof body.environmentId === "string" ? body.environmentId : null;
  if (!id) return { reaches: "unknown", why: "it answered, but not as T3 Code (a sign-in page in front of it, perhaps)" };
  if (localId && id === localId) return { reaches: "this" };
  if (!localId) return { reaches: "unknown", why: "T3 Code here is not answering, so there was nothing to compare with" };
  return { reaches: "other", label: typeof body.label === "string" ? body.label : null };
}

// ---------------------------------------------------------------------- cli --

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const stateDir = process.env.T3CODE_HOME || `${process.env.HOME || "/home/t3"}/.t3`;
  const resolved = resolvePublicUrl({ env: process.env, saved: readSaved(stateDir) });
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(resolved)}\n`);
  else if (process.argv.includes("--describe")) {
    if (resolved.url) process.stdout.write(`${resolved.url} (${describeSource(resolved)})\n`);
  } else if (resolved.url) process.stdout.write(`${resolved.url}\n`);
}
