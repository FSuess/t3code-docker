// Unit tests for what the image adds to T3 Code's own client
// (docker/t3-client/setup-bridge.js and the build step that injects it).
//
//   node --test tests/t3-client.test.mjs
//
// The bridge is a classic script inlined into T3's HTML shell. Loaded here
// with no document, it exports its pure helpers instead of starting; what it
// does on T3's real pages is scripts/setup-bridge-audit.js's job.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const BRIDGE = new URL("../docker/t3-client/setup-bridge.js", import.meta.url);
const PATCH = new URL("../docker/t3-client/patch.mjs", import.meta.url);
const source = readFileSync(BRIDGE, "utf8");
const context = vm.createContext({});
vm.runInContext(source, context, { filename: "setup-bridge.js" });
const B = context.T3SetupBridge;

test("the bridge can be inlined into an HTML script tag", () => {
  assert.doesNotMatch(source, /<\/script/i);
  assert.match(source, /data-t3-setup-entry/, "the build step recognises it by this");
});

test("it looks for the console on the documented route first", () => {
  assert.deepEqual([...B.PROBE_PATHS], ["/__setup/", "/setup/"]);
});

test("Settings is every page under /settings, and nothing else", () => {
  for (const path of ["/settings", "/settings/", "/settings/general", "/settings/projects/abc"]) assert.equal(B.isSettingsPath(path), true, path);
  for (const path of ["/", "/pair", "/welcome", "/settingsx", "/chat/settings", ""]) assert.equal(B.isSettingsPath(path), false, path);
});

test("the dialog opens the console embedded, in T3's theme", () => {
  assert.equal(B.embedUrl("/__setup/", "dark", null), "/__setup/?embed=t3&theme=dark");
  assert.equal(B.embedUrl("/__setup/", "light", "agents"), "/__setup/?embed=t3&theme=light#agents");
  assert.equal(B.embedUrl("/setup/", "<script>", null), "/setup/?embed=t3&theme=light", "anything else is light");
});

test("only the console's own answer counts as the console", () => {
  assert.deepEqual({ ...B.readHello({ service: "t3-setup", signedIn: true, attention: 2 }) }, { signedIn: true, attention: 2 });
  assert.deepEqual({ ...B.readHello({ service: "t3-setup", signedIn: false }) }, { signedIn: false, attention: 0 });
  assert.deepEqual({ ...B.readHello({ service: "t3-setup", signedIn: "yes", attention: -1 }) }, { signedIn: false, attention: 0 });
  assert.deepEqual({ ...B.readHello({ service: "t3-setup", signedIn: true, attention: 1.5 }) }, { signedIn: true, attention: 0 });
  assert.equal(B.readHello({ authenticated: true }), null, "T3's own JSON is not the console");
  assert.equal(B.readHello(null), null, "nor is T3's HTML shell, which parses to nothing");
});

test("the count beside Setup is short, and says itself to a screen reader", () => {
  assert.equal(B.badgeText(0), "");
  assert.equal(B.badgeText(3), "3");
  assert.equal(B.badgeText(120), "99+");
  assert.equal(B.entryLabel(0), "Setup");
  assert.equal(B.entryLabel(1), "Setup, 1 thing needs you");
  assert.equal(B.entryLabel(4), "Setup, 4 things need you");
});

test("only the console in the dialog is listened to", () => {
  const frame = { contentWindow: {} };
  const message = (over) => ({ source: frame.contentWindow, origin: "https://t3.example.com", data: { source: "t3-setup", type: "close" }, ...over });
  assert.equal(B.fromConsole(message({}), frame, "https://t3.example.com"), true);
  assert.equal(B.fromConsole(message({ source: {} }), frame, "https://t3.example.com"), false, "another frame");
  assert.equal(B.fromConsole(message({ origin: "https://evil.example.com" }), frame, "https://t3.example.com"), false, "another origin");
  assert.equal(B.fromConsole(message({ data: { source: "other", type: "close" } }), frame, "https://t3.example.com"), false);
  assert.equal(B.fromConsole(message({ data: "close" }), frame, "https://t3.example.com"), false);
  assert.equal(B.fromConsole(message({}), null, "https://t3.example.com"), false, "no dialog open");
});

test("the build step injects the bridge once, before </body>, or fails loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3-client-"));
  const shell = join(dir, "index.html");
  const run = () => execFileSync(process.execPath, [PATCH.pathname], {
    env: { ...process.env, T3_CLIENT_SHELL: shell, T3_SETUP_BRIDGE: BRIDGE.pathname },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  writeFileSync(shell, "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>");
  assert.match(run(), /setup bridge injected/);
  const once = readFileSync(shell, "utf8");
  assert.match(once, /<script data-t3-setup-bridge>\n[\s\S]+<\/script>\n<\/body>/);
  assert.ok(once.includes(source), "verbatim");
  assert.match(run(), /already present/);
  assert.equal(readFileSync(shell, "utf8"), once, "a second run changes nothing");

  writeFileSync(shell, "<!doctype html><html><body><div id=\"root\"></div></html>");
  assert.throws(run, /no <\/body>/, "an upstream layout change stops the build");
});
