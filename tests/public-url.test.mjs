// Unit tests for where pairing links point (docker/setup/public-url.mjs).
//
//   node --test tests/public-url.test.mjs
//
// The setup page, t3-pair, t3-doctor and the entrypoint all resolve the public
// URL through this one module, so its precedence is the product's: the
// container's T3_PUBLIC_URL, then the address saved from the setup page, then
// the hosting platform's. The reachability check runs against a fake fetch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PLATFORMS, checkReaches, clearSaved, parsePublicUrl, platformUrl, readSaved, resolvePublicUrl, savedPath, writeSaved,
} from "../docker/setup/public-url.mjs";

const MODULE = fileURLToPath(new URL("../docker/setup/public-url.mjs", import.meta.url));

// ------------------------------------------------------------------- parse --

test("an address is taken as typed, scheme optional, down to its origin", () => {
  assert.deepEqual(parsePublicUrl("https://t3.example.com"), { url: "https://t3.example.com" });
  assert.deepEqual(parsePublicUrl("https://t3.example.com/"), { url: "https://t3.example.com" });
  assert.deepEqual(parsePublicUrl("  t3.example.com  "), { url: "https://t3.example.com" }, "no scheme means https");
  assert.deepEqual(parsePublicUrl("HTTPS://T3.Example.COM:443"), { url: "https://t3.example.com" }, "case and default port fold away");
  assert.deepEqual(parsePublicUrl("http://192.168.1.20:3773"), { url: "http://192.168.1.20:3773" }, "a LAN address over http is allowed");
  assert.deepEqual(parsePublicUrl("http://[fd7a:115c::1]:8080"), { url: "http://[fd7a:115c::1]:8080" });
  assert.deepEqual(parsePublicUrl("box.tail1234.ts.net:8080"), { url: "https://box.tail1234.ts.net:8080" });
});

test("what can't be a pairing address says what to change", () => {
  assert.match(parsePublicUrl("").error, /Enter the address/);
  assert.match(parsePublicUrl("   ").error, /Enter the address/);
  assert.match(parsePublicUrl("ftp://t3.example.com").error, /https:\/\/ or http:\/\//);
  assert.match(parsePublicUrl("https://t3.example.com/app").error, /Leave the path out.*https:\/\/t3\.example\.com\./);
  assert.match(parsePublicUrl("https://t3.example.com/?x=1").error, /Leave the path out/);
  assert.match(parsePublicUrl("https://t3.example.com/#pair").error, /Leave the path out/);
  assert.match(parsePublicUrl("https://me:pw@t3.example.com").error, /user name and password/);
  assert.match(parsePublicUrl("https://exa mple.com").error, /is not an address/);
});

// ---------------------------------------------------------------- platforms --

test("each platform's own variable becomes its address", () => {
  const cases = [
    [{ RAILWAY_PUBLIC_DOMAIN: "t3-production.up.railway.app" }, "https://t3-production.up.railway.app", "Railway"],
    [{ RENDER_EXTERNAL_URL: "https://t3.onrender.com" }, "https://t3.onrender.com", "Render"],
    [{ KOYEB_PUBLIC_DOMAIN: "t3-me.koyeb.app" }, "https://t3-me.koyeb.app", "Koyeb"],
    [{ ZEABUR_WEB_URL: "https://t3.zeabur.app/" }, "https://t3.zeabur.app", "Zeabur"],
    [{ ZEABUR_WEB_DOMAIN: "t3.zeabur.app" }, "https://t3.zeabur.app", "Zeabur"],
    [{ COOLIFY_URL: "https://t3.example.com" }, "https://t3.example.com", "Coolify"],
    [{ COOLIFY_URL: "t3.example.com", COOLIFY_FQDN: "https://t3.example.com,https://other.example.com" }, "https://t3.example.com", "Coolify"],
    [{ COOLIFY_FQDN: "t3.example.com" }, "https://t3.example.com", "Coolify"],
    [{ FLY_APP_NAME: "my-t3" }, "https://my-t3.fly.dev", "Fly.io"],
  ];
  for (const [env, url, platform] of cases) {
    assert.deepEqual(platformUrl(env), { url, platform }, JSON.stringify(env));
  }
  assert.equal(platformUrl({}), null);
  assert.equal(platformUrl({ RAILWAY_PUBLIC_DOMAIN: "" }), null, "a template's empty domain is no domain");
  assert.equal(platformUrl({ RENDER_EXTERNAL_URL: "not a url at all" }), null);
  assert.deepEqual(platformUrl({ FLY_APP_NAME: "x", RAILWAY_PUBLIC_DOMAIN: "y.up.railway.app" }).platform, "Railway", "Fly's app name is the last resort");
  assert.equal(PLATFORMS.at(-1).id, "fly");
});

// --------------------------------------------------------------- precedence --

test("the container's T3_PUBLIC_URL wins, then the setup page's address, then the platform's", () => {
  const env = { RAILWAY_PUBLIC_DOMAIN: "t3.up.railway.app" };
  assert.deepEqual(resolvePublicUrl({ env, saved: null }), { url: "https://t3.up.railway.app", source: "platform", platform: "Railway" });
  assert.deepEqual(resolvePublicUrl({ env, saved: "https://t3.example.com" }), { url: "https://t3.example.com", source: "saved", platform: null });
  assert.deepEqual(resolvePublicUrl({ env: { ...env, T3_PUBLIC_URL: "https://pinned.example.com/" }, saved: "https://t3.example.com" }),
    { url: "https://pinned.example.com", source: "env", platform: null });
  assert.deepEqual(resolvePublicUrl({ env: {}, saved: null }), { url: null, source: null, platform: null });
  assert.deepEqual(resolvePublicUrl({ env, saved: "garbage with spaces" }).source, "platform", "a damaged saved file is passed over");
  assert.deepEqual(resolvePublicUrl({ env: { T3_PUBLIC_URL: "  " }, saved: null }).url, null, "a blank T3_PUBLIC_URL is unset");
  assert.equal(resolvePublicUrl({ env: { T3_PUBLIC_URL: "https://t3.example.com/base" } }).url, "https://t3.example.com/base",
    "T3_PUBLIC_URL is the container's configuration and is taken as written");
});

// ------------------------------------------------------------------ storage --

test("a saved address survives as one line on the state volume, and clears", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "t3-public-url-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(readSaved(dir), null);
  writeSaved(dir, "https://t3.example.com");
  assert.equal(readFileSync(savedPath(dir), "utf8"), "https://t3.example.com\n");
  assert.equal(statSync(savedPath(dir)).mode & 0o777, 0o644);
  assert.equal(readSaved(dir), "https://t3.example.com");
  writeSaved(dir, "https://other.example.com");
  assert.equal(readSaved(dir), "https://other.example.com", "replaced whole");
  clearSaved(dir);
  assert.equal(readSaved(dir), null);
  clearSaved(dir);
  writeFileSync(savedPath(dir), "\n\n");
  assert.equal(readSaved(dir), null, "an empty file is no address");
});

test("t3-pair and the entrypoint read the same answer from the command line", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "t3-public-url-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (env, ...args) => execFileSync(process.execPath, [MODULE, ...args], { env: { PATH: process.env.PATH, T3CODE_HOME: dir, ...env }, encoding: "utf8" });
  assert.equal(run({}), "", "nothing set prints nothing");
  assert.equal(run({ KOYEB_PUBLIC_DOMAIN: "t3.koyeb.app" }), "https://t3.koyeb.app\n");
  writeSaved(dir, "https://t3.example.com");
  assert.deepEqual(JSON.parse(run({ KOYEB_PUBLIC_DOMAIN: "t3.koyeb.app" }, "--json")), { url: "https://t3.example.com", source: "saved", platform: null });
  assert.equal(run({ T3_PUBLIC_URL: "https://pinned.example.com" }), "https://pinned.example.com\n");
  assert.equal(run({}, "--describe"), "https://t3.example.com (set on the setup page)\n");
  assert.equal(run({ T3_PUBLIC_URL: "https://pinned.example.com" }, "--describe"), "https://pinned.example.com (T3_PUBLIC_URL)\n");
  clearSaved(dir);
  assert.equal(run({ RENDER_EXTERNAL_URL: "https://t3.onrender.com" }, "--describe"), "https://t3.onrender.com (from Render)\n");
  assert.equal(run({}, "--describe"), "", "nothing set describes nothing");
});

// -------------------------------------------------------------------- check --

const answering = (body, { status = 200, json = true } = {}) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (!json) throw new SyntaxError("Unexpected token <");
    return body;
  },
});
const failing = (code, name = "TypeError") => async () => {
  const error = new Error("fetch failed");
  error.name = name;
  if (code) error.cause = { code };
  throw error;
};

test("an address that answers with this server's environment reaches it", async () => {
  const asked = [];
  const fetchImpl = async (url, options) => {
    asked.push({ url, accept: options.headers.accept });
    return answering({ environmentId: "env-1", label: "box" })();
  };
  assert.deepEqual(await checkReaches("https://t3.example.com", { localId: "env-1", fetchImpl }), { reaches: "this" });
  assert.deepEqual(asked, [{ url: "https://t3.example.com/.well-known/t3/environment", accept: "application/json" }]);
});

test("a different T3 Code server at the address is called out, with its label", async () => {
  assert.deepEqual(await checkReaches("https://x", { localId: "env-1", fetchImpl: answering({ environmentId: "env-2", label: "old-box" }) }),
    { reaches: "other", label: "old-box" });
});

test("no answer that settles it is unknown, with a reason, never an error", async () => {
  const why = async (fetchImpl, localId = "env-1") => (await checkReaches("https://x", { localId, fetchImpl })).why;
  assert.match(await why(failing("ENOTFOUND")), /name does not resolve there/);
  assert.match(await why(failing(null, "TimeoutError")), /did not answer in time/);
  assert.match(await why(failing("SELF_SIGNED_CERT_IN_CHAIN")), /certificate/);
  assert.match(await why(failing("ECONNREFUSED")), /nothing answered/);
  assert.match(await why(answering({}, { status: 403 })), /HTTP 403/);
  assert.match(await why(answering(null, { json: false })), /not as T3 Code/);
  assert.match(await why(answering({ ok: true })), /not as T3 Code/);
  assert.match(await why(answering({ environmentId: "env-1" }), null), /nothing to compare with/);
});
