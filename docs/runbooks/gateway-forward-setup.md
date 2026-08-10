# Gateway Forward Setup (VPS#1 → VPS#2)

## Purpose

Forward `api.leuwongrr.cloud` traffic from VPS#1 (where Cloudflare Tunnel runs) to VPS#2 (where Gateway runs at `127.0.0.1:2080`).

This is a **temporary infrastructure overlay** until the Cloudflare Tunnel itself is migrated to VPS#2.

## Architecture

```
Cloudflare → VPS#1 (cloudflared) → 127.0.0.1:2080 → autossh → VPS#2:2080 (Gateway)
```

## Prerequisites

- VPS#1: `ubuntu@18.136.26.152` (SSH access)
- VPS#2: `admin@47.130.108.143` (SSH access)
- VPS#1 user `omniroute-tunnel` can SSH to VPS#2 (already exists for OmniRoute tunnel)
- `autossh` installed on VPS#1 (`apt install autossh`)

## Steps (VPS#1)

### 1. Install autossh

```bash
sudo apt-get update && sudo apt-get install -y autossh
```

### 2. Copy the systemd unit

```bash
sudo cp /path/to/leuwongrr-gateway-forward.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Or copy manually from `infra/gateway-forward/leuwongrr-gateway-forward.service`.

### 3. Verify SSH connectivity

```bash
sudo -u omniroute-tunnel ssh -o ConnectTimeout=5 omniroute-tunnel@47.130.108.143 echo OK
```

Must return `OK`. If not, check SSH key for `omniroute-tunnel` user.

### 4. Test forwarding manually

```bash
sudo -u omniroute-tunnel autossh -M 0 -N \
  -o "ServerAliveInterval 30" \
  -o "ExitOnForwardFailure yes" \
  -L 127.0.0.1:2080:127.0.0.1:2080 \
  omniroute-tunnel@47.130.108.143 &

# Test
curl -sS http://127.0.0.1:2080/health/live
# Expected: 200

# Kill test process
kill %1
```

### 5. Enable and start the service

```bash
sudo systemctl enable leuwongrr-gateway-forward.service
sudo systemctl start leuwongrr-gateway-forward.service
sudo systemctl status leuwongrr-gateway-forward.service
```

### 6. Verify

```bash
# Loopback test
curl -sS http://127.0.0.1:2080/health/live
# Expected: 200

# Public test
curl -sS https://api.leuwongrr.cloud/health/live
# Expected: 200
```

## Security Notes

- Gateway on VPS#2 stays at `127.0.0.1:2080` (loopback only) — never exposed to internet.
- SSH tunnel uses existing `omniroute-tunnel` user and key — no new credentials.
- `NoNewPrivileges=true` and `PrivateTmp=true` set on the service.
- Port 2080 is NOT exposed in VPS firewall/security groups.

## Rollback

```bash
sudo systemctl stop leuwongrr-gateway-forward.service
sudo systemctl disable leuwongrr-gateway-forward.service
```

Traffic returns to 502 (same state as before setup).

## Future: Move Cloudflare Tunnel to VPS#2

When ready to make Gateway fully independent:
1. Install `cloudflared` on VPS#2
2. Create tunnel with same config (`api.leuwongrr.cloud` → `http://127.0.0.1:2080`)
3. Update Cloudflare DNS to point to new tunnel
4. Disable and remove this forward service
5. Remove autossh dependency on VPS#1
