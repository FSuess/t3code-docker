# shellcheck shell=sh
# User tool environment for the unprivileged t3 account.
#
# Installed as /etc/profile.d/t3-user-env.sh and sourced explicitly by the
# entrypoint before it launches anything, so the server, the setup service and
# the terminals T3 opens all inherit it. It returns early for uid 0: anything in
# the user's home is user-controlled, and root must neither resolve its binaries
# nor create state there.
#
# The mutable npm prefix is also written to /home/t3/.npmrc, because npm reads
# its own user config without needing a shell: a bare `docker exec -u t3 npm i
# -g` never sources this file.

# Settings an older image baked in. Up to v0.4 the image shipped Go, Rust, Bun
# and Deno under /usr/local and Cursor under /opt/cursor, and pointed its ENV at
# them. A container recreated by a tool that copies the old container's
# environment (a hosting panel's "recreate", Watchtower, a duplicated service)
# keeps those values, and they now name directories that do not exist: Go
# refuses to run with GOROOT there, and rustup tries to create /usr/local/rustup.
# Each is dropped only while it still holds exactly the old value and that path
# is still missing, so a setting someone chose is never touched. What was
# dropped is listed in T3_LEGACY_ENV, which the entrypoint logs and the setup
# console shows, because only the container's own configuration can remove it
# for good: `docker exec` reads that directly.
for t3_legacy in GOROOT=/usr/local/go RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo \
    BUN_INSTALL=/usr/local/bun DENO_INSTALL=/usr/local/deno CURSOR_HOME=/opt/cursor; do
  t3_name="${t3_legacy%%=*}"
  # Indirect read of a name from the fixed list above.
  t3_value=""
  eval "t3_value=\${${t3_name}:-}"
  if [ "$t3_value" = "${t3_legacy#*=}" ] && [ ! -e "$t3_value" ]; then
    unset "$t3_name"
    T3_LEGACY_ENV="${T3_LEGACY_ENV:+$T3_LEGACY_ENV }${t3_name}"
  fi
done
# The same image's PATH, with the bin directories of those toolchains. Split
# by hand rather than with IFS, so no entry is ever glob-expanded.
t3_rest="${PATH}:"
t3_path=""
t3_dropped=""
while [ -n "$t3_rest" ]; do
  t3_dir="${t3_rest%%:*}"
  t3_rest="${t3_rest#*:}"
  case "$t3_dir" in
    /usr/local/go/bin|/usr/local/cargo/bin|/usr/local/bun/bin|/usr/local/deno/bin|/opt/cursor/.local/bin)
      if [ ! -e "$t3_dir" ]; then t3_dropped=1; continue; fi ;;
  esac
  t3_path="${t3_path:+${t3_path}:}${t3_dir}"
done
if [ -n "$t3_dropped" ]; then
  PATH="$t3_path"
  export PATH
  case " ${T3_LEGACY_ENV:-} " in
    *" PATH "*) ;;
    *) T3_LEGACY_ENV="${T3_LEGACY_ENV:+$T3_LEGACY_ENV }PATH" ;;
  esac
fi
[ -n "${T3_LEGACY_ENV:-}" ] && export T3_LEGACY_ENV
unset t3_legacy t3_name t3_value t3_rest t3_path t3_dir t3_dropped

# The build this container runs, from a file the image writes at build time.
# The image's ENV says the same, but values carried over in a recreated
# container's own environment win over the image's; this file cannot be
# overridden that way. Read, never sourced.
if [ -r /etc/t3code-image ]; then
  while IFS='=' read -r t3_key t3_val; do
    case "$t3_key" in
      version) T3_IMAGE_VERSION="$t3_val" ;;
      variant) T3_IMAGE_VARIANT="$t3_val" ;;
    esac
  done < /etc/t3code-image
  export T3_IMAGE_VERSION T3_IMAGE_VARIANT
  unset t3_key t3_val
fi

if [ "$(id -u)" != "0" ]; then
  # User globals from `npm i -g`. Writable by t3, so on t3's PATH only.
  : "${NPM_CONFIG_PREFIX:=/opt/npm-global}"
  export NPM_CONFIG_PREFIX
  case ":$PATH:" in
    *":${NPM_CONFIG_PREFIX}/bin:"*) ;;
    *) PATH="${NPM_CONFIG_PREFIX}/bin:${PATH}"; export PATH ;;
  esac

  # Go installs user binaries under GOPATH/bin. It is deliberately off the
  # image-wide PATH (see the Dockerfile): root running `go install` should use
  # its own /root/go, and a binary the t3 user dropped here must not be
  # resolvable by root.
  : "${GOPATH:=/home/t3/go}"
  export GOPATH
  case ":$PATH:" in
    *":${GOPATH}/bin:"*) ;;
    *) PATH="${GOPATH}/bin:${PATH}"; export PATH ;;
  esac

  # mise: persistent user toolchains. The binary is image infrastructure at
  # /usr/local/bin/mise; config, data, state and cache live in the persistent
  # home so installed tools survive container recreation. The paths are
  # explicit rather than left to mise's XDG defaults so they do not move when a
  # user sets XDG_* variables, and so they match what the image documents. They
  # are exported only here: root's HOME and PATH must stay free of
  # user-controlled directories.
  : "${MISE_CONFIG_DIR:=/home/t3/.config/mise}"
  : "${MISE_DATA_DIR:=/home/t3/.local/share/mise}"
  : "${MISE_STATE_DIR:=/home/t3/.local/state/mise}"
  : "${MISE_CACHE_DIR:=/home/t3/.cache/mise}"
  export MISE_CONFIG_DIR MISE_DATA_DIR MISE_STATE_DIR MISE_CACHE_DIR

  # The shims directory is what makes tool resolution project-aware in every
  # shell the user reaches - a login terminal, an interactive one, or a child
  # process of the server - without needing mise to be activated first.
  case ":$PATH:" in
    *":${MISE_DATA_DIR}/shims:"*) ;;
    *) PATH="${MISE_DATA_DIR}/shims:${PATH}"; export PATH ;;
  esac

  # Harnesses that get no mise shim (Cursor) are linked here by the harness
  # manager while they are installed, and only then.
  case ":$PATH:" in
    *":/home/t3/.local/share/t3-harness/bin:"*) ;;
    *) PATH="/home/t3/.local/share/t3-harness/bin:${PATH}"; export PATH ;;
  esac

  # The agent dispatcher (/usr/local/lib/t3-agents, on the image PATH for
  # `docker exec`) is deliberately not added here. T3 reads its PATH from an
  # interactive login shell, which runs this file, and decides an agent is
  # installed by finding its name there; the dispatcher answers to every
  # agent name, installed or not.

  # Interactive bash also gets mise's full activation, which keeps the tool
  # environment current when the shell changes directory. Non-interactive
  # contexts and explicit `mise exec` do not need it.
  if [ -n "${BASH_VERSION:-}" ]; then
    case $- in
      *i*) eval "$(/usr/local/bin/mise activate bash)" ;;
    esac
  fi
fi
