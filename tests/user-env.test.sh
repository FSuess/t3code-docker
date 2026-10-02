#!/usr/bin/env bash
# The user environment (docker/user-env.sh) drops the settings an older image
# baked in when a recreated container still carries them, and nothing else.
#
#   bash tests/user-env.test.sh
#
# It is sourced by login shells (dash, via /etc/profile) and by the entrypoint
# and helpers (bash), so every case runs under both.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
USER_ENV="$ROOT/docker/user-env.sh"

pass=0
fail=0
ok() { printf '  PASS %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (expected [$2], got [$3])"; fi
}

# The PATH every image up to v0.4 declared.
OLD_PATH=/usr/local/bun/bin:/usr/local/deno/bin:/usr/local/cargo/bin:/usr/local/go/bin:/home/t3/go/bin:/opt/cursor/.local/bin:/opt/npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Source the file in a clean environment and print what a script would read.
# The checks below rely on none of the old directories existing on this host.
probe() {
  local shell="$1"; shift
  env -i HOME=/tmp/t3-user-env-test "$@" "$shell" -c '
    . "$0"
    printf "legacy=%s\n" "${T3_LEGACY_ENV-}"
    for name in GOROOT RUSTUP_HOME CARGO_HOME BUN_INSTALL DENO_INSTALL CURSOR_HOME GOPATH; do
      eval "printf \"%s=%s\\n\" $name \"\${$name-<unset>}\""
    done
    printf "path=%s\n" "$PATH"
    printf "leftovers=%s\n" "$(set | grep -c "^t3_" || true)"
  ' "$USER_ENV"
}
field() { printf '%s\n' "$1" | sed -n "s/^$2=//p"; }

for shell in dash bash; do
  if ! command -v "$shell" >/dev/null 2>&1; then
    ok "$shell is not installed here; skipped"
    continue
  fi
  printf '%s\n' "$shell"

  out="$(probe "$shell" PATH="$OLD_PATH" GOPATH=/home/t3/go \
    GOROOT=/usr/local/go RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo \
    BUN_INSTALL=/usr/local/bun DENO_INSTALL=/usr/local/deno CURSOR_HOME=/opt/cursor)"
  is "every old toolchain setting is dropped" "<unset>" \
    "$(for n in GOROOT RUSTUP_HOME CARGO_HOME BUN_INSTALL DENO_INSTALL CURSOR_HOME; do field "$out" "$n"; done | sort -u)"
  is "and listed for the entrypoint and the console" \
    "GOROOT RUSTUP_HOME CARGO_HOME BUN_INSTALL DENO_INSTALL CURSOR_HOME PATH" "$(field "$out" legacy)"
  path="$(field "$out" path)"
  case ":$path:" in
    *:/usr/local/go/bin:*|*:/usr/local/cargo/bin:*|*:/usr/local/bun/bin:*|*:/usr/local/deno/bin:*|*:/opt/cursor/.local/bin:*)
      no "the old toolchain directories leave PATH ($path)" ;;
    *) ok "the old toolchain directories leave PATH" ;;
  esac
  case ":$path:" in
    *:/usr/bin:*) ok "the rest of PATH stays" ;;
    *) no "the rest of PATH stays ($path)" ;;
  esac
  is "GOPATH, which the image still uses, stays" /home/t3/go "$(field "$out" GOPATH)"
  is "no temporary variable is left in the shell" 0 "$(field "$out" leftovers)"

  out="$(probe "$shell" PATH=/usr/bin:/bin GOROOT=/opt/my-go CARGO_HOME=/home/t3/.cargo RUSTUP_HOME=/home/t3/.rustup)"
  is "a GOROOT someone chose is kept" /opt/my-go "$(field "$out" GOROOT)"
  is "so are CARGO_HOME and RUSTUP_HOME" "/home/t3/.cargo /home/t3/.rustup" \
    "$(field "$out" CARGO_HOME) $(field "$out" RUSTUP_HOME)"
  is "and nothing is reported" "" "$(field "$out" legacy)"

  out="$(probe "$shell" PATH=/usr/bin:/bin)"
  is "a clean environment reports nothing" "" "$(field "$out" legacy)"
done

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
