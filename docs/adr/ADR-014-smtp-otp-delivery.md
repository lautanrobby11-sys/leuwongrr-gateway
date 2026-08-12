# ADR-014: SMTP OTP delivery is explicit, bounded, and fail closed

Status: accepted
Date: 2026-08-12
Supersedes: none
Related: ADR-010 (production OTP delivery), ADR-011 (resolved egress)

## Context

The console sign-in code is delivered out of band. ADR-010 made webhook
delivery the only production-safe path: an HTTPS relay proves receipt, and the
code never appears in a response or a log. The candidate non-worker relay for
Gate 3 is SMTP through the operator's mail provider, but SMTP is a different
trust shape than webhook: the gateway itself dials the provider, so it must
carry a mail credential, and a misconfigured transport has real failure modes
(plaintext fallback, lax certificate checks, unbounded waits) that do not exist
for a webhook.

## Decision

**Configuration is explicit all-or-nothing.** `OTP_DELIVERY=smtp` requires
`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USERNAME`, `SMTP_PASSWORD`,
and `SMTP_FROM`, each with no default. A provider is never guessed from partial
state; `loadConfig` refuses to boot a process with a missing value. This
extends ADR-010: a production process with the console enabled now accepts
`OTP_DELIVERY=webhook` or `OTP_DELIVERY=smtp`, and still refuses `log`
(development disclosure) in production.

**Security is a closed enum, certificate validation stays on.** `SMTP_SECURITY`
accepts only `starttls` (the STARTTLS upgrade is mandatory via `requireTLS`)
or `tls` (implicit TLS from the first byte). There is no plaintext option.
`rejectUnauthorized` is pinned to true.

**Everything is bounded and there is no retry.** Connection, greeting, and
socket timeouts are fixed at 10s/10s/15s. A failing provider answers once;
classification never re-runs the transport.

**Failure is reduced to a fixed code at the module boundary.**
`classifySmtpFailure` inspects only the error's `code` and `responseCode`
fields and maps them to a closed set (`smtp_auth_failed`, `smtp_tls_failed`,
`smtp_timeout`, `smtp_connection_failed`, `smtp_provider_failed`). The raw
provider error — which can echo credentials or mail contents — never crosses
into a log, an error object, or the HTTP response. The gateway-facing route
maps any SMTP failure to the same fixed 502 `otp_delivery_failed` used by the
webhook relay, so a caller can never distinguish the provider detail and an
operator log never receives provider text.

**Transport lifecycle is short.** The transport is created per request and
closed after the send; nodemailer only dials on `sendMail`, so nothing is held
open between requests.

## Consequences

An operator who picks SMTP must confirm every value in `gateway.env`; any
missing value fails the process at boot, which is intended. SMTP egress is
still an operator-configured target and therefore does not need the DNS
rebinding defense discussed in ADR-011, but neither does it bypass it: the
route never resolves a caller-supplied name.

Timeout and classification behaviour is covered by unit tests with a fake
transport, so a future provider swap does not disturb the gateway-facing
contract.
