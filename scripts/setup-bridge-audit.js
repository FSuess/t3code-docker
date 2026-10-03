#!/usr/bin/env node
/*
 * End-to-end check of the setup bridge: T3 Code's own pages, with the console
 * routed beside them on one origin, driven in a real browser.
 *
 *   node scripts/setup-bridge-audit.js [--t3 URL] [--setup URL] [--bridge FILE]
 *
 *   T3_PAIR_CREDENTIAL   a pairing credential for this T3 (`t3 auth pairing create`)
 *   --bridge FILE        serve T3's shell with this bridge instead of the one
 *                        built into it, to try a working copy against an image
 *
 * The console is only reachable from T3 Code when one origin serves both, so
 * this starts that origin itself: a small router sending /__setup* to the
 * console and everything else to T3, as the README's Cloudflare Tunnel setup
 * does. Through it, a fresh browser:
 *
 *   - sees the Setup pill on the pairing screen, and no entry;
 *   - pairs through T3's own /pair page, after which the pill is gone;
 *   - finds Setup at the end of the Settings sidebar, drawn like T3's rows;
 *   - opens the console in a dialog, signed in on its T3 session, in T3's
 *     theme, with the rest of the page inert;
 *   - closes it with Escape and gets focus back on the entry;
 *   - on a phone, opens it from T3's sidebar sheet as a full-screen dialog;
 * and the console refuses a state change that did not come from its own
 * origin, even with a valid T3 session.
 *
 * Exits non-zero on the first finding, after saying what it was.
 */
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("playwright-core"));
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const T3 = new URL(arg("--t3", "http://127.0.0.1:3773"));
const SETUP = new URL(arg("--setup", "http://127.0.0.1:3774"));
const BRIDGE = arg("--bridge", null);
const CREDENTIAL = process.env.T3_PAIR_CREDENTIAL || "";
const CHROME = process.env.CHROME_PATH
  || (fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

if (!CREDENTIAL) {
  console.error("setup-bridge-audit: set T3_PAIR_CREDENTIAL (t3 auth pairing create --json, its credential)");
  process.exit(2);
}

// ------------------------------------------------------------------ router --
const upstream = (path) => (path.startsWith("/__setup") ? SETUP : T3);
const router = http.createServer((req, res) => {
  const to = upstream(req.url);
  const forward = http.request({
    host: to.hostname, port: to.port, path: req.url, method: req.method, headers: req.headers,
  }, (answer) => {
    res.writeHead(answer.statusCode, answer.headers);
    answer.pipe(res);
  });
  forward.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(forward);
});
router.on("upgrade", (req, socket, head) => {
  const to = upstream(req.url);
  const forward = net.connect(Number(to.port), to.hostname, () => {
    forward.write(`${req.method} ${req.url} HTTP/1.1\r\n`
      + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
    forward.write(head);
    socket.pipe(forward).pipe(socket);
  });
  forward.on("error", () => socket.destroy());
  socket.on("error", () => forward.destroy());
});

// ------------------------------------------------------------------ checks --
let passed = 0;
const fail = (what, detail) => {
  const error = new Error(what + (detail ? `\n    ${detail}` : ""));
  error.finding = true;
  throw error;
};
const ok = (what) => { passed += 1; console.log(`  ok  ${what}`); };
const expect = (cond, what, detail) => (cond ? ok(what) : fail(what, typeof detail === "function" ? detail() : detail));

/** Serve T3's shell with a working copy of the bridge in place of the built one. */
const useBridge = async (context) => {
  if (!BRIDGE) return;
  const code = fs.readFileSync(BRIDGE, "utf8");
  await context.route((url) => !/^\/(__setup|api|assets|ws|\.well-known|oauth)/.test(url.pathname) && !/\.\w+$/.test(url.pathname),
    async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const answer = await route.fetch();
      const body = (await answer.text())
        .replace(/<script data-t3-setup-bridge>[\s\S]*?<\/script>\n?/, "")
        .replace(/<script>\n\/\/ A link from T3 Code back to the setup console[\s\S]*?<\/script>\n?/, "")
        .replace("</body>", `<script data-t3-setup-bridge>\n${code}</script>\n</body>`);
      await route.fulfill({ response: answer, body, headers: { ...answer.headers(), "content-length": String(Buffer.byteLength(body)) } });
    });
};

/**
 * Go to a page of T3's, past the wizard T3 greets a fresh server with: it
 * decides after loading whether to show it, so wait for either the wizard or
 * the app, and decline the wizard's offers until it lets go.
 */
const visit = async (page, url) => {
  await page.goto(url);
  for (let round = 0; round < 3; round++) {
    await page.waitForFunction(() => location.pathname.startsWith("/welcome")
      || document.querySelector('[data-sidebar="menu-button"]') !== null, null, { timeout: 30000 }).catch(() => null);
    if (!new URL(page.url()).pathname.startsWith("/welcome")) return;
    for (let i = 0; i < 12 && new URL(page.url()).pathname.startsWith("/welcome"); i++) {
      let clicked = false;
      for (const name of [/^Do not import projects$/, /^Skip/, /^Continue/, /^(Finish|Done|Get started)/]) {
        const button = page.getByRole("button", { name }).last();
        if (await button.count() && await button.isEnabled().catch(() => false)) {
          await button.click({ timeout: 5000 }).catch(() => {});
          clicked = true;
          break;
        }
      }
      await page.waitForTimeout(clicked ? 1200 : 600);
    }
    if (new URL(page.url()).pathname.startsWith("/welcome")) fail("T3's welcome wizard could be finished", page.url());
    await page.goto(url);
  }
};

const ENTRY = "[data-t3-setup-entry] button";
const settingsRow = (label) => `[data-sidebar="menu-button"]:not([data-t3-setup-entry] *):text-is("${label}")`;

const run = async (base) => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    // A substituted shell (--bridge) loses its address space, and Chromium
    // would then refuse T3's WebSocket to a loopback address.
    args: ["--no-sandbox", "--disable-features=LocalNetworkAccessChecks"],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await useBridge(context);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    console.log("Before pairing");
    await page.goto(base + "/");
    await page.waitForSelector(".t3-setup-pill", { timeout: 20000 }).catch(() => null);
    expect(await page.locator(".t3-setup-pill").count() === 1, "the pairing screen shows the Setup pill");
    expect(await page.locator(".t3-setup-pill").getAttribute("href") === "/__setup/", "the pill opens the console's own page");

    console.log("Pairing");
    await page.goto(base + "/pair#token=" + encodeURIComponent(CREDENTIAL));
    await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 30000 });
    await visit(page, base + "/");
    await page.waitForFunction(() => !document.querySelector(".t3-setup-pill"), null, { timeout: 10000 }).catch(() => null);
    expect(await page.locator(".t3-setup-pill").count() === 0, "once paired, the pill leaves T3's own corner alone", page.url());

    console.log("Settings");
    await visit(page, base + "/settings/general");
    await page.waitForSelector(ENTRY, { timeout: 20000 }).catch(() => null);
    expect(await page.locator(ENTRY).count() === 1, "Settings has exactly one Setup entry");
    const geometry = await page.evaluate(() => {
      const entry = document.querySelector("[data-t3-setup-entry]");
      const list = entry.previousElementSibling;
      const rows = list.querySelectorAll('[data-sidebar="menu-button"]');
      const last = rows[rows.length - 1].getBoundingClientRect();
      const mine = entry.querySelector("button").getBoundingClientRect();
      return {
        after: list.getAttribute("data-sidebar") === "menu",
        height: [Math.round(last.height), Math.round(mine.height)],
        left: [Math.round(last.left), Math.round(mine.left)],
        width: [Math.round(last.width), Math.round(mine.width)],
        below: mine.top > last.bottom,
        label: entry.querySelector("button").getAttribute("aria-label"),
        popup: entry.querySelector("button").getAttribute("aria-haspopup"),
      };
    });
    expect(geometry.after && geometry.below, "it comes after T3's own settings list");
    expect(geometry.height[0] === geometry.height[1] && geometry.left[0] === geometry.left[1] && geometry.width[0] === geometry.width[1],
      "it is drawn exactly like T3's rows", JSON.stringify(geometry));
    expect(/^Setup/.test(geometry.label) && geometry.popup === "dialog", "it says what it is and that it opens a dialog", JSON.stringify(geometry));

    const hello = await page.evaluate(() => fetch("/__setup/hello").then((r) => r.json()));
    expect(hello.signedIn === true, "the console accepts this browser's T3 session", JSON.stringify(hello));
    const badge = await page.locator("[data-t3-setup-entry] .t3-setup-badge").evaluate((el) => (el.hidden ? "" : el.textContent));
    expect(badge === (hello.attention > 0 ? String(hello.attention) : ""), "the count beside it is the console's", `badge "${badge}", console ${hello.attention}`);

    console.log("The dialog");
    await page.click(ENTRY);
    await page.waitForSelector(".t3-setup-layer[data-ready]", { timeout: 20000 }).catch(() => null);
    expect(await page.locator(".t3-setup-layer[data-ready]").count() === 1, "Setup opens the console in a dialog");
    const frame = page.frames().find((f) => f.url().includes("/__setup/"));
    expect(Boolean(frame) && /[?&]embed=t3/.test(frame.url()), "the dialog holds the console, embedded", frame && frame.url());
    await frame.waitForSelector("#app", { timeout: 15000 }).catch(() => null);
    const inside = await frame.evaluate(async () => ({
      app: Boolean(document.getElementById("app")),
      close: Boolean(document.querySelector('[data-cmd="embed.close"]')),
      lockless: !document.querySelector("#theme-toggle"),
      via: (await fetch(BASE + "/status", { headers: { accept: "application/json" } }).then((r) => r.json())).viewer,
    }));
    expect(inside.app && inside.via && inside.via.via === "t3", "it opens signed in, without the setup key", JSON.stringify(inside));
    expect(inside.close && inside.lockless, "it has a close button and leaves the theme to T3");
    const modal = await page.evaluate(() => ({
      dialog: document.querySelector('.t3-setup-panel[role="dialog"][aria-modal="true"]') !== null,
      reachable: [...document.body.children]
        .filter((node) => !node.inert && !node.classList.contains("t3-setup-layer") && !/^(SCRIPT|STYLE|LINK)$/.test(node.tagName))
        .map((node) => node.tagName.toLowerCase() + (node.id ? "#" + node.id : "")),
    }));
    expect(modal.dialog && modal.reachable.length === 0, "it is modal: T3 behind it is out of reach", "still reachable: " + modal.reachable.join(", "));

    const themeOf = () => frame.evaluate(() => document.documentElement.getAttribute("data-theme"));
    const startTheme = await themeOf();
    await page.evaluate(() => document.documentElement.classList.toggle("dark"));
    await page.waitForTimeout(300);
    const switched = await themeOf();
    await page.evaluate(() => document.documentElement.classList.toggle("dark"));
    expect(startTheme !== switched && (switched === "dark" || switched === "light"), "it follows T3's theme as it changes", `${startTheme} -> ${switched}`);

    await frame.locator("#main").focus();
    await page.keyboard.press("Escape");
    await page.waitForSelector(".t3-setup-layer", { state: "detached", timeout: 5000 }).catch(() => null);
    expect(await page.locator(".t3-setup-layer").count() === 0, "Escape inside the console closes the dialog");
    expect(await page.evaluate(() => document.activeElement && document.activeElement.closest("[data-t3-setup-entry]") !== null),
      "focus goes back to the entry");
    expect(await page.evaluate(() => [...document.body.children].every((n) => !n.inert)), "and T3 is reachable again");

    await page.click(ENTRY);
    await page.waitForSelector(".t3-setup-layer[data-ready]", { timeout: 20000 });
    await page.mouse.click(8, 450);
    await page.waitForSelector(".t3-setup-layer", { state: "detached", timeout: 5000 }).catch(() => null);
    expect(await page.locator(".t3-setup-layer").count() === 0, "a click beside the dialog closes it");

    await visit(page, base + "/");
    await page.waitForTimeout(800);
    expect(await page.locator("[data-t3-setup-entry]").count() === 0, "outside Settings there is no entry");

    console.log("The console's own guard");
    // Asked from here rather than from the page, which cannot set Sec-Fetch-Site.
    const cookies = (await context.cookies()).filter((c) => c.name.startsWith("t3_session")).map((c) => `${c.name}=${c.value}`).join("; ");
    const post = (site) => fetch(base + "/__setup/revoke", {
      method: "POST",
      headers: { cookie: cookies, "content-type": "application/json", ...(site ? { "sec-fetch-site": site } : {}) },
      body: JSON.stringify({ kind: "link", id: "none" }),
    }).then((r) => r.status);
    expect(await post("cross-site") === 403 && await post("same-site") === 403, "a state change from another site is refused");
    expect(await post(null) === 401, "a T3 session alone does not authorise a state change the browser did not vouch for");
    const read = await fetch(base + "/__setup/status", { headers: { cookie: cookies, accept: "application/json" } });
    expect(read.status === 200 && (await read.json()).viewer.via === "t3", "a T3 session reads the console");
    const forged = await fetch(base + "/__setup/status", { headers: { cookie: cookies.replace(/=([^;]{8})/, "=x$1"), accept: "application/json" } });
    expect(forged.status === 401, "a forged T3 session does not");
    const framing = await fetch(base + "/__setup/", { headers: { cookie: cookies } });
    expect(framing.headers.get("x-frame-options") === "SAMEORIGIN" && /frame-ancestors 'self'/.test(framing.headers.get("content-security-policy") || ""),
      "only this origin may frame the console");

    console.log("On a phone");
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
      storageState: await context.storageState(),
    });
    await useBridge(phone);
    const mobile = await phone.newPage();
    await mobile.goto(base + "/settings/general");
    await mobile.waitForSelector('[data-sidebar="trigger"]', { timeout: 20000 });
    await mobile.locator('[data-sidebar="trigger"]').first().click();
    await mobile.waitForSelector(ENTRY, { timeout: 10000 }).catch(() => null);
    expect(await mobile.locator(ENTRY).count() === 1, "T3's sidebar sheet has the entry too");
    await mobile.locator(ENTRY).tap();
    await mobile.waitForSelector(".t3-setup-layer[data-ready]", { timeout: 20000 }).catch(() => null);
    const sheet = await mobile.evaluate(() => {
      const panel = document.querySelector(".t3-setup-panel");
      const r = panel ? panel.getBoundingClientRect() : null;
      return { open: Boolean(panel), full: r && r.width === innerWidth && r.height === innerHeight };
    });
    expect(sheet.open && sheet.full, "it opens full screen", JSON.stringify(sheet));
    // T3's sheet animates out; it must be gone once that is over.
    const sheetGone = await mobile.waitForFunction(() => !document.querySelector('[data-mobile="true"]'), null, { timeout: 3000 })
      .then(() => true, () => false);
    expect(sheetGone, "having closed T3's sheet, as T3's own rows do");
    const phoneFrame = mobile.frames().find((f) => f.url().includes("/__setup/"));
    await phoneFrame.waitForSelector('.tc-phonebar [data-cmd="embed.close"]', { timeout: 15000 });
    await phoneFrame.locator('.tc-phonebar [data-cmd="embed.close"]').tap();
    await mobile.waitForSelector(".t3-setup-layer", { state: "detached", timeout: 5000 }).catch(() => null);
    expect(await mobile.locator(".t3-setup-layer").count() === 0, "its close button closes it");
    await phone.close();

    expect(errors.length === 0, "no script errors on T3's pages", errors.join("\n    "));
    await context.close();
  } finally {
    await browser.close();
  }
};

router.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${router.address().port}`;
  console.log(`setup-bridge-audit: T3 ${T3.origin}, console ${SETUP.origin}, routed together at ${base}`);
  let code = 0;
  try {
    await run(base);
    console.log(`\n${passed} checks passed`);
  } catch (error) {
    console.error(`\nFAIL ${error.finding ? error.message : error.stack || error}`);
    code = 1;
  }
  router.close();
  process.exit(code);
});
