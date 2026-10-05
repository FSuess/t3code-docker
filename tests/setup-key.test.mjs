// Unit tests for the setup key (docker/setup/setup-key.mjs).
//
//   node --test tests/setup-key.test.mjs
//
// A generated key is made once and kept on the state volume, so a restart or
// a redeploy does not send anyone back to the log for a new one. T3_SETUP_KEY
// still wins, and the file always holds the key in effect, for the CLIs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { keyPath, newKey, readKeyFile, resolveSetupKey, validKey, writeKeyFile } from "../docker/setup/setup-key.mjs";

const MODULE = fileURLToPath(new URL("../docker/setup/setup-key.mjs", import.meta.url));
const scratch = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "t3-setup-key-"));
  t.after(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
};

test("a new key is 128 random bits in hex, different every time", () => {
  const a = newKey();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, newKey());
});

test("a usable key is printable ASCII without spaces, as a cookie and a header carry it", () => {
  assert.ok(validKey("0123abcd"));
  assert.ok(validKey("p@ss-word_!~"));
  for (const bad of ["", "two words", "tab\there", "line\nbreak", "ключ", "x".repeat(257), null, undefined, 42]) {
    assert.equal(validKey(bad), false, JSON.stringify(bad));
  }
});

test("the kept key is written whole, readable by its owner only, and read back", (t) => {
  const dir = scratch(t);
  assert.equal(readKeyFile(dir), null);
  writeKeyFile(dir, "first-key");
  assert.equal(readFileSync(keyPath(dir), "utf8"), "first-key\n");
  assert.equal(statSync(keyPath(dir)).mode & 0o777, 0o600);
  writeKeyFile(dir, "second-key");
  assert.equal(readKeyFile(dir), "second-key");
  assert.deepEqual(readdirSync(dir), ["setup-key"], "no temporary file left behind");
});

test("a damaged key file counts as no key", (t) => {
  const dir = scratch(t);
  writeFileSync(keyPath(dir), "\n");
  assert.equal(readKeyFile(dir), null);
  writeFileSync(keyPath(dir), "has a space\n");
  assert.equal(readKeyFile(dir), null);
  writeFileSync(keyPath(dir), "  padded-key  \n");
  assert.equal(readKeyFile(dir), "padded-key", "surrounding whitespace is not part of it");
});

test("the first start generates a key and keeps it; later starts use the same one", (t) => {
  const dir = scratch(t);
  const first = resolveSetupKey({ env: {}, stateDir: dir });
  assert.equal(first.source, "new");
  assert.match(first.key, /^[0-9a-f]{32}$/);
  const second = resolveSetupKey({ env: {}, stateDir: dir });
  assert.deepEqual(second, { key: first.key, source: "volume" });
  assert.deepEqual(resolveSetupKey({ env: { T3_SETUP_KEY: "" }, stateDir: dir }), { key: first.key, source: "volume" }, "an empty T3_SETUP_KEY is unset");
});

test("T3_SETUP_KEY wins, and is written where the CLIs read it", (t) => {
  const dir = scratch(t);
  resolveSetupKey({ env: {}, stateDir: dir });
  assert.deepEqual(resolveSetupKey({ env: { T3_SETUP_KEY: "  chosen-key " }, stateDir: dir }), { key: "chosen-key", source: "env" });
  assert.equal(readKeyFile(dir), "chosen-key");
  assert.deepEqual(resolveSetupKey({ env: {}, stateDir: dir }), { key: "chosen-key", source: "volume" },
    "removing T3_SETUP_KEY keeps the key it set rather than inventing another");
});

test("a volume that cannot keep a key still gets one, for this start", (t) => {
  const dir = scratch(t);
  chmodSync(dir, 0o500);
  // Root ignores directory permissions, so the case cannot be made there.
  if (process.getuid?.() === 0) return t.skip("running as root");
  const result = resolveSetupKey({ env: {}, stateDir: dir });
  assert.equal(result.source, "boot");
  assert.match(result.key, /^[0-9a-f]{32}$/);
  assert.throws(() => writeKeyFile(dir, "x"));
  assert.deepEqual(resolveSetupKey({ env: { T3_SETUP_KEY: "chosen" }, stateDir: dir }), { key: "chosen", source: "env" },
    "a configured key works without the file");
});

test("the entrypoint's --resolve prints the source and the key, and keeps the key", (t) => {
  const dir = scratch(t);
  const run = (env = {}) => execFileSync(process.execPath, [MODULE, "--resolve"], { env: { PATH: process.env.PATH, T3CODE_HOME: dir, ...env }, encoding: "utf8" });
  const [source, key] = run().trim().split(" ");
  assert.equal(source, "new");
  assert.equal(run(), `volume ${key}\n`);
  assert.equal(run({ T3_SETUP_KEY: "chosen" }), "env chosen\n");
  assert.equal(execFileSync(process.execPath, [MODULE], { env: { PATH: process.env.PATH, T3CODE_HOME: dir }, encoding: "utf8" }), "", "nothing without --resolve");
});
