#!/usr/bin/env bash
# Install the live loop as systemd services, so it starts at boot and comes back after a crash:
#   sealed-scouts.target                 operator + scouts + one active watchtower (start/stop them together)
#   sealed-scouts-operator.service       packages/operator loop
#   sealed-scouts-scout@SCOUTn.service   one per scout in SS_SCOUTS (default SCOUT1 SCOUT2 SCOUT3)
#   sealed-scouts-watchtower.service     the active watchtower: the only writer of repo/feed
#   sealed-scouts-topup.timer            optional: every 6 h runs `TOPUP_SCRIPT --once` (--topup SCRIPT)
# Usage: ops/install-systemd.sh [--topup SCRIPT]      (uses sudo; the services run as the calling user)
# Keys come from ops/env.local.sh at each start, as with ops/loop.sh. Logs: $B/run/<name>.log as before.
# Round timing follows SS_LOOP_ARGS (default --demo). Afterwards ops/loop.sh start|stop|status drives the target.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$(cd "${SS_RUN_ROOT:-$REPO/../run}" && pwd)"
ARGS="${SS_LOOP_ARGS:---demo}"
SCOUTS="${SS_SCOUTS:-SCOUT1 SCOUT2 SCOUT3}"
USER_NAME="$(id -un)"
TOPUP=""
if [ "${1:-}" = "--topup" ]; then TOPUP="$(realpath "$2")"; fi
[ -f "$REPO/ops/env.local.sh" ] || { echo "ops/env.local.sh is missing: the services could not load their keys" >&2; exit 1; }

unit() { # name, content
  echo "$2" | sudo tee "/etc/systemd/system/$1" >/dev/null
  echo "wrote /etc/systemd/system/$1"
}

# Common [Unit]/[Service] lines. StartLimitIntervalSec=0: keep retrying (a chain endpoint may be down for a while).
common() { # description, log name
  cat <<EOF
[Unit]
Description=$1
After=network-online.target
Wants=network-online.target
PartOf=sealed-scouts.target
StartLimitIntervalSec=0

[Service]
User=$USER_NAME
Restart=on-failure
RestartSec=15
KillMode=control-group
TimeoutStopSec=30
StandardOutput=append:$RUN/$2.log
StandardError=append:$RUN/$2.log
EOF
}

unit sealed-scouts.target "[Unit]
Description=Sealed Scouts live loop (operator, scouts, active watchtower)
After=network-online.target
Wants=network-online.target

[Install]
WantedBy=multi-user.target"

unit sealed-scouts-operator.service "$(common "Sealed Scouts operator" operator)
WorkingDirectory=$REPO/packages/operator
ExecStart=/bin/bash -c 'source ../../ops/env.local.sh && exec node --import tsx src/loop.ts $ARGS'

[Install]
WantedBy=sealed-scouts.target"

unit sealed-scouts-scout@.service "$(common "Sealed Scouts scout %i" scout-%i)
WorkingDirectory=$REPO
ExecStart=/bin/bash -c 'source ops/env.local.sh && exec npm run scout -- --role %i $ARGS'

[Install]
WantedBy=sealed-scouts.target"

unit sealed-scouts-watchtower.service "$(common "Sealed Scouts active watchtower" watchtower)
WorkingDirectory=$REPO
ExecStart=/bin/bash -c 'source ops/env.local.sh && exec npm run watchtower -- --active $ARGS'

[Install]
WantedBy=sealed-scouts.target"

if [ -n "$TOPUP" ]; then
  unit sealed-scouts-topup.service "[Unit]
Description=Sealed Scouts scout and relayer top-up
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$USER_NAME
WorkingDirectory=$REPO
ExecStart=$TOPUP --once
StandardOutput=append:$RUN/auto-topup.log
StandardError=append:$RUN/auto-topup.log"

  unit sealed-scouts-topup.timer "[Unit]
Description=Sealed Scouts top-up every 6 h

[Timer]
OnBootSec=10min
OnUnitActiveSec=6h
Persistent=true

[Install]
WantedBy=timers.target"
fi

sudo systemctl daemon-reload
sudo systemctl enable sealed-scouts.target sealed-scouts-operator.service sealed-scouts-watchtower.service
for s in $SCOUTS; do sudo systemctl enable "sealed-scouts-scout@$s.service"; done
if [ -n "$TOPUP" ]; then sudo systemctl enable sealed-scouts-topup.timer; fi
echo "installed and enabled at boot; start with: ops/loop.sh start"
