#!/usr/bin/env bash
# Start, stop or check the whole live loop: operator, scouts SCOUT1-3 and one active watchtower, each detached in
# its own process group so it outlives the shell and stops cleanly.
#   ops/loop.sh start | stop | status
# Round timing follows "roundMode" in deployments/diana.json unless SS_LOOP_ARGS says otherwise (default --demo).
# Logs and pids: $B/run/<name>.log and .pid (B = the folder above the repo).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RUN="${SS_RUN_ROOT:-$REPO/../run}"
ARGS="${SS_LOOP_ARGS:---demo}"
SCOUTS="${SS_SCOUTS:-SCOUT1 SCOUT2 SCOUT3}"
mkdir -p "$RUN"

alive() { [[ -f "$RUN/$1.pid" ]] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }

start_one() { # name, command...
  local name=$1; shift
  if alive "$name"; then echo "$name: already running (pid $(cat "$RUN/$name.pid"))"; return; fi
  rm -f "$RUN/$name.pid"
  # setsid may fork (it does when the caller's shell has job control), so $! is not reliable: the new session
  # leader writes its own pid, which is also the process group that stop_one signals.
  cd "$REPO"
  setsid nohup bash -c 'echo $$ >"$0"; exec "$@"' "$RUN/$name.pid" "$@" >>"$RUN/$name.log" 2>&1 </dev/null &
  for _ in 1 2 3 4 5 6 7 8 9 10; do [[ -s "$RUN/$name.pid" ]] && break; sleep 0.2; done
  echo "$name: started (pid $(cat "$RUN/$name.pid"))"
}

stop_one() {
  local name=$1
  if alive "$name"; then kill -TERM -- "-$(cat "$RUN/$name.pid")" 2>/dev/null || kill -TERM "$(cat "$RUN/$name.pid")"; echo "$name: stopped"
  else echo "$name: not running"; fi
}

case "${1:-status}" in
  start)
    # One watchtower only: two would race on the same feed folder.
    if pgrep -f "src/cli.ts --(active|observe)" >/dev/null && ! alive watchtower; then
      echo "a watchtower not started by this script is running; stop it first:" >&2; pgrep -af "src/cli.ts --(active|observe)" >&2; exit 1
    fi
    # shellcheck disable=SC1091
    source "$REPO/ops/env.local.sh"
    "$REPO/ops/operator.sh" start $ARGS
    for s in $SCOUTS; do start_one "scout-$s" npm run scout -- --role "$s" $ARGS; done
    start_one watchtower npm run watchtower -- --active $ARGS
    ;;
  stop)
    for s in $SCOUTS; do stop_one "scout-$s"; done
    stop_one watchtower
    "$REPO/ops/operator.sh" stop
    ;;
  status)
    "$REPO/ops/operator.sh" status
    for n in $(for s in $SCOUTS; do echo "scout-$s"; done) watchtower; do
      if alive "$n"; then echo "$n: running (pid $(cat "$RUN/$n.pid"))"; else echo "$n: not running"; fi
    done
    ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 1 ;;
esac
