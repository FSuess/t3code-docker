#!/usr/bin/env bash
# Measure publishable image size and startup cost for the toolchain baseline.
#
# Two modes, because the numbers must be reproducible both on a native build
# runner and from a published artifact:
#
#   scripts/measure-image.sh core browser
#     Measure locally built targets through the container runtime (default:
#     docker). Builds a missing target first unless --no-build is given, and
#     records compressed size, unpacked size, digest, and startup time.
#
#   scripts/measure-image.sh --registry ghcr.io/dizys/t3code-docker core browser
#     Measure a pushed multi-arch reference through the registry API. Needs no
#     container runtime, and records the compressed and uncompressed layer
#     totals plus the provenance labels baked into the config. Startup time is
#     not available without a runtime.
#
# Sizes are printed as bytes; pass --human for GiB. --json prints machine
# readable records for CI.
set -euo pipefail

cd "$(dirname "$0")/.."

BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
[ -t 1 ] || { BOLD=""; DIM=""; RESET=""; }

usage() {
  cat <<'USAGE'
Usage: scripts/measure-image.sh [options] TARGET...

  TARGET            local mode: core | browser (any target scripts/build.sh accepts)
                    registry mode: image tag, e.g. core | browser | 0.5.0-core

Options:
  --registry HOST/REPO   measure pushed tags through the registry API instead
                         of local images (no container runtime required)
  --platform LIST        registry mode: comma-separated linux/[amd64|arm64]
                         (default: host architecture)
  --runtime CMD          local mode: container runtime (default: docker)
  --tag-prefix NAME      local mode: image name for a target (default: t3code)
  --no-build             local mode: fail instead of building a missing target
  --unpacked             registry mode: download and sum uncompressed layers
  --no-startup           local mode: skip the first-healthy-response timing
  --timeout SECS         local mode: startup wait budget (default: 180)
  --json                 print one JSON object per record
  --out FILE             append a Markdown table of the records to FILE
  -h, --help             show this help

Examples:
  scripts/measure-image.sh core browser
  scripts/measure-image.sh --no-startup --runtime podman core
  scripts/measure-image.sh --registry ghcr.io/dizys/t3code-docker --unpacked core browser
USAGE
}

REGISTRY=""
PLATFORMS=""
RUNTIME="${CONTAINER_RUNTIME:-docker}"
TAG_PREFIX="t3code"
BUILD=1
UNPACKED=0
STARTUP=1
TIMEOUT=180
JSON=0
OUT=""
TARGETS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --registry)   REGISTRY="${2:?--registry needs HOST/REPO}"; shift 2 ;;
    --platform)   PLATFORMS="${2:?--platform needs a list}"; shift 2 ;;
    --runtime)    RUNTIME="${2:?--runtime needs a command}"; shift 2 ;;
    --tag-prefix) TAG_PREFIX="${2:?--tag-prefix needs a name}"; shift 2 ;;
    --no-build)   BUILD=0; shift ;;
    --unpacked)   UNPACKED=1; shift ;;
    --no-startup) STARTUP=0; shift ;;
    --timeout)    TIMEOUT="${2:?--timeout needs seconds}"; shift 2 ;;
    --json)       JSON=1; shift ;;
    --out)        OUT="${2:?--out needs a file}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    --)           shift; TARGETS+=("$@"); break ;;
    -*)           echo "measure-image.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
    *)            TARGETS+=("$1"); shift ;;
  esac
done

[ "${#TARGETS[@]}" -gt 0 ] || { usage >&2; exit 2; }

RECORDS="$(mktemp)"
SAVE_TMP=""
trap 'rm -f "$RECORDS" "$SAVE_TMP"' EXIT

record() {
  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "$@" >> "$RECORDS"
}

human() {
  [ -n "${1:-}" ] || { printf '%s' "-"; return; }
  awk -v n="$1" 'BEGIN {
    split("B KiB MiB GiB TiB", u, " "); i = 1
    while (n >= 1024 && i < 5) { n /= 1024; i++ }
    printf "%.2f %s", n, u[i]
  }'
}

host_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) echo "$(uname -m)" ;;
  esac
}

# --- local mode -------------------------------------------------------------

# Uncompressed bytes of every layer in a `docker save` archive. The modern OCI
# layout stores blobs under blobs/sha256/; the legacy layout stores an
# already-uncompressed `<id>/layer.tar` per layer. `manifest.json` lists the
# layers in order in both layouts. A blob may be gzipped (the registry artifact
# passed through) or the uncompressed layer tar (a local store that does not
# compress), so the gzip path falls back to the size in the tar header - a
# failed gunzip closes the pipe and truncates the extract, which is how this
# used to report 0 on those runners.
save_unpacked_bytes() {
  local save="$1" ref="$2" layers layer total=0 stored unpacked
  layers="$(tar -xOf "$save" manifest.json \
    | jq -r --arg ref "$ref" \
        '([.[] | select((.RepoTags // []) | index($ref))][0] // .[0]).Layers[]')"
  while IFS= read -r layer; do
    [ -n "$layer" ] || continue
    if [ "${layer##*.}" = tar ]; then
      total=$((total + $(tar -xOf "$save" "$layer" | wc -c)))
      continue
    fi
    stored="$(tar -tvf "$save" "$layer" 2>/dev/null | awk '{print $3}' | head -1)"
    unpacked="$(tar -xOf "$save" "$layer" 2>/dev/null | gzip -dc 2>/dev/null | wc -c)"
    if [ "${unpacked:-0}" -gt 0 ]; then
      total=$((total + unpacked))
    else
      total=$((total + ${stored:-0}))
    fi
  done <<< "$layers"
  printf '%s' "$total"
}

measure_startup() {
  local image="$1" name port start now alive deadline
  name="measure-$$-$RANDOM"
  port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("", 0)); print(s.getsockname()[1]); s.close()' 2>/dev/null || echo 13774)"
  start="$(date +%s.%N)"
  alive=""
  deadline=$(( $(date +%s) + TIMEOUT ))
  "$RUNTIME" run -d --name "$name" -p "127.0.0.1:${port}:3773" "$image" >/dev/null
  # Poll well below a second: a 1s sleep quantises the result and reports a
  # boot a second or more slower than it is, depending on where the ticks land.
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS --noproxy '*' --max-time 2 \
        "http://127.0.0.1:${port}/.well-known/t3/environment" >/dev/null 2>&1; then
      now="$(date +%s.%N)"; alive=1; break
    fi
    sleep 0.2
  done
  "$RUNTIME" rm -f "$name" >/dev/null 2>&1 || true
  [ -n "$alive" ] || { printf '%s' ""; return; }
  awk -v a="$start" -v b="$now" 'BEGIN { printf "%.2f", b - a }'
}

measure_local() {
  local target="$1" ref arch unpacked digest compressed startup save
  ref="${TAG_PREFIX}:${target}"

  if ! "$RUNTIME" image inspect "$ref" >/dev/null 2>&1; then
    if [ "$BUILD" -ne 1 ]; then
      echo "measure-image.sh: no local image $ref (drop --no-build to build it)" >&2
      return 1
    fi
    printf '%sbuilding %s%s\n' "$DIM" "$ref" "$RESET" >&2
    scripts/build.sh --target "$target" --tag "$ref" >&2
  fi

  arch="$("$RUNTIME" image inspect --format '{{.Architecture}}' "$ref")"
  digest="$("$RUNTIME" image inspect \
    --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}' "$ref")"
  save="$(mktemp)"
  SAVE_TMP="$save"
  "$RUNTIME" save "$ref" > "$save"
  compressed="$(gzip -c "$save" | wc -c | tr -d ' ')"
  unpacked="$(save_unpacked_bytes "$save" "$ref")"
  rm -f "$save"; SAVE_TMP=""
  if [ "$STARTUP" -eq 1 ]; then
    startup="$(measure_startup "$ref")"
  else
    startup=""
  fi

  record local "$target" "$arch" "$ref" "$digest" "$compressed" "$unpacked" "$startup" "" "" ""
}

# --- registry mode ----------------------------------------------------------

REG_HOST=""
REG_REPO=""
REG_TOKEN=""

registry_init() {
  REG_HOST="${REGISTRY%%/*}"
  REG_REPO="${REGISTRY#*/}"
  REG_TOKEN="$(curl -fsS --max-time 30 \
    "https://${REG_HOST}/token?scope=repository:${REG_REPO}:pull&service=${REG_HOST}" \
    | jq -r .token)"
}

reg_get() {
  local path="$1"; shift
  curl -fsSL --retry 3 --max-time 600 \
    -H "Authorization: Bearer ${REG_TOKEN}" "$@" \
    "https://${REG_HOST}/v2/${REG_REPO}/${path}"
}

platforms() {
  if [ -n "$PLATFORMS" ]; then
    printf '%s\n' "$PLATFORMS" | tr ',' '\n' | sed 's|^linux/||'
  else
    host_arch
  fi
}

manifest_digest_for() {
  local tag="$1" arch="$2" index
  index="$(reg_get "manifests/${tag}" \
    -H 'Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json')"
  if printf '%s' "$index" | jq -e '.manifests' >/dev/null 2>&1; then
    printf '%s' "$index" \
      | jq -r --arg arch "$arch" \
        '.manifests[] | select((.platform.os == "linux") and (.platform.architecture == $arch)) | .digest' \
      | head -1
  else
    # A single-platform tag: the reference itself resolves the manifest.
    printf '%s' "$tag"
  fi
}

measure_registry() {
  local tag="$1" arch="$2" digest manifest config compressed unpacked
  local revision version created layer n total

  digest="$(manifest_digest_for "$tag" "$arch")"
  if [ -z "$digest" ]; then
    echo "measure-image.sh: ${REGISTRY}:${tag} has no linux/${arch} manifest" >&2
    return 1
  fi

  manifest="$(reg_get "manifests/${digest}" \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json')"
  config="$(reg_get "blobs/$(printf '%s' "$manifest" | jq -r '.config.digest')")"

  compressed="$(printf '%s' "$manifest" | jq '[.layers[].size] | add // 0')"
  revision="$(printf '%s' "$config" | jq -r '.config.Labels["org.opencontainers.image.revision"] // ""')"
  version="$(printf '%s' "$config" | jq -r '.config.Labels["org.opencontainers.image.version"] // ""')"
  created="$(printf '%s' "$config" | jq -r '.created // ""')"
  arch="$(printf '%s' "$config" | jq -r '.architecture // ""')"
  unpacked=""
  if [ "$UNPACKED" -eq 1 ]; then
    total=0
    while read -r layer; do
      [ -n "$layer" ] || continue
      n="$(reg_get "blobs/${layer}" | gzip -dc 2>/dev/null | wc -c)"
      total=$((total + n))
    done < <(printf '%s' "$manifest" | jq -r '.layers[].digest')
    unpacked="$total"
  fi

  record registry "$tag" "$arch" "${REGISTRY}:${tag}" "$digest" "$compressed" "$unpacked" "" "$revision" "$version" "$created"
}

if [ -n "$REGISTRY" ]; then
  registry_init
  for tag in "${TARGETS[@]}"; do
    while read -r arch; do
      [ -n "$arch" ] || continue
      measure_registry "$tag" "$arch"
    done < <(platforms)
  done
else
  command -v "$RUNTIME" >/dev/null 2>&1 \
    || { echo "measure-image.sh: ${RUNTIME} not found; use --registry to measure a pushed reference" >&2; exit 1; }
  for target in "${TARGETS[@]}"; do
    measure_local "$target"
  done
fi

# --- output -----------------------------------------------------------------

if [ "$JSON" -eq 1 ]; then
  while IFS='|' read -r mode target arch ref digest compressed unpacked startup revision version created; do
    [ -n "$mode" ] || continue
    jq -cn \
      --arg mode "$mode" --arg target "$target" --arg arch "$arch" --arg ref "$ref" \
      --arg digest "$digest" --arg compressed "$compressed" --arg unpacked "$unpacked" \
      --arg startup "$startup" --arg revision "$revision" --arg version "$version" \
      --arg created "$created" \
      '{mode:$mode, target:$target, arch:$arch, ref:$ref, digest:$digest,
        compressed_bytes: ($compressed | if .=="" then null else tonumber end),
        unpacked_bytes: ($unpacked | if .=="" then null else tonumber end),
        startup_seconds: ($startup | if .=="" then null else tonumber end),
        revision:$revision, version:$version, created:$created}'
  done < "$RECORDS" | jq -s .
else
  printf '\n%s%-9s %-11s %-6s %14s %14s %9s%s\n' \
    "$BOLD" "TARGET" "ARCH" "MODE" "COMPRESSED" "UNPACKED" "STARTUP" "$RESET"
  printf '%-9s %-11s %-6s %14s %14s %9s\n' "---------" "-----------" "------" "--------------" "--------------" "---------"
  while IFS='|' read -r mode target arch ref digest compressed unpacked startup revision version created; do
    [ -n "$mode" ] || continue
    printf '%-9s %-11s %-6s %14s %14s %9s\n' \
      "$target" "$arch" "$mode" \
      "$(human "${compressed:-}")" "$(human "${unpacked:-}")" "${startup:--}"
  done < "$RECORDS"
  printf '\n'
  while IFS='|' read -r mode target arch ref digest compressed unpacked startup revision version created; do
    [ -n "$mode" ] || continue
    printf '%s%-9s %-6s %s%s\n' "$DIM" "$target" "$arch" "$ref" "$RESET"
    printf '  %-10s %s\n' "digest" "$digest"
    [ -n "$revision" ] && printf '  %-10s %s\n' "revision" "$revision"
    [ -n "$version" ] && printf '  %-10s %s\n' "version" "$version"
    [ -n "$created" ] && printf '  %-10s %s\n' "created" "$created"
  done < "$RECORDS"
fi

if [ -n "$OUT" ]; then
  {
    printf '\n| Target | Arch | Mode | Compressed | Unpacked | Startup | Digest |\n'
    printf '| --- | --- | --- | ---: | ---: | ---: | --- |\n'
    while IFS='|' read -r mode target arch ref digest compressed unpacked startup revision version created; do
      [ -n "$mode" ] || continue
      printf '| `%s` | `%s` | %s | %s | %s | %s | `%s` |\n' \
        "$target" "$arch" "$mode" "$(human "${compressed:-}")" "$(human "${unpacked:-}")" \
        "${startup:--}" "$digest"
    done < "$RECORDS"
  } >> "$OUT"
  printf '%sappended %s%s\n' "$DIM" "$OUT" "$RESET" >&2
fi
