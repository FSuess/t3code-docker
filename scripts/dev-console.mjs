#!/usr/bin/env node
// A scratch T3 Code and setup console on one origin, for working on the
// console and on what the image adds to T3 Code's own pages.
//
//   node scripts/dev-console.mjs [--port 23780] [--fresh] [--verbose]
//
// Run it where T3's platform binary is (inside the image, or with
// T3_INFRA_BINARY pointing at one). It starts:
//
//   - T3 Code in a scratch home ($TMPDIR/t3-dev, kept between runs unless
//     --fresh), so nothing touches the real one;
//   - the setup console from this working tree, with the key "dev", restarted
//     whenever a file under docker/setup changes;
//   - a router on --port that sends /__setup* to the console and everything
//     else to T3, as the README's Cloudflare Tunnel setup does, and serves T3's
//     HTML shell with this working tree's setup bridge in place of the built
//     one, read fresh on every load.
//
// It prints a pairing link for a browser, and stops everything on Ctrl-C.
// scripts/setup-bridge-audit.js can be pointed at the router's T3 and console
// ports to run its checks against the same processes.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(name);
const PORT = Number(arg("--port", "23780"));
const T3_PORT = PORT + 1;
const SETUP_PORT = PORT + 2;
const HOME = join(tmpdir(), "t3-dev");
const T3_BINARY = process.env.T3_INFRA_BINARY || "/opt/t3/t3";
const BRIDGE = join(ROOT, "docker/t3-client/setup-bridge.js");
const KEY = "dev";
const VERBOSE = flag("--verbose");

if (!existsSync(T3_BINARY)) {
  console.error(`dev-console: no T3 binary at ${T3_BINARY}; set T3_INFRA_BINARY`);
  process.exit(1);
}
if (flag("--fresh")) rmSync(HOME, { recursive: true, force: true });
mkdirSync(join(HOME, "workspace"), { recursive: true });

// ---------------------------------------------------------------- children --
const children = new Set();
const start = (name, command, args, env) => {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const relay = (stream) => stream.on("data", (chunk) => {
    if (!VERBOSE && name === "t3") return;
    for (const line of String(chunk).split("\n")) if (line.trim()) console.log(`[${name}] ${line}`);
  });
  relay(child.stdout);
  relay(child.stderr);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!stopping && !child.replaced) console.log(`[${name}] exited (${signal || code})`);
  });
  return child;
};

const T3_ENV = { T3CODE_HOME: join(HOME, "t3"), T3CODE_PORT: String(T3_PORT), T3CODE_HOST: "127.0.0.1" };
start("t3", T3_BINARY, ["serve", "--host", "127.0.0.1", "--port", String(T3_PORT), "--no-browser", join(HOME, "workspace")], T3_ENV);

let console_ = null;
const startConsole = () => {
  if (console_) {
    console_.replaced = true;
    console_.kill();
  }
  console_ = start("setup", process.execPath, [join(ROOT, "docker/setup/server.mjs")], {
    ...T3_ENV,
    T3_SETUP_PORT: String(SETUP_PORT),
    T3_SETUP_KEY: KEY,
    T3_PUBLIC_URL: `http://127.0.0.1:${PORT}`,
    T3_IMAGE_VERSION: "dev",
    T3_IMAGE_VARIANT: process.env.T3_IMAGE_VARIANT || "browser",
    T3_INFRA_LAUNCHER: T3_BINARY,
  });
};
startConsole();
// The console inlines its files at startup: start it again when one changes.
// Polled rather than watched: an editor or `sed -i` that replaces a file can
// leave a watcher on the old one, and a few dozen stats a second cost nothing.
const SETUP_DIR = join(ROOT, "docker/setup");
const newest = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((latest, entry) => {
  const path = join(dir, entry.name);
  return Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
}, 0);
let seen = newest(SETUP_DIR);
setInterval(() => {
  const now = newest(SETUP_DIR);
  if (now === seen) return;
  seen = now;
  console.log("[setup] files changed; restarting");
  startConsole();
}, 1000).unref();

// ------------------------------------------------------------------ router --
const upstream = (path) => (path.startsWith("/__setup") ? SETUP_PORT : T3_PORT);
// T3 answers every app route with its shell; swap the built bridge for this one.
const isShell = (req) => req.method === "GET" && !/^\/(__setup|api|assets|ws|oauth|\.well-known)/.test(req.url)
  && !/\.\w+(\?|$)/.test(req.url) && /text\/html/.test(String(req.headers.accept || ""));

const router = http.createServer((req, res) => {
  const shell = isShell(req);
  const headers = { ...req.headers };
  if (shell) delete headers["accept-encoding"];
  const forward = http.request({ host: "127.0.0.1", port: upstream(req.url), path: req.url, method: req.method, headers }, (answer) => {
    const type = String(answer.headers["content-type"] || "");
    if (!shell || !type.includes("text/html")) {
      res.writeHead(answer.statusCode, answer.headers);
      answer.pipe(res);
      return;
    }
    const chunks = [];
    answer.on("data", (c) => chunks.push(c));
    answer.on("end", () => {
      const bridge = readFileSync(BRIDGE, "utf8");
      const body = Buffer.concat(chunks).toString("utf8")
        .replace(/<script data-t3-setup-bridge>[\s\S]*?<\/script>\n?/, "")
        .replace("</body>", `<script data-t3-setup-bridge>\n${bridge}</script>\n</body>`);
      const out = { ...answer.headers, "content-length": String(Buffer.byteLength(body)) };
      delete out["content-encoding"];
      res.writeHead(answer.statusCode, out);
      res.end(body);
    });
  });
  forward.on("error", () => { res.writeHead(502); res.end("not up yet"); });
  req.pipe(forward);
});
router.on("upgrade", (req, socket, head) => {
  const forward = net.connect(upstream(req.url), "127.0.0.1", () => {
    forward.write(`${req.method} ${req.url} HTTP/1.1\r\n`
      + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
    forward.write(head);
    socket.pipe(forward).pipe(socket);
  });
  forward.on("error", () => socket.destroy());
  socket.on("error", () => forward.destroy());
});

// ------------------------------------------------------------------- ready --
// T3 opens its port before it answers, so each try gives up after a moment.
const up = (port) => new Promise((resolve) => {
  const tryOnce = (left) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/" }, (r) => { r.resume(); resolve(true); });
    req.setTimeout(2000, () => req.destroy(new Error("no answer yet")));
    req.on("error", () => (left ? setTimeout(() => tryOnce(left - 1), 500) : resolve(false)));
  };
  tryOnce(120);
});

router.listen(PORT, "127.0.0.1", async () => {
  const [t3, setup] = await Promise.all([up(T3_PORT), up(SETUP_PORT)]);
  if (!t3 || !setup) {
    console.error(`dev-console: ${t3 ? "the console" : "T3"} did not start; run with --verbose`);
    return stop(1);
  }
  let link = "";
  try {
    const out = execFileSync(T3_BINARY, ["auth", "pairing", "create", "--base-url", `http://127.0.0.1:${PORT}`, "--label", "Dev browser", "--ttl", "1h", "--json"],
      { env: { ...process.env, ...T3_ENV }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    link = JSON.parse(out.slice(out.indexOf("{"))).pairUrl;
  } catch {
    link = "(could not create one; run `t3 auth pairing create` with T3CODE_HOME=" + T3_ENV.T3CODE_HOME + ")";
  }
  console.log([
    "",
    `  T3 Code       http://127.0.0.1:${PORT}/`,
    `  Setup         http://127.0.0.1:${PORT}/__setup/   (key: ${KEY})`,
    `  Pair a browser ${link}`,
    `  Audit         T3_PAIR_CREDENTIAL=… node scripts/setup-bridge-audit.js --t3 http://127.0.0.1:${T3_PORT} --setup http://127.0.0.1:${SETUP_PORT}`,
    "",
    "  Ctrl-C stops everything.",
    "",
  ].join("\n"));
});

let stopping = false;
const stop = (code = 0) => {
  stopping = true;
  router.close();
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 300);
};
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
