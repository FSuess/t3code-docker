// Setup service: everything you need before T3 Code's own UI can take over.
//
// T3 Code's welcome wizard handles agent sign-in and project import perfectly
// well - but only once you have reached it, and reaching it needs a pairing
// link. Minting one otherwise means a shell in the container, which a hosting
// panel makes awkward. This serves that one step over HTTP, on its own port,
// gated by a key you set as an environment variable when creating the
// container.
//
// Deliberately dependency-free: Node's http, plus `t3` and `qrencode` from the
// image.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  withTimeout,
  createProviderCache,
  createHarnessCache,
} from "./cache.mjs";

const run = promisify(execFile);

// Read verbatim rather than embedded in a template literal: see the note at the
// top of app.js for what that cost twice.
const CLIENT_JS = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const CONSOLE_CSS = readFileSync(new URL("./console.css", import.meta.url), "utf8");

// Resolve the theme before first paint. Left to the client script, the page
// flashes light for as long as it takes to parse, which on a phone over a
// tunnel is long enough to see. Kept tiny and inline for that reason.
const THEME_BOOT = `(function(){try{var m=localStorage.getItem("t3-console-theme")||"system";` +
  `var d=m==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):m;` +
  `document.documentElement.setAttribute("data-theme",d);` +
  `document.documentElement.setAttribute("data-theme-mode",m);}catch(e){}})();`;

const PORT = Number(process.env.T3_SETUP_PORT ?? 3774);
const KEY = process.env.T3_SETUP_KEY ?? "";
const T3_PORT = process.env.T3CODE_PORT ?? "3773";
const PUBLIC_URL = (process.env.T3_PUBLIC_URL ?? "").replace(/\/+$/, "");
const COOKIE = "t3setup";
// Lets a single public hostname route a path prefix here instead of needing a
// second subdomain: e.g. Cloudflare Tunnel sending /__setup* to this port.
const BASE_PATH = (process.env.T3_SETUP_BASE_PATH ?? "").replace(/\/+$/, "");

if (!KEY) {
  console.error("[setup] T3_SETUP_KEY is empty; refusing to start");
  process.exit(1);
}

/** Constant-time compare that tolerates length differences. */
const keyMatches = (candidate) => {
  const a = Buffer.from(String(candidate ?? ""));
  const b = Buffer.from(KEY);
  if (a.length !== b.length) {
    // Still burn a comparison so failures cost the same either way.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
};

// A trivial throttle: the key is the only thing between a stranger and a
// pairing token, so make guessing expensive.
const failures = new Map();
const throttle = (ip) => {
  const n = failures.get(ip) ?? 0;
  failures.set(ip, n + 1);
  return new Promise((r) => setTimeout(r, Math.min(n * 250, 3000)));
};

// Bounded like the agent probes are. Without a timeout a single stuck
// subcommand - a locked state database during an upgrade, an agent CLI waiting
// on something - hangs /status forever, and the whole console sits on
// skeletons with no way to tell why.
const T3_TIMEOUT_MS = 15_000;
// T3 Code is image infrastructure: launch it by absolute path through the
// immutable launcher rather than resolving `t3` through PATH. Anything on PATH
// - a project shim, a mise shim - would otherwise be able to answer.
const T3_LAUNCHER = process.env.T3_INFRA_LAUNCHER || "/usr/local/bin/t3-admin";
const t3 = (args) =>
  run(T3_LAUNCHER, args, {
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: T3_TIMEOUT_MS,
  });

const health = async () => {
  try {
    const res = await fetch(
      `http://127.0.0.1:${T3_PORT}/.well-known/t3/environment`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = await res.json();
    return { ok: true, version: body.serverVersion, label: body.label };
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) };
  }
};

// --- managed harnesses ------------------------------------------------------
//
// One harness-management module owns exact-version install, state, locking and
// executable resolution for the five supported harnesses. The setup console
// and the `t3-harness` CLI
// are both thin surfaces over it, so they report identical selections and
// errors - no PATH workaround, no second installer.
//
// In the image the module lives at /opt/t3-harness/index.mjs (Dockerfile).
// In a checkout it lives at docker/harness/index.mjs. T3_HARNESS_MODULE
// overrides both, which is what the container tests use to pin the source.
const HARNESS_CANDIDATES = [
  process.env.T3_HARNESS_MODULE,
  "/opt/t3-harness/index.mjs",
  new URL("../harness/index.mjs", import.meta.url).href,
  new URL("../../docker/harness/index.mjs", import.meta.url).href,
].filter(Boolean);
const PROVIDER_CANDIDATES = [
  process.env.T3_PROVIDER_MODULE,
  "/opt/t3-provider/index.mjs",
  new URL("../provider-integration/index.mjs", import.meta.url).href,
  new URL("../../docker/provider-integration/index.mjs", import.meta.url).href,
].filter(Boolean);

let harnessManager = null;
let harnessModule = null;
async function loadHarness() {
  if (harnessManager) return harnessManager;
  let lastError = null;
  for (const candidate of HARNESS_CANDIDATES) {
    try {
      const module = await import(candidate);
      if (typeof module?.createHarnessManager !== "function") continue;
      harnessModule = module;
      harnessManager = module.createHarnessManager();
      return harnessManager;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `harness manager unavailable: ${String(lastError?.message ?? lastError ?? "not found")}`,
  );
}

async function loadProviderIntegration() {
  let lastError = null;
  for (const candidate of PROVIDER_CANDIDATES) {
    try {
      const module = await import(candidate);
      if (typeof module?.createProviderIntegration !== "function") continue;
      return module;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `provider integration unavailable: ${String(lastError?.message ?? lastError ?? "not found")}`,
  );
}

// After Install/Update/Uninstall, T3 must pick up the new `binaryPath`
// selection. T3 watches its settings file live, so one `sync()` reaches a
// running server without a restart. This is the notification interface -
// never a second settings writer.
const syncManagedProviders = async () => {
  const harness = await loadHarness();
  const { createProviderIntegration } = await loadProviderIntegration();
  const integration = createProviderIntegration({ harness });
  return integration.sync();
};

// Probing spawns a process per agent, so the manager caches sign-in verdicts
// briefly (10s per executable+version). A sign-in that changes credentials
// must clear that verdict, or the panel shows a stale answer after acting.
const forgetSignInState = (id) => {
  try {
    harnessManager?.invalidateAuth?.(id);
  } catch { /* a missing manager has nothing cached */ }
};

// The explicit credential writes (an API key, OpenCode's file) also drop the
// server's warm harness snapshot and refresh it before answering, so the very
// next poll cannot serve facts gathered before the credential existed. The
// probe flush happens first, or the refresh could read its own stale verdict.
// The refresh keeps the poll budget: if probes stall, it lands in the
// background and the next poll picks it up.
const refreshSignInState = async (id) => {
  forgetSignInState(id);
  try {
    await harnessCache.invalidate();
  } catch { /* the next poll still refreshes on its own */ }
};

// Last definite sign-in answer per agent. Five CLIs probed at once contend
// for the box, and the slowest two - Claude and Cursor - can miss a deadline
// even though each takes well under it alone. A missed deadline is not news
// about anyone's credentials, so it must not turn a known "Not signed in"
// into "not readable".
const lastKnown = new Map();
const stableAuth = (id, value) => {
  if (value === null) return lastKnown.has(id) ? lastKnown.get(id) : null;
  lastKnown.set(id, value);
  return value;
};

// The Agents card shape. `installed`/`signedIn` keep their historical names
// so older clients keep working; the managed facts alongside them are what
// the card actually renders: exact versions, runnable state, the operation in
// flight, and the failure that stopped the last one. Auth comes from the manager's bounded probe of
// the managed executable - never from a PATH search.
const toPublicHarness = (facts) => ({
  id: facts.id,
  name: facts.name,
  installed: facts.installed,
  runnable: facts.runnable,
  signedIn: stableAuth(facts.id, facts.authenticated),
  version: facts.installedVersion ?? facts.recordedVersion ?? null,
  installedVersion: facts.installedVersion,
  recordedVersion: facts.recordedVersion,
  verifiedVersion: facts.verifiedVersion ?? null,
  configuredVersion: facts.configuredVersion ?? null,
  executable: facts.executable,
  configured: facts.configured,
  minimumVersion: facts.minimumVersion ?? null,
  minimumSatisfied: facts.minimumSatisfied ?? null,
  supported: facts.supported,
  failed: facts.failed,
  failure: facts.failure,
  operation: facts.operation,
  operationState: facts.operationState,
  inProgress: facts.inProgress,
  managedVersions: facts.managedVersions ?? [],
  credentialsPresent: facts.credentials?.present ?? false,
  canSignIn: Boolean(AGENTS[facts.id]?.signin),
  canSetKey: Boolean(AGENTS[facts.id]?.apiKey),
  keyKind: AGENTS[facts.id]?.apiKey?.kind ?? null,
});

// --- offline-safe status ------------------------------------------------------
//
// `/status` and `/providers` stay responsive under `--network none`:
// every sub-read is local or bounded, provider data is served from bundled or
// cached state with an asynchronous refresh, and harness auth facts come from
// a coalesced refresh with a cheap local fallback. Nothing on these paths
// installs or updates: the manager reads are `status()` with
// `MISE_AUTO_INSTALL=false`, and the provider path only reads a file or
// fetches a catalogue.

// One authenticated refresh at a time, shared by concurrent polls; the cheap
// local read (`authenticate: false`: one `mise ls` plus filesystem checks)
// answers immediately when the budget loses. Authenticated probes can stall
// offline on remote API checks even though each is bounded, so the per-snapshot
// budget - not the probe timeout - is what keeps the endpoint within its five
// seconds.
const HARNESS_BUDGET_MS = 4000;
const T3_LIST_BUDGET_MS = 4000;

const harnessCache = createHarnessCache({
  full: async () => {
    const harness = await loadHarness();
    const { harnesses, degraded } = await harness.status({});
    return { harnesses: harnesses.map(toPublicHarness), degraded };
  },
  cheap: async () => {
    const harness = await loadHarness();
    const { harnesses, degraded } = await harness.status({ authenticate: false });
    return { harnesses: harnesses.map(toPublicHarness), degraded };
  },
  budgetMs: HARNESS_BUDGET_MS,
});

/** Authenticated snapshot for /status and /harnesses; explicit cheap polls
 * skip the auth refresh and answer from local state only. Returns the public
 * card rows plus the freshness of the answer.
 */
const harnessLifecycleStatus = async (authenticate = true) => {
  const snap = authenticate === false
    ? await harnessCache.snapshotCheap()
    : await harnessCache.snapshot();
  return {
    harnesses: snap.harnesses,
    degraded: snap.degraded,
    cache: { at: snap.at, stale: snap.stale, source: snap.source, refreshing: snap.refreshing },
  };
};

const harnessStatus = async (options = {}) => {
  const snap = await harnessLifecycleStatus(options.authenticate !== false);
  return snap.harnesses;
};

// The absolute managed executable when one is runnable, else null. Sign-in and the API-key
// stdin flow run through this, so credentials land where the executable T3
// launches reads them.
const managedExecutable = async (id) => {
  try {
    const harness = await loadHarness();
    const facts = await harness.resolve(id, { authenticate: false });
    if (facts?.runnable && facts?.executable) return facts.executable;
  } catch { /* no managed executable */ }
  return null;
};

const HARNESS_IDS = new Set(["claude", "codex", "opencode", "grok", "cursor"]);

const lifecycleHttpStatus = (code) => {
  switch (code) {
    case "ok": return 200;
    case "busy": return 409;
    case "unknown-harness":
    case "unknown-toolchain": return 404;
    case "invalid-version":
    case "version-below-minimum":
    case "not-installed":
    case "unsupported-arch": return 400;
    default: return 500;
  }
};

/**
 * OpenCode takes a key per provider, and there are north of two hundred of them
 * - typing the id from memory is a guess. models.dev is the catalog OpenCode
 * itself resolves providers from, so offer that list and let the browser pick.
 *
 * The document is 4.5MB, which is not something to hand a phone on every page
 * load, so pull it here, keep the id and name and nothing else, and cache that
 * to disk: a restart stays instant and an offline container keeps working. The
 * fallback below is only for a container that has never once reached the net.
 */
const PROVIDER_FALLBACK = [
  ["anthropic", "Anthropic"], ["openai", "OpenAI"], ["google", "Google"],
  ["openrouter", "OpenRouter"], ["deepseek", "DeepSeek"], ["xai", "xAI"],
  ["groq", "Groq"], ["mistral", "Mistral"], ["amazon-bedrock", "Amazon Bedrock"],
  ["azure", "Azure"], ["cerebras", "Cerebras"], ["together", "Together"],
  ["fireworks-ai", "Fireworks"], ["ollama", "Ollama"], ["opencode", "OpenCode Zen"],
].map(([id, name]) => ({ id, name }));

const PROVIDER_CACHE = `${process.env.T3CODE_HOME || `${process.env.HOME}/.t3`}/setup/providers.json`;
const PROVIDER_TTL_MS = 24 * 60 * 60 * 1000;
// The network fetch never blocks a response: it runs only as a background
// refresh behind `snapshot()`. Twelve seconds is generous for a slow edge
// precisely because no request waits on it.
const PROVIDER_FETCH_TIMEOUT_MS = 12_000;

const fetchProviderCatalog = async () => {
  const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Object.entries(await res.json())
    .map(([id, p]) => ({ id, name: typeof p?.name === "string" && p.name ? p.name : id }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

// Serve the catalogue immediately from memory, the disk cache, or the bundled
// fallback, and refresh asynchronously: under `--network none` this answers
// in milliseconds instead of waiting out the fetch timeout. The disk
// read and the fetch are the only I/O here; polling never installs anything.
const providerCache = createProviderCache({
  readFile: async () => {
    const { readFile } = await import("node:fs/promises");
    return readFile(PROVIDER_CACHE, "utf8");
  },
  writeFile: async (data) => {
    const { writeFile } = await import("node:fs/promises");
    return writeFile(PROVIDER_CACHE, data);
  },
  mkdir: async () => {
    const { mkdir } = await import("node:fs/promises");
    return mkdir(PROVIDER_CACHE.replace(/\/[^/]+$/, ""), { recursive: true });
  },
  fetchList: fetchProviderCatalog,
  fallback: PROVIDER_FALLBACK,
  ttlMs: PROVIDER_TTL_MS,
});

const providersSnapshot = () => providerCache.snapshot();

/** Which providers already hold a key, so the picker can say so. */
const configuredProviders = async () => {
  try {
    const { readFile } = await import("node:fs/promises");
    const auth = JSON.parse(await readFile(`${process.env.HOME}/.local/share/opencode/auth.json`, "utf8"));
    return Object.keys(auth ?? {});
  } catch {
    return [];
  }
};

// The first-start preinstall runs in its own process, so the harness card's
// cache does not hear about an agent it just installed. Any change in its
// progress drops the cache, and the next poll shows the agent as it lands.
let lastSetupProgress = null;
const noticeSetupProgress = (setup) => {
  const progress = setup ? JSON.stringify([setup.state, setup.items?.map((item) => item.state)]) : null;
  if (progress === lastSetupProgress) return;
  const first = lastSetupProgress === null;
  lastSetupProgress = progress;
  if (!first) void harnessCache.invalidate().catch(() => {});
};

const status = async () => {
  // Concurrently, and each failure contained: an empty list and "could not
  // read" are different facts, and reporting the first when the second is true
  // is how a console tells you a comfortable lie. Whatever answers, answers.
  // Every leg is bounded so the whole stays inside the five-second offline
  // budget: health is localhost, the harness snapshot races its authenticated
  // refresh against a local fallback, and the `t3 auth` lists are local
  // SQLite reads with a backstop for a locked database.
  const degraded = [];
  const attempt = async (what, work, fallback) => {
    try {
      return await work();
    } catch (error) {
      degraded.push({ what, error: String(error?.message ?? error).slice(0, 200) });
      return fallback;
    }
  };
  const attemptTimed = async (what, work, ms, fallback) => {
    const raced = await withTimeout(Promise.resolve().then(work), ms);
    if (raced.ok) return raced.value;
    degraded.push({ what, error: String(raced.error ?? "unavailable").slice(0, 200) });
    return fallback;
  };
  const [server, harnessSnap, pairings, sessions, toolchainSnap, setup] = await Promise.all([
    attempt("server health", health, { ok: false, detail: "health check failed" }),
    attempt("agent probes", () => harnessLifecycleStatus(true), {
      harnesses: [], degraded: [],
      cache: { at: null, stale: true, source: "unavailable", refreshing: false },
    }),
    attemptTimed("pairing links", () => listJson(["auth", "pairing", "list", "--json"]), T3_LIST_BUDGET_MS, []),
    attemptTimed("paired devices", () => listJson(["auth", "session", "list", "--json"]), T3_LIST_BUDGET_MS, []),
    // One local `mise ls`: cheap enough to read on every poll.
    attemptTimed("toolchains", async () => (await loadHarness()).toolchains.status(), HARNESS_BUDGET_MS,
      { toolchains: [], degraded: [] }),
    attempt("first-start setup", async () => {
      const manager = await loadHarness();
      return harnessModule.readPreinstall({ stateDir: manager.paths.stateDir });
    }, null),
  ]);
  noticeSetupProgress(setup);
  const harnesses = harnessSnap?.harnesses ?? [];
  for (const entry of harnessSnap?.degraded ?? []) {
    degraded.push({ what: `harness ${entry.what}`, error: String(entry.error ?? "").slice(0, 200) });
  }

  return {
    server,
    image: {
      version: process.env.T3_IMAGE_VERSION || null,
      variant: process.env.T3_IMAGE_VARIANT || null,
    },
    publicUrl: PUBLIC_URL || null,
    // The footer states where things live. Read them rather than printing a
    // plausible-looking default: a wrong path here is worse than no path.
    paths: {
      // What you mount is the home directory; the state dir lives inside it.
      volume: STATE_DIR.replace(/\/\.t3\/?$/, "") || STATE_DIR,
      state: STATE_DIR,
      workspace: process.env.T3_WORKSPACE || "/workspace",
      agents: `${STATE_DIR}/agents`,
      pairTtl: process.env.T3_PAIR_TTL || "30d",
    },
    harnesses,
    // Freshness of the harness facts above: `live` completed on this request,
    // `cache`/`cheap` are local or last-known state served because the
    // authenticated refresh exceeded its budget (it keeps running and warms
    // the next poll). A stale `signedIn` is the last definite verdict, never
    // a fresh claim.
    harnessCache: {
      at: harnessSnap?.cache?.at ?? null,
      stale: harnessSnap?.cache?.stale ?? true,
      source: harnessSnap?.cache?.source ?? "unavailable",
      refreshing: harnessSnap?.cache?.refreshing ?? false,
    },
    toolchains: toolchainSnap?.toolchains ?? [],
    // The background install of everything T3_PREINSTALL names, on a first
    // start: what it planned, where it is, and what failed (retried on the
    // next start, or from the row's own Install button).
    setup,
    // How the operations this page started ended, so a click that returned
    // 202 can still end in a toast or an error on the row.
    operations: Object.fromEntries([...operations].map(([key, { token: _token, ...op }]) => [key, op])),
    pairings,
    sessions,
    degraded,
  };
};

/** `t3 auth` prefixes JSON with log chatter; take the array and nothing else. */
const listJson = async (args) => {
  const { stdout } = await t3(args);
  const start = stdout.indexOf("[");
  if (start < 0) return [];
  return JSON.parse(stdout.slice(start));
};

const revoke = async ({ kind, id }) => {
  if (kind !== "session" && kind !== "pairing") throw new Error("unknown kind");
  if (!/^[A-Za-z0-9-]{1,64}$/.test(String(id ?? ""))) throw new Error("bad id");
  await t3(["auth", kind, "revoke", String(id)]);
  return { ok: true };
};

const mintPairing = async ({ ttl, label }) => {
  if (!PUBLIC_URL) {
    throw new Error(
      "T3_PUBLIC_URL is not set, so a pairing link would point at this container's own address. Set it and restart.",
    );
  }
  const args = ["auth", "pairing", "create", "--base-url", PUBLIC_URL, "--json"];
  if (ttl) args.push("--ttl", ttl);
  if (label) args.push("--label", label);
  const { stdout } = await t3(args);
  const issued = JSON.parse(stdout.slice(stdout.indexOf("{")));
  let qr = null;
  try {
    const { stdout: svg } = await run("qrencode", ["-t", "SVG", "-m", "1", "-o", "-", issued.pairUrl]);
    qr = svg;
  } catch {
    qr = null;
  }
  return { ...issued, qr };
};


// --- agent authentication ---------------------------------------------------
//
// Every one of these CLIs has a headless path, established by running them:
//   grok    login --device-auth   prints a URL and a code, then polls. No input.
//   cursor  login (NO_OPEN_BROWSER) prints a URL, then polls. No input.
//   claude  setup-token           prints a URL, then waits for a pasted code.
//   codex   login --with-api-key  reads the key from stdin. No browser.
//   opencode                      stores credentials in a JSON file we can write.
//
// The browser flows are TUIs, so they are run under `script` for a pty and
// their output is stripped of escapes before anything is scraped out of it.
import { spawn } from "node:child_process";
import { writeFile, mkdir, readFile } from "node:fs/promises";

const AGENTS = {
  claude: { name: "Claude Code",
    // `setup-token` mints a 1-year CI token and prints it; `auth login` is the
    // sign-in that actually leaves this container authenticated, which is what
    // the panel reports and what the agents then use.
    signin: { argv: ["claude", "auth", "login"], pty: true, expectsCode: true } },
  codex: { name: "Codex",
    apiKey: { kind: "stdin", argv: ["codex", "login", "--with-api-key"] },
    // Plain `codex login` starts a callback server on localhost:1455, which a
    // browser on any other machine cannot reach - it lands on the user's own
    // localhost instead. Codex says so itself and offers the device flow.
    signin: { argv: ["codex", "login", "--device-auth"], pty: true } },
  grok: { name: "Grok Build",
    signin: { argv: ["grok", "login", "--device-auth"], pty: false } },
  cursor: { name: "Cursor",
    signin: { argv: ["cursor-agent", "login"], pty: true, env: { NO_OPEN_BROWSER: "1" } } },
  opencode: { name: "OpenCode", apiKey: { kind: "opencode" } },
};

const stripAnsi = (text) =>
  text
    .replace(/\u001b\]8;[^\u0007\u001b]*(\u0007|\u001b\\)/g, "")  // OSC-8 hyperlinks
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "")                  // CSI
    .replace(/\u001b[()][A-Za-z0-9]/g, "")
    .replace(/\u001b[<-?]/g, "");

/**
 * Claude renders its sign-in URL as an OSC-8 hyperlink, wrapped across several
 * lines. The visible text is therefore broken into pieces and scraping it
 * yields a truncated URL missing every parameter after client_id - but the
 * escape sequence carries the whole thing as its target, so read that first
 * and only fall back to plain text for the CLIs that print one.
 */
const OSC8 = /\u001b\]8;[^;]*;([^\u0007\u001b]+)(?:\u0007|\u001b\\)/g;

const findUrl = (raw, stripped) => {
  const targets = [...raw.matchAll(OSC8)].map((m) => m[1]).filter((u) => /^https?:/.test(u));
  const plain = stripped.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  const all = [...targets, ...plain];
  if (all.length === 0) return null;
  return all.sort((a, b) => b.length - a.length)[0];
};
const findCode = (text) => (text.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/) ?? [null])[0];

const sessions = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000;
const SUBMIT_TTL_MS = 90 * 1000;
const TERMINAL_STATES = new Set(["done", "failed", "cancelled"]);

const shellQuote = (value) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(String(value ?? ""))
    ? String(value ?? "")
    : `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;

const startSignin = async (agentId) => {
  const agent = AGENTS[agentId];
  if (!agent?.signin) throw new Error(`${agentId} has no browser sign-in`);
  const { argv: baseArgv, pty, env, expectsCode } = agent.signin;

  // Run the sign-in through the managed executable when one is runnable, so
  // credentials land where the harness T3 launches reads them.
  // argv stays fixed per agent - only the binary is resolved, never built from
  // request input - so the shell that `script` needs cannot be steered.
  const managed = await managedExecutable(agentId);
  if (!managed) throw new Error(`${agentId} is not installed`);
  const argv = [managed, ...baseArgv.slice(1)];
  const [cmd, args] = pty
    ? ["script", ["-qec", argv.map(shellQuote).join(" "), "/dev/null"]]
    : [argv[0], argv.slice(1)];

  const child = spawn(cmd, args, {
    env: { ...process.env, ...(env ?? {}), NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const id = randomBytes(9).toString("hex");
  const session = {
    id, agentId, state: "starting", url: null, code: null,
    needsCode: Boolean(expectsCode), output: "", error: null, child,
    startedAt: Date.now(),
  };

  // Keep a window of the raw stream too: the escape sequences carry the real
  // hyperlink targets, and stripping them first loses the URL.
  let raw = "";
  const absorb = (chunk) => {
    raw = (raw + String(chunk)).slice(-20000);
    session.output = (session.output + stripAnsi(String(chunk))).slice(-8000);
    if (!session.url) {
      session.url = findUrl(raw, session.output);
      if (session.url) {
        run("qrencode", ["-t", "SVG", "-m", "1", "-o", "-", session.url])
          .then(({ stdout }) => { session.qr = stdout; })
          .catch(() => {});
      }
    }
    session.code ??= findCode(session.output);
    if (session.url && session.state === "starting") {
      session.state = session.needsCode ? "awaiting-code" : "awaiting-browser";
    }
    // A rejected code does not end the process: `claude setup-token` prints the
    // error and offers "Press Enter to retry", so waiting for an exit waits for
    // ever. Take the verdict from the output instead. The message itself is a
    // half-redrawn TUI frame, so say something useful rather than quoting it.
    if (session.state === "submitted" && /OAuth error|Press Enter to retry/i.test(session.output)) {
      session.state = "failed";
      session.error = "That code was not accepted. Copy the whole value from the "
        + "address bar, including everything after the #, and try again.";
      try { child.kill(); } catch {}
    }
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);
  child.on("error", (err) => { session.state = "failed"; session.error = String(err.message); });
  child.on("close", (code) => {
    // Either way the CLI may have written credentials, so re-probe next time.
    forgetSignInState(agentId);
    // A verdict already reached wins. We kill the child ourselves once the
    // output says the code was rejected, and `script` reports that kill as a
    // clean exit - which used to overwrite "failed" with "done" and tell
    // someone they were signed in when they had just been turned away.
    if (TERMINAL_STATES.has(session.state)) return;
    session.state = code === 0 ? "done" : "failed";
    if (code !== 0 && !session.error) {
      session.error = session.output.trim().split("\n").slice(-3).join(" ").slice(0, 300)
        || `exited with code ${code}`;
    }
  });

  sessions.set(id, session);
  setTimeout(() => {
    if (sessions.get(id)?.state?.startsWith("awaiting")) {
      try { session.child.kill(); } catch {}
      session.state = "failed";
      session.error = "Timed out waiting for the browser step.";
    }
  }, SESSION_TTL_MS).unref?.();
  // Waiting for the process to exit is the wrong finish line. These CLIs are
  // terminal UIs: several print their result and stay up. The question is not
  // "did it exit" but "is this agent signed in now", and we already have a way
  // to ask that - the manager's bounded probe of the managed executable - so
  // ask it, and keep the deadline for the case where nothing ever becomes true.
  const probeManagedAuth = async () => {
    try {
      const harness = await loadHarness();
      const facts = await harness.resolve(agentId, { authenticate: true });
      return facts?.authenticated ?? null;
    } catch {
      return null;
    }
  };
  // Only a transition counts. Someone signing in again while already signed in
  // - to switch accounts, say - would otherwise see the attempt declared done
  // before they had touched it.
  let wasSignedIn = null;
  probeManagedAuth().then((v) => { wasSignedIn = v; }).catch(() => {});
  const watchSession = setInterval(async () => {
    const live = sessions.get(id);
    if (!live || TERMINAL_STATES.has(live.state)) return;
    if (wasSignedIn !== true && (await probeManagedAuth()) === true) {
      try { live.child.kill(); } catch {}
      live.state = "done";
      forgetSignInState(agentId);
      return;
    }
    if (live.state !== "submitted") return;
    if (Date.now() - (live.submittedAt ?? Date.now()) < SUBMIT_TTL_MS) return;
    try { live.child.kill(); } catch {}
    live.state = "failed";
    live.error = "The CLI never reported being signed in after the code was sent.";
  }, 4000);
  watchSession.unref?.();
  child.on("close", () => clearInterval(watchSession));
  return session;
};

const publicSession = (s) => ({
  id: s.id, agent: s.agentId, state: s.state, url: s.url, code: s.code, qr: s.qr ?? null,
  needsCode: s.needsCode, error: s.error,
  tail: s.output.trim().split("\n").slice(-4).join("\n"),
});

const setApiKey = async (agentId, key, providerId) => {
  const agent = AGENTS[agentId];
  if (!agent?.apiKey) throw new Error(`${agentId} does not take a stored API key`);
  if (!key || key.length > 500) throw new Error("Enter a key");

  if (agent.apiKey.kind === "stdin") {
    const managed = await managedExecutable(agentId);
    if (!managed) throw new Error(`${agentId} is not installed`);
    const [bin, ...rest] = [managed, ...agent.apiKey.argv.slice(1)];
    await new Promise((resolve, reject) => {
      const child = spawn(bin, rest, {
        env: process.env, stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (c) => { out += c; });
      child.stderr.on("data", (c) => { out += c; });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(stripAnsi(out).trim().slice(-200) || "login failed")));
      child.stdin.end(`${key}\n`);
    });
    await refreshSignInState(agentId);
    return { ok: true };
  }

  // OpenCode reads credentials from a file, which is far steadier than driving
  // its picker; verified by writing one and having `opencode auth list` see it.
  if (agent.apiKey.kind === "opencode") {
    // Dots are in the catalog too (wafer.ai), and this only ever becomes a key
    // in a JSON object, never a path segment.
    if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(String(providerId ?? "")))
      throw new Error("Choose a provider (e.g. anthropic, openai, deepseek)");
    const dir = `${process.env.HOME}/.local/share/opencode`;
    await mkdir(dir, { recursive: true });
    let current = {};
    try { current = JSON.parse(await readFile(`${dir}/auth.json`, "utf8")); } catch {}
    current[providerId] = { type: "api", key };
    await writeFile(`${dir}/auth.json`, JSON.stringify(current, null, 2), { mode: 0o600 });
    await refreshSignInState(agentId);
    return { ok: true };
  }
  throw new Error("unsupported");
};

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { "cache-control": "no-store", ...headers });
  res.end(body);
};
const sendJson = (res, code, value, headers = {}) =>
  send(res, code, JSON.stringify(value), { "content-type": "application/json", ...headers });

const cookieFrom = (req) =>
  Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((pair) => pair.length === 2),
  )[COOKIE];

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) throw new Error("body too large");
  }
  return Buffer.concat(chunks).toString("utf8");
};

const page = (authed, mount) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>T3 Code setup</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23111'/%3E%3Ctext x='16' y='22' font-family='ui-monospace,monospace' font-size='16' font-weight='700' fill='%23fff' text-anchor='middle'%3ET3%3C/text%3E%3C/svg%3E">
<style>${CONSOLE_CSS}</style>
<script>window.__T3_SETUP_BASE__ = ${JSON.stringify(mount)};</script>
<script>${THEME_BOOT}</script>
</head><body>
<div class="console-top">
<header class="tc-chrome">
  <div class="tc-wrap tc-wrap--wide tc-chrome-in">
    <div class="tc-brand">
      <span class="tc-mark" aria-hidden="true"></span>
      <span class="tc-brand-name">T3 Code</span>
      <span class="tc-brand-sub">setup</span>
    </div>
    <div class="tc-chrome-spacer"></div>
    ${authed ? `<span class="tc-tag tc-tag--mono tc-tag--build" id="build"
      title="Image this container was built from">&mdash;</span>
    <span class="tc-health" id="health" role="status" aria-live="polite">Checking&hellip;</span>` : ""}
    <button type="button" class="tc-iconbtn" id="theme-btn"
      title="Switch color theme" aria-label="Switch color theme"></button>
  </div>
</header>
${authed ? `<div class="tc-strip"><div class="tc-wrap tc-wrap--wide tc-strip-in" id="strip"></div></div>` : ""}
</div>
<main class="tc-wrap tc-wrap--wide tc-main">
${authed ? `<div id="degraded"></div><div id="setup-progress" aria-live="polite"></div>` : ""}
${
  authed
    ? `<h1 class="tc-sr">T3 Code setup console</h1>
<div class="tc-deck">
  <div class="tc-deck-col">

    <section class="tc-card tc-card--hero">
      <div class="tc-cardhead">
        <h2 class="tc-eyebrow">Pair a device</h2>
        <div class="tc-cardhead-spacer"></div>
        <p class="tc-cardhead-note" id="paircount"></p>
      </div>
      <div class="tc-cardbody">
        <p class="tc-lede">Creates a single-use link for one device. Scan it with the
        T3 Code app, or open it in a browser.</p>
        <div class="pair-controls">
          <div class="tc-seg" id="ttl" role="group" aria-label="How long the link stays valid">
            <button type="button" data-ttl="1h">1 hour</button>
            <button type="button" data-ttl="7d">7 days</button>
            <button type="button" data-ttl="30d" aria-pressed="true">30 days</button>
          </div>
          <input id="label" class="tc-input grow" placeholder="Label, e.g. my phone"
            aria-label="Device label" />
          <button type="button" class="tc-btn tc-btn--primary" id="mint">Create pairing link</button>
        </div>
        <div id="out" aria-live="polite"></div>
      </div>
    </section>

    <section class="tc-card">
      <div class="tc-cardhead">
        <h2 class="tc-eyebrow">Agents</h2>
        <div class="tc-cardhead-spacer"></div>
        <p class="tc-cardhead-note" id="agent-count"></p>
      </div>
      <div class="tc-list" id="agents"><div class="tc-row"><span class="tc-skel"
        style="width:44%"></span></div><div class="tc-row"><span class="tc-skel"
        style="width:33%"></span></div></div>
    </section>

    <section class="tc-card">
      <div class="tc-cardhead">
        <h2 class="tc-eyebrow">Toolchains</h2>
        <div class="tc-cardhead-spacer"></div>
        <p class="tc-cardhead-note" id="toolchain-count"></p>
      </div>
      <div class="tc-list" id="toolchains"><div class="tc-row"><span class="tc-skel"
        style="width:36%"></span></div></div>
      <div class="tc-cardfoot">Available in every directory. A project that pins its own
        version in mise.toml or .tool-versions gets that one instead.</div>
    </section>

  </div>
  <div class="tc-deck-col">

    <section class="tc-card">
      <div class="tc-cardhead">
        <h2 class="tc-eyebrow">Ports</h2>
        <div class="tc-cardhead-spacer"></div>
        <p class="tc-cardhead-note" id="portnote"></p>
      </div>
      <div class="tc-list" id="ports"><div class="tc-row"><span class="tc-skel"
        style="width:38%"></span></div></div>
      <div class="tc-cardfoot" id="portfoot">A published URL is public while it is up.
        Take it down when you are done.</div>
    </section>

    <section class="tc-card">
      <div class="tc-cardhead">
        <h2 class="tc-eyebrow">Sessions</h2>
        <div class="tc-cardhead-spacer"></div>
        <p class="tc-cardhead-note" id="sessioncount"></p>
      </div>
      <div class="tc-grouphead">Devices</div>
      <div class="tc-list" id="clients"><div class="tc-row"><span class="tc-skel"
        style="width:56%"></span></div></div>
      <div class="tc-grouphead">Unused links</div>
      <div class="tc-list" id="links"><div class="tc-row"><span class="tc-skel"
        style="width:40%"></span></div></div>
    </section>

  </div>
</div>
<div class="tc-details" id="details"></div>`
    : `<section class="tc-card tc-card--pad" style="max-width:34rem;margin:8vh auto 0">
  <h2 style="font-size:22px;letter-spacing:-.02em;margin:0 0 6px">Unlock the console</h2>
  <p class="tc-lede" style="margin-bottom:20px">The key is
  <span class="tc-mono">T3_SETUP_KEY</span> from this container's environment: set by you,
  or generated at boot and printed to the container log.</p>
  <form method="POST" action="${mount}/login" class="tc-stack" id="loginform">
    <div class="tc-field">
      <label class="tc-label" for="key">Setup key</label>
      <input class="tc-input tc-input--mono" id="key" name="key" type="password"
        placeholder="Paste the setup key" autofocus autocomplete="current-password" />
      <span class="tc-hint">This key mints pairing links. Treat it like a password.</span>
    </div>
    <button class="tc-btn tc-btn--primary tc-btn--lg tc-btn--block" type="submit">Unlock console</button>
  </form>
</section>
<div class="tc-details" style="max-width:34rem;margin:20px auto 0;border:0;padding-top:0">
  <div class="tc-details-item"><span class="tc-details-value tc-mono">port ${
    process.env.T3_SETUP_PORT ?? 3774} · setup</span></div>
  <div class="tc-details-item"><span class="tc-details-value">Credentials never leave
    this container.</span></div>
</div>`
}
</main>
<script>${CLIENT_JS}</script></body></html>`;

// ---------------------------------------------------------------------------
// Ports
//
// A dev server started inside the container - by the user in a T3 Code terminal
// or by an agent - listens on a port nothing outside the container can reach.
// The whole premise here is that a phone is enough, so "now SSH in and forward
// a port" is not an answer. cloudflared publishes it instead: one click, a
// public https URL, and a QR code to open it on the device in your hand.
//
// This module is the only place tunnels are started or stopped. `t3-expose`
// does not run cloudflared itself - it calls this API - so the terminal and the
// page cannot hold different ideas about what is exposed.
// ---------------------------------------------------------------------------

const CLOUDFLARED = process.env.T3CODE_CLOUDFLARED_PATH || "cloudflared";
const STATE_DIR = process.env.T3CODE_HOME || `${process.env.HOME || "/home/t3"}/.t3`;
const EXPOSED_FILE = `${STATE_DIR}/exposed-ports.json`;

// Ports that belong to the container's own plumbing rather than to anything a
// user started. Exposing the setup page itself would be a foot-gun.
const RESERVED = new Set([PORT, Number(process.env.T3CODE_PORT ?? 3773)]);

// Ports the kernel hands out at random, which is where T3 Code's own agent
// probes and other short-lived internals land. They appear and vanish every
// few seconds, so listing them makes the panel churn and buries the dev server
// someone actually started. Discovery hides them; `t3-expose <port>` still
// publishes one by number if you really did start something up there.
const ephemeralRange = () => {
  try {
    const [lo, hi] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
      .trim().split(/\s+/).map(Number);
    if (Number.isInteger(lo) && Number.isInteger(hi) && lo < hi) return [lo, hi];
  } catch { /* not Linux, or /proc not mounted */ }
  return [32768, 60999];
};

const EPHEMERAL = ephemeralRange();

/** Ports currently in LISTEN state, whatever interface they bound to. */
const listeningPorts = async () => {
  // A dev server bound to 127.0.0.1 is the normal case and the one that most
  // needs a tunnel, so loopback-only listeners are included deliberately.
  // -p names the owning process, which is how cloudflared's own metrics
  // listener gets filtered out: publishing a port opened a second "port" in
  // this list, which is confusing and not something anyone would want to expose.
  const { stdout } = await run("ss", ["-H", "-l", "-t", "-n", "-p"]).catch(() => ({ stdout: "" }));
  const found = new Map();
  for (const line of stdout.split("\n")) {
    if (/"cloudflared"/.test(line)) continue;
    const local = line.trim().split(/\s+/)[3];
    if (!local) continue;
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port <= 0 || RESERVED.has(port)) continue;
    if (port >= EPHEMERAL[0] && port <= EPHEMERAL[1]) continue;
    // ss lists one row per bound address; a server on :: and 0.0.0.0 is one port.
    found.set(port, (found.get(port) ?? 0) + 1);
  }
  return [...found.keys()].sort((a, b) => a - b);
};

/** port -> { port, state, url, error, startedAt, child } */
const tunnels = new Map();

const publicTunnel = ({ port, state, url, error, startedAt, qr }) =>
  ({ port, state, url: url ?? null, error: error ?? null,
     startedAt: startedAt ?? null, qr: qr ?? null });

// Written for anything that wants to read the state without asking the server -
// a status line, a doctor check, a human with `cat`. The API is the source of
// truth; this file only ever mirrors it.
const persistExposed = () => {
  try {
    const live = [...tunnels.values()]
      .filter((t) => t.state === "open")
      .map(({ port, url, startedAt }) => ({ port, url, startedAt }));
    writeFileSync(EXPOSED_FILE, `${JSON.stringify({ exposed: live }, null, 2)}\n`, { mode: 0o600 });
  } catch { /* the state volume may be read-only; the API still works */ }
};

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

// cloudflared retries a blocked edge forever rather than exiting, so without
// this a firewalled network shows a spinner that never resolves and a CLI that
// times out saying nothing useful. Its own precheck already knows: it reports
// hard_fail when neither QUIC nor HTTP/2 can reach the edge. Say so instead.
const EDGE_UNREACHABLE = /precheck complete.*hard_fail=true/i;
// A hostname is assigned before any connection to the edge is established, so
// the URL alone is not proof the tunnel carries traffic - on a network that
// blocks the edge you get a name that answers 530. cloudflared logs this line
// when a connection is actually up, and T3 Code watches for the same one.
const EDGE_REGISTERED = /Registered tunnel connection/i;
const EDGE_MESSAGE =
  "cannot reach the Cloudflare edge from this network - it needs outbound "
  + "UDP 7844, or HTTP/2 to argotunnel.com";

const startTunnel = (rawPort) => {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be between 1 and 65535");
  }
  if (RESERVED.has(port)) {
    throw new Error(`port ${port} belongs to T3 Code itself`);
  }
  const existing = tunnels.get(port);
  if (existing && existing.state !== "failed") return existing;

  const child = spawn(CLOUDFLARED, [
    "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const tunnel = { port, state: "starting", url: null, error: null, startedAt: Date.now(), child };
  tunnels.set(port, tunnel);

  // cloudflared prints the assigned hostname to stderr, banner-style. Watch both
  // streams rather than guessing which release writes where.
  const watch = (chunk) => {
    const text = String(chunk);
    const match = text.match(QUICK_TUNNEL_URL);
    if (match) tunnel.url ??= match[0];
    if (EDGE_REGISTERED.test(text)) tunnel.registered = true;

    // Open means both: a hostname to hand out, and a connection to carry it.
    if (tunnel.url && tunnel.registered && tunnel.state !== "open") {
      tunnel.state = "open";
      persistExposed();
      // Rendered here rather than in the browser for the same reason pairing
      // does it: qrencode is already in the image, and the device that needs
      // to scan this is rarely the one showing the page.
      run("qrencode", ["-t", "SVG", "-m", "1", "-o", "-", tunnel.url])
        .then(({ stdout }) => { tunnel.qr = stdout; })
        .catch(() => { tunnel.qr = null; });
    }
    tunnel.log = `${(tunnel.log ?? "") + text}`.slice(-4000);

    if (tunnel.state === "starting" && EDGE_UNREACHABLE.test(tunnel.log)) {
      tunnel.state = "failed";
      tunnel.error = EDGE_MESSAGE;
      try { tunnel.child.kill(); } catch { /* already gone */ }
      persistExposed();
    }
  };
  child.stdout.on("data", watch);
  child.stderr.on("data", watch);

  child.on("exit", (code) => {
    // A tunnel we stopped on purpose is already gone from the map.
    if (tunnels.get(port) !== tunnel) return;
    if (tunnel.state === "failed") return;   // already diagnosed above
    tunnel.state = "failed";
    tunnel.error = tunnel.url
      ? `tunnel closed unexpectedly (exit ${code})`
      : firstUsefulLine(tunnel.log) || `cloudflared exited ${code}`;
    tunnel.url = null;
    persistExposed();
  });
  child.on("error", (error) => {
    tunnel.state = "failed";
    tunnel.error = String(error?.message ?? error);
    persistExposed();
  });

  return tunnel;
};

// cloudflared is chatty; surface the line that actually says what went wrong.
const firstUsefulLine = (log) => {
  for (const line of String(log ?? "").split("\n")) {
    const text = line.replace(/^\S+Z\s+/, "").trim();
    if (/ERR|error|failed|refused/i.test(text)) return text.slice(0, 200);
  }
  return "";
};

const stopTunnel = (rawPort) => {
  const port = Number(rawPort);
  const tunnel = tunnels.get(port);
  if (!tunnel) return { ok: false, error: `port ${port} is not exposed` };
  tunnels.delete(port);
  try { tunnel.child.kill("SIGTERM"); } catch { /* already gone */ }
  persistExposed();
  return { ok: true, port };
};

const portsStatus = async () => ({
  // `available` means cloudflared can run at all; the page says so plainly
  // rather than letting every Expose click fail with the same opaque error.
  available: existsSync(CLOUDFLARED) || CLOUDFLARED === "cloudflared",
  listening: await listeningPorts(),
  tunnels: [...tunnels.values()].map(publicTunnel),
});

// --- harness lifecycle ------------------------------------------------------
//
// One shared manager backs the Agents card and the `t3-harness` CLI, so both
// report identical selections and errors. Reads never install: status and
// resolve run `mise ls` plus bounded probes only. Mutations are explicit,
// authenticated POSTs that resolve `latest` to an exact version, record it,
// verify the executable runs, and then notify T3 through a single
// provider-integration `sync()` - never a second settings writer.
//
// Long operations outlive HTTP requests: mise installs take minutes, so the
// UI polls GET /harnesses (or /status) for `inProgress`/`operationState`
// rather than holding one request. Auth status is never inferred from install
// success; it stays whatever the bounded probe reports. Under `--network
// none` the authenticated read races its budget and falls back to cached or
// cheap local facts (see the offline-safe status block above).

// The install worked, but T3 may still not be pointed at it: the settings file
// could not be written, or someone set this agent's binary path themselves.
// Say so on the row instead of letting an "Installed" toast imply otherwise.
const syncWarning = (id, sync) => {
  if (!sync) return null;
  if (sync.ok === false) {
    return `Installed, but T3's settings were not updated (${String(sync.error ?? sync.code ?? "unknown").slice(0, 160)}).`;
  }
  if ((sync.kept ?? []).some((entry) => entry.id === id)) {
    return "Installed. T3 is set to a binary path of your own for this agent, so it keeps using that one.";
  }
  return null;
};

// Install, update and uninstall take from seconds to minutes: Codex is a
// 400 MB download, and a phone on a tunnel will not hold a request open that
// long (Cloudflare cuts it at 100 s and the page reported a failure while the
// install carried on). So a POST answers as soon as the operation holds the
// lock, and the work finishes in the background. `operations` is what the page
// polls to learn how its own clicks ended; work started elsewhere (preinstall,
// `t3-harness`) shows up through the manager's inProgress facts instead.
const operations = new Map(); // "harness:claude" -> { kind, state, error, ... }
const TOOLCHAIN_IDS = new Set(["go", "rust", "bun", "deno", "uv"]);

const startLifecycle = async (target, kind, input) => {
  const ids = target === "harness" ? HARNESS_IDS : TOOLCHAIN_IDS;
  const rawId = input?.id ?? input?.agent ?? "";
  const id = String(rawId ?? "").trim();
  if (!ids.has(id)) {
    const code = target === "harness" ? "unknown-harness" : "unknown-toolchain";
    return { http: 404, body: { ok: false, code, error: `unknown ${target}: ${String(rawId ?? "")}` } };
  }
  const rawVersion = target === "harness" ? input?.version : undefined;
  const version = rawVersion === undefined || rawVersion === null || String(rawVersion).trim() === ""
    ? undefined
    : String(rawVersion).trim();

  const manager = await loadHarness();
  const ops = target === "harness" ? manager : manager.toolchains;
  const key = `${target}:${id}`;
  // Only the request that actually took the lock reports into `operations`.
  // A second click refused as busy must not overwrite the one still running.
  const token = randomBytes(6).toString("hex");
  const mine = () => operations.get(key)?.token === token && operations.get(key)?.state === "running";
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const options = {
    ...(version ? { version } : {}),
    onStarted: () => {
      operations.set(key, { kind, state: "running", token, error: null, warning: null, startedAt: Date.now(), finishedAt: null });
      markStarted(null);
      // Let the next poll see the lock instead of the facts from before it.
      void harnessCache.invalidate().catch(() => {});
    },
  };

  const done = ops[kind](id, options).then(async (result) => {
    let sync = null;
    if (result?.ok && target === "harness") {
      try {
        sync = await syncManagedProviders();
      } catch (error) {
        sync = { ok: false, error: String(error?.message ?? error).slice(0, 200) };
      }
    }
    // Refresh the card's facts before reporting the result, so the poll that
    // sees "ok" also sees the agent installed.
    forgetSignInState(id);
    try { await harnessCache.invalidate(); } catch { /* the next poll refreshes */ }
    if (mine()) {
      operations.set(key, {
        ...operations.get(key),
        state: result?.ok ? "ok" : "failed",
        error: result?.ok ? null : String(result?.error ?? "failed").slice(0, 300),
        warning: result?.ok ? syncWarning(id, sync) : null,
        finishedAt: Date.now(),
      });
    }
    return { result, sync };
  }, (error) => {
    if (mine()) {
      operations.set(key, {
        ...operations.get(key), state: "failed", error: String(error?.message ?? error).slice(0, 300), finishedAt: Date.now(),
      });
    }
    return { result: { ok: false, code: "failed", error: String(error?.message ?? error) }, sync: null };
  });

  // Whichever comes first: the lock (answer now, finish in the background), or
  // the whole operation (refused before it started - busy, a bad version - or
  // simply quick, like an uninstall).
  const first = await Promise.race([started, done]);
  if (first === null) {
    return { http: 202, body: { ok: true, code: "started", id, kind, target } };
  }
  const { result, sync } = first;
  const body = {
    ok: Boolean(result?.ok),
    code: result?.code ?? "failed",
    ...(result?.error ? { error: result.error } : {}),
    ...(result?.harness ? { harness: toPublicHarness(result.harness) } : {}),
    ...(result?.toolchain ? { toolchain: result.toolchain } : {}),
    ...(sync ? { sync } : {}),
  };
  return { http: lifecycleHttpStatus(result?.code ?? "failed"), body };
};

const ROUTES = ["/login", "/status", "/pair", "/revoke", "/ports",
  "/ports/expose", "/ports/unexpose",
  "/harnesses/install", "/harnesses/update", "/harnesses/uninstall", "/harnesses",
  "/toolchains/install", "/toolchains/update", "/toolchains/uninstall",
  "/auth/apikey", "/auth/signin", "/auth/session", "/auth/code", "/auth/cancel",
  "/providers"];

/**
 * Work out which prefix this request arrived under, and which route it wants.
 *
 * A reverse proxy that routes by path (a Cloudflare Tunnel sending /__setup*
 * here, say) forwards the prefix intact. Requiring the operator to also declare
 * that prefix as an environment variable duplicates knowledge the request
 * already carries - and getting it wrong produced a bare "unauthorized", which
 * looks like a password problem rather than a routing one. So infer it, and
 * keep T3_SETUP_BASE_PATH only as an override.
 */
// A proxy that rewrites the path is supposed to say so. nginx, Traefik and
// friends send X-Forwarded-Prefix; when the path itself no longer carries the
// prefix, that header is the only thing left that knows it.
const forwardedPrefix = (req) => {
  const raw = req?.headers?.["x-forwarded-prefix"];
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim().replace(/\/+$/, "");
  return /^\/[\w\-./~]*$/.test(trimmed) ? trimmed : "";
};

const resolve = (pathname) => {
  if (BASE_PATH && (pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`))) {
    return { mount: BASE_PATH, route: pathname.slice(BASE_PATH.length) || "/" };
  }
  for (const route of ROUTES) {
    if (pathname === route) return { mount: "", route };
    if (pathname.endsWith(route)) {
      return { mount: pathname.slice(0, -route.length), route };
    }
  }
  // Anything else is a request for the page itself, whatever path it came in on.
  return { mount: pathname.replace(/\/+$/, ""), route: "/" };
};

const server = createServer(async (req, res) => {
  const ip = req.socket.remoteAddress ?? "?";
  const raw = new URL(req.url ?? "/", "http://localhost");
  const resolved = resolve(raw.pathname);
  const route = resolved.route;
  // The inferred mount wins when the prefix survived the hop; otherwise fall
  // back to what the proxy declared.
  const mount = resolved.mount || forwardedPrefix(req);
  // The page sends a cookie; the in-container CLIs send a header. Same key,
  // same comparison - so `t3-expose` and the page are the same client as far
  // as this server is concerned, and neither can act on state the other cannot.
  const authed = keyMatches(cookieFrom(req)) || keyMatches(req.headers["x-t3-setup-key"]);

  try {
    // Don't answer asset probes with the page.
    if (route === "/" && /\.[a-z0-9]{1,5}$/i.test(raw.pathname)) {
      return sendJson(res, 404, { error: "not found" });
    }

    if (req.method === "POST" && route === "/login") {
      const body = new URLSearchParams(await readBody(req));
      if (!keyMatches(body.get("key"))) {
        await throttle(ip);
        return send(res, 303, "", { location: `${mount}/` });
      }
      failures.delete(ip);
      return send(res, 303, "", {
        location: `${mount}/`,
        "set-cookie": `${COOKIE}=${encodeURIComponent(KEY)}; HttpOnly; SameSite=Strict; Path=${mount || "/"}; Max-Age=86400`,
      });
    }

    if (route === "/") {
      return send(res, 200, page(authed, mount), { "content-type": "text/html; charset=utf-8" });
    }

    if (!authed) {
      await throttle(ip);
      return sendJson(res, 401, { error: "unauthorized" });
    }

    if (route === "/status") return sendJson(res, 200, await status());

    if (req.method === "GET" && route === "/harnesses") {
      try {
        const url = new URL(req.url ?? "/", "http://x");
        const only = (url.searchParams.get("id") ?? "").trim();
        const authenticate = url.searchParams.get("authenticate") !== "false"
          && url.searchParams.get("authenticate") !== "0";
        const snap = await harnessLifecycleStatus(authenticate);
        const cache = snap.cache;
        if (only) {
          const found = snap.harnesses.find((h) => h.id === only);
          if (!found) return sendJson(res, 404, { ok: false, code: "unknown-harness", error: `unknown harness: ${only}` });
          return sendJson(res, 200, { harness: found, degraded: snap.degraded, harnessCache: cache });
        }
        return sendJson(res, 200, { harnesses: snap.harnesses, degraded: snap.degraded, harnessCache: cache });
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message ?? error) });
      }
    }
    const lifecycle = /^\/(harnesses|toolchains)\/(install|update|uninstall)$/.exec(route);
    if (req.method === "POST" && lifecycle) {
      try {
        const target = lifecycle[1] === "harnesses" ? "harness" : "toolchain";
        const input = JSON.parse((await readBody(req)) || "{}");
        const { http, body } = await startLifecycle(target, lifecycle[2], input);
        return sendJson(res, http, body);
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }

    if (req.method === "GET" && route === "/ports") {
      return sendJson(res, 200, await portsStatus());
    }
    if (req.method === "POST" && route === "/ports/expose") {
      try {
        const input = JSON.parse((await readBody(req)) || "{}");
        return sendJson(res, 200, publicTunnel(startTunnel(input.port)));
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }
    if (req.method === "POST" && route === "/ports/unexpose") {
      try {
        const input = JSON.parse((await readBody(req)) || "{}");
        const result = stopTunnel(input.port);
        return sendJson(res, result.ok ? 200 : 404, result);
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }


    if (req.method === "GET" && route === "/providers") {
      const snap = await providersSnapshot();
      return sendJson(res, 200, {
        providers: snap.list,
        configured: await configuredProviders(),
        cache: { at: snap.at, stale: snap.stale, source: snap.source, refreshing: snap.refreshing },
      });
    }
    if (req.method === "POST" && route === "/auth/apikey") {
      try {
        const input = JSON.parse((await readBody(req)) || "{}");
        return sendJson(res, 200, await setApiKey(input.agent, input.key, input.provider));
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }

    if (req.method === "POST" && route === "/auth/signin") {
      try {
        const input = JSON.parse((await readBody(req)) || "{}");
        return sendJson(res, 200, publicSession(await startSignin(input.agent)));
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }

    if (route === "/auth/session") {
      const session = sessions.get(new URL(req.url ?? "/", "http://x").searchParams.get("id"));
      if (!session) return sendJson(res, 404, { error: "no such session" });
      return sendJson(res, 200, publicSession(session));
    }

    if (req.method === "POST" && route === "/auth/code") {
      const input = JSON.parse((await readBody(req)) || "{}");
      const session = sessions.get(input.id);
      if (!session) return sendJson(res, 404, { error: "no such session" });
      try {
        // A carriage return, not a newline. These prompts run the terminal in
        // raw mode, where Enter arrives as CR; an LF is accepted as part of the
        // text and the prompt just sits there. The characters showed up as
        // asterisks and nothing ever happened.
        session.child.stdin.write(`${String(input.code ?? "").trim()}\r`);
        session.state = "submitted";
        session.submittedAt = Date.now();
        return sendJson(res, 200, publicSession(session));
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }

    if (req.method === "POST" && route === "/auth/cancel") {
      const input = JSON.parse((await readBody(req)) || "{}");
      const session = sessions.get(input.id);
      if (session) {
        session.state = "cancelled";
        try { session.child.kill(); } catch {}
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && route === "/revoke") {
      try {
        return sendJson(res, 200, await revoke(JSON.parse((await readBody(req)) || "{}")));
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }

    if (req.method === "POST" && route === "/pair") {
      const input = JSON.parse((await readBody(req)) || "{}");
      try {
        return sendJson(res, 200, await mintPairing(input));
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (error) {
    return sendJson(res, 500, { error: String(error?.message ?? error) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[setup] listening on 0.0.0.0:${PORT}`);
});
