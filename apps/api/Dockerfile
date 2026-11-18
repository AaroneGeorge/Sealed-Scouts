# Sealed Scouts demo: the read API, the built page and a watchtower in observe mode, on one port. No keys in this
# image, ever: everything here only reads public chain data. The deploy script copies this file to the build root
# (docs/RUNBOOK.md, "Host the demo").
FROM node:22-slim

WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund \
 && npm run build -w @sealed-scouts/web \
 && npm cache clean --force

# The watchtower replays the rollup with no key and writes the feed the page reads. Evidence and deployments ship
# with the repo. The hosting sidecar overwrites X-Forwarded-For, so the per-IP limit may trust its first hop.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5000 TRUST_PROXY=1 RUN_WATCHTOWER=1 \
    FEED_DIR=/tmp/feed EVIDENCE_DIR=/app/packages/attacks/evidence DEPLOYMENTS_FILE=/app/deployments/diana.json \
    WEB_DIST=/app/apps/web/dist
USER node
EXPOSE 5000
CMD ["sh", "apps/api/scripts/host-start.sh"]
