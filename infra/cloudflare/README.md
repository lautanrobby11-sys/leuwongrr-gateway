# Cloudflare boundary

Dashboard/API changes are operator-owned and must be recorded in the deployment audit.

1. Tunnel published application: `api.leuwongrr.cloud` -> `http://127.0.0.1:2080`.
2. Access self-hosted application path: `api.leuwongrr.cloud/admin*` **only**. Never protect the whole hostname.
3. Bypass cache for `/v1*`, `/v1beta*`, `/chat*`, `/admin*`, `/callbacks/*`, `/webhooks/*`.
4. Do not publish ports 2080 or 20128 in the VPS firewall/security group.
5. Verify negative cases: missing/forged/expired Access JWT; valid Access user without application role; `/v1` without interactive Access redirect.

Cloudflare Access identity headers are untrusted until the application verifies the JWT issuer, audience, signature, and expiry.