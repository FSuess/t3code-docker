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
