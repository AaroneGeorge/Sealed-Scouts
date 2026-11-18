#!/usr/bin/env bash
# Start, stop or check the operator loop as a detached process that outlives the shell.
#   ops/operator.sh start | stop | status | log
# Logs: $B/run/operator.log, pid: $B/run/operator.pid (B = the folder above the repo).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RUN="${SS_RUN_ROOT:-$REPO/../run}"
PID="$RUN/operator.pid"
LOG="$RUN/operator.log"
mkdir -p "$RUN"

running() { [[ -f "$PID" ]] && kill -0 "$(cat "$PID")" 2>/dev/null; }

case "${1:-status}" in
  start)
    if running; then echo "already running (pid $(cat "$PID"))"; exit 0; fi
    # shellcheck disable=SC1091
    source "$REPO/ops/env.local.sh"
    cd "$REPO/packages/operator"
    setsid nohup node --import tsx src/loop.ts >>"$LOG" 2>&1 </dev/null &
    echo $! >"$PID"
    echo "started (pid $!), log $LOG"
    ;;
  stop)
    if running; then kill -TERM "$(cat "$PID")" && echo "stopping pid $(cat "$PID")"; else echo "not running"; fi
    ;;
  status)
    if running; then echo "running (pid $(cat "$PID"))"; else echo "not running"; fi
    ;;
  log) tail -n 50 "$LOG" ;;
  *) echo "usage: $0 start|stop|status|log" >&2; exit 1 ;;
esac
