# Task 3 report — Multimode payment grants

## Scope
Implemented Task 3 only from current branch HEAD. No OmniRoute files, configuration, database, or secrets were read. No provider payloads or credentials were added to logs or persistence.

## Files changed
- `src/billing/service.ts`
  - Added `BillingService.settlePaymentSnapshot(accountId, paymentId, snapshot)`.
  - Supports rolling-time subscription, token pack, monetary pack, and PAYG cents grants.
  - Uses payment ID as immutable idempotency reference.
  - Keeps token and cents balances separate and returns grant totals.
  - Exposes subscription model-group snapshot.
- `src/http/console.ts`
  - Cryptomus settlement now delegates entitlement application to billing service.
  - Reads stored entitlement snapshot and preserves a legacy fallback for older empty snapshots.
- `src/persistence/migrations.ts`
  - Added forward-only migration `0013_multimode_payment_ledger` with ledger currency, cents, and cents balance-after fields.
- `tests/payment-multimode-settlement.test.ts`
  - Added coverage for token packs, monetary packs, rolling-time model-group snapshots, PAYG cents, idempotent retries, and shared non-negative balances.

## Commit
`6d8c42c4402d1e24e4fd97367ee896068fc40422` — `feat: settle cryptomus payments into shared balances`

## Verification
- Focused multimode test: PASS — 1 file, 4 tests.
- Required focused suite: PASS — 4 files, 32 tests (`payment-multimode-settlement`, `billing-settlement`, `subscription-engine`, `payment-webhook`).
- Typecheck: PASS — `npx tsc --noEmit`.
- `git diff --check`: PASS.
- Working tree after commit: clean.

The focused suite emits existing Fastify `FSTDEP023` deprecation warnings about `disableRequestLogging`; tests still pass.

## Review-fix follow-up

- Settlement failures now roll back payment event and grant writes together, durably set `settlement_status = 'reconciliation_required'` with a sanitized error code, clear `settled_at`, and return HTTP 409 without inviting blind retry.
- Settlement validates method, payment/account scope, integer non-negative amounts, and preserves non-negative token/cents balances.
- Token-pack payment ledger entries now retain token currency while recording equivalent cents metadata; ledger reads expose currency and cents fields.
- Review-fix commit: `1b0bb7d4b800e351a6354658032ebd56a8ec27bc` (`fix: make payment settlement reconciliation safe`).
- Re-ran typecheck, required focused suite (32 tests passed), and `git diff --check`.

## Concerns
- Full `npm run validate` was not run because the task requested focused tests and typecheck only.
- Existing legacy webhook records with empty entitlement snapshots use a compatibility fallback; new checkout records use the stored snapshot.
- The implementation records payment ledger currency fields, while existing token ledger readers remain token-compatible.
