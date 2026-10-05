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
import { gzip as gzipCallback } from "node:zlib";
import { readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import vm from "node:vm";
import {
  withTimeout,
  createProviderCache,
  createHarnessCache,
} from "./cache.mjs";
import { loadAssets, renderConsole, renderUnlock, contentSecurityPolicy } from "./page.mjs";
import { parseListeners, processLabel, looksLikeDatabase } from "./ports.mjs";
import { createStorageFacts } from "./storage.mjs";
import { createLatestCache } from "./latest.mjs";
import { createT3Api } from "./t3-api.mjs";
import { createAntigravity } from "./antigravity.mjs";
import { createT3Sessions } from "./t3-session.mjs";
import { clientAddress } from "./client-address.mjs";
import { newKey, readKeyFile, writeKeyFile } from "./setup-key.mjs";
import { connectState, jsonFrom, parseLinkOutput } from "./connect.mjs";
import {
  checkReaches, clearSaved, parsePublicUrl, platformUrl, readSaved, resolvePublicUrl, writeSaved,
} from "./public-url.mjs";

const run = promisify(execFile);
const gzip = promisify(gzipCallback);

// Every stylesheet and script the page inlines, read verbatim once: see the
// note at the top of app.js for what embedding them in template literals cost.
// A file that could not be inlined safely stops the service here, loudly,
// rather than shipping a page whose script ends early.
const ASSETS = loadAssets();

const PORT = Number(process.env.T3_SETUP_PORT ?? 3774);
const T3_PORT = process.env.T3CODE_PORT ?? "3773";
const COOKIE = "t3setup";
// Lets a single public hostname route a path prefix here instead of needing a
// second subdomain: e.g. Cloudflare Tunnel sending /__setup* to this port.
const BASE_PATH = (process.env.T3_SETUP_BASE_PATH ?? "").replace(/\/+$/, "");
// The one-port router in front of T3 Code and this page (docker/router), when
// T3_SINGLE_PORT asks for it. The entrypoint has already refused a value it
// could not serve, so anything here is a port.
const SINGLE_PORT = Number(process.env.T3_SINGLE_PORT) || null;
// Where the router puts this page, as it normalises T3_SETUP_BASE_PATH.
const SINGLE_PREFIX = BASE_PATH ? (BASE_PATH.startsWith("/") ? BASE_PATH : `/${BASE_PATH}`) : "/__setup";
// Where T3 Code keeps its state; the volume a user mounts is the home around it.
const STATE_DIR = process.env.T3CODE_HOME || `${process.env.HOME || "/home/t3"}/.t3`;
const VOLUME = STATE_DIR.replace(/\/\.t3\/?$/, "") || STATE_DIR;
const WORKSPACE = process.env.T3_WORKSPACE || "/workspace";
// The setup key and where it came from (setup-key.mjs): "env" for
// T3_SETUP_KEY, "volume" for one kept on the state volume, "boot" for one the
// volume could not keep. A kept key is read from the volume rather than the
// environment, so one replaced from this page outlives this process's own
// restarts, which inherit the key the container started with.
const keySourceOf = (source) => (source === "env" || source === "boot" ? source : source ? "volume" : "env");
let KEY_SOURCE = keySourceOf(process.env.T3_SETUP_KEY_SOURCE);
let KEY = (KEY_SOURCE === "volume" && readKeyFile(STATE_DIR)) || process.env.T3_SETUP_KEY || "";

// Where pairing links point: T3_PUBLIC_URL, else the address saved from this
// page, else the hosting platform's (public-url.mjs). Read on every use, so a
// change from this page, or from another process, applies at once.
const publicUrl = () => resolvePublicUrl({ env: process.env, saved: readSaved(STATE_DIR) });

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
// Bounded: behind a proxy that names each visitor, a guesser rotating
// addresses would otherwise grow this forever. The oldest go first.
const FAILURES_KEPT = 1000;
const failures = new Map();
const throttle = (ip) => {
  const n = failures.get(ip) ?? 0;
  failures.delete(ip);
  failures.set(ip, n + 1);
  if (failures.size > FAILURES_KEPT) failures.delete(failures.keys().next().value);
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

// T3 Code's own API, for what only T3 can do: install Google's Antigravity
// runtime (T3 pins and checks it) and sign it in. The console holds a bearer
// session of its own for it, issued through the same launcher; it is not a
// device, so the Devices page and its "paired" events leave it out.
const CONSOLE_SUBJECT = "t3-setup-console";
const t3Api = createT3Api({
  url: `ws://127.0.0.1:${T3_PORT}/ws`,
  issueSession: async () => {
    const { stdout } = await t3(["auth", "session", "issue", "--ttl", "4h", "--label", "Setup console", "--subject", CONSOLE_SUBJECT, "--json"]);
    const start = stdout.indexOf("{");
    if (start < 0) throw new Error("t3 auth session issue printed no session");
    return JSON.parse(stdout.slice(start));
  },
  revokeSession: (sessionId) => t3(["auth", "session", "revoke", String(sessionId)]),
});
const antigravity = createAntigravity({ api: t3Api });
const T3_AGENT_IDS = new Set(["antigravity"]);
const isConsoleSession = (session) => session?.subject === CONSOLE_SUBJECT;

// A browser signed in to T3 Code with terminal access may use the console
// without the key: see t3-session.mjs for why that grants nothing new.
// T3_SETUP_ACCEPT_T3_SESSIONS=0 asks every browser for the key again.
const ACCEPT_T3_SESSIONS = !/^(0|false|no|off)$/i.test(String(process.env.T3_SETUP_ACCEPT_T3_SESSIONS ?? "").trim());
const t3Sessions = createT3Sessions({ baseUrl: `http://127.0.0.1:${T3_PORT}` });

// The page's own view model, run here once so that the count T3 Code's
// settings show beside Setup is the one the console's own badges add up to.
const Model = (() => {
  const { code } = ASSETS.console.find((script) => script.path === "client/model.js");
  const context = vm.createContext({ URL });
  vm.runInContext(`${code}\nthis.T3Model = T3Model;`, context, { filename: "client/model.js" });
  return context.T3Model;
})();

const health = async () => {
  try {
    const res = await fetch(
      `http://127.0.0.1:${T3_PORT}/.well-known/t3/environment`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = await res.json();
    return { ok: true, version: body.serverVersion, label: body.label, environmentId: body.environmentId ?? null };
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
  authMethod: authMethodOf(facts),
});

// How an agent is signed in, where that can be told without asking it: a key
// in the environment, or Codex's stored API key against its browser sign-in.
// Null means "the agent's usual way", which the page already knows how to say.
const authMethodOf = (facts) => {
  if ((facts.credentials?.env ?? []).length) return "env";
  if (facts.id !== "codex" || !facts.credentials?.present) return null;
  try {
    const home = process.env.CODEX_HOME || `${process.env.HOME}/.codex`;
    const auth = JSON.parse(readFileSync(`${home}/auth.json`, "utf8"));
    if (auth?.OPENAI_API_KEY) return "apikey";
    if (auth?.tokens) return "oauth";
  } catch { /* unreadable: say nothing */ }
  return null;
};

// --- recent events ----------------------------------------------------------
//
// The last few things worth knowing since this service started, newest first,
// for the Overview's Recent list. Everything here already passes through this
// process - a device appearing in the session list, a tunnel opening, an
// operation finishing - so nothing is polled for it. Memory only: a restart
// starts the list again, which the page says ("since the setup service started").
const EVENT_LIMIT = 20;
const events = [];
const recordEvent = (kind, text, detail = null) => {
  events.unshift({ at: Date.now(), kind, text, ...(detail ? { detail } : {}) });
  if (events.length > EVENT_LIMIT) events.length = EVENT_LIMIT;
};

// --- background facts --------------------------------------------------------
//
// Two things a row wants that are far too slow for a poll: the newest release
// of each tool (a registry round trip each) and how much the volume holds (a
// `du` over every toolchain). Both refresh in the background and are served
// from memory; a poll never waits on either.
const LATEST_CACHE = `${STATE_DIR}/setup/latest-versions.json`;
const latestCache = createLatestCache({
  keys: () => [
    ...[...HARNESS_IDS].map((id) => `harness:${id}`),
    ...[...TOOLCHAIN_IDS].map((id) => `toolchain:${id}`),
    // Source control CLIs only once installed: nobody waits on a release of
    // one they never asked for, and gitea.com and codeberg.org are not asked.
    ...[...knownSourceControl].map((id) => `toolchain:${id}`),
    // The tools added beyond those, as the last status read listed them.
    ...[...knownPackages].map((id) => `package:${id}`),
  ],
  lookup: async (key) => {
    // On the first colon only: a package id can carry its own (npm:prettier).
    const cut = key.indexOf(":");
    const target = key.slice(0, cut);
    const id = key.slice(cut + 1);
    const manager = await loadHarness();
    if (target === "harness") return manager.latestRelease(id);
    if (target === "package") return manager.packages.latestRelease(id);
    return manager.toolchains.latestRelease(id);
  },
  read: async () => {
    const { readFile } = await import("node:fs/promises");
    return readFile(LATEST_CACHE, "utf8");
  },
  write: async (text) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(LATEST_CACHE.replace(/\/[^/]+$/, ""), { recursive: true });
    await writeFile(LATEST_CACHE, text);
  },
});
/** mise's minimum release age in milliseconds, once read; null until then or when it is not a duration. */
let releaseAgeMs = null;

/** Each row with the newest release known for it (`latestVersion`, `latestCheckedAt`). */
const withLatest = (target, rows) => rows.map((row) => ({ ...row, ...latestCache.get(`${target}:${row.id}`) }));

// --- added tools ---------------------------------------------------------------
//
// Any mise tool beyond the agents and toolchains (docker/harness/packages.mjs).
// The registry ships inside mise, so it is read once, kept parsed and
// compressed, and lets each row say what a tool is and which commands it
// provides. Versions and details ask the network, so they are fetched on
// demand, cached briefly, and shared by concurrent requests.
const knownPackages = new Set();
let registryLoad = null;
const packageRegistry = () => {
  registryLoad ??= (async () => {
    const entries = await (await loadHarness()).packages.registry();
    const byName = new Map();
    for (const entry of entries) {
      byName.set(entry.name, entry);
      for (const alias of entry.aliases) if (!byName.has(alias)) byName.set(alias, entry);
    }
    // The browser needs no full backend specs, only their kinds.
    const tools = entries.map(({ name, description, kinds, bins, aliases }) => ({ name, description, kinds, bins, aliases }));
    const body = Buffer.from(JSON.stringify({ tools }));
    return { entries, byName, body, gzipped: await gzip(body) };
  })().catch((error) => {
    registryLoad = null;
    throw error;
  });
  return registryLoad;
};

/** A package row with what the registry says about it, when it is in there. */
const withRegistry = async (rows) => {
  if (!rows.length) return rows;
  const registry = await withTimeout(packageRegistry(), 1000);
  if (!registry.ok) return rows;
  return rows.map((row) => {
    const entry = registry.value.byName.get(row.id);
    return entry ? { ...row, description: entry.description, bins: entry.bins } : row;
  });
};

/** A small TTL cache whose concurrent misses share one lookup. */
const ttlCache = (ttlMs, limit = 200) => {
  const entries = new Map();
  return (key, load) => {
    const hit = entries.get(key);
    if (hit && (hit.pending || Date.now() - hit.at < ttlMs)) return hit.value;
    const value = load().then((result) => {
      entries.set(key, { at: Date.now(), value: Promise.resolve(result) });
      return result;
    }, (error) => {
      entries.delete(key);
      throw error;
    });
    entries.set(key, { at: Date.now(), pending: true, value });
    if (entries.size > limit) entries.delete(entries.keys().next().value);
    return value;
  };
};
// Short: which releases mise is still holding back changes as they age.
const versionsCache = ttlCache(10 * 60 * 1000);
const infoCache = ttlCache(6 * 60 * 60 * 1000);

const storage = createStorageFacts({ volume: VOLUME, workspace: WORKSPACE });

// The browser image's agent browser, as built: the versions are build args the
// Dockerfile bakes into the environment. Absent on the core image.
const BROWSER = (() => {
  const chromium = existsSync(process.env.CHROME_PATH || "/usr/bin/chromium");
  if (!chromium && process.env.T3_IMAGE_VARIANT !== "browser") return null;
  return {
    chromium,
    playwrightMcp: process.env.T3_PLAYWRIGHT_MCP_VERSION || null,
    devtoolsMcp: process.env.T3_CHROME_DEVTOOLS_MCP_VERSION || null,
  };
})();

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
// The source control CLIs' facts, the same way: who each is signed in as is
// a CLI run per host (glab asks its API), so it is refreshed in the background
// and a poll answers from what is known, or from a cheap read naming none.
const sourceControlCache = createHarnessCache({
  full: async () => {
    const { sourceControl, degraded } = await (await loadHarness()).sourceControl.status();
    return { harnesses: sourceControl, degraded };
  },
  cheap: async () => {
    const { sourceControl, degraded } = await (await loadHarness()).sourceControl.status({ authenticate: false });
    return { harnesses: sourceControl, degraded };
  },
  budgetMs: HARNESS_BUDGET_MS,
});
/** The mise-installed source control CLIs the last status read found installed. */
const knownSourceControl = new Set();

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
    case "cancelled": return 409;
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
let lastSetupState = null;
const noticeSetupProgress = (setup) => {
  const progress = setup ? JSON.stringify([setup.state, setup.items?.map((item) => item.state)]) : null;
  if (setup?.state === "finished" && lastSetupState === "running") {
    const done = (setup.items ?? []).filter((item) => item.state === "done");
    const agents = done.filter((item) => item.kind === "agent").length;
    const tools = done.length - agents;
    const what = [agents ? `${agents} agent${agents === 1 ? "" : "s"}` : null, tools ? `${tools} toolchain${tools === 1 ? "" : "s"}` : null]
      .filter(Boolean).join(" and ");
    recordEvent("setup.finished", what ? `First start finished: ${what}` : "First start finished");
  }
  lastSetupState = setup?.state ?? lastSetupState;
  if (progress === lastSetupProgress) return;
  const first = lastSetupProgress === null;
  lastSetupProgress = progress;
  if (!first) void harnessCache.invalidate().catch(() => {});
};

// A session the last read did not have is a device that just paired. The
// first read is the baseline, and a failed read changes nothing.
let knownSessions = null;
const noticeSessions = (sessions) => {
  if (!Array.isArray(sessions)) return;
  if (knownSessions) {
    for (const session of sessions) {
      if (!knownSessions.has(session.sessionId)) {
        recordEvent("device.paired", `Paired ${Model.deviceName(session)}`);
      }
    }
  }
  knownSessions = new Set(sessions.map((session) => session.sessionId));
};

const status = async () => {
  const where = publicUrl();
  // Concurrently, and each failure contained: an empty list and "could not
  // read" are different facts, and reporting the first when the second is true
  // is how a console tells you a comfortable lie. Whatever answers, answers.
  // Every leg is bounded so the whole stays inside the five-second offline
  // budget: health is localhost, the harness snapshot races its authenticated
  // refresh against a local fallback, and the `t3 auth` lists are local
  // SQLite reads with a backstop for a locked database.
  const degraded = [];
  // Taken before the facts below are read, never after: an operation that ends
  // while they are read then shows as still running beside the newer facts,
  // rather than finished beside the older ones (a toast saying "Installed"
  // over a row that still says Installing).
  const operationsSeen = Object.fromEntries([...operations].map(([key, { token: _token, controller: _controller, ...op }]) => [key, op]));
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
  // Antigravity, as T3 reports it, read beside the rest. Its own short cache:
  // a poll waits on T3 only for the very first read.
  const antigravityRead = attempt("Antigravity", () => antigravity.status(), null);
  const [server, harnessSnap, pairings, sessions, toolchainSnap, setup, scmSnap] = await Promise.all([
    attempt("server health", health, { ok: false, detail: "health check failed" }),
    attempt("agent probes", () => harnessLifecycleStatus(true), {
      harnesses: [], degraded: [],
      cache: { at: null, stale: true, source: "unavailable", refreshing: false },
    }),
    attemptTimed("pairing links", () => listJson(["auth", "pairing", "list", "--json"]), T3_LIST_BUDGET_MS, []),
    attemptTimed("paired devices", () => listJson(["auth", "session", "list", "--json"]), T3_LIST_BUDGET_MS, null),
    // One local `mise ls`: cheap enough to read on every poll.
    attemptTimed("toolchains", async () => (await loadHarness()).toolchains.status(), HARNESS_BUDGET_MS,
      { toolchains: [], degraded: [] }),
    attempt("first-start setup", async () => {
      const manager = await loadHarness();
      return harnessModule.readPreinstall({ stateDir: manager.paths.stateDir });
    }, null),
    attempt("source control", () => sourceControlCache.snapshot(), { harnesses: [], degraded: [] }),
  ]);
  const antigravityRow = await antigravityRead;
  const devices = Array.isArray(sessions) ? sessions.filter((session) => !isConsoleSession(session)) : sessions;
  noticeSetupProgress(setup);
  noticeSessions(devices);
  // Added tools, with what the registry says about each; their ids feed the
  // background check for newer releases.
  const packageRows = await withRegistry(toolchainSnap?.packages ?? []);
  knownPackages.clear();
  for (const row of packageRows) if (row.configured) knownPackages.add(row.id);
  // Shown when T3 has the provider, or when T3 is up but would not answer the
  // console (the row says so); while T3 itself is down the page already says.
  const t3Agents = antigravityRow && (antigravityRow.available || (!antigravityRow.reachable && server?.ok)) ? [antigravityRow] : [];
  const harnesses = harnessSnap?.harnesses ?? [];
  const sourceControl = scmSnap?.harnesses ?? [];
  knownSourceControl.clear();
  for (const row of sourceControl) if (row.installed && !row.inImage) knownSourceControl.add(row.id);
  const disk = storage.snapshot();
  for (const entry of harnessSnap?.degraded ?? []) {
    degraded.push({ what: `harness ${entry.what}`, error: String(entry.error ?? "").slice(0, 200) });
  }

  return {
    // uptimeSeconds is this service's: it starts with the container and is
    // only restarted by its own loop, which is rare and logged.
    server: { ...server, uptimeSeconds: Math.round(process.uptime()) },
    image: {
      version: process.env.T3_IMAGE_VERSION || null,
      variant: process.env.T3_IMAGE_VARIANT || null,
    },
    platform: `${process.platform}/${process.arch}`,
    publicUrl: where.url,
    // "env" (T3_PUBLIC_URL), "saved" (from this page) or "platform".
    publicUrlSource: where.source,
    // The platform's own address, also when something else overrides it, so
    // the page can offer to go back to it.
    publicUrlPlatform: platformUrl(process.env),
    t3: {
      port: Number(T3_PORT),
      bind: `${process.env.T3CODE_HOST || "0.0.0.0"}:${T3_PORT}`,
      // Under the image's supervisor (docker/run-t3.sh), this page can
      // restart it; the pid changing is how it sees the restart land.
      pid: t3Pid(),
    },
    connect: await connectFacts(),
    setupPort: PORT,
    // T3_SINGLE_PORT: both services behind one listener, this page under
    // `prefix` there. The page shows it beside the two ports it fronts.
    singlePort: SINGLE_PORT ? { port: SINGLE_PORT, prefix: SINGLE_PREFIX } : null,
    setupKeySource: KEY_SOURCE,
    // Settings an older image baked in that this container still carries, which
    // the user environment dropped for everything the entrypoint started
    // (docker/user-env.sh); only the container's configuration can remove them.
    legacyEnv: (process.env.T3_LEGACY_ENV ?? "").split(/\s+/).filter(Boolean),
    // Environment states where things live. Read them rather than printing a
    // plausible-looking default: a wrong path here is worse than no path.
    paths: {
      // What you mount is the home directory; the state dir lives inside it.
      volume: VOLUME,
      state: STATE_DIR,
      workspace: WORKSPACE,
      agents: `${STATE_DIR}/agents`,
      pairTtl: process.env.T3_PAIR_TTL || "30d",
      // From the background storage check; null until its first pass lands.
      volumeKind: disk.volumeKind,
      workspaceKind: disk.workspaceKind,
      volumeBytes: disk.volumeBytes,
      workspaceProjects: disk.workspaceProjects,
    },
    browser: BROWSER,
    harnesses: [...withLatest("harness", harnesses), ...t3Agents],
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
    toolchains: withLatest("toolchain", toolchainSnap?.toolchains ?? []),
    // The CLI T3 Code drives for each source control host: the image's gh,
    // and glab, fj, tea and az, installed and updated like a toolchain. `auth`
    // is null until a background check has asked the CLI.
    sourceControl: withLatest("toolchain", sourceControl),
    sourceControlCache: { at: scmSnap?.at ?? null, stale: scmSnap?.stale ?? true, source: scmSnap?.source ?? "unavailable" },
    // How long mise waits before offering a new release as the newest.
    releaseAgeMs,
    // Every other tool in the global mise config, added here or with `mise use -g`.
    packages: withLatest("package", packageRows),
    // The background install of everything T3_PREINSTALL names, on a first
    // start: what it planned, where it is, and what failed (retried on the
    // next start, or from the row's own Install button).
    setup,
    // How the operations this page started ended, so a click that returned
    // 202 can still end in a toast or an error on the row.
    operations: operationsSeen,
    pairings,
    sessions: devices ?? [],
    events,
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
  const { url } = publicUrl();
  if (!url) {
    throw new Error("Set the public URL first: a pairing link points at it, and without it a device has nowhere to go.");
  }
  const args = ["auth", "pairing", "create", "--base-url", url, "--json"];
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

/**
 * Save the address pairing links point at, or clear it (url null) to fall
 * back to the platform's. Refused while T3_PUBLIC_URL pins it, since the
 * container's configuration would win anyway, and refused when the address
 * answers as a different T3 Code server, which is always a mistake. An address
 * the container cannot reach itself is still saved: LAN and tailnet names
 * often cannot be, and the devices that use them are elsewhere.
 *
 * `check: false` skips asking the address: the page sends it for the address
 * it is open on, which the browser has just seen answer as this server.
 */
const setPublicUrl = async (value, { check: shouldCheck = true } = {}) => {
  if (String(process.env.T3_PUBLIC_URL ?? "").trim()) {
    return { http: 409, body: { ok: false, code: "pinned", error: "T3_PUBLIC_URL sets it in the container's configuration. Change it there, or remove it to set the address here." } };
  }
  if (value === null) {
    clearSaved(STATE_DIR);
    const where = publicUrl();
    recordEvent("url.cleared", where.url ? `Public URL back to ${where.platform}'s` : "Public URL cleared", where.url ? hostOf(where.url) : null);
    return { http: 200, body: { ok: true, publicUrl: where.url, publicUrlSource: where.source } };
  }
  const parsed = parsePublicUrl(value);
  if (parsed.error) return { http: 400, body: { ok: false, code: "invalid", error: parsed.error } };
  const check = shouldCheck ? await checkReaches(parsed.url, { localId: (await health()).environmentId }) : null;
  if (check?.reaches === "other") {
    return { http: 409, body: { ok: false, code: "other-server", check, error: `${hostOf(parsed.url)} answers as a different T3 Code server${check.label ? ` (${check.label})` : ""}. Pairing links there would pair with that one.` } };
  }
  writeSaved(STATE_DIR, parsed.url);
  recordEvent("url.set", "Public URL set", hostOf(parsed.url));
  return { http: 200, body: { ok: true, publicUrl: parsed.url, publicUrlSource: "saved", check } };
};

// --- restarting T3 Code ---------------------------------------------------
//
// T3 Code runs under docker/run-t3.sh, which starts it again when asked: a
// request file, then SIGTERM, so it shuts down exactly as for `docker stop`.
// Anything T3 Code only reads on a start (T3 Connect's link) then applies
// without anyone restarting the container.
const RUN_DIR = process.env.T3_RUN_DIR || "/tmp/t3code";

const t3Pid = () => {
  try {
    const pid = Number(readFileSync(`${RUN_DIR}/t3.pid`, "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
};

// When T3 Code last started: the supervisor writes its pid file on each start.
const t3StartedAt = () => {
  try {
    return statSync(`${RUN_DIR}/t3.pid`).mtimeMs;
  } catch {
    return 0;
  }
};

const restartT3 = (why = null) => {
  const pid = t3Pid();
  if (!pid) {
    return { http: 409, body: { ok: false, code: "unsupervised", error: "T3 Code is not running under the image's supervisor, so this page cannot restart it. Restart the container instead." } };
  }
  const request = `${RUN_DIR}/restart`;
  try {
    writeFileSync(request, `${new Date().toISOString()}\n`);
    process.kill(pid, "SIGTERM");
  } catch (error) {
    rmSync(request, { force: true });
    return { http: 500, body: { ok: false, error: `Could not restart T3 Code (${error.code ?? error.message}).` } };
  }
  forgetConnect();
  recordEvent("t3.restarted", "Restarted T3 Code", why);
  return { http: 202, body: { ok: true, pid } };
};

// --- T3 Connect -------------------------------------------------------------
//
// Through T3 Code's own CLI (connect.mjs says why). `status` starts a t3
// process, about a second of CPU, so the answer is kept: five minutes while
// nothing is happening, ten seconds while a link waits on T3 Code's start (so
// the page sees it come on). Anything this page does to Connect drops it.
const CONNECT_FRESH_MS = { idle: 5 * 60_000, pending: 10_000 };
let connectCache = { at: 0, value: null, refreshing: null };
// When this service saw a sign-in finish. A link saved after T3 Code's last
// start still needs one; one saved before it is being made, and another
// restart would only interrupt that. Unknown (0) after this service restarts.
let connectLinkedAt = 0;

const refreshConnect = () => {
  connectCache.refreshing ??= t3(["connect", "status", "--json"])
    .then(({ stdout }) => {
      connectCache = { at: Date.now(), value: connectState(jsonFrom(stdout)), refreshing: null };
    })
    .catch(() => {
      connectCache = { ...connectCache, at: Date.now(), refreshing: null };
    });
  return connectCache.refreshing;
};

const forgetConnect = () => {
  connectCache = { ...connectCache, at: 0 };
};

/**
 * The last answer, after a short wait for a fresh one when it is stale, with
 * `startedSinceLink`: whether T3 Code has started since the sign-in this
 * service saw finish (null when it saw none).
 */
const connectFacts = async () => {
  const fresh = connectCache.value?.state === "pending" ? CONNECT_FRESH_MS.pending : CONNECT_FRESH_MS.idle;
  if (Date.now() - connectCache.at > fresh) {
    await withTimeout(refreshConnect(), connectCache.value ? 300 : 3000);
  }
  if (!connectCache.value) return null;
  return { ...connectCache.value, startedSinceLink: connectLinkedAt ? t3StartedAt() > connectLinkedAt : null };
};

/**
 * `t3 connect link --headless`, as a sign-in session the page's sheet shows
 * like an agent's device sign-in: a link, a code, and a wait for approval.
 * The link it saves is made on T3 Code's next start; the page offers that
 * restart once this is done.
 */
// --- source control sign-in ----------------------------------------------------
//
// gh, glab, fj and tea sign in with a token for one host, which the manager
// hands to the CLI on stdin (sourceControl.signIn). az has no token sign-in T3
// Code would see - T3 asks `az account show` - so it runs the device flow:
// `az login --use-device-code` prints a page and a code, then waits for the
// approval and exits. That is a sign-in session like an agent's.
const AZ_CODE = /enter the code\s+([A-Z0-9]{6,12})\b/i;
const startAzSignin = async () => {
  const executable = await (await loadHarness()).sourceControl.executable("az");
  if (!executable) throw new Error("Azure CLI is not installed");
  const child = spawn(executable, ["login", "--use-device-code", "--allow-no-subscriptions", "--output", "none"], {
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const id = randomBytes(9).toString("hex");
  const session = {
    id, agentId: "az", state: "starting", url: null, code: null, needsCode: false,
    output: "", error: null, child, startedAt: Date.now(),
  };
  const absorb = (chunk) => {
    session.output = (session.output + stripAnsi(String(chunk))).slice(-8000);
    if (!session.url) {
      session.url = findUrl(session.output, session.output);
      if (session.url) {
        run("qrencode", ["-t", "SVG", "-m", "1", "-o", "-", session.url])
          .then(({ stdout }) => { session.qr = stdout; })
          .catch(() => {});
      }
    }
    session.code ??= AZ_CODE.exec(session.output)?.[1] ?? null;
    if (session.url && session.code && session.state === "starting") session.state = "awaiting-browser";
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);
  child.on("error", (error) => { session.state = "failed"; session.error = String(error.message); });
  child.on("close", (code) => {
    forgetSignInState("az");
    void sourceControlCache.invalidate().catch(() => {});
    if (TERMINAL_STATES.has(session.state)) return;
    session.state = code === 0 ? "done" : "failed";
    if (code === 0) recordEvent("signin.ok", "Signed in Azure CLI");
    else session.error = session.output.trim().split("\n").slice(-3).join(" ").slice(0, 300) || `exited with code ${code}`;
  });
  sessions.set(id, session);
  setTimeout(() => {
    if (!TERMINAL_STATES.has(session.state)) {
      try { child.kill(); } catch {}
      session.state = "failed";
      session.error = "Timed out waiting for the approval.";
    }
  }, SESSION_TTL_MS).unref?.();
  return session;
};

/** Sign a source control CLI in with a token, or out; either way the next poll sees it. */
const sourceControlSignIn = async (input, out = false) => {
  const manager = await loadHarness();
  const id = String(input?.id ?? "");
  const result = out
    ? await manager.sourceControl.signOut(id, { host: input?.host })
    : await manager.sourceControl.signIn(id, { host: input?.host, token: input?.token });
  forgetSignInState(id);
  try { await sourceControlCache.invalidate(); } catch { /* the next poll refreshes */ }
  const name = result.sourceControl?.name ?? SOURCE_CONTROL_NAMES[id] ?? id;
  if (result.ok) recordEvent(out ? "signin.out" : "signin.ok", `${out ? "Signed out" : "Signed in"} ${name}`, result.host ?? input?.host ?? null);
  const http = result.ok ? 200 : ["invalid-host", "invalid-token", "unsupported"].includes(result.code) ? 400
    : result.code === "unknown-toolchain" ? 404 : result.code === "not-installed" ? 409 : 422;
  return { http, body: result };
};

const startConnectLink = () => {
  const child = spawn(T3_LAUNCHER, ["connect", "link", "--headless"], {
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const id = randomBytes(9).toString("hex");
  const session = {
    id, agentId: "connect", state: "starting", url: null, code: null, needsCode: false,
    output: "", error: null, child, startedAt: Date.now(), identity: null,
  };
  const absorb = (chunk) => {
    session.output = (session.output + stripAnsi(String(chunk))).slice(-8000);
    const seen = parseLinkOutput(session.output);
    if (!session.url && seen.url) {
      session.url = seen.url;
      run("qrencode", ["-t", "SVG", "-m", "1", "-o", "-", session.url])
        .then(({ stdout }) => { session.qr = stdout; })
        .catch(() => {});
    }
    session.code ??= seen.code;
    if (seen.expiresInMs && !session.expiresAt) session.expiresAt = Date.now() + seen.expiresInMs;
    session.identity ??= seen.identity;
    if (session.url && session.state === "starting") session.state = "awaiting-browser";
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);
  child.on("error", (error) => { session.state = "failed"; session.error = String(error.message); });
  child.on("close", (code) => {
    forgetConnect();
    if (TERMINAL_STATES.has(session.state)) return;
    if (code === 0 && parseLinkOutput(session.output).authorized) {
      session.state = "done";
      connectLinkedAt = Date.now();
      recordEvent("connect.linked", "Signed in to T3 Connect", session.identity);
      return;
    }
    session.state = "failed";
    session.error = session.output.trim().split("\n").slice(-3).join(" ").slice(0, 300) || `exited with code ${code}`;
  });
  sessions.set(id, session);
  setTimeout(() => {
    if (!TERMINAL_STATES.has(session.state)) {
      try { child.kill(); } catch {}
      session.state = "failed";
      session.error = "Timed out waiting for the approval.";
    }
  }, SESSION_TTL_MS).unref?.();
  return session;
};

/** Off again: the environment leaves the relay, and the sign-in is kept. */
const unlinkConnect = async () => {
  try {
    await t3(["connect", "unlink"]);
  } catch (error) {
    const said = String(error?.stdout ?? "").trim() || String(error?.stderr ?? "").trim() || String(error?.message ?? error);
    return { http: 500, body: { ok: false, error: said.split("\n").slice(-2).join(" ").slice(0, 300) } };
  } finally {
    forgetConnect();
  }
  recordEvent("connect.unlinked", "Turned T3 Connect off");
  return { http: 200, body: { ok: true, connect: await connectFacts() } };
};

/**
 * Replace the setup key with a new one, kept on the volume. Every browser
 * signed in with the old key, and anything holding it, is shut out; the CLIs
 * read the new one from the file. Not while T3_SETUP_KEY sets it: the
 * container's configuration would put the old one back on the next start.
 */
const replaceKey = () => {
  if (KEY_SOURCE === "env") {
    return { http: 409, body: { ok: false, code: "pinned", error: "T3_SETUP_KEY sets the key in the container's configuration. Change it there." } };
  }
  const key = newKey();
  try {
    writeKeyFile(STATE_DIR, key);
  } catch (error) {
    return { http: 500, body: { ok: false, error: `The volume could not keep a new key (${error.code ?? error.message}).` } };
  }
  KEY = key;
  KEY_SOURCE = "volume";
  failures.clear();
  recordEvent("key.replaced", "Setup key replaced");
  return { http: 200, body: { ok: true, key, source: KEY_SOURCE } };
};

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
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
  // Signed in through T3's own Google flow (startAntigravitySignin).
  antigravity: { name: "Antigravity" },
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
    if (session.state === "done") recordEvent("signin.ok", `Signed in ${agent.name}`);
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
      recordEvent("signin.ok", `Signed in ${agent.name}`);
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

/**
 * Antigravity's sign-in is T3's own Google flow, shown in the same sheet as the
 * CLIs': T3 hands out a Google link, the browser lands on a 127.0.0.1 address
 * it cannot load, and the address pasted back (`/auth/code`) goes to T3,
 * which checks it. The session object reads like a CLI's to the page.
 */
const startAntigravitySignin = async () => {
  const id = randomBytes(9).toString("hex");
  const session = {
    id, agentId: "antigravity", state: "starting", url: null, code: null,
    needsCode: true, output: "", error: null, child: null, t3: true,
    flow: null, flowId: null, expiresAt: null, startedAt: Date.now(),
  };
  sessions.set(id, session);
  const end = (state, error = null) => {
    if (TERMINAL_STATES.has(session.state)) return;
    session.state = state;
    session.error = error;
    session.flow?.close();
  };
  try {
    session.flow = await antigravity.signIn((state) => {
      if (TERMINAL_STATES.has(session.state)) return;
      const expires = Date.parse(state.expiresAt ?? "");
      if (Number.isFinite(expires)) session.expiresAt = expires;
      if (state.phase === "waiting" && state.authorizationUrl) {
        session.url = state.authorizationUrl;
        if (session.state === "starting") session.state = "awaiting-code";
      } else if (state.phase === "verifying") {
        session.state = "submitted";
      } else if (state.phase === "succeeded") {
        end("done");
        recordEvent("signin.ok", "Signed in Antigravity");
        void antigravity.recheck().catch(() => {});
      } else if (state.phase === "failed") {
        end("failed", state.message ?? "Google sign-in did not finish.");
      } else if (state.phase === "cancelled") {
        end("cancelled", state.message ?? null);
      }
    });
    session.flowId = session.flow.flowId;
  } catch (error) {
    end("failed", String(error?.message ?? error).slice(0, 300));
  }
  // T3 gives a flow a few minutes; this only catches a flow nobody ended.
  setTimeout(() => {
    if (TERMINAL_STATES.has(session.state)) return;
    if (session.flowId) void antigravity.cancelSignIn(session.flowId).catch(() => {});
    end("failed", "Timed out waiting for the browser step.");
  }, SESSION_TTL_MS).unref?.();
  return session;
};

const publicSession = (s) => ({
  id: s.id, agent: s.agentId, state: s.state, url: s.url, code: s.code, qr: s.qr ?? null,
  needsCode: s.needsCode, error: s.error, identity: s.identity ?? null,
  // When the wait for the browser step gives up, for the device code's countdown.
  startedAt: s.startedAt, expiresAt: s.expiresAt ?? s.startedAt + SESSION_TTL_MS,
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
    recordEvent("signin.ok", `Saved an API key for ${agent.name}`);
    return { ok: true };
  }

  // OpenCode reads credentials from a file, which is far steadier than driving
  // its picker; verified by writing one and having `opencode auth list` see it.
  if (agent.apiKey.kind === "opencode") {
    // Dots are in the catalog too (wafer.ai), and this only ever becomes a key
    // in a JSON object, never a path segment.
    if (!OPENCODE_PROVIDER.test(String(providerId ?? "")))
      throw new Error("Choose a provider (e.g. anthropic, openai, deepseek)");
    const dir = `${process.env.HOME}/.local/share/opencode`;
    await mkdir(dir, { recursive: true });
    let current = {};
    try { current = JSON.parse(await readFile(`${dir}/auth.json`, "utf8")); } catch {}
    current[providerId] = { type: "api", key };
    await writeOpenCodeAuth(dir, current);
    await refreshSignInState(agentId);
    recordEvent("signin.ok", `Added a ${providerId} key to OpenCode`);
    return { ok: true };
  }
  throw new Error("unsupported");
};

const OPENCODE_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,39}$/;

// Written whole to a temporary file and renamed over the old one, so a reader
// - OpenCode itself, mid-request - never sees half a file.
const writeOpenCodeAuth = async (dir, value) => {
  const file = `${dir}/auth.json`;
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  const { rename } = await import("node:fs/promises");
  await rename(tmp, file);
};

/** Delete one provider's entry from OpenCode's auth.json; the rest stay. */
const removeApiKey = async (agentId, providerId) => {
  if (agentId !== "opencode") throw new Error(`${agentId} keeps no per-provider keys here`);
  if (!OPENCODE_PROVIDER.test(String(providerId ?? ""))) throw new Error("Choose a provider to remove");
  const dir = `${process.env.HOME}/.local/share/opencode`;
  let current = {};
  try { current = JSON.parse(await readFile(`${dir}/auth.json`, "utf8")); } catch { return { ok: true, removed: false }; }
  if (!current || typeof current !== "object" || !(providerId in current)) return { ok: true, removed: false };
  delete current[providerId];
  await writeOpenCodeAuth(dir, current);
  await refreshSignInState(agentId);
  return { ok: true, removed: true };
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
const EXPOSED_FILE = `${STATE_DIR}/exposed-ports.json`;

// Ports that belong to the container's own plumbing rather than to anything a
// user started. Exposing the setup page itself would be a foot-gun.
const RESERVED = new Set([PORT, Number(process.env.T3CODE_PORT ?? 3773), SINGLE_PORT].filter(Boolean));

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

/**
 * What is in LISTEN state, whatever interface it bound to: one entry per port
 * with the owning process and bind address (ports.mjs does the parsing).
 */
const listeners = async () => {
  // A dev server bound to 127.0.0.1 is the normal case and the one that most
  // needs a tunnel, so loopback-only listeners are included deliberately.
  // -p names the owning process, which is how cloudflared's own metrics
  // listener gets filtered out: publishing a port opened a second "port" in
  // this list, which is confusing and not something anyone would want to expose.
  const { stdout } = await run("ss", ["-H", "-l", "-t", "-n", "-p"]).catch(() => ({ stdout: "" }));
  return parseListeners(stdout, { reserved: RESERVED, ephemeral: EPHEMERAL }).map(({ pid, ...entry }) => {
    // The command line names a dev server far better than ss does.
    let argv = null;
    try { if (pid) argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { /* gone, or not ours */ }
    const process = processLabel(argv, entry.process);
    return { ...entry, process, looksLikeDatabase: entry.looksLikeDatabase || looksLikeDatabase(entry.port, process) };
  });
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
      recordEvent("port.published", `Published port ${port} to`, tunnel.url.replace(/^https:\/\//, ""));
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
  if (tunnel.state === "open") recordEvent("port.stopped", `Stopped publishing port ${port}`);
  return { ok: true, port };
};

const portsStatus = async () => {
  const found = await listeners();
  return {
    // `available` means cloudflared can run at all; the page says so plainly
    // rather than letting every Expose click fail with the same opaque error.
    available: existsSync(CLOUDFLARED) || CLOUDFLARED === "cloudflared",
    // Plain numbers: this is what t3-expose reads.
    listening: found.map((entry) => entry.port),
    // The same ports with what the page shows beside them.
    details: found,
    tunnels: [...tunnels.values()].map(publicTunnel),
  };
};

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
const operations = new Map(); // "harness:claude" -> { kind, state, error, progress, ... }
const TOOLCHAIN_IDS = new Set(["go", "rust", "bun", "deno", "uv"]);
const LIFECYCLE_PATHS = { harnesses: "harness", toolchains: "toolchain", packages: "package" };
// The source control CLIs mise installs run as toolchains (the image's gh is
// not one): the same routes, queue and lock.
const SOURCE_CONTROL_NAMES = { glab: "GitLab CLI", fj: "Forgejo CLI", tea: "Gitea CLI", az: "Azure CLI" };
const TOOLCHAIN_NAMES = { go: "Go", rust: "Rust", bun: "Bun", deno: "Deno", uv: "uv", ...SOURCE_CONTROL_NAMES };
const MANAGED_TOOL_IDS = new Set([...TOOLCHAIN_IDS, ...Object.keys(SOURCE_CONTROL_NAMES)]);
const isSourceControlJob = (job) => job.target === "toolchain" && Object.hasOwn(SOURCE_CONTROL_NAMES, job.id);
const lifecycleName = (target, id) =>
  (target === "harness" ? AGENTS[id]?.name : target === "toolchain" ? TOOLCHAIN_NAMES[id] : harnessModule?.displayName?.(id)) ?? id;

// The manager runs one operation at a time under its lock. Rather than turn a
// second click into "busy", the page's operations queue here and run in order:
// "Update all" is a row of clicks, and Install pressed while the first start is
// still installing simply waits its turn. A lock held by someone else - the
// first-start install, `t3-harness` in a terminal - is waited out the same
// way, from the front of the queue, for as long as is reasonable.
const queue = [];      // jobs not started yet, in order
let active = null;     // the job taking, or holding, the lock
const BUSY_RETRY_MS = 5000;
const BUSY_GIVE_UP_MS = 30 * 60 * 1000;
const PAST = { install: "installed", update: "updated", uninstall: "uninstalled" };
const DONE_TEXT = { install: "Installed", update: "Updated", uninstall: "Uninstalled" };

/** Only the job that owns a row reports into it; a newer request owns it next. */
const setOperation = (job, patch) => {
  const current = operations.get(job.key);
  if (current && current.token !== job.token && (current.state === "running" || current.state === "queued")) return;
  operations.set(job.key, {
    ...(current?.token === job.token ? current : {}),
    ...patch,
    kind: job.kind,
    token: job.token,
    controller: job.controller,
  });
  job.reported = true;
};

const enqueue = (job, { front = false } = {}) => {
  if (front) queue.unshift(job);
  else queue.push(job);
  setOperation(job, { state: "queued", error: null, warning: null, progress: null, queuedAt: job.queuedAt, startedAt: null, finishedAt: null });
};

/** Start the next queued job once nothing on this side holds the lock. */
const drain = () => {
  if (active || !queue.length) return;
  void runJob(queue.shift());
};

/** How a job ended: the row's state, a sentence for Recent, and nothing for a refusal nobody queued. */
const finishJob = (job, { result, sync }) => {
  const cancelled = result?.code === "cancelled";
  if (!job.reported) return;
  setOperation(job, {
    state: result?.ok ? "ok" : cancelled ? "cancelled" : "failed",
    error: result?.ok || cancelled ? null : String(result?.error ?? "failed").slice(0, 300),
    warning: result?.ok ? syncWarning(job.id, sync) : null,
    progress: null,
    finishedAt: Date.now(),
  });
  const name = lifecycleName(job.target, job.id);
  // An added tool is not in the scheduled check until the next status read
  // lists it; look its newest release up now.
  if (job.target === "package" && result?.ok && job.kind !== "uninstall") {
    void latestCache.refreshOne(`package:${job.id}`);
  }
  if (result?.ok) {
    const facts = result.harness ?? result.toolchain ?? result.package ?? null;
    const version = job.kind === "uninstall" ? null : facts?.installedVersion ?? facts?.version ?? null;
    recordEvent(`${job.target}.${PAST[job.kind]}`, `${DONE_TEXT[job.kind]} ${name}${version && job.kind === "update" ? " to" : ""}`, version);
  } else if (!cancelled) {
    recordEvent(`${job.target}.failed`, `Could not ${job.kind} ${name}`);
  }
};

/**
 * Run one job. Resolves with null as soon as it holds the lock (the work goes
 * on in the background), with `{ queued: true }` when someone else's lock sent
 * it back to wait, or with the finished `{ result, sync }` when it ended (or was
 * refused) before ever starting.
 */
const runJob = async (job) => {
  active = job;
  let manager;
  try {
    manager = await loadHarness();
  } catch (error) {
    const outcome = { result: { ok: false, code: "failed", error: String(error?.message ?? error) }, sync: null };
    finishJob(job, outcome);
    active = null;
    drain();
    return outcome;
  }
  const ops = job.target === "harness" ? manager : job.target === "package" ? manager.packages : manager.toolchains;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const options = {
    ...(job.version ? { version: job.version } : {}),
    signal: job.controller.signal,
    onStarted: () => {
      setOperation(job, { state: "running", error: null, warning: null, progress: null, startedAt: Date.now(), finishedAt: null });
      markStarted(null);
      // Let the next poll see the lock instead of the facts from before it.
      void harnessCache.invalidate().catch(() => {});
      if (isSourceControlJob(job)) void sourceControlCache.invalidate().catch(() => {});
    },
    onProgress: (progress) => {
      const op = operations.get(job.key);
      if (op?.token === job.token && op.state === "running") op.progress = progress;
    },
  };

  const work = ops[job.kind](job.id, options).then(async (result) => {
    let sync = null;
    if (result?.ok && job.target === "harness") {
      try {
        sync = await syncManagedProviders();
      } catch (error) {
        sync = { ok: false, error: String(error?.message ?? error).slice(0, 200) };
      }
    }
    // Refresh the card's facts before reporting the result, so the poll that
    // sees "ok" also sees the agent installed.
    forgetSignInState(job.id);
    try { await harnessCache.invalidate(); } catch { /* the next poll refreshes */ }
    if (isSourceControlJob(job)) {
      try { await sourceControlCache.invalidate(); } catch { /* the next poll refreshes */ }
    }
    return { result, sync };
  }, (error) => ({ result: { ok: false, code: "failed", error: String(error?.message ?? error) }, sync: null }));

  const done = work.then((outcome) => {
    const aborted = job.controller.signal.aborted;
    if (outcome.result?.code === "busy" && !aborted && Date.now() - job.queuedAt < BUSY_GIVE_UP_MS) {
      active = null;
      enqueue(job, { front: true });
      setTimeout(drain, BUSY_RETRY_MS).unref?.();
      return { queued: true };
    }
    const settled = aborted && !outcome.result?.ok
      ? { result: { ok: false, code: "cancelled", error: "cancelled" }, sync: null }
      : outcome;
    finishJob(job, settled);
    active = null;
    drain();
    return settled;
  });

  // Whichever comes first: the lock (answer now, finish in the background), or
  // the whole operation (refused before it started - a bad version - or simply
  // quick, like an uninstall).
  return Promise.race([started, done]);
};

/**
 * Install (or update to the release T3 pins) or remove Antigravity's runtime
 * through T3's installer, reporting into the row like any other job.
 */
const t3Jobs = new Map(); // key -> job, while it runs
const runT3Job = (job) => {
  t3Jobs.set(job.key, job);
  setOperation(job, { state: "running", error: null, warning: null, progress: null, startedAt: Date.now(), finishedAt: null });
  const onProgress = (progress) => {
    const op = operations.get(job.key);
    if (op?.token === job.token && op.state === "running") op.progress = progress;
  };
  const work = job.kind === "uninstall"
    ? antigravity.uninstall()
    : antigravity.install({ signal: job.controller.signal, onProgress });
  void work
    .catch((error) => ({ ok: false, code: "failed", error: String(error?.message ?? error) }))
    .then((result) => {
      t3Jobs.delete(job.key);
      const cancelled = job.controller.signal.aborted && !result?.ok;
      finishJob(job, {
        result: cancelled ? { ok: false, code: "cancelled", error: "cancelled" }
          : { ...result, ...(result?.version ? { harness: { installedVersion: result.version } } : {}) },
        sync: null,
      });
    });
};

/**
 * The id an operation is keyed and run under, or the answer refusing it. A
 * package's name comes from whoever typed it, so it is validated, refused when
 * an agent or toolchain owns it, and normalized (rg -> ripgrep) before it is
 * queued: two spellings of one tool must not queue as two jobs.
 */
const lifecycleId = async (target, rawId) => {
  const id = String(rawId ?? "").trim();
  if (target === "package") {
    const normalized = await (await loadHarness()).packages.normalize(id);
    if (!normalized.ok) return { refused: { http: 400, body: normalized } };
    return { id: normalized.id };
  }
  if (target === "harness" && T3_AGENT_IDS.has(id)) return { id };
  const ids = target === "harness" ? HARNESS_IDS : MANAGED_TOOL_IDS;
  if (!ids.has(id)) {
    const code = target === "harness" ? "unknown-harness" : "unknown-toolchain";
    return { refused: { http: 404, body: { ok: false, code, error: `unknown ${target}: ${id}` } } };
  }
  return { id };
};

const startLifecycle = async (target, kind, input) => {
  const resolved = await lifecycleId(target, input?.id ?? input?.agent ?? "");
  if (resolved.refused) return resolved.refused;
  const { id } = resolved;
  // A version applies to installing an agent or an added tool; toolchains
  // always take mise's newest.
  const rawVersion = target === "harness" || (target === "package" && kind === "install") ? input?.version : undefined;
  const version = rawVersion === undefined || rawVersion === null || String(rawVersion).trim() === ""
    ? undefined
    : String(rawVersion).trim();

  const key = `${target}:${id}`;
  const existing = operations.get(key);
  if (existing && (existing.state === "running" || existing.state === "queued")) {
    return {
      http: 409,
      body: { ok: false, code: "busy", error: `${lifecycleName(target, id)} already has an operation ${existing.state === "queued" ? "waiting" : "running"}` },
    };
  }
  const job = { key, target, kind, id, version, token: randomBytes(6).toString("hex"), controller: new AbortController(), queuedAt: Date.now(), reported: false };
  // T3 installs Antigravity's runtime itself: no mise, no lock, nothing to
  // wait behind. Its job runs at once, beside the queue.
  if (target === "harness" && T3_AGENT_IDS.has(id)) {
    runT3Job(job);
    return { http: 202, body: { ok: true, code: "started", id, kind, target } };
  }
  if (active || queue.length) {
    enqueue(job);
    return { http: 202, body: { ok: true, code: "queued", id, kind, target } };
  }

  const first = await runJob(job);
  if (first === null) return { http: 202, body: { ok: true, code: "started", id, kind, target } };
  if (first.queued) return { http: 202, body: { ok: true, code: "queued", id, kind, target } };
  const { result, sync } = first;
  const body = {
    ok: Boolean(result?.ok),
    code: result?.code ?? "failed",
    ...(result?.error ? { error: result.error } : {}),
    ...(result?.harness ? { harness: toPublicHarness(result.harness) } : {}),
    ...(result?.toolchain ? { toolchain: result.toolchain } : {}),
    ...(result?.package ? { package: result.package } : {}),
    ...(sync ? { sync } : {}),
  };
  return { http: lifecycleHttpStatus(result?.code ?? "failed"), body };
};

/** Take a job out of the queue, or stop the one running (its mise run included). */
const cancelLifecycle = (target, rawId) => {
  const key = `${target}:${String(rawId ?? "").trim()}`;
  const t3Job = t3Jobs.get(key);
  if (t3Job) {
    t3Job.controller.abort();
    return { http: 202, body: { ok: true, code: "cancelling" } };
  }
  const index = queue.findIndex((job) => job.key === key);
  if (index !== -1) {
    const [job] = queue.splice(index, 1);
    job.controller.abort();
    setOperation(job, { state: "cancelled", error: null, progress: null, finishedAt: Date.now() });
    return { http: 200, body: { ok: true, code: "cancelled" } };
  }
  if (active?.key === key) {
    active.controller.abort();
    return { http: 202, body: { ok: true, code: "cancelling" } };
  }
  return { http: 404, body: { ok: false, code: "not-running", error: "Nothing is running or waiting for that row." } };
};

const ROUTES = ["/login", "/logout", "/hello", "/status", "/pair", "/revoke", "/ports",
  "/public-url/clear", "/public-url", "/setup-key/reveal", "/setup-key/replace", "/connect/unlink", "/t3/restart",
  "/ports/expose", "/ports/unexpose",
  "/harnesses/install", "/harnesses/update", "/harnesses/uninstall", "/harnesses/cancel", "/harnesses/versions", "/harnesses/enable", "/harnesses",
  "/toolchains/install", "/toolchains/update", "/toolchains/uninstall", "/toolchains/cancel",
  "/auth/apikey/remove", "/auth/apikey", "/auth/signin", "/auth/session", "/auth/code", "/auth/cancel",
  "/source-control/signin", "/source-control/signout",
  "/providers", "/updates/check",
  "/packages/install", "/packages/update", "/packages/uninstall", "/packages/cancel",
  "/packages/registry", "/packages/versions", "/packages/info"];

// The session cookie. Secure when the request reached us over HTTPS (directly
// or through a proxy that says so); a plain-http LAN address must still work.
const cookie = (req, mount, value, maxAge) => {
  const secure = req.socket.encrypted || /^https$/i.test(String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim());
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=${mount || "/"}; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
};

/**
 * The one HTML document, under a Content-Security-Policy that lets only this
 * response's scripts run. Compressed when the browser accepts it: the page
 * inlines its whole design system, and it is often fetched over a tunnel.
 */
const sendPage = async (req, res, render) => {
  const nonce = randomBytes(16).toString("base64");
  const html = render(nonce);
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": contentSecurityPolicy(nonce),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    // T3 Code's settings open the console in a frame on the same origin;
    // nothing else may (frame-ancestors says the same to newer browsers).
    "x-frame-options": "SAMEORIGIN",
    vary: "accept-encoding, cookie",
  };
  if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    return send(res, 200, await gzip(html), { ...headers, "content-encoding": "gzip" });
  }
  return send(res, 200, html, headers);
};

const wantsJson = (req) => /application\/json/.test(String(req.headers.accept ?? ""));

// Where the browser says a request came from. A page on another site, or on a
// sibling subdomain (which cookies count as the same site), can make the
// browser send a request here with its cookies; nothing that changes state is
// accepted unless it came from this origin. The in-container CLIs send no such
// header, and authenticate with the key header rather than a cookie.
const fetchSite = (req) => String(req.headers["sec-fetch-site"] ?? "");
const fromElsewhere = (req) => !["", "same-origin", "none"].includes(fetchSite(req));
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Who is asking: `{ via: "key" }` for the setup key (cookie or header),
 * `{ via: "t3" }` for a T3 Code session T3 vouches for, otherwise null. A T3
 * session only counts for a state change when the browser says the request
 * came from this origin, because its cookie is not SameSite=Strict.
 */
const viewerOf = async (req) => {
  if (keyMatches(cookieFrom(req)) || keyMatches(req.headers["x-t3-setup-key"])) return { via: "key" };
  if (!ACCEPT_T3_SESSIONS) return null;
  if (!SAFE_METHODS.has(req.method) && fetchSite(req) !== "same-origin") return null;
  return (await t3Sessions.verify(req.headers.cookie)) ? { via: "t3" } : null;
};

// What needs the person, counted as the console's own badges count it, for
// the T3 Code settings entry. Ports are left out: listing them is the costly
// part of a poll, and a failed publish is rare. Kept briefly, since T3 asks
// each time its settings open.
let attentionCache = { at: 0, count: null };
const attentionCount = async () => {
  if (attentionCache.count !== null && Date.now() - attentionCache.at < 10_000) return attentionCache.count;
  const count = Model.attentionCount(await status(), null, null);
  attentionCache = { at: Date.now(), count };
  return count;
};

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
  // The visitor, not the router in front of them: see client-address.mjs.
  const ip = clientAddress(req);
  const raw = new URL(req.url ?? "/", "http://localhost");
  const resolved = resolve(raw.pathname);
  const route = resolved.route;
  // The inferred mount wins when the prefix survived the hop; otherwise fall
  // back to what the proxy declared.
  const mount = resolved.mount || forwardedPrefix(req);
  // The page sends a cookie; the in-container CLIs send a header. Same key,
  // same comparison - so `t3-expose` and the page are the same client as far
  // as this server is concerned, and neither can act on state the other cannot.
  // A browser signed in to T3 Code may come in on that session instead.
  const viewer = await viewerOf(req).catch(() => null);
  const authed = Boolean(viewer);
  // Opened inside T3 Code's settings rather than on its own.
  const embed = raw.searchParams.get("embed") === "t3";

  try {
    // Don't answer asset probes with the page.
    if (route === "/" && /\.[a-z0-9]{1,5}$/i.test(raw.pathname)) {
      return sendJson(res, 404, { error: "not found" });
    }

    if (req.method === "POST" && fromElsewhere(req)) {
      return sendJson(res, 403, { error: "This request came from another site." });
    }

    // T3 Code's client asks this to learn whether the console is routed on
    // its origin, and whether this browser can open it without the key. A
    // stranger learns only that the console exists, which its own page says.
    if (req.method === "GET" && route === "/hello") {
      const body = { service: "t3-setup", signedIn: authed };
      if (authed) body.attention = await attentionCount().catch(() => null);
      return sendJson(res, 200, body);
    }

    // The unlock form posts here. Without JavaScript it is a plain form post
    // answered with a redirect (carrying ?error=1 when the key was wrong); the
    // page's own script asks for JSON instead, so it can say so in place.
    if (req.method === "POST" && route === "/login") {
      const body = new URLSearchParams(await readBody(req));
      if (!keyMatches(body.get("key"))) {
        await throttle(ip);
        if (wantsJson(req)) return sendJson(res, 401, { ok: false, error: "That key was not accepted." });
        return send(res, 303, "", { location: `${mount}/?${body.get("embed") === "t3" ? "embed=t3&" : ""}error=1` });
      }
      failures.delete(ip);
      const setCookie = cookie(req, mount, encodeURIComponent(KEY), 86400);
      if (wantsJson(req)) return sendJson(res, 200, { ok: true }, { "set-cookie": setCookie });
      return send(res, 303, "", { location: `${mount}/${body.get("embed") === "t3" ? "?embed=t3" : ""}`, "set-cookie": setCookie });
    }

    // Lock console: forget this browser. Needs no key - signing out is never
    // something to refuse - and the cookie is SameSite=Strict, so another site
    // cannot do it for you either.
    if (req.method === "POST" && route === "/logout") {
      return send(res, 303, "", { location: `${mount}/`, "set-cookie": cookie(req, mount, "", 0) });
    }

    if (route === "/") {
      if (authed) return sendPage(req, res, (nonce) => renderConsole({ assets: ASSETS, nonce, mount, embed }));
      // The host the browser asked for, for the card's eyebrow; escaped by the template.
      const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0].trim().slice(0, 200);
      return sendPage(req, res, (nonce) => renderUnlock({
        assets: ASSETS, nonce, mount, host, publicUrl: publicUrl().url, error: raw.searchParams.get("error") === "1", embed,
      }));
    }

    if (!authed) {
      await throttle(ip);
      return sendJson(res, 401, { error: "unauthorized" });
    }

    // `viewer` says how this browser got in, so the page offers Lock only
    // where locking would end something.
    if (route === "/status") return sendJson(res, 200, { ...(await status()), viewer: { via: viewer.via } });

    if (req.method === "GET" && route === "/harnesses") {
      try {
        const url = new URL(req.url ?? "/", "http://x");
        const only = (url.searchParams.get("id") ?? "").trim();
        const authenticate = url.searchParams.get("authenticate") !== "false"
          && url.searchParams.get("authenticate") !== "0";
        const snap = await harnessLifecycleStatus(authenticate);
        const cache = snap.cache;
        const harnesses = withLatest("harness", snap.harnesses);
        if (only) {
          const found = harnesses.find((h) => h.id === only);
          if (!found) return sendJson(res, 404, { ok: false, code: "unknown-harness", error: `unknown harness: ${only}` });
          return sendJson(res, 200, { harness: found, degraded: snap.degraded, harnessCache: cache });
        }
        return sendJson(res, 200, { harnesses, degraded: snap.degraded, harnessCache: cache });
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message ?? error) });
      }
    }
    const lifecycle = /^\/(harnesses|toolchains|packages)\/(install|update|uninstall|cancel)$/.exec(route);
    if (req.method === "POST" && lifecycle) {
      try {
        const target = LIFECYCLE_PATHS[lifecycle[1]];
        const input = JSON.parse((await readBody(req)) || "{}");
        const { http, body } = lifecycle[2] === "cancel"
          ? cancelLifecycle(target, input?.id)
          : await startLifecycle(target, lifecycle[2], input);
        return sendJson(res, http, body);
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }

    // mise's registry, for the Add a tool search: local to the mise binary,
    // read once, served compressed (it runs to a thousand tools).
    if (req.method === "GET" && route === "/packages/registry") {
      try {
        const registry = await packageRegistry();
        const gz = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
        return send(res, 200, gz ? registry.gzipped : registry.body, {
          "content-type": "application/json",
          vary: "accept-encoding",
          ...(gz ? { "content-encoding": "gzip" } : {}),
        });
      } catch (error) {
        return sendJson(res, 503, { ok: false, error: `mise could not list its registry: ${String(error?.message ?? error)}` });
      }
    }
    // Turn a T3-installed agent back on in T3 Code (Antigravity, after someone
    // switched it off there).
    if (req.method === "POST" && route === "/harnesses/enable") {
      const input = JSON.parse((await readBody(req)) || "{}");
      if (!T3_AGENT_IDS.has(String(input.id ?? ""))) return sendJson(res, 404, { ok: false, code: "unknown-harness", error: `unknown harness: ${input.id}` });
      try {
        await antigravity.enable();
        recordEvent("harness.enabled", "Turned Antigravity on in T3 Code");
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        return sendJson(res, 502, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
      }
    }

    // An agent's releases, newest first, for "Install a specific version": each
    // with when it was published and whether mise is still holding it back.
    if (req.method === "GET" && route === "/harnesses/versions") {
      const id = String(raw.searchParams.get("id") ?? "");
      if (!HARNESS_IDS.has(id)) return sendJson(res, 404, { ok: false, code: "unknown-harness", error: `unknown harness: ${id}` });
      const manager = await loadHarness();
      const answer = await withTimeout(versionsCache(`harness:${id}`, () => manager.versions(id)), 20_000);
      if (!answer.ok) return sendJson(res, 502, { ok: false, error: String(answer.error ?? "mise did not answer").slice(0, 300) });
      return sendJson(res, 200, { ok: true, id, ...answer.value });
    }

    // A tool's releases, newest first, and where it comes from. Both ask the
    // network through mise, so they are cached and bounded.
    if (req.method === "GET" && (route === "/packages/versions" || route === "/packages/info")) {
      const manager = await loadHarness();
      const parsed = harnessModule.parseToolSpec(raw.searchParams.get("id"));
      if (!parsed.ok) return sendJson(res, 400, { ok: false, code: "invalid-tool", error: parsed.error });
      const work = route === "/packages/versions"
        ? versionsCache(`package:${parsed.id}`, () => manager.packages.versions(parsed.id))
        : infoCache(parsed.id, async () => {
          const info = await manager.packages.info(parsed.id);
          const registry = await packageRegistry().catch(() => null);
          const bins = registry?.byName.get(parsed.id)?.bins ?? [];
          // Commands the image already has. mise's shims come first on t3's
          // PATH, so an added tool takes precedence over these in terminals
          // and for agents; the sheet says so before anything is installed.
          const shadows = bins.filter((bin) => /^[\w.+-]+$/.test(bin)
            && ["/usr/local/bin", "/usr/bin", "/bin"].some((dir) => existsSync(`${dir}/${bin}`)));
          return { ...info, bins, shadows };
        });
      const answer = await withTimeout(work, 20_000);
      if (!answer.ok) return sendJson(res, 502, { ok: false, error: String(answer.error ?? "mise did not answer").slice(0, 300) });
      return sendJson(res, 200, { ok: true, id: parsed.id, ...answer.value });
    }

    // "Check for updates now": a fresh pass in the background; rows pick the
    // answers up on the next poll.
    if (req.method === "POST" && route === "/updates/check") {
      void latestCache.refresh({ force: true }).catch(() => {});
      return sendJson(res, 202, { ok: true, code: "checking" });
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
    if (req.method === "POST" && route === "/auth/apikey/remove") {
      try {
        const input = JSON.parse((await readBody(req)) || "{}");
        return sendJson(res, 200, await removeApiKey(input.agent, input.provider));
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
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
        if (input.agent === "antigravity") return sendJson(res, 200, publicSession(await startAntigravitySignin()));
        if (input.agent === "connect") return sendJson(res, 200, publicSession(startConnectLink()));
        if (input.agent === "az") return sendJson(res, 200, publicSession(await startAzSignin()));
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
      if (session.t3) {
        // The address Google sent the browser to: T3 checks it belongs to
        // this flow and finishes the sign-in.
        const callbackUrl = String(input.code ?? "").trim();
        if (!/^https?:\/\//i.test(callbackUrl) || callbackUrl.length > 16384) {
          return sendJson(res, 400, { error: "Paste the whole address from the browser's address bar, starting with http://127.0.0.1." });
        }
        try {
          await antigravity.completeSignIn(session.flowId, callbackUrl);
          if (!TERMINAL_STATES.has(session.state)) session.state = "submitted";
          session.submittedAt = Date.now();
          return sendJson(res, 200, publicSession(session));
        } catch (error) {
          return sendJson(res, 400, { error: String(error?.message ?? error).slice(0, 300) });
        }
      }
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

    if (req.method === "POST" && (route === "/source-control/signin" || route === "/source-control/signout")) {
      let input;
      try {
        input = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return sendJson(res, 400, { ok: false, code: "bad-request", error: "expected JSON" });
      }
      const { http, body } = await sourceControlSignIn(input, route === "/source-control/signout");
      return sendJson(res, http, body);
    }

    if (req.method === "POST" && route === "/auth/cancel") {
      const input = JSON.parse((await readBody(req)) || "{}");
      const session = sessions.get(input.id);
      if (session?.t3) {
        if (session.flowId && !TERMINAL_STATES.has(session.state)) void antigravity.cancelSignIn(session.flowId).catch(() => {});
        session.state = "cancelled";
        session.flow?.close();
      } else if (session) {
        session.state = "cancelled";
        try { session.child.kill(); } catch {}
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && route === "/revoke") {
      try {
        const result = await revoke(JSON.parse((await readBody(req)) || "{}"));
        // A revoked device must not stay trusted here for the cache's half minute.
        t3Sessions.forget();
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) });
      }
    }

    if (req.method === "POST" && route === "/t3/restart") {
      const input = JSON.parse((await readBody(req)) || "{}");
      const answer = restartT3(input.why === "connect" ? "to turn T3 Connect on" : null);
      return sendJson(res, answer.http, answer.body);
    }

    if (req.method === "POST" && route === "/connect/unlink") {
      const answer = await unlinkConnect();
      return sendJson(res, answer.http, answer.body);
    }

    // The key itself, for a signed-in browser to copy. Nothing new to it: one
    // signed in with T3 Code has a terminal that can read the same file.
    if (req.method === "POST" && route === "/setup-key/reveal") {
      return sendJson(res, 200, { ok: true, key: KEY, source: KEY_SOURCE });
    }

    if (req.method === "POST" && route === "/setup-key/replace") {
      const answer = replaceKey();
      // A browser that came in with the old key keeps its place with the new
      // one. One that came in on its T3 Code session gets no key cookie: it
      // stays as revocable as that session.
      const headers = answer.body.ok && viewer?.via === "key"
        ? { "set-cookie": cookie(req, mount, encodeURIComponent(KEY), 86400) }
        : {};
      return sendJson(res, answer.http, answer.body, headers);
    }

    if (req.method === "POST" && (route === "/public-url" || route === "/public-url/clear")) {
      const input = route === "/public-url" ? JSON.parse((await readBody(req)) || "{}") : {};
      const answer = await setPublicUrl(route === "/public-url/clear" ? null : input.url, { check: input.check !== false });
      return sendJson(res, answer.http, answer.body);
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

// Children belong to this process: a sign-in CLI waiting on a browser, a
// tunnel. Left behind by a restart they would keep running with nothing
// tracking them - a sign-in nobody can finish, a URL nobody can stop - so
// they go when the service does, however it goes.
const stopChildren = () => {
  for (const session of sessions.values()) {
    if (!TERMINAL_STATES.has(session.state)) {
      try { session.child.kill(); } catch { /* already gone */ }
    }
  }
  for (const tunnel of tunnels.values()) {
    try { tunnel.child.kill("SIGTERM"); } catch { /* already gone */ }
  }
};
process.on("exit", stopChildren);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => process.exit(0));
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[setup] listening on 0.0.0.0:${PORT}`);
  // Background facts: the storage check now, release lookups shortly after
  // (a first start is busy downloading; the cache on the volume answers until
  // then) and every half hour after that, each pass skipped while fresh.
  void storage.refresh();
  void latestCache.load();
  setTimeout(() => { void latestCache.refresh().catch(() => {}); }, 30_000).unref();
  // A pass runs once the last is an hour old; looking every ten minutes keeps
  // an answer from going much past that.
  setInterval(() => { void latestCache.refresh().catch(() => {}); }, 10 * 60 * 1000).unref();
  // Antigravity's row, warm before the first poll asks.
  setTimeout(() => { void antigravity.refresh().catch(() => {}); }, 3_000).unref();
  // How long mise holds a new release back, for "mise offers it in 21 hours".
  void loadHarness().then((manager) => manager.releaseAge()).then((ms) => { releaseAgeMs = ms; }, () => {});
});
