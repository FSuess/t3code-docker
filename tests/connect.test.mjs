// Unit tests for reading T3 Connect from T3 Code's CLI (docker/setup/connect.mjs).
//
//   node --test tests/connect.test.mjs
//
// The output below is what `t3 connect link --headless` and `t3 connect status
// --json` print in T3 Code 0.0.45 (apps/server/src/cli/connect.ts).
import assert from "node:assert/strict";
import test from "node:test";

import { connectState, jsonFrom, parseLinkOutput } from "../docker/setup/connect.mjs";

const PROMPT = [
  "T3 Connect",
  "",
  "Relay client ready (2026.5.2).",
  "Headless authorization",
  "Open this URL on a device with a browser:",
  "  https://accounts.t3.codes/device?user_code=WDJB-MJHT",
  "",
  "Confirm this code when asked: WDJB-MJHT",
  "",
  "Waiting for approval (expires in 10 min). Press Ctrl+C to cancel.",
].join("\n");

test("the device page, the code and the deadline are read as soon as they are printed", () => {
  assert.deepEqual(parseLinkOutput(PROMPT), {
    url: "https://accounts.t3.codes/device?user_code=WDJB-MJHT",
    code: "WDJB-MJHT",
    expiresInMs: 10 * 60_000,
    authorized: false,
    identity: null,
  });
});

test("nothing is claimed before it is printed", () => {
  assert.deepEqual(parseLinkOutput("T3 Connect\n\nHeadless authorization\n"), {
    url: null, code: null, expiresInMs: null, authorized: false, identity: null,
  });
  assert.deepEqual(parseLinkOutput(""), { url: null, code: null, expiresInMs: null, authorized: false, identity: null });
  assert.equal(parseLinkOutput(undefined).url, null);
});

test("approval reads as authorized, with the account when the CLI names one", () => {
  const named = parseLinkOutput(`${PROMPT}\n✓ Authorized as ada@example.com\n\nNext\n  Start the server with \`t3 serve\` to make this machine reachable.`);
  assert.equal(named.authorized, true);
  assert.equal(named.identity, "ada@example.com");
  const unnamed = parseLinkOutput(`${PROMPT}\n✓ Authorized\n`);
  assert.equal(unnamed.authorized, true);
  assert.equal(unnamed.identity, null);
});

test("a URL printed without the usual lead-in is still found", () => {
  assert.equal(parseLinkOutput("Visit https://example.test/device to continue").url, "https://example.test/device");
});

test("the saved state reads as off, signed out, waiting on a start, or on", () => {
  const relayClient = { status: "available", executablePath: "/usr/local/bin/cloudflared", source: "override", version: "2026.5.2" };
  const base = { desired: false, authenticated: false, linked: false, cloudUserId: null, relayUrl: null, publishAgentActivity: false, relayClient };
  assert.deepEqual(connectState(base), {
    state: "off", desired: false, authenticated: false, linked: false, relayHost: null, publishAgentActivity: false,
    relayClient: { status: "available", version: "2026.5.2" },
  });
  assert.equal(connectState({ ...base, desired: true, authenticated: true }).state, "pending");
  assert.equal(connectState({ ...base, desired: true }).state, "signin", "asked for, with the sign-in gone");
  const on = connectState({ ...base, desired: true, authenticated: true, linked: true, relayUrl: "https://relay.t3.codes", publishAgentActivity: true });
  assert.equal(on.state, "on");
  assert.equal(on.relayHost, "relay.t3.codes");
  assert.equal(on.publishAgentActivity, true);
  assert.equal(connectState({ ...base, authenticated: true }).state, "off", "signed in but not asked for is off");
});

test("anything but that JSON is no state, and a malformed relay URL is no host", () => {
  assert.equal(connectState(null), null);
  assert.equal(connectState("linked"), null);
  assert.equal(connectState({ linked: true, relayUrl: "not a url" }).relayHost, null);
  assert.deepEqual(connectState({ linked: true }).relayClient, { status: null, version: null });
});

test("the JSON is found after any lines the CLI prints first", () => {
  assert.deepEqual(jsonFrom('Migrating state…\n{"desired":true}\n'), { desired: true });
  assert.equal(jsonFrom("no json here"), null);
  assert.equal(jsonFrom("{ broken"), null);
  assert.equal(jsonFrom(undefined), null);
});
