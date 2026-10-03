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
  assert.ok(page.includes("<title>T3 Code setup</title>"));
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
  // T3 Code's settings frame the console from the same origin; nothing else may.
  assert.match(csp, /frame-ancestors 'self'/);
});

// The document's own markup, without the inlined scripts (which name the same selectors).
const markup = (page) => page.replace(/<script[\s\S]*?<\/script>/g, "");

test("inside T3 Code the console closes instead of linking to T3, and leaves the theme to it", () => {
  const embedded = markup(renderConsole({ assets, nonce: "n", mount: "/__setup", embed: true }));
  assert.match(embedded, /<html lang="en" data-embed="t3">/);
  // A close button ends the top bar and the phone's bar.
  assert.equal(embedded.match(/data-cmd="embed\.close"/g).length, 2);
  assert.match(embedded, /<a class="tc-nav-item" id="open-tab" href="\/__setup\/" target="_blank"[^>]*>.*Open in a new tab<\/a>/);
  assert.doesNotMatch(embedded, /id="open-t3"/, "no link to the T3 Code it is already inside");
  assert.doesNotMatch(embedded, /id="theme-toggle"/, "T3 Code's theme, not a toggle of its own");

  const alone = markup(renderConsole({ assets, nonce: "n", mount: "/__setup" }));
  assert.match(alone, /<html lang="en">/);
  assert.doesNotMatch(alone, /embed\.close|data-embed/);
  assert.match(alone, /id="open-t3"/);
  assert.match(alone, /id="theme-toggle"/);
});

test("the unlock page inside T3 Code keeps the dialog's query through a plain post, and closes", () => {
  const page = markup(renderUnlock({ assets, nonce: "n", mount: "/__setup", host: "h", publicUrl: "https://t3.example.com", error: false, embed: true }));
  assert.match(page, /<html lang="en" data-embed="t3">/);
  assert.match(page, /<input type="hidden" name="embed" value="t3">/);
  assert.match(page, /data-cmd="embed\.close"/);
  assert.doesNotMatch(page, />Open T3 Code</, "no T3 Code to open from inside it");
  const alone = markup(renderUnlock({ assets, nonce: "n", mount: "/__setup", host: "h", publicUrl: "https://t3.example.com", error: false }));
  assert.doesNotMatch(alone, /name="embed"|embed\.close/);
  assert.match(alone, />Open T3 Code</);
});

test("the theme is set before first paint, from T3 Code's when embedded", () => {
  const page = renderConsole({ assets, nonce: "n", mount: "", embed: true });
  const boot = page.match(/<script nonce="n">(\(function\(\)\{var r=document\.documentElement;[\s\S]*?)<\/script>/)[1];
  const run = (embed, search, stored) => {
    const attrs = embed ? { "data-embed": "t3" } : {};
    const root = { hasAttribute: (name) => name in attrs, setAttribute: (name, value) => { attrs[name] = value; } };
    const sandbox = {
      document: { documentElement: root },
      location: { search },
      localStorage: { getItem: () => stored },
      matchMedia: () => ({ matches: false }),
      URLSearchParams,
    };
    new Function(...Object.keys(sandbox), boot)(...Object.values(sandbox));
    return attrs["data-theme"];
  };
  assert.equal(run(true, "?embed=t3&theme=dark", "light"), "dark", "T3's theme wins inside T3");
  assert.equal(run(true, "?embed=t3&theme=nonsense", "dark"), "light", "an unknown theme follows the system, not the console's own setting");
  assert.equal(run(false, "?theme=dark", "light"), "light", "on its own the console keeps its own setting");
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
