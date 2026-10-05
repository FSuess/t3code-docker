#!/bin/bash
# Run T3 Code, and run it again when the setup page asks.
#
#   run-t3.sh <command> [args...]
#
# The entrypoint used to exec T3 Code, which made it the container's main
# process: the only way to restart it was to restart the container. Some
# settings only take effect on a start (T3 Connect's link, for one), and the
# setup page should be able to apply them without a shell or a host panel. So
# this stays in the middle:
#
#   - the setup page asks for a restart by creating $T3_RUN_DIR/restart and
#     sending T3 Code SIGTERM (its pid is in $T3_RUN_DIR/t3.pid); T3 Code
#     shuts down as it would for `docker stop`, and starts again here;
#   - T3 Code exiting for any other reason ends this script with its status,
#     and so the container, as before: a crash is seen, and the container's
#     restart policy decides what happens next. A loop that restarted it would
#     hide one;
#   - SIGTERM, SIGINT or SIGHUP here (docker stop) is passed to T3 Code, which
#     then shuts down as before, and nothing is restarted.
set -uo pipefail

log() { printf '[t3code] %s\n' "$*" >&2; }

: "${T3_RUN_DIR:=/tmp/t3code}"
PID_FILE="${T3_RUN_DIR}/t3.pid"
REQUEST="${T3_RUN_DIR}/restart"

[ "$#" -gt 0 ] || { log "run-t3.sh: no command to run"; exit 2; }
mkdir -p "$T3_RUN_DIR"
chmod 0700 "$T3_RUN_DIR" 2>/dev/null || true
# A request left over from before this container started is not one for it.
rm -f "$REQUEST"

t3_pid=""
stopping=0
stop() {
  stopping=1
  [ -n "$t3_pid" ] && kill -TERM "$t3_pid" 2>/dev/null
  return 0
}
trap stop TERM INT HUP

while :; do
  "$@" &
  t3_pid=$!
  printf '%s\n' "$t3_pid" > "$PID_FILE"
  status=0
  # A trapped signal interrupts `wait` while T3 Code is still shutting down;
  # only its own exit ends this.
  while :; do
    wait "$t3_pid"
    status=$?
    kill -0 "$t3_pid" 2>/dev/null || break
  done
  if [ "$stopping" -eq 0 ] && [ -e "$REQUEST" ]; then
    rm -f "$REQUEST"
    log "restarting T3 Code, as asked on the setup page"
    continue
  fi
  rm -f "$PID_FILE"
  exit "$status"
done
