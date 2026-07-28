#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

[[ $EUID -eq 0 ]] || { echo 'run as root' >&2; exit 1; }

ROOT=/opt/leuwongrr-gateway
SERVICE_USER=leuwongrr-gateway
UNIT_SRC=${1:-infra/systemd/leuwongrr-gateway.service}

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home "$ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -o root -g "$SERVICE_USER" -m 0750 \
  "$ROOT" "$ROOT/releases" "$ROOT/config" "$ROOT/repo"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 \
  "$ROOT/data" "$ROOT/data/attachments" "$ROOT/data/backups" "$ROOT/logs" "$ROOT/runtime"

if [[ ! -f $ROOT/config/gateway.env ]]; then
  install -o root -g root -m 0600 /dev/null "$ROOT/config/gateway.env"
  cat > "$ROOT/config/gateway.env" <<'EOF'
GATEWAY_HOST=127.0.0.1
GATEWAY_PORT=2080
OMNIROUTE_URL=http://127.0.0.1:20128
DATABASE_PATH=/opt/leuwongrr-gateway/data/gateway.db
API_KEY_PEPPER=replace-with-openssl-rand-hex-32
INTERNAL_READY_TOKEN=replace-with-openssl-rand-hex-32
LOG_LEVEL=info
UPSTREAM_CONCURRENCY=4
REQUEST_TIMEOUT_MS=120000
DAILY_BUDGET_UNITS=100000
EOF
  echo "created $ROOT/config/gateway.env (mode 600); replace placeholder secrets before deploy" >&2
fi

[[ $(stat -c %a "$ROOT/config/gateway.env") == 600 ]] || chmod 600 "$ROOT/config/gateway.env"
chown root:root "$ROOT/config/gateway.env"

if [[ -f $UNIT_SRC ]]; then
  install -o root -g root -m 0644 "$UNIT_SRC" /etc/systemd/system/leuwongrr-gateway.service
  systemctl daemon-reload
  systemctl enable leuwongrr-gateway.service
  echo 'installed systemd unit; service not started until first successful deploy' >&2
else
  echo "unit file not found at $UNIT_SRC; skip systemd install" >&2
fi

echo "bootstrap complete: $ROOT"
echo 'next: fill gateway.env secrets, build release, deploy, then seed tenant'
