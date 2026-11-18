#!/bin/sh
# Container entry: an observe-mode watchtower (no key) keeps the feed fresh, and the read API serves it with the page.
# Before the rollup is launched (no deployments file) the API serves the bundled sample feed instead; the page marks
# it as sample data. The watchtower restarts after a crash; the API is the main process.
set -eu
cd "$(dirname "$0")/../../.."
# Launched = the deployments file names a rollup (a file holding only, say, demoUrl does not count).
launched() { [ -f "$DEPLOYMENTS_FILE" ] && grep -q '"rollupId"' "$DEPLOYMENTS_FILE"; }
if [ "${RUN_WATCHTOWER:-0}" = "1" ] && launched; then
  mkdir -p "$FEED_DIR"
  # Replay with the operator's round timing: demo rounds when the deployment says "roundMode": "demo".
  DEMO_FLAG=""
  if node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).roundMode === "demo" ? 0 : 1)' "$DEPLOYMENTS_FILE"; then
    DEMO_FLAG="--demo"
  fi
  (
    cd packages/watchtower
    while true; do
      SS_DEPLOYMENT="$DEPLOYMENTS_FILE" node --import tsx src/cli.ts --observe $DEMO_FLAG --feed-dir "$FEED_DIR" || true
      echo "watchtower stopped; restarting in 10 s" >&2
      sleep 10
    done
  ) &
elif ! launched; then
  export FEED_DIR=/app/apps/api/fixtures/feed EVIDENCE_DIR=/app/apps/api/fixtures/evidence
  echo "no deployments file yet: serving the sample feed" >&2
fi
exec node --import tsx apps/api/src/server.ts
