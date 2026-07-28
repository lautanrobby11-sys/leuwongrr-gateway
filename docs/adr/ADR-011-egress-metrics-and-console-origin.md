# ADR-011: Resolved egress, guarded metrics, and console origin enforcement

Status: accepted
Date: 2026-07-28
Supersedes: none
Related: ADR-010 (production OTP delivery)

## Context

The production readiness audit left three gates open. Each is small in code and
large in consequence.

**Egress.** The target policy understood IPv4 only. A URL naming an IPv6
unique-local, link-local, or IPv4-mapped address passed, and so did CGNAT,
benchmarking, NAT64, and 6to4 ranges. Worse, only the literal name was judged:
a perfectly public hostname that answers with `169.254.169.254` was accepted.
The gateway makes outbound calls to three operator-configured targets, so a
mistaken or hostile configuration value was enough to reach the host's own
services.

**Observability.** There was no metrics surface at all, which made the
operational readiness gate impossible to satisfy. The obvious fix, an open
`/metrics`, would have been worse than nothing: Prometheus text is a very
readable description of who uses a system and how much.

**Console.** Member and admin authority arrives on the request by itself, as a
session cookie or as the Cloudflare Access assertion added at the edge. Any
other website could therefore cause a logged-in member to top up, revoke a key,
or an admin to change an account limit, simply by causing their browser to post.

## Decision

**Address judgement is family aware and applied to answers, not just names.**
`forbiddenAddress` classifies IPv4 and IPv6, and refuses anything it cannot
parse. IPv4 embedded in IPv6 is unpacked in both the dotted and the hexadecimal
form, because Node normalises `::ffff:169.254.169.254` into `::ffff:a9fe:a9fe`;
a check that reads only the dotted form is silently useless.
`assertResolvedPublicEgress` resolves the hostname and refuses if any answer is
non-public, treating an empty answer or a lookup failure as refusal rather than
as permission.

**Metrics are opt-in, separately credentialed, and label-poor.** The endpoint
requires `METRICS_ENABLED` and a dedicated `INTERNAL_METRICS_TOKEN` that must
differ from the readiness token; without both it answers 404 rather than 401,
so a scrape port that becomes reachable reveals nothing, not even that metrics
exist. A series is identified by the allowlist route identifier and a status
class only. Never a tenant, account, key, or raw path. That keeps the series
set finite regardless of what a caller sends, and keeps a scrape from being a
customer list. The endpoint stays inside the source rate limit so the token
cannot be guessed quickly.

**Origin is enforced in the shared request hook.** `POST` to `console.auth`,
`console.member`, and `console.admin` requires an Origin the operator allows.
It is checked in the hook rather than per handler so that no route can forget
it, and it fails closed when the header is absent. `console.callback` and
`webhook.cryptomus` are deliberately exempt: they legitimately arrive
cross-site and prove themselves with a provider signature or a one-time state
value instead.

**The OpenAPI document covers the whole allowlist and CI enforces it.** The
document described three of forty operations, which is worse than none because
it invites belief. `DOCUMENTED_OPERATIONS` expands the allowlist one entry per
operation and a test holds the document, that list, and the route resolver in
agreement, so an undocumented route now fails the quality gate.

## Consequences

Resolution costs one DNS lookup per outbound call to an operator-configured
target. These calls are already network-bound and infrequent.

A residual DNS rebinding window remains: the name is resolved for the check and
resolved again by the HTTP client for the connection, and an attacker who
controls an authoritative server could answer differently the second time.
Closing it properly means pinning the checked address at connect time, which
requires a custom dispatcher and therefore a new dependency. The lockfile is
deliberately pinned and deterministic, so that trade is refused for now. The
exposure is bounded: the targets are operator-configured rather than
caller-supplied, the gateway binds to loopback, and the host firewall is
default-deny outbound to internal ranges. This is recorded as a known,
accepted, and revisitable gap rather than a closed one.

Operators who serve the console from a second hostname must list it in
`CONSOLE_ALLOWED_ORIGINS` or their console will refuse to act. This is intended:
silence on origin is what the old behaviour offered.
