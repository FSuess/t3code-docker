#!/usr/bin/env bash
# The supervisor between the entrypoint and T3 Code (docker/run-t3.sh).
#
#   bash tests/run-t3.test.sh
#
# A stand-in for T3 Code records each start and waits to be stopped. The
# supervisor has to start it again only when the setup page asked, pass a
# `docker stop` on, and end with T3 Code's own status otherwise.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_T3="$ROOT/docker/run-t3.sh"

pass=0
fail=0
ok() { printf '  PASS %s\n' "$1"; pass=$((pass + 1)); }
no() { printf '  FAIL %s\n' "$1"; fail=$((fail + 1)); }
is() {
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1 (expected [$2], got [$3])"; fi
}

WORK="$(mktemp -d)"
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$WORK"' EXIT
export T3_RUN_DIR="$WORK/run"

# The stand-in: logs "start <pid>" and "stop <pid>" to $WORK/log, and exits
# with $WORK/exit-code when that file appears (a crash), or 143 on SIGTERM.
FAKE="$WORK/fake-t3"
cat > "$FAKE" <<'EOF'
#!/usr/bin/env bash
log="$1"; work="$2"
echo "start $$" >> "$log"
trap 'echo "stop $$" >> "$log"; exit 143' TERM
while :; do
  if [ -f "$work/exit-code" ]; then code="$(cat "$work/exit-code")"; rm -f "$work/exit-code"; exit "$code"; fi
  sleep 0.1
done
EOF
chmod +x "$FAKE"

starts() { grep -c '^start' "$WORK/log" 2>/dev/null || echo 0; }
wait_for() { # seconds, condition
  local _
  for _ in $(seq 1 $(($1 * 10))); do eval "$2" && return 0; sleep 0.1; done
  return 1
}
current_pid() { cat "$T3_RUN_DIR/t3.pid" 2>/dev/null; }

: > "$WORK/log"
bash "$RUN_T3" "$FAKE" "$WORK/log" "$WORK" &
sup=$!
wait_for 5 '[ "$(starts)" = 1 ]' && ok "starts T3 Code and records its pid" || no "starts T3 Code and records its pid"
first="$(current_pid)"
is "the pid file names the running process" "$(sed -n 's/^start //p' "$WORK/log" | tail -1)" "$first"

# A restart asked for: the request, then SIGTERM to T3 Code.
touch "$T3_RUN_DIR/restart"
kill -TERM "$first"
wait_for 5 '[ "$(starts)" = 2 ]' && ok "a requested restart starts it again" || no "a requested restart starts it again"
second="$(current_pid)"
[ -n "$second" ] && [ "$second" != "$first" ] && ok "with a new pid recorded" || no "with a new pid recorded"
[ ! -e "$T3_RUN_DIR/restart" ] && ok "and the request is used up" || no "and the request is used up"
kill -0 "$sup" 2>/dev/null && ok "the supervisor kept running" || no "the supervisor kept running"

# docker stop: SIGTERM to the supervisor reaches T3 Code, and nothing restarts,
# even with a request lying around.
touch "$T3_RUN_DIR/restart"
kill -TERM "$sup"
status=0
wait "$sup" || status=$?
is "docker stop ends with T3 Code's own status" 143 "$status"
is "and T3 Code was stopped, not restarted" 2 "$(starts)"
grep -q "^stop $second" "$WORK/log" && ok "the stop reached T3 Code" || no "the stop reached T3 Code"
[ ! -e "$T3_RUN_DIR/t3.pid" ] && ok "the pid file is cleared" || no "the pid file is cleared"

# A crash: T3 Code exits on its own, with no request. The supervisor ends with
# that status, so the container's restart policy sees it.
: > "$WORK/log"
bash "$RUN_T3" "$FAKE" "$WORK/log" "$WORK" &
sup=$!
wait_for 5 '[ "$(starts)" = 1 ]' || true
echo 3 > "$WORK/exit-code"
status=0
wait "$sup" || status=$?
is "a crash ends the supervisor with T3 Code's status" 3 "$status"
is "and is not restarted" 1 "$(starts)"

# A request left from before a start is not one for it.
mkdir -p "$T3_RUN_DIR" && touch "$T3_RUN_DIR/restart"
: > "$WORK/log"
bash "$RUN_T3" "$FAKE" "$WORK/log" "$WORK" &
sup=$!
wait_for 5 '[ "$(starts)" = 1 ]' || true
echo 0 > "$WORK/exit-code"
status=0
wait "$sup" || status=$?
is "a stale request does not turn an exit into a restart" "1 0" "$(starts) $status"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
