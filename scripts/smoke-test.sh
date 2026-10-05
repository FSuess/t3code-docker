#!/usr/bin/env bash
# Boot the image and assert the things a user would notice if they broke.
#
#   scripts/smoke-test.sh [--variant NAME] [image]      (default: t3code:browser)
#
# Capability profiles:
#   browser  default (`latest`): core + Chromium/fonts/MCP servers
#   core     installer + mise, no browser; agents and toolchains install on
#            first start, in both
#
# The variant selects which capabilities are asserted; it is never inferred
# from the presence of Chromium. When omitted it is inferred from the image
# tag (t3code:<variant>); digest references (image@sha256:...) require an
# explicit --variant because the tag carries no variant.
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/image-profile.sh
. "$SCRIPT_DIR/lib/image-profile.sh"

VARIANT=""
IMAGE=""

usage() {
  cat <<'USAGE'
Usage: scripts/smoke-test.sh [--variant NAME] [image]

  --variant NAME   core | browser
                   (default: inferred from the image tag; required for digest refs)
  image            image tag or digest reference (default: t3code:browser)
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --variant) VARIANT="${2:?--variant needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; [ $# -gt 0 ] && IMAGE="$1" && shift; break ;;
    -*) echo "smoke-test.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
    *) IMAGE="$1"; shift ;;
  esac
done
[ -n "$IMAGE" ] || IMAGE="t3code:browser"

t3_image_profile_resolve "smoke-test.sh" "$IMAGE" "$VARIANT"
NAME="t3code-smoke-$$"
PORT="${SMOKE_PORT:-13773}"
PUBLIC_URL="https://smoke.example.test"
SETUP_KEY="smoke-setup-key"

pass=0
fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
no()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else no "$1"; fi; }
# The setup service runs under a restart loop, so a single probe can land in the
# gap and fail a release build for no reason. Retry the ones that only talk to
# it; a genuine outage is caught separately by the crash-loop assertion below.
retry() { local n=$1; shift; local i; for i in $(seq 1 "$n"); do
  if eval "$*" >/dev/null 2>&1; then return 0; fi; sleep 2; done; return 1; }

STATE_MOUNT=""
PAGE_HTML=""
SETUP_COPY=""
# The layout audit runs with its output discarded, so record it here and print
# it with the failure summary.
UI_AUDIT_LOG="${UI_AUDIT_LOG:-}"
if [ -z "$UI_AUDIT_LOG" ]; then
  UI_AUDIT_LOG="$(mktemp "${TMPDIR:-/tmp}/t3-ui-audit.XXXXXX")"
  UI_AUDIT_LOG_CREATED=1
fi
cleanup() {
  docker rm -f "$NAME" "${NAME}-mount" "${NAME}-boot" "${NAME}-anon" "${NAME}-env" \
    "${NAME}-one" "${NAME}-badport" >/dev/null 2>&1 || true
  rm -f "${ONE_JAR:-}" 2>/dev/null || true
  rm -f "$PAGE_HTML" 2>/dev/null || true
  [ -n "$SETUP_COPY" ] && rm -rf "$SETUP_COPY" 2>/dev/null || true
  [ "${UI_AUDIT_LOG_CREATED:-0}" = 1 ] && rm -f "$UI_AUDIT_LOG" 2>/dev/null || true
  if [ -n "$STATE_MOUNT" ]; then
    sudo rm -rf "$STATE_MOUNT" 2>/dev/null || rm -rf "$STATE_MOUNT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

printf '\nSmoke-testing %s (variant %s)\n\n' "$IMAGE" "$VARIANT"

# Run as a container recreated from a v0.4 image does: a hosting panel or
# Watchtower that copies the old container's environment keeps the toolchain
# settings that image baked in, and its old variant name. Everything below, the
# first-start install of Go and Rust included, has to work regardless.
LEGACY_VARIANT=slim
[ "$VARIANT" = browser ] && LEGACY_VARIANT=full
LEGACY_ENV=(-e GOROOT=/usr/local/go -e GOPATH=/home/t3/go
  -e RUSTUP_HOME=/usr/local/rustup -e CARGO_HOME=/usr/local/cargo
  -e BUN_INSTALL=/usr/local/bun -e DENO_INSTALL=/usr/local/deno -e CURSOR_HOME=/opt/cursor
  -e "T3_IMAGE_VARIANT=${LEGACY_VARIANT}")
# ...and the PATH it declared, which the startup-pairing container below runs with.
LEGACY_PATH=/usr/local/bun/bin:/usr/local/deno/bin:/usr/local/cargo/bin:/usr/local/go/bin:/home/t3/go/bin:/opt/cursor/.local/bin:/opt/npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

docker run -d --name "$NAME" \
  -p "127.0.0.1:${PORT}:3773" \
  -e "T3_PUBLIC_URL=${PUBLIC_URL}" \
  -e "T3_SETUP_KEY=${SETUP_KEY}" \
  "${LEGACY_ENV[@]}" \
  "$IMAGE" >/dev/null

printf 'Waiting for the server to answer...\n'
health_url="http://127.0.0.1:${PORT}/.well-known/t3/environment"
for i in $(seq 1 60); do
  if curl -fsS --noproxy '*' --max-time 5 "$health_url" >/dev/null 2>&1; then break; fi
  if [ "$i" = 60 ]; then
    no "server never became healthy"
    docker logs "$NAME" 2>&1 | tail -30
    exit 1
  fi
  sleep 2
done

printf '\nServer\n'
version="$(curl -fsS --noproxy '*' "$health_url" | jq -r .serverVersion)"
[ -n "$version" ] && ok "health endpoint (serverVersion=$version)" || no "health endpoint"
# The healthcheck has a start period, so the first probe lands after the
# server is already answering. Give it room rather than racing it.
health_status=""
for _ in $(seq 1 60); do
  health_status="$(docker inspect --format '{{.State.Health.Status}}' "$NAME" 2>/dev/null || true)"
  [ "$health_status" = healthy ] && break
  [ "$health_status" = unhealthy ] && break
  sleep 5
done
[ "$health_status" = healthy ] \
  && ok "docker healthcheck reports healthy" \
  || no "docker healthcheck reports $health_status"

printf '\nHarnesses (variant %s)\n' "$VARIANT"
check "t3 runs" "docker exec $NAME t3 --version"
# The image ships the installer, never the executables: a baked harness would
# let a stale copy masquerade as a managed install. The agent names on root's
# PATH are all the root-owned dispatcher, which runs the managed install.
only_the_dispatcher_is_baked() {
  docker exec "$NAME" sh -c '
    for agent in claude codex opencode grok cursor-agent; do
      [ "$(command -v "$agent")" = "/usr/local/lib/t3-agents/$agent" ] || exit 1
      [ "$(readlink -f "/usr/local/lib/t3-agents/$agent")" = /usr/local/bin/t3-agent ] || exit 1
    done
    [ "$(stat -c %U /usr/local/bin/t3-agent /usr/local/lib/t3-agents | sort -u)" = root ]'
}
check "no harness executable is baked, only the root-owned dispatcher" only_the_dispatcher_is_baked
check "mise ships" "docker exec $NAME mise --version"
check "harness installer ships" "docker exec $NAME t3-harness --help"
check "provider integration ships" "docker exec $NAME test -r /opt/t3-provider/cli.mjs"

# T3 Code enforces a minimum `gh` at runtime: too old and it reports "GitHub
# CLI is too old to report sign-in status". Debian's gh (2.46) sat below that
# floor and made the CLI useless, so the Dockerfile pin is the source of truth.
T3_PREFIX="$(docker exec "$NAME" printenv T3_INFRA_PREFIX 2>/dev/null || true)"
[ -n "$T3_PREFIX" ] || T3_PREFIX=/opt/t3
T3_BINARY="$(docker exec "$NAME" printenv T3_INFRA_BINARY 2>/dev/null || true)"
[ -n "$T3_BINARY" ] || T3_BINARY="${T3_PREFIX}/t3"
check "the immutable T3 platform binary is where the image says it is" \
  "docker exec $NAME test -x $T3_BINARY"
check "the T3 client shell is available for the setup bridge" \
  "docker exec $NAME test -f $T3_PREFIX/client/index.html"
check "T3 is not installed in the mutable npm prefix" \
  "docker exec $NAME test ! -e /opt/npm-global/lib/node_modules/t3"
# Root resolves gosu, id and bash by name before stepping down. A directory on
# its PATH that t3 can write would let an agent plant any of them and get root
# on the next restart or `docker exec`.
check "root's PATH holds no directory the t3 user can write" \
  "docker exec $NAME sh -c 'IFS=:; for d in \$PATH; do [ -d \"\$d\" ] || continue; gosu t3 test -w \"\$d\" && { echo \"\$d\"; exit 1; }; done; exit 0'"
check "the t3 user still gets its own npm prefix" \
  "docker exec -u t3 $NAME bash -lc 'case :\$PATH: in *:/opt/npm-global/bin:*) true ;; *) false ;; esac'"

# T3 states the versions it needs inside its own platform binary, and enforces
# them at runtime: too old a `gh` and it reports "GitHub CLI is too old to
# report sign-in status", too old an OpenCode and it refuses the server. Read
# the floors back out of the binary (with -a: it is an executable) and hold the
# image to them, so an upstream bump fails here rather than in a session.
T3_BUNDLE="$T3_BINARY"

# Compares with sort -V: passes when installed >= required.
version_at_least() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]
}

gh_meets_t3_minimum() {
  local declared installed
  declared="$(docker exec "$NAME" sh -c \
    "grep -a -o 'Update .gh. to [0-9][0-9.]* or newer' $T3_BUNDLE | head -1" 2>/dev/null \
    | grep -o '[0-9][0-9.]*' | head -1)"
  # Fall back to the floor the Dockerfile asserts if the wording moved.
  [ -n "$declared" ] || declared="$(grep -m1 '^ARG GH_MIN_VERSION=' Dockerfile | cut -d= -f2)"
  installed="$(docker exec "$NAME" gh --version 2>/dev/null | head -1 | awk '{print $3}')"
  [ -n "$installed" ] || return 1
  GH_DECLARED="$declared"; GH_INSTALLED="$installed"
  version_at_least "$installed" "$declared"
}
if gh_meets_t3_minimum; then
  ok "gh $GH_INSTALLED meets the $GH_DECLARED T3 Code requires"
else
  no "gh ${GH_INSTALLED:-?} is below the ${GH_DECLARED:-?} T3 Code requires"
fi

# A freshly built image that immediately asks you to upgrade an agent is a bug
# in this repo, not in the agent. The pins are what go stale, so assert they
# were current when the image was built.
check "the image's pinned versions were current at build time" \
  "./scripts/bump-versions.sh --check"

printf '\nPairing\n'
pair_out="$(docker exec "$NAME" t3-pair --no-qr 2>/dev/null || true)"
case "$pair_out" in
  *"Pairing URL: ${PUBLIC_URL}/pair#token="*)
    ok "t3-pair uses the public URL" ;;
  *) no "t3-pair did not produce a public pairing URL"
     printf '%s\n' "$pair_out" ;;
esac
check "minted token is registered server-side" \
  "docker exec $NAME t3 auth pairing list --json 2>/dev/null | grep -q orchestration:operate"

have() { docker exec "$NAME" sh -c "command -v $1" >/dev/null 2>&1; }

printf '\nRuntimes (variant %s)\n' "$VARIANT"
for bin in node python3 git gh; do
  check "$bin present" "have $bin"
done
check "mise present" "have mise"

printf '\nNon-browser toolchain packages (core union)\n'
for bin in clang cmake ffmpeg; do
  check "$bin present" "have $bin"
done
check "postgresql client present" "have psql"
check "gdb present" "have gdb"

printf '\nProject runtimes (installed through mise, not baked)\n'
# Root has no mise shims on PATH by design, so a bare lookup as root only
# finds a baked runtime.
check "no language runtime is baked" \
  "! docker exec $NAME sh -c 'command -v go || command -v rustc || command -v cargo || command -v bun || command -v deno || command -v uv' >/dev/null 2>&1"

if [ "$HAS_BROWSER" -eq 1 ]; then
  printf '\nBrowser (variant %s)\n' "$VARIANT"
  check "chromium present" "have chromium"

  # about:blank would pass even with a broken renderer; render real markup and
  # look for it in the DOM, then prove the raster path produces a real image.
  docker exec "$NAME" sh -c \
    'printf "<h1 id=marker>t3code-smoke-ok</h1>" > /tmp/smoke.html'
  check "chromium renders a page" \
    "docker exec $NAME sh -c 'chromium --headless --no-sandbox --disable-gpu \
       --dump-dom file:///tmp/smoke.html 2>/dev/null | grep -q t3code-smoke-ok'"
  check "chromium screenshots a page" \
    "docker exec $NAME sh -c 'chromium --headless --no-sandbox --disable-gpu \
       --window-size=800,600 --screenshot=/tmp/smoke.png file:///tmp/smoke.html \
       >/dev/null 2>&1 && [ \"\$(stat -c %s /tmp/smoke.png)\" -gt 1000 ]'"

  check "playwright-mcp present" "have playwright-mcp"
  check "chrome-devtools-mcp present" "have chrome-devtools-mcp"

  # "installed" and "an agent can see a page" are different claims.
  docker cp "$SCRIPT_DIR/browser-probe.py" "$NAME:/tmp/browser-probe.py" >/dev/null
  check "browser MCP drives a real page (playwright)" \
    "docker exec -u t3 $NAME python3 /tmp/browser-probe.py"
  check "browser MCP drives a real page (chrome-devtools)" \
    "docker exec -u t3 $NAME python3 /tmp/browser-probe.py \
       \$(docker exec $NAME t3-browser-mcp --server chrome-devtools --print)"
  check "t3-browser-mcp prints playwright server" \
    "docker exec $NAME t3-browser-mcp --server playwright --print | grep -q playwright-mcp"
  check "t3-browser-mcp prints chrome-devtools server" \
    "docker exec $NAME t3-browser-mcp --server chrome-devtools --print | grep -q chrome-devtools-mcp"
  # No baked harness to register with, so just prove the helper does not fail
  # without one; the managed registration path is covered by the E2E.
  check "t3-browser-mcp runs with no baked harness" \
    "docker exec $NAME t3-browser-mcp --harness opencode"
else
  printf '\nBrowser (none expected in %s)\n' "$VARIANT"
  check "no chromium" "! docker exec $NAME sh -c 'command -v chromium' >/dev/null 2>&1"
  check "no playwright-mcp" "! docker exec $NAME sh -c 'command -v playwright-mcp' >/dev/null 2>&1"
  check "no chrome-devtools-mcp" "! docker exec $NAME sh -c 'command -v chrome-devtools-mcp' >/dev/null 2>&1"
fi

printf '\nOwnership\n'
check "state dir is owned by the t3 user" \
  "[ \"\$(docker exec $NAME stat -c %U /home/t3/.t3)\" = t3 ]"
check "root exec does not leave root-owned state" \
  "! docker exec $NAME find /home/t3/.t3 -user root -print -quit | grep -q ."

# A volume mounted directly at the state dir arrives root-owned while its
# parent still looks correct. The entrypoint has to notice and adopt it, or the
# server dies on `mkdir userdata` with nothing but an EACCES stack trace.
STATE_MOUNT="$(mktemp -d)"
sudo chown 0:0 "$STATE_MOUNT" 2>/dev/null || chown 0:0 "$STATE_MOUNT" 2>/dev/null || true
docker run -d --name "${NAME}-mount" -e T3_PREINSTALL=none -v "$STATE_MOUNT:/home/t3/.t3" "$IMAGE" >/dev/null
mounted_ok=0
for _ in $(seq 1 40); do
  if docker exec "${NAME}-mount" curl -fsS --max-time 3 \
       "http://127.0.0.1:3773/.well-known/t3/environment" >/dev/null 2>&1; then
    mounted_ok=1
    break
  fi
  [ "$(docker inspect -f '{{.State.Running}}' "${NAME}-mount" 2>/dev/null)" = true ] || break
  sleep 3
done
if [ "$mounted_ok" = 1 ]; then
  ok "root-owned volume mounted at the state dir is adopted"
else
  no "root-owned volume mounted at the state dir is adopted"
  docker logs "${NAME}-mount" 2>&1 | tail -15
fi

# Agent sign-ins default to $HOME, which is only persisted if the whole home is
# mounted. Anchoring them under the state directory is what makes "sign in once"
# true for a deployment that only mounted .t3.
printf '\nCredential persistence\n'
check "agent credentials are anchored on the state volume" \
  "docker exec $NAME sh -c '[ \"\$(readlink /home/t3/.claude)\" = /home/t3/.t3/agents/.claude ]'"
check "a written credential lands on the state volume" \
  "docker exec -u t3 $NAME sh -c 'echo x > ~/.codex/auth.json && test -f /home/t3/.t3/agents/.codex/auth.json'"
# The Dockerfile declares VOLUME, so an unmounted deployment still looks mounted
# from inside; only the mount source distinguishes a throwaway anonymous volume.
docker rm -f "${NAME}-anon" >/dev/null 2>&1 || true
docker run -d --name "${NAME}-anon" -e T3_SETUP_KEY=x -e T3_PREINSTALL=none "$IMAGE" >/dev/null
# The entrypoint always prints exactly one persistence verdict, so wait for any
# of them rather than only the one we want. A wrong verdict then fails at once
# with the line it printed, and a container that died fails with its exit code,
# instead of burning the whole timeout in silence the way this used to.
anon_verdict=""
for _ in $(seq 1 30); do
  anon_verdict="$(docker logs "${NAME}-anon" 2>&1 | grep -m1 \
    -e 'is an anonymous volume' -e 'credentials persist on' -e 'is not on a mount at all' || true)"
  [ -n "$anon_verdict" ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "${NAME}-anon" 2>/dev/null)" = true ] || break
  sleep 3
done
case "$anon_verdict" in
  *'is an anonymous volume'*)
    ok "an anonymous volume is called out as not durable" ;;
  *)
    no "an anonymous volume is called out as not durable"
    printf '    verdict: %s\n' "${anon_verdict:-<none printed>}"
    printf '    container: %s\n' \
      "$(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' "${NAME}-anon" 2>/dev/null || echo unknown)"
    docker logs "${NAME}-anon" 2>&1 | tail -15 ;;
esac
docker rm -f "${NAME}-anon" >/dev/null 2>&1 || true

# The setup service is the only way to pair without a shell in the container
# and without a restart, so it has to work unattended.
printf '\nSetup service\n'
SETUP_JAR="$(mktemp)"
# Gate the section on the service actually answering, so the first assertion
# is not the one that discovers it is still starting.
retry 30 "docker exec $NAME curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:3774/" \
  || no "setup service never answered"
check "refuses an unauthenticated request" \
  "[ \"\$(docker exec $NAME curl -sS -o /dev/null -w '%{http_code}' \
     http://127.0.0.1:3774/status)\" = 401 ]"
docker exec "$NAME" sh -c \
  "curl -sS -c /tmp/jar -d 'key=$SETUP_KEY' -o /dev/null http://127.0.0.1:3774/login" >/dev/null 2>&1
check "grants a session for the right key" \
  "docker exec $NAME sh -c 'curl -fsS -b /tmp/jar http://127.0.0.1:3774/status | grep -q publicUrl'"
setup_pair="$(docker exec "$NAME" sh -c \
  "curl -sS -b /tmp/jar -H 'content-type: application/json' -d '{\"ttl\":\"1h\"}' \
     http://127.0.0.1:3774/pair" 2>/dev/null || true)"
case "$setup_pair" in
  *"\"pairUrl\":\"${PUBLIC_URL}/pair#token="*) ok "mints a pairing link over HTTP" ;;
  *) no "mints a pairing link over HTTP"; printf '%s\n' "$setup_pair" | head -3 ;;
esac
check "the minted link is live on the running server" \
  "docker exec -u t3 $NAME t3 auth pairing list --json 2>/dev/null | grep -q orchestration:operate"

# A wrong key comes back to the form saying so, without JavaScript too: the
# redirect carries the failure for the unlock page to show.
wrong_key_is_reported() {
  docker exec "$NAME" curl -sS -o /dev/null -w '%{redirect_url}' \
    -d 'key=not-the-key' http://127.0.0.1:3774/login | grep -q '?error=1'
}
check "a wrong key is reported on the unlock page" wrong_key_is_reported

# The page runs only the scripts it was served with: every response carries a
# Content-Security-Policy with a fresh nonce, and nothing may load from elsewhere.
page_has_policy() {
  local headers
  headers="$(docker exec "$NAME" curl -sS -o /dev/null -D - -b /tmp/jar http://127.0.0.1:3774/)" || return 1
  case "$headers" in
    *"content-security-policy: default-src 'none'; script-src 'nonce-"*) return 0 ;;
    *) return 1 ;;
  esac
}
check "the console is served under a nonce-based CSP" page_has_policy

# What the redesigned console reads beyond the original fields. Each may be
# null (an update not checked yet, a size not measured yet) but never absent.
status_has_console_fields() {
  docker exec "$NAME" sh -c \
    "curl -sS --max-time 25 -b /tmp/jar http://127.0.0.1:3774/status" | python3 -c "
import json, sys
s = json.load(sys.stdin)
assert isinstance(s.get('events'), list), 'events'
assert s.get('platform', '').startswith('linux/'), 'platform'
assert s.get('setupKeySource') in ('env', 'volume', 'boot'), 'setupKeySource'
assert 'uptimeSeconds' in s['server'], 'uptimeSeconds'
assert all('latestVersion' in h for h in s['harnesses']), 'harness latestVersion'
assert all('latestVersion' in t for t in s['toolchains']), 'toolchain latestVersion'
assert 'volumeKind' in s['paths'] and 'volumeBytes' in s['paths'], 'storage facts'
"
}
check "status carries what the console reads" status_has_console_fields

# This container carries an older image's settings (see LEGACY_ENV). They are
# reported, the image still names itself correctly, and nothing it started runs
# with them.
legacy_settings_are_reported() {
  docker exec "$NAME" sh -c \
    "curl -sS --max-time 25 -b /tmp/jar http://127.0.0.1:3774/status" | python3 -c "
import json, sys
s = json.load(sys.stdin)
want = {'GOROOT', 'RUSTUP_HOME', 'CARGO_HOME', 'BUN_INSTALL', 'DENO_INSTALL', 'CURSOR_HOME'}
assert want <= set(s.get('legacyEnv') or []), s.get('legacyEnv')
assert (s.get('image') or {}).get('variant') == '$VARIANT', s.get('image')
"
}
check "settings left by an older image are reported, not obeyed" legacy_settings_are_reported
# Read as t3, the user the service runs as: another user's /proc/<pid>/environ
# needs CAP_SYS_PTRACE, which Docker does not grant even to root in the
# container. The pattern is anchored at the end of the command line, because
# the sh running it carries the same text earlier in its own.
setup_service_runs_without_them() {
  local env
  env="$(docker exec -u t3 "$NAME" sh -c 'tr "\0" "\n" < "/proc/$(pgrep -f "node /opt/t3-setup/server\.mjs$" | head -1)/environ"')" || return 1
  case "$env" in *T3_SETUP_PORT=*) ;; *) return 1 ;; esac
  ! grep -qE '^(GOROOT|RUSTUP_HOME|CARGO_HOME|BUN_INSTALL|DENO_INSTALL|CURSOR_HOME)=' <<<"$env"
}
check "and the services the entrypoint starts run without them" setup_service_runs_without_them
# Each of these captures the output and then matches it. Piped straight into
# `grep -q`, the writer is killed by SIGPIPE when grep stops at an early match,
# and under pipefail the check fails for a reason unrelated to what it tests.
output_has() {
  local out
  out="$(eval "$1" 2>&1)" || true
  grep -q -- "$2" <<<"$out"
}
check "the log says which were ignored" \
  "output_has 'docker logs $NAME' 'ignoring settings left over from an older image: GOROOT'"
check "t3-doctor says to remove them" \
  "output_has 'docker exec $NAME t3-doctor' 'older image settings'"

# Lock console: the session ends here and the key is needed again.
lock_signs_out() {
  docker exec "$NAME" sh -c \
    "curl -sS -c /tmp/lockjar -d 'key=$SETUP_KEY' -o /dev/null http://127.0.0.1:3774/login && \
     curl -fsS -b /tmp/lockjar -o /dev/null http://127.0.0.1:3774/status && \
     curl -sS -b /tmp/lockjar -c /tmp/lockjar -X POST -o /dev/null http://127.0.0.1:3774/logout && \
     [ \"\$(curl -sS -b /tmp/lockjar -o /dev/null -w '%{http_code}' http://127.0.0.1:3774/status)\" = 401 ]"
}
check "Lock console signs the browser out" lock_signs_out

# The setup console is the front door for a fresh install, but T3 Code's own
# UI does not link to it - the bridge injected into the client shell (the pill
# on the pairing screen, Setup in Settings) is the only route back. Assert it
# is in the served HTML, not just the built file, so a T3 bump cannot quietly
# drop it.
check "the T3 client links to the setup console" \
  "output_has 'docker exec $NAME curl -fsS http://127.0.0.1:3773/' 'data-t3-setup-bridge'"

# T3 Code's settings open the console in a dialog, signed in on the browser's
# own T3 session. T3 vouches for the session (with a terminal, which could read
# the setup key anyway), the console trusts only T3's word, and nothing that
# changes state is accepted from another site, whatever the cookie.
T3_COOKIE=""
t3_browser_session() {
  T3_COOKIE="$(docker exec "$NAME" node -e '
    const { execFileSync } = require("node:child_process");
    const out = execFileSync("t3", ["auth", "pairing", "create", "--base-url", "http://127.0.0.1", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const { credential } = JSON.parse(out.slice(out.indexOf("{")));
    fetch("http://127.0.0.1:3773/api/auth/browser-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential }) })
      .then((r) => process.stdout.write((r.headers.get("set-cookie") || "").split(";")[0]));
  ')" && [[ "$T3_COOKIE" == t3_session* ]]
}
check "a pairing credential becomes a T3 browser session" t3_browser_session
console_code() { docker exec "$NAME" curl -sS -o /dev/null -w '%{http_code}' --max-time 25 "$@"; }
t3_session_opens_console() {
  local body
  body="$(docker exec "$NAME" curl -fsS --max-time 25 -H "cookie: $T3_COOKIE" http://127.0.0.1:3774/status)" || return 1
  printf '%s' "$body" | python3 -c 'import json, sys; assert json.load(sys.stdin)["viewer"] == {"via": "t3"}'
}
check "the console accepts a session T3 vouches for" t3_session_opens_console
check "and not one T3 does not" \
  "[ \"\$(console_code -H \"cookie: \${T3_COOKIE}x\" http://127.0.0.1:3774/status)\" = 401 ]"
revoke_code() {
  console_code -H "cookie: $T3_COOKIE" -H 'content-type: application/json' "$@" \
    -d '{"kind":"link","id":"none"}' http://127.0.0.1:3774/revoke
}
check "a state change from another site is refused" \
  "[ \"\$(revoke_code -H 'sec-fetch-site: cross-site')\" = 403 ] && [ \"\$(revoke_code -H 'sec-fetch-site: same-site')\" = 403 ]"
check "a T3 session changes nothing unless the browser says it came from here" \
  "[ \"\$(revoke_code)\" = 401 ]"
hello_says_only_what_it_may() {
  local stranger member
  stranger="$(docker exec "$NAME" curl -fsS --max-time 25 http://127.0.0.1:3774/__setup/hello)" || return 1
  member="$(docker exec "$NAME" curl -fsS --max-time 25 -H "cookie: $T3_COOKIE" http://127.0.0.1:3774/__setup/hello)" || return 1
  python3 - "$stranger" "$member" <<'PY'
import json, sys
stranger, member = (json.loads(a) for a in sys.argv[1:3])
assert stranger == {"service": "t3-setup", "signedIn": False}, stranger
assert member["signedIn"] is True and isinstance(member["attention"], int), member
PY
}
check "the console tells T3's page where it is, and a stranger nothing more" hello_says_only_what_it_may
framed_by_its_own_origin_only() {
  local headers
  headers="$(docker exec "$NAME" curl -sS -o /dev/null -D - http://127.0.0.1:3774/)" || return 1
  grep -qi '^x-frame-options: SAMEORIGIN' <<<"$headers" && grep -qi "frame-ancestors 'self'" <<<"$headers"
}
check "only its own origin may frame the console" framed_by_its_own_origin_only

# Pulling a new image should be confirmable from the page itself rather than by
# guessing, so the build is stamped in at the end of the Dockerfile and shown in
# the top bar. Assert the stamp survives into the running container and names
# the variant that was actually built. The expected variant is the explicit
# --variant (never parsed from the image reference), so digest references work.
version_is_stamped() {
  local want="$VARIANT"
  docker exec "$NAME" sh -c \
    "curl -sS --max-time 25 -b /tmp/jar http://127.0.0.1:3774/status" | python3 -c "
import json, sys
img = json.load(sys.stdin).get('image') or {}
sys.exit(0 if img.get('version') and img.get('variant') == '$want' else 1)"
}
check "the image build is stamped and reported ($VARIANT)" version_is_stamped

# The image ships no agent CLI and no language runtime. The first start puts
# them back: everything T3_PREINSTALL names (by default Claude Code, Codex,
# OpenCode and the toolchains) installs in the background onto the volume. This
# container runs the default, so what follows is what someone pulling `latest`
# gets.
printf '\nFirst-start setup (T3_PREINSTALL default)\n'
status_json() { docker exec "${1:-$NAME}" sh -c \
  "curl -sS --max-time 25 -b ${2:-/tmp/jar} http://127.0.0.1:3774/status"; }
# The page's lifecycle buttons, driven the way the page drives them. An install
# answers as soon as it holds the lock (202) and finishes in the background, so
# a slow download cannot outlive the request behind a tunnel; the page learns
# the result from /status.
lifecycle_post() {
  docker exec "$NAME" sh -c "curl -sS -o /tmp/lifecycle.json -w '%{http_code}' -b /tmp/jar \
    -H 'content-type: application/json' -d '{\"id\":\"$2\"}' http://127.0.0.1:3774/harnesses/$1"
}
operation_result() {
  local state=""
  for _ in $(seq 1 150); do
    state="$(status_json | jq -r ".operations[\"harness:$1\"].state // \"\"")"
    case "$state" in running|queued|"") sleep 2 ;; *) break ;; esac
  done
  [ "$state" = ok ]
}

setup_state=""
for _ in $(seq 1 150); do
  setup_state="$(status_json 2>/dev/null | jq -r '.setup.state // "none"' 2>/dev/null || true)"
  [ "$setup_state" = finished ] && break
  sleep 4
done
if [ "$setup_state" = finished ]; then
  ok "first-start setup finished"
else
  no "first-start setup finished (state: ${setup_state:-unreadable})"
  docker logs "$NAME" 2>&1 | grep preinstall | tail -20
fi

setup_installed_defaults() {
  status_json | python3 -c '
import json, sys
items = json.load(sys.stdin)["setup"]["items"]
want = {"agent:" + i for i in ("claude", "codex", "opencode")} \
     | {"toolchain:" + i for i in ("go", "rust", "bun", "deno", "uv")}
planned = {i["kind"] + ":" + i["id"] for i in items}
done = {i["kind"] + ":" + i["id"] for i in items if i["state"] == "done"}
if want - done: print("not installed:", sorted(want - done))
if planned - want: print("installed unasked:", sorted(planned - want))
sys.exit(0 if want <= done and planned <= want else 1)'
}
check "the first start installs Claude Code, Codex, OpenCode and the toolchains, nothing else" setup_installed_defaults

# Grok and Cursor wait for someone to ask. Ask the way the Agents page does,
# one after the other, and everything below sees all five.
optional_agents_install() {
  local id code
  for id in grok cursor; do
    status_json | jq -e ".harnesses[] | select(.id == \"$id\") | .installed == false" >/dev/null || return 1
    code="$(lifecycle_post install "$id")"
    case "$code" in 200|202) ;; *) return 1 ;; esac
    operation_result "$id" || return 1
  done
}
check "Grok and Cursor are not installed unasked, and install from the page" optional_agents_install

agents_runnable() {
  status_json | python3 -c '
import json, sys
h = {a["id"]: a for a in json.load(sys.stdin)["harnesses"]}
sys.exit(0 if all(h[i]["runnable"] and h[i]["version"] for i in ("claude", "codex", "opencode", "grok", "cursor")) else 1)'
}
# Retried: the card's facts refresh on the poll after the last install lands.
check "every agent is runnable at a recorded version" "retry 10 agents_runnable"

# T3 learns about each agent through its settings file, as soon as the agent
# lands. Read it the way T3 does.
t3_points_at_managed_agents() {
  docker exec -u t3 "$NAME" cat /home/t3/.t3/userdata/settings.json | python3 -c '
import json, sys
p = json.load(sys.stdin).get("providers", {})
drivers = ("claudeAgent", "codex", "opencode", "grok", "cursor")
sys.exit(0 if all(p.get(d, {}).get("binaryPath", "").startswith("/home/t3/.local/share/mise/installs/") for d in drivers) else 1)'
}
check "T3 is pointed at every managed agent" t3_points_at_managed_agents

# Cursor's package carries its own node and rg. Installed through mise's
# registry as-is, they shadowed the image's for every agent and terminal.
image_node_wins() {
  docker exec -u t3 "$NAME" bash -lc 'cd /tmp &&
    [ "$(command -v node)" = /usr/local/bin/node ] &&
    case "$(command -v rg || echo none)" in *mise*) false ;; *) true ;; esac'
}
check "Cursor's bundled node does not shadow the image's" image_node_wins
# `docker exec` has none of the t3 user's shell setup; the dispatcher still
# runs the managed install, as t3 even when called as root - Cursor included,
# which has no shim at all.
agents_by_name_from_exec() {
  local want got
  want="$(status_json | jq -r '.harnesses[] | select(.id == "claude") | .version')"
  got="$(docker exec "$NAME" claude --version 2>/dev/null | head -1)"
  case "$got" in *"$want"*) ;; *) return 1 ;; esac
  docker exec -u t3 "$NAME" opencode --version >/dev/null 2>&1 &&
  docker exec -u t3 "$NAME" cursor-agent --version >/dev/null 2>&1 &&
  [ "$(docker exec "$NAME" sh -c 'stat -c %U /home/t3/.claude.json 2>/dev/null || echo t3')" = t3 ]
}
check "agents run by name from docker exec, as the t3 user" agents_by_name_from_exec
# Cursor has no mise shim, so the manager links the installed executable onto
# the t3 user's PATH; a terminal (and T3's own lookup) finds exactly that.
check "a login shell finds the installed cursor-agent through its link" \
  "docker exec -u t3 $NAME bash -lc 'cd /tmp && readlink \"\$(command -v cursor-agent)\"' | grep -q '/mise/installs/cursor-agent/'"
# T3 reads its PATH from `$SHELL -ilc` and calls an agent installed when its
# name is found there. The dispatcher answers to every name, so it must never
# be on that PATH, or an uninstalled agent reads as installed.
check "T3's login-shell PATH does not include the agent dispatcher" \
  "! docker exec -u t3 $NAME bash -ilc 'echo \"\$PATH\"' 2>/dev/null | grep -q t3-agents"
check "toolchains run from any directory, as the t3 user" \
  "docker exec -u t3 $NAME bash -lc 'cd /tmp && go version && cargo --version && cargo clippy --version && rustfmt --version && bun --version && deno --version && uv --version'"

# T3 refuses an OpenCode below the floor its own binary declares, and the
# manager refuses to select one. Both read the same number, or a T3 bump that
# raises it slips through until someone's session fails.
opencode_floor_matches_t3() {
  local declared catalogue installed
  declared="$(docker exec "$NAME" sh -c \
    "grep -a -o 'MINIMUM_OPENCODE_VERSION *= *\"[0-9][0-9.]*\"' $T3_BUNDLE | head -1" 2>/dev/null \
    | grep -o '[0-9][0-9.]*' | head -1)"
  catalogue="$(docker exec "$NAME" sh -c \
    "grep -o 'MINIMUM_OPENCODE_VERSION = \"[0-9.]*\"' /opt/t3-harness/catalogue.mjs" \
    | grep -o '[0-9][0-9.]*')"
  installed="$(status_json | jq -r '.harnesses[] | select(.id == "opencode") | .version')"
  [ -n "$declared" ] && [ "$declared" = "$catalogue" ] && version_at_least "$installed" "$declared"
}
check "the OpenCode floor matches T3's, and the install meets it" opencode_floor_matches_t3

# Agent authentication, driven the way the page drives it, against the agents
# the first start installed.
printf '\nAgent authentication (variant %s)\n' "$VARIANT"
auth_post() { docker exec "$NAME" sh -c "curl -sS -b /tmp/jar -H 'content-type: application/json' -d '$1' http://127.0.0.1:3774$2"; }
as_t3() { docker exec -u t3 "$NAME" bash -lc "$1"; }

codex_key_stored() {
  auth_post '{"agent":"codex","key":"sk-smoke-test-key"}' /auth/apikey | grep -q '"ok":true' &&
  as_t3 'codex login status' 2>&1 | grep -q "API key"
}
check "an API key signs Codex in" codex_key_stored

opencode_key_stored() {
  auth_post '{"agent":"opencode","provider":"deepseek","key":"sk-smoke"}' /auth/apikey | grep -q '"ok":true' &&
  docker exec -u t3 "$NAME" sh -c 'grep -q deepseek ~/.local/share/opencode/auth.json'
}
check "an API key is written for OpenCode" opencode_key_stored

check "an unknown agent is refused" \
  "auth_post '{\"agent\":\"bogus\",\"key\":\"x\"}' /auth/apikey | grep -q error"

# The panel used to decide this from a credentials file on disk, which misses
# every credential that never lands there. T3 Code honours ANTHROPIC_API_KEY and
# CLAUDE_CODE_OAUTH_TOKEN, so a container holding one showed as authenticated in
# T3 Code and "Not signed in" here. Ask each CLI instead. This container only
# preinstalls Claude, which also proves the variable picks a subset, and that a
# harness that is not installed reads as unknown rather than signed out.
env_token_reads_as_signed_in() {
  docker rm -f "${NAME}-env" >/dev/null 2>&1 || true
  docker run -d --name "${NAME}-env" -e T3_SETUP_KEY=envkey -e T3_PREINSTALL=claude \
    -e CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-smoke "$IMAGE" >/dev/null
  retry 25 "docker exec ${NAME}-env sh -c \"curl -sS --max-time 5 -c /tmp/envjar \
    -d 'key=envkey' -o /dev/null http://127.0.0.1:3774/login && \
    curl -fsS --max-time 20 -b /tmp/envjar http://127.0.0.1:3774/status | grep -q harnesses\"" || return 1
  for _ in $(seq 1 60); do
    [ "$(status_json "${NAME}-env" /tmp/envjar | jq -r '.setup.state // ""' 2>/dev/null)" = finished ] && break
    sleep 4
  done
  retry 10 claude_reads_signed_in_from_env
}
claude_reads_signed_in_from_env() {
  status_json "${NAME}-env" /tmp/envjar | python3 -c '
import json, sys
s = json.load(sys.stdin)
h = {a["id"]: a for a in s["harnesses"]}
only_claude = [i["id"] for i in s["setup"]["items"]] == ["claude"]
others_unknown = all(h[i]["signedIn"] is None and not h[i]["installed"] for i in ("codex", "grok", "cursor"))
sys.exit(0 if h["claude"]["signedIn"] is True and only_claude and others_unknown else 1)'
}
check "an env-var Claude credential reads as signed in" env_token_reads_as_signed_in
docker rm -f "${NAME}-env" >/dev/null 2>&1 || true

# Reading it correctly once is not enough: a cached verdict would keep saying
# "not signed in" straight after a key is stored, which is exactly when someone
# is looking at the panel.
key_flips_signed_in() {
  status_json | python3 -c '
import json, sys
h = {a["id"]: a for a in json.load(sys.stdin)["harnesses"]}
sys.exit(0 if h["codex"]["signedIn"] is True and h["claude"]["signedIn"] is False else 1)'
}
check "a stored key flips the panel without waiting for a cache" key_flips_signed_in

# Grok has no status command, and its credentials file proves nothing - a file
# of exactly the shape its own help text documents still leaves the CLI saying
# "You are not authenticated". So the reading comes from `grok models`, the way
# T3 Code does it, and a fresh container must read as a definite no.
grok_reads_definitely() {
  status_json | python3 -c '
import json, sys
h = {a["id"]: a for a in json.load(sys.stdin)["harnesses"]}
sys.exit(0 if h["grok"]["signedIn"] is False and h["cursor"]["signedIn"] is False else 1)'
}
check "Grok and Cursor report a definite sign-in state" grok_reads_definitely

session_state() {
  docker exec "$NAME" sh -c "curl -sS -b /tmp/jar 'http://127.0.0.1:3774/auth/session?id=$1'"
}
signin_id() {
  auth_post "{\"agent\":\"$1\"}" /auth/signin | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'
}

# Claude renders its URL as an OSC-8 hyperlink wrapped over several lines;
# scraping the visible text yields a truncated URL missing the PKCE challenge
# and state, which would send you to a sign-in page that cannot complete.
claude_url_complete() {
  local id
  id="$(signin_id claude)"
  [ -n "$id" ] || return 1
  sleep 14
  session_state "$id" | grep -q 'code_challenge' &&
  session_state "$id" | grep -q '"state":"awaiting-code"'
}
check "Claude sign-in captures a complete OAuth URL" claude_url_complete

# Capturing the URL is half the flow; the code has to get back in. That prompt
# runs the terminal in raw mode, where Enter arrives as CR - an LF is taken as
# part of the pasted text and the prompt just sits there, which is what left the
# panel saying "Submitting" for ever. A rejected code is the only exchange that
# can be driven without an account, and it proves the same thing: the CLI read
# the line, tried it, and answered. Stuck on "submitted" means it never did.
claude_code_reaches_the_prompt() {
  local id state
  id="$(signin_id claude)"
  [ -n "$id" ] || return 1
  sleep 14
  auth_post "{\"id\":\"$id\",\"code\":\"bogusCode123#bogusState456\"}" /auth/code >/dev/null
  state=submitted
  for _ in $(seq 1 20); do
    state="$(session_state "$id" | sed -n 's/.*"state":"\([^"]*\)".*/\1/p')"
    [ "$state" != "submitted" ] && break
    sleep 2
  done
  # And the verdict has to stick. The child is killed once its output says the
  # code was rejected, and `script` reports that kill as a clean exit, which
  # flipped the session to "done" a moment later. Re-read after it settles.
  sleep 6
  state="$(session_state "$id" | sed -n 's/.*"state":"\([^"]*\)".*/\1/p')"
  [ "$state" = "failed" ]
}
check "a pasted code reaches the Claude prompt" claude_code_reaches_the_prompt

# Completion is "this agent is signed in now", not "the CLI exited": these are
# terminal UIs, and one that prints its result and stays up is not a failure.
# Codex is the one whose state can be flipped from outside mid-flow, so use it
# - signed out first, since only a transition counts.
signin_finishes_on_transition() {
  local id state
  docker exec -u t3 "$NAME" sh -c 'rm -f ~/.codex/auth.json'
  id="$(signin_id codex)"
  [ -n "$id" ] || return 1
  sleep 12
  auth_post '{"agent":"codex","key":"sk-smoke-transition"}' /auth/apikey | grep -q '"ok":true' || return 1
  for _ in $(seq 1 10); do
    state="$(session_state "$id" | sed -n 's/.*"state":"\([^"]*\)".*/\1/p')"
    [ "$state" = "done" ] && return 0
    sleep 3
  done
  return 1
}
check "a sign-in finishes when the agent becomes signed in" signin_finishes_on_transition

# Codex's default login starts a callback server on localhost:1455, which is
# unreachable from a browser on any other machine. Any sign-in URL naming
# localhost is broken by construction for a remote server.
codex_device_not_localhost() {
  local id session
  docker exec -u t3 "$NAME" sh -c 'rm -f ~/.codex/auth.json'
  id="$(signin_id codex)"
  [ -n "$id" ] || return 1
  sleep 13
  session="$(session_state "$id")"
  printf '%s' "$session" | grep -q 'auth.openai.com/codex/device' &&
  ! printf '%s' "$session" | grep -q localhost
}
check "Codex signs in by device code, not a localhost callback" codex_device_not_localhost

grok_device_code() {
  local id
  id="$(signin_id grok)"
  [ -n "$id" ] || return 1
  sleep 12
  session_state "$id" | grep -q 'accounts.x.ai'
}
check "Grok sign-in captures a device URL" grok_device_code

# OpenCode takes a key per provider and there are over two hundred of them, so
# the page offers the models.dev catalog rather than asking you to recall an id.
provider_catalog() {
  docker exec "$NAME" sh -c \
    "curl -sS --max-time 30 -b /tmp/jar http://127.0.0.1:3774/providers" | python3 -c '
import json, sys, re
d = json.load(sys.stdin)
ids = [p["id"] for p in d["providers"]]
ok = len(ids) >= 10 and "anthropic" in ids
# Every id the picker offers has to survive the write path, or the dropdown
# hands people options the server then rejects.
rx = re.compile(r"^[a-z0-9][a-z0-9._-]{0,39}$")
sys.exit(0 if ok and all(rx.match(i) for i in ids) else 1)'
}
check "the provider picker offers a catalog the server accepts" provider_catalog

printf '\nAgent lifecycle from the page\n'
grok_binary_path() {
  docker exec -u t3 "$NAME" cat /home/t3/.t3/userdata/settings.json | jq -r '.providers.grok.binaryPath // ""'
}

uninstall_retracts_t3_wiring() {
  local code
  code="$(lifecycle_post uninstall grok)"
  { [ "$code" = 200 ] || { [ "$code" = 202 ] && operation_result grok; }; } || return 1
  [ -z "$(grok_binary_path)" ] &&
  status_json | jq -e '.harnesses[] | select(.id == "grok") | .installed == false' >/dev/null
}
check "uninstall from the page removes the agent and T3's path to it" uninstall_retracts_t3_wiring

install_answers_then_finishes() {
  local code
  code="$(lifecycle_post install grok)"
  [ "$code" = 202 ] || return 1
  operation_result grok &&
  status_json | jq -e '.harnesses[] | select(.id == "grok") | .runnable' >/dev/null &&
  case "$(grok_binary_path)" in /home/t3/.local/share/mise/installs/grok/*) true ;; *) false ;; esac
}
check "install from the page answers at once and finishes in the background" install_answers_then_finishes

# Any other mise tool, added from the Toolchains page: found in mise's registry,
# installed at an exact version into the global config, runnable from a login
# shell, listed by the CLI, refused under an agent's name, and removed again.
# shfmt is one small binary with published checksums, so this stays quick.
package_post() {
  docker exec "$NAME" sh -c "curl -sS -o /tmp/package.json -w '%{http_code}' -b /tmp/jar \
    -H 'content-type: application/json' -d '{\"id\":\"$2\"}' http://127.0.0.1:3774/packages/$1"
}
package_settled() {
  local state=""
  for _ in $(seq 1 90); do
    state="$(status_json | jq -r ".operations[\"package:$1\"].state // \"\"")"
    case "$state" in running|queued|"") sleep 2 ;; *) break ;; esac
  done
  [ "$state" = ok ]
}
registry_is_served() {
  local registry
  registry="$(docker exec "$NAME" curl -sS -b /tmp/jar http://127.0.0.1:3774/packages/registry)" || return 1
  jq -e '(.tools | length) > 500 and any(.tools[]; .name == "shfmt")' >/dev/null <<<"$registry"
}
check "the console serves mise's registry" registry_is_served
added_tool_installs() {
  [ "$(package_post install shfmt)" = 202 ] || return 1
  package_settled shfmt || return 1
  status_json | jq -e '.packages[] | select(.id == "shfmt" and .installed and (.version | test("^[0-9]+[.]")))' >/dev/null || return 1
  docker exec -u t3 "$NAME" grep -Eq '^shfmt = "[0-9]+[.][0-9.]+"' /home/t3/.config/mise/config.toml || return 1
  docker exec -u t3 "$NAME" bash -lc 'cd /tmp && shfmt --version' >/dev/null 2>&1
}
check "any mise tool installs from the page, pinned exactly, and runs in a login shell" added_tool_installs
check "and the CLI lists it" "output_has 'docker exec $NAME t3-harness packages' '^shfmt'"
added_tool_refused_under_an_agents_name() {
  [ "$(package_post install claude-code)" = 400 ] || return 1
  docker exec "$NAME" jq -e '.code == "managed-elsewhere"' /tmp/package.json >/dev/null
}
check "an agent's name is refused as an added tool" added_tool_refused_under_an_agents_name
added_tool_uninstalls() {
  case "$(package_post uninstall shfmt)" in 200|202) ;; *) return 1 ;; esac
  package_settled shfmt || return 1
  ! status_json | jq -e '.packages[] | select(.id == "shfmt")' >/dev/null || return 1
  ! docker exec -u t3 "$NAME" grep -q '^shfmt' /home/t3/.config/mise/config.toml
}
check "and uninstalls, leaving nothing in the config or the list" added_tool_uninstalls

# The client script used to be embedded in a template literal in server.mjs,
# which quietly ate escapes on the way out: `/\s+/` reached the browser as
# `/s+/` and split agent names on the letter s. That is not a syntax error in
# the result, so parsing it proves nothing; assert instead that what the
# browser receives is byte-for-byte the file on disk.
client_script_is_verbatim() {
  PAGE_HTML="$(mktemp)"; SETUP_COPY="$(mktemp -d)"
  docker exec "$NAME" sh -c \
    "curl -sS -c /tmp/j3 -d 'key=$SETUP_KEY' -o /dev/null http://127.0.0.1:3774/login && \
     curl -sS -b /tmp/j3 http://127.0.0.1:3774/" > "$PAGE_HTML" || return 1
  docker cp "$NAME:/opt/t3-setup/." "$SETUP_COPY" >/dev/null 2>&1 || return 1
  # Every inlined script names its file; each must arrive byte for byte.
  python3 - "$PAGE_HTML" "$SETUP_COPY" <<'PYEOF'
import os, re, sys
page = open(sys.argv[1], encoding="utf-8").read()
blocks = re.findall(r'<script nonce="[^"]*" data-src="([^"]+)">(.*?)</script>', page, re.S)
if [src for src, _ in blocks] != ["client/base.js", "design/ui.js", "client/model.js", "client/kit.js", "app.js"]:
    sys.exit(1)
for src, code in blocks:
    if code != open(os.path.join(sys.argv[2], src), encoding="utf-8").read():
        sys.exit(1)
PYEOF
}
# Antigravity is T3 Code's to install: it pins Google's runtime and owns the
# sign-in, and the console drives both through T3's own API. Without pulling
# the 650 MB runtime here, check the console reaches that API as a session of
# its own, reads the release T3 would install, and keeps that session off the
# Devices page.
printf '\nAntigravity through T3 Code\n'
antigravity_row_from_t3() {
  status_json | jq -e '.harnesses[] | select(.id == "antigravity")
    | .managedBy == "t3" and .reachable and .available and ((.latestVersion // "") | length > 0)' >/dev/null
}
check "Antigravity's row comes from T3 Code's own API" "retry 10 antigravity_row_from_t3"
console_session_is_not_a_device() {
  docker exec "$NAME" t3 auth session list --json 2>/dev/null | grep -q '"t3-setup-console"' &&
  ! status_json | jq -e '.sessions[] | select(.subject == "t3-setup-console")' >/dev/null
}
check "the console's own T3 session is not listed as a device" console_session_is_not_a_device

printf '\nPorts\n'

# T3 Code fetches cloudflared at runtime when it is missing, which needs egress
# at the moment you are trying to get connected. Shipping it is only useful if
# T3 Code actually finds it, so assert the pointer as well as the binary.
check "cloudflared ships in the image" \
  "docker exec $NAME cloudflared --version"
check "T3 Code is pointed at the shipped binary" \
  "docker exec $NAME sh -c 'test -x \"\$T3CODE_CLOUDFLARED_PATH\"'"

cloudflared_matches_t3() {
  local want have
  # The binary distribution has no greppable server bundle, so the Dockerfile
  # pin is the compatibility assertion.
  want="$(grep -m1 '^ARG CLOUDFLARED_VERSION=' Dockerfile | cut -d= -f2)"
  have="$(docker exec "$NAME" cloudflared --version 2>/dev/null | awk '{print $3}')"
  CF_WANT="$want"; CF_HAVE="$have"
  [ "$want" = "$have" ]
}
if cloudflared_matches_t3; then
  ok "cloudflared ${CF_HAVE:-?} is the release T3 Code asks for"
else
  no "cloudflared is ${CF_HAVE:-?}, T3 Code downloads ${CF_WANT:-?}"
fi

# A dev server in the container is unreachable from a phone, which is the one
# device this project assumes you have. These assert the plumbing that fixes
# that; they deliberately do not open a tunnel, since CI should not depend on
# reaching Cloudflare's edge.
# As t3, like a dev server started from a T3 Code terminal: the setup service
# runs as t3 too, and can name only processes it is allowed to see.
docker exec -d -u t3 "$NAME" sh -c \
  'cd /tmp && python3 -m http.server 3000 --bind 127.0.0.1 >/dev/null 2>&1' || true
sleep 2

# Nesting quotes through bash -> docker exec -> sh -c -> curl is how you get a
# test that passes for the wrong reason, so these go through functions.
# Uses the header the in-container CLIs authenticate with, which is the same
# key and the same check the page's cookie goes through.
ports_api() {
  docker exec "$NAME" curl -sS -H "x-t3-setup-key: $SETUP_KEY" \
    "http://127.0.0.1:3774/ports"
}
expose_api() {
  docker exec "$NAME" curl -sS -H "x-t3-setup-key: $SETUP_KEY" \
    -H "content-type: application/json" \
    -d "{\"port\":$1}" "http://127.0.0.1:3774/ports/expose"
}
port_3000_listed() { ports_api | tr -d " " | grep -q "\"listening\":\[3000"; }
# The page names what listens: the command line says http.server where ss
# would only say python3.
port_3000_named() { ports_api | tr -d " " | grep -q '"port":3000,"process":"http.server"'; }
reserved_port_refused() { expose_api 3774 | grep -q "T3 Code itself"; }
bad_port_refused() { expose_api 99999 | grep -q "between 1 and 65535"; }

check "a listening port is discovered" port_3000_listed
check "and named for what it runs" port_3000_named

# T3 Code's own agent probes open short-lived listeners on kernel-assigned
# ports. Listing them made the panel churn every few seconds and buried the dev
# server someone actually started, so discovery hides that range - while
# `t3-expose <port>` still publishes one by number.
ephemeral_port_hidden() {
  local lo port
  lo="$(docker exec "$NAME" sh -c 'cut -f1 /proc/sys/net/ipv4/ip_local_port_range')"
  port=$((lo + 101))
  docker exec -d "$NAME" sh -c "cd /tmp && python3 -m http.server $port --bind 127.0.0.1" || return 1
  sleep 2
  # it is listening ...
  docker exec "$NAME" sh -c "ss -Hltn | grep -q ':$port'" || return 1
  # ... and deliberately not offered as something to publish
  ! ports_api | tr -d " " | grep -q "\"listening\":\[[^]]*$port"
}
check "a kernel-assigned port is not offered for publishing" ephemeral_port_hidden
check "the ports API needs the key" \
  "docker exec $NAME sh -c 'curl -sS http://127.0.0.1:3774/ports | grep -q unauthorized'"
check "publishing T3 Code's own port is refused" reserved_port_refused
check "a nonsense port is refused" bad_port_refused

# The point of routing the CLI through the same API is that the two cannot
# disagree. Assert that they see the same port rather than trusting it.
check "t3-expose reports what the API reports" \
  "docker exec $NAME t3-expose | grep -q '^3000'"
check "cloudflared's own metrics port is not offered as a user port" \
  "docker exec $NAME t3-expose | grep -cq 'not published'"

# Screenshots prove the page renders; they do not prove it is square. This
# measures the rendered geometry - glyphs off centre in their box, buttons in
# one group with different heights - across the viewport matrix. Only the
# browser variant carries a browser to do it with.
console_layout_is_clean() {
  [ "$HAS_BROWSER" -eq 1 ] || return 0
  docker exec "$NAME" test -x /usr/bin/chromium 2>/dev/null || return 1
  docker cp scripts/ui-audit.js "$NAME:/tmp/ui-audit.js" >/dev/null 2>&1 || return 1
  docker exec \
    -e NODE_PATH=/opt/t3-mcp/lib/node_modules/@playwright/mcp/node_modules \
    -e CHROME_PATH=/usr/bin/chromium \
    "$NAME" node /tmp/ui-audit.js "http://127.0.0.1:3774/" "$SETUP_KEY" \
    >"$UI_AUDIT_LOG" 2>&1
}
check "the console has no layout defects" console_layout_is_clean

# The bridge on T3's own pages, in a real browser, with the console routed
# beside T3 on one origin (the audit starts that router itself): the pill
# before pairing, Setup in Settings, the dialog and its phone layout.
setup_bridge_works() {
  [ "$HAS_BROWSER" -eq 1 ] || return 0
  local credential
  credential="$(docker exec "$NAME" node -e '
    const { execFileSync } = require("node:child_process");
    const out = execFileSync("t3", ["auth", "pairing", "create", "--base-url", "http://127.0.0.1", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    process.stdout.write(JSON.parse(out.slice(out.indexOf("{"))).credential);
  ')" || return 1
  docker cp scripts/setup-bridge-audit.js "$NAME:/tmp/setup-bridge-audit.js" >/dev/null 2>&1 || return 1
  { printf '\nsetup-bridge-audit:\n'
    docker exec \
      -e NODE_PATH=/opt/t3-mcp/lib/node_modules/@playwright/mcp/node_modules \
      -e CHROME_PATH=/usr/bin/chromium \
      -e T3_PAIR_CREDENTIAL="$credential" \
      "$NAME" node /tmp/setup-bridge-audit.js 2>&1
  } >>"$UI_AUDIT_LOG"
}
check "T3 Code's pages reach the console: the pill, Setup in Settings, the dialog" setup_bridge_works

check "the browser gets the client script verbatim" client_script_is_verbatim
check "and those scripts parse" \
  "docker exec $NAME sh -c 'for f in /opt/t3-setup/app.js /opt/t3-setup/client/*.js /opt/t3-setup/design/ui.js; do node --check \"\$f\" || exit 1; done'"

# A proxy routing a path prefix here forwards it intact. Serving the page only
# at / turned that into a bare "unauthorized", which reads as a wrong password.
# A proxy that STRIPS the prefix leaves the server seeing "/" - it cannot infer
# a mount that is no longer in the path. Then the page called /status at the
# origin root, which such a proxy does not route back, and the console sat on
# skeletons saying only "could not read status". Honour the header proxies send
# for exactly this.
# Captured rather than piped: this script runs with pipefail, and `grep -q`
# closes the pipe the moment it matches, so a page big enough not to fit the
# pipe buffer kills curl with SIGPIPE and the assertion fails for a reason that
# has nothing to do with what it is testing.
page_says_mount() {
  local page
  page="$(docker exec "$NAME" curl -sS --max-time 10 "$@")" || return 1
  case "$page" in
    *"window.__T3_SETUP_BASE__ = \"/__setup\";"*) return 0 ;;
    *) return 1 ;;
  esac
}
forwarded_prefix_is_honoured() {
  page_says_mount -H "x-forwarded-prefix: /__setup" "http://127.0.0.1:3774/"
}
check "honours X-Forwarded-Prefix when the proxy strips the path" \
  forwarded_prefix_is_honoured

# The client's own fallback for proxies that strip and say nothing: the page
# knows where it was loaded from even when the server does not.
check "the page falls back to its own path when no mount is known" \
  "docker exec $NAME grep -q 'pageBase()' /opt/t3-setup/client/base.js"

# This is the assertion that should have caught the mount going missing: the
# old one only proved a page came back under a prefix, not that the page was
# told where it lives. It came back fine while every API call it made went to
# the origin root.
mount_is_declared() { page_says_mount "http://127.0.0.1:3774/__setup"; }
check "and tells the page which prefix it is under" mount_is_declared

# Captured rather than piped into `grep -q`: the page is ~90 KB, and grep exits
# at the first match, so curl is killed writing the rest and fails under
# pipefail. It raced on amd64 and lost reliably under arm64 emulation.
serves_page_under_prefix() {
  local page
  page="$(docker exec "$NAME" curl -fsS --max-time 5 http://127.0.0.1:3774/__setup)" || return 1
  case "$page" in
    *'<!doctype html>'*|*'<!DOCTYPE html>'*) return 0 ;;
    *) return 1 ;;
  esac
}
check "serves the page under an unconfigured path prefix" \
  "retry 5 serves_page_under_prefix"
check "and its routes work under that prefix" \
  "retry 5 \"docker exec $NAME sh -c \\\"curl -sS --max-time 5 -c /tmp/j2 -d 'key=$SETUP_KEY' -o /dev/null http://127.0.0.1:3774/__setup/login && curl -fsS --max-time 5 -b /tmp/j2 http://127.0.0.1:3774/__setup/status | grep -q publicUrl\\\"\""

# Retrying above would hide a service that is actually crash-looping, so assert
# separately that it started once and stayed up.
setup_stayed_up() {
  ! docker logs "$NAME" 2>&1 | grep -q "setup service exited"
}
check "the setup service did not crash-loop" setup_stayed_up

# T3_PUBLIC_URL is the container's own configuration: the page cannot change it.
url_is_pinned() {
  local answer
  answer="$(docker exec "$NAME" sh -c "curl -sS --max-time 10 -b /tmp/jar -H 'content-type: application/json' \
    -d '{\"url\":\"https://other.example.com\"}' http://127.0.0.1:3774/public-url")" || return 1
  [ "$(jq -r '.code' <<<"$answer")" = pinned ] || return 1
  [ "$(status_json | jq -r '"\(.publicUrl) \(.publicUrlSource)"')" = "${PUBLIC_URL} env" ]
}
check "a T3_PUBLIC_URL in the container's settings can't be changed from the page" url_is_pinned
check "nor can a T3_SETUP_KEY be replaced from it" \
  "docker exec $NAME sh -c \"curl -sS --max-time 10 -b /tmp/jar -H 'content-type: application/json' -d '{}' http://127.0.0.1:3774/setup-key/replace\" | jq -e '.code == \"pinned\"'"
rm -f "$SETUP_JAR"

# T3_SINGLE_PORT: one listener in front of both services, the way a hosting
# platform or a single-upstream tunnel reaches them. Every check below goes
# through it from the host, as a visitor would: T3's health and its pages, the
# setup page under its prefix with a session cookie scoped there, and T3's
# WebSocket opened with a session.
printf '\nOne port\n'
ONE_PORT="${SMOKE_ONE_PORT:-13780}"
ONE_URL="http://127.0.0.1:${ONE_PORT}"
ONE_JAR="$(mktemp)"
docker rm -f "${NAME}-one" >/dev/null 2>&1 || true
# Without T3_PUBLIC_URL, and with the variable Railway sets: the public URL
# checks below run against this container too.
ONE_PLATFORM_URL="https://t3-smoke.up.railway.app"
# No T3_SETUP_KEY either: the key checks below need the generated one.
docker run -d --name "${NAME}-one" -e T3_PREINSTALL=none \
  -e T3_SINGLE_PORT=8080 -e "RAILWAY_PUBLIC_DOMAIN=${ONE_PLATFORM_URL#https://}" \
  -p "127.0.0.1:${ONE_PORT}:8080" "$IMAGE" >/dev/null
one_up=0
for _ in $(seq 1 40); do
  if curl -fsS --noproxy '*' --max-time 3 "${ONE_URL}/.well-known/t3/environment" >/dev/null 2>&1; then
    one_up=1
    break
  fi
  [ "$(docker inspect -f '{{.State.Running}}' "${NAME}-one" 2>/dev/null)" = true ] || break
  sleep 3
done
if [ "$one_up" = 1 ]; then
  ok "T3 Code answers through the one port"
else
  no "T3 Code answers through the one port"
  docker logs "${NAME}-one" 2>&1 | tail -15
fi

# Without T3_SETUP_KEY, the first start generates a key and keeps it on the
# volume, where t3-expose and the page's later starts find it.
ONE_KEY_FILE=/home/t3/.t3/setup-key
ONE_KEY="$(docker exec "${NAME}-one" cat "$ONE_KEY_FILE" 2>/dev/null || true)"
check "without T3_SETUP_KEY, the first start generates a setup key and keeps it" \
  "[ -n \"\$ONE_KEY\" ] && output_has 'docker logs ${NAME}-one' 'generated a setup key and kept it on the volume'"
check "and only the t3 user can read it" \
  "[ \"\$(docker exec ${NAME}-one stat -c '%a %U' $ONE_KEY_FILE)\" = '600 t3' ]"

# Captured rather than piped into `grep -q`, for the reason given at
# page_says_mount below: grep exiting early kills curl under pipefail.
one_serves_t3_shell() {
  local page
  page="$(curl -fsS --noproxy '*' --max-time 10 -H 'accept: text/html' "${ONE_URL}/")" || return 1
  case "$page" in *'data-t3-setup-bridge'*) return 0 ;; *) return 1 ;; esac
}
check "T3 Code's pages come through it, setup bridge included" one_serves_t3_shell
check "the setup page answers under /__setup on it" \
  "retry 10 \"curl -fsS --noproxy '*' --max-time 5 ${ONE_URL}/__setup/hello | grep -q '\\\"service\\\":\\\"t3-setup\\\"'\""
one_signs_in() {
  curl -sS --noproxy '*' --max-time 10 -c "$ONE_JAR" -d "key=${ONE_KEY}" -o /dev/null "${ONE_URL}/__setup/login" || return 1
  # Netscape cookie jar: the path is the third field.
  awk '$6 == "t3setup" && $3 == "/__setup" { found = 1 } END { exit !found }' "$ONE_JAR" || return 1
  [ "$(curl -fsS --noproxy '*' --max-time 20 -b "$ONE_JAR" -H 'accept: application/json' \
       "${ONE_URL}/__setup/status" | jq -r '.singlePort.port')" = 8080 ]
}
check "and signs in there, its cookie scoped to /__setup, and says it is on one port" \
  "retry 5 one_signs_in"
one_opens_websocket() {
  docker exec "${NAME}-one" node -e '
    const { execFileSync } = require("node:child_process");
    const out = execFileSync("t3", ["auth", "session", "issue", "--ttl", "5m", "--label", "smoke", "--subject", "smoke-one-port", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const { token } = JSON.parse(out.slice(out.indexOf("{")));
    const ws = new WebSocket("ws://127.0.0.1:8080/ws", { headers: { authorization: `Bearer ${token}` } });
    const timer = setTimeout(() => process.exit(2), 10000);
    ws.addEventListener("open", () => ws.send(JSON.stringify({ _tag: "Ping" })));
    ws.addEventListener("message", (event) => {
      if (String(event.data).includes("Pong")) { clearTimeout(timer); ws.close(); process.exit(0); }
    });
    ws.addEventListener("error", () => process.exit(1));
  '
}
check "T3's WebSocket opens through it with a session, and answers" one_opens_websocket
check "ports 3773 and 3774 still answer inside the container" \
  "docker exec ${NAME}-one sh -c 'curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3773/.well-known/t3/environment && curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3774/hello'"
check "t3-expose will not publish the one port, and says why" \
  "output_has 'docker exec ${NAME}-one t3-expose 8080' 'belongs to T3 Code'"
check "t3-doctor checks the one port" \
  "output_has 'docker exec ${NAME}-one t3-doctor' 'reaches T3 Code'"
check "the log says where everything is" \
  "output_has 'docker logs ${NAME}-one' 'listening on .*:8080: T3 Code (port 3773) at /, the setup page (port 3774) at /__setup'"
# Asked through the one port, so this also proves the router stayed up long
# enough for Docker to see it.
one_healthy() {
  local status=""
  for _ in $(seq 1 30); do
    status="$(docker inspect --format '{{.State.Health.Status}}' "${NAME}-one" 2>/dev/null || true)"
    [ "$status" = healthy ] && return 0
    [ "$status" = unhealthy ] && return 1
    sleep 5
  done
  return 1
}
check "the docker healthcheck asks through it and reports healthy" one_healthy
check "the router did not crash-loop" "! output_has 'docker logs ${NAME}-one' 'router exited'"

# The public URL without T3_PUBLIC_URL: the platform's, then one saved on the
# setup page, which applies at once, reaches t3-pair, and survives a restart,
# then the platform's again once it is cleared.
printf '\nPublic URL\n'
one_status() {
  curl -fsS --noproxy '*' --max-time 25 -b "$ONE_JAR" -H 'accept: application/json' "${ONE_URL}/__setup/status"
}
one_public_url() { one_status | jq -r '"\(.publicUrl) \(.publicUrlSource)"'; }
one_set_url() {
  curl -sS --noproxy '*' --max-time 25 -b "$ONE_JAR" -H 'content-type: application/json' \
    -d "$1" "${ONE_URL}/__setup/public-url${2:-}"
}
check "the hosting platform's address is the public URL when nothing else is" \
  "[ \"\$(one_public_url)\" = '${ONE_PLATFORM_URL} platform' ]"
check "the startup log names it and where it came from" \
  "output_has 'docker logs ${NAME}-one' 'public URL: ${ONE_PLATFORM_URL} (from Railway)'"
one_saves_url() {
  local answer
  answer="$(one_set_url '{"url":"http://127.0.0.1:8080"}')" || return 1
  # The container asks the address itself, and finds this server there.
  [ "$(jq -r '.check.reaches' <<<"$answer")" = this ] || return 1
  [ "$(one_public_url)" = "http://127.0.0.1:8080 saved" ]
}
check "an address saved on the setup page is checked and applies at once" one_saves_url
check "a path is refused, saying what to use instead" \
  "one_set_url '{\"url\":\"https://t3.example.com/app\"}' | jq -e '.code == \"invalid\" and (.error | contains(\"use https://t3.example.com\"))'"
check "t3-pair builds its link from it" \
  "output_has 'docker exec ${NAME}-one t3-pair --no-qr --ttl 5m' 'Pairing URL: http://127.0.0.1:8080/pair#token='"
check "t3-doctor shows it with where it came from" \
  "output_has 'docker exec ${NAME}-one t3-doctor' 'http://127.0.0.1:8080 (set on the setup page)'"
one_url_survives_restart() {
  docker restart "${NAME}-one" >/dev/null || return 1
  retry 30 "curl -fsS --noproxy '*' --max-time 3 -o /dev/null ${ONE_URL}/.well-known/t3/environment" || return 1
  retry 15 "[ \"\$(one_public_url)\" = 'http://127.0.0.1:8080 saved' ]"
}
check "and it survives a restart" one_url_survives_restart
# The status read above already used the cookie from before the restart; the
# file and the log say why.
check "the setup key is the same after a restart" \
  "[ \"\$(docker exec ${NAME}-one cat $ONE_KEY_FILE)\" = \"\$ONE_KEY\" ] && output_has 'docker logs ${NAME}-one' 'the setup key kept on the volume is'"
check "clearing it goes back to the platform's" \
  "one_set_url '{}' /clear >/dev/null && [ \"\$(one_public_url)\" = '${ONE_PLATFORM_URL} platform' ]"

# Replacing the key: the old one stops working at once, the browser that asked
# stays signed in on a cookie for the new one, the volume holds it, and
# t3-expose (which reads the file) follows it.
one_status_code() { curl -sS --noproxy '*' --max-time 10 -o /dev/null -w '%{http_code}' -H 'accept: application/json' "$@" "${ONE_URL}/__setup/status"; }
one_replaces_key() {
  local answer new
  answer="$(curl -sS --noproxy '*' --max-time 10 -b "$ONE_JAR" -c "$ONE_JAR" -H 'content-type: application/json' \
    -d '{}' "${ONE_URL}/__setup/setup-key/replace")" || return 1
  new="$(jq -r '.key // empty' <<<"$answer")"
  [ -n "$new" ] && [ "$new" != "$ONE_KEY" ] || return 1
  [ "$(docker exec "${NAME}-one" cat "$ONE_KEY_FILE")" = "$new" ] || return 1
  [ "$(one_status_code -b "$ONE_JAR")" = 200 ] || return 1
  [ "$(one_status_code -H "x-t3-setup-key: ${ONE_KEY}")" = 401 ] || return 1
  [ "$(one_status_code -H "x-t3-setup-key: ${new}")" = 200 ] || return 1
  ONE_KEY="$new"
}
check "the setup page replaces the key: the old one stops working, the browser stays in" one_replaces_key
check "and t3-expose follows the new key" \
  "output_has 'docker exec ${NAME}-one t3-expose' 'PORT\\|Nothing is listening'"

# T3 Code runs under docker/run-t3.sh, so the setup page can restart it (T3
# Connect's link takes effect on a start) while the container keeps running.
printf '\nRestarting T3 Code, T3 Connect\n'
ONE_PID_FILE=/tmp/t3code/t3.pid
one_t3_pid() { docker exec "${NAME}-one" cat "$ONE_PID_FILE" 2>/dev/null; }
one_restarts_t3() {
  local before started code
  before="$(one_t3_pid)"
  [ -n "$before" ] || return 1
  started="$(docker inspect -f '{{.State.StartedAt}}' "${NAME}-one")"
  code="$(curl -sS --noproxy '*' --max-time 10 -o /dev/null -w '%{http_code}' -b "$ONE_JAR" \
    -H 'content-type: application/json' -d '{}' "${ONE_URL}/__setup/t3/restart")"
  [ "$code" = 202 ] || return 1
  retry 30 "[ -n \"\$(one_t3_pid)\" ] && [ \"\$(one_t3_pid)\" != '$before' ] && curl -fsS --noproxy '*' --max-time 3 -o /dev/null ${ONE_URL}/.well-known/t3/environment" || return 1
  # The same container, not one the runtime restarted.
  [ "$(docker inspect -f '{{.State.StartedAt}}' "${NAME}-one")" = "$started" ]
}
check "the setup page restarts T3 Code, and the container keeps running" one_restarts_t3
check "the log says it was asked for" \
  "output_has 'docker logs ${NAME}-one' 'restarting T3 Code, as asked on the setup page'"
check "status reports T3 Connect off, with its relay client ready" \
  "one_status | jq -e '.connect.state == \"off\" and .connect.relayClient.status == \"available\"'"
# docker stop reaches T3 Code through the supervisor, which then exits with
# it, well inside the timeout: a SIGKILL at the deadline would read as 137.
one_stops_cleanly() {
  local started took code
  started=$SECONDS
  docker stop -t 30 "${NAME}-one" >/dev/null || return 1
  took=$((SECONDS - started))
  code="$(docker inspect -f '{{.State.ExitCode}}' "${NAME}-one")"
  [ "$took" -lt 25 ] && [ "$code" != 137 ]
}
check "docker stop shuts it down through the supervisor, not at the deadline" one_stops_cleanly
docker rm -f "${NAME}-one" >/dev/null 2>&1 || true

# A port the router cannot serve must stop the container with the reason, not
# leave one that starts and answers nothing where it was told to.
bad_port_is_refused() {
  local out rc=0
  docker rm -f "${NAME}-badport" >/dev/null 2>&1 || true
  out="$(timeout 90 docker run --name "${NAME}-badport" -e T3_PREINSTALL=none -e T3_SINGLE_PORT=3773 "$IMAGE" 2>&1)" || rc=$?
  docker rm -f "${NAME}-badport" >/dev/null 2>&1 || true
  [ "$rc" -ne 0 ] && [ "$rc" -ne 124 ] || return 1
  grep -q 'T3_SINGLE_PORT=3773 is the port T3 Code itself listens on' <<<"$out"
}
check "an impossible T3_SINGLE_PORT stops the container at start, saying why" bad_port_is_refused

printf '\nStartup pairing link\n'
docker rm -f "${NAME}-boot" >/dev/null 2>&1 || true
# With the whole environment of a container recreated from a v0.4 image, PATH
# included: the entrypoint and the helpers run their root step from the system
# directories only, whatever PATH the container hands them.
docker run -d --name "${NAME}-boot" -e T3_PREINSTALL=none \
  -e "T3_PUBLIC_URL=${PUBLIC_URL}" \
  -e T3_PRINT_PAIRING_ON_START=1 \
  "${LEGACY_ENV[@]}" -e "PATH=${LEGACY_PATH}" \
  "$IMAGE" >/dev/null
boot_ok=0
for _ in $(seq 1 40); do
  if docker logs "${NAME}-boot" 2>&1 | grep -q "Pairing URL: ${PUBLIC_URL}/pair#token="; then
    boot_ok=1
    break
  fi
  [ "$(docker inspect -f '{{.State.Running}}' "${NAME}-boot" 2>/dev/null)" = true ] || break
  sleep 3
done
if [ "$boot_ok" = 1 ]; then
  ok "T3_PRINT_PAIRING_ON_START logs a usable pairing link"
else
  no "T3_PRINT_PAIRING_ON_START logs a usable pairing link"
  docker logs "${NAME}-boot" 2>&1 | tail -15
fi
check "an older image's PATH is reported and set aside" \
  "output_has 'docker logs ${NAME}-boot' 'ignoring settings left over from an older image: .*PATH'"
check "and a helper run as root under it steps down and works" \
  "output_has 'docker exec ${NAME}-boot t3-harness list' '^claude'"
docker rm -f "${NAME}-boot" >/dev/null 2>&1 || true

printf '\n%d passed, %d failed\n\n' "$pass" "$fail"
if [ "$fail" -gt 0 ] && [ -s "$UI_AUDIT_LOG" ]; then
  printf 'Browser audit output:\n'
  sed 's/^/  /' "$UI_AUDIT_LOG"
  printf '\n'
fi
[ "$fail" -eq 0 ]
