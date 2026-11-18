#!/usr/bin/env bash
# Waits for the faucet claim to OPERATOR, then runs the day-1 chain tests once and exits.
#   ops/wait-funds.sh start | stop | status | log      (start detaches; pid and log in $B/run)
# Every 5 minutes it reads the OPERATOR balance (public REST, no key). At >= 60 QOR it tops up the test roles
# (5 QOR each), runs ops/day1/day1.ts all, writes evidence to $B/evidence/day1/ and $B/briefs/requests/C-day1-done.md.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
B="$(cd "$REPO/.." && pwd)"
RUN="$B/run"; PID="$RUN/wait-funds.pid"; LOG="$RUN/wait-funds.log"
EVIDENCE="$B/evidence/day1"; DONE="$B/briefs/requests/C-day1-done.md"
OPERATOR="qor1gydsf0760dumk23gzph45w5y8gltuch8zfn9qf"
THRESHOLD_UQOR=60000000
mkdir -p "$RUN" "$EVIDENCE"

running() { [[ -f "$PID" ]] && kill -0 "$(cat "$PID")" 2>/dev/null; }
say() { echo "$(date -u +%FT%TZ) $*"; }

balance() {
  curl -sf -m 30 -A "sealed-scouts/0.1" \
    "https://api-testnet.qore.host/cosmos/bank/v1beta1/balances/$OPERATOR/by_denom?denom=uqor" |
    python3 -I -c 'import json,sys; print(json.load(sys.stdin)["balance"]["amount"])'
}

run_tests() {
  say "funded: running the day-1 tests"
  # shellcheck disable=SC1091
  source "$REPO/ops/env.local.sh"
  export PATH="$HOME/.foundry/bin:$PATH"
  cd "$REPO"
  (cd ops/day1/probe && forge build) || say "probe build failed"
  node --import tsx ops/fund.ts --topup 5 2>&1 | tee "$EVIDENCE/topup.log"
  node --import tsx ops/day1/day1.ts all --evidence "$EVIDENCE"
  local status=$?
  {
    node --import tsx ops/day1/report.ts "$EVIDENCE"
    echo; echo "## Top-up"; echo '```'; cat "$EVIDENCE/topup.log"; echo '```'
    echo; echo "day1.ts exit status: $status (0 = every step ok)"
  } >"$DONE"
  say "wrote $DONE (day1 exit $status)"
}

watch() {
  while true; do
    if bal=$(balance); then
      say "OPERATOR balance $bal uqor"
      if (( bal >= THRESHOLD_UQOR )); then run_tests; break; fi
    else
      say "balance read failed; trying again later"
    fi
    sleep 300
  done
  rm -f "$PID"
}

case "${1:-status}" in
  start)
    if running; then echo "already running (pid $(cat "$PID"))"; exit 0; fi
    setsid nohup "$0" __watch >>"$LOG" 2>&1 </dev/null &
    echo $! >"$PID"
    echo "started (pid $!), log $LOG"
    ;;
  __watch) watch ;;
  stop) if running; then kill -TERM "$(cat "$PID")"; rm -f "$PID"; echo stopped; else echo "not running"; fi ;;
  status) if running; then echo "running (pid $(cat "$PID"))"; else echo "not running"; fi ;;
  log) tail -n 40 "$LOG" ;;
  *) echo "usage: $0 start|stop|status|log" >&2; exit 1 ;;
esac
