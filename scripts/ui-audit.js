#!/usr/bin/env node
/*
 * Geometry audit for the setup console.
 *
 * Screenshots prove a page renders; they do not prove it is *square*. A circle
 * whose glyph sits a pixel high, two buttons in a row that differ by half a
 * pixel, a step tracker that wraps and leaves a connector pointing at nothing -
 * all of that reads as "off" long before anyone can say why. This measures the
 * rendered page instead of looking at it, so those are findings rather than
 * opinions.
 *
 *   node scripts/ui-audit.js [url] [key]
 *
 * Exits non-zero when it finds something.
 */
// Runs from a checkout with playwright installed, or inside the browser image,
// which already carries playwright-core and a chromium for the browser MCP.
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("playwright-core"));
}

const URL = process.argv[2] || "http://127.0.0.1:13775/";
const KEY = process.argv[3] || "k";
const CHROME = process.env.CHROME_PATH
  || (require("node:fs").existsSync("/usr/bin/chromium") ? "/usr/bin/chromium"
      : "/opt/pw-browsers/chromium-1194/chrome-linux/chrome");

// Viewports worth checking: the narrowest phone, the split point, and a desktop.
const VIEWPORTS = [[360, 800], [390, 844], [820, 1180], [1100, 1000], [1440, 900]];

const audit = () => {
  const findings = [];
  const add = (kind, detail, el) =>
    findings.push({ kind, detail, where: el ? path(el) : "" });

  const path = (el) => {
    const bits = [];
    for (let n = el; n && n.nodeType === 1 && bits.length < 4; n = n.parentElement) {
      const cls = (n.className || "").toString().trim().split(/\s+/).filter(Boolean);
      bits.unshift(n.id ? "#" + n.id : cls.length ? "." + cls[0] : n.tagName.toLowerCase());
    }
    return bits.join(" > ");
  };
  const box = (el) => el.getBoundingClientRect();
  const visible = (el) => {
    const r = box(el);
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };

  // -- 1. content clipped by its own box -----------------------------------
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const style = getComputedStyle(el);
    if (style.overflowX !== "visible" && style.overflowX !== "clip") continue;
    if (el.scrollWidth - el.clientWidth > 1 && el.clientWidth > 0) {
      add("clipped", `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`, el);
    }
  }

  // -- 2. a wrapped row that still draws its connectors ---------------------
  // A separator only means something between two items on the same line.
  for (const row of document.querySelectorAll(".tc-steps, .tc-cluster, .tc-copyrow")) {
    if (!visible(row)) continue;
    const kids = [...row.children].filter(visible);
    if (kids.length < 2) continue;
    // Compare vertical centres, not tops: a 1px connector centred against an
    // 18px step has a different top while sitting on the same visual line.
    const rows = [];
    for (const k of kids) {
      const b = box(k), mid = b.top + b.height / 2;
      const line = rows.find((r) => Math.abs(r - mid) <= 4);
      if (line === undefined) rows.push(mid);
    }
    const lineOf = (el) => {
      const b = box(el), mid = b.top + b.height / 2;
      return rows.findIndex((r) => Math.abs(r - mid) <= 4);
    };
    const seps = kids.filter((k) => k.classList.contains("tc-step-line"));
    if (rows.length === 1) continue;
    for (const sep of seps) {
      const i = kids.indexOf(sep);
      const before = kids[i - 1], after = kids[i + 1];
      if (before && after && lineOf(before) !== lineOf(after)) {
        add("dangling-separator",
            "a connector spans a line break, so it points at nothing", sep);
      }
    }
    // Wrapping is only a defect while the connectors are still drawn. Below the
    // container-query threshold they are hidden and the steps wrap as a group,
    // which is the intended narrow layout rather than a broken wide one.
    if (row.classList.contains("tc-steps") && seps.some(visible)) {
      add("wrapped-tracker",
          `step tracker wrapped onto ${rows.length} lines with connectors still drawn`
          + ` at ${Math.round(box(row).width)}px`, row);
    }
  }

  // -- 3. glyphs that are not optically centred in a fixed box --------------
  for (const el of document.querySelectorAll(".tc-step-mark, .tc-tile, .tc-iconbtn")) {
    if (!visible(el)) continue;
    const node = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    if (!node) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const ink = range.getBoundingClientRect();
    const b = box(el);
    if (!ink.width || !ink.height) continue;
    const dx = (ink.left + ink.width / 2) - (b.left + b.width / 2);
    const dy = (ink.top + ink.height / 2) - (b.top + b.height / 2);
    if (Math.abs(dx) > 0.75 || Math.abs(dy) > 0.75) {
      add("off-centre",
          `"${node.textContent.trim()}" sits ${dx.toFixed(2)}px x / ${dy.toFixed(2)}px y off centre`,
          el);
    }
  }

  // -- 4. siblings that should match but do not ----------------------------
  const groups = [
    [".tc-step-mark", "step marks"],
    [".tc-tile", "agent tiles"],
    [".tc-iconbtn", "icon buttons"],
  ];
  for (const [sel, label] of groups) {
    // Compare only within a shared parent: a 22px copy affordance in the status
    // strip and a 28px control in the chrome are different jobs, not a defect.
    const byParent = new Map();
    for (const e of [...document.querySelectorAll(sel)].filter(visible)) {
      const key = e.parentElement;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(e);
    }
    for (const els of byParent.values()) {
    if (els.length < 2) continue;
    const dims = els.map((e) => [Math.round(box(e).width * 100) / 100,
                                 Math.round(box(e).height * 100) / 100]);
    const ws = new Set(dims.map((d) => d[0])), hs = new Set(dims.map((d) => d[1]));
    if (ws.size > 1 || hs.size > 1) {
      add("uneven-siblings",
          `${label} differ: ${[...new Set(dims.map((d) => d.join("x")))].join(", ")}`, els[0]);
    }
    // A circle that is not round reads as a mistake even at 1px.
    for (const e of els) {
      const r = box(e);
      if (getComputedStyle(e).borderRadius === "50%" && Math.abs(r.width - r.height) > 0.5) {
        add("not-round", `${r.width.toFixed(2)}x${r.height.toFixed(2)}`, e);
      }
    }
    }
  }

  // -- 4b. same-class siblings in one list with different padding ----------
  // "The padding around X is off" is usually one element in a list disagreeing
  // with its neighbours rather than the whole scale being wrong.
  for (const list of document.querySelectorAll(".tc-list, .tc-deck-col, .tc-details")) {
    const kids = [...list.children].filter(visible);
    if (kids.length < 2) continue;
    const pad = (e) => {
      const c = getComputedStyle(e);
      return [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft].join("/");
    };
    // Group by class so a heading and a row are not compared with each other.
    const byClass = new Map();
    for (const k of kids) {
      const key = k.className.toString();
      if (!byClass.has(key)) byClass.set(key, []);
      byClass.get(key).push(k);
    }
    for (const [cls, group] of byClass) {
      if (group.length < 2) continue;
      const pads = new Set(group.map(pad));
      if (pads.size > 1) {
        add("uneven-padding", `"${cls}" siblings differ: ${[...pads].join(" vs ")}`, group[0]);
      }
    }
  }

  // -- 5. buttons in one action group with different heights ---------------
  for (const group of document.querySelectorAll(".tc-row-actions, .tc-dialog-foot")) {
    const btns = [...group.querySelectorAll(".tc-btn")].filter(visible);
    if (btns.length < 2) continue;
    const hs = new Set(btns.map((b) => Math.round(box(b).height * 100) / 100));
    if (hs.size > 1) {
      add("uneven-buttons", `heights ${[...hs].join(", ")} in one group`, group);
    }
    // Groups that opt into wrapping (the Agents card says so in its class, and
    // its comment says wrapping beats squeezing the name column) are measured
    // per visual line: buttons that share a line must share a top, and a
    // button on the next line is the intended layout rather than a defect.
    // Every other group must still stay on one line.
    if (group.classList.contains("tc-row-actions--wrap")) {
      const lines = [];
      for (const b of btns) {
        const top = box(b).top;
        const line = lines.find((l) => Math.abs(l.top - top) <= 2);
        if (line) line.btns.push(b);
        else lines.push({ top, btns: [b] });
      }
      for (const line of lines) {
        const tops = new Set(line.btns.map((b) => Math.round(box(b).top)));
        if (tops.size > 1) add("unaligned-buttons", `tops ${[...tops].join(", ")} in one line`, group);
      }
    } else {
      const tops = new Set(btns.map((b) => Math.round(box(b).top)));
      if (tops.size > 1) add("unaligned-buttons", `tops ${[...tops].join(", ")}`, group);
    }
  }

  // -- 6. a row's text baseline vs its chip ---------------------------------
  for (const line of document.querySelectorAll(".tc-row-nameline")) {
    const name = line.querySelector(".tc-row-name");
    const chip = line.querySelector(".tc-chip");
    if (!name || !chip || !visible(name) || !visible(chip)) continue;
    const a = box(name), c = box(chip);
    // A nameline that wrapped puts the chip on its own line on purpose; only
    // compare things the layout actually placed side by side.
    if (Math.abs(c.top - a.top) > a.height) continue;
    const dy = (c.top + c.height / 2) - (a.top + a.height / 2);
    if (Math.abs(dy) > 1.5) {
      add("chip-misaligned", `chip centre is ${dy.toFixed(2)}px off the name centre`, line);
    }
  }

  return findings;
};

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox"],   // there is no user namespace inside the image
  });
  let total = 0;

  for (const [width, height] of VIEWPORTS) {
    // Measure a settled page: reduced motion disables the transitions and
    // animations the stylesheet already gates behind that preference, so a
    // background poll cannot repaint a row mid-measurement and leave
    // half-updated geometry behind.
    const ctx = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      reducedMotion: "reduce",
    });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    await page.fill("input[type=password]", KEY);
    await page.click("button[type=submit]");
    await page.waitForSelector("#agents .tc-row-name", { timeout: 60000 });
    // A container with nothing listening renders the empty state, not a row;
    // either means the card has finished its first paint.
    await page.waitForSelector("#ports .tc-row, #ports .tc-empty", { timeout: 60000 });
    // The pairing panel is where the tracker lives, so open it.
    await page.click("#mint");
    await page.waitForSelector("#out .tc-steps", { timeout: 30000 });
    // Text metrics decide the boxes this audit compares, so wait for fonts
    // before measuring, then let the browser render two frames of the settled
    // layout.
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    await page.waitForTimeout(400);

    const findings = await page.evaluate(audit);
    const label = `${width}x${height}`;
    if (!findings.length) {
      console.log(`  ${label.padEnd(10)} clean`);
    } else {
      console.log(`  ${label.padEnd(10)} ${findings.length} finding(s)`);
      for (const f of findings) {
        console.log(`      ${f.kind}: ${f.detail}`);
        if (f.where) console.log(`        at ${f.where}`);
      }
      total += findings.length;
    }
    await ctx.close();
  }

  await browser.close();
  console.log(total ? `\n${total} finding(s)` : "\nno findings");
  process.exit(total ? 1 : 0);
})().catch((e) => { console.error("audit failed:", e.message); process.exit(2); });
