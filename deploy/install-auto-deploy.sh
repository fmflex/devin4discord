#!/bin/sh
# Installs the systemd timer that runs deploy/auto-deploy.sh every minute.
# Run once from the checkout on the host: sudo sh deploy/install-auto-deploy.sh
set -eu

[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
dir="$(cd "$(dirname "$0")/.." && pwd)"
user="$(stat -c %U "$dir")"
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

cat > /etc/systemd/system/devin4discord-deploy.service <<UNIT
[Unit]
Description=Deploy devin4discord from origin/main
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
User=$user
SupplementaryGroups=docker
WorkingDirectory=$dir
EnvironmentFile=-/etc/devin4discord-deploy.env
ExecStart=/bin/sh $dir/deploy/auto-deploy.sh
UNIT

cat > /etc/systemd/system/devin4discord-deploy.timer <<UNIT
[Unit]
Description=Check for a new devin4discord release every minute

[Timer]
OnActiveSec=10s
OnBootSec=2min
OnUnitInactiveSec=1min

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now devin4discord-deploy.timer
echo "Installed. Follow it with: journalctl -u devin4discord-deploy -f"
