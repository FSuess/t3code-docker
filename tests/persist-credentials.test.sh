#!/usr/bin/env bash
# Where the entrypoint keeps sign-ins (persist_agent_credentials in
# docker/entrypoint.sh): on the state volume, linked back into the home.
#
#   bash tests/persist-credentials.test.sh
#
# The function and its list of paths are read out of the entrypoint and run
# against a scratch home. Which paths are mounted on their own is stubbed
# (covering_mount reads /proc/self/mountinfo, which a test cannot arrange).
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

pass=0
fail=0
ok() { printf '  PASS %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (expected [$2], got [$3])"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log() { :; }
# Paths named in $MOUNTED are mounted on their own; everything else shares the
# home's mount.
MOUNTED=""
covering_mount() {
  local point
  for point in $MOUNTED; do
    case "$1/" in "$point"/*) printf '%s\n' "$point"; return ;; esac
  done
  printf 'home\n'
}
eval "$(sed -n '/^AGENT_DIRS=/,/^}/p' "$ROOT/docker/entrypoint.sh")"
declare -F persist_agent_credentials >/dev/null || { echo "persist_agent_credentials not found in the entrypoint"; exit 1; }

T3_HOME="$WORK/home"
T3CODE_HOME="$WORK/state"
export T3_PERSIST_AGENT_CREDENTIALS=1
STORE="$T3CODE_HOME/agents"
mkdir -p "$T3_HOME" "$T3CODE_HOME"

# A sign-in and a git identity from before, in the home.
mkdir -p "$T3_HOME/.config/gh"
echo "github.com: {user: ana}" > "$T3_HOME/.config/gh/hosts.yml"
printf '[user]\n\tname = Ana\n' > "$T3_HOME/.gitconfig"
# The host's glab sign-in, mounted into the container.
mkdir -p "$T3_HOME/.config/glab-cli"
echo "host's" > "$T3_HOME/.config/glab-cli/config.yml"
MOUNTED="$T3_HOME/.config/glab-cli"

persist_agent_credentials

[ -L "$T3_HOME/.config/gh" ] && ok "a CLI's directory becomes a link" || no "a CLI's directory becomes a link"
is "into the state volume" "$STORE/.config_gh" "$(readlink "$T3_HOME/.config/gh")"
is "with the sign-in that was there" "github.com: {user: ana}" "$(cat "$STORE/.config_gh/hosts.yml")"
[ -L "$T3_HOME/.gitconfig" ] && ok "the home's .gitconfig becomes a link" || no "the home's .gitconfig becomes a link"
is "with the settings that were there" "Ana" "$(git config --file "$T3_HOME/.gitconfig" user.name)"
[ ! -L "$T3_HOME/.config/glab-cli" ] && ok "a mounted directory is left where it is" || no "a mounted directory is left where it is"
is "with the host's files in it" "host's" "$(cat "$T3_HOME/.config/glab-cli/config.yml")"
[ ! -e "$STORE/.config_glab-cli" ] && ok "and nothing is copied out of it" || no "and nothing is copied out of it"
[ -d "$STORE/.azure" ] && [ -L "$T3_HOME/.azure" ] && ok "a CLI not used yet gets its place too" || no "a CLI not used yet gets its place too"

# git writes through the link: what gh auth setup-git and git config --global
# add lands on the state volume, and the link stays.
HOME="$T3_HOME" git config --global credential.https://github.com.helper '!gh auth git-credential'
[ -L "$T3_HOME/.gitconfig" ] && ok "git config --global keeps the link" || no "git config --global keeps the link"
is "and writes to the state volume" '!gh auth git-credential' "$(git config --file "$STORE/.gitconfig" credential.https://github.com.helper)"

# A recreated container: a fresh home, the same state volume.
rm -rf "$T3_HOME"
mkdir -p "$T3_HOME"
MOUNTED=""
persist_agent_credentials
is "after a recreate, the sign-in is back" "github.com: {user: ana}" "$(cat "$T3_HOME/.config/gh/hosts.yml")"
is "and so is git's identity" "Ana" "$(HOME="$T3_HOME" git config --global user.name)"
is "and its credential helper" '!gh auth git-credential' "$(HOME="$T3_HOME" git config --global credential.https://github.com.helper)"

# Running again changes nothing.
before="$(cd "$WORK" && find . | sort)"
persist_agent_credentials
is "a second run changes nothing" "$before" "$(cd "$WORK" && find . | sort)"

# Turned off: nothing moves.
rm -rf "$T3_HOME" "$T3CODE_HOME"
mkdir -p "$T3_HOME" "$T3CODE_HOME"
printf '[user]\n\tname = Ana\n' > "$T3_HOME/.gitconfig"
T3_PERSIST_AGENT_CREDENTIALS=0 persist_agent_credentials
[ -f "$T3_HOME/.gitconfig" ] && [ ! -L "$T3_HOME/.gitconfig" ] && [ ! -e "$STORE" ] && ok "T3_PERSIST_AGENT_CREDENTIALS=0 leaves everything" || no "T3_PERSIST_AGENT_CREDENTIALS=0 leaves everything"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
