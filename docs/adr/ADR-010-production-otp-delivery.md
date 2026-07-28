# ADR-010: Production OTP delivery must fail closed

## Status
Accepted — 2026-07-28

## Context
The console email-login route returns `dev_code` when `OTP_DELIVERY=log`. The production systemd unit sets `NODE_ENV=production`, while the previous example configuration selected `OTP_DELIVERY=log`. A deployment following that example would expose the current login code to the unauthenticated caller and defeat email ownership verification.

## Decision
- `NODE_ENV` is typed and defaults to `production`.
- A production process with the console enabled refuses to start unless `OTP_DELIVERY=webhook`.
- Webhook delivery requires both an HTTPS URL and a credential.
- Development/test environments may keep the one-time response code for offline work.

## Consequences
This intentionally breaks unsafe production configurations. Operators must configure a delivery relay before enabling the console. Runtime cost is limited to startup validation; request-path performance and memory are unchanged. The rule is covered by configuration tests and documented in `.env.example`.
