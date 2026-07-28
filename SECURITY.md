# Security policy

## Reporting

Report suspected vulnerabilities privately through GitHub security advisories on this repository. Do not open a public issue, and never include real keys, tokens, cookies, prompts, responses, or raw logs.

## Handling rules

- Provider credentials belong to OmniRoute only. They must never appear in this repository, the gateway database, logs, or responses.
- Gateway API keys are stored as HMAC-SHA256 digests. A plaintext key is shown once at creation and is never recoverable.
- Runtime secrets live only in `/opt/leuwongrr-gateway/config/gateway.env`, owned by root with mode 600.
- Every request path enforces tenant scoping; a cross-tenant read or write is treated as a critical defect.
- The public surface is an explicit allowlist. Any accidental passthrough to OmniRoute is a critical defect.
- `/admin*` requires a verified Cloudflare Access JWT and an application role. Trusting an Access header without verifying the token is a critical defect.

## Response expectations

1. Contain: revoke affected keys, disable the affected model or route, or roll back to the previous release SHA.
2. Verify: reproduce with a test that fails before the fix.
3. Fix in the canonical module, never with a parallel or suffixed file.
4. Record the commit SHA, migration ID, gate results, and rollback target in the audit log.
