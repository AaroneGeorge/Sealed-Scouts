#!/usr/bin/env bash
# Deploy the demo page + read API to the server's hosting (Dokku app, default name "sealed-scouts") from this
# working tree. Sends a clean tarball, with apps/api/Dockerfile at its root, to `dokku git:from-archive`.
#   deploy-host.sh [APP]        build and roll out on the server
#   deploy-host.sh --dry-run    pack and build the image locally with docker, deploy nothing
# The image holds no secrets: the script refuses if a .env file or anything that looks like a key is in the tarball.
# Steps around it (create the app, storage, make it public): docs/RUNBOOK.md, "Host the demo".
# DOKKU_CMD picks how Dokku is reached (default "sudo -n dokku" on the host itself; "ssh dokku@host" works too).
set -euo pipefail
cd "$(dirname "$0")/../../.."
DRY=0
if [ "${1:-}" = "--dry-run" ]; then DRY=1; shift; fi
APP=${1:-sealed-scouts}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
tar -cf "$tmp/src.tar" --exclude=./.git --exclude=node_modules --exclude='./.env' --exclude='./.env.*' \
  --exclude=./feed --exclude=./run --exclude=dist --exclude=./contracts/out --exclude=./contracts/cache \
  --exclude='*.log' --exclude=./ops/env.local.sh .
mkdir "$tmp/x" && tar -xf "$tmp/src.tar" -C "$tmp/x"
cp apps/api/Dockerfile "$tmp/x/Dockerfile"
if find "$tmp/x" -name '.env' -o -name '.env.local' -o -name 'env.local.sh' | grep -q .; then
  echo "refusing: an env file is in the tarball" >&2; exit 1
fi
if grep -rIlE --exclude-dir=node_modules '(MNEMONIC|PRIVATE_KEY)[A-Z_]*=[[:space:]]*[^[:space:]$]{16,}' "$tmp/x" | grep -v '\.env\.example$' | grep -q .; then
  echo "refusing: something that looks like a key is in the tarball" >&2; exit 1
fi
if [ "$DRY" = 1 ]; then
  docker build -q -t "$APP:dry-run" "$tmp/x"
  echo "dry run: image $APP:dry-run built, nothing deployed"
  exit 0
fi
tar -cf "$tmp/app.tar" -C "$tmp/x" .
${DOKKU_CMD:-sudo -n dokku} git:from-archive --archive-type tar "$APP" -- "Sealed Scouts deploy" "deploy@sealed-scouts.local" < "$tmp/app.tar"
echo "deployed $APP; check its /health"
