// Unit tests for the setup console's HTML document (docker/setup/page.mjs).
//
//   node --test tests/setup-page.test.mjs
//
// The page is one self-contained document: every stylesheet and script read
// verbatim from its file and inlined, run only under the response's nonce, and
// nothing fetched from anywhere else. These pin that, and the unlock form's
// contract.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CONSOLE_SCRIPTS, UNLOCK_SCRIPTS, contentSecurityPolicy, escapeHtml, loadAssets, renderConsole, renderUnlock,
} from "../docker/setup/page.mjs";

const assets = loadAssets();

test("every script is inlined verbatim, in order, and only runs with the response's nonce", async () => {
  const page = renderConsole({ assets, nonce: "N0NCE", mount: "/__setup" });
  const blocks = [...page.matchAll(/<script nonce="([^"]*)"(?: data-src="([^"]*)")?>([\s\S]*?)<\/script>/g)];
  assert.ok(blocks.every((b) => b[1] === "N0NCE"), "no script without the nonce");
  assert.equal(page.match(/<script/g).length, blocks.length);
  const files = blocks.filter((b) => b[2]);
  assert.deepEqual(files.map((b) => b[2]), CONSOLE_SCRIPTS);
  for (const [, , src, code] of files) {
    assert.equal(code, await readFile(new URL(`../docker/setup/${src}`, import.meta.url), "utf8"), `${src} reached the page byte for byte`);
  }
  assert.ok(page.includes('window.__T3_SETUP_BASE__ = "/__setup";'));
  assert.ok(page.includes("<title>T3 Code setup</title>"), "the T3 client's setup pill looks for this title");
});

test("the page asks for nothing from anywhere else", () => {
  for (const page of [renderConsole({ assets, nonce: "n", mount: "" }), renderUnlock({ assets, nonce: "n", mount: "", host: "h", publicUrl: "", error: false })]) {
    assert.doesNotMatch(page, /<link[^>]+href="https?:/i);
    assert.doesNotMatch(page, /<script[^>]+\ssrc=/i);
    assert.doesNotMatch(page, /url\(\s*["']?https?:/i);
    assert.doesNotMatch(page, /@import/i);
  }
  const csp = contentSecurityPolicy("abc");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-abc'/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
});

test("the unlock page posts the key to the mount, and shows a wrong key in place", () => {
  const page = renderUnlock({ assets, nonce: "n", mount: "/__setup", host: "t3.example.com", publicUrl: "https://t3.example.com", error: true });
  assert.match(page, /<form[^>]+method="POST"[^>]+action="\/__setup\/login"/);
  assert.match(page, /<input[^>]+name="key"[^>]+aria-invalid="true"/);
  assert.match(page, /id="key-error" role="alert">That key was not accepted/);
  assert.deepEqual(UNLOCK_SCRIPTS.filter((s) => s.includes("app.js")), [], "the console's code is not shipped to the locked page");
  const fresh = renderUnlock({ assets, nonce: "n", mount: "", host: "", publicUrl: "", error: false });
  assert.match(fresh, /id="key-error" role="alert" hidden>/);
});

test("anything a request controls is escaped", () => {
  const page = renderUnlock({ assets, nonce: "n", mount: "", host: '"><script>alert(1)</script>', publicUrl: "", error: false });
  assert.ok(!page.includes("<script>alert(1)</script>"));
  assert.ok(page.includes("&quot;&gt;&lt;script&gt;"));
  assert.equal(escapeHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
});
