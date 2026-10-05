# syntax=docker/dockerfile:1

# T3 Code, packaged as a headless server.
#
# Two targets:
#   browser - the default (`latest`): core + Chromium, fonts, and both
#             browser-automation MCP servers.
#   core    - T3 Code, the setup service, the full non-browser OS toolchain,
#             mise and the harness installer. No browser.
#
# Neither bakes an agent CLI or a language toolchain: the first start installs
# them onto the /home/t3 volume (T3_PREINSTALL), where they stay.
#
# Build:  docker build -t t3code:browser .
#         docker build --target core -t t3code:core .
# `full` and `slim` remain as aliases at the end, so an older .env still builds.
# See README.md for the runtime contract.

ARG NODE_IMAGE=node:24-trixie-slim

# ---------------------------------------------------------------------------
# base - OS packages, trust anchors, the unprivileged user
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Extra trust anchors. Drop PEM/CRT files into ca-certs/ to build behind a
# TLS-intercepting proxy; the directory ships empty and this is a no-op.
COPY ca-certs/ /usr/local/share/ca-certificates/extra/

# Debian's mirrors are reached over plain HTTP by default. Some proxies only
# relay CONNECT, so allow switching the sources to HTTPS at build time.
ARG APT_HTTPS=false

RUN set -eux; \
    find /usr/local/share/ca-certificates/extra -maxdepth 1 -type f \
         \( -name '*.crt' -o -name '*.pem' \) -exec cat {} + \
         > /usr/local/share/ca-certificates/extra-bundle.pem; \
    if [ -s /usr/local/share/ca-certificates/extra-bundle.pem ]; then \
      echo 'Acquire::https::CaInfo "/usr/local/share/ca-certificates/extra-bundle.pem";' \
          > /etc/apt/apt.conf.d/99-t3code-extra-ca; \
    else \
      rm -f /usr/local/share/ca-certificates/extra-bundle.pem; \
    fi; \
    if [ "$APT_HTTPS" = "true" ]; then \
      sed -i 's|http://deb.debian.org|https://deb.debian.org|g' \
          /etc/apt/sources.list.d/debian.sources; \
    fi

RUN set -eux; \
    apt-get -o Acquire::Retries=8 update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg \
        git git-lfs openssh-client \
        build-essential python3 python3-dev python3-venv pipx \
        tini gosu \
        jq ripgrep fd-find bat sqlite3 \
        unzip zip xz-utils \
        less nano vim-tiny \
        procps psmisc htop file tzdata \
        qrencode iproute2 iputils-ping dnsutils; \
    update-ca-certificates; \
    # Re-point apt at the merged store so later stages trust both the system
    # roots and any extra anchors, whatever the supplied bundle contained.
    if [ -f /etc/apt/apt.conf.d/99-t3code-extra-ca ]; then \
      echo 'Acquire::https::CaInfo "/etc/ssl/certs/ca-certificates.crt";' \
          > /etc/apt/apt.conf.d/99-t3code-extra-ca; \
    fi; \
    ln -sf "$(command -v fdfind)" /usr/local/bin/fd; \
    ln -sf "$(command -v batcat)" /usr/local/bin/bat; \
    git lfs install --system; \
    rm -rf /var/lib/apt/lists/*

# GitHub CLI from GitHub's own apt repository rather than Debian's. Debian
# trixie ships 2.46, and T3 Code refuses to read sign-in status from anything
# older than 2.81 - "GitHub CLI is too old to report sign-in status" - which
# makes the distro package useless for the one job it has here. This is the
# install method GitHub documents, and it carries both architectures.
#
# Deliberately unpinned: the repo keeps only the current version, so a pin
# would break the build the day it moves. The floor below is what actually
# matters, and it is asserted rather than assumed.
ARG GH_MIN_VERSION=2.81.0
RUN set -eux; \
    mkdir -p -m 755 /etc/apt/keyrings; \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list; \
    apt-get -o Acquire::Retries=8 update; \
    apt-get install -y --no-install-recommends gh; \
    rm -rf /var/lib/apt/lists/*; \
    installed="$(gh --version | head -1 | awk '{print $3}')"; \
    if [ "$(printf '%s\n%s\n' "$GH_MIN_VERSION" "$installed" | sort -V | head -1)" != "$GH_MIN_VERSION" ]; then \
      echo "gh $installed is below the $GH_MIN_VERSION T3 Code requires" >&2; exit 1; \
    fi; \
    echo "gh $installed"

# Cloudflare Tunnel. T3 Code has managed-tunnel support built in and fetches
# this binary at runtime when it is missing - which needs working egress at
# exactly the moment someone is trying to get connected, and writes into the
# state volume on first use. Ship it instead, pinned to the release T3 Code
# asks for, and point T3 Code at it so it never downloads its own. It is also
# what `t3-expose` and the setup page's Ports panel use to publish a dev server.
ARG CLOUDFLARED_VERSION=2026.5.2
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) cfarch=amd64 ;; \
      arm64) cfarch=arm64 ;; \
      *) echo "no cloudflared build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${cfarch}"; \
    chmod 0755 /usr/local/bin/cloudflared; \
    cloudflared --version
ENV T3CODE_CLOUDFLARED_PATH=/usr/local/bin/cloudflared

ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# The base image ships a `node` user on uid 1000. Reclaim it for `t3` so the
# common case (host uid 1000) needs no remapping at all.
ARG T3_UID=1000
ARG T3_GID=1000
RUN set -eux; \
    userdel -r node 2>/dev/null || true; \
    groupdel node 2>/dev/null || true; \
    groupadd -g "$T3_GID" t3; \
    useradd -m -u "$T3_UID" -g "$T3_GID" -s /bin/bash t3

# Mutable npm location for user globals (`npm i -g`). Nothing the image itself
# runs lives here: T3 Code is in /opt/t3, the browser MCP servers in /opt/t3-mcp,
# and agent harnesses install through mise into the persistent home. It is on
# the t3 user's PATH only (docker/user-env.sh), never the image-wide one: the
# directory is writable by t3, and root resolving `gosu` or `bash` out of it
# would hand root to whatever an agent dropped there.
RUN mkdir -p /opt/npm-global && chown -R t3:t3 /opt/npm-global

# `npm i -g` as the unprivileged user has nowhere to write by default - npm's
# system prefix (/usr/local) is root-owned. Point npm at the mutable prefix
# through the user's own config instead of a process-wide NPM_CONFIG_PREFIX:
# root's npm keeps using its root-owned prefix and creates no user-owned global
# state, while a plain `docker exec -u t3 npm i -g ...` still works. A project
# changing its own ~/.npmrc only redirects its own installs.
RUN printf 'prefix=/opt/npm-global\n' > /home/t3/.npmrc \
    && chown t3:t3 /home/t3/.npmrc

# User-only tool environment (the npm prefix, Go's GOPATH/bin and mise's
# shims, set by /etc/profile.d/t3-user-env.sh). Kept out of the image
# environment so root never has a user-controlled directory on PATH.
COPY docker/user-env.sh /etc/profile.d/t3-user-env.sh
RUN chmod 0644 /etc/profile.d/t3-user-env.sh

# mise - persistent, project-aware toolchains.
#
# Pinned to an exact release and verified against a committed checksum (both
# architectures) before the binary is installed. mise itself is image
# infrastructure: root-owned, not group/other writable, and launched by absolute
# path. Everything it manages - installed tools, the global config, its cache -
# lives in the unprivileged user's persistent home, so toolchains survive
# recreation without widening root's environment. docker/mise/config.toml lands
# at /etc/mise/config.toml: the lowest-precedence config every user and every
# `docker exec` reads, carrying the execution policy and the generated
# idiomatic allowlist.
ARG MISE_VERSION=2026.9.10
COPY docker/mise/ /opt/mise/
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) mise_arch=x64 ;; \
      arm64) mise_arch=arm64 ;; \
      *) echo "no mise build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    asset="mise-v${MISE_VERSION}-linux-${mise_arch}"; \
    curl -fsSL -o /tmp/mise \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/${asset}"; \
    checksum="$(awk -v asset="$asset" '$2 == asset { print $1 }' /opt/mise/SHA256SUMS)"; \
    if [ -z "$checksum" ]; then \
      echo "no checksum for ${asset} in docker/mise/SHA256SUMS" >&2; exit 1; \
    fi; \
    echo "${checksum}  /tmp/mise" | sha256sum -c -; \
    install -m 0755 /tmp/mise /usr/local/bin/mise; \
    rm -f /tmp/mise; \
    install -D -m 0644 /opt/mise/config.toml /etc/mise/config.toml; \
    mise --version; \
    # The user-owned trees mise writes to, ready before the first tool install. A
    # persistent volume mounted at /home/t3 hides these image defaults but keeps
    # its own contents; mise recreates whatever it needs.
    mkdir -p \
      /home/t3/.config/mise \
      /home/t3/.local/share/mise \
      /home/t3/.local/state/mise \
      /home/t3/.cache/mise; \
    chown -R t3:t3 /home/t3/.config /home/t3/.local /home/t3/.cache

# ---------------------------------------------------------------------------
# core - base + full non-browser OS packages, T3 infrastructure, mise (from
# base), and the harness installer. No baked harness executables, no baked
# language runtimes, no browser.
# ---------------------------------------------------------------------------
FROM base AS core

# The non-browser union: everything the old full target installed via apt except
# Chromium, fonts, and the baked toolchains. Browser-only packages live in the
# browser stage.
RUN set -eux; \
    apt-get -o Acquire::Retries=8 update; \
    apt-get install -y --no-install-recommends \
        clang lld cmake pkg-config gdb \
        ffmpeg imagemagick \
        postgresql-client redis-tools; \
    rm -rf /var/lib/apt/lists/*

# Pinned so a rebuild is reproducible; `scripts/bump-versions.sh` refreshes it
# against the registry. The agent harnesses are not baked and therefore carry
# no pins here: the harness installer resolves and records an exact version on
# explicit install.
ARG T3_VERSION=0.0.45
ARG TARGETARCH

# T3 Code is image infrastructure. Its platform distribution installs into a
# root-owned prefix and is launched only through an absolute path, so nothing
# under a project, a mise shim, or a user npm prefix can select or replace it.
ENV T3_INFRA_PREFIX=/opt/t3 \
    T3_INFRA_NODE=/usr/local/bin/node \
    T3_INFRA_BINARY=/opt/t3/t3 \
    T3_INFRA_LAUNCHER=/usr/local/bin/t3-admin

# The release is split into architecture-specific packages. Install the
# platform package explicitly instead of the tiny `t3` npm launcher, then
# flatten it into one architecture-independent immutable path. Its native
# modules and client assets must remain beside the executable.
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) t3_package='@t3code/t3-linux-x64' ;; \
      arm64) t3_package='@t3code/t3-linux-arm64' ;; \
      *) echo "unsupported T3 architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    install_root=/tmp/t3-install; \
    mkdir -p "$T3_INFRA_PREFIX" "$install_root"; \
    npm install --no-audit --no-fund --ignore-scripts --prefix "$install_root" \
        "${t3_package}@${T3_VERSION}"; \
    package_root="$install_root/node_modules/$t3_package"; \
    cp -a "$package_root/." "$T3_INFRA_PREFIX/"; \
    # Keep the package manifest as local audit evidence; runtime does not need
    # npm's surrounding node_modules layout.
    test -x "$T3_INFRA_BINARY"; \
    test -f "$T3_INFRA_PREFIX/client/index.html"; \
    rm -rf "$install_root"; \
    npm cache clean --force; \
    # Root-owned and not group/other writable: the t3 user runs the server and
    # must never be able to modify it.
    chown -R root:root "$T3_INFRA_PREFIX"; \
    chmod -R go-w "$T3_INFRA_PREFIX"

# No baked harnesses and no Cursor installer. The harness installer (manager +
# provider integration + t3-harness CLI) arrives with the COPYs below and
# installs mise-managed executables into the persistent home at runtime.

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
# T3 Code's supervisor: restarts it when the setup page asks, and otherwise
# ends the container when it exits, as `exec` did.
COPY docker/run-t3.sh /usr/local/lib/t3code/run-t3.sh
COPY docker/bin/ /usr/local/bin/
# Plain ESM modules shared by the setup service, the entrypoint and the shell
# helpers: the harness manager owns install/resolve, and the provider
# integration turns its selection into T3's per-provider `binaryPath`.
COPY docker/harness/ /opt/t3-harness/
COPY docker/provider-integration/ /opt/t3-provider/
COPY docker/setup/ /opt/t3-setup/
# The one-port router (T3_SINGLE_PORT): T3 Code and the setup page behind a
# single listener, for platforms and tunnels that route one port.
COPY docker/router/ /opt/t3-router/
COPY examples/ /opt/examples/
# T3 Code's client has no link to the setup console. The setup bridge is
# injected into its static shell: a Setup pill on the pairing screen, and a
# Setup entry in Settings that opens the console in a dialog. It probes for the
# console and changes nothing when it is absent, and patch.mjs fails the build
# if upstream moves the layout it relies on.
COPY docker/t3-client/ /usr/local/share/t3-client/
RUN "$T3_INFRA_NODE" /usr/local/share/t3-client/patch.mjs
# `t3` is the same immutable launcher under its user-facing name, for root's
# shell and anyone typing it. Nothing in the image resolves it by name: the
# entrypoint, the setup service and the helpers all use T3_INFRA_LAUNCHER.
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/lib/t3code/run-t3.sh /usr/local/bin/t3-* \
    && ln -sfn t3-admin /usr/local/bin/t3

# The agent names, for `docker exec <container> claude` and friends: links to
# t3-agent, which runs the managed install as t3. They sit in their own
# root-owned directory at the end of the image PATH because T3 decides whether
# an agent is installed by finding its name on PATH: the entrypoint drops it
# from the server's environment, and login shells (which T3 also reads its
# PATH from) never get it, so an uninstalled agent reads as uninstalled.
RUN mkdir -p /usr/local/lib/t3-agents \
    && for agent in claude codex opencode grok cursor-agent; do \
         ln -sfn /usr/local/bin/t3-agent "/usr/local/lib/t3-agents/${agent}"; \
       done
ENV PATH=${PATH}:/usr/local/lib/t3-agents

ENV T3CODE_HOME=/home/t3/.t3 \
    T3CODE_HOST=0.0.0.0 \
    T3CODE_PORT=3773 \
    T3_WORKSPACE=/workspace \
    T3_AUTO_ADD_PROJECTS=1 \
    T3_PRINT_PAIRING_ON_START=0 \
    T3_SETUP_ENABLED=1 \
    T3_SETUP_PORT=3774 \
    T3_SETUP_BASE_PATH= \
    T3_SINGLE_PORT= \
    PUID=1000 \
    PGID=1000

RUN mkdir -p /workspace /home/t3/.t3 /home/t3/go && chown -R t3:t3 /workspace /home/t3

VOLUME ["/home/t3", "/workspace"]
WORKDIR /workspace
EXPOSE 3773 3774

# With one port, asked through it: that is the way in, so a router that is not
# answering is an unhealthy container even while T3 Code itself is fine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD curl -fsS --max-time 4 "http://127.0.0.1:${T3_SINGLE_PORT:-${T3CODE_PORT}}/.well-known/t3/environment" >/dev/null || exit 1

# Stamped last so a version change reuses every layer above it. IMAGE_VERSION is
# the release tag in CI and "dev" for a local build; the setup page shows both so
# you can tell at a glance which image is actually running.
ARG IMAGE_VERSION=dev
ARG IMAGE_VARIANT=core
ENV T3_IMAGE_VERSION=${IMAGE_VERSION} \
    T3_IMAGE_VARIANT=${IMAGE_VARIANT}
# The same stamp in a file: a recreated container can carry an older image's
# T3_IMAGE_* in its own environment, which wins over ENV but not over this
# (docker/user-env.sh reads it).
RUN printf 'version=%s\nvariant=%s\n' "$IMAGE_VERSION" "$IMAGE_VARIANT" > /etc/t3code-image
LABEL org.opencontainers.image.version="${IMAGE_VERSION}"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["t3-serve"]

# ---------------------------------------------------------------------------
# browser - core + Chromium, fonts, and both MCP servers. No baked harnesses,
# no baked language runtimes.
# ---------------------------------------------------------------------------
FROM core AS browser

# Browser automation over MCP. T3 Code's own preview tools are hosted by the
# web/desktop client, so a phone-only setup has no eyes without this.
ARG CHROME_DEVTOOLS_MCP_VERSION=1.10.1
ARG PLAYWRIGHT_MCP_VERSION=0.0.83
USER root

RUN set -eux; \
    apt-get -o Acquire::Retries=8 update; \
    apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation fonts-dejavu-core fonts-noto-core \
        fonts-noto-color-emoji fonts-noto-cjk; \
    rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium \
    CHROME_BIN=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Image infrastructure like T3 itself: root-owned so an agent cannot rewrite
# the server it launches, with the entry points linked into /usr/local/bin so
# the bare names t3-browser-mcp registers resolve for every user.
RUN set -eux; \
    npm install -g --no-audit --no-fund --prefix /opt/t3-mcp \
        "chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}" \
        "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}"; \
    npm cache clean --force; \
    for bin in /opt/t3-mcp/bin/*; do ln -sfn "$bin" /usr/local/bin/; done; \
    chown -R root:root /opt/t3-mcp; \
    chmod -R go-w /opt/t3-mcp; \
    playwright-mcp --help >/dev/null; \
    chrome-devtools-mcp --version
# The setup console's Environment page reports these as built.
ENV T3_PLAYWRIGHT_MCP_VERSION=${PLAYWRIGHT_MCP_VERSION} \
    T3_CHROME_DEVTOOLS_MCP_VERSION=${CHROME_DEVTOOLS_MCP_VERSION}

# Stamped last so a version change reuses every layer above it. IMAGE_VERSION is
# the release tag in CI and "dev" for a local build; the setup page shows both so
# you can tell at a glance which image is actually running.
ARG IMAGE_VERSION=dev
ARG IMAGE_VARIANT=browser
ENV T3_IMAGE_VERSION=${IMAGE_VERSION} \
    T3_IMAGE_VARIANT=${IMAGE_VARIANT}
# The same stamp in a file: a recreated container can carry an older image's
# T3_IMAGE_* in its own environment, which wins over ENV but not over this
# (docker/user-env.sh reads it).
RUN printf 'version=%s\nvariant=%s\n' "$IMAGE_VERSION" "$IMAGE_VARIANT" > /etc/t3code-image
LABEL org.opencontainers.image.version="${IMAGE_VERSION}"

# ---------------------------------------------------------------------------
# The names the targets had before they stopped baking agents in, so a .env
# that still says T3_BUILD_TARGET=full (or slim) keeps building. Same images;
# `full` is last so a plain `docker build` gets it, and it is `browser`.
# ---------------------------------------------------------------------------
FROM core AS slim
FROM browser AS full
