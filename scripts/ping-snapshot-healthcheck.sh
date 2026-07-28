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

# The URL is a bearer capability and must never be printed. Use an explicit
# retry loop instead of version-specific curl retry flags so the same bounded
# behavior works across supported VPS images. Three attempts take at most 48s.
attempt=1
while true; do
  if curl --fail --silent --show-error \
    --proto '=https' \
    --tlsv1.2 \
    --max-redirs 0 \
    --connect-timeout 5 \
    --max-time 15 \
    "$URL" >/dev/null; then
    break
  fi

  if (( attempt >= 3 )); then
    echo 'snapshot healthcheck notification failed after 3 attempts' >&2
    exit 1
  fi
  sleep "$attempt"
  ((attempt += 1))
done

echo 'snapshot healthcheck notified'
