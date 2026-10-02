<div align="center">

<img src="docs/media/banner.png" alt="t3code-docker" width="100%">

<p>
  <a href="https://github.com/dizys/t3code-docker/actions/workflows/build.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/dizys/t3code-docker/build.yml?branch=main&style=flat-square&label=build"></a>
  <a href="https://github.com/dizys/t3code-docker/pkgs/container/t3code-docker"><img alt="Image" src="https://img.shields.io/badge/ghcr.io-t3code--docker-2496ED?style=flat-square&logo=docker&logoColor=white"></a>
  <a href="https://github.com/dizys/t3code-docker/releases"><img alt="Release" src="https://img.shields.io/github/v/tag/dizys/t3code-docker?style=flat-square&label=release&color=2563eb"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platforms-amd64%20%7C%20arm64-444?style=flat-square">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-444?style=flat-square"></a>
</p>

<p><strong>Run <a href="https://github.com/pingdotgg/t3code">T3 Code</a> as a headless server in a container,<br>
with the agent harnesses and language toolchains set up on first start.</strong></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/setup-dark.png">
  <img src="docs/media/setup-light.png" alt="The setup page, on desktop and phone" width="100%">
</picture>

</div>

T3 Code is a control surface for coding agents: the **server** runs the agents,
git, and your terminals, while the desktop, web, and phone apps are thin clients
over a single WebSocket. That split is what makes this work — put the server on
a box somewhere, and a phone is enough to drive it. No laptop in the loop.

This image is the server half, packaged: every agent CLI and the toolchains
they reach for, installed onto your volume the first time it starts, a headless
browser so they can see web pages, and a setup page that pairs a device and
signs the agents in without a shell.

> [!NOTE]
> T3 Code is alpha software and moves fast. So does this image.

## Highlights

- **A phone is enough.** Pair a device from a web page — QR or link, no terminal.
- **Agents sign in from the browser.** Every CLI's own flow, driven from the
  setup page: a URL and a QR to approve on your phone, a field for the code
  where one comes back. Credentials land on the state volume and survive a
  recreate.
- **Batteries included, kept on the volume.** Claude Code, Codex, OpenCode,
  Cursor and Grok; Go, Rust, Bun, Deno and uv. They install on the first start,
  in the background, at exact recorded versions - so the image stays small, a
  pull never resets them, and Update is a button rather than a new image. Node,
  Python, clang, ffmpeg, ImageMagick and psql are in the image itself.
- **Agents can see.** Headless Chromium plus Playwright and Chrome DevTools MCP
  servers, wired into Claude Code, Codex and OpenCode.
- **Show your dev server to your phone.** A port listening in the container is
  reachable from nowhere. Publish it from the setup page or with `t3-expose
  3000` and get a public https URL and a QR code - no DNS, no certificate, no
  port forwarding. Both routes drive the same API, so neither can go stale.
- **Multi-arch, and actually tested.** `linux/amd64` and `linux/arm64` each
  built *and* smoke-tested on their own native runner — dozens of assertions
  against a booted container, plus an end-to-end harness lifecycle run, before
  anything is published.
- **The image says what it is.** The setup page shows the release tag it was
  built from, so a pull can be confirmed rather than assumed.

## Contents

- [Quickstart](#quickstart)
- [What's in the box](#whats-in-the-box)
- [First run: the setup UI](#first-run-the-setup-ui)
- [Connecting a phone](#connecting-a-phone)
- [Publishing a port](#publishing-a-port)
- [Giving agents eyes](#giving-agents-eyes)
- [Harnesses](#harnesses)
- [Toolchains](#toolchains)
- [How long things last](#how-long-things-last)
- [Configuration](#configuration)
- [Building](#building)
- [Security](#security)
- [Troubleshooting](#troubleshooting)

## Quickstart

```bash
git clone https://github.com/dizys/t3code-docker
cd t3code-docker
cp .env.example .env      # then edit T3_PUBLIC_URL, PUID/PGID, T3_WORKSPACE_HOST
docker compose up -d --build
```

Prebuilt images are published to `ghcr.io/dizys/t3code-docker` — `:latest`
(also `:browser`, and `:full` for anyone still on the old name) for the full
image, `:core` (also `:slim`) for the same without the browser. They are
multi-arch manifests covering `linux/amd64` and `linux/arm64`, with each
architecture built *and* tested on its own native runner, so `docker pull`
resolves to the right one on an ARM server. (`v0.1.0` predates this and is
amd64-only.) To run a published image instead of building, set `T3_IMAGE` in
`.env` and drop `--build`.

The first start installs the agents and toolchains onto the `/home/t3` volume
in the background; it takes a few minutes on a decent connection, and the
setup page shows it happening. Meanwhile open the setup UI on port **3774**,
enter your `T3_SETUP_KEY`, and press **Create pairing link**. Scan the QR with
the T3 Code app, or open the link in a browser.

From there you are inside T3 Code. Sign each agent in from the setup page's
**Agents** card, through its own browser flow, then enable the provider under
**Settings → Providers**.

That is the whole path — no shell in the container at any point. `docker exec`
is a fallback, not the route:

```bash
docker compose exec t3code t3-doctor             # what's installed, signed in, healthy
docker compose exec t3code t3-harness list       # agents and their exact versions
docker compose exec -it t3code t3-login claude   # if you prefer a shell to the UI
```

## What's in the box

| | `browser` (`latest`) | `core` |
| --- | :---: | :---: |
| T3 Code server + web app | ✅ | ✅ |
| git, git-lfs, gh, ssh, Node, Python | ✅ | ✅ |
| clang/CMake/GDB, ffmpeg, ImageMagick, psql, redis-cli | ✅ | ✅ |
| Claude Code, Codex, OpenCode, Grok, Cursor CLIs | first start | first start |
| Go, Rust, Bun, Deno, uv | first start | first start |
| mise, for per-project versions | ✅ | ✅ |
| Headless Chromium + browser MCP servers | ✅ | — |
| cloudflared, for publishing a port | ✅ | ✅ |
| Image size, unpacked (download) | ~2.5 GB (~1.0 GB) | ~1.9 GB (~0.7 GB) |

"First start" means the container installs them onto the `/home/t3` volume the
first time it runs, in the background, and never again: about 2.5 GB that lives
on the volume you already keep rather than in every pull. `T3_PREINSTALL`
narrows it (`agents`, `toolchains`, a list like `claude,codex,go`) or turns it
off (`none`); anything you leave out is one click away on the setup page.

Neither image contains credentials or model access. You bring harnesses you have
already paid for and sign them in yourself.

## First run: the setup UI

The container runs a small setup page on port **3774**, next to T3 Code itself
on 3773. It exists for exactly one job — minting a pairing link — because that
is the only step that cannot happen inside T3 Code, since it is what gets you
*to* T3 Code. Adding a device needs neither a shell in the container nor a
restart.

Set a password for it when you create the container:

```
T3_SETUP_KEY=<something long>
T3_PUBLIC_URL=https://t3.example.com
```

Leave `T3_SETUP_KEY` empty and one is generated at boot and printed to the log;
setting it yourself keeps it stable when the container is recreated. Then open
port 3774, enter the key, and press **Create pairing link** — you get a URL and
a QR code built against your public address, valid for as long as you choose.
The same panel shows the **pair code** on its own, for clients like the desktop
app that ask for a server URL and a code as separate fields. The page also
shows whether the server is healthy, whether `T3_PUBLIC_URL` is set, and which
agents are signed in.

Beyond pairing it is a small management surface: connected clients with a
**Revoke** button each, outstanding unredeemed links with the same, the
environment status, an **Agents** card that signs your coding agents in (and
installs, updates or removes them), and a **Toolchains** card that does the same
for Go, Rust, Bun, Deno and uv. While the first start is still installing, a
banner at the top says what it is on.

The top bar shows which image is running — `v0.5.0 · browser` — alongside the
server's health, so a pull can be confirmed from the page instead of guessed at.
It reads a build stamp baked in at image build time: the release tag in CI, and
`dev` for a local build.

Creating a link tracks it: once the device it was made for appears, the panel
flips to **Paired** with an **Open T3 Code** button, and says so if the link
expires or is revoked before anyone uses it.

When the console is reachable at `/__setup` on the same hostname — the routing
in [Exposing it through one hostname](#exposing-it-through-one-hostname) — T3
Code's own pairing screen shows a small **Setup** button in the bottom-left
corner that comes back here, so a device that lands on the pairing screen first
is not a dead end. It appears only on the pairing screens, where no T3 Code
controls live, and renders nothing when the console is not routed there.

### Signing agents in, and keeping them current, from the page

The agents are not baked into the image; the first start installs them onto
the volume. Each row of the **Agents** card shows the exact version installed
and points T3 Code at that executable, and **Update** and **Uninstall** are
buttons on the same row: Update moves to the newest release (or one you type),
and a download carries on in the background with the row showing progress, so
a slow connection or a tunnel's request timeout does not matter. If an update
fails, the previous version stays installed and working. Nothing installs or
updates just because a poll ran. From a shell:

```bash
docker compose exec t3code t3-harness list
docker compose exec t3code t3-harness update codex
docker compose exec t3code t3-harness install claude --version 2.1.285
docker compose exec t3code t3-harness uninstall grok
```

Uninstall removes the executable and the T3 Code wiring but keeps credentials
and user data, so installing again gets you straight back to signed in. An
agent you uninstall stays uninstalled for as long as the home volume lives;
the first-start install does not bring it back. If you set an agent's binary
path yourself in T3 Code's provider settings, that path is left alone.

Each installed agent gets the sign-in actions it actually supports, established
by running the CLIs rather than reading about them:

| Agent | Sign in | API key |
| --- | --- | --- |
| Claude Code | `auth login` — shows a URL, takes the code back | — |
| Codex | device code — `login --device-auth` | stored via `login --with-api-key` |
| OpenCode | — | pick a provider, key written to its `auth.json` |
| Cursor | browser flow, polls to completion | — |
| Grok Build | device code — URL plus a code to confirm | — |

**Sign in** shows the URL as a link and a QR code, so you can approve it on the
phone in your hand; where the CLI wants the code pasted back, a field appears
for it. Nothing is typed into a terminal, and the page never becomes one — it
runs the CLI and reads what it prints.

<p align="center">
  <img src="docs/media/agent-signin.png" alt="Signing Claude Code in from the setup page" width="100%">
</p>

The signed-in badge asks each CLI rather than looking for a credentials file, so
a credential that never touches disk still reads correctly — `ANTHROPIC_API_KEY`
and `CLAUDE_CODE_OAUTH_TOKEN` in the container environment both count, which is
what T3 Code itself honours:

| Agent | Read from |
| --- | --- |
| Claude Code | `claude auth status --json` |
| Codex | `codex login status` |
| Cursor | `cursor-agent status --format json` |
| Grok Build | `grok models`, plus `XAI_API_KEY` — same as T3 Code |
| OpenCode | its `auth.json`, which is where its keys live |

Grok has no status command and its credentials file is not evidence: a file of
exactly the shape its own help text documents still leaves the CLI reporting
"You are not authenticated". Asking it costs a quarter of a second. Where an
answer genuinely cannot be had, the badge says "Sign-in state not readable"
rather than guessing at one.

OpenCode takes a key per provider, and there are over two hundred, so the page
offers the [models.dev](https://models.dev) catalog as a picker with a **Other —
type an id** entry for anything not in it. The catalog is fetched once and
cached on the state volume, so it survives restarts and keeps working offline.

You can still use T3 Code's own setup flow instead, which opens a terminal on
this machine with the command ready to run. Both write to the same place. Revoking a client's session drops that device; it does
not touch your threads, projects or provider logins.

`T3_SETUP_ENABLED=0` turns it off once you are set up.

### Exposing it through one hostname

Two ports normally means two public hostnames. To avoid that, route by path —
the setup UI works under any prefix without being told about it, since the
request carries the prefix already. With Cloudflare Tunnel, two public hostname
entries on the same domain:

| Hostname | Path | Service |
| --- | --- | --- |
| `t3.example.com` | `__setup*` | `http://127.0.0.1:3774` |
| `t3.example.com` | *(none)* | `http://127.0.0.1:3773` |

Order matters: the more specific path rule has to come first. The setup UI is
then at `https://t3.example.com/__setup`, and T3 Code keeps the root. No
container configuration is needed for this; `T3_SETUP_BASE_PATH` exists only to
pin the prefix explicitly if you want to reject every other path.

Leaving it on a second hostname works just as well, and keeping it off the
public internet entirely — reachable only over your LAN or tailnet — is the
safest option of the three.

**Treat the key like a password.** Anything it can do, a pairing link can do —
the difference is that it can issue them repeatedly. The port is loopback-only
in `compose.yaml`; publish it only as far as you need.

Everything after pairing belongs to T3 Code's own setup flow, which checks your
agents and **opens a terminal on this machine with the right sign-in command
ready to run**. You do not need `docker exec` for that.

## Connecting a phone

The server's own startup banner prints a pairing URL built from the container's
network interface — something like `http://172.17.0.2:3773/pair#token=…`. Your
phone cannot reach that. Use `t3-pair` instead, which mints the same kind of
link against the address you actually serve on:

```bash
docker compose exec t3code t3-pair
```

```
Pairing URL: https://t3.example.com/pair#token=A2VYN48RS2CG
Expires:     2026-10-08T19:40:13.911Z
Revoke with: t3 auth pairing revoke bb46fa34-…

█▀▀▀▀▀█ ▀█ ▄ ▄▀▄▀▀▄▀▄▀ ▀▀ █▀▀▀▀▀█
… QR code …
```

Scan it with the T3 Code app
([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824),
[Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), or
paste the URL into **Add environment**.

`t3-pair` reads `T3_PUBLIC_URL`; override per invocation with
`t3-pair --base-url https://other.host --ttl 7d --label "my phone"`.

**Ignore the server's own startup banner.** It advertises the container's bridge
address, and its token is issued with a five-minute TTL, so it has almost always
expired by the time you have a tunnel up. `t3-pair` replaces both.

### Pairing without a shell in the container

If your host panel makes `docker exec` awkward, set `T3_PRINT_PAIRING_ON_START=1`
alongside `T3_PUBLIC_URL`. Every start then mints a fresh 30-day link and writes
it to the container log, where any panel's log viewer will show it:

```
[t3code] pairing link for this environment (use this one, not the banner):
Pairing URL: https://t3.example.com/pair#token=XZB9QYQQUXFB
Expires:     2026-10-09T07:36:14.314Z
```

Set `T3_PAIR_TTL` to change how long those links last. Note that this puts a
credential in your logs — fine if only you can read them, otherwise pair on
demand instead.

Pairing is per device and one-time, but you only do it **once per device**: the
resulting session lives in `state.sqlite` on the `/home/t3` volume, so it
survives restarts and image upgrades.

### Getting a public URL

Pick one:

**Caddy sidecar (automatic HTTPS).** Set `T3_DOMAIN` to a hostname pointed at
this machine, make sure ports 80 and 443 are reachable, and:

```bash
docker compose --profile tls up -d
```

This is also what the hosted web app at [app.t3.codes](https://app.t3.codes)
needs — it connects straight to your server, over HTTPS only.

**T3 Connect.** Sign the machine in and let T3's relay handle reachability.
Devices then attach by account rather than by redeeming a pairing token, and
Connect renews their credentials, so you are not re-pairing every 30 days:

```bash
docker compose exec -it t3code t3-login connect
```

This authorizes the environment; it does not start or disturb the running
server, and the link takes effect **on the next start** — so restart the
container afterwards. Use `t3-login connect` rather than `t3 connect` directly:
`docker exec` lands as root, and Connect writes into the state directory, where
root-owned files would leave the server unable to write.

**Tailscale.** Run Tailscale on the host and set `T3_PUBLIC_URL` to the tailnet
name. (`t3 serve --tailscale-serve` wants `tailscaled` inside the container;
this image does not ship it.)

**Nothing at all.** On a trusted LAN you can set `T3_BIND_ADDR=0.0.0.0` and
`T3_PUBLIC_URL=http://<server-lan-ip>:3773`. The pairing token travels in the
clear, so do not do this on a network you do not control.

## Publishing a port

Start a dev server in the container - yourself in a T3 Code terminal, or an
agent doing it for you - and it listens on a port that nothing outside the
container can reach. Not the phone in your hand, not the browser on your
laptop. Docker's own answer is to publish the port when the container starts,
which means predicting the port before you know it, and still leaves you
without TLS or a route in from outside your LAN.

So the setup page has a **Ports** panel. It lists what is listening, including
servers bound to `127.0.0.1`, which is the usual default and the case that most
needs help. Press **Publish** and you get a public `https://` URL and a QR code
to open it on another device:

<p align="center">
  <img src="docs/media/ports-panel.png" alt="The Ports panel, listing what is listening in the container" width="100%">
</p>

The same thing from a terminal:

```bash
t3-expose 3000        # publish it; prints the URL and a QR code
t3-expose             # what is listening, and what is published
t3-expose stop 3000   # take it down
```

`t3-expose` is a client of the setup server's `/ports` API - the same API the
panel calls - not a second implementation. Publish from the terminal and the
panel shows it; press Stop in the panel and the terminal agrees. There is one
place tunnels are started, so the two cannot drift apart.

Underneath is a [Cloudflare quick
tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):
no account, no DNS record, no certificate. `cloudflared` ships in the image
pinned to the release T3 Code itself asks for, which also stops T3 Code
downloading its own copy at runtime for its managed tunnels.

Two things worth knowing:

- **The URL is public while it is published.** It is random and unguessable,
  and it stops working the moment you take it down, but anyone holding it can
  reach that port. Publish a dev server, not your database.
- **It needs egress to Cloudflare's edge** - outbound UDP 7844, or HTTP/2 to
  `argotunnel.com`. On a network that blocks both, publishing fails with that
  message rather than handing you a URL that answers 530.

## Giving agents eyes

T3 Code ships browser tools (`preview_open`, `preview_snapshot`,
`preview_click`, …), but the **server only brokers them** — a web or desktop
client hosts the actual browser. Drive the server from a phone alone and there
is no host, so the agent is blind.

The `browser` variant fixes that with a browser of its own:

```bash
docker compose exec t3code t3-browser-mcp              # playwright, all harnesses
docker compose exec t3code t3-browser-mcp --server chrome-devtools --harness claude
docker compose exec t3code t3-browser-mcp --remove
```

That registers a headless Chromium as an MCP server with the managed Claude
Code, Codex, and OpenCode harnesses, so the agent can navigate, screenshot,
click, and read the console whatever client you are on. Run it once the first
start has installed those agents (the setup page shows when). Start a new
thread afterwards — providers read their MCP configuration at session start.

Playwright is the default: `chrome-devtools-mcp` officially supports Google
Chrome rather than Debian's Chromium. It does work here — `t3-browser-mcp`
passes it the sandbox flags it needs — but it is the less tested path.

## Harnesses

All five install on the first start (unless `T3_PREINSTALL` says otherwise)
into `/home/t3/.local/share/mise`, at an exact recorded version, so they survive
a recreate with the rest of the volume. Sign them in from the setup page — each
one's own flow, a URL and a QR to approve on your phone, a field for the code
where one comes back. The `t3-login` column is the shell equivalent — it exists
because `docker exec` lands as root, and a harness signed in as root writes its
credentials somewhere the server never looks.

| Harness | Provider in T3 Code | Shell equivalent |
| --- | --- | --- |
| Claude Code | Claude | `t3-login claude` |
| Codex | Codex | `t3-login codex` |
| OpenCode | OpenCode | `t3-login opencode` |
| Cursor | Cursor (executable `cursor-agent`) | `t3-login cursor` |
| Grok Build | Grok Build | `t3-login grok` |

Antigravity is not installed: it signs in through Google inside the desktop app
and manages its own runtime.

**DeepSeek** has no T3 Code driver. Reach it through OpenCode — see
[`examples/opencode/`](examples/opencode/) — or by pointing a provider instance's
environment variables at a compatible endpoint.

## Toolchains

Go, Rust (with clippy and rustfmt), Bun, Deno and uv install on the first start
alongside the agents, through [mise](https://mise.jdx.dev/), into the persistent
home, and work in every directory. The **Toolchains** card on the setup page
updates or removes each one, or installs one you left out of `T3_PREINSTALL`.
Node and Python come with the image.

Projects can still ask for their own versions: mise reads whatever the project
already declares — `mise.toml`, `.tool-versions`, or idiomatic files like
`.nvmrc`, `go.mod` and `rust-toolchain.toml` — so two projects can want two
different Node versions, and an agent that runs `node` in a project directory
gets that project's Node:

```bash
docker compose exec -u t3 -w /workspace/myapp t3code mise install       # what mise.toml asks for
docker compose exec -u t3 -w /workspace/myapp t3code mise use node@22   # pins it, exactly
```

Two policies are worth knowing, both set in `/etc/mise/config.toml`:

- **Nothing updates on its own.** `mise use` records the resolved exact
  version rather than a floating selector.
- **No silent fallback.** If mise cannot provide a declared tool it fails
  rather than quietly running a different one from `PATH`.

Toolchains land in `/home/t3/.local/share/mise` (Rust's in `~/.rustup` and
`~/.cargo`) and survive a recreate with the rest of the volume. They are not
small — the default set is a bit over 1 GB — but that weight sits on the volume
you already keep, not in every pull.

### Upgrading from `slim`/`full`

The old images baked the agents and runtimes in; `browser` and `core` replace
`full` and `slim`, and `:full`, `:slim` and `:latest` now point at them, so a
plain `docker compose pull` is the upgrade. On the first start of the new image
the agents and toolchains install onto your volume in the background, and your
state, credentials, threads and projects are untouched — so once the setup page
says it is done, the agents come back already signed in.

If you build locally, rename the target in `.env`:

```bash
T3_IMAGE=t3code:browser       # was t3code:full
T3_BUILD_TARGET=browser       # or core, for what was slim
```

The `v0.4.x` tags keep the old baked images if you need to roll back.

## How long things last

Three different clocks, which is one more than is comfortable:

| | Lifetime | When it runs out |
| --- | --- | --- |
| The server's **startup banner** token | **5 minutes** | Ignore it entirely; it also names the container's own address |
| A **pairing link** | `T3_PAIR_TTL`, default 30 days | Mint another. Single-use, so one per device anyway |
| A paired **client session** | **30 days** | The device re-pairs |

The session clock is the one that matters, and nothing in the server slides it
forward on use. So expect to re-pair each device about monthly — a few seconds
in the setup UI. To avoid it entirely, use **T3 Connect**, which renews client
credentials rather than expiring them.

None of this touches your data: threads, projects, provider logins and history
live in `state.sqlite` on the `/home/t3` volume. Re-pairing drops you straight
back into everything.

## Configuration

Environment variables (all optional except where noted):

| Variable | Default | Meaning |
| --- | --- | --- |
| `T3_PUBLIC_URL` | — | Public base URL for pairing links. Set this. |
| `T3CODE_PORT` | `3773` | Server port inside the container |
| `T3CODE_HOST` | `0.0.0.0` | Bind interface inside the container |
| `T3CODE_HOME` | `/home/t3/.t3` | State directory (`userdata/state.sqlite`) |
| `T3_WORKSPACE` | `/workspace` | Scanned for projects |
| `T3_AUTO_ADD_PROJECTS` | `1` | Register each git checkout under the workspace |
| `T3_PRINT_PAIRING_ON_START` | `0` | Mint and log a pairing link on boot |
| `T3_PREINSTALL` | `all` | What the first start installs onto the volume: `all`, `agents`, `toolchains`, ids like `claude,go`, or `none` |
| `T3_PAIR_TTL` | `30d` | How long links from `t3-pair` stay redeemable |
| `T3_SETUP_ENABLED` | `1` | Run the setup UI |
| `T3_SETUP_KEY` | *(generated)* | Password for the setup UI. Set it to keep it stable. |
| `T3_SETUP_PORT` | `3774` | Setup UI port inside the container |
| `T3_SETUP_BASE_PATH` | — | Mount the setup UI under a path, e.g. `/__setup` |
| `T3_ALLOW_SUDO` | `0` | Give agents passwordless sudo in the container |
| `DEEPSEEK_API_KEY` | — | Used by the DeepSeek-through-OpenCode example |
| `PUID` / `PGID` | `1000` | Own the workspace bind mount correctly |

Volumes:

- `/home/t3` — state, agent credentials, installed harnesses and toolchains,
  shell history. Back this up.
- `/workspace` — your repositories.

Installed harnesses and toolchains live under `/home/t3/.local/share/mise`, so
they persist with the whole home mounted. A state-only mount (`/home/t3/.t3`)
keeps your credentials and threads, and the next start simply installs the
tools again.

Agent sign-ins normally land in `~/.claude`, `~/.codex`, `~/.cursor`, `~/.grok`
and OpenCode's XDG directories, which only persist if the whole home is mounted.
The container anchors them under `$T3CODE_HOME/agents` and links them back, so
signing in once holds even for a deployment that mounted only the state
directory. Set `T3_PERSIST_AGENT_CREDENTIALS=0` to leave them where the CLIs put
them.

**Watch for anonymous volumes.** Because the image declares `VOLUME`, running
with no `-v` still gives you a mount, and it still looks persistent from inside
— but recreating the container makes a fresh one and every sign-in, thread and
project goes with the old one. The container detects this and says so at boot:

```
[t3code] WARNING: /home/t3 is an anonymous volume. It survives a restart, but
[t3code]          recreating this container creates a new one and every agent
[t3code]          sign-in, thread and project is lost.
```

A named volume or a host directory reports the opposite, naming what it found.

Helper commands inside the container: `t3-pair`, `t3-login`, `t3-doctor`,
`t3-harness`, `t3-expose`, `t3-browser-mcp`. All of them step down from root
automatically, so plain `docker compose exec` is safe.

## Building

```bash
scripts/build.sh                                 # t3code:browser
scripts/build.sh --target core
scripts/build.sh --platform linux/amd64,linux/arm64 --push --tag ghcr.io/you/t3code
scripts/smoke-test.sh t3code:browser             # boots it and checks the contract
```

`--variant` is how the test scripts know what to assert; it is never guessed
from whether Chromium is present, so a digest reference needs it spelled out
(`--variant core t3code@sha256:…`).

The `browser` and `core` targets replaced `full` and `slim`. See [Upgrading
from `slim`/`full`](#upgrading-from-slimfull).

Behind a TLS-intercepting proxy, drop the CA PEM into `ca-certs/` and build with
`--build-arg APT_HTTPS=true`.

## Security

An agent with a shell in this container can run anything, and the container is
the only boundary. Some consequences worth being deliberate about:

- **Pairing links are credentials.** They carry a bearer token in the URL
  fragment. Serve over HTTPS, keep `--ttl` short, and revoke with
  `t3 auth pairing revoke <id>` / `t3 auth session revoke <id>`.
- **Do not publish port 3773 to the internet.** The compose file binds it to
  loopback for that reason. Put TLS in front, or use a tunnel.
- **Provider credentials live on the `t3-home` volume** in plaintext-ish form,
  the same as they would in your home directory. Treat that volume accordingly.
- **`T3_ALLOW_SUDO=1` gives the agent root in the container.** Convenient for
  `apt install` mid-task, and a much shorter path to the host if something else
  is misconfigured. Off by default.
- T3 Code's own [permission modes](https://github.com/pingdotgg/t3code/blob/main/docs/user/permission-modes.md)
  still apply. Start supervised.

## Troubleshooting

**The pairing link does not work, or "Invalid pairing token".** Three causes,
in order of likelihood. The token came from the server's startup banner, which
expires five minutes after boot — use `t3-pair`. Or the link uses `172.x` /
`192.0.2.x`, meaning `T3_PUBLIC_URL` is unset. Or the token was already
redeemed: they are one-time, so mint a fresh one per device.

**A provider is missing in Settings → Providers.** It has to be enabled per
environment, and signed in on the server. `t3-doctor` shows both. On a first
start, also check the setup page: the agent may still be installing, or the
install may have failed (no network at boot) - press **Retry** on its row, or
restart the container and it tries again.

**Terminals do not open.** T3 Code ships `node-pty` prebuilt beside its binary
in `/opt/t3`; if terminals fail, check `t3-doctor` and the container log rather
than rebuilding.

**Files in my repo are owned by the wrong user.** Set `PUID`/`PGID` to `id -u` /
`id -g` on the host and recreate the container.

**`EACCES: permission denied, mkdir '/home/t3/.t3/userdata'`.** A volume is
mounted at the state directory and the container could not take ownership of it.
The container adopts such a mount on startup, but only when it starts as root —
if your platform forces a `user:` setting, it has no way to, and it will say so
in the log. Either drop that setting and select the user with `PUID`/`PGID`, or
`chown` the host directory to that uid before mounting it.

**Chromium crashes.** Give it shared memory: `shm_size: 1gb` (compose already
does) and keep `--no-sandbox`, which `t3-browser-mcp` passes.

## Contributing

Issues and pull requests are welcome. Two things worth knowing before you open
one:

- **`scripts/smoke-test.sh` is the contract.** It boots the image and asserts
  the things a user would notice if you broke, against a running container. Run
  it against your build (`./scripts/smoke-test.sh t3code:browser`) and add an
  assertion for whatever you fixed. Most of the assertions in there exist
  because something shipped broken once.
- **CI builds and smoke-tests both targets on both architectures** before
  anything is published, so a change that only works on amd64 will be caught.
  The slower harness-lifecycle E2E runs on amd64 for every build.

Publishing happens on tags only: push `vX.Y.Z` and the workflow builds each
target for each architecture, smoke tests every one against the exact pushed
digest, runs the harness-lifecycle E2E and measures on amd64, then stitches
the tested digests into one manifest without rebuilding. `latest` and `full`
point at `browser`, `slim` at `core`.

## License

MIT — see [LICENSE](LICENSE). T3 Code and the harness CLIs are covered by their
own licenses; this repository packages them, it does not relicense them.
