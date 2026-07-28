#!/usr/bin/env bash
set -Eeuo pipefail

URL=${SNAPSHOT_HEALTHCHECK_URL:-}
if [[ -z $URL ]]; then
  echo 'snapshot monitoring disabled: SNAPSHOT_HEALTHCHECK_URL is unset' >&2
  exit 0
fi

[[ $URL == https://* ]] || {
  echo 'SNAPSHOT_HEALTHCHECK_URL must use https' >&2
  exit 1
}
command -v curl >/dev/null 2>&1 || {
  echo 'missing required command: curl' >&2
  exit 1
}

# The URL is a bearer capability and must never be printed. A dead-man service
# alerts externally when this success ping does not arrive within its period.
curl --fail --silent --show-error \
  --proto '=https' \
  --tlsv1.2 \
  --max-redirs 0 \
  --connect-timeout 5 \
  --max-time 15 \
  --retry 2 \
  --retry-all-errors \
  "$URL" >/dev/null

echo 'snapshot healthcheck notified'
