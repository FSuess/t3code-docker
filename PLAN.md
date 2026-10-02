# T3 Code Docker — Research & Implementation Plan

> **Historical research record.** This is the original image design research.
> It describes the former `slim`/`full` product with baked runtimes and
> harnesses. The current `core`/`browser` image is documented in the
> [README](README.md).

**Goal:** a batteries-included Docker image that runs [T3 Code](https://github.com/pingdotgg/t3code)
as a headless server on a Linux box, so that a phone (T3 Code iOS/Android app) or a browser is the
*only* thing you need locally. No laptop in the loop.

Status: research complete (findings below are verified against t3code `v0.0.40` unless marked
_assumed_). Implementation tracked in [Milestones](#10-milestones).

---

## 1. What T3 Code is, and what that means for a container

T3 Code is **not** a coding agent. It is a *control surface* that drives agent CLIs ("harnesses")
that you install and authenticate yourself. It ships:

- a **server** (Node, npm package `t3`, binary `t3`) that owns the execution boundary — it runs the
  provider processes, git, shells, and the filesystem;
- a **web app** bundled into that server and served on the same origin;
- **desktop** (Electron) and **mobile** (iOS/Android) clients that connect to a server over a single
  authenticated WebSocket.

The mobile and web clients never execute anything themselves. That is exactly why the "server in
Docker + phone as client" model works: it is the deployment the architecture was designed for.

State lives in `$T3CODE_HOME/userdata/state.sqlite` (Node's built-in SQLite).

### Consequences for the image

| T3 Code fact | What the image must do |
| --- | --- |
| Server runs provider CLIs as child processes | Ship the harness CLIs *and* their runtime deps |
| Server owns git, worktrees, checkpoints | Ship `git` (+ `git-lfs`), and persist the workspace |
| Server runs terminals via `node-pty` | Ship a PTY-capable runtime, run as non-root, reap zombies |
| Clients are thin | The container is the whole product surface; it must be reachable |
| Providers authenticate per-machine | Credential dirs must be on a persistent volume |

---

## 2. Verified findings (hands-on)

These were checked by installing `t3@0.0.40` on Linux x64 (Node 22.22) and running it, not just by
reading docs.

### 2.1 It runs headless on Linux, today

`t3 serve --host 0.0.0.0 --port 3773 <cwd>` starts, migrates its SQLite schema, and answers:

```
GET /.well-known/t3/environment
{"environmentId":"…","label":"vm","platform":{"os":"linux","arch":"x64"},"serverVersion":"0.0.40", …}
```

That endpoint is unauthenticated and cheap → **use it as the Docker `HEALTHCHECK`.**

### 2.2 The port is not stable unless you pin it

`DEFAULT_PORT = 3773`. In `web` mode (the default for the CLI) an unspecified port goes through
`findAvailablePort(3773)` — if 3773 is taken the server silently moves. In a container with a fixed
published port that would be a confusing failure. **The image must set `T3CODE_PORT` explicitly.**

### 2.3 The pairing URL printed at startup is wrong inside Docker

`t3 serve` prints a pairing URL built from `resolveHeadlessConnectionHost()`. With `--host 0.0.0.0`
that function picks *the first non-internal IPv4 interface* — i.e. the container's bridge address:

```
T3 Code server is ready.
Connection string: http://192.0.2.2:3773
Pairing URL: http://192.0.2.2:3773/pair#token=SNQTT2QAFC44
```

`192.0.2.2` is unreachable from a phone. This is the single biggest papercut of running T3 Code in a
container, and it needs a first-class fix in the image (see §6).

### 2.4 There is a clean headless pairing API — and it takes a public base URL

`t3 auth` is explicitly "the local auth control plane for headless deployments". Verified working
*while the server was running* (concurrent SQLite access is fine):

```
$ t3 auth pairing create --base-url https://t3.example.com --json --ttl 30d
{
  "id": "a6b5c999-…",
  "credential": "DXL73Y82LKSP",
  "scopes": ["orchestration:read","orchestration:operate","terminal:operate","review:write","relay:read"],
  "expiresAt": "2026-10-08T19:14:12.127Z",
  "pairUrl": "https://t3.example.com/pair#token=DXL73Y82LKSP"
}
```

This is the mechanism the image will wrap. Also available: `t3 auth pairing list|revoke`,
`t3 auth session issue|list|revoke`.

### 2.5 Cross-origin is already permitted in production mode

`browserApiCorsLayer` only pins an origin allowlist when a **dev** URL is configured. A packaged
server (our case) uses the default wildcard origin without credentials, and clients authenticate
with a bearer token. So **the hosted web app at `app.t3.codes` can talk to our container directly**,
provided we terminate HTTPS in front of it. No `T3CODE_DEV_ALLOWED_ORIGINS` tinkering needed.

### 2.6 `node-pty` compiles from source on Linux

The upstream devcontainer says it outright, and the install here confirmed it: prebuilds ship for
win32/darwin only, and `node_modules/node-pty/build/Release/pty.node` was produced locally. So the
**build stage needs `python3`, `make`, `g++`**. Missing them = no terminals.

### 2.7 The install is large, and arch-specific

`npm i t3` → **564 MB** of `node_modules`, dominated by:

- `@anthropic-ai/claude-agent-sdk-linux-x64` — 206 MB (platform-specific optional dep)
- `t3` itself — 170 MB
- `node-pty` — 63 MB (build artifacts)

Implication: the image is inherently chunky, and multi-arch builds pull a *different* Anthropic SDK
binary per platform. Both are fine, but size expectations should be set honestly in the README.

### 2.8 Providers supported by the server

Drivers present in `apps/server/src/provider/Drivers/`: **Claude, Codex, Cursor, Grok, OpenCode,
Antigravity**. There is **no DeepSeek driver** — see §8.

### 2.9 The built-in browser tools are hosted by the *client*, not the server

T3 Code ships an MCP toolkit with real browser automation — `preview_open`, `preview_navigate`,
`preview_snapshot`, `preview_click`, `preview_type`, `preview_press`, `preview_scroll`,
`preview_evaluate`, `preview_wait_for`, `preview_recording_start/stop`.

But the server only *brokers* these: `PreviewAutomationBroker` dispatches to a connected client that
volunteers as a host, and the host implementations live in `apps/web/src/components/preview/` and
`apps/desktop/src/preview/`. Nothing in `apps/mobile` implements it. Errors like
`PreviewAutomationNoAvailableHostError` and `PreviewAutomationUnsupportedClientError` are part of the
contract.

**So: with only a phone connected, the agent has no eyes.** That is the strongest argument for
shipping a server-side headless browser in the image (see §7). _Assumed:_ the exact mobile-client
behaviour — worth re-checking when the mobile app gains preview hosting.

### 2.10 Out of scope for a server container

- **SnapShots** (window capture) — desktop app only, needs a Wayland session.
- **`t3 service install`** — systemd *user* services with lingering. Docker's supervisor is the
  container runtime; we run `t3 serve` in the foreground as PID 1 instead.
- **Antigravity** — needs an in-app Google sign-in and downloads its own managed runtime. Leave it
  disabled by default; document it as unsupported-but-not-blocked.

---

## 3. Design decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Base image | `node:24-trixie-slim` | `t3` needs Node `^22.16 \|\| ^23.11 \|\| >=24.10`; Debian gives glibc (musl/Alpine would break native prebuilds) |
| Variants | `slim` and `full` (default) | Not everyone wants a 5 GB image; `full` is the "batteries included" ask |
| Process model | `tini` as PID 1 → entrypoint → `exec t3 serve` | `node-pty` spawns grandchildren; without reaping you accumulate zombies |
| User | non-root `t3`, UID/GID settable via `PUID`/`PGID`, step down with `gosu` | Agents writing into a bind-mounted repo must not create root-owned files |
| State | one named volume for `/home/t3` | Captures `~/.t3` *and* every provider's credential dir in one place |
| Projects | `/workspace` bind mount | The user's actual repos |
| Port | pinned `T3CODE_PORT=3773`, `T3CODE_HOST=0.0.0.0` | §2.2 |
| TLS | optional Caddy sidecar (compose profile) | Needed for `app.t3.codes`, and for not sending pairing tokens in clear |
| Multi-arch | `linux/amd64` + `linux/arm64` | ARM servers are common and cheap |

### Explicit non-goals

- No bundled model API keys, no proxying of anyone's subscription — you bring authenticated CLIs.
- No attempt to run the Electron desktop app in the container.
- Not a multi-tenant hosting platform. One server = one environment = one user's agents.

---

## 4. Image contents

### `slim`
Enough to actually run T3 Code and drive a repo.

- Node 24 (base), `corepack` (pnpm/yarn)
- `t3`
- Harnesses: Claude Code, Codex, OpenCode, Grok, Cursor CLI
- `git`, `git-lfs`, `openssh-client`, `gh`
- `python3` + `pip` + `venv`, `build-essential` (needed anyway for `node-pty`)
- `curl`, `wget`, `ca-certificates`, `unzip`, `zip`, `jq`, `ripgrep`, `fd-find`, `less`, `vim-tiny`, `tini`, `gosu`, `qrencode`

### `full` = `slim` +
The "work on real projects" layer the user asked for.

- **Go** toolchain (official tarball, pinned)
- **Rust** via `rustup` (stable, + `cargo`, `clippy`, `rustfmt`)
- **C/C++**: `clang`, `cmake`, `pkg-config`, `gdb`
- **Bun**, **Deno** _(Bun explicitly requested; Deno is cheap to add)_
- **uv** (fast Python installs)
- **ffmpeg**, **ImageMagick**
- **Chromium** + font packages + `chrome-devtools-mcp` + `@playwright/mcp` (see §7)
- `sqlite3`, `postgresql-client`, `redis-tools` — the usual suspects for app work

Harness CLI install methods (verified against the registries):

| Harness | Install | Login | Notes |
| --- | --- | --- | --- |
| Claude Code | `npm i -g @anthropic-ai/claude-code` (2.1.263) | `claude auth login` | |
| Codex | `npm i -g @openai/codex` (0.153.4) | `codex login` | |
| OpenCode | `npm i -g opencode-ai` (1.18.29) | `opencode auth login` | linux/darwin/win, x64+arm64 |
| Grok Build | `npm i -g @xai-official/grok` | `grok login` / `XAI_API_KEY` | |
| Cursor | `curl https://cursor.com/install -fsS \| bash` | `agent login` | **no npm package** (`@cursor/cli` is 404); T3 resolves the executable as `cursor-agent` |
| Antigravity | — | in-app Google sign-in | not installed; desktop-oriented |

Pin every version via build args so a rebuild is reproducible, with a documented "bump" script.

---

## 5. Repository layout

```
.
├── PLAN.md                     # this file
├── README.md                   # quickstart + the 5-minute phone setup
├── Dockerfile                  # multi-stage; targets: slim, full
├── compose.yaml                # t3code + optional caddy/tailscale profiles
├── .dockerignore
├── .env.example
├── docker/
│   ├── entrypoint.sh           # PUID/PGID, dirs, project auto-add, exec t3 serve
│   ├── bin/t3-pair             # mint a pairing URL against T3_PUBLIC_URL, print QR
│   ├── bin/t3-doctor           # report what's installed / authenticated / reachable
│   └── bin/t3-browser-mcp      # register the headless browser MCP with each harness
├── examples/
│   ├── caddy/Caddyfile
│   └── opencode/deepseek.json  # DeepSeek via the openai-compatible provider
└── scripts/
    ├── build.sh
    └── smoke-test.sh           # boots the image, asserts health + pairing + toolchains
```

---

## 6. Remote access & pairing (the UX that has to be right)

Three supported paths, in order of how much we can automate:

1. **Reverse proxy + HTTPS (recommended).** Caddy sidecar terminates TLS for `T3_PUBLIC_URL`, proxies
   to `t3code:3773`. Works with the phone app *and* `app.t3.codes` (§2.5).
2. **T3 Connect.** `docker compose exec -it t3code t3 connect` — the CLI prints a browser link and
   accepts the returned code, so it works fine over `exec` with no callback port to forward.
3. **Tailscale.** Either run `tailscale` on the host and point `T3_PUBLIC_URL` at the tailnet name,
   or add a `tailscale` sidecar profile. `t3 serve --tailscale-serve` needs `tailscaled` *inside* the
   container — documented, not the default.

**`t3-pair` helper** — the fix for §2.3:

```
$ docker compose exec t3code t3-pair
Pairing URL: https://t3.example.com/pair#token=DXL73Y82LKSP
Expires:     2026-10-08T19:14:12Z
[ QR code rendered with qrencode -t ANSIUTF8 ]
```

It resolves the base URL from `T3_PUBLIC_URL` (or `--base-url`), calls
`t3 auth pairing create --base-url … --json`, and renders the QR the server's own startup banner
would have rendered — with an address that is actually reachable. If `T3_PUBLIC_URL` is unset it
falls back to the startup behaviour and says so loudly.

Optionally, `T3_PRINT_PAIRING_ON_START=1` mints one link at boot and logs it, for first-run setup.

**Security note to carry into the README:** the pairing token is a credential in a URL fragment.
Over plain HTTP on an untrusted network it is sniffable. Default the docs to HTTPS, keep TTLs short,
and point at `t3 auth pairing revoke` / `t3 auth session revoke`.

---

## 7. Giving the agent eyes

Two complementary layers, because §2.9 means the built-in one is not always available:

1. **T3 Code's own preview tools** — free when you drive the server from the web UI or desktop app.
   Nothing for the image to install. Just make sure the preview URL (e.g. a dev server on `:3000`)
   is reachable *from the client*: document publishing project ports, or using `t3.json` `previewUrl`.
2. **Server-side headless browser (the image's job).** Install Chromium plus both
   `chrome-devtools-mcp` and `@playwright/mcp` globally, and set
   `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, `PUPPETEER_SKIP_DOWNLOAD=1`,
   `CHROME_PATH=/usr/bin/chromium` so nothing tries to re-download a browser at runtime.

   `t3-browser-mcp` then registers the chosen server with whichever harnesses are present
   (`claude mcp add …`, Codex's `config.toml`, OpenCode's `opencode.json`). This gives the agent
   screenshots, DOM snapshots, console logs, and network traces regardless of which client is
   connected — including "phone only".

   Chromium in a container needs `--no-sandbox` (or `--cap-add=SYS_ADMIN` / a seccomp profile).
   Default to the flag and document the trade-off.

Also ship the font packages — a headless Chromium without fonts renders CJK and emoji as boxes,
which quietly makes every screenshot the agent takes misleading.

---

## 8. The DeepSeek question

There is **no DeepSeek harness in T3 Code** (§2.8), and none announced. DeepSeek is reachable two
ways, both of which the image will support:

1. **Through OpenCode** — it speaks 75+ providers via models.dev/AI SDK. Ship
   `examples/opencode/deepseek.json` configuring DeepSeek through `@ai-sdk/openai-compatible`
   against `https://api.deepseek.com`, activated when `DEEPSEEK_API_KEY` is set.
2. **Through a provider instance's env vars** — T3 Code lets each provider instance carry its own
   environment (API keys, custom base URL), so a Claude or Codex instance can be pointed at an
   OpenAI/Anthropic-compatible DeepSeek endpoint without touching the image.

Document both; don't pretend there's a native driver.

---

## 9. Runtime contract

| Env var | Default | Meaning |
| --- | --- | --- |
| `T3CODE_PORT` | `3773` | pinned, see §2.2 |
| `T3CODE_HOST` | `0.0.0.0` | bind all interfaces inside the container |
| `T3CODE_HOME` | `/home/t3/.t3` | state dir (`userdata/state.sqlite`) |
| `T3_PUBLIC_URL` | *(unset)* | public base URL used to build pairing links |
| `T3_WORKSPACE` | `/workspace` | scanned for projects to auto-register |
| `T3_AUTO_ADD_PROJECTS` | `1` | `t3 project add` each git repo found one level under `/workspace` |
| `T3_PRINT_PAIRING_ON_START` | `0` | mint + log a pairing link at boot |
| `PUID` / `PGID` | `1000` | own the bind mount correctly |

Volumes: `/home/t3` (state + all provider credentials), `/workspace` (projects).
Ports: `3773`. Healthcheck: `GET /.well-known/t3/environment`.

---

## 10. Milestones

All built and verified against a live Docker daemon; `scripts/smoke-test.sh`
re-runs the checks (16 assertions on `slim`, 33 on `full`, all passing).

- [x] **M1 — Plan** (this file).
- [x] **M2 — `slim` image.** Boots, `/.well-known/t3/environment` returns 200,
      Docker healthcheck goes `healthy`, and all five harness CLIs report a
      version.
- [x] **M3 — Pairing UX.** `t3-pair` emits `https://<public>/pair#token=…` with a
      QR code, and the minted credential shows up in `t3 auth pairing list` on
      the running server.
- [x] **M4 — `full` image.** Go, Rust, clang/cmake, Bun, Deno, uv and ffmpeg all
      present; Chromium renders and screenshots a real page; **both**
      `playwright-mcp` and `chrome-devtools-mcp` complete an MCP handshake and
      navigate to a page (`scripts/browser-probe.py`).
- [x] **M5 — Compose + TLS.** `docker compose up -d` boots, auto-registers a git
      checkout under `./workspace`, and `docker compose exec t3code t3-pair`
      returns a public link. Caddy TLS lives behind `--profile tls`.
- [x] **M6 — Docs.** README covers the server → HTTPS → `t3-pair` → phone path.
- [x] **M7 — CI.** `.github/workflows/build.yml`: shellcheck + compose lint,
      builds both targets on native amd64 and arm64 runners, runs the smoke test
      on each, and on a tag pushes per-architecture images by digest and stitches
      them into one manifest list per target.

## 11. What changed while building it

Things the plan did not anticipate, found by building rather than reading:

- **`node-pty` needs no manual intervention, but the toolchain does.** With
  `build-essential` and `python3` present the global install compiles it
  silently; without them there are simply no terminals.
- **`docker exec` lands as root.** A harness signed in that way writes its
  credentials to `/root`, where the server (running as `t3`) never looks. All
  the helper commands now step down to `t3` themselves, and `t3-login` wraps the
  per-harness login commands so the footgun is hard to reach.
- **Compose interpolates the whole file regardless of active profiles.** A
  `${T3_DOMAIN:?…}` on the TLS-only Caddy service broke `docker compose up` for
  everyone not using TLS. It has a `localhost` fallback now.
- **`chrome-devtools-mcp` does work with Debian's Chromium** — but only when
  launched with `--chromeArg=--no-sandbox`; without it Chromium starts and is
  immediately lost ("Target closed"). `t3-browser-mcp` passes it.
- **Sizes.** `slim` ≈ 2.7 GB on disk (~1.1 GB pulled), `full` ≈ 4.9 GB (~2.0 GB).
  Trimming source maps and other platforms' prebuilds saves ~140 MB. The bulk is
  irreducible: `t3` pulls a 206 MB platform-specific Anthropic SDK, OpenCode
  ships two 177 MB Linux builds (baseline and modern — dropping either breaks
  someone's CPU), and Cursor's payload is 524 MB.

## 12. Resolved decisions

- **`:latest` = `full`.** "Batteries included" is the premise; `:slim` is
  published alongside and the README leads with the size table.
- **`sudo` off by default,** behind `T3_ALLOW_SUDO=1`, documented as giving the
  agent root in the container.
- **Harness versions pinned** via build args, so a rebuild is reproducible.
- **Playwright is the default browser MCP,** with chrome-devtools available;
  both are smoke-tested.

## 13. The setup service (added after first real deployments)

Running this on a panel-managed host surfaced a class of friction the original
plan missed entirely: everything before first contact assumed a shell in the
container.

The decisive finding is that **T3 Code's own welcome flow already solves the
hard part**. It checks which agents are installed and signed in, and opens a
terminal *on the environment server* with the right command ready to run — and
terminals run in this container. So agent sign-in and project import never
needed `docker exec`. What could not happen inside T3 Code was the one step that
gets you *to* T3 Code: minting a pairing link.

So the image runs a second process on port 3774 covering only that, plus the
management around it — connected clients and outstanding links, each revocable.

| Decision | Choice | Why |
| --- | --- | --- |
| In-image or sidecar | In-image | A sidecar would need the state volume, the `t3` binary and a matching uid, all of which are already here. Its only edge is isolation, which the key provides more cheaply |
| Supervision | Background restart loop under tini | `t3 serve` stays the `exec`'d foreground process, so the container's exit status tracks the thing that matters. A supervisor would report its own health instead |
| Auth | Pre-shared `T3_SETUP_KEY` | Solves the bootstrap problem cleanly: the secret arrives out of band, from the panel where the operator already is. Constant-time compare, growing delay on failures |
| One port or two | Two, with `T3_SETUP_BASE_PATH` | Serving both on one port needs a proxy in front of T3's long-lived WebSocket, where a bug breaks the product. Path-prefix mounting lets the *tunnel* route instead |
| Scope | Pairing and client management only | Anything more duplicates T3 Code's UI, which does it better |

**The trade-off, stated plainly:** unlike a pairing link, the setup key is a
*standing* ability to mint access. It is loopback-only in compose, and
`T3_SETUP_ENABLED=0` removes it once setup is done.

## 14. Still open

- Antigravity is not installed (Google sign-in happens inside the desktop app,
  and it manages its own runtime). Worth revisiting if it grows a headless path.
- `t3 serve --tailscale-serve` needs `tailscaled` in the container. Documented as
  host-side Tailscale instead; a sidecar profile is a possible follow-up.
- The mobile client does not host preview automation today (§2.9). If that
  changes, the server-side browser becomes a convenience rather than the only
  way for a phone-driven agent to see anything.
