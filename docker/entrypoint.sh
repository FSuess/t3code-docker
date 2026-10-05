#!/bin/bash
# Container entrypoint: normalise ownership, drop privileges, start T3 Code.
set -euo pipefail

log() { printf '[t3code] %s\n' "$*" >&2; }

# The root half below resolves commands only through the image's own system
# directories. The PATH it inherits is the container's, and a container
# recreated from an older image can carry that image's PATH, which listed
# directories the t3 user can write ahead of the system ones. The inherited PATH
# is handed back to the unprivileged half, where the user environment
# (docker/user-env.sh) drops what that older image added.
inherited_path="$PATH"
if [ "$EUID" -eq 0 ]; then
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
fi

T3_USER=t3
T3_HOME=/home/t3

: "${PUID:=1000}"
: "${PGID:=1000}"
: "${T3CODE_HOME:=${T3_HOME}/.t3}"
: "${T3CODE_HOST:=0.0.0.0}"
: "${T3CODE_PORT:=3773}"
: "${T3_WORKSPACE:=/workspace}"
: "${T3_AUTO_ADD_PROJECTS:=1}"
: "${T3_PRINT_PAIRING_ON_START:=0}"
: "${T3_ALLOW_SUDO:=0}"
: "${T3_SETUP_ENABLED:=1}"
: "${T3_SETUP_PORT:=3774}"
: "${T3_SINGLE_PORT:=}"
# Where docker/run-t3.sh keeps T3 Code's pid and takes restart requests from
# the setup page. Runtime only: nothing here outlives the container.
: "${T3_RUN_DIR:=/tmp/t3code}"
: "${T3_PERSIST_AGENT_CREDENTIALS:=1}"
: "${T3_PREINSTALL:=default}"
# The image's own runtimes. T3 runs as the root-owned platform binary; setup
# and repository JavaScript helpers run under the image Node. Neither resolves
# `node` or `t3` through PATH. Overridable for tests.
: "${T3_INFRA_NODE:=/usr/local/bin/node}"
: "${T3_INFRA_BINARY:=/opt/t3/t3}"
: "${T3_INFRA_LAUNCHER:=/usr/local/bin/t3-admin}"
# Provider integration: maps the harness manager's selection onto T3's
# per-provider `binaryPath`.
: "${T3_PROVIDER_CLI:=/opt/t3-provider/cli.mjs}"
export T3CODE_HOME T3CODE_HOST T3CODE_PORT T3_WORKSPACE T3_SETUP_PORT T3_SINGLE_PORT T3_RUN_DIR
export T3_INFRA_NODE T3_INFRA_BINARY T3_INFRA_LAUNCHER T3_PROVIDER_CLI T3_PREINSTALL

# Ownership migration is recorded here before anything else changes. The state
# directory is the one path every deployment mounts, so a marker written there
# survives the restart or recreate that must finish the migration.
OWNERSHIP_MARKER="${T3CODE_HOME}/.ownership-migration"

# This runs as root inside a directory the t3 user owns, so it must never open
# a path t3 could have pointed somewhere else. mktemp creates a fresh file with
# O_EXCL (a planted symlink makes it fail, not follow), and rename replaces the
# marker's directory entry itself rather than writing through it.
write_ownership_marker() {
  local tmp
  # The directory itself could be a link the t3 user planted; root writes
  # nothing through it. The migration still runs, it is just not resumable.
  if [ -L "$T3CODE_HOME" ]; then
    log "WARNING: ${T3CODE_HOME} is a symlink; not recording migration intent there"
    return 0
  fi
  tmp="$(mktemp "${OWNERSHIP_MARKER}.XXXXXX")"
  {
    printf 'version=1\n'
    printf 'target_uid=%s\n' "$PUID"
    printf 'target_gid=%s\n' "$PGID"
    printf 'started=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$tmp"
  chmod 0644 "$tmp"
  mv -fT "$tmp" "$OWNERSHIP_MARKER"
  log "recorded ownership migration intent (${OWNERSHIP_MARKER})"
}

# --- privileged half: fix uids, then re-exec as the unprivileged user --------
if [ "$(id -u)" -eq 0 ]; then
  current_uid="$(id -u "$T3_USER")"
  current_gid="$(id -g "$T3_USER")"
  remap=0
  [ "$PGID" != "$current_gid" ] && remap=1
  [ "$PUID" != "$current_uid" ] && remap=1

  # A marker left by an earlier start means that migration did not finish. It
  # must be completed even when the account already carries the target ids and
  # a top-level writability probe passes: the interruption may have left deep
  # files owned by the old uid while the top directory already looks correct.
  resumed=0
  [ -f "$OWNERSHIP_MARKER" ] && resumed=1
  [ "$resumed" -eq 1 ] && log "resuming an interrupted ownership migration"
  pending="$resumed"

  mkdir -p "$T3CODE_HOME" "$T3_WORKSPACE"

  # A freshly created volume comes up root-owned; so does ~ after a remap.
  # Test each directory the server writes rather than inferring from the home
  # directory's uid: a volume mounted directly at the state dir arrives
  # root-owned while its parent still looks perfectly correct, and the server
  # then dies on `mkdir userdata` with nothing but an EACCES stack trace.
  need=0
  [ "$remap" -eq 1 ] && need=1
  [ "$resumed" -eq 1 ] && need=1
  for dir in "$T3_HOME" "$T3CODE_HOME"; do
    mkdir -p "$dir"
    gosu "$T3_USER" test -w "$dir" || need=1
  done

  # Persist the intent before the first account or ownership change. `usermod`
  # rewrites ownership inside the home itself, so a crash between it and the
  # explicit traversal would otherwise leave a half-migrated tree that passes a
  # later writability probe and is never repaired.
  if [ "$need" -eq 1 ] && [ "$pending" -eq 0 ]; then
    write_ownership_marker
    pending=1
  fi

  if [ "$remap" -eq 1 ]; then
    if [ "$PGID" != "$current_gid" ]; then
      log "remapping group ${T3_USER}: ${current_gid} -> ${PGID}"
      groupmod -o -g "$PGID" "$T3_USER"
    fi
    if [ "$PUID" != "$current_uid" ]; then
      log "remapping user ${T3_USER}: ${current_uid} -> ${PUID}"
      usermod -o -u "$PUID" "$T3_USER"
    fi
  fi

  # A resumed migration traverses both trees: the previous attempt may have
  # stopped anywhere between them. A fresh one only walks what is not writable.
  for dir in "$T3_HOME" "$T3CODE_HOME"; do
    mkdir -p "$dir"
    if [ "$resumed" -eq 1 ] || [ "$remap" -eq 1 ] || ! gosu "$T3_USER" test -w "$dir"; then
      log "taking ownership of ${dir}"
      chown -R "$PUID:$PGID" "$dir"
    fi
  done

  # Only a completed, verified traversal clears the marker. `set -e` above means
  # a failed chown aborts with the marker still in place, so the next start
  # retries instead of trusting a partially migrated tree.
  if [ "$pending" -eq 1 ]; then
    if gosu "$T3_USER" test -w "$T3_HOME" && gosu "$T3_USER" test -w "$T3CODE_HOME"; then
      rm -f "$OWNERSHIP_MARKER"
      log "ownership migration complete"
    else
      log "WARNING: ownership migration finished but a directory is still not"
      log "         writable; leaving ${OWNERSHIP_MARKER} to retry."
    fi
  fi

  # /workspace is the user's own tree. Only adopt it when it is empty or
  # already root-owned; never rewrite ownership across somebody's repos.
  if [ "$(stat -c %u "$T3_WORKSPACE")" = "0" ]; then
    chown "$PUID:$PGID" "$T3_WORKSPACE"
  fi
  if ! gosu "$T3_USER" test -w "$T3_WORKSPACE"; then
    log "WARNING: ${T3_WORKSPACE} is not writable by uid ${PUID}."
    log "         Set PUID/PGID to match the owner of your bind mount."
  fi

  if [ "$T3_ALLOW_SUDO" = "1" ]; then
    if command -v sudo >/dev/null 2>&1; then
      printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$T3_USER" > /etc/sudoers.d/t3code
      chmod 0440 /etc/sudoers.d/t3code
      log "passwordless sudo enabled for ${T3_USER} (T3_ALLOW_SUDO=1)"
    else
      log "T3_ALLOW_SUDO=1 but sudo is not installed in this image"
    fi
  else
    rm -f /etc/sudoers.d/t3code
  fi

  # gosu by absolute path: env resolves its command with the PATH it sets.
  exec env PATH="$inherited_path" "$(command -v gosu)" "$T3_USER" "$0" "$@"
fi

# --- unprivileged half -------------------------------------------------------
# Reached either by the step-down above, or directly because the container was
# started with a `user:` setting. In the latter case nothing can fix ownership,
# so say what is wrong instead of letting the server fail on its first write.
if ! mkdir -p "$T3CODE_HOME" 2>/dev/null || [ ! -w "$T3CODE_HOME" ]; then
  log "ERROR: ${T3CODE_HOME} is not writable by uid $(id -u):$(id -g)."
  log "       A volume is probably mounted there owned by another user."
  log "       Fix it either way:"
  log "         - let the container start as root so it can adopt the volume"
  log "           itself, and select the user with PUID/PGID; or"
  log "         - chown the host directory to uid ${PUID} before mounting it."
  exit 1
fi

# One port asked for and impossible to serve (T3 Code's own port, say) would
# leave a deployment that comes up and answers nothing where it was told to.
# Refuse to start instead, with the reason, before anything else runs.
ROUTER=/opt/t3-router/server.mjs
if [ -n "$T3_SINGLE_PORT" ] && [ -f "$ROUTER" ]; then
  "$T3_INFRA_NODE" "$ROUTER" --check || exit 1
fi

# Establish the user-only tool environment before anything is launched, so the
# server, the setup service and the terminals T3 opens all inherit it. The
# fragment returns early for root; this half is already the unprivileged user.
# shellcheck source=/dev/null
[ -r /etc/profile.d/t3-user-env.sh ] && . /etc/profile.d/t3-user-env.sh

# Settings an older image baked in, still in this container's environment (see
# docker/user-env.sh). Everything started from here runs without them; say so,
# because `docker exec` still sees them until they are removed from the
# container's configuration.
if [ -n "${T3_LEGACY_ENV:-}" ]; then
  log "ignoring settings left over from an older image: ${T3_LEGACY_ENV}"
  log "    they point at toolchains this image no longer ships; remove them from the"
  log "    container's environment (the image sets its own PATH)"
fi

# A home volume from before the image wrote ~/.npmrc keeps its old one (or
# none), and `docker exec -u t3 npm i -g` then fails on the root-owned system
# prefix. Add the prefix once, without touching anything else in the file.
if ! grep -qs '^prefix=' "${T3_HOME}/.npmrc"; then
  # A file without a trailing newline would otherwise get the prefix glued
  # onto its last line - often an auth token.
  if [ -s "${T3_HOME}/.npmrc" ] && [ -n "$(tail -c 1 "${T3_HOME}/.npmrc")" ]; then
    printf '\n' >> "${T3_HOME}/.npmrc" 2>/dev/null || true
  fi
  printf 'prefix=/opt/npm-global\n' >> "${T3_HOME}/.npmrc" 2>/dev/null || true
fi

if [ "${1:-}" != "t3-serve" ]; then
  exec "$@"
fi
shift || true

# T3 decides an agent is installed by finding its name on PATH, and the
# dispatcher answers to every agent name whether it is installed or not. Keep
# it out of what the server and everything started here inherits.
PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -vx '/usr/local/lib/t3-agents' | paste -sd: -)"
export PATH

register_projects() {
  [ "$T3_AUTO_ADD_PROJECTS" = "1" ] || return 0
  [ -d "$T3_WORKSPACE" ] || return 0

  local dir
  if [ -e "${T3_WORKSPACE}/.git" ]; then
    "$T3_INFRA_LAUNCHER" project add "$T3_WORKSPACE" >/dev/null 2>&1 \
      && log "registered project ${T3_WORKSPACE}" || true
    return 0
  fi

  for dir in "$T3_WORKSPACE"/*/; do
    [ -d "$dir" ] || continue
    [ -e "${dir}.git" ] || continue
    dir="${dir%/}"
    "$T3_INFRA_LAUNCHER" project add "$dir" >/dev/null 2>&1 \
      && log "registered project ${dir}" || true
  done
}

register_projects

# Agent credentials default to $HOME - ~/.claude, ~/.codex and friends - which
# only survives a recreate if the whole home is mounted. The state directory is
# the one path every deployment mounts, so anchor them there and link them back.
# Whatever you mounted, signing in once stays signed in.
AGENT_DIRS=".claude .codex .cursor .grok .config/opencode .local/share/opencode"

persist_agent_credentials() {
  [ "$T3_PERSIST_AGENT_CREDENTIALS" = "1" ] || return 0
  local store="${T3CODE_HOME}/agents" src dst
  mkdir -p "$store"
  for rel in $AGENT_DIRS; do
    src="${T3_HOME}/${rel}"
    dst="${store}/$(printf '%s' "$rel" | tr '/' '_')"
    [ -L "$src" ] && continue
    mkdir -p "$dst" "$(dirname "$src")"
    if [ -d "$src" ]; then
      # Anything signed in before this existed comes along rather than being
      # silently orphaned behind the new link.
      cp -a "$src/." "$dst/" 2>/dev/null || true
      rm -rf "$src"
      log "moved ${rel} onto the state volume"
    fi
    ln -sfn "$dst" "$src"
  done
}

# Field 4 of mountinfo is the mount's source, which is the only way from inside
# a container to tell a bind mount from a named volume from an anonymous one.
# That distinction matters: the Dockerfile declares VOLUME, so /home/t3 is
# always a mount and always looks persistent - but an anonymous volume survives
# a restart and is replaced on recreate, taking every agent sign-in with it.
covering_mount() {
  awk -v path="$1" '
    $5 == "/" { next }
    path == $5 || index(path, $5 "/") == 1 {
      if (length($5) > length(point)) { point = $5; root = $4 }
    }
    END { if (point != "") print point "\t" root }
  ' /proc/self/mountinfo
}

report_persistence() {
  local line point root
  line="$(covering_mount "$T3CODE_HOME")"
  point="${line%%	*}"
  root="${line##*	}"

  if [ -z "$line" ]; then
    log "WARNING: ${T3CODE_HOME} is not on a mount at all. Nothing survives this"
    log "         container. Mount a volume at ${T3_HOME}."
    return
  fi

  case "$root" in
    # A named or anonymous volume. The data root can carry a prefix (a btrfs
    # subvolume layout reports sources as /@/var/lib/docker/volumes/...), so
    # match the volume path wherever it starts rather than only at the root.
    */var/lib/docker/volumes/*/_data)
      local name="${root##*/var/lib/docker/volumes/}"
      name="${name%%/*}"
      if printf '%s' "$name" | grep -qE '^[0-9a-f]{64}$'; then
        log "WARNING: ${point} is an anonymous volume. It survives a restart, but"
        log "         recreating this container creates a new one and every agent"
        log "         sign-in, thread and project is lost. Mount a named volume"
        log "         or a host directory at ${T3_HOME} instead."
      else
        log "state and agent credentials persist on volume '${name}' (${point})"
      fi
      ;;
    *)
      log "state and agent credentials persist on ${root} (${point})"
      ;;
  esac
}

persist_agent_credentials
report_persistence

# Hand T3 the harness manager's choice of executable. T3 watches its settings
# file and re-reads it live, so a managed Install/Update/Uninstall reaches the
# running server through the same write the setup console triggers. A missing
# or degraded mise is not fatal: no binaryPath is written, and T3's provider
# stays unconfigured rather than pointed at an executable that is not there.
sync_managed_providers() {
  [ -r "$T3_PROVIDER_CLI" ] || return 0
  [ -x "$T3_INFRA_NODE" ] || return 0
  local out
  if out="$("$T3_INFRA_NODE" "$T3_PROVIDER_CLI" sync 2>&1)"; then
    log "managed provider selections: ${out}"
  else
    log "WARNING: could not apply managed harness selections to T3 settings"
    log "         ${out}"
  fi
}

sync_managed_providers

# Put back what the image used to bake. Everything T3_PREINSTALL names (by
# default Claude Code, Codex, OpenCode and Go, Rust, Bun, Deno and uv) that is
# not on the volume yet installs in the background, once: progress is on the setup page,
# each agent is handed to T3 as soon as it lands, and a failure is retried on
# the next start. Nothing here blocks the server from coming up.
start_preinstall() {
  [ -r /opt/t3-harness/preinstall.mjs ] || return 0
  [ -x "$T3_INFRA_NODE" ] || return 0
  ( "$T3_INFRA_NODE" /opt/t3-harness/preinstall.mjs || true ) &
}

start_preinstall

# The setup service exists for one job: minting a pairing link on demand,
# without a shell in the container and without a restart. Everything after
# pairing belongs to T3 Code's own UI, which does it better.
start_setup_service() {
  [ "$T3_SETUP_ENABLED" = "1" ] || return 0
  [ -f /opt/t3-setup/server.mjs ] || return 0

  # The key: T3_SETUP_KEY, else the one kept on the volume since the first
  # start, else a new one, kept from now on (docker/setup/setup-key.mjs, which
  # also writes it where t3-expose and friends read it). Printed on every start
  # unless it was configured: on a hosting platform the log is the one place to
  # find it without a shell. Each message names T3_SETUP_KEY on the line before
  # the key, so `grep -A1 T3_SETUP_KEY` finds it whichever was printed.
  local resolved
  if ! resolved="$("$T3_INFRA_NODE" /opt/t3-setup/setup-key.mjs --resolve)" || [ -z "$resolved" ]; then
    log "ERROR: could not settle on a setup key; the setup UI is off for this start"
    return 0
  fi
  T3_SETUP_KEY_SOURCE="${resolved%% *}"
  T3_SETUP_KEY="${resolved#* }"
  case "$T3_SETUP_KEY_SOURCE" in
    new)
      log "T3_SETUP_KEY was not set; generated a setup key and kept it on the volume:"
      log "    ${T3_SETUP_KEY}"
      log "    It stays the same from now on. Set T3_SETUP_KEY to choose your own." ;;
    volume)
      log "T3_SETUP_KEY is not set; the setup key kept on the volume is:"
      log "    ${T3_SETUP_KEY}" ;;
    boot)
      log "T3_SETUP_KEY was not set, and ${T3CODE_HOME} could not keep a key; generated one for this start:"
      log "    ${T3_SETUP_KEY}"
      log "    It changes on every start. Set T3_SETUP_KEY to keep one." ;;
  esac
  export T3_SETUP_KEY T3_SETUP_KEY_SOURCE

  (
    while :; do
      "$T3_INFRA_NODE" /opt/t3-setup/server.mjs \
        || log "setup service exited; restarting in 5s"
      sleep 5
    done
  ) &

  if [ -n "$T3_SINGLE_PORT" ]; then
    log "setup UI on port ${T3_SETUP_PORT}, and on the one port below"
  else
    log "setup UI on port ${T3_SETUP_PORT} - publish it to pair a device from a browser"
  fi
}

start_setup_service

# T3_SINGLE_PORT: one listener in front of both services, for hosting platforms
# and tunnels that route a single port. The setup page answers under its prefix
# there, T3 Code everywhere else (docker/router/router.mjs). Started before the
# server so a visitor who arrives first gets a page that waits for it.
start_router() {
  [ -n "$T3_SINGLE_PORT" ] || return 0
  [ -f "$ROUTER" ] || return 0
  (
    # A router that ran a while and then died comes straight back; one that
    # cannot start at all (its port taken) backs off instead of filling the log.
    delay=1
    while :; do
      started=$SECONDS
      "$T3_INFRA_NODE" "$ROUTER" || true
      if [ $((SECONDS - started)) -ge 30 ]; then delay=1; else delay=$((delay * 2 > 60 ? 60 : delay * 2)); fi
      log "router exited; restarting in ${delay}s"
      sleep "$delay"
    done
  ) &
  # The router's own first line says exactly what it serves where.
  log "one port: ${T3_SINGLE_PORT}, in front of T3 Code and the setup page"
}

start_router

if [ "$T3_PRINT_PAIRING_ON_START" = "1" ]; then
  # The server has to be up before a token is worth anything; mint it just
  # after the listener opens.
  (
    for _ in $(seq 1 60); do
      # --max-time is load-bearing: the server accepts connections before it
      # answers, so a probe fired during startup hangs indefinitely and this
      # loop never reaches a second iteration.
      if curl -fsS --max-time 3 \
           "http://127.0.0.1:${T3CODE_PORT}/.well-known/t3/environment" \
           >/dev/null 2>&1; then
        log "pairing link for this environment (use this one, not the banner):"
        t3-pair || log "could not mint a startup pairing link"
        exit 0
      fi
      sleep 2
    done
    log "server did not become healthy in time; skipping startup pairing link"
  ) &
fi

log "starting T3 Code ${T3CODE_HOST}:${T3CODE_PORT} (state: ${T3CODE_HOME})"
# Resolved as the setup page resolves it: T3_PUBLIC_URL, the address saved on
# the setup page, or the hosting platform's (docker/setup/public-url.mjs).
public_url="$("$T3_INFRA_NODE" /opt/t3-setup/public-url.mjs --describe 2>/dev/null || true)"
if [ -n "$public_url" ]; then
  log "public URL: ${public_url} - pair a device on the setup page, or with t3-pair"
else
  log "no public URL yet; set it on the setup page (or T3_PUBLIC_URL) to pair a device"
fi
# The server's own banner follows, advertising its bridge address and a token
# that lives five minutes. Both are useless from outside the container.
log "note: the token in the server banner below expires in 5 minutes and is"
log "      addressed to this container - use t3-pair for a link that lasts"

# Under docker/run-t3.sh rather than in this shell's place, so the setup page
# can restart it: T3 Connect's link, for one, takes effect on a start. T3 Code
# exiting on its own still ends the container, with its status, as before.
exec /usr/local/lib/t3code/run-t3.sh "$T3_INFRA_LAUNCHER" serve \
  --host "$T3CODE_HOST" \
  --port "$T3CODE_PORT" \
  "$@" \
  "$T3_WORKSPACE"
