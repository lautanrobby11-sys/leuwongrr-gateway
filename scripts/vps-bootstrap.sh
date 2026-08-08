#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

[[ $EUID -eq 0 ]] || { echo 'run as root' >&2; exit 1; }

ROOT=/opt/leuwongrr-gateway
SERVICE_USER=leuwongrr-gateway
UNIT_SRC=${1:-infra/systemd/leuwongrr-gateway.service}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

# Host prerequisites for backup, restore, and the external dead-man ping.
# The gateway itself embeds SQLite through better-sqlite3 and never shells out
# to these tools, so runtime health alone cannot prove operations are ready.
HOST_TOOLS=(sqlite3 age rsync curl)
MISSING_TOOLS=()
for tool in "${HOST_TOOLS[@]}"; do
  command -v "$tool" >/dev/null 2>&1 || MISSING_TOOLS+=("$tool")
done
if (( ${#MISSING_TOOLS[@]} > 0 )); then
  if command -v apt-get >/dev/null 2>&1; then
    echo "installing host tools: ${MISSING_TOOLS[*]}" >&2
    DEBIAN_FRONTEND=noninteractive apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${MISSING_TOOLS[@]}"
  else
    echo "missing required host tools: ${MISSING_TOOLS[*]}" >&2
    echo 'install them with the distribution package manager, then re-run' >&2
    exit 1
  fi
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home "$ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -o root -g "$SERVICE_USER" -m 0750 \
  "$ROOT" "$ROOT/releases" "$ROOT/config" "$ROOT/repo"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 \
  "$ROOT/data" "$ROOT/data/attachments" "$ROOT/data/backups" "$ROOT/logs" "$ROOT/runtime"

if [[ ! -f $ROOT/config/gateway.env ]]; then
  install -o root -g root -m 0600 /dev/null "$ROOT/config/gateway.env"
  # Mirrors .env.example. Every key the schema needs is present, so the only
  # remaining task is substituting real values: an incomplete seed used to leave
  # loadConfig() rejecting production on OTP_DELIVERY, or main.ts exiting on a
  # missing OMNIROUTE_API_KEY, long after the operator believed host prep was
  # done. Every field needing a real value is the literal REPLACE_ME, with no
  # exceptions, because the message printed below and the README both tell the
  # operator to substitute exactly that string: a field spelled any other way was
  # outside the list they are given and shipped as a live example value. For a
  # secret REPLACE_ME is also too short to satisfy its own validation rule, so an
  # unedited file refuses to boot and names the field.
  cat > "$ROOT/config/gateway.env" <<'EOF'
NODE_ENV=production
GATEWAY_HOST=127.0.0.1
GATEWAY_PORT=2080
OMNIROUTE_URL=http://127.0.0.1:20128
OMNIROUTE_API_KEY=REPLACE_ME
PUBLIC_BASE_URL=https://api.leuwongrr.cloud
DATABASE_PATH=/opt/leuwongrr-gateway/data/gateway.db
API_KEY_PEPPER=REPLACE_ME
INTERNAL_READY_TOKEN=REPLACE_ME
LOG_LEVEL=info
UPSTREAM_CONCURRENCY=4
TENANT_MAX_CONCURRENT=2
TENANT_LIMIT_MAX_ENTRIES=512
REQUEST_TIMEOUT_MS=120000
STREAM_IDLE_TIMEOUT_MS=60000
READY_UPSTREAM_TIMEOUT_MS=2000
DAILY_BUDGET_UNITS=100000
RATE_LIMIT_RPM=120
RATE_LIMIT_BURST=30
RATE_LIMIT_MAX_ENTRIES=2048
SQLITE_CACHE_KIB=4096
RETENTION_DAYS=90
MAINTENANCE_INTERVAL_MS=3600000
TRUST_PROXY=true
TRUSTED_CLIENT_IP_HEADER=cf-connecting-ip
AGE_RECIPIENT=REPLACE_ME
BACKUP_KEEP=14
METRICS_ENABLED=false
CONSOLE_ENABLED=true
WEB_DIST_PATH=./dist/public
SESSION_COOKIE_NAME=lwrr_session
SESSION_TTL_HOURS=12
OTP_TTL_MINUTES=10
OTP_MAX_ATTEMPTS=5
OTP_RESEND_SECONDS=60
OTP_DELIVERY=webhook
OTP_WEBHOOK_URL=REPLACE_ME
OTP_WEBHOOK_TOKEN=REPLACE_ME
ACCESS_TEAM_DOMAIN=REPLACE_ME
ACCESS_AUD=REPLACE_ME
CRYPTOMUS_API_URL=https://api.cryptomus.com
CRYPTOMUS_TIMEOUT_MS=15000
# Optional keys, commented so the seed boots without them. Listed here because an
# absent line is indistinguishable from an unsupported one: an operator who needs
# federated sign-in, payments, metrics or a second console origin should not have
# to read src/config.ts to learn the spelling. Each group is all-or-nothing;
# loadConfig() rejects a half-configured pair at startup.
# CONSOLE_ALLOWED_ORIGINS=https://console.leuwongrr.cloud
# Required when METRICS_ENABLED=true, and must differ from INTERNAL_READY_TOKEN.
# The explanation stays on its own line: systemd EnvironmentFile does not treat
# a trailing `#` as a comment, so uncommenting a KEY=VALUE line that carried one
# would make the whole remainder part of the token and the comparison in
# src/http/app.ts would never match.
# INTERNAL_METRICS_TOKEN=REPLACE_ME
# SNAPSHOT_HEALTHCHECK_URL=https://external-deadman.example/ping-id
# GOOGLE_CLIENT_ID=REPLACE_ME
# GOOGLE_CLIENT_SECRET=REPLACE_ME
# DISCORD_CLIENT_ID=REPLACE_ME
# DISCORD_CLIENT_SECRET=REPLACE_ME
# TELEGRAM_BOT_TOKEN=REPLACE_ME
# TELEGRAM_BOT_USERNAME=REPLACE_ME
# CRYPTOMUS_MERCHANT_ID=REPLACE_ME
# CRYPTOMUS_PAYMENT_API_KEY=REPLACE_ME
EOF
  echo "$ROOT/config/gateway.env created with mode 600; every REPLACE_ME must be substituted before deploy" >&2
fi

[[ $(stat -c %a "$ROOT/config/gateway.env") == 600 ]] || chmod 600 "$ROOT/config/gateway.env"
chown root:root "$ROOT/config/gateway.env"

# A16: seed the signature trust anchor once. The public signers list is not a
# secret; the private key never leaves the operator workstation (ADR-013).
# Never overwrite an existing file: a key rotated by the operator on the host is
# authoritative over the copy inside whatever artifact bootstrapped this host.
if [[ -f $ROOT/config/release-signers ]]; then
  echo "$ROOT/config/release-signers already present; not overwriting" >&2
elif [[ -f $SCRIPT_DIR/../keys/release-signers ]]; then
  install -o root -g root -m 0644 "$SCRIPT_DIR/../keys/release-signers" "$ROOT/config/release-signers"
  echo "seeded $ROOT/config/release-signers from keys/release-signers" >&2
else
  echo "keys/release-signers not found next to $SCRIPT_DIR; operator must install $ROOT/config/release-signers manually" >&2
fi

if [[ -f $UNIT_SRC ]]; then
  install -o root -g root -m 0644 "$UNIT_SRC" /etc/systemd/system/leuwongrr-gateway.service
  systemctl daemon-reload
  systemctl enable leuwongrr-gateway.service
  echo 'installed systemd unit; service not started until first successful deploy' >&2
else
  echo "$UNIT_SRC not found; skip systemd install" >&2
fi

echo "bootstrap complete: $ROOT"
echo 'next: substitute every REPLACE_ME in gateway.env, build the release artifact,'
echo '      run deploy.sh, then provision with dist/cli/keys.js:'
echo '      key:issue for API access, account:role to grant the first admin,'
echo '      plan:upsert to seed the first plan.'
