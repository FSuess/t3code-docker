#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/image-profile.sh
. "$ROOT/scripts/lib/image-profile.sh"

pass=0
fail=0
ok() { printf '  PASS %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (expected [$2], got [$3])"; fi
}

resolve() {
  VARIANT=""
  HAS_BROWSER=""
  t3_image_profile_resolve test "$1" "${2:-}"
}

resolve t3code:core
is "core tag selects core" core "$VARIANT"
is "core has no browser" 0 "$HAS_BROWSER"

resolve ghcr.io/example/t3code:release-browser
is "suffixed tag selects browser" browser "$VARIANT"
is "browser capability is enabled" 1 "$HAS_BROWSER"

resolve 'ghcr.io/example/t3code@sha256:abc' core
is "explicit variant supports a digest" core "$VARIANT"

docker() {
  [ "$1 $2" = "image inspect" ] || return 1
  if [ "${5:-}" = 'repo@sha256:abc' ]; then
    return 1
  fi
  printf '%s\n' T3_IMAGE_VARIANT=browser
}
resolve sha256:local
is "image stamp selects browser" browser "$VARIANT"

if t3_image_profile_resolve test t3code:core invalid >/dev/null 2>&1; then
  no "invalid variant is rejected"
else
  is "invalid variant exits with usage status" 2 "$?"
fi

if t3_image_profile_resolve test 'repo@sha256:abc' "" >/dev/null 2>&1; then
  no "unstamped digest is rejected"
else
  is "unstamped digest requires explicit variant" 2 "$?"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
