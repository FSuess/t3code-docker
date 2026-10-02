#!/usr/bin/env bash
# End-to-end verification of the agent lifecycle on a real image.
#
#   scripts/test-toolchain-e2e.sh --variant core|browser <image>
#                               [--keep]
#
# The unit under test is the assembled product a fresh user meets, on one real
# amd64 image, not one module in isolation:
#
#   - a fresh image ships the installer and no baked harness;
#   - the noninteractive CLI installs all five harnesses and T3's own provider
#     probes (SDK init, app-server, serve, ACP) run the exact managed
#     executables, from T3's cached snapshots;
#   - mise-owned Claude, Codex and OpenCode paths resolve manual-only in T3,
#     so discovery and polling cannot update them. Grok and Cursor carry their
#     own updaters, which T3 offers wherever they live; T3's must target the
#     managed executable, and a self-updated Cursor is recorded as drift, not a
#     failure;
#   - exact versions, credentials and the project Node selection survive a
#     container recreate, including one with no network;
#   - T3 and setup keep running on the image Node while the project selects
#     another one;
#   - Uninstall retracts the managed path from T3 and removes the executable
#     without touching credentials;
#   - on `browser`, `t3-browser-mcp` registers the MCP servers through the
#     managed Claude, Codex and OpenCode, and Chromium drives a real page.
#
# Credentialed completion (a real provider sign-in and an agent turn) needs
# provider accounts and is not covered here; this script proves the credential
# surfaces, their survival, and that auth is never inferred from a successful
# launch. The first-start preinstall is turned off so every install below is
# the explicit one under test; scripts/smoke-test.sh covers the preinstall.
#
# Versions default to mise's latest, which is what a fresh install resolves;
# set T3C_E2E_<ID>_VERSION (CLAUDE, CODEX, OPENCODE, GROK, CURSOR) to pin one
# for a reproducible local run. T3C_E2E_KEEP=1 or --keep leaves the container
# and volume for inspection.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VARIANT=""
IMAGE=""
KEEP="${T3C_E2E_KEEP:-0}"

usage() {
  cat <<'USAGE'
Usage: scripts/test-toolchain-e2e.sh --variant core|browser [--keep] <image>

  --variant NAME   core | browser (required for a digest reference; inferred
                   from a t3code:<variant> tag otherwise)
  --keep           leave the container and volume behind for inspection
  image            image tag or digest reference (default: t3code:browser)

Version overrides (empty means mise's latest, resolved and recorded exactly):
  T3C_E2E_CLAUDE_VERSION, T3C_E2E_CODEX_VERSION, T3C_E2E_OPENCODE_VERSION,
  T3C_E2E_GROK_VERSION, T3C_E2E_CURSOR_VERSION, T3C_E2E_NODE_SELECTOR
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --variant) VARIANT="${2:?--variant needs a value}"; shift 2 ;;
    --keep)    KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; [ $# -gt 0 ] && IMAGE="$1" && shift; break ;;
    -*) echo "test-toolchain-e2e.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
    *) IMAGE="$1"; shift ;;
  esac
done
[ -n "$IMAGE" ] || IMAGE="t3code:browser"

case "$VARIANT" in
  ""|core|browser) ;;
  *) echo "test-toolchain-e2e.sh: variant must be core or browser" >&2; exit 2 ;;
esac

if [ -z "$VARIANT" ]; then
  tag="${IMAGE##*:}"
  case "$IMAGE" in *@sha256:*) tag="" ;; esac
  case "$tag" in
    core|browser) VARIANT="$tag" ;;
    *) echo "test-toolchain-e2e.sh: cannot infer --variant from '$IMAGE'; pass --variant explicitly" >&2; exit 2 ;;
  esac
fi

# Latest resolved at install time unless a caller pinned one.
declare -A REQ_VERSION=(
  [claude]="${T3C_E2E_CLAUDE_VERSION:-}"
  [codex]="${T3C_E2E_CODEX_VERSION:-}"
  [opencode]="${T3C_E2E_OPENCODE_VERSION:-}"
  [grok]="${T3C_E2E_GROK_VERSION:-}"
  [cursor]="${T3C_E2E_CURSOR_VERSION:-}"
)
NODE_SELECTOR="${T3C_E2E_NODE_SELECTOR:-22}"
IDS="claude codex opencode grok cursor"

NAME="t3code-e2e-$$"
VOLUME="t3code-e2e-home-$$"
WORKSPACE_VOLUME="t3code-e2e-workspace-$$"
SETUP_KEY="e2e-test-key"
STATE=/home/t3/.t3
SETTINGS="${STATE}/userdata/settings.json"
CACHE_DIR="${STATE}/caches"
PROJECT=/workspace/t3code-e2e-project

pass=0
fail=0
ok()    { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
no()    { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
is() { # label expected actual
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (expected [$2], got [$3])"; fi
}
has() { # label needle haystack
  if printf '%s' "$3" | grep -Fq -- "$2"; then ok "$1"; else no "$1 (missing [$2] in [$3])"; fi
}
matches() { # label regex haystack
  if printf '%s' "$3" | grep -Eq -- "$2"; then ok "$1"; else no "$1 (no match for /$2/ in [$3])"; fi
}
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }

cleanup() {
  if [ "$KEEP" = "1" ]; then
    printf '\nkept container %s and volumes %s, %s\n' "$NAME" "$VOLUME" "$WORKSPACE_VOLUME" >&2
    return 0
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" "$WORKSPACE_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

dex()   { docker exec -u t3 -e HOME=/home/t3 -w /home/t3 "$NAME" "$@"; }
droot() { docker exec "$NAME" "$@"; }
field() { printf '%s' "$2" | jq -r "$1" 2>/dev/null || printf ''; }

driver_kind() { case "$1" in claude) echo claudeAgent ;; *) echo "$1" ;; esac; }
mise_tool()   { case "$1" in cursor) echo cursor-agent ;; *) echo "$1" ;; esac; }

mise_ls()     { dex mise ls --json 2>/dev/null || printf '{}'; }
mise_config() { dex sh -c 'cat /home/t3/.config/mise/config.toml 2>/dev/null || true'; }
manager_state() { dex sh -c 'cat /home/t3/.local/state/mise/harness-state.json 2>/dev/null || true'; }
settings_body() { dex sh -c "cat $SETTINGS 2>/dev/null || true"; }
cache_body()    { dex sh -c "cat ${CACHE_DIR}/$1.json 2>/dev/null || true"; }

exe_hash() { # id
  local exe="${EXE[$1]:-}"
  [ -n "$exe" ] || { printf ''; return 0; }
  dex sh -c "sha256sum '$exe' 2>/dev/null | cut -d' ' -f1" || true
}

ulogin() { # dir command — the documented project execution path
  docker exec -u t3 -w "$1" "$NAME" bash -lc "$2"
}

wait_usable() {
  local _i
  for _i in $(seq 1 60); do
    dex test -w /home/t3 >/dev/null 2>&1 && return 0
    sleep 1
  done
  no "container never became usable"
  return 1
}

wait_health() { # timeout seconds
  local deadline=$((SECONDS + $1))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if droot curl -fsS --noproxy '*' --max-time 3 \
        "http://127.0.0.1:3773/.well-known/t3/environment" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# Process introspection has to happen inside the container; the server drops
# privileges with gosu, so `exe` is only readable as the user it runs as.
proc_exe()     { docker exec -u t3 "$NAME" readlink -f "/proc/$1/exe"; }
proc_cmdline() { docker exec "$NAME" sh -c "tr '\0' ' ' < /proc/$1/cmdline"; }
find_pid() {
  docker exec -e "T3_PID_PATTERN=$1" "$NAME" sh -c '
    for p in /proc/[0-9]*; do
      c="$(tr "\0" " " < "$p/cmdline" 2>/dev/null)"
      case "$c" in $T3_PID_PATTERN) echo "${p#/proc/}"; exit 0;; esac
    done
    exit 1' || true
}
wait_pid() { # pattern timeout seconds
  local deadline=$((SECONDS + $2)) pid
  while [ "$SECONDS" -lt "$deadline" ]; do
    pid="$(find_pid "$1")"
    [ -n "$pid" ] && { printf '%s' "$pid"; return 0; }
    sleep 1
  done
  return 1
}

assert_immutable_infrastructure() { # label
  local prefix binary pid spid health
  prefix="$(droot printenv T3_INFRA_PREFIX 2>/dev/null || true)"
  [ -n "$prefix" ] || prefix=/opt/t3
  binary="$(droot printenv T3_INFRA_BINARY 2>/dev/null || true)"
  [ -n "$binary" ] || binary="${prefix}/t3"

  health="$(droot curl -s --noproxy '*' --max-time 5 -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:3773/.well-known/t3/environment" 2>/dev/null || true)"
  is "$1: T3 answers health while a project Node is selected" "200" "$health"

  pid="$(wait_pid "*$binary*serve*" 30)"
  if [ -n "$pid" ]; then
    is "$1: T3 server runs the immutable platform binary" "$binary" "$(proc_exe "$pid")"
    has "$1: T3 server command names the immutable platform binary" "$binary" "$(proc_cmdline "$pid")"
  else
    no "$1: could not find the running T3 server process"
  fi

  spid="$(wait_pid '*/opt/t3-setup/server.mjs*' 30)"
  if [ -n "$spid" ]; then
    is "$1: setup service runs the image Node" "/usr/local/bin/node" "$(proc_exe "$spid")"
  else
    no "$1: could not find the running setup service process"
  fi
}

recreate() { # extra docker-run arguments...
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" -e "T3_SETUP_KEY=${SETUP_KEY}" -e T3_PREINSTALL=none \
    "$@" -v "${VOLUME}:/home/t3" -v "${WORKSPACE_VOLUME}:/workspace" "$IMAGE" >/dev/null
  wait_usable
}

enable_providers() {
  dex sh -c '
    set -e
    s=/home/t3/.t3/userdata/settings.json
    mkdir -p "$(dirname "$s")"
    [ -f "$s" ] || printf "%s" "{}" > "$s"
    t="$(mktemp)"
    jq '"'"'
      .providers = (.providers // {}) |
      reduce ["claudeAgent","codex","opencode","grok","cursor"][] as $d (.;
        .providers[$d] = ((.providers[$d] // {}) + {enabled: true}))
    '"'"' "$s" > "$t"
    mv "$t" "$s"'
}

save_credentials() {
  dex sh -c '
    set -e
    mkdir -p /home/t3/.claude /home/t3/.codex /home/t3/.local/share/opencode \
      /home/t3/.grok /home/t3/.cursor
    printf "%s" "{}" > /home/t3/.claude/.credentials.json
    # A realistic file-backed API key: an empty JSON object makes the Codex
    # app-server probe read it as ChatGPT auth without a plan and fail before it
    # can report a version.
    printf "%s" "{\"OPENAI_API_KEY\":\"sk-e2e-test\"}" > /home/t3/.codex/auth.json
    printf "%s" "{\"anthropic\":{\"type\":\"api\",\"key\":\"e2e-test-key\"}}" \
      > /home/t3/.local/share/opencode/auth.json
    printf "%s" "{}" > /home/t3/.grok/auth.json
    printf "%s" "{}" > /home/t3/.cursor/cli-config.json'
}

snapshot_installed() { # id — true/false from T3's cached provider snapshot
  field '.installed // false' "$(cache_body "$(driver_kind "$1")")"
}

wait_for_all_snapshots() { # timeout seconds
  local deadline=$((SECONDS + $1)) id ready installed
  while :; do
    ready=1
    for id in $IDS; do
      installed="$(snapshot_installed "$id")"
      [ "$installed" = "true" ] || ready=0
    done
    [ "$ready" = "1" ] && return 0
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 5
  done
}

wait_for_snapshot() { # id timeout installed-expectation
  local deadline=$((SECONDS + $2)) want="$3"
  while [ "$SECONDS" -lt "$deadline" ]; do
    [ "$(snapshot_installed "$1")" = "$want" ] && return 0
    sleep 5
  done
  return 1
}

printf '\nEnd-to-end verification of the toolchain product on %s (variant %s)\n' \
  "$IMAGE" "$VARIANT"

section "Fresh $VARIANT image"
docker volume create "$VOLUME" >/dev/null
docker volume create "$WORKSPACE_VOLUME" >/dev/null
recreate
is "the image declares its variant" "$VARIANT" "$(droot printenv T3_IMAGE_VARIANT 2>/dev/null || true)"

baseline="$(droot t3-harness status --json)"
is "the installer lists five harnesses" "5" "$(field '.harnesses | length' "$baseline")"
for id in $IDS; do
  facts="$(field ".harnesses[] | select(.id == \"$id\")" "$baseline")"
  is "$id starts uninstalled" "false" "$(field '.installed' "$facts")"
done
is "read-only status wrote no manager state" "absent" \
  "$(dex sh -c 'test -f /home/t3/.local/state/mise/harness-state.json && echo present || echo absent')"

section "Install all five harnesses through the noninteractive CLI"
declare -A VERSION=() EXE=()
for id in $IDS; do
  args=(install "$id")
  [ -n "${REQ_VERSION[$id]}" ] && args+=(--version "${REQ_VERSION[$id]}")
  args+=(--json)
  out="$(droot t3-harness "${args[@]}")"
  is "$id installs" "true" "$(field '.ok' "$out")"
  VERSION[$id]="$(field '.harness.installedVersion // empty' "$out")"
  EXE[$id]="$(field '.harness.executable // empty' "$out")"
  is "$id is runnable" "true" "$(field '.harness.runnable' "$out")"
  is "$id recorded the resolved exact version" "${VERSION[$id]}" \
    "$(field '.harness.recordedVersion' "$out")"
  matches "$id resolves under its mise install tree" \
    "mise/installs/$(mise_tool "$id")/${VERSION[$id]}/" "${EXE[$id]}"
  is "$id provider sync succeeded" "true" "$(field '.sync.ok' "$out")"
  ran="$(dex "${EXE[$id]}" --version 2>&1 | head -1 || true)"
  has "$id managed executable runs" "${VERSION[$id]}" "$ran"
  info "$id ${VERSION[$id]} -> ${EXE[$id]}"
done

section "Project Node selection while T3 and setup stay on the image Node"
TMP_MISE="$(mktemp)"
cat > "$TMP_MISE" <<EOF
[tools]
node = "$NODE_SELECTOR"
EOF
chmod 644 "$TMP_MISE"
dex mkdir -p "$PROJECT"
docker cp "$TMP_MISE" "$NAME:$PROJECT/mise.toml" >/dev/null
rm -f "$TMP_MISE"
ulogin "$PROJECT" 'mise trust' >/dev/null 2>&1 || true
if ulogin "$PROJECT" 'mise install'; then
  ok "the project Node installs through mise"
else
  no "the project Node installs through mise"
fi
project_node="$(ulogin "$PROJECT" 'mise exec -- node --version' 2>/dev/null || true)"
bare_node="$(ulogin "$PROJECT" 'node --version' 2>/dev/null || true)"
image_node="$(droot node --version 2>/dev/null || true)"
matches "mise exec selects the project Node" "^v${NODE_SELECTOR}\." "$project_node"
matches "a login shell in the project selects the project Node" "^v${NODE_SELECTOR}\." "$bare_node"
if [ "$project_node" != "$image_node" ]; then
  ok "the project Node differs from the image Node ($project_node vs $image_node)"
else
  no "the project Node did not differ from the image Node ($project_node)"
fi
assert_immutable_infrastructure "online"

section "Credentials (surfaces only; no provider accounts)"
save_credentials
status_creds="$(droot t3-harness status --json)"
for id in $IDS; do
  facts="$(field ".harnesses[] | select(.id == \"$id\")" "$status_creds")"
  is "$id reports its credential surface" "true" "$(field '.credentials.present' "$facts")"
done
setup_harnesses=""
opencode_signed=""
for _retry in $(seq 1 12); do
  setup_harnesses="$(droot curl -fsS --noproxy '*' --max-time 120 \
    -H "x-t3-setup-key: ${SETUP_KEY}" "http://127.0.0.1:3774/harnesses" 2>/dev/null || true)"
  opencode_signed="$(field '.harnesses[] | select(.id == "opencode") | .signedIn' "$setup_harnesses")"
  [ "$opencode_signed" = "true" ] && break
  sleep 5
done
is "opencode reads a file-backed sign-in as signed in" "true" "$opencode_signed"
is "claude's failed sign-in does not read as signed in" "true" \
  "$(field '.harnesses[] | select(.id == "claude") | (.installed == true and ((.signedIn // false) != true))' "$setup_harnesses")"

section "Provider launch through T3 (all five enabled; SDK init, app-server, serve, ACP)"
enable_providers
before_config="$(mise_config)"
before_ls="$(mise_ls)"
before_state="$(manager_state)"
declare -A HASH_BEFORE=()
for id in $IDS; do HASH_BEFORE[$id]="$(exe_hash "$id")"; done

recreate
if wait_health 180; then
  ok "T3 became healthy with every provider enabled"
else
  no "T3 never became healthy"
  droot sh -c 'tail -40 /home/t3/.t3/logs/server.log 2>/dev/null || true' || true
fi

if wait_for_all_snapshots 600; then
  ok "T3 produced all five provider snapshots"
else
  no "T3 did not produce all five provider snapshots"
  for id in $IDS; do
    info "$id snapshot: $(cache_body "$(driver_kind "$id")" | head -c 300)"
  done
fi

declare -A T3_VERSION=()
for id in $IDS; do
  d="$(driver_kind "$id")"
  body="$(cache_body "$d")"
  is "$id T3 snapshot reports installed" "true" "$(field '.installed // false' "$body")"
  T3_VERSION[$id]="$(field '.version // empty' "$body")"
  if [ "$id" = "cursor" ]; then
    info "cursor T3 version: ${T3_VERSION[$id]} (recorded ${VERSION[$id]}); updater: $(field '.versionAdvisory.updateCommand // "null"' "$body")"
  elif [ "$id" = "grok" ]; then
    # Since 0.0.44 T3 offers Grok's own `update` wherever it is installed, as
    # it does Cursor's. Pressing it updates the managed executable in place
    # rather than a second copy elsewhere, which is the part that matters.
    has "$id T3 snapshot reports the managed version" "${VERSION[$id]}" "${T3_VERSION[$id]}"
    is "$id T3's own updater targets the managed executable" "${EXE[$id]} update" \
      "$(field '.versionAdvisory.updateCommand // ""' "$body")"
  else
    has "$id T3 snapshot reports the managed version" "${VERSION[$id]}" "${T3_VERSION[$id]}"
    is "$id T3 resolves the mise path manual-only" "null" \
      "$(field '.versionAdvisory.updateCommand // null' "$body")"
    is "$id T3 cannot update the managed path" "false" \
      "$(field '.versionAdvisory.canUpdate // false' "$body")"
    if [ "$id" = "claude" ] || [ "$id" = "codex" ]; then
      is "$id T3 snapshot is ready" "ready" "$(field '.status // empty' "$body")"
    fi
  fi
done

section "Invocation and polling do not update anything"
poll_surfaces() {
  local _i
  for _i in 1 2 3; do
    droot t3-harness list --json >/dev/null 2>&1 || true
    droot curl -fsS --noproxy '*' --max-time 15 -H "x-t3-setup-key: ${SETUP_KEY}" \
      "http://127.0.0.1:3774/status" >/dev/null 2>&1 || true
    droot curl -fsS --noproxy '*' --max-time 15 -H "x-t3-setup-key: ${SETUP_KEY}" \
      "http://127.0.0.1:3774/harnesses?authenticate=false" >/dev/null 2>&1 || true
  done
}
setup_code="$(droot curl -s --noproxy '*' --max-time 20 -o /dev/null -w '%{http_code}' \
  -H "x-t3-setup-key: ${SETUP_KEY}" "http://127.0.0.1:3774/status" 2>/dev/null || true)"
is "setup status answers while the harnesses are installed" "200" "$setup_code"
poll_surfaces
is "T3 probes and polling changed no mise selection" "$before_ls" "$(mise_ls)"
is "T3 probes and polling changed no mise config" "$before_config" "$(mise_config)"
is "T3 probes and polling wrote no manager state" "$before_state" "$(manager_state)"
cursor_drift=0
for id in $IDS; do
  after="$(exe_hash "$id")"
  if [ "$id" = "cursor" ]; then
    if [ -n "${HASH_BEFORE[$id]:-}" ] && [ "$after" != "${HASH_BEFORE[$id]}" ]; then
      cursor_drift=1
      info "cursor executable changed during T3 invocation (self-update drift)"
    fi
  else
    is "$id executable is byte-identical after T3 invocation" "${HASH_BEFORE[$id]}" "$after"
  fi
done
cursor_actual="$(dex "${EXE[cursor]}" --version 2>&1 | head -1 || true)"
if printf '%s' "$cursor_actual" | grep -Fq -- "${VERSION[cursor]}"; then
  info "cursor still reports its recorded version (${VERSION[cursor]})"
else
  cursor_drift=1
  info "cursor now reports '${cursor_actual}' vs recorded '${VERSION[cursor]}' (observed drift)"
fi

if [ "$VARIANT" = "browser" ]; then
  section "Managed browser MCP registration and a real page"
  docker cp "${ROOT}/scripts/browser-probe.py" "$NAME:/tmp/browser-probe.py" >/dev/null
  mcp_out="$(droot t3-browser-mcp --harness claude,codex,opencode 2>&1)"
  has "claude registers through the managed executable" \
    "via /home/t3/.local/share/mise/installs/claude/" "$mcp_out"
  has "codex registers through the managed executable" \
    "via /home/t3/.local/share/mise/installs/codex/" "$mcp_out"
  has "opencode registers through the managed executable" \
    "via /home/t3/.local/share/mise/installs/opencode/" "$mcp_out"
  has "claude registered playwright" "claude: registered playwright" "$mcp_out"
  is "codex config records the mcp server" "true" \
    "$(dex sh -c "grep -q '^\\[mcp_servers.playwright\\]' /home/t3/.codex/config.toml && echo true || echo false")"
  is "opencode config records the mcp server" "true" \
    "$(dex jq -e '.mcp.playwright.enabled' /home/t3/.config/opencode/opencode.json >/dev/null && echo true || echo false)"
  claude_mcp="$(dex sh -c 'grep -l playwright /home/t3/.claude.json 2>/dev/null | head -1 || true')"
  if [ -n "$claude_mcp" ]; then ok "claude user config records the mcp server"; else no "claude user config does not record the mcp server"; fi

  docker exec "$NAME" sh -c 'rm -f /tmp/e2e-browser-*.log' || true
  if dex python3 /tmp/browser-probe.py >/tmp/e2e-browser-playwright-$$.log 2>&1; then
    ok "browser MCP drives a real page (playwright)"
  else
    no "browser MCP drives a real page (playwright)"
  fi
  sed 's/^/  /' /tmp/e2e-browser-playwright-$$.log || true
  rm -f /tmp/e2e-browser-playwright-$$.log

  chrome_cmd="$(droot t3-browser-mcp --server chrome-devtools --print)"
  read -r -a chrome_args <<< "$chrome_cmd"
  if dex python3 /tmp/browser-probe.py "${chrome_args[@]}" >/tmp/e2e-browser-cd-$$.log 2>&1; then
    ok "browser MCP drives a real page (chrome-devtools)"
  else
    no "browser MCP drives a real page (chrome-devtools)"
  fi
  sed 's/^/  /' /tmp/e2e-browser-cd-$$.log || true
  rm -f /tmp/e2e-browser-cd-$$.log
fi

section "Uninstall retracts the managed path and preserves credentials"
uninstall_out="$(droot t3-harness uninstall opencode --json)"
is "opencode uninstalls" "true" "$(field '.ok' "$uninstall_out")"
is "opencode is no longer installed" "false" "$(field '.harness.installed' "$uninstall_out")"
is "opencode no longer resolves an executable" "null" "$(field '.harness.executable // null' "$uninstall_out")"
is "uninstall provider sync succeeded" "true" "$(field '.sync.ok' "$uninstall_out")"
settings_after="$(settings_body)"
is "opencode's managed path is retracted from T3 settings" "null" \
  "$(field '.providers.opencode.binaryPath // null' "$settings_after")"
is "opencode credentials survive uninstall" "e2e-test-key" \
  "$(dex sh -c 'cat /home/t3/.local/share/opencode/auth.json' | jq -r '.anthropic.key')"
is "no opencode request remains in mise" "0" \
  "$(mise_ls | jq '(.opencode // []) | length')"
post_uninstall_ls="$(mise_ls)"
post_uninstall_config="$(mise_config)"

section "Recreate online: T3 sees the uninstalled provider, all state survives"
recreate
if wait_for_snapshot opencode 300 false; then
  ok "T3 reports the uninstalled provider as absent"
else
  no "T3 still reports opencode installed after uninstall and recreate"
fi
recreated_status="$(droot t3-harness status --json)"
for id in claude codex grok cursor; do
  facts="$(field ".harnesses[] | select(.id == \"$id\")" "$recreated_status")"
  is "$id survives recreation as installed" "true" "$(field '.installed' "$facts")"
  is "$id survives recreation at its exact version" "${VERSION[$id]}" "$(field '.installedVersion' "$facts")"
  is "$id survives recreation as runnable" "true" "$(field '.runnable' "$facts")"
  if [ "$id" != "cursor" ]; then
    is "$id executable is byte-identical across recreation" "${HASH_BEFORE[$id]}" "$(exe_hash "$id")"
  fi
done
project_node_after="$(ulogin "$PROJECT" 'mise exec -- node --version' 2>/dev/null || true)"
matches "project Node still selected after recreation" "^v${NODE_SELECTOR}\." "$project_node_after"
is "opencode credentials still present after recreation" "e2e-test-key" \
  "$(dex sh -c 'cat /home/t3/.local/share/opencode/auth.json' | jq -r '.anthropic.key')"
assert_immutable_infrastructure "recreated"

section "Offline recreation on the same volume"
recreate --network none
if wait_health 180; then
  ok "T3 becomes healthy with no network"
else
  no "T3 never became healthy offline"
  droot sh -c 'tail -40 /home/t3/.t3/logs/server.log 2>/dev/null || true' || true
fi
assert_immutable_infrastructure "offline"
project_node_offline="$(ulogin "$PROJECT" 'mise exec -- node --version' 2>/dev/null || true)"
matches "project Node still selected offline" "^v${NODE_SELECTOR}\." "$project_node_offline"
is "mise selection is unchanged offline" "$post_uninstall_ls" "$(mise_ls)"
is "mise config is unchanged offline" "$post_uninstall_config" "$(mise_config)"
offline_status="$(droot t3-harness status --json)"
for id in claude codex grok cursor; do
  facts="$(field ".harnesses[] | select(.id == \"$id\")" "$offline_status")"
  is "$id is installed offline" "true" "$(field '.installed' "$facts")"
  is "$id keeps its exact version offline" "${VERSION[$id]}" "$(field '.installedVersion' "$facts")"
  is "$id is runnable offline" "true" "$(field '.runnable' "$facts")"
  ran="$(dex "${EXE[$id]}" --version 2>&1 | head -1 || true)"
  has "$id managed executable still runs offline" "${VERSION[$id]}" "$ran"
  if [ "$id" != "cursor" ]; then
    is "$id executable is byte-identical offline" "${HASH_BEFORE[$id]}" "$(exe_hash "$id")"
  fi
done
opencode_facts="$(field '.harnesses[] | select(.id == "opencode")' "$offline_status")"
is "opencode is still uninstalled offline" "false" "$(field '.installed' "$opencode_facts")"
is "opencode credentials survived the offline recreate" "e2e-test-key" \
  "$(dex sh -c 'cat /home/t3/.local/share/opencode/auth.json' | jq -r '.anthropic.key')"
for id in $IDS; do
  d="$(driver_kind "$id")"
  offline_snap="$(cache_body "$d")"
  info "offline T3 snapshot $id: installed=$(field '.installed // false' "$offline_snap") version=$(field '.version // empty' "$offline_snap")"
done

section "Result"
for id in $IDS; do
  info "$id: installed ${VERSION[$id]}, T3 reports ${T3_VERSION[$id]:-?}"
done
info "project node (${NODE_SELECTOR}): ${project_node_offline:-?}; cursor self-update drift: $([ "$cursor_drift" = 1 ] && echo yes || echo no)"
printf '\n%d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
