# Password + OTP Authentication and Portal Refresh Design

- Date: 2026-08-16
- Status: Approved design baseline
- Scope: authentication foundation, `/login`, public portal `/`, and compatibility-safe migration
- Related plan: Notion “RENCANA Console Overhaul 2026 — Portal Chat Member Admin”

## Goal

Make the human console flow explicit and disciplined while preserving the gateway's existing security boundaries and production compatibility:

- New account: name → email → password → confirm password → OTP → active session.
- Existing verified account: email → password → OTP → active session.
- Existing passwordless account: email OTP remains available until the member sets a password.
- Password recovery: email → OTP → new password → confirmation.
- Public portal and login page become professional, lightweight, mobile-first, accessible, and SEO-aware.

This design does not change API-key authentication, OmniRoute access, Cloudflare Access admin authority, billing settlement, or the explicit route allowlist model.

## Current baseline

The gateway currently authenticates console members with an email OTP or configured OAuth provider. The backend has no password hash, registration state, or password endpoint. `display_name` already exists on account creation paths but email OTP currently creates an account without a name. The frontend login entry is a React portal with an email/code state machine and optional Google/Discord buttons. The public landing page is already static and lightweight at `/`.

## Decisions

### Authentication model

Password is a permanent credential for accounts that opt into the new flow, but it is never sufficient by itself. Every password login requires a second OTP verification. Email OTP remains a compatibility path for accounts without a password and a recovery path after a verified email challenge.

Password values are processed only at the boundary and stored only as a slow password hash using the approved password-hashing library/parameters for this runtime. API-key HMAC storage remains unchanged. OTP values remain short-lived, attempt-limited, cooldown-protected, and never logged or persisted in plaintext.

### Account states

The implementation uses explicit states rather than implicit UI assumptions:

- `pending_verification`: registration has begun but OTP has not completed.
- `active`: email verified; password may be present or absent for legacy compatibility.
- `suspended`: existing account policy; all authentication paths reject it.

A pending registration must not create a usable member session. Re-registering the same unverified email replaces only the pending registration challenge according to the existing OTP rate limits; it must not create duplicate active accounts.

### Auth state machine

1. **Register**: validate name/email/password/confirmation, create or update a pending account record, issue an OTP challenge, and return only a generic delivery result.
2. **Verify registration**: consume the registration OTP, mark email verified, persist the password hash and display name atomically, create a session, and redirect to `/member`.
3. **Password login**: validate email/password with a generic failure response, then issue a login OTP without creating a session.
4. **Verify password login**: consume the login OTP, create a session, and redirect to `/member`.
5. **Legacy OTP login**: for an account without a password, request and verify email OTP as today; create a session and show a one-time “set password” prompt in the member UI.
6. **Password reset**: request a generic reset challenge, verify OTP, then accept and persist a replacement password hash. A reset challenge must not reveal whether an email exists.

OAuth remains an optional alternate sign-in path. OAuth-created accounts are active and passwordless until a member explicitly sets a password; OAuth behavior and PKCE remain unchanged.

### Endpoint contract

Add explicit, allowlisted operations under `/console/api/auth`:

- `POST /register`
- `POST /register/verify`
- `POST /login/password`
- `POST /login/verify`
- `POST /password/request-reset`
- `POST /password/reset`
- `POST /password/set` for an authenticated legacy member

Existing `request-code`, `verify-code`, `logout`, OAuth start, and callbacks remain available during migration. Every new operation is added to `DOCUMENTED_OPERATIONS` and the OpenAPI contract. Payloads are strict Zod schemas with bounded lengths and no unknown fields.

Responses use the existing error envelope and generic messages for invalid credentials, unknown accounts, and reset requests. No endpoint returns password material, password hashes, OTPs, provider secrets, or account-enumeration signals.

### Storage and migration

Add one forward-only migration after the current head. It adds only nullable/compatible fields needed for the new flow, such as:

- password hash and password-hash version
- email verification timestamp/state
- registration/auth challenge purpose metadata if the existing OTP store cannot represent it

The migration must preserve all existing accounts and sessions. No plaintext password, OTP, recovery token, or provider credential is backfilled. Existing passwordless accounts remain usable through OTP.

The canonical account store owns all reads/writes. No route performs ad-hoc password persistence. Password hashes are never included in account list, session, audit metadata, error logs, or API responses.

### Abuse controls and security

Apply independent limits to registration, password login failures, OTP issue/resend, OTP verification attempts, and password reset. Reuse the existing origin/session protections and cookie settings. State-changing browser requests continue to require a trusted Origin where the policy requires it.

Use timing-safe password verification behavior supplied by the password-hashing library and generic authentication errors. Do not add password data to request logging, traces, analytics, or prompt/response telemetry. Suspended accounts cannot authenticate through any human-console path.

### Portal and login UX

`/login` becomes a single responsive auth shell with explicit modes:

- Create account
- Sign in
- Verify OTP
- Forgot password
- Set password for legacy OTP users

Registration fields are ordered Name, Email, Password, Confirm password. Password fields have accessible eye toggles that change only visibility, preserve the field value, work with keyboard input, and expose accurate `aria-label`/pressed state. Client validation mirrors server constraints but server validation remains authoritative. Loading, resend cooldown, expired OTP, invalid OTP, password mismatch, generic credential failure, and delivery failure states are visible and recoverable.

The page keeps OAuth buttons only when configured. It must not expose development OTP behavior in a production build or copy secrets into persistent browser storage.

The public `/` page remains static/no-framework and receives a restrained professional refresh: clear gateway value proposition, developer quickstart, truthful capability/pricing messaging, sign-in/create-account CTAs, status link, responsive layout, and semantic headings. SEO includes one canonical URL, accurate title/description, `robots`, Open Graph/Twitter metadata, and JSON-LD only for facts actually supported by the service. No fabricated pricing or unsupported compatibility claims.

### Visual and performance direction

Use the existing GNOME-dark tokens and shared components. Avoid new animation or chart dependencies. Keep the public page and login shell lightweight, preserve reduced-motion behavior, target no horizontal overflow at 360px, and keep interactive controls keyboard accessible with WCAG AA contrast.

## Error handling

- Validation errors identify the affected field without echoing secrets.
- Invalid/expired OTP returns a stable generic code and allows a controlled retry until the attempt limit.
- OTP delivery failure returns the existing fixed delivery error shape and never exposes provider details.
- Password login failures use one generic response for unknown email, wrong password, and suspended/blocked credential paths where disclosure would enable enumeration.
- Concurrent registration, verification, or reset attempts are resolved transactionally; a consumed challenge cannot be reused.
- Unexpected failures go through the existing console error handler with trace IDs and redacted logs.

## Testing and acceptance criteria

### Backend

- Forward-only migration applies to a fresh and existing database; foreign-key checks remain clean.
- Registration rejects invalid names/emails/passwords/mismatched confirmation and never creates an active session before OTP verification.
- Successful registration verifies email, persists only a password hash, stores the display name, and creates a session after OTP.
- Password login requires both valid password and valid OTP.
- Legacy passwordless OTP login remains green and can set a password once authenticated.
- Reset flow is generic, rate limited, OTP-protected, and cannot be replayed.
- Suspended accounts are rejected through password, OTP, reset completion, and OAuth-linked paths as applicable.
- New routes are present in allowlist, documented operations, OpenAPI, and route tests.
- Passwords, hashes, OTPs, and secrets are absent from logs, audit metadata, and response bodies.

### Frontend

- DOM tests cover registration, login, OTP, reset, legacy set-password, validation, loading/error states, and eye-toggle behavior.
- Login page has correct metadata, semantic labels, keyboard access, and no password value leakage in rendered text.
- Public landing page has one H1, canonical/SEO metadata, truthful copy, and no unsupported pricing claims.
- Mobile layout has no horizontal overflow at 360px; reduced motion remains respected.
- Build output contains all required console pages and assets.

### Release

Before merge or deployment: `npm run validate`, console build, `npm run ci:local`, clean-tree/release artifact checks, and the operator release-authority procedure must pass. A failed post-guard deployment is not retried with the same SHA. README, canonical status, and the Notion checkpoint are updated only with verified evidence.

## Out of scope

- Replacing Cloudflare Access or changing `/admin` authorization.
- Reading or changing OmniRoute files, database, configuration, or secrets.
- Adding social providers beyond the existing configured OAuth paths.
- Moving payment listener secrets into the UI or database.
- Implementing the full Notion Phase C plans overhaul or Phase D admin overhaul in the auth slice; those remain follow-up work after the auth foundation is stable.
