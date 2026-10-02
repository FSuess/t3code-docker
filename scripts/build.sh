#!/usr/bin/env bash
# Build the image. Defaults to the `browser` target (what `latest` publishes)
# for the local platform.
#
#   scripts/build.sh                      # t3code:browser
#   scripts/build.sh --target core        # t3code:core
#   scripts/build.sh --platform linux/amd64,linux/arm64 --push --tag ghcr.io/you/t3code
set -euo pipefail

cd "$(dirname "$0")/.."

target=browser
tag=""
platform=""
push=0
extra=()

usage() {
  cat <<'USAGE'
Usage: scripts/build.sh [options] [-- extra docker build args]

  --target NAME     browser | core                (default: browser)
  --tag NAME        image tag              (default: t3code:<target>)
  --platform LIST   e.g. linux/amd64,linux/arm64 (implies buildx)
  --push            push instead of loading locally

  Capability profiles:
    browser  default; core + Chromium/fonts/MCP servers
    core     the same without Chromium and the browser MCP servers

Behind a TLS-intercepting proxy, drop the CA in ca-certs/ and add:
  --  --network host --build-arg APT_HTTPS=true \
      --build-arg HTTPS_PROXY="$HTTPS_PROXY" --build-arg NO_PROXY="$NO_PROXY"
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target)   target="${2:?}"; shift 2 ;;
    --tag)      tag="${2:?}"; shift 2 ;;
    --platform) platform="${2:?}"; shift 2 ;;
    --push)     push=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    --)         shift; extra=("$@"); break ;;
    *) echo "build.sh: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$target" in
  core|browser) ;;
  # The old names, kept working: same images.
  full) target=browser ;;
  slim) target=core ;;
  *) echo "build.sh: target must be browser or core (full and slim are aliases)" >&2; exit 2 ;;
esac
[ -n "$tag" ] || tag="t3code:${target}"

args=(build --target "$target" -t "$tag")
[ -n "$platform" ] && args+=(--platform "$platform")
if [ "$push" -eq 1 ]; then args+=(--push); elif [ -n "$platform" ]; then args+=(--load); fi

if [ -n "$platform" ] || [ "$push" -eq 1 ]; then
  set -- docker buildx "${args[@]}" "${extra[@]}" .
else
  set -- docker "${args[@]}" "${extra[@]}" .
fi

printf 'running:'; printf ' %q' "$@"; printf '\n'
exec "$@"
