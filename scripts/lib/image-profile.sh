#!/usr/bin/env bash
# Shared image capability profile for the scripts that verify the targets.
#
# Call t3_image_profile_resolve <caller> <image> <requested-variant>. It sets:
#   VARIANT      core | browser
#   HAS_BROWSER  0 | 1

t3_image_profile_resolve() {
  local caller="$1"
  local image="$2"
  local requested="$3"
  local tag=""

  case "$requested" in
    ""|core|browser) ;;
    *) echo "$caller: variant must be core or browser" >&2; return 2 ;;
  esac

  VARIANT="$requested"
  if [ -z "$VARIANT" ]; then
    tag="${image##*:}"
    case "$image" in
      *@sha256:*) tag="" ;;
    esac

    case "$tag" in
      core|browser) VARIANT="$tag" ;;
      *-core) VARIANT="core" ;;
      *-browser) VARIANT="browser" ;;
      *)
        VARIANT="$(docker image inspect --format \
          '{{range .Config.Env}}{{println .}}{{end}}' "$image" 2>/dev/null \
          | sed -n 's/^T3_IMAGE_VARIANT=//p' | head -1)" || VARIANT=""
        case "$VARIANT" in
          core|browser) ;;
          *)
            echo "$caller: cannot infer --variant from '$image'; pass --variant explicitly" >&2
            return 2
            ;;
        esac
        ;;
    esac
  fi

  # Consumed by the sourcing verifier, so shellcheck cannot see the read here.
  # shellcheck disable=SC2034
  HAS_BROWSER=0
  # shellcheck disable=SC2034
  [ "$VARIANT" = browser ] && HAS_BROWSER=1
  return 0
}
