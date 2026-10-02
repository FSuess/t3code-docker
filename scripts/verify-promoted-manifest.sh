#!/usr/bin/env bash
# Assert that a published manifest maps exactly the expected platform digests.
#
#   scripts/verify-promoted-manifest.sh [options] REFERENCE...
#
# The unit under test is this repository's promotion rule: a release tag may
# only resolve to a multi-platform manifest whose linux/amd64 and linux/arm64
# members are the exact digests that were built, and whose amd64 member is the
# one the capability checks ran against. A rebuild that nobody tested is not a
# promotable artifact, even when its source is identical.
#
# References are read through the registry (`docker buildx imagetools`), so no
# local image or running container is needed - only the docker CLI with buildx
# and jq. Registry credentials come from the ambient docker login, exactly like
# the promotion step that calls this script.
#
#   # Verify a staged promotion before assigning release tags:
#   scripts/verify-promoted-manifest.sh \
#     --expect linux/amd64=sha256:111... \
#     --expect linux/arm64=sha256:222... \
#     ghcr.io/you/t3code:core-staging
#
#   # A tag promoted from the tested digests in CI evidence:
#   scripts/verify-promoted-manifest.sh \
#     --expect "linux/amd64=$(jq -r .digest amd64.json)" \
#     --expect "linux/arm64=$(jq -r .digest arm64.json)" \
#     ghcr.io/you/t3code:core
#
# Progress and the verdict go to stderr; --json writes machine-readable records
# to stdout. Exit status is 0 only when every reference maps every expected
# platform to the expected digest and carries no unexpected image member.
set -euo pipefail

PLATFORMS="linux/amd64,linux/arm64"
JSON=0
REFS=()
EXPECTED=()

usage() {
  cat <<'USAGE'
Usage: scripts/verify-promoted-manifest.sh [options] REFERENCE...

  REFERENCE          image tag or tag with registry, e.g. ghcr.io/you/t3code:core

Options:
  --expect PLATFORM=DIGEST  expected member digest, repeatable
                            (linux/amd64=sha256:..., linux/arm64=sha256:...)
  --platforms LIST          comma-separated image platforms that must be
                            present (default linux/amd64,linux/arm64)
  --json                    print one JSON record per member on stdout
  -h, --help                show this help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --expect)    EXPECTED+=("${2:?--expect needs PLATFORM=DIGEST}"); shift 2 ;;
    --platforms) PLATFORMS="${2:?--platforms needs a list}"; shift 2 ;;
    --json)      JSON=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    --)          shift; REFS+=("$@"); break ;;
    -*)          echo "verify-promoted-manifest.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
    *)           REFS+=("$1"); shift ;;
  esac
done

[ "${#REFS[@]}" -gt 0 ] || { usage >&2; exit 2; }
command -v docker >/dev/null 2>&1 \
  || { echo "verify-promoted-manifest.sh: docker (with buildx) is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 \
  || { echo "verify-promoted-manifest.sh: jq is required" >&2; exit 1; }

# Normalise the expected platform set once; it doubles as the member allowlist.
wanted=""
for platform in ${PLATFORMS//,/ }; do
  case "$platform" in
    linux/*) ;;
    *) echo "verify-promoted-manifest.sh: --platforms wants linux/<arch>, got '$platform'" >&2; exit 2 ;;
  esac
  wanted="${wanted:+$wanted }$platform"
done
[ -n "$wanted" ] || { echo "verify-promoted-manifest.sh: --platforms is empty" >&2; exit 2; }

EXPECTED_FILE="$(mktemp)"
RECORDS="$(mktemp)"
trap 'rm -f "$EXPECTED_FILE" "$RECORDS"' EXIT

for pair in ${EXPECTED[@]+"${EXPECTED[@]}"}; do
  case "$pair" in
    *"=sha256:"*) ;;
    *) echo "verify-promoted-manifest.sh: --expect wants PLATFORM=sha256:..., got '$pair'" >&2; exit 2 ;;
  esac
  platform="${pair%%=*}"
  printf '%s' "$wanted" | grep -qw -- "$platform" \
    || { echo "verify-promoted-manifest.sh: --expect $platform is not in --platforms '$PLATFORMS'" >&2; exit 2; }
  printf '%s\t%s\n' "$platform" "${pair#*=}" >> "$EXPECTED_FILE"
done

failure=0

report_ok() { printf '  \033[32mPASS\033[0m %s\n' "$1" >&2; }
report_no() { printf '  \033[31mFAIL\033[0m %s\n' "$1" >&2; failure=1; }

expected_digest() { # platform -> digest or empty
  awk -F'\t' -v p="$1" '$1 == p { print $2; exit }' "$EXPECTED_FILE"
}

verify_one() {
  local ref="$1" raw members foreign index_digest ambiguous
  local want_platform found_one member_platform member_digest expected ok=1
  local foreign_os foreign_arch foreign_digest

  raw="$(docker buildx imagetools inspect --raw "$ref" 2>/dev/null)" \
    || { report_no "$ref: cannot read the manifest"; return; }
  index_digest="$(docker buildx imagetools inspect "$ref" \
    --format '{{.Manifest.Digest}}' 2>/dev/null)" \
    || { report_no "$ref: cannot read the manifest digest"; return; }

  if ! printf '%s' "$raw" | jq -e '.manifests' >/dev/null 2>&1; then
    report_no "$ref: not a multi-platform manifest index"
    return
  fi

  # Attestation manifests ride along with some builds. They are not image
  # members and cannot be pulled by platform, so they are reported, not failed.
  # Anything else that is not a Linux image - a Windows or Darwin image, say -
  # is an unexpected member and fails: only linux/<arch> image members are
  # allowed.
  ambiguous="$(printf '%s' "$raw" | jq '[.manifests[] | select((.platform.os // "") == "unknown" and (.platform.architecture // "") == "unknown")] | length')"
  foreign="$(printf '%s' "$raw" | jq -r '
    .manifests[]
    | select((.platform.os // "") != "linux")
    | select((.platform.os // "") != "unknown" or (.platform.architecture // "") != "unknown")
    | [(.platform.os // "?"), (.platform.architecture // "?"), .digest] | @tsv')"
  members="$(printf '%s' "$raw" | jq -r '
    .manifests[]
    | select((.platform.os // "") == "linux")
    | [.platform.architecture, .digest] | @tsv')"

  while IFS=$'\t' read -r foreign_os foreign_arch foreign_digest; do
    [ -n "$foreign_os" ] || continue
    report_no "$ref: unexpected member $foreign_os/$foreign_arch ($foreign_digest)"
    ok=0
  done <<< "$foreign"

  for want_platform in $wanted; do
    found_one=0
    while IFS=$'\t' read -r member_platform member_digest; do
      [ -n "$member_platform" ] || continue
      [ "linux/$member_platform" = "$want_platform" ] || continue
      found_one=$((found_one + 1))
      expected="$(expected_digest "$want_platform")"
      if [ -n "$expected" ] && [ "$expected" != "$member_digest" ]; then
        report_no "$ref: $want_platform is $member_digest, expected $expected"
        ok=0
      fi
    done <<< "$members"
    if [ "$found_one" -eq 0 ]; then
      report_no "$ref: missing $want_platform"
      ok=0
    elif [ "$found_one" -gt 1 ]; then
      report_no "$ref: $want_platform appears $found_one times"
      ok=0
    fi
  done

  while IFS=$'\t' read -r member_platform member_digest; do
    [ -n "$member_platform" ] || continue
    printf '%s' "$wanted" | grep -qw -- "linux/$member_platform" || {
      report_no "$ref: unexpected member linux/$member_platform"
      ok=0
    }
  done <<< "$members"

  [ "$ok" -eq 1 ] && report_ok "$ref maps the expected digests"

  printf '%s\t%s\t%s\t%s\t\t\n' "$ref" "$index_digest" "$ambiguous" "$ok" >> "$RECORDS"
  while IFS=$'\t' read -r member_platform member_digest; do
    [ -n "$member_platform" ] || continue
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$ref" "$index_digest" "$ambiguous" "$ok" "linux/$member_platform" "$member_digest" >> "$RECORDS"
  done <<< "$members"
}

printf '\nVerifying promoted manifests\n' >&2
for ref in "${REFS[@]}"; do
  printf '\n%s\n' "$ref" >&2
  verify_one "$ref"
done

if [ "$JSON" -eq 1 ]; then
  jq -Rnc '
    [inputs | split("\t")]
    | map(select(length >= 4))
    | group_by(.[0])
    | map({
        ref: .[0][0],
        manifestDigest: .[0][1],
        ambiguousManifests: (.[0][2] | tonumber),
        ok: (.[0][3] == "1"),
        members: map(select(.[4] != "") | {platform: .[4], digest: .[5]})
      })
    | .[]
  ' < "$RECORDS"
fi

if [ "$failure" -ne 0 ]; then
  printf '\n\033[31mPromotion verification failed\033[0m\n\n' >&2
  exit 1
fi

printf '\nAll promoted manifests map the expected digests.\n\n' >&2
