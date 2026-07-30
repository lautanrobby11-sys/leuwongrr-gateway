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

## Update 2026-07-30

Two consequences of this decision were unreachable in practice and are now
closed by the operator CLI rather than by weakening the decision:

- No code path ever assigned `admin` or `owner`, so the role check this ADR
  requires could never pass. `keys.ts account:role` promotes an existing account,
  which keeps privilege an explicit operator act rather than a deploy side
  effect. A migration seed was rejected: it cannot know the operator's email and
  would grant privilege as a consequence of deploying.
- The plan catalogue had no writer outside the admin console, which itself
  needed an admin. `keys.ts plan:upsert` seeds it, so the member console has
  something to read at `/console/api/member/plans`.

Neither command may run against the production database while a soak is in
progress: the member console reads live rows.

Console asset delivery also no longer shares the data-plane rate limiter. One
page load fetches HTML plus several hashed assets, so charging the shell to the
caller's `/v1/*` budget let opening the dashboard exhaust it. The static bucket is
wider but still bounded — an unmetered static path is a free amplifier.

Three consequences of "no catch-all: every console path is declared in the
allowlist" were only half true and are now closed:

- The allowlist is unconditional while `registerConsole` is not, so with
  `CONSOLE_ENABLED=false` — the production setting — every console path was
  allowlisted with no handler behind it and Fastify's default 404 body answered
  instead of the gateway envelope. The `onRequest` hook now rejects console routes
  itself when the console is off, and sets the trace id and hardening headers
  before the allowlist check so an unlisted path carries them too.
- An asset miss answered with no `cache-control` at all, because the hook removes
  the header for asset routes so a hit can be immutable. A miss now restores
  `no-store`; a cached negative answer for a hashed filename would survive into
  the release that contains it.
- `plans` had two writers with different validation: the console route's schema
  and the CLI's hand-rolled range checks. Both now use
  `src/billing/plan-input.ts`. `applyPlanLimits` copies plan values into
  `tenant_limits`, so an unbounded writer set the concurrency and rate limits the
  request path enforces.

`account:role` writes an `operator.account.role` audit row. It is the only path to
`admin` and there is no HTTP route for it, so an unlogged promotion left no trace
anywhere.
