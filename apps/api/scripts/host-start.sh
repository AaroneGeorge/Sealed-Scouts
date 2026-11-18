#!/bin/sh
# Container entry: an observe-mode watchtower (no key) keeps the feed fresh, and the read API serves it with the page.
# The watchtower restarts after a crash; the API is the main process, so the container stops if the API stops.
set -eu
cd "$(dirname "$0")/../../.."
mkdir -p "$FEED_DIR"
if [ "${RUN_WATCHTOWER:-0}" = "1" ] && [ -f "$DEPLOYMENTS_FILE" ]; then
  (
    cd packages/watchtower
    while true; do
      SS_DEPLOYMENT="$DEPLOYMENTS_FILE" node --import tsx src/cli.ts --observe --feed-dir "$FEED_DIR" || true
      echo "watchtower stopped; restarting in 10 s" >&2
      sleep 10
    done
  ) &
fi
exec node --import tsx apps/api/src/server.ts
