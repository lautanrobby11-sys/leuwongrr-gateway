# Gateway Forward Setup (VPS#1 → VPS#2)

## Purpose

Forward `api.leuwongrr.cloud` traffic from VPS#1 (where Cloudflare Tunnel runs) to VPS#2 (where Gateway runs at `127.0.0.1:2080`).

This is a **temporary infrastructure overlay** until the Cloudflare Tunnel itself is migrated to VPS#2.

## Architecture

```
Cloudflare → VPS#1 (cloudflared) → 127.0.0.1:2080 → autossh (SSH -L) → VPS#2:2080 (Gateway)
```

## Prerequisites

- VPS#1: `ubuntu@18.136.26.152` (SSH access, operator key)
- VPS#2: `admin@47.130.108.143` (SSH access, operator key)
- `autossh` installed on VPS#1 (`apt install autossh`)
- The `omniroute-tunnel` SSH keypair (`id_ed25519`) on VPS#2 at `/opt/omniroute-tunnel/.ssh/` — reused for the forward. This keypair already powers the pre-existing OmniRoute tunnel (`VPS#2 → VPS#1`, `127.0.0.1:20128`).

> **Direction note (verified 2026-08-10):** the pre-existing OmniRoute tunnel is **inbound to VPS#1** (`VPS#2 → VPS#1`). There is **no** pre-existing outbound SSH path `VPS#1 → VPS#2` — the forward keypair must be provisioned once (step 2). Evidence: `ubuntu` on VPS#1 has no key authorized on VPS#2 (`Permission denied (publickey)`), user `ubuntu` does not exist on VPS#2 (`/etc/passwd` lists only `admin`), and `admin` on VPS#2 has no private key. Reusing the existing keypair avoids creating new credentials.

## Steps (VPS#1)

### 1. Install autossh

```bash
sudo apt-get update && sudo apt-get install -y autossh
```

### 2. Provision the forward keypair (one-time)

The forward reuses the existing `omniroute-tunnel` keypair. Copy it from VPS#2 to VPS#1 and authorize it on VPS#2 with restrictions. VPS#2 cannot initiate SSH to VPS#1 (no outbound key), so relay the keypair through the operator workstation. **Never print the private key.**

On VPS#2 (admin), stage the keypair for transfer:

```bash
sudo cp /opt/omniroute-tunnel/.ssh/id_ed25519 /tmp/otk
sudo cp /opt/omniroute-tunnel/.ssh/id_ed25519.pub /tmp/otk.pub
sudo chmod 644 /tmp/otk /tmp/otk.pub
# relay: scp /tmp/otk /tmp/otk.pub → workstation → VPS#1:/tmp/
sudo rm -f /tmp/otk /tmp/otk.pub   # cleanup immediately after relay
```

Verify integrity with `sha256sum` on every hop; both sides must match.

On VPS#1 (ubuntu), install the key for the service user:

```bash
sudo mkdir -p /opt/leuwongrr-tunnel/.ssh
sudo cp /tmp/otk /opt/leuwongrr-tunnel/.ssh/id_ed25519
sudo cp /tmp/otk.pub /opt/leuwongrr-tunnel/.ssh/id_ed25519.pub
sudo chown -R omniroute-tunnel:omniroute-tunnel /opt/leuwongrr-tunnel
sudo chmod 700 /opt/leuwongrr-tunnel /opt/leuwongrr-tunnel/.ssh
sudo chmod 600 /opt/leuwongrr-tunnel/.ssh/id_ed25519
sudo chmod 644 /opt/leuwongrr-tunnel/.ssh/id_ed25519.pub
sudo rm -f /tmp/otk /tmp/otk.pub
```

On VPS#2 (admin), authorize the same public key for inbound from VPS#1, restricted to the forward port (mirror the existing OmniRoute entry style on VPS#1):

```bash
sudo mkdir -p /opt/omniroute-tunnel/.ssh
echo 'from="18.136.26.152",restrict,port-forwarding,permitopen="127.0.0.1:2080" ssh-ed25519 <PUBKEY> omniroute-tunnel@vps2-leuwongrr' | sudo tee /opt/omniroute-tunnel/.ssh/authorized_keys
sudo chown omniroute-tunnel:omniroute-tunnel /opt/omniroute-tunnel/.ssh/authorized_keys
sudo chmod 600 /opt/omniroute-tunnel/.ssh/authorized_keys
```

`<PUBKEY>` is the content of the `id_ed25519.pub` staged from VPS#2.

### 3. Copy the systemd unit

The unit runs as `omniroute-tunnel` and points at the provisioned key with `-i /opt/leuwongrr-tunnel/.ssh/id_ed25519`.

```bash
sudo cp /path/to/leuwongrr-gateway-forward.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Or copy manually from `infra/gateway-forward/leuwongrr-gateway-forward.service`.

### 4. Verify SSH connectivity

The `omniroute-tunnel` account has a `nologin` shell: remote-command probes (e.g. `echo OK`) are rejected with `This account is currently not available.` — **expected**, and does not affect `-N` port-forwarding sessions. The goal is pubkey **authentication success** (absence of `Permission denied`):

```bash
sudo -u omniroute-tunnel ssh -i /opt/leuwongrr-tunnel/.ssh/id_ed25519 \
  -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
  omniroute-tunnel@47.130.108.143 echo OK
```

### 5. Test forwarding manually

```bash
sudo -u omniroute-tunnel /usr/bin/ssh -i /opt/leuwongrr-tunnel/.ssh/id_ed25519 -N \
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

### 6. Enable and start the service

```bash
sudo systemctl enable --now leuwongrr-gateway-forward.service
sudo systemctl status leuwongrr-gateway-forward.service
```

### 7. Verify

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
- The forward reuses the existing `omniroute-tunnel` keypair. The private key now exists on **both** VPS#2 (original, `/opt/omniroute-tunnel/.ssh/`) and VPS#1 (forward copy, `/opt/leuwongrr-tunnel/.ssh/`). Both directions are locked down with `from=`, `restrict`, `port-forwarding` and `permitopen`:
  - VPS#1 `authorized_keys` (pre-existing OmniRoute entry): `from="47.130.108.143",restrict,port-forwarding,permitopen="127.0.0.1:20128"`
  - VPS#2 `authorized_keys` (forward, step 2): `from="18.136.26.152",restrict,port-forwarding,permitopen="127.0.0.1:2080"`
- `NoNewPrivileges=true` and `PrivateTmp=true` set on the service.
- Port 2080 is NOT exposed in VPS firewall/security groups.
- Remove the VPS#1 key copy when the overlay is decommissioned (see below).

## Rollback

```bash
sudo systemctl disable --now leuwongrr-gateway-forward.service
```

On VPS#2, remove the authorized_keys entry:

```bash
sudo rm -f /opt/omniroute-tunnel/.ssh/authorized_keys
```

On VPS#1, remove the provisioned key:

```bash
sudo rm -rf /opt/leuwongrr-tunnel
```

Traffic returns to 502 (same state as before setup).

## Future: Move Cloudflare Tunnel to VPS#2

When ready to make Gateway fully independent:
1. Install `cloudflared` on VPS#2
2. Create tunnel with same config (`api.leuwongrr.cloud` → `http://127.0.0.1:2080`)
3. Update Cloudflare DNS to point to new tunnel
4. Disable and remove this forward service
5. Remove autossh dependency on VPS#1
6. Delete the VPS#1 copy of the tunnel keypair (`/opt/leuwongrr-tunnel/`)
