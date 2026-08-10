# Cloudflare boundary

Canonical record of the edge configuration. Dashboard/API changes are operator-owned and must be recorded in the deployment audit. `README.md` points here rather than restating the list.

1. Tunnel published application: `api.leuwongrr.cloud` -> `http://127.0.0.1:2080`.
2. Access self-hosted application path: `api.leuwongrr.cloud/admin*` **only**. Never protect the whole hostname. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `gateway.env` come from this application.
3. Bypass cache for every HTML page and every API surface: `/`, `/login`, `/member`, `/admin*`, `/chat*`, `/console/api*`, `/callbacks/*`, `/webhooks/*`, `/v1*`, `/v1beta*`.
   `/console/assets/*` is deliberately **not** on that list: those responses are `public, max-age=31536000, immutable` on content-hashed filenames, so edge caching them is correct.
4. Do not publish ports 2080 or 20128 in the VPS firewall/security group.
5. Verify negative cases: missing/forged/expired Access JWT; valid Access user without application role; `/v1` without interactive Access redirect.

## Gateway forward (P0 fix — Aug 2026)

After the VPS split, the Cloudflare Tunnel (`cloudflared`) still runs on VPS#1
and points `api.leuwongrr.cloud` to `http://127.0.0.1:2080` (local to VPS#1).
The Gateway now runs on VPS#2. To restore public access without moving the
tunnel, an SSH forward on VPS#1 relays `127.0.0.1:2080` to VPS#2:2080 via
`autossh` using the existing `omniroute-tunnel` user.

- Unit: `infra/gateway-forward/leuwongrr-gateway-forward.service`
- Runbook: `docs/runbooks/gateway-forward-setup.md`
- VPS#2 Gateway stays at `127.0.0.1:2080` (loopback only) — never exposed.
- This is a temporary overlay. The long-term fix is moving the Cloudflare
  Tunnel to VPS#2 and removing this forward.

Cloudflare Access identity headers are untrusted until the application verifies the JWT issuer, audience, signature, and expiry.
