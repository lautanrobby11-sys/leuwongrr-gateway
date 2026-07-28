# ADR-009: Console accounts, token billing, and the Cryptomus boundary

- Status: Accepted
- Date: 2026-07-28
- Supersedes: none

## Context

The gateway had exactly one way in: an operator issued an API key from the CLI.
There was no way for a person to sign in, see what they had spent, buy more
capacity, or for an owner to change a price without editing the database by
hand. Three surfaces were requested: `/admin`, `/member`, and `/chat`, with
pay-as-you-go tokens, subscriptions, and Cryptomus as the payment gateway.

The existing request path already meters usage into `usage_events` and settles
it after a response completes. That path is the most fragile part of the system:
a failure there costs a caller their in-flight response.

## Decision

**Billing derives from metering; it does not join it.** `usage_events` with
`state = 'settled'` remains the source of truth. A reconciler walks new rows in
batches and writes `ledger_entries`, keyed by `UNIQUE(account_id, source,
reference)` with the usage event id as the reference. Reconciliation is
therefore idempotent and can run lazily on dashboard reads and on the existing
maintenance tick. No new write was added to the streaming hot path.

**Spend order is subscription allowance, then prepaid wallet.** A shortfall is
recorded as an explicit unfunded ledger entry and marks the subscription
`past_due`. It is never rounded to zero, because silently absorbing a shortfall
is the same as giving capacity away.

**Funding is checked during authentication.** `assertFunded` runs alongside the
rate and concurrency checks, so an empty account gets a clean `402` before any
upstream work begins. Tenants with no console account, such as those the
operator provisions from the CLI, are exempt: introducing billing must not take
an existing integration offline.

**Admin authority comes from Cloudflare Access, not from a session cookie.**
`/console/api/admin/*` verifies the `Cf-Access-Jwt-Assertion` header against the
team JWKS, including signature, audience, issuer, and expiry, and then requires
an `admin` or `owner` role in the database. A stolen member cookie cannot reach
an admin endpoint.

**Members sign in with an email code or a federated identity.** Email codes are
stored as HMACs with the runtime pepper, rate limited on resend, and capped on
attempts. Google and Discord use OAuth with PKCE. Telegram provides no email
address, so it can only be linked to an account that already exists rather than
creating one.

**Cryptomus signatures are verified in both encodings.** Cryptomus signs with
PHP `json_encode`, which escapes forward slashes. Verification accepts the
escaped and unescaped forms and compares in constant time. Webhook deliveries
are deduplicated on a digest so a retry cannot grant tokens twice.

**The console is a separate front-end build.** `web/` is a four-entry Vite
build that emits to `dist/public`; the gateway serves those files from an
allowlisted route family. There is no catch-all: every console path is declared
in `src/policy/allowlist.ts` like every other route.

## Consequences

- Balances are eventually consistent with usage, bounded by the reconcile
  batch size and the maintenance interval. A very heavy burst can briefly
  overspend before the next reconcile observes it.
- `npm run build:web` is deliberately excluded from `validate` and CI. The
  repository still has no lockfile, so making CI depend on an unpinned install
  would trade a real guarantee for a convenience.
- Admin access now depends on Cloudflare Access being configured correctly. If
  `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is absent, the admin API returns 503
  rather than falling back to a weaker check.
- Plan changes rewrite tenant limits and model entitlements, so a plan edit is
  an operational change, not only a pricing one.

## Alternatives considered

- **Debiting inside the response pipeline.** Rejected: it puts a write between
  the user and their tokens, and a billing bug becomes an outage.
- **A single-page app with client-side routing.** Rejected: it would require a
  rewrite rule or a catch-all route, which the routing policy forbids.
- **Trusting the Access JWT without verification.** Rejected: the header is
  only meaningful if the signature, audience, and issuer are checked.
