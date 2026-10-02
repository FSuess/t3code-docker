#!/usr/bin/env node
/*
 * Focused audit for the harness lifecycle surfaces.
 *
 *   node scripts/harness-ui-audit.js [baseUrl] [setupKey]
 *
 * Static checks always run: the setup server must expose the authenticated
 * lifecycle endpoints over the shared manager, the Agents card must render
 * exact versions, progress, failures and runnable state without
 * erasing in-flight input, and the CLI must share the manager with useful
 * exit codes. When a base URL and key are given, the same schema is asserted
 * live against /harnesses and /status.
 *
 * Exits non-zero when it finds something.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "docker/setup/server.mjs");
const APP = path.join(ROOT, "docker/setup/app.js");
// What each row says and offers is decided in the view model; app.js renders it.
const MODEL = path.join(ROOT, "docker/setup/client/model.js");
const KIT = path.join(ROOT, "docker/setup/client/kit.js");
const CSS = path.join(ROOT, "docker/setup/console.css");
const CLI = path.join(ROOT, "docker/bin/t3-harness");

const findings = [];
const pass = [];
const check = (label, ok, detail = "") => {
  if (ok) pass.push(label);
  else findings.push({ label, detail });
};
const has = (file, needle) => {
  try {
    return readFileSync(file, "utf8").includes(needle);
  } catch {
    return false;
  }
};

// -- 1. server routes and manager wiring -------------------------------------
check("server exposes GET /harnesses",
  has(SERVER, 'route === "/harnesses"') && has(SERVER, "/harnesses"),
  "GET /harnesses is missing");
check("server exposes install/update/uninstall mutations",
  has(SERVER, "/harnesses/install") && has(SERVER, "/harnesses/update") && has(SERVER, "/harnesses/uninstall"),
  "lifecycle POST routes are missing");
check("mutations are backed only by the shared manager",
  has(SERVER, "loadHarness()") && has(SERVER, "manager.toolchains") && has(SERVER, "ops[job.kind](job.id, options)"),
  "lifecycle must call the shared manager, not a second installer");
check("status is read-only and mutations sync providers",
  has(SERVER, "syncManagedProviders") && has(SERVER, "harnessLifecycleStatus"),
  "expected sync-after-mutation and read-only status helpers");
check("sign-in resolves the managed executable",
  has(SERVER, "managedExecutable(agentId)") || has(SERVER, "managedExecutable("),
  "startSignin/setApiKey must run through the managed executable");
check("auth cache is invalidated after sign-in",
  has(SERVER, "invalidateAuth"),
  "call invalidateAuth(id) when credentials change");
check("busy maps to 409 and unknown to 404",
  has(SERVER, "lifecycleHttpStatus") && has(SERVER, "409") && has(SERVER, "404"),
  "map busy->409, unknown-harness->404");
check("prefixed routes include the lifecycle surface",
  has(SERVER, '"/harnesses/install"') && has(SERVER, "ROUTES"),
  "ROUTES must list /harnesses/* for prefix inference");

// -- 2. Agents rows -------------------------------------------------------------
check("rows distinguish progress, failure and runnable state",
  has(MODEL, "agentRow") && has(MODEL, "h.runnable") && has(MODEL, "h.inProgress") && has(MODEL, "h.failed"),
  "the view model must branch on inProgress/failed/runnable");
check("rows show the exact version",
  has(MODEL, "installedVersion"),
  "the row must render the recorded exact version");
check("rows offer explicit versions and every lifecycle action",
  has(MODEL, "'harness.install'") && has(MODEL, "'harness.update'") && has(MODEL, "'harness.uninstall'")
    && has(MODEL, "'harness.version'") && has(APP, "hv-version"),
  "Install/Update/Uninstall plus an exact-version dialog are required");
check("polling preserves version drafts and in-flight work",
  has(APP, "versionDrafts") && has(APP, "lifecycleBusy") && has(APP, "pendingOps")
    && has(KIT, "morphChildren"),
  "the poll must not erase version input or busy rows (app.js state, kit.js morphing patch)");
check("lifecycle failures stay visible",
  has(APP, "notices.set(key"),
  "POST errors and background failures must render inline, not only as a toast");
check("lifecycle answers before the download finishes",
  has(SERVER, "Promise.race([started, done])") && has(SERVER, "operations: Object.fromEntries(")
    && has(APP, "res.status === 202"),
  "an install must not hold the request open for the length of a download");
check("page operations queue instead of failing as busy, and can be cancelled",
  has(SERVER, "cancelLifecycle") && has(SERVER, '"/harnesses/cancel"') && has(SERVER, "enqueue(job")
    && has(MODEL, "op.cancel"),
  "a second click must queue, and the row must offer Cancel for work this page started");
check("operations report their phase",
  has(SERVER, "onProgress") && has(MODEL, "progressOf"),
  "the row's progress line needs the manager's phases");

// -- 3. styles for the lifecycle controls -------------------------------------
check("lifecycle controls wrap without squeezing the row",
  has(CSS, ".tc-row-actions--wrap") && has(CSS, ".tc-input--sm"),
  "console.css must carry the wrap and small-input rules");
check("the console is built from the vendored design system",
  existsSync(path.join(ROOT, "docker/setup/design/components.css")) && existsSync(path.join(ROOT, "docker/setup/design/tokens.css"))
    && existsSync(path.join(ROOT, "docker/setup/design/ui.js")),
  "docker/setup/design/ must hold tokens.css, components.css and ui.js");

// -- 4. CLI contract -----------------------------------------------------------
check("t3-harness lists the five lifecycle commands",
  has(CLI, "t3-harness list") && has(CLI, "install <id>") && has(CLI, "uninstall <id>"),
  "usage must document list/status/install/update/uninstall");
check("CLI shares the manager and syncs providers",
  has(CLI, "createHarnessManager") && has(CLI, "createProviderIntegration"),
  "the CLI must use the shared manager plus one provider sync");
check("CLI documents its exit codes",
  has(CLI, "Exit codes"),
  "document 0 ok / 1 failed / 2 usage / 4 no module");
check("CLI drops privileges and sources the user environment",
  has(CLI, "gosu t3") && has(CLI, "t3-user-env.sh"),
  "docker exec as root must step down to t3 with MISE_* set");

// -- 5. live schema (optional) --------------------------------------------------
const [baseUrl, setupKey] = process.argv.slice(2);
if (baseUrl && setupKey) {
  const get = async (pathname) => {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${pathname}`, {
      headers: { "x-t3-setup-key": setupKey },
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };
  try {
    const harnesses = await get("/harnesses");
    check("live GET /harnesses is 200", harnesses.status === 200, `got ${harnesses.status}`);
    const list = harnesses.body?.harnesses ?? [];
    check("live lifecycle lists five harnesses", list.length === 5, `got ${list.length}`);
    const required = ["id", "runnable", "installedVersion", "failed", "inProgress", "executable"];
    for (const id of ["claude", "codex", "opencode", "grok", "cursor"]) {
      const one = list.find((h) => h.id === id);
      check(`live ${id} is present`, Boolean(one), "missing from /harnesses");
      if (one) {
        for (const field of required) {
          check(`live ${id} exposes ${field}`, field in one, `missing ${field}`);
        }
      }
    }
    const status = await get("/status");
    check("live GET /status is 200", status.status === 200, `got ${status.status}`);
    check("live status carries the managed card fields",
      Array.isArray(status.body?.harnesses) && status.body.harnesses.length === 5
      && status.body.harnesses.every((h) => "runnable" in h && "installedVersion" in h),
      "status harnesses must carry managed lifecycle fields");
    const unauth = await fetch(`${baseUrl.replace(/\/+$/, "")}/harnesses`, { signal: AbortSignal.timeout(10000) });
    check("live unauthenticated lifecycle read is 401", unauth.status === 401, `got ${unauth.status}`);
  } catch (error) {
    findings.push({ label: "live lifecycle audit", detail: String(error?.message ?? error) });
  }
} else {
  pass.push("live checks skipped (pass a base URL and setup key to enable them)");
}

for (const label of pass) process.stdout.write(`  \x1b[32mPASS\x1b[0m ${label}\n`);
for (const { label, detail } of findings) {
  process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` (${detail})` : ""}\n`);
}
process.stdout.write(`\n${pass.length} passed, ${findings.length} failed\n`);
if (!existsSync(CLI)) findings.push({ label: "t3-harness exists", detail: "missing file" });
process.exit(findings.length ? 1 : 0);
